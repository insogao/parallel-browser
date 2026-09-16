import type { Cdp } from './cdp.ts'
import type { TargetHealth } from './inject.ts'
import { loadSettings } from './store.ts'
import { OFFSCREEN_MARGIN, readWorkArea } from './windows.ts'
import { debug, log, warn } from './log.ts'

export const CAPTURE_TITLE = 'BACKLIGHT_AGENT'
const CONTROLLER_PATH = '/controller'

interface ActiveCapture {
  targetId: string
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
export interface CaptureKeepAliveDeps {
  /** true when the app-level background state (bg) hid the app */
  appHidden?: () => Promise<boolean>
  /** re-apply that hidden state after a setup that unhid/activated the app */
  hideApp?: () => Promise<void>
}

export class CaptureKeepAlive {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private cdp: Cdp | null = null
  private generation = 0
  private active: ActiveCapture | null = null
  private controller: { targetId: string; sessionId: string } | null = null
  private targetSessions = new Map<string, string>()
  /** consecutive hidden samples per target — guards against visibility flicker */
  private hiddenStreak = new Map<string, number>()
  private failures = 0
  private cooldownUntil = 0
  private disabled = false
  private paused = false
  private getContext: () => { cdp: Cdp; controllerUrl: string } | null
  private getHealth: () => TargetHealth[]
  private deps: CaptureKeepAliveDeps

  constructor(
    getContext: () => { cdp: Cdp; controllerUrl: string } | null,
    getHealth: () => TargetHealth[],
    deps: CaptureKeepAliveDeps = {},
  ) {
    this.getContext = getContext
    this.getHealth = getHealth
    this.deps = deps
  }

