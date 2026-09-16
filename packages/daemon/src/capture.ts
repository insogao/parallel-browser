import type { Cdp } from './cdp.ts'
import type { TargetHealth } from './inject.ts'
import { loadSettings } from './store.ts'
import { debug, log, warn } from './log.ts'
import type { TransitionEntry } from './state-log.ts'

export const CAPTURE_TITLE = 'BACKLIGHT_AGENT'

interface ActiveCapture {
  targetId: string
  /**
   * true when the capture was armed while its window was visible. Chrome only
   * establishes the capture frame source (real frames, screenshots) in that
   * case; arming while hidden grants the rAF exemption but yields no frames,
   * so a later pre-arm rotates to a visible-armed capture.
   */
  visibleAtArm: boolean
}

interface CapturePage {
  targetId: string
  sessionId: string
  cdp: Cdp
}

export interface CaptureKeepAliveContext {
  cdp: Cdp
  /**
   * chrome-extension://<id>/capture.html when the bundled helper extension is
   * loaded; null when the engine cannot load extensions (capture stays off).
   */
  capturePageUrl: string | null
  pid: number
}

export interface CaptureKeepAliveDeps {
  /** privacy-safe state-transition sink */
  onTransition?: (entry: Omit<TransitionEntry, 'at'> & { at?: number }) => void
}

/**
 * Layer-1 keep-alive: tab capture → CapturerCount exemption.
 *
 * A captured WebContents reports PageVisibilityState kVisible even when its
 * window is minimized: native 60fps rAF, real screenshots, honest
 * visibilityState — on stock Chrome, no fork.
 *
 * The capture is requested by a hidden extension page
 * (chrome.tabCapture.getMediaStreamId + getUserMedia chromeMediaSource:'tab'),
 * not by getDisplayMedia: on macOS the latter is hard-gated to a VISIBLE
 * WebContents (DisplayMediaAccessHandler →
 * CAPTURE_FROM_BACKGROUND_PAGE_ON_MAC / InvalidStateError) and its Views picker
 * activates the app and orders the window on screen, so it can never satisfy
 * "explicit bg stays invisible". The extension path performs no window or app
 * visibility operation at all; the helper extension is allowlisted so the
 * managed page never needs a user invocation.
 *
 * One capture at a time (single magic title); other hidden targets fall back
 * to the frame pump / rAF shim layers.
 */
export class CaptureKeepAlive {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private cdp: Cdp | null = null
  private generation = 0
  private active: ActiveCapture | null = null
  private capturePage: CapturePage | null = null
  private targetSessions = new Map<string, string>()
  /** consecutive hidden samples per target — guards against visibility flicker */
  private hiddenStreak = new Map<string, number>()
  private failures = 0
  private cooldownUntil = 0
  private disabled = false
  private paused = false
  private getContext: () => CaptureKeepAliveContext | null
  private getHealth: () => TargetHealth[]
  private deps: CaptureKeepAliveDeps

