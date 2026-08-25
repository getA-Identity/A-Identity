# Remediation log

Finding -> commit -> what proves it. Every entry with a "negative control" column was
verified by re-introducing the defect and watching the suite go red, then restoring it.

| Finding | Severity | Commit | Evidence | Negative control |
| --- | --- | --- | --- | --- |
| A8-01 | High | `670b05f` | `soroban/audit/ghsa-check.mjs`, exit 0 on the real lock, exit 1 on a lock pinning soroban-sdk 22.0.0 and stellar-strkey 0.0.7, exit 2 with no token | yes: `cargo audit` reports nothing on the same lock |
| A8-02 | Medium | `670b05f` | CI now runs `stellar contract build`; a hash gate pins the artifact | yes: verified the two build paths differ, 28,728 vs 11,625 bytes |
| A8-03 | Medium | repo settings, `52b8ed5`, `337c451` | secret scanning and push protection enabled on both remotes, read back from the API; our own gitleaks step in `ci.yml` covers the Stellar seed format GitHub's free tier cannot | n/a |
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

---

## Complete disposition register

The table above is the evidence view: it lists what was fixed and what proves it. This one
is the completeness view. **Every finding id raised in `findings/` appears here exactly
once**, with exactly one of:

- **FIXED**, with the commit that did it.
- **ACCEPTED**, with the reason it is being lived with. This includes the ids whose own
  status line says the question was asked and the answer was "no defect": they are recorded
  rather than dropped, because a question that was checked and a question that was skipped
  look identical once neither is written down.
- **OPEN**, with what would close it.

Nothing here is disposed of on inference. Where a finding recommended a change and no commit
names it, the register says OPEN even when the change looks as though it may have happened
incidentally, and says so. Re-verified against the working tree on 2026-08-25; the
verification is noted inline wherever it was more than reading a commit message.

**62 findings: 18 FIXED, 13 ACCEPTED, 31 OPEN.** Most of the open set is documentation and
process, and most of it is cheap. Four of the open ids cannot be closed without a redeploy or
a decision that costs one, and those four are exactly what `DESIGN-DECISIONS.md` is waiting
on: A3-02 (D-3), A7-01 (D-2), A5-01 (D-4) and A4-01 (bundled with D-3).

### A1 - authorization

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A1-01 | Medium | **ACCEPTED** | D-1 decided and executed 2026-08-25, `cf35b33`. The permanent owner account is now a 2-of-3 multisig via `SetOptions`: same contract, same address, no redeploy. The contract property itself (there is no `set_owner`) cannot change without a new contract id. Residual, stated in D-1 and not closed: all three signers currently sit in the same local keystore, and losing any two locks the account permanently |
| A1-02 | Low | **OPEN** | A contract-address owner or operator is authorized by the invoker rule with no signature. No commit touches it. Closes with: a note where the roles are documented, plus a deployment-checklist line. Do not blanket-reject C-addresses, which would forbid the multisig owner A1-01 wants |
| A1-03 | Low | **OPEN** | Verified 2026-08-25: all three "unbypassable" claims are still in the tree, at `error.rs:77`, `lib.rs:90` and `test/behaviour.rs:243`. Closes with: the replacement doc comment A1-03 drafts, and dropping the word from the other two sites |
| A1-04 | Low | **OPEN** | The constructor binds four roles permanently on the deployer's authority with no read-back gate. The behaviour is correct as designed. Closes with: making read-back-before-funding a recorded step in the deploy runbook |
| A1-05 | Info | **OPEN** | `is_allowed` is an unauthenticated view that writes (a TTL bump the caller pays for). Benign, and the recommended fix is one doc-comment line. Verified 2026-08-25: `lib.rs:258` still carries no doc comment. Duplicate of A2-07; closing either closes both |
| A1-06 | Info | **FIXED** | `3ccb10d`. `00-threat-model.md:149` now reads "View entrypoints (13)" |
| A1-07 | Low | **OPEN** | Seven named test-suite gaps. The suite grew 52 -> 106, but no commit names A1-07 and gap 1 is verifiably still open: `set_allowed` appears in `test/auth.rs` only at line 153, inside `every_owner_setter_without_auth_fails`, and is still absent from the wrong-signer loop. Closes with: adopting A1's probes the way A2's and A3's were adopted |

