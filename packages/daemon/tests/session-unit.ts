import assert from 'node:assert/strict'
import test from 'node:test'
import { browserSessionId } from '../src/session.ts'

test('session id is stable for one managed instance and distinct across launches', () => {
  const a = browserSessionId({ space: 'default', pid: 4242, startedAt: 1000 })
  assert.equal(a, 's-default-4242-1000')
  assert.equal(a, browserSessionId({ space: 'default', pid: 4242, startedAt: 1000 }))
  assert.notEqual(a, browserSessionId({ space: 'default', pid: 4243, startedAt: 1000 }))
  assert.notEqual(a, browserSessionId({ space: 'default', pid: 4242, startedAt: 2000 }))
  assert.notEqual(a, browserSessionId({ space: 'work', pid: 4242, startedAt: 1000 }))
})

test('session id never carries paths or user content', () => {
  const id = browserSessionId({ space: '../../Users/me/space name', pid: 7, startedAt: 5 })
  assert.doesNotMatch(id, /[/\s.]/)
  assert.match(id, /^s-[a-zA-Z0-9_-]+-7-5$/)
})
