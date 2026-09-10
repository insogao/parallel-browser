import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { paths } from './paths.ts'
import { log } from './log.ts'

const CHROME_CANDIDATES = [
  { dir: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'), label: 'Google Chrome' },
  { dir: path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'), label: 'Chromium' },
]

export interface ChromeProfileInfo {
  /** profile directory name, e.g. "Default" or "Profile 1" */
  dir: string
  name: string
  email?: string
}

/** Scan one browser data dir for profiles (reads Local State). */
export function scanBrowserDir(dir: string, label: string): Array<ChromeProfileInfo & { browser: string; baseDir: string }> {
  const out: Array<ChromeProfileInfo & { browser: string; baseDir: string }> = []
  const localStatePath = path.join(dir, 'Local State')
  if (!fs.existsSync(localStatePath)) return out
  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
    const infoCache = localState?.profile?.info_cache ?? {}
    for (const [pdir, info] of Object.entries(infoCache) as Array<[string, any]>) {
      out.push({
        browser: label,
        baseDir: dir,
        dir: pdir,
        name: String(info.name ?? pdir),
        email: info.user_name ? String(info.user_name) : undefined,
      })
    }
    if (Object.keys(infoCache).length === 0 && fs.existsSync(path.join(dir, 'Default'))) {
      out.push({ browser: label, baseDir: dir, dir: 'Default', name: 'Default' })
    }
  } catch { /* unreadable Local State */ }
  return out
}

/** List importable profiles from installed Chromium browsers (via Local State). */
export function listChromeProfiles(): Array<ChromeProfileInfo & { browser: string; baseDir: string }> {
  const out: Array<ChromeProfileInfo & { browser: string; baseDir: string }> = []
  for (const cand of CHROME_CANDIDATES) {
    if (!fs.existsSync(path.join(cand.dir, 'Local State'))) continue
    out.push(...scanBrowserDir(cand.dir, cand.label))
  }
  return out
}

const IMPORT_FILES = [
  // cookies (Chrome ≥96 keeps them under Network/)
  'Network/Cookies',
  'Network/Cookies-journal',
  'Cookies',
  'Cookies-journal',
  // saved passwords
  'Login Data',
  'Login Data-journal',
  // autofill
  'Web Data',
  'Web Data-journal',
]

/**
 * Copy login-state files from a source Chrome profile into a Backlight space
 * profile (file-level copy). On macOS Chromium encrypts cookies with a
 * Keychain key scoped to the APPLICATION, so copying works 1:1 when the space
 * runs the same browser binary (Google Chrome → Google Chrome). Running the
 * space with Chrome for Testing will prompt once for Keychain access.
 *
 * The Backlight browser must be stopped while importing (we hold the file
 * handles otherwise).
 */
export function importProfile(sourceBrowserDir: string, sourceProfileDir: string, space: string): string[] {
  const src = path.join(sourceBrowserDir, sourceProfileDir)
  if (!fs.existsSync(src)) throw new Error(`source profile not found: ${src}`)
  const dest = path.join(paths.spaceDir(space), 'profile', 'Default')
  fs.mkdirSync(dest, { recursive: true })

  const copied: string[] = []
  for (const rel of IMPORT_FILES) {
    const from = path.join(src, rel)
    if (!fs.existsSync(from)) continue
    const to = path.join(dest, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    copied.push(rel)
  }
  if (copied.length === 0) throw new Error('nothing to import: no Cookies / Login Data / Web Data found in source profile')
  log(`imported ${copied.length} file(s) from ${src} into space "${space}"`)
  return copied
}
