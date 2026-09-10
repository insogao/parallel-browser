/**
 * Import feature test (fixture-based, no real Chrome needed):
 *   1. listChromeProfiles parses a fixture Local State
 *   2. importProfile copies cookies/login files into the space profile
 *
 * Run: node tests/import.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// BACKLIGHT_HOME must be set before importing modules that read paths
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-import-'))
process.env.BACKLIGHT_HOME = TMP

const { listChromeProfiles, importProfile, scanBrowserDir } = await import('../src/import.ts')
const { paths } = await import('../src/paths.ts')

let pass = true
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) pass = false
}

// ---- fixture: a fake Google Chrome data dir ----
const chromeDir = path.join(TMP, 'chrome-source')
const profDefault = path.join(chromeDir, 'Default')
const prof1 = path.join(chromeDir, 'Profile 1')
fs.mkdirSync(profDefault, { recursive: true })
fs.mkdirSync(prof1, { recursive: true })
fs.writeFileSync(path.join(chromeDir, 'Local State'), JSON.stringify({
  profile: {
    info_cache: {
      Default: { name: '个人' },
      'Profile 1': { name: '工作', user_name: 'me@example.com' },
    },
  },
}))
// Default has cookies, Profile 1 empty
fs.mkdirSync(path.join(profDefault, 'Network'), { recursive: true })
fs.writeFileSync(path.join(profDefault, 'Network', 'Cookies'), 'SQLITE_FAKE_COOKIES_v10')
fs.writeFileSync(path.join(profDefault, 'Login Data'), 'SQLITE_FAKE_LOGINS')

// ---- 1. profile scan ----
const profiles = scanBrowserDir(chromeDir, 'Test Chrome')
ok('found 2 profiles from Local State', profiles.length === 2)
ok('profile names/emails parsed', profiles.some(p => p.name === '工作' && p.email === 'me@example.com'))

// ---- 2. importProfile copies files into the space profile ----
const copied = importProfile(chromeDir, 'Default', 'default')
const destCookies = path.join(paths.spaceDir('default'), 'profile', 'Default', 'Network', 'Cookies')
ok('Cookies copied into space profile', fs.existsSync(destCookies) && fs.readFileSync(destCookies, 'utf8') === 'SQLITE_FAKE_COOKIES_v10')
ok('Login Data copied', fs.existsSync(path.join(paths.spaceDir('default'), 'profile', 'Default', 'Login Data')))
ok('reported copied list has 3 entries (Cookies + journal? no: 2 files present)', copied.length === 2)

// ---- 3. empty source throws ----
let threw = false
try { importProfile(chromeDir, 'Profile 1', 'default') } catch { threw = true }
ok('empty source profile throws', threw)

console.log(`\n${pass ? 'PASS' : 'FAIL'} import feature`)
fs.rmSync(TMP, { recursive: true, force: true }, )
process.exit(pass ? 0 : 1)
