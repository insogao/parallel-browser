import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { Cdp, fetchTargets, fetchVersion, type CdpTargetInfo } from './cdp.ts'
import { paths } from './paths.ts'
import { findFreePort } from './ports.ts'
import { loadSettings } from './store.ts'
import { ExtensionManager } from './extensions.ts'
import { OFFSCREEN_MARGIN, readWorkArea } from './windows.ts'
import { log, warn, error } from './log.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

/** pgrep for a Chrome process using the given managed profile dir. */
async function isProfileAlive(profileDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', `user-data-dir=${profileDir}`], (err, stdout) =>
      resolve(!err && stdout.trim().length > 0))
  })
}

/** Resolve the real browser pid (needed when launched via `open`, where we only own the `open` process). */
async function resolveChromePid(profileDir: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', `user-data-dir=${profileDir}`], (err, stdout) => {
      const first = stdout.trim().split('\n')[0]
      resolve(!err && first ? Number(first) : -1)
    })
  })
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
  /** override settings.launchMode for this launch */
  focus?: boolean
  /** internal: skip auto-collapse after launch (tests that measure visible baseline) */
  keepVisible?: boolean
}

export interface BrowserInstance {
  child: ChildProcess | null
  pid: number
  binary: string
  version: string
  upstreamPort: number
  space: string
  profileDir: string
  extensionPaths: string[]
  cdp: Cdp
  startedAt: number
}

export interface ManagerDeps {
  extensions: ExtensionManager
  /** hook that records/manages collapsed windows (set by the daemon wiring) */
  cornerWindow?: (cdp: Cdp, windowId: number) => Promise<boolean>
}

export class BrowserManager {
  current: BrowserInstance | null = null
  private deps: ManagerDeps
  private reaper: NodeJS.Timeout | null = null

  constructor(deps: ManagerDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.current != null
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

    const backgroundLaunch = opts.keepVisible ? false : !(opts.focus ?? settings.launchMode === 'visible')
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
      // allow the silent-audio keep-alive to run without a user gesture
      '--autoplay-policy=no-user-gesture-required',
      // tab-capture keep-alive: getDisplayMedia() from the controller tab
      // auto-selects the BACKLIGHT_AGENT tab (CapturerCount exemption);
      // blink-settings removes the user-gesture requirement (daemon-initiated)
      '--auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT',
      '--blink-settings=displayCaptureRequiresUserGesture=false',
    ]
    if (backgroundLaunch) {
      // start with no window; pages open as background targets afterwards so
      // nothing pops to the front. The first window is born AT the offscreen
      // corner (position args are legal there — only fully-offscreen positions
      // get clamped), so there is no visible move/resize dance.
      const wa = settings.workArea
      const winW = 1440
      const winH = 900
      args.push(
        '--no-startup-window',
        `--window-position=${wa.al - (winW - OFFSCREEN_MARGIN)},${wa.at + wa.ah - OFFSCREEN_MARGIN}`,
        `--window-size=${winW},${winH}`,
      )
    }
    if (extensionPaths.length > 0) {
      args.push(`--load-extension=${extensionPaths.join(',')}`)
      if (settings.soloExtensions) {
        args.push(`--disable-extensions-except=${extensionPaths.join(',')}`)
      }
    }

    const { child, pid } = await this.spawnBrowser(binary, args, profileDir, backgroundLaunch)
    log(`launching ${binary} (space=${space}, upstreamPort=${upstreamPort}, extensions=${extensionPaths.length}, mode=${backgroundLaunch ? 'background' : 'visible'})`)

    // wait for the debug endpoint
    const deadline = Date.now() + 20_000
    let version: { Browser: string; webSocketDebuggerUrl: string } | null = null
    while (Date.now() < deadline) {
      if (child && (child.pid ?? 0) > 0 && child.exitCode != null) {
        throw new Error(`browser exited immediately (code=${child.exitCode})`)
      }
      try {
        version = await fetchVersion(upstreamPort, 1500)
        break
      } catch { await sleep(300) }
    }
    if (!version) throw new Error('browser debug endpoint did not come up within 20s')

    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    const realPid = await resolveChromePid(profileDir)
    this.current = {
      child,
      pid: realPid,
      binary,
      version: version.Browser,
      upstreamPort,
      space,
      profileDir,
      extensionPaths,
      cdp,
      startedAt: Date.now(),
    }
    this.startReaper()

    // background mode: open initial url(s) as background targets, then collapse
    // any on-screen window as fast as possible (frame pump keeps pages fast)
    if (backgroundLaunch) {
      if (opts.url) {
        await cdp.send('Target.createTarget', { url: opts.url, background: true }).catch((e) =>
          warn(`background target failed: ${e.message}`))
      }
      await this.autoCollapse(cdp)
    } else if (opts.url) {
      // visible mode: open the initial url(s) in the startup window
      const cur = this.current
      const urls = [opts.url]
      await cdp.send('Target.createTarget', { url: urls[0] }).catch((e) =>
        warn(`initial target failed: ${e.message}`))
      void cur
    }

