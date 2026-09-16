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

function harness(opts: { running?: boolean; initial?: string; setPaused?: (paused: boolean) => Promise<void> } = {}) {
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
    capture: { isPaused: () => false, setPaused: opts.setPaused ?? (async () => {}), activeTargetId: () => null, prearm: async () => null },
    appState: async () => ({ active: false, hidden: track.hidden }),
    hideBrowser: async () => { nativeCalls.push('hide'); track.hideCalls++; track.hidden = true },
    unhideBrowser: async () => { nativeCalls.push('unhide'); track.hidden = false },
    activateBrowser: async () => { nativeCalls.push('activate'); track.hidden = false },
    stateLog,
  }
  const server = createServer(deps as any)
  return {
    track, server, supervisor, stateLog, nativeCalls, manager,
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
    // An OS/tray reconciliation is not a human intent: it is logged with its
    // own origin+token but must not overwrite the explicit intent anchor.
    assert.equal(h.supervisor.lastIntent()?.kind, 'bg', 'auto reconcile must not fabricate an explicit intent')
    const autoIntent = h.stateLog.recent(50).find(e => e.event === 'control-intent' && e.origin === 'auto')
    assert.ok(autoIntent, 'the auto request must be logged with origin auto')
    assert.equal(autoIntent.source, 'tray.auto.unhide')
    assert.equal(typeof autoIntent.token, 'string')
    const autoRestores = h.stateLog.recent(50).filter(e => e.event === 'window-restore' && e.origin === 'auto')
    assert.ok(autoRestores.length > 0, 'window transitions must carry the auto origin')
    assert.ok(autoRestores.every(e => e.token === autoIntent.token && e.source === 'tray.auto.unhide'))
    assert.ok(!h.nativeCalls.includes('activate'), 'an auto reconcile may never foreground the app')
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

// ---- intent token / origin attribution (release-gate audit) ----------------

test('login records its explicit intent before side effects; an auto-show during launch cannot steal the generation', { timeout: 20_000 }, async () => {
  const h = harness({ running: false })
  const base = await h.listen()
  const originalLaunch = h.manager.launch
  try {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    let launchEntered = false
    h.manager.launch = async (opts: any) => {
      launchEntered = true
      assert.ok(
        h.stateLog.recent(50).some(e => e.event === 'control-intent' && e.origin === 'explicit' && e.source === 'cli.login'),
        'login intent must be recorded before the launch side effect',
      )
      await gate
      return originalLaunch.call(h.manager, opts)
    }
    const loginPromise = post(base, '/api/login', { source: 'cli.login' })
    const deadline = Date.now() + 5000
    while (!launchEntered && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
    assert.ok(launchEntered, 'login must reach the gated launch')
    const genBeforeAuto = h.supervisor.controlGen()

    // A tray auto-show reacting to our own launch arrives while login is still
    // applying: it must be ignored instead of bumping the generation ahead of
    // the explicit login (which would silently drop the maximize).
    const auto = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: Date.now(), activate: false })
    assert.equal(auto.body.ignored, 'explicit-in-flight', JSON.stringify(auto.body))
    assert.equal(auto.body.restored, 0)
    assert.equal(h.supervisor.controlGen(), genBeforeAuto, 'the auto request must not steal the explicit generation')
    assert.equal(h.supervisor.lastIntent()?.kind, 'show', 'the explicit login intent stays the anchor')

    release()
    const login = await loginPromise
    assert.equal(login.status, 200, JSON.stringify(login.body))
    assert.equal(login.body.ok, true)
    assert.equal(login.body.launched, true)
    assert.equal(login.body.restored, 1)
    assert.equal(h.track.bounds.windowState, 'maximized', 'the explicit login maximize must survive the auto race')
    assert.deepEqual(h.nativeCalls, ['activate'], 'login foregrounds exactly once and no auto foreground slips in')
    assert.equal(h.stateLog.recent(50).filter(e => e.event === 'native-activate' && e.branch === 'applied').length, 1)

    const entries = h.stateLog.recent(80)
    const intent = entries.find(e => e.event === 'control-intent' && e.branch === 'show' && e.source === 'cli.login')
    assert.ok(intent, 'explicit login intent logged')
    const token = intent.token
    assert.ok(token)
    const requested = entries.findIndex(e => e.event === 'window-restore' && e.branch === 'requested' && e.token === token)
    const applied = entries.findIndex(e => e.event === 'window-restore' && e.branch === 'maximize' && e.token === token)
    const native = entries.findIndex(e => e.event === 'native-activate' && e.branch === 'applied' && e.token === token)
    assert.ok(requested >= 0 && applied > requested, 'restore requested before the applied maximize, same token')
    assert.ok(native > applied, 'native foreground follows the applied maximize')
  } finally {
    h.manager.launch = originalLaunch
    h.server.close()
  }
})

