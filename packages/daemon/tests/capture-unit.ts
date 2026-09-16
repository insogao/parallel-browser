import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { CaptureKeepAlive, CAPTURE_TITLE } from '../src/capture.ts'
import type { Cdp } from '../src/cdp.ts'
import type { TargetHealth } from '../src/inject.ts'

function fixture(t: any, options: {
  appHidden?: boolean
  onHide?: () => Promise<void> | void
  onUnhide?: () => void
  /** apply setWindowBounds only on a later getWindowBounds probe (macOS async) */
  deferredBounds?: boolean
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const page = { document: { title: 'Original' }, window: {} as any }
  const calls: { method: string; params: any; session?: string }[] = []
  let bounds = { windowState: 'minimized', left: 50, top: 60, width: 1200 }
  let pendingBounds: { bounds: any; stale: number } | null = null
  let hook: (method: string, params: any) => any = () => undefined
  let controllerVisibility: 'visible' | 'hidden' = 'visible'
  const fake = {
    closed: false,
    attach: async (id: string) => `session-${id}`,
    send: async (method: string, params: any = {}, session?: string) => {
      calls.push({ method, params, session })
      const intercepted = hook(method, params)
      if (intercepted !== undefined) return intercepted
      if (method === 'Target.createTarget') return { targetId: 'controller' }
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'controller', type: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') {
        if (pendingBounds) {
          if (pendingBounds.stale > 0) { pendingBounds.stale--; return { bounds: { ...bounds } } }
          Object.assign(bounds, pendingBounds.bounds)
          pendingBounds = null
        }
        return { bounds: { ...bounds } }
      }
      if (method === 'Browser.setWindowBounds') {
        if (options.deferredBounds) {
          pendingBounds = { bounds: { ...params.bounds }, stale: 1 }
          return {}
        }
        Object.assign(bounds, params.bounds)
        return {}
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('screen.avail')) return { result: { value: '{"al":0,"at":25,"ah":900}' } }
        if (params.expression === 'document.visibilityState' && session === 'session-controller') {
          return { result: { value: controllerVisibility } }
        }
        if (session === 'session-page') return { result: { value: vm.runInNewContext(params.expression, page) } }
        return { result: { value: params.expression.includes('startCapture') ? 'ok' : true } }
      }
      return {}
    },
  }
  let cdp = fake as unknown as Cdp
  const capture = new CaptureKeepAlive(() => ({ cdp, controllerUrl: 'http://localhost/controller', pid: 4242 }),
    () => [{ targetId: 'page', title: 'Original', url: 'https://example.com', visibility: 'hidden' } as TargetHealth],
    {
      appHidden: async () => options.appHidden ?? false,
      hideApp: async () => { await options.onHide?.() },
      unhideApp: async () => { options.onUnhide?.() },
    })
  async function settle(promise: Promise<unknown>, limit = 30000) {
    let done = false
    promise.finally(() => { done = true })
    for (let ms = 0; ms < limit && !done; ms += 50) {
      await Promise.resolve(); await Promise.resolve()
      t.mock.timers.tick(50)
    }
    assert.ok(done, 'operation must finish within bounded time')
    await promise
  }
  return {
    capture, calls, page, bounds, settle,
    setHook: (h: typeof hook) => { hook = h },
    setControllerVisibility: (v: 'visible' | 'hidden') => { controllerVisibility = v },
    restart: () => { cdp = { ...fake } as unknown as Cdp },
  }
}

test('hidden DOM can have a successful capture; title restored and visibility remains honest', async t => {
  const f = fixture(t)
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), 'page')
  assert.equal(f.page.document.title, 'Original')
  assert.equal(Object.hasOwn(f.page.document, 'visibilityState'), false)
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
})

for (const stage of ['Browser.getWindowForTarget', 'Target.activateTarget', 'Input.dispatchMouseEvent']) {
  test(`takeover at ${stage} cleans title and preserves user window`, async t => {
    const f = fixture(t)
    let paused: Promise<void> | undefined
    f.setHook(method => {
      if (method === stage && !paused) {
        paused = f.capture.setPaused(true)
        Object.assign(f.bounds, { windowState: 'normal', left: 200, top: 250 })
      }
    })
    await f.capture.tick(); await f.settle(f.capture.tick())
    if (paused) await f.settle(paused)
    assert.ok(paused)
    assert.equal(f.page.document.title, 'Original')
    assert.equal(f.bounds.windowState, 'normal')
    assert.equal(f.bounds.left, 200)
    assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, stage === 'Input.dispatchMouseEvent' ? 1 : 0)
  })
}

