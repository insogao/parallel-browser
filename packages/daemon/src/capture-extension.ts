import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { paths } from './paths.ts'
import { warn } from './log.ts'

/**
 * Bundled helper extension for window-invisible tab capture.
 *
 * Chrome's getDisplayMedia() path is unusable for a collapsed window on macOS:
 * DisplayMediaAccessHandler rejects with CAPTURE_FROM_BACKGROUND_PAGE_ON_MAC
 * (surfaced as InvalidStateError) unless the requesting WebContents is visible,
 * and the Views picker shown while the window is normal activates the app
 * (NSRunningApplication.hidden flips to false) and orders the window on screen
 * for ~0.4–1.5s. The extension tabCapture API has no visibility gate: a hidden
 * extension page calls chrome.tabCapture.getMediaStreamId({targetTabId}) and
 * holds the stream via getUserMedia({video:{mandatory:{chromeMediaSource:'tab',
 * chromeMediaSourceId}}}), granting the same CapturerCount exemption with zero
 * window activation.
 *
 * `--allowlisted-extension-id` skips the activeTab "invoked by the user"
 * requirement for the managed page. The id must match Chrome's unpacked
 * extension id, which is the SHA-256 (first 16 bytes, mapped to a–p) of the
 * canonicalized extension directory path.
 */

const CAPTURE_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'Backlight Capture',
  description: 'Internal tab-capture keep-alive. Opened as a background page by the Backlight daemon.',
  version: '1.0.0',
  permissions: ['tabCapture', 'tabs'],
}, null, 2) + '\n'

const CAPTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>bl-capture</title></head>
<body>Backlight capture
<script src="capture.js"></script></body></html>
`

// A short-lived, hidden extension document may create a minimized browser
// window atomically through chrome.windows.create(). CDP Target.createTarget
// with newWindow:true creates a second normal window on macOS when no browser
// window exists, splitting the first and second AI tabs across windows.
const WINDOW_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>bl-window-helper</title></head><body></body></html>\n`

const CAPTURE_JS = `// Held by the daemon as a background page; never activated, never visible.
window.__blCapture = null;
window.__blCaptureState = { state: 'idle', error: null };
window.startCaptureByTitle = async (title) => {
  try {
    if (window.__blCapture) return 'already';
    const tabs = await chrome.tabs.query({ title });
    if (!tabs.length) {
      window.__blCaptureState = { state: 'error', error: 'no-target' };
      return 'err';
    }
    const targetTabId = tabs[0].id;
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
    window.__blCapture = stream;
    window.__blCaptureState = { state: 'live', error: null };
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      window.__blCapture = null;
      window.__blCaptureState = { state: 'ended', error: null };
    });
    return 'ok';
  } catch (error) {
    if (window.__blCapture) {
      try { window.__blCapture.getTracks().forEach(t => t.stop()); } catch {}
      window.__blCapture = null;
    }
    const message = String(error && error.message ? error.message : error);
    window.__blCaptureState = { state: 'error', error: message.slice(0, 160) };
    return 'err';
  }
};
window.stopCapture = () => {
  try { if (window.__blCapture) window.__blCapture.getTracks().forEach(t => t.stop()); } catch {}
  window.__blCapture = null;
  window.__blCaptureState = { state: 'stopped', error: null };
  return 'stopped';
};
window.captureLive = () => !!(window.__blCapture
  && window.__blCapture.getVideoTracks().some(t => t.readyState === 'live'));
window.captureState = () => JSON.stringify(window.__blCaptureState);
`

export interface CaptureExtension {
  /** canonicalized absolute path passed to --load-extension */
  dir: string
  /** unpacked-extension id derived from the canonical path */
  id: string
  /** background page the daemon drives over CDP */
  pageUrl: string
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return
  } catch { /* missing or unreadable: rewrite below */ }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/**
 * Compute the Chrome unpacked-extension id for a directory. Chrome
 * canonicalizes the --load-extension path before hashing (on macOS /var is a
 * symlink to /private/var), so the caller must pass/derive the realpath.
 */
export function extensionIdForPath(dir: string): string {
  const real = fs.realpathSync(dir)
  const hex = createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 32)
  return [...hex].map(c => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
}

/**
 * Materialize the helper extension under the data dir and return its id/page
 * URL. Content is rewritten only when it changed (no mtime churn for Chrome's
 * extension watcher). Returns null (and warns) when the assets cannot be
 * written; capture keep-alive is then simply not armed.
 */
export function ensureCaptureExtension(): CaptureExtension | null {
  try {
    const dir = path.join(paths.root, 'extensions', 'backlight-capture')
    writeIfChanged(path.join(dir, 'manifest.json'), CAPTURE_MANIFEST)
    writeIfChanged(path.join(dir, 'capture.html'), CAPTURE_HTML)
    writeIfChanged(path.join(dir, 'capture.js'), CAPTURE_JS)
    writeIfChanged(path.join(dir, 'window.html'), WINDOW_HTML)
    const real = fs.realpathSync(dir)
    const id = extensionIdForPath(real)
    return { dir: real, id, pageUrl: `chrome-extension://${id}/capture.html` }
  } catch (err) {
    warn(`capture keep-alive unavailable (extension materialization failed): ${(err as Error).message}`)
    return null
  }
}