  start(tickMs = 1000) {
    this.stop()
    this.timer = setInterval(() => void this.tick(), tickMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.generation++
  }

  activeTargetId(): string | null {
    this.syncContext()
    return this.active?.targetId ?? null
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused
    if (paused) this.generation++
    // Finish any in-flight setup before showing a user window. The flag also
    // prevents that setup from re-minimizing or switching tabs during takeover.
    const deadline = Date.now() + 2500
    while (paused && this.ticking && Date.now() < deadline) await sleep(50)
  }

  async tick(): Promise<void> {
    this.syncContext()
    if (this.ticking || this.disabled || this.paused) return
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

  /** All state below belongs to one browser connection, even after failures. */
  private syncContext() {
    const cdp = this.getContext()?.cdp ?? null
    if (cdp === this.cdp) return
    this.cdp = cdp
    this.generation++
    this.active = null
    this.controller = null
    this.targetSessions.clear()
    this.hiddenStreak.clear()
    this.failures = 0
    this.cooldownUntil = 0
    this.disabled = false
  }

  private async send<T = any>(cdp: Cdp, method: string, params: Record<string, unknown> = {}, session?: string): Promise<T> {
    return bounded(cdp.send<T>(method, method === 'Runtime.evaluate' ? { timeout: 1500, ...params } : params, session))
  }

  private async engage(target: TargetHealth): Promise<void> {
    const ctx = this.getContext()
    if (!ctx) return
    const { cdp } = ctx
    const generation = this.generation
    const current = () => this.getContext()?.cdp === cdp && !cdp.closed
    const allowed = () => current() && !this.paused && this.generation === generation
    const check = () => { if (!allowed()) throw new Error('capture setup aborted') }
    const cur = this.getHealth().find(t => t.targetId === target.targetId)
    if (!cur || cur.visibility === 'visible') return
    let controllerSession: string | null = null
    let targetSession: string | undefined
    let titleTouched = false
    let switched = false
    let started = false
    let windowId: number | undefined
    let original: any
    let parked: { left: number; top: number } | undefined
    let appWasHidden = false
    try {
      check()
      controllerSession = await this.ensureController(cdp, check)
      check()
      if (!controllerSession) throw new Error('controller unavailable')
      targetSession = await this.sessionFor(cdp, target.targetId)
      check()
      titleTouched = true
      await this.send(cdp, 'Runtime.evaluate', {
        expression: `(() => { if (window.__blOrigTitle === undefined) window.__blOrigTitle = String(document.title); document.title = ${JSON.stringify(CAPTURE_TITLE)} })()`,
      }, targetSession)
      check()
      const win = await this.send(cdp, 'Browser.getWindowForTarget', { targetId: this.controller!.targetId })
      check()
      windowId = win.windowId
      if (windowId !== undefined) {
        const { bounds } = await this.send(cdp, 'Browser.getWindowBounds', { windowId })
        check()
        if (bounds.windowState === 'minimized') {
          original = bounds
          if (this.deps.appHidden) appWasHidden = await this.deps.appHidden().catch(() => false)
          const wa = await bounded(readWorkArea(cdp))
          check()
          // Measured on macOS/CfT 153: a position sent together with the
          // minimized -> normal transition is ignored (the window reappears at
          // its old frame), so switch to normal first and park in a separate
          // call. A position set on a minimized window would un-minimize it.
          const target = { left: wa.al - ((bounds.width ?? 1200) - OFFSCREEN_MARGIN), top: wa.at + wa.ah - OFFSCREEN_MARGIN }
          await this.send(cdp, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
          check()
          await this.send(cdp, 'Browser.setWindowBounds', { windowId, bounds: target })
          check()
          // AppKit may clamp a mostly-offscreen frame; remember what actually
          // applied so cleanup can recognize our own move.
          const applied = await this.send<{ bounds?: { left?: number; top?: number } }>(cdp, 'Browser.getWindowBounds', { windowId }).catch(() => null)
          parked = applied?.bounds && typeof applied.bounds.left === 'number' && typeof applied.bounds.top === 'number'
            ? { left: applied.bounds.left, top: applied.bounds.top }
            : target
        }
      }
      switched = true
      await this.send(cdp, 'Target.activateTarget', { targetId: this.controller!.targetId })
      await sleep(300)
      check()
      await this.send(cdp, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }, controllerSession)
      check()
      await this.send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, controllerSession)
      check()
      const res = await this.send(cdp, 'Runtime.evaluate', {
        // A cancelled picker can resolve after the daemon timeout. Its own
        // continuation must stop that late stream instead of leaking capture.
        expression: `(async () => {
          const attempt = {}; window.__blCaptureAttempt = attempt;
          const result = await window.startCapture(5);
          if (window.__blCaptureAttempt !== attempt) { window.stopCapture(); return 'aborted' }
          return result;
        })()`,
        returnByValue: true, awaitPromise: true,
      }, controllerSession)
      check()
      if (res.exceptionDetails || !['ok', 'already'].includes(res.result?.value)) throw new Error('capture did not start')
      const live = await this.send(cdp, 'Runtime.evaluate', {
        expression: `!!window.__stream?.getVideoTracks().some(t => t.readyState === 'live')`, returnByValue: true,
      }, controllerSession)
      check()
      if (live.exceptionDetails || live.result?.value !== true) throw new Error('capture stream is not live')
      started = true
      this.active = { targetId: target.targetId }
      this.failures = 0
      log(`capture keep-alive engaged for ${target.targetId.slice(0, 8)} (native full speed while hidden)`)
    } catch (err) {
      if (allowed()) {
        this.failures++
        this.cooldownUntil = Date.now() + 15_000
        this.disabled = this.failures >= 3
        warn(`capture keep-alive failed: ${(err as Error).message}; failure #${this.failures}`)
      }
    } finally {
      if (!started && controllerSession) await this.stopStream(cdp, controllerSession)
      if (titleTouched && targetSession) await this.restoreTitle(cdp, targetSession)
      if (switched) {
        if (allowed()) {
          await this.send(cdp, 'Target.activateTarget', { targetId: target.targetId }).catch(() => {})
        } else {
          // Takeover/cancel: never leave the human in front of the controller.
          // Undo our own switch only if the controller is still the active tab;
          // a tab the human selected during the race wins.
          await this.restorePageIfControllerActive(cdp, target.targetId, controllerSession)
        }
      }
      if (parked && windowId !== undefined && current()) {
        // Only undo our own offscreen move. A human may have restored/moved
        // this window while setup or cleanup was awaiting CDP.
        const now = await this.send(cdp, 'Browser.getWindowBounds', { windowId }).catch(() => null)
        if (now?.bounds.windowState === 'normal' && now.bounds.left === parked.left && now.bounds.top === parked.top) {
          if (allowed()) {
            // Position must be restored while the window is normal: setting a
            // position on a minimized window un-minimizes it (measured macOS/CfT 153).
            await this.send(cdp, 'Browser.setWindowBounds', { windowId, bounds: { left: original.left, top: original.top } }).catch(() => {})
            if (allowed()) await this.send(cdp, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {})
            // The macOS capture picker can unhide/activate the app even when the
            // window stays minimized; bg semantics must survive the setup.
            if (allowed() && appWasHidden && this.deps.hideApp) await this.deps.hideApp().catch(() => {})
          } else if (this.paused && current()) {
            // Takeover owns the window now: bring it back on-screen and leave it visible.
            const latest = await this.send(cdp, 'Browser.getWindowBounds', { windowId }).catch(() => null)
            if (latest?.bounds.left === parked.left && latest.bounds.top === parked.top) {
              await this.send(cdp, 'Browser.setWindowBounds', { windowId, bounds: { left: original.left, top: original.top } }).catch(() => {})
            }
          }
        }
      }
    }
  }

  /**
   * Takeover-safe cleanup: activate the page we switched away from, but only
   * while our controller is still what the human would see. If the controller
   * is hidden because another tab was selected, that choice is preserved.
   * Every probe is bounded and failures (closed target, dead connection) are
   * swallowed so takeover never blocks on cleanup.
   */
  private async restorePageIfControllerActive(cdp: Cdp, targetId: string, controllerSession: string | null) {
    if (!controllerSession) return
    if (!(await this.controllerIsActive(cdp, controllerSession))) return
    await this.send(cdp, 'Target.activateTarget', { targetId }).catch(() => {})
  }

  private async controllerIsActive(cdp: Cdp, session: string): Promise<boolean> {
    try {
      const r = await this.send<{ result?: { value?: unknown } }>(cdp, 'Runtime.evaluate', {
        expression: 'document.visibilityState',
        returnByValue: true,
      }, session)
      if (r?.result?.value === 'visible') return true
      if (r?.result?.value !== 'hidden') return false
      // Hidden: the human may have selected another tab (keep it), or the
      // window may be minimized (nothing is visible; still put the page back
      // so restoring the window later shows the website, not our controller).
      const controllerTargetId = this.controller?.targetId
      if (!controllerTargetId) return false
      const win = await this.send<{ windowId?: number }>(cdp, 'Browser.getWindowForTarget', { targetId: controllerTargetId }).catch(() => null)
      if (win?.windowId === undefined) return false
      const bounds = await this.send<{ bounds?: { windowState?: string } }>(cdp, 'Browser.getWindowBounds', { windowId: win.windowId }).catch(() => null)
      return bounds?.bounds?.windowState === 'minimized'
    } catch {
      return false
    }
  }

  private async restoreTitle(cdp: Cdp, session: string) {
    await this.send(cdp, 'Runtime.evaluate', {
      expression: `(() => { if (window.__blOrigTitle !== undefined) { if (document.title === ${JSON.stringify(CAPTURE_TITLE)}) document.title = String(window.__blOrigTitle); delete window.__blOrigTitle } })()`,
    }, session).catch(() => {})
  }

  private async stopStream(cdp: Cdp, session: string) {
    await this.send(cdp, 'Runtime.evaluate', {
      expression: 'window.__blCaptureAttempt = null; window.stopCapture()',
    }, session).catch(() => {})
  }

  private async release(reason: string): Promise<void> {
    const cdp = this.cdp
    this.active = null
    debug(`capture keep-alive release (${reason})`)
    if (cdp && this.controller) await this.stopStream(cdp, this.controller.sessionId)
  }

  private async sessionFor(cdp: Cdp, targetId: string): Promise<string> {
    const cached = this.targetSessions.get(targetId)
    if (cached) return cached
    const sessionId = await bounded(cdp.attach(targetId))
    if (this.getContext()?.cdp === cdp) this.targetSessions.set(targetId, sessionId)
    return sessionId
  }

  private async ensureController(cdp: Cdp, check: () => void): Promise<string | null> {
    const ctx = this.getContext()
    if (!ctx) return null
    if (this.controller) {
      // verify still alive
      const ctl = this.controller
      const { targetInfos } = await this.send<{ targetInfos: any[] }>(cdp, 'Target.getTargets')
      const alive = targetInfos.find(t => t.targetId === ctl.targetId && t.type === 'page')
      check()
      if (alive) return ctl.sessionId
      this.controller = null
    }
    try {
      check()
      const { targetId } = await this.send<{ targetId: string }>(cdp, 'Target.createTarget', {
        url: ctx.controllerUrl,
        background: true,
      })
      check()
      await sleep(800)
      check()
      const sessionId = await bounded(cdp.attach(targetId))
      check()
      await this.send(cdp, 'Page.enable', {}, sessionId)
      check()
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

async function bounded<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('capture operation timed out')), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
