import { backlightFixture } from './backlight-fixture.ts'
/**
 * Probe: does getDisplayMedia work from a HIDDEN (background/minimized) controller tab?
 *   D1: controller ACTIVE + visible  → start capture (known good)
 *   D2: controller BACKGROUND tab    → start capture → ?
 * Run: node tests/probe-capture2.ts
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findFreePort } from '../src/ports.ts'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cap2-'))
const backlightBinary = backlightFixture(TMP)
const SITE = 9492
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const AGENT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>BACKLIGHT_AGENT</title></head>
<body style="font:40px monospace;background:#101418;color:#39d98a">AGENT
<script>if(!window.__h){window.__h={raf:0,timer:0}};const f=()=>{window.__h.raf++;requestAnimationFrame(f)};requestAnimationFrame(f)</script></body></html>`
const CTRL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>bl-controller</title></head>
<body>ctrl<script>
window.__res = 'not-called'
window.tryCapture = (fps) => {
  navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false })
    .then(s => { window.__res = 'OK' })
    .catch(e => { window.__res = (e && e.name) + ': ' + (e && e.message) })
}
</script></body></html>`

async function main() {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/controller' ? CTRL_HTML : AGENT_HTML)
  })
  await new Promise<void>(r => site.listen(SITE, '127.0.0.1', r))

  const port = await findFreePort(9499)
  const args = [
    `--user-data-dir=${TMP}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT',
    '--blink-settings=displayCaptureRequiresUserGesture=false',
  ]
  const child = spawn(backlightBinary, args, { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 15_000
    let version: any = null
    while (Date.now() < deadline) {
      try { version = await fetchVersion(port, 1500); break } catch { await sleep(300) }
    }
    if (!version) throw new Error('no debug endpoint')
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)

    const { targetId: agentId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `http://127.0.0.1:${SITE}/agent` })
    await sleep(1200)
    const { targetId: ctrlId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `http://127.0.0.1:${SITE}/controller` })
    await sleep(1000)
    const agentSession = await cdp.attach(agentId)
    const ctrlSession = await cdp.attach(ctrlId)

    const clickAndCapture = async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }, ctrlSession)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, ctrlSession)
      await cdp.send('Runtime.evaluate', { expression: 'window.tryCapture(10)' }, ctrlSession)
      await sleep(2500)
      return (await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'window.__res', returnByValue: true }, ctrlSession)).result.value
    }
    const vis = async () => (await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, agentSession)).result.value
    const rafRate = async (ms: number) => {
      const a = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__h.raf', returnByValue: true }, agentSession)).result.value
      await sleep(ms)
      const b = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__h.raf', returnByValue: true }, agentSession)).result.value
      return Math.round(((b - a) / (ms / 1000)) * 10) / 10
    }
    const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: agentId })

    // D1: controller ACTIVE (visible) — baseline known good
    await cdp.send('Target.activateTarget', { targetId: ctrlId })
    await sleep(400)
    console.log(`D1 active controller: ${await clickAndCapture()}`)
    // stop it
    await cdp.send('Runtime.evaluate', { expression: 'window.__stream && window.__stream.getTracks().forEach(t=>t.stop())' }, ctrlSession)
    await sleep(500)

    // D2: controller BACKGROUND (agent tab active), then minimized window
    await cdp.send('Target.activateTarget', { targetId: agentId })
    await sleep(400)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    await sleep(500)
    console.log(`D2 hidden controller (minimized): res=${await clickAndCapture()} agentVis=${await vis()} agentRaf=${await rafRate(3000)}/s`)
  } finally {
    site.close()
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await sleep(400)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(0)
  }
}

await main()
