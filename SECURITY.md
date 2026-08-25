# Security

A-Identity settles **real money on public mainnets**. This file used to open by calling it
a testnet application, which was true when it was written and has not been true for months.
The correction matters more here than in a marketing page: a reader deciding how carefully
to treat these credentials was being told the blast radius was test funds.

What is accurate today, and what the registry
([`mcp/src/chains/registry.ts`](mcp/src/chains/registry.ts)) will confirm, because it is the
single source of truth and a test fails the build if any other file disagrees:

- **11 chains, 7 of them mainnet.** Four mainnets are `live` and carry our own traffic:
  OKX X Layer, Celo, Robinhood Chain and Arbitrum One. Base and **Stellar pubnet** are
  `beta` on mainnet, and Avalanche is `planned`. Stellar pubnet is beta rather than live on
  purpose: a spend vault is deployed there and real USDC has moved under its policy, but no
  paid call sells there yet.
- **Circle Arc is testnet and is still the `live` phase-1 network.** Both statements hold;
  Arc being test money is not a statement about the other six.
- **Money moves.** x402 calls settle in real USD₮0 on X Layer, real Circle USDC on Celo and
  Arbitrum One, and USDG on Robinhood Chain. The Stellar rail settles SEP-41 USDC on
  testnet.
- **We hold no user keys.** Agent wallet keys are generated in the browser
  ([`src/components/app/agent/RegisterForm.tsx`](src/components/app/agent/RegisterForm.tsx));
  the server only ever sees public addresses. That part of the old text was and remains
  true, and it is the reason the key risk below is ours rather than our users'.
- **A human stays on the loop** for anything that deploys a contract or moves value above a
  policy ceiling.

## The keys that actually matter

Our facilitators run a "the buyer signs, we broadcast and pay the gas" model. That means
**every signer below is a hot wallet**: it sits in the host environment, it is used without
human interaction on each request, and on four of these chains it spends real money. The
previous version of this file listed exactly one of them and described it as test funds.

No secret is committed to git. Runtime credentials live in the host env (Render) and, for
local development, in `mcp/.env` (git-ignored). The frontend build bakes in only *public*
values, such as the WalletConnect project id.

### Chain signers, one per registry entry

| Env var | Chain | Network | Spends |
| --- | --- | --- | --- |
| `XLAYER_SIGNER_KEY` | OKX X Layer | mainnet | **real value** |
| `CELO_SIGNER_KEY` | Celo | mainnet | **real value** |
| `RHCHAIN_SIGNER_KEY` | Robinhood Chain | mainnet | **real value** |
| `ARB_SIGNER_KEY` | Arbitrum One | mainnet | **real value** |
| `BASE_SIGNER_KEY` | Base | mainnet (`beta`) | real value if funded |
| `AVAX_SIGNER_KEY` | Avalanche C-Chain | mainnet (`planned`) | real value if funded |
| `STELLAR_PUBNET_SIGNER_SECRET` | Stellar pubnet | mainnet (`beta`) | **real value** |
| `ARC_SIGNER_KEY` | Circle Arc | testnet | test funds |
| `CELO_SEPOLIA_SIGNER_KEY` | Celo Sepolia | testnet | test funds |
| `RHCHAIN_TESTNET_SIGNER_KEY` | Robinhood Chain Testnet | testnet | test funds |
| `STELLAR_TESTNET_SIGNER_SECRET` | Stellar Testnet | testnet | test funds |

The remaining `planned` / `beta` rows are not dormant by nature, only by funding. A key set
on one of them is a mainnet key the moment somebody sends it gas. Stellar pubnet stopped
being hypothetical on 2026-08-24: burner keys were funded there, a contract was deployed,
and 1 USDC moved through it. Those burners are separate from `STELLAR_PUBNET_SIGNER_SECRET`
and are named in `soroban/releases/pubnet-v0.1.0.json`.

### Payment-rail keys, on top of the chain signers

