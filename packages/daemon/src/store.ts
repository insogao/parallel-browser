import fs from 'node:fs'
import { paths } from './paths.ts'

export interface Settings {
  /** public port: CDP proxy + HTTP API + dashboard, bound to 127.0.0.1 */
  proxyPort: number
  /** active space name (each space = one managed Chromium profile) */
  space: string
  /** frame-pump hidden pages so they keep rendering (rAF) at full speed */
  backgroundMode: boolean
  /** tab-capture keep-alive: captured tabs report visible (native 60fps) even minimized */
  captureKeepAlive: boolean
  /** pump rate (captures per second) per hidden page */
  pumpFps: number
  /** in-page halo pulse when an AI command touches the page */
  halo: boolean
  /** pass --disable-extensions-except when loading dev extensions */
  soloExtensions: boolean
  /** 'auto' or an absolute browser binary path */
  browser: string
  /**
   * 'background' (default): launch without stealing focus; the first window is
   * born at the offscreen corner (2px sliver) so pages run at native full speed.
   * 'visible': launch focused/on screen like a normal browser.
   */
  launchMode: 'background' | 'visible'
  /**
   * How "collapse to background" behaves:
   * 'minimize' (default) — native minimize: fully invisible, dock-click
   *   restores natively, capture keep-alive keeps pages at native 60fps
   * 'corner'   — window parks at the offscreen corner (2px sliver, full speed)
   *   fallback for when capture keep-alive is unavailable
   */
  collapseMode: 'corner' | 'minimize'
  /** cached display work area {availLeft, availTop, availHeight} for corner math */
  workArea: { al: number; at: number; ah: number }
}

export const defaultSettings: Settings = {
  proxyPort: Number(process.env.BACKLIGHT_PORT ?? 9333),
  space: 'default',
  backgroundMode: true,
  captureKeepAlive: true,
  pumpFps: 10,
  halo: true,
  soloExtensions: false,
  browser: 'auto',
  launchMode: 'background',
  collapseMode: 'minimize',
  workArea: { al: 0, at: 25, ah: 922 },
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
