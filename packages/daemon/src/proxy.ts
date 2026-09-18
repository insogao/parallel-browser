import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { ActivityBus } from './activity.ts'
import type { BrowserManager } from './browser.ts'
import type { CaptureKeepAlive } from './capture.ts'
import type { ExtensionManager } from './extensions.ts'
import type { ExtensionDev } from './extension-dev.ts'
import type { HealthMonitor } from './inject.ts'
import { loadSettings, saveSettings, type Settings } from './store.ts'
import { listChromeProfiles, importProfile } from './import.ts'
import { ensureChromiumForExtensions } from './browser.ts'
import { brandBundle } from './brand.ts'
import { paths } from './paths.ts'
import { resolveBrandedEngineSelection, selectBrandedEngineSetting, type LoginResult } from './launcher.ts'

import type { ControlIntent, FramePumpSupervisor, IntentOrigin, IntentRef } from './windows.ts'
import { TapState, tapFrame } from './tap.ts'
import { log, debug } from './log.ts'
import { StateTransitionLog, type TransitionEntry } from './state-log.ts'
import {
  closeWindowlessPage, openWindowlessPage, pendingWindowlessPages, windowlessCapability,
} from './window-open.ts'
import {
  clearManagedWindow, firstDisplayUsed, managedWindow, markFirstDisplayUsed,
  targetWindowId, trackManagedWindow, windowStillOpen,
} from './managed-window.ts'
import { browserSessionId } from './session.ts'

/**
 * Known control surfaces that may ask for on-screen state (visible launch,
 * restore, maximize, unhide, activate). A caller-supplied source string is
 * provenance to log, never proof of a human click: labels outside these
 * surfaces are `unknown` and may not show the browser.
 */
const EXPLICIT_SOURCE_PATTERN = /^(?:cli|dashboard|tray\.menu|test|probe)\./
/** OS/tray reconciliation observed by the tray process; never a user intent. */
const AUTO_SOURCE_PATTERN = /^tray\.auto\./

export interface RequestMeta {
  /** caller label; absent when the caller provided none (never invented) */
  source?: string
  /** explicit | auto | internal | unknown */
  origin: IntentOrigin
  requestId: string
  route: string
}

export interface ServerDeps {
  manager: BrowserManager
  supervisor: FramePumpSupervisor
  health: HealthMonitor
  capture: CaptureKeepAlive
  extensions: ExtensionManager
  extensionDev: ExtensionDev
  bus: ActivityBus
  version: string
  startedAt: number
  pulse: (targetId: string) => void
  /** native app helpers, injectable so unit tests never touch the OS */
  appState: (pid: number) => Promise<{ active: boolean; hidden: boolean }>
  hideBrowser: (pid: number) => Promise<void>
  unhideBrowser: (pid: number) => Promise<void>
  activateBrowser: (pid: number) => Promise<void>
  /** bounded privacy-safe transition log (optional; unit tests may omit) */
  stateLog?: StateTransitionLog
  /** managed session id for log/status attribution (optional in unit tests) */
  sessionId?: () => string | undefined
}

/** Best-effort privacy-safe transition logging (never throws into routes). */
function transition(deps: ServerDeps, entry: Omit<TransitionEntry, 'at'> & { at?: number }): void {
  try {
    deps.stateLog?.record({ at: entry.at ?? Date.now(), ...entry, session: entry.session ?? deps.sessionId?.() })
  } catch { /* logging is best effort */ }
}

/**
 * One window-materializing operation at a time per daemon/session.
 *
 * `managedWindow`/`firstDisplayUsed` are read-then-write state: without this
 * lock two concurrent `/api/open` (or launch/open) requests could both see
 * "zero windows, allowance unused" and each create a native window. It also
 * serializes same-window tab opens with human manual window creation so the
 * "exactly one managed window" invariant holds under concurrency.
 */
const windowLocks = new WeakMap<ServerDeps, Promise<unknown>>()
function withWindowLock<T>(deps: ServerDeps, work: () => Promise<T>): Promise<T> {
  const previous = windowLocks.get(deps) ?? Promise.resolve()
  const run = previous.then(work, work)
  windowLocks.set(deps, run.catch(() => {}))
  return run
}

/**
 * Attribution for one request. `explicit` requires a sanitized source from a
 * known control surface; tray reconciliation sources and `explicit:false` are
 * `auto`; anything else (missing source or an arbitrary label) is `unknown`
 * and is never silently classified as human.
 */
function requestMeta(payload: any, route: string, requestId: string): RequestMeta {
  const raw = typeof payload?.source === 'string' ? payload.source.trim() : ''
  const source = raw ? raw.replace(/[^a-zA-Z0-9._-]+/g, '').slice(0, 48) || undefined : undefined
  const declaredAuto = payload?.explicit === false
  const origin: IntentOrigin = declaredAuto || (source !== undefined && AUTO_SOURCE_PATTERN.test(source))
    ? 'auto'
    : source !== undefined && EXPLICIT_SOURCE_PATTERN.test(source) ? 'explicit' : 'unknown'
  return { source, origin, requestId, route }
}

/** Correlation fields logged with every transition an intent produces. */
function intentFields(intent: ControlIntent): IntentRef {
  return {
    origin: intent.origin,
    token: intent.token,
    source: intent.source,
    route: intent.route,
    requestId: intent.requestId,
    gen: intent.gen,
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Rewrite upstream webSocketDebuggerUrl hosts to point at our proxy. */
function rewriteDebuggerUrls(text: string, proxyPort: number): string {
  try {
    const data = JSON.parse(text)
    const walk = (obj: any) => {
      if (Array.isArray(obj)) return obj.forEach(walk)
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'webSocketDebuggerUrl' && typeof v === 'string') {
            obj[k] = v.replace(/ws:\/\/127\.0\.0\.1:\d+\//, `ws://127.0.0.1:${proxyPort}/`)
          } else walk(v)
        }
      }
    }
    walk(data)
    return JSON.stringify(data)
  } catch {
    return text
  }
}

