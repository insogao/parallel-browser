import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDefaultIcon, makeIcns } from './brand.ts'
import { paths } from './paths.ts'
import { acquireFileLock } from './single-instance.ts'
import { loadSettings, saveSettings } from './store.ts'

/**
 * Launchpad / Dock entry (~/Applications/Backlight.app).
 *
 * The branded browser engine is a hidden managed app under
 * `~/Library/Application Support/Backlight/apps/Backlight.app`; opening that
 * bundle directly would bypass the daemon-managed profile and space. The
 * launcher is a separate, tiny app whose click target is the normal CLI
 * `login` path (daemon -> branded engine -> default space -> show/maximize).
 */

export const LAUNCHER_BUNDLE_ID = 'dev.backlight.launcher'
export const ENGINE_BUNDLE_ID = 'dev.backlight.browser'
export const LAUNCHER_APP_NAME = 'Backlight'
export const LAUNCHER_EXECUTABLE = 'Backlight'
export const LAUNCHER_VERSION = '0.1.0'

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export interface LoginResult {
  ok: boolean
  launched: boolean
  restored: number
  engine: string | null
  /** live managed session runs another engine: no side effects were applied */
  mismatchedEngine?: boolean
  currentEngine?: string
  note?: string
}

export interface BundleInfo {
  bundleId: string | null
  executable: string | null
  name: string | null
  iconFile: string | null
}

export interface BrandedEngine {
  appPath: string
  binPath: string
  bundleId: string
  name: string
  executable: string
  iconPath: string
}

export interface VerifyCheck {
  name: string
  ok: boolean
  detail: string
}

export interface LauncherConfig {
  bundleId: string
  node: string
  nodeCandidates: string[]
  cli: string
  args: string[]
  home: string
  engine: string | null
  log: string
}

export interface LauncherPaths {
  root: string
  applicationsDir: string
  runtimeDir: string
  launcherApp: string
  logFile: string
}

export interface LauncherPathOptions {
  root?: string
  applicationsDir?: string
  runtimeDir?: string
}

export interface BuildLauncherOptions extends LauncherPathOptions {
  sourceRoot?: string
  nodePath?: string
  nodeCandidates?: string[]
  compile?: (source: string, out: string) => Promise<void>
  log?: (message: string) => void
}

export interface InstallLauncherOptions extends BuildLauncherOptions {
  /** skip replacing the installed runtime snapshot (debug/tests) */
  skipRuntime?: boolean
  /** register the built app with LaunchServices (off in unit tests) */
  register?: boolean
}

export interface InstallRuntimeOptions extends LauncherPathOptions {
  sourceRoot?: string
  log?: (message: string) => void
}

/** Entries copied into the stable runtime snapshot; node_modules includes the
 * pnpm symlink layout so module resolution keeps working after branch removal. */
export const RUNTIME_ENTRIES = [
  'packages/cli/package.json',
  'packages/cli/bin',
  'packages/cli/src',
  'packages/daemon/package.json',
  'packages/daemon/src',
  'packages/daemon/node_modules',
  'packages/launcher/main.swift',
  'packages/tray/build.sh',
  'packages/tray/main.swift',
  'tools/app-control.swift',
  'node_modules',
]

/** Dev-only packages never needed at runtime (keeps the snapshot ~3MB). Also
 * prunes the matching pnpm hoist symlinks so the snapshot has no dangling
 * links after typescript/@types are removed. */