  constructor(
    getContext: () => CaptureKeepAliveContext | null,
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

  isPaused(): boolean {
    return this.paused
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused
    if (paused) this.generation++
    // Finish any in-flight setup before showing a user window; the flag also
    // prevents a new capture from being armed during takeover. Setup never
    // touches window/app visibility, so a bounded wait is all that is needed.
    const deadline = Date.now() + 2500
    while (paused && this.ticking && Date.now() < deadline) await sleep(50)
  }

  /**
   * Arm (or rotate) the capture while the target window is still visible.
   *
   * Called by /api/bg BEFORE the collapse: Chrome only establishes the capture
   * frame source when arming happens with a visible window. Arming after
   * minimization still exempts rAF but produces no frames (CDP screenshots
   * hang), so the explicit-bg path pre-arms here and the later minimize needs
   * no capture engagement at all. The operation itself is invisible (hidden
   * extension page, no activation), so it adds no pop-up.
   */
  async prearm(): Promise<string | null> {
    this.syncContext()
    if (this.ticking || this.disabled || this.paused) return this.active?.targetId ?? null
    const ctx = this.getContext()
    if (!ctx?.capturePageUrl || !loadSettings().captureKeepAlive) return this.active?.targetId ?? null
    const wanted = this.getHealth().find(t => t.visibility === 'visible' && this.isCapturable(t, ctx))
    if (!wanted) return this.active?.targetId ?? null
    // a visible-armed capture for the same target already has frames; a
    // hidden-armed one must be rotated while the window is visible
    if (this.active?.targetId === wanted.targetId && this.active.visibleAtArm) return wanted.targetId
    this.ticking = true
    try {
      if (this.active) await this.release('pre-arm rotate')
      await this.engage(wanted, true)
    } catch (err) {
      debug(`capture pre-arm failed: ${(err as Error).message}`)
    } finally {
      this.ticking = false
    }
    return this.active?.targetId ?? null
  }

  async tick(): Promise<void> {
    this.syncContext()
    if (this.ticking || this.disabled || this.paused) return
    const ctx = this.getContext()
    if (!ctx || !ctx.capturePageUrl || !loadSettings().captureKeepAlive) return
    this.ticking = true
    try {
      // once engaged, a capture lives for the whole session: the exemption it
      // grants is exactly what we want, and re-arming is expensive
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
      const candidates = this.getHealth().filter(t =>
        t.visibility !== 'visible' && this.isCapturable(t, ctx) && (this.hiddenStreak.get(t.targetId) ?? 0) >= 2)
      if (candidates.length === 0) return
      await this.engage(candidates[0], false)
    } catch (err) {
      debug(`capture tick failed: ${(err as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  /** Targets that may consume the single capture slot (never internal pages). */
  private isCapturable(target: TargetHealth, ctx: CaptureKeepAliveContext): boolean {
    if (this.capturePage && target.targetId === this.capturePage.targetId) return false
    if (ctx.capturePageUrl && target.url.startsWith(ctx.capturePageUrl)) return false
    if (target.url.includes('/controller')) return false
    if (target.url.startsWith('about:blank') || target.title === '' || target.title === CAPTURE_TITLE) return false
    // only real web pages: never waste the (single) capture on internal pages
    if (/^(chrome|chrome-extension|devtools|about|view-source|bl-controller):/i.test(target.url)) return false
    return true
  }

  /** All state below belongs to one browser connection, even after failures. */
  private syncContext() {
    const cdp = this.getContext()?.cdp ?? null
    if (cdp === this.cdp) return
    this.cdp = cdp
    this.generation++
    this.active = null
    this.capturePage = null
    this.targetSessions.clear()
    this.hiddenStreak.clear()
    this.failures = 0
    this.cooldownUntil = 0
    this.disabled = false
  }

  private async send<T = any>(
    cdp: Cdp,
    method: string,
    params: Record<string, unknown> = {},
    session?: string,
    ms = 1500,
  ): Promise<T> {
    return bounded(cdp.send<T>(method, params, session), ms)
  }

  private transition(entry: Omit<TransitionEntry, 'at'> & { at?: number }): void {
    try { this.deps.onTransition?.({ at: entry.at ?? Date.now(), ...entry }) } catch { /* logging is best effort */ }
  }

  /**
   * Arm the capture through the hidden helper-extension page. This performs no
   * window or app-visibility operation: the page is a background target, the
   * extension API needs no invocation (allowlisted id) and no picker window is
   * created. Explicit bg therefore stays invisible while the captured page
   * keeps native compositor frames.
   */
  private async engage(target: TargetHealth, visibleAtArm: boolean): Promise<void> {
    const ctx = this.getContext()
    if (!ctx?.capturePageUrl) return
    const { cdp } = ctx
    const generation = this.generation
    const current = () => this.getContext()?.cdp === cdp && !cdp.closed
    const allowed = () => current() && !this.paused && this.generation === generation
    const check = () => { if (!allowed()) throw new Error('capture setup aborted') }
    const cur = this.getHealth().find(t => t.targetId === target.targetId)
    if (!cur) return
    this.transition({ event: 'capture-engage', origin: 'internal', source: 'capture', branch: visibleAtArm ? 'pre-arm' : 'picked' })
    let pageSession: string | null = null
    let targetSession: string | undefined
    let titleTouched = false
    let started = false
    try {
      check()
      pageSession = await this.ensureCapturePage(cdp, ctx.capturePageUrl)
      check()
      if (!pageSession) throw new Error('capture extension page unavailable')
      targetSession = await this.sessionFor(cdp, target.targetId)
      check()
      titleTouched = true
      // the extension finds the target tab by this magic title; it is restored
      // on failure (a successful capture keeps it until release)
      await this.send(cdp, 'Runtime.evaluate', {
        expression: `(() => { if (window.__blOrigTitle === undefined) window.__blOrigTitle = String(document.title); document.title = ${JSON.stringify(CAPTURE_TITLE)}; return document.title })()`,
      }, targetSession)
      check()
      const res = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(cdp, 'Runtime.evaluate', {
        expression: `window.startCaptureByTitle(${JSON.stringify(CAPTURE_TITLE)})`,
        returnByValue: true,
        awaitPromise: true,
      }, pageSession, 4_000)
      check()
      if (res.exceptionDetails || !['ok', 'already'].includes(String(res.result?.value))) {
        throw new Error(`capture did not start (${String(res.result?.value ?? 'exception')})`)
      }
      const live = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(cdp, 'Runtime.evaluate', {
        expression: 'window.captureLive()', returnByValue: true,
      }, pageSession)
      check()
      if (live.exceptionDetails || live.result?.value !== true) throw new Error('capture stream is not live')
      started = true
      this.active = { targetId: target.targetId, visibleAtArm }
      this.failures = 0
      this.transition({
        event: 'capture-started', origin: 'internal', source: 'capture', pid: ctx.pid,
        branch: visibleAtArm ? 'extension-tab-capture-visible' : 'extension-tab-capture-hidden',
      })
      log(`capture keep-alive engaged for ${target.targetId.slice(0, 8)} via hidden extension page (no window activation${visibleAtArm ? ', armed while visible: real frames' : ''})`)
    } catch (err) {
      if (allowed()) {
        this.transition({ event: 'capture-failed', origin: 'internal', source: 'capture', pid: ctx.pid, branch: 'setup-error' })
        this.noteFailure(`capture keep-alive failed: ${(err as Error).message}`)
      }
    } finally {
      if (!started && pageSession) await this.stopStream(cdp, pageSession)
      // the extension only needs the magic title to resolve the target tab
      if (titleTouched && targetSession) await this.restoreTitle(cdp, targetSession)
    }
  }

  /**
   * Record a capture failure, cooldown and (after three) disable keep-alive.
   * Callers must hold the control generation (allowed()) when using this.
   */
  private noteFailure(message: string): void {
    this.failures++
    this.cooldownUntil = Date.now() + 15_000
    this.disabled = this.failures >= 3
    warn(`${message}; failure #${this.failures}`)
  }

  /** Reuse or create the hidden extension page; never activates it. */
  private async ensureCapturePage(cdp: Cdp, pageUrl: string): Promise<string | null> {
    if (this.capturePage && this.capturePage.cdp === cdp) {
      try {
        const { targetInfos } = await this.send<{ targetInfos: any[] }>(cdp, 'Target.getTargets')
        const alive = targetInfos.some(t => t.targetId === this.capturePage!.targetId && t.type === 'page')
        if (alive) return this.capturePage.sessionId
      } catch { /* probe failed: recreate below */ }
      this.capturePage = null
    }
    try {
      const { targetInfos } = await this.send<{ targetInfos: any[] }>(cdp, 'Target.getTargets')
      const existing = targetInfos.find(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(pageUrl))
      let targetId = existing?.targetId
      let created = false
      if (!targetId) {
        // background: true — new tab in the managed window, no activation,
        // no window restore (verified: hidden/minimized stay untouched)
        const createdTarget = await this.send<{ targetId: string }>(cdp, 'Target.createTarget', { url: pageUrl, background: true })
        targetId = createdTarget.targetId
        created = true
      }
      const sessionId = await bounded(cdp.attach(targetId))
      this.capturePage = { targetId, sessionId, cdp }
      if (created) {
        const ready = await this.waitForCaptureReady(cdp, sessionId, () => this.getContext()?.cdp === cdp)
        if (!ready) throw new Error('capture extension page did not load')
        this.transition({ event: 'capture-page', origin: 'internal', source: 'capture', branch: 'created' })
      }
      return sessionId
    } catch (err) {
      warn(`capture extension page failed: ${(err as Error).message}`)
      return null
    }
  }

  private async waitForCaptureReady(cdp: Cdp, session: string, alive: () => boolean, attempts = 25): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (!alive()) return false
      try {
        const r = await this.send<{ result?: { value?: unknown } }>(cdp, 'Runtime.evaluate', {
          expression: `typeof window.startCaptureByTitle === 'function'`, returnByValue: true,
        }, session)
        if (r.result?.value === true) return true
      } catch { /* page still loading */ }
      await sleep(100)
    }
    return false
  }

  /**
   * Restore the page title after a setup attempt: the extension only needs the
   * magic title while it resolves the target tab, and a successful capture
   * already owns the stream. Never leave a modified title on a user page.
   */
  private async restoreTitle(cdp: Cdp, session: string) {
    await this.send(cdp, 'Runtime.evaluate', {
      expression: `(() => { if (window.__blOrigTitle !== undefined) { if (document.title === ${JSON.stringify(CAPTURE_TITLE)}) document.title = String(window.__blOrigTitle); delete window.__blOrigTitle } })()`,
    }, session).catch(() => {})
  }

  private async stopStream(cdp: Cdp, session: string) {
    await this.send(cdp, 'Runtime.evaluate', { expression: 'window.stopCapture()' }, session).catch(() => {})
  }

  private async release(reason: string): Promise<void> {
    const cdp = this.cdp
    this.active = null
    this.transition({ event: 'capture-release', origin: 'internal', source: 'capture', branch: reason })
    debug(`capture keep-alive release (${reason})`)
    const page = this.capturePage
    if (cdp && page && page.cdp === cdp) await this.stopStream(cdp, page.sessionId)
  }

  private async sessionFor(cdp: Cdp, targetId: string): Promise<string> {
    const cached = this.targetSessions.get(targetId)
    if (cached) return cached
    const sessionId = await bounded(cdp.attach(targetId))
    if (this.getContext()?.cdp === cdp) this.targetSessions.set(targetId, sessionId)
    return sessionId
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
