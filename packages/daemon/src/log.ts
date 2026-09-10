import fs from 'node:fs'
import path from 'node:path'

let verbose = process.env.BACKLIGHT_VERBOSE === '1'
let logStream: fs.WriteStream | null = null

export function setVerbose(v: boolean) { verbose = v }
export function isVerbose() { return verbose }

export function initFileLogging(dir: string, name = 'daemon.log') {
  try {
    fs.mkdirSync(dir, { recursive: true })
    logStream = fs.createWriteStream(path.join(dir, name), { flags: 'a' })
  } catch { /* logging must never throw */ }
}

function write(level: string, stream: NodeJS.WriteStream, msg: string, rest: unknown[]) {
  const line = `[${new Date().toISOString()}] ${level}${msg} ${rest.map(String).join(' ')}`.trimEnd()
  stream.write(line + '\n')
  try { logStream?.write(line + '\n') } catch { /* ignore */ }
}

export function log(msg: string, ...rest: unknown[]) { write('', process.stdout, msg, rest) }
export function warn(msg: string, ...rest: unknown[]) { write('WARN ', process.stderr, msg, rest) }
export function error(msg: string, ...rest: unknown[]) { write('ERROR ', process.stderr, msg, rest) }
export function debug(msg: string, ...rest: unknown[]) {
  if (verbose) write('DEBUG ', process.stdout, `[${process.pid}] ${msg}`, rest)
}
