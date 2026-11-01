/**
 * HTTP smoke test: connect to the running Streamable-HTTP server, list tools,
 * and call one. Assumes `npm run start:http` is up (or start it first).
 *
 *   A_IDENTITY_HTTP_PORT=3399 node dist/http-smoke.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CHAIN_IDS } from './chains/index.js'

const PORT = Number(process.env.A_IDENTITY_HTTP_PORT ?? 3399)
const url = new URL(`http://localhost:${PORT}/mcp`)

type TextResult = { content: { type: string; text: string }[] }
const textOf = (r: TextResult) => r.content.map((c) => c.text).join('\n')

async function main() {
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client({ name: 'a-identity-http-smoke', version: '0.1.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  console.log('tools over HTTP:', names.join(', '))

  // The policy tools are registered only when the HTTP entry injects its hooks, so a
  // broken injection would silently drop the whole guardrail surface from MCP while every
  // REST route kept working. Assert they are present, and that each still advertises a
  // schema a client can build a call from.
  for (const name of ['register_agent', 'policy_get', 'policy_set', 'pre_action_check', 'audit_log', 'record_audit_outcome']) {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`MCP is missing the policy tool: ${name}`)
    const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
    if (!props.length) throw new Error(`MCP tool ${name} advertises no input schema`)
  }

  // The commerce merchant check is an always-on read-only tool (like resolve_agent), so a
  // registration slip would silently drop the pre-checkout trust surface. Assert it is
  // listed and still advertises the url/agentId schema a client builds a call from.
  const merchant = tools.find((t) => t.name === 'merchant_check')
  if (!merchant) throw new Error('MCP is missing merchant_check')
  const merchantProps = Object.keys((merchant.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
  if (!merchantProps.includes('url') || !merchantProps.includes('agentId')) {
    throw new Error(`merchant_check schema lost its inputs (got: ${merchantProps.join(',')})`)
  }

  // verify_then_pay is injected by the HTTP entry like the policy tools, so the same silent
  // drop is possible. Assert both tools and the inputs a caller builds a call from. Nothing
  // is called: the tool would read Arc Mainnet, and a smoke test should not depend on it.
  for (const [name, wanted] of [
    ['verify_then_pay', ['vault', 'payee', 'amount', 'payment', 'payOnWarn']],
    ['verify_then_pay_receipt', ['flowId', 'txHash']],
  ] as const) {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`MCP is missing ${name}`)
    const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
    const lost = wanted.filter((p) => !props.includes(p))
    if (lost.length) throw new Error(`${name} schema lost its inputs: ${lost.join(', ')}`)
  }

  const caps = (await client.callTool({ name: 'list_capabilities', arguments: {} })) as TextResult
  if (!textOf(caps).includes('ERC-8004')) throw new Error('list_capabilities failed over HTTP')

  // Owner-gated by construction: an unauthenticated MCP caller must be refused, not served.
  // The exact refusal depends on whether the id exists at all ("Unknown agent" is checked
  // before ownership, matching the REST gate), so assert what actually matters: an error
  // came back and no policy did.
  const gated = textOf((await client.callTool({ name: 'policy_get', arguments: { agentId: 'anything' } })) as TextResult)
  const refused = gated.includes('Forbidden') || gated.includes('Unknown agent')
  if (!refused || gated.includes('perActionCapUsd')) {
    throw new Error(`policy_get served an unauthenticated MCP caller: ${gated.slice(0, 160)}`)
  }

  await client.close()

  // REST companion endpoints (used by the frontend)
  const chainsRes = await fetch(`http://localhost:${PORT}/api/chains`).then((r) => r.json())
  const ids = (chainsRes.chains as { id: string }[]).map((c) => c.id)
  // Expect the registry, not a copy of it: the hand-typed list here omitted the two Celo
  // chains, so the REST surface could have dropped them without this failing.
  for (const id of CHAIN_IDS) {
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

  // The merchant-check REST route must be wired AND validate its input: with neither a url
  // nor an agentId it answers a clean 400 with an error, not the router's 404 fallthrough.
  const mcRes = await fetch(`http://localhost:${PORT}/api/commerce/merchant-check`)
  const mcBody = (await mcRes.json().catch(() => ({}))) as { error?: string }
  if (mcRes.status !== 400 || typeof mcBody.error !== 'string') {
    throw new Error(`GET /api/commerce/merchant-check not wired or not validating (got ${mcRes.status} ${JSON.stringify(mcBody)})`)
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

  // GET /mcp must never fall through to the 404 again: a browser gets a 200 page that
  // says the endpoint is live and how to connect, and an MCP client asking for an SSE
  // stream gets the spec's 405 with Allow: POST, which keeps it on plain POST.
  const page = await fetch(url, { headers: { Accept: 'text/html' } })
  const pageText = await page.text()
  if (page.status !== 200 || !pageText.includes('claude mcp add --transport http')) {
    throw new Error(`GET /mcp from a browser should describe the endpoint (got ${page.status})`)
  }
  const sse = await fetch(url, { headers: { Accept: 'text/event-stream' } })
  if (sse.status !== 405 || sse.headers.get('allow') !== 'POST') {
    throw new Error(`GET /mcp asking for SSE should be 405 with Allow: POST (got ${sse.status})`)
  }

  console.log(`✅ HTTP smoke test passed (MCP + REST, ${CHAIN_IDS.length} chains, 6 policy tools + merchant_check + the 2 verify_then_pay tools over MCP, action-policy wired + gated, merchant-check validated, GET /mcp described)`)
}

main().catch((err) => {
  console.error('❌ HTTP smoke test failed:', err)
  process.exit(1)
})
