import type { Cdp } from './cdp.ts'
import type { TargetHealth } from './inject.ts'
import { loadSettings } from './store.ts'
import { OFFSCREEN_MARGIN, readWorkArea } from './windows.ts'
import { debug, log, warn } from './log.ts'

export const CAPTURE_TITLE = 'BACKLIGHT_AGENT'
const CONTROLLER_PATH = '/controller'

interface ActiveCapture {
  targetId: string
  origTitle: string
}

/**
 * Layer-1 keep-alive: Tab Capture → CapturerCount exemption (verified in
 * tests/probe-capture.ts). A captured WebContents reports PageVisibilityState
 * kVisible even when its window is minimized: native 60fps rAF, real
 * screenshots, honest visibilityState — on stock Chrome, no fork.
 *
 * Trigger: --auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT (launch
 * arg) + a controller tab calling getDisplayMedia(); the picker auto-selects
 * the tab whose title matches. One capture at a time (single magic title);
 * other hidden targets fall back to the frame pump / rAF shim layers.
 */
export class CaptureKeepAlive {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private active: ActiveCapture | null = null
  private controller: { targetId: string; sessionId: string } | null = null
  private targetSessions = new Map<string, string>()
  /** consecutive hidden samples per target — guards against visibility flicker */
  private hiddenStreak = new Map<string, number>()
  private failures = 0
  private cooldownUntil = 0
  private disabled = false
  private getContext: () => { cdp: Cdp; controllerUrl: string } | null
  private getHealth: () => TargetHealth[]

  constructor(getContext: () => { cdp: Cdp; controllerUrl: string } | null, getHealth: () => TargetHealth[]) {
    this.getContext = getContext
    this.getHealth = getHealth
  }