export function isRuntimeExcluded(relative: string): boolean {
  const parts = relative.split(path.sep)
  if (parts[0] === 'node_modules' && parts[1] === '.pnpm' && parts[2] === 'node_modules' && parts[3]) {
    return parts[3] === 'typescript' || parts[3] === '@types' || parts[3] === '.bin'
  }
  if (parts[0] === 'node_modules' && parts[1] === '.pnpm' && parts[2]) {
    return parts[2].startsWith('typescript@') || parts[2].startsWith('@types+')
  }
  if (parts[0] === 'packages' && parts[1] === 'daemon' && parts[2] === 'node_modules' && parts[3]) {
    return parts[3] === 'typescript' || parts[3] === '@types' || parts[3] === '.bin'
  }
  return false
}

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 300)}`)) : resolve(String(stdout)))
  })
}

function plistValue(text: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)
  return match?.[1] ?? null
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!))
}

export function readBundleInfo(appPath: string): BundleInfo | null {
  try {
    const text = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')
    return {
      bundleId: plistValue(text, 'CFBundleIdentifier'),
      executable: plistValue(text, 'CFBundleExecutable'),
      name: plistValue(text, 'CFBundleDisplayName') ?? plistValue(text, 'CFBundleName'),
      iconFile: plistValue(text, 'CFBundleIconFile'),
    }
  } catch {
    return null
  }
}

export function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function findBrandedEngines(root = paths.root): BrandedEngine[] {
  const appsDir = path.join(root, 'apps')
  if (!fs.existsSync(appsDir)) return []
  const engines: BrandedEngine[] = []
  for (const name of fs.readdirSync(appsDir)) {
    if (!name.endsWith('.app')) continue
    const appPath = path.join(appsDir, name)
    const info = readBundleInfo(appPath)
    if (!info || info.bundleId !== ENGINE_BUNDLE_ID || !info.executable) continue
    const binPath = path.join(appPath, 'Contents', 'MacOS', info.executable)
    if (!isExecutableFile(binPath)) continue
    const iconFile = (info.iconFile ?? 'backlight').replace(/\.icns$/, '')
    const iconPath = path.join(appPath, 'Contents', 'Resources', `${iconFile}.icns`)
    engines.push({
      appPath,
      binPath,
      bundleId: info.bundleId,
      name: info.name ?? name.replace(/\.app$/, ''),
      executable: info.executable,
      iconPath,
    })
  }
  return engines
}

/** The engine named `Backlight.app` is preferred; a custom brand already
 * selected in settings.json is respected. */
export function findBrandedEngine(root = paths.root, preferred?: string): BrandedEngine | null {
  const engines = findBrandedEngines(root)
  if (preferred) {
    const match = engines.find(e => path.resolve(e.binPath) === path.resolve(preferred))
    if (match) return match
  }
  return engines.find(e => path.basename(e.appPath) === `${LAUNCHER_APP_NAME}.app`) ?? engines[0] ?? null
}

/** Read-only resolution of which branded engine login would select. Never
 * touches settings.json, so callers can refuse before any side effect. */
export function resolveBrandedEngineSelection(root = paths.root): { engine: BrandedEngine | null; wouldChange: boolean } {
  const settings = loadSettings()
  const engines = findBrandedEngines(root)
  const current = engines.find(e => path.resolve(e.binPath) === path.resolve(settings.browser ?? ''))
  if (current) return { engine: current, wouldChange: false }
  const preferred = engines.find(e => path.basename(e.appPath) === `${LAUNCHER_APP_NAME}.app`) ?? engines[0] ?? null
  return { engine: preferred, wouldChange: preferred != null }
}

/** Apply that selection. Returns changed=true when settings.json was updated
 * (no-op when it already points at a branded app). */
export function selectBrandedEngineSetting(root = paths.root): { engine: BrandedEngine | null; changed: boolean } {
  const selection = resolveBrandedEngineSelection(root)
  if (selection.wouldChange && selection.engine) {
    saveSettings({ browser: selection.engine.binPath })
    return { engine: selection.engine, changed: true }
  }
  return { engine: selection.engine, changed: false }
}

export function launcherPaths(opts: LauncherPathOptions = {}): LauncherPaths {
  const root = opts.root ?? paths.root
  const applicationsDir = opts.applicationsDir
    ?? process.env.BACKLIGHT_APPLICATIONS_DIR
    ?? path.join(os.homedir(), 'Applications')
  const runtimeDir = opts.runtimeDir ?? path.join(root, 'runtime')
  return {
    root,
    applicationsDir,
    runtimeDir,
    launcherApp: path.join(applicationsDir, `${LAUNCHER_APP_NAME}.app`),
    logFile: path.join(root, 'logs', 'launcher.log'),
  }
}

function copyRuntimeEntry(sourceRoot: string, staging: string, entry: string): void {
  const source = path.join(sourceRoot, entry)
  if (!fs.existsSync(source)) throw new Error(`runtime entry missing: ${source}`)
  const dest = path.join(staging, entry)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(source, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (candidate) => !isRuntimeExcluded(path.relative(sourceRoot, candidate)),
  })
}

function installLockDir(p: LauncherPaths): string {
  return path.join(p.root, 'launcher-install.lock')
}

/** Serializes runtime/launcher installs so concurrent installers cannot
 * interleave staging/backup/rename or delete each other's fallback directory. */
async function withInstallLock<T>(p: LauncherPaths, work: () => Promise<T>): Promise<T> {
  const lockDir = installLockDir(p)
  const lock = await acquireFileLock(lockDir, { waitMs: 120_000, pollMs: 200 })
  if (!lock) throw new Error(`another launcher install is still running (lock: ${lockDir})`)
  try {
    return await work()
  } finally {
    lock.release()
  }
}

/** Atomically (re)build the stable runtime snapshot the launcher invokes. */
async function installRuntimeUnlocked(opts: InstallRuntimeOptions = {}): Promise<{ runtimeDir: string; copied: string[] }> {
  const p = launcherPaths(opts)
  const sourceRoot = opts.sourceRoot ?? repoRoot()
  const logLine = opts.log ?? (() => {})
  const staging = `${p.runtimeDir}.staging-${process.pid}-${Date.now()}`
  const backup = `${p.runtimeDir}.old-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const copied: string[] = []
  try {
    for (const entry of RUNTIME_ENTRIES) {
      copyRuntimeEntry(sourceRoot, staging, entry)
      copied.push(entry)
    }
    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      JSON.stringify({
        version: LAUNCHER_VERSION,
        installedAt: new Date().toISOString(),
        sourceRoot,
        node: process.execPath,
        entries: copied,
      }, null, 2) + '\n',
    )
    fs.mkdirSync(path.dirname(p.runtimeDir), { recursive: true })
    fs.rmSync(backup, { recursive: true, force: true })
    if (fs.existsSync(p.runtimeDir)) fs.renameSync(p.runtimeDir, backup)
    try {
      fs.renameSync(staging, p.runtimeDir)
    } catch (err) {
      if (fs.existsSync(backup) && !fs.existsSync(p.runtimeDir)) fs.renameSync(backup, p.runtimeDir)
      throw err
    }
    fs.rmSync(backup, { recursive: true, force: true })
    logLine(`runtime installed: ${p.runtimeDir} (${copied.length} entries)`)
    return { runtimeDir: p.runtimeDir, copied }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
}

