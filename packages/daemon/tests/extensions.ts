import { backlightFixture } from './backlight-fixture.ts'
/**
 * M2 extension dev-loop e2e:
 *   1. register a fixture unpacked extension (MV3, content script)
 *   2. launch — the installed Backlight build loads the unpacked extension
 *   3. content script must execute on a local test page
 *   4. edit the manifest (version bump) — hot reload must preserve the browser process
 *      and the new content script version must run
 *
 * Run: node tests/extensions.ts
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backlight-ext-'))
backlightFixture(TMP)
const PORT = 9435
const SITE_PORT = 9490
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function writeExt(version: string) {
  fs.mkdirSync(path.join(TMP, 'ext'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'ext', 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Backlight Fixture',
    version,
    permissions: ['sidePanel', 'storage'],
    side_panel: { default_path: 'panel.html' },
    background: { service_worker: 'sw.js' },
    content_scripts: [{
      matches: ['http://*/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    }],
  }, null, 2))
  for (const file of ['panel.html', 'panel.css', 'panel.js']) {
    fs.copyFileSync(new URL(`../../../examples/side-panel/${file}`, import.meta.url), path.join(TMP, 'ext', file))
  }
  fs.writeFileSync(path.join(TMP, 'ext', 'sw.js'), `console.log('backlight fixture sw ${version}')\n`)
  // content scripts run in an ISOLATED world: window.* markers are invisible to
  // CDP Runtime.evaluate (main world). Use a DOM marker instead.
  fs.writeFileSync(path.join(TMP, 'ext', 'content.js'), `document.documentElement.dataset.blExtVersion = '${version}';\n` + fs.readFileSync(new URL('../../../examples/side-panel/content.js', import.meta.url), 'utf8'))
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return
    await sleep(300)
  }
  throw new Error(`timeout waiting for: ${what}`)
}

