import { backlightFixture } from './backlight-fixture.ts'
/**
 * Minimal isolated experiment: how does Chrome for Testing 153 expose a target
 * created with `Target.createTarget({ background: true, hidden: true })`?
 *
 * Needed for the U3 fix: the daemon must be able to (a) observe its own hidden
 * capture page for liveness and (b) keep the hidden target out of the tab strip.
 * Run: node tests/probe-hidden-target.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cdp, fetchVersion } from '../src/cdp.ts'
import { findFreePort } from '../src/ports.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-hid-'))
const binary = backlightFixture(tmp)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const port = await findFreePort()

const child = spawn(binary, [
  `--user-data-dir=${tmp}/profile`,
  `--remote-debugging-port=${port}`,
  '--no-first-run', '--no-default-browser-check',
], { stdio: 'ignore' })

const summarize = (infos: any[]) => infos
  .map(t => `${String(t.targetId).slice(0, 8)} type=${t.type} attached=${t.attached} url=${String(t.url).split(':')[0]}:${String(t.url).includes('/capture') ? 'capture' : String(t.url).includes('data:') ? 'data' : 'page'}`)
  .join('\n  ')

try {
  let version: any = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { version = await fetchVersion(port, 1500); break } catch { await sleep(300) }
  }
  if (!version) throw new Error('no debug endpoint')
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const pageUrl = 'data:text/html,<title>probe-hidden</title><body>probe'

  // a normal window/page first, so the hidden target has a window to live in
  const normal = await cdp.send<{ targetId: string }>('Target.createTarget', { url: pageUrl })
  await sleep(800)
  console.log('after normal page:')
  console.log('  ' + summarize((await cdp.send<{ targetInfos: any[] }>('Target.getTargets')).targetInfos))

  const hidden = await cdp.send<{ targetId: string }>('Target.createTarget', { url: pageUrl, background: true, hidden: true })
  await sleep(800)
  const afterCreate = (await cdp.send<{ targetInfos: any[] }>('Target.getTargets')).targetInfos
  console.log(`after hidden create (targetId=${hidden.targetId.slice(0, 8)}):`)
  console.log('  ' + summarize(afterCreate))
  console.log(`hidden targetId present in getTargets: ${afterCreate.some(t => t.targetId === hidden.targetId)}`)
  const info = await cdp.send<any>('Target.getTargetInfo', { targetId: hidden.targetId })
  console.log(`getTargetInfo(hidden): type=${info.targetInfo?.type} attached=${info.targetInfo?.attached} url-scheme=${String(info.targetInfo?.url).split(':')[0]}`)
  const attached = await cdp.attach(hidden.targetId)
  console.log(`attach(hidden): session=${attached.slice(0, 8)}`)
  const evalRes = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, attached)
  console.log(`eval in hidden target: title=${evalRes.result?.value}`)
  const afterAttach = (await cdp.send<{ targetInfos: any[] }>('Target.getTargets')).targetInfos
  console.log(`after attach, hidden targetId present: ${afterAttach.some(t => t.targetId === hidden.targetId)} type=${afterAttach.find(t => t.targetId === hidden.targetId)?.type}`)
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: normal.targetId })
  const state = async (label: string) => {
    const infos = (await cdp.send<{ targetInfos: any[] }>('Target.getTargets')).targetInfos
    const found = infos.find(t => t.targetId === hidden.targetId)
    let evalTitle = 'n/a'
    try { evalTitle = String((await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, attached)).result?.value) } catch (e) { evalTitle = `err:${(e as Error).message.slice(0, 40)}` }
    console.log(`${label}: hidden-listed=${!!found}${found ? ` type=${found.type}` : ''} eval=${evalTitle}`)
  }
  await state('visible/normal')
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  await sleep(700)
  await state('cdp-minimized (app still visible)')
  const { hideBrowser, browserAppState } = await import('../src/native.ts')
  if (child.pid) await hideBrowser(child.pid)
  await state('minimized + app hidden')
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await sleep(700)
  await state('restored normal (app still hidden)')
  const { unhideBrowser } = await import('../src/native.ts')
  if (child.pid) await unhideBrowser(child.pid)
  await state('unhidden (fully visible)')

  const closed = await cdp.send<{ success?: boolean }>('Target.closeTarget', { targetId: hidden.targetId }).catch((e: Error) => ({ error: e.message }))
  console.log(`closeTarget(hidden): ${JSON.stringify(closed)}`)
  await sleep(500)
  console.log(`normal target still present: ${(await cdp.send<{ targetInfos: any[] }>('Target.getTargets')).targetInfos.some(t => t.targetId === normal.targetId)}`)
} catch (err) {
  console.error('FAIL', err)
  process.exitCode = 1
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}
