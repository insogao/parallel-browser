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
const { browserSessionId } = await import('../src/session.ts')

const SESSION = browserSessionId({ space: 'default', pid: 4242, startedAt: 0 })

interface Track {
  running: boolean
  bounds: any
  hidden: boolean
  active: boolean
  hideCalls: number
  minimizes: number
  launches: number
  launchOpts: any
  launchHistory: any[]
  restarts: Array<{ reason: string; opts: any }>
  /** set to a reason to make the manager's fail-closed restart guard refuse */
  restartDeferral: string | null
  /** result the fake manager returns from restart (race-path coverage) */
  restartResult: { restarted: boolean; deferred?: string }
  activatedTabs: string[]
  createdTabs: string[]
  createdOpts: any[]
  closedTargets: string[]
  /** Target.createTarget invocations that have started (before any delay) */
  createStarted: number
  createWhenHidden: boolean[]
  windowCreates: Array<{ focused: boolean; state: string; url: string }>
  hasWindow: boolean
  windowAlive: boolean
  /** ordered settle operations: health-refresh, prearm, minimize, hide */
  ops: string[]
  pausedCalls: boolean[]
  tabs: Array<{ targetId: string; type: string; title: string; url: string; attached: boolean }>
}

interface HarnessOptions {
  running?: boolean
  initial?: string
  hasWindow?: boolean
  initialHidden?: boolean
  initialActive?: boolean
  /** make Target.createTarget place the new tab in a second native window */
  createTargetInNewWindow?: boolean
  /** place new non-hidden tabs in this existing window id (default 1) */
  createTargetInWindow?: number
  /** extra existing window ids (each with a page target); default [1] */
  windowIds?: number[]
  /** delay every Target.createTarget (forces real overlap without the lock) */
  createTargetDelayMs?: number
  /** make Browser.getWindowForTarget always fail (resolution failure path) */
  failWindowForTarget?: boolean
  setPaused?: (paused: boolean) => Promise<void>
  extensionDev?: any
}

