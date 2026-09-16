import { backlightFixture } from './backlight-fixture.ts'
/**
 * OPT-IN isolated regression probe (NOT part of `test` / `test:integration`).
 *
 * Release-blocker contract: after an explicit `/api/bg`, the managed browser
 * must never become visible again — not even for a sub-second transient.
 * A restart/launch that "repairs" visibility by hiding afterwards is not a
 * fix: the user counts ANY unintended reappearance as a bug.
 *
 * Live evidence that motivated this probe (2026-09-16 17:24, default daily
 * session): after `/api/bg` the getDisplayMedia-based capture setup
 * un-minimized the window (CDP normal), the capture picker unhid the app
 * (hidden=false, onScreen=2 at t=3s) before cleanup re-minimized/re-hid it at
 * t=4s. A later isolated run showed the same class of transient on hidden
 * restarts: macOS unhides a hidden app when a window creates/restores a tab,
 * so `stop() -> launch() -> hideApp()` could show the app between tab
 * recreation and the repair hide. This probe samples native WindowServer +
 * AppKit state at ~100ms and rejects ANY active/unhidden/onScreen>0 sample
 * from the last known hidden state until completion, starting BEFORE the
 * request and covering PID changes.
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
import { isInvisibleProbe, parseNativeVisibilityProbe, type NativeVisibilityProbe } from './window-state-samples.ts'

const execFileAsync = promisify(execFile)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-bg-invisible-'))
backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { findFreePort } = await import('../src/ports.ts')
const port = await findFreePort()

const SAMPLE_MS = 100
const MIN_SETTLED_SAMPLES = 20 // ≥2s of high-frequency evidence after settling
const MIN_CAPTURE_NATIVE_PER_SEC = 30
const profileDir = path.join(tmp, 'spaces', 'default', 'profile')

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

// ---- strict sampler: pre-request start + PID-change coverage -----------------
/**
 * Main browser processes for the managed profile (helpers all carry `--type=`,
 * so they are excluded). Discovered per sample so the watcher can follow the
 * browser across stop/launch PID changes.
 */
function managedMainPids(): number[] {
  const pids: number[] = []
  try {
    const ps = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 5_000 })
    for (const line of ps.split('\n')) {
      if (!line.includes(`user-data-dir=${profileDir}`) || line.includes('--type=')) continue
      const pid = Number(line.trim().split(/\s+/, 1)[0])
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.push(pid)
    }
  } catch { /* ps unavailable */ }
  return pids
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

interface StrictSample {
  atMs: number
  pid: number | null
  probe: NativeVisibilityProbe | null
  /** a live PID that the native probe could not read (conservative violation) */
  probeError: boolean
}

/** A sample is visible when the app is active, unhidden, or has an on-screen window. */
const sampleVisible = (s: StrictSample): boolean =>
  s.probeError || (s.probe !== null && (s.probe.active || !s.probe.hidden || s.probe.onScreenWindowCount > 0))

const describeSample = (s: StrictSample): string =>
  `t=${(s.atMs / 1000).toFixed(2)}s pid=${s.pid ?? '-'} hidden=${s.probe?.hidden ?? 'n/a'} active=${s.probe?.active ?? 'n/a'} onScreen=${s.probe?.onScreenWindowCount ?? 'n/a'}${s.probeError ? ' probe-error' : ''}`

function startStrictSampler() {
  const samples: StrictSample[] = []
  const t0 = Date.now()
  let running = true
  const loop = (async () => {
    while (running) {
      const started = Date.now()
      const pids = managedMainPids()
      if (pids.length === 0) {
        samples.push({ atMs: Date.now() - t0, pid: null, probe: null, probeError: false })
      } else {
        for (const pid of pids) {
          let probe: NativeVisibilityProbe | null = null
          let probeError = false
          try {
            probe = await nativeVisibility(pid)
          } catch {
            // A PID can die between `ps` and the probe; only a still-live PID
            // that cannot be read is a conservative failure.
            if (pidAlive(pid)) {
              await sleep(50)
              try { probe = await nativeVisibility(pid) } catch { probeError = pidAlive(pid) }
            }
          }
          samples.push({ atMs: Date.now() - t0, pid: pidAlive(pid) ? pid : null, probe, probeError })
        }
      }
      const elapsed = Date.now() - started
      await sleep(Math.max(0, SAMPLE_MS - elapsed))
    }
  })()
  return {
    samples,
    nowMs: () => Date.now() - t0,
    stop: async () => { running = false; await Promise.race([loop, sleep(600)]) },
  }
}

