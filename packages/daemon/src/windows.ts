import type { Cdp } from './cdp.ts'
import type { TargetHealth } from './inject.ts'
import { loadSettings } from './store.ts'
import { debug, log } from './log.ts'
import type { TransitionEntry } from './state-log.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export interface WindowStateInfo {
  windowId: number
  state: string
  cornered: boolean
}

export interface WorkArea { al: number; at: number; ah: number }

/** Who caused an operation. `explicit` requires a caller-provided source label;
 * `auto` is an OS/tray reconciliation; `internal` is daemon-internal work;
 * `unknown` means no evidence was provided — never silently treated as human. */
export type IntentOrigin = 'explicit' | 'auto' | 'internal' | 'unknown'

/** Explicit user/AI control intent. `bg` means "collapse and stay back" and is
 * the anchor for rejecting tray auto-show requests that are really reactions
 * to internal (capture-picker) native activation. */
export interface ControlIntent {
  kind: 'bg' | 'show'
  origin: IntentOrigin
  /** unique token correlating every transition produced by this intent */
  token: string
  /** true until the operation applying the intent finishes (applied/failed) */
  pending: boolean
  source?: string
  route?: string
  requestId?: string
  gen: number
  at: number
  /** internal native-activity sequence at the moment this intent was set */
  internalSeq: number
}

/** Correlation fields copied onto each transition; empty fields mean the
 * evidence was absent (origin `unknown`), never an invented source. */
export interface IntentRef {
  origin: IntentOrigin
  token?: string
  source?: string
  route?: string
  requestId?: string
  gen?: number
}

interface InternalWindow {
  kind: string
  seq: number
  from: number
  to: number | null
}

