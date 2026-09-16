/**
 * Pure helpers for the window-state throttle acceptance test
 * (`window-state-throttle.ts`). Kept dependency-free so
 * `window-state-throttle-unit.ts` can verify transitions and rates without a
 * GUI or a running browser.
 */

export interface WindowStateSample {
  /** ms since the test's time origin */
  atMs: number
  /** CDP `Browser.getWindowBounds` windowState */
  cdpWindowState: string | null
  /** AppKit `NSRunningApplication.isHidden` (app-control state) */
  nativeAppHidden: boolean | null
  /** WindowServer on-screen layer-0 window count (app-control windows) */
  nativeOnScreenWindows: number | null
  /** page-reported document.visibilityState, read-only */
  domVisibility: string | null
  /** compensatory rAF count via the injected shim — logic frames, NOT compositor frames */
  raf: number | null
  /** native compositor rAF count via the un-shimmed callback */
  nativeRaf: number | null
  /** injected 100ms timer counter */
  timer: number | null
  /** page-side successful fetch counter */
  pagePolls: number | null
  /** server-side request counter (ground truth for network polling) */
  serverPolls: number | null
}

export interface NativeWindowsProbe {
  windowCount: number
  onScreenWindowCount: number
}

/** Parse `app-control windows <pid>` output. */
export function parseNativeWindowsProbe(stdout: string): NativeWindowsProbe {
  let parsed: { windowCount?: unknown; onScreenWindowCount?: unknown }
  try {
    parsed = JSON.parse(stdout) as { windowCount?: unknown; onScreenWindowCount?: unknown }
  } catch {
    throw new Error(`unexpected app-control windows output: ${stdout.trim()}`)
  }
  const { windowCount, onScreenWindowCount } = parsed ?? {}
  if (typeof windowCount !== 'number' || !Number.isFinite(windowCount)
    || typeof onScreenWindowCount !== 'number' || !Number.isFinite(onScreenWindowCount)) {
    throw new Error(`unexpected app-control windows output: ${stdout.trim()}`)
  }
  return { windowCount, onScreenWindowCount }
}

/** First sample (in chronological order) that matches, with its timestamp. */
export function firstSampleAt(
  samples: WindowStateSample[],
  predicate: (sample: WindowStateSample) => boolean,
): number | null {
  for (const sample of samples) if (predicate(sample)) return sample.atMs
  return null
}

/** Samples inside [fromMs, toMs] — used to isolate baseline / observation windows. */
export function sliceWindow(samples: WindowStateSample[], fromMs: number, toMs: number): WindowStateSample[] {
  return samples.filter(sample => sample.atMs >= fromMs && sample.atMs <= toMs)
}

/**
 * Average rate per second between the first and last finite point. Null when
 * fewer than two finite points exist, so a missing channel can never silently
 * pass a threshold check.
 */
export function ratePerSec(
  samples: WindowStateSample[],
  pick: (sample: WindowStateSample) => number | null,
): number | null {
  const points: Array<{ atMs: number; value: number }> = []
  for (const sample of samples) {
    const value = pick(sample)
    if (value !== null && Number.isFinite(value)) points.push({ atMs: sample.atMs, value })
  }
  if (points.length < 2) return null
  const first = points[0]!
  const last = points[points.length - 1]!
  const seconds = (last.atMs - first.atMs) / 1000
  if (seconds <= 0) return null
  return (last.value - first.value) / seconds
}

/** True only when there is at least one sample and every sample satisfies the predicate. */
export function holdsThroughout(
  samples: WindowStateSample[],
  predicate: (sample: WindowStateSample) => boolean,
): boolean {
  return samples.length > 0 && samples.every(predicate)
}

/** Human-readable timestamped state-transition timeline. */
export function formatTimeline(events: Array<{ atMs: number | null; label: string; detail?: string }>): string {
  return events
    .map(event => {
      const time = event.atMs === null ? '  --  ' : `${(event.atMs / 1000).toFixed(2).padStart(6)}s`
      return `  [${time}] ${event.label}${event.detail ? `: ${event.detail}` : ''}`
    })
    .join('\n')
}
