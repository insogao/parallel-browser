/**
 * Brand feature test: fake .app fixture → brandBundle → verify name/icon/plist
 * (uses real sips + iconutil + the generated default icon; skips codesign).
 * Run: node tests/brand.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.BACKLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-brand-'))

const { brandBundle, patchPlist, generateDefaultIcon } = await import('../src/brand.ts')

let pass = true
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) pass = false
}

// ---- fixture: minimal Chromium-style .app ----
const srcApp = path.join(process.env.BACKLIGHT_HOME!, 'src', 'Test Chrome for Testing.app')
fs.mkdirSync(path.join(srcApp, 'Contents', 'MacOS'), { recursive: true })
fs.mkdirSync(path.join(srcApp, 'Contents', 'Resources'), { recursive: true })
fs.writeFileSync(path.join(srcApp, 'Contents', 'MacOS', 'Test Chrome for Testing'), '#!/bin/sh\n')
fs.writeFileSync(path.join(srcApp, 'Contents', 'Resources', 'app.icns'), 'FAKE_OLD_ICNS')
fs.writeFileSync(path.join(srcApp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Test Chrome for Testing</string>
  <key>CFBundleIdentifier</key><string>com.google.chrome.for.testing</string>
  <key>CFBundleName</key><string>Test Chrome for Testing</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
</dict></plist>`)

// ---- default icon generation (pure JS PNG encoder) ----
const iconPng = path.join(process.env.BACKLIGHT_HOME!, 'brand-icon.png')
generateDefaultIcon('MyBrand', iconPng)
const pngHead = fs.readFileSync(iconPng).subarray(0, 8)
ok('default icon generated as valid PNG', pngHead.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
ok('default icon is substantial (>2KB)', fs.statSync(iconPng).size > 2_000)

// ---- plist patch unit ----
const patched = patchPlist('<key>CFBundleName</key><string>Old</string>', { CFBundleName: 'New' })
ok('patchPlist replaces existing key', patched.includes('<string>New</string>'))
const inserted = patchPlist('<key>A</key><string>1</string></dict></plist>', { CFBundleDisplayName: 'Brand' })
ok('patchPlist inserts missing key', inserted.includes('CFBundleDisplayName'))

// ---- brandBundle (real sips/iconutil, no codesign) ----
let destBin = ''
try {
  destBin = await brandBundle({
    srcApp,
    destApp: path.join(process.env.BACKLIGHT_HOME!, 'apps', 'MyBrand.app'),
    name: 'MyBrand',
  })
  ok('branded app created (binPath returned)', fs.existsSync(destBin))
  const appDir = path.dirname(path.dirname(path.dirname(destBin)))
  const plist = fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8')
  ok('CFBundleName rebranded', plist.includes('<string>MyBrand</string>'))
  ok('CFBundleIdentifier set to dedicated brand id', plist.includes('dev.backlight.browser'))
  ok('icon switched to backlight.icns', plist.includes('<string>backlight</string>') && fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'backlight.icns')))
  ok('asset catalog no longer overrides custom icon', !plist.includes('<key>CFBundleIconName</key>'))
  ok('runtime app.icns uses brand icon', fs.readFileSync(path.join(appDir, 'Contents', 'Resources', 'app.icns')).equals(fs.readFileSync(path.join(appDir, 'Contents', 'Resources', 'backlight.icns'))))
  ok('source browser icon remains untouched', fs.readFileSync(path.join(srcApp, 'Contents', 'Resources', 'app.icns'), 'utf8') === 'FAKE_OLD_ICNS')
} catch (err) {
  console.error('BRAND ERROR:', err instanceof Error ? err.stack : err)
  pass = false
}

console.log(`\n${pass ? 'PASS' : 'FAIL'} brand feature`)
fs.rmSync(process.env.BACKLIGHT_HOME!, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