test('auto tray reconcile may never maximize or foreground (invariant)', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    const auto = await post(base, '/api/show', {
      source: 'tray.auto.poll', observedAt: Date.now(), maximize: true, activate: true,
    })
    assert.equal(auto.body.ignored, undefined)
    assert.deepEqual(auto.body.downgraded, ['maximize', 'activate'])
    assert.equal(h.track.bounds.windowState, 'normal', 'auto reconcile may restore but never maximize')
    assert.ok(!h.nativeCalls.includes('activate'), 'auto reconcile may never foreground')
    assert.ok(h.nativeCalls.includes('unhide'))
    const autoIntent = h.stateLog.recent(50).find(e => e.event === 'control-intent' && e.origin === 'auto' && e.source === 'tray.auto.poll')
    assert.ok(autoIntent)
    const downgrades = h.stateLog.recent(50).filter(e => e.event === 'policy-downgrade' && e.token === autoIntent.token)
    assert.deepEqual(downgrades.map(e => e.branch).sort(), ['activate', 'maximize'])
    assert.ok(downgrades.every(e => e.origin === 'auto'))
    assert.equal(h.supervisor.lastIntent()?.kind, 'bg', 'auto must not overwrite the explicit anchor')
  } finally {
    h.server.close()
  }
})

test('explicit bg correlates control-intent, capture-prearm, window minimize and native hide under one token', { timeout: 20_000 }, async () => {
  const h = harness({ initial: 'maximized' })
  const base = await h.listen()
  try {
    const bg = await post(base, '/api/bg', { source: 'probe.explicit.bg' })
    assert.equal(bg.body.ok, true)
    const entries = h.stateLog.recent(80)
    const intent = entries.find(e => e.event === 'control-intent' && e.branch === 'bg')
    assert.ok(intent)
    assert.equal(intent.origin, 'explicit')
    assert.equal(intent.source, 'probe.explicit.bg')
    assert.equal(intent.route, 'POST /api/bg')
    assert.ok(intent.requestId)
    const token = intent.token
    assert.ok(token)

    const prearm = entries.findIndex(e => e.event === 'capture-prearm')
    const requested = entries.findIndex(e => e.event === 'window-minimize' && e.branch === 'requested')
    const applied = entries.findIndex(e => e.event === 'window-minimize' && e.branch === 'single')
    const hide = entries.findIndex(e => e.event === 'native-hide' && e.branch === 'applied')
    assert.ok(prearm >= 0 && requested > prearm, 'capture pre-arm must be logged before the collapse')
    assert.ok(applied > requested, 'actual minimize result follows the requested entry')
    assert.ok(hide > applied, 'native hide follows the applied minimize')
    for (const entry of [entries[prearm]!, entries[requested]!, entries[applied]!, entries[hide]!]) {
      assert.equal(entry.token, token, `${entry.event}/${entry.branch} must share the bg token`)
      assert.equal(entry.origin, 'explicit')
      assert.equal(entry.source, 'probe.explicit.bg')
      assert.equal(entry.route, 'POST /api/bg')
      assert.ok(entry.requestId)
    }
    assert.equal(entries[requested]!.windowId, 1)
    assert.equal(entries[hide]!.pid, 4242)
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)
  } finally {
    h.server.close()
  }
})

