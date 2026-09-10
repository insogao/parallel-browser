/**
 * M2 extension dev-loop e2e:
 *   1. register a fixture unpacked extension (MV3, content script)
 *   2. launch — branded Chrome is swapped for a Chromium build (--load-extension)
 *   3. content script must execute on a local test page
 *   4. edit the manifest (version bump) — hot reload must restart the browser
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
const PORT = 9435
const SITE_PORT = 9490
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function writeExt(version: string) {
  fs.mkdirSync(path.join(TMP, 'ext'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'ext', 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Backlight Fixture',
    version,
    background: { service_worker: 'sw.js' },
    content_scripts: [{
      matches: ['http://*/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    }],
  }, null, 2))
  fs.writeFileSync(path.join(TMP, 'ext', 'sw.js'), `console.log('backlight fixture sw ${version}')\n`)
  // content scripts run in an ISOLATED world: window.* markers are invisible to
  // CDP Runtime.evaluate (main world). Use a DOM marker instead.
  fs.writeFileSync(path.join(TMP, 'ext', 'content.js'), `document.documentElement.dataset.blExtVersion = '${version}';\n`)
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
    const added = await post('/api/extensions/add', { path: path.join(TMP, 'ext') })
    if (!added.ok) throw new Error(`ext add failed: ${JSON.stringify(added)}`)
    console.log(`extension registered: ${added.extension.name}`)

    // 2. launch with the extension
    const launched = await post('/api/launch', { url: `http://127.0.0.1:${SITE_PORT}/` })
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

    // 3. bump the version — hot reload should restart the browser
    const oldPid = conn.pid
    writeExt('1.0.1')
    console.log('manifest bumped to 1.0.1; waiting for hot reload...')
    await waitFor(async () => {
      const s: any = await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.json()).catch(() => null)
      return s?.browser?.running && s.browser.pid !== oldPid
    }, 20_000, 'browser restart (hot reload)')

    conn = await connectPage()
    const v2 = await readVersion(conn.cdp, conn.sessionId)
    console.log(`content script version after hot reload: ${v2}`)
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
