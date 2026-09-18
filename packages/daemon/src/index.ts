import path from 'node:path'
import { ActivityBus } from './activity.ts'
import { BrowserManager } from './browser.ts'
import { CaptureKeepAlive } from './capture.ts'
import { ExtensionManager } from './extensions.ts'
import { ExtensionDev } from './extension-dev.ts'
import { HealthMonitor } from './inject.ts'
import { ensureDirs, paths } from './paths.ts'
import { findFreePort } from './ports.ts'
import { createServer } from './proxy.ts'
import { loadSettings } from './store.ts'
import { error, initFileLogging, log } from './log.ts'
import { StateTransitionLog } from './state-log.ts'
import { browserSessionId } from './session.ts'
import { FramePumpSupervisor } from './windows.ts'
import { activateBrowser, browserAppState, hideBrowser, startTray, unhideBrowser } from './native.ts'
import { acquireFileLock, readLiveDaemon, removeDaemonInfo, writeDaemonInfo } from './single-instance.ts'

export const VERSION = '0.1.0'

async function main() {
  ensureDirs()
  initFileLogging(paths.logs)

  // Single instance per data dir: the lock is held from before the port probe
  // until daemon.json is on disk. A duplicate (e.g. from a double click) that
  // cannot take ownership waits, re-checks daemon.json and exits instead of
  // binding a fallback port and overwriting the running daemon's info.
  const lockDir = path.join(paths.root, 'daemon.lock')
  const lock = await acquireFileLock(lockDir, { waitMs: 20_000, pollMs: 150 })
  if (!lock) {
    const live = readLiveDaemon()
    if (live) {
      log(`another backlight daemon is already running (pid=${live.pid} port=${live.port}); exiting`)
      process.exit(0)
    }
    error(`could not acquire daemon start lock ${lockDir}; another daemon may be starting`)
    process.exit(1)
  }
  process.on('exit', () => lock.release())
  const alreadyRunning = readLiveDaemon()
  if (alreadyRunning) {
    log(`another backlight daemon is already running (pid=${alreadyRunning.pid} port=${alreadyRunning.port}); exiting`)
    process.exit(0)
  }
  const settings = loadSettings()

  // single public port: CDP proxy + API + dashboard
  const proxyPort = await findFreePort(settings.proxyPort)
  if (proxyPort !== settings.proxyPort) {
    log(`configured port ${settings.proxyPort} busy; using ${proxyPort}`)
  }

  const bus = new ActivityBus()
  const stateLog = new StateTransitionLog()
  const extensions = new ExtensionManager()
  const manager: BrowserManager = new BrowserManager({
    extensions,
    cornerWindow: (cdp, windowId) => supervisor.cornerWindow(cdp, windowId),
    // Background launches re-assert native hidden (macOS warm reopen can
    // otherwise relaunch a previously-visible app unhidden).
    hideApp: hideBrowser,
    // Visibility evidence for the fail-closed hidden-restart guard.
    appState: browserAppState,
  })
  const health = new HealthMonitor(() => (manager.current ? { cdp: manager.current.cdp } : null))
  const supervisor: FramePumpSupervisor = new FramePumpSupervisor(
    () => (manager.current ? { cdp: manager.current.cdp } : null),
    () => health.snapshot(),
  )
  // Every transition from every source carries the managed session id, so
  // Dock/launchpad/menu/API actions share one attribution vocabulary.
  const record = (entry: Parameters<StateTransitionLog['record']>[0]) => {
    const cur = manager.current
    stateLog.record({ ...entry, session: entry.session ?? (cur ? browserSessionId(cur) : undefined) })
  }
  supervisor.onTransition = record
  const capture = new CaptureKeepAlive(
    () => (manager.current ? {
      cdp: manager.current.cdp,
      capturePageUrl: manager.current.capturePageUrl,
      pid: manager.current.pid,
    } : null),
    () => health.snapshot(),
    {
      onTransition: record,
    },
  )
  const extensionDev = new ExtensionDev(manager, extensions, bus)

  const pulseSessions = new Map<string, Promise<string>>()
  const pulse = (targetId: string) => {
    const cur = manager.current
    if (!cur || !loadSettings().halo) return
    try {
      let session = pulseSessions.get(targetId)
      if (!session) {
        session = cur.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
          .then(r => r.sessionId)
        pulseSessions.set(targetId, session)
        session.catch(() => pulseSessions.delete(targetId))
      }
      void session.then(sid => cur.cdp.evaluateOnSession(sid, 'window.__backlightPulse && window.__backlightPulse()'))
        .catch(() => pulseSessions.delete(targetId))
    } catch { /* page may be gone; fine */ }
  }

  const server = createServer({
    manager,
    supervisor,
    health,
    capture,
    extensions,
    extensionDev,
    bus,
    version: VERSION,
    startedAt: Date.now(),
    pulse,
    appState: browserAppState,
    hideBrowser,
    unhideBrowser,
    activateBrowser,
    stateLog,
    sessionId: () => (manager.current ? browserSessionId(manager.current) : undefined),
  })

  extensions.startWatching((files) => {
    void extensionDev.changed(files).catch(err => error(`extension reload: ${err.message}`))
  })

  supervisor.start(500)
  health.start(2000)
  capture.start(1000)

  server.listen(proxyPort, '127.0.0.1', () => {
    // Held the lock through startup, so nobody else can have claimed the data
    // dir; still re-check defensively before publishing daemon.json.
    const raced = readLiveDaemon()
    if (raced && raced.pid !== process.pid) {
      error(`another backlight daemon appeared during startup (pid=${raced.pid}); exiting`)
      server.close()
      process.exit(0)
    }
    log(`backlight daemon v${VERSION} listening on http://127.0.0.1:${proxyPort}`)
    writeDaemonInfo({ pid: process.pid, port: proxyPort, startedAt: Date.now() })
    lock.release()
    void startTray().catch(err => error(`tray startup failed: ${err.message}`))
  })

  const shutdown = async (signal: string) => {
    log(`daemon ${signal}; shutting down`)
    supervisor.stop()
    health.stop()
    capture.stop()
    extensions.stopWatching()
    removeDaemonInfo()
    if (manager.running) await manager.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    error(`uncaught: ${err.stack ?? err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    error(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
  })
}

await main()
