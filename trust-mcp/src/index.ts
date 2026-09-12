#!/usr/bin/env node
/**
 * a-identity-trust-mcp: the trust tools over stdio, for Claude, Cursor or any MCP client.
 *
 *   A_IDENTITY_ALGORAND_MNEMONIC   the paying account (25 words, holds USDC). Unset: quotes only.
 *   A_IDENTITY_MAX_USD_PER_CALL    per-call spending cap in USD (default 0.25)
 *   A_IDENTITY_BASE_URL            oracle origin (default https://a-identity.xyz)
 *   A_IDENTITY_ALGOD_URL           algod endpoint override
 *
 * Logs go to stderr: stdout belongs to the MCP protocol. The mnemonic is never logged.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildTrustMcpServer, configFromEnv, DEFAULT_MAX_USD_PER_CALL } from './server.js'

const config = configFromEnv()
const server = buildTrustMcpServer(config)
await server.connect(new StdioServerTransport())

console.error(
  config.mnemonic
    ? `[a-identity-trust-mcp] ready; paying on Algorand, capped at ${config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL} USDC per call`
    : '[a-identity-trust-mcp] ready; A_IDENTITY_ALGORAND_MNEMONIC is not set, so paid tools return their price instead of paying',
)
