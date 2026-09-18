import { log } from './log.ts'

/**
 * Bounded, privacy-safe structured state-transition log.
 *
 * Only an allowlist of keys is persisted. Values are length-capped and any URL
 * (http/ws/file/devtools/chrome-extension/...) is redacted, so window-state
 * diagnosis can never leak page URLs, titles, cookies or profile content.
 * Entries live in a fixed-size ring buffer for GET /api/state-log.
 */
export interface TransitionEntry {
  /** ms since epoch */
  at: number
  /** e.g. control-intent, window-minimize, native-hide, capture-cleanup */
  event: string
  /** who caused the transition: explicit | auto | internal | unknown */
  origin?: string
  /** common intent token correlating one intent with all of its transitions */
  token?: string
  /** e.g. POST /api/bg */
  route?: string
  /** caller label: cli.bg, tray.menu.show, tray.auto.activate, dashboard, capture */
  source?: string
  requestId?: string
  /** window control generation (last-intent-wins) */
  gen?: number
  windowId?: number
  pid?: number
  /** managed browser session id (session.ts); attributes every entry point */
  session?: string
  /** state before the transition, e.g. minimized / normal / hidden / visible */
  before?: string
  /** state after the transition */
  after?: string
  /** branch taken, e.g. internal-activation, settle-repeat, parked, takeover */
  branch?: string
  /** short bounded context (never user content) */
  detail?: string
}

const DEFAULT_LIMIT = 256
const MAX_LIMIT = 256
const STRING_LIMIT = 80
const DETAIL_LIMIT = 160

const STRING_KEYS = ['event', 'origin', 'token', 'route', 'source', 'requestId', 'session', 'before', 'after', 'branch', 'detail'] as const
const NUMBER_KEYS = ['at', 'gen', 'windowId', 'pid'] as const

/** anything that looks like a locator is replaced before it can be persisted */
const URL_RE = /\b(?:https?|wss?|file|devtools|chrome|chrome-extension|view-source|data|blob):\S*/gi

export function cleanTransitionString(value: unknown, limit = STRING_LIMIT): string {
  return String(value ?? '')
    .replace(URL_RE, '[redacted-url]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, limit)
}

/** Keep only allowlisted keys with sanitized, bounded values. */
export function sanitizeTransition(raw: Partial<TransitionEntry> & { event: string }): TransitionEntry {
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now()
  const out: TransitionEntry = { at, event: cleanTransitionString(raw.event) || 'unknown' }
  for (const key of STRING_KEYS) {
    if (key === 'event') continue
    const value = raw[key]
    if (value === undefined || value === null) continue
    out[key] = cleanTransitionString(value, key === 'detail' ? DETAIL_LIMIT : STRING_LIMIT)
  }
  for (const key of NUMBER_KEYS) {
    if (key === 'at') continue
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

export function formatTransition(entry: TransitionEntry): string {
  return JSON.stringify(entry)
}

export class StateTransitionLog {
  private entries: TransitionEntry[] = []
  private limit: number
  private sink: (line: string) => void

  constructor(options: { limit?: number; sink?: (line: string) => void } = {}) {
    this.limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT))
    this.sink = options.sink ?? (line => log(line))
  }

  record(raw: Partial<TransitionEntry> & { event: string }): TransitionEntry {
    const entry = sanitizeTransition(raw)
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    try { this.sink(formatTransition(entry)) } catch { /* logging must never throw */ }
    return entry
  }

  recent(limit = 50): TransitionEntry[] {
    const n = Math.max(1, Math.min(this.limit, Math.floor(limit) || 50))
    return this.entries.slice(-n)
  }

  size(): number {
    return this.entries.length
  }
}
