#!/usr/bin/env node
/**
 * A-Identity MCP server - stdio entry.
 *
 * Read-only tools (resolve_agent, get_reputation, list_capabilities) over LIVE
 * on-chain reads (Arc ERC-8004) + platform state. No mocks, no private keys, no
 * funds, no chain writes.
 *
 * stdout is reserved for the MCP wire protocol - this process never
 * `console.log`s; diagnostics go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'

async function main() {
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[a-identity-mcp] ready on stdio')
}

main().catch((err) => {
  console.error('[a-identity-mcp] fatal:', err)
  process.exit(1)
})
