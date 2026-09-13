import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionDev } from '../src/extension-dev.ts'
import { ActivityBus } from '../src/activity.ts'
import type { BrowserManager } from '../src/browser.ts'
import type { ExtensionManager } from '../src/extensions.ts'
import type { Cdp } from '../src/cdp.ts'

const extPath = fs.realpathSync(fileURLToPath(new URL('../../../examples/side-panel', import.meta.url)))

function fixture() {
  const calls: Array<{ method: string; params: any; session?: string }> = []
  const owners: Record<string, number> = { 'panel-b': 2, 'panel-a': 1 }
  const openSessions = new Set<string>()
  let opened = false
  const fake = {
    closed: false,
    attach: async (targetId: string) => { const s = `s-${targetId}`; openSessions.add(s); return s },
    send: async (method: string, params: any = {}, session?: string) => {
      calls.push({ method, params, session })
      switch (method) {
        case 'Extensions.getExtensions':
          return { extensions: [{ id: 'ext1', name: 'demo', path: extPath, version: '1.0.0', enabled: true }] }
        case 'Browser.getWindowForTarget':
          return { windowId: params.targetId === 'page-a' ? 1 : 3 }
        case 'Target.createTarget':
          return { targetId: 'bridge' }
        case 'Target.closeTarget':
          return {}
        case 'Target.detachFromTarget':
          openSessions.delete(params.sessionId)
          return {}
        case 'Target.getTargets': {
          const targets = opened
            ? [
                { targetId: 'page-a', type: 'page', url: 'https://example.com/a' },
                { targetId: 'panel-b', type: 'page', url: 'chrome-extension://ext1/panel.html' },
                { targetId: 'panel-a', type: 'page', url: 'chrome-extension://ext1/panel.html' },
              ]
            : [{ targetId: 'page-a', type: 'page', url: 'https://example.com/a' }]
          return { targetInfos: targets }
        }
        case 'Runtime.evaluate': {
          if (session === 's-bridge') {
            if (params.expression.includes('chrome.tabs.getCurrent')) return { result: { value: { windowId: 2 } } }
            if (params.expression.includes('sidePanel.open')) { opened = true; return { result: { value: undefined } } }
            return { result: { value: true } }
          }
          const targetId = session?.replace(/^s-/, '')
          if (targetId && targetId in owners) {
            return { result: { value: owners[targetId] } }
          }
          return { result: { value: undefined } }
        }
        default:
          return {}
      }
    },
  }
  const manager = {
    current: { cdp: fake as unknown as Cdp, extensionPaths: [] },
    running: true,
  } as unknown as BrowserManager
  const extensions = {
    get: (name: string) => name === 'demo' ? { name: 'demo', path: extPath, addedAt: Date.now() } : undefined,
    list: () => [{ name: 'demo', path: extPath, addedAt: Date.now() }],
  } as unknown as ExtensionManager
  return {
    dev: new ExtensionDev(manager, extensions, new ActivityBus()),
    calls, openSessions, owners,
  }
}

test('openPanel binds sidePanel APIs to the requested page window, not the bridge window', async () => {
  const f = fixture()
  const result = await f.dev.openPanel('demo', 'page-a')
  assert.equal(result.targetId, 'page-a')
  assert.equal(result.panelTargetId, 'panel-a', 'must pick the panel owned by the requested window')
  const open = f.calls.find(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('sidePanel.open'))
  assert.ok(open, 'sidePanel.open must be called')
  assert.match(open!.params.expression, /"windowId":1/)
  assert.doesNotMatch(open!.params.expression, /"windowId":2/)
  assert.equal(f.openSessions.size, 0, 'no sessions may leak')
})

test('openPanel rejects panels from other windows and still closes sessions and bridge', async () => {
  const f = fixture()
  f.owners['panel-b'] = 2
  delete f.owners['panel-a']
  await assert.rejects(f.dev.openPanel('demo', 'page-a'), /side panel did not open/)
  assert.ok(f.calls.some(c => c.method === 'Target.closeTarget' && c.params.targetId === 'bridge'), 'bridge must close on failure')
  assert.equal(f.openSessions.size, 0, 'no sessions may leak on failure')
})
