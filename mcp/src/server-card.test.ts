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

test('every published copy of the tool count agrees with the card, and a printed tool list names them all', () => {
  const card = JSON.parse(readFileSync(new URL('../../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8')) as { tools: { name: string }[] }
  const published = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const copies = [
    'docs/protocols/mcp.mdx',
    'docs/developers/mcp-server.mdx',
    'index.html',
    'public/index.md',
    'public/llms.txt',
    'public/llms-full.txt',
    'public/.well-known/api-catalog',
    'public/.well-known/agent-card.json',
  ]
  for (const rel of copies) {
    const counts = [...published(rel).matchAll(/\b(\d+)(?:\*\*)? tools\b/g)].map((m) => Number(m[1]))
    assert.ok(counts.length > 0, `${rel} no longer states a tool count; drop it from this list`)
    for (const n of counts) assert.equal(n, card.tools.length, `${rel} says ${n} tools`)
  }
  const list = published('docs/protocols/mcp.mdx')
  for (const { name } of card.tools) assert.ok(list.includes(`\`${name}\``), `docs/protocols/mcp.mdx does not list ${name}`)
})
