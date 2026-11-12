# NEAR mainnet real-data dataset

A labeled, cited set of real NEAR **mainnet** accounts that the A-Identity verdict engine is
benchmarked on, so the entry shows verdicts on accounts that exist, not on demo labels.
Everything here was read from mainnet **read-only** (view calls and a public indexer); this
folder holds no keys and sends no transactions.

**Risk signals, not accusations.** A `suspicious` row means a public report or an on-chain
fact ties the account to a scam, a phishing theft or an exploit, and the row says which. A
`lookalike_candidate` row means only that a name close to a known brand exists. Neither is a
finding of guilt, and nothing in this dataset is written to any on-chain registry.

| File | What it is |
|---|---|
| `dataset.json` | the dataset: one JSON array, one object per account (schema below) |
| `dataset.summary.json` | counts, block range, `checked_at` window, endpoints, generator version, and how the last build got its answers (from the day's cache or live, with request stats) |
| `seeds/known-good.json`, `seeds/suspicious.json` | the cited, hand-curated input: account, category, evidence (URL, date, exact quote) |
| `lookalikes.mjs` | the deterministic lookalike-name generator and the lookalike row annotations (pure, no network) |
| `build-dataset.mjs` | live checks plus the lookalike sweep; writes `dataset.json` and `dataset.summary.json` |
| `spot-check.mjs` | live, about a minute: replays every cited row and a random lookalike sample at its recorded block and compares with `dataset.json` |
| `check-citations.mjs` | re-fetches every cited source and checks every quote |
| `score.mjs` | scores an engine's verdicts against the dataset (the benchmark protocol below) |
| `lib.mjs` | zero-dependency read-only clients (JSON-RPC pool with archival fallback, FastNEAR indexer) |
| `dataset.test.mjs`, `score.test.mjs` | offline checks: schema, citations match the seeds, the campaign rule, every lookalike re-derives, summary and README numbers match the data, scorer math |
| `SOURCES.md` | every source, what it supports, and what was looked at and left out |

## Snapshot

Built on 2026-11-12. `view_account` answered between mainnet blocks 224151709 and 224153995
(02:32 to 02:54 UTC), and each row's access keys and token metadata were read at that row's
own block. All 117 citations were re-verified live the same day (`check-citations.mjs`:
117/117), and `spot-check.mjs` replayed all 76 cited rows and a 20-row lookalike sample
at their recorded blocks with 96/96 matching (106/106 with `--keys` and a 30-row sample,
access-key counts included). The committed build (05:34 UTC) replayed the
existence checks and indexer answers from that morning's cache and read keys and token
metadata live for 517 accounts; `dataset.summary.json` records which was which.

| Label | Rows | Exist at the checked block |
|---|---|---|
| `known_good` | 46 | 46 |
| `suspicious` | 30 | 26 (the other 4 are Rhea exploit worker accounts deleted after the attack) |
| `lookalike_candidate` | 445 | all (only existing names are kept) |

The lookalike sweep generated 3,745 names from the known_good brands; 448 exist on mainnet
(3 of them, linear_protocol.near, metapools.near and lonkrewards.near, are already
`suspicious` rows and are not repeated).

### What the sweep found

- Nine lookalike names were created in the 30 days before the snapshot. Five of them come
  from one implicit account (`4d31fbb4...f064`) on 2026-10-19 and 2026-10-20:
  `1ntents.near`, `iintents.near`, `int3nts.near` and `intent5.near` (all imitating
  `intents.near`) and `wr4p.near` (`wrap.near`). Each holds no NEAR, one full-access key and
  one transaction: registered, not yet used. Unknown intent.
- Two lookalike names are NEP-141 contracts whose metadata copies Tether's token exactly
  (`neartether.near` and `tether-near.near`: name "Tether USD", symbol "USDt", same code hash;
  the first created the second in December 2025). A payment check that trusts token
  metadata would take them for USDt.
- One implicit account (`03ae5523...23f7`) created ten of the names, mostly copies of
  `usdt.tether-token.near` (`tether_token.near`, `tethertoken.near`, `usdttether-token.near`, ...),
  and `titiku.near` created 54 (MimicWatch reports 92 across its own brand list).
- 176 of the 445 names were also found by MimicWatch's independent scan of 2026-11-01. Two
  were created by the imitated brand itself (`orderlynetwork.near`, `mintbasev2.near`):
  defensive registrations.
- 145 of the 445 names were created before every known_good account that uses their brand
  word (`facts.predates_brand`), for example `aurora.near` (2020-09-16) before `aurora`
  (2021-04-15) and `rhea.near` (2021-04-17) before `token.rhealab.near` (2025-05-06). They are
  most likely older, unrelated names, so a DENY on one is over-blocking; MimicWatch lists 42 of
  them. None of the nine recent names predates its brand.
- Only 3 of the 30 suspicious rows have lookalike names. Most are implicit (hex) exploit
  accounts or unrelated names, so a lookalike signal alone cannot catch them: the engine
  needs the other signals (age, keys, code, registry verdicts and reports).

## Re-run

Node >= 22.22.2 (no dependencies; `npm ci` is not needed for this folder). From `near/`:

```bash
node --test "scan/*.test.mjs"                  # offline, seconds: schema, citations = seeds, campaign rule, lookalikes re-derive, summary and README numbers, scorer
node scan/spot-check.mjs                       # live, about 1 minute: replay all cited rows + 20 random lookalike rows at their recorded block
node scan/check-citations.mjs                  # live, about 1 minute: re-fetch every source, check every quote and that it names the row's account
node scan/build-dataset.mjs --skip-lookalikes  # live, 3 to 5 minutes: re-check the cited rows, keep the last sweep (same UTC day: add --refresh)
node scan/build-dataset.mjs                    # live, 25 minutes to several hours: everything, including the lookalike sweep (same UTC day: add --refresh)
node scan/score.mjs verdicts.json              # score declared engine verdicts: precision, recall, misses by name
```

`spot-check.mjs` is the quick way to check the published file against the chain: it reads
everything fresh (no cache), replays `view_account` at each row's `facts.block_height` (exists,
code hash, balance; `--keys` adds the access-key counts) and the indexer's oldest transaction
of each sampled lookalike row (created_at, creation_tx, creator), and fails on any difference.
Drift since the snapshot (a contract upgraded, an account deleted) is listed, not failed.
`--sample N` sets the sample size; every run prints its seed and `--seed` repeats a sample.
Once regular nodes have garbage-collected the snapshot blocks (about two days), the replay goes
to FastNEAR's archival node, which is slower.