test('takeover after controller activation returns the human to the captured page', async t => {
  const f = fixture(t)
  let paused: Promise<void> | undefined
  f.setHook(method => {
    if (method === 'Input.dispatchMouseEvent' && !paused) {
      paused = f.capture.setPaused(true)
      Object.assign(f.bounds, { windowState: 'normal', left: 200, top: 250 })
    }
  })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.ok(paused)
  await f.settle(paused)
  assert.equal(f.bounds.windowState, 'normal', 'takeover window is not re-minimized')
  assert.equal(f.bounds.left, 200, 'takeover window is not moved')
  assert.equal(f.page.document.title, 'Original')
  const activations = f.calls.filter(c => c.method === 'Target.activateTarget')
  assert.equal(activations.at(-1)?.params.targetId, 'page', 'captured page is active again after takeover')
})

test('takeover keeps the tab the human chose during the race', async t => {
  const f = fixture(t)
  f.setControllerVisibility('hidden')
  let paused: Promise<void> | undefined
  f.setHook(method => {
    if (method === 'Input.dispatchMouseEvent' && !paused) paused = f.capture.setPaused(true)
  })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.ok(paused)
  await f.settle(paused)
  const activations = f.calls.filter(c => c.method === 'Target.activateTarget')
  assert.equal(activations.length, 1, 'no activation once the human picked another tab')
})

test('takeover completing after capture started still returns the page', async t => {
  const f = fixture(t)
  let paused: Promise<void> | undefined
  f.setHook((method, params) => {
    if (method === 'Runtime.evaluate' && params.expression.includes('__blOrigTitle !== undefined') && !paused) {
      paused = f.capture.setPaused(true)
    }
  })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.ok(paused)
  await f.settle(paused)
  assert.equal(f.page.document.title, 'Original')
  const activations = f.calls.filter(c => c.method === 'Target.activateTarget')
  assert.equal(activations.at(-1)?.params.targetId, 'page', 'captured page is active again after takeover')
})

test('setup error restores title and minimized window position', async t => {
  const f = fixture(t)
  f.setHook(method => method === 'Input.dispatchMouseEvent' ? Promise.reject(new Error('input failed')) : undefined)
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.equal(f.page.document.title, 'Original')
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
})

test('capture setup parks as a separate call, restores position before minimizing, re-hides a background app', async t => {
  let hides = 0
  const f = fixture(t, { appHidden: true, onHide: () => { hides++ } })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), 'page')
  const setBounds = f.calls.filter(c => c.method === 'Browser.setWindowBounds').map(c => c.params.bounds)
  // macOS drops a position sent together with the minimized -> normal transition,
  // so the park must be two calls: normal first, then the offscreen position.
  assert.deepEqual(setBounds[0], { windowState: 'normal' })
  assert.equal(setBounds[1].left, -1198)
  // Cleanup must restore the position while normal, then minimize last: a
  // position set on a minimized window would un-minimize it (measured macOS/CfT 153).
  assert.equal(setBounds.at(-2)?.left, 50)
  assert.equal(setBounds.at(-2)?.top, 60)
  assert.deepEqual(setBounds.at(-1), { windowState: 'minimized' })
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
  assert.equal(hides, 1, 'a background app must be hidden again after capture setup')
})

test('takeover during capture setup keeps the window and never re-hides the app', async t => {
  let hides = 0
  const f = fixture(t, { appHidden: true, onHide: () => { hides++ } })
  let paused: Promise<void> | undefined
  f.setHook(method => {
    if (method === 'Target.activateTarget' && !paused) paused = f.capture.setPaused(true)
  })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.ok(paused)
  await f.settle(paused)
  assert.equal(hides, 0, 'takeover must never hide the app')
  assert.equal(f.bounds.windowState, 'normal', 'takeover window stays visible')
  assert.equal(f.bounds.left, 50, 'parked window is returned to its original position')
})