function harness(opts: HarnessOptions = {}) {
  const hiddenTargets = new Map<string, string>()
  const windowIds = opts.windowIds ?? [1]
  const windowForTarget = new Map<string, number>(windowIds.map(id => [id === 1 ? 'page' : `page-${id}`, id]))
  const track: Track = {
    running: opts.running ?? true,
    bounds: { left: 60, top: 60, width: 1200, height: 800, windowState: opts.initial ?? 'normal' },
    hidden: opts.initialHidden ?? false, active: opts.initialActive ?? false, hideCalls: 0, minimizes: 0, launches: 0, launchOpts: null, launchHistory: [], restarts: [],
    restartDeferral: null, restartResult: { restarted: true },
    activatedTabs: [], createdTabs: [], createdOpts: [], closedTargets: [], createStarted: 0,
    createWhenHidden: [], windowCreates: [], hasWindow: opts.hasWindow ?? true,
    windowAlive: true, ops: [], pausedCalls: [], tabs: [],
  }
  const cdp = {
    closed: false,
    attach: async (targetId: string) => `session-${targetId}`,
    send: async (method: string, params: any = {}) => {
      switch (method) {
        case 'Target.getTargets': return { targetInfos: [
          ...(track.hasWindow && track.windowAlive
            ? windowIds.map(id => ({ targetId: id === 1 ? 'page' : `page-${id}`, type: 'page', url: 'about:blank' }))
            : []),
          ...[...hiddenTargets].map(([targetId, url]) => ({ targetId, type: 'other', url })),
        ] }
        case 'Browser.getWindowForTarget':
          if (opts.failWindowForTarget) throw new Error('No window for target')
          return { windowId: windowForTarget.get(params.targetId) ?? 1 }
        case 'Browser.getWindowBounds':
          if (!track.windowAlive) throw new Error('Browser window not found')
          return { bounds: { ...track.bounds } }
        case 'Browser.setWindowBounds':
          if (params.bounds.windowState === 'minimized') { track.minimizes++; track.ops.push('minimize') }
          Object.assign(track.bounds, params.bounds)
          return {}
        case 'Runtime.evaluate': {
          const expression = String(params.expression)
          if (expression.includes('chrome.windows?.create')) return { result: { value: true } }
          if (expression.includes('chrome.windows.create')) {
            const url = expression.match(/url:\s*("[^"]+")/)?.[1]
            track.windowCreates.push({ focused: false, state: 'minimized', url: url ? JSON.parse(url) : '' })
            track.hasWindow = true
            track.bounds.windowState = 'minimized'
            return { result: { value: { id: 1, state: 'minimized' } } }
          }
          return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
        }
        case 'Target.activateTarget': track.activatedTabs.push(params.targetId); return {}
        case 'Target.createTarget': {
          track.createStarted++
          if (opts.createTargetDelayMs) await new Promise(r => setTimeout(r, opts.createTargetDelayMs))
          track.createdTabs.push(params.url)
          track.createdOpts.push(params)
          track.createWhenHidden.push(track.hidden)
          const targetId = params.hidden ? `hidden-${track.createdOpts.length}` : 'created'
          if (params.hidden) hiddenTargets.set(targetId, params.url)
          else {
            track.hasWindow = true
            track.windowAlive = true
            windowForTarget.set(targetId, opts.createTargetInNewWindow ? 99 : (opts.createTargetInWindow ?? 1))
          }
          return { targetId }
        }
        case 'Target.closeTarget': track.closedTargets.push(params.targetId); hiddenTargets.delete(params.targetId); return { success: true }
        default: return {}
      }
    },
  }
  const instance = () => ({ cdp, pid: 4242, upstreamPort: 1, binary: '/x/Backlight', space: 'default', version: 'test', extensionPaths: [], capturePageUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/capture.html', startedAt: 0 })
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
    async backgroundRestartDeferral() { return track.restartDeferral },
    async restart(reason: string, restartOpts: any = {}) {
      track.restarts.push({ reason, opts: restartOpts })
      return track.restartResult
    },
  }
  const supervisor = new FramePumpSupervisor(() => (manager.current ? { cdp } : null) as any, () => [])
  const stateLog = new StateTransitionLog({ sink: () => {} })
  // Mirror the daemon wiring: every transition from every source is attributed
  // to the one managed session.
  supervisor.onTransition = entry => stateLog.record({ ...entry, session: entry.session ?? SESSION })
  const nativeCalls: string[] = []
  const deps = {
    manager,
    supervisor,
    health: { refresh: async () => { track.ops.push('health-refresh') } },
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
      prearm: async () => { track.ops.push('prearm'); return 'created' },
    },
    appState: async () => ({ active: track.active, hidden: track.hidden }),
    hideBrowser: async () => { nativeCalls.push('hide'); track.ops.push('hide'); track.hideCalls++; track.hidden = true; track.active = false },
    unhideBrowser: async () => { nativeCalls.push('unhide'); track.hidden = false },
    activateBrowser: async () => { nativeCalls.push('activate'); track.hidden = false; track.active = true },
    stateLog,
    sessionId: () => SESSION,
  }
  const server = createServer(deps as any)
  return {
    track, server, supervisor, stateLog, nativeCalls, manager,
    /** Simulate the user closing the managed window (native window gone). */
    loseWindow: () => { track.windowAlive = false; track.hasWindow = false },
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

test('no launch inherits launchMode=visible: plain launches are background, only explicit visibility flags may show', { timeout: 20_000 }, async () => {
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

      // `bl launch` without --focus/--keep-visible promises background even
      // though cli.launch is an allowlisted explicit source.
      const explicitPlain = await post(base, '/api/launch', { url: 'about:blank', source: 'cli.launch' })
      assert.equal(explicitPlain.body.ok, true)
      assert.equal(h.track.launchOpts.focus, false, 'a plain explicit launch must not honor launchMode')
      assert.equal(h.track.launchOpts.keepVisible, false)
      const plainEntry = h.stateLog.recent(40).find(e => e.event === 'launch' && e.source === 'cli.launch')
      assert.ok(plainEntry)
      assert.equal(plainEntry.origin, 'explicit')
      assert.equal(plainEntry.branch, 'background')
      assert.ok(!h.stateLog.recent(40).some(e => e.event === 'policy-downgrade'
        && e.detail === 'non-explicit-visible-launch'), 'a plain launch requested nothing, so nothing is downgraded')

      const foreground = await post(base, '/api/launch', { url: 'about:blank', source: 'cli.launch', focus: true })
      assert.equal(foreground.body.ok, true)
      assert.equal(h.track.launchOpts.focus, true)
      assert.equal(h.track.launchOpts.keepVisible, false)

      const keepVisible = await post(base, '/api/launch', { url: 'about:blank', source: 'dashboard.launch', keepVisible: true })
      assert.equal(keepVisible.body.ok, true)
      assert.equal(h.track.launchOpts.focus, false)
      assert.equal(h.track.launchOpts.keepVisible, true)

      const backgroundFalse = await post(base, '/api/launch', { url: 'about:blank', source: 'cli.launch', background: false })
      assert.equal(backgroundFalse.body.ok, true)
      assert.equal(h.track.launchOpts.focus, true)

      const downgraded = await post(base, '/api/launch', { url: 'about:blank', focus: true, keepVisible: true })
      assert.equal(h.track.launchOpts.focus, false, 'a non-explicit visibility request is downgraded')
      assert.equal(h.track.launchOpts.keepVisible, false)
      assert.ok(h.stateLog.recent(40).some(e => e.event === 'policy-downgrade' && e.branch === 'foreground'
        && e.origin === 'unknown' && e.detail === 'non-explicit-visible-launch'))
    } finally {
      h.server.close()
    }
  })
})

