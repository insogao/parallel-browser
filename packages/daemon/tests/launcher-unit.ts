import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// Isolate settings/paths before the daemon modules are loaded; every path
// intentionally contains a space to exercise argument handling.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-launcher-'))
const home = path.join(base, 'back light home')
const applicationsDir = path.join(base, 'user applications dir')
const sourceRoot = path.join(base, 'source tree')
process.env.BACKLIGHT_HOME = home

const launcher = await import('../src/launcher.ts')
const { invalidateSettings } = await import('../src/store.ts')
const { createServer } = await import('../src/proxy.ts')

const {
  LAUNCHER_BUNDLE_ID, ENGINE_BUNDLE_ID,
  findBrandedEngine, findBrandedEngines, resolveBrandedEngineSelection, selectBrandedEngineSetting,
  buildLauncherApp, installRuntime, installLauncher, verifyLauncher, uninstallLauncher,
  readBundleInfo, launcherPaths, isOurLauncher,
} = launcher
const { acquireFileLock, releaseFileLock, tryAcquireFileLock } = await import('../src/single-instance.ts')

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function write(file: string, content: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode) fs.chmodSync(file, mode)
}

function collectSymlinks(root: string): string[] {
  const links: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const candidate = path.join(dir, entry.name)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) links.push(candidate)
      else if (stat.isDirectory()) walk(candidate)
    }
  }
  walk(root)
  return links
}

/** Every copied pnpm symlink must resolve inside the snapshot (no link back
 * into a worktree/source tree) and none may dangle after dev-dep pruning. */
function assertSymlinksStayInside(runtimeDir: string) {
  // /var is a symlink to /private/var on macOS; compare canonical paths only.
  const canonical = fs.realpathSync(runtimeDir)
  const links = collectSymlinks(runtimeDir)
  assert.ok(links.length > 0, 'snapshot should contain pnpm symlinks')
  for (const link of links) {
    let real: string
    try {
      real = fs.realpathSync(link)
    } catch {
      assert.fail(`dangling symlink in snapshot: ${link}`)
    }
    assert.ok(
      real === canonical || real.startsWith(canonical + path.sep),
      `symlink escapes the snapshot: ${link} -> ${real}`,
    )
  }
}

