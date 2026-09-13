import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { RAF_SHIM_JS } from '../src/inject.ts'

test('multiple rAF consumers share one native frame and cancellation still works', () => {
  let next = 0
  const frames = new Map<number, Function>()
  const context: any = {
    document: { hidden: false, addEventListener() {} },
    performance: { now: () => 16 },
    setTimeout, clearTimeout,
    requestAnimationFrame: (cb: Function) => { frames.set(++next, cb); return next },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }
  context.window = context
  vm.runInNewContext(RAF_SHIM_JS, context)
  let calls = 0
  const loop = () => { calls++; context.requestAnimationFrame(loop) }
  context.requestAnimationFrame(loop)
  context.requestAnimationFrame(loop)
  assert.equal(frames.size, 1, 'two consumers must not create two pumps')
  for (const [id, cb] of [...frames]) { frames.delete(id); cb(16) }
  assert.equal(calls, 2, 'each consumer runs only once per frame')
  assert.equal(frames.size, 1)
  let cancelled = false
  let cancelId: number
  context.requestAnimationFrame(() => context.cancelAnimationFrame(cancelId))
  cancelId = context.requestAnimationFrame(() => { cancelled = true })
  for (const [id, cb] of [...frames]) { frames.delete(id); cb(32) }
  assert.equal(cancelled, false, 'callbacks cancelled during the same frame must not run')
})
