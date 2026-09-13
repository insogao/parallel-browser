import fs from 'node:fs'
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
import { FramePumpSupervisor } from './windows.ts'
import { browserAppState, hideBrowser, startTray } from './native.ts'

export const VERSION = '0.1.0'

async function main() {
  ensureDirs()
  initFileLogging(paths.logs)
  const settings = loadSettings()

  // single public port: CDP proxy + API + dashboard
  const proxyPort = await findFreePort(settings.proxyPort)
  if (proxyPort !== settings.proxyPort) {
    log(`configured port ${settings.proxyPort} busy; using ${proxyPort}`)
  }

  const bus = new ActivityBus()
  const extensions = new ExtensionManager()
  const manager: BrowserManager = new BrowserManager({
    extensions,
    cornerWindow: (cdp, windowId) => supervisor.cornerWindow(cdp, windowId),
  })
  const health = new HealthMonitor(() => (manager.current ? { cdp: manager.current.cdp } : null))
  const supervisor: FramePumpSupervisor = new FramePumpSupervisor(
    () => (manager.current ? { cdp: manager.current.cdp } : null),
    () => health.snapshot(),
  )
  const capture = new CaptureKeepAlive(
    () => (manager.current ? { cdp: manager.current.cdp, controllerUrl: `http://127.0.0.1:${proxyPort}/controller` } : null),
    () => health.snapshot(),
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
  })

  extensions.startWatching((files) => {
    void extensionDev.changed(files).catch(err => error(`extension reload: ${err.message}`))
  })

  supervisor.start(500)
  health.start(2000)
  capture.start(1000)

  server.listen(proxyPort, '127.0.0.1', () => {
    log(`backlight daemon v${VERSION} listening on http://127.0.0.1:${proxyPort}`)
    fs.writeFileSync(paths.daemonFile, JSON.stringify({ pid: process.pid, port: proxyPort, startedAt: Date.now() }, null, 2))
    void startTray().catch(err => error(`tray startup failed: ${err.message}`))
  })

  const shutdown = async (signal: string) => {
    log(`daemon ${signal}; shutting down`)
    supervisor.stop()
    health.stop()
    capture.stop()
    extensions.stopWatching()
    try { fs.rmSync(paths.daemonFile, { force: true }) } catch { /* ignore */ }
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
