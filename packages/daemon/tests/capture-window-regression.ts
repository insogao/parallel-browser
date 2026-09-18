import { backlightFixture } from './backlight-fixture.ts'
/**
 * OPT-IN isolated regression test for the 2026-09-17 U3 report:
 * "minimized window popped to the front, content `bl-capture` (ACTIVE), while
 *  the daemon state-log shows no window-restore/native-activate".
 *
 * It observes, at high frequency and from independent channels:
 *   - AppKit/WindowServer: active/hidden/on-screen windows (app-control, ~60ms)
 *   - CDP: Browser.getWindowBounds (windowState) for every involved window
 *   - per-page document.visibilityState + document.hasFocus()
 *   - extension ground truth: chrome.tabs.query({active}) evaluated inside the
 *     capture extension page (is the capture page itself the active tab?)
 *
 * Scenarios (all on an isolated branded Backlight.app, temp BACKLIGHT_HOME,
 * random non-9333 port, temp profile; never touches the live 9333 session or
 * the daily profile):
 *   V   visible/maximized: background tab via Target.createTarget (control)
 *   H   hidden/minimized, capture disabled: background tab (control)
 *   C   hidden/minimized, capture enabled: capture page created while hidden
 *   R3  visible: capture page killed, then /api/bg re-creates and re-arms it
 *   R1  hidden: the ACTIVE captured tab is closed (the live 11:31 event); the
 *       capture page must never become the active tab and nothing may show
 *   R2  hidden: the capture page dies out-of-band; the keep-alive must detect
 *       it and release without revealing anything. Chrome for Testing 153 keeps
 *       the old tab-capture stream "active" until the window is visible again,
 *       so re-acquisition while minimized is not guaranteed (measured, see
 *       probe-hidden-capture-recreate.ts); that path must fail closed, never
 *       fall back to a visible tab.
 *   X2  hidden: Chrome-native Target.activateTarget reveal behavior (measured,
 *       external flows only; the capture code never calls it)
 *
 * Run: caffeinate -dis node tests/capture-window-regression.ts
 * Never add this to the default test chain.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-capwin-'))
backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { findFreePort } = await import('../src/ports.ts')
const port = await findFreePort()

const SAMPLE_MS = 60
const profileDir = path.join(tmp, 'spaces', 'default', 'profile')

// ---- local site: recorder pages (visibility/focus transitions + rAF) --------
const pageHtml = (name: string) => `<!doctype html><meta charset="utf-8"><title>bl-probe-${name}</title>
<body style="font:28px monospace">probe ${name}
<script>
  window.__rec = [];
  const push = (k) => window.__rec.push([k, Math.round(performance.now())]);
  document.addEventListener('visibilitychange', () => push('vis:' + document.visibilityState));
  window.addEventListener('focus', () => push('focus'));
  window.addEventListener('blur', () => push('blur'));
  window.__h = { raf: 0 };
  const f = () => { window.__h.raf++; requestAnimationFrame(f) };
  requestAnimationFrame(f);
</script></body>`
const site = http.createServer((req, res) => {
  const name = (req.url ?? '/').replace(/^\//, '').split('?')[0] || 'a'
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(pageHtml(name))
})
await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`

// ---- app-control (same Swift source the daemon builds) ----------------------
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
const stateLog = async (limit = 256) => (await api(`state-log?limit=${limit}`)).entries as any[]
async function waitFor(fn: () => Promise<boolean> | boolean, message: string, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(150) }
  throw new Error(message)
}

// ---- process helpers / cleanup ----------------------------------------------
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
  stopObservation()
  await sleep(300)
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

// ---- observation ------------------------------------------------------------
let cdp: Cdp
let pid = 0
let userWindowId = 0
let observationRunning = false
const obsT0 = Date.now()
interface Obs {
  atMs: number
  phase: string
  probe: NativeVisibilityProbe | null
  probeError: boolean
  windowState: string | null
  pages: Record<string, { vis: string | null; focus: boolean | null }>
  capture: {
    present: boolean
    targetId: string | null
    windowId: number | null
    vis: string | null
    selfTabId: number | null
    activeIsSelf: boolean | null
    windowTabCount: number | null
  } | null
}
const obs: Obs[] = []
const pageSessions = new Map<string, { targetId: string; sessionId: string; label: string }>()
let captureTargetId: string | null = null
let captureSessionId: string | null = null
let captureSessionTargetId: string | null = null
let phase = 'boot'
const marks: Array<{ atMs: number; label: string; kind: 'visible' | 'hidden' | 'info' }> = []
const mark = (label: string, kind: 'visible' | 'hidden' | 'info' = 'info') => {
  const atMs = Date.now() - obsT0
  marks.push({ atMs, label, kind })
  console.log(`    [${(atMs / 1000).toFixed(2)}s] ${label}`)
}
const startPhase = (name: string) => { phase = name; console.log(`\n== phase ${name} ==`) }
const stopObservation = () => { observationRunning = false }

/** Observation calls must never hang the watcher (e.g. a renderer busy with the
 * frame pump screenshot); they time out and are retried on the next sample. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer) }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      timer.unref?.()
    }),
  ])
}

const evalOn = async (sessionId: string, expression: string, awaitPromise = false, ms = 1_500): Promise<any> => {
  const res = await bounded(cdp.send<{ result?: { value?: any }; exceptionDetails?: any }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId), ms, 'Runtime.evaluate')
  if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`)
  return res.result?.value
}

async function captureState(): Promise<Obs['capture']> {
  const { targetInfos } = await bounded(cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets'), 1_200, 'Target.getTargets')
  // hidden targets are reported as type 'other' (CfT 153)
  const target = targetInfos.find(t => (t.type === 'page' || t.type === 'other') && t.url.includes('/capture.html'))
  if (!target) { captureTargetId = null; captureSessionId = null; captureSessionTargetId = null; return { present: false, targetId: null, windowId: null, vis: null, selfTabId: null, activeIsSelf: null, windowTabCount: null } }
  captureTargetId = target.targetId
  if (!captureSessionId || captureSessionTargetId !== target.targetId) {
    try { captureSessionId = await bounded(cdp.attach(target.targetId), 1_200, 'attach'); captureSessionTargetId = target.targetId } catch { captureSessionId = null; captureSessionTargetId = null }
  }
  let windowId: number | null = null
  try { windowId = (await bounded(cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: target.targetId }), 1_200, 'getWindowForTarget')).windowId } catch { /* gone */ }
  let vis: string | null = null
  if (captureSessionId) {
    try { vis = await evalOn(captureSessionId, 'document.visibilityState') } catch { /* reloading */ }
  }
  let selfTabId: number | null = null
  let activeIsSelf: boolean | null = null
  let windowTabCount: number | null = null
  if (captureSessionId) {
    try {
      const r = await evalOn(captureSessionId, `(async () => {
        if (!chrome || !chrome.tabs) return { hasApi: false };
        const self = await chrome.tabs.getCurrent();
        const tabs = await chrome.tabs.query({});
        const active = tabs.filter(t => t.active).map(t => t.id);
        const own = self ? tabs.filter(t => t.windowId === self.windowId) : [];
        return { hasApi: true, self: self ? self.id : null, activeIds: active, activeIsSelf: !!(self && active.includes(self.id)), windowTabCount: own.length };
      })()`, true)
      selfTabId = r?.self ?? null
      activeIsSelf = r?.hasApi ? !!r.activeIsSelf : null
      windowTabCount = r?.windowTabCount ?? null
    } catch { /* tabs API unavailable */ }
  }
  return { present: true, targetId: target.targetId, windowId, vis, selfTabId, activeIsSelf, windowTabCount }
}

