import type { Cdp } from './cdp.ts'
import type { TargetHealth } from './inject.ts'
import { loadSettings } from './store.ts'
import { debug, log } from './log.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export interface WindowStateInfo {
  windowId: number
  state: string
  cornered: boolean
}

export interface WorkArea { al: number; at: number; ah: number }

/** 2px of the window stays on-screen: invisible in practice, but Chromium
 * still counts the window as visible (full-speed rAF, real screenshots). */
export const OFFSCREEN_MARGIN = 2

/** Read the main display work area from any page (CDP has no screen API). */
export async function readWorkArea(cdp: Cdp): Promise<WorkArea> {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets')
  for (const t of targetInfos) {
    if (t.type !== 'page') continue
    try {
      const sessionId = await cdp.attach(t.targetId)
      const r = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: 'JSON.stringify({al:screen.availLeft,at:screen.availTop,ah:screen.availHeight})',
        returnByValue: true,
      }, sessionId)
      if (r.result?.value) return JSON.parse(r.result.value)
    } catch { /* next page */ }
  }
  return { al: 0, at: 25, ah: 900 }
}

/**
 * "Background stays full-speed" — CORNER COLLAPSE.
 *
 * Verified on macOS (Chrome 152): hidden pages pause native rAF and nothing
 * launchable changes that; but Chrome only clamps window moves when the
 * window would be FULLY offscreen. Leaving a 2px sliver on-screen is allowed
 * and Chromium still treats the window as visible: native rAF at 60fps,
 * real screenshots, document.visibilityState === 'visible' — everything
 * works as if the window were in front, while occupying a 2px corner.
 *
 * Secondary layer for pages the USER minimized (true hidden): the health
 * monitor injects a rAF shim (16ms timer fallback) and the frame pump forces
 * occasional real frames via fromSurface:false captures.
 */
export class FramePumpSupervisor {
  private timer: NodeJS.Timeout | null = null
  private pumps = new Map<string, { cdp: Cdp; sessionId: string; running: boolean; strikes: number }>()
  private pumpCooldown = new Map<string, number>()
  private ticking = false
  humanMode = false
  /** Last user intent: every collapse/restore starts a generation; slower
   * in-flight work checks it before each delayed step so a newer intent wins. */
  private controlGeneration = 0
  private collapsed = new Map<number, { left: number; top: number; wasMinimized: boolean }>()
  private getContext: () => { cdp: Cdp } | null
  private getHealth: () => TargetHealth[]

  constructor(getContext: () => { cdp: Cdp } | null, getHealth: () => TargetHealth[]) {
    this.getContext = getContext
    this.getHealth = getHealth
  }

  start(tickMs = 500) {
    this.stop()
    this.timer = setInterval(() => void this.tick(), tickMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const targetId of [...this.pumps.keys()]) this.stopPump(targetId)
  }

  private settings = () => loadSettings()