test('cold open creates exactly one real managed window and settles it to background', { timeout: 20_000 }, async () => {
  await withLaunchMode('visible', async () => {
    const h = harness({ running: false, hasWindow: false, initialHidden: true })
    const base = await h.listen()
    try {
      const open = await post(base, '/api/open', { url: 'https://www.baidu.com/' })
      assert.equal(open.status, 200, JSON.stringify(open.body))
      assert.equal(open.body.windowless, false)
      assert.equal(open.body.takeover, true)
      assert.equal(open.body.firstDisplay, true)
      assert.equal(open.body.settled, true)
      assert.equal(open.body.windowId, 1)
      assert.equal(open.body.session, SESSION)
      assert.equal(h.track.launches, 1)
      assert.equal(h.track.launchOpts.focus, false, 'cold open must never inherit launchMode')
      assert.deepEqual(h.track.createdOpts, [{ url: 'https://www.baidu.com/', background: true }])
      assert.equal((h.track.createdOpts[0] as any).newWindow, undefined, 'never newWindow')
      assert.equal((h.track.createdOpts[0] as any).hidden, undefined, 'the default path is a real tab, not hidden')
      // settle order: health refresh -> capture pre-arm (while visible) ->
      // minimize -> native hide. No operation activates/foregrounds.
      const ops = h.track.ops
      assert.equal(ops[0], 'health-refresh')
      assert.ok(ops.indexOf('prearm') > 0, JSON.stringify(ops))
      assert.ok(ops.indexOf('minimize') > ops.indexOf('prearm'), JSON.stringify(ops))
      assert.ok(ops.lastIndexOf('hide') > ops.lastIndexOf('minimize'), JSON.stringify(ops))
      assert.equal(h.track.bounds.windowState, 'minimized')
      assert.equal(h.track.hidden, true)
      const entries = h.stateLog.recent(50)
      for (const branch of ['create-requested', 'created', 'settle-requested', 'settled']) {
        assert.ok(entries.some(e => e.event === 'managed-window' && e.branch === branch), `missing managed-window/${branch}`)
      }
      const created = entries.find(e => e.event === 'managed-window' && e.branch === 'created')
      assert.equal(created?.windowId, 1)
      assert.equal(created?.session, SESSION)
      assert.match(String(created?.detail), /first-display=once/)
      const openEntry = entries.find(e => e.event === 'open' && e.branch === 'first-window')
      assert.ok(openEntry)
      assert.match(String(openEntry.detail), /settled=true/)
      assert.equal(openEntry.session, SESSION)
      // No foreground/activation may ever be issued for a background open.
      assert.ok(!h.nativeCalls.includes('activate') && !h.nativeCalls.includes('unhide'))
    } finally {
      h.server.close()
    }
  })
})

test('repeated background opens reuse the one window without showing or minimizing again', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    const first = await post(base, '/api/open', { url: 'https://www.baidu.com/', source: 'cli.open' })
    assert.equal(first.body.firstDisplay, true)
    const opsAfterFirst = h.track.ops.length
    const second = await post(base, '/api/open', { url: 'https://www.bing.com/', source: 'cli.open' })
    assert.equal(second.status, 200)
    assert.equal(second.body.windowId, 1)
    assert.equal(second.body.reusedWindow, true)
    assert.equal(second.body.firstDisplay, false)
    assert.equal(second.body.settled, true)
    assert.equal(h.track.createdOpts.length, 2, 'one tab per open, still exactly one window')
    assert.equal(h.track.launches, 0, 'the running session is reused, not relaunched')
    assert.deepEqual(h.track.createdOpts[1], { url: 'https://www.bing.com/', background: true })
    const opsAfterSecond = h.track.ops.slice(opsAfterFirst)
    assert.ok(!opsAfterSecond.includes('minimize'), 'the window is not re-minimized per open')
    assert.ok(!opsAfterSecond.includes('prearm'), 'capture is not re-armed per open')
    assert.deepEqual(h.track.closedTargets, [])
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.equal(h.track.hidden, true)
    const events = h.stateLog.recent(60).filter(e => e.event === 'managed-window')
    assert.ok(events.some(e => e.branch === 'created'), 'the window was created once')
    assert.ok(events.some(e => e.branch === 'reuse'), 'later opens reuse the same managed window')
    assert.ok(events.some(e => e.branch === 'settled'))
  } finally { h.server.close() }
})

test('a lost managed window is never popped again by a background open', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    await post(base, '/api/open', { url: 'https://www.baidu.com/' })
    h.loseWindow()
    const refused = await post(base, '/api/open', { url: 'https://www.bing.com/' })
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.ok, false)
    assert.match(String(refused.body.reason), /one-time/)
    assert.match(String(refused.body.hint), /windowless/)
    assert.equal(h.track.createdOpts.length, 1, 'no second window may be created')
    const entries = h.stateLog.recent(40)
    assert.ok(entries.some(e => e.event === 'managed-window' && e.branch === 'lost'))
    assert.ok(entries.some(e => e.event === 'managed-window' && e.branch === 'refused'))

    // Only an explicit human action may re-create a window; it is tracked again.
    const show = await post(base, '/api/show', { source: 'tray.menu.show' })
    assert.equal(show.status, 200)
    assert.deepEqual(h.track.createdOpts[1], { url: 'about:blank', background: false })
    const again = await post(base, '/api/open', { url: 'https://www.bing.com/' })
    assert.equal(again.status, 200)
    assert.equal(again.body.firstDisplay, false)
    assert.equal(again.body.reusedWindow, true)
    assert.equal(h.track.createdOpts.length, 3)
  } finally { h.server.close() }
})