| Env var | What it is |
| --- | --- |
| `X402_3009_SIGNER_KEY` | Broadcaster for the EIP-3009 rail. Overrides the chain signer when set, so it can be the wallet paying gas on Robinhood Chain and Arbitrum One mainnet ([`x402-3009/engine.ts:528`](mcp/src/x402-3009/engine.ts#L528)). |
| `X402_STELLAR_TESTNET_FEE_PAYER` | Pays the network fee for every Stellar settlement we broadcast. **Live in production since 2026-08-24.** |
| `X402_STELLAR_PUBNET_FEE_PAYER` | The same role on pubnet. Unset today. |
| `X402_STELLAR_TESTNET_OZ_KEY` / `X402_STELLAR_PUBNET_OZ_KEY` | OpenZeppelin Channels API keys, the fallback broadcaster. |
| `CELO_X402_API_KEY` | Gates the Celo paid rail; without it that rail is fail-closed. |
| `X402_PAY_TO` / `X402_STELLAR_PAYTO` | Receiving addresses. Not secrets, but a wrong value sells to an account nobody controls, so treat edits as privileged. |

### Service credentials

| Secret | Scope | Notes |
| --- | --- | --- |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX exchange API | A full API credential triple, used by [`asp/payment.ts`](mcp/src/asp/payment.ts). Absent from every previous version of this file. |
| `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` | Circle | `CIRCLE_ENTITY_SECRET` is the master credential for the developer-controlled wallets. **Re-registering a new entity secret orphans existing wallets** — coordinate before rotating. |
| `PIMLICO_API_KEY` | Arc bundler | With `ARC_SIGNER_KEY`, enables the account-abstraction path. |
| `RESEND_API_KEY` | Production email | Can send real email from the verified domain. |
| `AUTH_SECRET` | Session-token signing | Rotating it invalidates all live sessions. |
| `DATABASE_URL` | Postgres (Neon) | Durable platform state, settlement logs and replay guards. |

## Rotation guidance

Priority is by blast radius, and the mainnet signers now sit above everything that used to
be at the top of this list.

1. **The four live mainnet signers** (`XLAYER_SIGNER_KEY`, `CELO_SIGNER_KEY`,
   `RHCHAIN_SIGNER_KEY`, `ARB_SIGNER_KEY`) and `X402_3009_SIGNER_KEY`. These hold real
   value and sign without a human. Sweep the balance to a fresh key, set the new key in the
   Render env, redeploy, then confirm a settlement lands before considering it done.
2. **`OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`.** Exchange credentials. Rotate in
   the OKX console; check the key's permission scope while you are there.
3. **`X402_STELLAR_TESTNET_FEE_PAYER`.** Test funds, but it is now spending on every
   Stellar settlement, so treat it as an active operational key rather than a spare.
4. **`RESEND_API_KEY`.** A production email credential; a leak is a phishing vector from our
   own domain.
5. **`CIRCLE_ENTITY_SECRET` / `CIRCLE_API_KEY`.** Note that a new entity secret orphans the
   existing Circle wallets; provision fresh wallets afterward.
6. **`AUTH_SECRET`.** Rotate on any suspicion; users simply sign in again.
7. **The testnet signers.** Low value, good hygiene.

Any credential that has ever been pasted into a chat, a screenshot or a shared document
should be treated as exposed regardless of where it sits in this list.

## Known limitations

Stated as they are, not as they were. Each one is a thing to fix or accept knowingly, and
the first one is tracked as an open audit finding rather than a settled decision.

- **Durable state, with one exception.** The platform blob, the x402 spent-payment set, and
  the Celo and Stellar settlement logs are all in Postgres
  ([`mcp/src/storage.ts`](mcp/src/storage.ts)), so replay protection and the double-settle
  guard survive a restart and would survive a second instance. This file previously said
  they were in-memory; that stopped being true when Neon was wired in.
  **Rate-limit buckets are still process-local** ([`mcp/src/http.ts:71`](mcp/src/http.ts#L71)),
  so a horizontally-scaled deploy would multiply every limit by the instance count.
- **The Stellar daily fee budget used to fail open, and no longer does (F-05, fixed
  2026-08-24).** `feeSpentOnDay` was written fail-closed, but the loader it called returned
  `[]` on a read error instead of saying so, so an unreachable database read as "nothing
  spent today" and the ceiling silently stopped applying. It became reachable in production
  the day the Stellar rail was switched on. The loader now returns a result that
  distinguishes *empty* from *unreadable*
  ([`storage.ts`](mcp/src/storage.ts)), and an unreadable log is charged as
  `FEE_BUDGET_UNKNOWN`
  ([`x402-stellar/settle.ts`](mcp/src/x402-stellar/settle.ts)), which spends nothing.
  Recorded here rather than deleted, because a guard that once said one thing and did
  another is worth remembering.
- **The Stellar self-broadcast path used to have no unit test (F-04, closed 2026-08-25).**
  The suite exercised the OpenZeppelin and buyer-paid paths only, so the path that spends
  our own XLM, and which the rail picks by default, ran in production untested. Twelve
  tests now drive it, including one that asserts the guard ORDER by recording the seam call
  sequence. Writing them surfaced a real defect, since fixed: a submission that threw
  returned before the settlement record was built, so a transaction that may have been in
  the ledger left no trace and its fee never reached the daily budget.
- **Transitive dependency advisories we cannot close.** Both HIGH advisories are gone: the
  frontend's axios (through WalletConnect) and `tmp` (through the `solc` devDependency) are
  pinned forward with npm `overrides`, and `bn.js` with them. The frontend tree is clean.
  The backend still carries 22 (15 moderate, 7 low), and every one of them arrives through
  `@circle-fin/*` -> `@coral-xyz/anchor` -> `@solana/web3.js`. They are left open
  deliberately, for two reasons rather than one. The fix npm proposes is a downgrade of
  `@circle-fin/app-kit` to 1.0.0, which is a breaking change to a rail that settles real
  money. And two of the leaves have no fix at all: `elliptic` has published nothing above
  the vulnerable 6.6.1, and `uuid` would need a major bump that breaks `jayson`. None of it
  is on a path we call, because we run no Solana adapter; that bounds the exposure without
  removing it. Re-check whenever Circle ships a new app-kit.
- **Postgres TLS does not verify the server certificate.**
  [`storage.ts:29`](mcp/src/storage.ts#L29) sets `rejectUnauthorized: false`, which is the
  common workaround for managed-Postgres chains and does leave the connection open to an
  active man-in-the-middle.
- **Rate limiting** is a per-IP fixed window on auth challenges, the magic-link email and the
  on-chain demo endpoints. Enough to stop casual abuse, not a WAF, and the client IP is taken
  from a proxy header (`TRUSTED_PROXY_COUNT` bounds how far it is trusted).
- **No external audit.** The Soroban contract has been through free tooling we can run and
  re-run, plus an adversarial review that found and fixed real defects. That is not an audit
  and this project does not call it one. The EVM `AgentSpendPolicy` has not had the Soroban
  port's payee-validity gate backported (audit finding G-1).

## Reporting

Found something? Email `security@a-identity.xyz` (or `agents@a-identity.xyz`) rather than
opening a public issue.
