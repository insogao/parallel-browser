import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate settings/paths before the daemon modules are loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-window-intent-'))
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ collapseMode: 'minimize' }))
process.env.BACKLIGHT_HOME = home

const { createServer } = await import('../src/proxy.ts')
const { FramePumpSupervisor } = await import('../src/windows.ts')
const { ActivityBus } = await import('../src/activity.ts')
const { StateTransitionLog } = await import('../src/state-log.ts')

interface Track {
  running: boolean
  bounds: any
  hidden: boolean
  hideCalls: number
  minimizes: number
  launches: number
  launchOpts: any
  activatedTabs: string[]
  createdTabs: string[]
  tabs: Array<{ targetId: string; type: string; title: string; url: string; attached: boolean }>
}

function harness(opts: { running?: boolean; initial?: string } = {}) {
  const track: Track = {
    running: opts.running ?? true,
    bounds: { left: 60, top: 60, width: 1200, height: 800, windowState: opts.initial ?? 'normal' },
    hidden: false, hideCalls: 0, minimizes: 0, launches: 0, launchOpts: null,
    activatedTabs: [], createdTabs: [], tabs: [],
  }
  const cdp = {
    closed: false,
    send: async (method: string, params: any = {}) => {
      switch (method) {
        case 'Target.getTargets': return { targetInfos: [{ targetId: 'page', type: 'page' }] }
        case 'Browser.getWindowForTarget': return { windowId: 1 }
        case 'Browser.getWindowBounds': return { bounds: { ...track.bounds } }
        case 'Browser.setWindowBounds':
          if (params.bounds.windowState === 'minimized') track.minimizes++
          Object.assign(track.bounds, params.bounds)
          return {}
        case 'Runtime.evaluate': return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
        case 'Target.activateTarget': track.activatedTabs.push(params.targetId); return {}
        case 'Target.createTarget': track.createdTabs.push(params.url); return { targetId: 'created' }
        default: return {}
      }
    },
  }
  const instance = () => ({ cdp, pid: 4242, upstreamPort: 1, binary: '/x/Backlight', space: 'default', version: 'test', extensionPaths: [], startedAt: 0 })
  const manager: any = {
    current: track.running ? instance() : null,
    get running() { return track.running },
    async launch(o: any) {
      track.launches++
      track.launchOpts = o
      track.running = true
      manager.current = instance()
      return { pid: 4242, upstreamPort: 1, version: 'test' }
    },
    async listTabs() { return track.tabs },
    async stop() { track.running = false; manager.current = null },
  }
  const supervisor = new FramePumpSupervisor(() => (manager.current ? { cdp } : null) as any, () => [])
  const stateLog = new StateTransitionLog({ sink: () => {} })
  supervisor.onTransition = entry => stateLog.record(entry)
  const nativeCalls: string[] = []
  const deps = {
    manager,
    supervisor,
    health: {},
    extensions: { list: () => [] },
    extensionDev: {},
    bus: new ActivityBus(),
    version: '0',
    startedAt: 0,
    pulse() {},
    capture: { isPaused: () => false, setPaused: async () => {}, activeTargetId: () => null },
    appState: async () => ({ active: false, hidden: track.hidden }),
    hideBrowser: async () => { nativeCalls.push('hide'); track.hideCalls++; track.hidden = true },
    unhideBrowser: async () => { nativeCalls.push('unhide'); track.hidden = false },
    activateBrowser: async () => { nativeCalls.push('activate'); track.hidden = false },
    stateLog,
  }
  const server = createServer(deps as any)
  return {
    track, server, supervisor, stateLog, nativeCalls,
    listen: async () => {
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${(server.address() as any).port}`
    },
  }
}

const post = (base: string, route: string, body: unknown) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() as any }))

test('internal capture activation cannot override explicit bg; explicit menu show still wins', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const bg = await post(base, '/api/bg', { source: 'tray.menu.bg' })
    assert.equal(bg.body.ok, true)
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)
    const minimizesAfterBg = h.track.minimizes

    // The capture picker activates/unhides the app; the tray observer reacts
    // with an auto-show during that interval.
    h.supervisor.beginInternalActivity('capture-picker')
    const during = Date.now()
    const auto = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: during, activate: false })
    assert.equal(auto.body.ignored, 'internal-activation', JSON.stringify(auto.body))
    assert.equal(auto.body.restored, 0)
    assert.equal(h.track.minimizes, minimizesAfterBg, 'ignored auto-show must not touch windows')
    assert.equal(h.track.bounds.windowState, 'minimized', 'window must stay collapsed')
    assert.equal(h.track.hidden, true, 'app must stay hidden')

    // An explicit menu show during the same internal interval is a user
    // intent and must still be honored (last explicit intent wins).
    const explicit = await post(base, '/api/show', { source: 'tray.menu.show', observedAt: during, activate: false })
    assert.equal(explicit.body.ignored, undefined)
    assert.equal(explicit.body.restored, 1)
    assert.equal(h.track.hidden, false)
    assert.equal(h.track.bounds.windowState, 'normal')

    // Re-collapse, then a genuinely late user activation after the internal
    // interval ended must be honored (no arbitrary suppression timer).
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    h.supervisor.endInternalActivity('capture-picker')
    const endedAt = h.supervisor.internalState()!.to!
    const late = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: endedAt + 5_000, activate: false })
    assert.equal(late.body.ignored, undefined)
    assert.equal(late.body.restored, 1)
    assert.equal(h.track.hidden, false)

    const skips = h.stateLog.recent(50).filter(e => e.event === 'show-skip')
    assert.equal(skips.length, 1)
    assert.equal(skips[0]!.branch, 'internal-activation')
    assert.equal(skips[0]!.source, 'tray.auto.activate')
  } finally {
    h.server.close()
  }
})

test('auto show after a genuine Dock activation is honored when no internal activity matches', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    const auto = await post(base, '/api/show', { source: 'tray.auto.unhide', observedAt: Date.now(), activate: false })
    assert.equal(auto.body.ignored, undefined)
    assert.equal(auto.body.restored, 1)
    assert.equal(h.track.hidden, false)
    assert.deepEqual(h.supervisor.lastIntent()?.kind, 'show')
  } finally {
    h.server.close()
  }
})

test('status exposes explicit intent and internal interval so the tray can attribute activations', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    await post(base, '/api/bg', { source: 'cli.bg' })
    h.supervisor.beginInternalActivity('capture-picker')
    const status = await (await fetch(`${base}/api/status`)).json() as any
    assert.equal(status.intent.kind, 'bg')
    assert.equal(status.intent.source, 'cli.bg')
    assert.equal(status.internal.active, true)
    assert.equal(status.internal.kind, 'capture-picker')
    assert.equal(typeof status.internal.from, 'number')
    h.supervisor.endInternalActivity('capture-picker')
    const after = await (await fetch(`${base}/api/status`)).json() as any
    assert.equal(after.internal.active, false)
    assert.equal(typeof after.internal.from, 'number')
    assert.equal(typeof after.internal.to, 'number')
  } finally {
    h.server.close()
  }
})

test('tray console route reuses the managed dashboard tab instead of the default browser', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const port = new URL(base).port
    h.track.tabs = [
      { targetId: 'other', type: 'page', title: 'site', url: 'https://example.org/', attached: false },
      { targetId: 'dash', type: 'page', title: 'Backlight', url: `http://127.0.0.1:${port}/`, attached: false },
    ]
    h.track.bounds.windowState = 'minimized'
    const res = await post(base, '/api/console', { source: 'tray.menu.console' })
    assert.equal(res.body.ok, true)
    assert.equal(res.body.activated, true)
    assert.equal(res.body.launched, false)
    assert.deepEqual(h.track.activatedTabs, ['dash'])
    assert.equal(h.track.createdTabs.length, 0, 'must not create a duplicate dashboard tab')
    assert.equal(h.track.bounds.windowState, 'normal', 'explicit console action restores the managed window')
    assert.equal(h.track.hidden, false)
    assert.ok(h.stateLog.recent(20).some(e => e.event === 'console-open' && e.branch === 'activated-existing-tab'))
  } finally {
    h.server.close()
  }
})

test('tray console route creates a managed tab when no dashboard tab exists', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const port = new URL(base).port
    await post(base, '/api/console', { source: 'tray.menu.console' })
    assert.deepEqual(h.track.createdTabs, [`http://127.0.0.1:${port}/`])
    assert.equal(h.track.launches, 0)
    assert.ok(h.stateLog.recent(20).some(e => e.event === 'console-open' && e.branch === 'created-managed-tab'))
  } finally {
    h.server.close()
  }
})

test('tray console route launches the managed browser when stopped', { timeout: 20_000 }, async () => {
  const h = harness({ running: false })
  const base = await h.listen()
  try {
    const port = new URL(base).port
    const res = await post(base, '/api/console', { source: 'tray.menu.console' })
    assert.equal(res.body.launched, true)
    assert.equal(h.track.launches, 1)
    assert.equal(h.track.launchOpts.url, `http://127.0.0.1:${port}/`)
    assert.equal(h.track.launchOpts.focus, true)
    assert.ok(h.stateLog.recent(20).some(e => e.event === 'console-open' && e.branch === 'launched-managed'))
  } finally {
    h.server.close()
  }
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
