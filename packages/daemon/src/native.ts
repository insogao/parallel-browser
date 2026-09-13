import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './paths.ts'
import { debug } from './log.ts'

const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(command, args, { timeout: 60_000 }, (err, _out, stderr) => err ? reject(new Error(stderr || err.message)) : resolve())
})
let build: Promise<string> | undefined
export async function nativeControl(): Promise<string> {
  if (!build) build = (async () => {
    const source = fileURLToPath(new URL('../../../tools/app-control.swift', import.meta.url))
    const binary = path.join(paths.root, 'bin', 'app-control')
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    if (!fs.existsSync(binary) || fs.statSync(binary).mtimeMs < fs.statSync(source).mtimeMs) {
      await run('/usr/bin/swiftc', [source, '-o', binary])
    }
    return binary
  })().catch(err => { build = undefined; throw err })
  return build
}

export async function activateBrowser(pid: number): Promise<void> {
  if (pid <= 0) throw new Error('managed browser PID is unavailable')
  await run(await nativeControl(), ['activate', String(pid)])
}

const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

/** NSRunningApplication state, used to pick the reliable minimize sequence. */
export async function browserAppState(pid: number): Promise<{ active: boolean; hidden: boolean }> {
  if (pid <= 0) throw new Error('managed browser PID is unavailable')
  return appStateVia(await nativeControl(), pid)
}

function appStateVia(binary: string, pid: number): Promise<{ active: boolean; hidden: boolean }> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['state', String(pid)], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`unexpected app state output: ${stdout.trim()}`)) }
    })
  })
}

/**
 * AppKit applies hide/unhide asynchronously and the helper process cannot
 * observe the transition (no run loop). Issue the request, then verify from a
 * fresh process with a bounded retry so callers can rely on the final state.
 */
export async function hideBrowser(pid: number): Promise<void> {
  if (pid <= 0) throw new Error('managed browser PID is unavailable')
  const binary = await nativeControl()
  for (let attempt = 0; attempt < 8; attempt++) {
    await run(binary, ['hide', String(pid)])
    if ((await appStateVia(binary, pid)).hidden) return
    await sleepMs(100)
  }
  debug(`hideBrowser pid=${pid} did not hide`)
  throw new Error(`managed browser ${pid} did not hide`)
}

/** Unhide without activating/focusing (ordered after any in-flight hide). */
export async function unhideBrowser(pid: number): Promise<void> {
  if (pid <= 0) throw new Error('managed browser PID is unavailable')
  const binary = await nativeControl()
  for (let attempt = 0; attempt < 8; attempt++) {
    await run(binary, ['unhide', String(pid)])
    if (!(await appStateVia(binary, pid)).hidden) return
    await sleepMs(100)
  }
  debug(`unhideBrowser pid=${pid} did not unhide`)
  throw new Error(`managed browser ${pid} did not unhide`)
}

export async function startTray(): Promise<void> {
  // Isolated tests/development daemons do not install a desktop-wide observer.
  if (process.env.BACKLIGHT_TRAY === '0' || (process.env.BACKLIGHT_HOME && process.env.BACKLIGHT_TRAY !== '1')) return
  const source = fileURLToPath(new URL('../../tray/main.swift', import.meta.url))
  const app = path.join(path.dirname(source), 'build', 'Backlight Tray.app')
  const binary = path.join(app, 'Contents', 'MacOS', 'Backlight Tray')
  if (!fs.existsSync(binary) || fs.statSync(binary).mtimeMs < fs.statSync(source).mtimeMs) {
    await run('/bin/bash', [path.join(path.dirname(source), 'build.sh')])
  }
  await run('/usr/bin/open', ['-g', '-a', app])
}