// ---- isolated daemon ---------------------------------------------------------
const daemonLog = fs.openSync(path.join(tmp, 'daemon.log'), 'w')
const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
  env: { ...process.env, BACKLIGHT_HOME: tmp, BACKLIGHT_PORT: String(port), BACKLIGHT_TRAY: '0', BACKLIGHT_VERBOSE: '1' },
  stdio: ['ignore', daemonLog, daemonLog],
})

const apiRaw = async (route: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, body === undefined
    ? { signal: AbortSignal.timeout(60_000) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const result = await r.json().catch(() => ({})) as any
  return { status: r.status, ok: r.ok, body: result }
}
const api = async (route: string, body?: unknown) => {
  const result = await apiRaw(route, body)
  assert.ok(result.ok, `${route}: ${JSON.stringify(result.body)}`)
  return result.body
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
let strictSampler: ReturnType<typeof startStrictSampler> | null = null

try {
  await waitFor(async () => !!(await api('status')).daemon, 'daemon startup', 15_000)
  await api('settings', { captureKeepAlive: true, backgroundMode: true, collapseMode: 'minimize', pumpFps: 1 })
  // Visible baseline launch is explicit: the acceptance needs a measurable
  // visible window (baseline native rAF + capture pre-arm target).
  await api('launch', { url: siteUrl, keepVisible: true, source: 'probe.bg-invisibility.launch' })
  const status = await api('status')
  let pid = status.browser.pid as number
  assert.ok(pid > 0, 'managed browser pid unavailable')
  cdp = await Cdp.connect((await fetchVersion(status.browser.upstreamPort)).webSocketDebuggerUrl)
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>('Target.getTargets')
  const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith(siteUrl))
  assert.ok(page, 'probe page not found')
  const targetId = page.targetId
  let session = await cdp.attach(targetId)
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

  // Prepare the tab that a restart would have to restore while visible, so the
  // hidden-restart section never needs to create a window from a hidden state
  // (that side effect is measured separately below).
  await api('open', { url: `${siteUrl}/?extra=restart`, source: 'probe.explicit.restart.prepare' })
  await waitFor(async () => (await cdp!.send<{ targetInfos: Array<{ type: string; url: string }> }>('Target.getTargets'))
    .targetInfos.some(t => t.url.includes('extra=restart')), 'restart-prepared second tab', 10_000)

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
  // Release-gate audit: the explicit bg's minimize/hide transitions carry their source+token.
  const bgMinimize = entries.filter(e => e.event === 'window-minimize' && e.source === 'probe.explicit.bg')
  assert.ok(bgMinimize.length > 0 && bgMinimize.every(e => typeof e.token === 'string'),
    `explicit bg minimize transitions need source+token: ${JSON.stringify(bgMinimize)}`)
  const bgHide = entries.filter(e => e.event === 'native-hide' && e.source === 'probe.explicit.bg')
  assert.ok(bgHide.length > 0 && bgHide.every(e => e.token === bgMinimize[0].token),
    'native hide must share the bg token')

  // ---- a synthetic/delayed tray.auto can never rebound the hidden window ----
  // The original release blocker: the tray observer posts /api/show with
  // source=tray.auto.*; an NSWorkspace activation is not a verified physical
  // click, so the daemon must keep the window hidden and log the provenance.
  const auto = await api('show', { source: 'tray.auto.activate', observedAt: Date.now(), activate: false })
  assert.equal(auto.restored, 0, `auto show must not restore: ${JSON.stringify(auto)}`)
  assert.equal(auto.ignored, 'unverified-activation', JSON.stringify(auto))
  for (let i = 0; i < 12; i++) {
    const probe = await nativeVisibility(pid).catch(() => null)
    assert.ok(!!probe && isInvisibleProbe(probe), `auto show exposed the app: ${JSON.stringify(probe)}`)
    assert.equal((await api('windows')).windows?.[0]?.state, 'minimized', 'auto show must not unminimize')
    await sleep(150)
  }
  const autoEntries = (await api('state-log?limit=200')).entries as any[]
  const autoSkips = autoEntries.filter(e => e.event === 'show-skip' && e.origin === 'auto')
  assert.ok(autoSkips.length > 0, 'auto show refusal must be logged with direct provenance')
  assert.ok(autoSkips.every(e => e.source === 'tray.auto.activate' && e.branch === 'unverified-activation' && e.route === 'POST /api/show'),
    `auto show-skip provenance must be direct: ${JSON.stringify(autoSkips)}`)
  assert.ok(!autoEntries.some(e => e.origin === 'auto' && (e.event === 'window-restore' || e.event === 'native-unhide')),
    'no auto-origin restore/unhide transition may exist after bg')
  const bgMinimizeAfterAuto = autoEntries.filter(e => e.event === 'window-minimize' && e.source === 'probe.explicit.bg')
  assert.equal(bgMinimizeAfterAuto.length, bgMinimize.length, 'auto show must not add window transitions')

  // ---- a hidden background restart must be deferred, never spawn-then-hide --
  // macOS unhides a hidden app when a window creates/restores a tab, so
  // `stop() -> launch() -> hideApp()` can only repair, not prevent, a visible
  // transient. The daemon therefore refuses a plain/automatic hidden restart
  // BEFORE stopping the current process and keeps the working session.
  // Sampling starts BEFORE the request and never stops until after the
  // response + settle; a post-settle-only assertion is a release blocker.
  const preRestartPid = pid
  const baselineProbes: NativeVisibilityProbe[] = []
  for (let i = 0; i < 5; i++) { baselineProbes.push(await nativeVisibility(pid)); await sleep(120) }
  assert.ok(baselineProbes.every(isInvisibleProbe), `pre-restart state must be invisible: ${JSON.stringify(baselineProbes)}`)

  strictSampler = startStrictSampler()
  const restartRequestAt = strictSampler.nowMs()
  const restartRaw = await apiRaw('restart', { reason: 'probe hidden restart', source: 'probe.explicit.restart' })
  await sleep(2_500)
  const restartSampleFrom = strictSampler.samples.findIndex(s => s.atMs >= restartRequestAt)
  const restartSamples = strictSampler.samples.slice(Math.max(0, restartSampleFrom))
  await strictSampler.stop()
  strictSampler = null

  const restartSamplesVisible = restartSamples.filter(sampleVisible)
  console.log(`hidden restart request: status=${restartRaw.status} body=${JSON.stringify(restartRaw.body)}; `
    + `${restartSamples.length} strict samples across the request, ${restartSamplesVisible.length} visible`)
  if (restartSamplesVisible.length > 0) {
    console.error(`DIAGNOSIS: hidden restart exposed the browser:\n${restartSamplesVisible.slice(0, 10).map(describeSample).join('\n')}`)
  }
  assert.equal(restartRaw.status, 409, `a hidden background restart must be refused: ${JSON.stringify(restartRaw)}`)
  assert.equal(restartRaw.body.ok, false, JSON.stringify(restartRaw.body))
  assert.equal(restartRaw.body.restarted, false, JSON.stringify(restartRaw.body))
  assert.equal(restartRaw.body.deferred, true, JSON.stringify(restartRaw.body))
  assert.ok(typeof restartRaw.body.reason === 'string' && restartRaw.body.reason.length > 0, 'refusal must name a reason')

  assert.deepEqual(restartSamplesVisible, [],
    `a deferred hidden restart exposed the browser:\n${restartSamplesVisible.slice(0, 10).map(describeSample).join('\n')}`)
  assert.ok(restartSamples.length >= 6, `strict sampler must cover the restart request (got ${restartSamples.length})`)

  const afterRefusal = await api('status')
  assert.equal(afterRefusal.browser?.running, true, 'a refused restart must keep the browser running')
  assert.equal(afterRefusal.browser?.pid, preRestartPid, 'a refused restart must not replace the process (no process loss)')
  assert.equal(afterRefusal.browser?.upstreamPort, status.browser.upstreamPort, 'a refused restart must preserve the session')
  const windowsAfterRefusal = (await api('windows')).windows as any[]
  assert.ok(windowsAfterRefusal.length > 0 && windowsAfterRefusal.every(w => w.state === 'minimized'),
    `a refused restart must leave the working session minimized: ${JSON.stringify(windowsAfterRefusal)}`)
  const restoredTabs = (await cdp.send<{ targetInfos: Array<{ type: string; url: string }> }>('Target.getTargets'))
    .targetInfos.filter(t => t.type === 'page' && t.url.startsWith(siteUrl))
  assert.ok(restoredTabs.length >= 2, `a refused restart must keep every session tab: ${JSON.stringify(restoredTabs.map(t => t.url))}`)

  // Honest logs: the refusal is recorded with direct provenance and reason.
  const refusalEntries = (await api('state-log?limit=200')).entries as any[]
  const deferral = refusalEntries.find(e => e.event === 'restart' && e.source === 'probe.explicit.restart')
  assert.ok(deferral, `restart refusal provenance missing: ${JSON.stringify(refusalEntries.slice(-8))}`)
  assert.equal(deferral.branch, 'deferred', JSON.stringify(deferral))
  assert.match(String(deferral.detail ?? ''), /hidden/i, `refusal detail must name the hidden state: ${JSON.stringify(deferral)}`)
  assert.ok(!refusalEntries.some(e => e.event === 'restart' && e.branch === 'forced-background' && e.source === 'probe.explicit.restart'),
    'a deferred restart must not log an applied background restart')
  console.log(`hidden restart deferred: ${restartSamples.length} strict samples across the request, 0 visible; pid ${preRestartPid} kept, session tabs kept`)

  // ---- a background tab open on the hidden browser must not expose it --------
  // `/api/open` creates a background target in the running browser. macOS can
  // unhide the app for a window/tab operation, so the same strict contract
  // applies: from the last known hidden state, nothing may become visible.
  strictSampler = startStrictSampler()
  const openRequestAt = strictSampler.nowMs()
  await api('open', { url: `${siteUrl}/?extra=open`, source: 'probe.explicit.open' })
  await waitFor(async () => (await cdp!.send<{ targetInfos: Array<{ type: string; url: string }> }>('Target.getTargets'))
    .targetInfos.some(t => t.url.includes('extra=open')), 'background tab created while hidden', 10_000)
  await sleep(2_000)
  const openSamples = strictSampler.samples.slice(strictSampler.samples.findIndex(s => s.atMs >= openRequestAt))
  await strictSampler.stop()
  strictSampler = null
  const openVisible = openSamples.filter(sampleVisible)
  assert.deepEqual(openVisible, [],
    `/api/open on a hidden browser exposed the app:\n${openVisible.slice(0, 10).map(describeSample).join('\n')}`)
  assert.ok(openSamples.length >= 6, `strict sampler must cover the open request (got ${openSamples.length})`)
  const stillInvisible = await nativeVisibility(pid)
  assert.ok(isInvisibleProbe(stillInvisible), `hidden browser became visible after open: ${JSON.stringify(stillInvisible)}`)
  console.log(`hidden /api/open: ${openSamples.length} strict samples, 0 visible; tab added while the app stayed hidden`)

  // ---- an explicit visible restart is still allowed (human contract) --------
  // With an explicit source AND an actual visibility flag the user asked for a
  // visible restart; the strict hidden rule does not apply, but the watcher
  // must still cover the PID change without gaps.
  const previousPid = pid
  strictSampler = startStrictSampler()
  await waitFor(() => strictSampler!.samples.some(s => s.pid === previousPid), 'sampler observes the pre-restart process', 5_000)
  await api('restart', { reason: 'probe visible restart', source: 'probe.explicit.restart', focus: true })
  const visibleStatus = await api('status')
  pid = visibleStatus.browser?.pid as number
  assert.ok(pid > 0 && pid !== previousPid, `visible restart must relaunch: ${JSON.stringify(visibleStatus.browser)}`)
  await waitFor(async () => {
    const probe = await nativeVisibility(pid).catch(() => null)
    return !!probe && probe.hidden === false && probe.onScreenWindowCount >= 1
  }, 'explicit visible restart shows the browser', 25_000)
  await sleep(1_500)
  await strictSampler.stop()
  const restartPids = [...new Set(strictSampler.samples.map(s => s.pid).filter((p): p is number => p != null))]
  strictSampler = null
  assert.ok(restartPids.includes(previousPid), 'sampler must start on the pre-restart process')
  assert.ok(restartPids.includes(pid), 'sampler must cover the new process across the PID change')
  const visibleEntries = (await api('state-log?limit=200')).entries as any[]
  const visibleRestart = visibleEntries.find(e => e.event === 'restart' && e.source === 'probe.explicit.restart' && e.branch === 'visible-request')
  assert.ok(visibleRestart && visibleRestart.after === 'visible', `explicit visible restart must log visible-request: ${JSON.stringify(visibleRestart)}`)
  console.log(`explicit visible restart: pid ${previousPid} -> ${pid} both sampled; window on-screen`)

  // Rebind to the restarted browser and measure the page a human can see. The
  // human-visible "full speed" contract is about a visible page; background-tab
  // throttling is irrelevant here (background full speed was proven above in
  // the minimized+capture window).
  cdp = await Cdp.connect((await fetchVersion(visibleStatus.browser.upstreamPort)).webSocketDebuggerUrl)
  const { targetInfos: restartedTargets } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
  const probeTargets = restartedTargets.filter(t => t.type === 'page' && t.url.startsWith(siteUrl))
  assert.ok(probeTargets.length > 0, 'restored probe page not found after visible restart')
  let measuredTarget = probeTargets[0]!
  let measuredSession: string | null = null
  for (const candidate of probeTargets) {
    const sid = await cdp.attach(candidate.targetId)
    const visibility = await cdp.evaluateOnSession<string>(sid, 'document.visibilityState').catch(() => 'unknown')
    if (visibility === 'visible') { measuredTarget = candidate; measuredSession = sid; break }
    await cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {})
  }
  await cdp.send('Target.activateTarget', { targetId: measuredTarget.targetId }).catch(() => {})
  session = measuredSession ?? await cdp.attach(measuredTarget.targetId)
  await waitFor(async () => (await readNativeRaf().catch(() => 0)) > 0, 'rAF counter after visible restart', 15_000)

  // ---- an explicit show still works (login/show contract preserved) ---------
  // The visible restart recreates windows; an explicit human show must still
  // maximize/foreground the session and restore full native speed.
  await api('show', { maximize: true, activate: false, source: 'probe.explicit.show' })
  await waitFor(async () => {
    const probe = await nativeVisibility(pid).catch(() => null)
    const state = (await api('windows')).windows?.[0]?.state
    return !!probe && probe.hidden === false && probe.onScreenWindowCount >= 1 && state === 'maximized'
  }, 'explicit show restores the window')
  const restoredRaf = await rafRate(2_000)
  assert.ok(restoredRaf >= MIN_CAPTURE_NATIVE_PER_SEC, `restored native rAF ${restoredRaf}/s < ${MIN_CAPTURE_NATIVE_PER_SEC}`)
  console.log(`explicit show (after visible restart): maximized/on-screen, native rAF=${restoredRaf}/s`)

  // Release-gate audit: the explicit show's restore transition is correlated.
  const showEntries = (await api('state-log?limit=200')).entries as any[]
  const showIntent = showEntries.find(e => e.event === 'control-intent' && e.branch === 'show' && e.source === 'probe.explicit.show')
  assert.ok(showIntent && typeof showIntent.token === 'string', `show control-intent needs source+token: ${JSON.stringify(showIntent)}`)
  assert.ok(showEntries.some(e => e.event === 'window-restore' && e.branch === 'maximize' && e.after === 'maximized' && e.token === showIntent.token),
    'applied maximize must share the show token')
  assert.ok(showEntries.some(e => e.event === 'native-unhide' && e.source === 'probe.explicit.show' && e.token === showIntent.token),
    'native unhide must share the show token')

  // ---- first background launch diagnosis (documented, not transient-free) ---
  // A cold background launch has no prior hidden state to protect, but macOS
  // can still briefly unhide the app while the first window/tab is born. The
  // probe records the exact timeline instead of pretending it is invisible;
  // the release gate is that the launch settles hidden and never reappears
  // afterwards, and that an already-running hidden browser is never restarted
  // (see the deferred-restart contract above).
  await api('stop', {})
  await waitFor(async () => !(await apiRaw('status')).body.browser?.running, 'browser stops for cold-launch diagnosis', 15_000)
  strictSampler = startStrictSampler()
  const coldRequestAt = strictSampler.nowMs()
  await api('launch', { url: `${siteUrl}/?cold=1`, source: 'probe.bg-invisibility.cold-launch' })
  const coldStatus = await api('status')
  pid = coldStatus.browser?.pid as number
  await waitFor(async () => isInvisibleProbe(await nativeVisibility(pid)), 'cold background launch settles hidden', 25_000)
  await sleep(2_000)
  const coldSamples = strictSampler.samples.slice(strictSampler.samples.findIndex(s => s.atMs >= coldRequestAt))
  await strictSampler.stop()
  strictSampler = null
  const firstVisible = coldSamples.find(sampleVisible)
  const firstHidden = coldSamples.find(s => s.probe && isInvisibleProbe(s.probe))
  assert.ok(firstHidden, `cold background launch never settled hidden: ${JSON.stringify(coldSamples.slice(-5).map(describeSample))}`)
  const hiddenIndex = coldSamples.indexOf(firstHidden)
  const reappeared = coldSamples.slice(hiddenIndex).filter(sampleVisible)
  assert.deepEqual(reappeared, [], `cold background launch reappeared after settling hidden:\n${reappeared.slice(0, 10).map(describeSample).join('\n')}`)
  assert.ok(coldSamples.length >= 6, `strict sampler must cover the cold launch (got ${coldSamples.length})`)
  const coldCdp = await Cdp.connect((await fetchVersion(coldStatus.browser.upstreamPort)).webSocketDebuggerUrl)
  const { targetInfos: coldTargets } = await coldCdp.send<{ targetInfos: Array<{ type: string; url: string }> }>('Target.getTargets')
  assert.ok(coldTargets.some(t => t.type === 'page' && t.url.includes('cold=1')), 'cold background launch must open its page while hidden')
  console.log(`cold background launch: ${coldSamples.length} strict samples; first hidden sample at ${(firstHidden.atMs / 1000).toFixed(2)}s; `
    + (firstVisible ? `transient before settling (${describeSample(firstVisible)})` : 'no active/unhidden/onScreen sample at all')
    + `; page present while hidden; no reappearance after settling`)

  console.log('\nPASS bg invisibility probe (isolated Backlight.app, temp home, random port)')
} catch (err) {
  console.error('\nFAIL bg invisibility probe')
  try { console.error(`\n  daemon log tail:\n${fs.readFileSync(path.join(tmp, 'daemon.log'), 'utf8').split('\n').slice(-50).join('\n')}`) } catch { /* ignore */ }
  throw err
} finally {
  samplerRunning = false
  try { await strictSampler?.stop() } catch { /* ignore */ }
  await cleanup()
}
