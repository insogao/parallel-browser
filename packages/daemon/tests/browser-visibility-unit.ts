import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// Isolate settings/paths before the daemon modules are loaded. launchMode is
// deliberately set to 'visible': no browser module may honor it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-browser-visibility-'))
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ launchMode: 'visible' }))
process.env.BACKLIGHT_HOME = home

const { BrowserManager, launchRequestsVisibility } = await import('../src/browser.ts')

test('on-screen launch requires an explicit visibility flag; launchMode is not an input', () => {
  assert.equal(launchRequestsVisibility({}), false)
  assert.equal(launchRequestsVisibility({ focus: false }), false)
  assert.equal(launchRequestsVisibility({ keepVisible: false }), false)
  assert.equal(launchRequestsVisibility({ focus: false, keepVisible: false }), false)
  assert.equal(launchRequestsVisibility({ focus: true }), true)
  assert.equal(launchRequestsVisibility({ keepVisible: true }), true)
})

test('manager.restart relaunches background-only and restores tabs as background targets', { timeout: 20_000 }, async (t) => {
  const tabs = ['https://a.test/', 'https://b.test/', 'https://c.test/']
  const debug = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(tabs.map((url, i) => ({ id: `t${i}`, type: 'page', title: '', url, attached: false }))))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => debug.listen(0, '127.0.0.1', resolve))
  t.after(() => debug.close())
  const upstreamPort = (debug.address() as any).port

  const created: any[] = []
  const oldCdp = { closed: false, close() { this.closed = true }, send: async () => ({}) }
  const newCdp = {
    closed: false,
    close() { this.closed = true },
    send: async (method: string, params: any = {}) => {
      if (method === 'Target.createTarget') { created.push(params); return { targetId: `new${created.length}` } }
      return {}
    },
  }

  const hides: number[] = []
  const manager = new BrowserManager({
    extensions: { namesForPaths: () => ['ext-a'] } as any,
    hideApp: async (pid: number) => { hides.push(pid) },
  })
  const profileDir = path.join(home, 'spaces', 'default', 'profile')
  const instance = (cdp: any) => ({
    child: null, pid: 4242, binary: '/x/Backlight', version: 'test', upstreamPort,
    space: 'default', profileDir, extensionPaths: ['/x/ext-a'], captureExtensionId: null,
    capturePageUrl: null, cdp, startedAt: 0,
  })
  manager.current = instance(oldCdp) as any

  const launches: any[] = []
  manager.launch = (async (opts: any) => {
    launches.push(opts)
    const launched = instance(newCdp)
    manager.current = launched as any
    return launched
  }) as any

  await manager.restart('unit', { focus: false, keepVisible: false })

  assert.equal(launches.length, 1)
  assert.equal(launches[0].url, tabs[0], 'the first tab becomes the launch url')
  assert.equal(launches[0].space, 'default')
  assert.deepEqual(launches[0].with, ['ext-a'], 'extension names survive the restart')
  assert.equal(launches[0].focus, false, 'a background restart must not request focus')
  assert.equal(launches[0].keepVisible, false)
  assert.deepEqual(created, [
    { url: tabs[1], background: true },
    { url: tabs[2], background: true },
  ], 'recreated tabs must be background targets, never focused')
  assert.deepEqual(hides, [4242], 'a background restart must re-assert native hidden after recreating tabs')
  assert.equal(oldCdp.closed, true, 'the old CDP connection is torn down')

  // A visible restart keeps the human window and must not hide it.
  hides.length = 0
  manager.current = instance(oldCdp) as any
  await manager.restart('unit visible', { focus: true, keepVisible: true })
  assert.deepEqual(hides, [], 'a visible restart must not hide the app')
  assert.equal(launches.at(-1).focus, true)
  assert.equal(launches.at(-1).keepVisible, true)
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
