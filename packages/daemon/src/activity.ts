export interface ActivityEvent {
  ts: number
  kind: 'ai-command' | 'system'
  method: string
  targetId?: string
  detail?: string
}

type Subscriber = (e: ActivityEvent) => void

const HISTORY_LIMIT = 500

/** In-memory activity bus: ring buffer + live subscribers (WS /activity). */
export class ActivityBus {
  private history: ActivityEvent[] = []
  private subs = new Set<Subscriber>()

  emit(event: ActivityEvent) {
    this.history.push(event)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    for (const sub of [...this.subs]) {
      try { sub(event) } catch { /* subscriber errors are ignored */ }
    }
  }

  system(method: string, detail?: string) {
    this.emit({ ts: Date.now(), kind: 'system', method, detail })
  }

  recent(limit = 50): ActivityEvent[] {
    return this.history.slice(-limit)
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
}
