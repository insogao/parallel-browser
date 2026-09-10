#!/usr/bin/env node
/**
 * backlight (bl) — control the Backlight background-browser daemon.
 * Requires Node >= 22.6 (native TypeScript type stripping).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const daemonEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon', 'src', 'index.ts')
const home = process.env.BACKLIGHT_HOME
  ?? path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Backlight')
const daemonFile = path.join(home, 'daemon.json')

interface DaemonInfo { pid: number; port: number }

function readDaemonInfo(): DaemonInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(daemonFile, 'utf8')) as DaemonInfo
    try {
      process.kill(info.pid, 0)
      return info
    } catch { return null }
  } catch { return null }
}

async function api<T = any>(info: DaemonInfo, pathname: string, init?: RequestInit, timeoutMs = 120_000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${text.slice(0, 200)}`)
  return body
}

async function ensureDaemon(env: Record<string, string> = {}): Promise<DaemonInfo> {
  const existing = readDaemonInfo()
  if (existing) return existing
  fs.mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  })
  child.unref()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    const info = readDaemonInfo()
    if (info) return info
  }
  throw new Error('daemon did not start; run BACKLIGHT_VERBOSE=1 node packages/daemon/src/index.ts to see logs')
}

// ---- tiny arg parser ----------------------------------------------------------

interface Args {
  _: string[]
  flags: Map<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const _: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { _.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const eq = key.indexOf('=')
      if (eq >= 0) flags.set(key.slice(0, eq), key.slice(eq + 1))
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) flags.set(key, argv[++i]!)
      else flags.set(key, true)
    } else {
      _.push(a)
    }
  }
  return { _, flags }
}

function usage(): string {
  return `Backlight v0.1.0 · 后台浏览器

用法:
  backlight launch [url]        启动后台浏览器（可 --space 名称 --with 扩展名 --bare）
  backlight open <url>          在运行中的浏览器开新标签页（可 --with 扩展名）
  backlight bg                  一键收起全部窗口到后台（伪最小化，页面满速运行）
  backlight restore             恢复收起的窗口
  backlight status              查看 daemon / 浏览器状态
  backlight health              各标签页后台健康度（rAF/定时器速率）
  backlight windows             查看窗口状态
  backlight activity [-n N]     最近 AI 指令活动
  backlight stop                关闭浏览器并停止 daemon
  backlight ext add <目录>      注册未打包扩展（--name 别名）
  backlight ext ls              列出已注册扩展
  backlight ext rm <名称>       移除扩展
  backlight doctor              环境体检

环境变量:
  BACKLIGHT_PORT=9333           公共端口（CDP 代理 + API + 控制台）
  BACKLIGHT_HOME=...            数据目录
  BACKLIGHT_VERBOSE=1           调试日志
`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] ?? 'status'
  const port = Number(args.flags.get('port') ?? process.env.BACKLIGHT_PORT ?? 9333)
  process.env.BACKLIGHT_PORT = String(port)

  const withList = (args.flags.get('with') != null)
    ? String(args.flags.get('with')).split(',').map(s => s.trim()).filter(Boolean)
    : undefined

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(usage())
      return

    case 'daemon': {
      // foreground daemon (debugging)
      process.argv[1] = daemonEntry
      await import(daemonEntry)
      return
    }

    case 'launch': {
      const info = await ensureDaemon()
      const url = args._[1]
      const body: Record<string, unknown> = {}
      if (url) body.url = url
      if (args.flags.get('space')) body.space = args.flags.get('space')
      if (withList) body.with = withList
      if (args.flags.has('bare')) body.bare = true
      if (args.flags.has('focus')) body.focus = true
      if (args.flags.has('keep-visible')) body.keepVisible = true
      const res = await api(info, '/api/launch', { method: 'POST', body: JSON.stringify(body) })
      console.log(`browser launched: pid=${res.pid} upstream=${res.upstreamPort} version=${res.version}`)
      if (!args.flags.has('focus') && !args.flags.has('keep-visible')) {
        console.log('launched in background (no focus steal); use `bl show` to bring it up')
      }
      console.log(`AI tools connect via CDP proxy: http://127.0.0.1:${info.port}`)
      return
    }

    case 'show': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const res = await api(info, '/api/show', { method: 'POST', body: '{}' })
      console.log(`restored ${res.restored} window(s) to screen`)
      return
    }

    case 'open': {
      const info = await ensureDaemon()
      const url = args._[1]
      if (!url) throw new Error('usage: backlight open <url> [--with 扩展名]')
      await api(info, '/api/open', { method: 'POST', body: JSON.stringify({ url, with: withList }) })
      console.log(`opened: ${url}`)
      return
    }

    case 'bg': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const res = await api(info, '/api/bg', { method: 'POST', body: '{}' })
      console.log(`collapsed ${res.collapsed} window(s) to background (pages keep full speed)`)
      return
    }

    case 'restore': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const res = await api(info, '/api/restore', { method: 'POST', body: '{}' })
      console.log(`restored ${res.restored} window(s)`)
      return
    }

    case 'stop': {
      const info = readDaemonInfo()
      if (!info) { console.log('daemon not running'); return }
      await api(info, '/api/stop', { method: 'POST', body: '{}' }, 10_000).catch(() => {})
      try { process.kill(info.pid, 'SIGTERM') } catch { /* already gone */ }
      try { fs.rmSync(daemonFile, { force: true }) } catch { /* ignore */ }
      console.log('daemon stopped')
      return
    }

    case 'status': {
      const info = readDaemonInfo()
      if (!info) { console.log('daemon: not running'); return }
      const s = await api(info, '/api/status', {}, 5000)
      console.log(`daemon:  v${s.daemon.version} pid=${s.daemon.pid} uptime=${s.daemon.uptimeSec}s port=${s.daemon.port}`)
      const b = s.browser
      if (b?.running) {
        console.log(`browser: ${b.version} pid=${b.pid}`)
        console.log(`         binary=${b.binary}`)
        console.log(`         space=${b.space} extensions=[${b.extensions.join(', ')}]`)
        console.log(`         CDP proxy: http://127.0.0.1:${s.daemon.port} (upstream ${b.upstreamPort})`)
        console.log(`         launchMode=${s.settings.launchMode} backgroundMode=${s.settings.backgroundMode} pumpFps=${s.settings.pumpFps} halo=${s.settings.halo}`)
      } else {
        console.log('browser: not running (backlight launch)')
      }
      return
    }

    case 'health': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const h = await api(info, '/api/health', {}, 5000)
      if (!h.targets?.length) { console.log('no pages tracked yet'); return }
      console.log('visibility  rAF/s(shim)  native/s  timer/s  page')
      for (const t of h.targets) {
        console.log(
          `${t.visibility.padEnd(10)}  ${String(t.rafPerSec).padEnd(13)} ${String(t.nativeRafPerSec).padEnd(9)} ${String(t.timerPerSec).padEnd(8)} ${(t.title || t.url).slice(0, 60)}`,
        )
      }
      return
    }

    case 'windows': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const w = await api(info, '/api/windows', {}, 5000)
      for (const win of w.windows ?? []) {
        console.log(`window ${win.windowId}: ${win.state}${win.offscreen ? ' (pseudo-minimized, offscreen)' : ''}`)
      }
      if (!w.windows?.length) console.log('no windows')
      return
    }

    case 'activity': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const n = Number(args.flags.get('n') ?? 20)
      const a = await api(info, `/api/activity?limit=${n}`, {}, 5000)
      for (const e of a.events ?? []) {
        const time = new Date(e.ts).toLocaleTimeString()
        console.log(`${time}  [${e.kind}] ${e.method}${e.detail ? ` (${e.detail})` : ''}${e.targetId ? ` → ${e.targetId.slice(0, 8)}` : ''}`)
      }
      return
    }

    case 'ext': {
      const info = await ensureDaemon()
      const sub = args._[1]
      if (sub === 'add') {
        const dir = args._[2]
        if (!dir) throw new Error('usage: backlight ext add <扩展目录> [--name 别名]')
        const res = await api(info, '/api/extensions/add', {
          method: 'POST',
          body: JSON.stringify({ path: path.resolve(dir), name: args.flags.get('name') || undefined }),
        })
        console.log(`registered: ${res.extension.name} (${res.extension.path})`)
        if (res.reloaded) console.log('browser reloaded with the new extension set')
      } else if (sub === 'ls' || sub === 'list') {
        const res = await api(info, '/api/extensions', {}, 5000)
        if (!res.extensions.length) { console.log('(none registered)'); return }
        for (const e of res.extensions) {
          const loaded = res.loaded?.includes(e.path) ? ' [loaded]' : ''
          console.log(`${e.name.padEnd(30)} ${e.path}${loaded}`)
        }
      } else if (sub === 'rm' || sub === 'remove') {
        const name = args._[2]
        if (!name) throw new Error('usage: backlight ext rm <名称>')
        const res = await api(info, '/api/extensions/remove', { method: 'POST', body: JSON.stringify({ name }) })
        console.log(res.ok ? `removed: ${name}` : `not found: ${name}`)
      } else {
        throw new Error('usage: backlight ext add|ls|rm')
      }
      return
    }

    case 'doctor': {
      console.log('doctor: expanded checks land in v0.1 (see README)')
      const info = await ensureDaemon()
      const s = await api(info, '/api/status', {}, 5000)
      console.log(`daemon ok (port ${s.daemon.port})`)
      return
    }

    default:
      console.error(`unknown command: ${cmd}\n`)
      console.log(usage())
      process.exitCode = 1
  }
}

await main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
