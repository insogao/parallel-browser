import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isWindowlessPage, openWindowlessPage, pendingWindowlessPages, closeWindowlessPage,
  probeWindowless, windowlessCapability, windowlessCount,
} from '../src/window-open.ts'
import type { Cdp } from '../src/cdp.ts'

function fakeCdp(type: 'other' | 'page', url = 'https://www.bing.com/search?q=test') {
  const calls: Array<{ method: string; params: any }> = []
  const cdp = { send: async (method: string, params: any = {}) => {
    calls.push({ method, params })
    if (method === 'Target.createTarget') return { targetId: 'hidden-1' }
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'hidden-1', type, url }] }
    return {}
  } } as unknown as Cdp
  return { cdp, calls }
}

test('windowless page persists through navigation and is removed after manual takeover', async () => {
  const { cdp, calls } = fakeCdp('other')
  const id = await openWindowlessPage(cdp, 'https://www.baidu.com/')
  assert.equal(id, 'hidden-1')
  assert.equal(isWindowlessPage(cdp, id), true)
  assert.equal(windowlessCount(cdp), 1)
  assert.deepEqual(await pendingWindowlessPages(cdp), [{ targetId: id, url: 'https://www.bing.com/search?q=test' }])
  await closeWindowlessPage(cdp, id)
  assert.equal(isWindowlessPage(cdp, id), false)
  assert.equal(windowlessCount(cdp), 0)
  assert.deepEqual(await pendingWindowlessPages(cdp), [])
  assert.deepEqual(calls.filter(c => c.method === 'Target.createTarget')[0]?.params,
    { url: 'https://www.baidu.com/', background: true, hidden: true })
})

test('an engine that ignores hidden:true is refused and the tab is closed', async () => {
  const { cdp, calls } = fakeCdp('page')
  await assert.rejects(
    () => openWindowlessPage(cdp, 'https://www.baidu.com/'),
    /engine did not honor hidden:true/,
  )
  const closed = calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId)
  assert.deepEqual(closed, ['hidden-1'], 'the visible fallback tab must be closed')
  assert.equal(isWindowlessPage(cdp, 'hidden-1'), false, 'no identity may be registered for a visible tab')
})

test('a target that cannot be observed is treated as missing and refused', async () => {
  const cdp = { send: async (method: string) => {
    if (method === 'Target.createTarget') return { targetId: 'ghost' }
    if (method === 'Target.getTargets') return { targetInfos: [] }
    return {}
  } } as unknown as Cdp
  await assert.rejects(() => openWindowlessPage(cdp, 'https://example.com/', 1), /target is missing/)
  assert.equal(await probeWindowless(cdp, 'ghost', 1), 'missing')
})

test('capability contract states adoption and BrowserPilot are unsupported', () => {
  const capability = windowlessCapability()
  assert.equal(capability.create, true)
  assert.equal(capability.adoption, 'unsupported')
  assert.equal(capability.browserPilot, 'unsupported')
  assert.match(capability.reason, /not-tab-strip/)
  assert.equal(windowlessCapability() === capability, false, 'each caller gets its own copy')
})
