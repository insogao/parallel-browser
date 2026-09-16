import fs from 'node:fs'
import path from 'node:path'
import { paths } from './paths.ts'

export interface DaemonInfo {
  pid: number
  port: number
}

/** daemon.json pointing at a live process; null when missing/stale/dead. */
export function readLiveDaemon(file = paths.daemonFile): DaemonInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as DaemonInfo
    if (!info?.pid) return null
    process.kill(info.pid, 0)
    return info
  } catch {
    return null
  }
}

/**
 * mkdir-based start lock so two rapid CLI/launcher clicks cannot spawn two
 * daemons for the same data dir. A stale lock (crashed starter) is taken over.
 */
export function acquireStartLock(dir: string, staleMs = 15_000): boolean {
  const lock = path.join(dir, 'daemon.lock')
  try {
    fs.mkdirSync(lock)
    return true
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
        fs.rmdirSync(lock)
        fs.mkdirSync(lock)
        return true
      }
    } catch {
      try {
        fs.mkdirSync(lock)
        return true
      } catch { /* another starter holds it */ }
    }
    return false
  }
}

export function releaseStartLock(dir: string): void {
  try {
    fs.rmdirSync(path.join(dir, 'daemon.lock'))
  } catch { /* already released */ }
}
