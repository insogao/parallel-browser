import assert from 'node:assert/strict'
import test from 'node:test'
import { FramePumpSupervisor } from '../src/windows.ts'
import type { Cdp } from '../src/cdp.ts'

test('hidden app needs the settle cycle repeated before minimize really applies', async () => {
  // Real macOS/Chrome behavior (measured, see docs/development/2026-09-13.md):
  // a hidden app reports the window state as minimized while the AppKit
  // miniaturize never happens; the page stays document.hidden === false until a
  // second normal -> minimized cycle is issued.
  let reported: any = { left: 0, top: 34, width: 1470, height: 840, windowState: 'maximized' }
  let real = 'maximized'
  let normalSinceMinimize = false
  let minimizeCycles = 0
  const cdp = {
    attach: async () => 'session',
    send: async (method: string, params: any) => {
      if (method === 'Browser.getWindowBounds') return { bounds: { ...reported } }
      if (method === 'Browser.setWindowBounds') {
        const state = params.bounds.windowState
        if (state === 'normal') { reported = { ...reported, windowState: 'normal' }; normalSinceMinimize = true }
        else if (state === 'minimized') {
          if (normalSinceMinimize) minimizeCycles++
          normalSinceMinimize = false
          reported = { ...reported, windowState: 'minimized' }
          if (minimizeCycles >= 2) real = 'minimized'
        }
        return {}
      }
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
      throw new Error(method)
    },
  } as unknown as Cdp
  const supervisor = new FramePumpSupervisor(() => ({ cdp }), () => [])
  assert.equal(await supervisor.minimizeWindow(cdp, 1, true), true)
  assert.equal(minimizeCycles, 2, 'hidden app must repeat the normal -> minimized cycle')
  assert.equal(real, 'minimized', 'window must really minimize, not only report it')
})

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
