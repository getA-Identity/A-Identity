# @a-identity/mcp

The A-Identity backend: a single Node HTTP server that is **two things at once**.

1. An **MCP server** (stdio + Streamable HTTP `POST /mcp`) exposing **read-only** tools any
   MCP-capable agent can call — no keys, no writes on this surface.
2. A **REST companion** (the same process, `http.ts`) that is the **write side** the app uses:
   it creates agents, runs the policy engine, and — when a funded `ARC_SIGNER_KEY` is present —
   **broadcasts real transactions on Arc testnet**: ERC-8004 registration, USDC settlement,
   ERC-8183 escrow, an `AgentSpendPolicy` vault, KYA attestation, Gateway/CCTP/Nanopayments.

Human-on-the-loop by design: nothing that holds a key, deploys a contract, or moves value
runs without an explicit human action, and without a signer key every write returns a labeled
`prepared` / `simulated` no-op. It is **testnet only** (Arc testnet, test USDC).

## MCP tools (read-only)

| Tool                | Input                                   | Returns                                             |
| ------------------- | --------------------------------------- | --------------------------------------------------- |
| `resolve_agent`     | `query` (CAIP-10 id / token id / owner) | live ERC-8004 identity read from Arc, or `found:false` |
| `get_reputation`    | `agentId`                               | deterministic score (0-1000) + breakdown            |
| `list_agents`       | -                                       | agents this platform instance knows                 |
| `get_chain_status`  | -                                       | supported chains + status                           |
| `get_arc_status`    | -                                       | live Arc testnet chainId + latest block             |
| `get_circle_status` | -                                       | Circle platform link state (real ping with a key)   |
| `list_capabilities` | -                                       | the A-Identity protocol surface                     |

Identity reads go through a swappable `IdentityProvider` (`src/erc8004.ts`) — Arc's deployed
ERC-8004 IdentityRegistry is read live out of the box; more EVM chains are added when their RPC
+ registry env vars are set. Reputation is the pure, unit-tested `computeAgentReputation`
(`src/reputation.ts`) — the same function `platform.ts` uses in production.

## REST surface (the write side)

See the "Backend endpoints" table in the repo root [README](../README.md). Highlights: agents,
wallets, instructions (pay/purchase/rental/batch through the policy engine), the on-chain
`AgentSpendPolicy` vault, Circle Agent Wallet, KYA, treasury, and the x402 / Nanopayments /
Gateway / CCTP rails. Writes are env-gated behind `ARC_SIGNER_KEY` (and, for Circle Wallets,
`CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET`); sensitive/expensive endpoints are rate-limited per IP.

## Develop

```bash
npm install
npm run build        # tsc to dist/
npm run compile      # compile contracts/AgentSpendPolicy.sol -> src/contracts/AgentSpendPolicy.ts (committed)
npm run start        # MCP server on stdio
npm run start:http   # the HTTP server (REST + /mcp). Reads config from process.env directly.
npm run smoke        # spin up the MCP server + exercise every read-only tool
npm run http-smoke   # exercise the tools over HTTP (server must be running)
npm test             # tsc + node:test unit tests (462 across 36 files, as of Aug 2026)
npm run e2e          # full end-to-end flow against a running server (E2E_BASE=...)
```

The server does **not** auto-load `.env`. Run it with the key inline or via `--env-file`:

```bash
node --env-file=.env dist/http.js     # Node 20.6+
# or
ARC_SIGNER_KEY=0x<funded-key> node dist/http.js
```

Tests: **462 unit tests across 36 colocated `*.test.ts` files** (as of Aug 2026; `npm test`) +
a full **E2E of about 67 checks** (`npm run e2e`) that adapts to signer presence: green with no
signer key (live Arc reads; on-chain writes reported as prepared), with the real Arc write
checks activating under a funded `ARC_SIGNER_KEY`. CI runs the no-signer path.

## Connect from an MCP client

The MCP server speaks stdio. Point any client at the built entry:

```jsonc
{ "mcpServers": { "a-identity": { "command": "node", "args": ["./mcp/dist/index.js"] } } }
```

For Claude Code:

```bash
claude mcp add a-identity -- node ./mcp/dist/index.js
```

> stdout is reserved for the MCP wire protocol — the server logs only to stderr.

## Deploy

Long-running Node process (not serverless). Root dir `mcp`, build
`npm install --include=dev && npm run build`, start `npm run start:http`. Binds to `$PORT`.
Set `AUTH_SECRET`, `ALLOWED_ORIGINS`, optionally `ARC_SIGNER_KEY` / Circle keys / `DATABASE_URL`.
On a free host it self-pings and a keep-warm cron keeps it awake — see the root README
"Reliability" section (and prefer a paid instance for a live demo).