test('explicit show maximizes and foregrounds with correlated attribution', { timeout: 20_000 }, async () => {
  const h = harness({ initial: 'minimized' })
  const base = await h.listen()
  try {
    const show = await post(base, '/api/show', { maximize: true, source: 'cli.show' })
    assert.equal(show.body.ok, true)
    assert.equal(show.body.restored, 1)
    assert.equal(h.track.bounds.windowState, 'maximized')
    assert.deepEqual(h.nativeCalls, ['activate'])
    const entries = h.stateLog.recent(80)
    const requested = entries.find(e => e.event === 'window-restore' && e.branch === 'requested')
    const applied = entries.find(e => e.event === 'window-restore' && e.branch === 'maximize' && e.after === 'maximized')
    const native = entries.find(e => e.event === 'native-activate' && e.branch === 'applied')
    assert.ok(requested && applied && native)
    assert.equal(requested.origin, 'explicit')
    assert.equal(requested.source, 'cli.show')
    assert.equal(requested.token, applied.token)
    assert.equal(requested.token, native.token)
    assert.equal(native.pid, 4242)
    assert.ok(requested.before === 'minimized')
  } finally {
    h.server.close()
  }
})

test('unknown source may restore/unhide but never maximize/foreground; unknown login is refused with zero side effects', { timeout: 20_000 }, async () => {
  const h = harness({ initial: 'minimized' })
  const base = await h.listen()
  try {
    const show = await post(base, '/api/show', { maximize: true, activate: true })
    assert.equal(show.body.ok, true)
    assert.equal(show.body.restored, 1)
    assert.deepEqual(show.body.downgraded, ['maximize', 'activate'])
    assert.equal(h.track.bounds.windowState, 'normal', 'unknown source may not maximize')
    assert.ok(!h.nativeCalls.includes('activate'), 'unknown source may not foreground')
    assert.ok(h.nativeCalls.includes('unhide'))
    const entries = h.stateLog.recent(60)
    const requested = entries.find(e => e.event === 'window-restore' && e.branch === 'requested')
    const unhide = entries.find(e => e.event === 'native-unhide' && e.branch === 'applied')
    assert.ok(requested && unhide)
    assert.equal(requested.origin, 'unknown')
    assert.equal(requested.source, undefined, 'no source may be invented')
    assert.equal(typeof requested.token, 'string', 'the unknown request still gets a correlation token')
    assert.equal(unhide.origin, 'unknown')
    assert.ok(entries.some(e => e.event === 'policy-downgrade' && e.origin === 'unknown'))
    assert.equal(h.supervisor.lastIntent(), null, 'unknown is never silently classified as human')

    const launches = h.track.launches
    const login = await post(base, '/api/login', {})
    assert.equal(login.status, 400)
    assert.equal(login.body.ok, false)
    assert.equal(h.track.launches, launches, 'refused login must not launch')
    assert.equal(h.nativeCalls.filter(c => c === 'activate').length, 0)
    const rejected = h.stateLog.recent(20).find(e => e.event === 'request-rejected')
    assert.ok(rejected)
    assert.equal(rejected.origin, 'unknown')
    assert.equal(rejected.branch, 'non-explicit')
  } finally {
    h.server.close()
  }
})

test('an external window change is not attributed to any daemon intent', { timeout: 20_000 }, async () => {
  const h = harness({ initial: 'normal' })
  const base = await h.listen()
  try {
    const before = h.stateLog.size()
    // Simulate a raw CDP client / OS maximizing the window outside the daemon.
    h.track.bounds = { ...h.track.bounds, windowState: 'maximized' }
    const windows = await (await fetch(`${base}/api/windows`)).json() as any
    assert.equal(windows.windows[0].state, 'maximized')
    assert.equal(h.stateLog.size(), before, 'an external transition produces no fabricated daemon attribution')
    assert.equal(h.supervisor.lastIntent(), null)
  } finally {
    h.server.close()
  }
})

test('a failed explicit route completes its intent so auto reconcile is never blocked forever', { timeout: 20_000 }, async () => {
  let failNext = true
  const h = harness({
    setPaused: async () => {
      if (failNext) { failNext = false; throw new Error('capture pause gate failure') }
    },
  })
  const base = await h.listen()
  try {
    const show = await post(base, '/api/show', { source: 'test.fail.show' })
    assert.equal(show.status, 502)
    const failed = h.stateLog.recent(40).find(e => e.event === 'control-intent' && e.branch === 'complete' && e.after === 'failed')
    assert.ok(failed, 'a thrown route must complete its intent')
    const auto = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: Date.now(), activate: false })
    assert.equal(auto.body.ignored, undefined, 'a lingering pending intent must not block auto reconcile forever')
  } finally {
    h.server.close()
  }
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
