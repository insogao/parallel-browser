import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { paths } from './paths.ts'
import { log, warn } from './log.ts'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 200)}`)) : resolve(String(stdout)))
  })
}

/** Encode a raw RGBA buffer as PNG (no deps). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw)

  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Fallback default icon (no custom logo provided): dark rounded square + cyan
 * ring + brand initial, drawn in pure pixels. 512×512.
 */
export function generateDefaultIcon(name: string, outPath: string): void {
  const size = 512
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2, cy = size / 2
  const letter = (name.trim()[0] ?? 'B').toUpperCase()
  // tiny 5x7 bitmap font for A-Z 0-9
  const glyphs: Record<string, string[]> = {
    B: ['1110', '1001', '1001', '1110', '1001', '1001', '1110'],
    A: ['0111', '1000', '1000', '1111', '1000', '1000', '1000'],
    C: ['0111', '1000', '1000', '1000', '1000', '1000', '0111'],
    D: ['1110', '1001', '1001', '1001', '1001', '1001', '1110'],
    E: ['1111', '1000', '1000', '1110', '1000', '1000', '1111'],
    F: ['1111', '1000', '1000', '1110', '1000', '1000', '1000'],
    G: ['0111', '1000', '1000', '1011', '1001', '1001', '0111'],
    H: ['1001', '1001', '1001', '1111', '1001', '1001', '1001'],
    I: ['111', '010', '010', '010', '010', '010', '111'],
    J: ['0011', '0001', '0001', '0001', '1001', '1001', '0110'],
    K: ['1001', '1001', '1010', '1100', '1010', '1001', '1001'],
    L: ['1000', '1000', '1000', '1000', '1000', '1000', '1111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['1001', '1101', '1011', '1001', '1001', '1001', '1001'],
    O: ['0110', '1001', '1001', '1001', '1001', '1001', '0110'],
    P: ['1110', '1001', '1001', '1110', '1000', '1000', '1000'],
    Q: ['0110', '1001', '1001', '1001', '1011', '1001', '0111'],
    R: ['1110', '1001', '1001', '1110', '1010', '1001', '1001'],
    S: ['0111', '1000', '1000', '0110', '0001', '0001', '1110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['1001', '1001', '1001', '1001', '1001', '1001', '0110'],
    V: ['10001', '10001', '10001', '10001', '01010', '01010', '00100'],
    W: ['10001', '10001', '10101', '10101', '10101', '11011', '10001'],
    X: ['1001', '1001', '0110', '0110', '0110', '1001', '1001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['1111', '0001', '0010', '0100', '1000', '1000', '1111'],
  }
  const glyph = glyphs[letter] ?? glyphs['B']!
  const cell = Math.floor(size * 0.06)
  const gw = glyph[0]!.length * cell
  const gh = glyph.length * cell
  const gx = Math.floor(size / 2 - gw / 2)
  const gy = Math.floor(size / 2 - gh / 2)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // dark rounded-square background
      const m = size * 0.04
      const inRounded = (() => {
        if (x < m && y < m) return (x - m) ** 2 + (y - m) ** 2 <= m * m
        if (x > size - m && y < m) return (x - (size - m)) ** 2 + (y - m) ** 2 <= m * m
        if (x < m && y > size - m) return (x - m) ** 2 + (y - (size - m)) ** 2 <= m * m
        if (x > size - m && y > size - m) return (x - (size - m)) ** 2 + (y - (size - m)) ** 2 <= m * m
        return true
      })()
      if (!inRounded) { rgba[i + 3] = 0; continue }
      rgba[i] = 11; rgba[i + 1] = 15; rgba[i + 2] = 20; rgba[i + 3] = 255
      // cyan ring
      const dx = x - cx, dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      const ringR = size * 0.30, ringW = size * 0.028
      const ringOuter = size * 0.225, ringW2 = size * 0.008
      if (Math.abs(d - ringR) <= ringW / 2) { rgba[i] = 55; rgba[i + 1] = 200; rgba[i + 2] = 255 }
      else if (Math.abs(d - ringOuter) <= ringW2 / 2) { rgba[i] = 55; rgba[i + 1] = 200; rgba[i + 2] = 255; rgba[i + 3] = 120 }
      // letter
      const px = x - gx, py = y - gy
      if (px >= 0 && py >= 0 && py < gh) {
        const col = Math.floor(px / cell), row = Math.floor(py / cell)
        const rowPat = glyph[row]
        if (rowPat && col < rowPat.length && rowPat[col] === '1') {
          rgba[i] = 235; rgba[i + 1] = 240; rgba[i + 2] = 245
        }
      }
    }
  }
  fs.writeFileSync(outPath, encodePng(size, size, rgba))
}

/**
 * Convert a 512/1024 master PNG into an .icns via sips + iconutil
 * (both ship with macOS).
 */
export async function makeIcns(masterPng: string, icnsPath: string): Promise<void> {
  const iconset = icnsPath.replace(/\.icns$/, '.iconset')
  fs.rmSync(iconset, { recursive: true, force: true })
  fs.mkdirSync(iconset, { recursive: true })
  const sizes: Array<[string, number]> = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ]
  for (const [name, px] of sizes) {
    await run('/usr/bin/sips', ['-z', String(px), String(px), masterPng, '--out', path.join(iconset, name)])
  }
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icnsPath])
  fs.rmSync(iconset, { recursive: true, force: true })
}

/** Patch a mac Info.plist text: replace or insert CF string keys. */
export function patchPlist(plistText: string, values: Record<string, string>): string {
  let out = plistText
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`)
    if (re.test(out)) out = out.replace(re, `$1${value.replace(/[<>&]/g, '')}$2`)
    else out = out.replace(/<\/dict>\s*<\/plist>/, `  <key>${key}</key>\n  <string>${value.replace(/[<>&]/g, '')}</string>\n</dict>\n</plist>`)
  }
  return out
}

