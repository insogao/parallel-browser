/**
 * M1 supervisor e2e (corner collapse): window visible ~2s for the baseline,
 * then /api/bg corners it (2px sliver, offscreen) — pages must render NATIVELY
 * at full speed. Also verifies the user-minimize scenario: rAF shim keeps page
 * logic alive and the frame pump produces real frames.
 *
 * Run: node tests/supervisor.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backlight-sup-'))
const PORT = 9434
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const PAGE_HTML = (title: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:42px monospace;background:#101418;color:#39d98a">
<div>${title}</div>
<script>
  window.__raf = () => window.__blHealth ? window.__blHealth.raf : 0
  window.__native = () => window.__blHealth ? window.__blHealth.native : 0
</script></body></html>`)}`

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
    const launched = await apiPost('/api/launch', { url: PAGE_HTML('tab1'), keepVisible: true })
    if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)

    const version = await fetchVersion(launched.upstreamPort)
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    const findTab = async (title: string) => {
      for (let i = 0; i < 20; i++) {
        const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
        const found = targetInfos.find(t => t.type === 'page' && t.title === title)
        if (found) return found
        await sleep(400)
      }
      throw new Error(`tab ${title} not found`)
    }
    const tab1 = await findTab('tab1')
    const sessionId = await cdp.attach(tab1.targetId)
    await cdp.send('Page.enable', {}, sessionId)
    const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: tab1.targetId })
    await sleep(1500) // let injection land

    // visible baseline
    const v0 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__native()', returnByValue: true }, sessionId)).result.value
    await sleep(2000)
    const v1 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__native()', returnByValue: true }, sessionId)).result.value
    const baseline = (v1 - v0) / 2
    console.log(`baseline native rAF/s (visible): ${baseline.toFixed(1)}`)

    // 1. corner collapse → native full speed
    const t0 = Date.now()
    await apiPost('/api/bg', {})
    let cornered = false
    while (Date.now() - t0 < 5000) {
      await sleep(300)
      const w = await apiGet('/api/windows')
      const win = (w.windows ?? []).find((x: any) => x.windowId === windowId)
      if (win?.cornered) { cornered = true; break }
    }
    const b0 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__native()', returnByValue: true }, sessionId)).result.value
    await sleep(4000)
    const b1 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__native()', returnByValue: true }, sessionId)).result.value
    const cornerRate = (b1 - b0) / 4
    const cornerRatio = cornerRate / baseline
    const health = await apiGet('/api/health')
    const t1h = (health.targets ?? []).find((t: any) => t.targetId === tab1.targetId)
    console.log(`cornered: cornered=${cornered} native rAF/s=${cornerRate.toFixed(1)} ratio=${(cornerRatio * 100).toFixed(0)}% visibility=${t1h?.visibility}`)

    // screenshot must be fresh and fast while cornered
    const st0 = Date.now()
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 20 }, sessionId)
    const shotMs = Date.now() - st0
    console.log(`cornered screenshot: ${shot.data.length} bytes in ${shotMs}ms`)

    // 2. user minimize → shim keeps logic alive + pump produces real frames
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    const t2 = Date.now()
    let pumping = false
    while (Date.now() - t2 < 5000) {
      await sleep(300)
      const w = await apiGet('/api/windows')
      if ((w.pumping ?? 0) > 0) { pumping = true; break }
    }
    const m0 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__raf()', returnByValue: true }, sessionId)).result.value
    await sleep(4000)
    const m1 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__raf()', returnByValue: true }, sessionId)).result.value
    const shimRate = (m1 - m0) / 4
    console.log(`minimized: pumping=${pumping} shimmed logic rAF/s=${shimRate.toFixed(1)}`)

    // 3. restore
    await apiPost('/api/restore', {})
    await sleep(800)
    const w3 = await apiGet('/api/windows')
    const win3 = (w3.windows ?? []).find((x: any) => x.windowId === windowId)
    const restored = win3 != null && !win3.cornered
    console.log(`restore: ${restored}`)

    const pass = cornered && cornerRatio >= 0.9 && shotMs < 3000 && pumping && shimRate >= 12 && restored
    console.log(`\n${pass ? 'PASS' : 'FAIL'} supervisor e2e (corner collapse)`)
    process.exitCode = pass ? 0 : 1
  } catch (err) {
    console.error('\nSUPERVISOR TEST ERROR:', err instanceof Error ? err.stack : err)
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
