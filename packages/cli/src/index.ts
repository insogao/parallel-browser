#!/usr/bin/env node
/**
 * backlight (bl) — control the Backlight background-browser daemon.
 * Requires Node >= 22.6 (native TypeScript type stripping).
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLiveDaemon, type DaemonInfo } from '../../daemon/src/single-instance.ts'

const daemonEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon', 'src', 'index.ts')
const home = process.env.BACKLIGHT_HOME
  ?? path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Backlight')
const daemonFile = path.join(home, 'daemon.json')

const readDaemonInfo = (): DaemonInfo | null => readLiveDaemon(daemonFile)

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
  // Two rapid clicks may spawn two daemon processes; the daemon-side start
  // lock makes exactly one win and the duplicate exits instead of binding a
  // fallback port and overwriting daemon.json.
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  })
  child.unref()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    const info = readDaemonInfo()
    if (info) return info
  }
  throw new Error('daemon did not start; see ~/Library/Application Support/Backlight/logs/daemon.log')
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
  backlight bg                  最小化窗口并交回后台运行
  backlight show [--maximize]   显示浏览器并进入人工接管，可最大化
  backlight login               启动台点击行为：确保 daemon/品牌引擎，启动或复用默认 space 并最大化接管
  backlight restore             恢复收起的窗口
  backlight status              查看 daemon / 浏览器状态
  backlight health              各标签页后台健康度（rAF/定时器速率）
  backlight windows             查看窗口状态
  backlight activity [-n N]     最近 AI 指令活动
  backlight stop                关闭浏览器并停止 daemon
  backlight ext add <目录>      注册未打包扩展（--name 别名）
  backlight ext ls              列出已注册扩展
  backlight ext rm <名称>       移除扩展
  backlight ext dev <名称> <url> 打开网页与真实扩展侧栏
  backlight ext reload <名称>   仅重载扩展，保留网页输入
  backlight targets            列出可调试的网页、扩展和后台脚本
  backlight inspect <targetId>  为选定目标打开独立 DevTools 窗口
  backlight import              从本机 Chrome 导入 cookie/登录态（--profile 目录名 --space 名称，--list 列出）
  backlight brand               品牌化浏览器（--name 名称 --icon logo.png）
  backlight launcher install    安装/刷新 ~/Applications/Backlight.app（启动台入口，--apps-dir 目录）
  backlight launcher status     校验启动台入口（结构/签名/目标/引擎）
  backlight launcher uninstall  移除启动台入口（--purge 同时删除运行时副本）
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
      body.source = 'cli.launch'
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
      const res = await api(info, '/api/show', { method: 'POST', body: JSON.stringify({ maximize: args.flags.has('maximize'), source: 'cli.show' }) })
      console.log(`restored ${res.restored} window(s) to screen`)
      return
    }

    case 'login': {
      const info = await ensureDaemon()
      const res = await api(info, '/api/login', { method: 'POST', body: JSON.stringify({ source: 'cli.login' }) }, 180_000)
      if (res.mismatchedEngine) {
        console.log(`not taking over: ${res.note ?? 'managed browser is running with a different engine'}`)
        if (res.currentEngine) console.log(`current engine: ${res.currentEngine}`)
        process.exitCode = 1
        return
      }
      console.log(`managed browser ${res.launched ? 'launched' : 'reused'} · restored ${res.restored} window(s) maximized for login`)
      if (res.engine) console.log(`engine: ${res.engine}`)
      if (res.note) console.log(`note: ${res.note}`)
      return
    }

    case 'open': {
      const info = await ensureDaemon()
      const url = args._[1]
      if (!url) throw new Error('usage: backlight open <url> [--with 扩展名]')
      await api(info, '/api/open', { method: 'POST', body: JSON.stringify({ url, with: withList, source: 'cli.open' }) })
      console.log(`opened: ${url}`)
      return
    }

    case 'bg': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const res = await api(info, '/api/bg', { method: 'POST', body: JSON.stringify({ source: 'cli.bg' }) })
      console.log(`collapsed ${res.collapsed} window(s) to background (pages keep full speed)`)
      return
    }

    case 'restore': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const res = await api(info, '/api/restore', { method: 'POST', body: JSON.stringify({ source: 'cli.restore' }) })
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
        console.log(`window ${win.windowId}: ${win.state}${win.cornered ? ' (cornered, 2px sliver)' : ''}`)
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
      if (sub === 'dev') {
        const name = args._[2], url = args._[3]
        if (!name || !url) throw new Error('usage: backlight ext dev <名称> <url>')
        const res = await api(info, '/api/extensions/dev', { method: 'POST', body: JSON.stringify({ name, url, maximize: args.flags.has('maximize'), source: 'cli.ext.dev' }) })
        console.log(`网页与侧栏已打开。网页: ${res.targetId}  侧栏: ${res.panelTargetId}`)
        console.log(`调试侧栏: bl inspect ${res.panelTargetId}`)
      } else if (sub === 'reload') {
        const name = args._[2]
        if (!name) throw new Error('usage: backlight ext reload <名称>')
        const res = await api(info, '/api/extensions/reload', { method: 'POST', body: JSON.stringify({ name }) })
        console.log(`已加载 ${res.extension.name} ${res.extension.version}。${res.note}`)
      } else if (sub === 'add') {
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
        throw new Error('usage: backlight ext add|ls|rm|dev|reload')
      }
      return
    }

    case 'targets': {
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      const res = await api(info, '/api/targets')
      for (const target of res.targets) console.log(`${target.targetId}  ${target.type}  ${target.title || target.url}`)
      return
    }
    case 'inspect': {
      const targetId = args._[1]
      if (!targetId) throw new Error('usage: backlight inspect <targetId> (see bl targets)')
      const info = readDaemonInfo(); if (!info) throw new Error('daemon not running')
      await api(info, '/api/inspect', { method: 'POST', body: JSON.stringify({ targetId, source: 'cli.inspect' }) })
      console.log('DevTools 已打开；原网页和侧栏保持打开。')
      return
    }

    case 'import': {
      const info = await ensureDaemon()
      const list = args.flags.has('list')
      if (list) {
        const res = await api(info, '/api/import/sources', {}, 10000)
        for (const s of res.sources ?? []) {
          console.log(`${(s.browser + ' / ' + s.dir).padEnd(30)} ${s.name}${s.email ? ' <' + s.email + '>' : ''}`)
        }
        if (!res.sources?.length) console.log('(no Chrome profiles found)')
        return
      }
      const body: Record<string, unknown> = {}
      if (args.flags.get('profile')) body.source = args.flags.get('profile')
      if (args.flags.get('space')) body.space = args.flags.get('space')
      const res = await api(info, '/api/import', { method: 'POST', body: JSON.stringify(body) })
      console.log(`imported into space "${res.space}" from ${res.source}:`)
      for (const f of res.copied) console.log(`  - ${f}`)
      console.log('note: cookies are encrypted per-browser; launch with the same browser binary (default Google Chrome) to reuse the login state')
      return
    }

    case 'tray': {
      const cliDir = path.dirname(fileURLToPath(import.meta.url))
      const appPath = path.join(cliDir, '..', '..', 'tray', 'build', 'Backlight Tray.app')
      if (!fs.existsSync(appPath)) {
        console.log('building tray app…')
        const build = path.join(cliDir, '..', '..', 'tray', 'build.sh')
        execFileSync('bash', [build], { stdio: 'inherit' })
      }
      spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref()
      console.log('tray launched — menu bar icon appears (bolt = AI activity, menu: 收起/恢复/控制台)')
      return
    }

    case 'launcher': {
      const sub = args._[1] ?? 'status'
      const appsDir = args.flags.get('apps-dir') ? path.resolve(String(args.flags.get('apps-dir'))) : undefined
      const { installLauncher, verifyLauncher, uninstallLauncher, launcherPaths } = await import('../../daemon/src/launcher.ts')
      const p = launcherPaths({ applicationsDir: appsDir })
      if (sub === 'install' || sub === 'refresh') {
        const res = await installLauncher({ applicationsDir: appsDir, log: (m) => console.log(m) })
        console.log(`\nlauncher: ${res.appPath}`)
        console.log(`runtime:  ${res.runtimeDir}`)
        console.log(`engine:   ${res.engine ?? '(none branded found)'}`)
        console.log(`settings: ${res.settingsChanged ? 'selected branded engine' : 'already selected'}`)
        const failed = res.checks.filter(c => !c.ok)
        for (const c of res.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`)
        if (failed.length) { console.error(`\n${failed.length} check(s) failed`); process.exitCode = 1 }
        else console.log('\nclick it from Launchpad: it ensures daemon, branded engine, default space, then shows + maximizes the managed browser')
        return
      }
      if (sub === 'status') {
        const checks = await verifyLauncher({ applicationsDir: appsDir })
        console.log(`path: ${p.launcherApp}`)
        for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`)
        const failed = checks.filter(c => !c.ok)
        if (failed.length) { console.error(`\n${failed.length} check(s) failed`); process.exitCode = 1 }
        else console.log('\ninstalled and structurally valid (physical Launchpad click still requires manual acceptance)')
        return
      }
      if (sub === 'uninstall') {
        const res = await uninstallLauncher({ applicationsDir: appsDir, purgeRuntime: args.flags.has('purge') })
        console.log(res.removed ? `removed: ${p.launcherApp}` : `nothing to remove (${res.note})`)
        if (res.removed && args.flags.has('purge')) console.log(`purged runtime: ${p.runtimeDir}`)
        return
      }
      throw new Error('usage: backlight launcher install|status|uninstall [--apps-dir 目录] [--purge]')
    }

    case 'brand': {
      const info = await ensureDaemon()
      const body: Record<string, unknown> = {}
      if (args.flags.get('name')) body.name = args.flags.get('name')
      if (args.flags.get('icon')) body.icon = path.resolve(String(args.flags.get('icon')))
      console.log('branding: downloading Chrome for Testing (if needed) and creating your branded browser…')
      const res = await api(info, '/api/browser/brand', { method: 'POST', body: JSON.stringify(body) }, 600_000)
      console.log(`branded browser ready: ${res.browser}`)
      console.log('`bl launch` will now use it — Dock shows your brand.')
      console.log('ℹ 品牌浏览器有独立登录存储（手动登录一次即可）；要复用导入的 cookie 请使用默认 Google Chrome 引擎')
      return
    }

    case 'doctor': {
      console.log('Backlight doctor')
      const [major] = process.versions.node.split('.').map(Number)
      console.log(`${major >= 22 ? '✓' : '✗'} node ${process.versions.node}（需要 ≥22 原生 TS 运行）`)
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
      const found = candidates.filter(c => fs.existsSync(c))
      console.log(`${found.length ? '✓' : '✗'} 浏览器: ${found.length ? found.join(', ') : '未找到 Chromium 系浏览器'}`)
      const info = readDaemonInfo()
      if (info) {
        try {
          const s = await api(info, '/api/status', {}, 5000)
          console.log(`✓ daemon v${s.daemon.version} port=${s.daemon.port}`)
          if (s.browser?.running) console.log(`✓ 浏览器运行中: ${s.browser.version}`)
          else console.log('ℹ 浏览器未运行 (bl launch)')
        } catch (e) {
          console.log(`✗ daemon 无响应: ${(e as Error).message}`)
        }
      } else {
        console.log('ℹ daemon 未运行（任意命令会自动启动）')
      }
      const cacheDir = path.join(home, "..", "..", "..", "Library", "Caches", "Backlight", "browsers")
      const hasCft = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0
      console.log(`${hasCft ? '✓' : 'ℹ'} 扩展用浏览器缓存: ${hasCft ? cacheDir : '未下载（插件开发时自动下载 Chrome for Testing）'}`)
      try {
        const r = await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(5000) })
        console.log(`${r.ok ? '✓' : '⚠'} npm registry ${r.ok ? '可达' : '异常 ' + r.status}（异常时可设 BACKLIGHT_DOWNLOAD_BASE_URL=https://cdn.npmmirror.com/binaries/chrome-for-testing）`)
      } catch { console.log('⚠ npm registry 不可达（将影响 Chromium 自动下载）') }
      console.log(`ℹ 数据目录: ${home}`)
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