function makeEngineFixture(root: string, name = 'Backlight.app', bundleId = ENGINE_BUNDLE_ID) {
  const app = path.join(root, 'apps', name)
  const executable = 'Google Chrome for Testing'
  const bin = path.join(app, 'Contents', 'MacOS', executable)
  write(bin, '#!/bin/sh\nexit 0\n', 0o755)
  write(path.join(app, 'Contents', 'Resources', 'backlight.icns'), 'FAKE_ICNS')
  write(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>Backlight</string>
  <key>CFBundleDisplayName</key><string>Backlight</string>
  <key>CFBundleIconFile</key><string>backlight</string>
</dict></plist>`)
  return { app, bin }
}

const engine = makeEngineFixture(home)
write(path.join(home, 'apps', 'Chrome.app', 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Google Chrome</string>
  <key>CFBundleIdentifier</key><string>com.google.Chrome</string>
</dict></plist>`)

function makeSourceFixture(root: string) {
  write(path.join(root, 'packages', 'cli', 'package.json'), '{"name":"@backlight/cli","type":"module"}\n')
  write(path.join(root, 'packages', 'cli', 'bin', 'backlight.js'), "import '../src/index.ts'\n", 0o755)
  write(path.join(root, 'packages', 'cli', 'src', 'index.ts'), 'export {}\n')
  write(path.join(root, 'packages', 'daemon', 'package.json'), '{"name":"@backlight/daemon","type":"module"}\n')
  write(path.join(root, 'packages', 'daemon', 'src', 'index.ts'), 'export {}\n')
  write(path.join(root, 'packages', 'launcher', 'main.swift'), '// fixture\n')
  write(path.join(root, 'packages', 'tray', 'build.sh'), '#!/bin/bash\n')
  write(path.join(root, 'packages', 'tray', 'main.swift'), '// fixture\n')
  write(path.join(root, 'tools', 'app-control.swift'), '// fixture\n')

  const pnpm = path.join(root, 'node_modules', '.pnpm')
  const packages: Array<[string, string]> = [
    ['ws@8.21.3', 'ws'],
    ['chokidar@4.0.3', 'chokidar'],
    ['@puppeteer+browsers@3.2.2', '@puppeteer/browsers'],
    ['typescript@5.9.3', 'typescript'],
    ['@types+node@24.13.4', '@types/node'],
  ]
  for (const [dir, name] of packages) {
    const pkgDir = path.join(pnpm, dir, 'node_modules', name)
    write(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }))
    write(path.join(pkgDir, 'index.js'), 'export const name = ' + JSON.stringify(name) + '\n')
  }
  const daemonModules = path.join(root, 'packages', 'daemon', 'node_modules')
  const link = (target: string, rel: string) => {
    const dest = path.join(daemonModules, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.symlinkSync(target, dest)
  }
  link('../../../node_modules/.pnpm/ws@8.21.3/node_modules/ws', 'ws')
  link('../../../node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar', 'chokidar')
  link('../../../../node_modules/.pnpm/@puppeteer+browsers@3.2.2/node_modules/@puppeteer/browsers', '@puppeteer/browsers')
  link('../../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript', 'typescript')
  write(path.join(daemonModules, '@types', 'node', 'index.d.ts'), '// dev only\n')

  // pnpm hoists a few packages into .pnpm/node_modules; the dev ones must be
  // pruned so they do not become dangling symlinks after the snapshot copy.
  const hoist = path.join(pnpm, 'node_modules')
  link('../typescript@5.9.3/node_modules/typescript', path.relative(daemonModules, path.join(hoist, 'typescript')))
  link('../ws@8.21.3/node_modules/ws', path.relative(daemonModules, path.join(hoist, 'ws')))
  link('../../@types+node@24.13.4/node_modules/@types/node', path.relative(daemonModules, path.join(hoist, '@types', 'node')))
  write(path.join(hoist, '.bin', 'tsc'), '#!/bin/sh\n')
  link('../../../../packages/cli', path.relative(daemonModules, path.join(hoist, '@backlight', 'cli')))
}
makeSourceFixture(sourceRoot)

const fakeCompile = async (_source: string, out: string) => {
  fs.copyFileSync('/bin/echo', out)
  fs.chmodSync(out, 0o755)
}

const repoLauncherSource = new URL('../../launcher/main.swift', import.meta.url).pathname

test('branded engine discovery ignores unbranded apps and resolves the setting read-only', () => {
  const engines = findBrandedEngines(home)
  assert.equal(engines.length, 1, 'only bundle id dev.backlight.browser counts')
  assert.equal(engines[0]!.bundleId, ENGINE_BUNDLE_ID)
  assert.equal(engines[0]!.binPath, engine.bin)
  assert.equal(path.basename(engines[0]!.appPath), 'Backlight.app')

  fs.rmSync(path.join(home, 'settings.json'), { force: true })
  invalidateSettings()
  const readOnly = resolveBrandedEngineSelection(home)
  assert.equal(readOnly.engine?.binPath, engine.bin)
  assert.equal(readOnly.wouldChange, true)
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')), 'resolve must not write settings.json')

  const first = selectBrandedEngineSetting(home)
  assert.equal(first.changed, true)
  assert.equal(first.engine?.binPath, engine.bin)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).browser, engine.bin)
  const second = selectBrandedEngineSetting(home)
  assert.equal(second.changed, false, 'already selected engine is a no-op')
})

