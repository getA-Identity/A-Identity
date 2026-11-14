# Benchmark: the NEAR verdict engine on real mainnet accounts

The A-Identity NEAR verdict engine (`near/sdk`: engine 1.1.0, policy `near-default/1`) run
read-only on NEAR mainnet against the cited dataset in `scan/dataset.json`, and scored by
`scan/score.mjs`. Every number in the main run is as measured at one block on 2026-11-12; the at-age
snapshots were collected on the days "Run at age" gives. Nothing is estimated.

`report.mjs` writes this file from `RESULTS.template.md` and the committed run files, and
`benchmark.test.mjs` fails unless the committed file is exactly what they produce. The test also
checks with its own code that each quoted scorer block is the scorer's whole output, and that the
Result, confusion, recall and lookalike stratum tables, the WARN split and the leave-self-out
numbers match the verdict files; for the at-age section, it checks every creation and replay block
in `at-age/plan.json` against the age rule, the context of every at-age snapshot, and the at-age
tables.

## Summary for quoting

On 176 NEAR mainnet accounts (all 30 `suspicious` and 46 `known_good` rows of
`scan/dataset.json` and a seeded sample of 100 of its 445 `lookalike_candidate`
rows), read-only at block 224191308 (2026-11-12), the engine issued no DENY: strict recall is
0.0% (0 of 30). Counting WARN as flagged, recall is 20.0% (6 of 30) and precision 46.2% (6 of 13),
or 40.0% (6 of 15) counting the 2 `known_good` tokens (`token.rhealab.near` and `token.v2.ref-finance.near`) that
are not warned only because they are on the engine's known list, whose entries are never compared
as lookalikes. Of the 6 catches, 4 are deleted exploit accounts, flagged for not
existing at the block, and 2 are fake airdrop tokens whose names imitate a token on
that list. All 24 misses are older than 30 days with 5 or more transactions at the block, and
19 of the 26 suspicious rows named in a report were named within 15 days of
their creation (for the 4 deleted ones, of a surviving account of the same exploit):
this benchmark observes them months to years after the incident, not at payment time.
Replayed instead at each account's own age (pre-registered in `at-age/PREREGISTRATION.md`: the first block 1 day and 7 days after its creation block, with the 4 deleted worker accounts, gone by then, counted as misses), strict precision and recall are 100.0% (2 of 2) and 6.7% (2 of 30) at 1 day and n/a (no DENY issued) and 0.0% (0 of 30) at 7 days, and cautious precision and recall are 36.1% (26 of 72) and 86.7% (26 of 30) at 1 day, where every account that exists is held as new whatever its class, and 26.8% (11 of 41) and 36.7% (11 of 30) at 7 days. The engine was not given the labels (`labels_used: false`); its known list is the
top 25 NEP-141 tokens by on-chain market cap on NearBlocks, 15 of which are
also `known_good` rows.

## Result

| Operating point | Precision | Recall | TP | FP | FN |
|---|---|---|---|---|---|
| strict: DENY counts as flagged | n/a (no DENY issued) | 0.0% (0 of 30) | 0 | 0 | 30 |
| cautious: WARN or DENY counts as flagged | 46.2% (6 of 13) | 20.0% (6 of 30) | 6 | 7 | 24 |
| strict, listed payees not exempt (leave-self-out) | n/a (no DENY issued) | 0.0% (0 of 30) | 0 | 0 | 30 |
| cautious, listed payees not exempt (leave-self-out) | 40.0% (6 of 15) | 20.0% (6 of 30) | 6 | 9 | 24 |
| strict, without the brand list (ablation) | n/a (no DENY issued) | 0.0% (0 of 30) | 0 | 0 | 30 |
| cautious, without the brand list (ablation) | 66.7% (4 of 6) | 13.3% (4 of 30) | 4 | 2 | 26 |

Positives are the 30 `suspicious` rows, negatives the 46 `known_good` rows. The first two
rows are the benchmark. The other four replay the same snapshots offline with another known list:
each payee compared with the list minus its own name (leave-self-out), and no list at all
(ablation); "The brand list" below explains both.

- **No DENY at all.** The engine's DENY rules need a fact that this data does not contain: a
  named account that does not exist, an entry on Circle's USDC blocklist, a DENY in an
  A-Identity registry (none on mainnet; one filled from these reports would score its own
  labels), or a strong lookalike of a known name that is younger than 72 hours. Every
  suspicious account that still exists is older than 30 days at the block, none is on the USDC
  blocklist, and the 4 deleted ones are implicit (hex) accounts, for which absence is a
  soft warning, not a DENY.
- **What was flagged.** Of the 6 suspicious rows flagged, 4 are deleted Rhea
  Lend worker accounts, flagged because they do not exist at the block, and 2 are
  fake airdrop tokens whose names imitate a token on the brand list. None was flagged for anything
  it did.
- **What was missed.** The 24 misses are exploit, theft and lure accounts created between
  2021 and April 2026. At the block each one is older than 30 days with 5 or more
  transactions (`long_history`), and nothing about them changed in the 72 hours before it. By the
  dataset's `last_tx_at`, 8 of the 24 last transacted before 2025. The engine
  warns on newness, recent change, thin history, lookalike names and missing data; nothing it reads
  on mainnet records that an account was reported.
- **False positives.** Of the 7, 2 are contract upgrades inside the 72-hour window
  (the rule holds such a payment for one owner tap on purpose), and 5 are `token.*`
  contracts that the weak role-label rule matches to a `token.*` account on the brand list. Any of the 3
  listed ones (`token.rhealab.near`, rank 7; `token.v2.ref-finance.near`, rank 17; `token.publicailab.near`, rank 23) gives that same match; the engine names `token.publicailab.near` only
  because it breaks ties between equal matches in sorted order, and neither removing it nor keeping
  only the top 10 removes these false positives (list sensitivity, below). The list also holds
  2 `known_good` `token.*` contracts, `token.rhealab.near` and `token.v2.ref-finance.near`, that would match too;
  they are not warned only because a listed payee is never compared as a lookalike (the
  leave-self-out rows).

The engine's rules target a payee that is new, changed in the last 72 hours, or a fresh
lookalike of a name the owner knows (`sdk/README.md`, decision table). At the benchmark block
(2026-11-12) every suspicious account that exists is more than 30 days old with 5 or more
transactions (`long_history`). Most were named within days of their creation (19 of the
26 reported rows within 15 days), so this benchmark observes them months to years after
the incident, not at payment time.

| Days from creation to the earliest report that names the account | Rows | Observed | By source |
|---|---|---|---|
| 0 to 15 | 19 | 0 to 15 | 14 `security_writeup`, 3 `victim_report`, 2 `project_incident_report` |
| 16 to 60 | 4 | 27 to 34 | 2 `security_writeup`, 2 `victim_report` |
| more than 60 | 3 | 897 to 899 | 3 `researcher_dataset` |
| no dated report: linked on chain to the lure campaign | 4 | | 4 `onchain_campaign_link` |

Creation is the row's `facts.created_at`, and the report date is the earliest `date` in its
`evidence`; "Every suspicious row" gives the number for each row. The 4 deleted worker
accounts have no creation date in the dataset, so they are counted from 2026-04-16, the
creation of `d39fd6da...f473`, the one account named in the same sentence of the same report that
still exists. "At payment age" below replays every scored account at the first block 1 day and
7 days after its own creation block instead.

## Run

| | |
|---|---|
| Date | 2026-11-12. Snapshots collected from 08:46:47 to 09:06:11 (UTC), keyless (no `FASTNEAR_API_KEY`, no `NEARBLOCKS_API_KEY`) |
| Network | NEAR mainnet, read-only: JSON-RPC view queries and indexer queries. Nothing signed or sent |
| Block | every account pinned to block **224191308** (hash `4j4GE1M9LMLopGTKQBHXQ48k2kHbLCLq62BuxA6osDFE`, 2026-11-12T08:46:40.012Z) |
| Probe blocks | 72 h line: block 223743655 (2026-11-09T08:43:20.941Z); 30-day line: block 219793567 (2026-10-13T08:41:47.862Z) (the same for every account that exists) |
| Dataset blocks | the dataset checked its rows at blocks 224151709 to 224153995 (`facts.block_height`), about 6 hours earlier; each verdict entry records both as `block` and `dataset_block_height` |
| Engine | `a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0)` |
| Rows run | 46 known_good, 30 suspicious and 100 of the 445 lookalike_candidate rows: 176 accounts |
| Missing data | none: no verdict was saved with an unanswered read or a missing-data warning. One account (`metapoo.near`) was collected twice, because its first 72-hour key read got no answer |
| Re-collection | for 8 accounts (`wrap.near`, `linear_protocol.near`, `outlayer.near`, `token.paras.near`, `839810a1...60f2`, `rhea000505.multica.near`, `1ntents.near`, `metapool-dao.near`), the plain CLI at the same block (command below) gave the same verdict, reasons, score and `chain_sha256` as the committed snapshot |

Requests per host, from the runner's console output (the 4-account trial run included). These
counts are not part of the snapshots and cannot be re-derived offline.

| Host | Requests sent | 429 answers | Requests skipped while the host cooled down |
|---|---|---|---|
| `rpc.mainnet.fastnear.com` | 835 | 19 | 53 |
| `near.drpc.org` | 72 | 0 | 0 |
| `archival-rpc.mainnet.fastnear.com` | 597 | 70 | 67 |
| `archival-rpc.mainnet.near.org` | 32 | 19 | 105 |
| `tx.main.fastnear.com` (FastNEAR transactions API) | 354 | 0 | 0 |
| `api.nearblocks.io` | 68 | 0 | 0 |

The runner keeps a minimum gap per host (500 ms on FastNEAR RPC, 170 ms on dRPC, 3.5 s on the
near.org archival host, 750 ms on the FastNEAR transactions API, 10.5 s on NearBlocks, which
documents 6 keyless calls a minute). After a 429 or a 5xx a host cools down for 4 s, doubling
up to 2 minutes; while it does, JSON-RPC reads go to the next host in the SDK's failover list,
and indexer reads wait. Reads of a block by height are memoized, because a final block never
changes and every account at one pinned block searches the same probe blocks.

## What the engine read, and what it did not

The runner gives the engine four inputs: the account id, the network, the block and the
25 names in `known-brands.json`. It reads `scan/dataset.json` only to choose the accounts and
draw the sample.

