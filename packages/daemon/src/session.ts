import type { BrowserInstance } from './browser.ts'

/**
 * One managed browser session identity, shared by every entry point (Dock via
 * the tray, launchpad via the launcher/CLI login, menu bar and HTTP API).
 *
 * The id is derived from the managed instance only (space/pid/startedAt), so
 * two sessions can never alias and no profile path, URL or user content is
 * exposed. It is attached to `/api/status` and to every state-log transition
 * so Dock/launchpad/API actions can be attributed to the same session.
 */
export function browserSessionId(instance: Pick<BrowserInstance, 'space' | 'pid' | 'startedAt'>): string {
  const space = instance.space.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 24) || 'default'
  return `s-${space}-${instance.pid}-${instance.startedAt}`
}
