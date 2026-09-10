import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { ActivityBus } from './activity.ts'
import type { BrowserManager } from './browser.ts'
import type { ExtensionManager } from './extensions.ts'
import type { HealthMonitor } from './inject.ts'
import { loadSettings, saveSettings, type Settings } from './store.ts'
import type { WindowStateInfo, FramePumpSupervisor } from './windows.ts'
import { TapState, tapFrame } from './tap.ts'
import { log, debug } from './log.ts'

export interface ServerDeps {
  manager: BrowserManager
  supervisor: FramePumpSupervisor
  health: HealthMonitor
  extensions: ExtensionManager
  bus: ActivityBus
  version: string
  startedAt: number
  pulse: (targetId: string) => void
  restartForReload: () => void
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

  // ---- normal HTTP requests -------------------------------------------------
  httpServer.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(dashboardHtml(deps))
        return
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, deps)
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

    const closeAll = () => {
      try { client.close() } catch { /* ignore */ }
      try { upstream.close() } catch { /* ignore */ }
    }

    upstream.on('open', () => {
      if (head?.length) upstream.send(head)
    })
    upstream.on('message', (data: Buffer, isBinary: boolean) => {
      client.send(data, { binary: isBinary })
      if (!isBinary && Buffer.byteLength(data) < 2_000_000) {
        tapFrame(data.toString(), 'b2c', state, { onAction: () => {} })
      }
    })
    upstream.on('close', closeAll)
    upstream.on('error', closeAll)

    client.on('message', (data: Buffer, isBinary: boolean) => {
      if (upstream.readyState !== WebSocket.OPEN) return
      upstream.send(data, { binary: isBinary })
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

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ServerDeps) {
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : ''
  const payload = body ? (() => { try { return JSON.parse(body) } catch { return {} } })() : {}
  const route = `${req.method} ${url.pathname}`

  switch (route) {
    case 'GET /api/status': {
      const settings = loadSettings()
      const cur = deps.manager.current
      json(res, 200, {
        daemon: { version: deps.version, pid: process.pid, uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000), port: settings.proxyPort },
        settings,
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
            }
          : { running: false },
      })
      return
    }
    case 'POST /api/launch': {
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
    case 'POST /api/stop': {
      deps.supervisor.stop()
      await deps.manager.stop()
      json(res, 200, { ok: true })
      return
    }
    case 'POST /api/restart': {
      if (!deps.manager.running) return json(res, 409, { error: 'browser not running' })
      await deps.manager.restart(payload.reason ?? 'manual restart')
      json(res, 200, { ok: true })
      return
    }
    case 'POST /api/bg': {
      const n = deps.manager.running ? await deps.supervisor.collapseAll() : 0
      json(res, 200, { ok: true, collapsed: n })
      return
    }
    case 'POST /api/restore': {
      const n = deps.manager.running ? await deps.supervisor.restoreAll() : 0
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
      json(res, 200, { extensions: deps.extensions.list(), loaded: deps.manager.current?.extensionPaths ?? [] })
      return
    }
    case 'POST /api/extensions/add': {
      if (!payload.path) return json(res, 400, { error: 'path required' })
      const entry = deps.extensions.add(payload.path, payload.name)
      if (deps.manager.running) await deps.manager.restart(`extension added: ${entry.name}`)
      json(res, 200, { ok: true, extension: entry })
      return
    }
    case 'POST /api/extensions/remove': {
      const ok = deps.extensions.remove(String(payload.name ?? ''))
      if (ok && deps.manager.running) await deps.manager.restart('extension removed')
      json(res, 200, { ok })
      return
    }
    case 'POST /api/open': {
      if (!payload.url) return json(res, 400, { error: 'url required' })
      if (!deps.manager.running) {
        await deps.manager.launch({ url: payload.url, with: payload.with })
      } else {
        // background:true — tab never activates; the window gets cornered so
        // nothing pops to the front and the page keeps native full speed
        const cur = deps.manager.current!
        const { targetId } = await cur.cdp.send<{ targetId: string }>('Target.createTarget', { url: payload.url, background: true })
        try {
          const { windowId } = await cur.cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
          await deps.supervisor.cornerWindow(cur.cdp, windowId)
        } catch { /* window handling is best-effort */ }
      }
      json(res, 200, { ok: true })
      return
    }
    case 'POST /api/show': {
      const n = deps.manager.running ? await deps.supervisor.restoreAll() : 0
      json(res, 200, { ok: true, restored: n })
      return
    }
    case 'POST /api/settings': {
      const allowed: Array<keyof Settings> = ['backgroundMode', 'halo', 'pumpFps', 'soloExtensions', 'space', 'browser', 'proxyPort', 'launchMode']
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
  input { background: #0b0f14; border: 1px solid #24374a; color: #d7e2ec; border-radius: 8px; padding: 7px 10px; font-size: 13px; min-width: 280px; }
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
      <button id="bRestore">恢复窗口</button>
      <button id="bStop">关闭浏览器</button>
      <input id="url" placeholder="https://example.com  — 打开新标签页" />
      <button id="bOpen">打开</button>
    </div>
  </section>
  <section>
    <h2>后台健康度（rAF/定时器 速率，页面在后台应保持与前台一致）</h2>
    <table id="health"><thead><tr><th>页面</th><th>可见性</th><th>rAF/s</th><th>Timer/s</th><th>状态</th></tr></thead><tbody></tbody></table>
  </section>
  <section>
    <h2>AI 指令活动流（WebSocket /activity）</h2>
    <div id="activity"></div>
  </section>
  <section>
    <h2>说明</h2>
    <div class="sub">窗口最小化/遮挡/后台标签都会被帧泵（frame pump）保活：页面继续以接近满速渲染，rAF 与定时器不停。CDP 代理端口即本端口，AI 工具直接连 <kbd>http://127.0.0.1:${loadSettings().proxyPort}</kbd>。</div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  async function api(path, opts) { const r = await fetch(path, opts); return r.json(); }
  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      $('status').textContent = s.browser?.running
        ? \`浏览器运行中 · pid \${s.browser.pid} · \${s.browser.version} · space=\${s.browser.space}\`
        : '浏览器未运行';
    } catch { $('status').textContent = 'daemon 离线'; }
  }
  async function refreshHealth() {
    try {
      const h = await api('/api/health');
      const tb = $('health').querySelector('tbody');
      tb.innerHTML = (h.targets ?? []).map(t => {
        const bg = t.visibility !== 'visible';
        const good = t.rafPerSec >= 20;
        return \`<tr><td>\${escapeHtml(t.title || t.url).slice(0, 60)}</td>
          <td class="\${bg ? 'warn' : 'ok'}">\${t.visibility}</td>
          <td>\${t.rafPerSec}</td><td>\${t.timerPerSec}</td>
          <td class="\${good ? 'ok' : 'bad'}">\${good ? '满速' : '被节流?'}</td></tr>\`;
      }).join('');
    } catch {}
  }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  $('bLaunch').onclick = () => api('/api/launch', { method: 'POST', body: '{}' }).then(refreshStatus);
  $('bBg').onclick = () => api('/api/bg', { method: 'POST', body: '{}' });
  $('bRestore').onclick = () => api('/api/restore', { method: 'POST', body: '{}' });
  $('bStop').onclick = () => api('/api/stop', { method: 'POST', body: '{}' }).then(refreshStatus);
  $('bOpen').onclick = () => { const u = $('url').value.trim(); if (u) api('/api/open', { method: 'POST', body: JSON.stringify({ url: u }) }); };
  const es = new WebSocket(\`ws://\${location.host}/activity\`);
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data);
      if (e.kind !== 'ai-command') return;
      const div = document.createElement('div');
      div.innerHTML = \`<span class="t">\${new Date(e.ts).toLocaleTimeString()}</span><span class="m">\${escapeHtml(e.method)}</span> \${escapeHtml(e.detail ?? '')} \${e.targetId ? '· ' + escapeHtml(e.targetId.slice(0, 8)) : ''}\`;
      $('activity').prepend(div);
      const dot = $('pulseDot');
      dot.style.opacity = '0.2';
      setTimeout(() => { dot.style.opacity = '1'; }, 200);
      while ($('activity').childElementCount > 100) $('activity').lastChild.remove();
    } catch {}
  };
  refreshStatus(); refreshHealth();
  setInterval(refreshStatus, 3000); setInterval(refreshHealth, 3000);
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
