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
  limit is enforced by a contract before the payment exists. Testnet only; pubnet is still
  `planned`. Artifacts at `/api/proof/stellar`.

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
  agent **#0**, the registry's first mint, is ours. Reads are wired; both networks stay
  beta because neither publishes a canonical stablecoin to settle in.
- Trusted agent marketplace on Arc: verify -> hire (ERC-8183 escrow) -> work -> release,
  with a composite leaderboard and public agent certificates.
- Paid Trust Oracle live on OKX.AI (X Layer mainnet): six x402 services, 120 real
  settlements published with tx hashes at /proof.
- On-chain AgentSpendPolicy vault per agent, session keys (both vault-native and real
  ERC-4337 via a Kernel smart account), Arc Memo audit trail, Multicall3From batch
  settlement.
- Spend preflight (dry-run of the whole policy ladder with zero mutation) and a
  velocity circuit-breaker against burst spending.
- merchant_check: commerce-grade counterparty verification for agentic checkouts
  (MCP tool + REST).
- Structural hardening: the backend split into a layered platform/ + http/ module
  system with the layer graph enforced by tests; 823 unit tests + full E2E suite.

## Now

- **Encode x Arc "Programmable Money"**: final submitted; Demo Day Aug 20.
- **Turn the Stellar rail on in production**: the code shipped (see above) but the hosted
  backend has no `X402_STELLAR_NETWORKS`, so `/api/x402/stellar/status` reports
  `configured: false` and the tool endpoints answer 501. That is the fail-closed path
  working as designed, not a bug, and it is also the reason nobody can buy over this rail
  yet. It needs a payTo account holding a USDC trustline and a funded fee payer, both
  operator-held keys.
- **Stellar pubnet (phase 2, second half)**: after the above, mainnet. A pubnet deploy of
  the vault, its own payTo and fee payer, and a first settlement that matters. Until those
  exist the pubnet descriptor stays `planned` and nothing claims otherwise.
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
- **Base**: the one beta EVM chain still carrying no ERC-8004 registry. X Layer, Celo and
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