export interface IntentMeta {
  source?: string
  route?: string
  requestId?: string
}

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
  /** optional privacy-safe state-transition sink (wired to StateTransitionLog) */
  onTransition: ((entry: TransitionEntry) => void) | null = null
  /** last explicit control intent; auto-show requests may not override 'bg' */
  private intentRecord: ControlIntent | null = null
  /** every intent (any origin) keyed by its control generation, for correlation */
  private intents = new Map<number, ControlIntent>()
  private intentSeq = 0
  private internalSeq = 0
  private internalWindows: InternalWindow[] = []

  constructor(getContext: () => { cdp: Cdp } | null, getHealth: () => TargetHealth[]) {
    this.getContext = getContext
    this.getHealth = getHealth
  }

  private transition(entry: Omit<TransitionEntry, 'at'> & { at?: number }): void {
    try { this.onTransition?.({ at: entry.at ?? Date.now(), ...entry }) } catch { /* logging is best effort */ }
  }

  /** Intent correlation fields for transitions of `gen`; absent evidence stays absent. */
  private refFields(gen?: number): { origin: string; token?: string; source?: string; route?: string; requestId?: string } {
    const ref = this.intentRef(gen)
    return { origin: ref.origin, token: ref.token, source: ref.source, route: ref.route, requestId: ref.requestId }
  }

  /**
   * Record an intent with an explicit origin. Only `explicit` intents become
   * the anchor for the auto-show gate; `auto`/`unknown` operations are logged
   * but never silently promoted to human intent.
   */
  noteIntent(origin: IntentOrigin, kind: 'bg' | 'show', meta: IntentMeta & { gen?: number } = {}): ControlIntent {
    const gen = meta.gen ?? this.controlGeneration
    const intent: ControlIntent = {
      kind,
      origin,
      token: `i${++this.intentSeq}`,
      pending: true,
      source: meta.source,
      route: meta.route,
      requestId: meta.requestId,
      gen,
      at: Date.now(),
      internalSeq: this.internalSeq,
    }
    this.intents.set(gen, intent)
    while (this.intents.size > 32) {
      const oldest = this.intents.keys().next().value
      if (oldest === undefined || oldest === gen) break
      this.intents.delete(oldest)
    }
    if (origin === 'explicit') {
      // Last explicit intent wins: a previous explicit intent that never
      // completed (e.g. its route threw before completing) must not keep
      // blocking auto reconciliation forever.
      const previous = this.intentRecord
      if (previous && previous.pending && previous.token !== intent.token) {
        this.completeIntent(previous.token, 'superseded')
      }
      this.intentRecord = intent
    }
    this.transition({
      event: 'control-intent',
      branch: kind,
      origin,
      token: intent.token,
      source: intent.source,
      route: intent.route,
      requestId: intent.requestId,
      gen,
    })
    return intent
  }

  /** Explicit user/AI action (menu/CLI/dashboard/launcher). */
  noteExplicitIntent(kind: 'bg' | 'show', meta: IntentMeta & { gen?: number } = {}): ControlIntent {
    return this.noteIntent('explicit', kind, meta)
  }

  /** Mark an intent's operation finished so it stops blocking auto-show. */
  completeIntent(token: string, outcome: 'applied' | 'failed' | 'superseded'): void {
    for (const intent of this.intents.values()) {
      if (intent.token !== token) continue
      intent.pending = false
      this.transition({
        event: 'control-intent',
        branch: 'complete',
        origin: intent.origin,
        token,
        source: intent.source,
        route: intent.route,
        requestId: intent.requestId,
        gen: intent.gen,
        after: outcome,
      })
      return
    }
  }

  /** Correlation fields for one generation; missing evidence stays missing. */
  intentRef(gen?: number): IntentRef {
    if (gen !== undefined) {
      const found = this.intents.get(gen)
      if (found) {
        return {
          origin: found.origin,
          token: found.token,
          source: found.source,
          route: found.route,
          requestId: found.requestId,
          gen,
        }
      }
    }
    return { origin: 'unknown', gen }
  }

  lastIntent(): ControlIntent | null {
    return this.intentRecord
  }

  controlGen(): number {
    return this.controlGeneration
  }

  /**
   * Native activation/unhide the daemon performs for itself (capture picker,
   * controller tab switch, re-hide after setup). Recorded as bounded intervals
   * so a tray auto-show caused by them can be attributed and rejected without
   * an arbitrary suppression timer.
   */
  beginInternalActivity(kind: string): number {
    this.internalSeq++
    this.internalWindows.push({ kind, seq: this.internalSeq, from: Date.now(), to: null })
    if (this.internalWindows.length > 16) this.internalWindows.shift()
    this.transition({ event: 'internal-native', branch: 'begin', origin: 'internal', detail: kind, gen: this.controlGeneration })
    return this.internalSeq
  }

  endInternalActivity(kind: string): void {
    for (let i = this.internalWindows.length - 1; i >= 0; i--) {
      const window = this.internalWindows[i]!
      if (window.kind === kind && window.to === null) {
        window.to = Date.now()
        this.transition({ event: 'internal-native', branch: 'end', origin: 'internal', detail: kind, gen: this.controlGeneration })
        return
      }
    }
  }

  /** Most recent internal native-activity interval (open or closed). */
  internalState(): { active: boolean; kind?: string; from?: number; to?: number } | null {
    const last = this.internalWindows.at(-1)
    if (!last) return null
    return { active: last.to === null, kind: last.kind, from: last.from, to: last.to ?? undefined }
  }

  /** True when `at` falls inside (or just after the end of) an internal native
   * activity interval. The small margin covers the notification delivery
   * delay between the activation and the tray's observer callback. */
  isInternalActivationAt(at: number, marginMs = 250): boolean {
    for (let i = this.internalWindows.length - 1; i >= 0; i--) {
      const window = this.internalWindows[i]!
      if (at >= window.from - marginMs && at <= (window.to ?? Date.now()) + marginMs) return true
      if (window.to !== null && at > window.to + marginMs) break
    }
    return false
  }

  /** Auto-show from the tray may not override a recent explicit bg when the
   * activation it reacts to was generated by daemon-internal capture work, and
   * it may never supersede an explicit intent that is still being applied. */
  autoShowSkipReason(observedAt: number): 'internal-activation' | 'explicit-in-flight' | null {
    const record = this.intentRecord
    if (!record) return null
    if (record.origin === 'explicit' && record.pending) return 'explicit-in-flight'
    if (record.kind !== 'bg') return null
    return this.isInternalActivationAt(observedAt) ? 'internal-activation' : null
  }

  shouldIgnoreAutoShow(observedAt: number): boolean {
    return this.autoShowSkipReason(observedAt) !== null
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
          : await this.cornerWindow(ctx.cdp, windowId, gen)
        if (ok) n++
      } catch (err) {
        this.transition({
          event: 'window-minimize', windowId, gen, ...this.refFields(gen),
          after: 'error', branch: 'error', detail: (err as Error).message,
        })
      }
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
    const ref = this.refFields(gen)
    const current = () => gen === undefined || this.isControlCurrent(gen)
    const cycles = settleRepeat ? 2 : 1
    let before: string | undefined
    for (let cycle = 0; cycle < cycles; cycle++) {
      if (!current()) return false
      const initial = await this.windowBounds(cdp, windowId)
      if (initial === null) {
        this.transition({ event: 'window-minimize', windowId, gen, ...ref, before, after: 'gone', branch: 'unreadable' })
        return false
      }
      if (before === undefined) before = initial.windowState ?? 'unknown'
      if (!settleRepeat && initial.windowState === 'minimized') return true
      // Record the requested transition BEFORE any side effect so a maximize /
      // minimize observed in WindowServer can always be traced to an intent.
      this.transition({
        event: 'window-minimize', windowId, gen, ...ref, before,
        branch: 'requested',
      })
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
    const minimized = final?.windowState === 'minimized'
    this.transition({
      event: 'window-minimize', windowId, gen, ...ref, before, after: final?.windowState ?? 'unreadable',
      branch: !current() ? 'superseded' : minimized ? (settleRepeat ? 'settle-repeat' : 'single') : 'not-stuck',
    })
    return minimized
  }

  private async windowBounds(cdp: Cdp, windowId: number): Promise<{ windowState?: string } | null> {
    try {
      const { bounds } = await cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
      return bounds
    } catch {
      return null
    }
  }

  /**
   * Maximize a window that may have just left minimized state. CDP rejects
   * `maximized` while the window is still minimized ("restore it to normal
   * state first"), so wait for the normal transition to apply, then verify the
   * result. Bounded; returns false (and does not send maximize) when normal
   * never arrives, and false when the maximize did not stick.
   */
  private async maximizeWindow(cdp: Cdp, windowId: number): Promise<boolean> {
    let state: string | null = null
    for (let i = 0; i < 20; i++) {
      const bounds = await this.windowBounds(cdp, windowId)
      if (bounds === null) return false
      state = bounds.windowState ?? null
      if (state === 'normal') break
      await sleep(50)
    }
    if (state !== 'normal') {
      debug(`window ${windowId}: still ${state ?? 'unknown'} after waiting for normal; maximize skipped`)
      return false
    }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }).catch(() => {})
    for (let i = 0; i < 20; i++) {
      const bounds = await this.windowBounds(cdp, windowId)
      if (bounds === null) return false
      if (bounds.windowState === 'maximized') return true
      await sleep(50)
    }
    debug(`window ${windowId}: maximize did not stick`)
    return false
  }

  /** Move one window to the offscreen corner. Returns true if moved. */
  async cornerWindow(cdp: Cdp, windowId: number, gen?: number): Promise<boolean> {
    const ref = this.refFields(gen)
    try {
      const { bounds } = await cdp.send<{ bounds: any }>('Browser.getWindowBounds', { windowId })
      if (this.collapsed.has(windowId)) return true
      const wa = await readWorkArea(cdp)
      const width = bounds.width ?? 1200
      const orig = { left: bounds.left ?? wa.al, top: bounds.top ?? wa.at, wasMinimized: (bounds.windowState ?? 'normal') === 'minimized' }
      this.transition({
        event: 'window-corner', windowId, gen, ...ref,
        before: orig.wasMinimized ? 'minimized' : 'normal', branch: 'requested',
      })
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height: bounds.height ?? 800 } })
      const left = wa.al - (width - OFFSCREEN_MARGIN)
      const top = wa.at + wa.ah - OFFSCREEN_MARGIN
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top } })
      this.collapsed.set(windowId, orig)
      this.transition({ event: 'window-corner', windowId, gen, ...ref, before: orig.wasMinimized ? 'minimized' : 'normal', after: 'cornered', branch: 'corner' })
      log(`window ${windowId}: collapsed to corner (left=${left}, top=${top}, page keeps native full-speed)`)
      return true
    } catch (err) {
      this.transition({
        event: 'window-corner', windowId, gen, ...ref,
        after: 'error', branch: 'error', detail: (err as Error).message,
      })
      debug(`cornerWindow(${windowId}) failed: ${(err as Error).message}`)
      return false
    }
  }

  /** Bring collapsed windows back: 'minimize' mode un-minimizes everything
   * (native dock-click semantics); 'corner' mode restores cornered positions. */
  async restoreAll(maximize = false, gen: number = this.beginControl()): Promise<number> {
    if (!this.isControlCurrent(gen)) return 0
    const ctx = this.getContext()
    if (!ctx) return 0
    this.humanMode = true
    const ref = this.refFields(gen)
    const wa = await readWorkArea(ctx.cdp)
    let n = 0
    for (const windowId of await this.collectWindowIds()) {
      if (!this.isControlCurrent(gen)) break
      try {
        const { bounds } = await ctx.cdp.send<{ bounds: any }>('Browser.getWindowBounds', { windowId })
        const orig = this.collapsed.get(windowId)
        const offscreen = bounds.left + bounds.width <= wa.al + 40 || bounds.top >= wa.at + wa.ah - 40
        const before = bounds.windowState ?? 'normal'
        if (bounds.windowState === 'minimized' || orig || offscreen || maximize) {
          // Log the requested restore before any side effect; the applied /
          // not-restored / superseded entry follows the actual outcome.
          this.transition({ event: 'window-restore', windowId, gen, ...ref, before, branch: 'requested' })
          await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
          if (orig || offscreen) {
            const left = orig?.left ?? bounds.left
            const top = orig?.top ?? bounds.top
            await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: {
              left: left + bounds.width <= wa.al + 40 ? wa.al + 40 : left,
              top: top >= wa.at + wa.ah - 40 ? wa.at + 40 : top,
            } })
          }
          let restored = true
          if (maximize) restored = await this.maximizeWindow(ctx.cdp, windowId)
          // A newer intent may have superseded us during the bounded maximize
          // wait; never count a stale restore.
          if (!this.isControlCurrent(gen)) {
            this.transition({ event: 'window-restore', windowId, gen, ...ref, before, after: 'superseded', branch: 'maximize-wait' })
            break
          }
          this.collapsed.delete(windowId)
          if (restored) {
            n++
            this.transition({ event: 'window-restore', windowId, gen, ...ref, before, after: maximize ? 'maximized' : 'normal', branch: maximize ? 'maximize' : 'unminimize' })
          } else {
            this.transition({ event: 'window-restore', windowId, gen, ...ref, before, after: 'not-restored', branch: 'maximize' })
          }
        }
      } catch (err) {
        this.transition({
          event: 'window-restore', windowId, gen, ...ref,
          after: 'error', branch: 'error', detail: (err as Error).message,
        })
        debug(`restore window ${windowId}: ${(err as Error).message}`)
      }
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
