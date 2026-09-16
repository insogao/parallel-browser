import { backlightFixture } from './backlight-fixture.ts'
/**
 * OPT-IN isolated regression probe (NOT part of `test` / `test:integration`).
 *
 * Release-blocker contract: an explicit `/api/bg` must never make the managed
 * browser or app visible again, even transiently, while capture keep-alive
 * arms.
 *
 * Live evidence that motivated this probe (2026-09-16 17:24, default daily
 * session): after `/api/bg` the getDisplayMedia-based capture setup
 * un-minimized the window (CDP normal), the capture picker unhid the app
 * (hidden=false, onScreen=2 at t=3s) before cleanup re-minimized/re-hid it at
 * t=4s. The previous acceptance passed because it waited for that transient to
 * settle before asserting. This probe samples the native WindowServer + AppKit
 * state at ~100ms from the bg request through capture engagement and rejects
 * ANY on-screen or unhidden sample after the window first settles hidden.
 *
 * It runs on an isolated branded Backlight.app (temp BACKLIGHT_HOME, random
 * port, tray disabled, independent profile) and never touches the live 9333
 * session or the daily profile.
 *
 * Run: pnpm --filter @backlight/daemon test:bg-invisibility
 *   or: caffeinate -dis node tests/bg-invisibility.ts
 */
import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { Cdp, fetchVersion } from '../src/cdp.ts'
import { isInvisibleProbe, parseNativeVisibilityProbe, ratePerSec, type NativeVisibilityProbe } from './window-state-samples.ts'

const execFileAsync = promisify(execFile)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-bg-invisible-'))
backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { findFreePort } = await import('../src/ports.ts')
const port = await findFreePort()

const SAMPLE_MS = 100
const MIN_SETTLED_SAMPLES = 20 // ≥2s of high-frequency evidence after settling
const MIN_CAPTURE_NATIVE_PER_SEC = 30

// ---- local site --------------------------------------------------------------
const site = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>Backlight bg-invisibility probe</title>
<body style="font:28px monospace">probe
<script>if(!window.__h){window.__h={raf:0}};const f=()=>{window.__h.raf++;requestAnimationFrame(f)};requestAnimationFrame(f)</script>
</body>`)
})
await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`

// ---- app-control (same Swift source the daemon builds) -----------------------
const appControl = path.join(tmp, 'bin', 'app-control')
fs.mkdirSync(path.dirname(appControl), { recursive: true })
execFileSync('/usr/bin/swiftc', [fileURLToPath(new URL('../../../tools/app-control.swift', import.meta.url)), '-o', appControl], { timeout: 120_000 })
const nativeVisibility = async (pid: number): Promise<NativeVisibilityProbe> =>
  parseNativeVisibilityProbe((await execFileAsync(appControl, ['visibility', String(pid)], { encoding: 'utf8', timeout: 5_000 })).stdout)

// ---- isolated daemon ---------------------------------------------------------
const daemonLog = fs.openSync(path.join(tmp, 'daemon.log'), 'w')
const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
  env: { ...process.env, BACKLIGHT_HOME: tmp, BACKLIGHT_PORT: String(port), BACKLIGHT_TRAY: '0', BACKLIGHT_VERBOSE: '1' },
  stdio: ['ignore', daemonLog, daemonLog],
})

const api = async (route: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, body === undefined
    ? { signal: AbortSignal.timeout(60_000) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const result = await r.json() as any
  assert.ok(r.ok, `${route}: ${JSON.stringify(result)}`)
  return result
}
async function waitFor(fn: () => Promise<boolean> | boolean, message: string, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(150) }
  throw new Error(message)
}

/** PIDs whose argv contains an exact literal path (no pkill -f regex). */
function listProcessesMatching(needle: string): number[] {
  const pids: number[] = []
  try {
    const ps = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 5_000 })
    for (const line of ps.split('\n')) {
      if (!line.includes(needle)) continue
      const pid = Number(line.trim().split(/\s+/, 1)[0])
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.push(pid)
    }
  } catch { /* ps unavailable */ }
  return pids
}

