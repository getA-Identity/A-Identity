# @a-identity/mcp

The A-Identity backend: a single Node HTTP server that is **two things at once**.

1. An **MCP server** (stdio + Streamable HTTP `POST /mcp`) exposing **read-only** tools any
   MCP-capable agent can call - no keys, no writes on this surface.
2. A **REST companion** (the same process, `http.ts`) that is the **write side** the app uses:
   it creates agents, runs the policy engine, and - when a funded signer is present -
   **broadcasts real transactions**: ERC-8004 registration, USDC settlement, ERC-8183
   escrow, an `AgentSpendPolicy` vault, KYA attestation, Gateway/CCTP/Nanopayments.

Human-on-the-loop by design: nothing that holds a key, deploys a contract, or moves value
runs without an explicit human action, and without a signer key every write returns a labeled
`prepared` / `simulated` no-op.

**Not testnet only.** This line used to say it was, which was true of Arc and never true of
the registry. Arc is testnet and is the `live` phase-1 network, but four mainnets carry our
own traffic and real value: OKX X Layer, Celo, Robinhood Chain and Arbitrum One. Stellar
pubnet is a fifth mainnet, `beta`, where the Soroban spend vault is deployed and real USDC
has moved under its policy without a paid call selling there yet. Two payment
rails sell there - `x402-3009/` (self-facilitated EIP-3009) and `x402-stellar/` (Soroban) -
and each chain has its own signer env var. [`src/chains/registry.ts`](src/chains/registry.ts)
is the source of truth for which is which, and [`../SECURITY.md`](../SECURITY.md) lists every
key and what it can spend.

## MCP tools

The server registers **20** tools (`src/server.ts`). Eight are always present; the other
twelve appear only when the HTTP entry injects the hooks they need, so a bare stdio server
exposes the read-only set and nothing that can move money.

### Always registered (read-only)

| Tool                | Input                                   | Returns                                             |
| ------------------- | --------------------------------------- | --------------------------------------------------- |
| `resolve_agent`     | `query` (CAIP-10 id / token id / owner) | live ERC-8004 identity read from Arc, or `found:false` |
| `get_reputation`    | `agentId`                               | deterministic score (0-1000) + breakdown            |
| `list_agents`       | -                                       | agents this platform instance knows                 |
| `get_chain_status`  | -                                       | supported chains + status                           |
| `get_arc_status`    | -                                       | live Arc testnet chainId + latest block             |
| `get_circle_status` | -                                       | Circle platform link state (real ping with a key)   |
| `list_capabilities` | -                                       | the A-Identity protocol surface                     |
| `merchant_check`    | merchant agent id or URL                | commerce verdict before a checkout (`src/commerce.ts`) |

### Marketplace group (registered when the HTTP entry injects marketplace hooks)

| Tool                 | Input                        | Returns                                          |
| -------------------- | ---------------------------- | ------------------------------------------------ |
| `find_agent`         | capability / natural-language ask | matching KYA-verified worker agents         |
| `get_agent_manifest` | `agentId`                    | that agent's public manifest (AMP Discover)      |
| `hire_agent`         | agent + task + budget        | a task, with USDC held in ERC-8183 escrow        |
| `deliver_task`       | `taskId` + result            | the task moved to delivered                      |
| `check_task_status`  | `taskId`                     | lifecycle state and any escrow tx                |
| `release_escrow`     | `taskId`                     | escrow released to the worker on delivery        |

### Policy group (Phase 1.7, ownership-gated)

| Tool                  | Input                       | Returns                                            |
| --------------------- | --------------------------- | -------------------------------------------------- |
| `register_agent`      | a manifest                  | the agent registered against its owner             |
| `policy_get`          | `agentId`                   | the current action policy                          |
| `policy_set`          | `agentId` + policy          | the stored policy, sanitized and versioned         |
| `pre_action_check`    | an intended action          | ALLOW / WARN / DENY with the rule that decided     |
| `audit_log`           | `agentId`                   | the decision trail                                 |
| `record_audit_outcome`| a verdict id + what happened| the trail updated with the real outcome            |

Identity reads go through a swappable `IdentityProvider` (`src/erc8004.ts`) - Arc's deployed
ERC-8004 IdentityRegistry is read live out of the box; more EVM chains are added when their RPC
+ registry env vars are set. Reputation is the pure, unit-tested `computeAgentReputation`
(`src/reputation.ts`) - the same function `platform.ts` uses in production.

## REST surface (the write side)

See the "Backend endpoints" table in the repo root [README](../README.md). Highlights: agents,
wallets, instructions (pay/purchase/rental/batch through the policy engine), the on-chain
`AgentSpendPolicy` vault, Circle Agent Wallet, KYA, treasury, and the x402 / Nanopayments /
Gateway / CCTP rails. Writes are env-gated behind `ARC_SIGNER_KEY` (and, for Circle Wallets,
`CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET`); sensitive/expensive endpoints are rate-limited per IP.

## Module map

`src/` is deliberately flat for the small modules; the two big domains live in their own
directories. Entry points and `storage.ts` must stay at the top level: their `dist/` paths are
pinned by npm scripts, CI, Render, and `storage.ts` resolves `mcp/data/` relative to itself.

Directories:

