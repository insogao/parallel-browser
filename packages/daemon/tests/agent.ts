import { backlightFixture } from './backlight-fixture.ts'
/**
 * M3 agent-channel e2e: an AI tool connects through the CDP PROXY (port 9333
 * path), drives the page, and the daemon must:
 *   1. stay transparent (everything works as if connected directly)
 *   2. emit activity events (method + targetId) on /api/activity
 *   3. fire the in-page halo (window.__backlightPulse invoked)
 *
 * Run: node tests/agent.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cdp } from '../src/cdp.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backlight-agent-'))
backlightFixture(TMP)
const PORT = 9439
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// A lost response must fail this test instead of hanging it forever. Long
// legitimate operations (screenshots) still get a generous bound.
const CDP_TIMEOUT = 15_000
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CDP timeout after ${CDP_TIMEOUT}ms: ${label}`)), CDP_TIMEOUT)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const send = <T = any>(cdp: Cdp, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
  bounded(cdp.send<T>(method, params, sessionId), method)

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>BL Agent</title></head>
<body style="font:40px monospace;background:#101418;color:#39d98a">
<button id="b" onclick="this.textContent='clicked'">button</button>
<script>window.__backlightPulse = window.__backlightPulse</script>
</body></html>`)}`

async function apiGet(pathname: string): Promise<any> {
  return fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())
}
async function apiPost(pathname: string, body: unknown): Promise<any> {
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

async function main() {
  const daemon = spawn(process.execPath, [path.resolve('src/index.ts')], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, BACKLIGHT_HOME: TMP, BACKLIGHT_PORT: String(PORT), BACKLIGHT_VERBOSE: '1' },
  })
  daemon.unref()
  try {
    await waitApi(10_000)
    // settings proxyPort must equal PORT for the proxy under test
    await apiPost('/api/settings', { proxyPort: PORT })
    // Visible window: the proxy is under test here, and Page.captureScreenshot
    // needs a compositor frame. Cornered background windows produce no frames,
    // so background capture is covered by spike's capture keep-alive scenario.
    const launched = await apiPost('/api/launch', { url: PAGE, keepVisible: true })
    if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)

    // ---- the AI tool connects THROUGH THE PROXY ----
    const meta: any = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json())
    if (!meta.webSocketDebuggerUrl.includes(`:${PORT}/`)) {
      throw new Error(`proxy did not rewrite webSocketDebuggerUrl: ${meta.webSocketDebuggerUrl}`)
    }
    console.log(`proxy rewrite ok: ${meta.webSocketDebuggerUrl}`)
    const cdp = await Cdp.connect(meta.webSocketDebuggerUrl)

    let page: any
    const pageDeadline = Date.now() + 10_000
    while (!page && Date.now() < pageDeadline) {
      const { targetInfos } = await send<{ targetInfos: any[] }>(cdp, 'Target.getTargets')
      page = targetInfos.find((t: any) => t.type === 'page' && (t.title === 'BL Agent' || t.url.startsWith('data:text/html')))
      if (!page) await sleep(200)
    }
    if (!page) throw new Error('agent page target did not appear')
    const sessionId = await bounded(cdp.attach(page.targetId), 'Target.attachToTarget')
    await send(cdp, 'Page.enable', {}, sessionId)

    // instrument the halo so we can count pulses (proxy calls it via the daemon session)
    await send(cdp, 'Runtime.evaluate', {
      expression: `(() => { const orig = window.__backlightPulse; window.__pulses = 0;
        window.__backlightPulse = () => { window.__pulses++; orig && orig() } })()`,
    }, sessionId)

    // give the health monitor a moment to bootstrap halo in this page
    await sleep(2500)

    // ---- AI does things through the proxy ----
    const evalRes = await send<{ result: { value: any } }>(cdp, 'Runtime.evaluate', {
      expression: 'document.getElementById("b").textContent', returnByValue: true,
    }, sessionId)
    const click = { type: 'mousePressed', x: 30, y: 30, button: 'left', clickCount: 1 } as const
    await send(cdp, 'Input.dispatchMouseEvent', click, sessionId)
    await send(cdp, 'Input.dispatchMouseEvent', { ...click, type: 'mouseReleased' }, sessionId)
    const afterClick = await send<{ result: { value: any } }>(cdp, 'Runtime.evaluate', {
      expression: 'document.getElementById("b").textContent', returnByValue: true,
    }, sessionId)

    // transparency: captureScreenshot + navigation event stream work
    const shot = await send<{ data: string }>(cdp, 'Page.captureScreenshot', { format: 'png' }, sessionId)
    console.log(`through proxy: evaluate="${evalRes.result.value}" afterClick="${afterClick.result.value}" shotBytes=${shot.data?.length ?? 0}`)
    await sleep(1200)

    // ---- activity events recorded? ----
    const activity = await apiGet('/api/activity?limit=50')
    const evs = (activity.events ?? []).filter((e: any) => e.kind === 'ai-command')
    const methods = new Set(evs.map((e: any) => e.method))
    const hasEval = methods.has('Runtime.evaluate')
    const hasInput = methods.has('Input.dispatchMouseEvent')
    const attributed = evs.filter((e: any) => e.targetId === page.targetId).length
    console.log(`activity: ${evs.length} ai-command events, evaluate=${hasEval}, input=${hasInput}, attributedToPage=${attributed}`)

    // ---- halo fired? ----
    const pulses = await send<{ result: { value: number } }>(cdp, 'Runtime.evaluate', {
      expression: 'window.__pulses ?? -1', returnByValue: true,
    }, sessionId).then(r => r.result.value)
    console.log(`halo pulses observed in page: ${pulses}`)

    const pass = evalRes.result.value === 'button'
      && afterClick.result.value === 'clicked'
      && (shot.data?.length ?? 0) > 1000
      && hasEval && hasInput && attributed > 0
      && pulses > 0
    console.log(`\n${pass ? 'PASS' : 'FAIL'} agent channel e2e`)
    process.exitCode = pass ? 0 : 1
  } catch (err) {
    console.error('\nAGENT TEST ERROR:', err instanceof Error ? err.stack : err)
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
