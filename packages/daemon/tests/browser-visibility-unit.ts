import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocketServer } from 'ws'

// Isolate settings/paths before the daemon modules are loaded. launchMode is
// deliberately set to 'visible': no browser module may honor it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-browser-visibility-'))
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ launchMode: 'visible' }))
process.env.BACKLIGHT_HOME = home

const { BrowserManager, launchRequestsVisibility, HIDDEN_RESTART_UNSAFE, RESTART_STATE_UNKNOWN } = await import('../src/browser.ts')

const profileDir = path.join(home, 'spaces', 'default', 'profile')

const fakeCdp = () => ({ closed: false, close() { this.closed = true }, send: async () => ({}) })
const fakeInstance = (cdp: any, pid = 4242) => ({
  child: null, pid, binary: '/x/Backlight', version: 'test', upstreamPort: 1,
  space: 'default', profileDir, extensionPaths: [], captureExtensionId: null,
  capturePageUrl: null, cdp, startedAt: 0,
})

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
    // Visible app: a background restart is allowed to touch it.
    appState: async () => ({ active: true, hidden: false }),
  })
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

  const result = await manager.restart('unit', { focus: false, keepVisible: false })
  assert.deepEqual(result, { restarted: true })

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

test('hidden/unknown background restart is deferred before stopping the browser', { timeout: 20_000 }, async () => {
  const events: string[] = []
  let hidden = true
  const instanceA = fakeInstance(fakeCdp(), 777)
  const instanceB = fakeInstance(fakeCdp(), 888)
  const manager = new BrowserManager({
    extensions: { namesForPaths: () => [] } as any,
    appState: async () => ({ active: false, hidden }),
  })
  manager.current = instanceA as any
  manager.listTabs = async () => []
  manager.stop = async () => { events.push('stop') }
  manager.launch = (async () => { events.push('launch'); manager.current = instanceB as any; return instanceB }) as any

  // Plain/automatic background restart on a hidden browser: refused untouched.
  const hiddenResult = await manager.restart('hidden restart', { focus: false })
  assert.deepEqual(hiddenResult, { restarted: false, deferred: HIDDEN_RESTART_UNSAFE })
  assert.deepEqual(events, [], 'a hidden background restart must not stop/launch')
  assert.equal(manager.current, instanceA, 'the working session must be preserved')

  // Internal/extension-style helper observes the same rule and leaves it running.
  const internalResult = await manager.restartIfRunning('internal reload')
  assert.deepEqual(internalResult, { restarted: false, deferred: HIDDEN_RESTART_UNSAFE })
  assert.deepEqual(events, [])
  assert.equal(manager.current, instanceA)

  // An explicit visible restart is still a human action and may restart a
  // hidden browser (the caller asked for a visible window on purpose).
  const visibleResult = await manager.restart('explicit visible', { focus: true })
  assert.deepEqual(visibleResult, { restarted: true })
  assert.deepEqual(events, ['stop', 'launch'])
  assert.equal(manager.current, instanceB)

  hidden = false
})

test('unreadable visibility fails closed as hidden-state-unknown', async () => {
  const events: string[] = []
  const manager = new BrowserManager({
    extensions: { namesForPaths: () => [] } as any,
    appState: async () => { throw new Error('probe failed') },
  })
  manager.current = fakeInstance(fakeCdp()) as any
  manager.listTabs = async () => []
  manager.stop = async () => { events.push('stop') }
  manager.launch = (async () => { events.push('launch'); return manager.current }) as any
  const result = await manager.restart('unreadable', {})
  assert.deepEqual(result, { restarted: false, deferred: RESTART_STATE_UNKNOWN })
  assert.deepEqual(events, [], 'an unreadable visibility probe must not risk a hidden restart')

  // No probe wired at all is equally unsafe.
  const noProbe = new BrowserManager({ extensions: { namesForPaths: () => [] } as any })
  noProbe.current = fakeInstance(fakeCdp()) as any
  assert.equal(await noProbe.backgroundRestartDeferral(), RESTART_STATE_UNKNOWN)
})

test('a launch whose verified hide fails tears the spawned browser down (no untracked visible process)', { timeout: 30_000 }, async (t) => {
  const { saveSettings } = await import('../src/store.ts')
  const fakeBinary = path.join(home, 'fake-browser')
  fs.writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n')
  saveSettings({ browser: fakeBinary })

  const closers: Array<() => void> = []
  let closedSockets = 0
  t.after(() => { for (const close of closers) { try { close() } catch { /* ignore */ } } })

  const manager = new BrowserManager({
    extensions: { enabledPaths: () => [] } as any,
    cornerWindow: async () => true,
    hideApp: async () => { throw new Error('simulated hide failure') },
    appState: async () => ({ active: false, hidden: false }),
  })
  // The spawn is faked: the debug endpoint and CDP socket are local fakes, so
  // the only real side effect left is the cleanup under test.
  ;(manager as any).spawnBrowser = async (_binary: string, args: string[]) => {
    const debugPort = Number(args.find(a => a.startsWith('--remote-debugging-port='))!.split('=')[1])
    const wsServer = new WebSocketServer({ port: 0 })
    await new Promise<void>(resolve => wsServer.once('listening', resolve))
    closers.push(() => wsServer.close())
    wsServer.on('connection', (ws) => {
      ws.on('close', () => { closedSockets++ })
      ws.on('message', (data) => {
        let msg: any
        try { msg = JSON.parse(data.toString()) } catch { return }
        if (typeof msg.id !== 'number') return
        const result = msg.method === 'Target.getTargets'
          ? { targetInfos: [{ targetId: 'page', type: 'page' }] }
          : msg.method === 'Browser.getWindowForTarget' ? { windowId: 1 } : {}
        ws.send(JSON.stringify({ id: msg.id, result }))
      })
    })
    const wsPort = (wsServer.address() as any).port
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ Browser: 'fake', webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser` }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => httpServer.listen(debugPort, '127.0.0.1', resolve))
    closers.push(() => httpServer.close())
    return { child: null, pid: -1 }
  }

  await assert.rejects(manager.launch({ url: 'about:blank', bare: true }), /simulated hide failure/)
  assert.equal(manager.current, null, 'a failed launch must not stay tracked (and possibly visible)')
  for (let i = 0; i < 20 && closedSockets === 0; i++) await new Promise(r => setTimeout(r, 50))
  assert.equal(closedSockets, 1, 'the failed launch must close its CDP connection')
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
