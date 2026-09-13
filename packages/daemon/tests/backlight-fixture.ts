import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Test the installed Backlight build, with separate application/profile paths
 * so the user's tray cannot redirect test activation into their live session. */
export function backlightFixture(home: string): string {
  const source = path.join(os.homedir(), 'Library/Application Support/Backlight/apps/Backlight.app')
  const read = (app: string, key: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  if (read(source, 'CFBundleIdentifier') !== 'dev.backlight.browser' || read(source, 'CFBundleName') !== 'Backlight') {
    throw new Error('Acceptance tests require installed branded Backlight.app; no Chrome fallback is allowed')
  }
  const app = path.join(home, 'apps/Backlight.app')
  fs.mkdirSync(path.dirname(app), { recursive: true })
  execFileSync('/bin/cp', ['-cR', source, app])
  const relative = path.join('Contents/MacOS', read(source, 'CFBundleExecutable'))
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const binary = path.join(app, relative)
  if (digest(binary) !== digest(path.join(source, relative))) throw new Error('Backlight executable mismatch')
  const iconName = read(source, 'CFBundleIconFile')
  const icon = path.join('Contents/Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`)
  if (digest(path.join(app, icon)) !== digest(path.join(source, icon))) throw new Error('Backlight icon mismatch')
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ browser: binary }))
  console.log(`[Backlight acceptance] source=${source}; binary=${binary}; sha256=${digest(binary)}`)
  return binary
}
