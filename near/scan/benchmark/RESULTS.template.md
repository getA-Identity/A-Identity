# Benchmark: the NEAR verdict engine on real mainnet accounts

The A-Identity NEAR verdict engine (`near/sdk`: engine @@ENGINE_SEMVER@@, policy `@@POLICY_ID@@`) run
read-only on NEAR mainnet against the cited dataset in `scan/dataset.json`, and scored by
`scan/score.mjs`. Every number here is as measured on @@BLOCK_DAY@@; nothing is estimated.

`report.mjs` writes this file from `RESULTS.template.md` and the committed run files, and
`benchmark.test.mjs` fails unless the committed file is exactly what they produce. The test also
checks with its own code that each quoted scorer block is the scorer's whole output, and that the
Result, confusion, recall and lookalike stratum tables, the WARN split and the leave-self-out
numbers match the verdict files.

## Summary for quoting

On @@N_TOTAL@@ NEAR mainnet accounts (all @@N_SUS@@ `suspicious` and @@N_KG@@ `known_good` rows of
`scan/dataset.json` and a seeded sample of @@N_LOOK_SAMPLED@@ of its @@N_LOOK@@ `lookalike_candidate`
rows), read-only at block @@BLOCK@@ (@@BLOCK_DAY@@), the engine issued no DENY: strict recall is
@@STRICT_RECALL@@. Counting WARN as flagged, recall is @@C_RECALL@@ and precision @@C_PRECISION@@,
or @@LSO_PRECISION@@ counting the @@N_LSO_CHANGED@@ `known_good` tokens (@@LSO_CHANGED_NAMES@@) that
are not warned only because they are on the engine's known list, whose entries are never compared
as lookalikes. Of the @@N_TP@@ catches, @@N_TP_DELETED@@ are deleted exploit accounts, flagged for not
existing at the block, and @@N_TP_LOOKALIKE@@ are fake airdrop tokens whose names imitate a token on
that list. All @@N_FN@@ misses are older than 30 days with 5 or more transactions at the block, and
@@N_NAMED_15@@ of the @@N_REPORTED@@ suspicious rows named in a report were named within 15 days of
their creation (for the @@N_LAG_BORROWED@@ deleted ones, of a surviving account of the same exploit):
this benchmark observes them months to years after the incident, not at payment time. The engine
was not given the labels (`labels_used: false`); its known list is the top @@N_KNOWN@@ NEP-141 tokens
by on-chain market cap on NearBlocks, @@KNOWN_IN_KG@@ of which are also `known_good` rows.

## Result

| Operating point | Precision | Recall | TP | FP | FN |
|---|---|---|---|---|---|
@@RESULT_ROWS@@

Positives are the @@N_SUS@@ `suspicious` rows, negatives the @@N_KG@@ `known_good` rows. The first two
rows are the benchmark. The other four replay the same snapshots offline with another known list:
each payee compared with the list minus its own name (leave-self-out), and no list at all
(ablation); "The brand list" below explains both.

- **No DENY at all.** The engine's DENY rules need a fact that this data does not contain: a
  named account that does not exist, an entry on Circle's USDC blocklist, a DENY in an
  A-Identity registry (none on mainnet; one filled from these reports would score its own
  labels), or a strong lookalike of a known name that is younger than 72 hours. Every
  suspicious account that still exists is older than 30 days at the block, none is on the USDC
  blocklist, and the @@N_DELETED@@ deleted ones are implicit (hex) accounts, for which absence is a
  soft warning, not a DENY.
- **What was flagged.** Of the @@N_TP@@ suspicious rows flagged, @@N_TP_DELETED@@ are deleted Rhea
  Lend worker accounts, flagged because they do not exist at the block, and @@N_TP_LOOKALIKE@@ are
  fake airdrop tokens whose names imitate a token on the brand list. None was flagged for anything
  it did.
