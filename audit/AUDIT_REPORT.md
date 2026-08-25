# Security audit - AgentSpendPolicy (Soroban)

**Date:** 2026-08-24 to 2026-08-25
**Subject:** `soroban/contracts/agent-spend-policy`, 822 lines of Rust across 5 files
**Deployed:** Stellar pubnet `CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP`
holding real Circle USDC, and testnet `CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI`
**SDK:** `soroban-sdk = "=27.0.6"`, protocol 27, target `wasm32v1-none`

---

## Executive summary

**Findings: 0 Critical, 2 High, 7 Medium, 26 Low, 29 Informational.**

**The single most serious issue, in plain language:** this project had no way of ever
learning that its smart contract SDK had a security advisory. Its CI ran a step called
"Advisory audit", which used `cargo audit`, which reads the RustSec database, and RustSec
has never carried a single Stellar advisory in its life. Dependabot was switched off. So the
one mechanical check the project had was structurally incapable of reporting the thing it
was named after. GitHub, meanwhile, carries six advisories against crates in this lock, one
of them high severity and one inside the deployed wasm. All six happen to sit below the
pinned versions, which is luck rather than coverage.

That is fixed. It is also the finding that best characterises this codebase: **the contract
itself is careful, and the failures were in the scaffolding around it and in the claims made
about it.** No finding lets an unauthorized party move money. No finding lets an authorized
agent exceed its policy. The two paths that could have been Critical, an unreachable
`withdraw` and a spend cap that silently resets, were both hunted specifically and both hold.

### Deployment go/no-go

**GO, with three conditions and one correction already made.**

The contract may stay deployed and may continue to hold small balances. The conditions are
operational, not code:

1. **Make the owner a multisig now, or accept single-key loss knowingly.** The owner address
   is permanent and is currently a burner key in a local CLI keystore. It can be made a
   2-of-3 with one `SetOptions` operation costing about 0.00001 XLM, with no contract change
   and no new address, but only while the key is still held. See D-1.
2. **Keep the balance small.** The vault holds 0 USDC today and its cap is 1 USDC per day.
   That is what makes an unaudited contract holding real money a reasonable trade, and it
   stops being reasonable if the balance grows.
3. **Disclose that Circle can freeze it.** The pubnet USDC issuer has `auth_revocable` set.
   No contract change prevents that, and `/proof/stellar` currently does not say so.

**Where those three conditions stand, as of 2026-08-25.** Condition 1 is **done**: the owner
account is a 2-of-3 multisig (D-1, `cf35b33`), with the residual that all three signers are
still in one keystore. Condition 2 is **in force**: the vault holds 0 USDC and the cap is 1
USDC per day. Condition 3 was **declined**: the maintainer chose not to publish the Circle
freeze disclosure and removed the caveats box from `/proof/:rail` (`51978c5`), so the
statement below that `/proof/stellar` does not say so remains true and is now a decision
rather than an oversight. D-5 records it.

**NO-GO for anything larger.** This audit does not clear the contract for balances anyone
would mind losing. Two of the reasons are structural and cannot be fixed by testing: there
is no upgrade path, so any future Critical is unpatchable in place, and there is no owner
rotation, so a compromised owner key is total and irreversible loss.

---

## What was done

| Phase | Output |
| --- | --- |
| 0 Threat model | `00-threat-model.md`, 22 numbered invariants, 6 structural properties |
| 1 Research | `research/R1..R4`, 4 parallel agents, ~2,700 lines |
| 2 Tooling | 9 tools run, raw output in `tool-output/` |
| 3 Audit | 8 parallel agents by domain, `findings/A1..A8` |
| 4 Remediation | 8 commits, all findings not needing a redeploy |
| 5 Test suite | 52 -> 106 tests, 22 -> 0 surviving mutants, 93% -> 99.7% coverage |
| 6 Report | this file, `DESIGN-DECISIONS.md` |

### Verification gates, as measured

