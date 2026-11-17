# Security

A-Identity settles **real money on public mainnets**. This file used to open by calling it
a testnet application, which was true when it was written and has not been true for months.
The correction matters more here than in a marketing page: a reader deciding how carefully
to treat these credentials was being told the blast radius was test funds.

What is accurate today, and what the registry
([`mcp/src/chains/registry.ts`](mcp/src/chains/registry.ts)) will confirm, because it is the
single source of truth and a test fails the build if any other file disagrees:

- **15 chains, 9 of them mainnet.** Eight of those mainnets are `live`: Arc Mainnet,
  OKX X Layer, Celo, Robinhood Chain, Arbitrum One, **Base**, **Stellar pubnet** and
  **Algorand**; nothing of ours has sold on X Layer since OKX.AI delisted the oracle on
  2026-09-26, or on Arbitrum One since our EIP-3009 rail paused there on 2026-11-11.
  Avalanche is the only `planned` entry, and every `beta` entry is a testnet: four mirror
  a live mainnet (Stellar, Algorand, Robinhood Chain, Celo Sepolia), and NEAR Testnet,
  added on 2026-11-12 with no mainnet entry, is read-only and has no signer at all. Base
  and Stellar pubnet were listed here as "mainnet (`beta`)" until 2026-08-30, days after
  both went live and both started settling real value. That understated the blast radius
  of two keys, which is the only direction this document must never be wrong in.
- **Circle Arc testnet is still `live`, and Arc Mainnet has been live beside it since 2026-09-16.**
  Arc testnet being test money is not a statement about the eight live mainnets.
- **Money moves.** x402 calls settle in real Circle USDC on Arc Mainnet, Celo and Base,
  USDG (Paxos Global Dollar) on Robinhood Chain, SEP-41 USDC on
  Stellar (pubnet since 2026-08-27, and testnet), and the Circle USDC ASA on Algorand
  mainnet (since 2026-08-30). They settled in real Circle USDC on Arbitrum One until our
  EIP-3009 rail paused there on 2026-11-11, and in real USD₮0 on X Layer until OKX.AI
  delisted the oracle on 2026-09-26.
- **We hold no user keys.** Agent wallet keys are generated in the browser
  ([`src/components/app/agent/RegisterForm.tsx`](src/components/app/agent/RegisterForm.tsx));
  the server only ever sees public addresses. That part of the old text was and remains
  true, and it is the reason the key risk below is ours rather than our users'.
- **A human stays on the loop** for anything that deploys a contract or moves value above a
  policy ceiling.

## The keys that actually matter

