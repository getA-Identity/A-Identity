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
  const repRes = await fetch(`http://localhost:${PORT}/api/reputation?id=stellar:pubnet:aid/8`).then(
    (r) => r.json(),
  )
  if (typeof repRes.reputation?.score !== 'number') throw new Error('REST /api/reputation failed')

  console.log(`✅ HTTP smoke test passed (MCP + REST, 7 chains, stellar score=${repRes.reputation.score})`)
}

main().catch((err) => {
  console.error('❌ HTTP smoke test failed:', err)
  process.exit(1)
})
