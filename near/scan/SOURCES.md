# Sources for the NEAR real-data dataset

Every row in `dataset.json` carries its own `evidence` list. This page groups those sources,
says what each one supports, and lists what was looked at and left out, with the reason.

Conventions:

- Retrieval date is 2026-11-12 (UTC) for living sources (docs, repo files, APIs). Articles,
  forum posts and reports keep their publication date.
- A quote is an exact substring of the source as fetched, with whitespace collapsed,
  curly quotes and dashes mapped to ASCII and other non-ASCII characters (emoji, the
  Tether sign) dropped. `node scan/check-citations.mjs` re-fetches every source and checks
  every quote (it compares with all whitespace removed, because some pages put no space
  between a tag and the next word).
- GitHub sources are permalinks to a commit, so the quoted line cannot move.
- NearBlocks links are for humans (the site needs a browser). The fact behind each one is
  checked on chain instead. A `nearblocks.io/txns/<hash>` quote is checked against the
  transaction as the FastNEAR transactions API returns it, rendered
  `signer <id> receiver <id> <method> <decoded args>`, and the row's account must appear in
  it; so a creation quote such as
  `signer nearrewards.near receiver near create_account {"new_account_id":"nearreward.near"`
  binds who created what. A `nearblocks.io/address/<id>` link must name the row's own account,
  and its quote is checked against that account's live `ft_metadata` (JSON-RPC).
- A quote is cut where a secret scanner would misread it: gitleaks' generic-api-key rule takes
  a label such as `Token Contracts:` or `TOKEN_ID:` followed by a 64-hex NEAR implicit id for
  a credential, so such quotes start at the id (the rekt.news list of the four fake token
  contracts) or use a second source that names the id without that label (Circle USDC in the
  NEAR Intents 1Click token list).

## 1. Live chain data (every row)

| Source | Used for |
|---|---|
| NEAR mainnet JSON-RPC: `https://rpc.mainnet.fastnear.com`, `https://free.rpc.fastnear.com` (FastNEAR), `https://near-mainnet.drpc.org` (dRPC) | `view_account` (exists, balance, code hash, storage) at finality `final`, with the block height stored in `facts.block_height`; then, pinned to that same block (`block_id`), `view_access_key_list` (full-access and function-call key counts, paginated) and `call_function ft_metadata` on contracts |
| NEAR mainnet archival JSON-RPC `https://archival-rpc.mainnet.fastnear.com` | the same reads once regular nodes have garbage-collected the block (they answer `GARBAGE_COLLECTED_BLOCK` or `UNKNOWN_BLOCK`); `spot-check.mjs` replays every row at its recorded block this way |
| FastNEAR transactions API `https://tx.main.fastnear.com/v0/account` and `/v0/transactions` | oldest transaction touching the account (`created_at`, `creation_tx`), its signer (`creator`), newest transaction (`last_tx_at`), `txs_count` |
| NearBlocks API v3 `https://api.nearblocks.io/v3/accounts/{id}/txns?signer={id}&receiver=near` | research only, not called by the build: listed the `create_account` transactions of the fake-airdrop campaign accounts (section 3.1). Powered by Nearblocks.io APIs |

`created_at` is the first transaction an indexer saw touching the account. For a named
account that is its creation; for an implicit (64-hex) account it is the first transfer
into it, and an implicit account that was deleted can be re-created by any transfer.

## 2. known_good sources