test('explicit show creates one empty window and never clones protocol-only pages', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    const hidden = await post(base, '/api/open', { url: 'https://www.baidu.com/', windowless: true })
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.windowless, true)
    assert.equal(hidden.body.takeover, false)
    await post(base, '/api/show', { source: 'tray.auto.activate' })
    assert.equal(h.track.createdOpts.length, 1, 'auto observations never materialize a page')
    const result = await post(base, '/api/show', { source: 'tray.menu.show' })
    assert.equal(result.status, 200)
    assert.deepEqual(h.track.createdOpts[1], { url: 'about:blank', background: false })
    assert.deepEqual(h.track.closedTargets, [], 'protocol-only pages are never closed to fake a takeover')
    const entries = h.stateLog.recent(50)
    assert.ok(entries.some(e => e.event === 'manual-window-create' && e.branch === 'created-empty'))
    assert.ok(entries.some(e => e.event === 'windowless-handoff' && e.branch === 'refused'
      && String(e.detail).includes('pending=1') && String(e.detail).includes('adoption=unsupported')))
    await post(base, '/api/show', { source: 'tray.menu.show' })
    assert.equal(h.track.createdOpts.length, 2, 'repeated manual show reuses the window')
  } finally { h.server.close() }
})

test('Dock activation never clones or closes protocol-only pages', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    await post(base, '/api/open', { url: 'https://www.baidu.com/', windowless: true })
    await post(base, '/api/open', { url: 'https://www.bing.com/', windowless: true })
    const created = h.track.createdOpts.length
    const native = h.nativeCalls.length
    h.track.hasWindow = true // Chrome opened its own New Tab on Dock click.
    h.track.hidden = false
    h.track.active = true
    const response = await post(base, '/api/show', { source: 'tray.auto.activate' })
    assert.equal(response.body.restored, 0)
    await new Promise(r => setTimeout(r, 400))
    assert.equal(h.track.createdOpts.length, created, 'no URL clone may be created for the user')
    assert.deepEqual(h.track.closedTargets, [], 'the original protocol-only targets must keep running')
    assert.equal(h.nativeCalls.length, native, 'no unhide/activate/hide may be issued')
    const refusal = h.stateLog.recent(40).find(e => e.event === 'windowless-handoff' && e.branch === 'refused')
    assert.ok(refusal, 'the unprovable handoff must be logged')
    assert.equal(refusal.origin, 'auto')
    assert.equal(refusal.source, 'tray.auto.activate')
    assert.match(String(refusal.detail), /trigger=dock-visible/)
    assert.match(String(refusal.detail), /pending=2/)
  } finally { h.server.close() }
})

test('windowless:false selects the real managed window path (cold and live)', { timeout: 20_000 }, async () => {
  const cold = harness({ running: false, hasWindow: false, initialHidden: true })
  const coldBase = await cold.listen()
  try {
    const res = await post(coldBase, '/api/open', { url: 'https://example.com/', windowless: false, source: 'cli.open' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.windowless, false)
    assert.equal(res.body.firstDisplay, true)
    assert.equal(cold.track.launches, 1)
    assert.deepEqual(cold.track.createdOpts, [{ url: 'https://example.com/', background: true }])
    assert.equal((cold.track.createdOpts[0] as any).hidden, undefined)
  } finally { cold.server.close() }

  const warm = harness({ hasWindow: true })
  const warmBase = await warm.listen()
  try {
    const res = await post(warmBase, '/api/open', { url: 'https://example.com/', windowless: false })
    assert.equal(res.status, 200)
    assert.equal(res.body.windowless, false)
    assert.equal(res.body.reusedWindow, true)
    assert.deepEqual(warm.track.closedTargets, [])
  } finally { warm.server.close() }
})

test('windowless:true keeps an existing window’s native visibility untouched', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: true, initialHidden: false, initialActive: true })
  const base = await h.listen()
  try {
    const res = await post(base, '/api/open', { url: 'https://example.com/', windowless: true, source: 'cli.open' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.windowless, true)
    assert.equal(res.body.takeover, false)
    assert.equal(h.track.hideCalls, 0, 'a protocol-only page must not hide a visible window')
    assert.equal(h.track.hidden, false)
    assert.equal(h.track.active, true)
    assert.deepEqual(h.nativeCalls, [], 'no native visibility operation at all')
    assert.equal(h.track.createdOpts[0].hidden, true)
    assert.equal(h.track.hasWindow, true)
    const entry = h.stateLog.recent(20).find(e => e.event === 'open' && e.branch === 'windowless-target')
    assert.ok(entry)
    assert.match(String(entry.detail), /native=unchanged/)
  } finally { h.server.close() }

  // The zero-window background contract still hides (there is no window to preserve).
  const cold = harness({ hasWindow: false, initialHidden: false })
  const coldBase = await cold.listen()
  try {
    const res = await post(coldBase, '/api/open', { url: 'https://example.com/', windowless: true })
    assert.equal(res.status, 200)
    assert.equal(cold.track.hideCalls, 1)
    assert.equal(cold.track.hidden, true)
    assert.equal(cold.track.hasWindow, false)
  } finally { cold.server.close() }
})

