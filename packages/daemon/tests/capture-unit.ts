import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { CaptureKeepAlive } from '../src/capture.ts'
import type { Cdp } from '../src/cdp.ts'
import type { TargetHealth } from '../src/inject.ts'

const CAPTURE_PAGE_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/capture.html'

function fixture(t: any, options: {
  /** value returned by window.startCaptureByTitle */
  startResult?: string
  /** value returned by window.captureLive() */
  live?: boolean
  health?: TargetHealth[]
  legacyCaptureTargets?: string[]
  onTransition?: (entry: any) => void
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const page = { document: { title: 'Original' }, window: {} as any }
  const calls: { method: string; params: any; session?: string }[] = []
  let hook: (method: string, params: any, session?: string) => any = () => undefined
  let capturePageExists = false
  const legacyCaptureTargets = new Set(options.legacyCaptureTargets ?? [])
  let startResult = options.startResult ?? 'ok'
  let live = options.live ?? true
  let health: TargetHealth[] = options.health
    ?? [{ targetId: 'page', title: 'Original', url: 'https://example.com', visibility: 'hidden' } as TargetHealth]
  const fake = {
    closed: false,
    attach: async (id: string) => `session-${id}`,
    send: async (method: string, params: any = {}, session?: string) => {
      calls.push({ method, params, session })
      const intercepted = hook(method, params, session)
      if (intercepted !== undefined) return intercepted
      if (method === 'Target.getTargets') {
        return {
          // Chrome reports hidden targets as type 'other' (CfT 153): the daemon
          // must still recognize its own capture page for liveness/reuse.
          targetInfos: [
            ...(capturePageExists ? [{ targetId: 'capture-page', type: 'other', url: CAPTURE_PAGE_URL }] : []),
            ...[...legacyCaptureTargets].map(targetId => ({ targetId, type: 'page', url: CAPTURE_PAGE_URL })),
          ],
        }
      }
      if (method === 'Target.createTarget') {
        capturePageExists = true
        return { targetId: 'capture-page' }
      }
      if (method === 'Target.closeTarget') {
        capturePageExists = false
        legacyCaptureTargets.delete(params.targetId)
        return {}
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression)
        if (session === 'session-page') return { result: { value: vm.runInNewContext(expression, page) } }
        if (expression.includes('typeof window.startCaptureByTitle')) return { result: { value: true } }
        if (expression.includes('captureLive')) return { result: { value: live } }
        if (expression.includes('stopCapture')) return { result: { value: 'stopped' } }
        if (expression.includes('startCaptureByTitle(')) return { result: { value: startResult } }
        return { result: { value: true } }
      }
      return {}
    },
  }
  let cdp = fake as unknown as Cdp
  const capture = new CaptureKeepAlive(
    () => ({ cdp, capturePageUrl: CAPTURE_PAGE_URL, pid: 4242 }),
    () => health,
    { onTransition: entry => { options.onTransition?.(entry) } },
  )
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
  const windowOps = () => calls.filter(c =>
    c.method.startsWith('Browser.') || c.method === 'Input.dispatchMouseEvent' || c.method === 'Target.activateTarget')
  // hidden-streak qualification: the first tick samples, the second arms
  const arm = async () => { await capture.tick(); await settle(capture.tick()) }
  return {
    capture, calls, page, settle, arm, windowOps,
    setHook: (h: typeof hook) => { hook = h },
    setStartResult: (v: string) => { startResult = v },
    setHealth: (h: TargetHealth[]) => { health = h },
    setCapturePageExists: (v: boolean) => { capturePageExists = v },
    restart: () => { cdp = { ...fake } as unknown as Cdp },
    advance: (ms: number) => { t.mock.timers.tick(ms) },
  }
}

test('capture engages through a hidden extension page with zero window/app operations', async t => {
  const transitions: any[] = []
  const f = fixture(t, { onTransition: entry => transitions.push(entry) })
  await f.arm()
  assert.equal(f.capture.activeTargetId(), 'page')
  // the capture page is created as a background target, never activated
  const created = f.calls.find(c => c.method === 'Target.createTarget')
  assert.ok(created, 'capture page must be created')
  assert.equal(created.params.background, true, 'capture page must be a background target')
  // U3: background alone still inserts a tab into the strip; when the active
  // user tab closes, Chromium activates the next strip tab (measured: the
  // capture page). hidden:true keeps it out of the tab UI entirely.
  assert.equal(created.params.hidden, true, 'capture page must be a hidden target (never in the tab strip)')
  assert.equal(created.params.url, CAPTURE_PAGE_URL)
  // the manual-bg blocker: no native visibility operation may happen at all
  assert.deepEqual(f.windowOps(), [], 'capture setup must not touch windows, app visibility or tab activation')
  assert.equal(f.page.document.title, 'Original', 'magic title is restored after arming')
  const events = transitions.map(e => `${e.event}:${e.branch ?? ''}`)
  assert.ok(events.includes('capture-engage:picked'))
  assert.ok(events.includes('capture-page:created'))
  assert.ok(events.includes('capture-started:extension-tab-capture-hidden'))
  assert.ok(!events.some(e => e.startsWith('capture-window')), 'no window-mutation provenance may be recorded')
  assert.ok(!events.some(e => e.startsWith('capture-cleanup')), 'nothing needs window cleanup anymore')
  assert.ok(!JSON.stringify(transitions).includes('http'), 'transition log must not contain URLs')
  assert.ok(!JSON.stringify(transitions).includes('chrome-extension'), 'transition log must not contain extension URLs')
  assert.ok(!JSON.stringify(transitions).includes('Original'), 'transition log must not contain page titles')
})

