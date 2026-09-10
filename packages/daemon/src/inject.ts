import type { Cdp } from './cdp.ts'
import { loadSettings } from './store.ts'
import { debug } from './log.ts'

/**
 * Injected into every page: health counters (rAF / timer / visibility) and the
 * AI-command halo. Idempotent, survives navigation via periodic re-injection.
 */
/**
 * rAF shim: while the page is hidden (user minimized the window), native
 * requestAnimationFrame pauses and nothing we launch with can change that.
 * The shim redirects rAF callbacks to a 16ms timer loop (timers stay
 * unthrottled via our launch flags), so rAF-driven page logic keeps running
 * at ~60Hz. Self-gating: when the page becomes visible again it switches
 * back to the native rAF automatically.
 */
export const RAF_SHIM_JS = `(() => {
  if (window.__blRafShim) return
  const native = window.requestAnimationFrame.bind(window)
  window.__blNativeRaf = native
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  window.__blRafShim = true
  let nextId = 0
  let hiddenMode = document.hidden
  const pending = new Map()
  let worker = null
  const pump = () => {
    const now = performance.now()
    for (const [id, cb] of [...pending]) { pending.delete(id); try { cb(now) } catch {} }
    if (hiddenMode && pending.size > 0 && worker) worker.postMessage('tick')
  }
  const scheduleNext = () => {
    if (pending.size === 0) return
    if (hiddenMode) {
      // worker timers are not subject to hidden-page clamping; setTimeout is
      // the fallback when a strict CSP blocks blob: workers
      if (worker) worker.postMessage('tick')
      else setTimeout(pump, 16)
    } else {
      native(() => pump())
    }
  }
  const setWorker = (w) => {
    worker = w
    if (w) {
      w.onmessage = () => { if (hiddenMode && pending.size > 0) pump() }
      if (hiddenMode) w.postMessage('tick')
    }
  }
  try {
    const src = 'let t=null;const loop=()=>{postMessage(0);t=setTimeout(loop,16)};onmessage=()=>{if(!t)loop()}'
    setWorker(new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))))
  } catch { /* strict CSP: setTimeout fallback at ~28Hz when hidden */ }
  // rescue in-flight native callbacks when the page becomes hidden: the last
  // scheduled native frame may never fire once minimized
  document.addEventListener('visibilitychange', () => {
    hiddenMode = document.hidden
    if (hiddenMode) scheduleNext()
  })
  window.requestAnimationFrame = (cb) => {
    const id = ++nextId
    pending.set(id, cb)
    scheduleNext()
    return id
  }
  window.cancelAnimationFrame = (id) => { pending.delete(id); nativeCancel(id) }
})()`

export function buildInjectJs(halo: boolean): string {
  return `(() => {
    ${RAF_SHIM_JS}
    if (!window.__blHealth) {
      const h = { raf: 0, native: 0, timer: 0, since: Date.now() };
      window.__blHealth = h;
      const raf = () => { h.raf++; requestAnimationFrame(raf) };
      requestAnimationFrame(raf);
      const nraf = window.__blNativeRaf || requestAnimationFrame;
      const nloop = () => { h.native++; nraf(nloop) };
      nraf(nloop);
      setInterval(() => { h.timer++ }, 100);
    }
    if (${halo ? 'true' : 'false'} && !window.__backlightPulse) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;opacity:0;'
        + 'box-shadow:inset 0 0 0 5px #37c8ff, inset 0 0 28px rgba(55,200,255,.85);'
        + 'transition:opacity .15s ease-out;border-radius:2px;';
      const attach = () => {
        if (document.documentElement) document.documentElement.appendChild(el);
        else setTimeout(attach, 50);
      };
      attach();
      let t = null;
      window.__backlightPulse = () => {
        el.style.opacity = '1';
        if (t) clearTimeout(t);
        t = setTimeout(() => { el.style.opacity = '0' }, 320);
      };
    }
  })()`
}

export interface TargetHealth {
  targetId: string
  title: string
  url: string
  visibility: string
  /** logic frame rate — goes through the rAF shim, stays ~60Hz even hidden */
  rafPerSec: number
  /** real compositor frame rate — drops to 0 when truly hidden (minimized) */
  nativeRafPerSec: number
  timerPerSec: number
  sampleMs: number
}

interface TrackedTarget {
  targetId: string
  sessionId: string
  title: string
  url: string
  visibility: string
  scriptAdded: boolean
  prevRaf: number
  prevNative: number
  prevTimer: number
  prevTs: number
  rafPerSec: number
  nativeRafPerSec: number
  timerPerSec: number
  sampleMs: number
}

/**
 * Periodically injects the bootstrap and reads back per-target counters so the
 * dashboard/API can prove pages keep running at full speed in the background.
 */
