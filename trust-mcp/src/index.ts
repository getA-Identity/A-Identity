#!/usr/bin/env node
/**
 * a-identity-trust-mcp: the trust tools over stdio, for Claude, Cursor or any MCP client.
 *
 *   A_IDENTITY_ALGORAND_MNEMONIC   the paying account (25 words, holds USDC). Unset: the wallet
 *                                  file `wallet new` made, if any; otherwise quotes only.
 *   A_IDENTITY_KEYFILE             that wallet file (default ~/.a-identity/algorand-wallet.json)
 *   A_IDENTITY_MAX_USD_PER_CALL    per-call spending cap in USD (default 10)
 *   A_IDENTITY_BASE_URL            oracle origin (default https://a-identity.xyz)
 *   A_IDENTITY_ALGOD_URL           algod endpoint override
 *   A_IDENTITY_CHECKS_LEDGER       where answers are kept (default ~/.a-identity/checks.json)
 *   A_IDENTITY_CACHE_HOURS         hours an answer is kept and served free (24 or more; default 24)
 *
 * Logs go to stderr: stdout belongs to the MCP protocol. The mnemonic is never logged.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildTrustMcpServer, configFromEnv, DEFAULT_MAX_USD_PER_CALL } from './server.js'
import { runCli } from './cli.js'
import { keyfilePath, loadWallet } from './wallet.js'

// With arguments it is a command (wallet new, check, ...); without, the MCP server.
if (process.argv.length > 2) process.exit(await runCli(process.argv.slice(2)))

const config = configFromEnv()
// No mnemonic in the environment: use the one-time wallet `wallet new` made, if there is one.
if (!config.mnemonic) config.mnemonic = loadWallet(keyfilePath())?.mnemonic
const server = buildTrustMcpServer(config)
await server.connect(new StdioServerTransport())

console.error(
  config.mnemonic
    ? `[a-identity-trust-mcp] ready; paying on Algorand, capped at ${config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL} USDC per call, each check of a target paid for once`
    : '[a-identity-trust-mcp] ready; A_IDENTITY_ALGORAND_MNEMONIC is not set, so paid tools return their price instead of paying',
)