test('capture start failure restores the title, stops any stream and records a bounded failure', async t => {
  const transitions: any[] = []
  const f = fixture(t, { startResult: 'err', onTransition: entry => transitions.push(entry) })
  await f.arm()
  assert.equal(f.capture.activeTargetId(), null, 'failure must not be counted as an active capture')
  assert.equal(f.page.document.title, 'Original', 'no title residue')
  assert.deepEqual(f.windowOps(), [], 'a failure must not fall back to window mutation')
  assert.ok(f.calls.some(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('stopCapture')),
    'a failed start must stop any partially created stream')
  const events = transitions.map(e => `${e.event}:${e.branch ?? ''}`)
  assert.ok(events.includes('capture-failed:setup-error'))
  assert.ok(!events.includes('capture-started:extension-tab-capture'))
})

test('three failed setups disable keep-alive instead of retrying forever', async t => {
  const transitions: any[] = []
  const f = fixture(t, { startResult: 'err', onTransition: entry => transitions.push(entry) })
  await f.capture.tick() // hidden-streak sample
  for (let i = 0; i < 4; i++) {
    await f.settle(f.capture.tick())
    // step past the 15s failure cooldown so the next tick actually retries
    f.advance(16_000)
  }
  const failures = transitions.filter(e => e.event === 'capture-failed')
  assert.equal(failures.length, 3, 'the third failure disables further attempts')
  assert.equal(f.capture.activeTargetId(), null)
})

test('takeover during setup aborts without counting a failure and restores the title', async t => {
  const transitions: any[] = []
  const f = fixture(t, { onTransition: entry => transitions.push(entry) })
  let paused: Promise<void> | undefined
  f.setHook(method => {
    if (method === 'Runtime.evaluate' && !paused) paused = f.capture.setPaused(true)
  })
  await f.arm()
  assert.ok(paused)
  assert.equal(f.capture.activeTargetId(), null, 'takeover wins over the in-flight setup')
  assert.equal(f.page.document.title, 'Original')
  await f.settle(paused)
  assert.deepEqual(f.windowOps(), [])
  assert.ok(!transitions.some(e => e.event === 'capture-failed'), 'a takeover race is not a capture failure')
})

test('a vanished capture target releases the stream without window repair', async t => {
  const transitions: any[] = []
  const f = fixture(t, { onTransition: entry => transitions.push(entry) })
  await f.arm()
  assert.equal(f.capture.activeTargetId(), 'page')
  f.setHealth([])
  await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), null)
  assert.ok(f.calls.some(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('stopCapture')),
    'release must stop the stream')
  assert.ok(transitions.some(e => e.event === 'capture-release' && e.branch === 'target gone'))
  assert.deepEqual(f.windowOps(), [], 'release must not perform window repair')
})

test('new CDP connection resets state and re-arms on the new connection', async t => {
  const f = fixture(t)
  await f.arm()
  assert.equal(f.capture.activeTargetId(), 'page')
  const startsBefore = f.calls.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('startCaptureByTitle(')).length
  f.restart()
  await f.arm()
  assert.equal(f.capture.activeTargetId(), 'page', 'capture re-arms after a browser reconnect')
  const startsAfter = f.calls.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('startCaptureByTitle(')).length
  assert.equal(startsAfter, startsBefore + 1, 'the new connection must arm its own capture')
  assert.deepEqual(f.windowOps(), [])
})

test('extension pages and the magic title are never capture candidates', async t => {
  const f = fixture(t, {
    health: [
      { targetId: 'ext', title: 'bl-capture', url: CAPTURE_PAGE_URL, visibility: 'hidden' } as TargetHealth,
      { targetId: 'magic', title: 'BACKLIGHT_AGENT', url: 'https://example.com/magic', visibility: 'hidden' } as TargetHealth,
      { targetId: 'blank', title: '', url: 'about:blank', visibility: 'hidden' } as TargetHealth,
    ],
  })
  await f.arm()
  assert.equal(f.capture.activeTargetId(), null, 'no internal page may burn the single capture')
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 0)
})

test('the hidden extension page owns the capture call', async t => {
  const f = fixture(t)
  await f.arm()
  const startEvaluations = f.calls.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('startCaptureByTitle('))
  assert.equal(startEvaluations.length, 1)
  assert.equal(startEvaluations[0]?.session, 'session-capture-page', 'the hidden extension page owns the capture call')
})

