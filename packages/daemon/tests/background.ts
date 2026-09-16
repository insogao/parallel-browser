import { backlightFixture } from './backlight-fixture.ts'
/**
 * M4 background-first launch e2e: `launch` must NOT leave a visible window —
 * windows are auto-minimized within seconds, pages keep rendering via frame
 * pump, `/api/open` never brings a window up, and `/api/show` restores them.
 *
 * Run: node tests/background.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backlight-bg-'))
backlightFixture(TMP)
const PORT = 9440
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const PAGE = (t: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>${t}</title></head>
<body style="font:40px monospace;background:#101418;color:#39d98a">${t}
<script>let raf=0;window.__h={raf:0};const f=()=>{window.__h.raf++;requestAnimationFrame(f)};requestAnimationFrame(f);</script>
</body></html>`)}`

const apiGet = (p: string): Promise<any> => fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())
const apiPost = (p: string, b: unknown): Promise<any> => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())

async function waitApi(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(800) })
      if (res.ok) return
    } catch { /* retry */ }
    await sleep(200)
  }
  throw new Error('daemon did not come up')
}

async function main() {
  const daemon = spawn(process.execPath, [path.resolve('src/index.ts')], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, BACKLIGHT_HOME: TMP, BACKLIGHT_PORT: String(PORT), BACKLIGHT_VERBOSE: '1' },
  })
  daemon.unref()
  try {
    await waitApi(10_000)
    const launched = await apiPost('/api/launch', { url: PAGE('bg1'), source: 'test.background.launch' })
    if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)

    // wait for auto-collapse: every window must reach the offscreen corner
    const deadline = Date.now() + 8000
    let allCornered = false
    while (Date.now() < deadline) {
      await sleep(400)
      const w = await apiGet('/api/windows')
      const wins = w.windows ?? []
      if (wins.length > 0 && wins.every((x: any) => x.cornered)) { allCornered = true; break }
    }
    console.log(`auto-collapse to offscreen corner: ${allCornered}`)

    // page must render NATIVELY at full speed (corner keeps window visible)
    await sleep(2500) // let health engage
    const status = await apiGet('/api/status')
    const version = await fetchVersion(status.browser.upstreamPort)
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
    const page = targetInfos.find(t => t.type === 'page' && t.title === 'bg1')!
    const sessionId = await cdp.attach(page.targetId)
    const a = (await cdp.send<{ result: { value: any } }>('Runtime.evaluate', { expression: 'window.__blHealth.native', returnByValue: true }, sessionId)).result.value
    await sleep(5000)
    const b = (await cdp.send<{ result: { value: any } }>('Runtime.evaluate', { expression: 'window.__blHealth.native', returnByValue: true }, sessionId)).result.value
    const rafPerSec = (b - a) / 5
    console.log(`cornered native rAF/s: ${rafPerSec.toFixed(1)}`)

    // open a second page: must not restore any window
    await apiPost('/api/open', { url: PAGE('bg2') })
    await sleep(2500)
    const w2 = await apiGet('/api/windows')
    const stillCornered = (w2.windows ?? []).every((x: any) => x.cornered)
    console.log(`after /api/open windows still cornered: ${stillCornered}`)

    // show: windows come back
    await apiPost('/api/show', { source: 'test.background.show' })
    await sleep(1200)
    const w3 = await apiGet('/api/windows')
    const restored = (w3.windows ?? []).length > 0 && (w3.windows ?? []).every((x: any) => !x.cornered && x.state === 'normal')
    console.log(`after /api/show windows restored: ${restored}`)

    const pass = allCornered && rafPerSec >= 45 && stillCornered && restored
    console.log(`\n${pass ? 'PASS' : 'FAIL'} background-first launch e2e`)
    process.exitCode = pass ? 0 : 1
  } catch (err) {
    console.error('\nBACKGROUND TEST ERROR:', err instanceof Error ? err.stack : err)
    process.exitCode = 1
  } finally {
    await fetch(`http://127.0.0.1:${PORT}/api/stop`, { method: 'POST', body: '{}' }).catch(() => {})
    try { process.kill(daemon.pid!, 'SIGTERM') } catch { /* ignore */ }
    await sleep(600)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(process.exitCode ?? 0)
  }
}

await main()
