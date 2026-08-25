# Remediation log

Finding -> commit -> what proves it. Every entry with a "negative control" column was
verified by re-introducing the defect and watching the suite go red, then restoring it.

| Finding | Severity | Commit | Evidence | Negative control |
| --- | --- | --- | --- | --- |
| A8-01 | High | `670b05f` | `soroban/audit/ghsa-check.mjs`, exit 0 on the real lock, exit 1 on a lock pinning soroban-sdk 22.0.0 and stellar-strkey 0.0.7, exit 2 with no token | yes: `cargo audit` reports nothing on the same lock |
| A8-02 | Medium | `670b05f` | CI now runs `stellar contract build`; a hash gate pins `155eb31c...79239` | yes: verified the two build paths differ, 28,728 vs 11,625 bytes |
| A8-03 | Medium | repo settings | secret scanning and push protection enabled on both remotes, read back from the API | n/a |
| A2-01 | Low | `0d9bd70` | `test/durability.rs` asserts absolute ledgers; `const _: () = assert!(...)` in storage.rs | yes: mutant now fails the BUILD with `error[E0080]` |
| A2-02 | Low | `0d9bd70` | same | yes: `LONG_TTL_THRESHOLD = 0` now fails the build |
| A3-01 | Low | `f0c730f` | `test/arithmetic.rs` pins the balance boundary from both sides | yes: the `check_balance` mutant is now caught |
| A3-03..06 | Low | `f0c730f` | `test/arithmetic.rs` | yes: full-crate mutants 22 -> 4 |
| views | Low | `f0c730f` | `test/views.rs` | yes: full-crate mutants 4 -> 0 |
| A5-05 | Info | `ad8d5b6` | four parity comments corrected in error.rs, lib.rs, policy.rs | n/a, documentation |
| A2-04 | Medium | `ad8d5b6` | `mcp/scripts/stellar-vault-archival.mjs`, live TTL read from both networks | yes: `--warn-days 200` exits 1, `--warn-days 30` exits 0 |
| INV-20 | - | `4bc0a78` | `test/availability.rs`, 7 states enumerated | n/a, a proof of absence |
| budget | - | `4bc0a78` | 485,587 CPU of 400,000,000; 158,346 mem of 41,943,040 | pinned at 10% so a regression reports |
| fuzzing | - | `4bc0a78` | `fuzz/policy_ladder`, 20,136 executions committed and re-runnable | n/a |
| F-05 (out of scope, found earlier) | High | `dc14389` | storage tells "empty" from "unreadable"; 6 tests | yes: restoring the fail-open turns the producer tests red |

## Not fixed, by decision

| Finding | Why | Where |
| --- | --- | --- |
| A7-02, A1-01 | Needs a decision, and the cheapest fix is a settings change not a redeploy | D-1 |
| A7-01 | Needs a decision; partly a runbook change | D-2 |
| A3-02 | Live defect, but a redeploy for a Low is the wrong trade alone | D-3 |
| A5-01, A3-07 | Deliberate and matches Solidity; the invariant text was the defect | D-4 |
| A4-02 | No contract change can prevent it | D-5 |
| A4-01 | Needs a redeploy; bundle with D-3 | D-3 |

## Corrections to the audit itself

| What | Commit |
| --- | --- |
| INV-05 was false as written | `1466845`, `f0c730f` |
| Threat model said 12 views, there are 13 | `f0c730f` |
| Release record `deployedAt` was 19 minutes off | `f0c730f` |
| A comment named the wrong protection for testutils | `3e656f7` |
| Provenance said the override "bypasses the gates, not the budget" | `1466845` |
| The first F-05 tests mocked the thing they were testing | `dc14389` |