test('prearm arms a visible target with zero window/app operations', async t => {
  const transitions: any[] = []
  const f = fixture(t, {
    health: [{ targetId: 'page', title: 'Original', url: 'https://example.com', visibility: 'visible' } as TargetHealth],
    onTransition: entry => transitions.push(entry),
  })
  await f.settle(f.capture.prearm())
  assert.equal(f.capture.activeTargetId(), 'page')
  assert.deepEqual(f.windowOps(), [])
  const events = transitions.map(e => `${e.event}:${e.branch ?? ''}`)
  assert.ok(events.includes('capture-engage:pre-arm'))
  assert.ok(events.includes('capture-started:extension-tab-capture-visible'))
})

test('prearm keeps an already visible-armed capture without re-arming', async t => {
  const f = fixture(t, {
    health: [{ targetId: 'page', title: 'Original', url: 'https://example.com', visibility: 'visible' } as TargetHealth],
  })
  await f.settle(f.capture.prearm())
  await f.settle(f.capture.prearm())
  const starts = f.calls.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('startCaptureByTitle('))
  assert.equal(starts.length, 1)
  assert.deepEqual(f.windowOps(), [])
})

test('prearm rotates a hidden-armed capture once the window is visible again', async t => {
  const transitions: any[] = []
  const f = fixture(t, { onTransition: entry => transitions.push(entry) })
  await f.arm() // hidden-armed (rAF only)
  assert.equal(f.capture.activeTargetId(), 'page')
  f.setHealth([{ targetId: 'page', title: 'Original', url: 'https://example.com', visibility: 'visible' } as TargetHealth])
  await f.settle(f.capture.prearm())
  assert.equal(f.capture.activeTargetId(), 'page')
  const starts = f.calls.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('startCaptureByTitle('))
  assert.equal(starts.length, 2, 'a hidden-armed capture must be rotated to a visible-armed one')
  assert.ok(transitions.some(e => e.event === 'capture-release' && e.branch === 'pre-arm rotate'))
  assert.ok(transitions.some(e => e.event === 'capture-started' && e.branch === 'extension-tab-capture-visible'))
  assert.deepEqual(f.windowOps(), [])
})

test('prearm is a no-op while no capturable target is visible', async t => {
  const f = fixture(t) // hidden target
  await f.settle(f.capture.prearm())
  assert.equal(f.capture.activeTargetId(), null)
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 0)
})

test('a dead capture page is detected and re-created for the still-hidden target', async t => {
  const transitions: any[] = []
  const f = fixture(t, { onTransition: entry => transitions.push(entry) })
  await f.arm()
  assert.equal(f.capture.activeTargetId(), 'page')
  const createdBefore = f.calls.filter(c => c.method === 'Target.createTarget').length
  f.setCapturePageExists(false) // the hidden extension page died out-of-band
  await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), null, 'a dead capture page must release the stale capture')
  assert.ok(transitions.some(e => e.event === 'capture-release' && e.branch === 'capture page gone'))
  await f.settle(f.capture.tick())
  assert.equal(f.capture.activeTargetId(), 'page', 'the still-hidden target is re-armed')
  const createdAfter = f.calls.filter(c => c.method === 'Target.createTarget').length
  assert.equal(createdAfter, createdBefore + 1, 'a fresh capture page is created')
  assert.deepEqual(f.windowOps(), [], 're-creation must not touch windows or tab activation')
})

test('a browser that rejects hidden targets fails closed instead of creating a visible tab', async t => {
  const transitions: any[] = []
  const f = fixture(t, { onTransition: entry => transitions.push(entry) })
  f.setHook((method, params) => {
    if (method === 'Target.createTarget') {
      assert.equal(params.hidden, true)
      throw new Error('cdp Invalid parameters: hidden')
    }
    return undefined
  })
  await f.arm()
  assert.equal(f.capture.activeTargetId(), null, 'no capture may be reported when the hidden page cannot be created')
  const creates = f.calls.filter(c => c.method === 'Target.createTarget')
  assert.ok(creates.length >= 1, 'the hidden create must have been attempted')
  assert.ok(creates.every(c => c.params.hidden === true), 'no visible fallback tab may ever be created')
  assert.ok(transitions.some(e => e.event === 'capture-failed'))
  assert.deepEqual(f.windowOps(), [])
})

test('migration closes every old capture tab before creating the hidden page', async t => {
  const f = fixture(t, { legacyCaptureTargets: ['legacy-1', 'legacy-2'] })
  await f.arm()
  const closed = f.calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId)
  assert.deepEqual(closed, ['legacy-1', 'legacy-2'])
  const created = f.calls.find(c => c.method === 'Target.createTarget')
  assert.equal(created?.params.hidden, true)
  assert.equal(f.capture.activeTargetId(), 'page')
})