test('buildLauncherApp constructs a distinct launcher bundle targeting the login command (paths with spaces)', async () => {
  const built = await buildLauncherApp({ applicationsDir, sourceRoot, nodePath: process.execPath, compile: fakeCompile })
  try {
    assert.ok(built.appPath.startsWith(applicationsDir + path.sep))
    const info = readBundleInfo(built.appPath)
    assert.equal(info?.bundleId, LAUNCHER_BUNDLE_ID)
    assert.notEqual(info?.bundleId, ENGINE_BUNDLE_ID, 'launcher must not reuse the engine bundle id')
    assert.equal(info?.name, 'Backlight')
    assert.equal(info?.executable, 'Backlight')

    const config = JSON.parse(fs.readFileSync(path.join(built.appPath, 'Contents', 'Resources', 'launcher.json'), 'utf8'))
    assert.deepEqual(config.args, ['login'], 'click target must be the daemon login path')
    assert.equal(config.cli, path.join(home, 'runtime', 'packages', 'cli', 'bin', 'backlight.js'))
    assert.equal(config.home, home)
    assert.equal(config.log, path.join(home, 'logs', 'launcher.log'))
    assert.equal(config.engine, engine.bin)
    assert.ok(config.nodeCandidates.includes(process.execPath))
    assert.ok(fs.existsSync(path.join(built.appPath, 'Contents', 'Resources', 'backlight.icns')))
    assert.ok(launcher.isExecutableFile(path.join(built.appPath, 'Contents', 'MacOS', 'Backlight')))
    assert.equal(sha256(engine.bin), sha256(engine.bin))
  } finally {
    fs.rmSync(built.stagingRoot, { recursive: true, force: true })
  }
})

test('installRuntime snapshots the project (relative symlinks, dev deps pruned) and is repeatable', async () => {
  const p = launcherPaths({ root: home })
  const first = await installRuntime({ sourceRoot, root: home })
  assert.ok(fs.existsSync(path.join(first.runtimeDir, 'packages', 'daemon', 'src', 'index.ts')))
  assert.ok(fs.existsSync(path.join(first.runtimeDir, 'packages', 'cli', 'bin', 'backlight.js')))
  assert.ok(fs.existsSync(path.join(first.runtimeDir, 'manifest.json')))
  assert.ok(!fs.existsSync(path.join(first.runtimeDir, 'node_modules', '.pnpm', 'typescript@5.9.3')), 'typescript is pruned')
  assert.ok(!fs.existsSync(path.join(first.runtimeDir, 'packages', 'daemon', 'node_modules', 'typescript')), 'dangling dev symlinks are pruned')
  assert.ok(!fs.existsSync(path.join(first.runtimeDir, 'node_modules', '.pnpm', 'node_modules', 'typescript')), 'dev hoist symlinks are pruned')
  assert.ok(!fs.existsSync(path.join(first.runtimeDir, 'node_modules', '.pnpm', 'node_modules', '@types')), 'dev @types hoist is pruned')
  assert.ok(!fs.existsSync(path.join(first.runtimeDir, 'node_modules', '.pnpm', 'node_modules', '.bin')), 'dev .bin hoist is pruned')
  assert.ok(fs.existsSync(fs.realpathSync(path.join(first.runtimeDir, 'packages', 'daemon', 'node_modules', 'ws'))), 'ws symlink resolves inside the snapshot')
  assertSymlinksStayInside(first.runtimeDir)

  const checkFile = path.join(first.runtimeDir, 'packages', 'daemon', '__import-check.mjs')
  fs.writeFileSync(checkFile, "await Promise.all([import('ws'), import('chokidar'), import('@puppeteer/browsers')]);\nconsole.log('deps-ok')\n")
  try {
    assert.match(execFileSync(process.execPath, [checkFile], { encoding: 'utf8' }), /deps-ok/)
  } finally {
    fs.rmSync(checkFile, { force: true })
  }

  write(path.join(sourceRoot, 'packages', 'daemon', 'src', 'refreshed.ts'), '// new\n')
  await installRuntime({ sourceRoot, root: home })
  assert.ok(fs.existsSync(path.join(p.runtimeDir, 'packages', 'daemon', 'src', 'refreshed.ts')), 'reinstall picks up new files')
  const leftovers = fs.readdirSync(home).filter(n => n.startsWith('runtime.staging-') || n.startsWith('runtime.old-'))
  assert.deepEqual(leftovers, [], 'no staging/backup leftovers')
  assert.ok(!fs.existsSync(path.join(p.runtimeDir, 'node_modules', '.pnpm', 'typescript@5.9.3')), 'reinstall stays pruned')
})

