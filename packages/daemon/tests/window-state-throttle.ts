import { backlightFixture } from './backlight-fixture.ts'
/**
 * OPT-IN manual acceptance (NOT part of `test:integration` / `test`).
 *
 * One window-state sequence on an isolated branded Backlight.app:
 *   visible/maximized baseline → /api/bg (minimize) → observation → /api/show --maximize
 * During the single minimized observation window it reports each channel
 * separately (never conflated):
 *   - CDP windowState                      (Browser.getWindowBounds)
 *   - AppKit native visibility             (app-control state + windows)
 *   - document.visibilityState             (Chromium's own value, read-only)
 *   - timer / network polling              (__blHealth.timer + server counter)
 *   - compensatory rAF                     (__blHealth.raf, rAF shim)
 *   - native compositor rAF                (__blHealth.native, un-shimmed)
 *
 * Capture keep-alive (production path) is enabled so the single minimized
 * window proves the captured target keeps native compositor frames while the
 * AppKit window stays hidden/offscreen. The non-captured `nativeRaf == 0`
 * evidence was produced by the 2026-09-16 Phase A run documented in
 * docs/development/2026-09-16.md.
 *
 * The window (of the isolated test Backlight only) is maximized once,
 * minimized once and restored once; capture setup may transiently park it as
 * part of production behavior. Never add this to the default test chain.
 *
 * Run: pnpm --filter @backlight/daemon test:window-state
 *   or: caffeinate -dis node tests/window-state-throttle.ts
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { Cdp, fetchVersion } from '../src/cdp.ts'
import {
  firstSampleAt,
  formatTimeline,
  holdsThroughout,
  parseNativeWindowsProbe,
  ratePerSec,
  sliceWindow,
  type NativeWindowsProbe,
  type WindowStateSample,
} from './window-state-samples.ts'

// Thresholds and their rationale are documented in
// docs/plans/2026-09-16-window-state-throttle-acceptance.md
const BASELINE_MS = 4_000
const HIDDEN_OBSERVE_MS = 10_000
const RECOVERY_OBSERVE_MS = 4_000
const SAMPLE_MS = 500
const MIN_VISIBLE_NATIVE_PER_SEC = 30 // visible maximized ~60–120/s
const MIN_TIMER_PER_SEC = 5 // setInterval 100ms → 10/s; Chromium hidden clamp is ~1/s
const MIN_POLL_PER_SEC = 2 // fetch 250ms → 4/s; Chromium hidden clamp is ~1/s
const MIN_SHIM_RAF_PER_SEC = 25 // rAF shim ~60/s; broken shim + paused native → ~0
const MIN_CAPTURE_NATIVE_RATIO = 0.7 // supervisor e2e contract was 0.75; margin for jitter
const TRANSITION_TIMEOUT_MS = 20_000
const CAPTURE_ENGAGE_TIMEOUT_MS = 30_000

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-wstate-'))
backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { findFreePort } = await import('../src/ports.ts')
const port = await findFreePort() // random ephemeral, never the user's 9333

// ---- local site: network polling + server-side ground truth -----------------
const pageKey = 'one'
const serverPolls = new Map<string, number>()
const site = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/data') {
    const key = url.searchParams.get('page') ?? 'unknown'
    const n = (serverPolls.get(key) ?? 0) + 1
    serverPolls.set(key, n)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ n }))
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>Backlight window-state acceptance</title>
<body style="font:28px monospace">window-state probe
<script>
  window.__polls = 0; window.__lastServerN = 0;
  setInterval(async () => {
    try {
      const r = await fetch('/data?page=${pageKey}', { cache: 'no-store' });
      const j = await r.json();
      window.__lastServerN = j.n; window.__polls++;
    } catch {}
  }, 250);
</script></body>`)
})
await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`

// ---- app-control (same Swift source the daemon builds) ----------------------
const appControl = path.join(tmp, 'bin', 'app-control')
fs.mkdirSync(path.dirname(appControl), { recursive: true })
execFileSync('/usr/bin/swiftc', [fileURLToPath(new URL('../../../tools/app-control.swift', import.meta.url)), '-o', appControl])
const nativeState = (pid: number): { active: boolean; hidden: boolean } =>
  JSON.parse(execFileSync(appControl, ['state', String(pid)], { encoding: 'utf8' }))
const nativeWindows = (pid: number): NativeWindowsProbe =>
  parseNativeWindowsProbe(execFileSync(appControl, ['windows', String(pid)], { encoding: 'utf8' }))

// ---- isolated daemon --------------------------------------------------------
const log = fs.openSync(path.join(tmp, 'daemon.log'), 'w')
const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
  env: { ...process.env, BACKLIGHT_HOME: tmp, BACKLIGHT_PORT: String(port), BACKLIGHT_TRAY: '0', BACKLIGHT_VERBOSE: '1' },
  stdio: ['ignore', log, log],
})
const api = async (route: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, body === undefined
    ? { signal: AbortSignal.timeout(60_000) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const result = await r.json() as any
  assert.ok(r.ok, `${route}: ${JSON.stringify(result)}`)
  return result
}
async function waitFor(fn: () => Promise<boolean> | boolean, message: string, timeout = TRANSITION_TIMEOUT_MS) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(150) }
  throw new Error(message)
}

let cdp: Cdp | undefined
let session = ''
let targetId = ''
let windowId = 0
let pid = 0
const samples: WindowStateSample[] = []
let samplerRunning = false
let T0 = Date.now()

const sampleLine = (s: WindowStateSample) =>
  `t=${(s.atMs / 1000).toFixed(2)}s cdp=${s.cdpWindowState} appHidden=${s.nativeAppHidden} onScreen=${s.nativeOnScreenWindows} `
  + `dom=${s.domVisibility} shimRaf=${s.raf} nativeRaf=${s.nativeRaf} timer=${s.timer} polls=${s.pagePolls}/${s.serverPolls}`

const readCounters = () => cdp!.evaluateOnSession<{
  vis: string; raf: number | null; native: number | null; timer: number | null; polls: number | null
}>(session, `(() => {
  const h = window.__blHealth;
  return {
    vis: document.visibilityState,
    raf: h ? h.raf : null,
    native: h ? h.native : null,
    timer: h ? h.timer : null,
    polls: typeof window.__polls === 'number' ? window.__polls : null,
  };
})()`)

const cdpWindowState = async (): Promise<string | null> => {
  try { return (await cdp!.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })).bounds.windowState ?? null } catch { return null }
}

async function sampleOnce(): Promise<void> {
  const atMs = Date.now() - T0
  const state = await cdpWindowState()
  let nativeAppHidden: boolean | null = null
  let nativeOnScreenWindows: number | null = null
  try { nativeAppHidden = nativeState(pid).hidden } catch { /* native probe unavailable */ }
  try { nativeOnScreenWindows = nativeWindows(pid).onScreenWindowCount } catch { /* native probe unavailable */ }
  let domVisibility: string | null = null
  let raf: number | null = null
  let nativeRaf: number | null = null
  let timer: number | null = null
  let pagePolls: number | null = null
  try {
    const counters = await readCounters()
    domVisibility = counters.vis
    raf = counters.raf
    nativeRaf = counters.native
    timer = counters.timer
    pagePolls = counters.polls
  } catch { /* page busy or session re-attaching */ }
  samples.push({
    atMs,
    cdpWindowState: state,
    nativeAppHidden,
    nativeOnScreenWindows,
    domVisibility,
    raf,
    nativeRaf,
    timer,
    pagePolls,
    serverPolls: serverPolls.get(pageKey) ?? 0,
  })
}

