# A-Identity roadmap

Now / next / later, in the open. "Now" means work is underway or committed for the
current cycle. Nothing below carries a target date, deliberately: a date we cannot keep
is worth less than an honest ordering, and the dates that do appear are on things that
already happened. Recently shipped is listed so the roadmap stays honest about velocity.
Updated 2026-08-30.

## Recently shipped

- **Algorand went live on its first mainnet sale** (2026-08-30): the second non-EVM
  ecosystem, entered as a registry descriptor and promoted the same day on a real
  payment rather than on a plan. x402 v2 `exact` in native Circle USDC (ASA 31566704),
  the buyer signing a fee-zero transfer inside a pooled-fee atomic group through the
  GoPlausible facilitator, so the buyer needs no ALGO for fees. Each of the four
  sellable tools has its own mainnet receipt, and no sale counts until our own indexer
  read returns the transfer. The `AgentSpendPolicy` vault landed with it as the policy's
  third implementation (Solidity, then Rust/Soroban, now Algorand Python): application
  `3688854723`, no update or delete handler, real USDC under a 1 USDC daily cap, walked
  through the same settle-refuse-freeze-override ladder as the Stellar releases.

- **The Stellar x402 rail sells on pubnet** (2026-08-28): first mainnet sale
  `f213371c...` at ledger 64155370, 0.001 USDC through our own facilitator, the buyer
  signing a Soroban authorization entry and paying no fee. Recorded with the part that
  did not work: two earlier attempts bid the 100-stroop minimum that testnet always
  accepts, lost pubnet's inclusion auction and sat invisible until they expired. The
  rail now bids the fee market's own rate with headroom. This is what turned `stellar`
  from a vault-only story into a selling rail.

- **Base went live** (2026-08-28): agent #73232 on the canonical ERC-8004 registries
  (deployed by their authors, not by us) and x402 settling in native Circle USDC through
  the same first-party EIP-3009 facilitator that serves Robinhood Chain and Arbitrum
  One. The operating wallets were funded from Stellar pubnet USDC through a NEAR Intents
  swap, and that funding trail is published rather than left as a gap.

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
  coming to rest exactly at the cap. What this release proved on its own day was the
  spend policy alone; the x402 rail followed on 2026-08-28 and the chain is `live`. The
  owner account was raised to a 2-of-3 multisig on 2026-08-25, after an audit finding
  pointed out that a permanent owner behind a single key is a single point of total loss.

- **Arbitrum One went live** (2026-08-13): agent #1259 on the canonical ERC-8004 registry,
  and x402 settling in native Circle USDC through our own EIP-3009 facilitator. That took
  the rail to two chains at once, with a per-chain fee derived from measured gas rather
  than guessed; Base became the third on 2026-08-28.

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
  system with the layer graph enforced by tests; 993 unit tests + full E2E suite.

## Now

- **Turn the two newest rails on in the hosted deployment.** Both mainnet firsts above
  were settled from an operator machine, against the same code path production runs.
  Production sells on Stellar pubnet only once its environment names that network, a
  pubnet payTo holding a USDC trustline, and a funded fee payer; on Algorand it needs the
  network named and a payTo opted in to the USDC ASA. Until each is set, that rail is
  fail-closed and says so at its own status route. Fail-closed is the behaviour we want,
  but a fail-closed rail is not a shipped one.
- **Backport the payee-validity gate to the EVM `AgentSpendPolicy`** (audit finding G-1,
  still open). The Soroban and Algorand ports refuse a payee equal to the vault itself;
  the Solidity original accepts it and burns the cap against a payment that goes nowhere.
  Three implementations of one policy model are a strength only while they agree.
- **Ops hardening**: post-event secret rotation; the backend off the free tier for demo
  reliability; and the rate-limit buckets off process-local state, which is the one piece
  of runtime state Postgres did not absorb, so a horizontally scaled deploy would still
  multiply every limit by the instance count.

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
- **A readable identity story for the non-EVM rails**. ERC-8004 is EVM-only, and neither
  Stellar nor Algorand has an agent registry we are willing to resolve against, so a
  passport on those chains is bridged from an EVM chain rather than anchored. Today that
  bridge is a sentence in the docs. Making it a pointer a buyer can check, and saying at
  the point of sale that KYA cannot be anchored there, is the next honest step rather
  than deploying a registry of our own and calling it a standard.

## Later

- **Cross-protocol settlement router**: one quote layer answering 402s with the union
  of rails we accept (x402 exact, Nanopayments, MPP session) and routing settlement.
- **Avalanche**, the only `planned` entry left in the registry. The descriptor is already
  there and the canonical ERC-8004 identity and reputation registries are already live on
  the chain, deployed by their authors. What is missing is ours: an agent on them and a
  rail pointed at them. It stays `planned` until both exist, because a descriptor is not
  an integration.
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