test('runtime snapshot stays functional after the source tree is removed', async () => {
  const removableSource = path.join(base, 'removable source tree')
  const independentRuntime = path.join(base, 'independent runtime dir')
  makeSourceFixture(removableSource)
  await installRuntime({ sourceRoot: removableSource, runtimeDir: independentRuntime })
  const manifest = JSON.parse(fs.readFileSync(path.join(independentRuntime, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sourceRoot, removableSource, 'manifest records provenance only')

  fs.rmSync(removableSource, { recursive: true, force: true })
  assert.ok(!fs.existsSync(removableSource), 'source tree is gone')
  assertSymlinksStayInside(independentRuntime)

  const checkFile = path.join(independentRuntime, 'packages', 'daemon', '__import-check.mjs')
  fs.writeFileSync(checkFile, "await Promise.all([import('ws'), import('chokidar')]);\nconsole.log('deps-ok')\n")
  try {
    assert.match(execFileSync(process.execPath, [checkFile], { encoding: 'utf8' }), /deps-ok/)
  } finally {
    fs.rmSync(checkFile, { force: true })
  }
  assert.ok(fs.existsSync(path.join(independentRuntime, 'packages', 'cli', 'bin', 'backlight.js')))
})

test('install lock serializes concurrent installs, recovers stale owners and never deletes unrelated state', async () => {
  const lockDir = path.join(home, 'launcher-install.lock')
  fs.rmSync(lockDir, { recursive: true, force: true })
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'held-by-test', startedAt: Date.now() }))
  assert.equal(await acquireFileLock(lockDir, { waitMs: 250, pollMs: 50 }), null, 'a live owner blocks contenders')
  assert.ok(fs.existsSync(path.join(lockDir, 'owner.json')), 'a blocked contender must not delete the lock')
  fs.rmSync(lockDir, { recursive: true, force: true })

  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 30, token: 'dead', startedAt: Date.now() - 60_000 }))
  const recovered = await acquireFileLock(lockDir, { waitMs: 1000, pollMs: 50 })
  assert.ok(recovered, 'a dead owner lock is recoverable')
  const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
  assert.equal(owner.token, recovered!.token)
  releaseFileLock(lockDir, 'not-my-token')
  assert.ok(fs.existsSync(lockDir), 'release must never remove a lock owned by someone else')
  recovered!.release()
  assert.ok(!fs.existsSync(lockDir))

  write(path.join(home, 'keep.txt'), 'KEEP')
  write(path.join(applicationsDir, 'Unrelated.app', 'marker'), 'KEEP')
  const opts = { applicationsDir, sourceRoot, nodePath: process.execPath, compile: fakeCompile, register: false }
  const [a, b] = await Promise.all([installLauncher(opts), installLauncher(opts)])
  assert.equal(a.appPath, b.appPath, 'both concurrent installers converge on the same app')
  assert.ok(fs.existsSync(path.join(home, 'keep.txt')), 'unrelated files survive installs')
  assert.ok(fs.existsSync(path.join(applicationsDir, 'Unrelated.app', 'marker')), 'unrelated apps survive installs')
  assert.ok(fs.existsSync(path.join(a.appPath, 'Contents', 'MacOS', 'Backlight')))
})

