import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate settings/paths before the daemon modules are loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-proxy-race-'))
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ collapseMode: 'minimize' }))
process.env.BACKLIGHT_HOME = home

const { createServer } = await import('../src/proxy.ts')
const { FramePumpSupervisor } = await import('../src/windows.ts')
const { ActivityBus } = await import('../src/activity.ts')

test('show during a settling /api/bg supersedes it: no minimize, no hide, stays visible', { timeout: 20_000 }, async () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  let bounds: any = { left: 60, top: 60, width: 1200, height: 800, windowState: 'maximized' }
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let held = false
  let minimizes = 0
  let hidden = false
  const cdp = {
    send: async (method: string, params: any = {}) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page', type: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') return { bounds: { ...bounds } }
      if (method === 'Browser.setWindowBounds') {
        const state = params.bounds.windowState
        if (state === 'normal' && !held) {
          held = true
          bounds = { ...bounds, windowState: 'normal' }
          await gate
        } else {
          if (state === 'minimized') minimizes++
          bounds = { ...bounds, ...params.bounds }
        }
        return {}
      }
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
      return {}
    },
  }
  const supervisor = new FramePumpSupervisor(() => ({ cdp }) as any, () => [])
  const deps = {
    manager: { current: { cdp, pid: 999_999, upstreamPort: 1 }, running: true },
    supervisor,
    health: {},
    capture: { setPaused: async () => {} },
    extensions: {},
    extensionDev: {},
    bus: new ActivityBus(),
    version: '0',
    startedAt: 0,
    pulse() {},
    appState: async () => ({ active: false, hidden: true }),
    hideBrowser: async () => { hidden = true },
  }
  const server = createServer(deps as any)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const bgPromise = post('/api/bg', {}).then(async r => ({ status: r.status, body: await r.json() as any }))
    const deadline = Date.now() + 5000
    while (!held && Date.now() < deadline) await sleep(10)
    assert.ok(held, 'bg must reach the settle step')
    const show = await post('/api/show', { activate: false }).then(r => r.json() as any)
    assert.equal(show.ok, true)
    release()
    const bg = await bgPromise
    assert.equal(bg.status, 200, JSON.stringify(bg.body))
    assert.equal(bg.body.superseded, true, 'bg must report that show superseded it')
    assert.equal(minimizes, 0, 'no minimize may be issued after show')
    assert.equal(hidden, false, 'superseded bg must not hide the app')
    assert.equal(bounds.windowState, 'normal', 'window stays visible for the newer intent')
  } finally {
    server.close()
  }
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