`build-dataset.mjs` rewrites `dataset.json` and `dataset.summary.json` (`--out` and
`--summary` write elsewhere, to compare). It paces every host (about 2 requests a second per
FastNEAR RPC host, 6 on dRPC, 1.4 on the FastNEAR indexer), benches a host that answers 429 and
moves to the next one, and caches answers per UTC day in `scan/.cache/` (git-ignored), so an
interrupted run resumes where it stopped; a second run on the same UTC day replays that cache
unless `--refresh` is given, and the summary's `cache` block says how many accounts came from
it. The sweep runs in two phases: existence for every generated name, then enrichment for the
names that exist. Runtimes depend on the keyless FastNEAR limits, above all the transactions
API, which answers 429 for long stretches under load. Options: `--refresh`, `--workers N`,
`--rpc url1,url2`, `--rpc-gap ms`, `--drpc-gap ms`, `--tx-gap ms`, `--out path`,
`--summary path`. `npm test` in `near/` also picks up `scan/*.test.mjs`.

## Schema

Each object in `dataset.json`:

| Field | Type | Meaning |
|---|---|---|
| `account_id` | string | NEAR account id (named, or 64-hex implicit) |
| `network` | `"mainnet"` | always mainnet |
| `label` | `known_good` \| `suspicious` \| `lookalike_candidate` | see "How labels were chosen" |
| `category` | string | known_good: token, stablecoin, dex, lending, liquid_staking, bridge, ...; suspicious: fake_airdrop_token, exploiter, exploit_fake_token, exploit_staging, phishing_receiver, theft_receiver; lookalike_candidate: the generator rule that produced the name |
| `evidence` | `[{url, date, quote}]` | known_good and suspicious: the citations from the seed file, quote exact (see SOURCES.md); lookalike_candidate: one derived record (rule, block, creation) with a NearBlocks link for humans |
| `exists` | boolean | `view_account` found the account at `facts.block_height` |
| `checked_at` | ISO 8601 UTC | when that `view_account` ran |
| `notes` | string | what the row claims and how strong the evidence is |
| `facts` | object | live data, below |