### A2 - storage and TTL

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A2-01 | Low | **FIXED** | `0d9bd70`. Tests assert absolute ledgers; a const assertion fails the build |
| A2-02 | Low | **FIXED** | `0d9bd70`. Same |
| A2-03 | Low | **OPEN** | The comment does not say which TTL floor wins on which network. `test/durability.rs` (from `0d9bd70`) now pins the pubnet-versus-testnet outcome in tests, but the comment the finding names has not been corrected. Closes with: correcting it. No code change is needed; taking the larger of the two is right |
| A2-04 | Medium | **FIXED** | `ad8d5b6`. The archival date is monitored from a script that reads live TTL from both networks |
| A2-05 | Info | **OPEN** | The trap-versus-clamp sentence is still attached to `LONG_TTL_THRESHOLD` / `LONG_TTL_EXTEND` at `storage.rs:59-61`, which are the extensions that clamp rather than trap. `0d9bd70` added a correct statement elsewhere (the fourth const assertion, `storage.rs:103-107`), which is not the same as removing the wrong one. Closes with: correcting or deleting the original sentence |
| A2-06 | Info | **OPEN** | The per-UTC-day cap permits 2x `daily_cap` across midnight. Verified 2026-08-25: neither `public/llms.txt` nor `llms-full.txt` states the window. Closes with: saying "up to `daily_cap` per UTC day" wherever the cap is presented. A rolling window would be a behaviour change against the Solidity original and is not proposed |
| A2-07 | Info | **OPEN** | Duplicate of A1-05, from the storage side |
| A2-08 | Info | **ACCEPTED** | Not a defect. The finding's own status is "Confirmed correct": archival does not revoke an allowlist entry, which is the intended behaviour. Recorded so the question shows as asked and answered |
| A2-09 | Info | **FIXED** | `f0c730f`. `test/views.rs:111` pins `decimals()`, and the full-crate run reports 137 mutants with 0 survivors, so the mutants this finding named are dead |

### A3 - arithmetic

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A3-01 | Low | **FIXED** | `f0c730f` |
| A3-02 | Low | **OPEN** | A live defect in the deployed wasm: `settle` checks the payee before the amount, `withdraw` the reverse, so the same two violations return two different codes. The failing test is committed and `#[ignore]`d with the finding id in the attribute, so `cargo test` prints it on every run. Closes with: a redeploy carrying the two-line reorder. Awaiting D-3 |
| A3-03 | Low | **FIXED** | `f0c730f` |
| A3-04 | Low | **FIXED** | `f0c730f` |
| A3-05 | Low | **FIXED** | `f0c730f` |
| A3-06 | Low | **FIXED** | `f0c730f` |
| A3-07 | Info | **FIXED** | `3ccb10d`. Its recommended fix was explicitly the invariant text and not the code: `00-threat-model.md:232-236` now states INV-05 over `pay` alone and records the correction in place. Whether to also cap `owner_pay` in the contract is a separate question, tracked as A5-01 under D-4 |
| A3-08 | Info | **OPEN** | `MathOverflow` is a rung of the refusal ladder that the ladder documentation does not list. `error.rs:29-30` documents the variant in the Solidity-parity list, which is a different list. Closes with: adding it where the ladder is documented |
| A3-09 | Info | **OPEN** | The calendar-bucket consequence, same substance as A2-06 and closed by the same wording change |
| A3-10 | Info | **OPEN**, and the finding needs restating first | It reports that "the committed `soroban/mutants.out`" under-reports by 49 mutants. Verified 2026-08-25: `git log --all -- 'soroban/mutants.out*'` is empty, so that directory has never been committed on any branch and there is no stale committed artifact to replace. It is ignored locally by `soroban/.gitignore`, which is itself invisible to git for the reason A8-06 gives, so a fresh clone WOULD stage it. Closes with: restating the finding against the untracked directory, or withdrawing it |

