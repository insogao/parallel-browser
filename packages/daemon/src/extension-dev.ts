import fs from 'node:fs'
import path from 'node:path'
import type { BrowserManager } from './browser.ts'
import type { ExtensionManager, ExtEntry } from './extensions.ts'
import type { ActivityBus } from './activity.ts'
import type { Cdp } from './cdp.ts'

interface RuntimeExtension { id: string; name: string; path: string; version: string; enabled: boolean }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const canonical = (p: string) => fs.realpathSync(p)

/** Developer operations only affect registered unpacked extensions. */
export class ExtensionDev {
  private manager: BrowserManager
  private extensions: ExtensionManager
  private bus: ActivityBus
  private queue: Promise<unknown> = Promise.resolve()
  lastReload: { name: string; ok: boolean; message: string; at: number } | null = null

  constructor(manager: BrowserManager, extensions: ExtensionManager, bus: ActivityBus) {
    this.manager = manager; this.extensions = extensions; this.bus = bus
  }

  entry(name: string): ExtEntry {
    const entry = this.extensions.get(name)
    if (!entry) throw new Error(`extension not registered: ${name}`)
    return entry
  }

  private cdp(): Cdp {
    if (!this.manager.current) throw new Error('browser not running')
    return this.manager.current.cdp
  }

  async runtime(): Promise<RuntimeExtension[]> {
    if (!this.manager.running) return []
    return (await this.cdp().send<{ extensions: RuntimeExtension[] }>('Extensions.getExtensions')).extensions
  }

  async load(name: string, reload = false): Promise<RuntimeExtension> {
    const job = this.queue.catch(() => {}).then(async () => {
      const entry = this.entry(name)
      const existing = (await this.runtime()).find(e => canonical(e.path) === canonical(entry.path))
      if (existing?.enabled && !reload) return existing
      const cur = this.manager.current
      if (!cur) throw new Error('browser not running')
      try {
        const { id } = await cur.cdp.send<{ id: string }>('Extensions.loadUnpacked', { path: entry.path })
        if (!cur.extensionPaths.includes(entry.path)) cur.extensionPaths.push(entry.path)
        const updated = (await this.runtime()).find(e => e.id === id)
        if (!updated?.enabled) throw new Error('extension did not become enabled')
        this.lastReload = { name, ok: true, message: `已加载 ${updated.version}；网页保持原状，内容脚本修改需刷新网页`, at: Date.now() }
        this.bus.system('extension-loaded', `${name} ${updated.version}; browser kept running`)
        return updated
      } catch (err) {
        this.lastReload = { name, ok: false, message: (err as Error).message, at: Date.now() }
        this.bus.system('extension-reload-failed', `${name}: ${(err as Error).message}`)
        throw new Error(`extension reload failed: ${(err as Error).message}. Use a recent Chrome for Testing engine; the browser was not restarted.`)
      }
    })
    this.queue = job
    return job
  }

  async changed(files: string[]): Promise<void> {
    const loaded = this.manager.current?.extensionPaths ?? []
    for (const entry of this.extensions.list()) {
      if (loaded.includes(entry.path) && files.some(f => f === entry.path || f.startsWith(entry.path + path.sep))) {
        await this.load(entry.name, true).catch(() => {})
      }
    }
  }

  async remove(name: string): Promise<boolean> {
    const job = this.queue.catch(() => {}).then(async () => {
      const entry = this.entry(name)
      const current = (await this.runtime()).find(e => canonical(e.path) === canonical(entry.path))
      if (current) await this.cdp().send('Extensions.uninstall', { id: current.id })
      if (this.manager.current) this.manager.current.extensionPaths = this.manager.current.extensionPaths.filter(p => p !== entry.path)
      return this.extensions.remove(name)
    })
    this.queue = job
    return job
  }

  async evaluate(cdp: Cdp, session: string, expression: string, gesture = false): Promise<any> {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture, timeout: 8000 }, session)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }

  async openPanel(name: string, targetId: string): Promise<{ extensionId: string; targetId: string; panelTargetId: string }> {
    const entry = this.entry(name)
    const manifest = JSON.parse(fs.readFileSync(path.join(entry.path, 'manifest.json'), 'utf8'))
    const panelPath = manifest.side_panel?.default_path
    if (!panelPath || !manifest.permissions?.includes('sidePanel')) {
      throw new Error('此扩展未声明 side_panel.default_path 和 sidePanel 权限；请先配置真实侧栏。可参考 examples/side-panel。')
    }
    const ext = await this.load(name)
    const cdp = this.cdp()
    await cdp.send('Target.activateTarget', { targetId })
    const pageSession = await cdp.attach(targetId)
    let bridge: string | undefined
    let extensionSession: string | undefined
    try {
      // Activating a page within the managed app selects the window whose active
      // tab the extension APIs will address. No website content is reloaded.
      await cdp.send('Page.bringToFront', {}, pageSession)
      // Runtime's userGesture flag is honored by extension documents, but not
      // service workers. Use a short-lived background extension document so
      // this also supports side-panel extensions without a background worker.
      const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `chrome-extension://${ext.id}/${panelPath}`, background: true })
      bridge = created.targetId
      extensionSession = await cdp.attach(created.targetId)
      let tab: any
      for (let i = 0; i < 40; i++) {
        tab = await this.evaluate(cdp, extensionSession, 'chrome.tabs.getCurrent()').catch(() => null)
        if (tab?.windowId != null) break
        await sleep(100)
      }
      if (tab?.windowId == null) throw new Error('extension page failed to load')
      const options = { windowId: tab.windowId }
      // Reopen only this window's panel so its new CDP target can be identified
      // unambiguously even when another window has the same extension open.
      await this.evaluate(cdp, extensionSession, `chrome.sidePanel.close(${JSON.stringify(options)}).catch(() => {})`)
      const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map((t: any) => t.targetId))
      await this.evaluate(cdp, extensionSession, `chrome.sidePanel.open(${JSON.stringify(options)})`, true)
      if (bridge) { await cdp.send('Target.closeTarget', { targetId: bridge }); bridge = undefined }
      for (let i = 0; i < 50; i++) {
        const candidates = (await cdp.send('Target.getTargets')).targetInfos.filter((t: any) => t.type === 'page' && !before.has(t.targetId) && t.url.startsWith(`chrome-extension://${ext.id}/`))
        for (const candidate of candidates) {
          const sid = await cdp.attach(candidate.targetId)
          try {
            // A native side panel is an extension page with no tabs.getCurrent().
            const native = await this.evaluate(cdp, sid, `(async () => {
              if (await chrome.tabs.getCurrent()) return false;
              const contexts = await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL'],documentUrls:[location.href]});
              return contexts.length > 0;
            })()`)
            if (native) return { extensionId: ext.id, targetId, panelTargetId: candidate.targetId }
          } catch { /* still loading */ }
          finally { await cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {}) }
        }
        await sleep(100)
      }
      throw new Error('side panel did not open; check extension sidePanel options and errors')
    } finally {
      if (bridge) await cdp.send('Target.closeTarget', { targetId: bridge }).catch(() => {})
      if (extensionSession) await cdp.send('Target.detachFromTarget', { sessionId: extensionSession }).catch(() => {})
      await cdp.send('Target.detachFromTarget', { sessionId: pageSession }).catch(() => {})
    }
  }
}