  start(tickMs = 1000) {
    this.stop()
    this.timer = setInterval(() => void this.tick(), tickMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  activeTargetId(): string | null {
    return this.active?.targetId ?? null
  }

  async tick(): Promise<void> {
    if (this.ticking || this.disabled) return
    const ctx = this.getContext()
    if (!ctx || !loadSettings().captureKeepAlive) return
    this.ticking = true
    try {
      // once engaged, a capture lives for the whole session: the exemption it
      // grants is exactly what we want, and re-arming is expensive/visible
      if (this.active) {
        const me = this.getHealth().find(t => t.targetId === this.active!.targetId)
        if (!me) await this.release('target gone')
        return
      }

      if (Date.now() < this.cooldownUntil) return
      const visible = new Set(
        this.getHealth().filter(t => t.visibility === 'visible').map(t => t.targetId),
      )
      // update hidden streaks: only targets hidden across consecutive samples
      // qualify (guards against transient visibility flicker at page load)
      for (const [id, n] of [...this.hiddenStreak]) {
        if (visible.has(id)) this.hiddenStreak.delete(id)
        else this.hiddenStreak.set(id, n + 1)
      }
      for (const t of this.getHealth()) {
        if (t.visibility !== 'visible' && !this.hiddenStreak.has(t.targetId)) this.hiddenStreak.set(t.targetId, 1)
      }
      const candidates = this.getHealth().filter(t => {
        if (t.visibility === 'visible') return false
        if (t.targetId === this.controller?.targetId) return false
        if (t.url.includes(CONTROLLER_PATH)) return false
        if (t.url.startsWith('about:blank') || t.title === '' || t.title === CAPTURE_TITLE) return false
        // only real web pages: never waste the (single) capture on internal pages
        if (/^(chrome|devtools|about|view-source|bl-controller):/i.test(t.url)) return false
        return (this.hiddenStreak.get(t.targetId) ?? 0) >= 2
      })
      if (candidates.length === 0) return
      await this.engage(candidates[0])
    } catch (err) {
      debug(`capture tick failed: ${(err as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  private async engage(target: TargetHealth): Promise<void> {
    const ctx = this.getContext()
    if (!ctx) return
    const { cdp } = ctx
    // pre-condition: the target must STILL be hidden right now — a visible
    // target doesn't need the exemption and engaging it would waste CPU
    const cur = this.getHealth().find(t => t.targetId === target.targetId)
    if (!cur || cur.visibility === 'visible') return
    const controllerSession = await this.ensureController(cdp)
    if (!controllerSession) {
      this.cooldownUntil = Date.now() + 10_000
      return
    }
    // 1. magic title so the auto-select switch picks THIS tab
    const targetSession = await this.sessionFor(cdp, target.targetId)
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { if (window.__blOrigTitle === undefined) window.__blOrigTitle = String(document.title); document.title = ${JSON.stringify(CAPTURE_TITLE)}; return document.title })()`,
      returnByValue: true,
    }, targetSession)

    // 2. the controller tab must be the ACTIVE, visible tab for
    // getDisplayMedia to be allowed (hidden callers get InvalidStateError).
    // If its window is minimized, restore it straight to the offscreen corner
    // in ONE step (≈one frame flash at worst), capture, then re-minimize and
    // put the original restored-position back so dock-clicks still work.
    const win = await cdp.send<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: this.controller!.targetId }).catch(() => ({ windowId: undefined }))
    let reMinimizeAfter = false
    let origLeft: number | undefined
    let origTop: number | undefined
    if (win.windowId !== undefined) {
      const { bounds } = await cdp.send<{ bounds: any }>('Browser.getWindowBounds', { windowId: win.windowId })
      if ((bounds.windowState ?? 'normal') === 'minimized') {
        reMinimizeAfter = true
        origLeft = bounds.left
        origTop = bounds.top
        const wa = await readWorkArea(cdp)
        const left = wa.al - ((bounds.width ?? 1200) - OFFSCREEN_MARGIN)
        const top = wa.at + wa.ah - OFFSCREEN_MARGIN
        await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', left, top } })
      }
    }
    await cdp.send('Target.activateTarget', { targetId: this.controller!.targetId })
    await sleep(300)

    // 3. controller: synthetic click (transient activation) + getDisplayMedia
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }, controllerSession)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, controllerSession)
    const res = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: 'window.startCapture(5)',
      returnByValue: true,
      awaitPromise: true,
    }, controllerSession)
    const started = res.result?.value
    await sleep(1000)

    // 4. hand focus back to the captured target; the stream persists
    await cdp.send('Target.activateTarget', { targetId: target.targetId })
    await sleep(500)

    // 5. verify the exemption took effect (health samples every ~2s, so poll)
    let engaged = false
    for (let i = 0; i < 6; i++) {
      const meV = this.getHealth().find(t => t.targetId === target.targetId)?.visibility
      if (started === 'ok' && meV === 'visible') { engaged = true; break }
      await sleep(700)
    }
    if (engaged) {
      const origTitle = String(await this.readOrigTitle(cdp, target.targetId) ?? '')
      this.active = { targetId: target.targetId, origTitle }
      this.failures = 0
      // freeze page-visible semantics while captured: some pages pause
      // themselves on visibilitychange even though frames are flowing
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          if (window.__blVisFrozen) return
          window.__blVisFrozen = true
          try {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
          } catch {}
        })()`,
      }, targetSession).catch(() => {})
      log(`capture keep-alive engaged for ${target.targetId.slice(0, 8)} (native full speed while hidden)`)
      // preserve the user's minimize + their original window position so
      // dock-click still restores the window exactly where it was
      if (reMinimizeAfter && win.windowId !== undefined) {
        await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } })
        await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: origLeft, top: origTop } })
        log(`window re-minimized after capture; original position preserved`)
      }
    } else {
      const meV = this.getHealth().find(t => t.targetId === target.targetId)?.visibility
      this.failures++
      warn(`capture keep-alive failed (started=${started}, vis=${meV}); failure #${this.failures}`)
      await cdp.send('Runtime.evaluate', { expression: 'window.stopCapture()' }, controllerSession).catch(() => {})
      // restore the tab title even on failure, or it stays BACKLIGHT_AGENT forever
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { if (window.__blOrigTitle !== undefined) { document.title = String(window.__blOrigTitle); delete window.__blOrigTitle } })()`,
      }, targetSession).catch(() => {})
      if (this.failures >= 3) {
        this.disabled = true
        warn('capture keep-alive disabled for this session after repeated failures (pump/shim remain)')
      }
      this.cooldownUntil = Date.now() + 15_000
    }
  }

  private async readOrigTitle(cdp: Cdp, targetId: string): Promise<string | null> {
    try {
      const session = await this.sessionFor(cdp, targetId)
      const r = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: 'String(window.__blOrigTitle ?? "")',
        returnByValue: true,
      }, session)
      return r.result?.value ?? null
    } catch { return null }
  }
  private async release(reason: string): Promise<void> {
    const ctx = this.getContext()
    const active = this.active
    this.active = null
    if (!ctx || !active) return
    const { cdp } = ctx
    debug(`capture keep-alive release (${reason})`)
    if (this.controller) {
      await cdp.send('Runtime.evaluate', { expression: 'window.stopCapture()' }, this.controller.sessionId).catch(() => {})
    }
    try {
      const session = await this.sessionFor(cdp, active.targetId)
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          if (window.__blOrigTitle !== undefined) { document.title = String(window.__blOrigTitle); delete window.__blOrigTitle }
          if (window.__blVisFrozen) { delete document.visibilityState; delete document.hidden; window.__blVisFrozen = false }
        })()`,
      }, session)
    } catch { /* target gone */ }
  }

  private async sessionFor(cdp: Cdp, targetId: string): Promise<string> {
    const cached = this.targetSessions.get(targetId)
    if (cached) return cached
    const sessionId = await cdp.attach(targetId)
    this.targetSessions.set(targetId, sessionId)
    return sessionId
  }

  private async ensureController(cdp: Cdp): Promise<string | null> {
    const ctx = this.getContext()
    if (!ctx) return null
    if (this.controller) {
      // verify still alive
      const ctl = this.controller
      const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
      const alive = targetInfos.find(t => t.targetId === ctl.targetId && t.type === 'page')
      if (alive) return ctl.sessionId
      this.controller = null
    }
    try {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
        url: ctx.controllerUrl,
        background: true,
      })
      await sleep(800)
      const sessionId = await cdp.attach(targetId)
      await cdp.send('Page.enable', {}, sessionId)
      this.controller = { targetId, sessionId }
      debug(`controller tab created: ${targetId.slice(0, 8)}`)
      return sessionId
    } catch (err) {
      warn(`controller tab creation failed: ${(err as Error).message}`)
      return null
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