### A4 - cross-contract

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A4-01 | Medium | **OPEN** | The token's error codes collide with this contract's and a caller cannot tell them apart. Confirmed with a passing PoC. Needs a redeploy; closes with: moving this contract's discriminants clear of the SAC range, bundled with whatever redeploy D-3 triggers |
| A4-02 | Medium | **ACCEPTED** | D-5 decided 2026-08-25. Option A (publish the freeze disclosure) was DECLINED and the caveats box was removed from `/proof/:rail` in `51978c5`; option C, keeping balances small, is what bounds the exposure and is in force. The facts are unchanged and are recorded in D-5. The caveat data is still machine-readable in `provenance.ts` and still test-enforced; it is no longer rendered |
| A4-03 | Low here, Medium elsewhere | **OPEN** | Settlement is asserted, never verified: no balance delta anywhere. A deployment risk rather than a live one for the two audited deployments. Closes with: a balance-delta assertion around settlement |
| A4-04 | Low | **OPEN** | Three payee-side failures produce untyped aborts and a muxed destination is unpayable. Closes with: typed refusals for the three, and an explicit statement that muxed destinations are unsupported |
| A4-05 | Info | **ACCEPTED** | Not a defect. The constructor's `decimals()` read is a liveness probe, not a safety property; the finding records it as confirmed with impact "n/a" and recommends nothing |

### A5 - economic logic

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A5-01 | Low | **OPEN** | `owner_pay` is charged to the daily cap but not bounded by it. The published claim was corrected (`1466845`) and INV-05 was rewritten (`3ccb10d`), but whether the contract should gain a cap gate is undecided. Closes with: D-4. See the note below on why this is not being decided here |
| A5-02 | Info | **OPEN** | Verified 2026-08-25: `policy.rs:104` still says the accumulator keeps "on-chain accounting ... honest about total outflow". It resets daily and does not count `withdraw`, so it is not that record. `ad8d5b6` corrected four parity comments; this was not one of them. Closes with: correcting that sentence |
| A5-03 | Low | **ACCEPTED** | A compromised operator can burn the cap at net-zero cost. Accepted and mitigated by the allowlist, as recorded in `AUDIT_REPORT.md`. The comment claiming `require_valid_payee` closes it is what was wrong, not the trade |
| A5-04 | Info | **OPEN** | `InvalidPayee` is absent from the documented refusal ladder and fires in a different position per entrypoint. The position half is A3-02. Closes with: documenting the rung |
| A5-05 | Info | **FIXED** | `ad8d5b6`. Four parity comments corrected in error.rs, lib.rs and policy.rs |
| A5-06 | Low | **OPEN** | `set_policy` is a whole-struct overwrite with no partial update and no compare-and-swap, so a stale read overwrites a concurrent change silently. Closes with: a compare-and-swap argument, which needs a redeploy, or an operational rule that only one writer touches policy |
| A5-07 | Info | **OPEN** | The allowlist can be enabled over an empty payee set, locking the agent out. The finding says "believed intended"; a belief is not a decision. Closes with: a maintainer confirming it is intended, at which point it becomes ACCEPTED |
| A5-08 | Info | **OPEN** | A no-op setter still publishes a change event. Closes with: either accepting it explicitly or suppressing the event when nothing changed (needs a redeploy) |
| A5-09 | Info | **OPEN** | Ordering exposure on freeze is bounded by remaining daily headroom, and unbounded when `daily_cap == 0`. Also "believed intended". Closes with: the same explicit confirmation, or documenting the `daily_cap == 0` case where the cap is presented |

### A6 - panics, DoS and resource limits

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A6-01 | Low | **ACCEPTED** | The TTL bump is unmetered work an authorized caller can repeat. The finding's own status is "Confirmed, accepted risk" and its recommended fix is "None": the invocation rolls back, so the cost is the caller's own fee, and bumping only on success would drift a refused vault toward archival, which is worse |
| A6-02 | Info | **ACCEPTED** | Not a defect. Error-code stability is already enforced by `test/errors.rs:34` and `#[repr(u32)]`. Recorded so the register shows the question was asked |
| A6-03 | Info | **ACCEPTED** as a measurement | Not a defect on its own: the four `unwrap()` in `storage.rs` are proven unreachable by A2, since an archived instance entry is restored with its value. Re-measured 2026-08-25 and still exactly four, now at `storage.rs:144,152,160,168` (they moved when `0d9bd70` added the const-assertion block above them). Turning the lint set into a gate is A8-04 and is OPEN |
| A6-04 | Info | **ACCEPTED** | Not a defect. Entry and key size limits are far away and nothing this contract writes is caller-sized |

Two A6 sections are not findings and are recorded in the evidence table above rather than
here: INV-20 (`withdraw` is reachable in all seven reachable states) and the proof that a
refusal writes nothing, including the TTL bump.

