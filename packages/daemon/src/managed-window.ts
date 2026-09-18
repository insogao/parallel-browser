import type { Cdp } from './cdp.ts'

/**
 * The one managed real window (product trade-off 2026-09-17):
 *
 * Zero-window cold start MAY create one real window and macOS may show it
 * once. From then on the daemon reuses that same window for every background
 * open, so an AI-driven page and a later human open are the SAME document
 * (same target, same tab). It never creates a second window, never activates
 * the window for background work and never re-creates a page from its URL.
 *
 * Per browser connection (CDP) state:
 *  - `windowId`  the managed window currently owned by the daemon
 *  - `firstDisplayUsed`  whether the one-time zero-window creation happened;
 *    once spent, a lost window must be re-opened by an explicit human action
 *    (show/login) — the daemon will not pop another window on its own.
 */

export interface ManagedWindowInfo {
  windowId: number
  /** target of the tab that established the window (when known) */
  firstTargetId?: string
  createdAt: number
  /** how the window became the managed one */
  source: 'background-first-display' | 'adopted' | 'explicit'
}

const windows = new WeakMap<Cdp, ManagedWindowInfo>()
const firstDisplay = new WeakSet<Cdp>()

export function managedWindow(cdp: Cdp): ManagedWindowInfo | null {
  return windows.get(cdp) ?? null
}

export function trackManagedWindow(cdp: Cdp, info: ManagedWindowInfo): void {
  windows.set(cdp, info)
}

export function clearManagedWindow(cdp: Cdp): void {
  windows.delete(cdp)
}

export function firstDisplayUsed(cdp: Cdp): boolean {
  return firstDisplay.has(cdp)
}

export function markFirstDisplayUsed(cdp: Cdp): void {
  firstDisplay.add(cdp)
}

/** True while the window can still be addressed over CDP. */
export async function windowStillOpen(cdp: Cdp, windowId: number): Promise<boolean> {
  try {
    await cdp.send('Browser.getWindowBounds', { windowId })
    return true
  } catch {
    return false
  }
}

/** Bounded resolution of the native window holding a target. */
export async function targetWindowId(
  cdp: Cdp,
  targetId: string,
  attempts = 5,
  intervalMs = 100,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise(r => setTimeout(r, intervalMs))
    try {
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
      if (typeof windowId === 'number') return windowId
    } catch { /* target may not be window-backed yet; retry */ }
  }
  return null
}
