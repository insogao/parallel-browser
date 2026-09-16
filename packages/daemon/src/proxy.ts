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
import { selectBrandedEngineSetting, type LoginResult } from './launcher.ts'

import type { FramePumpSupervisor } from './windows.ts'
import { TapState, tapFrame } from './tap.ts'
import { log, debug } from './log.ts'

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
    /** Persist the visibility of the newest intent without forcing focus. */
    async persist(gen: number, activate: boolean): Promise<void> {
      const cur = deps.manager.current
      if (!cur) return
      await nativeControl.op(gen, async () => {
        if (activate) await deps.activateBrowser(cur.pid)
        else await deps.unhideBrowser(cur.pid)
      })
    },
  }

  // Repeated clicks (Launchpad) share one in-flight login: the browser is
  // launched/reused once and every click resolves with the same result.
  let loginInFlight: Promise<LoginResult> | null = null
  const login = (): Promise<LoginResult> => {
    if (!loginInFlight) {
      loginInFlight = runLogin(deps, nativeControl).finally(() => { loginInFlight = null })
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
        await handleApi(req, res, url, deps, nativeControl, login)
        return
      }
      if (url.pathname === '/json' || url.pathname === '/json/list' || url.pathname === '/json/new'
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
  persist(gen: number, activate: boolean): Promise<void>
}

/**
 * Launchpad/`bl login` click path: select the branded engine when the managed
 * browser is not running yet, launch the configured (default) space visibly,
 * then show + maximize + activate for assisted login. A live session is never
 * killed or switched; repeated/concurrent calls are idempotent.
 */
async function runLogin(deps: ServerDeps, native: NativeControl): Promise<LoginResult> {
  const selection = selectBrandedEngineSetting()
  const before = deps.manager.current
  let note: string | undefined
  let engine = selection.engine?.binPath ?? loadSettings().browser
  if (!selection.engine) {
    note = `branded engine not found under ${path.join(paths.root, 'apps')}; using configured engine`
  } else if (before && path.resolve(before.binary) !== path.resolve(selection.engine.binPath)) {
    note = `managed browser is already running with a different engine (${before.binary}); run backlight stop, then click again to switch`
  } else if (selection.changed) {
    note = 'selected the branded Backlight engine for the managed space'
  }
  const gen = deps.supervisor.beginControl()
  deps.supervisor.humanMode = true
  await deps.capture.setPaused(true)
  let launched = false
  if (!deps.manager.running) {
    deps.supervisor.start()
    const instance = await deps.manager.launch({ focus: true })
    launched = true
    engine = instance.binary
  }
  const restored = deps.manager.running ? await deps.supervisor.restoreAll(true, gen) : 0
  await native.persist(gen, true)
  return { ok: true, launched, restored, engine, note }
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ServerDeps,
  native: NativeControl,
  login: () => Promise<LoginResult>,
) {
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : ''
  const payload = body ? (() => { try { return JSON.parse(body) } catch { return {} } })() : {}
  const route = `${req.method} ${url.pathname}`

  switch (route) {
    case 'GET /api/demo': {
      json(res, 200, { now: Date.now() })
      return
    }
    case 'GET /api/status': {
      const settings = loadSettings()
      const cur = deps.manager.current
      json(res, 200, {
        daemon: { version: deps.version, pid: process.pid, uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000), port: settings.proxyPort },
        settings,
        control: deps.supervisor.humanMode ? 'human' : 'background',
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
            }
          : { running: false },
      })
      return
    }
    case 'POST /api/launch': {
      deps.supervisor.beginControl() // a new launch outranks any settling collapse
      deps.supervisor.humanMode = payload.focus === true || payload.keepVisible === true || payload.background === false
      await deps.capture.setPaused(deps.supervisor.humanMode)
      deps.supervisor.start()
      const inst = await deps.manager.launch({
        url: payload.url,
        space: payload.space,
        with: payload.with,
        bare: payload.bare === true,
        focus: payload.focus === true || payload.background === false ? true : undefined,
        keepVisible: payload.keepVisible === true,
      })
      json(res, 200, { ok: true, pid: inst.pid, upstreamPort: inst.upstreamPort, version: inst.version })
      return
    }
    case 'POST /api/login': {
      json(res, 200, await login())
      return
    }
    case 'POST /api/stop': {
      deps.supervisor.beginControl() // stop outranks any settling collapse
      deps.supervisor.stop()
      await deps.manager.stop()
      json(res, 200, { ok: true })
      return
    }
    case 'POST /api/restart': {
      if (!deps.manager.running) return json(res, 409, { error: 'browser not running' })
      deps.supervisor.beginControl() // restart outranks any settling collapse
      await deps.manager.restart(payload.reason ?? 'manual restart')
      json(res, 200, { ok: true })
      return
    }
    case 'POST /api/bg': {
      // Last user intent wins: allocate the generation on route entry, before
      // any await, so a show arriving while this request is parked cannot be
      // outranked by a later allocation. Every delayed step and the native
      // hide (in its own critical section) recheck it.
      const gen = deps.supervisor.beginControl()
      await deps.capture.setPaused(false)
      // A hidden app needs the normal -> minimized cycle repeated for the
      // miniaturize (and renderer visibility) to actually apply; the repeat is
      // invisible there. A visible app minimizes on the first cycle.
      let appHidden = false
      if (deps.manager.current) {
        try { appHidden = (await deps.appState(deps.manager.current.pid)).hidden } catch { /* unknown: single cycle */ }
      }
      const n = deps.manager.running ? await deps.supervisor.collapseAll(appHidden, gen) : 0
      if (deps.manager.current) {
        const pid = deps.manager.current.pid
        await native.op(gen, () => deps.hideBrowser(pid))
      }
      const superseded = !deps.supervisor.isControlCurrent(gen)
      json(res, 200, { ok: true, collapsed: n, superseded })
      return
    }
    case 'POST /api/show':
    case 'POST /api/restore': {
      const gen = deps.supervisor.beginControl() // newer intent invalidates an in-flight bg
      deps.supervisor.humanMode = true
      await deps.capture.setPaused(true)
      const n = deps.manager.running ? await deps.supervisor.restoreAll(payload.maximize === true, gen) : 0
      await native.persist(gen, payload.activate !== false)
      json(res, 200, { ok: true, restored: n })
      return
    }
    case 'GET /api/windows': {
      json(res, 200, {
        windows: deps.manager.running ? await deps.supervisor.windowStates() : [],
        pumping: deps.supervisor.pumpTargetIds().length,
      })
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
      const gen = deps.supervisor.beginControl() // newer intent invalidates an in-flight bg
      const name = String(payload.name ?? '')
      deps.extensionDev.entry(name)
      if (!deps.manager.running) {
        if (!payload.url) return json(res, 400, { error: 'url required to start extension development' })
        await deps.manager.launch({ url: payload.url, with: [name] })
      }
      deps.supervisor.humanMode = true
      await deps.capture.setPaused(true)
      const cur = deps.manager.current!
      let targetId = payload.targetId
      if (!targetId && payload.url) {
        targetId = (await deps.manager.listTabs()).find(t => t.type === 'page' && t.url === payload.url)?.targetId
        if (!targetId) targetId = (await cur.cdp.send('Target.createTarget', { url: payload.url, background: true })).targetId
      }
      if (!targetId) return json(res, 400, { error: 'select a website targetId or url' })
      await deps.supervisor.restoreAll(payload.maximize === true, gen)
      await native.persist(gen, payload.activate !== false)
      const result = await deps.extensionDev.openPanel(name, targetId)
      json(res, 200, { ok: true, ...result })
      return
    }
    case 'GET /api/targets': {
      json(res, 200, { targets: (await deps.manager.listTabs()).filter(t => t.type === 'page' || t.type === 'service_worker') })
      return
    }
    case 'POST /api/inspect': {
      const cur = deps.manager.current
      if (!cur) return json(res, 409, { error: 'browser not running' })
      const target = (await deps.manager.listTabs()).find(t => t.targetId === payload.targetId)
      if (!target) return json(res, 404, { error: 'target is no longer available; refresh the target list' })
      const gen = deps.supervisor.beginControl() // newer intent invalidates an in-flight bg
      deps.supervisor.humanMode = true
      await deps.capture.setPaused(true)
      // Go through our loopback proxy: Chromium rejects the frontend's
      // devtools:// Origin at its raw remote-debugging socket.
      const inspectorUrl = `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${req.socket.localPort}/devtools/page/${target.targetId}`
      const { targetId } = await cur.cdp.send('Target.createTarget', { url: inspectorUrl, newWindow: true })
      await deps.supervisor.restoreAll(false, gen)
      await native.persist(gen, payload.activate !== false)
      json(res, 200, { ok: true, targetId })
      return
    }
    case 'POST /api/open': {
      if (!payload.url) return json(res, 400, { error: 'url required' })
      if (!deps.manager.running) {
        await deps.manager.launch({ url: payload.url, with: payload.with })
      } else {
        // Never move or un-minimize an existing window when creating an AI tab.
        const cur = deps.manager.current!
        for (const name of payload.with ?? []) await deps.extensionDev.load(name)
        await cur.cdp.send('Target.createTarget', { url: payload.url, background: true })
      }
      json(res, 200, { ok: true })
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
  action('bLaunch', async () => { await post('/api/launch', { url: location.origin + '/demo' }); return '浏览器已在后台启动'; });
  action('bBg', async () => { await post('/api/bg'); return '已收起，后台继续运行'; });
  action('bRestore', async () => { await post('/api/show'); return '已进入人工接管'; });
  action('bMaximize', async () => { await post('/api/show', { maximize: true }); return '已最大化，人工接管中'; });
  action('bStop', async () => { await post('/api/stop'); return '浏览器已关闭'; });
  action('bOpen', async () => { const url = $('url').value.trim(); if (!url) throw new Error('请输入网址'); await post('/api/open', { url }); return '已静默打开网页'; });
  action('bExtAdd', async () => { await post('/api/extensions/add', { path: $('extPath').value.trim() }); return '扩展已添加'; });
  action('bExtDev', async () => { if (!$('extName').value) throw new Error('请先添加扩展'); const result = await post('/api/extensions/dev', { name: $('extName').value, url: $('devUrl').value.trim() || location.origin + '/demo' }); await refreshExtensions(); $('target').value = result.panelTargetId; return '真实侧栏已打开，可选择网页、侧栏或后台脚本分别调试'; });
  action('bExtReload', async () => { if (!$('extName').value) throw new Error('请先选择扩展'); await post('/api/extensions/reload', { name: $('extName').value }); return '扩展已重载；内容脚本更新需刷新目标网页'; });
  action('bInspect', async () => { if (!$('target').value) throw new Error('请选择调试目标'); await post('/api/inspect', { targetId: $('target').value }); return '调试窗口已打开'; });
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