test('async normal transition and delayed position still restore position then minimize', async t => {
  // macOS applies minimized -> normal asynchronously and a position sent in
  // the same call is dropped. The fake reports the old state for one probe
  // after every setWindowBounds, so only bounded re-probing can succeed.
  let hides = 0
  const f = fixture(t, { appHidden: true, deferredBounds: true, onHide: () => { hides++ } })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), 'page')
  const setBounds = f.calls.filter(c => c.method === 'Browser.setWindowBounds').map(c => c.params.bounds)
  assert.deepEqual(setBounds[0], { windowState: 'normal' })
  assert.equal(setBounds[1].left, -1198, 'park position only after normal applied')
  assert.equal(setBounds.at(-2)?.left, 50, 'cleanup restores the original position while normal')
  assert.equal(setBounds.at(-2)?.top, 60)
  assert.deepEqual(setBounds.at(-1), { windowState: 'minimized' })
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
  assert.equal(hides, 1, 'a background app must be hidden exactly once after setup')
})

test('takeover during a delayed hide ends with the app visible (hide undone)', async t => {
  const events: string[] = []
  let captureRef: CaptureKeepAlive
  let paused: Promise<void> | undefined
  let releaseHide: () => void = () => {}
  const hideGate = new Promise<void>(resolve => { releaseHide = resolve })
  const f = fixture(t, {
    appHidden: true,
    onHide: async () => {
      events.push('hide')
      // takeover starts while the hide is still in flight
      paused = captureRef.setPaused(true)
      await Promise.resolve()
      releaseHide()
      await hideGate
    },
    onUnhide: () => { events.push('unhide') },
  })
  captureRef = f.capture
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.ok(paused, 'takeover must have started during the hide')
  await f.settle(paused)
  assert.deepEqual(events, ['hide', 'unhide'], 'a hide raced by takeover must be undone')
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
})

test('probe failures after normal fail setup but cleanup still restores the window', async t => {
  // The bug this guards: the first getWindowBounds after sending normal
  // rejects; the wait used to return null immediately and engage returned
  // with parked unset, leaving the window normal/foreground forever.
  let hides = 0
  let failProbes = false
  const f = fixture(t, { appHidden: true, onHide: () => { hides++ } })
  f.setHook((method, params) => {
    if (method === 'Browser.setWindowBounds' && params.bounds.windowState === 'normal') failProbes = true
    if (method === 'Browser.getWindowBounds' && failProbes) return Promise.reject(new Error('cdp probe timeout'))
    return undefined
  })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), null, 'setup must not be counted as successful')
  const setBounds = f.calls.filter(c => c.method === 'Browser.setWindowBounds').map(c => c.params.bounds)
  assert.equal(setBounds.at(-2)?.left, 50, 'cleanup still sends the original position')
  assert.equal(setBounds.at(-2)?.top, 60)
  assert.deepEqual(setBounds.at(-1), { windowState: 'minimized' }, 'cleanup still sends minimize last')
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
  assert.equal(hides, 1, 'a hidden background app must be re-hidden exactly once')
  assert.equal(f.page.document.title, 'Original', 'no title residue')
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 0, 'no controller interaction')
  assert.equal(
    f.calls.filter(c => c.method === 'Runtime.evaluate' && String((c.params as any).expression).includes('startCapture')).length,
    0, 'capture must not start')
})

test('a single transient probe failure after normal is retried and setup still succeeds', async t => {
  let hides = 0
  let probes = 0
  const f = fixture(t, { appHidden: true, onHide: () => { hides++ } })
  f.setHook(method => {
    if (method !== 'Browser.getWindowBounds') return undefined
    probes++
    if (probes === 2) return Promise.reject(new Error('transient cdp timeout'))
    return undefined
  })
  await f.capture.tick(); await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), 'page', 'a single failed probe must not abort setup')
  assert.equal(hides, 1)
  assert.equal(f.bounds.windowState, 'minimized')
  assert.equal(f.bounds.left, 50)
  assert.equal(f.page.document.title, 'Original')
})

test('hanging Runtime promise cannot block takeover or later disrupt it', async t => {
  const f = fixture(t)
  let paused: Promise<void> | undefined
  f.setHook((method, params) => {
    if (method === 'Runtime.evaluate' && params.awaitPromise) {
      paused = f.capture.setPaused(true)
      Object.assign(f.bounds, { windowState: 'normal', left: 200 })
      return new Promise(() => {})
    }
  })
  await f.capture.tick(); const tick = f.capture.tick()
  await f.settle(tick)
  assert.ok(paused); await f.settle(paused)
  assert.equal(f.bounds.windowState, 'normal')
  assert.equal(f.page.document.title, 'Original')
})

test('new CDP resets active capture and controller sessions', async t => {
  const f = fixture(t)
  await f.capture.tick(); await f.settle(f.capture.tick())
  f.restart()
  await f.settle(f.capture.tick()); await f.settle(f.capture.tick())
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 2)
})