export interface BrandOptions {
  srcApp: string
  destApp: string
  name: string
  /** custom logo PNG (≥512px recommended); default = generated ring + initial */
  iconPng?: string
}

/**
 * Create a branded copy of a Chromium .app: new name, new icon, same bundle
 * identifier (so Keychain/cookie encryption semantics stay intact).
 */
export async function brandBundle(opts: BrandOptions): Promise<string> {
  const { srcApp, destApp, name } = opts
  if (!fs.existsSync(path.join(srcApp, 'Contents', 'MacOS'))) {
    throw new Error(`source app missing Contents/MacOS: ${srcApp}`)
  }
  if (fs.existsSync(destApp)) fs.rmSync(destApp, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destApp), { recursive: true })
  log(`copying browser bundle for branding (this can take a moment)…`)
  fs.cpSync(srcApp, destApp, { recursive: true })

  // icon
  const resources = path.join(destApp, 'Contents', 'Resources')
  fs.mkdirSync(resources, { recursive: true })
  let masterPng = opts.iconPng ?? ''
  if (!masterPng) {
    masterPng = path.join(paths.root, 'brand-icon.png')
    generateDefaultIcon(name, masterPng)
  }
  if (!fs.existsSync(masterPng)) throw new Error(`icon not found: ${masterPng}`)
  await makeIcns(masterPng, path.join(resources, 'backlight.icns'))

  // Info.plist: display name + icon. CFBundleIdentifier is set to a DEDICATED
  // id (not CfT's) so macOS registers the branded app as a fresh, separate
  // application — no icon-cache collision with Chrome/CfT registrations.
  // Keychain caveat: the branded browser has its own login store.
  const plistPath = path.join(destApp, 'Contents', 'Info.plist')
  const patched = patchPlist(fs.readFileSync(plistPath, 'utf8'), {
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleIconFile: 'backlight',
    CFBundleIdentifier: 'dev.backlight.browser',
  })
  fs.writeFileSync(plistPath, patched)

  // register with LaunchServices so the Dock shows the branded icon immediately
  try {
    await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', destApp])
    await run('/bin/killall', ['Dock'])
  } catch (err) {
    warn(`LaunchServices refresh failed: ${(err as Error).message.slice(0, 120)}`)
  }

  // NOTE: do NOT re-sign. The main executable is untouched (still validly
  // signed by Google); a --deep ad-hoc re-sign would strip the helpers'
  // JIT entitlements and crash the renderer on arm64. Modified Resources
  // (icon/plist) don't block direct execution without quarantine.
  const execName = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(destApp, 'Contents', 'Info.plist')])).trim()
  const binPath = path.join(destApp, 'Contents', 'MacOS', execName)
  if (!fs.existsSync(binPath)) throw new Error(`branded executable missing: ${binPath}`)
  log(`branded browser ready: ${destApp}`)
  return binPath
}