    log(`browser up: ${version.Browser} pid=${realPid}`)
    return this.current
  }

  /**
   * Background launch: make sure every window Chrome creates ends up parked at
   * the offscreen corner. Preferred path is a single position move (no resize,
   * no visible dance); windows already born at the corner are left alone.
   */
  private async autoCollapse(cdp: Cdp): Promise<void> {
    const done = new Set<number>()
    const deadline = Date.now() + 6000
    let quiet = 0
    while (Date.now() < deadline) {
      const ids = await this.collectWindowIds(cdp)
      for (const windowId of ids) {
        if (done.has(windowId)) continue
        try {
          if (this.deps.cornerWindow && await this.deps.cornerWindow(cdp, windowId)) {
            done.add(windowId)
            continue
          }
        } catch { /* fall through */ }
        done.add(windowId)
      }
      quiet = ids.length > 0 && ids.every(id => done.has(id)) ? quiet + 1 : 0
      if (quiet >= 5) break
      await sleep(200)
    }
  }

  private async collectWindowIds(cdp: Cdp): Promise<number[]> {
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets')
    const ids = new Set<number>()
    for (const t of targetInfos) {
      if (t.type !== 'page') continue
      try {
        const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: t.targetId })
        ids.add(windowId)
      } catch { /* target without window */ }
    }
    return [...ids]
  }

  /**
   * Spawn the browser. For background launches prefers `open -g -j` (launches
   * WITHOUT activating the app — no focus steal) when no instance of that
   * binary is running yet; falls back to a direct spawn otherwise (args are
   * lost via `open` when an instance already exists). Visible launches always
   * spawn directly — a hidden launch would leave the app permanently occluded.
   */
  private async spawnBrowser(
    binary: string,
    args: string[],
    _profileDir: string,
    allowHiddenLaunch: boolean,
  ): Promise<{ child: ChildProcess | null; pid: number }> {
    const appPath = binary.includes('/Contents/MacOS/')
      ? binary.slice(0, binary.indexOf('/Contents/MacOS/'))
      : null
    const alreadyRunning = await new Promise<boolean>((resolve) => {
      execFile('pgrep', ['-f', binary], (err, stdout) => resolve(!err && stdout.trim().length > 0))
    })
    if (allowHiddenLaunch && appPath && !alreadyRunning) {
      log(`spawning via open -g -j (no activation): ${appPath}`)
      spawn('/usr/bin/open', ['-g', '-j', '-a', appPath, '--args', ...args], { stdio: 'ignore' })
      return { child: null, pid: -1 }
    }
    const child = spawn(binary, args, { stdio: 'ignore' })
    child.on('exit', (code) => {
      if (this.current?.child === child) {
        log(`browser exited (code=${code})`)
        this.current.cdp.close()
        this.current = null
      }
    })
    return { child, pid: child.pid ?? -1 }
  }
  /** Clear `current` if the browser process disappears (e.g. user quits it). */
  private startReaper() {
    if (this.reaper) return
    this.reaper = setInterval(() => {
      const cur = this.current
      if (!cur) return
      void isProfileAlive(cur.profileDir).then(alive => {
        if (!alive && this.current === cur) {
          log('browser process is gone; clearing state')
          cur.cdp.close()
          this.current = null
        }
      })
    }, 4000)
    this.reaper.unref?.()
  }

  async stop(): Promise<void> {
    const cur = this.current
    if (!cur) return
    this.current = null
    cur.cdp.close()
    // kill by profile dir — works for both direct spawns and `open -g` launches
    await new Promise<void>(resolve => execFile('pkill', ['-f', `user-data-dir=${cur.profileDir}`], () => resolve()))
    if (cur.child && cur.pid > 0) {
      try { cur.child.kill('SIGTERM') } catch { /* ignore */ }
    }
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!(await isProfileAlive(cur.profileDir))) break
      await sleep(200)
    }
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
export async function ensureChromiumForExtensions(): Promise<string | null> {
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
    const envBase = process.env.BACKLIGHT_DOWNLOAD_BASE_URL
    const baseUrls = envBase
      ? [envBase]
      : [undefined, 'https://cdn.npmmirror.com/binaries/chrome-for-testing']
    let installed: any = null
    let lastErr: Error | null = null
    for (const baseUrl of baseUrls) {
      try {
        installed = await mod.install({
          browser: 'chrome',
          buildId,
          cacheDir: paths.browserCache,
          baseUrl,
        })
        break
      } catch (err) {
        lastErr = err as Error
        warn(`CfT download failed (${(err as Error).message.slice(0, 80)}); trying next source...`)
      }
    }
    if (!installed) throw lastErr ?? new Error('download failed')
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
