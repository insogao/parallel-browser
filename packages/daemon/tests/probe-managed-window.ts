import { backlightFixture } from './backlight-fixture.ts'
/**
 * OPT-IN bounded real-machine probe (NOT part of any default test chain).
 *
 * Question (task B, product trade-off 2026-09-17): in a zero-window Chrome
 * session, can the daemon create ONE real tab (= one real managed window, which
 * macOS may show once), collapse it to the background, and later have a human
 * open restore the SAME document (same target, same in-memory JS), without a
 * second window and without URL cloning?
 *
 * What it measures on an isolated copy of the branded Backlight.app
 * (temp BACKLIGHT_HOME, random port, temp profile, direct spawn; never touches
 * the live 9333 daemon, the daily profile or LaunchServices' running app):
 *   1. first `Target.createTarget({background:true})` in a zero-window browser
 *   2. whether/for how long the app becomes unhidden/on-screen (one-time
 *      display; recorded, not asserted to be zero)
 *   3. minimize + native hide, then >=2s settled sampling
 *   4. restore (simulated human open): target id, JS nonce and
 *      performance.timeOrigin must be unchanged
 *
 * Run: caffeinate -dis node tests/probe-managed-window.ts [--keep]
 * Exit 0 = identity preserved; 1 = failed (evidence kept); 2 = not-run.
 */
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Cdp, fetchVersion } from '../src/cdp.ts'
import { findFreePort } from '../src/ports.ts'

const execFileAsync = promisify(execFile)
const keep = process.argv.includes('--keep')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-managed-win-'))
const binary = backlightFixture(tmp)
const profile = path.join(tmp, 'spaces', 'default', 'profile')
const appControl = path.join(os.homedir(), 'Library/Application Support/Backlight/bin/app-control')
if (!fs.existsSync(appControl)) {
  console.error(`not-run: app-control missing at ${appControl}`)
  process.exit(2)
}

const site = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>bl-managed-window probe</title>
<body style="font:28px monospace">probe
<script>window.__blProbeLoaded = true</script></body>`)
})
await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}/`
const port = await findFreePort()

interface Probe { active: boolean; hidden: boolean; windowCount: number; onScreenWindowCount: number }
const visibility = async (pid: number): Promise<Probe> =>
  JSON.parse((await execFileAsync(appControl, ['visibility', String(pid)], { encoding: 'utf8', timeout: 5_000 })).stdout)
const appStateText = async (pid: number): Promise<Probe> => {
  const state = JSON.parse((await execFileAsync(appControl, ['state', String(pid)], { encoding: 'utf8', timeout: 5_000 })).stdout)
  return { active: state.active, hidden: state.hidden, windowCount: -1, onScreenWindowCount: -1 }
}
const setHidden = async (pid: number, hidden: boolean) => {
  await execFileAsync(appControl, [hidden ? 'hide' : 'unhide', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  for (let i = 0; i < 30; i++) {
    const state = await appStateText(pid)
    if (state.hidden === hidden) return state
    await sleep(100)
  }
  return appStateText(pid)
}
/** Main browser process for the isolated profile (helpers carry --type=). */
function mainPid(): number | null {
  const ps = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 5_000 })
  for (const line of ps.split('\n')) {
    if (!line.includes(`user-data-dir=${profile}`) || line.includes('--type=')) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (pid > 0) return pid
  }
  return null
}

const args = [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--no-startup-window',
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--autoplay-policy=no-user-gesture-required',
  '--window-position=-1198,925', '--window-size=1200,800',
]
console.log(`[managed-window probe] binary=${binary}`)
console.log(`[managed-window probe] profile=${profile} port=${port}`)
const child = spawn(binary, args, { stdio: 'ignore' })
let pid = -1

interface Sample { t: number; active: boolean; hidden: boolean; onScreen: number }
const samples: Sample[] = []
let sampling = true
const t0 = Date.now()
const sampler = (async () => {
  while (sampling) {
    if (pid > 0) {
      try {
        const probe = await visibility(pid)
        samples.push({ t: Date.now() - t0, active: probe.active, hidden: probe.hidden, onScreen: probe.onScreenWindowCount })
      } catch { /* process may be gone */ }
    }
    await sleep(100)
  }
})()

let cdp: Cdp | null = null
let targetId: string | null = null
let windowId: number | null = null
let failure: string | null = null
const summary: Record<string, unknown> = {}