test('installLauncher is idempotent, leaves the engine untouched and verifies cleanly', async () => {
  const engineBinDigest = sha256(engine.bin)
  const enginePlistDigest = sha256(path.join(engine.app, 'Contents', 'Info.plist'))
  const opts = { applicationsDir, sourceRoot, nodePath: process.execPath, compile: fakeCompile, register: false }

  write(path.join(applicationsDir, 'Unrelated.app', 'marker'), 'KEEP')
  write(path.join(home, 'keep.txt'), 'KEEP')
  const first = await installLauncher(opts)
  assert.equal(first.appPath, path.join(applicationsDir, 'Backlight.app'))
  assert.equal(first.engine, engine.bin)
  assert.ok(fs.existsSync(first.appPath))

  const second = await installLauncher(opts)
  assert.equal(second.appPath, first.appPath)
  const checks = second.checks
  const failed = checks.filter(c => !c.ok)
  assert.deepEqual(failed, [], `checks failed: ${failed.map(c => `${c.name}: ${c.detail}`).join('; ')}`)
  assert.ok(checks.some(c => c.name === 'cli arguments' && c.ok))
  assert.ok(checks.some(c => c.name === 'codesign verify' && c.ok))
  assert.ok(checks.some(c => c.name === 'engine distinct from launcher app' && c.ok))

  assert.equal(sha256(engine.bin), engineBinDigest, 'engine executable must not be modified')
  assert.equal(sha256(path.join(engine.app, 'Contents', 'Info.plist')), enginePlistDigest, 'engine plist must not be modified')
  assert.notEqual(sha256(path.join(first.appPath, 'Contents', 'MacOS', 'Backlight')), engineBinDigest)
  assert.notEqual(readBundleInfo(first.appPath)?.bundleId, readBundleInfo(engine.app)?.bundleId)

  const leftovers = fs.readdirSync(applicationsDir).filter(n => n.startsWith('.backlight-launcher-build-') || n.endsWith('.old-' + process.pid))
  assert.deepEqual(leftovers, [], 'no build or backup leftovers')
  assert.ok(fs.existsSync(path.join(applicationsDir, 'Unrelated.app', 'marker')), 'unrelated apps survive replacement')
  assert.ok(fs.existsSync(path.join(home, 'keep.txt')), 'unrelated files survive replacement')
})