async function main() {
  writeExt('1.0.0')

  // local site the extension content script matches
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><title>Ext Test Page</title></head><body><h1 id="h">hello</h1></body></html>')
  })
  await new Promise<void>(r => site.listen(SITE_PORT, '127.0.0.1', r))

  const daemon = spawn(process.execPath, [path.resolve('src/index.ts')], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, BACKLIGHT_HOME: TMP, BACKLIGHT_PORT: String(PORT), BACKLIGHT_VERBOSE: '1' },
  })
  daemon.unref()
  let pass = false
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.ok).catch(() => false)), 10_000, 'daemon up')
    const post = (p: string, body: unknown): Promise<any> =>
      fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())

    // 1. register extension
    const added = await post('/api/extensions/add', { path: path.join(TMP, 'ext'), source: 'test.extensions.add' })
    if (!added.ok) throw new Error(`ext add failed: ${JSON.stringify(added)}`)
    console.log(`extension registered: ${added.extension.name}`)

    // 2. launch with the extension
    const launched = await post('/api/launch', { url: `http://127.0.0.1:${SITE_PORT}/`, source: 'test.extensions.launch' })
    if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)} (Chromium download may have failed)`)
    console.log(`browser pid=${launched.pid} binary supports --load-extension`)

    const connectPage = async () => {
      const status: any = await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.json())
      const version = await fetchVersion(status.browser.upstreamPort)
      const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
      const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
      const sw = targetInfos.find(t => t.type === 'service_worker')
      console.log(`extension service worker target: ${sw ? 'present (' + sw.url.slice(-40) + ')' : 'MISSING'}`)
      const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${SITE_PORT}`))
      if (!page) throw new Error('test page target not found')
      const sessionId = await cdp.attach(page.targetId)
      await cdp.send('Page.enable', {}, sessionId)
      return { cdp, sessionId, pid: status.browser.pid as number }
    }

    const readVersion = async (cdp: Cdp, sessionId: string): Promise<string | null> => {
      // reload to give a fresh content-script run, then read the DOM marker
      await cdp.send('Page.reload', {}, sessionId)
      await sleep(1500)
      const res = await cdp.send<{ result: { value: string | null } }>(
        'Runtime.evaluate',
        { expression: 'document.documentElement?.dataset?.blExtVersion ?? null', returnByValue: true },
        sessionId,
      )
      return res.result.value ?? null
    }

    let conn = await connectPage()
    const v1 = await readVersion(conn.cdp, conn.sessionId)
    console.log(`content script version after launch: ${v1}`)
    if (v1 !== '1.0.0') throw new Error(`expected 1.0.0, got ${v1}`)

    const siteTarget = (await conn.cdp.send('Target.getTargets')).targetInfos.find((t: any) => t.url.startsWith(`http://127.0.0.1:${SITE_PORT}`))
    await conn.cdp.send('Runtime.evaluate', { expression: 'window.unsavedDraft = "keep me"' }, conn.sessionId)
    const dev = await post('/api/extensions/dev', { name: added.extension.name, targetId: siteTarget.targetId, activate: false, source: 'test.extensions.dev' })
    if (!dev.ok || !dev.panelTargetId) throw new Error(`side panel failed: ${JSON.stringify(dev)}`)
    const panelSession = await conn.cdp.attach(dev.panelTargetId)
    const panelType = await conn.cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getContexts({contextTypes:["SIDE_PANEL"]})', awaitPromise: true, returnByValue: true }, panelSession)
    if (!panelType.result.value?.length) throw new Error('not a real SIDE_PANEL context')
    await conn.cdp.send('Runtime.evaluate', { expression: 'chrome.storage.local.set({draft:"persist"})', awaitPromise: true }, panelSession)
    console.log('PASS real native side panel with extension context')
    await conn.cdp.evaluateOnSession(panelSession, 'document.querySelector("#read").click()')
    await waitFor(async () => await conn.cdp.evaluateOnSession(panelSession, 'document.querySelector("#page-title").textContent') === 'Ext Test Page', 5000, 'sample side panel reads the selected website')
    await conn.cdp.evaluateOnSession(panelSession, 'document.querySelector("#highlight").click()')
    await waitFor(async () => !!(await conn.cdp.evaluateOnSession(conn.sessionId, 'document.querySelector("h1").style.background')), 5000, 'sample side panel changes website heading')
    console.log('PASS side panel ↔ website messaging')
    const inspector = await post('/api/inspect', { targetId: dev.panelTargetId, activate: false, source: 'test.extensions.inspect' })
    if (!inspector.ok) throw new Error(`inspector failed: ${JSON.stringify(inspector)}`)
    const inspectorSession = await conn.cdp.attach(inspector.targetId)
    await waitFor(async () => {
      const text = await conn.cdp.evaluateOnSession<string>(inspectorSession, `(() => {
        const parts = []; const visit = n => { if (['SCRIPT','STYLE'].includes(n.nodeName)) return; if (n.nodeType === 3) parts.push(n.textContent); if (n.shadowRoot) visit(n.shadowRoot); for (const c of n.childNodes || []) visit(c) }; visit(document.body); return parts.join(' ');
      })()`)
      if (/disconnected|WebSocket disconnected|连接已断开/i.test(text)) throw new Error(text)
      return /Elements|Console|元素|控制台/.test(text)
    }, 10000, 'DevTools UI loads for side panel')
    console.log('PASS separate DevTools window for native side panel')
    await conn.cdp.send('Target.closeTarget', { targetId: inspector.targetId })

    // 3. bump the version — reload only the extension
    const oldPid = conn.pid
    writeExt('1.0.1')
    console.log('manifest bumped to 1.0.1; waiting for hot reload...')
    await waitFor(async () => {
      const e: any = await fetch(`http://127.0.0.1:${PORT}/api/extensions`).then(r => r.json())
      return e.runtime?.some((x: any) => x.version === '1.0.1')
    }, 20_000, 'extension reload without browser restart')
    const after: any = await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.json())
    if (after.browser.pid !== oldPid) throw new Error('browser restarted during extension reload')
    if (await conn.cdp.evaluateOnSession(conn.sessionId, 'window.unsavedDraft') !== 'keep me') throw new Error('page draft lost during extension reload')
    conn.cdp.close()

    conn = await connectPage()
    const v2 = await readVersion(conn.cdp, conn.sessionId)
    console.log(`content script version after hot reload: ${v2}`)
    const devAgain = await post('/api/extensions/dev', { name: added.extension.name, targetId: siteTarget.targetId, activate: false, source: 'test.extensions.dev' })
    if (!devAgain.ok) throw new Error(JSON.stringify(devAgain))
    const againSession = await conn.cdp.attach(devAgain.panelTargetId)
    const stored = await conn.cdp.send('Runtime.evaluate', { expression: 'chrome.storage.local.get("draft")', returnByValue: true, awaitPromise: true }, againSession)
    if (stored.result.value?.draft !== 'persist') throw new Error('extension storage lost during reload')
    console.log('PASS extension storage survives reload')
    await conn.cdp.send('Target.detachFromTarget', { sessionId: againSession }).catch(() => {})

    // Two windows, same extension: a side panel request for window A must open
    // and return A's panel even when focus was deliberately moved to window B.
    const extId = devAgain.extensionId as string
    const winA = (await conn.cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: siteTarget.targetId })).windowId
    const second = await conn.cdp.send<{ targetId: string }>('Target.createTarget', { url: `http://127.0.0.1:${SITE_PORT}/second-window`, newWindow: true })
    await sleep(1500)
    const winB = (await conn.cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: second.targetId })).windowId
    if (winA === winB) throw new Error('second window was not created')
    const secondSession = await conn.cdp.attach(second.targetId)
    const panelHost = async (targetId: string): Promise<number | null> => {
      const sid = await conn.cdp.attach(targetId)
      try {
        const r = await conn.cdp.send<{ result: { value: number | null } }>('Runtime.evaluate', {
          expression: '(async () => { const w = await chrome.windows.getCurrent(); return w?.id ?? null })()',
          awaitPromise: true, returnByValue: true,
        }, sid)
        return r.result.value ?? null
      } finally { await conn.cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {}) }
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await conn.cdp.send('Page.bringToFront', {}, secondSession)
      await sleep(250)
      const openA = await post('/api/extensions/dev', { name: added.extension.name, targetId: siteTarget.targetId, activate: false, source: 'test.extensions.dev' })
      if (!openA.ok || !openA.panelTargetId) throw new Error(`two-window side panel failed: ${JSON.stringify(openA)}`)
      const owner = await panelHost(openA.panelTargetId)
      if (owner !== winA) throw new Error(`attempt ${attempt}: panel opened in window ${owner}, expected ${winA}`)
      const strays = (await conn.cdp.send('Target.getTargets')).targetInfos
        .filter((t: any) => t.type === 'page' && t.targetId !== openA.panelTargetId && t.url.startsWith(`chrome-extension://${extId}/panel`))
      for (const stray of strays) {
        if (await panelHost(stray.targetId) === winB) throw new Error(`attempt ${attempt}: foreign panel opened in window B`)
      }
    }
    console.log('PASS two windows, same extension: panel stays bound to the requested window (3/3)')
    pass = v2 === '1.0.1'
    console.log(`\n${pass ? 'PASS' : 'FAIL'} extension dev loop e2e`)
    process.exitCode = pass ? 0 : 1
  } catch (err) {
    console.error('\nEXT TEST ERROR:', err instanceof Error ? err.stack : err)
    console.log('\nFAIL extension dev loop e2e')
    process.exitCode = 1
  } finally {
    site.close()
    await fetch(`http://127.0.0.1:${PORT}/api/stop`, { method: 'POST', body: '{}' }).catch(() => {})
    try { process.kill(daemon.pid!, 'SIGTERM') } catch { /* ignore */ }
    await sleep(600)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(process.exitCode ?? 0)
  }
}

await main()
