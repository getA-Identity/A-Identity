# A-Identity roadmap

Now / next / later, in the open. "Now" means work is underway or committed for the
current cycle; dates are targets, not promises. Recently shipped is listed so the
roadmap stays honest about velocity. Updated 2026-08-09.

## Recently shipped (July-August 2026)

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
  system with the layer graph enforced by tests; 482 unit tests + full E2E suite.

## Now

- **Encode x Arc "Programmable Money"**: final submitted; Demo Day Aug 20.
- **Stellar port (phase 2 start)**: Soroban AgentSpendPolicy in Rust (SEP-41 USDC,
  daily cap + auto-approve + allowlist + freeze, owner/operator roles, typed-error
  reverts), an end-to-end bounded payment on testnet, and an agent paying a live x402
  API through policy. The chain registry already carries the Stellar descriptor.
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
- **Base as the second proven EVM chain** for the adapter (descriptor is in beta).

## Later

- **Cross-protocol settlement router**: one quote layer answering 402s with the union
  of rails we accept (x402 exact, Nanopayments, MPP session) and routing settlement.
- **Avalanche, then Solana** (phase 3/4): registry entries for EVM; one adapter plus a
  contract reimplementation for SVM.
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