### A7 - upgrade and initialization

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A7-01 | Medium | **OPEN** | A redeploy silently drops the allowlist, and testnet's `allowlist_enabled` is `true` today, so a redeploy there right now would re-open the policy. Pubnet RPC event retention is about 7.9 days, so the recovery window is finite. Closes with: D-2 |
| A7-02 | High | **ACCEPTED** | Same disposition and same residual as A1-01: D-1, `cf35b33`, owner account is a 2-of-3 multisig. "Singular" is closed; "permanent" and "un-timelocked" are properties of the deployed contract and cannot be closed without a new contract id |
| A7-03 | Low | **OPEN** | The documented recovery runbook omits the freeze step and has never been rehearsed. Closes with: adding the step and rehearsing it once on testnet, which is free |
| A7-04 | Info | **ACCEPTED** | Not a defect. No upgrade path, confirmed at bytecode level; protocol 28 does not change it. The finding's status is "Verified, no action" |
| A7-05 | Info | **OPEN** | The constructor requires no consent from the addresses it names, and its tests cannot prove otherwise. Verified as correct behaviour; the outstanding part is documentation, which has not been written. Closes with: stating it where the constructor is documented |
| A7-06 | Info | **ACCEPTED** | Not a defect. Deploy front-running is structurally impossible, verified rather than assumed. Status "Verified, no action" |
| A7-07 | Info | **OPEN** | Anyone may instantiate a byte-identical clone, so the wasm hash does not identify this deployment. Documentation only, and its own status still reads "Open". Closes with: saying so wherever the hash is published as identity |
| A7-08 | Info | **FIXED** | `3ccb10d`. `soroban/releases/pubnet-v0.1.0.json` now carries the ledger-derived `deployedAt` plus a `deployedAtNote` recording the 19-minute correction rather than silently editing it |

### A8 - build and configuration

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| A8-01 | High | **FIXED** | `670b05f`. The GHSA query in `soroban.yml`, plus Dependabot re-enabled. Negative control: `cargo audit` reports nothing on a lock the GHSA step fails |
| A8-02 | Medium | **FIXED** | `670b05f` built and hashed the deployed artifact; `3eb8bc4` then corrected the gate itself, which had asserted a cross-machine reproducibility claim the repo explicitly refuses to make. It now pins the hash this runner produces and prints the deployed one beside it, unasserted |
| A8-03 | Medium | **FIXED** | Repo settings on both remotes, plus our own scanner: `52b8ed5` added the gitleaks step and `337c451` switched it to the MIT binary after the licensed action refused to run for an organization. The setting `AUDIT_REPORT.md` calls "left" is GitHub's non-provider secret patterns, a paid Secret Protection feature; the gitleaks step exists precisely because the free tier cannot cover the Stellar seed format |
| A8-04 | Low | **OPEN** | Six CI gates absent, and no `--locked`. Two have landed since: the GHSA query (`670b05f`) and gitleaks (`52b8ed5`, in `ci.yml`). Verified 2026-08-25 that four are still absent from every workflow: the clippy security lint set, `cargo llvm-cov` with a floor, `cargo mutants`, a `cargo fuzz` smoke run, and `cargo deny check`; and that no cargo invocation in `soroban.yml` uses `--locked`. `security.yml`, added 2026-08-25, gates the npm dependency surface and closes none of these. Closes with: adding them, cheapest first |
| A8-05 | Low | **FIXED** | `3e656f7`. The Cargo.toml comment now names the real protection, that soroban-sdk's testutils cannot compile for `wasm32v1-none` at all, instead of the false one about `--features` |
| A8-06 | Low | **OPEN** | Verified 2026-08-25: `.gitignore:81` is still a bare `.gitignore`, and `git ls-files` still lists only `.gitignore`, `mcp/.gitignore` and `sdk/.gitignore`, so `soroban/.gitignore` and `trust-guard/.gitignore` remain invisible. A fresh clone still has nothing ignoring `target/`, `mutants.out*/` or `*.wasm` under `soroban/`. Closes with: narrowing line 81 to the path it was meant for, then committing the two ignore files |
| A8-07 | Low | **OPEN** | The claim is still published, at `soroban/releases/pubnet-v0.1.0.json:170` and `mcp/src/chains/provenance.ts:327`. It is closer to true than when it was written, because `audit/tool-output/` now holds 52 committed files. Closes with: naming that directory from the claim, or dropping "with output committed" |
| A8-08 | Info | **FIXED** | `337c451`. `soroban.yml:88-94` installs a pinned `STELLAR_CLI_VERSION: 27.1.0` release tarball, with a comment saying the tool that produces the hashed artifact may not float; that matches the `"stellarCli": "27.1.0"` already recorded in both release files. The other half of this finding was that the docs UNDERSTATE the reproducibility property, which the finding itself calls "not wrong" |
| A8-09 | Info | **OPEN** for the geiger half | The release profile, the `unsafe` audit and the dependency pinning were verified clean and need nothing. cargo-geiger still has not run: `audit/tool-output/P2-cargo-geiger.txt` is 168 bytes recording the failure, which is filed as a failure rather than as a pass. Closes with: a geiger run that completes, or a written decision that `cargo tree` plus manual review is the substitute |
| A8-10 | Info | **ACCEPTED** | Explicitly not a finding. Recorded because a tool that was tried and found useless is worth naming, so nobody spends the afternoon again. CoinFabrik Scout is a false green against soroban-sdk 27.0.6 |

