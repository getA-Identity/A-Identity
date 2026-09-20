# Security

A-Identity settles **real money on public mainnets**. This file used to open by calling it
a testnet application, which was true when it was written and has not been true for months.
The correction matters more here than in a marketing page: a reader deciding how carefully
to treat these credentials was being told the blast radius was test funds.

What is accurate today, and what the registry
([`mcp/src/chains/registry.ts`](mcp/src/chains/registry.ts)) will confirm, because it is the
single source of truth and a test fails the build if any other file disagrees:

- **13 chains, 8 of them mainnet.** Seven of those mainnets are `live` and carry our own
  traffic: OKX X Layer, Celo, Robinhood Chain, Arbitrum One, **Base**, **Stellar pubnet**
  and **Algorand**. Avalanche is the only `planned` entry, and every `beta` entry is a
  testnet mirror (Stellar, Algorand, Robinhood Chain, Celo Sepolia). Base and Stellar pubnet
  were listed here as "mainnet (`beta`)" until 2026-08-30, days after both went live and
  both started settling real value. That understated the blast radius of two keys, which is
  the only direction this document must never be wrong in.
- **Circle Arc is testnet and is still `live`.** Both statements hold; Arc being test money
  is not a statement about the seven mainnets.
- **Money moves.** x402 calls settle in real USD₮0 on X Layer, real Circle USDC on Celo,
  Arbitrum One and Base, USDG (Paxos Global Dollar) on Robinhood Chain, SEP-41 USDC on
  Stellar (pubnet since 2026-08-27, and testnet), and the Circle USDC ASA on Algorand
  mainnet (since 2026-08-30).
- **We hold no user keys.** Agent wallet keys are generated in the browser
  ([`src/components/app/agent/RegisterForm.tsx`](src/components/app/agent/RegisterForm.tsx));
  the server only ever sees public addresses. That part of the old text was and remains
  true, and it is the reason the key risk below is ours rather than our users'.
- **A human stays on the loop** for anything that deploys a contract or moves value above a
  policy ceiling.

## The keys that actually matter

Our facilitators run a "the buyer signs, we broadcast and pay the gas" model. That means
**every signer below is a hot wallet**: it sits in the host environment, it is used without
human interaction on each request, and on seven of these chains it spends real money. The
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
| `BASE_SIGNER_KEY` | Base | mainnet | **real value** |
| `ARC_MAINNET_SIGNER_KEY` | Arc Mainnet | mainnet | **real value** (USDC is the gas) |
| `AVAX_SIGNER_KEY` | Avalanche C-Chain | mainnet (`planned`) | real value if funded |
| `STELLAR_PUBNET_SIGNER_SECRET` | Stellar pubnet | mainnet | **real value** |
| `ALGORAND_MAINNET_SIGNER_MNEMONIC` | Algorand | mainnet | **real value** |
| `ARC_SIGNER_KEY` | Circle Arc | testnet | test funds |
| `CELO_SEPOLIA_SIGNER_KEY` | Celo Sepolia | testnet | test funds |
| `RHCHAIN_TESTNET_SIGNER_KEY` | Robinhood Chain Testnet | testnet | test funds |
| `ALGORAND_TESTNET_SIGNER_MNEMONIC` | Algorand Testnet | testnet | test funds |
| `STELLAR_TESTNET_SIGNER_SECRET` | Stellar Testnet | testnet | test funds |

`AVAX_SIGNER_KEY` is the only row left that is dormant, and it is dormant by funding rather
than by nature: a key set on it is a mainnet key the moment somebody sends it gas.
`ARC_MAINNET_SIGNER_KEY` stopped being dormant on 2026-09-16; on Arc the gas is USDC itself,
so funding the gas IS funding the key, and today it holds the same operator key as Base. Stellar
pubnet stopped being hypothetical on 2026-08-24, when burner keys were funded there, a
contract was deployed and 1 USDC moved through it, and it stopped being a vault-only story
on 2026-08-27, when the first x402 sale settled on that network. Those pubnet burners are
separate from `STELLAR_PUBNET_SIGNER_SECRET` and are named in
`soroban/releases/pubnet-v0.1.0.json`; the owner account among them was raised to a 2-of-3
multisig on 2026-08-25, so it is the one key in this document that a single compromise does
not spend.

### Payment-rail keys, on top of the chain signers

