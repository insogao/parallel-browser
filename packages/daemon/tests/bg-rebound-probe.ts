import { backlightFixture } from './backlight-fixture.ts'
/**
 * OPT-IN isolated causal probe (NOT part of `test` / `test:integration`).
 *
 * Reproduces the tray/internal-capture bg→show rebound at the daemon boundary
 * on an isolated branded Backlight.app (temp BACKLIGHT_HOME, random port,
 * tray disabled, independent profile). It never touches the live 9333 session.
 *
 * Sequence:
 *   visible/maximized → explicit /api/bg → capture keep-alive engages
 *   → simulate the tray auto-show the capture picker would trigger
 *     (source=tray.auto.activate, observedAt inside the recorded internal
 *     activation interval) → assert ignored, window/app stay collapsed
 *   → wait until the internal interval closes → simulate a genuinely later
 *     user activation (observedAt after the interval) → assert it restores
 *   → explicit menu show is honored as well.
 *
 * Run: pnpm --filter @backlight/daemon test:bg-rebound
 *   or: caffeinate -dis node tests/bg-rebound-probe.ts
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { parseNativeWindowsProbe, type NativeWindowsProbe } from './window-state-samples.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-bg-rebound-'))
backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { findFreePort } = await import('../src/ports.ts')
const port = await findFreePort()

// ---- local site --------------------------------------------------------------
const site = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><meta charset="utf-8"><title>Backlight bg-rebound probe</title><body>probe</body>')
})
await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`

// ---- app-control (same Swift source the daemon builds) -----------------------
const appControl = path.join(tmp, 'bin', 'app-control')
fs.mkdirSync(path.dirname(appControl), { recursive: true })
execFileSync('/usr/bin/swiftc', [fileURLToPath(new URL('../../../tools/app-control.swift', import.meta.url)), '-o', appControl], { timeout: 120_000 })
const nativeState = (pid: number): { active: boolean; hidden: boolean } =>
  JSON.parse(execFileSync(appControl, ['state', String(pid)], { encoding: 'utf8', timeout: 5_000 }))
const nativeWindows = (pid: number): NativeWindowsProbe =>
  parseNativeWindowsProbe(execFileSync(appControl, ['windows', String(pid)], { encoding: 'utf8', timeout: 5_000 }))

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
  while (Date.now() < end) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(200) }
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

try {
  await waitFor(async () => !!(await api('status')).daemon, 'daemon startup', 15_000)
  await api('settings', { captureKeepAlive: true, backgroundMode: true, collapseMode: 'minimize', pumpFps: 10 })
  await api('launch', { url: siteUrl, keepVisible: true })
  const status = await api('status')
  const pid = status.browser.pid as number
  assert.ok(pid > 0, 'managed browser pid unavailable')
  const upstreamPort = status.browser.upstreamPort as number
  const targets = await (await fetch(`http://127.0.0.1:${upstreamPort}/json/list`)).json() as any[]
  const page = targets.find(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(siteUrl))
  assert.ok(page, 'probe page not found')
  const targetId = page.id as string

  await api('show', { maximize: true, activate: false, source: 'probe.setup' })
  console.log(`isolated Backlight: pid=${pid} port=${port} target=${targetId.slice(0, 8)} (never touches 9333)`)

  // ---- explicit bg: capture keep-alive must not rebound visibility ----------
  await api('bg', { source: 'probe.explicit.bg' })
  await waitFor(async () => (await api('status')).browser?.captureTargetId === targetId,
    'capture keep-alive engages for the probe target', 30_000)
  await waitFor(async () => {
    const entries = (await api('state-log?limit=200')).entries as any[]
    return entries.some(e => e.event === 'internal-native' && e.branch === 'begin')
  }, 'capture records its internal activation interval')
  // The picker interval can close before the next request; read the exact
  // recorded interval from the privacy-safe state log instead of racing it.
  await waitFor(async () => {
    const entries = (await api('state-log?limit=200')).entries as any[]
    return entries.some(e => e.event === 'internal-native' && e.branch === 'end')
  }, 'capture closes its internal activation interval', 30_000)
  const logEntries = (await api('state-log?limit=200')).entries as any[]
  const internalBegin = [...logEntries].reverse().find(e => e.event === 'internal-native' && e.branch === 'begin')
  const internalEnd = [...logEntries].reverse().find(e => e.event === 'internal-native' && e.branch === 'end')
  assert.ok(internalBegin && internalEnd, `internal interval provenance missing: ${JSON.stringify(logEntries)}`)
  assert.ok(internalEnd.at >= internalBegin.at)
  console.log(`capture internal activation interval: from=${internalBegin.at} to=${internalEnd.at} (picker activation)`)
  const observedAtInside = internalBegin.at + 50

  // Wait for production cleanup to settle hidden/minimized (park dance included).
  await waitFor(() => {
    const s = nativeState(pid)
    return s.hidden === true && nativeWindows(pid).onScreenWindowCount === 0
  }, 'app hidden + no native on-screen windows after capture setup', 20_000)

  // Simulate exactly the tray auto-show caused by the picker activation.
  const auto = await api('show', {
    source: 'tray.auto.activate', observedAt: observedAtInside, activate: false,
  })
  assert.equal(auto.ignored, 'internal-activation', `auto-show must be ignored: ${JSON.stringify(auto)}`)
  assert.equal(auto.restored, 0)

  // No window may appear for the whole observation window.
  const observeUntil = Date.now() + 3_000
  while (Date.now() < observeUntil) {
    const windows = (await api('windows')).windows as any[]
    assert.ok(windows.length > 0, 'window disappeared')
    assert.ok(windows.every(w => w.state === 'minimized'), `window reappeared after ignored auto-show: ${JSON.stringify(windows)}`)
    assert.equal(nativeState(pid).hidden, true, 'app became visible after ignored auto-show')
    assert.equal(nativeWindows(pid).onScreenWindowCount, 0, 'native on-screen window appeared after ignored auto-show')
    await sleep(250)
  }
  console.log('PASS: capture-driven tray auto-show ignored; bg state stable for 3s')

  // ---- a genuinely later user activation is still honored -------------------
  const late = await api('show', { source: 'tray.auto.activate', observedAt: internalEnd.at + 5_000, activate: false })
  assert.ok(late.restored >= 1, `later genuine activation must restore: ${JSON.stringify(late)}`)
  await waitFor(() => nativeState(pid).hidden === false && nativeWindows(pid).onScreenWindowCount >= 1,
    'later genuine activation becomes visible')
  console.log('PASS: later genuine user activation restores the window')

  // ---- explicit menu show after bg is honored even within the interval ------
  await api('bg', { source: 'probe.explicit.bg' })
  const explicit = await api('show', { source: 'tray.menu.show', activate: false })
  assert.ok(explicit.restored >= 1, `explicit menu show must restore: ${JSON.stringify(explicit)}`)
  console.log('PASS: explicit menu show wins over bg')

  const entries = (await api('state-log?limit=200')).entries as any[]
  assert.ok(entries.some(e => e.event === 'show-skip' && e.branch === 'internal-activation'), 'skip provenance missing')
  assert.ok(entries.some(e => e.event === 'capture-cleanup'), 'capture cleanup provenance missing')
  assert.ok(!JSON.stringify(entries).includes('http'), 'state log must not contain URLs')
  console.log('\nPASS bg-rebound probe (isolated Backlight.app, temp home, random port)')
} catch (err) {
  console.error('\nFAIL bg-rebound probe')
  try { console.error(`\n  daemon log tail:\n${fs.readFileSync(path.join(tmp, 'daemon.log'), 'utf8').split('\n').slice(-50).join('\n')}`) } catch { /* ignore */ }
  throw err
} finally {
  await cleanup()
}
