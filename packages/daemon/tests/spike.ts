/**
 * M1 verification spike (frame-pump strategy, non-intrusive).
 *
 * The window is visible ONLY for the 2s visible-baseline at the start and
 * briefly at the end; everything else runs TRUE-MINIMIZED (native minimize,
 * which is exactly what the user does). Verified:
 *   1. visible baseline rAF
 *   2. true minimize with pump OFF  -> rAF pauses (the problem we solve)
 *   3. true minimize with pump ON   -> rAF restored to a large fraction of
 *      baseline and stable over a 10s soak; timers alive throughout
 *   4. restore                      -> pump stops, rAF normal
 *
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
<div id="raf">raf: 0</div><div id="timer">timer: 0</div><div id="now" style="color:#e6edf3"></div>
<script>
  let raf = 0, timer = 0;
  const step = () => { raf++; document.getElementById('raf').textContent = 'raf: ' + raf; requestAnimationFrame(step) };
  requestAnimationFrame(step);
  setInterval(() => { timer++; document.getElementById('timer').textContent = 'timer: ' + timer }, 100);
  setInterval(() => { document.getElementById('now').textContent = new Date().toISOString() }, 50);
</script></body></html>`)}`

async function post(pathname: string, body: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
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
  // pump off for the control phase
  await post('/api/settings', { backgroundMode: false })
  const launched = await post('/api/launch', { url: PAGE_HTML })
  if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)
  console.log(`browser pid=${launched.pid} (window visible ~2s for baseline, then stays minimized)`)

  const version = await fetchVersion(launched.upstreamPort)
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
  const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith('data:'))!
  const sessionId = await cdp.attach(page.targetId)
  await cdp.send('Page.enable', {}, sessionId)
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: page.targetId })

  await cdp.send('Runtime.evaluate', {
    expression: `(()=>{if(!window.__h){const h={raf:0};window.__h=h;const f=()=>{h.raf++;requestAnimationFrame(f)};requestAnimationFrame(f);window.__t=0;setInterval(()=>window.__t++,100)}})()`,
  }, sessionId)

  const counters = async () => {
    const r = await cdp.send<{ result: { value: any } }>(
      'Runtime.evaluate',
      { expression: '({raf: window.__h.raf, timer: window.__t, vis: document.visibilityState})', returnByValue: true },
      sessionId,
    )
    return r.result.value as { raf: number; timer: number; vis: string }
  }
  const rate = async (ms: number) => {
    const a = await counters()
    await sleep(ms)
    const b = await counters()
    const dt = ms / 1000
    return {
      rafPerSec: Math.round(((b.raf - a.raf) / dt) * 10) / 10,
      timerPerSec: Math.round(((b.timer - a.timer) / dt) * 10) / 10,
      visibility: b.vis,
    }
  }
  const minimize = (state: 'minimized' | 'normal') =>
    cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } })

  const results: Record<string, ReturnType<typeof rate> extends Promise<infer T> ? T : never> = {}

  // 1. visible baseline (2s on screen, that's all)
  await sleep(500)
  results['visible-baseline'] = await rate(2000)
  console.log('visible-baseline ', JSON.stringify(results['visible-baseline']))

  // 2. true minimize, pump OFF -> rAF pauses (control)
  await minimize('minimized')
  await sleep(600)
  results['min-no-pump'] = await rate(3000)
  console.log('min-no-pump      ', JSON.stringify(results['min-no-pump']), '(window now minimized; stays minimized rest of test)')

  // 3. pump ON -> rAF restored, 10s soak
  await post('/api/settings', { backgroundMode: true })
  const deadline = Date.now() + 5000
  let pumped = false
  while (Date.now() < deadline) {
    await sleep(300)
    const w: any = await fetch(`http://127.0.0.1:${PORT}/api/windows`).then(r => r.json())
    if ((w.pumping ?? 0) > 0) { pumped = true; break }
  }
  console.log(`pump engaged: ${pumped}`)
  await sleep(1000)
  results['min-pump-soak'] = await rate(10_000)
  console.log('min-pump-soak    ', JSON.stringify(results['min-pump-soak']))

  // 4. restore; pump should stop; rAF normal
  await post('/api/restore', {})
  await sleep(1000)
  results['restored'] = await rate(2000)
  const wAfter: any = await fetch(`http://127.0.0.1:${PORT}/api/windows`).then(r => r.json())
  console.log('restored         ', JSON.stringify(results['restored']), `pumping=${wAfter.pumping}`)

  // ---- verdicts ----
  const base = results['visible-baseline']!
  const ok = (label: string, cond: boolean) => `${cond ? 'PASS' : 'FAIL'}  ${label}`
  console.log('\n===== verdict =====')
  console.log(ok('control: minimize pauses rAF with pump off (the problem)', results['min-no-pump']!.rafPerSec < base.rafPerSec * 0.2))
  console.log(ok('control: timers alive while minimized (flags)', results['min-no-pump']!.timerPerSec >= base.timerPerSec * 0.8))
  console.log(ok(`pump restores rAF while minimized (${results['min-pump-soak']!.rafPerSec}/${base.rafPerSec})`, results['min-pump-soak']!.rafPerSec >= base.rafPerSec * 0.4))
  console.log(ok('pump keeps rAF stable over 10s soak', results['min-pump-soak']!.rafPerSec >= results['min-pump-soak']!.rafPerSec * 0.9))
  console.log(ok('pump stops after restore', (wAfter.pumping ?? 0) === 0))
  console.log(ok('restored rAF normal', results['restored']!.rafPerSec >= base.rafPerSec * 0.8))
  console.log(ok('restored visibility=visible', results['restored']!.visibility === 'visible'))

  const verdict =
    results['min-pump-soak']!.rafPerSec >= base.rafPerSec * 0.4 && results['min-no-pump']!.rafPerSec < base.rafPerSec * 0.2
  console.log(`\nstrategy: ${verdict ? 'frame pump CONFIRMED — minimized pages keep rendering' : 'frame pump FAILED'}`)
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