export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null
  private registrar: NodeJS.Timeout | null = null
  private sessions = new Map<string, TrackedTarget>()
  private checking = false
  private registering = false

  private getContext: () => { cdp: Cdp } | null

  constructor(getContext: () => { cdp: Cdp } | null) {
    this.getContext = getContext
  }

  start(intervalMs = 2000) {
    this.stop()
    // fast registrar: attach + Page.addScriptToEvaluateOnNewDocument ASAP so
    // the rAF shim beats the page's own script (registration covers all
    // future navigations of that target)
    this.registrar = setInterval(() => void this.register(), 200)
    this.registrar.unref?.()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.registrar) clearInterval(this.registrar)
    this.timer = null
    this.registrar = null
    this.sessions.clear()
  }

  /** Attach early and pre-register the injection script per page target. */
  private async register(): Promise<void> {
    if (this.registering) return
    const ctx = this.getContext()
    if (!ctx) return
    this.registering = true
    try {
      const { cdp } = ctx
      const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
      for (const page of targetInfos.filter(t => t.type === 'page')) {
        if (this.sessions.has(page.targetId)) continue
        try {
          const sessionId = await cdp.attach(page.targetId)
          await cdp.send('Page.enable', {}, sessionId)
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectJs(loadSettings().halo) }, sessionId)
          this.sessions.set(page.targetId, {
            targetId: page.targetId, sessionId, title: page.title, url: page.url,
            visibility: 'unknown', scriptAdded: true, prevRaf: 0, prevNative: 0, prevTimer: 0, prevTs: Date.now(),
            rafPerSec: 0, nativeRafPerSec: 0, timerPerSec: 0,
            sampleMs: 0,
          })
          debug(`injection pre-registered for ${page.targetId.slice(0, 8)}`)
        } catch { /* target may be mid-navigation */ }
      }
    } catch { /* ignore */ } finally {
      this.registering = false
    }
  }

  snapshot(): TargetHealth[] {
    return [...this.sessions.values()].map(t => ({
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      visibility: t.visibility,
      rafPerSec: Math.round(t.rafPerSec * 10) / 10,
      nativeRafPerSec: Math.round(t.nativeRafPerSec * 10) / 10,
      timerPerSec: Math.round(t.timerPerSec * 10) / 10,
      sampleMs: t.sampleMs,
    }))
  }

  private async tick(): Promise<void> {
    if (this.checking) return
    const ctx = this.getContext()
    if (!ctx) return
    this.checking = true
    try {
      const { cdp } = ctx
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; title: string; url: string }> }>(
        'Target.getTargets',
      )
      const pages = targetInfos.filter(t => t.type === 'page')
      const alive = new Set(pages.map(p => p.targetId))
      for (const id of [...this.sessions.keys()]) {
        if (!alive.has(id)) this.sessions.delete(id)
      }
      for (const page of pages) {
        await this.sample(cdp, page)
      }
    } catch (err) {
      debug(`health tick failed: ${(err as Error).message}`)
    } finally {
      this.checking = false
    }
  }

  private async sample(cdp: Cdp, page: { targetId: string; title: string; url: string }): Promise<void> {
    const settings = loadSettings()
    let tracked = this.sessions.get(page.targetId)
    let sessionId: string
    if (tracked) sessionId = tracked.sessionId
    else {
      try { sessionId = await cdp.attach(page.targetId) } catch { return }
      tracked = {
        targetId: page.targetId, sessionId, title: page.title, url: page.url,
        visibility: 'unknown', scriptAdded: false, prevRaf: 0, prevNative: 0, prevTimer: 0, prevTs: Date.now(),
        rafPerSec: 0, nativeRafPerSec: 0, timerPerSec: 0,
        sampleMs: 0,
      }
      this.sessions.set(page.targetId, tracked)
      // register the bootstrap to run BEFORE any page script on future
      // navigations — the rAF shim must beat the page's own rAF capture
      try {
        await cdp.send('Page.enable', {}, sessionId)
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectJs(settings.halo) }, sessionId)
        tracked.scriptAdded = true
      } catch { /* current-doc evaluate below still applies */ }
    }
    try {
      const res = await cdp.send<{ result?: { value?: any }; exceptionDetails?: any }>(
        'Runtime.evaluate',
        {
          expression: buildInjectJs(settings.halo),
          returnByValue: true,
        },
        sessionId,
      )
      if (res.exceptionDetails) return
      const health = await cdp.send<{ result?: { value?: any } }>(
        'Runtime.evaluate',
        { expression: '(()=>{const h=window.__blHealth;if(!h)return null;return{raf:h.raf,native:h.native,timer:h.timer,vis:document.visibilityState}})()', returnByValue: true },
        sessionId,
      )
      const v = health.result?.value
      if (!v) return
      const now = Date.now()
      const dt = Math.max(1, now - tracked.prevTs) / 1000
      tracked.rafPerSec = (v.raf - tracked.prevRaf) / dt
      tracked.nativeRafPerSec = (v.native - tracked.prevNative) / dt
      tracked.timerPerSec = (v.timer - tracked.prevTimer) / dt
      tracked.prevRaf = v.raf
      tracked.prevNative = v.native
      tracked.prevTimer = v.timer
      tracked.prevTs = now
      tracked.visibility = v.vis
      tracked.title = page.title
      tracked.url = page.url
      tracked.sampleMs = now
    } catch {
      // session went bad (navigation edge, crashed tab) — re-attach next round
      this.sessions.delete(page.targetId)
    }
  }
}
