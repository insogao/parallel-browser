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

test('hidden app repairs a falsely reported minimized state', async () => {
  // The exact same phantom report: CDP says minimized while AppKit is normal.
  // A repeated /api/bg must still run the normal -> minimized recovery cycle.
  let reported: any = { left: 0, top: 34, width: 1470, height: 840, windowState: 'minimized' }
  let real = 'normal'
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
  assert.equal(minimizeCycles, 2, 'false minimized report must still run the recovery cycles')
  assert.equal(real, 'minimized', 'window must really minimize, not only report it')
})

test('restore during collapse supersedes the in-flight minimize', async () => {
  let bounds: any = { left: 60, top: 60, width: 1200, height: 800, windowState: 'maximized' }
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let held = false
  let minimizes = 0
  const cdp = {
    attach: async () => 'session',
    send: async (method: string, params: any) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') return { bounds: { ...bounds } }
      if (method === 'Browser.setWindowBounds') {
        const state = params.bounds.windowState
        if (state === 'normal' && !held) {
          held = true
          bounds = { ...bounds, windowState: 'normal' }
          await gate
        } else {
          if (state === 'minimized') minimizes++
          bounds = { ...bounds, ...params.bounds }
        }
        return {}
      }
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
      throw new Error(method)
    },
  } as unknown as Cdp
  const supervisor = new FramePumpSupervisor(() => ({ cdp }), () => [])
  const collapse = supervisor.collapseAll(true)
  while (!held) await new Promise(r => setTimeout(r, 5))
  await supervisor.restoreAll()
  release()
  assert.equal(await collapse, 0, 'superseded collapse reports no minimized window')
  assert.equal(minimizes, 0, 'no minimize may be issued after restore superseded bg')
  assert.equal(bounds.windowState, 'normal', 'window stays visible for the newer intent')
})

test('show --maximize waits for normal before maximizing a minimized window', async () => {
  // Measured on macOS/CfT 153: after a minimized window is set to normal, the
  // transition applies asynchronously; a maximize sent immediately after is
  // rejected with "To maximize a minimized or fullscreen window, restore it to
  // normal state first." The restore path must wait for normal.
  let bounds: any = { left: 60, top: 60, width: 1200, height: 800, windowState: 'minimized' }
  let normalRequested = false
  const cdp = {
    attach: async () => 'session',
    send: async (method: string, params: any) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') {
        // the normal transition only lands when observed from a later probe
        if (normalRequested && bounds.windowState === 'minimized') bounds = { ...bounds, windowState: 'normal' }
        return { bounds: { ...bounds } }
      }
      if (method === 'Browser.setWindowBounds') {
        const state = params.bounds.windowState
        if (state === 'normal') { normalRequested = true; return {} }
        if (state === 'maximized') {
          if (bounds.windowState !== 'normal') {
            throw new Error('To maximize a minimized or fullscreen window, restore it to normal state first.')
          }
          bounds = { ...bounds, windowState: 'maximized' }
          return {}
        }
        return {}
      }
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
      throw new Error(method)
    },
  } as unknown as Cdp
  const supervisor = new FramePumpSupervisor(() => ({ cdp }), () => [])
  const restored = await supervisor.restoreAll(true)
  assert.equal(restored, 1, 'minimized window must be restored and counted')
  assert.equal(bounds.windowState, 'maximized', 'window must reach maximized, not stop at normal')
})

test('an unverified maximize is not counted as a successful restore', async () => {
  // CDP can swallow the maximize (macOS keeps the window normal). The bounded
  // wait must report failure instead of silently counting the window restored.
  let bounds: any = { left: 60, top: 60, width: 1200, height: 800, windowState: 'minimized' }
  const cdp = {
    attach: async () => 'session',
    send: async (method: string, params: any) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'page' }] }
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') return { bounds: { ...bounds } }
      if (method === 'Browser.setWindowBounds') {
        // normal applies; the maximize request never sticks
        if (params.bounds.windowState === 'normal') bounds = { ...bounds, windowState: 'normal' }
        return {}
      }
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ al: 0, at: 25, ah: 900 }) } }
      throw new Error(method)
    },
  } as unknown as Cdp
  const supervisor = new FramePumpSupervisor(() => ({ cdp }), () => [])
  assert.equal(await supervisor.restoreAll(true), 0, 'unmaximized window must not be reported as restored')
  assert.equal(bounds.windowState, 'normal', 'window is un-minimized but not maximized')
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
