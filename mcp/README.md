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
the registry. Arc was the phase-1 network on testnet and has been `live` on Arc Mainnet
(`eip155:5042`) since the day it opened, 2026-09-16: agent #0 on the canonical ERC-8004
registry, an `AgentSpendPolicy` vault holding real USDC, and x402 selling there through both
our EIP-3009 facilitator and Circle Gateway nanopayments (see `src/x402-3009/` and
`src/x402-gateway/` below), every payment so far self-funded and labeled internal. Escrow, KYA anchoring
and the console's register, anchor and vault flows still run on Arc testnet. Other mainnets
carrying our own traffic and real value: OKX X Layer, Celo, Base, Robinhood Chain,
Arbitrum One and Algorand. Stellar pubnet is `live` too, not `beta`: the Soroban spend vault holds real
USDC under its on-ledger policy, and since 2026-08-28 the Soroban x402 rail SELLS on both
Stellar networks from the hosted deployment, which `/api/x402/stellar/status` answers for
itself. Two payment
rails of our own sell across these chains - `x402-3009/` (self-facilitated EIP-3009, on Arc
Mainnet, Base, Arbitrum One and Robinhood Chain) and `x402-stellar/` (Soroban, on the two Stellar networks) - and each chain
has its own signer env var. [`src/chains/registry.ts`](src/chains/registry.ts)
is the source of truth for which is which, and [`../SECURITY.md`](../SECURITY.md) lists every
key and what it can spend.

## MCP tools

The server registers **20** tools (`src/server.ts`). Eight are always present; the other
twelve appear only when the HTTP entry injects the hooks they need, so a bare stdio server
exposes the read-only set and nothing that can move money.

### Always registered (read-only)

| Tool                | Input                                   | Returns                                             |
| ------------------- | --------------------------------------- | --------------------------------------------------- |
| `resolve_agent`     | `query` (CAIP-10 id / token id / owner) | live ERC-8004 identity read from every registry chain, or `found:false`; `registeredAt` is the mint block's date when the chain can prove it, else self-reported (labeled) or `''` |
| `get_reputation`    | `agentId`                               | deterministic score (0-1000) + breakdown            |
| `list_agents`       | -                                       | agents this platform instance knows                 |
| `get_chain_status`  | -                                       | supported chains + status                           |
| `evm_pay_check`     | `query` (token / wallet / agent id / x402 link), `chain` | verdict + coded reasons: real USDG or USDC with a proven EIP-712 domain, registered payee, what a 402 challenge asks for |
| `get_arc_status`    | -                                       | live Arc testnet chainId + latest block (Arc Mainnet evidence: `GET /api/proof/arc`) |
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
  Sells on Arc Mainnet (USDC, the ERC-20 face of the gas token), Base, Arbitrum One (native
  Circle USDC on both) and Robinhood Chain (USDG); `GET /api/facilitator/status` lists the
  configured networks and their fees.
- `src/x402-gateway/` - the Circle Gateway batched rail (Nanopayments) for Circle Agent
  Marketplace buyers: the buyer signs an EIP-3009 authorization against Gateway's
  `GatewayWalletBatched` domain and pays no gas, Gateway credits and batches, we broadcast
  nothing. Chain-generic: a chain joins by declaring a `gateway` in the registry, and the
  live supported-kinds endpoint must name that wallet and the chain's USDC before a
  challenge is served. Nothing is recorded or served until the transfer is read back from
  Gateway's transfers API. Prices are read from `asp/payment.ts`, never restated. Sells on
  Arc Mainnet (the primary network) and Base mainnet (`X402_GATEWAY_NETWORKS`,
  `X402_GATEWAY_PAYTO`); `GET /api/x402/gateway/status` answers for itself.