async function observeOnce() {
  const atMs = Date.now() - obsT0
  let probe: NativeVisibilityProbe | null = null
  let probeError = false
  try { probe = await nativeVisibility(pid) } catch { probeError = true }
  let windowState: string | null = null
  try {
    windowState = (await bounded(cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId: userWindowId }), 1_200, 'getWindowBounds')).bounds.windowState ?? null
  } catch { /* window may be gone */ }
  const pages: Obs['pages'] = {}
  for (const [label, entry] of pageSessions) {
    try {
      pages[label] = await evalOn(entry.sessionId, '({vis: document.visibilityState, focus: document.hasFocus()})')
    } catch { pages[label] = { vis: null, focus: null } }
  }
  let capture: Obs['capture'] = null
  try { capture = await captureState() } catch { capture = null }
  obs.push({ atMs, phase, probe, probeError, windowState, pages, capture })
}

// ---- evidence helpers -------------------------------------------------------
const isVisibleObs = (o: Obs) =>
  o.probeError || o.probe === null || !isInvisibleProbe(o.probe)
const violations = (list: Obs[], requireMinimized = true) => list.filter(o =>
  isVisibleObs(o) || (requireMinimized && o.windowState !== null && o.windowState !== 'minimized'))
const describe = (o: Obs) =>
  `t=${(o.atMs / 1000).toFixed(2)}s phase=${o.phase} hidden=${o.probe?.hidden ?? 'err'} active=${o.probe?.active ?? 'err'} `
  + `onScreen=${o.probe?.onScreenWindowCount ?? 'err'} cdp=${o.windowState} `
  + `capture=${o.capture ? `win=${o.capture.windowId} vis=${o.capture.vis} activeSelf=${o.capture.activeIsSelf} tabCount=${o.capture.windowTabCount}` : 'absent'} `