/** Public entry: rebuilds the snapshot under the install lock. */
export async function installRuntime(opts: InstallRuntimeOptions = {}): Promise<{ runtimeDir: string; copied: string[] }> {
  const p = launcherPaths(opts)
  return withInstallLock(p, () => installRuntimeUnlocked(opts))
}

function launcherInfoPlist(): string {
  const version = LAUNCHER_VERSION
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${escapeXml(LAUNCHER_APP_NAME)}</string>
  <key>CFBundleExecutable</key><string>${LAUNCHER_EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>backlight</string>
  <key>CFBundleIdentifier</key><string>${LAUNCHER_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${escapeXml(LAUNCHER_APP_NAME)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`
}

async function defaultCompile(source: string, out: string): Promise<void> {
  await run('/usr/bin/swiftc', ['-O', source, '-o', out], 120_000)
}

async function prepareLauncherIcon(engine: BrandedEngine | null, root: string, destIcns: string): Promise<void> {
  if (engine && fs.existsSync(engine.iconPath)) {
    fs.copyFileSync(engine.iconPath, destIcns)
    return
  }
  const master = path.join(root, 'brand-icon.png')
  if (fs.existsSync(master)) {
    await makeIcns(master, destIcns)
    return
  }
  const generated = path.join(root, 'launcher-icon.png')
  generateDefaultIcon(LAUNCHER_APP_NAME, generated)
  await makeIcns(generated, destIcns)
  fs.rmSync(generated, { force: true })
}

function defaultNodeCandidates(nodePath: string): string[] {
  const candidates = [
    nodePath,
    fs.existsSync(nodePath) ? fs.realpathSync(nodePath) : nodePath,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ]
  return [...new Set(candidates.filter(Boolean))]
}

/** Build a launcher bundle in a staging dir (no swap, no registration). */
export async function buildLauncherApp(opts: BuildLauncherOptions = {}): Promise<{
  appPath: string
  stagingRoot: string
  config: LauncherConfig
}> {
  const p = launcherPaths(opts)
  const sourceRoot = opts.sourceRoot ?? repoRoot()
  const logLine = opts.log ?? (() => {})
  const engine = findBrandedEngine(p.root)
  if (!engine) {
    throw new Error(`branded engine not found under ${path.join(p.root, 'apps')}; run: bl brand --name Backlight`)
  }
  const nodePath = opts.nodePath ?? process.execPath
  if (!isExecutableFile(nodePath)) throw new Error(`node executable not found: ${nodePath}`)
  const source = path.join(sourceRoot, 'packages', 'launcher', 'main.swift')
  if (!fs.existsSync(source)) throw new Error(`launcher source missing: ${source}`)

  const stagingRoot = path.join(p.applicationsDir, `.backlight-launcher-build-${process.pid}-${Date.now()}`)
  const appPath = path.join(stagingRoot, `${LAUNCHER_APP_NAME}.app`)
  const macosDir = path.join(appPath, 'Contents', 'MacOS')
  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  fs.rmSync(stagingRoot, { recursive: true, force: true })
  fs.mkdirSync(macosDir, { recursive: true })
  fs.mkdirSync(resourcesDir, { recursive: true })
  try {
    const executable = path.join(macosDir, LAUNCHER_EXECUTABLE)
    await (opts.compile ?? defaultCompile)(source, executable)
    if (!isExecutableFile(executable)) throw new Error(`compiled launcher missing: ${executable}`)
    await prepareLauncherIcon(engine, p.root, path.join(resourcesDir, 'backlight.icns'))
    fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), launcherInfoPlist())
    const config: LauncherConfig = {
      bundleId: LAUNCHER_BUNDLE_ID,
      node: nodePath,
      nodeCandidates: opts.nodeCandidates ?? defaultNodeCandidates(nodePath),
      cli: path.join(p.runtimeDir, 'packages', 'cli', 'bin', 'backlight.js'),
      args: ['login'],
      home: p.root,
      engine: engine.binPath,
      log: p.logFile,
    }
    fs.writeFileSync(path.join(resourcesDir, 'launcher.json'), JSON.stringify(config, null, 2) + '\n')
    await run('/usr/bin/plutil', ['-lint', path.join(appPath, 'Contents', 'Info.plist')], 30_000)
    await run('/usr/bin/codesign', ['--force', '--sign', '-', appPath], 60_000)
    logLine(`launcher built: ${appPath}`)
    return { appPath, stagingRoot, config }
  } catch (err) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    throw err
  }
}

/** Replacement/uninstall require the exact launcher bundle id; merely having a
 * launcher.json resource is not ownership. */
export function isOurLauncher(appPath: string): boolean {
  return readBundleInfo(appPath)?.bundleId === LAUNCHER_BUNDLE_ID
}

/** Build + atomically replace ~/Applications/Backlight.app, register it with
 * LaunchServices and select the branded engine. Refuses to touch a foreign app. */
export async function installLauncher(opts: InstallLauncherOptions = {}): Promise<{
  appPath: string
  runtimeDir: string
  engine: string | null
  settingsChanged: boolean
  checks: VerifyCheck[]
}> {
  const p = launcherPaths(opts)
  const logLine = opts.log ?? (() => {})
  return withInstallLock(p, async () => {
    if (fs.existsSync(p.launcherApp) && !isOurLauncher(p.launcherApp)) {
      throw new Error(
        `refusing to overwrite ${p.launcherApp}: it is not a Backlight launcher (expected bundle id ${LAUNCHER_BUNDLE_ID})`,
      )
    }
    const runtime = opts.skipRuntime
      ? { runtimeDir: p.runtimeDir, copied: [] as string[] }
      : await installRuntimeUnlocked({ ...opts })
    const built = await buildLauncherApp(opts)
    const backup = `${p.launcherApp}.old-${process.pid}`
    fs.mkdirSync(p.applicationsDir, { recursive: true })
    fs.rmSync(backup, { recursive: true, force: true })
    const hadOld = fs.existsSync(p.launcherApp)
    try {
      if (hadOld) fs.renameSync(p.launcherApp, backup)
      fs.renameSync(built.appPath, p.launcherApp)
    } catch (err) {
      if (hadOld && !fs.existsSync(p.launcherApp) && fs.existsSync(backup)) fs.renameSync(backup, p.launcherApp)
      fs.rmSync(built.stagingRoot, { recursive: true, force: true })
      throw err
    }
    fs.rmSync(backup, { recursive: true, force: true })
    fs.rmSync(built.stagingRoot, { recursive: true, force: true })
    if (opts.register !== false) {
      await run(LSREGISTER, ['-f', p.launcherApp], 30_000)
      logLine(`registered with LaunchServices: ${p.launcherApp}`)
    }
    const selection = selectBrandedEngineSetting(p.root)
    if (selection.changed) logLine(`settings.browser -> ${selection.engine?.binPath}`)
    const checks = await verifyLauncher(opts)
    return { appPath: p.launcherApp, runtimeDir: runtime.runtimeDir, engine: selection.engine?.binPath ?? null, settingsChanged: selection.changed, checks }
  })
}

export async function verifyLauncher(opts: LauncherPathOptions = {}): Promise<VerifyCheck[]> {
  const p = launcherPaths(opts)
  const checks: VerifyCheck[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  const exists = fs.existsSync(p.launcherApp)
  add('launcher app exists', exists, p.launcherApp)
  if (!exists) return checks

  const info = readBundleInfo(p.launcherApp)
  add('bundle id', info?.bundleId === LAUNCHER_BUNDLE_ID, `CFBundleIdentifier=${info?.bundleId ?? 'missing'}`)
  let plistText = ''
  try {
    plistText = fs.readFileSync(path.join(p.launcherApp, 'Contents', 'Info.plist'), 'utf8')
  } catch { /* reported by plist lint below */ }
  // The launcher hands off to the CLI and exits; LSUIElement keeps it out of
  // the Dock (no duplicate icon flash) while Launchpad still lists it.
  add('launcher hidden from Dock (LSUIElement)', /<key>LSUIElement<\/key>\s*<true\s*\/>/.test(plistText), 'LSUIElement=true')
  try {
    const lint = await run('/usr/bin/plutil', ['-lint', path.join(p.launcherApp, 'Contents', 'Info.plist')], 30_000)
    add('plist lint', /OK$/m.test(lint.trim()) || lint.includes('OK'), lint.trim())
  } catch (err) {
    add('plist lint', false, (err as Error).message)
  }

  const execName = info?.executable ?? LAUNCHER_EXECUTABLE
  const executable = path.join(p.launcherApp, 'Contents', 'MacOS', execName)
  add('executable', isExecutableFile(executable), executable)
  add('icon', fs.existsSync(path.join(p.launcherApp, 'Contents', 'Resources', 'backlight.icns')), 'backlight.icns')

  let config: LauncherConfig | null = null
  try {
    config = JSON.parse(fs.readFileSync(path.join(p.launcherApp, 'Contents', 'Resources', 'launcher.json'), 'utf8'))
  } catch { /* reported below */ }
  add('launcher config', !!config && config.bundleId === LAUNCHER_BUNDLE_ID, config ? 'launcher.json readable' : 'launcher.json missing/invalid')
  if (config) {
    add('cli target', typeof config.cli === 'string' && fs.existsSync(config.cli), config.cli)
    add('cli arguments', Array.isArray(config.args) && config.args[0] === 'login', `args=${JSON.stringify(config.args)}`)
    const nodes = [config.node, ...(config.nodeCandidates ?? [])].filter(Boolean)
    add('node executable', nodes.some(isExecutableFile), config.node)
    add('runtime dir', path.resolve(config.cli).startsWith(path.resolve(p.runtimeDir) + path.sep), p.runtimeDir)
    add('launcher home', config.home === p.root, config.home)
    const engine = config.engine ? findBrandedEngine(p.root, config.engine) : null
    add('branded engine target', !!engine, config.engine ?? 'not configured')
    add('engine not launcher', !config.engine || path.resolve(config.engine) !== path.resolve(executable), 'launcher must never point at itself')
    add('engine distinct from launcher app', !engine || path.resolve(engine.appPath) !== path.resolve(p.launcherApp), 'engine app path must differ from launcher app path')
  }
  try {
    await run('/usr/bin/codesign', ['--verify', p.launcherApp], 30_000)
    add('codesign verify', true, 'ad-hoc signature valid')
  } catch (err) {
    add('codesign verify', false, (err as Error).message)
  }
  return checks
}

export async function uninstallLauncher(opts: LauncherPathOptions & { purgeRuntime?: boolean; register?: boolean } = {}): Promise<{ removed: boolean; note?: string }> {
  const p = launcherPaths(opts)
  if (!fs.existsSync(p.launcherApp)) return { removed: false, note: 'launcher not installed' }
  if (!isOurLauncher(p.launcherApp)) {
    throw new Error(`refusing to remove ${p.launcherApp}: not a Backlight launcher`)
  }
  fs.rmSync(p.launcherApp, { recursive: true, force: true })
  if (opts.register !== false) {
    await run(LSREGISTER, ['-u', p.launcherApp], 30_000).catch(() => {})
  }
  if (opts.purgeRuntime) fs.rmSync(p.runtimeDir, { recursive: true, force: true })
  return { removed: true }
}
