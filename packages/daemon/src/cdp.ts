import WebSocket from 'ws'

type Params = Record<string, unknown>

interface Waiter { resolve: (v: any) => void; reject: (e: Error) => void }

/**
 * Flat-protocol CDP client (one browser-level WebSocket, sessions via sessionId).
 * Only what the daemon needs: send, sessions, event subscription.
 */
export class Cdp {
  private ws: WebSocket
  private nextId = 0
  private waiters = new Map<number, Waiter>()
  private listeners = new Set<(msg: any) => void>()
  public closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data: WebSocket.RawData) => this.handle(data.toString()))
    ws.on('close', () => this.handleClose(new Error('cdp socket closed')))
    ws.on('error', (err: Error) => this.handleClose(err))
  }

  private handleClose(err: Error) {
    if (this.closed) return
    this.closed = true
    for (const w of this.waiters.values()) w.reject(err)
    this.waiters.clear()
    for (const l of [...this.listeners]) {
      try { l({ method: '__closed', params: { message: err.message } }) } catch { /* ignore */ }
    }
  }

  private handle(text: string) {
    let msg: any
    try { msg = JSON.parse(text) } catch { return }
    if (typeof msg.id === 'number' && this.waiters.has(msg.id)) {
      const w = this.waiters.get(msg.id)!
      this.waiters.delete(msg.id)
      if (msg.error) w.reject(new Error(`cdp ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else w.resolve(msg.result)
      return
    }
    if (msg.method !== undefined) {
      for (const l of [...this.listeners]) {
        try { l(msg) } catch (err) { /* listener errors must not kill the client */ }
      }
    }
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (err) => reject(err))
    })
    await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error('cdp connect timeout')), timeoutMs))])
    return new Cdp(ws)
  }

  send<T = any>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('cdp client closed'))
    const id = ++this.nextId
    const payload: Params = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      // Register before sending: a fast response can be handled while ws.send
      // is still on the stack (proxies, local endpoints, synchronous test
      // sockets), and a dropped response would hang the caller forever.
      this.waiters.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        this.waiters.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      // no per-call timeout by design: CDP responses can legitimately be slow (screenshots)
    })
  }

  on(listener: (msg: any) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Attach to a target and return the new session id. */
  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    return sessionId
  }

  async evaluateOnSession<T = any>(sessionId: string, expression: string): Promise<T> {
    const res = await this.send<{ result?: { value?: T }; exceptionDetails?: any }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId,
    )
    if (res.exceptionDetails) throw new Error(`page eval failed: ${res.exceptionDetails.text}`)
    return res.result?.value as T
  }

  close() {
    this.closed = true
    try { this.ws.close() } catch { /* ignore */ }
    for (const w of this.waiters.values()) w.reject(new Error('cdp client closed'))
    this.waiters.clear()
  }
}

export interface CdpTargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached: boolean
}

export interface CdpVersion {
  Browser: string
  'Protocol-Version': string
  webSocketDebuggerUrl: string
}

/** Query /json/version of a debug endpoint. */
export async function fetchVersion(port: number, timeoutMs = 3000): Promise<CdpVersion> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`/json/version ${res.status}`)
  return res.json() as Promise<CdpVersion>
}

/** Query /json/list of a debug endpoint. */
export async function fetchTargets(port: number, timeoutMs = 3000): Promise<CdpTargetInfo[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`/json/list ${res.status}`)
  const targets = await res.json() as Array<CdpTargetInfo & { id?: string }>
  return targets.map(target => ({ ...target, targetId: target.targetId ?? target.id! }))
}
