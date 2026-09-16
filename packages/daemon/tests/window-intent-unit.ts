import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate settings/paths before the daemon modules are loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-window-intent-'))
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ collapseMode: 'minimize', launchMode: 'background' }))
process.env.BACKLIGHT_HOME = home

const { createServer } = await import('../src/proxy.ts')
const { FramePumpSupervisor } = await import('../src/windows.ts')
const { ActivityBus } = await import('../src/activity.ts')
const { StateTransitionLog } = await import('../src/state-log.ts')
const { saveSettings } = await import('../src/store.ts')

interface Track {
  running: boolean
  bounds: any
  hidden: boolean
  hideCalls: number
  minimizes: number
  launches: number
  launchOpts: any
  launchHistory: any[]
  restarts: Array<{ reason: string; opts: any }>
  activatedTabs: string[]
  createdTabs: string[]
  createdOpts: any[]
  pausedCalls: boolean[]
  tabs: Array<{ targetId: string; type: string; title: string; url: string; attached: boolean }>
}

interface HarnessOptions {
  running?: boolean
  initial?: string
  setPaused?: (paused: boolean) => Promise<void>
  extensionDev?: any
}

function harness(opts: HarnessOptions = {}) {
  const track: Track = {
    running: opts.running ?? true,
    bounds: { left: 60, top: 60, width: 1200, height: 800, windowState: opts.initial ?? 'normal' },
    hidden: false, hideCalls: 0, minimizes: 0, launches: 0, launchOpts: null, launchHistory: [], restarts: [],
    activatedTabs: [], createdTabs: [], createdOpts: [], pausedCalls: [], tabs: [],
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
        case 'Target.createTarget':
          track.createdTabs.push(params.url)
          track.createdOpts.push(params)
          return { targetId: 'created' }
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
      track.launchHistory.push(o)
      track.running = true
      manager.current = instance()
      return { pid: 4242, upstreamPort: 1, version: 'test' }
    },
    async listTabs() { return track.tabs },
    async stop() { track.running = false; manager.current = null },
    async restart(reason: string, restartOpts: any = {}) { track.restarts.push({ reason, opts: restartOpts }) },
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
    extensionDev: opts.extensionDev ?? {
      entry: () => ({ name: 'stub', path: '/stub' }),
      openPanel: async () => ({ extensionId: 'stub', targetId: 'page', panelTargetId: 'panel' }),
    },
    bus: new ActivityBus(),
    version: '0',
    startedAt: 0,
    pulse() {},
    capture: {
      isPaused: () => false,
      setPaused: async (paused: boolean) => { track.pausedCalls.push(paused); if (opts.setPaused) await opts.setPaused(paused) },
      activeTargetId: () => null,
      prearm: async () => null,
    },
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

const withLaunchMode = async <T>(mode: 'background' | 'visible', fn: () => Promise<T>): Promise<T> => {
  saveSettings({ launchMode: mode })
  try { return await fn() } finally { saveSettings({ launchMode: 'background' }) }
}

// ---- strict provenance gate -------------------------------------------------

test('non-explicit show is refused before any side effect: auto, unknown and delayed auto after bg', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const bg = await post(base, '/api/bg', { source: 'tray.menu.bg' })
    assert.equal(bg.body.ok, true)
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)
    const minimizesAfterBg = h.track.minimizes
    const nativeAfterBg = h.nativeCalls.slice()

    // A synthetic tray.auto request (no physical click can be proven from the
    // caller label) must not unminimize or unhide anything.
    const auto = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: Date.now(), activate: false })
    assert.equal(auto.status, 200)
    assert.equal(auto.body.ignored, 'unverified-activation', JSON.stringify(auto.body))
    assert.equal(auto.body.restored, 0)
    assert.equal(h.track.minimizes, minimizesAfterBg, 'refused auto show must not touch windows')
    assert.equal(h.track.bounds.windowState, 'minimized', 'window must stay collapsed')
    assert.equal(h.track.hidden, true, 'app must stay hidden')
    assert.deepEqual(h.nativeCalls, nativeAfterBg, 'refused auto show must not touch native app state')

    // Unknown sources are refused with an explicit error, zero side effects.
    const unknown = await post(base, '/api/show', { maximize: true, activate: true })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.ignored, 'unverified-source')
    assert.equal(unknown.body.ok, false)
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)
    assert.deepEqual(h.nativeCalls, nativeAfterBg)

    // An explicit control surface still works (last explicit intent wins).
    const explicit = await post(base, '/api/show', { source: 'tray.menu.show', activate: false })
    assert.equal(explicit.status, 200)
    assert.equal(explicit.body.restored, 1)
    assert.equal(h.track.hidden, false)
    assert.equal(h.track.bounds.windowState, 'normal')

    // Delayed auto after the explicit bg completed: inside an internal
    // activity interval it is labelled internal-activation, after it ends it
    // is unverified-activation — neither may rebound the collapsed window.
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    h.supervisor.beginInternalActivity('capture-picker')
    const during = Date.now()
    const autoDuring = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: during, activate: false })
    assert.equal(autoDuring.body.ignored, 'internal-activation', JSON.stringify(autoDuring.body))
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)
    h.supervisor.endInternalActivity('capture-picker')
    const endedAt = h.supervisor.internalState()!.to!
    const delayed = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: endedAt + 5_000, activate: false })
    assert.equal(delayed.body.ignored, 'unverified-activation', JSON.stringify(delayed.body))
    assert.equal(h.track.minimizes, minimizesAfterBg + 1, 'the repeated bg is the only new minimize')
    assert.equal(h.track.bounds.windowState, 'minimized', 'delayed auto must not unminimize')
    assert.equal(h.track.hidden, true, 'delayed auto must not unhide')

    const skips = h.stateLog.recent(80).filter(e => e.event === 'show-skip')
    assert.ok(skips.length >= 4, `every refusal must be logged: ${JSON.stringify(skips)}`)
    assert.ok(skips.every(e => e.route === 'POST /api/show' && typeof e.requestId === 'string'))
    assert.ok(skips.some(e => e.origin === 'auto' && e.source === 'tray.auto.activate' && e.branch === 'unverified-activation'))
    assert.ok(skips.some(e => e.origin === 'auto' && e.branch === 'internal-activation'))
    assert.ok(skips.some(e => e.origin === 'unknown' && e.source === undefined && e.branch === 'unverified-source'), 'unknown must not invent a source')
    assert.ok(skips.some(e => typeof e.detail === 'string' && e.detail.includes('evidence=hidden')),
      'the refusal must record the OS evidence it chose safety over')
    const autoRestores = h.stateLog.recent(200).filter(e => e.origin === 'auto' && (e.event === 'window-restore' || e.event === 'native-unhide'))
    assert.equal(autoRestores.length, 0, `auto may never produce an on-screen transition: ${JSON.stringify(autoRestores)}`)
  } finally {
    h.server.close()
  }
})