### Out of scope of this audit

| Id | Sev | Disposition | Detail |
| --- | --- | --- | --- |
| F-05 | High | **FIXED** | `dc14389`. Found before this audit, in the TypeScript backend. Listed here because its negative control is what caught the audit's own bad tests |

---

## Awaiting a maintainer decision

Three of the five design decisions are still undecided, and this log does not decide them.
They are not OPEN findings in the ordinary sense: the analysis is finished and the trade-off
is written up. What is missing is a choice that the audit has no standing to make.

| Decision | Findings it disposes of | Choosing between |
| --- | --- | --- |
| D-2 | A7-01 | A: record the allowlist off-chain before any redeploy, a free runbook change that works only inside the 7.9-day event window. B: add an enumerating view, which needs a redeploy and reintroduces the unbounded read INV-19 deliberately avoids. C: take the allowlist as a constructor argument, which needs a redeploy but carries the policy forward atomically. D: accept, and document that a redeploy resets the policy |
| D-3 | A3-02, and it is the natural carrier for A4-01 | A: fix in the next redeploy that happens for another reason, two lines reordered. B: redeploy for this alone, a new contract id for a Low. C: document the divergence and leave a wrong answer in production |
| D-4 | A5-01 | A: leave the contract and keep the corrected wording, so the claim is "the cap binds the agent, not the human". B: add a cap gate to `owner_pay` in a future redeploy, which removes the override's usefulness in the case it exists for. C: add a separate, higher owner ceiling |

D-1 (A7-02, A1-01) and D-5 (A4-02) are decided and their findings are dispositioned above.

---

## Corrections to the audit itself

| What | Commit |
| --- | --- |
| INV-05 was false as written | `1466845`, `f0c730f`, `3ccb10d` |
| Threat model said 12 views, there are 13 | `3ccb10d` |
| Release record `deployedAt` was 19 minutes off | `3ccb10d` |
| This log attributed both of the two rows above to `f0c730f`, which touched neither `audit/00-threat-model.md` nor `soroban/releases/pubnet-v0.1.0.json` | this commit |
| A comment named the wrong protection for testutils | `3e656f7` |
| Provenance said the override "bypasses the gates, not the budget" | `1466845` |
| The first F-05 tests mocked the thing they were testing | `dc14389` |
| A6 claimed its fuzz artifacts were archived in `tool-output/`; they were never in the repository, and the 51,218-run figure is unverifiable from here | this commit, in `findings/A6-panics-dos.md` and `AUDIT_REPORT.md` |
| The gate table said clippy was clean "with `unwrap_used`, `panic`, `indexing_slicing`, `arithmetic_side_effects`". That lint set is enabled nowhere and does not pass | this commit, in `AUDIT_REPORT.md` |
| Coverage of 99.70% was asserted in `AUDIT_REPORT.md` and `soroban/README.md` and archived in neither. Re-measured and archived; the numbers were right | `audit/tool-output/P5-llvm-cov.txt` |
| "137 mutants, 0 survivors" had the same shape: `mutants.out/` is gitignored, so the newest ARCHIVED run said "10 missed" and contradicted the headline. Re-run and archived; the headline was right | `audit/tool-output/P5-cargo-mutants.txt` |
| "re-runnable from the committed target" was asserted about the fuzz target and never demonstrated. Re-run and archived; it is true | `audit/tool-output/P5-fuzz-rerun.txt` |
| The fuzz README carried a THIRD copy of the "crash input is archived" claim, missed when the other two were corrected | this commit, in `soroban/contracts/agent-spend-policy/fuzz/README.md` |