const fmt = (v: number | null) => v === null ? 'null' : v.toFixed(1)
const printObservations = (window: WindowStateSample[], label: string) => {
  const observed = {
    timerRate: ratePerSec(window, s => s.timer),
    pollRate: ratePerSec(window, s => s.serverPolls),
    shimRate: ratePerSec(window, s => s.raf),
    nativeRate: ratePerSec(window, s => s.nativeRaf),
  }
  console.log(`  ${label}: timer=${fmt(observed.timerRate)}/s polls(server)=${fmt(observed.pollRate)}/s `
    + `shimRaf=${fmt(observed.shimRate)}/s nativeRaf=${fmt(observed.nativeRate)}/s`)
  return observed
}

// ---- cleanup survives SIGINT/SIGTERM and never leaves isolated processes ----
let cleanedUp = false
async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  samplerRunning = false
  await sleep(700)
  try { cdp?.close() } catch { /* ignore */ }
  try {
    await fetch(`http://127.0.0.1:${port}/api/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3_000),
    })
  } catch { /* daemon may be gone */ }
  try { daemon.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  try { if (daemon.exitCode === null) daemon.kill('SIGKILL') } catch { /* ignore */ }
  try { site.close() } catch { /* ignore */ }
  try { fs.closeSync(log) } catch { /* ignore */ }
  // kill any browser started with this temp profile, then remove the temp dir
  try { execFileSync('/usr/bin/pkill', ['-f', tmp], { stdio: 'ignore' }) } catch { /* none left */ }
  await sleep(400)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`\n${signal} received; cleaning up isolated test environment…`)
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  })
}

try {
  await waitFor(async () => !!(await api('status')).daemon, 'daemon startup', 15_000)
  // Production capture keep-alive path; single minimize observation window.
  await api('settings', { captureKeepAlive: true, backgroundMode: true, collapseMode: 'minimize', pumpFps: 10 })
  await api('launch', { url: siteUrl, keepVisible: true })
  const status = await api('status')
  pid = status.browser.pid
  assert.ok(pid > 0, `managed browser pid unavailable: ${JSON.stringify(status.browser)}`)
  cdp = await Cdp.connect((await fetchVersion(status.browser.upstreamPort)).webSocketDebuggerUrl)

  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>('Target.getTargets')
  const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith(siteUrl))
  assert.ok(page, 'acceptance page not found')
  targetId = page.targetId
  session = await cdp.attach(targetId)
  ;({ windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId }))
  await waitFor(async () => !!(await readCounters().catch(() => null)), 'health injection lands', 15_000)
  await api('show', { maximize: true, activate: false })
  await waitFor(async () => (await cdpWindowState()) === 'maximized', 'show --maximize reaches CDP maximized')

  T0 = Date.now()
  samplerRunning = true
  void (async () => { while (samplerRunning) { await sampleOnce(); await sleep(SAMPLE_MS) } })()

  console.log('\n=== window state sequence: visible/maximized → minimized → restored/maximized ===')
  console.log(`  (isolated Backlight.app, pid=${pid}, target=${targetId.slice(0, 8)}, window=${windowId}, capture keep-alive on)`)

  // ---- visible/maximized baseline ------------------------------------------
  const baselineStart = Date.now() - T0
  await sleep(BASELINE_MS)
  const baseline = sliceWindow(samples, baselineStart, Date.now() - T0)
  const baselineObserved = printObservations(baseline, 'baseline visible/maximized')
  assert.ok(holdsThroughout(baseline, s => s.cdpWindowState === 'maximized'), 'baseline must stay CDP-maximized')
  assert.ok(holdsThroughout(baseline, s => s.nativeAppHidden === false), 'baseline must be natively unhidden')
  assert.ok(holdsThroughout(baseline, s => (s.nativeOnScreenWindows ?? 0) >= 1), 'baseline must have a native on-screen window')
  assert.ok(holdsThroughout(baseline, s => s.domVisibility === 'visible'), 'baseline DOM must be visible')
  assert.ok(baselineObserved.nativeRate !== null && baselineObserved.nativeRate >= MIN_VISIBLE_NATIVE_PER_SEC,
    `visible baseline native compositor rAF/s ${fmt(baselineObserved.nativeRate)} < ${MIN_VISIBLE_NATIVE_PER_SEC}`)
  assert.ok(baselineObserved.timerRate !== null && baselineObserved.timerRate >= MIN_TIMER_PER_SEC,
    `visible baseline timer/s ${fmt(baselineObserved.timerRate)} < ${MIN_TIMER_PER_SEC}`)
  assert.ok(baselineObserved.pollRate !== null && baselineObserved.pollRate >= MIN_POLL_PER_SEC,
    `visible baseline network polls/s ${fmt(baselineObserved.pollRate)} < ${MIN_POLL_PER_SEC}`)
  console.log(`PASS baseline: cdp=maximized, native on-screen, dom=visible, nativeRaf=${fmt(baselineObserved.nativeRate)}/s`)

  // ---- minimize once -------------------------------------------------------
  const bgRequestedAt = Date.now() - T0
  await api('bg', {})
  await waitFor(async () => (await api('status')).browser?.captureTargetId === targetId,
    'capture keep-alive engages for the probe target', CAPTURE_ENGAGE_TIMEOUT_MS)
  // capture setup transiently parks/normalizes the window; wait until the
  // production background state is stable again before observing.
  await waitFor(() => {
    const recent = sliceWindow(samples, Date.now() - T0 - 2_500, Date.now() - T0)
    return recent.length >= 4 && recent.every(s => s.cdpWindowState === 'minimized'
      && s.nativeAppHidden === true && s.nativeOnScreenWindows === 0)
  }, 'minimized + natively hidden state settles after capture setup')
  const minimizingEvents = [
    { atMs: bgRequestedAt, label: 'requested background (/api/bg)' },
    { atMs: firstSampleAt(samples, s => s.cdpWindowState === 'minimized'), label: 'CDP windowState=minimized' },
    { atMs: firstSampleAt(samples, s => s.domVisibility === 'hidden'), label: 'document.visibilityState=hidden' },
    { atMs: firstSampleAt(samples, s => s.nativeAppHidden === true), label: 'AppKit app hidden=true' },
    { atMs: firstSampleAt(samples, s => s.nativeOnScreenWindows === 0), label: 'native on-screen windows=0' },
  ].sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity))
  console.log('  transitions:')
  console.log(formatTimeline(minimizingEvents))

  // ---- single minimized observation window ---------------------------------
  const hiddenStart = Date.now() - T0
  await sleep(HIDDEN_OBSERVE_MS)
  const hiddenEnd = Date.now() - T0
  const hidden = sliceWindow(samples, hiddenStart, hiddenEnd)
  assert.ok(hidden.length >= 15, `minimized window must have enough samples: ${hidden.length}`)
  assert.ok(holdsThroughout(hidden, s => s.cdpWindowState === 'minimized'), 'CDP must stay minimized for the whole observation window')
  assert.ok(holdsThroughout(hidden, s => s.nativeAppHidden === true), 'AppKit must stay hidden for the whole observation window')
  assert.ok(holdsThroughout(hidden, s => s.nativeOnScreenWindows === 0), 'no native on-screen window may appear while minimized')
  const hiddenObserved = printObservations(hidden, 'minimized + capture')
  assert.ok(hiddenObserved.timerRate !== null && hiddenObserved.timerRate >= MIN_TIMER_PER_SEC,
    `minimized timer/s ${fmt(hiddenObserved.timerRate)} < ${MIN_TIMER_PER_SEC} (Chromium hidden clamp is ~1/s)`)
  assert.ok(hiddenObserved.pollRate !== null && hiddenObserved.pollRate >= MIN_POLL_PER_SEC,
    `minimized network polls/s ${fmt(hiddenObserved.pollRate)} < ${MIN_POLL_PER_SEC} (Chromium hidden clamp is ~1/s)`)
  assert.ok(hiddenObserved.shimRate !== null && hiddenObserved.shimRate >= MIN_SHIM_RAF_PER_SEC,
    `compensatory rAF/s ${fmt(hiddenObserved.shimRate)} < ${MIN_SHIM_RAF_PER_SEC} (shim must keep logic frames alive)`)
  assert.ok(hiddenObserved.nativeRate !== null && baselineObserved.nativeRate !== null
    && hiddenObserved.nativeRate >= baselineObserved.nativeRate * MIN_CAPTURE_NATIVE_RATIO,
    `captured native compositor rAF/s ${fmt(hiddenObserved.nativeRate)} < ${MIN_CAPTURE_NATIVE_RATIO} × baseline ${fmt(baselineObserved.nativeRate)}`)
  const visWhileHidden = [...new Set(hidden.map(s => s.domVisibility))].join(',')
  console.log(`  document.visibilityState while minimized+captured: ${visWhileHidden} (Chromium capturer semantics; reported, not faked)`)
  const shotStart = Date.now()
  const shot = await Promise.race([
    cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 20 }, session),
    new Promise<'HANG'>(resolve => setTimeout(() => resolve('HANG'), 8_000)),
  ])
  const shotMs = Date.now() - shotStart
  assert.ok(shot !== 'HANG' && shot.data.length > 5_000 && shotMs < 3_000,
    `minimized+captured screenshot must be a fresh real frame (${shot === 'HANG' ? 'HANG' : `${shot.data.length}B in ${shotMs}ms`})`)
  console.log(`PASS minimized + capture: timers/polling/shim keep running, native compositor ${fmt(hiddenObserved.nativeRate)}/s, screenshot ${shot.data.length}B in ${shotMs}ms`)

  // ---- restore/maximize once ----------------------------------------------
  const restoreRequestedAt = Date.now() - T0
  await api('show', { maximize: true, activate: false })
  await waitFor(() => {
    const recent = sliceWindow(samples, restoreRequestedAt, Date.now() - T0)
    return recent.some(s => s.cdpWindowState === 'maximized' && s.nativeAppHidden === false
      && (s.nativeOnScreenWindows ?? 0) >= 1 && s.domVisibility === 'visible')
  }, 'restore transitions (CDP maximized, AppKit unhidden, native on-screen, DOM visible)')
  const restoringEvents = [
    { atMs: restoreRequestedAt, label: 'requested show --maximize' },
    { atMs: firstSampleAt(samples, s => s.atMs >= restoreRequestedAt && s.cdpWindowState === 'maximized'), label: 'CDP windowState=maximized' },
    { atMs: firstSampleAt(samples, s => s.atMs >= restoreRequestedAt && s.domVisibility === 'visible'), label: 'document.visibilityState=visible' },
    { atMs: firstSampleAt(samples, s => s.atMs >= restoreRequestedAt && s.nativeAppHidden === false), label: 'AppKit app hidden=false' },
    { atMs: firstSampleAt(samples, s => s.atMs >= restoreRequestedAt && (s.nativeOnScreenWindows ?? 0) >= 1), label: 'native on-screen windows>=1' },
  ].sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity))
  console.log('  transitions:')
  console.log(formatTimeline(restoringEvents))
  const recoveryStart = Date.now() - T0
  await sleep(RECOVERY_OBSERVE_MS)
  const recovery = sliceWindow(samples, recoveryStart, Date.now() - T0)
  const recoveryObserved = printObservations(recovery, 'restored/maximized')
  assert.ok(holdsThroughout(recovery, s => s.cdpWindowState === 'maximized'), 'restored window must stay maximized while observing')
  assert.ok(recoveryObserved.nativeRate !== null && recoveryObserved.nativeRate >= MIN_VISIBLE_NATIVE_PER_SEC,
    `restored native compositor rAF/s ${fmt(recoveryObserved.nativeRate)} < ${MIN_VISIBLE_NATIVE_PER_SEC}`)
  console.log(`PASS restored/maximized: native compositor rAF recovers to ${fmt(recoveryObserved.nativeRate)}/s`)

  console.log(`\nPASS window-state throttle acceptance (Backlight.app, pid=${pid}, target=${targetId.slice(0, 8)}, window=${windowId})`)
} catch (err) {
  console.error('\nFAIL window-state throttle acceptance')
  console.error(`  last samples:\n${samples.slice(-40).map(s => '  ' + sampleLine(s)).join('\n')}`)
  try { console.error(`\n  daemon log tail:\n${fs.readFileSync(path.join(tmp, 'daemon.log'), 'utf8').split('\n').slice(-40).join('\n')}`) } catch { /* ignore */ }
  throw err
} finally {
  await cleanup()
}