| Gate | Result |
| --- | --- |
| Contract tests | **106**, 2 ignored (both encode known-open findings) |
| Mutation score | **137 mutants, 0 survivors**, 126 caught, 11 unviable. Re-measured 2026-08-25 and archived at `audit/tool-output/P5-cargo-mutants.txt`; `mutants.out/` is gitignored, so until now the newest ARCHIVED run said "10 missed" and contradicted this row |
| Line coverage | **99.70%** lines, **98.18%** functions, **99.82%** regions. The one uncovered line is `storage.rs:110`, the `#[contracttype]` macro on `DataKey`. Re-measured 2026-08-25 and archived at `audit/tool-output/P5-llvm-cov.txt`; it had been asserted in two places and archived in none |
| Function coverage | **98.18%** |
| Fuzzing | **20,136** executions, no panic reached, and re-runnable is verified rather than asserted: re-run 2026-08-25 from the committed target, 20,136 executions, exit 0, archived at `audit/tool-output/P5-fuzz-rerun.txt`. A further **51,218 is reported but unverified**: that run's target lived in a scratch copy and its artifacts were not preserved, so nothing in this repository can confirm it (see `findings/A6-panics-dos.md`) |
| Negative controls | **6/6** guards deleted, suite goes red each time |
| `cargo audit` | 0 vulnerabilities over 215 crates |
| `cargo deny` | advisories, bans, licenses, sources all ok |
| GHSA check | 0 of 215 locked crates in a published vulnerable range |
| clippy `-D warnings` | clean, and enforced in CI (`soroban.yml:47`) |
| clippy security lint set | **NOT enforced, and it does not pass.** `unwrap_used`, `expect_used`, `panic`, `indexing_slicing` and `arithmetic_side_effects` are enabled by no `clippy.toml`, no `[lints]` table and no crate attribute, and plain `-D warnings` enables none of them. Turned on by hand, the library alone fails with 4 errors: `unwrap()` at `storage.rs:144,152,160,168`. See A8-04 and A6-03 |
| Deployed wasm | `155eb31c...79239` on both networks, byte-identical, verified by `stellar contract fetch` |

---

## Findings by severity

### High

| Id | Title | Status |
| --- | --- | --- |
| A8-01 | No channel could surface a soroban-sdk advisory | **Fixed** |
| A7-02 | The owner is permanent, singular and un-timelocked | **Accepted**: D-1 decided, `cf35b33`, owner is now a 2-of-3 multisig. One residual open |

### Medium

| Id | Title | Status |
| --- | --- | --- |
| A8-02 | CI measured a binary nobody deploys | **Fixed** |
| A8-03 | Secret scanning and push protection off on a public repo | **Fixed** (one setting left) |
| A2-04 | The live vaults archive on a known date | **Fixed** (made checkable) |
| A1-01 | Owner over-privilege, formalising P-2 | **Accepted**: same as A7-02, D-1, `cf35b33` |
| A7-01 | A redeploy silently drops the allowlist | Open, awaiting D-2 (**undecided**) |
| A4-01 | Token error codes collide with this contract's | Open, needs redeploy |
| A4-02 | Circle can freeze the vault permanently | **Accepted**: D-5 declined the disclosure, `51978c5`; option C, small balances, is in force |

### Notable Low

| Id | Title | Status |
| --- | --- | --- |
| A3-02 | The refusal ladder's first rung differs by path | Open, live defect, needs redeploy (D-3) |
| A5-01 / A3-07 | `owner_pay` is charged to the cap but not limited by it | A3-07 (the invariant text) **Fixed**, `3ccb10d`. A5-01 (the contract) Open, awaiting D-4, which is **undecided** |
| A2-01, A2-02 | TTL guards could be disabled without failing a test | **Fixed** |
| A3-01 | Paying exactly the vault balance was untested | **Fixed** |
| A5-03 | A compromised operator can burn the cap at net-zero cost | Accepted, mitigated by the allowlist |
| A5-06 | `set_policy` is a whole-struct overwrite with no compare-and-swap | Open |

Full detail, with proof-of-concept tests, in `findings/`. **Every finding id, with exactly one
of FIXED / ACCEPTED / OPEN against it, is in `REMEDIATION_LOG.md`.** The tables above are the
notable ones, not all of them.

---

## What the contract gets right

Stated because an audit that lists only defects misrepresents what it read.

- **The authorization surface is one line per role and it is correct.** A1 enumerated every
  path: exactly two `require_auth` sites, exactly two `transfer` sites, every transfer
  dominated by a guard, and the built wasm exports 22 functions with no hidden entrypoint.
- **The negative-amount guard is airtight on all three money paths**, proven with `i128::MIN`
  through `-1` and `0`. OpenZeppelin's Stellar Contracts audit found exactly this bug in a
  comparable spending-limit policy; this contract has the guard, and its code comment gives
  the right reason for it.
- **The storage durability split is a documented mitigation to a real published High**
  (Soroswap `OS-SWP-ADV-00`). The instance map stays at exactly 9 keys under 300
  attacker-shaped writes.
