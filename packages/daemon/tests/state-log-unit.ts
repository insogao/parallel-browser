import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StateTransitionLog, cleanTransitionString, sanitizeTransition } from '../src/state-log.ts'

test('ring buffer stays bounded and keeps the newest transitions', () => {
  const log = new StateTransitionLog({ limit: 8, sink: () => {} })
  for (let i = 0; i < 300; i++) log.record({ event: 'probe', windowId: i })
  assert.equal(log.size(), 8)
  const recent = log.recent(50)
  assert.equal(recent.length, 8)
  assert.equal(recent[0]!.windowId, 292)
  assert.equal(recent.at(-1)!.windowId, 299)
})

test('sanitize keeps only allowlisted keys and drops content-bearing fields', () => {
  const entry = sanitizeTransition({
    event: 'window-minimize',
    windowId: 7,
    gen: 3,
    origin: 'explicit',
    token: 'i4',
    source: 'capture',
    before: 'normal',
    after: 'minimized',
    branch: 'single',
    // must be dropped: never part of the transition vocabulary
    url: 'https://bank.example/secret?token=abc',
    cookie: 'session=deadbeef',
    title: 'Private tab title',
    nested: { profile: '/Users/me/Library' },
  } as any)
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['after', 'at', 'before', 'branch', 'event', 'gen', 'origin', 'source', 'token', 'windowId'].sort(),
  )
  assert.equal(entry.origin, 'explicit')
  assert.equal(entry.token, 'i4')
  assert.equal((entry as any).url, undefined)
  assert.equal((entry as any).cookie, undefined)
  assert.equal((entry as any).title, undefined)
})

test('URLs in allowed fields are redacted and strings are bounded', () => {
  const entry = sanitizeTransition({
    event: 'show-skip',
    detail: 'observedAt=123 from https://127.0.0.1:9333/api/status?token=leak',
    source: 'tray.auto.activate',
    before: 'ws://127.0.0.1:50486/devtools/page/DEADBEEF\t\n',
  })
  assert.match(entry.detail!, /\[redacted-url\]/)
  assert.doesNotMatch(entry.detail!, /https?:\/\//)
  assert.doesNotMatch(entry.detail!, /leak/)
  assert.doesNotMatch(entry.before!, /ws:\/\//)
  assert.doesNotMatch(entry.before!, /[\r\n\t]/)
  const long = sanitizeTransition({ event: 'x'.repeat(5000), detail: 'y'.repeat(5000) })
  assert.equal(long.event.length, 80)
  assert.equal(long.detail!.length, 160)
})

test('cleanTransitionString leaves identifiers intact', () => {
  assert.equal(cleanTransitionString('tray.auto.activate'), 'tray.auto.activate')
  assert.equal(cleanTransitionString('POST /api/bg'), 'POST /api/bg')
  assert.equal(cleanTransitionString(''), '')
})

test('sink receives one bounded JSON line per transition', () => {
  const lines: string[] = []
  const log = new StateTransitionLog({ limit: 4, sink: line => lines.push(line) })
  const recorded = log.record({ event: 'native-hide', at: 1234, source: 'tray.menu.bg', before: 'visible', after: 'hidden', branch: 'applied' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0], JSON.stringify(recorded))
  const parsed = JSON.parse(lines[0]!)
  assert.equal(parsed.at, 1234)
  assert.equal(parsed.event, 'native-hide')
  assert.equal(parsed.branch, 'applied')
})
