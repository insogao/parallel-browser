import type { Cdp } from './cdp.ts'
import { loadSettings } from './store.ts'
import { debug } from './log.ts'

/**
 * Injected into every page: health counters (rAF / timer / visibility) and the
 * AI-command halo. Idempotent, survives navigation via periodic re-injection.
 */
export function buildInjectJs(halo: boolean): string {
  return `(() => {
    if (!window.__blHealth) {
      const h = { raf: 0, timer: 0, since: Date.now() };
      window.__blHealth = h;
      const raf = () => { h.raf++; requestAnimationFrame(raf) };
      requestAnimationFrame(raf);
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
  rafPerSec: number
  timerPerSec: number
  sampleMs: number
}

interface TrackedTarget {
  targetId: string
  sessionId: string
  title: string
  url: string
  visibility: string
  prevRaf: number
  prevTimer: number
  prevTs: number
  rafPerSec: number
  timerPerSec: number
  sampleMs: number
}

/**
 * Periodically injects the bootstrap and reads back per-target counters so the
 * dashboard/API can prove pages keep running at full speed in the background.
 */
export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null
  private sessions = new Map<string, TrackedTarget>()
  private checking = false

  private getContext: () => { cdp: Cdp } | null

  constructor(getContext: () => { cdp: Cdp } | null) {
    this.getContext = getContext
  }

  start(intervalMs = 2000) {
    this.stop()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.sessions.clear()
  }

  snapshot(): TargetHealth[] {
    return [...this.sessions.values()].map(t => ({
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      visibility: t.visibility,
      rafPerSec: Math.round(t.rafPerSec * 10) / 10,
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
        visibility: 'unknown', prevRaf: 0, prevTimer: 0, prevTs: Date.now(), rafPerSec: 0, timerPerSec: 0,
        sampleMs: 0,
      }
      this.sessions.set(page.targetId, tracked)
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
        { expression: '(()=>{const h=window.__blHealth;if(!h)return null;return{raf:h.raf,timer:h.timer,vis:document.visibilityState}})()', returnByValue: true },
        sessionId,
      )
      const v = health.result?.value
      if (!v) return
      const now = Date.now()
      const dt = Math.max(1, now - tracked.prevTs) / 1000
      tracked.rafPerSec = (v.raf - tracked.prevRaf) / dt
      tracked.timerPerSec = (v.timer - tracked.prevTimer) / dt
      tracked.prevRaf = v.raf
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