export function createServer(deps: ServerDeps): http.Server {
  const upstream = () => deps.manager.current?.upstreamPort ?? null
  const httpServer = http.createServer()
  let requestCounter = 0
  const nextRequestId = () => `r${(++requestCounter).toString(36)}`

  // Native app-visibility operations (hide/unhide/activate) are serialized in
  // arrival order. Each op rechecks its control generation inside the critical
  // section, so if bg entered native hide first a later show's unhide runs
  // after it, and if show entered first a stale bg skips hiding entirely.
  let nativeQueue: Promise<unknown> = Promise.resolve()
  const nativeControl: NativeControl = {
    op<T>(gen: number, work: () => Promise<T>): Promise<T | undefined> {
      debug(`native op gen=${gen} current=${deps.supervisor.isControlCurrent(gen)}`)
      const run = nativeQueue.catch(() => {}).then(async () => {
        if (!deps.supervisor.isControlCurrent(gen)) {
          debug(`native op gen=${gen} skipped (superseded)`)
          return undefined
        }
        debug(`native op gen=${gen} running`)
        return work()
      })
      nativeQueue = run.catch(() => {})
      return run
    },
    /**
     * Persist the visibility of the newest intent. Defense in depth: only an
     * `explicit` generation may unhide or foreground; auto/internal/unknown
     * are refused here even if a route forgets to gate (never silent).
     */
    async persist(gen: number, activate: boolean, meta: Partial<RequestMeta> = {}): Promise<void> {
      const cur = deps.manager.current
      if (!cur) return
      const ref = deps.supervisor.intentRef(gen)
      if (ref.origin !== 'explicit') {
        transition(deps, {
          event: 'policy-downgrade', ...ref, branch: 'native-op',
          source: ref.source ?? meta.source, detail: 'non-explicit-native-refused',
        })
        return
      }
      const foreground = activate
      let skipped = false
      const base = {
        ...ref,
        source: ref.source ?? meta.source,
        pid: cur.pid,
      }
      const ran = await nativeControl.op(gen, async () => {
        let before: string | undefined
        try { before = (await deps.appState(cur.pid)).hidden ? 'hidden' : 'visible' } catch { /* unknown */ }
        const entry = { event: foreground ? 'native-activate' : 'native-unhide', ...base, before: before ?? 'unknown' }
        transition(deps, { ...entry, branch: 'requested' })
        try {
          if (foreground) {
            await deps.activateBrowser(cur.pid)
            transition(deps, { ...entry, after: 'active-visible', branch: 'applied' })
          } else {
            await deps.unhideBrowser(cur.pid)
            transition(deps, { ...entry, after: 'visible', branch: 'applied' })
          }
        } catch (err) {
          transition(deps, { ...entry, after: before ?? 'unknown', branch: 'failed', detail: (err as Error).message })
          throw err
        }
        return true
      })
      if (ran !== true) skipped = true
      if (skipped) {
        transition(deps, {
          event: foreground ? 'native-activate' : 'native-unhide', ...base,
          branch: 'superseded', after: 'skipped',
        })
      }
    },
  }

  // Repeated clicks (Launchpad) share one in-flight login: the browser is
  // launched/reused once and every click resolves with the same result.
  let loginInFlight: Promise<LoginResult> | null = null
  const login = (meta: RequestMeta): Promise<LoginResult> => {
    if (!loginInFlight) {
      loginInFlight = runLogin(deps, nativeControl, meta).finally(() => { loginInFlight = null })
    }
    return loginInFlight
  }

  // ---- normal HTTP requests -------------------------------------------------
  httpServer.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/controller') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(controllerHtml())
        return
      }
      if (url.pathname === '/demo') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(fs.readFileSync(new URL('./demo.html', import.meta.url), 'utf8'))
        return
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(dashboardHtml(deps))
        return
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, deps, nativeControl, login, nextRequestId)
        return
      }
      if (url.pathname === '/json/new') {
        // Chromium's own /json/new focuses the created tab (and may create a
        // visible window). Route it through the daemon's background-target
        // semantics instead so a raw HTTP caller can never pop on screen.
        const up = upstream()
        const cur = deps.manager.current
        if (!up || !cur) return json(res, 503, { error: 'browser not running (backlight launch first)' })
        const targetUrl = url.searchParams.get('url') ?? 'about:blank'
        try {
          if ((await deps.supervisor.windowStates()).length === 0) {
            return json(res, 409, { error: 'use POST /api/open for windowless background pages' })
          }
          const { targetId } = await cur.cdp.send<{ targetId: string }>('Target.createTarget', { url: targetUrl, background: true })
          const proxyPort = req.socket.localPort
          transition(deps, {
            event: 'open', origin: 'unknown', route: 'PUT /json/new', requestId: nextRequestId(),
            branch: 'background-target',
          })
          json(res, 200, {
            description: '',
            devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${proxyPort}/devtools/page/${targetId}`,
            id: targetId,
            title: '',
            type: 'page',
            url: targetUrl,
            webSocketDebuggerUrl: `ws://127.0.0.1:${proxyPort}/devtools/page/${targetId}`,
          })
        } catch (err) {
          if (!res.headersSent) json(res, 502, { error: (err as Error).message })
          else res.end()
        }
        return
      }
      if (url.pathname === '/json' || url.pathname === '/json/list'
        || url.pathname === '/json/version' || url.pathname === '/json/activate' || url.pathname === '/json/close') {
        const up = upstream()
        if (!up) return json(res, 503, { error: 'browser not running (backlight launch first)' })
        const method = req.method ?? 'GET'
        const upstreamUrl = `http://127.0.0.1:${up}${url.pathname}${url.search}`
        const body = method === 'PUT' || method === 'POST' ? await readBody(req) : undefined
        const upstreamRes = await fetch(upstreamUrl, {
          method,
          body: body && body.length ? body : undefined,
          signal: AbortSignal.timeout(10_000),
        })
        const text = await upstreamRes.text()
        const headers: Record<string, string> = { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' }
        res.writeHead(upstreamRes.status, headers)
        res.end(rewriteDebuggerUrls(text, loadSettings().proxyPort))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found (endpoints: /, /api/*, /activity ws, /json/*, /devtools/*)')
    } catch (err) {
      debug(`http error ${url.pathname}: ${(err as Error).message}`)
      if (!res.headersSent) json(res, 502, { error: (err as Error).message })
      else res.end()
    }
  })

  // ---- websocket upgrades ---------------------------------------------------
  const wssActivity = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/activity') {
      wssActivity.handleUpgrade(req, socket, head, (ws) => {
        const send = (e: unknown) => { try { ws.send(JSON.stringify(e)) } catch { /* ignore */ } }
        for (const e of deps.bus.recent(50)) send(e)
        const unsub = deps.bus.subscribe(send)
        ws.on('close', unsub)
        ws.on('error', unsub)
      })
      return
    }
    const up = upstream()
    if (!up) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nbrowser not running')
      socket.destroy()
      return
    }
    pipeCdpSocket(req, socket, head, up, deps)
  })

  return httpServer
}

/** Transparent WebSocket pipe to the real CDP endpoint, with a tap on the way. */
function pipeCdpSocket(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, upstreamPort: number, deps: ServerDeps) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  wss.handleUpgrade(req, socket, head, (client) => {
    const targetUrl = `ws://127.0.0.1:${upstreamPort}${req.url}`
    const upstream = new WebSocket(targetUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    const state = new TapState()
    const pending: Array<{ data: Buffer; isBinary: boolean }> = []
    let pendingBytes = 0

    const closeAll = () => {
      try { client.close() } catch { /* ignore */ }
      try { upstream.close() } catch { /* ignore */ }
    }

    upstream.on('open', () => {
      for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.isBinary })
      pendingBytes = 0
    })
    upstream.on('message', (data: Buffer, isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      if (!isBinary && Buffer.byteLength(data) < 2_000_000) {
        tapFrame(data.toString(), 'b2c', state, { onAction: () => {} })
      }
    })
    upstream.on('close', closeAll)
    upstream.on('error', closeAll)

    client.on('message', (data: Buffer, isBinary: boolean) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
      else if (upstream.readyState === WebSocket.CONNECTING) {
        pendingBytes += data.length
        if (pendingBytes > 16 * 1024 * 1024) { closeAll(); return }
        pending.push({ data, isBinary })
      } else return
      if (!isBinary && Buffer.byteLength(data) < 2_000_000) {
        tapFrame(data.toString(), 'c2b', state, {
          onAction: (hit) => {
            if (hit.targetId && loadSettings().halo) {
              deps.pulse(hit.targetId)
            }
          },
        }, deps.bus)
      }
    })
    client.on('close', closeAll)
    client.on('error', closeAll)
  })
}

// ---- API --------------------------------------------------------------------

/** Per-server serialization of native app-visibility operations. */
interface NativeControl {
  op<T>(gen: number, work: () => Promise<T>): Promise<T | undefined>
  persist(gen: number, activate: boolean, meta?: Partial<RequestMeta>): Promise<void>
}

/**
 * Launchpad/`bl login` click path: select the branded engine when the managed
 * browser is not running yet, launch the configured (default) space visibly,
 * then show + maximize + activate for assisted login. A live session is never
 * killed or switched; repeated/concurrent calls are idempotent.
 */
async function runLogin(deps: ServerDeps, native: NativeControl, meta?: RequestMeta): Promise<LoginResult> {
  // Resolve read-only first: a live managed session on another engine must be
  // refused before any side effect (settings write, humanMode, capture pause,
  // restore/maximize, activate or launch).
  const resolution = resolveBrandedEngineSelection()
  const before = deps.manager.current
  if (deps.manager.running && before && resolution.engine
    && path.resolve(before.binary) !== path.resolve(resolution.engine.binPath)) {
    transition(deps, {
      event: 'login-refused', origin: 'explicit', source: meta?.source, route: meta?.route, requestId: meta?.requestId,
      pid: before.pid, branch: 'engine-mismatch',
    })
    return {
      ok: false,
      launched: false,
      restored: 0,
      engine: resolution.engine.binPath,
      mismatchedEngine: true,
      currentEngine: before.binary,
      note: `managed browser is already running with a different engine (${before.binary}); run backlight stop, then click again to switch`,
    }
  }
  const selection = resolution.wouldChange
    ? selectBrandedEngineSetting()
    : { engine: resolution.engine, changed: false }
  let note: string | undefined
  let engine = selection.engine?.binPath ?? loadSettings().browser
  if (!selection.engine) {
    note = `branded engine not found under ${path.join(paths.root, 'apps')}; using configured engine`
  } else if (selection.changed) {
    note = 'selected the branded Backlight engine for the managed space'
  }
  const previousHumanMode = deps.supervisor.humanMode
  const previousPaused = deps.capture.isPaused?.() ?? false
  const gen = deps.supervisor.beginControl()
  // Record the explicit login intent BEFORE any side effect (launch/show/
  // activate), so a tray auto-show reacting to our own launch sees a pending
  // explicit intent and cannot steal the control generation.
  const intent = deps.supervisor.noteExplicitIntent('show', {
    source: meta?.source,
    route: meta?.route,
    requestId: meta?.requestId,
    gen,
  })
  deps.supervisor.humanMode = true
  let launched = false
  try {
    await deps.capture.setPaused(true)
    if (!deps.manager.running) {
      deps.supervisor.start()
      const instance = await deps.manager.launch({ focus: true })
      launched = true
      engine = instance.binary
    }
    // The whole human takeover (manual window + restore + native unhide/
    // activate) is one critical section: a background open queued behind it
    // then sees humanMode/new-generation and cannot re-hide the human window.
    const restored = await withWindowLock(deps, async () => {
      await ensureManualWindow(deps, gen, meta)
      const count = deps.manager.running ? await deps.supervisor.restoreAll(true, gen) : 0
      await native.persist(gen, true, meta)
      return count
    })
    deps.supervisor.completeIntent(intent.token, 'applied')
    return { ok: true, launched, restored, engine, note }
  } catch (err) {
    // Launch failed: restore the prior control/capture intent as far as the
    // architecture allows (the bumped control generation deliberately stays).
    transition(deps, {
      event: 'login-failed', origin: 'explicit', token: intent.token, source: intent.source, route: intent.route,
      requestId: intent.requestId, gen, branch: 'error', detail: (err as Error).message,
    })
    deps.supervisor.completeIntent(intent.token, 'failed')
    deps.supervisor.humanMode = previousHumanMode
    try { await deps.capture.setPaused(previousPaused) } catch { /* keep the original error */ }
    throw err
  }
}

/**
 * A windowless page can never become a real chrome.tabs tab (see
 * window-open.ts feasibility finding). Every handoff attempt is therefore
 * recorded as refused and the page keeps running unchanged — it is never
 * re-created from its URL and never closed to fake a takeover.
 */
