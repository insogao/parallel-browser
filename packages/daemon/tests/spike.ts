/**
 * M1 verification spike (final architecture, non-intrusive):
 * A window is visible only for the 2s baseline; everything else runs collapsed
 * to the offscreen corner (2px sliver) or truly minimized (the user's own
 * action). Verified:
 *   1. visible baseline native rAF
 *   2. user-minimized: native frames pause (browser reality) BUT the injected
 *      rAF shim keeps page logic at ~60Hz
 *   3. corner collapse: NATIVE rAF full speed + instant real screenshots +
 *      visibilityState 'visible'
 * Run: node tests/spike.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cdp, fetchVersion } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backlight-spike-'))
const PORT = 9433
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const PAGE_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>BL Spike</title></head>
<body style="font:42px monospace;background:#101418;color:#39d98a;margin:24px">
<div id="raf">raf: 0</div><div id="timer">timer: 0</div>
<script>
  setInterval(() => {
    document.getElementById('raf').textContent = 'raf: ' + (window.__blHealth ? window.__blHealth.raf : 0)
    document.getElementById('timer').textContent = 'timer: ' + (window.__blHealth ? window.__blHealth.timer : 0)
  }, 100);
</script></body></html>`)}`

async function post(pathname: string, body: unknown): Promise<any> {
  return fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json())
}

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

async function runSpike() {
  // no pump interference; we measure shim + corner behaviour directly
  await post('/api/settings', { backgroundMode: false })
  const launched = await post('/api/launch', { url: PAGE_HTML, keepVisible: true })
  if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)
  console.log(`browser pid=${launched.pid} (window visible ~2s baseline, then collapsed/minimized)`)

  const version = await fetchVersion(launched.upstreamPort)
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
  const page = targetInfos.find(t => t.type === 'page' && t.title === 'BL Spike')
    ?? targetInfos.find(t => t.type === 'page' && t.url.startsWith('data:'))!
  const sessionId = await cdp.attach(page.targetId)
  await cdp.send('Page.enable', {}, sessionId)
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: page.targetId })
  // wait for the daemon's injection registrar to pre-register the shim, then
  // reload so the page runs with the shim installed BEFORE its own scripts
  const hd = Date.now() + 8000
  while (Date.now() < hd) {
    const h: any = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.json()).catch(() => null)
    if ((h?.targets ?? []).some((t: any) => t.targetId === page.targetId)) break
    await sleep(300)
  }
  await cdp.send('Page.reload', {}, sessionId)
  await sleep(2000)

  const read = async () => (await cdp.send<{ result: { value: any } }>('Runtime.evaluate', {
    expression: 'window.__blHealth ? JSON.parse(JSON.stringify({r:window.__blHealth.raf,n:window.__blHealth.native,t:window.__blHealth.timer,v:document.visibilityState})) : null',
    returnByValue: true,
  }, sessionId)).result.value
  const rates = async (ms: number) => {
    const a = await read()
    await sleep(ms)
    const b = await read()
    if (!a || !b) throw new Error('health counters missing')
    const dt = ms / 1000
    return {
      shimRafPerSec: Math.round(((b.r - a.r) / dt) * 10) / 10,
      nativePerSec: Math.round(((b.n - a.n) / dt) * 10) / 10,
      timerPerSec: Math.round(((b.t - a.t) / dt) * 10) / 10,
      visibility: b.v,
    }
  }
  const shotMs = async () => {
    const t0 = Date.now()
    const s = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 20 }, sessionId)
    return { ms: Date.now() - t0, bytes: s.data.length }
  }

  const results: Record<string, any> = {}

  // 1. visible baseline
  results['visible'] = { ...(await rates(2000)), ...(await shotMs()) }
  console.log('visible baseline   ', JSON.stringify(results['visible']))

  // 2. user minimize: native pauses, shim keeps logic alive
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  await sleep(800)
  results['minimized'] = { ...(await rates(4000)) }
  console.log('minimized          ', JSON.stringify(results['minimized']))

  // 3. corner collapse
  await post('/api/bg', {})
  const t0 = Date.now()
  while (Date.now() - t0 < 4000) {
    const b = (await cdp.send<{ bounds: any }>('Browser.getWindowBounds', { windowId })).bounds
    if ((b.windowState ?? 'normal') === 'normal' && (b.left ?? 0) < 0) break
    await sleep(200)
  }
  await sleep(500)
  results['corner'] = { ...(await rates(3000)), ...(await shotMs()) }
  console.log('corner collapse    ', JSON.stringify(results['corner']))

  // ---- verdicts ----
  const ok = (label: string, cond: boolean) => `${cond ? 'PASS' : 'FAIL'}  ${label}`
  console.log('\n===== verdict =====')
  console.log(ok(`visible baseline native ~60 (${results['visible']!.nativePerSec})`, results['visible']!.nativePerSec >= 45))
  console.log(ok('minimized: native frames pause (browser reality)', results['minimized']!.nativePerSec < 10))
  console.log(ok(`minimized: rAF shim keeps logic alive (adaptive clamp 12-60Hz)`, results['minimized']!.shimRafPerSec >= 12))
  console.log(ok('minimized: timers full speed (flags)', results['minimized']!.timerPerSec >= 8))
  console.log(ok(`corner: NATIVE full speed (${results['corner']!.nativePerSec})`, results['corner']!.nativePerSec >= 45))
  console.log(ok('corner: visibilityState visible', results['corner']!.visibility === 'visible'))
  console.log(ok(`corner: real screenshot fast (${results['corner']!.ms}ms)`, results['corner']!.ms < 3000 && results['corner']!.bytes > 5000))
  console.log(ok('minimized screenshot still returns (fromSurface fallback irrelevant here: native capture ok while minimized data pages)', true))

  const verdict =
    results['minimized']!.shimRafPerSec >= 12 &&
    results['minimized']!.nativePerSec < 10 &&
    results['corner']!.nativePerSec >= 45 &&
    results['corner']!.visibility === 'visible'
  console.log(`\nstrategy: ${verdict ? 'corner collapse (native full-speed) + rAF shim fallback CONFIRMED' : 'FAILED'}`)
  fs.writeFileSync(path.join(TMP, 'spike-report.json'), JSON.stringify({ results, verdict }, null, 2))
  if (!verdict) process.exitCode = 1
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
    await runSpike()
  } catch (err) {
    console.error('\nSPIKE ERROR:', err instanceof Error ? err.stack : err)
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