/** settle: wait until the window is minimized in CDP and natively hidden/offscreen */
async function waitSettledHidden(what: string) {
  await waitFor(() => {
    const last = obs.at(-1)
    return !!last && last.windowState === 'minimized' && !!last.probe && isInvisibleProbe(last.probe)
  }, `settled hidden after ${what}`, 30_000)
  for (let i = 0; i < 4; i++) {
    const last = obs.at(-1)
    assert.ok(last && last.windowState === 'minimized' && last.probe && isInvisibleProbe(last.probe),
      `hidden state did not hold while settling after ${what}: ${last ? describe(last) : 'no sample'}`)
    await sleep(120)
  }
}

async function targetWindowId(targetId: string): Promise<number | null> {
  try { return (await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })).windowId } catch { return null }
}
const attachLabel = async (label: string, targetId: string) => {
  const sessionId = await cdp.attach(targetId)
  pageSessions.set(label, { targetId, sessionId, label })
  return sessionId
}
const targetBySuffix = async (suffix: string) => {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
  return targetInfos.find(t => t.type === 'page' && t.url.endsWith(suffix)) ?? null
}
async function readRecorder(label: string): Promise<any[]> {
  const entry = pageSessions.get(label)
  if (!entry) return []
  try { return await evalOn(entry.sessionId, 'window.__rec || []') } catch { return [] }
}
async function readHealth(targetId: string): Promise<any | null> {
  const targets = (await api('health')).targets as any[]
  return targets.find(t => t.targetId === targetId) ?? null
}

const failures: string[] = []
const findings: string[] = []
const check = (cond: boolean, message: string) => {
  if (cond) { console.log(`  PASS ${message}`); return }
  failures.push(message)
  console.error(`  FAIL ${message}`)
}