- **What was missed.** The @@N_FN@@ misses are exploit, theft and lure accounts created between
  @@MISS_FIRST@@ and @@MISS_LAST@@. At the block each one is older than 30 days with 5 or more
  transactions (`long_history`), and nothing about them changed in the 72 hours before it. By the
  dataset's `last_tx_at`, @@N_MISS_IDLE@@ of the @@N_FN@@ last transacted before 2025. The engine
  warns on newness, recent change, thin history, lookalike names and missing data; nothing it reads
  on mainnet records that an account was reported.
- **False positives.** Of the @@N_FP@@, @@N_FP_CODE@@ are contract upgrades inside the 72-hour window
  (the rule holds such a payment for one owner tap on purpose), and @@N_FP_TOKEN@@ are `token.*`
  contracts that the weak role-label rule matches to a `token.*` account on the brand list. Any of the @@N_LISTED_TOKENS@@
  listed ones (@@LISTED_TOKENS@@) gives that same match; the engine names `@@TIE_NAME@@` only
  because it breaks ties between equal matches in sorted order, and neither removing it nor keeping
  only the top 10 removes these false positives (list sensitivity, below). The list also holds
  @@N_LSO_CHANGED@@ `known_good` `token.*` contracts, @@LSO_CHANGED_NAMES@@, that would match too;
  they are not warned only because a listed payee is never compared as a lookalike (the
  leave-self-out rows).

The engine's rules target a payee that is new, changed in the last 72 hours, or a fresh
lookalike of a name the owner knows (`sdk/README.md`, decision table). At the benchmark block
(@@BLOCK_DAY@@) every suspicious account that exists is more than 30 days old with 5 or more
transactions (`long_history`). Most were named within days of their creation (@@N_NAMED_15@@ of the
@@N_REPORTED@@ reported rows within 15 days), so this benchmark observes them months to years after
the incident, not at payment time.

| Days from creation to the earliest report that names the account | Rows | Observed | By source |
|---|---|---|---|
@@NAMING_ROWS@@

Creation is the row's `facts.created_at`, and the report date is the earliest `date` in its
`evidence`; "Every suspicious row" gives the number for each row. The @@N_LAG_BORROWED@@ deleted worker
accounts have no creation date in the dataset, so they are counted from @@LAG_BORROWED_FROM@@, the
creation of `@@LAG_BORROWED_BY@@`, the one account named in the same sentence of the same report that
still exists. Replaying each account at a block near its incident would measure the engine where
its rules aim; this run does not (Limits).

## Run

| | |
|---|---|
| Date | @@BLOCK_DAY@@. Snapshots collected @@COLLECTED@@ (UTC), keyless (no `FASTNEAR_API_KEY`, no `NEARBLOCKS_API_KEY`) |
| Network | NEAR mainnet, read-only: JSON-RPC view queries and indexer queries. Nothing signed or sent |
| Block | every account pinned to block **@@BLOCK@@** (hash `@@BLOCK_HASH@@`, @@BLOCK_UTC@@) |
| Probe blocks | 72 h line: @@PROBE_RECENT@@; 30-day line: @@PROBE_LONG@@ (the same for every account that exists) |
| Dataset blocks | the dataset checked its rows at blocks @@DS_BLOCKS@@ (`facts.block_height`), about @@DS_HOURS@@ hours earlier; each verdict entry records both as `block` and `dataset_block_height` |
| Engine | `@@ENGINE@@` |
| Rows run | @@N_KG@@ known_good, @@N_SUS@@ suspicious and @@N_LOOK_SAMPLED@@ of the @@N_LOOK@@ lookalike_candidate rows: @@N_TOTAL@@ accounts |
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
@@N_KNOWN@@ names in `known-brands.json`. It reads `scan/dataset.json` only to choose the accounts and
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
@@N_TOTAL@@: the known list equals `known-brands.json`, no third-party registry, no registry,
no vault, mainnet reads only, one block. The three verdict files declare `labels_used: false`, and
their entries carry no label.

### The brand list

Lookalike detection compares a payee with a known list; with an empty list there is nothing to
compare with. The list is fixed by a rule that does not look at the dataset: the first
@@N_KNOWN@@ NEP-141 tokens of NearBlocks' token list ordered by on-chain market cap, fetched once
(`GET https://api.nearblocks.io/v1/fts?page=1&per_page=25&sort=onchain_market_cap&order=desc`,
@@KNOWN_FETCHED@@; Powered by Nearblocks.io APIs). The rule was written before the fetch and
before any benchmark verdict, and the answer was not edited.