| Env var | What it is |
| --- | --- |
| `X402_3009_SIGNER_KEY` | Broadcaster for the EIP-3009 rail. Overrides the chain signer when set, so it can be the wallet paying gas on Robinhood Chain and Arbitrum One mainnet ([`x402-3009/engine.ts:528`](mcp/src/x402-3009/engine.ts#L528)). |
| `X402_STELLAR_TESTNET_FEE_PAYER` | Pays the network fee for every Stellar settlement we broadcast. **Live in production since 2026-08-24.** |
| `X402_STELLAR_PUBNET_FEE_PAYER` | The same role on pubnet, spending **real value** on every mainnet Stellar sale. **Set on the hosted deployment**, which `/api/x402/stellar/status` answers for itself; without it the pubnet rail is fail-closed. Since 2026-09-15 its value is the dedicated XLM-only account `GAFVDEN6BC52WWPRPINOVENMXW3FU4LCSVVVA5C67RLPG4GAK6BE4SXY`; the first two mainnet sales (2026-08-27 and 2026-08-28) were broadcast by the vault operator key, before that split. See [Stellar operational posture](#stellar-operational-posture) below. |
| `X402_STELLAR_TESTNET_OZ_KEY` / `X402_STELLAR_PUBNET_OZ_KEY` | OpenZeppelin Channels API keys, the fallback broadcaster. |
| `CCTP_EVM_SIGNER_KEY` | The only key the Stellar CCTP bridge signs with on an EVM chain. It used to fall back to that chain's own signer, so an executed bridge could burn USDC from `ARC_SIGNER_KEY`; it no longer can. Unset means every EVM step comes back prepared. |
| `CCTP_STELLAR_TESTNET_SECRET` / `CCTP_STELLAR_PUBNET_SECRET` | Dedicated Stellar bridging seeds, never the vault operator or a fee payer. The pubnet one moves **real value** once `CCTP_STELLAR_ALLOW_MAINNET=true`. |
| `CCTP_BRIDGE_OPERATORS` | Not a key, and privileged anyway: the session subjects allowed to make the server EXECUTE a bridge. Unset means nobody. Any verified session may still ask for the prepared steps, which broadcast nothing. |
| `CELO_X402_API_KEY` | Gates the Celo paid rail; without it that rail is fail-closed. |
| `X402_PAY_TO` / `X402_STELLAR_PAYTO` / `X402_ALGORAND_PAYTO` (plus the per-network `*_MAINNET_PAYTO` / `*_TESTNET_PAYTO` overrides) | Receiving addresses. Not secrets, but a wrong value sells to an account nobody controls, so treat edits as privileged. |
| `X402_ALGORAND_FACILITATOR` | Not a key at all, and worth saying so: the Algorand rail has no broadcaster of ours. It settles through the GoPlausible facilitator, which signs the fee payer, so `ALGORAND_MAINNET_SIGNER_MNEMONIC` above covers only our own writes (vault calls, funding). Pointing this at a different host changes who assembles a payment group, which makes it privileged even though it is public. |

### Service credentials

| Secret | Scope | Notes |
| --- | --- | --- |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX exchange API | A full API credential triple, used by [`asp/payment.ts`](mcp/src/asp/payment.ts). Absent from every previous version of this file. |
| `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` | Circle | `CIRCLE_ENTITY_SECRET` is the master credential for the developer-controlled wallets. **Re-registering a new entity secret orphans existing wallets** - coordinate before rotating. |
| `PIMLICO_API_KEY` | Arc bundler | With `ARC_SIGNER_KEY`, enables the account-abstraction path. |
| `RESEND_API_KEY` | Production email | Can send real email from the verified domain. |
| `AUTH_SECRET` | Session-token signing | Rotating it invalidates all live sessions. |
| `DATABASE_URL` | Postgres (Neon) | Durable platform state, settlement logs and replay guards. |

## Rotation guidance

Priority is by blast radius, and the mainnet signers now sit above everything that used to
be at the top of this list.

1. **The seven live mainnet signers** (`XLAYER_SIGNER_KEY`, `CELO_SIGNER_KEY`,
   `RHCHAIN_SIGNER_KEY`, `ARB_SIGNER_KEY`, `BASE_SIGNER_KEY`,
   `STELLAR_PUBNET_SIGNER_SECRET`, `ALGORAND_MAINNET_SIGNER_MNEMONIC`),
   `X402_3009_SIGNER_KEY` and `X402_STELLAR_PUBNET_FEE_PAYER`. These hold real value and
   sign without a human. Sweep the balance to a fresh key, set the new key in the Render env,
   redeploy, then confirm a settlement lands before considering it done. Two of them need a
   step the EVM keys do not: a fresh Stellar account has to open its USDC trustline and a
   fresh Algorand account has to opt in to the USDC ASA before either can receive anything,
   so a rotation that skips it produces failures that read as a product bug. The pubnet fee
   payer is the exception on Stellar: it holds XLM only and needs no trustline.
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
- **Postgres TLS verifies the server certificate** as of 2026-08-27. It did not before:
  `storage.ts` set `rejectUnauthorized: false` unconditionally, which keeps the encryption
  and discards the identity check, leaving the connection open to an active
  man-in-the-middle. `PGSSLROOTCERT` names a private CA and keeps the check;
  `PGSSL_ALLOW_UNVERIFIED=true` restores the old behaviour and warns on every boot.
  `node mcp/scripts/check-db-tls.mjs` reports whether a given `DATABASE_URL` verifies
  without printing it. Confirmed live against Neon on 2026-08-27.
- **Rate limiting** is a per-IP fixed window on auth challenges, the magic-link email, the
  on-chain demo endpoints and every POST that broadcasts from the shared signer. Enough to
  stop casual abuse, not a WAF.

  It was inert in production until 2026-08-27, on every endpoint, since it was written. The
  client IP comes from `X-Forwarded-For`, counted `TRUSTED_PROXY_COUNT` entries from the
  trusted end, and that default was 1 while **Render appends two hops**. So the rule picked
  Render's own inner hop, which rotates across their fleet, and a rotating key means a fresh
  bucket every few requests. It passed locally the whole time. The count is now 2, measured
  from the running service rather than assumed, and a host with a single proxy in front must
  set `TRUSTED_PROXY_COUNT=1`.

  Getting that number too HIGH used to be the dangerous direction: the lookup clamped to
  index 0, and index 0 is the entry the caller wrote, so a misconfiguration handed the
  rate-limit key to whoever was asking. A header shorter than the configured depth now falls
  back to the socket address instead. One shared bucket over-limits and is loud; a spoofable
  key is silent and unlimited.
- **No external audit.** The Soroban contract has been through free tooling we can run and
  re-run, plus an adversarial review that found and fixed real defects. That is not an audit
  and this project does not call it one. Audit finding G-1, the payee-validity gate the EVM
  `AgentSpendPolicy` was missing, has since been backported: the Solidity declares
  `InvalidPayee` and reverts with it in `pay`, `ownerPay` and `withdraw`.

## Stellar operational posture

Stellar is the chain where a contract of ours holds value, so the key layout there deserves
to be written down rather than inferred from env var names. Everything below is current as
of 2026-09-15.

- **The pubnet fee payer is an account of its own; testnet still shares one.** Since
  2026-09-15 `X402_STELLAR_PUBNET_FEE_PAYER` is the dedicated XLM-only account
  `GAFVDEN6BC52WWPRPINOVENMXW3FU4LCSVVVA5C67RLPG4GAK6BE4SXY` (local alias
  `aid-pubnet-x402-fee`). It was funded with 3 XLM, set in the Render env, and proven by the
  pubnet sale `43a97d67dad5f90a4c8dff703fb07bd9b5f17503201ffb37d5168b08bd12b2b4` at ledger
  64432240, whose source account is the new fee payer and whose fee_charged was 23479
  stroops. The vault operator `GDLAJM25YQRTIZOVZPVEM2GJ6L2I4OTZGY3HAWX3HGMPV7SM3QZONO4S`,
  which paid for the first two mainnet sales, no longer signs or pays for settlements, so
  the key that may call `vault.pay` is no longer the hot key that broadcasts every sale.

  The fee payer holds XLM only, never USDC and never a trustline, because it signs envelopes
  and nothing else. At about 0.0023 XLM a settlement its balance is the rail's runway, and a
  fee payer that cannot pay makes the rail fail closed rather than loud, so its balance is
  worth watching. Rotating it is the rotation procedure above plus one confirmed settlement.
  On testnet the overlap remains: `X402_STELLAR_TESTNET_FEE_PAYER` is still the vault
  operator `GDZXSO4AOKPSHMQZMBNEEBQNYOIF7TWDPD7K2U5VAPKFN3QIAIELTAN6`, which
  `mcp/scripts/stellar-key-roles.mjs` reports as a warning. That one is test money.

- **The owner multisig's three signers are in one keystore.** The pubnet vault owner was
  raised to a 2-of-3 multisig on 2026-08-25, which is what stops a single compromised key
  from moving the vault's balance. All three signers currently live in the same local
  keystore, so the property the multisig buys is not yet realised against an attacker who
  reaches that machine. This is audit finding D-1's residual and it is the maintainer's to
  close, by moving at least one signer somewhere else.

- **The vault has a calendar, and it is on the clock.** A Soroban contract instance is
  archived when its rent lapses, and this one only re-extends its own TTL once fewer than
  1,036,800 ledgers remain: sixty days as the contract counts them, at 17,280 ledgers a day,
  but about 67.5 days at the measured 5.625 s close. The pubnet vault's instance archives
  around **2027-01-06** unless it is touched, so the action window opens around
  **2026-10-31**. The weekly workflow
  `.github/workflows/stellar-ops.yml` goes red at 45 days remaining, and also audits
  key-role overlap and allowlist drift, so none of the three depends on anyone
  remembering. `mcp/scripts/stellar-vault-allowlist.mjs` and
  `mcp/scripts/stellar-key-roles.mjs` are the same checks, runnable by hand.

- **RPC failover is reads only, deliberately.** Each Stellar descriptor carries a primary
  RPC and one or two independent fallbacks, and a read that fails moves down the list. A
  `sendTransaction` never does: a resubmitted envelope answers `DUPLICATE` on the second
  host, and the rail would read that as a decided refusal of a payment that is in fact in
  flight. Availability is worth a retry; a wrong answer about whether money moved is not.

- **Audit decisions on the record.** D-2, D-3 and D-4 were decided on 2026-09-15 on the
  maintainer's instruction and are written up under `audit/`. Two hardening items, A3-02
  and A4-01, ship only with a redeploy rather than with a config change, so they land on
  the next one.

## Reporting

Found something? Email `security@a-identity.xyz` (or `agents@a-identity.xyz`) rather than
opening a public issue.