Our facilitators run a "the buyer signs, we broadcast and pay the gas" model. That means
**every signer below that is set is a hot wallet**: it sits in the host environment, it is used
without human interaction on each request, and on a mainnet it spends real money. Six of the
mainnet rows and one testnet row are unset: four since 2026-11-11, and the X Layer, Celo and
Robinhood Chain Testnet signers confirmed removed by 2026-11-14 (see
[The 2026-11-11 rotation](#the-2026-11-11-rotation), which names each variable). The
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
so funding the gas IS funding the key, and until 2026-11-11 it held the same operator key as Base,
the operating wallet then, which left the server env that day and which A-Identity has since
retired because someone else holds its key (see
[The 2026-11-11 rotation](#the-2026-11-11-rotation)). Stellar
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
| `X402_3009_SIGNER_KEY` | Broadcaster for the EIP-3009 rail. Overrides the chain signer when set (`signerKey()` in [`x402-3009/engine.ts`](mcp/src/x402-3009/engine.ts)). Since 2026-11-11 its address is `0x760342469785d06Dc23F8b491a53cA2ebbEaa849`, a new random key that only pays gas: it broadcasts on Robinhood Chain and Arc Mainnet and receives nothing. The rail is paused on Base and Arbitrum One until this key has gas there. |
| `X402_3009_BUYER_KEY` / `CELO_BUYER_KEY` | Our own buyer wallet, one key under both names. It pays our own rails in self-tests, so every payment it makes is labeled internal, never external demand. Only scripts on the founder's machine read it (`mcp/.env`); it is not set on the server, which needs neither name because both addresses are committed in [`mcp/src/arc-owner-vault.ts`](mcp/src/arc-owner-vault.ts). Since 2026-11-17 its address is `0x312963475c508Eff66951b77989ca459CA41268F`, a new random key made for this role only. Until then it was `0x8C8D9cd12d8896A40cf2115Ee731258Bb4983349`, replaced as a precaution: its key sat in the same env file as the two retired keys below, while the leak behind those is traced to the personal seed they came from, and nothing shows that anyone else holds this one. The old address is not retired: it stays ours and on every internal payer list, and it is still the operator of the three launch-day vaults (session keys valid to 2027-01-15 on Arc Mainnet and 2027-01-07 on Robinhood Chain, lapsed 2026-11-15 on Arbitrum One), so do not fund those vaults. Its leftover balance is moving to the founder's wallet. |
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

1. **The live mainnet signers** (`XLAYER_SIGNER_KEY`, `CELO_SIGNER_KEY`,
   `STELLAR_PUBNET_SIGNER_SECRET`, `ALGORAND_MAINNET_SIGNER_MNEMONIC`),
   `X402_3009_SIGNER_KEY` and `X402_STELLAR_PUBNET_FEE_PAYER`, and `RHCHAIN_SIGNER_KEY`,
   `ARB_SIGNER_KEY`, `BASE_SIGNER_KEY` and `ARC_MAINNET_SIGNER_KEY` whenever they are set
   again (they left the server env on 2026-11-11). These hold real value and sign without a
   human. Sweep the balance to a fresh key, set the new key in the Render env,
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

### The 2026-11-11 rotation

Recorded here because it is the case the guidance above exists for.

- **Two addresses retired as compromised; neither is A-Identity's.**
  `0xd305607510E0Db2c95807173c7A05BEA53c1ed36`, the operating wallet until 2026-11-11, and
  `0xF43F43D8aee114a71B164e1f6214BC7625a5742D`, the Celo pay-to and the owner of Celo agent #9759
  until 2026-11-11, came from the same personal seed, and someone else holds their keys. Neither
  receives anything of ours any more. Both are on the retired list,
  [`mcp/src/chains/retired.ts`](mcp/src/chains/retired.ts), which only ever keeps protections in
  place: a vault either one owns is refused and never counts, what either one pays never counts as
  external usage, neither can be a pay-to (a rail configured with one fails closed as not
  configured), and no server signer signs with a key that derives either. Do not pay or fund either.
- **How they were taken, read on chain on 2026-11-14.**
  - An EIP-7702 delegation to the sweeper `0x33bcd6304fc165ef0bb85bd5720bc677baae4ce7`, whose only
    destination is `0xd9D6FE80E840c190dD44fcc21dE58AA5fFd4894B`, is set on `0xd305` on Base and
    Arbitrum One and on `0xF43F` on Celo, by type-4 transactions that `0xd9D6...4894B` sent itself.
    It is still set, and it forwards what reaches those addresses there.
  - What it took, all of it to `0xd9D6...4894B`: 0.000205411756177579 ETH on Arbitrum One (tx
    `0xafa4611a2b98fbaf8f1c53cdd55ad50774029cf22e810eb8890fd6f3e3ed504b`, 13:00:36 UTC on
    2026-11-01), 0.000499628214249019 ETH on Base (tx
    `0x4ddc0bd7ac976287c16d6b2d39f0395dbd44049ad35d9ac3823e98ea9cb75d28`, 13:01:41 UTC the same
    day), 0.001 ETH sent to `0xd305` on Arbitrum One on 2026-11-10 and forwarded in the same
    transaction (tx `0x3df4d8e83d491d4b8581692f5adc64788b0f5dccb975629864a1e8a9f8228f67`), and
    16.9404493575 CELO from `0xF43F` on Celo (tx
    `0x3ee846c8582dffb2bc91e41ec0c0cb8cc4ba5de184925e002a89487e13444f63`, 01:24:10 UTC on
    2026-11-11, one block after agent #9759 moved off it). In total 0.001705039970426598 ETH and
    16.9404493575 CELO. No USDC or other token was taken anywhere.
  - `0xF43F` has been delegated on Ethereum since 2026-01-28 (tx
    `0x513ae029b3bc70aff96ce6724eb428241c778470f3661466e756d33179f85964`), to an older sweeper of the
    same family that pays `0xd4a92e6763aae819473a1730aff5d2263180f6e5`, and that delegation is still
    set. So by January 2026 someone held that key, or a signature from it (the chain cannot tell
    which), months before A-Identity used the address: the leak is to be scoped from January, not
    from November.
  - We were not singled out: the same sweeper operation has delegated at least 244 accounts on Celo
    and 93 on Arbitrum One.
- **Off the server.** The four mainnet chain signer variables in the table above that held `0xd305`
  (`RHCHAIN_SIGNER_KEY`, `ARB_SIGNER_KEY`, `BASE_SIGNER_KEY` and `ARC_MAINNET_SIGNER_KEY`) were
  removed from the server env on 2026-11-11. The other three were confirmed removed by
  2026-11-14: `CELO_SIGNER_KEY` (which held `0xF43F`), `RHCHAIN_TESTNET_SIGNER_KEY` (which held
  `0xd305`) and `XLAYER_SIGNER_KEY`. No variable that holds either retired key is set on the
  server, and the backend code refuses one anyway: a signer whose key derives a retired address builds no client
  and signs nothing, with a labeled reason
  ([`mcp/src/chains/evm/client.ts`](mcp/src/chains/evm/client.ts)).
- **A new key, for gas only.** `X402_3009_SIGNER_KEY` is now
  `0x760342469785d06Dc23F8b491a53cA2ebbEaa849`: it broadcasts EIP-3009 settlements on Robinhood
  Chain and Arc Mainnet, pays their gas and receives nothing, and the rail stays paused on Base
  and Arbitrum One until it has gas there. The pay-to of the Circle Gateway and EIP-3009 rails
  moved to the founder's wallet `0xCB8824ffAF30687E36374C08eC52298b62871bdf`, which a person
  holds, at 18:35 UTC that day, and Celo's at 01:04 UTC. The Arc testnet signer `ARC_SIGNER_KEY`
  is new too: `0xCE398f99dbC1cA6Cd4901Bff294bd950CEd5055c`.
- **The rule from here.** A server key is random, derived from no seed, made for one role and
  never imported into a wallet app. Both retired addresses came from one personal seed, and
  `0xd305` held several roles at once: signer, receiver and vault owner.
- **Never copy an address from transaction history.** Lookalike addresses made to resemble ours
  sit in the histories (address poisoning), among them `0xcb88744f438b1d8f7cbafeff4eecb4a18c171bdf`
  on Arc and `0xcb88e3b2095dc7dcc67fde04b064e25633eb1bdf` on Robinhood Chain, both imitating the
  founder's wallet. Paste an address from this file or from the chain registry, never from an
  explorer's list of past transactions.
- **What `0xd305` still holds that A-Identity deployed or registered (none of it ours any more).**
  The three launch-day AgentSpendPolicy vaults, which have no owner transfer and so are retired
  (see the operator custody note in [ARCHITECTURE.md](ARCHITECTURE.md)), Arbitrum One agent
  #1259, Base agent #73232 and the platform's Arc testnet anchors: on the Arc testnet registry it
  held 61 tokens in all when read before Arc testnet agent #849980 left it on 2026-11-17. The agent
  wallet (`getAgentWallet`) of #1259 and #73232 is `0xd305` itself, so anything paid to those
  agents' wallets goes to it. The Arbitrum One vault still held
  0.01 USDC when read on 2026-11-14, and its owner, that retired address, can withdraw it at any
  time through `withdraw()` or `ownerPay()`, with no expiry; the agent key could pay it out only
  until its session key lapsed at 12:42:37 UTC on 2026-11-15. Arc Mainnet #0 and Robinhood Chain
  #0 moved from it to the founder's wallet, Arc testnet #849980 and Robinhood Chain testnet #0
  followed on 2026-11-17 (below), and Celo #9759 moved there from `0xF43F`. Past receipts
  and settlements stay attributed to the address they were paid to.
- **The identities that were still on `0xd305`, read on chain on 2026-11-16.** Arc testnet #849980
  (Meridian, the showcase agent we registered), Robinhood Chain testnet #0, Base #73232 and
  Arbitrum One #1259 were still owned by `0xd305` that day. None of their URIs has changed: three point at
  `https://a-identity.xyz/.well-known/agent-card.json` and #849980 carries its original inline
  JSON. On 2026-11-17 #849980 and testnet #0 moved to the founder's wallet, so they are ours again;
  #73232 and #1259 stay on `0xd305` as former agents, not ours. Whoever else holds the key can
  transfer those two or repoint their URIs, so a change to either that we have not announced here
  is not ours, and neither should be trusted on ownership alone.
  - *Arc testnet and Robinhood Chain testnet:* no delegation is set on `0xd305` there and it still
    held gas, so on 2026-11-17 A-Identity moved #849980 and testnet #0 to `0xCB88...1bdf` directly,
    with `transferFrom` signed by the retired key, of which A-Identity still had a copy (Arc testnet
    tx `0x477d96e371cf21d688d294818deaa9a6ce532ac14e33918de216d0648755919b`, Robinhood Chain testnet
    tx `0x1d7a948cabe05d5b7ad51040c4ef688599f9195caf9cc31809d544924472b989`). Each move cleared the
    agent wallet (`getAgentWallet` now reads the zero address), so #849980's 2026-07-10 KYA
    wallet-control proof is about a wallet it no longer declares, and the same day our oracle
    validator revoked the feedback it had written for #849980 (tx
    `0x258a45213695e716fdce2caff60bf32181f2207ef140477e6b3b809be011d6c0`).
  - *Base and Arbitrum One:* the sweeper delegation is still set, so gas sent to `0xd305` is taken
    in the same transaction. These two could move only through a sponsored EIP-7702 transaction
    that `0xd305` signs and another key pays for, and on 2026-11-17 A-Identity decided not to try:
    they are retired in place. The same day our oracle validator revoked the feedback it had written
    for each (Base tx `0x8f75a0630fdf317240209e1aeda7c82af697e0d80a9d9740822d03e7cbae5adc`,
    Arbitrum One tx `0xa20cbe45f5d856fbac1ad8dfd701c02070a1e94b9925576f8ba5e2c7618d9bdc`).
  - *`public/.well-known/agent-card.json`* no longer lists #1259 or #73232 in `registrations`, and
    lists #849980 again, with the founder's wallet as its owner. A note at the top of the card says
    that #1259 and #73232 are not ours, because someone else holds the same key, and that the card
    does not vouch for them, although their tokenURIs still point at the card. The proof pages list
    both as former agents, never as ours.

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
- **New advisories open on main, read from Dependabot on 2026-11-16.** The line above that
  says both HIGH advisories are gone was true when written; it is not now. One critical and
  four high are open, and each has a fix or a replacement:
  - *critical,* `wee_alloc` in `near/contracts/Cargo.lock`: unmaintained, with known memory
    leaks and no fixed release. Closes by moving the NEAR contracts to another allocator.
  - *high,* `zod` in `package-lock.json`, `mcp/package-lock.json` and `trust-mcp/package.json`:
    validating an oversized constrained collection can exhaust memory, a denial of service on
    any route that validates untrusted input. Fixed in 4.6.6.
  - *high,* `decode-uri-component` in `package-lock.json`: quadratic work on runs of
    percent-encoded input, also a denial of service. Fixed in 0.5.1.
  None of them touches a key or a payment path. They are named here so the list of what is
  open stays true until the bumps land.
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
- **No external audit, on any chain.** The Soroban contract has been through free tooling we can
  run and re-run, plus an adversarial review that found and fixed real defects. The Solidity
  `AgentSpendPolicy` and `MerkleAirdrop` have had internal reviews, the latest an Arc Studio AI
  review on 2026-10-30 (33 findings, none Critical or High; see `OLYMPIX_SUBMISSION.md`), and then
  went through an automated Olympix pre-audit scan, whose results came back on 2026-11-02 and are
  being answered. None of that is an audit and this project does not call it one. Internal review finding G-1, the payee-validity
  gate the EVM
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
  and sixty days of wall time too at the 5.0 s close both networks have run since
  mid-September (re-measured 2026-10-11). The pubnet vault's instance, live until ledger
  66,177,017, archives around **2026-12-25** unless it is touched, so the action window
  opens around **2026-10-26**. An earlier version of this entry said 2027-01-06 and
  2026-10-31, from a 5.625 s close measured on 2026-08-24. The weekly workflow
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
  maintainer's instruction and are written up under `audit/`. A3-02 is fixed in the v0.1.1
  contract source (2026-10-01) and reaches each vault when a v0.1.1 vault replaces it; its
  code entry is on testnet, where the SOW 2 D2 vault runs it since 2026-10-03. A4-01 (error renumbering) and D-2 option C (allowlist as a
  constructor argument) are deferred past v0.1.1, because each changes the contract
  interface.

## Reporting

Found something? Email `security@a-identity.xyz` (or `agents@a-identity.xyz`) rather than
opening a public issue.