  async tick(): Promise<void> {
    if (this.ticking) return
    const ctx = this.getContext()
    if (!ctx || !this.settings().backgroundMode) return
    this.ticking = true
    try {
      const { cdp } = ctx
      const wanted = new Set(
        this.getHealth()
          .filter(t => t.visibility !== 'visible' && !t.url.includes('/controller'))
          .map(t => t.targetId),
      )
      for (const [targetId, pump] of this.pumps) {
        if (!wanted.has(targetId) || pump.cdp !== cdp) this.stopPump(targetId)
      }
      for (const targetId of wanted) {
        const cooldown = this.pumpCooldown.get(targetId) ?? 0
        if (Date.now() < cooldown) continue
        if (!this.pumps.has(targetId)) this.startPump(targetId)
      }
    } catch (err) {
      debug(`pump tick failed: ${(err as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  private startPump(targetId: string) {
    const ctx = this.getContext()
    if (!ctx) return
    const fps = Math.max(1, Math.min(30, this.settings().pumpFps))
    const entry = { cdp: ctx.cdp, sessionId: '', running: true, strikes: 0 }
    this.pumps.set(targetId, entry)
    void (async () => {
      try {
        entry.sessionId = await ctx.cdp.attach(targetId)
        log(`frame pump started for hidden target ${targetId.slice(0, 8)} @${fps}fps`)
        const interval = 1000 / fps
        while (entry.running && this.pumps.get(targetId) === entry) {
          const t0 = Date.now()
          // fromSurface:false works for true-minimized windows (fromSurface
          // deadlocks on heavy hidden pages); races a timeout as a guard.
          await Promise.race([
            entry.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 10, fromSurface: false }, entry.sessionId),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('capture timeout')), 8000)),
          ]).then(() => { entry.strikes = 0 }).catch((err) => {
            entry.strikes++
            debug(`pump capture failed (${entry.strikes} strikes): ${(err as Error).message}`)
            // after 3 consecutive failures give the target a 30s cooldown —
            // some minimized pages simply refuse captures
            if (entry.strikes >= 3) {
              this.stopPump(targetId)
              this.pumpCooldown.set(targetId, Date.now() + 30_000)
              return
            }
          })
          if (!entry.running) break
          const spent = Date.now() - t0
          if (spent < interval) await new Promise(r => setTimeout(r, interval - spent))
        }
      } catch (err) {
        debug(`pump for ${targetId.slice(0, 8)} died: ${(err as Error).message}`)
        this.stopPump(targetId)
      }
    })()
  }

  private stopPump(targetId: string) {
    const pump = this.pumps.get(targetId)
    if (!pump) return
    this.pumps.delete(targetId)
    pump.running = false
    debug(`frame pump stopped for ${targetId.slice(0, 8)}`)
  }

  pumpTargetIds(): string[] {
    return [...this.pumps.keys()]
  }

  /** Start a new user-intent generation. Older in-flight collapses see their
   * generation go stale and stop before the next delayed step. */
  beginControl(): number {
    return ++this.controlGeneration
  }

  isControlCurrent(gen: number): boolean {
    return gen === this.controlGeneration
  }

  /** Collapse: 'minimize' mode (default) = native minimize (dock-click restores
   * natively; capture keep-alive keeps pages fast). 'corner' = 2px sliver. */
  async collapseAll(appHidden = false, gen: number = this.beginControl()): Promise<number> {
    this.humanMode = false
    const ctx = this.getContext()
    if (!ctx) return 0
    let n = 0
    const mode = this.settings().collapseMode
    for (const windowId of await this.collectWindowIds()) {
      if (!this.isControlCurrent(gen)) break
      try {
        const ok = mode === 'minimize'
          ? await this.minimizeWindow(ctx.cdp, windowId, appHidden, gen)
          : await this.cornerWindow(ctx.cdp, windowId)
        if (ok) n++
      } catch { /* gone */ }
    }
    if (!this.isControlCurrent(gen)) {
      debug('collapse superseded by a newer control request')
      return 0
    }
    log(`collapsed ${n} window(s) (${mode}); pages keep running at full speed`)
    return n
  }

  /**
   * Native minimize, verified. macOS quirks measured on Chrome for Testing 153:
   * - a minimize request issued while the window leaves maximized/fullscreen is
   *   dropped, so settle to normal and wait for that state first;
   * - when the app is hidden (`open -g -j` background launches), the reported
   *   window state can claim "minimized" while AppKit never really miniaturized
   *   (the active tab keeps `document.hidden === false`). A full
   *   normal -> minimized cycle repairs it, and the cycle has to run twice
   *   (measured: one cycle fails, two succeed). `settleRepeat` (hidden apps)
   *   therefore forces the recovery cycle even when the initial report is
   *   already "minimized" — a repeated `/api/bg` must still repair it.
   * `gen` invalidates delayed steps when a newer control request arrives.
   * Returns false if the window is gone, superseded, or never minimized.
   */
  async minimizeWindow(cdp: Cdp, windowId: number, settleRepeat = false, gen?: number): Promise<boolean> {
    const current = () => gen === undefined || this.isControlCurrent(gen)
    const cycles = settleRepeat ? 2 : 1
    for (let cycle = 0; cycle < cycles; cycle++) {
      if (!current()) return false
      const initial = await this.windowBounds(cdp, windowId)
      if (initial === null) return false
      if (!settleRepeat && initial.windowState === 'minimized') return true
      // Settling to normal is required both to leave maximized/fullscreen and
      // to repair a falsely reported minimized state on a hidden app.
      if (initial.windowState !== 'normal') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
        for (let i = 0; i < 20; i++) {
          const b = await this.windowBounds(cdp, windowId)
          if (b === null) return false
          if (b.windowState === 'normal') break
          await sleep(50)
        }
        await sleep(300)
      }
      if (!current()) return false
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {})
      for (let i = 0; i < 20; i++) {
        const b = await this.windowBounds(cdp, windowId)
        if (b === null) return false
        if (b.windowState === 'minimized') break
        await sleep(50)
      }
      if (!current()) return false
      if (cycle + 1 < cycles) await sleep(500)
    }
    const final = await this.windowBounds(cdp, windowId)
    if (final?.windowState !== 'minimized') debug(`window ${windowId}: minimize did not stick`)
    return final?.windowState === 'minimized'
  }

  private async windowBounds(cdp: Cdp, windowId: number): Promise<{ windowState?: string } | null> {
    try {
      const { bounds } = await cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
      return bounds
    } catch {
      return null
    }
  }

  /** Move one window to the offscreen corner. Returns true if moved. */
  async cornerWindow(cdp: Cdp, windowId: number): Promise<boolean> {
    try {
      const { bounds } = await cdp.send<{ bounds: any }>('Browser.getWindowBounds', { windowId })
      if (this.collapsed.has(windowId)) return true
      const wa = await readWorkArea(cdp)
      const width = bounds.width ?? 1200
      const orig = { left: bounds.left ?? wa.al, top: bounds.top ?? wa.at, wasMinimized: (bounds.windowState ?? 'normal') === 'minimized' }
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height: bounds.height ?? 800 } })
      const left = wa.al - (width - OFFSCREEN_MARGIN)
      const top = wa.at + wa.ah - OFFSCREEN_MARGIN
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top } })
      this.collapsed.set(windowId, orig)
      log(`window ${windowId}: collapsed to corner (left=${left}, top=${top}, page keeps native full-speed)`)
      return true
    } catch (err) {
      debug(`cornerWindow(${windowId}) failed: ${(err as Error).message}`)
      return false
    }
  }

  /** Bring collapsed windows back: 'minimize' mode un-minimizes everything
   * (native dock-click semantics); 'corner' mode restores cornered positions. */
  async restoreAll(maximize = false): Promise<number> {
    this.beginControl() // newer intent: any in-flight collapse must stop
    const ctx = this.getContext()
    if (!ctx) return 0
    this.humanMode = true
    const wa = await readWorkArea(ctx.cdp)
    let n = 0
    for (const windowId of await this.collectWindowIds()) {
      try {
        const { bounds } = await ctx.cdp.send<{ bounds: any }>('Browser.getWindowBounds', { windowId })
        const orig = this.collapsed.get(windowId)
        const offscreen = bounds.left + bounds.width <= wa.al + 40 || bounds.top >= wa.at + wa.ah - 40
        if (bounds.windowState === 'minimized' || orig || offscreen || maximize) {
          await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
          if (orig || offscreen) {
            const left = orig?.left ?? bounds.left
            const top = orig?.top ?? bounds.top
            await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: {
              left: left + bounds.width <= wa.al + 40 ? wa.al + 40 : left,
              top: top >= wa.at + wa.ah - 40 ? wa.at + 40 : top,
            } })
          }
          if (maximize) await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } })
          this.collapsed.delete(windowId)
          n++
        }
      } catch (err) { debug(`restore window ${windowId}: ${(err as Error).message}`) }
    }
    log(`restored ${n} window(s)`)
    return n
  }

  async windowStates(): Promise<WindowStateInfo[]> {
    const ctx = this.getContext()
    if (!ctx) return []
    const out: WindowStateInfo[] = []
    for (const windowId of await this.collectWindowIds()) {
      try {
        const { bounds } = await ctx.cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
        out.push({ windowId, state: bounds.windowState ?? 'normal', cornered: this.collapsed.has(windowId) })
      } catch { /* gone */ }
    }
    return out
  }

  private async collectWindowIds(): Promise<number[]> {
    const ctx = this.getContext()
    if (!ctx) return []
    const { targetInfos } = await ctx.cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
      'Target.getTargets',
    )
    const ids = new Set<number>()
    for (const t of targetInfos) {
      if (t.type !== 'page') continue
      try {
        const { windowId } = await ctx.cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: t.targetId })
        ids.add(windowId)
      } catch { /* target without window */ }
    }
    return [...ids]
  }
}
