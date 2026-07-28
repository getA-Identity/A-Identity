/**
 * Smoke test: spin up the built read-only MCP server over stdio, list its tools, and
 * exercise the real ones. Exits non-zero on any failure.
 *
 * This server is the READ-ONLY agent-facing surface: it resolves identity with a live
 * on-chain read (Arc ERC-8004) and describes capabilities/chains. Reputation and the
 * agent roster live on the PLATFORM (the HTTP server + its store), so `get_reputation`
 * and `list_agents` here return honest pointers to the platform, not fabricated data —
 * the assertions below reflect that (no mock scores, no mock agents).
 *
 * Run with: npm run build && npm run smoke
 */
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = fileURLToPath(new URL('./index.js', import.meta.url))

type TextResult = { content: { type: string; text: string }[] }
const textOf = (r: TextResult) => r.content.map((c) => c.text).join('\n')

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [serverPath],
  })
  const client = new Client({ name: 'a-identity-smoke', version: '0.1.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  console.log('tools:', names.join(', '))

  const expected = [
    'get_arc_status',
    'get_chain_status',
    'get_circle_status',
    'get_reputation',
    'list_agents',
    'list_capabilities',
    'resolve_agent',
  ]
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`missing tool: ${name}`)
  }

  // 1) Resolve the live Arc showcase agent (ERC-8004 #849980) with a real on-chain read.
  const SHOWCASE = 'eip155:5042002:8004/849980'
  const resolved = (await client.callTool({
    name: 'resolve_agent',
    arguments: { query: SHOWCASE },
  })) as TextResult
  console.log(`\nresolve_agent(${SHOWCASE}):`)
  console.log(textOf(resolved))
  if (!textOf(resolved).includes('"found": true')) {
    throw new Error('resolve_agent did not resolve the live Arc showcase agent')
  }

  // 2) Capabilities advertise the ERC-8004 identity standard.
  const caps = (await client.callTool({ name: 'list_capabilities', arguments: {} })) as TextResult
  console.log('\nlist_capabilities():')
  console.log(textOf(caps))
  if (!textOf(caps).includes('ERC-8004')) throw new Error('list_capabilities missing identity standard')

  // 3) get_reputation is a read-only pointer here: reputation is computed on the platform
  //    (REST /api/agents/reputation), so the tool returns a well-formed response — a real
  //    score when it has one, otherwise an honest note — never a fabricated number.
  const rep = (await client.callTool({ name: 'get_reputation', arguments: { agentId: SHOWCASE } })) as TextResult
  console.log('\nget_reputation(showcase):')
  console.log(textOf(rep))
  const repJson = JSON.parse(textOf(rep))
  if (typeof repJson.found !== 'boolean') throw new Error('get_reputation returned a malformed response')
  const repScore = repJson?.reputation?.score
  if (repScore !== undefined && (typeof repScore !== 'number' || repScore < 0 || repScore > 1000)) {
    throw new Error('get_reputation score out of range')
  }

  // 4) Every registry chain is reported by get_chain_status.
  const chainStatus = (await client.callTool({ name: 'get_chain_status', arguments: {} })) as TextResult
  const chainIds = JSON.parse(textOf(chainStatus)).chains.map((c: { id: string }) => c.id)
  for (const id of ['arc', 'base', 'arbitrum', 'avalanche', 'xlayer', 'stellar', 'solana']) {
    if (!chainIds.includes(id)) throw new Error(`get_chain_status missing chain: ${id}`)
  }

  // 5) Chain filter: the Arc agent must NOT resolve when filtered to a different chain.
  const mismatched = (await client.callTool({
    name: 'resolve_agent',
    arguments: { query: SHOWCASE, chain: 'base' },
  })) as TextResult
  if (textOf(mismatched).includes('"found": true')) {
    throw new Error('resolve_agent chain filter did not reject a cross-chain match')
  }

  await client.close()
  console.log(
    `\n✅ smoke test passed (live Arc resolve, capabilities, honest reputation pointer, 5 chains, chain filter)`,
  )
}

main().catch((err) => {
  console.error('❌ smoke test failed:', err)
  process.exit(1)
})