try {
  const deadline = Date.now() + 20_000
  let version: { webSocketDebuggerUrl: string } | null = null
  while (Date.now() < deadline) {
    try { version = await fetchVersion(port, 1500); break } catch { await sleep(300) }
  }
  if (!version) throw new Error('debug endpoint did not come up')
  pid = mainPid() ?? -1
  if (pid <= 0) throw new Error('could not resolve the isolated browser pid')
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)

  // Mirror the daemon: hide before the first real target so the only possible
  // display is macOS' one-time first-window activation.
  const hidden = await setHidden(pid, true)
  summary.beforeCreateHidden = hidden.hidden

  const createStart = Date.now()
  const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: siteUrl, background: true })
  targetId = created.targetId
  let resolvedWindowId: number | null = null
  for (let i = 0; i < 50 && resolvedWindowId === null; i++) {
    try {
      resolvedWindowId = (await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })).windowId
    } catch { await sleep(100) }
  }
  if (resolvedWindowId === null) throw new Error('the first real target did not get a native window')
  windowId = resolvedWindowId
  summary.windowId = windowId
  summary.windowResolvedMs = Date.now() - createStart

  const sessionId = await cdp.attach(targetId)
  const evaluate = async (expression: string): Promise<any> => {
    const res = await cdp!.send<{ result?: { value?: any }; exceptionDetails?: any }>(
      'Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`)
    return res.result?.value
  }
  for (let i = 0; i < 50; i++) {
    if (await evaluate('document.readyState === "complete" && window.__blProbeLoaded === true').catch(() => false)) break
    await sleep(100)
  }
  const identity = await evaluate(`(() => { window.__blProbeNonce = 'n-' + Math.random().toString(36).slice(2);
    return { nonce: window.__blProbeNonce, timeOrigin: performance.timeOrigin, title: document.title } })()`)
  if (!identity?.nonce) throw new Error('could not establish the page identity nonce')
  await sleep(1200)

  // One-time display characterisation (recorded, not required to be invisible).
  const beforeSettle = samples.filter(s => s.t > createStart - t0)
  summary.createVisibleSamples = beforeSettle.filter(s => !s.hidden || s.onScreen > 0).length
  summary.createActiveSamples = beforeSettle.filter(s => s.active).length
  summary.createSamples = beforeSettle.length

  // Settle to background exactly like the daemon: minimize, then native hide.
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  let minimised = false
  for (let i = 0; i < 30; i++) {
    const bounds = await cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
    if (bounds.bounds.windowState === 'minimized') { minimised = true; break }
    await sleep(100)
  }
  const afterHide = await setHidden(pid, true)
  summary.minimised = minimised
  summary.settledHidden = afterHide.hidden

  const settleStart = Date.now()
  await sleep(2200)
  const settled = samples.filter(s => s.t >= settleStart - t0)
  summary.settledSamples = settled.length
  summary.settledViolations = settled.filter(s => !s.hidden || s.onScreen > 0 || s.active).length

  // The page must still be the same document after background time.
  const targetInfos = (await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets')).targetInfos
  const stillThere = targetInfos.some(t => t.targetId === targetId && t.type === 'page')
  const backgroundIdentity = await evaluate('({ nonce: window.__blProbeNonce, timeOrigin: performance.timeOrigin })')
  summary.targetAliveWhileBackgrounded = stillThere
  summary.noncePreservedWhileBackgrounded = backgroundIdentity?.nonce === identity.nonce

  // Simulated human open: restore the SAME window (no new target anywhere).
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await setHidden(pid, false)
  await sleep(1000)
  const afterShowTargets = (await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets')).targetInfos
  const identityAfterShow = await evaluate('({ nonce: window.__blProbeNonce, timeOrigin: performance.timeOrigin })')
  const sameTarget = afterShowTargets.some(t => t.targetId === targetId && t.type === 'page')
  const sameDocument = identityAfterShow?.nonce === identity.nonce
    && identityAfterShow?.timeOrigin === identity.timeOrigin
  summary.sameTargetAfterShow = sameTarget
  summary.sameDocumentAfterShow = sameDocument
  summary.targetCountAfterShow = afterShowTargets.filter(t => t.type === 'page').length

  if (!stillThere || !backgroundIdentity || backgroundIdentity.nonce !== identity.nonce) {
    failure = 'page identity was not preserved while backgrounded'
  } else if (!sameTarget || !sameDocument) {
    failure = 'human open did not restore the same target/document'
  } else if (summary.targetCountAfterShow !== 1) {
    failure = `unexpected page target count after show: ${summary.targetCountAfterShow}`
  }
} catch (err) {
  failure = (err as Error).message
  summary.error = failure
} finally {
  sampling = false
  await sampler.catch(() => {})
  try { if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }) } catch { /* ignore */ }
  try { cdp?.close() } catch { /* ignore */ }
  await new Promise<void>(resolve => execFile('pkill', ['-f', `user-data-dir=${profile}`], () => resolve()))
  await sleep(500)
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  site.close()
}
const report = {
  ok: failure === null,
  failure,
  firstDisplay: {
    visibleSamples: summary.createVisibleSamples ?? null,
    activeSamples: summary.createActiveSamples ?? null,
    samples: summary.createSamples ?? null,
  },
  settle: {
    minimised: summary.minimised ?? null,
    hidden: summary.settledHidden ?? null,
    samples: summary.settledSamples ?? null,
    violations: summary.settledViolations ?? null,
  },
  identity: {
    targetId: targetId ? `${targetId.slice(0, 12)}…` : null,
    windowId: summary.windowId ?? null,
    aliveWhileBackgrounded: summary.targetAliveWhileBackgrounded ?? null,
    noncePreservedWhileBackgrounded: summary.noncePreservedWhileBackgrounded ?? null,
    sameTargetAfterShow: summary.sameTargetAfterShow ?? null,
    sameDocumentAfterShow: summary.sameDocumentAfterShow ?? null,
    pageTargetsAfterShow: summary.targetCountAfterShow ?? null,
  },
  evidence: { profileDir: tmp, samples: samples.length },
}
console.log(JSON.stringify(report, null, 2))
if (failure === null && !keep) {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
} else {
  console.log(`[managed-window probe] evidence kept at ${tmp}`)
}
process.exitCode = failure === null ? 0 : 1