let cleanedUp = false
async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  await sleep(500)
  try {
    await fetch(`http://127.0.0.1:${port}/api/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3_000),
    })
  } catch { /* daemon may be gone */ }
  try { daemon.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  try { if (daemon.exitCode === null) daemon.kill('SIGKILL') } catch { /* ignore */ }
  try { site.close() } catch { /* ignore */ }
  try { fs.closeSync(daemonLog) } catch { /* ignore */ }
  const profileDir = path.join(tmp, 'spaces', 'default', 'profile')
  const stragglers = new Set<number>(listProcessesMatching(profileDir))
  if (typeof daemon.pid === 'number' && daemon.exitCode === null) stragglers.add(daemon.pid)
  for (const target of stragglers) { try { process.kill(target, 'SIGTERM') } catch { /* gone */ } }
  await sleep(500)
  for (const target of stragglers) { try { process.kill(target, 'SIGKILL') } catch { /* gone */ } }
  await sleep(300)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`\n${signal} received; cleaning up isolated test environment…`)
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  })
}

let cdp: Cdp | undefined
let samplerRunning = false

try {
  await waitFor(async () => !!(await api('status')).daemon, 'daemon startup', 15_000)
  await api('settings', { captureKeepAlive: true, backgroundMode: true, collapseMode: 'minimize', pumpFps: 1 })
  await api('launch', { url: siteUrl, keepVisible: true })
  const status = await api('status')
  const pid = status.browser.pid as number
  assert.ok(pid > 0, 'managed browser pid unavailable')
  cdp = await Cdp.connect((await fetchVersion(status.browser.upstreamPort)).webSocketDebuggerUrl)
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>('Target.getTargets')
  const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith(siteUrl))
  assert.ok(page, 'probe page not found')
  const targetId = page.targetId
  const session = await cdp.attach(targetId)
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })

  const readNativeRaf = () => cdp!.evaluateOnSession<number>(session, 'window.__h ? window.__h.raf : 0')
  await waitFor(async () => (await readNativeRaf().catch(() => 0)) > 0, 'injected rAF counter lands', 15_000)
  const rafRate = async (ms: number) => {
    const a = await readNativeRaf()
    await sleep(ms)
    const b = await readNativeRaf()
    return Math.round(((b - a) / (ms / 1000)) * 10) / 10
  }
  const baselineRaf = await rafRate(2_000)
  assert.ok(baselineRaf >= MIN_CAPTURE_NATIVE_PER_SEC, `visible baseline native rAF ${baselineRaf}/s < ${MIN_CAPTURE_NATIVE_PER_SEC}`)
  console.log(`isolated Backlight: pid=${pid} port=${port} target=${targetId.slice(0, 8)} window=${windowId} baseline native rAF=${baselineRaf}/s (never touches 9333)`)

  // ---- high-frequency native watcher: starts BEFORE the bg request ----------
  type Sample = { atMs: number; probe: NativeVisibilityProbe | null; cdpState: string | null }
  const samples: Sample[] = []
  let T0 = Date.now()
  samplerRunning = true
  void (async () => {
    while (samplerRunning) {
      const started = Date.now()
      let probe: NativeVisibilityProbe | null = null
      try { probe = await nativeVisibility(pid) } catch { /* probe gap is recorded and treated as a failure */ }
      let cdpState: string | null = null
      try { cdpState = (await cdp!.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })).bounds.windowState ?? null } catch { /* transient */ }
      samples.push({ atMs: Date.now() - T0, probe, cdpState })
      const elapsed = Date.now() - started
      await sleep(Math.max(0, SAMPLE_MS - elapsed))
    }
  })()

  // ---- explicit bg; capture keep-alive must arm without any visibility ------
  T0 = Date.now()
  await api('bg', { source: 'probe.explicit.bg' })
  await waitFor(async () => (await api('status')).browser?.captureTargetId === targetId,
    'capture keep-alive engages for the probe target', 30_000)
  // keep watching until at least MIN_SETTLED_SAMPLES samples exist after settling
  await waitFor(() => {
    const settledIndex = samples.findIndex(s => s.probe && isInvisibleProbe(s.probe) && s.cdpState === 'minimized')
    return settledIndex >= 0 && samples.length - settledIndex >= MIN_SETTLED_SAMPLES
  }, 'high-frequency evidence window after capture engagement', 20_000)
  samplerRunning = false
  await sleep(SAMPLE_MS * 2)

  const settledIndex = samples.findIndex(s => s.probe && isInvisibleProbe(s.probe) && s.cdpState === 'minimized')
  assert.ok(settledIndex >= 0, 'window must settle hidden+minimized after bg')
  const afterSettle = samples.slice(settledIndex)
  const violations = afterSettle.filter(s => !s.probe || !isInvisibleProbe(s.probe) || (s.cdpState !== null && s.cdpState !== 'minimized'))
  const describe = (s: Sample) => `t=${(s.atMs / 1000).toFixed(2)}s hidden=${s.probe?.hidden} onScreen=${s.probe?.onScreenWindowCount} cdp=${s.cdpState}`
  assert.deepEqual(violations, [],
    `ANY visibility transition after bg is a release blocker:\n${violations.slice(0, 10).map(describe).join('\n')}`)
  console.log(`no-visibility contract: ${afterSettle.length} samples at ~${SAMPLE_MS}ms, 0 on-screen/unhidden after settling`)
  console.log(`  settle timeline: bg at 0.00s; first hidden sample ${(samples[settledIndex]!.atMs / 1000).toFixed(2)}s; capture armed and observed for ${((samples.at(-1)!.atMs - samples[settledIndex]!.atMs) / 1000).toFixed(1)}s`)

  // capture must actually be on and fast: no tradeoff was silently introduced
  const capturedRaf = await rafRate(3_000)
  assert.ok(capturedRaf >= MIN_CAPTURE_NATIVE_PER_SEC,
    `captured native compositor rAF ${capturedRaf}/s < ${MIN_CAPTURE_NATIVE_PER_SEC} (capture must keep full speed)`)
  console.log(`captured while minimized+hidden: native rAF=${capturedRaf}/s (baseline ${baselineRaf}/s)`)

  // capture must not have performed any window/app operation
  const entries = (await api('state-log?limit=200')).entries as any[]
  assert.ok(!entries.some(e => e.event === 'capture-window'), `capture recorded window mutations: ${JSON.stringify(entries.filter(e => e.event === 'capture-window'))}`)
  assert.ok(!entries.some(e => e.event === 'internal-native'), 'capture must not trigger native activation intervals')
  assert.ok(entries.some(e => e.event === 'capture-started'), 'capture-started provenance missing')
  assert.ok(!JSON.stringify(entries).includes('http'), 'state log must not contain URLs')

  // ---- an explicit show still works (login/show contract preserved) ---------
  await api('show', { maximize: true, activate: false, source: 'probe.explicit.show' })
  await waitFor(async () => {
    const probe = await nativeVisibility(pid).catch(() => null)
    const state = (await api('windows')).windows?.[0]?.state
    return !!probe && probe.hidden === false && probe.onScreenWindowCount >= 1 && state === 'maximized'
  }, 'explicit show restores the window')
  const restoredRaf = await rafRate(2_000)
  assert.ok(restoredRaf >= MIN_CAPTURE_NATIVE_PER_SEC, `restored native rAF ${restoredRaf}/s < ${MIN_CAPTURE_NATIVE_PER_SEC}`)
  console.log(`explicit show: maximized/on-screen, native rAF=${restoredRaf}/s`)

  console.log('\nPASS bg invisibility probe (isolated Backlight.app, temp home, random port)')
} catch (err) {
  console.error('\nFAIL bg invisibility probe')
  try { console.error(`\n  daemon log tail:\n${fs.readFileSync(path.join(tmp, 'daemon.log'), 'utf8').split('\n').slice(-50).join('\n')}`) } catch { /* ignore */ }
  throw err
} finally {
  samplerRunning = false
  await cleanup()
}
