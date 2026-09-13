import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { fetchTargets } from '../src/cdp.ts'

test('HTTP target ids normalize to the targetId used by CDP', async () => {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ id: 'page-id', type: 'page', title: 'Page', url: 'https://example.com/' }])) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try { assert.equal((await fetchTargets((server.address() as any).port))[0]?.targetId, 'page-id') }
  finally { server.close() }
})
