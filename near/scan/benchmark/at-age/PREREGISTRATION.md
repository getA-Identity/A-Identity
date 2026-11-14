# Pre-registration: the at-age replay of the NEAR benchmark

Written on 2026-11-12, before any at-age chain read, before any at-age snapshot and before any
at-age verdict existed. At the time of writing, the committed benchmark (commit ad639069, every
account pinned to block 224191308) and its results were known; nothing about the at-age replay
was. This file states the rule the at-age replay follows. It is not edited after the first
at-age read: a change forced by a technical problem is appended under "Amendments" with its time
and reason, and the text above that heading stays as written.

## Why

The committed benchmark observes every account at one recent block, months to years after the
incidents that put the suspicious rows in the dataset. The engine's rules aim at payment time: a
payee that is new, changed in the last 72 hours, or a fresh lookalike of a known name. This
replay measures the same engine on the same accounts at fixed ages after their creation.

## The rule

1. **Accounts.** All 30 `suspicious` and all 46 `known_good` rows of `scan/dataset.json` (76
   accounts). The 445 `lookalike_candidate` rows are left out and not scored. The dataset is read
   only to choose these accounts and to cross-check creation facts. No label, category, source
   type, evidence or note reaches the engine or any file the engine reads.

2. **Creation block, a chain fact.** For each account, the creation block C is the first mainnet
   block at which archival JSON-RPC `view_account` finds the account. It is proven by two archival
   answers: `view_account` at C answers the account, and `view_account` at C's predecessor P (the
   block whose hash is C's `prev_hash`) answers `UNKNOWN_ACCOUNT`. creation_time is C's header
   timestamp (`timestamp_nanosec`). The search starts from the oldest transaction that touches
   the account in FastNEAR's transactions API (`POST https://tx.main.fastnear.com/v0/account`,
   `desc: false`), read fresh, and finds the existence flip with archival `view_account` reads
   (forward from that transaction's block, or by bisection between a height where the account is
   absent and one where it exists). Recorded per account: C and P (height, hash, timestamp), the
   two `view_account` answers, and the locating transaction.
   Cross-checks, recorded and reported, never used to choose a block: (a) the dataset's
   `facts.created_at` (the dataset build's FastNEAR oldest-transaction time): C is expected at or
   after it and within 600 seconds of it; (b) NearBlocks v3 `GET /v3/accounts/{id}` (`created`),
   when it answers. A disagreement is reported with both values; the chain proof decides. Report
   and evidence dates are never used.

3. **The four deleted Rhea worker accounts** (`exists: false` in the dataset). The same method,
   from FastNEAR's transactions for those ids and archival `view_account`. If their creation block
   cannot be proven that way, they are excluded and the report says so.

4. **Age points.** D = 1 day and D = 7 days. The target time is T = creation_time + D * 86400 s,
   exactly, in nanoseconds. The replay block B is the first mainnet block whose timestamp is at
   or after T, proven by: B's timestamp is at or after T, and the timestamp of B's predecessor
   (the block whose hash is B's `prev_hash`) is before T. B is found by interpolation and
   bisection over archival block heights (a skipped height has no block). Recorded per account and
   age point: B and its predecessor (height, hash, timestamp).

5. **Exclusions**, each named in the report with its reason, never dropped silently. An account is
   excluded at an age point when (a) its creation block cannot be proven from the chain, or (b)
   archival `view_account` at B answers `UNKNOWN_ACCOUNT` (it did not exist at the replay block);
   such an account gets no snapshot at that age point. (c) A read that no endpoint answered
   (`UNAVAILABLE`), or an indexer request that failed in transit, is transient: the runner
   collects that account again; an account that still has such a read when collection ends is
   excluded at that age point as a technical failure. A decided answer from the chain is not
   transient (for example, that a contract the engine reads did not exist yet at B): the
   engine's verdict with it is scored as the engine gives it.

6. **Engine inputs**, exactly as in the committed benchmark and nothing else: `--network mainnet
   --at-block B --no-third-party --registry none --known <the 25 names in known-brands.json>`,
   no vault, through the same collector call `run.mjs` makes (`collectSnapshot` with
   `thirdParty: false`, `registry: null`, `vault: null`). Same engine (1.1.0, policy
   `near-default/1`). The engine is given the account id, the network, the block and the known
   list; it is not given the dataset, the labels, the creation facts or the age point. Each
   snapshot records, outside the digests (`meta`), its age point, creation block, target time,
   replay block and the predecessor that proves it, so a reader can check that the block was
   chosen by age.

7. **Scoring.** `node scan/score.mjs` on `at-age/d1/verdicts.json` and `at-age/d7/verdicts.json`
   (`labels_used: false`), unchanged. Positives are the `suspicious` rows, negatives the
   `known_good` rows; strict counts DENY as flagged, cautious WARN or DENY. An excluded account
   has no entry in the verdict file, and score.mjs counts it as `NONE`: an excluded suspicious row
   is a miss and an excluded known_good row is not flagged, so the denominators stay 30 and 46.
   The report also gives the same scorer function over the accounts that have a verdict at that
   age point. Each age point also gets `verdicts.leave-self-out.json`, computed offline from the
   same snapshots exactly as `run.mjs` computes the committed one (each payee compared with the
   known list minus its own name).

8. **Reported.** Per age point and operating point: precision and recall, and the same for
   leave-self-out; the confusion table; every suspicious row with its at-age verdict and deciding
   reasons; every false positive with its reasons; every exclusion with its reason. Two splits are
   fixed now: (i) replay blocks before, and at or after, the creation block of Circle's USDC
   contract on NEAR (`17208628...36133a1`, a `known_good` row, dated by the same method), because
   before it existed the engine cannot read the USDC blocklist; (ii) every verdict whose only
   deciding reasons are missing-data codes (`rpc_unavailable`, `indexer_unavailable`,
   `blocklist_unreadable`), named. The "Summary for quoting" of RESULTS.md gets one added
   sentence with strict and cautious precision and recall at D = 1 and at D = 7, as score.mjs
   prints them.

9. **What would change this rule after seeing results:** nothing. If a technical problem forces a
   change, it is appended below as an amendment with its time and reason.

## Expected from the rules alone, before any data

These follow from `sdk/src/engine/rules.ts` and `policy.ts` and are written down so the results
can be read against them:

- At D = 1 every account that exists is under 72 hours old, so `new_account` (a soft WARN) is
  expected on every scored account, of both classes. Cautious recall at D = 1 is then expected
  to be close to the share of suspicious rows that exist at their replay block, and cautious
  precision close to the share of suspicious rows among the scored rows: the 72-hour rule holds
  every new payee for one owner tap by design, so it does not separate the classes at D = 1.
- A DENY at D = 1 needs a strong lookalike of a name on the known list that is under 72 hours
  old, or another deny fact (`usdc_blocklisted`, a named account that does not exist, excluded
  here by rule 5).
- At D = 7 `new_account` no longer fires; what remains is `low_activity` (fewer than 5
  transactions at the block), `lookalike_known`, `code_changed_recently` and
  `new_full_access_key` for changes between day 4 and day 7, and missing data.
- At a replay block before Circle's USDC contract existed on NEAR, `usdc.is_blocklisted` cannot
  be answered, and the engine fails closed with `blocklist_unreadable`, a hard WARN, whatever the
  payee. Split (i) separates those verdicts.

## Amendments

None at the time of writing.