Its content is not independent of the dataset, and that is stated here rather than hidden:
@@KNOWN_IN_KG@@ of the @@N_KNOWN@@ are `known_good` rows (the largest tokens are also what the dataset
calls known good). The @@N_TP_LOOKALIKE@@ caught fake tokens imitate @@TP_BRANDS@@.

The engine reads the list in two ways, and two offline replays of the same @@N_TOTAL@@ snapshots
separate them:

- **Lookalike matching.** Every payee that is not on the list is compared with every name on it.
  `verdicts.no-known.json` replays with an empty list: @@ABL_TP_DIFF@@ fewer true positives (the
  caught fake tokens; no other suspicious row changes), @@ABL_FP_DIFF@@ fewer false positives and
  @@ABL_LOOK_DIFF@@ fewer lookalike rows warned.
- **The exemption of listed payees.** A payee whose own name is on the list is never compared as
  a lookalike (`sdk/src/engine/normalize.ts`: `isKnown ? null : findLookalike(...)`); it gets the
  `known_payee` info reason instead. That protects @@KNOWN_IN_KG@@ of the @@N_KG@@ negatives, the
  `known_good` rows on the list. The ablation cannot show this, because an empty list turns
  lookalike matching off altogether. `verdicts.leave-self-out.json` replays each account with the
  list minus its own name. It does the same for every account and reads no label, so only the
  @@N_ON_LIST@@ accounts whose own name is on the list can change. Of those, @@N_LSO_CHANGED@@ `known_good`
  rows, @@LSO_CHANGED_NAMES@@, are not warned only because a listed payee is never compared as a
  lookalike; counted, cautious precision would be @@LSO_PRECISION@@ instead of @@C_PRECISION@@.

| Account | Rank | As run | Leave-self-out | Match in the replay |
|---|---|---|---|---|
@@LSO_ROWS@@

| Rank | Account | Symbol | Dataset row |
|---|---|---|---|
@@KNOWN_ROWS@@

### List sensitivity

The same snapshots, replayed offline with known lists cut from the same ranking (`report.mjs`
computes these; no network). They show whether the `token.*` false positives depend on
`@@TIE_NAME@@`, the name the engine happens to report.

| Known list | Cautious precision | Cautious recall | FP | `token.*` FP | Matched to |
|---|---|---|---|---|---|
@@SENS_ROWS@@

Without `@@TIE_NAME@@` the same false positives are matched to `@@NEXT_MATCH@@`. With only the top
10, the @@N_FP_TOKEN@@ stay and @@TOP10_EXTRA@@, no longer on the list and so no longer exempt, adds
to them (@@TOP10_TOKEN_FP@@ in all). No list gives a DENY, so strict precision is n/a and strict
recall @@STRICT_RECALL@@ on each.

## Scorer output, verbatim

```
$ node scan/score.mjs scan/benchmark/verdicts.json
@@SCORE_MAIN@@
```

`NONE` in the lookalike lines counts the @@N_LOOK_NONE@@ lookalike rows outside the sample.

Leave-self-out, the same snapshots with each payee's own name left out of the known list:

```
$ node scan/score.mjs scan/benchmark/verdicts.leave-self-out.json
@@SCORE_SELF@@
```

The ablation, the same snapshots with an empty known list:

```
$ node scan/score.mjs scan/benchmark/verdicts.no-known.json
@@SCORE_ABLATION@@
```

## Confusion table

| | ALLOW | WARN | DENY | Rows |
|---|---|---|---|---|
@@CONFUSION_ROWS@@

Recall by kind of evidence (cautious; strict recall is 0 everywhere):

| Group | Rows | Flagged |
|---|---|---|
@@RECALL_ROWS@@

## Every suspicious row

The deciding reasons are the warnings and denials that set the verdict; for an ALLOW, the
positive signals. `soft` marks a warning that only says nobody has history with the payee yet.
"Named after" is the time from the account's creation to the earliest report that names it
(see Result).