test('an open that lands in a second native window is closed and fails', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: true, createTargetInNewWindow: true })
  const base = await h.listen()
  try {
    const res = await post(base, '/api/open', { url: 'https://example.com/', source: 'cli.open' })
    assert.equal(res.status, 502, JSON.stringify(res.body))
    assert.deepEqual(h.track.closedTargets, ['created'], 'the stray window tab must be closed, never adopted')
    assert.ok(!h.stateLog.recent(20).some(e => e.event === 'open' && e.branch === 'background-target'))
  } finally { h.server.close() }
})

test('a tab placed in another existing window is closed and fails, never adopted', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: true, windowIds: [1, 2], createTargetInWindow: 2 })
  const base = await h.listen()
  try {
    const res = await post(base, '/api/open', { url: 'https://example.com/', source: 'cli.open' })
    assert.equal(res.status, 502, JSON.stringify(res.body))
    assert.deepEqual(h.track.closedTargets, ['created'], 'the wrong-window tab must be closed')
    const entries = h.stateLog.recent(40)
    assert.ok(entries.some(e => e.event === 'managed-window' && e.branch === 'rejected-placement'
      && e.windowId === 1))
    assert.ok(!entries.some(e => e.event === 'managed-window' && e.branch === 'adopt' && e.windowId === 2),
      'the unintended window must never become the managed window')
    assert.ok(!entries.some(e => e.event === 'open' && e.branch === 'background-target'))
  } finally { h.server.close() }
})

test('concurrent zero-window opens are serialized: one window, one first display', { timeout: 20_000 }, async () => {
  // The create delay forces overlap: without the per-session window lock both
  // requests would pass the first-display check and create two windows.
  const h = harness({ hasWindow: false, initialHidden: true, createTargetDelayMs: 50 })
  const base = await h.listen()
  try {
    const [a, b] = await Promise.all([
      post(base, '/api/open', { url: 'https://a.example/', source: 'cli.open' }),
      post(base, '/api/open', { url: 'https://b.example/', source: 'cli.open' }),
    ])
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.equal(b.status, 200, JSON.stringify(b.body))
    const firsts = [a, b].filter(r => r.body.firstDisplay === true)
    const reuses = [a, b].filter(r => r.body.reusedWindow === true)
    assert.equal(firsts.length, 1, 'exactly one request may create the window')
    assert.equal(reuses.length, 1, 'the other request must reuse it')
    assert.equal(h.track.createdOpts.filter(o => !o.hidden).length, 2, 'one tab per request')
    assert.equal(h.track.createdOpts.filter(o => !o.hidden && o.background === true).length, 2)
    assert.equal(h.track.closedTargets.length, 0)
    assert.equal(h.track.hasWindow, true)
    assert.equal(h.stateLog.recent(80).filter(e => e.event === 'managed-window' && e.branch === 'created').length, 1)
    assert.equal(h.stateLog.recent(80).filter(e => e.event === 'managed-window' && e.branch === 'reuse').length, 1)
  } finally { h.server.close() }
})

test('concurrent launch+open share one session lock (one launch, one window)', { timeout: 20_000 }, async () => {
  const h = harness({ running: false, hasWindow: false, initialHidden: true, createTargetDelayMs: 30 })
  const base = await h.listen()
  try {
    const [launch, open] = await Promise.all([
      post(base, '/api/launch', { url: 'https://a.example/', source: 'cli.launch' }),
      post(base, '/api/open', { url: 'https://b.example/', source: 'cli.open' }),
    ])
    assert.equal(launch.status, 200, JSON.stringify(launch.body))
    assert.equal(open.status, 200, JSON.stringify(open.body))
    assert.equal(h.track.launches, 1, 'the browser must be launched once')
    assert.equal(h.track.createdOpts.filter(o => !o.hidden).length, 2, 'two tabs in the one window')
    const firsts = [launch, open].filter(r => r.body.firstDisplay === true)
    assert.equal(firsts.length, 1, 'one first display')
    assert.equal(h.stateLog.recent(80).filter(e => e.event === 'managed-window' && e.branch === 'created').length, 1)
  } finally { h.server.close() }
})