test('delayed tray.auto after an explicit bg completes never rebounds', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const bgAt = Date.now()
    await post(base, '/api/bg', { source: 'cli.bg' })
    const settled = { minimizes: h.track.minimizes, native: h.nativeCalls.slice() }
    // Simulate the stale notification that produced the original 2-3s rebound:
    // observedAt predates the collapse, delivery arrives now.
    for (const observedAt of [bgAt - 5_000, bgAt, Date.now() + 60_000]) {
      const res = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt, activate: false })
      assert.equal(res.body.restored, 0, `observedAt=${observedAt} must not restore`)
      assert.equal(res.body.ignored, 'unverified-activation', JSON.stringify(res.body))
    }
    await new Promise(r => setTimeout(r, 1_000))
    assert.equal(h.track.bounds.windowState, 'minimized', 'window must stay minimized')
    assert.equal(h.track.hidden, true, 'app must stay hidden')
    assert.equal(h.track.minimizes, settled.minimizes)
    assert.deepEqual(h.nativeCalls, settled.native)
    assert.equal(h.supervisor.lastIntent()?.kind, 'bg', 'an auto reconcile must not fabricate a human intent')

    // Explicit paths remain the only way to show.
    const show = await post(base, '/api/show', { source: 'cli.show' })
    assert.equal(show.body.restored, 1)
    assert.equal(h.track.bounds.windowState, 'normal')
    assert.equal(h.track.hidden, false)
  } finally {
    h.server.close()
  }
})

