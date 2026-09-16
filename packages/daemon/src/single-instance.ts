import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { paths } from './paths.ts'

export interface DaemonInfo {
  pid: number
  port: number
  startedAt?: number
}

export interface FileLock {
  readonly dir: string
  readonly token: string
  release(): void
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

/** Atomic daemon.json write (tmp + rename) so readers never see a partial file. */
export function writeDaemonInfo(info: DaemonInfo, file = paths.daemonFile): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function removeDaemonInfo(file = paths.daemonFile): void {
  try {
    fs.rmSync(file, { force: true })
  } catch { /* ignore */ }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readOwner(lockDir: string): { pid: number; token: string; startedAt: number } | null {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
    if (!owner || typeof owner.token !== 'string') return null
    return owner
  } catch {
    return null
  }
}

function lockMtime(lockDir: string): number {
  try {
    return fs.statSync(lockDir).mtimeMs
  } catch {
    return Date.now()
  }
}

function createLockDir(lockDir: string, token: string, pid: number): boolean {
  try {
    fs.mkdirSync(lockDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true })
      try {
        fs.mkdirSync(lockDir)
      } catch {
        return false
      }
    } else {
      return false
    }
  }
  try {
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid, token, startedAt: Date.now() }),
    )
  } catch { /* owner metadata is best effort; mtime still guards the lock */ }
  return true
}

/** A lock is stale only when its owner is gone, or when the owner never
 * managed to write metadata (crash between mkdir and owner.json). A live
 * owner is never stolen: stealing a slow process would let two installers /
 * daemons interleave their staged renames. */
function lockIsStale(lockDir: string): boolean {
  const owner = readOwner(lockDir)
  if (!owner) return Date.now() - lockMtime(lockDir) > 3_000
  return !isProcessAlive(owner.pid)
}

/**
 * Replace a stale lock via an atomic rename to a unique tombstone: only the
 * winner of the rename may install the new lock, so two contenders that both
 * judged the lock stale cannot both take it over (no read-then-delete TOCTOU).
 */
function takeOverStaleLock(lockDir: string): boolean {
  const tomb = `${lockDir}.stale-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  try {
    fs.renameSync(lockDir, tomb)
  } catch {
    return false
  }
  fs.rmSync(tomb, { recursive: true, force: true })
  return true
}

export function tryAcquireFileLock(lockDir: string): FileLock | null {
  const token = randomUUID()
  if (!createLockDir(lockDir, token, process.pid)) {
    if (!lockIsStale(lockDir)) return null
    if (!takeOverStaleLock(lockDir)) return null
    if (!createLockDir(lockDir, token, process.pid)) return null
  }
  return {
    dir: lockDir,
    token,
    release() { releaseFileLock(lockDir, token) },
  }
}

export async function acquireFileLock(
  lockDir: string,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<FileLock | null> {
  const deadline = Date.now() + (opts.waitMs ?? 15_000)
  for (;;) {
    const lock = tryAcquireFileLock(lockDir)
    if (lock) return lock
    if (Date.now() >= deadline) return null
    await new Promise(r => setTimeout(r, opts.pollMs ?? 150))
  }
}

/** Never removes a lock that has since been taken over by another owner. */
export function releaseFileLock(lockDir: string, token: string): void {
  try {
    const owner = readOwner(lockDir)
    if (owner?.token && owner.token !== token) return
    fs.rmSync(lockDir, { recursive: true, force: true })
  } catch { /* already released */ }
}