test('ownership requires the exact launcher bundle id, not just launcher.json', async () => {
  const fakeDir = path.join(base, 'lookalike applications')
  const fakeApp = path.join(fakeDir, 'Backlight.app')
  write(path.join(fakeApp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.lookalike</string></dict></plist>`)
  write(path.join(fakeApp, 'Contents', 'Resources', 'launcher.json'), '{"bundleId":"com.example.lookalike"}')
  assert.equal(isOurLauncher(fakeApp), false, 'launcher.json alone must not imply ownership')
  const opts = { applicationsDir: fakeDir, sourceRoot, nodePath: process.execPath, compile: fakeCompile, register: false }
  await assert.rejects(installLauncher(opts), /refusing to overwrite/)
  await assert.rejects(uninstallLauncher({ applicationsDir: fakeDir, register: false }), /refusing to remove/)
  assert.ok(fs.existsSync(fakeApp), 'lookalike app must survive')
})

test('installLauncher refuses to overwrite a foreign ~/Applications/Backlight.app', async () => {
  const foreignDir = path.join(base, 'foreign applications')
  const foreignApp = path.join(foreignDir, 'Backlight.app')
  write(path.join(foreignApp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.unrelated</string></dict></plist>`)
  write(path.join(foreignApp, 'keep.txt'), 'KEEP')
  const before = sha256(path.join(foreignApp, 'Contents', 'Info.plist'))

  await assert.rejects(
    installLauncher({ applicationsDir: foreignDir, sourceRoot, nodePath: process.execPath, compile: fakeCompile, register: false }),
    /refusing to overwrite/,
  )
  assert.ok(fs.existsSync(path.join(foreignApp, 'keep.txt')), 'unrelated files must survive')
  assert.equal(sha256(path.join(foreignApp, 'Contents', 'Info.plist')), before)
  assert.equal(fs.readdirSync(foreignDir).length, 1, 'no staging dir may be left behind')
})

test('compiled launcher prints its config and passes selftest without touching daemon/browser', async (t) => {
  if (!fs.existsSync('/usr/bin/swiftc')) return t.skip('swiftc unavailable')
  const swiftApps = path.join(base, 'swift applications')
  const built = await buildLauncherApp({
    applicationsDir: swiftApps,
    sourceRoot,
    nodePath: process.execPath,
    compile: async (_source, out) => {
      execFileSync('/usr/bin/swiftc', ['-O', repoLauncherSource, '-o', out])
      fs.chmodSync(out, 0o755)
    },
  })
  const executable = path.join(built.appPath, 'Contents', 'MacOS', 'Backlight')
  const printed = spawnSync(executable, ['--print-config'], { encoding: 'utf8' })
  assert.equal(printed.status, 0, `print-config failed: ${printed.stdout}${printed.stderr}`)
  const config = JSON.parse(printed.stdout)
  assert.deepEqual(config, built.config)
  assert.deepEqual(config.args, ['login'])
  const selftest = spawnSync(executable, ['--selftest'], { encoding: 'utf8' })
  assert.equal(selftest.status, 0, `selftest failed: ${selftest.stdout}${selftest.stderr}`)
  assert.match(selftest.stdout, /^selftest ok:/)

  const argvTarget = JSON.parse(execFileSync(executable, ['--print-config'], { encoding: 'utf8' })).cli
  assert.ok(argvTarget.includes(path.sep + 'runtime' + path.sep), 'launcher must target the installed runtime, not a worktree')
  fs.rmSync(built.stagingRoot, { recursive: true, force: true })
})

// ---- POST /api/login (click behavior) ---------------------------------------

function loginHarness() {
  const state = {
    running: false,
    current: null as any,
    launches: [] as any[],
    restores: [] as boolean[],
    paused: [] as boolean[],
    activated: 0,
  }
  const manager = {
    get running() { return state.running },
    get current() { return state.current },
    launch: async (opts: any) => {
      state.launches.push(opts)
      state.running = true
      state.current = { binary: engine.bin, pid: 4321, upstreamPort: 1 }
      return state.current
    },
  }
  const supervisor = {
    humanMode: false,
    starts: 0,
    beginControl: () => 7,
    start() { this.starts++ },
    async restoreAll(maximize: boolean) { state.restores.push(maximize); return 3 },
    isControlCurrent: () => true,
  }
  const capture = {
    paused: false,
    async setPaused(paused: boolean) { state.paused.push(paused); capture.paused = paused },
    isPaused() { return capture.paused },
  }
  const deps = {
    manager,
    supervisor,
    health: {},
    capture,
    extensions: {},
    extensionDev: {},
    bus: {},
    version: '0',
    startedAt: 0,
    pulse() {},
    appState: async () => ({ active: false, hidden: false }),
    hideBrowser: async () => {},
    unhideBrowser: async () => {},
    activateBrowser: async () => { state.activated++ },
  }
  const server = createServer(deps as any)
  return { state, manager, supervisor, capture, server }
}

const harness = loginHarness()
const baseUrl = await new Promise<string>(r => harness.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(harness.server.address() as any).port}`)))
const login = () => fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => ({ status: r.status, body: await r.json() as any }))

function setSettingsBrowser(value: string) {
  write(path.join(home, 'settings.json'), JSON.stringify({ browser: value }))
  invalidateSettings()
}

test('login selects the branded engine, launches the default space and maximizes', async () => {
  setSettingsBrowser('auto')
  const res = await login()
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.launched, true)
  assert.equal(res.body.restored, 3)
  assert.equal(res.body.engine, engine.bin)
  assert.equal(harness.state.launches.length, 1)
  assert.equal(harness.state.launches[0].focus, true, 'assisted login must launch visibly')
  assert.equal(harness.state.restores.at(-1), true, 'login maximizes')
  assert.deepEqual(harness.state.paused.slice(-1), [true])
  assert.equal(harness.state.activated, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).browser, engine.bin)
})

test('a second click reuses the running managed browser (no new launch)', async () => {
  const before = harness.state.launches.length
  const res = await login()
  assert.equal(res.body.launched, false)
  assert.equal(res.body.restored, 3)
  assert.equal(harness.state.launches.length, before)
  assert.equal(harness.state.activated, 2)
})

test('concurrent clicks share one launch', { timeout: 20_000 }, async () => {
  harness.state.running = false
  harness.state.current = null
  const originalLaunch = harness.manager.launch
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let calls = 0
  harness.manager.launch = async (_opts: any) => {
    calls++
    await gate
    harness.state.running = true
    harness.state.current = { binary: engine.bin, pid: 999, upstreamPort: 1 }
    return harness.state.current
  }
  try {
    const first = login()
    const second = login()
    const wait = Date.now() + 5000
    while (calls < 1 && Date.now() < wait) await new Promise(r => setTimeout(r, 10))
    assert.equal(calls, 1, 'first click must reach the gated launch')
    await new Promise(r => setTimeout(r, 200))
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(calls, 1, 'both clicks must share the in-flight launch')
    assert.equal(a.body.ok, true)
    assert.equal(b.body.ok, true)
    assert.equal(a.body.launched, true)
    assert.equal(b.body.launched, true)
  } finally {
    harness.manager.launch = originalLaunch
  }
})

test('a mismatched live engine is refused with zero side effects', async () => {
  setSettingsBrowser('auto')
  harness.state.running = true
  harness.state.current = { binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', pid: 111, upstreamPort: 1 }
  harness.supervisor.humanMode = false
  harness.capture.paused = true
  const launches = harness.state.launches.length
  const restores = harness.state.restores.length
  const paused = harness.state.paused.length
  const activated = harness.state.activated

  const res = await login()

  assert.equal(res.body.ok, false)
  assert.equal(res.body.mismatchedEngine, true)
  assert.equal(res.body.launched, false)
  assert.equal(res.body.restored, 0)
  assert.equal(res.body.engine, engine.bin, 'the selected setting is still the branded engine')
  assert.equal(res.body.currentEngine, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  assert.match(res.body.note, /different engine/)
  assert.equal(harness.state.launches.length, launches, 'no launch')
  assert.equal(harness.state.restores.length, restores, 'no restore/maximize')
  assert.equal(harness.state.paused.length, paused, 'capture pause untouched')
  assert.equal(harness.state.activated, activated, 'no activation')
  assert.equal(harness.supervisor.humanMode, false, 'humanMode untouched')
  assert.equal(harness.capture.paused, true, 'capture keeps its prior pause state')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).browser, 'auto', 'settings must not be rewritten')
})

test('a failed launch restores prior control/capture state', async () => {
  setSettingsBrowser(engine.bin)
  harness.state.running = false
  harness.state.current = null
  harness.supervisor.humanMode = false
  harness.capture.paused = false
  const originalLaunch = harness.manager.launch
  harness.manager.launch = async () => { throw new Error('engine missing') }
  try {
    const res = await login()
    assert.equal(res.status, 502)
    assert.match(res.body.error, /engine missing/)
    assert.equal(harness.supervisor.humanMode, false, 'humanMode rolled back to the prior value')
    assert.equal(harness.capture.paused, false, 'capture pause restored to the prior value')
    assert.equal(harness.state.paused.at(-1), false, 'capture was un-paused after the failure')
  } finally {
    harness.manager.launch = originalLaunch
  }
})

test('uninstallLauncher removes only our launcher by default', async () => {
  const res = await uninstallLauncher({ applicationsDir, register: false })
  assert.equal(res.removed, true)
  assert.ok(!fs.existsSync(path.join(applicationsDir, 'Backlight.app')))
  assert.ok(fs.existsSync(path.join(home, 'runtime')), 'runtime survives without --purge')
})

test.after(() => {
  harness.server.close()
  fs.rmSync(base, { recursive: true, force: true })
})