test('auto tray payload can never maximize or foreground (invariant)', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    const auto = await post(base, '/api/show', {
      source: 'tray.auto.poll', observedAt: Date.now(), maximize: true, activate: true,
    })
    assert.equal(auto.body.ignored, 'unverified-activation', JSON.stringify(auto.body))
    assert.equal(auto.body.downgraded, undefined, 'there is no downgraded restore path anymore')
    assert.equal(h.track.bounds.windowState, 'minimized', 'auto may not restore, let alone maximize')
    assert.ok(!h.nativeCalls.includes('activate'), 'auto may never foreground')
    assert.ok(!h.nativeCalls.includes('unhide'), 'auto may never unhide')
    const autoIntent = h.stateLog.recent(80).find(e => e.event === 'control-intent' && e.origin === 'auto')
    assert.equal(autoIntent, undefined, 'a refused request must not start a control intent')
    assert.equal(h.supervisor.lastIntent()?.kind, 'bg')
  } finally {
    h.server.close()
  }
})

test('arbitrary caller-supplied source labels are unknown, never explicit', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    for (const body of [
      { source: 'random.caller' },
      { source: 'mycli.show' },
      { source: 'tray.automatic' },
      { source: 'whatever', explicit: true },
    ]) {
      const res = await post(base, '/api/show', body)
      assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused`)
      assert.equal(res.body.ignored, 'unverified-source')
      assert.equal(h.track.bounds.windowState, 'minimized')
      assert.equal(h.track.hidden, true)
    }
    // A known label explicitly marked as not-explicit is auto, not human.
    const downgraded = await post(base, '/api/show', { source: 'cli.show', explicit: false })
    assert.equal(downgraded.status, 200)
    assert.equal(downgraded.body.ignored, 'unverified-activation')
    assert.equal(h.track.bounds.windowState, 'minimized')
    // A known control surface still shows.
    const ok = await post(base, '/api/show', { source: 'cli.show' })
    assert.equal(ok.body.restored, 1)
  } finally {
    h.server.close()
  }
})

test('unknown login and console are refused with zero side effects', { timeout: 20_000 }, async () => {
  const h = harness({ running: false })
  const base = await h.listen()
  try {
    for (const route of ['/api/login', '/api/console']) {
      const res = await post(base, route, {})
      assert.equal(res.status, 400, route)
      assert.equal(res.body.ok, false)
    }
    assert.equal(h.track.launches, 0, 'refused requests must not launch')
    assert.deepEqual(h.nativeCalls, [])
    const rejected = h.stateLog.recent(20).filter(e => e.event === 'request-rejected')
    assert.equal(rejected.length, 2)
    assert.ok(rejected.every(e => e.origin === 'unknown' && e.branch === 'non-explicit'))
  } finally {
    h.server.close()
  }
})

// ---- explicit control surfaces still work ----------------------------------

test('internal capture activation cannot override an explicit bg; explicit menu show still wins', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    await post(base, '/api/bg', { source: 'tray.menu.bg' })
    h.supervisor.beginInternalActivity('capture-picker')
    const during = Date.now()
    const auto = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: during, activate: false })
    assert.equal(auto.body.ignored, 'internal-activation', JSON.stringify(auto.body))
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)

    const explicit = await post(base, '/api/show', { source: 'tray.menu.show', observedAt: during, activate: false })
    assert.equal(explicit.body.ignored, undefined)
    assert.equal(explicit.body.restored, 1)
    assert.equal(h.track.hidden, false)
    assert.equal(h.track.bounds.windowState, 'normal')

    h.supervisor.endInternalActivity('capture-picker')
    const late = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: h.supervisor.internalState()!.to! + 5_000, activate: false })
    assert.equal(late.body.ignored, 'unverified-activation', 'late auto is still not proof of a human click')
    assert.equal(h.track.hidden, false, 'the explicit show is not undone by a later auto reconcile')
  } finally {
    h.server.close()
  }
})

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

// ---- launch / open / restart provenance ------------------------------------

test('non-explicit launch never inherits launchMode=visible; explicit launch still does', { timeout: 20_000 }, async () => {
  await withLaunchMode('visible', async () => {
    const h = harness({ running: false })
    const base = await h.listen()
    try {
      const unknown = await post(base, '/api/launch', { url: 'about:blank' })
      assert.equal(unknown.body.ok, true)
      assert.equal(h.track.launchOpts.focus, false, 'unknown launch must be forced background')
      assert.equal(h.track.launchOpts.keepVisible, false)
      const launchIntent = h.stateLog.recent(40).find(e => e.event === 'launch' && e.source === undefined)
      assert.ok(launchIntent)
      assert.equal(launchIntent.origin, 'unknown')
      assert.equal(launchIntent.branch, 'background')

      const explicit = await post(base, '/api/launch', { url: 'about:blank', source: 'cli.launch' })
      assert.equal(explicit.body.ok, true)
      assert.equal(h.track.launchOpts.focus, undefined, 'an explicit plain launch may honor launchMode')
      assert.equal(h.track.launchOpts.keepVisible, undefined)

      const foreground = await post(base, '/api/launch', { url: 'about:blank', source: 'cli.launch', focus: true })
      assert.equal(foreground.body.ok, true)
      assert.equal(h.track.launchOpts.focus, true)

      const downgraded = await post(base, '/api/launch', { url: 'about:blank', focus: true })
      assert.equal(h.track.launchOpts.focus, false, 'a non-explicit focus request is downgraded')
      assert.ok(h.stateLog.recent(40).some(e => e.event === 'policy-downgrade' && e.branch === 'foreground' && e.origin === 'unknown'))
    } finally {
      h.server.close()
    }
  })
})

test('open first launch is background even with launchMode=visible; running opens stay background targets', { timeout: 20_000 }, async () => {
  await withLaunchMode('visible', async () => {
    const h = harness({ running: false })
    const base = await h.listen()
    try {
      const open = await post(base, '/api/open', { url: 'about:blank' })
      assert.equal(open.body.ok, true)
      assert.equal(h.track.launches, 1)
      assert.equal(h.track.launchOpts.focus, false, 'open must never inherit launchMode')
      assert.equal(h.nativeCalls.length, 0)
      const launched = h.stateLog.recent(40).find(e => e.event === 'open' && e.branch === 'launched-background')
      assert.ok(launched)
      assert.equal(launched.origin, 'unknown')

      await post(base, '/api/open', { url: 'about:blank', source: 'cli.open' })
      assert.equal(h.track.createdOpts.length, 1)
      assert.equal(h.track.createdOpts[0].background, true, 'running open creates a background target')
      assert.equal(h.nativeCalls.length, 0)
    } finally {
      h.server.close()
    }
  })
})

test('non-explicit restart is forced background even with launchMode=visible', { timeout: 20_000 }, async () => {
  await withLaunchMode('visible', async () => {
    const h = harness()
    const base = await h.listen()
    try {
      const unknown = await post(base, '/api/restart', { reason: 'probe' })
      assert.equal(unknown.body.ok, true)
      assert.equal(h.track.restarts.length, 1)
      assert.equal(h.track.restarts[0].opts.focus, false, 'unknown restart must be forced background')
      const restartEntry = h.stateLog.recent(20).find(e => e.event === 'restart')
      assert.ok(restartEntry)
      assert.equal(restartEntry.origin, 'unknown')
      assert.equal(restartEntry.branch, 'forced-background')

      await post(base, '/api/restart', { reason: 'probe', source: 'cli.restart' })
      assert.equal(h.track.restarts[1].opts.focus, undefined, 'explicit restart keeps launchMode behavior')
    } finally {
      h.server.close()
    }
  })
})

// ---- extension dev / inspect ------------------------------------------------

test('extensions/dev and inspect refuse unknown sources with zero side effects; explicit sources work', { timeout: 20_000 }, async () => {
  const h = harness()
  h.track.tabs = [{ targetId: 't1', type: 'page', title: 't', url: 'about:blank', attached: false }]
  const base = await h.listen()
  try {
    const devUnknown = await post(base, '/api/extensions/dev', { name: 'stub', url: 'about:blank' })
    assert.equal(devUnknown.status, 400)
    assert.equal(devUnknown.body.ok, false)
    assert.equal(h.track.launches, 0, 'refused ext-dev must not launch')
    assert.equal(h.track.createdOpts.length, 0, 'refused ext-dev must not create targets')
    assert.equal(h.track.pausedCalls.length, 0, 'refused ext-dev must not pause capture')
    assert.equal(h.nativeCalls.length, 0)

    const inspectUnknown = await post(base, '/api/inspect', { targetId: 't1' })
    assert.equal(inspectUnknown.status, 400)
    assert.equal(inspectUnknown.body.ok, false)
    assert.equal(h.track.createdOpts.length, 0, 'refused inspect must not create a DevTools window')
    assert.equal(h.nativeCalls.length, 0)

    const rejected = h.stateLog.recent(20).filter(e => e.event === 'request-rejected')
    assert.equal(rejected.length, 2)
    assert.ok(rejected.every(e => e.origin === 'unknown' && e.branch === 'non-explicit' && typeof e.requestId === 'string'))

    const dev = await post(base, '/api/extensions/dev', { name: 'stub', targetId: 't1', activate: false, source: 'test.ext.dev' })
    assert.equal(dev.status, 200, JSON.stringify(dev.body))
    assert.equal(dev.body.panelTargetId, 'panel')
    assert.equal(h.track.bounds.windowState, 'normal', 'explicit ext-dev restores the window')
    assert.ok(h.nativeCalls.includes('unhide'))

    const inspect = await post(base, '/api/inspect', { targetId: 't1', source: 'test.inspect' })
    assert.equal(inspect.status, 200)
    assert.equal(h.track.createdOpts.at(-1)?.newWindow, true, 'explicit inspect opens its own window')
    assert.ok(h.nativeCalls.includes('activate'))
    const inspectIntent = h.stateLog.recent(40).find(e => e.event === 'control-intent' && e.source === 'test.inspect')
    assert.ok(inspectIntent && inspectIntent.origin === 'explicit')
  } finally {
    h.server.close()
  }
})

test('PUT /json/new creates a background target instead of a foreground tab', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const res = await fetch(`${base}/json/new?url=http://example.test/page`, { method: 'PUT' })
    assert.equal(res.status, 200)
    const body = await res.json() as any
    assert.equal(h.track.createdOpts.length, 1)
    assert.equal(h.track.createdOpts[0].background, true, '/json/new must not focus the new tab')
    assert.equal(body.id, 'created')
    assert.equal(body.type, 'page')
    assert.equal(body.url, 'http://example.test/page')
    assert.ok(String(body.webSocketDebuggerUrl).includes('/devtools/page/created'))
    assert.equal(h.track.bounds.windowState, 'normal', 'window state must not change')
    assert.equal(h.nativeCalls.length, 0)
  } finally {
    h.server.close()
  }
})

// ---- status / attribution ---------------------------------------------------

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

test('a failed explicit route completes its intent and never fabricates a native transition', { timeout: 20_000 }, async () => {
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
    assert.equal(h.supervisor.lastIntent()?.pending, false, 'no lingering pending anchor')
    // The refusal gate is independent of pending intents now.
    const auto = await post(base, '/api/show', { source: 'tray.auto.activate', observedAt: Date.now(), activate: false })
    assert.equal(auto.body.ignored, 'unverified-activation')
    assert.equal(h.track.bounds.windowState, 'normal', 'the failed show itself produced no transition')
  } finally {
    h.server.close()
  }
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
