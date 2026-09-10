import fs from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import { paths } from './paths.ts'
import { debug, log, warn } from './log.ts'

export interface ExtEntry {
  name: string
  path: string
  addedAt: number
}

interface ExtRegistry {
  extensions: ExtEntry[]
}

/**
 * Dev-extension registry + hot-reload watcher.
 *
 * Note on browser support: branded Google Chrome >= 136 ignores --load-extension.
 * Chromium and Chrome for Testing still honour it, so the launcher swaps to a
 * cached Chromium build whenever dev extensions are requested.
 */
export class ExtensionManager {
  private watcher?: import('chokidar').FSWatcher
  private debounceTimer?: NodeJS.Timeout
  private onChange?: () => void

  private read(): ExtRegistry {
    try {
      const reg = JSON.parse(fs.readFileSync(paths.extensionsFile, 'utf8')) as ExtRegistry
      if (Array.isArray(reg.extensions)) return reg
    } catch { /* fresh registry */ }
    return { extensions: [] }
  }

  private write(reg: ExtRegistry) {
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(paths.extensionsFile, JSON.stringify(reg, null, 2) + '\n')
  }

  list(): ExtEntry[] {
    return this.read().extensions
  }

  get(name: string): ExtEntry | undefined {
    const nameOf = (e: ExtEntry) => path.basename(e.path) === name ? path.basename(e.path) : e.name
    return this.list().find(e => e.name === name || nameOf(e) === name)
  }

  add(dir: string, name?: string): ExtEntry {
    const abs = path.resolve(dir)
    const manifestPath = path.join(abs, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`not an unpacked extension (missing ${manifestPath})`)
    }
    let manifestName = name
    if (!manifestName) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        manifestName = typeof manifest.name === 'string'
          ? manifest.name.replace(/^__MSG_.+__$/, 'msg-localized')
          : undefined
      } catch { /* keep dir name */ }
    }
    const entry: ExtEntry = {
      name: manifestName || path.basename(abs),
      path: abs,
      addedAt: Date.now(),
    }
    const reg = this.read()
    const existing = reg.extensions.findIndex(e => e.path === abs)
    if (existing >= 0) reg.extensions[existing] = entry
    else reg.extensions.push(entry)
    this.write(reg)
    this.watchDir(abs)
    log(`extension added: ${entry.name} -> ${abs}`)
    return entry
  }

  remove(name: string): boolean {
    const reg = this.read()
    const idx = reg.extensions.findIndex(e => e.name === name || path.basename(e.path) === name)
    if (idx < 0) return false
    const [gone] = reg.extensions.splice(idx, 1)
    this.write(reg)
    log(`extension removed: ${name}`)
    void gone
    return true
  }

  /**
   * Resolve extension paths. undefined (no filter) -> all registered;
   * empty array -> none; names -> matching subset.
   */
  enabledPaths(names?: string[]): string[] {
    const all = this.list()
    const wanted = names == null
      ? all
      : names.map(n => this.get(n)).filter((e): e is ExtEntry => !!e)
    return [...new Set(wanted.map(e => e.path))].filter(p => fs.existsSync(p))
  }

  /** Names for a set of loaded paths (used to re-launch with the same set). */
  namesForPaths(paths: string[]): string[] {
    return this.list().filter(e => paths.includes(e.path)).map(e => e.name)
  }

  /** Watch every registered extension dir; fire `onChange` (debounced) on any file event. */
  startWatching(onChange: () => void) {
    this.onChange = onChange
    const dirs = this.list().map(e => e.path).filter(p => fs.existsSync(p))
    if (!dirs.length) return
    this.watchDirs(dirs)
  }

  private watchDirs(dirs: string[]) {
    this.stopWatching()
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })
    this.watcher.on('all', (_event, filePath) => {
      debug(`extension file change: ${filePath}`)
      clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        warn('extension file changed -> hot reload requested')
        this.onChange?.()
      }, 600)
    })
    this.watcher.on('error', (err: unknown) => warn(`extension watcher error: ${(err as Error)?.message ?? String(err)}`))
  }

  private watchDir(dir: string) {
    // cheap approach: restart the watcher over all registered dirs
    this.startWatching(this.onChange ?? (() => {}))
  }

  stopWatching() {
    clearTimeout(this.debounceTimer)
    void this.watcher?.close().catch(() => {})
    this.watcher = undefined
  }
}
