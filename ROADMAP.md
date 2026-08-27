# A-Identity roadmap

Now / next / later, in the open. "Now" means work is underway or committed for the
current cycle; dates are targets, not promises. Recently shipped is listed so the
roadmap stays honest about velocity. Updated 2026-08-24.

## Recently shipped

- **Stellar testnet rail went end to end** (2026-08-15): `AgentSpendPolicy` in Rust on
  Soroban (daily cap + auto-approve ceiling + allowlist + freeze + session key, typed
  errors, no upgrade entrypoint), plus our own Soroban x402 facilitator settling in SEP-41
  USDC with the buyer signing an authorization entry and paying no network fee. Both halves
  are on the ledger: an under-limit payment settled, an over-limit one was refused on chain
  with `DailyCapExceeded`. The first non-EVM rail here, and the only one where the spend
  limit is enforced by a contract before the payment exists. Artifacts at
  `/api/proof/stellar`.

- **Stellar pubnet vault deployed** (2026-08-24): the same wasm as testnet, byte for byte,
  at `CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP`, holding real Circle USDC
  under a 1 USDC daily cap and a 0.25 USDC auto-approve ceiling, deliberately an order of
  magnitude under the testnet vault because this one holds real money. Four settlements, a
  freeze and unfreeze pair, and an owner override are on the ledger, with `spent_today`
  coming to rest exactly at the cap. The chain is `beta`, not live, because no x402 rail
  sells on pubnet: what it proves is the spend policy alone.

- **Arbitrum One went live** (2026-08-13): agent #1259 on the canonical ERC-8004 registry,
  and x402 settling in native Circle USDC through our own EIP-3009 facilitator. The rail
  now sells on two chains at once, with a per-chain fee derived from measured gas. (July-August 2026)

- Celo mainnet live (2026-08-09): ERC-8004 identity + reputation reads wired, agent #9759,
  and the trust tools selling over our own first-party x402 facilitator in native USDC.
- ERC-8004 identity on Robinhood Chain testnet (2026-08-11): the full canonical registry
  set is live there, with the missing ValidationRegistry implementation deployed by
  replaying the canonical Safe Singleton Factory calldata, and agent #0 minted.
- ERC-8004 identity on Robinhood Chain mainnet (2026-08-12): the canonical identity and
  reputation registries (deployed by the ERC-8004 authors, not by us) verified live, and
  agent **#0**, the registry's first mint, is ours. Mainnet went live on 2026-08-13 once
  the x402 rail settled there in USDG (Paxos Global Dollar), the chain publishing no
  canonical Circle USDC; the testnet stays beta as the rehearsal rail.
- Trusted agent marketplace on Arc: verify -> hire (ERC-8183 escrow) -> work -> release,
  with a composite leaderboard and public agent certificates.
- Paid Trust Oracle live on OKX.AI (X Layer mainnet): six paid x402 tools plus a free
  preview, 120 real settlements published with tx hashes at /proof.
- On-chain AgentSpendPolicy vault per agent, session keys (both vault-native and real
  ERC-4337 via a Kernel smart account), Arc Memo audit trail, Multicall3From batch
  settlement.
- Spend preflight (dry-run of the whole policy ladder with zero mutation) and a
  velocity circuit-breaker against burst spending.
- merchant_check: commerce-grade counterparty verification for agentic checkouts
  (MCP tool + REST).
- Structural hardening: the backend split into a layered platform/ + http/ module
  system with the layer graph enforced by tests; 919 unit tests + full E2E suite.

## Now

- **Sell over the Stellar rail on pubnet**: the testnet rail is switched on in production
  and the pubnet vault is deployed, but no x402 rail sells on pubnet. It needs its own
  payTo account holding a USDC trustline and its own funded fee payer, both operator-held
  keys, and a first settlement that matters. Until that exists the chain is `beta` and the
  copy says so.
- **Ops hardening**: post-event secret rotation; upgrade the backend off the free tier
  for demo reliability.

## Next

- **MPP (Machine Payments Protocol) session mode** on the main backend: open a funded
  session, make many vouchered trust checks, settle on close. Research and
  recommendation are done; prototype follows the Arc x402 rail's durable-store
  discipline.
- **X Layer payment rail to beta** (identity reads are already live) and the OKX
  payment-surface expansion (subscription-style monitoring, escrow-gated tool,
  batched settlement) bundled into one deliberate listing update.
- **Spend-preflight in the console UI** (the API is live; the Permissions screen gets
  a "would this pass?" panel).
- **Base**: the one beta EVM chain we have not wired. The canonical ERC-8004 identity and
  reputation registries ARE live there, deployed by their authors; what is missing is ours,
  which is an agent on them and a rail pointed at them. X Layer, Celo and
  both Robinhood networks already prove the adapter, so what Base needs is a deployment
  and a reason, not a first proof.

## Later

- **Cross-protocol settlement router**: one quote layer answering 402s with the union
  of rails we accept (x402 exact, Nanopayments, MPP session) and routing settlement.
- **Avalanche** (phase 3): a registry entry, since it is EVM and the adapter already
  covers it.
- **Cross-operator Sybil detection** (funder-graph provenance, beyond same-operator
  wash detection).
- **Per-party escrow signing** in the marketplace (today the platform signer is the
  escrow party; each party signing from its own wallet is the goal).
- **Frontend debt**: RegisterForm state to a single reducer; decouple the sitemap
  generator from blog.ts source text so content can be split freely.

## How to influence this

Open an issue or find us in [Discord](https://discord.gg/ak4rC3p7Tz). The rule for new
chains is in [CONTRIBUTING.md](CONTRIBUTING.md): a chain lands as a registry entry plus
at most one adapter, never as scattered special cases.
