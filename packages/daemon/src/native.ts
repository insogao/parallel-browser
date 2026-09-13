import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './paths.ts'

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

export async function hideBrowser(pid: number): Promise<void> {
  if (pid <= 0) throw new Error('managed browser PID is unavailable')
  await run(await nativeControl(), ['hide', String(pid)])
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
