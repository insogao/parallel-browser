import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = process.env.BACKLIGHT_HOME
  ?? path.join(os.homedir(), 'Library', 'Application Support', 'Backlight')

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
}

export const paths = {
  root,
  logs: path.join(root, 'logs'),
  spaces: path.join(root, 'spaces'),
  settingsFile: path.join(root, 'settings.json'),
  extensionsFile: path.join(root, 'extensions.json'),
  daemonFile: path.join(root, 'daemon.json'),
  // shared across spaces AND test runs: CfT downloads are ~150MB, never per-test
  browserCache: process.env.BACKLIGHT_BROWSER_CACHE
    ?? path.join(os.homedir(), 'Library', 'Caches', 'Backlight', 'browsers'),
  spaceDir(name: string) { return path.join(paths.spaces, sanitizeName(name)) },
}

export function ensureDirs() {
  for (const dir of [paths.root, paths.logs, paths.spaces]) fs.mkdirSync(dir, { recursive: true })
}
