import assert from 'node:assert/strict'
import test from 'node:test'
import { RAF_SHIM_JS, buildInjectJs } from '../src/inject.ts'
import {
  firstSampleAt,
  formatTimeline,
  holdsThroughout,
  parseNativeWindowsProbe,
  ratePerSec,
  sliceWindow,
  type WindowStateSample,
} from './window-state-samples.ts'

const sample = (atMs: number, patch: Partial<WindowStateSample> = {}): WindowStateSample => ({
  atMs,
  cdpWindowState: 'normal',
  nativeAppHidden: false,
  nativeOnScreenWindows: 1,
  domVisibility: 'visible',
  raf: null,
  nativeRaf: null,
  timer: null,
  pagePolls: null,
  serverPolls: null,
  ...patch,
})

test('native windows probe parses app-control windows output', () => {
  assert.deepEqual(
    parseNativeWindowsProbe('{"windowCount":7,"onScreenWindowCount":1}\n'),
    { windowCount: 7, onScreenWindowCount: 1 },
  )
  assert.deepEqual(
    parseNativeWindowsProbe('{"windowCount":2,"onScreenWindowCount":0}'),
    { windowCount: 2, onScreenWindowCount: 0 },
  )
})

test('native windows probe rejects output that cannot prove on-screen state', () => {
  assert.throws(() => parseNativeWindowsProbe('unsupported command'), /unexpected app-control windows output/)
  assert.throws(() => parseNativeWindowsProbe('{"windowCount":7}'), /unexpected app-control windows output/)
  assert.throws(() => parseNativeWindowsProbe('{"windowCount":7,"onScreenWindowCount":null}'), /unexpected/)
})

test('firstSampleAt records the transition timestamp of the first match only', () => {
  const samples = [
    sample(0, { cdpWindowState: 'maximized', domVisibility: 'visible' }),
    sample(500, { cdpWindowState: 'minimized' }),
    sample(1000, { cdpWindowState: 'minimized', domVisibility: 'hidden' }),
    sample(1500, { cdpWindowState: 'minimized', domVisibility: 'hidden' }),
  ]
  assert.equal(firstSampleAt(samples, s => s.cdpWindowState === 'minimized'), 500)
  assert.equal(firstSampleAt(samples, s => s.domVisibility === 'hidden'), 1000)
  assert.equal(firstSampleAt(samples, s => s.cdpWindowState === 'maximized'), 0)
  assert.equal(firstSampleAt(samples, s => s.cdpWindowState === 'fullscreen'), null)
})

test('ratePerSec computes the mean rate over finite points and ignores gaps', () => {
  const samples = [
    sample(0, { timer: 100, nativeRaf: null }),
    sample(1000, { timer: 110, nativeRaf: 0 }),
    sample(2000, { timer: null, nativeRaf: null }),
    sample(4000, { timer: 140, nativeRaf: 60 }),
  ]
  assert.equal(ratePerSec(samples, s => s.timer), 10)
  // finite points are (1s, 0) and (4s, 60): 60 over 3s
  assert.equal(ratePerSec(samples, s => s.nativeRaf), 20)
  assert.equal(ratePerSec(samples.slice(0, 2), s => s.nativeRaf), null)
  assert.equal(ratePerSec([], s => s.timer), null)
})

test('ratePerSec distinguishes unthrottled from background-throttled polling', () => {
  // Chromium clamps hidden-tab timers to ~1/s and intensive throttling to
  // ~1/min. The acceptance threshold of 2 polls/s must accept the nominal
  // stream and reject the clamped one.
  const throttled = [sample(0, { serverPolls: 0 }), sample(5000, { serverPolls: 5 }), sample(10_000, { serverPolls: 10 })]
  const unthrottled = [sample(0, { serverPolls: 0 }), sample(5000, { serverPolls: 20 }), sample(10_000, { serverPolls: 40 })]
  assert.equal(ratePerSec(throttled, s => s.serverPolls), 1)
  assert.equal(ratePerSec(unthrottled, s => s.serverPolls), 4)
  assert.ok(ratePerSec(unthrottled, s => s.serverPolls)! >= 2)
  assert.ok(ratePerSec(throttled, s => s.serverPolls)! < 2)
})

test('holdsThroughout requires every sample including native state channels', () => {
  const good = [sample(0), sample(500, { nativeOnScreenWindows: 0, nativeAppHidden: true })]
  assert.equal(holdsThroughout(good, s => s.nativeOnScreenWindows === 0 && s.nativeAppHidden === true), false)
  assert.equal(holdsThroughout(good.slice(1), s => s.nativeOnScreenWindows === 0 && s.nativeAppHidden === true), true)
  assert.equal(holdsThroughout([], s => true), false)
  // a missing native channel must not count as satisfying the predicate
  assert.equal(holdsThroughout([sample(0, { nativeOnScreenWindows: null })], s => s.nativeOnScreenWindows === 0), false)
})

test('sliceWindow isolates the minimized observation window', () => {
  const samples = [sample(0), sample(1000), sample(10_000), sample(11_000)]
  assert.deepEqual(sliceWindow(samples, 1000, 10_000).map(s => s.atMs), [1000, 10_000])
  assert.deepEqual(sliceWindow(samples, 10_001, 20_000).map(s => s.atMs), [11_000])
})

test('formatTimeline prints every transition with an explicit time or gap', () => {
  const text = formatTimeline([
    { atMs: 1250, label: 'CDP windowState=minimized' },
    { atMs: null, label: 'native on-screen windows=0' },
  ])
  assert.match(text, /\[  1\.25s\] CDP windowState=minimized/)
  assert.match(text, /\[\s+--\s+\] native on-screen windows=0/)
})

test('injected health/rAF shim never fakes document.visibilityState or document.hidden', () => {
  const js = buildInjectJs(true)
  // The rAF shim keeps page logic alive; it may READ visibility but never
  // rewrite it. The acceptance test reads Chromium's own value.
  assert.doesNotMatch(js, /document\.visibilityState\s*=/)
  assert.doesNotMatch(js, /document\.hidden\s*=/)
  assert.doesNotMatch(js, /defineProperty\s*\(\s*document/)
  assert.doesNotMatch(js, /['"]visibilityState['"]\s*\)/)
  assert.doesNotMatch(js, /['"]hidden['"]\s*\)/)
  // counters must keep the compensatory and native channels separate
  assert.match(js, /__blNativeRaf/)
  assert.match(js, /h\.native\+\+/)
  assert.match(js, /h\.raf\+\+/)
  assert.doesNotMatch(RAF_SHIM_JS, /document\.visibilityState\s*=/)
})
