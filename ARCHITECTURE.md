# A-Identity - Architecture (for reviewers)

**A passport (on-chain identity) + wallet (USDC payments) for AI agents.**
An agent gets a verifiable identity, proves it controls its wallet, is given spend limits a
human sets, and can then pay other agents.

Live: **https://a-identity.xyz** · backend **https://a-identity-backend.onrender.com**.

The registry holds **13 chains**. Eight are `live`, and seven of those are mainnets carrying
our own traffic and real money: **OKX X Layer**, **Celo**, **Robinhood Chain**,
**Arbitrum One**, **Base**, **Stellar** (pubnet) and **Algorand**. The eighth live chain is
**Circle Arc** (5042002), which is a testnet, so value moving there is test value; Arc is
where phase 1 started and it still carries all three ERC-8004 registries (identity +
reputation + validation), which is what makes KYA anchorable there. No mainnet in the
registry publishes a ValidationRegistry, so KYA cannot be anchored on any of them. The four
testnet mirrors (Stellar, Algorand, Robinhood Chain, Celo Sepolia) are `beta`, and Avalanche
is the only `planned` entry. This header said "eleven registry entries" and described Stellar
pubnet as merely holding a vault until 2026-08-30; both had gone stale, and understating the
blast radius is the expensive direction for that kind of error to point.

[`mcp/src/chains/registry.ts`](mcp/src/chains/registry.ts) is the source of truth for which
chain is which, [`mcp/src/chains/provenance.ts`](mcp/src/chains/provenance.ts) is the ledger
of transactions behind each claim (served at `/proof/:rail`), and [SECURITY.md](SECURITY.md)
lists every signer and what it can spend.

Everything below is real code broadcasting real transactions - no mocks in the core flow.

---

## The flow

![A-Identity architecture - identity (ERC-8004), three enforcement layers, payment rails (x402, Nanopayments, ERC-8183 escrow, direct), and cross-chain USDC (Gateway, CCTP), all settling on Circle Arc.](docs/images/architecture.png)

