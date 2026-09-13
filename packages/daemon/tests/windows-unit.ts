import assert from 'node:assert/strict'
import test from 'node:test'
import { FramePumpSupervisor } from '../src/windows.ts'
import type { Cdp } from '../src/cdp.ts'

test('show recovers a cornered startup window even when collapse mode is minimize', async () => {
  let bounds = { left: -1438, top: 945, width: 1440, height: 900, windowState: 'normal' }
  const cdp = {
    attach: async () => 'session',
    send: async (method: string, params: any) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') return { bounds: { ...bounds } }
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
      if (method === 'Browser.setWindowBounds') { bounds = { ...bounds, ...params.bounds }; return {} }
      throw new Error(method)
    },
  } as unknown as Cdp
  const supervisor = new FramePumpSupervisor(() => ({ cdp }), () => [])
  await supervisor.cornerWindow(cdp, 1)
  await supervisor.restoreAll()
  assert.ok(bounds.left >= 0 && bounds.top < 900, `window remains offscreen: ${JSON.stringify(bounds)}`)
  assert.equal(bounds.windowState, 'normal')
})
