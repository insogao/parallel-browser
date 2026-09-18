import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearManagedWindow, firstDisplayUsed, managedWindow, markFirstDisplayUsed,
  targetWindowId, trackManagedWindow, windowStillOpen,
} from '../src/managed-window.ts'
import type { Cdp } from '../src/cdp.ts'

function fakeCdp(handler: (method: string, params: any) => any): Cdp {
  return { send: async (method: string, params: any = {}) => handler(method, params) } as unknown as Cdp
}

test('managed window ownership is per browser connection and explicit', () => {
  const a = fakeCdp(() => ({}))
  const b = fakeCdp(() => ({}))
  assert.equal(managedWindow(a), null)
  trackManagedWindow(a, { windowId: 1, firstTargetId: 't1', createdAt: 10, source: 'background-first-display' })
  assert.equal(managedWindow(a)?.windowId, 1)
  assert.equal(managedWindow(b), null, 'another connection must not inherit the window')
  clearManagedWindow(a)
  assert.equal(managedWindow(a), null)
})

test('the one-time first display is spent per connection and never refunded', () => {
  const a = fakeCdp(() => ({}))
  const b = fakeCdp(() => ({}))
  assert.equal(firstDisplayUsed(a), false)
  markFirstDisplayUsed(a)
  assert.equal(firstDisplayUsed(a), true)
  assert.equal(firstDisplayUsed(b), false)
  // a lost window does not reset the allowance (no repeated popups)
  clearManagedWindow(a)
  assert.equal(firstDisplayUsed(a), true)
})

test('windowStillOpen is true only while CDP can read the window', async () => {
  let alive = true
  const cdp = fakeCdp(() => { if (!alive) throw new Error('Browser window not found'); return { bounds: {} } })
  assert.equal(await windowStillOpen(cdp, 1), true)
  alive = false
  assert.equal(await windowStillOpen(cdp, 1), false)
})

test('targetWindowId retries transient failures and gives up honestly', async () => {
  let calls = 0
  const flaky = fakeCdp(() => { calls++; if (calls < 3) throw new Error('not ready'); return { windowId: 7 } })
  assert.equal(await targetWindowId(flaky, 't1', 5, 1), 7)
  assert.equal(calls, 3)

  const missing = fakeCdp(() => ({}))
  assert.equal(await targetWindowId(missing, 't1', 3, 1), null)
  const refused = fakeCdp(() => { throw new Error('No window for target') })
  assert.equal(await targetWindowId(refused, 't1', 2, 1), null)
})