| Source | Kind | Rows |
|---|---|---|
| [ref-finance/ref-ui `src/services/config.ts`](https://github.com/ref-finance/ref-ui/blob/1938efcf29ad484735603008706ca748248d5dbc/src/services/config.ts) | the Rhea (Ref) app's own mainnet config | wrap.near, usdt.tether-token.near, v2.ref-finance.near, dclv2.ref-labs.near, boostfarm.ref-labs.near, token.v2.ref-finance.near, xtoken.ref-finance.near, contract.main.burrow.near, token.burrow.near, linear-protocol.near, meta-pool.near, USDC.e, USDT.e |
| [INTEARnear/price-indexer `src/token.rs`](https://github.com/INTEARnear/price-indexer/blob/a583f92827e1cbcb8230d903b88b69bd3cfd06b0/src/token.rs) | Intear's token reputation lists (`Reputable`, `NotFake`), written to tell real tokens from scams that imitate them | 13 token rows, as second source |
| [NEAR Intents 1Click token list](https://1click.chaindefuser.com/v0/tokens) | the token registry behind NEAR Intents' 1Click API (asset id, decimals, symbol) | 13 token rows, Circle USDC among them |
| [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses.md) | issuer page | Circle USDC `17208628...` |
| [Tether supported protocols](https://tether.to/en/supported-protocols/) | issuer page | usdt.tether-token.near |
| [Rhea guide: buy RHEA](https://guide.rhea.finance/getting-started/buy-rhea-token) | project docs | token.rhealab.near |
| [NEAR Intents verifier contract](https://docs.near-intents.org/integration/verifier-contract/introduction.md) | project docs | intents.near |
| [LiNEAR README](https://github.com/linear-protocol/LiNEAR/blob/63cd09aabbc3c28ca39ca4266647c24315ae3975/README.md) | project repo | linear-protocol.near, priceoracle.near |
| [Meta Pool contracts on NEAR](https://docs.metapool.app/master/for-developers/meta-pool-contracts/near-network) | project docs | meta-pool.near, mpdao-token.near |
| [aurora-engine README](https://github.com/aurora-is-near/aurora-engine/blob/f296f06ab618468dff58cbef81732b1d0ee1782e/README.md) | project repo | aurora |
| [Near-One/omni-bridge README](https://github.com/Near-One/omni-bridge/blob/af6d95bb4c6a9e31aba0cd9d6f0fe5f7c8cd2dc9/README.md) | project repo | omni.bridge.near, factory.bridge.near |
| [hot-dao/omni-sdk `src/env.ts`](https://github.com/hot-dao/omni-sdk/blob/ead5c13236a03a911f77a6c7b383482872b88ce7/src/env.ts) | project repo | v2_1.omni.hot.tg, intents.near |
| [hot-dao/hot-validation-sdk `core/src/lib.rs`](https://github.com/hot-dao/hot-validation-sdk/blob/76bfc3734110e16a16933a6b426f6d7a30137cc4/core/src/lib.rs) | project repo | mpc.hot.tg |
| [Meteor-Wallet/rNear-vault-public `common/near.ts`](https://github.com/Meteor-Wallet/rNear-vault-public/blob/3267548126411b700ce2b5e623312950d81395d4/common/near.ts) | wallet repo | lst.rhealab.near, contract.main.burrow.near |
| [HERE Wallet docs](https://docs.herewallet.app/llms-full.txt) | project docs | storage.herewallet.near |
| [ParasHQ/paras-landing `pages/token.js`](https://github.com/ParasHQ/paras-landing/blob/b90e20fcb8cb30bf265e123b91474dad75026bf3/pages/token.js) | project repo | token.paras.near |
| [docs.near.org: DEX primitives](https://docs.near.org/primitives/dex.md) | NEAR docs | v2.ref-finance.near, token.paras.near |
| [docs.near.org: Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures.md) | NEAR docs | v1.signer |
| [docs.near.org: contracts list](https://docs.near.org/tools/contracts-list.md) | NEAR docs | pool.near |
| [Mintbase/templates marketplace constants](https://github.com/Mintbase/templates/blob/f8dd13268fa64700cf174d298f572784e207a345/marketplace/src/config/constants.ts) | project repo | simple.market.mintbase1.near |
| [PotLock/bos-app constants](https://github.com/PotLock/bos-app/blob/7172699e7061d981819132e43b1fee62cf538d5f/apps/potlock/widget/constants.jsx) | project repo | donate.potlock.near |
| [NearSocial/social-db README](https://github.com/NearSocial/social-db/blob/b4a023d234d0f24a2cf0d4b7998ea485f90f576e/README.md) | project repo | social.near |
| [OrderlyNetwork/orderly-sdk-js environment](https://github.com/OrderlyNetwork/orderly-sdk-js/blob/2d450b4f33a84d86b62d4d9e584e688f94c7d7a4/src/smart-contract/enviroment.ts) | project repo | asset-manager.orderly-network.near |
| [OutLayer NEAR integration](https://outlayer.fastnear.com/docs/near-integration) | project docs | outlayer.near |
| [Shitzu-Apes/meme-cooking-docs developers](https://github.com/Shitzu-Apes/meme-cooking-docs/blob/89169f35cb6d6afd73aef75c7f884b2a968ae1c5/other/developers.md) | project docs | meme-cooking.near |
| [houseofstake/agora-near contract constants](https://github.com/houseofstake/agora-near/blob/2f8e3a17ee89f2fba1d19b006a65f3d6289ee272/src/lib/contractConstants.ts) | project repo | venear.dao, vote.dao |

Lead list: MimicWatch's public brand list
([`brands/near-brands.json`](https://github.com/kacpergumieniuk/mimicwatch-near/blob/0906683760d32ae0438f6ab0348b4724f23dc6c5/brands/near-brands.json),
MIT, by another NEAR HACKATHON 2026 team) pointed at most of the primary sources above.
No known_good row cites MimicWatch: each one was fetched and quoted from the primary source.

## 3. suspicious sources

### 3.1 Fake-airdrop "rewards" token campaign (7 rows)

- `researcher_dataset` (3 rows): the
  [MimicWatch README, findings of the 2026-11-01 mainnet scan](https://github.com/kacpergumieniuk/mimicwatch-near/blob/0906683760d32ae0438f6ab0348b4724f23dc6c5/README.md)
  and its evidence files for
  [linear_protocol.near](https://github.com/kacpergumieniuk/mimicwatch-near/blob/0906683760d32ae0438f6ab0348b4724f23dc6c5/evidence/account/linear_protocol.near.json),
  [metapools.near](https://github.com/kacpergumieniuk/mimicwatch-near/blob/0906683760d32ae0438f6ab0348b4724f23dc6c5/evidence/account/metapools.near.json) and
  [burrowfinancedao.near](https://github.com/kacpergumieniuk/mimicwatch-near/blob/0906683760d32ae0438f6ab0348b4724f23dc6c5/evidence/account/burrowfinancedao.near.json)
  (2026-11-01, MIT): three NEP-141 tokens named after LiNEAR, Meta Pool and Burrow, each
  advertising a lookalike website in its token name, held by thousands of accounts;
  burrowfinancedao.near created the other two. These are the only three of MimicWatch's 507
  findings it marks as fake tokens.
- `onchain_campaign_link` (4 rows, the campaign rule in README.md): accounts tied to those
  three by `create_account` transactions, directly or through another account added this
  way, and whose own `ft_metadata` name advertises a website, read on chain on 2026-11-12.
  MimicWatch does not flag any of them.

  | Row | Link (create_account transaction) |
  |---|---|
  | nearrewards.near | signed the creation of burrowfinancedao.near, [`8wR3X8jA...`](https://nearblocks.io/txns/8wR3X8jAsTXg6jPAwmkmYBadFJkV1zP79jy1qCw8S4p8) (2024-05-16); MimicWatch's evidence for burrowfinancedao.near names it as the creator |
  | nearreward.near | created by nearrewards.near, [`8XVfU6PG...`](https://nearblocks.io/txns/8XVfU6PGmFzAEEaghLFZ2ws5nD3wsC8Gon1d8PAFp9L2) (2024-09-11) |
  | dragoneggsmeme.near | created by burrowfinancedao.near, [`6G8KfH3g...`](https://nearblocks.io/txns/6G8KfH3gUqy6dm1pSVwwfLyebYAaG8DQPwRHbCgoDJXa) (2024-05-19) |
  | lonkrewards.near | created by burrowfinancedao.near, [`FHa8Kiwn...`](https://nearblocks.io/txns/FHa8Kiwn3jJDur3amYi8C2ZLvrdvBAU53v2j3dPUfaF4) (2024-05-18) |
- Context, not per-row evidence: NEAR Protocol's public warning of
  [2022-10-09](https://x.com/NEARProtocol/status/1579085051861815298): "PSA: Please be
  vigilant of unexpected tokens being airdropped to your #NEAR wallet. Do not go to links
  that appear in token names."

### 3.2 Rhea Lend exploit, April 2026 (14 rows)

- [rekt.news, "Rhea Finance - Rekt"](https://rekt.news/rhea-finance-rekt) (2026-04-21):
  attacker wallet and collector, master account, five worker accounts, four fake token
  contracts (shared code hash `BBeoVgxZC5Ce1ef7nErevX98QonNsedBFfqzep5RV1Vu`, which
  `view_account` confirms for all four), and three staging accounts in Rhea's Multichain
  Account system.
- [QuillAudits, "Rhea Finance $18.4M Slippage Exploit"](https://www.quillaudits.com/blog/hack-analysis/rhea-finance-hack)
  (2026-04-23): the same three staging accounts, listed as "MCA staging wallet".
- Four of the five worker accounts no longer exist (deleted after the attack); they stay
  listed with `exists: false`.

### 3.3 Other exploit write-ups (4 rows)

| Row | Source | Date | On-chain corroboration (2026-11-12) |
|---|---|---|---|
| 5ebc5ecc... (Skyward Finance) | [rekt.news, "Skyward Finance - REKT"](https://rekt.news/skyward-rekt/) | 2022-11-03 | the attack tx `92Gq7zeh...` is signed by this account and calls `skyward.near` with repeated `wrap.near` ids |
| 3be304b2... (SWEAT token) | Blockaid's community alert as embedded by [ourcryptotalk](https://ourcryptotalk.com/news/sweat-economy-exploit-near-protocol), and [Tekedia](https://www.tekedia.com/sweat-economy-on-near-protocol-exploited-draining-13-71b-sweat-tokens/) | 2026-04-29, 2026-05-01 | the largest exploit tx `DvrSMfY8...` is signed by this account and calls its own contract with `{"token": "token.sweat", "victim": "hodl-lockup.sweat", ...}` |
| gregoshes.near (Stader NearX) | [Stader's incident report](https://staderlabs.com/blog/stader-near-incident-report-08-16-2022) | 2022-08-16 | created on the day of the attack, last active the same day |
| 9c2a08cf... (Kangaroo Coin Flip) | [project post-mortem on the NEAR forum](https://gov.near.org/t/report-kangaroo-coin-flip-exploit-post-mortem/25445/1) | 2022-07-21 | active only from 2022-07-11 to 2022-07-15 |

The four NEAR incidents in DefiLlama's hacks API (`https://api.llama.fi/hacks`: Ref Finance
2021-08, Skyward Finance 2022-11, Rhea Lend 2026-04, Sweat Foundation 2026-04) were the
starting list; Ref Finance 2021 has no published attacker account and is not represented.

### 3.4 Victim reports on the NEAR governance forum (5 rows)

| Row | Post | Date |
|---|---|---|
| bigbank101.near | [fake NEAR Wallet app alert](https://gov.near.org/t/alert-fake-near-wallet-is-hacking-accounts/11112/1) and the victim's [confirmation](https://gov.near.org/t/alert-fake-near-wallet-is-hacking-accounts/11112/5) | 2021-12-18 |
| dolbabob.near | [victim's report](https://gov.near.org/t/alert-fake-near-wallet-is-hacking-accounts/11112/13) after a moderator [flagged the phishing site](https://gov.near.org/t/alert-fake-near-wallet-is-hacking-accounts/11112/12) | 2021-12-20 |
| 9ebef819... | [seed phrase stolen through a fake wallet site](https://gov.near.org/t/emergency-scam-stolen-near-tokens-from-my-near-wallet-via-fake-website-near-wallet-seed-phrases/18659/1) | 2022-04-10 |
| 087184b1... | [funds and NFTs stolen, first hop](https://gov.near.org/t/beware-of-scammers-in-near-protocol-chat-on-telegram/21725/1) | 2022-05-28 |
| wisdom1.near | [guild treasury drained](https://gov.near.org/t/alert-near-wallet-log-out-button-request/14521/16) | 2022-02-18 |

These are single-party reports and are marked `source_type: victim_report`. Each was checked
on chain for consistency (for example wisdom1.near was created in January 2022 and holds
about 130 NEAR, as the post says; 087184b1...'s first transaction is signed by the victim's
account, as a thief using a stolen key would produce).

## 4. Annotation source (not a label)

[MimicWatch's 2026-11-01 scan results](https://github.com/kacpergumieniuk/mimicwatch-near/blob/0906683760d32ae0438f6ab0348b4724f23dc6c5/data/scans/2026-11-01/accounts.json)
(507 existing lookalike names, MIT): when our generator finds a name MimicWatch also found,
the row gets `facts.mimicwatch_2026_11_01` with MimicWatch's label and severity. It never
changes our label: two independent generators agreeing that a name exists says nothing
about intent.

## 5. Looked at and left out

| Candidate | Why it is not in the dataset |
|---|---|
| `5c33c6...57d2` (forum, 2023-06-23) and `77479917...b5b6` (forum, 2022-05-28) | more than 500,000 and 1.5 million transactions: exchange hot wallets that received stolen funds, not scam accounts |
| `d647be68...8338` (second hop in the 2022-05-28 report) | 4,275 transactions since 2021, sends on to the exchange wallet above: most likely an exchange deposit address |
| `ceea6b0e...4557` (in Stader's report) | Stader's own recovery address, not the attacker |
| `4fefe684...0ec8` (created nearrewards.near) | deleted, so it has no token name to carry a lure (campaign rule condition 2), and the only link is the creation |
| `gtnears.near`, `gtneardev.near`, `newaccount100.near` (created by nearrewards.near) | no token metadata lure and no report |
| `titiku.near` | MimicWatch reports it registered 92 lookalike names and calls it a name collector; no theft or phishing report. Its names can appear as `lookalike_candidate` rows, with `creator: titiku.near` in facts |
| `ref-flnance.near` and MimicWatch's other "watch" names | no harm evidence; they are `lookalike_candidate` rows when the generator produces them |
| `msageerdao.near` (forum, 2023-07) | an election sybil allegation, not a payment-fraud report |
| Accounts behind the NEAR Intents exploit (2026-09/10) and the Binance-hack memecoin laundering on NEAR (Elliptic, 2026-11) | no NEAR account id published in text |
| Meta Pool's warning about an impersonating contract (TechFlow, 2026-04-23) | the contract id is not given in the text we could read |
| HAPI Protocol's NEAR proxy `proxy.hapiprotocol.near` (an on-chain malicious-address list) | the account does not exist on mainnet any more (checked 2026-11-12) |
| Intear's `/token-spam-list` endpoint | returned an empty list on 2026-11-12 |
| Phishing domains (walletnearo.com, dual-near.org, rheaswap.finance and others) | domains, not NEAR accounts |
| Competitor registries on testnet (Tripwire, Leash, BaitNet) | demo or fictional data |