function noteWindowlessHandoff(deps: ServerDeps, meta: RequestMeta | undefined, trigger: string, count: number): void {
  const capability = windowlessCapability()
  transition(deps, {
    event: 'windowless-handoff', origin: meta?.origin ?? 'internal', source: meta?.source,
    route: meta?.route, requestId: meta?.requestId, branch: 'refused',
    detail: `trigger=${trigger} pending=${count} adoption=${capability.adoption} reason=${capability.reason}`,
  })
}

/**
 * Only explicit human-control routes call this; background opens must not.
 * With zero windows an explicit show may create exactly one empty visible
 * window (the human asked to see the browser). Pending windowless pages are
 * never cloned into it: that would reload them and lose page identity. They
 * keep running and the refusal is logged.
 */
async function ensureManualWindow(deps: ServerDeps, gen: number, meta?: RequestMeta): Promise<void> {
  const cur = deps.manager.current
  if (!cur) return
  const windows = (await deps.supervisor.windowStates()).length
  const pending = await pendingWindowlessPages(cur.cdp).catch(() => [])
  if (windows > 0) {
    if (pending.length) noteWindowlessHandoff(deps, meta, 'manual-show-existing-window', pending.length)
    return
  }
  if (!deps.supervisor.isControlCurrent(gen)) return
  transition(deps, { event: 'manual-window-create', origin: 'explicit', gen,
    source: meta?.source, route: meta?.route, requestId: meta?.requestId,
    branch: 'requested', detail: `windowless-pending=${pending.length}` })
  const { targetId } = await cur.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: false })
  const windowId = await targetWindowId(cur.cdp, targetId)
  if (windowId !== null) {
    // The human-visible window becomes the single managed window; later
    // background opens reuse it instead of creating another one.
    trackManagedWindow(cur.cdp, { windowId, firstTargetId: targetId, createdAt: Date.now(), source: 'explicit' })
    transition(deps, { event: 'managed-window', origin: 'explicit', gen,
      source: meta?.source, route: meta?.route, requestId: meta?.requestId, windowId,
      branch: 'adopt', detail: 'human-explicit-window' })
  }
  transition(deps, { event: 'manual-window-create', origin: 'explicit', gen,
    source: meta?.source, route: meta?.route, requestId: meta?.requestId,
    branch: 'created-empty', detail: `empty-window windowId=${windowId ?? 'unknown'} windowless-pending=${pending.length}` })
  if (pending.length) noteWindowlessHandoff(deps, meta, 'manual-window-create', pending.length)
}

type OpenOutcome =
  | { kind: 'windowless'; targetId: string }
  | {
      kind: 'tab'
      targetId: string
      windowId: number
      reused: boolean
      firstDisplay: boolean
      settled: boolean
      settleReason?: string
    }
  | { kind: 'refused'; status: number; body: unknown }

/**
 * One normal background tab in an already existing window. Never passes
 * `newWindow`, never activates the tab/window, and closes the tab again if the
 * engine ignores the background hint and opens a new native window.
 */
async function openBackgroundTab(
  deps: ServerDeps,
  meta: RequestMeta,
  route: string,
  requestId: string,
  url: string,
  cur: NonNullable<ServerDeps['manager']['current']>,
  expectedWindowId: number,
  reused: boolean,
): Promise<OpenOutcome> {
  const cdp = cur.cdp
  const session = browserSessionId(cur)
  const ref = { origin: meta.origin, source: meta.source, route, requestId }
  // Provenance snapshot BEFORE the async createTarget: `wasHidden` alone goes
  // stale while the create is in flight. A human show (API/Dock) during that
  // window must win, so the re-hide is gated on this snapshot and on fresh
  // native evidence (never on the stale hidden flag).
  const genAtStart = deps.supervisor.controlGen()
  const humanAtStart = deps.supervisor.humanMode
  const statesBefore = await deps.supervisor.windowStates()
  const before = new Set(statesBefore.map(w => w.windowId))
  // Our background createTarget never restores a minimized window (measured),
  // so a minimized -> normal transition during the create is human/Dock work.
  const wasMinimized = statesBefore.find(w => w.windowId === expectedWindowId)?.state === 'minimized'
  const wasHidden = await deps.appState(cur.pid).then(s => s.hidden).catch(() => false)
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url, background: true })
  const placedWindowId = await targetWindowId(cdp, targetId)
  if (placedWindowId === null || !before.has(placedWindowId) || placedWindowId !== expectedWindowId) {
    // The one-managed-window invariant: a tab that landed in a different (or
    // brand-new) window is closed again and the request fails. The daemon
    // never adopts an unintended window and never leaves a second one behind.
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    transition(deps, { event: 'managed-window', ...ref, session, windowId: expectedWindowId,
      branch: 'rejected-placement',
      detail: `placed=${placedWindowId ?? 'none'} expected=${expectedWindowId}` })
    throw new Error(placedWindowId === null
      ? 'background tab did not land in an existing window; refused (no second window)'
      : `background tab landed in window ${placedWindowId}, expected managed window ${expectedWindowId}; refused`)
  }
  let settled = true
  let settleReason: string | undefined
  if (wasHidden) {
    const fresh = await deps.appState(cur.pid).catch(() => null)
    const statesAfter = await deps.supervisor.windowStates().catch(() => [])
    const nowMinimized = statesAfter.find(w => w.windowId === placedWindowId)?.state === 'minimized'
    const reason = humanAtStart || deps.supervisor.humanMode ? 'human-mode'
      : deps.supervisor.controlGen() !== genAtStart ? 'newer-control-intent'
      : fresh === null ? 'state-unknown'
      : fresh.active ? 'active-app'
      : wasMinimized && !nowMinimized ? 'restored-window'
      : null
    if (reason) {
      // A human took over (or the state is no longer trustworthy): do not hide
      // the window the human is looking at. The tab stays, the refusal is
      // logged, and native visibility is left exactly as the human set it.
      settled = false
      settleReason = reason
      transition(deps, { event: 'native-hide', ...ref, session,
        branch: 'skipped-human-takeover', after: 'visible',
        detail: `reason=${reason} (stale wasHidden=true not used)` })
    } else {
      try {
        await deps.hideBrowser(cur.pid)
        transition(deps, { event: 'native-hide', ...ref, session,
          branch: 'verified', pid: cur.pid, detail: 'hidden-window-post-create' })
      } catch (err) {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
        throw err
      }
    }
  }
  transition(deps, { event: 'open', ...ref, session, windowId: placedWindowId,
    branch: 'background-target',
    detail: `windowId=${placedWindowId} sameWindow=${reused} firstDisplay=false settled=${settled}` })
  return { kind: 'tab', targetId, windowId: placedWindowId, reused, firstDisplay: false, settled, settleReason }
}

/**
 * Background-first-display settle: the one fresh real window is armed for
 * capture while it is still visible, then minimized and natively hidden.
 * Best effort and honest: failures are logged and reported, never hidden.
 */
async function settleFirstWindow(
  deps: ServerDeps,
  meta: RequestMeta,
  route: string,
  requestId: string,
  cur: NonNullable<ServerDeps['manager']['current']>,
  windowId: number,
): Promise<{ settled: boolean; reason?: string; capture: string }> {
  const ref = { origin: meta.origin, source: meta.source, route, requestId }
  const session = browserSessionId(cur)
  const skip = (reason: string) => {
    transition(deps, { event: 'managed-window', ...ref, session, windowId,
      branch: 'settle-skipped', detail: `reason=${reason}` })
    return { settled: false, reason, capture: 'none' }
  }
  // A human-visible window (explicit show/login racing this open) must never
  // be collapsed by background work.
  if (deps.supervisor.humanMode) return skip('human-mode')
  transition(deps, { event: 'managed-window', ...ref, session, windowId,
    branch: 'settle-requested', detail: 'capture-prearm,then-minimize+native-hide' })
  let capture = 'none'
  try {
    await deps.capture.setPaused(false)
    // The fresh tab must be visible in the health snapshot before arming:
    // arming while hidden grants the rAF exemption but no real frames.
    try { await deps.health.refresh?.() } catch { /* best effort */ }
    const armed = await deps.capture.prearm()
    capture = armed ? 'armed' : 'none'
  } catch {
    capture = 'failed'
  }
  if (deps.supervisor.humanMode) return skip('human-mode')
  // Do not bump the control generation: a background settle never outranks a
  // human intent. If one arrives mid-settle, collapseAll stops (superseded).
  const gen = deps.supervisor.controlGen()
  const appHidden = await deps.appState(cur.pid).then(s => s.hidden).catch(() => false)
  await deps.supervisor.collapseAll(appHidden, gen)
  if (!deps.supervisor.isControlCurrent(gen)) return skip('superseded')
  // Final provenance check before the native hide: a human show may have
  // arrived (and possibly already unhidden the app) while collapseAll ran.
  if (deps.supervisor.humanMode) return skip('human-mode')
  const fresh = await deps.appState(cur.pid).catch(() => null)
  if (fresh === null) return skip('state-unknown')
  if (fresh.active) return skip('human-active')
  if (!deps.supervisor.isControlCurrent(gen)) return skip('superseded')
  let hidden = false
  try {
    await deps.hideBrowser(cur.pid)
    hidden = true
  } catch { /* reported below */ }
  const state = (await deps.supervisor.windowStates().catch(() => []))
    .find(w => w.windowId === windowId)
  const backgrounded = hidden && (state?.state === 'minimized' || state?.cornered === true)
  transition(deps, { event: 'managed-window', ...ref, session, windowId,
    branch: backgrounded ? 'settled' : 'settle-failed',
    detail: `capture=${capture} windowState=${state?.state ?? 'unknown'} cornered=${state?.cornered ?? false} appHidden=${hidden}` })
  return { settled: backgrounded, reason: backgrounded ? undefined : 'not-backgrounded', capture }
}