- `src/platform/` - the write-side domain, split by concern behind the `src/platform.ts`
  re-export barrel. `core.ts` (L1) owns the state singleton, persistence, and shared helpers;
  above it sit `kya`, `vault`, `reputation`, `instructions` (L2), `permissions` (L3),
  `agents` (L4), `guardrail` (L5), `feed` (L6), `tasks` (L7), `manifest` (L8). A module may
  import only lower layers, so cycles are impossible. Everything outside imports
  `./platform.js` only; internal symbols (state, save, repOf, isShowcase, ...) are never
  re-exported. Test-enforced, not prose: `src/platform/layering.test.ts` encodes the layer
  graph and fails the build on an upward import, a barrel bypass, or a module missing from
  the map.
- `src/http/` - the REST surface as route-group handlers (`auth`, `public`, `arc`, `agent`,
  `guardrail`, `instruction`, `marketplace` + `shared.ts` helpers). `src/http.ts` stays the
  entry: it owns CORS, rate limiting, caller resolution, the mutation gate, the `/mcp`
  transport, and dispatches to the groups in a fixed order. A handler returns true when it
  handled the request.
- `src/chains/` - the chain registry (single source of truth for ids/RPCs/addresses) + the
  generic EVM adapter. Nothing outside may hardcode a chain constant (test-enforced).
- `src/x402-3009/` - the self-facilitated EIP-3009 rail: the buyer signs a transfer
  authorization and pays no gas, we broadcast, and nothing counts as settled without a
  receipt carrying a matching `Transfer` log. Chain-generic, so a chain joins by declaring a
  `settlementTokens` entry. Its EIP-712 signing domain is PROVEN against the token's live
  `DOMAIN_SEPARATOR` rather than pasted; if it cannot be proven, no challenge is served.
  Sells on Robinhood Chain (USDG) and Arbitrum One (native Circle USDC).
- `src/x402-stellar/` - the same contract on Soroban, a sibling rather than a fork. The buyer
  signs an authorization ENTRY, so there is no per-token domain to prove, and settled means
  we read the transfer event ourselves and match it to the buyer's authorization nonce. Ships
  its own facilitator; OpenZeppelin Channels is available as a fallback broadcaster.
- `src/policy/` - Policy Engine v2 (pure evaluate + audit + compliance + badges + meters).
- `src/asp/` - the OKX.AI paid Trust Oracle (tools, x402 payment, proof, settlements).
  Registered listing: do not change tool schemas or prices casually.
- `src/callers/` - venue adapters (Robinhood Crypto, written ahead of integration).
- `src/contracts/` - GENERATED by `npm run compile` from `contracts/*.sol`. Do not hand-edit.

Flat files by group: entries (`index.ts` stdio MCP, `http.ts` REST+MCP, `asp-gateway.ts` ASP,
`smoke.ts`, `http-smoke.ts`) - infra (`server.ts` tool registration, `storage.ts` persistence,
`build-stamp.ts`) - Circle rails (`gateway.ts`, `cctp.ts`, `nanopay.ts`, `appkit.ts`,
`circle.ts`, `circle-agent.ts`, `circle-cli.ts`, `paymaster.ts`) - Arc binding (`arc.ts`,
`arc-contracts.ts`) - auth (`auth.ts`, `oauth.ts`, `magic.ts`, `bot-auth.ts`) - domain
(`erc8004.ts`, `reputation.ts`, `marketplace.ts`, `data.ts`) - x402/autonomy (`x402.ts`,
`autopilot.ts`, `trust-oracle.ts`) - treasury (`treasury.ts`, `treasury-safe.ts`,
`airdrop.ts`) - AA (`aa-wallet.ts`).

## Develop

```bash
npm install
npm run build        # tsc to dist/
npm run compile      # compile contracts/AgentSpendPolicy.sol -> src/contracts/AgentSpendPolicy.ts (committed)
npm run start        # MCP server on stdio
npm run start:http   # the HTTP server (REST + /mcp). Reads config from process.env directly.
npm run smoke        # spin up the MCP server + exercise every read-only tool
npm run http-smoke   # exercise the tools over HTTP (server must be running)
npm test             # tsc + node:test unit tests (1013 across 77 files, as of Aug 2026)
npm run e2e          # full end-to-end flow against a running server (E2E_BASE=...)
```

The server does **not** auto-load `.env`. Run it with the key inline or via `--env-file`:

```bash
node --env-file=.env dist/http.js     # Node 20.6+
# or
ARC_SIGNER_KEY=0x<funded-key> node dist/http.js
```

Tests: **1013 unit tests across 77 colocated `*.test.ts` files** (as of Aug 2026; `npm test`) +
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

> stdout is reserved for the MCP wire protocol - the server logs only to stderr.

## Deploy

Long-running Node process (not serverless). Root dir `mcp`, build
`npm install --include=dev && npm run build`, start `npm run start:http`. Binds to `$PORT`.
Set `AUTH_SECRET`, `ALLOWED_ORIGINS`, optionally `ARC_SIGNER_KEY` / Circle keys / `DATABASE_URL`.
On a free host it self-pings and a keep-warm cron keeps it awake - see the root README
"Reliability" section (and prefer a paid instance for a live demo).
