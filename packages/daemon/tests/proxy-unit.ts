import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { createServer, type ServerDeps } from '../src/proxy.ts'
import { ActivityBus } from '../src/activity.ts'

test('proxy queues the first CDP command while upstream handshake is pending', async () => {
  const upstream = http.createServer()
  const wss = new WebSocketServer({ server: upstream, verifyClient: (_info, done) => setTimeout(() => done(true), 80) })
  wss.on('connection', ws => ws.on('message', data => {
    const request = JSON.parse(data.toString())
    ws.send(JSON.stringify({ id: request.id, result: { targetInfos: [] } }))
  }))
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const proxy = createServer({ manager: { current: { upstreamPort: (upstream.address() as any).port } }, supervisor: { humanMode: false }, bus: new ActivityBus(), pulse() {} } as unknown as ServerDeps)
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r))
  const client = new WebSocket(`ws://127.0.0.1:${(proxy.address() as any).port}/devtools/browser/test`)
  try {
    const received = new Promise<any>(resolve => client.once('message', data => resolve(JSON.parse(data.toString()))))
    await new Promise<void>(r => client.once('open', r))
    client.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }))
    const timeout = setTimeout(() => client.close(), 1000)
    const result = await Promise.race([received, new Promise<null>(r => client.once('close', () => r(null)))])
    clearTimeout(timeout)
    assert.deepEqual(result, { id: 1, result: { targetInfos: [] } }, 'initial CDP command was lost')
  } finally {
    client.terminate()
    for (const socket of wss.clients) socket.terminate()
    wss.close(); upstream.close(); proxy.close()
  }
})