| Signal | State | Why |
|---|---|---|
| account state, access keys, archival probes at 72 h and 30 days, key and code changes since the 72 h probe | on | chain facts at the block |
| FastNEAR transactions (the 5 oldest, cut at the block); NearBlocks as fallback and for contract deployments | on | activity, bounded by the block |
| Circle USDC `is_blocklisted` and `storage_balance_of` | on | issuer data, not built from the labels |
| ERC-8004 identity and reputation (Arras's registries) | on | permissionless, not built from the labels; no account in the run owns an identity |
| lookalike against `known-brands.json` | on | the fixed list below. A payee whose own name is on the list is never compared as a lookalike; it gets the `known_payee` info reason instead |
| other teams' registries (MimicWatch, Tripwire, near-leash, Leash commons) | off | MimicWatch's 2026-11-01 scan is the source of the three `researcher_dataset` rows; the others list testnet demo data |
| A-Identity registry: verdicts and open reports | off | not deployed on mainnet, and one filled from these reports would score its own labels |
| vault: prior payments, refusals, owner allowlist | off | a benchmark payee has no owner history |

Every snapshot records this context, and `benchmark.test.mjs` checks it on all
176: the known list equals `known-brands.json`, no third-party registry, no registry,
no vault, mainnet reads only, one block. The three verdict files declare `labels_used: false`, and
their entries carry no label.

### The brand list

Lookalike detection compares a payee with a known list; with an empty list there is nothing to
compare with. The list is fixed by a rule that does not look at the dataset: the first
25 NEP-141 tokens of NearBlocks' token list ordered by on-chain market cap, fetched once
(`GET https://api.nearblocks.io/v1/fts?page=1&per_page=25&sort=onchain_market_cap&order=desc`,
2026-11-12T08:38:33Z; Powered by Nearblocks.io APIs). The rule was written before the fetch and
before any benchmark verdict, and the answer was not edited.

Its content is not independent of the dataset, and that is stated here rather than hidden:
15 of the 25 are `known_good` rows (the largest tokens are also what the dataset
calls known good). The 2 caught fake tokens imitate `meta-pool.near` (rank 5) and `linear-protocol.near` (rank 6).

The engine reads the list in two ways, and two offline replays of the same 176 snapshots
separate them:

- **Lookalike matching.** Every payee that is not on the list is compared with every name on it.
  `verdicts.no-known.json` replays with an empty list: 2 fewer true positives (the
  caught fake tokens; no other suspicious row changes), 5 fewer false positives and
  10 fewer lookalike rows warned.
- **The exemption of listed payees.** A payee whose own name is on the list is never compared as
  a lookalike (`sdk/src/engine/normalize.ts`: `isKnown ? null : findLookalike(...)`); it gets the
  `known_payee` info reason instead. That protects 15 of the 46 negatives, the
  `known_good` rows on the list. The ablation cannot show this, because an empty list turns
  lookalike matching off altogether. `verdicts.leave-self-out.json` replays each account with the
  list minus its own name. It does the same for every account and reads no label, so only the
  15 accounts whose own name is on the list can change. Of those, 2 `known_good`
  rows, `token.rhealab.near` and `token.v2.ref-finance.near`, are not warned only because a listed payee is never compared as a
  lookalike; counted, cautious precision would be 40.0% (6 of 15) instead of 46.2% (6 of 13).

| Account | Rank | As run | Leave-self-out | Match in the replay |
|---|---|---|---|---|
| `token.rhealab.near` | 7 | ALLOW 680 (`known_payee`, info) | WARN 499 | weak `parent_swap` with `token.publicailab.near` |
| `token.v2.ref-finance.near` | 17 | ALLOW 680 (`known_payee`, info) | WARN 499 | weak `parent_swap` with `token.publicailab.near` |

| Rank | Account | Symbol | Dataset row |
|---|---|---|---|
| 1 | `usdt.tether-token.near` | USDt | known_good |
| 2 | `zec.omft.near` | ZEC | known_good |
| 3 | `wrap.near` | wNEAR | known_good |
| 4 | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | USDC | known_good |
| 5 | `meta-pool.near` | STNEAR | known_good |
| 6 | `linear-protocol.near` | LINEAR | known_good |
| 7 | `token.rhealab.near` | RHEA | known_good |
| 8 | `aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near` | AURORA | known_good |
| 9 | `eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` | USDC | not in the dataset |
| 10 | `walc.near` | WALC | not in the dataset |
| 11 | `a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near` | USDC.e | known_good |
| 12 | `eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near` | USDT | not in the dataset |
| 13 | `nbtc.bridge.near` | NBTC | known_good |
| 14 | `near20.margaritafinance.near` | NEAR20 | not in the dataset |
| 15 | `mpdao-token.near` | mpDAO | known_good |
| 16 | `btc.omft.near` | BTC | not in the dataset |
| 17 | `token.v2.ref-finance.near` | REF | known_good |
| 18 | `eth.bridge.near` | ETH | known_good |
| 19 | `eth.omft.near` | ETH | not in the dataset |
| 20 | `far-token.fewandfar-protocol.near` | FAR | not in the dataset |
| 21 | `meta-token.near` | $META | not in the dataset |
| 22 | `dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near` | USDT.e | known_good |
| 23 | `token.publicailab.near` | PUBLIC | not in the dataset |
| 24 | `usn` | USN | not in the dataset |
| 25 | `npro.nearmobile.near` | NPRO | known_good |

### List sensitivity

The same snapshots, replayed offline with known lists cut from the same ranking (`report.mjs`
computes these; no network). They show whether the `token.*` false positives depend on
`token.publicailab.near`, the name the engine happens to report.

| Known list | Cautious precision | Cautious recall | FP | `token.*` FP | Matched to |
|---|---|---|---|---|---|
| the 25, as run | 46.2% (6 of 13) | 20.0% (6 of 30) | 7 | 5 | `token.publicailab.near` |
| the 25, each payee's own name left out (leave-self-out) | 40.0% (6 of 15) | 20.0% (6 of 30) | 9 | 7 | `token.publicailab.near` |
| the 25 without `token.publicailab.near` (rank 23) | 46.2% (6 of 13) | 20.0% (6 of 30) | 7 | 5 | `token.rhealab.near` |
| the top 10 (ranks 1 to 10) | 42.9% (6 of 14) | 20.0% (6 of 30) | 8 | 6 | `token.rhealab.near` |
| none (ablation) | 66.7% (4 of 6) | 13.3% (4 of 30) | 2 | 0 | none |

Without `token.publicailab.near` the same false positives are matched to `token.rhealab.near`. With only the top
10, the 5 stay and `token.v2.ref-finance.near`, no longer on the list and so no longer exempt, adds
to them (6 in all). No list gives a DENY, so strict precision is n/a and strict
recall 0.0% (0 of 30) on each.

## Scorer output, verbatim

```
$ node scan/score.mjs scan/benchmark/verdicts.json
engine: a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0); signals: account_state, access_keys, age_archival_probes, key_and_code_changes, activity_fastnear, nearblocks_fallback, usdc_blocklist, erc8004, lookalike_fixed_brands; labels_used: false
rows: 30 suspicious (positives), 46 known_good (negatives), 445 lookalike_candidate (not scored)
strict (DENY): precision n/a, recall 0.0% (tp 0, fp 0, fn 30)
cautious (WARN or DENY): precision 46.2%, recall 20.0% (tp 6, fp 7, fn 24)
missed suspicious (24):
  ALLOW 087184b14c3cad5de72090c4a48816d46e53f39454df13b957e14350793b18e7 [theft_receiver, victim_report]
  ALLOW 31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540 [exploiter, security_writeup]
  ALLOW 3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018 [exploiter, security_writeup]
  ALLOW 5ebc5ecca14a44175464d0e6a7d3b2a6890229cd5f19cfb29ce8b1651fd58d39 [exploiter, security_writeup]
  ALLOW 72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5 [exploiter, security_writeup]
  ALLOW 7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640 [exploit_fake_token, security_writeup]
  ALLOW 80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705 [exploit_fake_token, security_writeup]
  ALLOW 9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee [exploit_fake_token, security_writeup]
  ALLOW 9c2a08cf1d06716bb03c662ed67096ea92cedacf058d50e1dea60ff442cf6180 [exploiter, project_incident_report]
  ALLOW 9ebef819489ae5e6641cc5573740dadc751c35c3ae37c110e4fad8101494e418 [phishing_receiver, victim_report]
  ALLOW bigbank101.near [phishing_receiver, victim_report]
  ALLOW burrowfinancedao.near [fake_airdrop_token, researcher_dataset]
  ALLOW c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163 [exploit_fake_token, security_writeup]
  ALLOW d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473 [exploiter, security_writeup]
  ALLOW dolbabob.near [phishing_receiver, victim_report]
  ALLOW dragoneggsmeme.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW gregoshes.near [exploiter, project_incident_report]
  ALLOW lonkrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW nearreward.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW nearrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW rhea000453.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000462.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000505.multica.near [exploit_staging, security_writeup]
  ALLOW wisdom1.near [theft_receiver, victim_report]
flagged known_good (7):
  WARN  outlayer.near [compute]
  WARN  token.0xshitzu.near [token]
  WARN  token.burrow.near [token]
  WARN  token.lonkingnearbackto2024.near [token]
  WARN  token.paras.near [token]
  WARN  token.sweat [token]
  WARN  v1.signer [chain_signatures]
lookalike_candidate verdicts: {"WARN":66,"ALLOW":34,"NONE":345}
  created after the brand: {"WARN":49,"ALLOW":21,"NONE":230}; before it: {"NONE":115,"WARN":17,"ALLOW":13}; unknown: {}
  over-blocking flags: DENY on brand-created names 0, DENY on names older than the brand 0
```

`NONE` in the lookalike lines counts the 345 lookalike rows outside the sample.

Leave-self-out, the same snapshots with each payee's own name left out of the known list:

```
$ node scan/score.mjs scan/benchmark/verdicts.leave-self-out.json
engine: a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0); signals: account_state, access_keys, age_archival_probes, key_and_code_changes, activity_fastnear, nearblocks_fallback, usdc_blocklist, erc8004, lookalike_fixed_brands_minus_self; labels_used: false
rows: 30 suspicious (positives), 46 known_good (negatives), 445 lookalike_candidate (not scored)
strict (DENY): precision n/a, recall 0.0% (tp 0, fp 0, fn 30)
cautious (WARN or DENY): precision 40.0%, recall 20.0% (tp 6, fp 9, fn 24)
missed suspicious (24):
  ALLOW 087184b14c3cad5de72090c4a48816d46e53f39454df13b957e14350793b18e7 [theft_receiver, victim_report]
  ALLOW 31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540 [exploiter, security_writeup]
  ALLOW 3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018 [exploiter, security_writeup]
  ALLOW 5ebc5ecca14a44175464d0e6a7d3b2a6890229cd5f19cfb29ce8b1651fd58d39 [exploiter, security_writeup]
  ALLOW 72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5 [exploiter, security_writeup]
  ALLOW 7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640 [exploit_fake_token, security_writeup]
  ALLOW 80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705 [exploit_fake_token, security_writeup]
  ALLOW 9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee [exploit_fake_token, security_writeup]
  ALLOW 9c2a08cf1d06716bb03c662ed67096ea92cedacf058d50e1dea60ff442cf6180 [exploiter, project_incident_report]
  ALLOW 9ebef819489ae5e6641cc5573740dadc751c35c3ae37c110e4fad8101494e418 [phishing_receiver, victim_report]
  ALLOW bigbank101.near [phishing_receiver, victim_report]
  ALLOW burrowfinancedao.near [fake_airdrop_token, researcher_dataset]
  ALLOW c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163 [exploit_fake_token, security_writeup]
  ALLOW d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473 [exploiter, security_writeup]
  ALLOW dolbabob.near [phishing_receiver, victim_report]
  ALLOW dragoneggsmeme.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW gregoshes.near [exploiter, project_incident_report]
  ALLOW lonkrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW nearreward.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW nearrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW rhea000453.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000462.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000505.multica.near [exploit_staging, security_writeup]
  ALLOW wisdom1.near [theft_receiver, victim_report]
flagged known_good (9):
  WARN  outlayer.near [compute]
  WARN  token.0xshitzu.near [token]
  WARN  token.burrow.near [token]
  WARN  token.lonkingnearbackto2024.near [token]
  WARN  token.paras.near [token]
  WARN  token.rhealab.near [token]
  WARN  token.sweat [token]
  WARN  token.v2.ref-finance.near [token]
  WARN  v1.signer [chain_signatures]
lookalike_candidate verdicts: {"WARN":66,"ALLOW":34,"NONE":345}
  created after the brand: {"WARN":49,"ALLOW":21,"NONE":230}; before it: {"NONE":115,"WARN":17,"ALLOW":13}; unknown: {}
  over-blocking flags: DENY on brand-created names 0, DENY on names older than the brand 0
```

The ablation, the same snapshots with an empty known list:

```
$ node scan/score.mjs scan/benchmark/verdicts.no-known.json
engine: a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0); signals: account_state, access_keys, age_archival_probes, key_and_code_changes, activity_fastnear, nearblocks_fallback, usdc_blocklist, erc8004; labels_used: false
rows: 30 suspicious (positives), 46 known_good (negatives), 445 lookalike_candidate (not scored)
strict (DENY): precision n/a, recall 0.0% (tp 0, fp 0, fn 30)
cautious (WARN or DENY): precision 66.7%, recall 13.3% (tp 4, fp 2, fn 26)
missed suspicious (26):
  ALLOW 087184b14c3cad5de72090c4a48816d46e53f39454df13b957e14350793b18e7 [theft_receiver, victim_report]
  ALLOW 31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540 [exploiter, security_writeup]
  ALLOW 3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018 [exploiter, security_writeup]
  ALLOW 5ebc5ecca14a44175464d0e6a7d3b2a6890229cd5f19cfb29ce8b1651fd58d39 [exploiter, security_writeup]
  ALLOW 72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5 [exploiter, security_writeup]
  ALLOW 7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640 [exploit_fake_token, security_writeup]
  ALLOW 80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705 [exploit_fake_token, security_writeup]
  ALLOW 9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee [exploit_fake_token, security_writeup]
  ALLOW 9c2a08cf1d06716bb03c662ed67096ea92cedacf058d50e1dea60ff442cf6180 [exploiter, project_incident_report]
  ALLOW 9ebef819489ae5e6641cc5573740dadc751c35c3ae37c110e4fad8101494e418 [phishing_receiver, victim_report]
  ALLOW bigbank101.near [phishing_receiver, victim_report]
  ALLOW burrowfinancedao.near [fake_airdrop_token, researcher_dataset]
  ALLOW c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163 [exploit_fake_token, security_writeup]
  ALLOW d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473 [exploiter, security_writeup]
  ALLOW dolbabob.near [phishing_receiver, victim_report]
  ALLOW dragoneggsmeme.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW gregoshes.near [exploiter, project_incident_report]
  ALLOW linear_protocol.near [fake_airdrop_token, researcher_dataset]
  ALLOW lonkrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW metapools.near [fake_airdrop_token, researcher_dataset]
  ALLOW nearreward.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW nearrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW rhea000453.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000462.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000505.multica.near [exploit_staging, security_writeup]
  ALLOW wisdom1.near [theft_receiver, victim_report]
flagged known_good (2):
  WARN  outlayer.near [compute]
  WARN  v1.signer [chain_signatures]
lookalike_candidate verdicts: {"WARN":56,"ALLOW":44,"NONE":345}
  created after the brand: {"WARN":42,"ALLOW":28,"NONE":230}; before it: {"NONE":115,"WARN":14,"ALLOW":16}; unknown: {}
  over-blocking flags: DENY on brand-created names 0, DENY on names older than the brand 0
```

## Confusion table

| | ALLOW | WARN | DENY | Rows |
|---|---|---|---|---|
| suspicious (positives) | 24 | 6 | 0 | 30 |
| known_good (negatives) | 39 | 7 | 0 | 46 |

Recall by kind of evidence (cautious; strict recall is 0 everywhere):

| Group | Rows | Flagged |
|---|---|---|
| `security_writeup` | 16 | 4 (the 4 deleted Rhea worker accounts) |
| `victim_report` | 5 | 0 |
| `onchain_campaign_link` | 4 | 0 |
| `researcher_dataset` | 3 | 2 (`linear_protocol.near` and `metapools.near`: lookalikes of brand-list tokens) |
| `project_incident_report` | 2 | 0 |
| exist at the block | 26 | 2 |
| deleted (`exists: false`) | 4 | 4 |

## Every suspicious row

The deciding reasons are the warnings and denials that set the verdict; for an ALLOW, the
positive signals. `soft` marks a warning that only says nobody has history with the payee yet.
"Named after" is the time from the account's creation to the earliest report that names it
(see Result).

| Account | Verdict | Score | Engine's reasons | Named after | Why |
|---|---|---|---|---|---|
| `5a7695e3626aeae7c0d340b6e58f813c71455d1be490eeb44e90bd9682343040` | WARN | 499 | `implicit_unfunded` (soft) | 5 days (from `d39fd6da...f473`) | exploiter, security_writeup. Rhea Lend worker account, deleted after the attack. The implicit account does not exist at the block, and the engine calls it never funded: the rule reads only the account state at the block, which is the same for a deleted account and a never-funded one, and the indexer history that would tell them apart is not used for an absent account. Flagged for being absent, not for the exploit. A transfer would re-create the account for whoever holds its key. |
| `839810a1aef8ed1adb03e795b2a9785d783d4e2f415ab80c8b6fb30483e160f2` | WARN | 499 | `implicit_unfunded` (soft) | 5 days (from `d39fd6da...f473`) | exploiter, security_writeup. Rhea Lend worker account, deleted after the attack. The implicit account does not exist at the block, and the engine calls it never funded: the rule reads only the account state at the block, which is the same for a deleted account and a never-funded one, and the indexer history that would tell them apart is not used for an absent account. Flagged for being absent, not for the exploit. A transfer would re-create the account for whoever holds its key. |
| `9053223460198e5e1e54dc15c18295ff0e98dca41ecd6c3872da1ff634d99616` | WARN | 499 | `implicit_unfunded` (soft) | 5 days (from `d39fd6da...f473`) | exploiter, security_writeup. Rhea Lend worker account, deleted after the attack. The implicit account does not exist at the block, and the engine calls it never funded: the rule reads only the account state at the block, which is the same for a deleted account and a never-funded one, and the indexer history that would tell them apart is not used for an absent account. Flagged for being absent, not for the exploit. A transfer would re-create the account for whoever holds its key. |
| `d4e8e706f5a59610d85924af858f0562031930d14eb7add9a433edea50cf0b03` | WARN | 499 | `implicit_unfunded` (soft) | 5 days (from `d39fd6da...f473`) | exploiter, security_writeup. Rhea Lend worker account, deleted after the attack. The implicit account does not exist at the block, and the engine calls it never funded: the rule reads only the account state at the block, which is the same for a deleted account and a never-funded one, and the indexer history that would tell them apart is not used for an absent account. Flagged for being absent, not for the exploit. A transfer would re-create the account for whoever holds its key. |
| `linear_protocol.near` | WARN | 499 | `lookalike_known` | 897 days | fake_airdrop_token, researcher_dataset. Fake LiNEAR airdrop token, created 2024-05-18. Its name folds to the same skeleton as `linear-protocol.near` (rank 6 on the brand list): a strong homoglyph match. Older than 72 h, so WARN rather than DENY. ALLOW without the brand list. |
| `metapools.near` | WARN | 499 | `lookalike_known` | 897 days | fake_airdrop_token, researcher_dataset. Fake Meta Pool airdrop token, created 2024-05-18. One edit from `meta-pool.near` (rank 5 on the brand list): a strong edit-distance match. Older than 72 h, so WARN rather than DENY. ALLOW without the brand list. |
| `31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540` | ALLOW | 680 | `long_history` | 6 days | exploiter, security_writeup. Rhea Lend attacker wallet and collector, created 2026-04-15, about 7 months before the block: `long_history`. Keys unchanged within 72 h, not on Circle's USDC blocklist. Nothing the engine reads records the exploit. |
| `3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018` | ALLOW | 680 | `long_history` | 2 days | exploiter, security_writeup. SWEAT token exploit drainer, a contract account created 2026-04-27, 5 or more transactions, code unchanged within 72 h: `long_history`. |
| `5ebc5ecca14a44175464d0e6a7d3b2a6890229cd5f19cfb29ce8b1651fd58d39` | ALLOW | 680 | `long_history` | 2 days | exploiter, security_writeup. Skyward Finance exploiter, created 2022-11-01: `long_history`; no change within 72 h. |
| `72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5` | ALLOW | 680 | `long_history` | 5 days | exploiter, security_writeup. Rhea Lend master account that consolidated the proceeds, a contract account created 2026-04-16: `long_history`; code and keys unchanged within 72 h. |
| `9c2a08cf1d06716bb03c662ed67096ea92cedacf058d50e1dea60ff442cf6180` | ALLOW | 680 | `long_history` | 10 days | exploiter, project_incident_report. Kangaroo Coin Flip exploiter, created 2022-07-11: `long_history`; no change within 72 h. |
| `d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473` | ALLOW | 680 | `long_history` | 5 days | exploiter, security_writeup. Rhea Lend worker account that still exists, created 2026-04-16: `long_history`; no change within 72 h. |
| `gregoshes.near` | ALLOW | 680 | `long_history` | 0 days | exploiter, project_incident_report. Stader NearX exploiter, created 2022-08-16 (the day of the attack): `long_history` about 4 years later. |
| `7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640` | ALLOW | 680 | `long_history` | 5 days | exploit_fake_token, security_writeup. One of the four fake token contracts of the Rhea Lend exploit, created 2026-04-16, 5 or more transactions, code unchanged within 72 h: `long_history`. The shared code hash in the rekt.news report is not something the engine reads. |
| `80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705` | ALLOW | 680 | `long_history` | 5 days | exploit_fake_token, security_writeup. One of the four fake token contracts of the Rhea Lend exploit, created 2026-04-16, 5 or more transactions, code unchanged within 72 h: `long_history`. The shared code hash in the rekt.news report is not something the engine reads. |
| `9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee` | ALLOW | 680 | `long_history` | 5 days | exploit_fake_token, security_writeup. One of the four fake token contracts of the Rhea Lend exploit, created 2026-04-16, 5 or more transactions, code unchanged within 72 h: `long_history`. The shared code hash in the rekt.news report is not something the engine reads. |
| `c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163` | ALLOW | 680 | `long_history` | 5 days | exploit_fake_token, security_writeup. One of the four fake token contracts of the Rhea Lend exploit, created 2026-04-16, 5 or more transactions, code unchanged within 72 h: `long_history`. The shared code hash in the rekt.news report is not something the engine reads. |
| `rhea000453.multica.near` | ALLOW | 680 | `long_history` | 31 days | exploit_staging, security_writeup. Staging account in Rhea's Multichain Account system that received exploit funds, created 2026-03-21: a contract with no full-access key (`locked_contract`, info) and `long_history`. |
| `rhea000462.multica.near` | ALLOW | 680 | `long_history` | 27 days | exploit_staging, security_writeup. Staging account in Rhea's Multichain Account system that received exploit funds, created 2026-03-25: a contract with no full-access key (`locked_contract`, info) and `long_history`. |
| `rhea000505.multica.near` | ALLOW | 680 | `long_history` | 11 days | exploit_staging, security_writeup. Staging account in Rhea's Multichain Account system that received exploit funds, created 2026-04-10: a contract with no full-access key (`locked_contract`, info) and `long_history`. |
| `burrowfinancedao.near` | ALLOW | 680 | `long_history` | 899 days | fake_airdrop_token, researcher_dataset. Lure token that created four others, created 2024-05-16, 5 or more transactions: `long_history`, and no warning fires. No brand-list name is close: Burrow has no token in the top 25, and the engine compares whole account names (`token.burrow.near`), not brand words. The website lure in its token name is not something the engine reads. |
| `dragoneggsmeme.near` | ALLOW | 680 | `long_history` | no dated report (linked on chain) | fake_airdrop_token, onchain_campaign_link. Lure token created by `burrowfinancedao.near` on 2024-05-19: `long_history`. It imitates no brand-list name, and the lure in its token name is not read. |
| `lonkrewards.near` | ALLOW | 680 | `long_history` | no dated report (linked on chain) | fake_airdrop_token, onchain_campaign_link. Lure token imitating LONK, created 2024-05-18: `long_history`. `token.lonkingnearbackto2024.near` is not on the brand list, and the name is not close to that whole account id either. |
| `nearreward.near` | ALLOW | 680 | `long_history` | no dated report (linked on chain) | fake_airdrop_token, onchain_campaign_link. Lure token created by `nearrewards.near` on 2024-09-11: `long_history`. It imitates no brand-list name, and the lure in its token name is not read. |
| `nearrewards.near` | ALLOW | 680 | `long_history` | no dated report (linked on chain) | fake_airdrop_token, onchain_campaign_link. Creator of the campaign and itself a lure token, created 2024-05-10, last transaction 2026-11-04 by the dataset's count: `long_history`. Its 4 full-access keys were all there 72 h before the block. |
| `9ebef819489ae5e6641cc5573740dadc751c35c3ae37c110e4fad8101494e418` | ALLOW | 680 | `long_history` | 15 days | phishing_receiver, victim_report. Received funds phished through a fake wallet website (victim report), created 2022-03-26: `long_history`. |
| `bigbank101.near` | ALLOW | 680 | `long_history` | 1 day | phishing_receiver, victim_report. Received funds stolen through a fake NEAR Wallet app (victim report), created 2021-12-17: `long_history`. |
| `dolbabob.near` | ALLOW | 680 | `long_history` | 27 days | phishing_receiver, victim_report. Received funds lost to a phishing site (victim report), created 2021-11-23: `long_history`. |
| `087184b14c3cad5de72090c4a48816d46e53f39454df13b957e14350793b18e7` | ALLOW | 680 | `long_history` | 2 days | theft_receiver, victim_report. First hop of stolen funds and NFTs (victim report), created 2022-05-26: `long_history`. |
| `wisdom1.near` | ALLOW | 680 | `long_history` | 34 days | theft_receiver, victim_report. Received a drained guild treasury (victim report), created 2022-01-15, 5 or more transactions: `long_history`. |

## Every false positive

| Account | Verdict | Score | Engine's reasons | Why |
|---|---|---|---|---|
| `outlayer.near` | WARN | 499 | `code_changed_recently` | compute. Its contract was upgraded inside the 72 h window: code hash `5waWVnt6...` at the probe block 223743655 became `AsbxRWTQ...`. Any code change in that window holds a payment for one owner tap, by design, whoever the payee is. |
| `token.0xshitzu.near` | WARN | 499 | `lookalike_known` | token. Weak `parent_swap`: the same first label `token` as a listed `token.*` account, under another parent. Each of the 3 listed ones (`token.rhealab.near`, rank 7; `token.v2.ref-finance.near`, rank 17; `token.publicailab.near`, rank 23) gives this same weak match; the engine names `token.publicailab.near` only because it breaks ties between equal matches in sorted order. Without `token.publicailab.near` the WARN stays, matched to `token.rhealab.near`, and it stays with only the top 10 on the list (list sensitivity). The rule was written for role labels such as `agent.alice.testnet` against `agent.bob.testnet`; on NEAR, `token.<project>` is the usual name of a token contract, so every `token.*` contract outside the list matches. A weak match only warns and never denies, and age does not clear it. ALLOW without the brand list. |
| `token.burrow.near` | WARN | 499 | `lookalike_known` | token. Weak `parent_swap`: the same first label `token` as a listed `token.*` account, under another parent. Each of the 3 listed ones (`token.rhealab.near`, rank 7; `token.v2.ref-finance.near`, rank 17; `token.publicailab.near`, rank 23) gives this same weak match; the engine names `token.publicailab.near` only because it breaks ties between equal matches in sorted order. Without `token.publicailab.near` the WARN stays, matched to `token.rhealab.near`, and it stays with only the top 10 on the list (list sensitivity). The rule was written for role labels such as `agent.alice.testnet` against `agent.bob.testnet`; on NEAR, `token.<project>` is the usual name of a token contract, so every `token.*` contract outside the list matches. A weak match only warns and never denies, and age does not clear it. ALLOW without the brand list. |
| `token.lonkingnearbackto2024.near` | WARN | 499 | `lookalike_known` | token. Weak `parent_swap`: the same first label `token` as a listed `token.*` account, under another parent. Each of the 3 listed ones (`token.rhealab.near`, rank 7; `token.v2.ref-finance.near`, rank 17; `token.publicailab.near`, rank 23) gives this same weak match; the engine names `token.publicailab.near` only because it breaks ties between equal matches in sorted order. Without `token.publicailab.near` the WARN stays, matched to `token.rhealab.near`, and it stays with only the top 10 on the list (list sensitivity). The rule was written for role labels such as `agent.alice.testnet` against `agent.bob.testnet`; on NEAR, `token.<project>` is the usual name of a token contract, so every `token.*` contract outside the list matches. A weak match only warns and never denies, and age does not clear it. ALLOW without the brand list. |
| `token.paras.near` | WARN | 499 | `lookalike_known` | token. Weak `parent_swap`: the same first label `token` as a listed `token.*` account, under another parent. Each of the 3 listed ones (`token.rhealab.near`, rank 7; `token.v2.ref-finance.near`, rank 17; `token.publicailab.near`, rank 23) gives this same weak match; the engine names `token.publicailab.near` only because it breaks ties between equal matches in sorted order. Without `token.publicailab.near` the WARN stays, matched to `token.rhealab.near`, and it stays with only the top 10 on the list (list sensitivity). The rule was written for role labels such as `agent.alice.testnet` against `agent.bob.testnet`; on NEAR, `token.<project>` is the usual name of a token contract, so every `token.*` contract outside the list matches. A weak match only warns and never denies, and age does not clear it. ALLOW without the brand list. |
| `token.sweat` | WARN | 499 | `lookalike_known` | token. Weak `parent_swap`: the same first label `token` as a listed `token.*` account, under another parent. Each of the 3 listed ones (`token.rhealab.near`, rank 7; `token.v2.ref-finance.near`, rank 17; `token.publicailab.near`, rank 23) gives this same weak match; the engine names `token.publicailab.near` only because it breaks ties between equal matches in sorted order. Without `token.publicailab.near` the WARN stays, matched to `token.rhealab.near`, and it stays with only the top 10 on the list (list sensitivity). The rule was written for role labels such as `agent.alice.testnet` against `agent.bob.testnet`; on NEAR, `token.<project>` is the usual name of a token contract, so every `token.*` contract outside the list matches. A weak match only warns and never denies, and age does not clear it. ALLOW without the brand list. |
| `v1.signer` | WARN | 499 | `code_changed_recently` | chain_signatures. The Chain Signatures contract was upgraded inside the 72 h window: `DAE5ng4Z...` became `CpGX8ywX...`. Same rule, same reason. |

The other 39 known_good rows are ALLOW at score 680 (`long_history`).

## Lookalike candidates (not scored)

These rows are names close to a known_good brand that exist on mainnet. Their intent is
unknown, so a WARN on one is neither right nor wrong; the dataset README says not to score them,
and `score.mjs` reports only the mix.

**Sample.** 100 of the 445 rows, drawn by `sampleLookalikes` in `run.mjs`
with the seed `a-identity-near-benchmark/1`. Two strata are taken whole: the names the imitated brand registered
itself (`created_by_brand`, 2 rows; a DENY there is an over-blocking flag in
`score.mjs`) and the names created in the 30 days before the dataset checked them
(9 rows, the README's recent names). The other 89 draws are shared among
strata by `predates_brand` and generator rule in proportion to their size (largest remainder);
inside a stratum, rows are ordered by `sha256("<seed>|<account_id>")` and the first ones taken.
`node scan/benchmark/run.mjs --list` prints the strata and the accounts.

| Stratum | Rows | Sampled | ALLOW | WARN | DENY | WARN without the brand list |
|---|---|---|---|---|---|---|
| take-all: created by the brand itself | 2 | 2 | 2 | 0 | 0 | 0 |
| take-all: created in the 30 days before the dataset check | 9 | 9 | 1 | 8 | 0 | 8 |
| proportional: created after the brand | 289 | 59 | 18 | 41 | 0 | 34 |
| proportional: created before the brand | 145 | 30 | 13 | 17 | 0 | 14 |

Of the 66 WARN verdicts, 48 come from `low_activity` alone (fewer than 5
transactions; soft), 10 from `lookalike_known` alone and 8 from both. There is
no DENY, so both over-blocking flags of `score.mjs` are 0. The `lookalike_known` warnings include
3 on names older than the brand they resemble (`near_mobile.near`, `ref_finance.near`, `reffinance.near`): the nearest thing to
over-blocking in this run, at WARN. No lookalike row is on the brand list, so the leave-self-out
replay leaves all of them as they are.

The take-all rows by name:

| Account | Stratum | Verdict | Engine's reasons | Note |
|---|---|---|---|---|
| `mintbasev2.near` | created_by_brand | ALLOW | `long_history` | imitates `simple.market.mintbase1.near`; created 2024-07-11 by `mintbase1.near`; 12 transactions by the dataset's count; a defensive registration by the brand's own account |
| `orderlynetwork.near` | created_by_brand | ALLOW | `long_history` | imitates `asset-manager.orderly-network.near`; created 2022-09-08 by `orderly-network.near`; 13 transactions by the dataset's count; a defensive registration by the brand's own account |
| `1ntents.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `intents.near`; created 2026-10-20 by `4d31fbb4...f064`; 1 transaction by the dataset's count |
| `bl4ckdragon.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `blackdragon.tkn.near`; created 2026-10-15 by `meteor-relayer.near`; 1 transaction by the dataset's count |
| `herewallett.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `storage.herewallet.near`; created 2026-10-25 by `free-name.herewallet.near`; 1 transaction by the dataset's count |
| `iintents.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `intents.near`; created 2026-10-20 by `4d31fbb4...f064`; 1 transaction by the dataset's count |
| `int3nts.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `intents.near`; created 2026-10-20 by `4d31fbb4...f064`; 1 transaction by the dataset's count |
| `intent5.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `intents.near`; created 2026-10-20 by `4d31fbb4...f064`; 1 transaction by the dataset's count |
| `lonknear.near` | created_last_30d | ALLOW | (no warning and no positive; base score) | imitates `token.lonkingnearbackto2024.near`; created 2026-10-18 by `free-name.herewallet.near`; 6 transactions by the dataset's count; about 25 days old at the block, so past the 72 h and 5-transaction lines but short of 30 days, and no brand-list name is close: no warning and no positive, ALLOW at the base score 600 |
| `usd_c.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`; created 2026-10-31 by `meteor-relayer.near`; 1 transaction by the dataset's count |
| `wr4p.near` | created_last_30d | WARN | `low_activity` (soft) | imitates `wrap.near`; created 2026-10-19 by `4d31fbb4...f064`; 1 transaction by the dataset's count |

The 5 names created by `4d31fbb4...f064` on 2026-10-19 and 2026-10-20 are held only because they
have 1 transaction each. The lookalike rule does not match any of them: `intents.near` is not on
the brand list, and `wr4p` against `wrap` is a 4-character name, which matches only on an identical
skeleton (`4` is not folded to `a`).

## At payment age: the same accounts at 1 and 7 days old

The run above reads every account at one block, on 2026-11-12, months to years after most of
them were named in a report. This section replays the same engine with the same inputs on the
same 76 scored accounts (all 30 `suspicious` and 46 `known_good` rows; the
lookalike rows are not run), each at blocks chosen by its own age: the first block at or after
its creation block's timestamp plus 1 day, and plus 7 days. The rule was written in
`at-age/PREREGISTRATION.md` at 2026-11-12T16:01:04Z, before any at-age read, and was not changed
after the results were seen: its first 8297 bytes hash to `0e9dccfc1e8553b8ccdce51844a76fa09d48606755816dc3db59b1c786325af4`,
`at-age/run.mjs --offline --check` fails if they change, and no amendment was needed.

- **Creation block, from the chain.** The first block at which archival `view_account` finds the
  account, proven by two answers recorded in `at-age/plan.json`: the account at that block, and
  `UNKNOWN_ACCOUNT` at its predecessor (the block its `prev_hash` names). The search starts at the
  oldest transaction that touches the account in FastNEAR's transactions API. Proven for
  76 of the 76 accounts, the 4 deleted Rhea worker accounts included,
  each one 1 to 6 blocks after that transaction's block, found by reading every block forward from it. Cross-checks, never used to choose a block: for the 72 accounts with
  a `facts.created_at` in the dataset, the creation block is 0.9 to 8.5 s after it
  (all within the pre-registered 0 to 600 s), and the oldest transaction is the dataset's `creation_tx` for
  72 of them; NearBlocks v3 answered for 76 accounts and names the same
  creation transaction for 73, 0.3 to 7.6 s before the creation block; for the other 3 it names a later transaction as the creation, and the chain's proof stands: `asset-manager.orderly-network.near` (creation block 73727638 at 2022-09-08T09:38:54.384Z; NearBlocks 2022-09-08T17:34:27.154Z, 7.9 h later, transaction `2HEKdmN9...`), `d39fd6da...f473` (creation block 194226561 at 2026-04-16T08:23:25.372Z; NearBlocks 2026-04-16T09:55:44.127Z, 1.5 h later, transaction `AjY6ruWH...`) and `lst.rhealab.near` (creation block 157830580 at 2025-08-02T00:57:55.958Z; NearBlocks 2025-08-02T13:20:08.990Z, 12.4 h later, transaction `5AUveJbR...`).
- **Replay block.** The first block whose timestamp is at or after the target, proven by its
  predecessor, whose timestamp is before the target. The creation blocks run from
  2020-10-14 to 2026-04-27, so the replay blocks span more than 5 years of mainnet.
- **Engine inputs.** Exactly the run above's: the account id, mainnet, the replay block and the
  25 names in `known-brands.json`, with no third-party registry, no A-Identity registry
  and no vault. The engine is not given the dataset, the labels, the creation facts or the age.
  Each snapshot records its age point, creation block, target time, replay block and that
  block's predecessor in `meta.at_age`, outside both digests; `benchmark.test.mjs` checks every
  one against the plan and the age rule, and checks the label-free context on every snapshot.
- **Excluded, as pre-registered.** 4 accounts at both age points: the deleted Rhea
  worker accounts. Each was created on 2026-04-16 and no longer existed 1 day later
  (`view_account` at both replay blocks answers `UNKNOWN_ACCOUNT`; NearBlocks dates the deletions
  about 1.5 hours after creation), so it has no snapshot and no verdict. score.mjs counts an
  excluded row as `NONE`, so these 4 count as missed suspicious rows in the first table
  below, and its denominators stay 30 and 46.

### Result at age

| Age | Operating point | Precision | Recall | TP | FP | FN |
|---|---|---|---|---|---|---|
| 1 day | strict: DENY counts as flagged | 100.0% (2 of 2) | 6.7% (2 of 30) | 2 | 0 | 28 |
| 1 day | cautious: WARN or DENY counts as flagged | 36.1% (26 of 72) | 86.7% (26 of 30) | 26 | 46 | 4 |
| 1 day | strict, listed payees not exempt (leave-self-out) | 100.0% (2 of 2) | 6.7% (2 of 30) | 2 | 0 | 28 |
| 1 day | cautious, listed payees not exempt (leave-self-out) | 36.1% (26 of 72) | 86.7% (26 of 30) | 26 | 46 | 4 |
| 7 days | strict: DENY counts as flagged | n/a (no DENY issued) | 0.0% (0 of 30) | 0 | 0 | 30 |
| 7 days | cautious: WARN or DENY counts as flagged | 26.8% (11 of 41) | 36.7% (11 of 30) | 11 | 30 | 19 |
| 7 days | strict, listed payees not exempt (leave-self-out) | n/a (no DENY issued) | 0.0% (0 of 30) | 0 | 0 | 30 |
| 7 days | cautious, listed payees not exempt (leave-self-out) | 26.2% (11 of 42) | 36.7% (11 of 30) | 11 | 31 | 19 |

The leave-self-out rows replay the same snapshots with each payee compared with the known list minus its own name, as `verdicts.leave-self-out.json` does for the run above: at 1 day no verdict changes, and at 7 days 1 verdict changes (`token.rhealab.near`, ALLOW to WARN on a weak `parent_swap` match with `token.publicailab.near`).

Over the accounts that have a verdict (the excluded ones left out of both classes):

| Age | Accounts with a verdict | Strict precision | Strict recall | Cautious precision | Cautious recall |
|---|---|---|---|---|---|
| 1 day | 26 of 30 suspicious, 46 of 46 known_good | 100.0% (2 of 2) | 7.7% (2 of 26) | 36.1% (26 of 72) | 100.0% (26 of 26) |
| 7 days | 26 of 30 suspicious, 46 of 46 known_good | n/a (no DENY issued) | 0.0% (0 of 26) | 26.8% (11 of 41) | 42.3% (11 of 26) |

| Age | Class | ALLOW | WARN | DENY | Excluded | Rows |
|---|---|---|---|---|---|---|
| 1 day | suspicious (positives) | 0 | 24 | 2 | 4 | 30 |
| 1 day | known_good (negatives) | 0 | 46 | 0 | 0 | 46 |
| 7 days | suspicious (positives) | 15 | 11 | 0 | 4 | 30 |
| 7 days | known_good (negatives) | 16 | 30 | 0 | 0 | 46 |

Suspicious rows flagged at age, by kind of evidence (cautious; an excluded row counts as missed):

| Group | Rows | 1 day | 7 days |
|---|---|---|---|
| `security_writeup` | 16 | 12 | 1 |
| `victim_report` | 5 | 5 | 5 |
| `onchain_campaign_link` | 4 | 4 | 1 |
| `researcher_dataset` | 3 | 3 | 2 |
| `project_incident_report` | 2 | 2 | 2 |
| exist today (dataset `exists: true`) | 26 | 26 | 11 |
| deleted (`exists: false`), excluded at age | 4 | 0 | 0 |

- **1 day: every account that exists is held, of both classes.** All 72 accounts with a verdict get WARN or DENY, and `new_account` (under 72 hours old; a soft warning) decides every one of them. That is the rule as designed, and what `at-age/PREREGISTRATION.md` expected from the rules alone: a payee under 72 hours old waits for one owner tap, whoever it is. So at this age the cautious operating point does not tell the classes apart: over the accounts with a verdict, cautious recall is 100.0% (26 of 26) and cautious precision is 36.1% (26 of 72), exactly the share of suspicious rows among them, because all 46 `known_good` rows are held too. A WARN holds the payment for one tap; it does not refuse it.
- **DENY at 1 day.** The engine refuses 2 accounts, `linear_protocol.near` and `metapools.near`, the fake airdrop tokens whose names imitate `linear-protocol.near` (rank 6) and `meta-pool.near` (rank 5) on the brand list, because they are strong lookalikes under 72 hours old (`lookalike_new_account`). No `known_good` row is denied: strict precision 100.0% (2 of 2), strict recall 6.7% (2 of 30). At block 224191308 the same two were only WARN, being older than 72 hours there.
- **7 days: the 72-hour rule no longer applies.** `new_account` decides no verdict at 7 days. Of the 72 accounts with a verdict, 41 are still held: 11 of the 26 `suspicious` and 30 of the 46 `known_good`, and none is refused (no DENY). Over the accounts with a verdict, cautious recall is 42.3% (11 of 26) and cautious precision 26.8% (11 of 41), below the 36.1% share of suspicious rows among them.
- **Suspicious rows at 7 days.** Held: `code_changed_recently` on 1 (`nearrewards.near`); `lookalike_known` on 2 (`linear_protocol.near` and `metapools.near`); `low_activity` (soft) on 1 (`wisdom1.near`); `blocklist_unreadable` on 8 (`087184b1...18e7`, `5ebc5ecc...8d39`, `9c2a08cf...6180`, `9ebef819...e418`, `bigbank101.near`, `dolbabob.near`, `gregoshes.near` and `wisdom1.near`). ALLOW: 15 (15 accounts), each at the base score 600: 5 or more transactions by day 7, no key or code change between day 4 and day 7, no lookalike match, and too young for `long_history` (30 days).
- **`known_good` rows at 7 days.** Held: `code_changed_recently` on 3 (`intents.near`, `usdt.tether-token.near` and `v2_1.omni.hot.tg`); `lookalike_known` on 5 (`token.0xshitzu.near`, `token.burrow.near`, `token.lonkingnearbackto2024.near`, `token.paras.near` and `token.sweat`); `low_activity` (soft) on 10; `blocklist_unreadable` on 24. ALLOW: 16, each at the base score 600.
- **Missing data, not the payee.** 32 of the 41 accounts held at 7 days have a replay block before Circle's USDC contract existed, where every verdict carries `blocklist_unreadable` whatever the payee (split (i) below). At or after that block the engine holds 3 of 18 `suspicious` and 6 of 22 `known_good` accounts: cautious recall 16.7% (3 of 18) and cautious precision 33.3% (3 of 9) there.

### What decided the verdicts

Each row counts the verdicts whose deciding reasons include that reason, out of the accounts
with a verdict; a verdict can have several.

| Age | Deciding reason | Suspicious | known_good |
|---|---|---|---|
| 1 day | `lookalike_new_account` | 2 of 26 | 0 of 46 |
| 1 day | `lookalike_known` | 0 of 26 | 5 of 46 |
| 1 day | `new_account` (soft) | 26 of 26 | 46 of 46 |
| 1 day | `low_activity` (soft) | 5 of 26 | 18 of 46 |
| 1 day | `blocklist_unreadable` | 8 of 26 | 24 of 46 |
| 7 days | `code_changed_recently` | 1 of 26 | 3 of 46 |
| 7 days | `lookalike_known` | 2 of 26 | 5 of 46 |
| 7 days | `low_activity` (soft) | 1 of 26 | 10 of 46 |
| 7 days | `blocklist_unreadable` | 8 of 26 | 24 of 46 |

Pre-registered split (i). Circle's USDC contract on NEAR (`17208628...36133a1`) was created at
block 79039277 (2022-11-22T21:10:19.824Z, by the same creation method). At a replay block before
it, the engine cannot read `is_blocklisted` and fails closed with `blocklist_unreadable`, a hard
WARN, whatever the payee; every verdict at such a block carries it.

| Age | Replay block | Suspicious flagged | known_good flagged | Cautious precision | Cautious recall |
|---|---|---|---|---|---|
| 1 day | before block 79039277 | 8 of 8 | 24 of 24 | 25.0% (8 of 32) | 100.0% (8 of 8) |
| 1 day | at or after block 79039277 | 18 of 18 | 22 of 22 | 45.0% (18 of 40) | 100.0% (18 of 18) |
| 7 days | before block 79039277 | 8 of 8 | 24 of 24 | 25.0% (8 of 32) | 100.0% (8 of 8) |
| 7 days | at or after block 79039277 | 3 of 18 | 6 of 22 | 33.3% (3 of 9) | 16.7% (3 of 18) |

No verdict at or after that block carries it.

Pre-registered split (ii), the verdicts whose only deciding reasons are missing-data codes
(`rpc_unavailable`, `indexer_unavailable`, `blocklist_unreadable`): at 1 day, none; at 7 days, 20 (7 `suspicious`: `087184b1...18e7`, `5ebc5ecc...8d39`, `9c2a08cf...6180`, `9ebef819...e418`, `bigbank101.near`, `dolbabob.near` and `gregoshes.near`; 13 `known_good`: `asset-manager.orderly-network.near`, `boostfarm.ref-labs.near`, `contract.main.burrow.near`, `dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near`, `factory.bridge.near`, `ftv2.nekotoken.near`, `meta-pool.near`, `priceoracle.near`, `storage.herewallet.near`, `token.v2.ref-finance.near`, `v2.ref-finance.near`, `wrap.near` and `xtoken.ref-finance.near`).

### Every suspicious row at age

Each age cell gives the verdict, the score and the deciding reasons (for an ALLOW, the positive
signals). The last column is the verdict at block 224191308, from the run above.

| Account | Kind | Created (chain) | 1 day | 7 days | At block 224191308 |
|---|---|---|---|---|---|
| `31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540` | exploiter, security_writeup | 2026-04-15 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018` | exploiter, security_writeup | 2026-04-27 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning | ALLOW |
| `5a7695e3626aeae7c0d340b6e58f813c71455d1be490eeb44e90bd9682343040` | exploiter, security_writeup | 2026-04-16 | excluded: absent at the replay block | excluded: absent at the replay block | WARN |
| `5ebc5ecca14a44175464d0e6a7d3b2a6890229cd5f19cfb29ce8b1651fd58d39` | exploiter, security_writeup | 2022-11-01 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5` | exploiter, security_writeup | 2026-04-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `839810a1aef8ed1adb03e795b2a9785d783d4e2f415ab80c8b6fb30483e160f2` | exploiter, security_writeup | 2026-04-16 | excluded: absent at the replay block | excluded: absent at the replay block | WARN |
| `9053223460198e5e1e54dc15c18295ff0e98dca41ecd6c3872da1ff634d99616` | exploiter, security_writeup | 2026-04-16 | excluded: absent at the replay block | excluded: absent at the replay block | WARN |
| `9c2a08cf1d06716bb03c662ed67096ea92cedacf058d50e1dea60ff442cf6180` | exploiter, project_incident_report | 2022-07-11 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473` | exploiter, security_writeup | 2026-04-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `d4e8e706f5a59610d85924af858f0562031930d14eb7add9a433edea50cf0b03` | exploiter, security_writeup | 2026-04-16 | excluded: absent at the replay block | excluded: absent at the replay block | WARN |
| `gregoshes.near` | exploiter, project_incident_report | 2022-08-16 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640` | exploit_fake_token, security_writeup | 2026-04-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705` | exploit_fake_token, security_writeup | 2026-04-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee` | exploit_fake_token, security_writeup | 2026-04-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163` | exploit_fake_token, security_writeup | 2026-04-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `rhea000453.multica.near` | exploit_staging, security_writeup | 2026-03-21 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning | ALLOW |
| `rhea000462.multica.near` | exploit_staging, security_writeup | 2026-03-25 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning | ALLOW |
| `rhea000505.multica.near` | exploit_staging, security_writeup | 2026-04-10 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `burrowfinancedao.near` | fake_airdrop_token, researcher_dataset | 2024-05-16 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `dragoneggsmeme.near` | fake_airdrop_token, onchain_campaign_link | 2024-05-19 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `linear_protocol.near` | fake_airdrop_token, researcher_dataset | 2024-05-18 | DENY 120: `lookalike_new_account`, `new_account` | WARN 480: `lookalike_known` | WARN |
| `lonkrewards.near` | fake_airdrop_token, onchain_campaign_link | 2024-05-18 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `metapools.near` | fake_airdrop_token, researcher_dataset | 2024-05-18 | DENY 120: `lookalike_new_account`, `new_account` | WARN 480: `lookalike_known` | WARN |
| `nearreward.near` | fake_airdrop_token, onchain_campaign_link | 2024-09-11 | WARN 499: `new_account` | ALLOW 600: no warning | ALLOW |
| `nearrewards.near` | fake_airdrop_token, onchain_campaign_link | 2024-05-10 | WARN 499: `new_account` | WARN 480: `code_changed_recently` | ALLOW |
| `9ebef819489ae5e6641cc5573740dadc751c35c3ae37c110e4fad8101494e418` | phishing_receiver, victim_report | 2022-03-26 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `bigbank101.near` | phishing_receiver, victim_report | 2021-12-17 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `dolbabob.near` | phishing_receiver, victim_report | 2021-11-23 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `087184b14c3cad5de72090c4a48816d46e53f39454df13b957e14350793b18e7` | theft_receiver, victim_report | 2022-05-26 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` | ALLOW |
| `wisdom1.near` | theft_receiver, victim_report | 2022-01-15 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` | ALLOW |

### Every false positive at age

Every `known_good` row flagged at either age point (46 of 46):

| Account | Category | Created (chain) | 1 day | 7 days |
|---|---|---|---|---|
| `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | stablecoin | 2022-11-22 | WARN 499: `new_account` | ALLOW 600: no warning |
| `a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near` | stablecoin | 2021-03-15 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near` | token | 2021-10-07 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `asset-manager.orderly-network.near` | dex | 2022-09-08 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `aurora` | evm | 2021-04-15 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `blackdragon.tkn.near` | token | 2023-12-20 | WARN 499: `new_account` | ALLOW 600: no warning |
| `boostfarm.ref-labs.near` | farming | 2022-07-26 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `contract.main.burrow.near` | lending | 2022-03-27 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near` | stablecoin | 2021-03-15 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `dclv2.ref-labs.near` | dex | 2023-01-26 | WARN 499: `new_account` | ALLOW 600: no warning |
| `donate.potlock.near` | donations | 2023-11-03 | WARN 499: `new_account` | ALLOW 600: no warning |
| `eth.bridge.near` | token | 2025-04-07 | WARN 499: `new_account` | ALLOW 600: no warning |
| `factory.bridge.near` | bridge | 2021-03-15 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `ftv2.nekotoken.near` | token | 2022-07-15 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `intents.near` | intents | 2024-11-01 | WARN 440: `new_account`, `low_activity` | WARN 480: `code_changed_recently` |
| `linear-protocol.near` | liquid_staking | 2022-03-10 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `lst.rhealab.near` | liquid_staking | 2025-08-02 | WARN 499: `new_account` | ALLOW 600: no warning |
| `meme-cooking.near` | launchpad | 2024-07-22 | WARN 440: `new_account`, `low_activity` | WARN 499: `low_activity` |
| `meta-pool.near` | liquid_staking | 2021-08-21 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `mpc.hot.tg` | wallet_infra | 2024-05-20 | WARN 499: `new_account` | ALLOW 600: no warning |
| `mpdao-token.near` | token | 2024-04-10 | WARN 499: `new_account` | ALLOW 600: no warning |
| `nbtc.bridge.near` | token | 2025-01-20 | WARN 499: `new_account` | ALLOW 600: no warning |
| `npro.nearmobile.near` | token | 2025-12-03 | WARN 499: `new_account` | ALLOW 600: no warning |
| `omni.bridge.near` | bridge | 2025-01-10 | WARN 499: `new_account` | ALLOW 600: no warning |
| `outlayer.near` | compute | 2025-10-21 | WARN 440: `new_account`, `low_activity` | WARN 499: `low_activity` |
| `pool.near` | staking_factory | 2020-10-14 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `priceoracle.near` | oracle | 2021-10-22 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `simple.market.mintbase1.near` | nft_marketplace | 2022-08-03 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `social.near` | social | 2021-02-23 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 400: `low_activity`, `blocklist_unreadable` |
| `storage.herewallet.near` | liquid_staking | 2022-07-08 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `token.0xshitzu.near` | token | 2024-01-05 | WARN 400: `lookalike_known`, `new_account` | WARN 480: `lookalike_known` |
| `token.burrow.near` | token | 2021-12-29 | WARN 280: `lookalike_known`, `new_account`, `blocklist_unreadable` | WARN 360: `lookalike_known`, `blocklist_unreadable` |
| `token.lonkingnearbackto2024.near` | token | 2023-12-26 | WARN 400: `lookalike_known`, `new_account` | WARN 480: `lookalike_known` |
| `token.paras.near` | token | 2021-09-13 | WARN 280: `lookalike_known`, `new_account`, `blocklist_unreadable` | WARN 360: `lookalike_known`, `blocklist_unreadable` |
| `token.rhealab.near` | token | 2025-05-06 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning |
| `token.sweat` | token | 2022-06-15 | WARN 200: `lookalike_known`, `new_account`, `low_activity`, `blocklist_unreadable` | WARN 280: `lookalike_known`, `low_activity`, `blocklist_unreadable` |
| `token.v2.ref-finance.near` | token | 2021-08-24 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `usdt.tether-token.near` | stablecoin | 2022-09-02 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 360: `code_changed_recently`, `blocklist_unreadable` |
| `v1.signer` | chain_signatures | 2024-07-31 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning |
| `v2.ref-finance.near` | dex | 2021-08-21 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `v2_1.omni.hot.tg` | bridge | 2025-04-11 | WARN 499: `new_account` | WARN 480: `code_changed_recently` |
| `venear.dao` | governance | 2025-10-10 | WARN 499: `new_account` | ALLOW 600: no warning |
| `vote.dao` | governance | 2025-10-10 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning |
| `wrap.near` | token | 2021-02-15 | WARN 320: `new_account`, `low_activity`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `xtoken.ref-finance.near` | token | 2022-01-17 | WARN 400: `new_account`, `blocklist_unreadable` | WARN 480: `blocklist_unreadable` |
| `zec.omft.near` | token | 2025-01-24 | WARN 440: `new_account`, `low_activity` | ALLOW 600: no warning |

Every one of the 46 `known_good` rows is flagged at one age point or both.

### Exclusions

| Account | Row | Age | Reason |
|---|---|---|---|
| `5a7695e3626aeae7c0d340b6e58f813c71455d1be490eeb44e90bd9682343040` | suspicious | 1 day and 7 days | absent at the replay block: `view_account` at #194368235 (1 day) and #195224506 (7 days) answered `UNKNOWN_ACCOUNT`; created at block 194226543 (2026-04-16T08:23:14.648Z), and NearBlocks dates its deletion 2026-04-16T09:54:44.246Z, 1.5 h later |
| `839810a1aef8ed1adb03e795b2a9785d783d4e2f415ab80c8b6fb30483e160f2` | suspicious | 1 day and 7 days | absent at the replay block: `view_account` at #194368244 (1 day) and #195224513 (7 days) answered `UNKNOWN_ACCOUNT`; created at block 194226551 (2026-04-16T08:23:19.507Z), and NearBlocks dates its deletion 2026-04-16T09:54:53.673Z, 1.5 h later |
| `9053223460198e5e1e54dc15c18295ff0e98dca41ecd6c3872da1ff634d99616` | suspicious | 1 day and 7 days | absent at the replay block: `view_account` at #194368249 (1 day) and #195224519 (7 days) answered `UNKNOWN_ACCOUNT`; created at block 194226556 (2026-04-16T08:23:22.553Z), and NearBlocks dates its deletion 2026-04-16T09:54:59.161Z, 1.5 h later |
| `d4e8e706f5a59610d85924af858f0562031930d14eb7add9a433edea50cf0b03` | suspicious | 1 day and 7 days | absent at the replay block: `view_account` at #194368239 (1 day) and #195224510 (7 days) answered `UNKNOWN_ACCOUNT`; created at block 194226547 (2026-04-16T08:23:17.060Z), and NearBlocks dates its deletion 2026-04-16T09:54:48.619Z, 1.5 h later |

### Scorer output at age, verbatim

```
$ node scan/score.mjs scan/benchmark/at-age/d1/verdicts.json
engine: a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0); block: the first block at or after the account's creation + 1 day; signals: account_state, access_keys, age_archival_probes, key_and_code_changes, activity_fastnear, nearblocks_fallback, usdc_blocklist, erc8004, lookalike_fixed_brands; labels_used: false
rows: 30 suspicious (positives), 46 known_good (negatives), 445 lookalike_candidate (not scored)
strict (DENY): precision 100.0%, recall 6.7% (tp 2, fp 0, fn 28)
cautious (WARN or DENY): precision 36.1%, recall 86.7% (tp 26, fp 46, fn 4)
missed suspicious (4):
  NONE  5a7695e3626aeae7c0d340b6e58f813c71455d1be490eeb44e90bd9682343040 [exploiter, security_writeup, deleted]
  NONE  839810a1aef8ed1adb03e795b2a9785d783d4e2f415ab80c8b6fb30483e160f2 [exploiter, security_writeup, deleted]
  NONE  9053223460198e5e1e54dc15c18295ff0e98dca41ecd6c3872da1ff634d99616 [exploiter, security_writeup, deleted]
  NONE  d4e8e706f5a59610d85924af858f0562031930d14eb7add9a433edea50cf0b03 [exploiter, security_writeup, deleted]
flagged known_good (46):
  WARN  17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 [stablecoin]
  WARN  a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near [stablecoin]
  WARN  aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near [token]
  WARN  asset-manager.orderly-network.near [dex]
  WARN  aurora [evm]
  WARN  blackdragon.tkn.near [token]
  WARN  boostfarm.ref-labs.near [farming]
  WARN  contract.main.burrow.near [lending]
  WARN  dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near [stablecoin]
  WARN  dclv2.ref-labs.near [dex]
  WARN  donate.potlock.near [donations]
  WARN  eth.bridge.near [token]
  WARN  factory.bridge.near [bridge]
  WARN  ftv2.nekotoken.near [token]
  WARN  intents.near [intents]
  WARN  linear-protocol.near [liquid_staking]
  WARN  lst.rhealab.near [liquid_staking]
  WARN  meme-cooking.near [launchpad]
  WARN  meta-pool.near [liquid_staking]
  WARN  mpc.hot.tg [wallet_infra]
  WARN  mpdao-token.near [token]
  WARN  nbtc.bridge.near [token]
  WARN  npro.nearmobile.near [token]
  WARN  omni.bridge.near [bridge]
  WARN  outlayer.near [compute]
  WARN  pool.near [staking_factory]
  WARN  priceoracle.near [oracle]
  WARN  simple.market.mintbase1.near [nft_marketplace]
  WARN  social.near [social]
  WARN  storage.herewallet.near [liquid_staking]
  WARN  token.0xshitzu.near [token]
  WARN  token.burrow.near [token]
  WARN  token.lonkingnearbackto2024.near [token]
  WARN  token.paras.near [token]
  WARN  token.rhealab.near [token]
  WARN  token.sweat [token]
  WARN  token.v2.ref-finance.near [token]
  WARN  usdt.tether-token.near [stablecoin]
  WARN  v1.signer [chain_signatures]
  WARN  v2.ref-finance.near [dex]
  WARN  v2_1.omni.hot.tg [bridge]
  WARN  venear.dao [governance]
  WARN  vote.dao [governance]
  WARN  wrap.near [token]
  WARN  xtoken.ref-finance.near [token]
  WARN  zec.omft.near [token]
lookalike_candidate verdicts: {"NONE":445}
  created after the brand: {"NONE":300}; before it: {"NONE":145}; unknown: {}
  over-blocking flags: DENY on brand-created names 0, DENY on names older than the brand 0
no verdict for 4 scored rows
```

```
$ node scan/score.mjs scan/benchmark/at-age/d7/verdicts.json
engine: a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0); block: the first block at or after the account's creation + 7 days; signals: account_state, access_keys, age_archival_probes, key_and_code_changes, activity_fastnear, nearblocks_fallback, usdc_blocklist, erc8004, lookalike_fixed_brands; labels_used: false
rows: 30 suspicious (positives), 46 known_good (negatives), 445 lookalike_candidate (not scored)
strict (DENY): precision n/a, recall 0.0% (tp 0, fp 0, fn 30)
cautious (WARN or DENY): precision 26.8%, recall 36.7% (tp 11, fp 30, fn 19)
missed suspicious (19):
  ALLOW 31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540 [exploiter, security_writeup]
  ALLOW 3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018 [exploiter, security_writeup]
  NONE  5a7695e3626aeae7c0d340b6e58f813c71455d1be490eeb44e90bd9682343040 [exploiter, security_writeup, deleted]
  ALLOW 72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5 [exploiter, security_writeup]
  ALLOW 7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640 [exploit_fake_token, security_writeup]
  ALLOW 80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705 [exploit_fake_token, security_writeup]
  NONE  839810a1aef8ed1adb03e795b2a9785d783d4e2f415ab80c8b6fb30483e160f2 [exploiter, security_writeup, deleted]
  NONE  9053223460198e5e1e54dc15c18295ff0e98dca41ecd6c3872da1ff634d99616 [exploiter, security_writeup, deleted]
  ALLOW 9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee [exploit_fake_token, security_writeup]
  ALLOW burrowfinancedao.near [fake_airdrop_token, researcher_dataset]
  ALLOW c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163 [exploit_fake_token, security_writeup]
  ALLOW d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473 [exploiter, security_writeup]
  NONE  d4e8e706f5a59610d85924af858f0562031930d14eb7add9a433edea50cf0b03 [exploiter, security_writeup, deleted]
  ALLOW dragoneggsmeme.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW lonkrewards.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW nearreward.near [fake_airdrop_token, onchain_campaign_link]
  ALLOW rhea000453.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000462.multica.near [exploit_staging, security_writeup]
  ALLOW rhea000505.multica.near [exploit_staging, security_writeup]
flagged known_good (30):
  WARN  a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near [stablecoin]
  WARN  aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near [token]
  WARN  asset-manager.orderly-network.near [dex]
  WARN  aurora [evm]
  WARN  boostfarm.ref-labs.near [farming]
  WARN  contract.main.burrow.near [lending]
  WARN  dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near [stablecoin]
  WARN  factory.bridge.near [bridge]
  WARN  ftv2.nekotoken.near [token]
  WARN  intents.near [intents]
  WARN  linear-protocol.near [liquid_staking]
  WARN  meme-cooking.near [launchpad]
  WARN  meta-pool.near [liquid_staking]
  WARN  outlayer.near [compute]
  WARN  pool.near [staking_factory]
  WARN  priceoracle.near [oracle]
  WARN  simple.market.mintbase1.near [nft_marketplace]
  WARN  social.near [social]
  WARN  storage.herewallet.near [liquid_staking]
  WARN  token.0xshitzu.near [token]
  WARN  token.burrow.near [token]
  WARN  token.lonkingnearbackto2024.near [token]
  WARN  token.paras.near [token]
  WARN  token.sweat [token]
  WARN  token.v2.ref-finance.near [token]
  WARN  usdt.tether-token.near [stablecoin]
  WARN  v2.ref-finance.near [dex]
  WARN  v2_1.omni.hot.tg [bridge]
  WARN  wrap.near [token]
  WARN  xtoken.ref-finance.near [token]
lookalike_candidate verdicts: {"NONE":445}
  created after the brand: {"NONE":300}; before it: {"NONE":145}; unknown: {}
  over-blocking flags: DENY on brand-created names 0, DENY on names older than the brand 0
no verdict for 4 scored rows
```

`NONE` marks the 4 excluded accounts, and all 445 lookalike rows, which are not
run at age.

### Run at age

| | |
|---|---|
| Plan | `at-age/plan.json`, each account planned between 2026-11-12 16:10:24 and 2026-11-12 18:54:06 (UTC) |
| 1 day | 72 snapshots in `at-age/d1/snapshots/`, collected from 2026-11-12 18:55:31 to 2026-11-12 22:17:04 (UTC) |
| 7 days | 72 snapshots in `at-age/d7/snapshots/`, collected from 2026-11-12 22:18:38 to 2026-11-14 02:50:09 (UTC) |
| Size | the at-age snapshots take 2.4 MB (1 day: 1.0 MB, 7 days: 1.3 MB), `plan.json` 0.3 MB and the four verdict files 0.4 MB |
| Missing data | no at-age verdict has an unanswered read or an indexer failure. Two contracts the engine reads did not exist yet at many replay blocks, and their decided `UNKNOWN_ACCOUNT` answers are kept as the engine reads them: Circle's USDC contract (`blocklist_unreadable`, a hard warning; 32 at 1 day and 32 at 7 days) and Arras's ERC-8004 identity registry (`erc8004_unreadable`, info, never deciding; 72 at 1 day and 72 at 7 days) |
| Reads | keyless and read-only, through `run.mjs`'s per-host pacer. The archival hosts, where nearly every at-age read goes, get a longer gap (`--archival-gap-ms`, 2.4 s by default on FastNEAR's and at least 6.0 s on near.org's). Request counts per host are not given: the runner prints them to its console only, and that output was not kept for every sitting |
| Engine | `a-identity-near-engine/1.1.0 (policy near-default/1; collector a-identity-near-sdk/0.2.0)` |

## Reproduce

From `near/`, Node 22.22.2 or later. Offline, no network:

```
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs --offline --check
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/report.mjs --check
node scan/score.mjs scan/benchmark/verdicts.json
node scan/score.mjs scan/benchmark/verdicts.leave-self-out.json
node scan/score.mjs scan/benchmark/verdicts.no-known.json
npm run verdict -- --offline scan/benchmark/snapshots/metapools.near.json
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/at-age/run.mjs --offline --check
node scan/score.mjs scan/benchmark/at-age/d1/verdicts.json
node scan/score.mjs scan/benchmark/at-age/d7/verdicts.json
npm run verdict -- --offline scan/benchmark/at-age/d1/snapshots/metapools.near.json
node --experimental-strip-types --no-warnings=ExperimentalWarning --test scan/benchmark/benchmark.test.mjs
```

The first command rebuilds the three verdict files from the 176 snapshots and exits 1
unless each matches the committed file byte for byte; without `--check` it writes them. The second
does the same for this file, from `RESULTS.template.md`; without `--check` it writes it. The
`at-age/run.mjs --offline --check` line does the same for the four at-age verdict files, from
`at-age/plan.json` and the 144 at-age snapshots, and checks that
`at-age/PREREGISTRATION.md` still begins with the text written before any at-age read.

Online, one account at the same block (any account in `verdicts.json`):

```
npm run verdict -- metapools.near --network mainnet --at-block 224191308 --no-third-party --registry none \
  --known "$(node -p 'require("./scan/benchmark/known-brands.json").accounts.join(",")')" --json
```

This gives the same verdict, reasons, score and `chain_sha256` as the account's entry in
`verdicts.json`. `snapshot_sha256` differs, because it also covers the indexer answers and the
time they were fetched. Once regular nodes have pruned the block (about two days), the reads go
to archival RPC.

Online, one account at its own replay block, from `at-age/plan.json` (here `metapools.near` at
1 day, block 119261938):

```
npm run verdict -- metapools.near --network mainnet --at-block 119261938 --no-third-party --registry none \
  --known "$(node -p 'require("./scan/benchmark/known-brands.json").accounts.join(",")')" --json
```

This gives the verdict (DENY), reasons, score and `chain_sha256` of the account's
entry in `at-age/d1/verdicts.json`.

Online, the whole run:

```
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs
```

With the committed snapshots in place this collects nothing and rebuilds the verdict files. To
collect again, move `snapshots/` away first; add `--at-block 224191308` to measure the same
block, or leave it out for a new measurement at the latest block. Collecting took about
19 minutes from the first snapshot to the last, keyless, in four sittings
(`--budget-minutes 8` stops starting new accounts after 8 minutes; the next run resumes from the
saved snapshots).

## Limits

- **Small labeled set.** 30 positives and 46 negatives: one row moves recall by
  3.3 points, and one more true or false positive moves cautious precision by
  3.8 or 3.3 points. Read the per-row tables, not only the percentages.
- **Rhea-heavy.** 14 of the 30 suspicious rows come from the Rhea Lend exploit of April
  2026, and 4 of the 6 cautious catches are its deleted worker accounts. On the
  26 suspicious accounts that exist, cautious recall is 2 of 26.
- **What the positives are.** Exploit infrastructure, theft receivers and lure tokens, named in
  public reports or linked on chain to a reported lure campaign, created between
  2021 and 2026. At the block the 26 that exist are older than 30
  days with 5 or more transactions. The engine's rules target a payee that is new, changed in the
  last 72 hours, or a fresh lookalike of a known name. The at-age section replays the 76
  scored accounts at the first block 1 day and 7 days after their own creation blocks
  (pre-registered, archival RPC). It does not replay them at the time of each incident or of a
  victim's payment, which the dataset does not date per account; it measures no other age, so
  the 4 deleted worker accounts, deleted about 1.5 hours after creation by
  NearBlocks' dates, are seen at neither age point; it runs no lookalike row at age; and it
  applies today's engine and today's brand list to blocks from 2020-10-14 on, while the
  USDC contract the engine reads exists only from 2022-11-22 (split (i) there).
- **Label-independent by design.** The signals that would carry what is publicly known about an
  account (an A-Identity registry DENY or open reports, another team's registry) are off,
  because on this dataset they would be filled from the same reports that make the labels. These
  numbers are the engine without shared knowledge. What a registry adds is not measured here.
- **One brand list.** A list from another rule changes the lookalike verdicts and the role-label
  false positives; the ablation and the list sensitivity table show the size of that effect here.
  The list also exempts its own entries from lookalike matching, and 15 of them are
  `known_good` rows: without that exemption 2 of them are warned, and cautious
  precision is 40.0% (6 of 15), not 46.2% (6 of 13).
- **One block.** The 72-hour rules depend on the day: on another day other contracts are
  upgraded inside the window (2 of 46 known_good here).
- **Lookalike rows have unknown intent**, and the sample's 89 proportional draws estimate
  the mix of the 434 rows outside the take-all strata; the 11 take-all rows are
  not representative.
- **Indexer data is not consensus.** FastNEAR and NearBlocks answers are recorded in each
  snapshot (`snapshot_sha256` covers them, `chain_sha256` does not), and only facts bounded by
  the block are used.
- **One keyless run.** Rate limiting was absorbed by retries and failover and left no missing
  data. A read that stays unanswered would make a WARN, never an ALLOW; the runner collects such
  an account again, and the test fails if one was saved.
- **Tied to engine 1.1.0.** If the engine or its policy changes, `run.mjs --offline` and
  `at-age/run.mjs --offline` re-derive every verdict from the same snapshots, `report.mjs` rewrites
  this file from them, and `benchmark.test.mjs` fails until all of them are committed.

Files: `run.mjs` (runner), `report.mjs` (writes this file from `RESULTS.template.md`),
`known-brands.json` (the fixed known list), `snapshots/` (one engine snapshot per account),
`verdicts.json` (score.mjs format, `labels_used: false`), `verdicts.leave-self-out.json` (the
replay without the exemption of listed payees), `verdicts.no-known.json` (the ablation),
`benchmark.test.mjs` (offline checks). The at-age replay is in `at-age/`: `PREREGISTRATION.md`
(the rule, written before any at-age read), `run.mjs` (its runner), `plan.json` (the creation
and replay blocks, with the answers that prove them), and `d1/` and `d7/`, each with
`snapshots/`, `verdicts.json` and `verdicts.leave-self-out.json`.
