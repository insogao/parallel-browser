import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { Cdp, fetchTargets, fetchVersion, type CdpTargetInfo } from './cdp.ts'
import { paths } from './paths.ts'
import { findFreePort } from './ports.ts'
import { loadSettings } from './store.ts'
import { ExtensionManager } from './extensions.ts'
import { ensureCaptureExtension, type CaptureExtension } from './capture-extension.ts'
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
  /**
   * request an on-screen launch. `focus` and `keepVisible` are the only
   * visibility switches: a plain launch is always background, even when
   * `settings.launchMode` is 'visible'.
   */
  focus?: boolean
  /** request a visible launch (login / acceptance baselines); never a default */
  keepVisible?: boolean
}

/**
 * The only switch that may create on-screen state. Kept as a pure function so
 * the invariant is unit-tested without spawning a browser: `settings.launchMode`
 * is deliberately not an input.
 */
export function launchRequestsVisibility(opts: Pick<LaunchOptions, 'focus' | 'keepVisible'>): boolean {
  return opts.focus === true || opts.keepVisible === true
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
  /** bundled tab-capture helper id (null when the engine cannot load extensions) */
  captureExtensionId: string | null
  /** hidden helper page the capture keep-alive drives (null when unavailable) */
  capturePageUrl: string | null
  cdp: Cdp
  startedAt: number
}

export interface ManagerDeps {
  extensions: ExtensionManager
  /** hook that records/manages collapsed windows (set by the daemon wiring) */
  cornerWindow?: (cdp: Cdp, windowId: number) => Promise<boolean>
  /**
   * Verified native app hide (native.ts hideBrowser). Background launches
   * re-assert it because macOS can relaunch a previously-visible app unhidden
   * even with `open -g -j`; without it a plain launch could leave windows on
   * screen. Optional so unit tests can stub the manager without the OS.
   */
  hideApp?: (pid: number) => Promise<void>
  /**
   * Native app visibility probe (native.ts browserAppState), used to decide
   * whether a background restart is safe. Missing/unreadable state fails
   * closed (a restart is then refused rather than risking an unhide).
   */
  appState?: (pid: number) => Promise<{ active: boolean; hidden: boolean }>
}

export interface RestartResult {
  restarted: boolean
  /**
   * Reason a background restart was refused before stopping the current
   * process. The browser is left running exactly as it was.
   */
  deferred?: string
}

/**
 * A hidden background restart cannot be made transient-free on macOS:
 * `open -g -j`/LaunchServices can bring the relaunched app up unhidden, and
 * restoring the session creates windows/tabs, which unhides the app again.
 * `stop() -> launch() -> hideApp()` therefore only repairs visibility after
 * the fact. Callers must use this to fail closed.
 */
