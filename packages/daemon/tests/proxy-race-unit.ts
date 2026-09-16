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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Track { bounds: any; minimizes: number; hidden: boolean; hideCalls: number }

interface HarnessOptions {
  initial?: string
  setPaused?: (paused: boolean) => Promise<void>
  hideBrowser?: (track: Track) => Promise<void>
  unhideBrowser?: (track: Track) => Promise<void>
  activateBrowser?: (track: Track) => Promise<void>
  cdpHook?: (state: string, track: Track) => Promise<void> | void
}

function harness(opts: HarnessOptions = {}) {
  const track: Track = {
    bounds: { left: 60, top: 60, width: 1200, height: 800, windowState: opts.initial ?? 'normal' },
    minimizes: 0, hidden: false, hideCalls: 0,
  }
  const cdp = {
    send: async (method: string, params: any = {}) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page', type: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') return { bounds: { ...track.bounds } }
      if (method === 'Browser.setWindowBounds') {
        const state = params.bounds.windowState
        if (opts.cdpHook) await opts.cdpHook(state, track)
        else {
          if (state === 'minimized') track.minimizes++
          track.bounds = { ...track.bounds, ...params.bounds }
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
    capture: { setPaused: opts.setPaused ?? (async () => {}), prearm: async () => null },
    extensions: {},
    extensionDev: {},
    bus: new ActivityBus(),
    version: '0',
    startedAt: 0,
    pulse() {},
    appState: async () => ({ active: false, hidden: true }),
    hideBrowser: async () => { track.hideCalls++; track.hidden = true; await opts.hideBrowser?.(track) },
    unhideBrowser: async () => { track.hidden = false; await opts.unhideBrowser?.(track) },
    activateBrowser: async () => { track.hidden = false; await opts.activateBrowser?.(track) },
  }
  const server = createServer(deps as any)
  return {
    track, server,
    listen: async () => {
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${(server.address() as any).port}`
    },
  }
}

const post = (base: string, route: string, body: unknown) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() as any }))

test('show during a settling /api/bg supersedes it: no minimize, no hide, stays visible', { timeout: 20_000 }, async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let held = false
  const h = harness({
    initial: 'maximized',
    cdpHook: async (state, track) => {
      if (state === 'normal' && !held) {
        held = true
        track.bounds = { ...track.bounds, windowState: 'normal' }
        await gate
      } else {
        if (state === 'minimized') track.minimizes++
        track.bounds = { ...track.bounds, windowState: state }
      }
    },
  })
  const base = await h.listen()
  try {
    const bgPromise = post(base, '/api/bg', { source: 'test.race.bg' })
    const deadline = Date.now() + 5000
    while (!held && Date.now() < deadline) await sleep(10)
    assert.ok(held, 'bg must reach the settle step')
    const show = await post(base, '/api/show', { activate: false, source: 'test.race.show' })
    assert.equal(show.body.ok, true)
    release()
    const bg = await bgPromise
    assert.equal(bg.status, 200, JSON.stringify(bg.body))
    assert.equal(bg.body.superseded, true, 'bg must report that show superseded it')
    assert.equal(h.track.minimizes, 0, 'no minimize may be issued after show')
    assert.equal(h.track.hidden, false, 'superseded bg must not hide the app')
    assert.equal(h.track.bounds.windowState, 'normal', 'window stays visible for the newer intent')
  } finally {
    h.server.close()
  }
})

test('show arriving while bg awaits setPaused(false) still supersedes the older bg', { timeout: 20_000 }, async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let pausedGateEntered = false
  const h = harness({
    setPaused: async paused => {
      if (!paused) { pausedGateEntered = true; await gate }
    },
  })
  const base = await h.listen()
  try {
    const bgPromise = post(base, '/api/bg', { source: 'test.race.bg' })
    const deadline = Date.now() + 5000
    while (!pausedGateEntered && Date.now() < deadline) await sleep(10)
    assert.ok(pausedGateEntered, 'bg must be parked in setPaused(false)')
    const show = await post(base, '/api/show', { activate: false, source: 'test.race.show' })
    assert.equal(show.body.ok, true)
    release()
    const bg = await bgPromise
    assert.equal(bg.status, 200, JSON.stringify(bg.body))
    assert.equal(bg.body.superseded, true, 'bg allocated before its await must lose to the later show')
    assert.equal(h.track.minimizes, 0, 'stale bg must not minimize')
    assert.equal(h.track.hideCalls, 0, 'stale bg must not hide')
    assert.equal(h.track.hidden, false)
  } finally {
    h.server.close()
  }
})

test('show during an in-flight native hide leaves the app visible', { timeout: 20_000 }, async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let hideEntered = false
  let hidden = false
  const h = harness({
    initial: 'maximized',
    hideBrowser: async () => { hideEntered = true; await gate; hidden = true },
    unhideBrowser: async () => { hidden = false },
  })
  const base = await h.listen()
  try {
    const bgPromise = post(base, '/api/bg', { source: 'test.race.bg' })
    const deadline = Date.now() + 5000
    while (!hideEntered && Date.now() < deadline) await sleep(10)
    assert.ok(hideEntered, 'bg must reach the native hide')
    const showPromise = post(base, '/api/show', { activate: false, source: 'test.race.show' })
    await sleep(50) // let show queue its unhide behind the in-flight hide
    release()
    const show = await showPromise
    assert.equal(show.body.ok, true, JSON.stringify(show.body))
    const bg = await bgPromise
    assert.equal(bg.body.superseded, true)
    assert.equal(hidden, false, 'show must unhide after the in-flight hide completes')
    assert.equal(h.track.bounds.windowState, 'normal', 'window restored and visible')
    assert.equal(h.track.minimizes, 2, 'the hidden-app collapse ran its two cycles before show')
  } finally {
    h.server.close()
  }
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
