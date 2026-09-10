import fs from 'node:fs'
import { paths } from './paths.ts'

export interface Settings {
  /** public port: CDP proxy + HTTP API + dashboard, bound to 127.0.0.1 */
  proxyPort: number
  /** active space name (each space = one managed Chromium profile) */
  space: string
  /** frame-pump hidden pages so they keep rendering (rAF) at full speed */
  backgroundMode: boolean
  /** pump rate (captures per second) per hidden page */
  pumpFps: number
  /** in-page halo pulse when an AI command touches the page */
  halo: boolean
  /** pass --disable-extensions-except when loading dev extensions */
  soloExtensions: boolean
  /** 'auto' or an absolute browser binary path */
  browser: string
}

export const defaultSettings: Settings = {
  proxyPort: Number(process.env.BACKLIGHT_PORT ?? 9333),
  space: 'default',
  backgroundMode: true,
  pumpFps: 10,
  halo: true,
  soloExtensions: false,
  browser: 'auto',
}

let cache: Settings | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  let stored: Partial<Settings> = {}
  try { stored = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) } catch { /* defaults */ }
  cache = { ...defaultSettings, ...stored }
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const s = { ...loadSettings(), ...patch }
  fs.mkdirSync(paths.root, { recursive: true })
  fs.writeFileSync(paths.settingsFile, JSON.stringify(s, null, 2) + '\n')
  cache = s
  return s
}

export function invalidateSettings() { cache = null }
