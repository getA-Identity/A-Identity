import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, type ServerData } from './server.js'

/**
 * The published MCP server card lists the tools a client can expect, and nothing regenerates it.
 * Its list drifted from the server once already, so this holds the two equal: every tool the
 * server registers when the HTTP entry injects all of its hooks, and no other.
 */
const every: ServerData = {
  marketplace: {} as ServerData['marketplace'],
  policy: {} as ServerData['policy'],
  verifyThenPay: {} as ServerData['verifyThenPay'],
}

test("the server card's tool names are exactly the registered MCP tool names", async () => {
  const card = JSON.parse(readFileSync(new URL('../../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8')) as { tools: { name: string }[] }
  const named = card.tools.map((t) => t.name)
  assert.equal(new Set(named).size, named.length, 'the card lists a tool twice')

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildServer(every).connect(serverSide)
  const client = new Client({ name: 'server-card-test', version: '0.0.0' })
  await client.connect(clientSide)
  const registered = (await client.listTools()).tools.map((t) => t.name)
  await client.close()

  assert.deepEqual([...named].sort(), [...registered].sort())
})
