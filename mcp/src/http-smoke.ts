/**
 * HTTP smoke test: connect to the running Streamable-HTTP server, list tools,
 * and call one. Assumes `npm run start:http` is up (or start it first).
 *
 *   A_IDENTITY_HTTP_PORT=3399 node dist/http-smoke.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = Number(process.env.A_IDENTITY_HTTP_PORT ?? 3399)
const url = new URL(`http://localhost:${PORT}/mcp`)

type TextResult = { content: { type: string; text: string }[] }
const textOf = (r: TextResult) => r.content.map((c) => c.text).join('\n')

async function main() {
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client({ name: 'a-identity-http-smoke', version: '0.1.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  console.log('tools over HTTP:', tools.map((t) => t.name).sort().join(', '))

  const caps = (await client.callTool({ name: 'list_capabilities', arguments: {} })) as TextResult
  if (!textOf(caps).includes('ERC-8004')) throw new Error('list_capabilities failed over HTTP')

  await client.close()

  // REST companion endpoints (used by the frontend)
  const chainsRes = await fetch(`http://localhost:${PORT}/api/chains`).then((r) => r.json())
  const ids = (chainsRes.chains as { id: string }[]).map((c) => c.id)
  for (const id of ['arc', 'base', 'arbitrum', 'avalanche', 'xlayer', 'stellar', 'solana']) {
    if (!ids.includes(id)) throw new Error(`REST /api/chains missing ${id}`)
  }
  // /api/reputation must ANSWER correctly, which for an agent that does not exist means a
  // clean found:false with a reason. This used to assert a numeric score for a seeded
  // "aid/8" agent, but the fabricated demo agents were removed (data.ts AGENTS = []), so
  // that assertion could never pass again and the whole script died before its later
  // checks. Real reputation needs real state; a smoke test must not require invented data.
  const repRes = await fetch(`http://localhost:${PORT}/api/reputation?id=stellar:pubnet:aid/8`).then(
    (r) => r.json(),
  )
  if (repRes.found !== false || typeof repRes.reason !== 'string') {
    throw new Error(`REST /api/reputation did not answer cleanly for an unknown agent: ${JSON.stringify(repRes)}`)
  }

  // The action-policy routes are wired and gated. An unknown agent must come back as
  // "Unknown agent" from the handler, NOT the router's own lowercase "not found": that
  // difference is what proves the route exists rather than falling through. The POST is
  // additionally behind the mutation auth gate, so unauthenticated it must 401.
  const gr = await fetch(`http://localhost:${PORT}/api/agents/action-policy?agentId=missing`)
  const gb = (await gr.json().catch(() => ({}))) as { error?: string }
  if (gr.status !== 404 || gb.error !== 'Unknown agent') {
    throw new Error(`GET /api/agents/action-policy not wired (got ${gr.status} ${JSON.stringify(gb)})`)
  }
  const pr = await fetch(`http://localhost:${PORT}/api/agents/action-policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'missing', policy: {} }),
  })
  if (pr.status !== 401) {
    throw new Error(`POST /api/agents/action-policy should require a verified session (got ${pr.status})`)
  }

  console.log('✅ HTTP smoke test passed (MCP + REST, 7 chains, action-policy wired + gated)')
}

main().catch((err) => {
  console.error('❌ HTTP smoke test failed:', err)
  process.exit(1)
})