export const HIDDEN_RESTART_UNSAFE = 'hidden-restart-unsafe'
export const RESTART_STATE_UNKNOWN = 'hidden-state-unknown'

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
    // Tab-capture keep-alive needs the bundled helper extension. It is always
    // loaded (dev/bare modes included) so the captureKeepAlive setting can be
    // toggled without a browser restart; it is only driven when that setting
    // is on, and it is the only mechanism that can arm capture without any
    // window/app visibility operation.
    let captureExtension: CaptureExtension | null = ensureCaptureExtension()
    let binary = detectBrowserBinary(settings.browser)
    if ((extensionPaths.length > 0 || captureExtension) && isBrandedChrome(binary)) {
      const cached = await ensureChromiumForExtensions()
      if (cached) binary = cached
      else if (extensionPaths.length > 0)
        throw new Error(
          'branded Google Chrome ignores --load-extension (M136+). Install Chromium / Chrome for Testing, or run: backlight doctor',
        )
      else {
        warn('capture keep-alive disabled: branded Chrome ignores --load-extension; hidden pages use the frame pump/rAF shim')
        captureExtension = null
      }
    }
    const loadedExtensions = captureExtension ? [captureExtension.dir, ...extensionPaths] : extensionPaths

    // Only an explicit visibility request can create an on-screen window.
    // `settings.launchMode` is legacy and intentionally not consulted: plain
    // launches (CLI/AI/probe/restart) are always background, so neither a
    // caller label nor a stale setting can inherit visible state.
    const backgroundLaunch = !launchRequestsVisibility(opts)
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
    ]
    if (captureExtension) {
      // the hidden helper page may capture any managed tab without a user
      // invocation; its id is derived from the materialized extension path
      args.push(`--allowlisted-extension-id=${captureExtension.id}`)
    }
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
    if (loadedExtensions.length > 0) {
      args.push(`--load-extension=${loadedExtensions.join(',')}`)
      if (settings.soloExtensions) {
        args.push(`--disable-extensions-except=${loadedExtensions.join(',')}`)
      }
    }

    const { child, pid } = await this.spawnBrowser(binary, args, profileDir, backgroundLaunch)
    log(
      `launching ${binary} (space=${space}, upstreamPort=${upstreamPort}, `
      + `extensions=${extensionPaths.length}${captureExtension ? '+capture-helper' : ''}, mode=${backgroundLaunch ? 'background' : 'visible'})`,
    )

    // Everything after the spawn can fail (debug endpoint, CDP connect, the
    // verified hide). A failed launch must never leave a spawned browser
    // running untracked or visible, so tear it down before propagating.
    let cdp: Cdp | null = null
    try {
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

      cdp = await Cdp.connect(version.webSocketDebuggerUrl)
      const realPid = await resolveChromePid(profileDir)
      const instance: BrowserInstance = {
        child,
        pid: realPid,
        binary,
        version: version.Browser,
        upstreamPort,
        space,
        profileDir,
        extensionPaths,
        captureExtensionId: captureExtension?.id ?? null,
        capturePageUrl: captureExtension?.pageUrl ?? null,
        cdp,
        startedAt: Date.now(),
      }
      this.current = instance
      this.startReaper()

      // background mode: open initial url(s) as background targets, then collapse
      // any on-screen window as fast as possible (frame pump keeps pages fast)
      if (backgroundLaunch) {
        if (opts.url) {
          await cdp.send('Target.createTarget', { url: opts.url, background: true }).catch((e) =>
            warn(`background target failed: ${e.message}`))
        }
        await this.autoCollapse(cdp)
        // A background launch must also be natively hidden: macOS may relaunch a
        // previously-visible app unhidden (warm reopen) despite `open -g -j`.
        // Verified by native.ts; a hide failure fails the launch, never silently
        // leaves a cornered-but-unhidden window.
        if (this.deps.hideApp) await this.deps.hideApp(realPid)
      } else if (opts.url) {
        // visible mode: open the initial url(s) in the startup window
        await cdp.send('Target.createTarget', { url: opts.url }).catch((e) =>
          warn(`initial target failed: ${e.message}`))
      }

      log(`browser up: ${version.Browser} pid=${realPid}`)
      return instance
    } catch (err) {
      await this.cleanupFailedLaunch(profileDir, cdp, child, pid)
      throw err
    }
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

  /** kill by profile dir — works for direct spawns and `open -g` launches */
  private async killProfile(profileDir: string): Promise<void> {
    await new Promise<void>(resolve => execFile('pkill', ['-f', `user-data-dir=${profileDir}`], () => resolve()))
  }

  private async waitProfileGone(profileDir: string): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!(await isProfileAlive(profileDir))) break
      await sleep(200)
    }
  }

  /**
   * A launch that failed after the spawn (debug endpoint, CDP connect, or the
   * verified hide for background mode) must not leave an untracked browser
   * process behind — especially not a visible one whose hide failed. Stop the
   * process and clear any state that points at it.
   */
  private async cleanupFailedLaunch(
    profileDir: string,
    cdp: Cdp | null,
    child: ChildProcess | null,
    pid: number,
  ): Promise<void> {
    try { cdp?.close() } catch { /* ignore */ }
    if (this.current?.profileDir === profileDir) this.current = null
    await this.killProfile(profileDir)
    if (child && pid > 0) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    }
    await this.waitProfileGone(profileDir)
    log(`launch failed; stopped browser for ${profileDir} (no untracked process left)`)
  }

  async stop(): Promise<void> {
    const cur = this.current
    if (!cur) return
    this.current = null
    cur.cdp.close()
    await this.killProfile(cur.profileDir)
    if (cur.child && cur.pid > 0) {
      try { cur.child.kill('SIGTERM') } catch { /* ignore */ }
    }
    await this.waitProfileGone(cur.profileDir)
    log('browser stopped')
  }

  async listTabs(): Promise<CdpTargetInfo[]> {
    if (!this.running || !this.current) return []
    try { return await fetchTargets(this.current.upstreamPort) } catch { return [] }
  }

  /**
   * Reason a background (non-visible) restart must be refused, or null when it
   * is safe. Fail closed: a natively hidden browser would be stopped and
   * relaunched only to repair an unhide that macOS performs while the first
   * window/tab of the restored session is born; an unreadable visibility state
   * cannot prove the browser is on screen, so it is treated as hidden too.
   * A visible browser is safe: nothing invisible can "reappear".
   */
  async backgroundRestartDeferral(): Promise<string | null> {
    const cur = this.current
    if (!cur) return null
    if (!this.deps.appState) return RESTART_STATE_UNKNOWN
    try {
      const { hidden } = await this.deps.appState(cur.pid)
      return hidden ? HIDDEN_RESTART_UNSAFE : null
    } catch {
      return RESTART_STATE_UNKNOWN
    }
  }

  /**
   * Restart preserving http(s) tabs. Background restarts fail closed on a
   * hidden browser and return `{restarted:false, deferred}` without touching
   * the process; only an explicit visible request may restart while hidden.
   * Extension hot reload does not use this: it goes through
   * `Extensions.loadUnpacked` and keeps the browser running.
   */
  async restart(reason: string, launchOpts: Pick<LaunchOptions, 'focus' | 'keepVisible'> = {}): Promise<RestartResult> {
    if (!this.running || !this.current) return { restarted: false }
    const cur = this.current
    if (!launchRequestsVisibility(launchOpts)) {
      const deferral = await this.backgroundRestartDeferral()
      if (deferral) {
        log(`restart deferred (${reason}): ${deferral}; pid=${cur.pid} stays running (stop-then-launch would unhide it before the repair hide)`)
        return { restarted: false, deferred: deferral }
      }
    }
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
    await this.launch({ url: first ?? 'about:blank', space: cur.space, with: withNames, ...launchOpts })
    const opened = this.current
    if (opened) {
      for (const url of tabs) {
        // Recreated tabs are background targets: the hidden-restart contract
        // is that restoring a session may never focus or unveil a window.
        await opened.cdp.send('Target.createTarget', { url, background: true }).catch((e) => warn(`tab restore failed: ${e.message}`))
      }
      // Chrome unhides a hidden app when a tab is created in its window
      // (measured on macOS), so a background restart re-asserts the invisible
      // state after the session is fully recreated.
      if (!launchRequestsVisibility(launchOpts) && this.deps.hideApp) {
        await this.deps.hideApp(opened.pid)
      }
    }
    return { restarted: true }
  }

  /**
   * Internal/automatic restart helper (e.g. a future engine swap). Observes
   * the same fail-closed rule as `restart`: a hidden browser is never stopped,
   * and the function reports the deferral to the caller.
   */
  async restartIfRunning(reason: string): Promise<RestartResult> {
    if (!this.running) return { restarted: false }
    return this.restart(reason, { focus: false })
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
