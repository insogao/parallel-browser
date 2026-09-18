import { backlightFixture } from './backlight-fixture.ts'
/**
 * Focused experiment: after a hidden capture-extension page is killed, can a
 * re-created hidden page acquire tabCapture again? Pinpoints which chrome.*
 * await hangs if not (tabs.query / tabCapture.getMediaStreamId / getUserMedia).
 *
 * Run: node tests/probe-hidden-capture-recreate.ts
 */
import type { Cdp } from '../src/cdp.ts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-hcrec-'))
const binary = backlightFixture(tmp)
process.env.BACKLIGHT_HOME = tmp // before importing paths-dependent modules
const { ensureCaptureExtension } = await import('../src/capture-extension.ts')
const { Cdp: CdpClient, fetchVersion } = await import('../src/cdp.ts')
const { findFreePort } = await import('../src/ports.ts')

const ext = ensureCaptureExtension()
if (!ext) throw new Error('capture extension materialization failed')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const port = await findFreePort()

const child = spawn(binary, [
  `--user-data-dir=${tmp}/profile`,
  `--remote-debugging-port=${port}`,
  `--load-extension=${ext.dir}`,
  `--allowlisted-extension-id=${ext.id}`,
  '--no-first-run', '--no-default-browser-check',
], { stdio: 'ignore' })

const evalBounded = async (cdp: Cdp, session: string, expression: string, ms = 5_000): Promise<string> => {
  const res = await Promise.race([
    cdp.send<{ result?: { value?: any }; exceptionDetails?: any }>(
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session),
    sleep(ms).then(() => 'HANG' as const),
  ])
  if (res === 'HANG') return 'HANG'
  if (res.exceptionDetails) return `EXC ${res.exceptionDetails.text}`
  return JSON.stringify(res.result?.value)
}
const newHiddenPage = async (cdp: Cdp): Promise<{ targetId: string; session: string }> => {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: ext.pageUrl, background: true, hidden: true })
  await sleep(500)
  const session = await cdp.attach(targetId)
  return { targetId, session }
}
const acquire = async (cdp: Cdp, session: string, step: string) => {
  console.log(`  [${step}] startCaptureByTitle: ${await evalBounded(cdp, session, `window.startCaptureByTitle('BACKLIGHT_AGENT')`, 6_000)}`)
  console.log(`  [${step}] state: ${await evalBounded(cdp, session, 'window.captureState()', 2_000)}`)
  console.log(`  [${step}] live: ${await evalBounded(cdp, session, 'window.captureLive()', 2_000)}`)
}
const stepwise = async (cdp: Cdp, session: string, step: string) => {
  const queryExpr = "chrome.tabs.query({title:'BACKLIGHT_AGENT'}).then(t => t.length)"
  const idExpr = "chrome.tabs.query({title:'BACKLIGHT_AGENT'}).then(async t => { if(!t.length) return 'no-tab'; const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: t[0].id }); return typeof id === 'string' && id.length > 0 ? 'ok' : 'empty' })"
  const gumExpr = "chrome.tabs.query({title:'BACKLIGHT_AGENT'}).then(async t => { if(!t.length) return 'no-tab'; const sid = await chrome.tabCapture.getMediaStreamId({ targetTabId: t[0].id }); const s = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ mandatory:{ chromeMediaSource:'tab', chromeMediaSourceId: sid } } }); const live = s.getVideoTracks().some(x => x.readyState === 'live'); s.getTracks().forEach(x => x.stop()); return 'live:'+live })"
  console.log(`  [${step}] query: ${await evalBounded(cdp, session, queryExpr, 4_000)}`)
  console.log(`  [${step}] streamId: ${await evalBounded(cdp, session, idExpr, 6_000)}`)
  console.log(`  [${step}] getUserMedia: ${await evalBounded(cdp, session, gumExpr, 8_000)}`)
}

try {
  let version: any = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { version = await fetchVersion(port, 1500); break } catch { await sleep(300) }
  }
  if (!version) throw new Error('no debug endpoint')
  const cdp = await CdpClient.connect(version.webSocketDebuggerUrl)

  const target = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'data:text/html,<title>BACKLIGHT_AGENT</title><body>t' })
  await sleep(800)
  const targetSession = await cdp.attach(target.targetId)

  // replicate the daemon's explicit-bg state: window minimized + app hidden
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: target.targetId })
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  await sleep(500)
  const { hideBrowser, browserAppState } = await import('../src/native.ts')
  if (child.pid) await hideBrowser(child.pid)
  console.log(`window minimized + app hidden: ${child.pid ? JSON.stringify(await browserAppState(child.pid)) : 'no-pid'}`)

  console.log('hidden page #1 (fresh):')
  const page1 = await newHiddenPage(cdp)
  await acquire(cdp, page1.session, 'p1')

  console.log('kill hidden page #1, then create #2:')
  console.log(`  closeTarget: ${JSON.stringify(await cdp.send('Target.closeTarget', { targetId: page1.targetId }).catch((e: Error) => e.message))}`)
  await sleep(1_000)
  const page2 = await newHiddenPage(cdp)
  await stepwise(cdp, page2.session, 'p2')
  await acquire(cdp, page2.session, 'p2')

  console.log('long wait while still minimized (is the stale stream reaped?):')
  await sleep(15_000)
  const page4 = await newHiddenPage(cdp)
  await stepwise(cdp, page4.session, 'p4-still-minimized')

  console.log('restore window (normal + unhidden), wait, then create #5:')
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  const { unhideBrowser } = await import('../src/native.ts')
  if (child.pid) await unhideBrowser(child.pid)
  await sleep(2_500)
  const page5 = await newHiddenPage(cdp)
  await stepwise(cdp, page5.session, 'p5-after-visible')
  await acquire(cdp, page5.session, 'p5-after-visible')
} catch (err) {
  console.error('FAIL', err)
  process.exitCode = 1
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}