test('a human show during an in-flight background open is never re-hidden', { timeout: 20_000 }, async () => {
  // Deterministic race: the reused-window open reads wasHidden=true, then its
  // createTarget is held open while the human explicitly shows the browser.
  // The stale hidden flag must not cause a second native hide.
  const h = harness({ hasWindow: false, initialHidden: true, createTargetDelayMs: 200 })
  const base = await h.listen()
  try {
    const first = await post(base, '/api/open', { url: 'https://a.example/' })
    assert.equal(first.body.firstDisplay, true)
    const hidesBefore = h.track.hideCalls
    const createsBefore = h.track.createStarted

    const bgPromise = post(base, '/api/open', { url: 'https://b.example/', source: 'cli.open' })
    const deadline = Date.now() + 4000
    while (h.track.createStarted < createsBefore + 1 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5))
    }
    assert.equal(h.track.createStarted, createsBefore + 1, 'the background create must be in flight')
    const showPromise = post(base, '/api/show', { source: 'tray.menu.show' })
    // Let the show route record its explicit intent + humanMode before the
    // delayed create resolves.
    await new Promise(r => setTimeout(r, 50))
    const [bg, show] = await Promise.all([bgPromise, showPromise])

    assert.equal(bg.status, 200, JSON.stringify(bg.body))
    assert.equal(bg.body.settled, false, 'a stale wasHidden must not trigger a hide')
    assert.equal(bg.body.settleReason, 'human-mode')
    assert.equal(show.status, 200)
    assert.equal(show.body.restored, 1)
    assert.equal(h.track.hideCalls, hidesBefore, 'no native hide may run after the human takeover')
    assert.equal(h.track.hidden, false, 'the human window must stay visible')
    assert.equal(h.track.bounds.windowState, 'normal')
    const skipped = h.stateLog.recent(60)
      .find(e => e.event === 'native-hide' && e.branch === 'skipped-human-takeover')
    assert.ok(skipped, 'the refused re-hide must be logged')
    assert.match(String(skipped.detail), /reason=human-mode/)
    // The background tab itself was still created in the same window.
    assert.ok(h.track.createdOpts.some(o => o.url === 'https://b.example/'))
    assert.deepEqual(h.track.closedTargets, [])
  } finally { h.server.close() }
})

test('a Dock-style window restore during an in-flight background open is not re-hidden', { timeout: 20_000 }, async () => {
  // Dock boundary: the OS restores the minimized window without any API intent
  // (no humanMode, no generation bump, app never becomes active). The stale
  // wasHidden=true must not hide it again.
  const h = harness({ hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    const first = await post(base, '/api/open', { url: 'https://a.example/' })
    assert.equal(first.body.firstDisplay, true)
    assert.equal(h.track.bounds.windowState, 'minimized')
    const hidesBefore = h.track.hideCalls

    const originalSend = h.manager.current.cdp.send
    h.manager.current.cdp.send = async (method: string, params: any = {}) => {
      const result = await originalSend(method, params)
      if (method === 'Target.createTarget') h.track.bounds.windowState = 'normal' // Dock restore
      return result
    }
    const bg = await post(base, '/api/open', { url: 'https://b.example/', source: 'cli.open' })
    assert.equal(bg.status, 200, JSON.stringify(bg.body))
    assert.equal(bg.body.settled, false)
    assert.equal(bg.body.settleReason, 'restored-window')
    assert.equal(h.track.hideCalls, hidesBefore, 'the Dock-restored window must not be hidden')
    assert.equal(h.track.bounds.windowState, 'normal')
    const skipped = h.stateLog.recent(60)
      .find(e => e.event === 'native-hide' && e.branch === 'skipped-human-takeover')
    assert.ok(skipped)
    assert.match(String(skipped.detail), /reason=restored-window/)
  } finally { h.server.close() }
})

test('a failed first-window resolution consumes the one-time display (no second pop)', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: false, initialHidden: true, failWindowForTarget: true })
  const base = await h.listen()
  try {
    const first = await post(base, '/api/open', { url: 'https://a.example/' })
    assert.equal(first.status, 502, JSON.stringify(first.body))
    assert.equal(h.track.createdOpts.length, 1, 'the irreversible create happened exactly once')
    assert.ok(h.stateLog.recent(30).some(e => e.event === 'managed-window'
      && e.branch === 'first-display-unresolved'))
    const second = await post(base, '/api/open', { url: 'https://b.example/' })
    assert.equal(second.status, 409, JSON.stringify(second.body))
    assert.equal(h.track.createdOpts.length, 1, 'the consumed allowance must fail closed, never pop again')
    assert.ok(!h.track.createdOpts.some(o => o.url === 'https://b.example/'))
  } finally { h.server.close() }
})

test('existing-window opens reuse the same window as a normal background tab', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: true })
  const base = await h.listen()
  try {
    const res = await post(base, '/api/open', { url: 'https://example.com/', source: 'cli.open' })
    assert.equal(res.status, 200)
    assert.equal(res.body.windowless, false)
    assert.equal(res.body.takeover, true)
    assert.equal(res.body.windowId, 1)
    assert.equal(res.body.reusedWindow, true)
    assert.equal(res.body.firstDisplay, false)
    assert.deepEqual(h.track.createdOpts[0], { url: 'https://example.com/', background: true })
    assert.equal((h.track.createdOpts[0] as any).newWindow, undefined, 'no newWindow flag may ever be sent')
    assert.deepEqual(h.track.closedTargets, [])
    assert.equal(h.track.hasWindow, true)
    assert.ok(h.stateLog.recent(20).some(e => e.event === 'managed-window' && e.branch === 'adopt'))
  } finally { h.server.close() }
})

