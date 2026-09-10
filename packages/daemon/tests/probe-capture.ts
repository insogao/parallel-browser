/**
 * P0 experiment v2: Tab Capture → CapturerCount keep-alive.
 * Pages served from http://127.0.0.1 (secure context) so getDisplayMedia works.
 *
 * Case A  agent tab is a BACKGROUND tab, no capture   → expect rAF ~0
 * Case B  agent tab is a BACKGROUND tab, tab-captured → exempted? (P0 question)
 * Case C  window minimized, tab-captured              → exempted?
 *
 * Run: node tests/probe-capture.ts
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findFreePort } from '../src/ports.ts'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cap-'))
const SITE = 9491
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const AGENT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>BACKLIGHT_AGENT</title></head>
<body style="font:40px monospace;background:#101418;color:#39d98a">AGENT
<canvas id="c" width="300" height="100" style="background:#222"></canvas>
<script>
  if (!window.__h) { window.__h = { raf: 0, timer: 0 }; }
  const f = () => { window.__h.raf++; requestAnimationFrame(f) }; requestAnimationFrame(f);
  setInterval(() => window.__h.timer++, 100);
  let x = 0; const ctx = document.getElementById('c').getContext('2d');
  const draw = () => { x = (x + 3) % 300; ctx.fillStyle = '#0f8'; ctx.fillRect(0, 0, 300, 100); ctx.fillStyle = '#123'; ctx.fillRect(x, 0, 20, 100); requestAnimationFrame(draw) };
  draw();
</script></body></html>`
const CTRL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>bl-controller</title></head>
<body style="font:30px monospace">controller <div id="s"></div>
<script>
  window.__capOk = false; window.__capErr = null; window.__capState = 'idle';
  window.startCapture = (fps) => {
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false })
      .then(s => { window.__capOk = true; window.__capState = s.getVideoTracks()[0].label; document.getElementById('s').textContent = 'CAPTURING' })
      .catch(e => { window.__capErr = (e && e.name) + ': ' + (e && e.message); document.getElementById('s').textContent = String(window.__capErr) })
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
    `--user-data-dir=${TMP}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT',
  ]
  const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args, { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 15_000
    let version: any = null
    while (Date.now() < deadline) {
      try { version = await fetchVersion(port, 1500); break } catch { await sleep(300) }
    }
    if (!version) throw new Error('no debug endpoint')
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)

    const { targetId: agentId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `http://127.0.0.1:${SITE}/agent` })
    await sleep(1500)
    const agentSession = await cdp.attach(agentId)
    await cdp.send('Page.enable', {}, agentSession)

    const evalA = async <T = any>(expr: string) => (await cdp.send<{ result: { value?: T } }>('Runtime.evaluate', { expression: expr, returnByValue: true }, agentSession)).result?.value
    const nativeRate = async (ms: number) => {
      const a = await evalA<number>('window.__h.raf')
      await sleep(ms)
      const b = await evalA<number>('window.__h.raf')
      return Math.round((((b ?? 0) - (a ?? 0)) / (ms / 1000)) * 10) / 10
    }
    const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: agentId })

    // ---- Case A: background tab, no capture ----
    const { targetId: ctrlId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `http://127.0.0.1:${SITE}/controller` })
    await sleep(1000) // controller becomes the active tab; agent is now background
    const ctrlSession = await cdp.attach(ctrlId)
    await cdp.send('Page.enable', {}, ctrlSession)
    const evalC = async <T = any>(expr: string) => (await cdp.send<{ result: { value?: T } }>('Runtime.evaluate', { expression: expr, returnByValue: true }, ctrlSession)).result?.value

    const caseA = await nativeRate(5000)
    const visA = await evalA<string>('document.visibilityState')
    console.log(`A) background tab, no capture : rAF=${caseA}/s vis=${visA} (expect ~0)`)

    // ---- start tab capture (click for activation, then getDisplayMedia) ----
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }, ctrlSession)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, ctrlSession)
    await evalC('window.startCapture(10)')
    await sleep(4000)
    const capOk = await evalC<boolean>('window.__capOk')
    const capErr = await evalC<string>('window.__capErr')
    console.log(`capture start: ok=${capOk} err=${capErr ?? '-'}`)

    if (capOk) {
      // ---- Case B: background tab WITH capture ----
      const caseB = await nativeRate(6000)
      const visB = await evalA<string>('document.visibilityState')
      console.log(`B) background tab, CAPTURED   : rAF=${caseB}/s vis=${visB} ${caseB >= 25 ? '★ EXEMPTED' : '✗'}`)

      // ---- Case C: minimize with capture ----
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await sleep(700)
      const caseC = await nativeRate(6000)
      const visC = await evalA<string>('document.visibilityState')
      console.log(`C) minimized, CAPTURED        : rAF=${caseC}/s vis=${visC} ${caseC >= 25 ? '★ EXEMPTED' : '✗'}`)

      // screenshot freshness while minimized+captured
      const t0 = Date.now()
      const s1 = await Promise.race([
        cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, agentSession),
        new Promise<'HANG'>(r => setTimeout(() => r('HANG'), 6000)),
      ])
      const ms1 = Date.now() - t0
      const shotOk = typeof s1 === 'object' && (s1.data as string).length > 10000 && ms1 < 3000
      console.log(`screenshot minimized: ${typeof s1 === 'string' ? s1 : `${(s1.data as string).length}B in ${ms1}ms`}`)

      const pass = caseA < 10 && caseB >= 25 && visB === 'visible' && caseC >= 25 && visC === 'visible' && shotOk
      console.log(`\n${pass ? 'PASS' : 'FAIL'} tab-capture keep-alive (CapturerCount exemption)`)
      process.exitCode = pass ? 0 : 1
    } else {
      // inspect what's blocking: list targets (picker dialog would be a WebUI target)
      const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
      console.log('targets:', targetInfos.map(t => `${t.type}:${String(t.url).slice(0, 60)}`).join(' | '))
      console.log('\nFAIL tab-capture keep-alive (capture did not start)')
      process.exitCode = 1
    }
  } finally {
    site.close()
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await sleep(400)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(0)
  }
}

await main()