// ---- main -------------------------------------------------------------------
let probeErrorThrown: unknown = null
try {
  await waitFor(async () => !!(await api('status')).daemon, 'daemon startup', 20_000)
  await api('settings', { captureKeepAlive: false, backgroundMode: true, collapseMode: 'minimize', pumpFps: 1 })
  await api('launch', { url: `${siteUrl}/a`, keepVisible: true, source: 'probe.capwin.launch' })
  const status = await api('status')
  pid = status.browser.pid as number
  cdp = await Cdp.connect((await fetchVersion(status.browser.upstreamPort)).webSocketDebuggerUrl)
  const a = await targetBySuffix('/a')
  assert.ok(a, 'probe page /a missing')
  await attachLabel('a', a.targetId)
  userWindowId = (await targetWindowId(a.targetId)) ?? 0
  assert.ok(userWindowId > 0, 'page /a has no window')
  const aSession = pageSessions.get('a')!.sessionId
  await waitFor(async () => (await evalOn(aSession, 'window.__h ? window.__h.raf : 0').catch(() => 0)) > 0, 'page /a rAF counter', 15_000)

  observationRunning = true
  void (async () => {
    while (observationRunning) {
      const t = Date.now()
      try { await observeOnce() } catch { /* a bad sample must never stop the watcher */ }
      await sleep(Math.max(0, SAMPLE_MS - (Date.now() - t)))
    }
  })()

  await api('show', { maximize: true, activate: false, source: 'probe.capwin.show' })
  await waitFor(() => {
    const last = obs.at(-1)
    return !!last && last.windowState === 'maximized' && last.probe?.hidden === false
  }, 'visible/maximized baseline', 20_000)
  await sleep(600)
  console.log(`isolated Backlight: pid=${pid} port=${port} window=${userWindowId} (never touches 9333)`)

  // ---- V: visible background-tab control ------------------------------------
  startPhase('V-visible-bg-tab')
  mark('createTarget /b background:true while visible')
  const b = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${siteUrl}/b`, background: true })
  await waitFor(async () => !!(await targetBySuffix('/b')), 'tab /b appears', 10_000)
  await attachLabel('b', b.targetId)
  await sleep(1_500)
  const bWindow = await targetWindowId(b.targetId)
  const bState = await evalOn(pageSessions.get('b')!.sessionId, '({vis:document.visibilityState,focus:document.hasFocus()})')
  console.log(`  /b window=${bWindow} (user window=${userWindowId}) vis=${bState?.vis} focus=${bState?.focus}`)
  check(bWindow === userWindowId, 'background tab lands in the existing user window')
  check(bState?.vis === 'hidden', 'background tab is not the active tab while the window is visible')
  mark('close /b')
  await cdp.send('Target.closeTarget', { targetId: b.targetId }).catch(() => {})
  pageSessions.delete('b')

  // ---- H: hidden/minimized background-tab control ---------------------------
  startPhase('H-hidden-bg-tab')
  await api('bg', { source: 'probe.capwin.bg.control' })
  await waitSettledHidden('/api/bg (capture disabled)')
  const hStart = Date.now() - obsT0
  mark('createTarget /c background:true while hidden+minimized')
  const c = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${siteUrl}/c`, background: true })
  await waitFor(async () => !!(await targetBySuffix('/c')), 'tab /c appears', 10_000)
  await attachLabel('c', c.targetId)
  await sleep(3_000)
  const hEnd = Date.now() - obsT0
  const cWindow = await targetWindowId(c.targetId)
  console.log(`  /c window=${cWindow} (user window=${userWindowId})`)
  check(cWindow === userWindowId, 'hidden background tab lands in the existing user window')
  const hHidden = obs.filter(o => o.atMs >= hStart && o.atMs <= hEnd && o.phase === 'H-hidden-bg-tab')
  const hViolations = violations(hHidden)
  check(hViolations.length === 0, `background tab while hidden causes no visible sample (${hHidden.length} samples)`)
  if (hViolations.length > 0) console.error(hViolations.slice(0, 8).map(describe).join('\n'))

  // inspect which tab is active after the hidden create (explicit show once)
  mark('explicit show (activate:false) to inspect the active tab')
  await api('show', { activate: false, source: 'probe.capwin.show.inspect' })
  await sleep(1_500)
  const activeAfterH = {
    a: await evalOn(aSession, 'document.visibilityState').catch(() => null),
    c: await evalOn(pageSessions.get('c')!.sessionId, 'document.visibilityState').catch(() => null),
  }
  console.log(`  active-tab probe after show: /a=${activeAfterH.a} /c=${activeAfterH.c}`)
  mark('close /c, then /api/bg again')
  await cdp.send('Target.closeTarget', { targetId: c.targetId }).catch(() => {})
  pageSessions.delete('c')
  await api('bg', { source: 'probe.capwin.bg.again' })
  await waitSettledHidden('/api/bg again')
  mark('hidden state re-settled before capture scenario', 'hidden')

  // ---- C: the U3 path — capture page created while hidden --------------------
  startPhase('C-capture-created-while-hidden')
  const createdBefore = (await stateLog()).filter(e => e.event === 'capture-page' && e.branch === 'created').length
  mark('enable captureKeepAlive while hidden (tick will engage: branch=picked)')
  const cStart = Date.now() - obsT0
  await api('settings', { captureKeepAlive: true })
  await waitFor(async () => {
    const entries = await stateLog()
    return entries.filter(e => e.event === 'capture-page' && e.branch === 'created').length > createdBefore
      && entries.some(e => e.event === 'capture-started')
  }, 'capture page created + capture started while hidden', 40_000)
  await sleep(3_500)
  const cEnd = Date.now() - obsT0
  const cHidden = obs.filter(o => o.atMs >= cStart && o.atMs <= cEnd && o.phase === 'C-capture-created-while-hidden')
  const cViolations = violations(cHidden)
  check(cViolations.length === 0, `capture engage/create while hidden causes no visible sample (${cHidden.length} samples)`)
  if (cViolations.length > 0) console.error(cViolations.slice(0, 12).map(describe).join('\n'))
  const capObs = [...cHidden].reverse().find(o => o.capture?.present)?.capture
  console.log(`  capture page: target=${capObs?.targetId?.slice(0, 8)} window=${capObs?.windowId} (user window=${userWindowId}) `
    + `vis=${capObs?.vis} selfTab=${capObs?.selfTabId} activeIsSelf=${capObs?.activeIsSelf} windowTabCount=${capObs?.windowTabCount}`)
  check(capObs?.present === true && capObs.windowId === null && capObs.selfTabId === null,
    'capture page has no user window or tab-strip entry')
  check(capObs?.activeIsSelf !== true, 'capture page is NOT the active tab while hidden')
  const captureStatusC = await api('status')
  check(captureStatusC.browser?.captureTargetId === a.targetId, 'capture is armed for the probe page')
  const healthA = await readHealth(a.targetId)
  console.log(`  page /a native compositor rAF while minimized+captured: ${healthA?.nativeRafPerSec}/s, visibility=${healthA?.visibility}`)
  check(typeof healthA?.nativeRafPerSec === 'number' && healthA.nativeRafPerSec > 20, 'captured hidden page keeps native compositor frames')
  const entriesC = await stateLog()
  check(!entriesC.some(e => e.event === 'capture-window'), 'no capture-window mutation provenance was recorded')
  const recA = await readRecorder('a')
  console.log(`  /a in-page events during hidden phase: ${JSON.stringify(recA.slice(-6))}`)

  // ---- R3: positive re-creation while the window is visible -----------------
  // While visible, Chromium releases the old tab-capture stream immediately, so
  // this proves the daemon detects a dead capture page, re-creates its hidden
  // page and re-arms — with zero window/app operations.
  startPhase('R3-recreate-while-visible')
  mark('explicit show (maximize) while the capture is armed')
  await api('show', { maximize: true, activate: false, source: 'probe.capwin.show.r3' })
  await waitFor(() => {
    const last = obs.at(-1)
    return !!last && last.windowState === 'maximized' && last.probe?.hidden === false
  }, 'visible before the re-creation scenario', 20_000)
  const createdBefore3 = (await stateLog()).filter(e => e.event === 'capture-page' && e.branch === 'created').length
  const startedBefore3 = (await stateLog()).filter(e => e.event === 'capture-started').length
  mark('Target.closeTarget on the capture page while visible')
  await cdp.send('Target.closeTarget', { targetId: captureTargetId! }).catch(() => {})
  await waitFor(async () => (await stateLog()).some(e =>
    e.event === 'capture-release' && e.branch === 'capture page gone'), 'liveness release while visible', 20_000)
  mark('/api/bg: prearm must re-create the hidden page and re-arm while visible')
  await api('bg', { source: 'probe.capwin.bg.r3' })
  await waitFor(async () => {
    const entries = await stateLog()
    return entries.filter(e => e.event === 'capture-page' && e.branch === 'created').length > createdBefore3
      && entries.filter(e => e.event === 'capture-started').length > startedBefore3
  }, 'capture page re-created and re-armed while visible', 40_000)
  await waitSettledHidden('/api/bg re-creation')
  const r3Start = Date.now() - obsT0
  await sleep(2_500)
  const r3End = Date.now() - obsT0
  const r3Hidden = obs.filter(o => o.atMs >= r3Start && o.atMs <= r3End && o.phase === 'R3-recreate-while-visible')
  const r3Violations = violations(r3Hidden)
  check(r3Violations.length === 0, `re-creation after settling hidden causes no visible sample (${r3Hidden.length} samples)`)
  if (r3Violations.length > 0) console.error(r3Violations.slice(0, 12).map(describe).join('\n'))
  const captureStatusR3 = await api('status')
  check(captureStatusR3.browser?.captureTargetId === a.targetId, 're-created capture is armed for page /a')
  const healthA3 = await readHealth(a.targetId)
  console.log(`  page /a native compositor rAF after visible re-creation: ${healthA3?.nativeRafPerSec}/s`)
  check(typeof healthA3?.nativeRafPerSec === 'number' && healthA3.nativeRafPerSec > 20, 're-created capture keeps native compositor frames')
  const capObsR3 = [...obs].reverse().find(o => o.capture?.present)?.capture
  console.log(`  re-created capture page: window=${capObsR3?.windowId} vis=${capObsR3?.vis} `
    + `activeIsSelf=${capObsR3?.activeIsSelf} windowTabCount=${capObsR3?.windowTabCount}`)
  check(capObsR3?.windowId === null && capObsR3.selfTabId === null,
    're-created capture page remains outside the user window and tab strip')
  check(capObsR3?.activeIsSelf !== true, 're-created capture page is not the active tab')

  // ---- R1: close the ACTIVE captured tab while hidden ------------------------
  // The live 11:31 event: the test runner closes its (active) tab; Chromium then
  // activates the next entry in the tab strip. Before the fix that was the
  // capture page (`bl-capture` ACTIVE in the user window). It must now never be
  // the capture page, and the window must stay minimized+hidden.
  startPhase('R1-active-tab-close-while-hidden')
  const startedBefore1 = (await stateLog()).filter(e => e.event === 'capture-started').length
  mark('open /d in background while hidden (replacement target)')
  await api('open', { url: `${siteUrl}/d`, source: 'probe.capwin.open.d' })
  await waitFor(async () => !!(await targetBySuffix('/d')), 'tab /d appears', 10_000)
  const d = await targetBySuffix('/d')
  assert.ok(d, 'tab /d missing')
  await attachLabel('d', d.targetId)
  const r1Start = Date.now() - obsT0
  mark('Target.closeTarget on the ACTIVE captured tab /a')
  await cdp.send('Target.closeTarget', { targetId: a.targetId }).catch(() => {})
  pageSessions.delete('a')
  const diag = setInterval(() => {
    void api('health').then(h => console.log('    diag health: ' + (h.targets as any[])
      .map(t => `${String(t.targetId).slice(0, 6)} vis=${t.visibility} nraf=${t.nativeRafPerSec}`).join(' '))).catch(() => {})
  }, 4_000)
  let r1Rearmed = false
  try {
    await waitFor(async () => {
      const entries = await stateLog()
      return entries.filter(e => e.event === 'capture-started').length > startedBefore1
    }, 'capture re-armed after the active tab closed', 45_000)
    r1Rearmed = true
  } catch { /* recorded below */ } finally { clearInterval(diag) }
  await sleep(3_500)
  const r1End = Date.now() - obsT0
  const r1Hidden = obs.filter(o => o.atMs >= r1Start && o.atMs <= r1End && o.phase === 'R1-active-tab-close-while-hidden')
  const r1Violations = violations(r1Hidden)
  const r1Cap = [...r1Hidden].reverse().find(o => o.capture?.present)?.capture
  console.log(`  R1: rearmed=${r1Rearmed} capture page activeIsSelf=${r1Cap?.activeIsSelf} selfTab=${r1Cap?.selfTabId}`
    + ` windowTabCount=${r1Cap?.windowTabCount} visibleSamples=${r1Violations.length}/${r1Hidden.length}`)
  if (r1Violations.length > 0) console.error(r1Violations.slice(0, 12).map(describe).join('\n'))
  check(r1Violations.length === 0, 'closing the active user tab never reveals the window')
  check(r1Cap?.activeIsSelf !== true, 'the capture page never becomes the active tab (U3)')
  const captureStatusR1 = await api('status')
  console.log(`  R1 capture target after switch: ${captureStatusR1.browser?.captureTargetId === d.targetId ? '/d (re-armed)' : 'none/other (visible-report quirk?)'}`)

  // ---- R2: capture page dies out-of-band while hidden → fail closed ----------
  // CfT 153 keeps the killed page's tab-capture stream "active" until the
  // window is visible again (measured: getUserMedia hangs/errors, see
  // probe-hidden-capture-recreate.ts), so re-arming while minimized is not
  // guaranteed. The contract here is safety: detect, release, never reveal,
  // never fall back to a visible tab; recovery may be deferred (frame pump and
  // rAF shim keep the page logic alive meanwhile).
  startPhase('R2-capture-page-died-while-hidden')
  const startedBefore2 = (await stateLog()).filter(e => e.event === 'capture-started').length
  mark('Target.closeTarget on the capture page (not the active tab) while hidden')
  await cdp.send('Target.closeTarget', { targetId: captureTargetId! }).catch(() => {})
  const r2Start = Date.now() - obsT0
  await waitFor(async () => (await stateLog()).some(e =>
    e.event === 'capture-release' && e.branch === 'capture page gone'), 'liveness release after the capture page died', 20_000)
  let r2Rearmed = false
  try {
    await waitFor(async () => (await stateLog()).filter(e => e.event === 'capture-started').length > startedBefore2,
      'capture re-armed after re-creation', 25_000)
    r2Rearmed = true
  } catch { /* fail-closed while minimized is acceptable (Chrome stream limbo) */ }
  await sleep(2_500)
  const r2End = Date.now() - obsT0
  const r2Hidden = obs.filter(o => o.atMs >= r2Start && o.atMs <= r2End && o.phase === 'R2-capture-page-died-while-hidden')
  const r2Violations = violations(r2Hidden)
  check(r2Violations.length === 0, `capture-page death while hidden never reveals the window (${r2Hidden.length} samples)`)
  if (r2Violations.length > 0) console.error(r2Violations.slice(0, 12).map(describe).join('\n'))
  const { targetInfos: r2Targets } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
  const r2Pages = r2Targets.filter(t => t.url.includes('/capture.html'))
  console.log(`  R2: rearmed=${r2Rearmed} capture-page target types=${JSON.stringify(r2Pages.map(t => t.type))}`)
  check(r2Pages.every(t => t.type === 'other'), 'the capture page is never a tab-strip page target')
  if (!r2Rearmed) console.log('  NOTE: re-acquire while minimized is limited by Chrome (stale tab-capture stream until the window is visible); fail-closed, no visible tab')
  const stillMinimized = await api('windows')
  check((stillMinimized.windows as any[])?.every(w => w.state === 'minimized'), 'the window stays minimized through the capture-page death')

  // ---- X2: Chrome-native Target.activateTarget on a hidden window -------------
  // The daemon capture code never calls this; external/BrowserPilot flows do. It
  // is measured so a reveal can be attributed to that native path, not to capture.
  startPhase('X2-native-activate-target-while-hidden')
  const { targetInfos: x2Targets } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
  const activateMe = x2Targets.find(t => t.type === 'page' && t.url.endsWith('/d'))
    ?? x2Targets.find(t => t.type === 'page' && !t.url.includes('/capture.html'))
  if (activateMe) {
    mark('Target.activateTarget on a background tab while hidden+minimized')
    const x2Start = Date.now() - obsT0
    await cdp.send('Target.activateTarget', { targetId: activateMe.targetId }).catch(() => {})
    await sleep(2_500)
    const x2End = Date.now() - obsT0
    const x2Hidden = obs.filter(o => o.atMs >= x2Start && o.atMs <= x2End && o.phase === 'X2-native-activate-target-while-hidden')
    const x2Violations = violations(x2Hidden)
    console.log(`  X2: visibleSamples=${x2Violations.length}/${x2Hidden.length}`)
    if (x2Violations.length > 0) {
      console.error(x2Violations.slice(0, 8).map(describe).join('\n'))
      findings.push(`X2 (Target.activateTarget while hidden): ${x2Violations.length}/${x2Hidden.length} visible samples`)
    }
  } else {
    console.log('  X2 skipped: no page target to activate')
  }
  await sleep(1_000)
} catch (err) {
  probeErrorThrown = err
} finally {
  stopObservation()
  await sleep(300)

  // ---- report --------------------------------------------------------------
  console.log('\n===== observation summary =====')
  for (const m of marks) console.log(`  [${(m.atMs / 1000).toFixed(2)}s] ${m.kind.padEnd(7)} ${m.label}`)
  const byPhase = new Map<string, Obs[]>()
  for (const o of obs) {
    if (!byPhase.has(o.phase)) byPhase.set(o.phase, [])
    byPhase.get(o.phase)!.push(o)
  }
  for (const [name, list] of byPhase) {
    const visibleCount = list.filter(isVisibleObs).length
    const states = [...new Set(list.map(o => o.windowState))].join(',')
    const capA = list.filter(o => o.capture?.present).length
    const pageVis = new Map<string, Set<string>>()
    for (const o of list) {
      for (const [label, state] of Object.entries(o.pages)) {
        if (!pageVis.has(label)) pageVis.set(label, new Set())
        pageVis.get(label)!.add(String(state.vis))
      }
    }
    const pageStr = [...pageVis].map(([label, vis]) => `${label}=[${[...vis].join('|')}]`).join(' ')
    console.log(`  phase ${name}: ${list.length} samples, ${visibleCount} visible(active/unhidden/onScreen), windowState=[${states}], capture-page-samples=${capA} ${pageStr}`)
  }
  if (findings.length > 0) {
    console.log('  FINDINGS (native paths, measured):')
    for (const f of findings) console.log(`    - ${f}`)
  }
  const visibleSamples = obs.filter(isVisibleObs)
  if (visibleSamples.length > 0) {
    console.log(`  first 10 visible samples:\n${visibleSamples.slice(0, 10).map(describe).join('\n')}`)
  }
  const firstCap = obs.find(o => o.capture?.present)?.capture
  console.log(`  capture page tab ground truth when first seen: ${JSON.stringify(firstCap)}`)
  console.log(`  in-page visibility event counts: a=${(await readRecorder('a')).length} d=${(await readRecorder('d')).length}`)

  if (probeErrorThrown) {
    console.error('\nFAIL capture-window probe (see above)')
    try { console.error(`\n  daemon log tail:\n${fs.readFileSync(path.join(tmp, 'daemon.log'), 'utf8').split('\n').slice(-50).join('\n')}`) } catch { /* ignore */ }
    console.error(probeErrorThrown instanceof Error ? probeErrorThrown.stack : probeErrorThrown)
    process.exitCode = 1
  } else if (failures.length > 0) {
    console.error(`\nFAIL capture-window probe: ${failures.length} contract violation(s)`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('\nPASS capture-window probe (isolated Backlight.app, temp home, random port)')
  }
  await cleanup()
}