test('a background launch with a URL creates the real managed window via the same path', { timeout: 20_000 }, async () => {
  const h = harness({ running: false, hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    const res = await post(base, '/api/launch', { url: 'https://example.com/', source: 'cli.launch' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.windowless, false)
    assert.equal(res.body.firstDisplay, true)
    assert.equal(res.body.settled, true)
    assert.equal(res.body.windowId, 1)
    assert.equal(h.track.launchOpts.url, undefined, 'the URL must not be passed to the manager (no hidden page)')
    assert.deepEqual(h.track.createdOpts[0], { url: 'https://example.com/', background: true })
    const entry = h.stateLog.recent(40).find(e => e.event === 'launch' && e.branch === 'background')
    assert.ok(entry)
    assert.match(String(entry.detail), /firstDisplay=true/)
    assert.match(String(entry.detail), /settled=true/)

    // windowless:false is now the default semantics and must not be refused.
    const explicitReal = await post(base, '/api/launch', { url: 'https://example.com/', windowless: false })
    assert.equal(explicitReal.status, 200, JSON.stringify(explicitReal.body))
    assert.equal(explicitReal.body.windowless, false)
  } finally { h.server.close() }
})

test('capabilities describe the one-time real-window trade-off and the protocol-only fallback', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    const body = await (await fetch(`${base}/api/capabilities`)).json() as any
    assert.equal(body.windowlessOpen, true)
    assert.equal(body.windowless.adoption, 'unsupported')
    assert.equal(body.windowless.browserPilot, 'unsupported')
    assert.equal(body.zeroWindowRealTab.supported, true)
    assert.equal(body.zeroWindowRealTab.firstDisplay, 'once-per-browser-session')
    assert.equal(body.zeroWindowRealTab.sameWindowReuse, true)
    assert.equal(body.zeroWindowRealTab.windowlessFallback, true)
    assert.ok(String(body.zeroWindowRealTab.evidence).length > 0)
  } finally { h.server.close() }
})

test('status and transitions carry one managed session id and window ownership', { timeout: 20_000 }, async () => {
  const h = harness({ hasWindow: false, initialHidden: true })
  const base = await h.listen()
  try {
    await post(base, '/api/open', { url: 'https://www.baidu.com/', source: 'cli.open' })
    const status = await (await fetch(`${base}/api/status`)).json() as any
    assert.equal(status.session.id, SESSION)
    assert.equal(status.session.managedWindowId, 1)
    assert.equal(status.session.firstDisplayUsed, true)
    assert.equal(status.session.windowlessPages, 0)
    assert.equal(status.session.takeover, 'real-window')
    const entries = h.stateLog.recent(50)
    assert.ok(entries.length > 0)
    assert.ok(entries.every(e => e.session === SESSION), JSON.stringify(entries.filter(e => e.session !== SESSION)))
    const openEntry = entries.find(e => e.event === 'open')
    assert.equal(openEntry?.route, 'POST /api/open')
    assert.equal(openEntry?.source, 'cli.open')
  } finally { h.server.close() }
})

test('opening a tab in an existing hidden window re-hides after Chrome unhide', { timeout: 20_000 }, async () => {
  const h = harness({ initial: 'minimized', initialHidden: true })
  const base = await h.listen()
  try {
    // Simulate Chromium's native unhide side effect during createTarget.
    const originalSend = h.manager.current.cdp.send
    h.manager.current.cdp.send = async (method: string, params: any = {}) => {
      const result = await originalSend(method, params)
      if (method === 'Target.createTarget') h.track.hidden = false
      return result
    }
    const response = await post(base, '/api/open', { url: 'https://example.com/' })
    assert.equal(response.status, 200)
    assert.equal(h.track.hidden, true)
    assert.equal(h.track.hideCalls, 1)
    assert.equal(h.track.bounds.windowState, 'minimized')
    assert.ok(h.stateLog.recent(20).some(e => e.event === 'native-hide' && e.branch === 'verified'
      && e.detail === 'hidden-window-post-create'))
  } finally {
    h.server.close()
  }
})

