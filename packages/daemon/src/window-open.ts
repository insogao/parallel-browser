import type { Cdp } from './cdp.ts'

/**
 * Windowless background pages (zero-window sessions).
 *
 * FEASIBILITY FINDING (2026-09-17, task B): creating a REAL, take-overable tab
 * in a zero-window Chrome session without any on-screen flash is NOT possible
 * with the current Chrome/macOS architecture, and is therefore not claimed:
 *
 *  - `Target.createTarget({ hidden: true })` yields a protocol-only target. On
 *    Chrome for Testing 153 it is reported by `Target.getTargets` as
 *    `type: 'other'`; it has no window, never enters the tab strip and cannot
 *    be moved into one (CDP has no "adopt" call, and `chrome.tabs` cannot see
 *    it), so BrowserPilot cannot drive it as a normal tab.
 *  - `Target.createTarget` without `hidden` in a zero-window session has to
 *    create the first native window. macOS foregrounds/unhides the app for it
 *    (`browser.ts` background launch hides before the create; the previous
 *    hidden-restart investigation measured the unavoidable visible window).
 *  - `newWindow: true` / `chrome.windows.create({ state: 'minimized' })` split
 *    the session into multiple windows or flash on screen — both were already
 *    measured as failures (see docs/plans/2026-09-16-window-state-throttle-*).
 *
 * Consequence (fail closed, capability-flagged): the daemon may still create a
 * hidden windowless page for AI/CDP use, but it never re-creates its URL as a
 * new tab to fake a human handoff ("URL clone"). Repeated clicks never turn a
 * windowless page into a real tab. Callers see `adoption: 'unsupported'`.
 *
 * The registry is per CDP connection so unrelated extension helpers and pages
 * are never mistaken for user-requested background pages.
 */

export interface WindowlessCapability {
  /** hidden protocol target creation works and cannot materialize a window */
  create: boolean
  /** a windowless page can be adopted as a real chrome.tabs tab */
  adoption: 'unsupported'
  /** BrowserPilot (chrome.tabs) can see or operate on it */
  browserPilot: 'unsupported'
  reason: string
  evidence: string
}

export const WINDOWLESS_CAPABILITY: WindowlessCapability = {
  create: true,
  adoption: 'unsupported',
  browserPilot: 'unsupported',
  reason: 'windowless-targets-are-protocol-only-not-tab-strip-tabs',
  evidence: 'CfT 153 reports hidden:true targets as type=other with no window; no CDP/extension API moves them into a tab strip. A real first tab materializes a native window instead (isolated probe 2026-09-17: on-screen ~1s at the offscreen corner, app active=false), which is why the product now creates one real managed window rather than faking adoption',
}

export function windowlessCapability(): WindowlessCapability {
  return { ...WINDOWLESS_CAPABILITY }
}

const pending = new WeakMap<Cdp, Map<string, string>>()

export function isWindowlessPage(cdp: Cdp, targetId: string): boolean {
  return pending.get(cdp)?.has(targetId) ?? false
}

export function windowlessCount(cdp: Cdp): number {
  return pending.get(cdp)?.size ?? 0
}

/** How Chrome currently reports one target: hidden pages are `other` (CfT
 * 153); a real tab-strip page is `page`. `missing` means it could not be
 * observed within the bound — never treated as success. */
export type WindowlessProbe = 'hidden' | 'page' | 'missing'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function probeWindowless(cdp: Cdp, targetId: string, timeoutMs = 2_000): Promise<WindowlessProbe> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets')
      const info = targetInfos.find(t => t.targetId === targetId)
      if (info) return info.type === 'other' ? 'hidden' : 'page'
    } catch { /* transient CDP error: retry within the bound */ }
    if (Date.now() >= deadline) return 'missing'
    await sleep(100)
  }
}

/**
 * Create a windowless page and fail closed when the engine does not honour
 * `hidden: true`: if the target shows up as a real `page` (tab strip) or cannot
 * be observed, it is closed again and the caller gets an error instead of a
 * page whose identity cannot be kept invisible.
 */
export async function openWindowlessPage(cdp: Cdp, url: string, timeoutMs = 2_000): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url, background: true, hidden: true,
  })
  if (!targetId) throw new Error('Chromium returned no hidden target')
  const probe = await probeWindowless(cdp, targetId, timeoutMs)
  if (probe !== 'hidden') {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    throw new Error(`engine did not honor hidden:true (target is ${probe}); windowless page refused`)
  }
  let pages = pending.get(cdp)
  if (!pages) { pages = new Map(); pending.set(cdp, pages) }
  pages.set(targetId, url)
  return targetId
}

export async function closeWindowlessPage(cdp: Cdp, targetId: string): Promise<void> {
  pending.get(cdp)?.delete(targetId)
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
}

/** Human takeover may create UI tabs; URLs come from current targets after redirects. */
export async function pendingWindowlessPages(cdp: Cdp): Promise<Array<{ targetId: string; url: string }>> {
  const pages = pending.get(cdp)
  if (!pages?.size) return []
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string }> }>('Target.getTargets')
  const live = new Map(targetInfos.map(t => [t.targetId, t.url]))
  const result: Array<{ targetId: string; url: string }> = []
  for (const [targetId, originalUrl] of pages) {
    const currentUrl = live.get(targetId)
    if (currentUrl === undefined) { pages.delete(targetId); continue }
    result.push({ targetId, url: /^https?:\/\//i.test(currentUrl) ? currentUrl : originalUrl })
  }
  return result
}
