import type { Cdp } from './cdp.ts'
import type { TargetHealth } from './inject.ts'
import { loadSettings } from './store.ts'
import { debug, log } from './log.ts'

export interface WindowStateInfo {
  windowId: number
  state: string
  pumped: boolean
}

/**
 * "Background stays full-speed" mechanism — FRAME PUMP.
 *
 * Verified on macOS (Chrome 152): no flag or window trick keeps rAF running
 * for hidden pages — minimized/occluded/background tabs pause rAF, and
 * Browser.setWindowBounds cannot move a window offscreen (Chrome clamps it).
 * What DOES work: Page.captureScreenshot forces BeginFrames, which drives
 * rAF. A ~10fps capture pump on hidden targets keeps them rendering at
 * ~40-45 rAF/s while the window stays 100% native (minimized is fine).
 *
 * Flags handle timers (--disable-background-timer-throttling etc.); the pump
 * handles frames. Hidden = anything whose visibilityState is not "visible":
 * minimized windows, fully occluded windows, background tabs.
 */
export class FramePumpSupervisor {
  private timer: NodeJS.Timeout | null = null
  private pumps = new Map<string, { cdp: Cdp; sessionId: string; running: boolean }>()
  private ticking = false
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

  async tick(): Promise<void> {
    if (this.ticking) return
    const ctx = this.getContext()
    if (!ctx || !loadSettings().backgroundMode) return
    this.ticking = true
    try {
      const { cdp } = ctx
      const wanted = new Set(
        this.getHealth()
          .filter(t => t.visibility !== 'visible')
          .map(t => t.targetId),
      )
      for (const [targetId, pump] of this.pumps) {
        if (!wanted.has(targetId) || pump.cdp !== cdp) this.stopPump(targetId)
      }
      for (const targetId of wanted) {
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
    const settings = loadSettings()
    const fps = Math.max(1, Math.min(30, settings.pumpFps))
    const entry = { cdp: ctx.cdp, sessionId: '', running: true }
    this.pumps.set(targetId, entry)
    void (async () => {
      try {
        entry.sessionId = await ctx.cdp.attach(targetId)
        log(`frame pump started for hidden target ${targetId.slice(0, 8)} @${fps}fps`)
        const interval = 1000 / fps
        while (entry.running && this.pumps.get(targetId) === entry) {
          const t0 = Date.now()
          await entry.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }, entry.sessionId).catch(async (err) => {
            debug(`pump capture failed: ${(err as Error).message}`)
            this.stopPump(targetId)
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

  /** Minimize every window natively ("collapse to background"; pump keeps them fast). */
  async collapseAll(): Promise<number> {
    const ctx = this.getContext()
    if (!ctx) return 0
    let n = 0
    for (const windowId of await this.collectWindowIds()) {
      try {
        await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
        n++
      } catch { /* gone */ }
    }
    log(`collapsed ${n} window(s); frame pump keeps pages at speed`)
    return n
  }

  /** Restore every minimized window. */
  async restoreAll(): Promise<number> {
    const ctx = this.getContext()
    if (!ctx) return 0
    let n = 0
    for (const windowId of await this.collectWindowIds()) {
      try {
        const { bounds } = await ctx.cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
        if ((bounds.windowState ?? 'normal') === 'minimized') {
          await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
          n++
        }
      } catch { /* gone */ }
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
        out.push({ windowId, state: bounds.windowState ?? 'normal', pumped: this.pumps.size > 0 })
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
