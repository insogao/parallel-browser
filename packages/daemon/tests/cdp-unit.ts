import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Cdp } from '../src/cdp.ts'

/** Build a Cdp over a fake socket; the private constructor is only a type fence. */
function cdpOver(socket: unknown): Cdp {
  return new (Cdp as unknown as new (ws: unknown) => Cdp)(socket)
}

test('send resolves even when the response arrives during ws.send', async () => {
  const handlers = new Map<string, (data: unknown) => void>()
  const cdp = cdpOver({
    on(event: string, cb: (data: unknown) => void) { handlers.set(event, cb) },
    send(data: string) {
      const msg = JSON.parse(data)
      // A fast endpoint can answer before send() returns; that response must
      // not be dropped because the waiter was registered after ws.send.
      handlers.get('message')?.(JSON.stringify({ id: msg.id, result: { fast: true } }))
    },
    close() { /* ignore */ },
  })
  const result = await Promise.race([
    cdp.send<{ fast: boolean }>('Target.getTargets'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waiter lost the response')), 1000)),
  ])
  assert.deepEqual(result, { fast: true })
})

test('send rejects instead of throwing when the socket send throws synchronously', async () => {
  const cdp = cdpOver({
    on() { /* ignore */ },
    send() { throw new Error('socket already closing') },
    close() { /* ignore */ },
  })
  await assert.rejects(cdp.send('Target.getTargets'), /socket already closing/)
})

test('send surfaces a structured CDP error from a fast response', async () => {
  const handlers = new Map<string, (data: unknown) => void>()
  const cdp = cdpOver({
    on(event: string, cb: (data: unknown) => void) { handlers.set(event, cb) },
    send(data: string) {
      const msg = JSON.parse(data)
      handlers.get('message')?.(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'no such method' } }))
    },
    close() { /* ignore */ },
  })
  await assert.rejects(
    Promise.race([
      cdp.send('Target.getTargets'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waiter lost the error response')), 1000)),
    ]),
    /no such method/,
  )
})