`facts`: always `block_height` (the block `view_account` answered at). When the account exists,
also `balance_near`, `has_contract` and `code_hash` from that answer; `full_access_keys` and
`function_call_keys` from `view_access_key_list` and `ft_name` / `ft_symbol` when the contract
answers `ft_metadata`, both read **at the same block**; and from the FastNEAR indexer
`created_at`, `creation_tx`, `creator` (signer of the oldest transaction touching the account:
history, fixed), `txs_count` and `last_tx_at` (as of the indexer read, the same UTC day).
`creation_indexed: false` marks an account the indexer answered for but has no transaction for;
`enrichment_error` names a read that failed after every retry, and the row then states only what
was read. Non-ASCII characters in a token name are replaced by `?` and flagged with
`ft_metadata_non_ascii`, because token names are attacker-controlled (`nearreward.near` writes
its domain with a one-dot-leader character instead of a period). Label-specific: known_good rows
carry `stems` (the brand words the generator imitates); suspicious rows carry `source_type`,
`incident` and, when the generator also produces the name, `lookalike_of` and
`lookalike_rule`; lookalike_candidate rows carry `imitates`, `stem`, `rule`, `predates_brand`
(created before every known_good account that contributes the stem), `created_by_brand`
(created by the imitated brand's own root account or one of its known contracts: a defensive
registration), `creator_lookalikes` (how many lookalike rows the same creator made; large and
meaningless for public onboarding relayers such as `meteor-relayer.near`,
`free-name.herewallet.near` and `coin-op.near`, which create names for anyone) and
`mimicwatch_2026_11_01` (MimicWatch's label when its scan found the same name).

## How labels were chosen

### known_good

A major NEAR mainnet protocol contract, token or service account (46: tokens and stablecoins,
DEX, lending, liquid staking, bridges, NEAR Intents, oracles, governance, NFT, social and
infrastructure contracts), tied to at least one public source that names it: the project's own
docs or repo config, the issuer's page (Circle, Tether), or an ecosystem registry (the NEAR
Intents 1Click token list, Intear's token reputation list). Each quote is an exact substring of
the source, re-checked by `check-citations.mjs`. Every known_good account exists at the
checked block. "known_good" means "the legitimate counterparty this name refers to", not
"safe": the Rhea Lend contract, for one, was itself drained in April 2026 (it is the victim in
section 3.2 of SOURCES.md).

### suspicious

Publicly reported as a scam, phishing, fake-airdrop, drainer or exploit account, with the
report's URL, date and an exact quote naming the account, or tied to such a report by the
campaign rule below. 26 of the 30 suspicious rows are named as scam, exploit or theft accounts
in a third-party report; the other 4 are added by the campaign rule from on-chain facts.
Nothing is invented: a candidate whose report could not be found again, or which turned out to
be an exchange wallet, a victim, or a recovery address, was dropped (SOURCES.md section 5 lists
them). `source_type` grades the evidence:

| source_type | Meaning | Rows |
|---|---|---|
| `security_writeup` | an incident write-up by a security publication or firm (rekt.news, QuillAudits, Blockaid's alert) | 16 |
| `project_incident_report` | the affected project's own post-mortem | 2 |
| `researcher_dataset` | a public, reproducible scan that flags this account, with an evidence file for it (MimicWatch, 2026-11-01) | 3 |
| `victim_report` | a single victim's post on the NEAR governance forum, checked on chain for consistency | 5 |
| `onchain_campaign_link` | the campaign rule below: on-chain facts, no third-party report of its own | 4 |

**Campaign rule.** An account is added as `onchain_campaign_link` only when both hold, and the
row cites both on-chain facts: (1) a `create_account` transaction links it to the campaign: it
was created by, or it created, an account that a public report names as a fake-airdrop token,
or an account already added by this rule; and (2) its own `ft_metadata` name advertises a
website, the pattern NEAR Protocol warned about on 2022-10-09 ("Do not go to links that appear
in token names"). Four accounts qualify: `nearrewards.near` (it created `burrowfinancedao.near`),
`nearreward.near` (created by `nearrewards.near`), and `dragoneggsmeme.near` and
`lonkrewards.near` (created by `burrowfinancedao.near`). Three other accounts created by
`nearrewards.near` were left out because they carry no such lure. `dataset.test.mjs` checks the
rule on the seed file: every campaign row must reach a reported account through its quoted
creation transactions, and its own token name must carry a URL.

Deleted accounts stay listed with `exists: false` (four Rhea exploit worker accounts): an
agent could still be told to pay that id, and a payment to a deleted implicit account
re-creates it.

### lookalike_candidate

Names generated by a fixed rule from the known_good brands (`lookalikes.mjs`, a pure
function, version `lookalikes/2`) that **exist** on mainnet. Intent is unknown: most are
probably someone's own name or a defensive registration. They are not ground truth and must
not be scored as positives.

For every known_good row, the generator takes its brand stems (declared in the seed next to
the citation, for example `blackdragon` for `blackdragon.tkn.near`, whose parent `tkn.near`
is an open token factory) and applies, one at a time:

| Rule | Example |
|---|---|
| `homoglyph`: one ASCII confusable (o/0, l/1/i, e/3, a/4, s/5, rn/m, vv/w, cl/d) | `ref-flnance.near` |
| `separator`: drop, swap or insert `-` / `_` | `linear_protocol.near` |
| `separator_dot`: turn a separator into a dot (a sub-account of another name) | `ref.finance.near` |
| `typo_deletion`, `typo_duplication`, `typo_transposition` (stems of 4+ characters) | `buurrow.near` |
| `affix`: lure and brand words (`-airdrop`, `-claim`, `-rewards`, `-support`, `-official`, `near-`, `v2-`, ...) | `burrow-airdrop.near` |
| `flattened_subaccount`: a sub-account id flattened into one name | `contract-main-burrow.near` |
| `exact_stem`, `exact_stem_tg`: the bare stem under `.near` or `.tg` (HOT usernames) | `ref-finance.tg` |

Excluded: the known_good accounts themselves, every ancestor of one (`mintbase1.near` is
Mintbase's own factory, the parent of `market.mintbase1.near`, so it cannot imitate
`simple.market.mintbase1.near`; open registrars included), and everything under a brand's own
root (only the parent can create sub-accounts, so `x.ref-finance.near` cannot be an impostor),
except under open registrars anyone can use (`near`, `tg`, `sweat`, `tkn.near`, `pool.near`,
...). Implicit (hex) known_good accounts have no name to imitate. NEAR ids are ASCII only, so
Unicode homoglyphs cannot exist on chain. A candidate is kept only if `view_account` finds it;
each kept row is then enriched like the others. `node --test "scan/*.test.mjs"` re-derives every
`lookalike_candidate` row from `seeds/known-good.json`, recomputes its cross-row facts and its
evidence line, and fails if one was not produced by the rule.

## Benchmark protocol (for the engine)

1. **No label leakage.** Every signal that reads this dataset's labels or their sources is
   switched off for a benchmark run: `seeds/*.json` and `dataset.json` themselves, the cited
   reports, the MimicWatch scan (the source of the `researcher_dataset` rows), an allowlist
   built from the known_good seeds, and an on-chain registry or oracle populated from any of
   these (the engine's registry verdict and report signals, once the registry holds verdicts
   written from this set). The verdicts file declares what was on:

   ```json
   {
     "engine": "a-identity-near-engine/1.1.0",
     "signals": ["account", "keys", "fastnear", "usdc_blocklist", "lookalike"],
     "labels_used": false,
     "verdicts": { "<account_id>": "ALLOW | WARN | DENY" }
   }
   ```

   `score.mjs` prints the declaration, refuses a file without one (exit 2), and refuses
   `labels_used: true` (exit 3) unless `--with-labels` is given, in which case the output opens
   with "NOT A BENCHMARK RESULT" (`benchmark: false` with `--json`). A with-labels number is
   shown only next to the run without labels.
2. Run the engine on every `known_good` and `suspicious` row. Positives are `suspicious`,
   negatives are `known_good`. Report two operating points: strict (predicted positive =
   DENY) and cautious (predicted positive = WARN or DENY), each with precision, recall and the
   list of misses (suspicious rows the engine allowed, known_good rows it warned on or denied),
   so misses are named, not averaged away.
3. Report recall separately per `source_type` and for `exists: false` rows, because the
   evidence strength differs and a deleted account has no state to score.
4. Report the verdict distribution on `lookalike_candidate` rows without scoring it, split by
   `predates_brand`; a DENY on a `created_by_brand` row or on a name older than its brand is a
   red flag for over-blocking (`score.mjs` lists both).
5. Signals drift: record the block the engine read at, next to `facts.block_height`, so a
   verdict can be recomputed from public data at a recorded block.

## Ethics

- Labels are risk signals for a payment guard that holds or refuses a payment for a human to
  review. They are not public accusations and are not published to any registry.
- Victims are never listed. Exchange hot wallets and deposit addresses that appear in theft
  reports are excluded on purpose (SOURCES.md section 5).
- Every row carries its evidence and its strength (`source_type`), so a reader can disagree
  with a row and say why.
- Corrections: if a row is wrong, open an issue with the account id and the evidence; the row
  is removed or relabeled in the next build.

## Limits

- The suspicious set is small and skewed: 14 of 30 rows come from one incident (Rhea Lend), and
  most rows are exploit accounts rather than everyday scam payees. Public, citable reports of
  NEAR scam accounts are rare; we did not pad the set with unreported accounts.
- The generator finds only the names it generates; a scammer's `rhea-lucky-draw-2026.near`
  is invisible to it.
- `created_at` and `creator` come from one indexer (FastNEAR); `txs_count` counts any
  transaction touching the account, so it differs from other explorers' counts. The indexer
  cannot be read at a past block, so `txs_count` and `last_tx_at` are as of the build day.
- The snapshot ages: accounts get deleted, keys change, tokens migrate. `spot-check.mjs` lists
  that drift; re-run the build and compare `dataset.summary.json` for a new snapshot.

Data: NEAR mainnet via FastNEAR and dRPC; creation and activity from the FastNEAR transactions
API; campaign research Powered by Nearblocks.io APIs; MimicWatch data (MIT) attributed in
SOURCES.md.
