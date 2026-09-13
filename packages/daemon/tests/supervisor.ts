import { backlightFixture } from './backlight-fixture.ts'
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
backlightFixture(TMP)
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

    // 1. collapse (native minimize by default) → capture keep-alive engages →
    //    NATIVE full speed while invisible
    await apiPost('/api/bg', {})
    const t0 = Date.now()
    let minimized = false
    while (Date.now() - t0 < 5000) {
      await sleep(300)
      const w = await apiGet('/api/windows')
      const win = (w.windows ?? []).find((x: any) => x.windowId === windowId)
      if (win?.state === 'minimized') { minimized = true; break }
    }
    // capture keep-alive: daemon engages on the hidden target (status.captureTargetId)
    let captured = false
    const t1 = Date.now()
    while (Date.now() - t1 < 20000) {
      await sleep(500)
      const s = await apiGet('/api/status')
      if (s.browser?.captureTargetId === tab1.targetId) { captured = true; break }
    }
    const b0 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__native()', returnByValue: true }, sessionId)).result.value
    await sleep(4000)
    const b1 = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__native()', returnByValue: true }, sessionId)).result.value
    const hiddenRate = (b1 - b0) / 4
    const hiddenRatio = hiddenRate / baseline
    const health = await apiGet('/api/health')
    const t1h = (health.targets ?? []).find((t: any) => t.targetId === tab1.targetId)
    console.log(`collapsed: minimized=${minimized} captured=${captured} native rAF/s=${hiddenRate.toFixed(1)} ratio=${(hiddenRatio * 100).toFixed(0)}% visibility=${t1h?.visibility}`)

    // screenshot must be fresh and fast while minimized+captured
    const st0 = Date.now()
    const shot = await Promise.race([
      cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 20 }, sessionId),
      new Promise<'HANG'>(r => setTimeout(() => r('HANG' as any), 8000)),
    ])
    const shotMs = Date.now() - st0
    const shotOk = typeof shot === 'object' && (shot as any).data?.length > 5000 && shotMs < 3000
    console.log(`minimized screenshot: ${typeof shot === 'string' ? shot : `${(shot as any).data.length} bytes in ${shotMs}ms`}`)

    // 2. restore: native un-minimize (same as dock-click)
    await apiPost('/api/restore', {})
    await sleep(800)
    const w3 = await apiGet('/api/windows')
    const win3 = (w3.windows ?? []).find((x: any) => x.windowId === windowId)
    const restored = win3 != null && win3.state === 'normal'
    console.log(`restore: ${restored}`)

    const pass = minimized && captured && hiddenRatio >= 0.75 && shotOk && restored
    // note: DOM visibilityState may read 'hidden' while captured — known cosmetic
    // gap; native frames + real screenshots are the actual contract
    console.log(`\n${pass ? 'PASS' : 'FAIL'} supervisor e2e (minimize + capture keep-alive)`)
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