/**
 * Single managed-window path (product trade-off 2026-09-17):
 *
 * - managed window alive  → one background tab in that same window
 * - another window exists → adopt it (deterministic oldest id), background tab
 * - zero windows          → create EXACTLY ONE real window (macOS may show it
 *   once), then settle it to the background. The one-time display is per
 *   browser session; after the window is lost, background opens are refused
 *   (409) so the daemon can never pop windows repeatedly.
 * - `windowless: true`    → explicit protocol-only hidden page (no window,
 *   never take-overable; BrowserPilot cannot see it)
 */
async function openManagedPage(
  deps: ServerDeps,
  meta: RequestMeta,
  route: string,
  requestId: string,
  payload: any,
  cur: NonNullable<ServerDeps['manager']['current']>,
): Promise<OpenOutcome> {
  const cdp = cur.cdp
  const session = browserSessionId(cur)
  const ref = { origin: meta.origin, source: meta.source, route, requestId }

  if (payload.windowless === true) {
    const beforeWindows = await deps.supervisor.windowStates()
    const beforeIds = new Set(beforeWindows.map(w => w.windowId))
    // The native hide is part of the zero-window background contract only. An
    // existing (possibly user-visible) window must keep its native visibility:
    // a protocol-only page never justifies hiding what the human is looking at.
    const zeroWindow = beforeIds.size === 0
    if (zeroWindow) await deps.hideBrowser(cur.pid)
    const targetId = await openWindowlessPage(cdp, payload.url)
    const afterIds = (await deps.supervisor.windowStates()).map(w => w.windowId)
    if (afterIds.length !== beforeIds.size || afterIds.some(id => !beforeIds.has(id))) {
      await closeWindowlessPage(cdp, targetId)
      throw new Error('windowless page creation changed the native window set; refused')
    }
    transition(deps, { event: 'open', ...ref, session, branch: 'windowless-target',
      detail: zeroWindow
        ? `zero-window-hidden-page adoption=${windowlessCapability().adoption}`
        : `existing-window-hidden-page native=unchanged adoption=${windowlessCapability().adoption}` })
    return { kind: 'windowless', targetId }
  }

  const tracked = managedWindow(cdp)
  if (tracked && await windowStillOpen(cdp, tracked.windowId)) {
    transition(deps, { event: 'managed-window', ...ref, session, windowId: tracked.windowId,
      branch: 'reuse', detail: `same-window windowId=${tracked.windowId} firstDisplay=false` })
    return openBackgroundTab(deps, meta, route, requestId, payload.url, cur, tracked.windowId, true)
  }
  if (tracked) {
    clearManagedWindow(cdp)
    transition(deps, { event: 'managed-window', ...ref, session, windowId: tracked.windowId,
      branch: 'lost', detail: 'window-gone' })
  }

  const existing = await deps.supervisor.windowStates()
  if (existing.length > 0) {
    const windowId = [...existing].sort((a, b) => a.windowId - b.windowId)[0]!.windowId
    trackManagedWindow(cdp, { windowId, createdAt: Date.now(), source: 'adopted' })
    transition(deps, { event: 'managed-window', ...ref, session, windowId,
      branch: 'adopt', detail: `existing-window windows=${existing.length}` })
    return openBackgroundTab(deps, meta, route, requestId, payload.url, cur, windowId, true)
  }

  if (firstDisplayUsed(cdp)) {
    transition(deps, { event: 'managed-window', ...ref, session, branch: 'refused',
      detail: 'one-time-background-first-display-used' })
    return {
      kind: 'refused',
      status: 409,
      body: {
        ok: false,
        error: 'managed window unavailable',
        reason: 'the one-time zero-window background window was already created and is now closed; the daemon will not pop another one',
        hint: 'open a window explicitly (bl show / login), or request the invisible protocol-only mode with {"windowless":true}',
      },
    }
  }

  transition(deps, { event: 'managed-window', ...ref, session, branch: 'create-requested',
    detail: 'reason=zero-window-cold-start one-time-display=true' })
  // The attempt is irreversible from here: `Target.createTarget` can already
  // materialize a native window even when the window lookup afterwards fails.
  // Consume the one-time allowance BEFORE the side effect so a failed attempt
  // can never pop a second window (fail closed).
  markFirstDisplayUsed(cdp)
  // background:true keeps the new tab inactive if the window does appear once.
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: payload.url, background: true })
  const windowId = await targetWindowId(cdp, targetId)
  if (windowId === null) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    transition(deps, { event: 'managed-window', ...ref, session, branch: 'first-display-unresolved',
      detail: 'attempt=consumed state=unresolved fail-closed=true' })
    throw new Error('could not resolve the native window of the first tab; the one-time display was consumed (fail closed)')
  }
  trackManagedWindow(cdp, { windowId, firstTargetId: targetId, createdAt: Date.now(), source: 'background-first-display' })
  transition(deps, { event: 'managed-window', ...ref, session, windowId,
    branch: 'created', detail: 'first-display=once' })
  const settle = await settleFirstWindow(deps, meta, route, requestId, cur, windowId)
  transition(deps, { event: 'open', ...ref, session, windowId, branch: 'first-window',
    detail: `windowId=${windowId} settled=${settle.settled}${settle.reason ? ` reason=${settle.reason}` : ''}` })
  return {
    kind: 'tab', targetId, windowId, reused: false, firstDisplay: true,
    settled: settle.settled, settleReason: settle.reason,
  }
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ServerDeps,
  native: NativeControl,
  login: (meta: RequestMeta) => Promise<LoginResult>,
  nextRequestId: () => string,
) {
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : ''
  const payload = body ? (() => { try { return JSON.parse(body) } catch { return {} } })() : {}
  const route = `${req.method} ${url.pathname}`
  const requestId = nextRequestId()
  const meta = requestMeta(payload, route, requestId)

  switch (route) {
    case 'GET /api/demo': {
      json(res, 200, { now: Date.now() })
      return
    }
    case 'GET /api/status': {
      const settings = loadSettings()
      const cur = deps.manager.current
      const windowlessPages = cur
        ? await pendingWindowlessPages(cur.cdp).then(p => p.length).catch(() => 0)
        : 0
      json(res, 200, {
        daemon: { version: deps.version, pid: process.pid, uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000), port: settings.proxyPort },
        settings,
        control: deps.supervisor.humanMode ? 'human' : 'background',
        // Let the tray attribute auto-show reactions: `intent` is the last
        // explicit user action, `internal` is a daemon-internal native
        // activation interval (capture picker). No page content is exposed.
        intent: deps.supervisor.lastIntent(),
        internal: deps.supervisor.internalState(),
        // One managed session, shared by Dock/launchpad/menu/API attribution.
        // `managedWindowId` is the single real window reused by background
        // opens; `firstDisplayUsed` says whether the one-time zero-window
        // creation was spent. `takeover` stays honest about protocol-only
        // windowless pages (window-open.ts / managed-window.ts).
        session: cur
          ? {
              id: browserSessionId(cur),
              space: cur.space,
              pid: cur.pid,
              startedAt: cur.startedAt,
              managedWindowId: managedWindow(cur.cdp)?.windowId ?? null,
              firstDisplayUsed: firstDisplayUsed(cur.cdp),
              windowlessPages,
              takeover: managedWindow(cur.cdp)
                ? 'real-window'
                : windowlessPages > 0 ? 'windowless-limited' : 'none',
            }
          : null,
        browser: cur
          ? {
              running: true,
              pid: cur.pid,
              binary: cur.binary,
              version: cur.version,
              upstreamPort: cur.upstreamPort,
              space: cur.space,
              extensions: deps.extensions.list().filter(e => cur.extensionPaths.includes(e.path)).map(e => e.name),
              startedAt: cur.startedAt,
              captureTargetId: deps.capture.activeTargetId(),
              windowlessPages,
            }
          : { running: false },
      })
      return
    }
    case 'POST /api/launch': {
      const requestedForeground = payload.focus === true || payload.keepVisible === true || payload.background === false
      // Showing a window (`focus`/`keepVisible`/`background:false`) is
      // foreground state: it requires BOTH an explicit control-surface source
      // AND an actual visibility flag. A plain launch — even `cli.launch`, as
      // the CLI itself promises — is forced background and never inherits
      // settings.launchMode.
      const explicitLaunch = meta.origin === 'explicit'
      const foreground = requestedForeground && explicitLaunch
      const gen = deps.supervisor.beginControl() // a new launch outranks any settling collapse
      const intent = deps.supervisor.noteIntent(meta.origin, foreground ? 'show' : 'bg', { source: meta.source, route, requestId, gen })
      if (requestedForeground && !foreground) {
        transition(deps, { event: 'policy-downgrade', ...intentFields(intent), branch: 'foreground', detail: 'non-explicit-visible-launch' })
      }
      deps.supervisor.humanMode = foreground
      try {
        await deps.capture.setPaused(foreground)
        deps.supervisor.start()
        // A launch materializes windows too: serialize it with every other
        // window-materializing path so launch/open concurrency cannot produce
        // two first windows (the first-display allowance is read-then-write).
        const { inst, outcome } = await withWindowLock(deps, async () => {
          // A background launch never passes the URL to the manager: the first
          // real tab (and its one-time window display) is created afterwards
          // through the single managed-window path, so it is tracked and
          // settled to the background instead of being re-created later.
          const inst = await deps.manager.launch({
            url: foreground ? payload.url : undefined,
            space: payload.space,
            with: payload.with,
            bare: payload.bare === true,
            focus: foreground && (payload.focus === true || payload.background === false),
            keepVisible: foreground && payload.keepVisible === true,
          })
          let outcome: OpenOutcome | null = null
          if (!foreground && payload.url && deps.manager.current) {
            outcome = await openManagedPage(deps, meta, route, requestId, payload, deps.manager.current)
          } else if (foreground && deps.manager.current) {
            // Remember the human-visible window as the single managed one.
            const cdp = deps.manager.current.cdp
            const windows = await deps.supervisor.windowStates().catch(() => [])
            if (!managedWindow(cdp) && windows.length > 0) {
              const windowId = [...windows].sort((a, b) => a.windowId - b.windowId)[0]!.windowId
              trackManagedWindow(cdp, { windowId, createdAt: Date.now(), source: 'explicit' })
              transition(deps, { event: 'managed-window', ...intentFields(intent), windowId,
                branch: 'adopt', detail: 'explicit-visible-launch' })
            }
          }
          return { inst, outcome }
        })
        if (outcome?.kind === 'refused') {
          deps.supervisor.completeIntent(intent.token, 'applied')
          json(res, 409, { ok: false, pid: inst.pid, ...(outcome.body as object) })
          return
        }
        const windowless = outcome?.kind === 'windowless'
        transition(deps, {
          event: 'launch', ...intentFields(intent), pid: inst.pid,
          branch: foreground ? 'visible' : 'background',
          detail: outcome?.kind === 'tab'
            ? `windowId=${outcome.windowId} firstDisplay=${outcome.firstDisplay} settled=${outcome.settled}`
            : windowless ? `windowless-page adoption=${windowlessCapability().adoption}` : undefined,
        })
        deps.supervisor.completeIntent(intent.token, 'applied')
        json(res, 200, {
          ok: true, pid: inst.pid, upstreamPort: inst.upstreamPort, version: inst.version,
          windowless, takeover: !windowless,
          ...(outcome?.kind === 'tab'
            ? { windowId: outcome.windowId, firstDisplay: outcome.firstDisplay, settled: outcome.settled,
                ...(outcome.settleReason ? { settleReason: outcome.settleReason } : {}) }
            : {}),
        })
      } catch (err) {
        transition(deps, { event: 'launch', ...intentFields(intent), branch: 'failed', detail: (err as Error).message })
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'POST /api/login': {
      // Login launches visibly, maximizes and foregrounds: it always requires
      // an explicit caller source; auto/unknown requests are refused before any
      // side effect and logged as rejected (never silently treated as human).
      if (meta.origin !== 'explicit') {
        transition(deps, {
          event: 'request-rejected', origin: meta.origin, source: meta.source, route, requestId,
          branch: 'non-explicit', detail: 'login requires an explicit source',
        })
        json(res, 400, { ok: false, error: 'login requires an explicit source label (e.g. cli.login)' })
        return
      }
      const result = await login(meta)
      json(res, 200, result)
      return
    }
    case 'POST /api/stop': {
      deps.supervisor.beginControl() // stop outranks any settling collapse
      deps.supervisor.stop()
      await deps.manager.stop()
      json(res, 200, { ok: true })
      return
    }
    case 'POST /api/console': {
      // Explicit user action (tray "open console"): show the daemon dashboard
      // in the managed Backlight browser, never in the macOS default browser.
      // Recursion-safe: the dashboard only calls local /api/* endpoints.
      if (meta.origin !== 'explicit') {
        transition(deps, {
          event: 'request-rejected', origin: meta.origin, source: meta.source, route, requestId,
          branch: 'non-explicit', detail: 'console requires an explicit source',
        })
        json(res, 400, { ok: false, error: 'console requires an explicit source label (e.g. tray.menu.console)' })
        return
      }
      const gen = deps.supervisor.beginControl()
      const intent = deps.supervisor.noteIntent(meta.origin, 'show', { source: meta.source, route, requestId, gen })
      deps.supervisor.humanMode = true
      const dashboardUrl = `http://127.0.0.1:${req.socket.localPort}/`
      let launched = false
      let activated = false
      try {
        await deps.capture.setPaused(true)
        if (!deps.manager.running) {
          const inst = await deps.manager.launch({ url: dashboardUrl, focus: true })
          transition(deps, { event: 'console-open', ...intentFields(intent), pid: inst.pid, branch: 'launched-managed' })
          deps.supervisor.completeIntent(intent.token, 'applied')
          json(res, 200, { ok: true, launched: true, activated: false })
          return
        }
        const cur = deps.manager.current!
        const tabs = await deps.manager.listTabs()
        const existing = tabs.find(t => t.type === 'page' && t.url.startsWith(dashboardUrl))
        if (existing) {
          await cur.cdp.send('Target.activateTarget', { targetId: existing.targetId })
          activated = true
        } else {
          await cur.cdp.send('Target.createTarget', { url: dashboardUrl })
        }
        await deps.supervisor.restoreAll(false, gen)
        await native.persist(gen, true, meta)
        transition(deps, {
          event: 'console-open', ...intentFields(intent), pid: cur.pid,
          branch: existing ? 'activated-existing-tab' : 'created-managed-tab', after: 'visible',
        })
        deps.supervisor.completeIntent(intent.token, 'applied')
        json(res, 200, { ok: true, launched, activated })
      } catch (err) {
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'POST /api/restart': {
      if (!deps.manager.running) return json(res, 409, { error: 'browser not running' })
      const requestedForeground = payload.focus === true || payload.keepVisible === true || payload.background === false
      // Conservative visibility contract, identical to /api/launch: a restart
      // may only come back on screen when an explicit control surface requests
      // it with an actual visibility flag. A plain restart — even `cli.restart`
      // — is forced background and never inherits settings.launchMode.
      const foreground = requestedForeground && meta.origin === 'explicit'
      // Fail closed for hidden background restarts BEFORE any side effect:
      // stopping a working invisible browser only to repair an unhide that
      // macOS performs during relaunch/session rebuild would violate the
      // no-reappearance contract. The browser keeps running unchanged.
      if (!foreground) {
        const deferral = await deps.manager.backgroundRestartDeferral()
        if (deferral) {
          transition(deps, {
            event: 'restart', origin: meta.origin, source: meta.source, route, requestId,
            gen: deps.supervisor.controlGen(), branch: 'deferred', after: 'unchanged',
            detail: `${deferral}: hidden browser kept running (stop-then-launch would unhide it before the repair hide; use an explicit visible restart or bl stop/bl launch)`,
          })
          json(res, 409, {
            ok: false, restarted: false, deferred: true, reason: deferral,
            error: `hidden background restart deferred (${deferral}); the running browser was kept; use an explicit visible restart (focus/keepVisible) or \`bl stop\` + \`bl launch\``,
          })
          return
        }
      }
      // Windowless background pages cannot survive a restart (their process is
      // replaced and their URLs are never cloned). Report the count instead of
      // dropping them silently.
      const windowlessDropped = deps.manager.current
        ? await pendingWindowlessPages(deps.manager.current.cdp).then(p => p.length).catch(() => 0)
        : 0
      const gen = deps.supervisor.beginControl() // restart outranks any settling collapse
      const intent = deps.supervisor.noteIntent(meta.origin, foreground ? 'show' : 'bg', { source: meta.source, route, requestId, gen })
      if (requestedForeground && !foreground) {
        transition(deps, { event: 'policy-downgrade', ...intentFields(intent), branch: 'foreground', detail: 'non-explicit-visible-restart' })
      }
      const previousHumanMode = deps.supervisor.humanMode
      deps.supervisor.humanMode = foreground
      try {
        const result = await deps.manager.restart(payload.reason ?? 'manual restart', {
          focus: foreground && (payload.focus === true || payload.background === false),
          keepVisible: foreground && payload.keepVisible === true,
        })
        if (!result.restarted) {
          // The manager re-checked and refused (state changed while the route
          // was queued); never report an applied restart, never claim visible.
          deps.supervisor.humanMode = previousHumanMode
          transition(deps, {
            event: 'restart', ...intentFields(intent), branch: 'deferred', after: 'unchanged',
            detail: `${result.deferred ?? 'deferred'}: hidden browser kept running`,
          })
          deps.supervisor.completeIntent(intent.token, 'superseded')
          json(res, 409, {
            ok: false, restarted: false, deferred: true, reason: result.deferred ?? 'deferred',
            error: 'hidden background restart deferred; the running browser was kept',
          })
          return
        }
        transition(deps, {
          event: 'restart', ...intentFields(intent),
          branch: foreground ? 'visible-request' : 'forced-background',
          after: foreground ? 'visible' : 'background',
          detail: windowlessDropped > 0 ? `windowless-dropped=${windowlessDropped} adoption=unsupported` : undefined,
        })
        deps.supervisor.completeIntent(intent.token, 'applied')
        json(res, 200, { ok: true, windowlessDropped })
      } catch (err) {
        transition(deps, { event: 'restart', ...intentFields(intent), branch: 'failed', detail: (err as Error).message })
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'POST /api/bg': {
      // Last user intent wins: allocate the generation on route entry, before
      // any await, so a show arriving while this request is parked cannot be
      // outranked by a later allocation. Every delayed step and the native
      // hide (in its own critical section) recheck it.
      const gen = deps.supervisor.beginControl()
      const intent = deps.supervisor.noteIntent(meta.origin, 'bg', { source: meta.source, route, requestId, gen })
      try {
        await deps.capture.setPaused(false)
        // Arm capture while the window is still visible. Chrome only establishes
        // the capture frame source in that state; arming after minimization
        // grants the rAF exemption but no real frames/screenshots. Arming itself
        // is invisible (hidden extension page, no activation), and having the
        // capture already active is what lets the collapse stay invisible.
        transition(deps, { event: 'capture-prearm', ...intentFields(intent), branch: 'requested' })
        let prearmError: string | undefined
        const prearmed = await deps.capture.prearm().catch((err) => { prearmError = (err as Error).message; return null })
        transition(deps, {
          event: 'capture-prearm', ...intentFields(intent),
          branch: prearmed ? 'armed' : prearmError ? 'failed' : 'none',
          detail: prearmError,
        })
        // A hidden app needs the normal -> minimized cycle repeated for the
        // miniaturize (and renderer visibility) to actually apply; the repeat is
        // invisible there. A visible app minimizes on the first cycle.
        let appHidden = false
        let appStateKnown = false
        if (deps.manager.current) {
          try { appHidden = (await deps.appState(deps.manager.current.pid)).hidden; appStateKnown = true } catch { /* unknown: single cycle */ }
        }
        const n = deps.manager.running ? await deps.supervisor.collapseAll(appHidden, gen) : 0
        let hidden: boolean | undefined
        if (deps.manager.current) {
          const pid = deps.manager.current.pid
          const base = {
            ...intentFields(intent), pid,
            before: appStateKnown ? (appHidden ? 'hidden' : 'visible') : undefined,
          }
          transition(deps, { event: 'native-hide', ...base, branch: 'requested' })
          try {
            hidden = await native.op(gen, async () => { await deps.hideBrowser(pid); return true })
          } catch (err) {
            transition(deps, { event: 'native-hide', ...base, branch: 'failed', detail: (err as Error).message })
            throw err
          }
          transition(deps, {
            event: 'native-hide', ...base,
            after: hidden ? 'hidden' : undefined,
            branch: hidden ? 'applied' : 'superseded',
          })
        }
        const superseded = !deps.supervisor.isControlCurrent(gen)
        deps.supervisor.completeIntent(intent.token, superseded ? 'superseded' : 'applied')
        json(res, 200, { ok: true, collapsed: n, superseded })
      } catch (err) {
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'POST /api/show':
    case 'POST /api/restore': {
      const observedAt = Number.isFinite(Number(payload.observedAt)) ? Number(payload.observedAt) : Date.now()
      // Provenance gate: only an explicit, allowlisted control surface may
      // create or restore on-screen state. Auto and unknown requests are
      // recorded and refused BEFORE any side effect: no control generation
      // bump, no restore, no unhide/activate. A delayed tray reconcile after
      // an explicit bg therefore can never rebound the window.
      if (meta.origin !== 'explicit') {
        if (meta.origin === 'auto') {
          // An OS/tray observation is not a verified physical click; the
          // bounded internal-activity / in-flight checks only label why the
          // window stays hidden. `evidence` records what the OS currently
          // shows so the uncertainty is auditable.
          const reason = deps.supervisor.autoShowSkipReason(observedAt) ?? 'unverified-activation'
          let evidence = 'no-browser'
          const cur = deps.manager.current
          if (cur) {
            try {
              const state = await deps.appState(cur.pid)
              evidence = state.hidden ? 'hidden' : state.active ? 'active-visible' : 'unhidden-inactive'
            } catch { evidence = 'unknown' }
          }
          transition(deps, {
            event: 'show-skip', origin: meta.origin, source: meta.source, route, requestId,
            gen: deps.supervisor.controlGen(), branch: reason,
            detail: `observedAt=${Math.round(observedAt)} evidence=${evidence}`,
          })
          if (evidence === 'active-visible') {
            // A Dock reopen may make Chrome create its own window; the daemon
            // must not fill it by cloning windowless pages (URL clone loses
            // page identity). Record the refusal, change nothing.
            const pending = cur ? await pendingWindowlessPages(cur.cdp).catch(() => []) : []
            if (pending.length) noteWindowlessHandoff(deps, meta, 'dock-visible', pending.length)
          }
          json(res, 200, { ok: true, restored: 0, ignored: reason })
          return
        }
        transition(deps, {
          event: 'show-skip', origin: meta.origin, source: meta.source, route, requestId,
          gen: deps.supervisor.controlGen(), branch: 'unverified-source',
          detail: 'show requires an explicit control-surface source',
        })
        json(res, 400, {
          ok: false, restored: 0, ignored: 'unverified-source',
          error: 'show requires an explicit source label (e.g. cli.show, tray.menu.show)',
        })
        return
      }
      const gen = deps.supervisor.beginControl() // newer intent invalidates an in-flight bg
      const intent = deps.supervisor.noteIntent(meta.origin, 'show', { source: meta.source, route, requestId, gen })
      deps.supervisor.humanMode = true
      try {
        await deps.capture.setPaused(true)
        let n = 0
        // Restore + native unhide/activate are atomic with respect to
        // background opens: a queued open observes humanMode and never
        // re-hides the window the human just took over.
        await withWindowLock(deps, async () => {
          await ensureManualWindow(deps, gen, meta)
          n = deps.manager.running ? await deps.supervisor.restoreAll(payload.maximize === true, gen) : 0
          await native.persist(gen, payload.activate !== false, meta)
        })
        deps.supervisor.completeIntent(intent.token, 'applied')
        json(res, 200, { ok: true, restored: n })
      } catch (err) {
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'GET /api/windows': {
      json(res, 200, {
        windows: deps.manager.running ? await deps.supervisor.windowStates() : [],
        pumping: deps.supervisor.pumpTargetIds().length,
      })
      return
    }
    case 'GET /api/state-log': {
      // Bounded, privacy-safe recent transitions (no URLs/titles/content).
      const limit = Number(url.searchParams.get('limit') ?? 50)
      json(res, 200, { entries: deps.stateLog?.recent(limit) ?? [] })
      return
    }
    case 'GET /api/health': {
      json(res, 200, { targets: deps.health.snapshot() })
      return
    }
    case 'GET /api/activity': {
      json(res, 200, { events: deps.bus.recent(Number(url.searchParams.get('limit') ?? 50)) })
      return
    }
    case 'GET /api/extensions': {
      let runtime: unknown[] = []
      let runtimeError: string | undefined
      try { runtime = await deps.extensionDev.runtime() } catch (err) { runtimeError = (err as Error).message }
      json(res, 200, { extensions: deps.extensions.list(), loaded: deps.manager.current?.extensionPaths ?? [], runtime, runtimeError, lastReload: deps.extensionDev.lastReload })
      return
    }
    case 'POST /api/extensions/add': {
      if (!payload.path) return json(res, 400, { error: 'path required' })
      const entry = deps.extensions.add(payload.path, payload.name)
      if (deps.manager.running) await deps.extensionDev.load(entry.name)
      json(res, 200, { ok: true, extension: entry })
      return
    }
    case 'POST /api/extensions/remove': {
      const ok = await deps.extensionDev.remove(String(payload.name ?? ''))
      json(res, 200, { ok })
      return
    }
    case 'POST /api/extensions/reload': {
      const extension = await deps.extensionDev.load(String(payload.name ?? ''), true)
      json(res, 200, { ok: true, extension, browserRestarted: false, note: '内容脚本更新需刷新目标网页；未自动刷新，以保留输入内容。' })
      return
    }
    case 'POST /api/extensions/dev': {
      // The dev loop opens a real side panel on a visible window: an explicit
      // control surface is required, auto/unknown are refused with zero side
      // effects (no launch, no restore, no capture pause).
      if (meta.origin !== 'explicit') {
        transition(deps, {
          event: 'request-rejected', origin: meta.origin, source: meta.source, route, requestId,
          branch: 'non-explicit', detail: 'extensions/dev requires an explicit source',
        })
        json(res, 400, { ok: false, error: 'extensions/dev requires an explicit source label (e.g. cli.ext.dev)' })
        return
      }
      const gen = deps.supervisor.beginControl() // newer intent invalidates an in-flight bg
      const intent = deps.supervisor.noteIntent(meta.origin, 'show', { source: meta.source, route, requestId, gen })
      try {
        const name = String(payload.name ?? '')
        deps.extensionDev.entry(name)
        if (!deps.manager.running) {
          if (!payload.url) {
            deps.supervisor.completeIntent(intent.token, 'failed')
            return json(res, 400, { error: 'url required to start extension development' })
          }
          // Background first launch; make it visible only through the explicit
          // restore/activate below, never through settings.launchMode.
          await deps.manager.launch({ url: payload.url, with: [name], focus: false })
        }
        deps.supervisor.humanMode = true
        await deps.capture.setPaused(true)
        const cur = deps.manager.current!
        let targetId = payload.targetId
        if (!targetId && payload.url) {
          targetId = (await deps.manager.listTabs()).find(t => t.type === 'page' && t.url === payload.url)?.targetId
          if (!targetId) targetId = (await cur.cdp.send('Target.createTarget', { url: payload.url, background: true })).targetId
        }
        if (!targetId) {
          deps.supervisor.completeIntent(intent.token, 'failed')
          return json(res, 400, { error: 'select a website targetId or url' })
        }
        await deps.supervisor.restoreAll(payload.maximize === true, gen)
        await native.persist(gen, payload.activate !== false, meta)
        const result = await deps.extensionDev.openPanel(name, targetId)
        deps.supervisor.completeIntent(intent.token, 'applied')
        json(res, 200, { ok: true, ...result })
      } catch (err) {
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'GET /api/targets': {
      const cur = deps.manager.current
      const windowless = cur ? await pendingWindowlessPages(cur.cdp) : []
      json(res, 200, { targets: [
        ...(await deps.manager.listTabs()).filter(t => t.type === 'page' || t.type === 'service_worker'),
        ...windowless.map(t => ({ ...t, type: 'other', title: '', attached: false, windowless: true })),
      ] })
      return
    }
    case 'GET /api/capabilities': {
      const capability = windowlessCapability()
      json(res, 200, {
        windowlessOpen: true,
        windowless: {
          supported: capability.create,
          adoption: capability.adoption,
          browserPilot: capability.browserPilot,
          reason: capability.reason,
        },
        // Product trade-off 2026-09-17: zero-window cold start creates ONE
        // real managed window (macOS may show it once), then settles it to the
        // background. Later human opens restore the same window/tabs, so AI
        // background work and human inspection are the same document.
        zeroWindowRealTab: {
          supported: true,
          firstDisplay: 'once-per-browser-session',
          sameWindowReuse: true,
          windowlessFallback: true,
          reason: 'zero-window cold start creates one real managed window; it may appear once, then capture is pre-armed and the window is minimized and natively hidden; every later background tab reuses that same window',
          evidence: 'isolated probe 2026-09-17 (CfT 153, temp profile): first background:true tab materialized one window, on-screen ~1s at the offscreen corner with app active=false; after minimize+hide the same target id and in-memory nonce survived, and a simulated human show restored the same target/document (1 page target). Repeated creation after the window is lost is refused with 409',
        },
      })
      return
    }
    case 'POST /api/inspect': {
      const cur = deps.manager.current
      if (!cur) return json(res, 409, { error: 'browser not running' })
      const target = (await deps.manager.listTabs()).find(t => t.targetId === payload.targetId)
      if (!target) return json(res, 404, { error: 'target is no longer available; refresh the target list' })
      // An inspector needs its own visible window: explicit control surface
      // only, auto/unknown are refused with zero side effects.
      if (meta.origin !== 'explicit') {
        transition(deps, {
          event: 'request-rejected', origin: meta.origin, source: meta.source, route, requestId,
          branch: 'non-explicit', detail: 'inspect requires an explicit source',
        })
        json(res, 400, { ok: false, error: 'inspect requires an explicit source label (e.g. cli.inspect)' })
        return
      }
      const gen = deps.supervisor.beginControl() // newer intent invalidates an in-flight bg
      const intent = deps.supervisor.noteIntent(meta.origin, 'show', { source: meta.source, route, requestId, gen })
      try {
        deps.supervisor.humanMode = true
        await deps.capture.setPaused(true)
        // Go through our loopback proxy: Chromium rejects the frontend's
        // devtools:// Origin at its raw remote-debugging socket.
        const inspectorUrl = `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${req.socket.localPort}/devtools/page/${target.targetId}`
        const { targetId } = await cur.cdp.send('Target.createTarget', { url: inspectorUrl, newWindow: true })
        await deps.supervisor.restoreAll(false, gen)
        await native.persist(gen, payload.activate !== false, meta)
        deps.supervisor.completeIntent(intent.token, 'applied')
        json(res, 200, { ok: true, targetId })
      } catch (err) {
        deps.supervisor.completeIntent(intent.token, 'failed')
        throw err
      }
      return
    }
    case 'POST /api/open': {
      if (!payload.url) return json(res, 400, { error: 'url required' })
      // Serialized with every other window-materializing request: the
      // launch + first-display check + create must be one critical section.
      const opened = await withWindowLock(deps, async () => {
        let launched = false
        if (!deps.manager.running) {
          // Background launch without a URL: the first real tab (and therefore
          // the one-time window display) is created below through the single
          // managed-window path, after the verified hide.
          await deps.manager.launch({ with: payload.with, focus: false })
          launched = true
        }
        const cur = deps.manager.current!
        if (!launched) for (const name of payload.with ?? []) await deps.extensionDev.load(name)
        return { cur, outcome: await openManagedPage(deps, meta, route, requestId, payload, cur) }
      })
      const { cur, outcome } = opened
      const session = browserSessionId(cur)
      if (outcome.kind === 'refused') {
        json(res, outcome.status, outcome.body)
        return
      }
      if (outcome.kind === 'windowless') {
        json(res, 200, {
          ok: true, targetId: outcome.targetId, windowless: true, takeover: false,
          capability: windowlessCapability(), session,
        })
        return
      }
      json(res, 200, {
        ok: true, targetId: outcome.targetId, windowId: outcome.windowId,
        windowless: false, takeover: true, reusedWindow: outcome.reused,
        firstDisplay: outcome.firstDisplay, settled: outcome.settled,
        ...(outcome.settleReason ? { settleReason: outcome.settleReason } : {}),
        session,
      })
      return
    }
    case 'GET /api/import/sources': {
      json(res, 200, { sources: listChromeProfiles() })
      return
    }
    case 'POST /api/import': {
      const settings = loadSettings()
      const space = payload.space ?? settings.space
      const sources = listChromeProfiles()
      const src = payload.source
        ? sources.find(s => s.dir === payload.source || s.name === payload.source || `${s.browser}/${s.dir}` === payload.source)
        : sources[0]
      if (!src) return json(res, 400, { error: payload.source ? `source profile not found: ${payload.source}` : 'no Chrome profiles found on this machine' })
      const wasRunning = deps.manager.running
      if (wasRunning) await deps.manager.stop()
      let copied: string[]
      try {
        copied = importProfile(src.baseDir, src.dir, space)
      } catch (err) {
        return json(res, 400, { error: (err as Error).message })
      }
      json(res, 200, { ok: true, space, source: `${src.browser} / ${src.dir} (${src.name})`, copied })
      return
    }
    case 'POST /api/browser/brand': {
      if (deps.manager.running) return json(res, 409, { error: 'stop the browser first (bl stop)' })
      const name = String(payload.name ?? 'Backlight').slice(0, 40)
      let cftBin: string | null = null
      try {
        cftBin = await ensureChromiumForExtensions()
      } catch (err) {
        return json(res, 500, { error: `CfT unavailable: ${(err as Error).message}` })
      }
      if (!cftBin) return json(res, 500, { error: 'Chrome for Testing unavailable (download failed)' })
      const srcApp = cftBin.slice(0, cftBin.indexOf('.app') + '.app'.length)
      const safe = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-')
      const destApp = path.join(paths.root, 'apps', `${safe}.app`)
      const destBin = await brandBundle({
        srcApp,
        destApp,
        name,
        iconPng: payload.icon ? path.resolve(String(payload.icon)) : undefined,
      })
      saveSettings({ browser: destBin })
      json(res, 200, {
        ok: true,
        browser: destBin,
        note: 'branded browser keeps its own login store (fresh logins); imported cookies work with the unbranded Google Chrome engine',
      })
      return
    }
    case 'POST /api/settings': {
      const allowed: Array<keyof Settings> = ['backgroundMode', 'captureKeepAlive', 'halo', 'pumpFps', 'soloExtensions', 'space', 'browser', 'proxyPort', 'launchMode', 'collapseMode']
      const patch: Partial<Settings> = {}
      for (const k of allowed) if (k in payload) (patch as any)[k] = payload[k]
      const settings = saveSettings(patch)
      json(res, 200, { ok: true, settings })
      return
    }
    default:
      json(res, 404, { error: `no api route: ${route}` })
  }
}


// ---- controller tab (tab-capture keep-alive trigger) -------------------------

function controllerHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>bl-controller</title></head>
<body style="font:24px monospace;background:#0b0f14;color:#37c8ff">
Backlight controller · 后台保活运行中
<script>
  window.__stream = null;
  window.startCapture = async (fps) => {
    try {
      if (window.__stream) return 'already';
      window.__stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps || 10 }, audio: false });
      window.__stream.getVideoTracks()[0].addEventListener('ended', () => { window.__stream = null });
      return 'ok';
    } catch (e) { return 'err: ' + (e && e.name); }
  };
  window.stopCapture = () => {
    try { if (window.__stream) window.__stream.getTracks().forEach(t => t.stop()); } catch {}
    const had = !!window.__stream; window.__stream = null; return had ? 'stopped' : 'none';
  };
</script></body></html>`
}

// ---- dashboard ---------------------------------------------------------------

function dashboardHtml(deps: ServerDeps): string {
  const escapedVersion = escapeHtml(deps.version)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Backlight · 后台浏览器</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "PingFang SC", "Segoe UI", sans-serif; background: #0b0f14; color: #d7e2ec; }
  header { display: flex; align-items: center; gap: 10px; padding: 14px 20px; background: #101720; border-bottom: 1px solid #1d2935; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .dot { width: 10px; height: 10px; border-radius: 50%; background: #37c8ff; box-shadow: 0 0 8px #37c8ff; }
  header .sub { color: #7b8b9c; font-size: 12px; }
  main { padding: 20px; max-width: 1080px; margin: 0 auto; display: grid; gap: 16px; }
  section { background: #101720; border: 1px solid #1d2935; border-radius: 10px; padding: 14px 16px; }
  section h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #7b8b9c; }
  button { background: #16222e; color: #d7e2ec; border: 1px solid #24374a; border-radius: 8px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #1d2d3d; border-color: #37c8ff; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #17232f; }
  th { color: #7b8b9c; font-weight: 500; }
  .ok { color: #4ade80; } .bad { color: #f87171; } .warn { color: #fbbf24; }
  #activity { max-height: 260px; overflow-y: auto; font-size: 12.5px; }
  #activity div { padding: 2px 0; border-bottom: 1px solid #131e29; }
  #activity .m { color: #37c8ff; }
  #activity .t { color: #5c6f81; margin-right: 8px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  input, select { background: #0b0f14; border: 1px solid #24374a; color: #d7e2ec; border-radius: 8px; padding: 7px 10px; font-size: 13px; min-width: 220px; max-width: 100%; }
  select { flex: 1; }
  button:disabled { opacity: .5; cursor: wait; }
  kbd { background:#16222e;border:1px solid #24374a;border-radius:4px;padding:1px 6px;font-size:11px;color:#9fb3c6; }
</style>
</head>
<body>
<header>
  <div class="dot" id="pulseDot"></div>
  <h1>Backlight · 后台浏览器</h1>
  <span class="sub" id="ver">v${escapedVersion}</span>
  <span class="sub" id="status">connecting…</span>
</header>
<main>
  <section>
    <h2>控制</h2>
    <div class="row">
      <button id="bLaunch">启动浏览器</button>
      <button id="bBg">收起到后台</button>
      <button id="bRestore">显示并接管</button>
      <button id="bMaximize">最大化</button>
      <button id="bStop">关闭浏览器</button>
      <input id="url" placeholder="https://example.com  — 打开新标签页" />
      <button id="bOpen">打开</button>
    </div>
    <p id="notice" role="status" aria-live="polite" class="sub">默认静默打开网页。需要登录或扫码时，点击“显示并接管”。</p>
  </section>
  <section>
    <h2>插件开发 · 网页与侧栏一起调试</h2>
    <div class="row"><input id="extPath" placeholder="未打包扩展的本地绝对路径" aria-label="扩展目录"/><button id="bExtAdd">添加扩展</button></div>
    <div class="row" style="margin-top:12px"><select id="extName" aria-label="选择扩展"></select><input id="devUrl" placeholder="目标网页，留空使用本地体验页" aria-label="侧栏目标网页"/><button id="bExtDev">打开网页 + 侧栏</button><button id="bExtReload">重载扩展</button></div>
    <p class="sub" id="extStatus">加载扩展列表…</p>
    <p class="sub">保存扩展代码后自动重载，网页输入保持原状。内容脚本修改后，请刷新目标网页。</p>
    <div class="row"><select id="target" aria-label="选择调试目标"></select><button id="bInspect">调试所选目标</button></div>
  </section>
  <section>
    <h2>后台健康度</h2>
    <table id="health"><thead><tr><th>页面</th><th>可见性</th><th>逻辑帧/s</th><th>原生帧/s</th><th>定时器/s</th><th>状态</th></tr></thead><tbody></tbody></table>
  </section>
  <section>
    <h2>AI 指令活动流（WebSocket /activity）</h2>
    <div id="activity"></div>
  </section>
  <section>
    <h2>说明</h2>
    <div class="sub">后台页面可持续加载数据。原生渲染保活目前覆盖一个目标，其余页面使用定时器与逻辑帧兜底；请以实测健康度为准。人工接管期间暂停新的捕获设置。AI 连接地址：<kbd id="connection"></kbd>。</div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  $('connection').textContent = location.origin;
  async function api(path, opts) { const r = await fetch(path, opts); const body = await r.json(); if (!r.ok) throw new Error(body.error || '操作失败'); return body; }
  const post = (path, body = {}) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const action = (id, fn) => { $(id).onclick = async () => { $(id).disabled = true; $('notice').textContent = '处理中…'; try { const message = await fn(); $('notice').textContent = message || '已完成'; await refreshStatus(); await refreshExtensions(); } catch(e) { $('notice').textContent = e.message; } finally { $(id).disabled = false; } }; };
  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      $('status').textContent = s.browser?.running
        ? (s.control === 'human' ? '人工接管中 · 完成后可收起到后台' : '后台运行中')
        : '浏览器未运行';
    } catch { $('status').textContent = 'daemon 离线'; }
  }
  async function refreshHealth() {
    try {
      const h = await api('/api/health');
      const tb = $('health').querySelector('tbody');
      tb.innerHTML = (h.targets ?? []).map(t => {
        const bg = t.visibility !== 'visible';
        const good = t.timerPerSec >= 5;
        return \`<tr><td>\${escapeHtml(t.title || t.url).slice(0, 60)}</td>
          <td class="\${bg ? 'warn' : 'ok'}">\${t.visibility}</td>
          <td>\${t.rafPerSec}</td><td>\${t.nativeRafPerSec}</td><td>\${t.timerPerSec}</td>
          <td class="\${good ? 'ok' : 'warn'}">\${good ? '定时器正常' : '采样中 / 请检查'}</td></tr>\`;
      }).join('');
    } catch {}
  }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function options(select, entries) {
    const current = select.value;
    select.replaceChildren(...entries.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
    if (entries.some(([value]) => value === current)) select.value = current;
  }
  async function refreshExtensions() {
    try {
      const e = await api('/api/extensions');
      options($('extName'), e.extensions.map(ext => [ext.name, ext.name]));
      $('extStatus').textContent = e.lastReload ? e.lastReload.name + '：' + e.lastReload.message : e.runtimeError || '已注册 ' + e.extensions.length + ' 个扩展';
      const t = await api('/api/targets');
      options($('target'), t.targets.filter(x => !x.url.startsWith('devtools:')).map(x => [x.targetId, (x.type === 'service_worker' ? '后台脚本 · ' : x.url.startsWith('chrome-extension:') ? '扩展页面 / 侧栏 · ' : '网页 · ') + (x.title || x.url)]));
    } catch(e) { $('extStatus').textContent = e.message; }
  }
  action('bLaunch', async () => { await post('/api/launch', { url: location.origin + '/demo', source: 'dashboard.launch' }); return '浏览器已在后台启动'; });
  action('bBg', async () => { await post('/api/bg', { source: 'dashboard.bg' }); return '已收起，后台继续运行'; });
  action('bRestore', async () => { await post('/api/show', { source: 'dashboard.show' }); return '已进入人工接管'; });
  action('bMaximize', async () => { await post('/api/show', { maximize: true, source: 'dashboard.show.maximize' }); return '已最大化，人工接管中'; });
  action('bStop', async () => { await post('/api/stop', { source: 'dashboard.stop' }); return '浏览器已关闭'; });
  action('bOpen', async () => { const url = $('url').value.trim(); if (!url) throw new Error('请输入网址'); await post('/api/open', { url, source: 'dashboard.open' }); return '已静默打开网页'; });
  action('bExtAdd', async () => { await post('/api/extensions/add', { path: $('extPath').value.trim(), source: 'dashboard.ext.add' }); return '扩展已添加'; });
  action('bExtDev', async () => { if (!$('extName').value) throw new Error('请先添加扩展'); const result = await post('/api/extensions/dev', { name: $('extName').value, url: $('devUrl').value.trim() || location.origin + '/demo', source: 'dashboard.ext.dev' }); await refreshExtensions(); $('target').value = result.panelTargetId; return '真实侧栏已打开，可选择网页、侧栏或后台脚本分别调试'; });
  action('bExtReload', async () => { if (!$('extName').value) throw new Error('请先选择扩展'); await post('/api/extensions/reload', { name: $('extName').value, source: 'dashboard.ext.reload' }); return '扩展已重载；内容脚本更新需刷新目标网页'; });
  action('bInspect', async () => { if (!$('target').value) throw new Error('请选择调试目标'); await post('/api/inspect', { targetId: $('target').value, source: 'dashboard.inspect' }); return '调试窗口已打开'; });
  const es = new WebSocket(\`ws://\${location.host}/activity\`);
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data);
      const div = document.createElement('div');
      div.innerHTML = \`<span class="t">\${new Date(e.ts).toLocaleTimeString()}</span><span class="m">\${escapeHtml(e.method)}</span> \${escapeHtml(e.detail ?? '')} \${e.targetId ? '· ' + escapeHtml(e.targetId.slice(0, 8)) : ''}\`;
      $('activity').prepend(div);
      const dot = $('pulseDot');
      dot.style.opacity = '0.2';
      setTimeout(() => { dot.style.opacity = '1'; }, 200);
      while ($('activity').childElementCount > 100) $('activity').lastChild.remove();
    } catch {}
  };
  refreshStatus(); refreshHealth(); refreshExtensions();
  setInterval(refreshStatus, 3000); setInterval(refreshHealth, 3000); setInterval(refreshExtensions, 3000);
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