*Live PNG: [a-identity.xyz/architecture.png](https://a-identity.xyz/architecture.png). Source (rendered by GitHub) below.*

```mermaid
flowchart LR
  H[Human in the tower] -->|sets limits, approves| P
  A[AI agent] -->|acts within policy| P
  subgraph Identity
    ID[ERC-8004 IdentityRegistry<br/>on-chain passport]
    KYA[ERC-8004 ValidationRegistry<br/>KYA wallet-proof attestation]
  end
  subgraph Enforcement
    P[Policy engine<br/>server pre-check]
    V[On-chain policy vault<br/>AgentSpendPolicy - reverts on Arc]
    C[Circle Agent Wallet<br/>hosted screening]
  end
  subgraph Payment rails
    X[x402<br/>on-chain pay-per-call]
    N[Circle Nanopayments<br/>gasless, batched sub-cent]
    E[ERC-8183 escrow<br/>agent-to-agent jobs]
    S[Direct USDC settlement]
  end
  subgraph Cross-chain USDC
    G[Circle Gateway<br/>unified balance]
    CC[Circle CCTP<br/>burn-and-mint]
  end
  A --> ID --> KYA
  P --> V
  P --> C
  P --> S & X & N & E
  S -->|USDC on Arc| OUT[(Arc testnet)]
  V --> OUT
  E --> OUT
  X --> OUT
  N -->|batched settlement| OUT
  OUT --> G & CC -->|native USDC| OTHER[(Base / other chains)]
```

## Three independent enforcement layers

A payment is checked in depth - a limit you set is enforced in **three** ways:

1. **Server policy engine** (`mcp/src/platform.ts`) - the pre-check: daily cap, auto-approve
   ceiling, payee allowlist, freeze, human-approval gate (00:00 UTC reset).
2. **On-chain policy vault** (`mcp/contracts/AgentSpendPolicy.sol`) - a per-agent USDC contract
   that enforces the same policy **on Arc**: an over-limit `pay()` *reverts on-chain*. This is the
   trustless source of truth; the server is only the pre-check + fallback. The vault is deployed
   with the human's real wallet as **`owner`** (freeze / override / withdraw) and, in this build,
   the **server signer as the delegated `operator`** that calls `pay()` on the agent's behalf -
   so the *limit* is trustless (the contract reverts regardless of who signs), while *initiating*
   the payment is a delegated action. Roadmap: hand the `operator` role to an agent-held key /
   Circle programmable wallet so the agent signs its own payments end-to-end.
3. **Circle Agent Wallet** (`mcp/src/circle-agent.ts`) - a hosted, Developer-Controlled wallet
   whose policy engine screens each transfer at the wallet layer (sanctions / allow-block / freeze).

`executeInstruction` routes a payment **vault → Circle → direct settlement**, each additive with a
fallback, so one layer failing never fabricates a success.

```mermaid
flowchart TD
  I[Agent asks to pay] --> S{1. Server policy engine<br/>cap, ceiling, allowlist, freeze}
  S -->|refuses| D1[DENY, nothing signed]
  S -->|allows| V{2. On-chain vault<br/>AgentSpendPolicy.pay}
  V -->|reverts: DailyCapExceeded,<br/>PayeeNotAllowed, IsFrozen,<br/>SessionKeyExpired| D2[The chain refused.<br/>Cap given back, no txHash]
  V -->|no vault configured| C{3. Circle Agent Wallet<br/>sanctions, allow-block, freeze}
  C -->|screened out| D3[Wallet layer refused]
  V -->|passes| R[Receipt required]
  C -->|passes| R
  R -->|Transfer log matches| OK[Settled]
  R -->|no matching log,<br/>or receipt times out| AMB[Ambiguous.<br/>Never marked settled]
```

Read the diagram by its refusals rather than its happy path. Each layer can say no on its
own, and the server is only the first of the three: the vault reverts whoever signs, so the
limit survives our server being wrong, compromised or simply switched off. Nothing reaches
**Settled** without a receipt carrying a matching `Transfer` log, which is why the ambiguous
arm exists at all: a payment we cannot prove settled is reported as unproven, not as done.

## Standards

```mermaid
flowchart LR
  subgraph Identity
    E8004[ERC-8004<br/>agent passport]
    KYA[KYA attestation<br/>ValidationRegistry]
    REP[Reputation<br/>ReputationRegistry]
  end
  subgraph Authority
    VAULT[AgentSpendPolicy<br/>Solidity / Soroban / Algorand Python]
  end
  subgraph Payment
    X402[x402<br/>HTTP 402 challenge]
    E3009[EIP-3009<br/>gasless buyer, we broadcast]
    SOR[Soroban auth entry]
    AVM[Algorand atomic group]
    E8183[ERC-8183<br/>escrow]
  end
  E8004 --> KYA --> REP
  REP --> VAULT
  VAULT --> X402
  X402 --> E3009
  X402 --> SOR
  X402 --> AVM
  VAULT --> E8183
```

The order matters and is the product: identity first, then a bounded authority derived from
it, and only then a payment rail. A rail is interchangeable, and three of them are drawn
here precisely because none of them is the thesis.


| Standard | Where | What it does |
|---|---|---|
| **ERC-8004** Identity | `0x8004A818…BD9e` | On-chain agent passport (ERC-724). Real `register` tx per agent. |
| **ERC-8004** Validation | `0x8004Cb1B…4272` | **KYA**: the agent signs a challenge (viem `verifyMessage`); the result is attested on the ValidationRegistry (`validationRequest` + `validationResponse=100`, tag `"kya"`). |
| **ERC-8183** Commerce | `0x0747EEf0…4583` | Agent-to-agent job escrow: create → setBudget → approve → fund → submit → complete; USDC held in escrow, released on delivery. |
| **x402** | `mcp/src/x402.ts` | HTTP-402 pay-per-call: server returns 402 + requirements, client pays USDC on Arc, server verifies on-chain (with replay protection) and serves the resource. |
| **Circle Gateway** | `mcp/src/gateway.ts` | Chain-abstracted USDC: deposit on Arc → a unified balance, then move it to Base Sepolia via the Forwarding Service (signed EIP-712 burn intent). Minted on Base in <500 ms, gaslessly. Permissionless - no Circle API key. |
| **Circle Nanopayments** | `mcp/src/nanopay.ts` | The second x402 rail: the `exact`/`GatewayWalletBatched` scheme. Buyer signs an **EIP-3009 authorization off-chain (0 gas)**; Circle Gateway verifies + credits instantly and **batches** the on-chain settlement - sub-cent USDC becomes economical. Permissionless on Arc testnet (`@circle-fin/x402-batching`); buyer balance = the same Gateway Wallet deposit (`0x0077…19b9`). |
| **Circle CCTP** | `mcp/src/cctp.ts` | Native USDC cross-chain by **burn-and-mint** (CCTPv2 via `@circle-fin/bridge-kit`): burn on Arc → attest → mint natively on Base Sepolia (never wrapped). Canonical bridge, distinct from Gateway's unified-balance forwarding. |

> Circle products used: **USDC, Wallets, Gateway, Nanopayments, CCTP** - all live on Arc testnet.

### Gated products - architecture-level (USYC, StableFX)

USYC and StableFX are enterprise-gated (access by request). Per the hackathon rules,
conceptual/architecture-level integration is accepted with no penalty. Where they fit:

- **USYC - idle-treasury yield.** An agent treasury spends in bursts; between bursts USDC
  sits idle. The policy layer parks the surplus above a liquidity floor in **USYC** (Circle's
  tokenized money-market fund) and pulls it back when spending picks up - yield without losing
  the ability to pay. Surfaced today in the *"idle USDC parks itself in USYC"* use case; the
  `AgentSpendPolicy` vault is the natural on-chain home for the park/unpark rule once access is granted.
- **StableFX - cross-currency settlement.** An agent paid in USDC that must settle a EURC
  invoice (or vice-versa) uses **StableFX** to convert at settlement time, so the bounded-authority
  policy and reputation travel across currencies for cross-border agent-to-agent commerce.

### Autonomy - the agent runs itself, bounded

`mcp/src/autopilot.ts` (`POST /api/arc/agent-run`) is the autonomous economic experience: a
human sets a budget once, then the agent makes a **burst of real gasless nanopayments** to a
service (pay-per-inference / streaming) on its own and **stops itself** the moment the next
payment would breach the budget - bounded authority, demonstrated live, no human per payment.
Each run routes a **protocol fee** (basis points of volume) to an A-Identity treasury as one
real settlement - the on-chain proof of the "fee per settlement" model.

## Verifiable on-chain proof

### Arc testnet

- **Showcase agent "Meridian"** - ERC-8004 id **#849980**, KYA attested on-chain, policy vault,
  reputation from **3 real settlements**. The score is recency-weighted, so it decays as those
  settlements age and any figure pinned in prose goes stale within days: read the live one from
  [`/api/agents/reputation?agentId=849980`](https://a-identity-backend.onrender.com/api/agents/reputation?agentId=849980),
  which also reports `settledOnchain` (3, and fixed) next to `settledEffective` (the decayed
  weight those same settlements still carry). Anchor tx:
  [`0x506b125f…`](https://testnet.arcscan.app/tx/0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54) ·
  KYA attestation: [`0x758ddbfa…`](https://testnet.arcscan.app/tx/0x758ddbfad38daeb772a37deb07e65339f13aeb393899fc7e1d2689c95adf0dad)
- **Completed ERC-8183 escrow job #155504** - full lifecycle settled on Arc.
  createJob [`0xcce5a56c…`](https://testnet.arcscan.app/tx/0xcce5a56cc0518d5760f90d11d88eb70d5097636179eb3e92903152a96a684cc5) →
  complete [`0x245f0ee7…`](https://testnet.arcscan.app/tx/0x245f0ee76a6d8dd21e8a14cbd1f489a3d80a1824113316f3b39c58c0e50f25e3)
- **Circle Gateway** - USDC deposited on Arc, then moved to **Base Sepolia gaslessly** via the
  Forwarding Service and minted there in ~6s (verified live on prod). Recipient balance on Base:
  [signer on Basescan](https://sepolia.basescan.org/address/0xd305607510E0Db2c95807173c7A05BEA53c1ed36).

### Robinhood Chain (mainnet + testnet)

The ERC-8004 registries on Robinhood Chain were **not deployed by us** - the ERC-8004 authors
put them at their canonical cross-chain addresses. What is ours is the identity minted in them.

- **Mainnet agent #0** (`eip155:4663`) - the registry's **first mint**. Mint tx:
  [`0x602ce85a…`](https://robinhoodchain.blockscout.com/tx/0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e)
  in block 34617892, owner `0xd305607510E0Db2c95807173c7A05BEA53c1ed36`, tokenURI
  [`agent-card.json`](https://a-identity.xyz/.well-known/agent-card.json) - so the card and the
  token point at each other. Identity registry
  [`0x8004a169…`](https://robinhoodchain.blockscout.com/address/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432),
  reputation
  [`0x8004BAa1…`](https://robinhoodchain.blockscout.com/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63).
  There is no ValidationRegistry in the mainnet family, so KYA is not anchorable there.
- **Testnet agent #0** (`eip155:46630`) - mint tx:
  [`0x20918ec6…`](https://explorer.testnet.chain.robinhood.com/tx/0x20918ec68186bd4aaee7c36d33d0383f1bc6a2bc921e72e3b812d034da5212fd).
  This network carries the **full canonical set** (identity + reputation + validation) at the same
  addresses as Arc; the missing ValidationRegistry implementation was deployed on 2026-08-11 by
  replaying the canonical Safe Singleton Factory calldata (`mcp/scripts/rh-testnet-deploy-8004.mjs`).
- **No canonical USDC.** Neither network publishes one, so the registry asserts none, and the
  mainnet settles in USDG (Paxos Global Dollar) instead. This line used to end "so both stay
  `beta`", which stopped being true on 2026-08-13: mainnet went live when four real USDG
  settlements landed through our own first-party facilitator, each with a receipt carrying a
  matching Transfer log. The testnet mirror stays `beta`, because test money is not live money.

### Celo mainnet

- **Agent [#9759](https://celoscan.io/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/9759)** in the
  ERC-8004 IdentityRegistry
  [`0x8004A169…`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432); reputation
  [`0x8004BAa1…`](https://celoscan.io/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63). Verified
  live on 2026-08-09 with `eth_getCode` plus real reads on both.
- **x402 in native USDC** through our own first-party Celo facilitator (EIP-3009, so the buyer pays
  no gas). Every settlement it takes is published verbatim at
  [/celo-proof](https://a-identity.xyz/celo-proof), internal traffic labeled rather than hidden.
- Celo has **no ValidationRegistry**, so KYA cannot be anchored on-chain there. We say so instead
  of implying the Arc feature set travels.

### Stellar pubnet

Not a vault sitting idle: the spend policy holds real Circle USDC *and* the Soroban x402 rail
sells on this network.

- **`AgentSpendPolicy` on pubnet** - [`CB5LYXFK…`](https://stellar.expert/explorer/public/contract/CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP),
  deployed 2026-08-24, wasm sha256 `155eb31c…9239`, byte for byte the hash the testnet vault
  carries. No upgrade entrypoint and no `initialize`: the constructor ran atomically at deploy
  and its arguments are permanent. Policy: **1 USDC per UTC day, 0.25 USDC per payment** -
  deliberately an order of magnitude under the testnet vault, because this one holds real money.
  Owner hardened to a **2-of-3 multisig** on 2026-08-25.
- **The budget was spent to its edge and then refused.** Four payments settled inside the policy
  (first [`c4a884c3…`](https://stellar.expert/explorer/public/tx/c4a884c306ee0cd76b7fb4fa245176618897687ad7fee724e2d43b72d20f3733)),
  the next was refused with the contract's own `DailyCapExceeded`, and `spent_today` came to rest
  at exactly the 1 USDC cap. A Soroban refusal fails in simulation and never reaches the ledger,
  so the typed error code is the artifact and there is no hash to link.
- **First x402 sale on mainnet** (2026-08-28):
  [`f213371c…`](https://stellar.expert/explorer/public/tx/f213371c1241968ee78170923d8c5a3bd9b32950e73bb9c563d800ab2c70ec9e),
  ledger 64155370, 0.001 USDC for `verify_agent`. The buyer signed a Soroban authorization entry
  and paid no fee; we assembled, bid the fee market's own rate and submitted, and the sale counted
  only once the SEP-41 transfer event bound to that authorization's nonce was read back.
- Full record with every hash and caveat: [`soroban/releases/pubnet-v0.1.0.json`](soroban/releases/pubnet-v0.1.0.json)
  and the `stellar` entry in [`provenance.ts`](mcp/src/chains/provenance.ts).

### Base and Arbitrum One

Both are mainnets where the canonical ERC-8004 registries were already deployed **by their
authors**; registering is permissionless, so what is ours is the agent and the rail.

- **Base agent [#73232](https://basescan.org/tx/0xb428bf8e79df3c44157c134df1858eb75fe3758b74868445c1dcd07948705bf0)**
  (2026-08-28) and the first x402 settlement in native Circle USDC,
  [`0xb59ae67c…`](https://basescan.org/tx/0xb59ae67ced56426bdc1d85a71adadb35b0db59bcffeb3ff637eba23fe49a1450) -
  the receipt carries the matching USDC `Transfer` plus the token's `AuthorizationUsed` event.
  That measurement is what the disclosed settlement fee is derived from, not a guess.
- **Arbitrum One agent #1259** and the first settlement `0x69abb8a9…` (2026-08-13), same
  first-party EIP-3009 facilitator, buyer signs and pays no gas.
- Neither family publishes a ValidationRegistry, so KYA is verified off-chain here and recorded
  rather than anchored.

### Algorand mainnet

The second non-EVM rail, live on its first mainnet sale the day it shipped (2026-08-30).

- **First x402 sale** [`YNNA54CX…`](https://allo.info/tx/YNNA54CXZGWBGL5ILYBV4K5RI26KTALIGWGXX6MJOORDAEEUPCWQ),
  round 64547231, 0.001 USDC for `verify_agent`. The buyer signs an ASA transfer with **fee zero**
  inside a pooled-fee atomic group, the GoPlausible facilitator broadcasts, and nothing counts as
  settled until our own indexer read returns the transfer. Three more sales followed the same day,
  one per remaining tool, so every tool this rail sells has a mainnet receipt.
- **`AgentSpendPolicy` application `3688854723`** (created by
  [`NFDZMQYV…`](https://allo.info/tx/NFDZMQYVEFXBNKHAWIGUODMYCRONPX655VOALPR6AAZHOMK5I5ZA)) - the
  policy's *third* implementation (Solidity, Rust/Soroban, now Algorand Python), compiled with
  puyapy 5.10.1, approval program sha256 `665c8f7e…3850`, TEAL committed next to the source. No
  update, delete or owner-transfer handler exists, so the rules cannot change after the fact. Same
  1 USDC / 0.25 USDC policy, walked through the same settle-refuse-freeze-override ladder.
- USDC here is **ASA 31566704**, a uint64 id rather than a contract address, and receiving it at
  all needs an opt-in (0.1 ALGO minimum-balance step) - Algorand's trustline equivalent, which no
  rail can remove.

## Stack

```mermaid
flowchart TD
  UI[Frontend<br/>React + Vite on Vercel] -->|same-origin /api, /mcp| BE
  AG[Agent] -->|MCP JSON-RPC| BE
  BUY[x402 buyer] -->|402 challenge, signed payload| BE
  subgraph BE[Backend on Render]
    HTTP[http/ route groups]
    PLAT[platform/ layered domain<br/>core to tasks, graph enforced by a test]
    RAILS[x402-3009 / x402-stellar / x402-algorand]
    REG[chains/registry.ts<br/>single source of truth]
    HTTP --> PLAT
    HTTP --> RAILS
    PLAT --> REG
    RAILS --> REG
  end
  BE -->|reads and writes| CH[(13 chains<br/>8 live)]
  BE -->|durable state| DB[(Postgres, JSON fallback)]
  REG -.generates.-> UI
```

Two edges in that picture are load-bearing and both are test-enforced. `platform/` is
layered, and a module may import only strictly lower layers, never `http/` and never its own
barrel. `chains/registry.ts` is the only place a chain id, an RPC or explorer host, or a
token address may live: a test generates its forbidden list from the registry itself and
fails the build if any other file under `mcp/src` restates one, so a new chain is guarded the
day it lands rather than the day someone remembers to add it.


- **Frontend** - React + Vite (Vercel). Talks to its own origin; `vercel.json` proxies `/api`, `/mcp`,
  `/health` to the backend (first-party → dodges ad-blocker false "offline").
- **Backend** - Node HTTP + **MCP** (Model Context Protocol) server (Render). REST companion for the UI,
  `/mcp` JSON-RPC for agents. Durable state via Postgres (`DATABASE_URL`), JSON-file fallback for dev.
- **Auth** - Sign-In with Ethereum (wallet) + email magic link (Resend) are *verified*; a plain guest
  session is read-only. Agent ownership is bound to a verified identity.
- **Tests / CI** - `node:test` unit suite: **1013 tests across 77 colocated `*.test.ts` files**
  (as of Aug 2026; `npm test` in `mcp/`) + a full E2E (`mcp/e2e.mjs`) of about **67 checks** that
  adapts to signer presence: live reads always run, and the on-chain write checks (x402, ERC-8183
  escrow, Gateway, **Nanopayments settle**, **CCTP burn-and-mint**) activate with a funded
  `ARC_SIGNER_KEY`. GitHub Actions runs the no-signer path.

## Honesty guardrails (we say exactly what's true)

- **KYA** = the agent **proves it controls its wallet**, recorded on-chain. It's an
  **operator/wallet-proof attestation, not** an independent third-party audit.
- **Circle** *screens* transfers; it does **not** enforce the USD spend cap - the server + the on-chain
  vault do.
- **Operator custody**: today the **server signer** is the vault `operator` that submits `pay()` on the
  agent's behalf (a delegated action); the human `owner` is the user's own wallet. The *limit* is
  trustless regardless (the contract reverts), but the agent does not yet sign its own payments -
  that's the roadmap (agent-held key / Circle programmable wallet). We say this plainly.
- **Which money is real**: Arc is a testnet, so everything in the "Arc testnet" section above is
  real tech and test money. The seven live mainnets above are not: X Layer, Celo, Robinhood
  Chain, Arbitrum One, Base, Stellar pubnet and Algorand settle real value, in small deliberate
  amounts, and [SECURITY.md](SECURITY.md) says which key spends where. This line used to read
  "Testnet: Arc testnet, test USDC" and nothing else, which was true of Arc and wrong about the
  product.
