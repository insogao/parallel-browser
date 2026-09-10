import type { ActivityBus } from './activity.ts'

/** CDP methods that represent an AI "doing something" to a page. */
const ACTION_PATTERNS: Array<[RegExp, string]> = [
  [/^Input\./, 'input'],
  [/^Runtime\.(evaluate|callFunctionOn)$/, 'evaluate'],
  [/^Page\.(navigate|reload|goBack|goForward)$/, 'navigation'],
  [/^Page\.(captureScreenshot|printToPDF|captureSnapshot)$/, 'capture'],
  [/^Snapshot\.captureSnapshot$/, 'capture'],
  [/^DOM\.setFileInputFiles$/, 'input'],
  [/^Target\.(createTarget|closeTarget)$/, 'tab'],
  [/^Accessibility\.getFullAXTree$/, 'observe'],
]

export function classifyAction(method: string): string | null {
  for (const [re, kind] of ACTION_PATTERNS) {
    if (re.test(method)) return kind
  }
  return null
}

/**
 * Per-connection tap state: maps flat-protocol sessionIds -> targetIds so we
 * can attribute AI commands to pages and fire the halo on the right tab.
 */
export class TapState {
  private pendingAttach = new Map<number, string>()
  private sessionToTarget = new Map<string, string>()

  /** Feed one parsed message. Returns the action kind if this message is an attributed AI action. */
  ingest(msg: any, dir: 'c2b' | 'b2c'): { kind: string; method: string; targetId?: string } | null {
    try {
      if (dir === 'c2b') {
        if (msg.method === 'Target.attachToTarget' && typeof msg.id === 'number' && msg.params?.targetId) {
          this.pendingAttach.set(msg.id, String(msg.params.targetId))
          return null
        }
        if (msg.method === 'Target.detachFromTarget' && msg.params?.sessionId) {
          this.sessionToTarget.delete(msg.params.sessionId)
          return null
        }
        const kind = typeof msg.method === 'string' ? classifyAction(msg.method) : null
        if (!kind) return null
        const targetId = (msg.sessionId && this.sessionToTarget.get(msg.sessionId)) || msg.params?.targetId || undefined
        return { kind, method: msg.method, targetId: targetId ? String(targetId) : undefined }
      }

      // b2c
      if (typeof msg.id === 'number' && this.pendingAttach.has(msg.id)) {
        const targetId = this.pendingAttach.get(msg.id)!
        this.pendingAttach.delete(msg.id)
        if (msg.result?.sessionId) this.sessionToTarget.set(msg.result.sessionId, targetId)
        return null
      }
      if (msg.method === 'Target.attachedTo' && msg.params?.sessionId) {
        this.sessionToTarget.set(msg.params.sessionId, String(msg.params.targetInfo?.targetId ?? ''))
        return null
      }
      if (msg.method === 'Target.targetDisposed' && msg.params?.targetId) {
        for (const [sid, tid] of this.sessionToTarget) {
          if (tid === msg.params.targetId) this.sessionToTarget.delete(sid)
        }
      }
      return null
    } catch {
      return null
    }
  }
}

export interface TapHooks {
  onAction: (e: { method: string; targetId?: string; kind: string }) => void
}

/** Parse one CDP text frame; calls hooks for attributed AI actions. */
export function tapFrame(text: string, dir: 'c2b' | 'b2c', state: TapState, hooks: TapHooks, bus?: ActivityBus): void {
  if (text.length > 2_000_000) return // skip huge frames (binary-ish payloads)
  let msg: any
  try { msg = JSON.parse(text) } catch { return }
  const hit = state.ingest(msg, dir)
  if (hit) {
    bus?.emit({ ts: Date.now(), kind: 'ai-command', method: hit.method, targetId: hit.targetId, detail: hit.kind })
    hooks.onAction(hit)
  }
}
