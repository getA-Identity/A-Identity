 # Contributing and team split

Two tracks, one repo.

| Track | Owner | Scope |
| --- | --- | --- |
| **Backend / networks** | Meric | `mcp/` end to end: Arc + Circle (done, extend), then Stellar. Contract calls, wallet management, on-chain reads/writes, REST endpoints. |
| **Product / GTM** | Aybars | `src/` frontend, `docs/`, pitch, BD, marketing, distribution, content, applications. |

Keep PRs small and scoped to one track where possible. `main` stays deployable.

## Where the backend lives

Everything is in `mcp/src`. The two entry points (`index.ts` stdio, `http.ts`
REST + MCP) share the same modules:

- `arc.ts` - live Arc testnet status (JSON-RPC block reads).
- `arc-contracts.ts` - the real ERC-8004 and ERC-8183 contracts. Verbatim
  addresses, minimal ABIs, live reads (no key) and env-gated writes
  (`ARC_SIGNER_KEY`). **This is the reference for how a network integrates.**
- `circle.ts` - Circle developer platform link (env-gated ping, `CIRCLE_API_KEY`).
- `platform.ts` - the write side: agents, wallets, instructions (policy engine),
  marketplace. JSON-persisted to `mcp/data/` (gitignored).
- `erc8004.ts` - multi-chain identity provider interface (mock + rpc).

Run `cd mcp && npm run build && npm run smoke` after any change.

## Adding a network

**Do not copy `arc-contracts.ts`.** That was the pre-registry recipe and it does not
scale; Arc is now just the first descriptor served by a generic engine. Config is data,
logic is chain-agnostic. The single source of truth is
`mcp/src/chains/registry.ts`, and everything public is derived from it: the
`GET /api/chains` payload, the `get_chain_status` MCP tool (both via `CHAIN_CONFIG` in
`data.ts`), and the frontend's `src/lib/chains.ts`, which is a GENERATED file.

**Adding an EVM chain (Base, Arbitrum, Avalanche, X Layer) is a data edit:**

1. Add one **descriptor** to `mcp/src/chains/registry.ts` (CAIP-2 as the primary key,
   `evmChainId`, `cctpDomain`, RPC list, explorer, `shortName`/`color`/`role` for the
   UI, `confirmations`, `status: 'planned'`).
2. Deploy the contracts with the same salt via a deterministic factory (so the address
   matches the other chains), paste the addresses into the descriptor `contracts` block.
3. Run `cd mcp && npm run gen:chains` to regenerate the frontend module, then
   `npm test`. There is **no new adapter and no new product code**: the chain gets
   identity register, ERC-8183 escrow, USDC settlement, the AgentSpendPolicy vault and
   ERC-8004 attestation from `chains/evm/adapter.ts` for free.
4. Flip `status`: `planned` -> `beta` (team-only) -> `live`, regenerate, ship.

If adding an EVM chain requires touching anything other than the registry plus a deploy,
the abstraction is leaking. Fix the leak instead of special-casing the chain.

**Adding a non-EVM chain (Stellar, Solana) additionally needs one adapter:**

1. Descriptor with `ecosystem: 'stellar' | 'solana'`, the correct CAIP-2 reference
   (Stellar = network label, Solana = truncated genesis hash) and `evmChainId: null`.
2. A new adapter under `mcp/src/chains/<ecosystem>/` behind the same interface, using
   the native SDK (`@stellar/stellar-sdk`, `@solana/kit`), never viem. It owns exactly
   three things: address resolution/validation, balance + account reads, and
   transaction build/sign/submit.
3. Reimplement the contract in the native language (Soroban Rust / Anchor Rust) against
   a VM-neutral interface spec, and prove equivalence with shared test vectors run
   against both it and the Solidity reference.
4. Identity is the native registry (Soroban registry + SEP-10 on Stellar); the ERC-8004
   passport is bridged, not native. See `docs/chains` for the framing.
5. Document the RPC and signer env vars in `.env.example`.

`src/lib/chains.ts` is generated. Never hand-edit it: `npm test` fails if it drifts
from the registry (`mcp/src/chains/frontend-sync.test.ts`). Change the registry and
regenerate.

Golden rules that must hold for every network:

- **No autonomous key custody.** Keys are user-held; the server holds addresses,
  not secrets. Writes are env-gated and human-approved.
- **Honest status.** Live reads are labeled live; simulations are labeled
  simulated; anything unbuilt is labeled `planned`. Never fake traction.
- **Prepared-or-executed.** Every write function returns the exact call it would
  make when no signer is configured, and broadcasts only when one is.

## Env and secrets

Never commit `.env`. `.gitignore` already excludes `.env*` (except
`.env.example`), `mcp/data/`, `node_modules`, and `dist`. If a key ever lands in
a commit, rotate it immediately.

## Style

- Content rules for anything user-facing: plain ASCII punctuation only (no em
  dash, curly quotes, arrows, ellipsis, middle dot). Title Case for eyebrows,
  sentence case for body. Real stablecoins only.
- Backend: keep functions pure where possible; degrade gracefully when an RPC is
  unreachable (return a status object, do not throw into the request handler).