test('restart never inherits launchMode=visible: plain restarts are background, explicit visibility flags required', { timeout: 20_000 }, async () => {
  await withLaunchMode('visible', async () => {
    const h = harness()
    const base = await h.listen()
    try {
      const unknown = await post(base, '/api/restart', { reason: 'probe' })
      assert.equal(unknown.body.ok, true)
      assert.equal(h.track.restarts.length, 1)
      assert.equal(h.track.restarts[0].opts.focus, false, 'unknown restart must be forced background')
      assert.equal(h.track.restarts[0].opts.keepVisible, false)
      const unknownEntry = h.stateLog.recent(20).find(e => e.event === 'restart')
      assert.ok(unknownEntry)
      assert.equal(unknownEntry.origin, 'unknown')
      assert.equal(unknownEntry.branch, 'forced-background')
      assert.equal(typeof unknownEntry.token, 'string', 'restart transitions must be token-correlated')

      // Explicit but plain restart also stays background (CLI contract).
      await post(base, '/api/restart', { reason: 'probe', source: 'cli.restart' })
      assert.equal(h.track.restarts[1].opts.focus, false, 'a plain explicit restart must not honor launchMode')
      assert.equal(h.track.restarts[1].opts.keepVisible, false)
      const plainEntry = h.stateLog.recent(20).find(e => e.event === 'restart' && e.source === 'cli.restart')
      assert.ok(plainEntry)
      assert.equal(plainEntry.origin, 'explicit')
      assert.equal(plainEntry.branch, 'forced-background')
      assert.equal(plainEntry.after, 'background')

      await post(base, '/api/restart', { reason: 'probe', source: 'cli.restart', focus: true })
      assert.equal(h.track.restarts[2].opts.focus, true)
      assert.equal(h.track.restarts[2].opts.keepVisible, false)
      const visibleEntry = h.stateLog.recent(20).find(e => e.event === 'restart' && e.source === 'cli.restart'
        && e.branch === 'visible-request')
      assert.ok(visibleEntry, 'explicit focus request may relaunch visible')
      assert.equal(visibleEntry.after, 'visible')
      const visibleIntent = h.stateLog.recent(20).find(e => e.event === 'control-intent'
        && e.source === 'cli.restart' && e.branch === 'show')
      assert.ok(visibleIntent)
      assert.equal(visibleEntry.token, visibleIntent.token, 'the restart transition must correlate with its control intent')

      await post(base, '/api/restart', { reason: 'probe', source: 'cli.restart', keepVisible: true })
      assert.equal(h.track.restarts[3].opts.focus, false)
      assert.equal(h.track.restarts[3].opts.keepVisible, true)

      await post(base, '/api/restart', { reason: 'probe', focus: true, keepVisible: true })
      assert.equal(h.track.restarts[4].opts.focus, false, 'a non-explicit visibility request is downgraded')
      assert.equal(h.track.restarts[4].opts.keepVisible, false)
      assert.ok(h.stateLog.recent(20).some(e => e.event === 'policy-downgrade' && e.branch === 'foreground'
        && e.detail === 'non-explicit-visible-restart'), 'the downgrade must be logged, never silent')
    } finally {
      h.server.close()
    }
  })
})

test('a hidden plain restart is deferred with zero side effects and honest logs', { timeout: 20_000 }, async () => {
  const h = harness()
  const base = await h.listen()
  try {
    h.track.restartDeferral = 'hidden-restart-unsafe'
    const beforeGen = h.supervisor.controlGen()
    const refused = await post(base, '/api/restart', { reason: 'probe', source: 'cli.restart' })
    assert.equal(refused.status, 409, JSON.stringify(refused))
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.restarted, false)
    assert.equal(refused.body.deferred, true)
    assert.equal(refused.body.reason, 'hidden-restart-unsafe')
    assert.equal(h.track.restarts.length, 0, 'no restart may be attempted while hidden')
    assert.equal(h.supervisor.controlGen(), beforeGen, 'a refused restart must not bump the control generation')
    const entries = h.stateLog.recent(40)
    const deferred = entries.find(e => e.event === 'restart' && e.source === 'cli.restart')
    assert.ok(deferred, `deferred restart provenance missing: ${JSON.stringify(entries)}`)
    assert.equal(deferred.branch, 'deferred')
    assert.equal(deferred.after, 'unchanged')
    assert.ok(String(deferred.detail ?? '').includes('hidden-restart-unsafe'), JSON.stringify(deferred))
    assert.ok(!entries.some(e => e.event === 'restart' && e.branch === 'forced-background'))
    assert.ok(!entries.some(e => e.event === 'control-intent' && e.source === 'cli.restart'), 'no intent may be recorded for a refused restart')

    // Race path: the early check passed, then the manager re-checked and
    // refused. The route must still report honestly (no applied restart).
    h.track.restartDeferral = null
    h.track.restartResult = { restarted: false, deferred: 'hidden-restart-unsafe' }
    const raced = await post(base, '/api/restart', { reason: 'probe', source: 'cli.restart' })
    assert.equal(raced.status, 409, JSON.stringify(raced))
    assert.equal(raced.body.deferred, true)
    assert.equal(h.track.restarts.length, 1, 'the race path may call the manager once')
    const racedEntries = h.stateLog.recent(40).filter(e => e.event === 'restart' && e.source === 'cli.restart')
    const racedEntry = racedEntries.at(-1)
    assert.ok(racedEntry && racedEntry.branch === 'deferred' && typeof racedEntry.token === 'string',
      `race deferral must log with the intent token: ${JSON.stringify(racedEntry)}`)
    assert.ok(!h.stateLog.recent(40).some(e => e.event === 'restart' && e.branch === 'forced-background'))
  } finally {
    h.server.close()
  }
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
