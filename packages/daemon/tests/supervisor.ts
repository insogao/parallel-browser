/**
 * M1 supervisor e2e (frame pump): window visible ~2s at start for the
 * baseline, then stays minimized for everything else (exactly what a user
 * does). Verifies: collapse action, pump engagement, rAF kept alive while
 * minimized, restore, pump stop, and background-tab pumping.
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
  let raf = 0; window.__t = 0;
  const step = () => { raf++; requestAnimationFrame(step) };
  requestAnimationFrame(step);
  setInterval(() => window.__t++, 100);
  window.__raf = () => raf; window.__timer = () => window.__t;
</script></body></html>`)}`

async function apiGet(pathname: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(3000) })
  return res.json()
}
async function apiPost(pathname: string, body: unknown): Promise<any> {
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

async function main() {
  const daemon = spawn(process.execPath, [path.resolve('src/index.ts')], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, BACKLIGHT_HOME: TMP, BACKLIGHT_PORT: String(PORT), BACKLIGHT_VERBOSE: '1' },
  })
  daemon.unref()
  try {
    await waitApi(10_000)
    const launched = await apiPost('/api/launch', { url: PAGE_HTML('tab1') })
    if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)

    const version = await fetchVersion(launched.upstreamPort)
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    const findTab = async (title: string) => {
      const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
      return targetInfos.find(t => t.type === 'page' && t.title === title)!
    }
    const sess = async (targetId: string) => {
      const sessionId = await cdp.attach(targetId)
      await cdp.send('Page.enable', {}, sessionId)
      return sessionId
    }
    const raf = async (sessionId: string) =>
      (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__raf()', returnByValue: true }, sessionId)).result.value

    const tab1 = await findTab('tab1')
    const s1 = await sess(tab1.targetId)

    // visible baseline (2s on screen)
    await sleep(500)
    const r0 = await raf(s1)
    await sleep(2000)
    const r1 = await raf(s1)
    const baseline = (r1 - r0) / 2
    console.log(`baseline rAF/s (visible): ${baseline.toFixed(1)}`)

    // collapse to background (native minimize; pump keeps speed)
    await apiPost('/api/bg', {})
    const t0 = Date.now()
    let pumping = false
    while (Date.now() - t0 < 5000) {
      await sleep(300)
      const w = await apiGet('/api/windows')
      if ((w.pumping ?? 0) > 0) { pumping = true; break }
    }
    const reactMs = Date.now() - t0
    console.log(`collapse done; pump engaged in ~${reactMs}ms (engaged=${pumping}); window now minimized`)

    // rAF must keep running while minimized (8s measurement)
    const p0 = await raf(s1)
    await sleep(8000)
    const p1 = await raf(s1)
    const bgRate = (p1 - p0) / 8
    const ratio = bgRate / baseline
    const health = await apiGet('/api/health')
    const target = (health.targets ?? []).find((t: any) => t.targetId === tab1.targetId)
    console.log(`minimized rAF/s: ${bgRate.toFixed(1)}  ratio ${(ratio * 100).toFixed(0)}%  visibility=${target?.visibility}`)

    // background-tab case: open tab2 (active), tab1 becomes hidden background tab
    await cdp.send('Target.createTarget', { url: PAGE_HTML('tab2') })
    await sleep(1500)
    let pumpingBg = false
    const t1 = Date.now()
    while (Date.now() - t1 < 5000) {
      await sleep(300)
      const w = await apiGet('/api/windows')
      if ((w.pumping ?? 0) >= 1) { pumpingBg = w.pumping >= 1; if (pumpingBg) break }
    }
    const b0 = await raf(s1)
    await sleep(5000)
    const b1 = await raf(s1)
    const bgTabRate = (b1 - b0) / 5
    console.log(`background-tab rAF/s (pumped): ${bgTabRate.toFixed(1)} (${pumpingBg ? 'pump on' : 'pump OFF'})`)

    // restore: windows come back normal; tab1 is still a BACKGROUND tab, so by
    // design its pump keeps running — pumping targets must equal hidden targets
    await apiPost('/api/restore', {})
    await sleep(1000)
    const w2 = await apiGet('/api/windows')
    const allNormal = (w2.windows ?? []).every((x: any) => x.state === 'normal')
    const health2 = await apiGet('/api/health')
    const hiddenCount = (health2.targets ?? []).filter((t: any) => t.visibility !== 'visible').length
    const tab2Health = (health2.targets ?? []).find((t: any) => t.title === 'tab2')
    const pumpsMatchHidden = (w2.pumping ?? 0) === hiddenCount && (tab2Health?.visibility ?? 'hidden') === 'visible'
    console.log(`restored: allNormal=${allNormal} pumping=${w2.pumping} hiddenTargets=${hiddenCount} tab2Visible=${tab2Health?.visibility}`)

    const pass = pumping && reactMs <= 5000 && ratio >= 0.4 && bgTabRate >= baseline * 0.4 && allNormal && pumpsMatchHidden
    console.log(`\n${pass ? 'PASS' : 'FAIL'} supervisor e2e (frame pump)`)
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