- `src/verify-then-pay/` - verify-then-pay on Arc Mainnet, the hosted half, behind
  `POST /api/x402/gateway/verify-then-pay` and the `verify_then_pay` MCP tool. Free checks
  first, read from Arc Mainnet (`reads.ts`): the vault holds the registry's USDC, the payee
  holds an ERC-8004 agent on Arc Mainnet's own IdentityRegistry, and the vault's policy plus a
  simulated `pay()` from its operator would accept the payment, so a payment the vault would
  refuse never buys a check. Then `risk_check` is bought in process through the Gateway rail,
  Arc Mainnet's offer only, with the payee ADDRESS as agentId (`core.ts`), and the answer must
  pass `verdict.ts` (settlement echo, payee and amount echo, a finite reputation, an ALLOW or
  a WARN that agrees with its own signals). ALLOW returns the exact `vault.pay(payee, amount)`
  for the operator, WARN an `ownerPay()` hand-off unless `payOnWarn` (and nothing when the
  vault's owner and operator are one key), DENY nothing; always `executed: false`, because the
  server signs nothing (`prepare.ts`). A nonce is reserved by an insert-only `opening` row
  before the check is bought, so one signed payment reaches Gateway once; to a reader that row
  is nothing yet. Every paid check is a public row in `vtp_flows`, keyed by the check's nonce;
  a revert counts as a refusal only on the vault's typed policy errors, recovered by replaying
  the call at the block before. A flow becomes executed only when
  `POST /api/x402/gateway/flows/:flowId/receipt` shows the server a receipt it reads from
  every RPC itself, mined in a block after the one the verdict came back in (`receipt.ts`,
  over `chains/evm/receipts.ts`). Which flow a payment answers is the server's call, not the
  path's: the latest open check on its vault, payee and amount before its block. The Arc
  Acceleration Season report counts those rows through `season.ts`, timed by the payment's
  own block; a flow whose check has aged out of the Gateway log (it keeps 2000 rows, `vtp_flows`
  keeps every flow) links by the settlement its own row recorded, and the report says so.
- `src/cctp-stellar.ts` - Circle CCTP V2 between Stellar and EVM, driven directly because
  Bridge Kit has no Stellar adapter: burn, Iris attestation, mint, in both directions.
  A Stellar recipient is carried in the hook data and minted through the CctpForwarder in
  one atomic call (a direct mint to a G... account is unrecoverable). Prepared-or-executed,
  dedicated bridging keys, capped, mainnet only behind `CCTP_STELLAR_ALLOW_MAINNET`.
  Proven both ways on testnet 2026-09-10; contract ids in the registry cite Circle's page.
- `src/x402-stellar/` - the same contract on Soroban, a sibling rather than a fork. The buyer
  signs an authorization ENTRY, so there is no per-token domain to prove, and settled means
  we read the transfer event ourselves and match it to the buyer's authorization nonce. Ships
  its own facilitator; OpenZeppelin Channels is available as a fallback broadcaster.
- `src/stellar-passkey.ts` - every decision the passkey-vault endpoints make, pure and with
  no network and no Stellar SDK in scope: which network may be served at all (testnet by
  name, pubnet refused by name), which host functions the fee-sponsoring relay may forward,
  which authorization entries may ride along with them, how a KYA verdict maps onto a binary
  on-chain allowlist, and the caps on what the operator key may be made to spend.
- `src/http/stellar-passkey-routes.ts` - the thin half of that: the endpoints behind the
  public `/stellar` page (relay, vault deploy, allowlist plan, agent pay, status). Not behind
  the verified-session gate, because the owner is a passkey the browser holds rather than an
  A-Identity login. What stands in for that gate: these endpoints serve testnet alone, are
  rate-budgeted, fail closed, and cap what the operator key can be made to spend. They log no
  request body, because an authorization entry carries the passkey's own credential material.
- `src/chains/stellar/relay.ts` - the only place a relay request's XDR is decoded, into the
  plain shape below. It signs nothing, sends nothing and keeps nothing, and it never sees the
  credential behind an authorization entry as more than opaque bytes to re-encode.
- `src/chains/stellar/relay-shape.ts` - what a relay request CONTAINS, in plain strings and
  deliberately free of `@stellar/stellar-sdk` even as a type, so the half that decodes and the
  half that decides cannot drift on what an inspection looks like.
- `src/policy/` - Policy Engine v2 (pure evaluate + audit + compliance + badges + meters).
- `src/asp/` - the OKX.AI paid Trust Oracle (tools, x402 payment, proof, settlements).
  Registered listing: do not change tool schemas or prices casually.
- `src/callers/` - venue adapters (Robinhood Crypto, written ahead of integration).
- `src/contracts/` - `AgentSpendPolicy.ts` and `MerkleAirdrop.ts` are GENERATED by `npm run compile`
  from `contracts/*.sol`; do not hand-edit them (`npm run compile -- --check`, run in CI, fails
  when they differ from what the pinned solc compiles). `frontend-view.ts` renders the browser's
  copy of the vault artifact, `src/lib/contracts/agent-spend-policy.ts` (`npm run gen:contracts`),
  which /app/vault/arc deploys from.

Flat files by group: entries (`index.ts` stdio MCP, `http.ts` REST+MCP, `asp-gateway.ts` ASP,
`smoke.ts`, `http-smoke.ts`) - infra (`server.ts` tool registration, `storage.ts` persistence,
`build-stamp.ts`) - Circle rails (`gateway.ts`, `cctp.ts`, `nanopay.ts`, `appkit.ts`,
`circle.ts`, `circle-agent.ts`, `circle-cli.ts`, `paymaster.ts`) - Arc binding (`arc.ts`,
`arc-contracts.ts`) - Arc Acceleration Season (`arc-season.ts` the milestone report,
`arc-owner-vault.ts` the owner-held vault admission, `arc-vtp-run.ts` the Milestone 1 flow runner's rules) - auth (`auth.ts`, `oauth.ts`, `magic.ts`, `bot-auth.ts`) - domain
(`erc8004.ts`, `reputation.ts`, `marketplace.ts`, `data.ts`) - x402/autonomy (`x402.ts`,
`autopilot.ts`, `trust-oracle.ts`) - treasury (`treasury.ts`, `treasury-safe.ts`,
`airdrop.ts`) - AA (`aa-wallet.ts`).

## Develop

```bash
npm install
npm run build        # tsc to dist/
npm run compile      # compile contracts/*.sol -> src/contracts/*.ts (committed); -- --check compares without writing
npm run gen:contracts # write the browser copy of the vault artifact, src/lib/contracts/agent-spend-policy.ts (committed)
npm run start        # MCP server on stdio
npm run start:http   # the HTTP server (REST + /mcp). Reads config from process.env directly.
npm run smoke        # spin up the MCP server + exercise every read-only tool
npm run http-smoke   # exercise the tools over HTTP (server must be running)
npm test             # tsc + node:test unit tests (2041 across 123 files, as of Nov 2026)
npm run e2e          # full end-to-end flow against a running server (E2E_BASE=...)
```

The server does **not** auto-load `.env`. Run it with the key inline or via `--env-file`:

```bash
node --env-file=.env dist/http.js     # Node 20.6+
# or
ARC_SIGNER_KEY=0x<funded-key> node dist/http.js
```

Tests: **2041 unit tests across 123 colocated `*.test.ts` files** (as of Nov 2026; `npm test`) +
a full **E2E of about 67 checks** (`npm run e2e`) that adapts to signer presence: green with no
signer key (live Arc reads; on-chain writes reported as prepared), with the real Arc write
checks activating under a funded `ARC_SIGNER_KEY`. CI runs the no-signer path.

### Admit a vault to Milestone 1's owner-held list

`ARC_OWNER_HELD_VAULTS` in `src/arc-season.ts` takes a vault only after its deploy receipt is
checked, and `scripts/arc-owner-vault-check.mjs` is that check. It is read-only: it signs and
sends nothing. It reads the receipt from every registry RPC host (a null from one host is not an
answer), compares the deploy with the `AgentSpendPolicy` artifact, reads the vault's getters,
and prints the entry to paste, or `REFUSED` with every reason. The rules live in
`src/arc-owner-vault.ts`, unit-tested.

```bash
npm run build
node scripts/arc-owner-vault-check.mjs --tx 0x<deploy tx hash>      # admit or refuse, Arc Mainnet
node --env-file=.env scripts/arc-owner-vault-check.mjs --tx 0x...   # also compare with our env keys' addresses
node scripts/arc-owner-vault-check.mjs --tx 0x... --chain arc       # Arc Testnet rehearsal, never an entry
node scripts/arc-owner-vault-check.mjs --vault 0x<vault address>    # re-read code and state only
```

It refuses unless the owner's own wallet sent the deploy (`owner() == receipt.from`), the owner
is none of our keys, the operator is set and is not the owner, `usdc()` is the registry USDC,
`dailyCap` and `autoApproveMax` are not 0, and the session key outlives the chain's current
block time. Exit 0 admitted, 1 refused, 2 usage. The launch-day vault (deploy `0xabf41b6f`) is
refused: its owner is our operating wallet.

### Run the Milestone 1 flows

`scripts/arc-vtp-runner.mjs` runs verify-then-pay flows through the launch-day vault: each one a
settled Gateway check followed by a vault payment or a refusal. Milestone 1 needs 100. The rules
live in `src/arc-vtp-run.ts`, unit-tested with fakes. Status: built and tested with fakes; no
flow has been run with it on Arc Mainnet yet, and `/api/arc/season` is what says how many have.

```bash
npm run build && (cd ../trust-guard && npm run build)

# PREPARED, the default: reads only, signs nothing, needs no key. Prints the plan, or REFUSED.
node scripts/arc-vtp-runner.mjs --allow 25 --deny 75

# EXECUTES, with the operator key in env X402_3009_BUYER_KEY, never printed.
CONFIRM_ARC_VTP_RUN=yes node --env-file=.env scripts/arc-vtp-runner.mjs \
  --allow 25 --deny 75 --log data/arc-vtp-run.jsonl --execute

# Confirm the count on the public report.
curl -s https://a-identity.xyz/api/arc/season | jq '.milestone1.checks | {count, target, linked, unlinked}'
```

`--allow` flows pay Meridian and expect ALLOW and a `Paid` transaction. `--deny` flows name our
operating wallet (agent #0, internal) and expect `TrustDenyError`. Other flags: `--amount-units`
(default 1000, and each flow pays one unit more, so no two share an amount), `--base-url`,
`--budget` (default 0.75 USDC), `--max-fee-gwei` (default 60), `--pause-ms` (default 5000),
`--operator`, `--ack-stop`, `--ack-fresh-log`, `--reconcile`. Exit 0 fits or finished, 1 refused or
stopped, 2 usage.

- The plan refuses, naming the exact shortfall, when the budget, the Gateway balance, the vault
  balance, the daily cap or the gas balance would not cover the upper bound of the run, or when
  a payee is not expected to reach its verdict today. Gas is bounded at `--max-fee-gwei`, so
  the budget it checks is above what the run should really cost. It also refuses a check price
  other than the decided 0.005 USDC, and the signing cap never rises above that, whatever the
  server quotes.
- `--allow` and `--deny` are totals for the log, so the same command resumes. What the log counts
  as done is not run again, and what it spent counts against `--budget` across runs. Each flow's
  intent reaches the disk before it can spend, so a flow with no result costs its upper bound.
- Flows run one at a time, refusals first. The run stops at the first unexpected outcome (a WARN
  where ALLOW was expected, a Gateway or receipt failure, `recorded:false`) and never retries a
  check or a payment. A WARN leaves the prepared `ownerPay` for the owner, unsent.
- A flow expected to DENY gets a signer that cannot send, so an ALLOW there stops the run with
  nothing moved from the vault.
- When a stop leaves money unknown (a payment with no receipt, a check with no answer, a settle
  Gateway did not answer) or moved without the server recording it, the next run refuses until a
  human has looked and passes `--ack-stop`. Those flows stay in the budget at their upper bound.
- A hash in the log with no verified record is posted again before the plan on every `--execute`,
  and on its own with `--reconcile` (needs no key). That sends nothing, the server reads the chain
  itself, and the result is appended, so a payment that landed can still count. A prepared run
  writes nothing and only says how many are waiting.
- The budget, the done count and the unique amounts bind per log, so a log is not to be moved or
  replaced: repair a torn line instead. Its header line binds it to the vault and `--amount-units`,
  and a repeated amount refuses it. A new log is refused when `GET /api/x402/gateway/proof` shows
  `risk_check`s from this payer on Arc Mainnet, or cannot be read, until `--ack-fresh-log`. That
  read covers the proof's last 50 rows.
- One run per vault on this machine: the lock is `~/.a-identity/arc-vtp-<vault>.lock`, whichever
  log is named. Two machines are not covered by it. A crash leaves it held, and the message says
  what to read before deleting it.
- This script itself is tested by spawning it with every network faked
  (`src/arc-vtp-runner.test.ts`), and the route's real answers are fed to the built SDK
  (`src/verify-then-pay/sdk-contract.test.ts`). `npm test` builds trust-guard first for both.
- The SDK compares the verdict's `agentId` and `txContext` with its own inputs, so the route has to
  be deployed with those fields before a run: against an older server an ALLOW comes out as
  `CONTEXT_MISMATCH`, after the check was paid.

Each result names the flow's public record, `/api/x402/gateway/flows/<flowId>`. The log's count is
this runner's own; the season report decides what counted.

## Connect from an MCP client

The hosted server is live at `https://a-identity.xyz/mcp` over Streamable HTTP (POST
JSON-RPC, stateless; a browser GET shows how to connect):

```bash
claude mcp add --transport http a-identity https://a-identity.xyz/mcp
```

To self-host, the server also speaks stdio. Point any client at the built entry:

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
