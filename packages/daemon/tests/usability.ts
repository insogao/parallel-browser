import { backlightFixture } from './backlight-fixture.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-usability-'))
backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { findFreePort } = await import('../src/ports.ts')
const port = await findFreePort()
const site = http.createServer((req, res) => {
  if (req.url?.startsWith('/data')) { res.end(JSON.stringify({ value: Date.now() })); return }
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!doctype html><title>Backlight acceptance</title><input id="draft"><p id="data">loading</p>
    <script>window.polls=0;setInterval(async()=>{const r=await fetch('/data');document.querySelector('#data').textContent=await r.text();window.polls++},250)</script>`)
})
await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`
const log = fs.openSync(path.join(tmp, 'daemon.log'), 'w')
const daemon = spawn(process.execPath, [path.resolve('src/index.ts')], {
  env: { ...process.env, BACKLIGHT_HOME: tmp, BACKLIGHT_PORT: String(port) }, stdio: ['ignore', log, log],
})
let cdp: Cdp | undefined
const api = async (route: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await r.json() as any
  assert.ok(r.ok, `${route}: ${JSON.stringify(result)}`)
  return result
}
async function waitFor(fn: () => Promise<boolean>, message: string, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(150) }
  throw new Error(message)
}
try {
  await waitFor(async () => !!(await api('status')).daemon, 'daemon startup')
  await api('settings', { captureKeepAlive: false })
  await api('launch', { url: siteUrl + '/one' })
  const status = await api('status')
  cdp = await Cdp.connect((await fetchVersion(status.browser.upstreamPort)).webSocketDebuggerUrl)
  const pages = async () => (await cdp!.send('Target.getTargets')).targetInfos.filter((t: any) => t.url.startsWith(siteUrl))
  const page = (await pages())[0]
  const session = await cdp.attach(page.targetId)
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId })
  await api('show', { maximize: true, activate: false })
  let { bounds } = await cdp.send('Browser.getWindowBounds', { windowId })
  assert.ok(bounds.left >= 0 && bounds.top < 900, 'show brings startup window onscreen')
  assert.equal(bounds.windowState, 'maximized', 'show supports maximize')
  await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#draft").value="unsaved login draft"' }, session)
  await api('open', { url: siteUrl + '/two' })
  assert.deepEqual((await cdp.send('Browser.getWindowBounds', { windowId })).bounds, bounds, 'background open must not move user window')
  assert.equal(await cdp.evaluateOnSession(session, 'document.querySelector("#draft").value'), 'unsaved login draft')
  assert.equal((await api('status')).control, 'human')
  console.log('PASS human takeover: maximize, open without moving window, preserve draft')
  await api('bg', {})
  await waitFor(async () => (await cdp!.send('Browser.getWindowBounds', { windowId })).bounds.windowState === 'minimized', 'native minimize completes')
  await api('open', { url: siteUrl + '/three' })
  assert.equal((await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState, 'minimized', 'opening while minimized stays minimized')
  await waitFor(async () => (await pages()).length === 3, 'three pages')
  for (const p of await pages()) {
    const sid = await cdp.attach(p.targetId)
    await waitFor(async () => await cdp!.evaluateOnSession(sid, 'window.polls > 3'), 'background network polling')
    assert.equal(await cdp.evaluateOnSession(sid, 'document.hidden'), true)
  }
  console.log('PASS three minimized pages load and poll fresh network data')
} catch (e) {
  console.error(fs.readFileSync(path.join(tmp, 'daemon.log'), 'utf8'))
  throw e
} finally {
  cdp?.close()
  await api('stop', {}).catch(() => {})
  daemon.kill('SIGTERM')
  site.close()
  fs.closeSync(log)
  await sleep(500)
  fs.rmSync(tmp, { recursive: true, force: true })
}
