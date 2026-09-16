import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const { readLiveDaemon, writeDaemonInfo, acquireFileLock, releaseFileLock, tryAcquireFileLock } =
  await import('../src/single-instance.ts')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-single-instance-'))

function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`timeout waiting for ${label}`))
      setTimeout(poll, 100)
    }
    poll()
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

test('readLiveDaemon/writeDaemonInfo only expose live daemons and write atomically', () => {
  const file = path.join(base, 'daemon.json')
  fs.rmSync(file, { force: true })
  assert.equal(readLiveDaemon(file), null)
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, port: 1 }))
  assert.equal(readLiveDaemon(file), null, 'dead pid is not a live daemon')
  writeDaemonInfo({ pid: process.pid, port: 123, startedAt: 1 }, file)
  assert.deepEqual(readLiveDaemon(file), { pid: process.pid, port: 123, startedAt: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid)
  assert.deepEqual(fs.readdirSync(base).filter(n => n.includes('daemon.json.tmp-')), [], 'no tmp files left behind')
})

test('file locks: live owners block, stale owners are taken over atomically, tokens guard release', async () => {
  const keep = path.join(base, 'keep-me.txt')
  fs.writeFileSync(keep, 'KEEP')
  const lockDir = path.join(base, 'daemon.lock')
  fs.rmSync(lockDir, { recursive: true, force: true })

  const first = tryAcquireFileLock(lockDir)
  assert.ok(first, 'first acquire wins')
  const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
  assert.equal(owner.pid, process.pid)
  assert.equal(owner.token, first!.token)

  assert.equal(tryAcquireFileLock(lockDir), null, 'live owner blocks a second acquire')
  assert.equal(await acquireFileLock(lockDir, { waitMs: 200, pollMs: 50 }), null, 'contender times out without touching the lock')
  assert.ok(fs.existsSync(path.join(lockDir, 'owner.json')), 'the live lock survives contention')
  releaseFileLock(lockDir, 'not-my-token')
  assert.ok(fs.existsSync(lockDir), 'token mismatch must never release')
  first!.release()
  assert.ok(!fs.existsSync(lockDir))

  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 30, token: 'dead', startedAt: Date.now() - 60_000 }))
  fs.writeFileSync(path.join(lockDir, 'stale-content.txt'), 'replaced with the tombstone')
  const recovered = await acquireFileLock(lockDir, { waitMs: 1000, pollMs: 50 })
  assert.ok(recovered, 'dead owner lock is recoverable')
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token, recovered!.token)
  assert.ok(!fs.existsSync(path.join(lockDir, 'stale-content.txt')), 'stale contents are gone with the tombstone')
  recovered!.release()

  // two contenders racing to take over one stale lock: exactly one owner
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 30, token: 'dead', startedAt: Date.now() - 60_000 }))
  const [a, b] = await Promise.all([tryAcquireFileLock(lockDir), tryAcquireFileLock(lockDir)])
  assert.equal([a, b].filter(Boolean).length, 1, 'only one contender may take over')
  ;(a ?? b)!.release()
  assert.ok(fs.existsSync(keep), 'lock operations must not delete unrelated files')
  assert.deepEqual(fs.readdirSync(base).filter(n => n.includes('.stale-')), [], 'no tombstones left behind')
})

test('two daemons racing for one data dir: exactly one survives and owns daemon.json', { timeout: 60_000 }, async () => {
  const home = path.join(base, 'daemon home')
  fs.mkdirSync(home, { recursive: true })
  const port = await freePort()
  const daemonEntry = new URL('../src/index.ts', import.meta.url).pathname
  const env = {
    ...process.env,
    BACKLIGHT_HOME: home,
    BACKLIGHT_PORT: String(port),
    BACKLIGHT_TRAY: '0',
  }
  const children: ChildProcess[] = []
  const output: string[] = []
  const start = () => {
    const child = spawn(process.execPath, [daemonEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', d => output.push(String(d)))
    child.stderr?.on('data', d => output.push(String(d)))
    children.push(child)
    return child
  }
  start()
  start()
  try {
    await waitFor(() => readLiveDaemon(path.join(home, 'daemon.json')) != null, 25_000, 'daemon.json')
    await waitFor(() => children.filter(c => c.exitCode === null).length === 1, 15_000, 'one daemon to exit')
    const alive = children.filter(c => c.exitCode === null)
    assert.equal(alive.length, 1, `expected one daemon, got ${alive.length}: ${output.join('').slice(0, 800)}`)
    const info = readLiveDaemon(path.join(home, 'daemon.json'))!
    assert.equal(info.pid, alive[0]!.pid, 'daemon.json points at the surviving daemon')
    assert.equal(info.port, port, 'winner keeps the configured port instead of falling back')

    const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(r => r.json() as any)
    assert.equal(status.daemon.pid, info.pid)
    assert.equal(status.browser.running, false)
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.all(children.map(c => c.exitCode !== null ? null : new Promise<void>(r => c.once('exit', () => r()))))
  }
  assert.equal(readLiveDaemon(path.join(home, 'daemon.json')), null, 'shutdown removes daemon.json')
  assert.ok(!fs.existsSync(path.join(home, 'daemon.lock')), 'start lock is released')
  assert.deepEqual(fs.readdirSync(home).filter(n => n.includes('.stale-') || n.includes('.tmp-')), [], 'no stale/tmp leftovers')
})

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true })
})