| Account | Verdict | Score | Engine's reasons | Named after | Why |
|---|---|---|---|---|---|
@@SUSPICIOUS_ROWS@@

## Every false positive

| Account | Verdict | Score | Engine's reasons | Why |
|---|---|---|---|---|
@@FP_ROWS@@

The other @@N_KG_ALLOW@@ known_good rows are ALLOW at score @@KG_ALLOW_SCORE@@ (`long_history`).

## Lookalike candidates (not scored)

These rows are names close to a known_good brand that exist on mainnet. Their intent is
unknown, so a WARN on one is neither right nor wrong; the dataset README says not to score them,
and `score.mjs` reports only the mix.

**Sample.** @@N_LOOK_SAMPLED@@ of the @@N_LOOK@@ rows, drawn by `sampleLookalikes` in `run.mjs`
with the seed `@@SEED@@`. Two strata are taken whole: the names the imitated brand registered
itself (`created_by_brand`, @@N_BRAND@@ rows; a DENY there is an over-blocking flag in
`score.mjs`) and the names created in the 30 days before the dataset checked them
(@@N_RECENT@@ rows, the README's recent names). The other @@N_DRAWS@@ draws are shared among
strata by `predates_brand` and generator rule in proportion to their size (largest remainder);
inside a stratum, rows are ordered by `sha256("<seed>|<account_id>")` and the first ones taken.
`node scan/benchmark/run.mjs --list` prints the strata and the accounts.

| Stratum | Rows | Sampled | ALLOW | WARN | DENY | WARN without the brand list |
|---|---|---|---|---|---|---|
@@STRATA_ROWS@@

Of the @@N_LOOK_WARN@@ WARN verdicts, @@W_LOW@@ come from `low_activity` alone (fewer than 5
transactions; soft), @@W_LOOK@@ from `lookalike_known` alone and @@W_BOTH@@ from both. There is
no DENY, so both over-blocking flags of `score.mjs` are 0. The `lookalike_known` warnings include
@@N_OLD_LK@@ on names older than the brand they resemble (@@OLD_LK_NAMES@@): the nearest thing to
over-blocking in this run, at WARN. No lookalike row is on the brand list, so the leave-self-out
replay leaves all of them as they are.

The take-all rows by name:

| Account | Stratum | Verdict | Engine's reasons | Note |
|---|---|---|---|---|
@@TAKEALL_ROWS@@

The @@N_BULK@@ names created by `@@BULK_CREATOR@@` on @@BULK_DAYS@@ are held only because they
have 1 transaction each. The lookalike rule does not match any of them: `intents.near` is not on
the brand list, and `wr4p` against `wrap` is a 4-character name, which matches only on an identical
skeleton (`4` is not folded to `a`).

## Reproduce

From `near/`, Node 22.22.2 or later. Offline, no network:

```
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs --offline --check
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/report.mjs --check
node scan/score.mjs scan/benchmark/verdicts.json
node scan/score.mjs scan/benchmark/verdicts.leave-self-out.json
node scan/score.mjs scan/benchmark/verdicts.no-known.json
npm run verdict -- --offline scan/benchmark/snapshots/metapools.near.json
node --experimental-strip-types --no-warnings=ExperimentalWarning --test scan/benchmark/benchmark.test.mjs
```

The first command rebuilds the three verdict files from the @@N_TOTAL@@ snapshots and exits 1
unless each matches the committed file byte for byte; without `--check` it writes them. The second
does the same for this file, from `RESULTS.template.md`; without `--check` it writes it.

Online, one account at the same block (any account in `verdicts.json`):

```
npm run verdict -- metapools.near --network mainnet --at-block @@BLOCK@@ --no-third-party --registry none \
  --known "$(node -p 'require("./scan/benchmark/known-brands.json").accounts.join(",")')" --json
```

This gives the same verdict, reasons, score and `chain_sha256` as the account's entry in
`verdicts.json`. `snapshot_sha256` differs, because it also covers the indexer answers and the
time they were fetched. Once regular nodes have pruned the block (about two days), the reads go
to archival RPC.

Online, the whole run:

```
node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs
```

With the committed snapshots in place this collects nothing and rebuilds the verdict files. To
collect again, move `snapshots/` away first; add `--at-block @@BLOCK@@` to measure the same
block, or leave it out for a new measurement at the latest block. Collecting took about
@@COLLECT_MIN@@ minutes from the first snapshot to the last, keyless, in four sittings
(`--budget-minutes 8` stops starting new accounts after 8 minutes; the next run resumes from the
saved snapshots).

## Limits

- **Small labeled set.** @@N_SUS@@ positives and @@N_KG@@ negatives: one row moves recall by
  @@RECALL_STEP@@ points, and one more true or false positive moves cautious precision by
  @@PREC_UP@@ or @@PREC_DOWN@@ points. Read the per-row tables, not only the percentages.
- **Rhea-heavy.** @@N_RHEA@@ of the @@N_SUS@@ suspicious rows come from the Rhea Lend exploit of April
  2026, and @@N_TP_DELETED@@ of the @@N_TP@@ cautious catches are its deleted worker accounts. On the
  @@N_EXIST@@ suspicious accounts that exist, cautious recall is @@N_EXIST_CAUGHT@@ of @@N_EXIST@@.
- **What the positives are.** Exploit infrastructure, theft receivers and lure tokens, named in
  public reports or linked on chain to a reported lure campaign, created between
  @@SUS_FIRST_YEAR@@ and @@SUS_LAST_YEAR@@. At the block the @@N_EXIST@@ that exist are older than 30
  days with 5 or more transactions. The engine's rules target a payee that is new, changed in the
  last 72 hours, or a fresh lookalike of a known name. Replaying each account at a block near its
  incident (`--at-block`, archival RPC) would measure that design; this run does not.
- **Label-independent by design.** The signals that would carry what is publicly known about an
  account (an A-Identity registry DENY or open reports, another team's registry) are off,
  because on this dataset they would be filled from the same reports that make the labels. These
  numbers are the engine without shared knowledge. What a registry adds is not measured here.
- **One brand list.** A list from another rule changes the lookalike verdicts and the role-label
  false positives; the ablation and the list sensitivity table show the size of that effect here.
  The list also exempts its own entries from lookalike matching, and @@KNOWN_IN_KG@@ of them are
  `known_good` rows: without that exemption @@N_LSO_CHANGED@@ of them are warned, and cautious
  precision is @@LSO_PRECISION@@, not @@C_PRECISION@@.
- **One block.** The 72-hour rules depend on the day: on another day other contracts are
  upgraded inside the window (@@N_FP_CODE@@ of @@N_KG@@ known_good here).
- **Lookalike rows have unknown intent**, and the sample's @@N_DRAWS@@ proportional draws estimate
  the mix of the @@N_PROP_ROWS@@ rows outside the take-all strata; the @@N_TAKEALL@@ take-all rows are
  not representative.
- **Indexer data is not consensus.** FastNEAR and NearBlocks answers are recorded in each
  snapshot (`snapshot_sha256` covers them, `chain_sha256` does not), and only facts bounded by
  the block are used.
- **One keyless run.** Rate limiting was absorbed by retries and failover and left no missing
  data. A read that stays unanswered would make a WARN, never an ALLOW; the runner collects such
  an account again, and the test fails if one was saved.
- **Tied to engine @@ENGINE_SEMVER@@.** If the engine or its policy changes, `run.mjs --offline`
  re-derives every verdict from the same snapshots, `report.mjs` rewrites this file from them, and
  `benchmark.test.mjs` fails until both are committed.

Files: `run.mjs` (runner), `report.mjs` (writes this file from `RESULTS.template.md`),
`known-brands.json` (the fixed known list), `snapshots/` (one engine snapshot per account),
`verdicts.json` (score.mjs format, `labels_used: false`), `verdicts.leave-self-out.json` (the
replay without the exemption of listed payees), `verdicts.no-known.json` (the ablation),
`benchmark.test.mjs` (offline checks).
