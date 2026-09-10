import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { Cdp, fetchTargets, fetchVersion, type CdpTargetInfo } from './cdp.ts'
import { paths } from './paths.ts'
import { findFreePort } from './ports.ts'
import { loadSettings } from './store.ts'
import { ExtensionManager } from './extensions.ts'
import { log, warn, error } from './log.ts'

const BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

export function detectBrowserBinary(preferred?: string): string {
  if (preferred && preferred !== 'auto') {
    if (fs.existsSync(preferred)) return preferred
    throw new Error(`configured browser not found: ${preferred}`)
  }
  for (const cand of BROWSER_CANDIDATES) {
    if (fs.existsSync(cand)) return cand
  }
  throw new Error(
    'no Chromium-based browser found in /Applications; install Google Chrome/Chromium/Edge/Brave or set settings.browser',
  )
}

/**
 * Branded Google Chrome >= 136 ignores --load-extension. Chromium and Chrome
 * for Testing still honour it, so dev-extension workflows need one of those.
 */
function isBrandedChrome(binary: string): boolean {
  return binary.includes('Google Chrome.app')
}

export interface LaunchOptions {
  url?: string
  space?: string
  /** extension names to load (default: all registered) */
  with?: string[]
  /** launch without any dev extensions */
  bare?: boolean
}

export interface BrowserInstance {
  child: ChildProcess
  pid: number
  binary: string
  version: string
  upstreamPort: number
  space: string
  extensionPaths: string[]
  cdp: Cdp
  startedAt: number
}

export interface ManagerDeps {
  extensions: ExtensionManager
}

export class BrowserManager {
  current: BrowserInstance | null = null
  private deps: ManagerDeps

  constructor(deps: ManagerDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.current != null && this.current.child.exitCode == null
  }

  private spaceProfileDir(space: string): string {
    return paths.spaceDir(space) + '/profile'
  }

  async launch(opts: LaunchOptions = {}): Promise<BrowserInstance> {
    if (this.running) throw new Error('browser already running; use backlight stop first')
    const settings = loadSettings()
    const space = opts.space ?? settings.space
    const profileDir = this.spaceProfileDir(space)
    fs.mkdirSync(profileDir, { recursive: true })

    const extensionPaths = opts.bare ? [] : this.deps.extensions.enabledPaths(opts.with)
    let binary = detectBrowserBinary(settings.browser)
    if (extensionPaths.length > 0 && isBrandedChrome(binary)) {
      const cached = await ensureChromiumForExtensions()
      if (cached) binary = cached
      else
        throw new Error(
          'branded Google Chrome ignores --load-extension (M136+). Install Chromium / Chrome for Testing, or run: backlight doctor',
        )
    }

    const upstreamPort = await findFreePort()
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${upstreamPort}`,
      // anti-background-throttling trio: timers keep running for hidden/occluded renderers
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
    ]
    if (extensionPaths.length > 0) {
      args.push(`--load-extension=${extensionPaths.join(',')}`)
      if (settings.soloExtensions) {
        args.push(`--disable-extensions-except=${extensionPaths.join(',')}`)
      }
    }
    const urls = []
    if (opts.url) urls.push(opts.url)

    log(`launching ${binary} (space=${space}, upstreamPort=${upstreamPort}, extensions=${extensionPaths.length})`)
    const child = spawn(binary, [...args, ...urls], {
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.on('exit', (code) => {
      if (this.current?.child === child) {
        log(`browser exited (code=${code})`)
        this.current.cdp.close()
        this.current = null
      }
    })

    // wait for the debug endpoint
    const deadline = Date.now() + 20_000
    let version: { Browser: string; webSocketDebuggerUrl: string } | null = null
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`browser exited immediately (code=${child.exitCode})`)
      try {
        version = await fetchVersion(upstreamPort, 1500)
        break
      } catch { await new Promise(r => setTimeout(r, 300)) }
    }
    if (!version) throw new Error('browser debug endpoint did not come up within 20s')

    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    this.current = {
      child,
      pid: child.pid!,
      binary,
      version: version.Browser,
      upstreamPort,
      space,
      extensionPaths,
      cdp,
      startedAt: Date.now(),
    }
    log(`browser up: ${version.Browser} pid=${child.pid}`)
    return this.current
  }

  async stop(): Promise<void> {
    const cur = this.current
    if (!cur) return
    this.current = null
    cur.cdp.close()
    await new Promise<void>((resolve) => {
      const kill = () => { try { cur.child.kill('SIGKILL') } catch { /* ignore */ } resolve() }
      try {
        cur.child.once('exit', resolve)
        cur.child.kill('SIGTERM')
        setTimeout(kill, 3000).unref()
      } catch { kill() }
    })
    log('browser stopped')
  }

  async listTabs(): Promise<CdpTargetInfo[]> {
    if (!this.running || !this.current) return []
    try { return await fetchTargets(this.current.upstreamPort) } catch { return [] }
  }

  /** Restart preserving http(s) tabs (used by extension hot reload). */
  async restart(reason: string): Promise<void> {
    if (!this.running || !this.current) return
    const cur = this.current
    const tabs = (await this.listTabs())
      .filter(t => /^https?:/i.test(t.url))
      .map(t => t.url)
    // `with` expects NAMES, not paths — map the loaded paths back to names so
    // the same extension set survives the restart (empty names = bare launch)
    const withNames = cur.extensionPaths.length > 0
      ? this.deps.extensions.namesForPaths(cur.extensionPaths)
      : []
    log(`restarting browser (${reason}); restoring ${tabs.length} tab(s), ${withNames.length} extension(s)`)
    const first = tabs.shift()
    await this.stop()
    await this.launch({ url: first ?? 'about:blank', space: cur.space, with: withNames })
    const opened = this.current
    if (opened) {
      for (const url of tabs) {
        await opened.cdp.send('Target.createTarget', { url }).catch((e) => warn(`tab restore failed: ${e.message}`))
      }
    }
  }

  async restartIfRunning(reason: string): Promise<void> {
    if (this.running) await this.restart(reason)
  }
}

/**
 * Download a Chromium build (Chrome for Testing) that still supports
 * --load-extension. Cached under BACKLIGHT_HOME/browsers.
 */
async function ensureChromiumForExtensions(): Promise<string | null> {
  // Lazy import: keeps daemon startup cheap when extensions aren't used.
  let mod: any
  try {
    mod = await import('@puppeteer/browsers')
  } catch {
    warn('@puppeteer/browsers not installed; cannot auto-fetch Chromium')
    return null
  }
  try {
    const platform = mod.detectBrowserPlatform()
    const buildId = await mod.resolveBuildId('chrome', platform, 'stable')
    log(`fetching Chrome for Testing ${buildId} (${platform}) for extension support...`)
    const installed = await mod.install({
      browser: 'chrome',
      buildId,
      cacheDir: paths.browserCache,
      baseUrl: process.env.BACKLIGHT_DOWNLOAD_BASE_URL || undefined,
    })
    log(`chromium ready: ${installed.executablePath}`)
    return installed.executablePath
  } catch (err) {
    error(`chromium download failed: ${(err as Error).message}`)
    return null
  }
}

/** Reserved for future use: wait until a TCP port accepts connections. */
export async function waitUntilListening(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
    })
    if (ok) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`port ${port} not listening within ${timeoutMs}ms`)
}