- **`overflow-checks` is not load-bearing**, and A3 proved it by running the suite with the
  flag off. `checked_add` is what holds, which is what the code comment claims.
- **Reentrancy is prohibited at the host level**, confirmed from `soroban-env-host` source,
  and the state-before-call ordering in `settle` is the safe one regardless.
- **Refusals write nothing.** The TTL bump runs before the policy ladder, and a returned
  contracterror rolls the whole footprint back.
- **The negative-control runner already existed** and is already in CI. Most projects do not
  have one.

---

## What this audit is not

**This does not replace a professional third-party audit.** It was performed by an AI agent
system with the maintainer in the loop, using free tooling, over two days. It found real
defects and fixed most of them, and its proof-of-concept tests are committed so any claim
here can be re-run. That is not the same as a firm putting its name and liability behind a
report.

Two specific reasons to be sceptical of the coverage, stated rather than buried:

1. **There is no working Soroban-aware static analyzer.** Both candidates failed. CoinFabrik
   Scout is a false green: its build fails against soroban-sdk 27.0.6 and it then prints
   "Analyzed, 0, 0, 0, 0", writes `"findings": []` and exits 0. OpenZeppelin's
   `soroban-scanner` panics on every input including a two-line file. So static coverage in
   this audit is clippy plus manual reading, and the load-bearing tools were mutation
   testing and fuzzing.
2. **The fuzzing campaign is shallow, and most of it cannot be checked.** About 71,000
   executions total at roughly 11 per second, of which only the 20,136 from the committed
   target are re-runnable; the other 51,218 were reported by an audit agent whose artifacts
   were not preserved. It found nothing new, but absence over that budget is weak evidence,
   and weaker still for the part nobody can repeat.

Unproven items are listed as such in each agent's report, and in `UNCONFIRMED.md`.

---

## Corrections to this audit's own work

Five things the audit got wrong and had to fix. Recorded because a report that shows no
self-correction is a report nobody checked.

1. **INV-05 was false as written.** It claimed `pay` and `owner_pay` together stay under the
   daily cap. `check_owner_pay` has no cap comparison. Found independently by A5 (differential
   reading), A3 (ladder reading) and the fuzzer (random input).
2. **The threat model miscounted the view functions**, 12 against an actual 13.
3. **The pubnet release record's `deployedAt` was 19 minutes off**, taken from when the file
   was written rather than from the ledger.
4. **A code comment named the wrong protection.** It said `stellar contract build` does not
   pass `--features`. It does; what actually protects the artifact is that soroban-sdk's
   testutils cannot compile for `wasm32v1-none` at all.
5. **The published provenance said "the override bypasses the gates, not the budget"**,
   which is the inverse of the truth. Corrected on `/proof/stellar` and in both release
   records, as a correction rather than a silent edit.

A sixth is worth recording as method rather than fact: the first three tests written for
finding F-05 injected the loader they were meant to be testing, so restoring the bug left
them green. A negative control caught it. Three more tests were added that call the real
function.

---

## Remaining work

| | Where |
| --- | --- |
| **31 open findings**, each with what would close it | `REMEDIATION_LOG.md` |
| **Three decisions still undecided**: D-2, D-3, D-4. D-1 and D-5 are settled | `DESIGN-DECISIONS.md` |
| One repo setting (non-provider secret patterns), a paid feature; the gitleaks step in `ci.yml` is what covers it meanwhile | maintainer, both remotes |
| npm advisories: both HIGHs closed 2026-08-25 (`259db02`); `mcp/` keeps 22 (15 moderate, 7 low) deliberately | `SECURITY.md`, and the daily gate in `.github/workflows/security.yml` |
| A longer fuzz campaign with a committed corpus | unfinished |
| Items that need a redeploy: A3-02, A4-01, D-2's constructor change | bundle if a redeploy happens |

---

## Scope

**In:** `soroban/contracts/agent-spend-policy/src/**`, its Cargo manifests, the workspace
release profile, `rust-toolchain.toml`, the built wasm, `.github/workflows/soroban.yml`,
`.gitignore` and repository secret hygiene.

**Out:** `mcp/**` (the TypeScript backend, including the code that calls this contract),
`src/**` (the frontend), and `mcp/contracts/AgentSpendPolicy.sol` (the EVM sibling). The
backend remains in the threat model as an *actor*, because it holds the operator key on some
deployments.
