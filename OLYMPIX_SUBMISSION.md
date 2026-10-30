# Olympix pre-audit submission: A-Identity Solidity contracts

## 1. Summary

- **Project:** A-Identity (`getA-Identity/A-Identity`), Foundry project in `mcp/`
- **Date:** 2026-10-30
- **Review level:** max (Critical, High, Medium, Low), plus Slither 0.11.6 static analysis and Foundry unit, fuzz and invariant tests. The review ran in two rounds: before the fixes and after them.
- **Solidity compiler:** solc 0.8.36 (pinned in `mcp/foundry.toml`, optimizer on, 200 runs). Source pragma is `^0.8.24`. Foundry 1.7.1.
- **Scope:** every production contract under `mcp/contracts/`. Tests, mocks, scripts and dependencies (`lib/`, `node_modules/`) are excluded.
- **Dependency note:** `forge-std` v1.16.2 was fetched into `mcp/lib/forge-std` the way `.github/workflows/solidity.yml` does. It is gitignored and is not a project file.

| File | SHA-256 before the review | SHA-256 after the fixes |
| --- | --- | --- |
| `mcp/contracts/AgentSpendPolicy.sol` | `d64fd994f40d840d39fa8ec6159437e4c20e1af0d29d20436525c8b9b48508c8` | `ccdc54bdc0f08b9c45cf742e2e1a6a3d7fcc767639187498e0c22dfd54ea0795` |
| `mcp/contracts/MerkleAirdrop.sol` | `befd54d525d7f5bb038e3127eca5575e44607d9a9259eb7cd6b72ec9c29e5c42` | `5e01a74a06c7cc95d641aff1f23ce06d1949bb436cd037c2c7635034287f6cfb` |

**Behavior changes made by the fixes**

`MerkleAirdrop` (not deployed anywhere):
- The constructor now reverts with `ZeroToken()` for a zero token address (F-04).
- The constructor now reverts with `InvalidDeadline()` when `_claimDeadline <= block.timestamp` (F-01). The constructor check order is `ZeroOwner`, then `ZeroToken`, then `InvalidDeadline`.
- `sweep(to)` now reverts with `ZeroAddress()` for `to == address(0)` (F-05). The order is `NotOwner`, then `SweepBeforeDeadline`, then `ZeroAddress`.
- Three new custom errors are added to the ABI: `InvalidDeadline`, `ZeroToken`, `ZeroAddress`.
- `owner` is now `immutable` (F-30). The `owner()` getter is unchanged.

`AgentSpendPolicy` (already deployed and immutable on Arc Mainnet, Robinhood Chain and Arbitrum One):
- There is no runtime behavior change and no ABI change.
- `owner` is now `immutable` (F-29). The getter is unchanged, but the storage layout shifts and the bytecode changes.
- The NatSpec for the session-key expiry is corrected so it matches the code (F-03). This changes the metadata hash.
- Because the bytecode and metadata differ, these edits apply to new deployments only. The three live deployments are unaffected and no longer byte-match this source file.

Line numbers in this document refer to the files after the fixes.

Finding IDs `F-01` and up are new in this review. Older comments in the test files ("Finding F-1 to F-6, M-1, M-2, PG-1 to PG-3, G-1") come from an earlier internal review and are a different numbering. Mapping where they overlap: legacy M-1 is F-04, legacy M-2 is F-06, legacy F-4 is F-02/F-03, legacy F-3 is F-08, legacy F-2 is F-09, legacy F-6 is F-11.

## 2. Findings

| ID | Severity | Source | Title | File and line | Status | Fix or reason |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | Medium | Review | Airdrop accepts a zero or already-passed claim deadline, so the owner can sweep right after funding | `MerkleAirdrop.sol:55-63` | Fixed | Constructor now reverts `InvalidDeadline` unless the deadline is strictly in the future. |
| F-02 | Medium | Review | Session-key "revoke now" still allows payments for the rest of that second (strict `>` check) | `AgentSpendPolicy.sol:140`, `:188` | Open | Changing `>` to `>=` changes a deliberate, tested behavior that matches the Soroban port. Needs your decision (section 4). |
| F-03 | Low | Review | NatSpec said `block.timestamp` revokes immediately, which the code does not do | `AgentSpendPolicy.sol:21-28`, `:56-61`, `:181-190` | Fixed | Comments corrected. No code change. |
| F-04 | Low | Review | Airdrop accepts a zero token address (every claim and sweep then reverts) | `MerkleAirdrop.sol:55-63` | Fixed | Constructor now reverts `ZeroToken`. |
| F-05 | Low | Review | `sweep` accepts a zero destination | `MerkleAirdrop.sol:106-113` | Fixed | `sweep` now reverts `ZeroAddress`. |
| F-06 | Low | Review | Claims stay open after the deadline, and a late claim after a sweep fails inside the token with an untyped error | `MerkleAirdrop.sol:82-102`, `:106-113` | Accepted risk | Documented design (legacy M-2). Closing claims would change behavior. |
| F-07 | Low | Review | Neither contract can rotate or transfer its owner, so a lost or compromised owner key cannot be replaced | `AgentSpendPolicy.sol:41`, `MerkleAirdrop.sol:25` | Open | Adding two-step ownership is a new feature. Needs your decision (section 4). |
| F-08 | Informational | Review | Daily cap is per UTC calendar day, so an operator can spend up to 2x the cap across midnight | `AgentSpendPolicy.sol:136-148` | Accepted risk | Documented design (legacy F-3). Rolling windows would change behavior. |
| F-09 | Informational | Review | `ownerPay` counts toward the day but is not cap-checked, so it can exhaust the agent's budget | `AgentSpendPolicy.sol:153-160` | Accepted risk | Documented design (legacy F-2). The owner is the trusted principal. |
| F-10 | Informational | Review | `pay(to, 0)` is accepted and emits `Paid` | `AgentSpendPolicy.sol:136-148` | Accepted risk | Harmless, and the operator is already bounded. Documented by a test. |
| F-11 | Informational | Review | Tokens whose `transfer` returns no data (USDT-style) make the vault unusable | `AgentSpendPolicy.sol:136-160`, `:199-207` | Accepted risk | USDC returns a bool (legacy F-6). Documented by a test. |
| F-12 | Informational | Review | Floating pragma `^0.8.24` while builds use 0.8.36 | `AgentSpendPolicy.sol:2`, `MerkleAirdrop.sol:2` | Accepted risk | Foundry pins 0.8.36 and the deploy script uses the lockfile solc. Pinning would change the metadata hash for no behavior gain. |
| F-13 | Informational | Review | Both files declare a file-scope `interface IERC20` with the same name | `AgentSpendPolicy.sol:34`, `MerkleAirdrop.sol:18` | Accepted risk | Only a problem if both files are ever imported into one compilation unit. Not done today. |
| F-14 | Low | Slither | missing-zero-check on constructor `_operator` | `AgentSpendPolicy.sol:105` | False positive | A zero operator intentionally means "no agent". Tested. |
| F-15 | Low | Slither | missing-zero-check on `setOperator` | `AgentSpendPolicy.sol:176` | False positive | `setOperator(address(0))` is the documented immediate revoke. Tested. |
| F-16 | Low | Slither | reentrancy-events in `ownerPay` | `AgentSpendPolicy.sol:153-160` | False positive | State is updated before the external call. Only the event ordering is affected. Reentrancy tested. |
| F-17 | Low | Slither | reentrancy-events in `withdraw` | `AgentSpendPolicy.sol:199-207` | False positive | Same reason as F-16. Reentrancy tested. |
| F-18 | Low | Slither | reentrancy-events in `pay` | `AgentSpendPolicy.sol:136-148` | False positive | Same reason as F-16. Reentrancy tested. |
| F-19 | Low | Slither | reentrancy-events in `sweep` | `MerkleAirdrop.sol:106-113` | False positive | The balance is read and the transfer sends everything. A re-entrant sweep finds nothing left or reverts. Tested. |
| F-20 | Low | Slither | reentrancy-events in `claim` | `MerkleAirdrop.sol:82-102` | False positive | The claimed bit is set before the transfer. Tested. |
| F-21 | Low | Slither | timestamp comparison in `sweep` | `MerkleAirdrop.sol:106-113` | False positive | Deadline is day-scale and the comparison is intended. Boundary tested. |
| F-22 | Low | Slither | timestamp comparison in `pay` | `AgentSpendPolicy.sol:136-148` | False positive | Intended. The same-second granularity is tracked as F-02. Boundary tested. |
| F-23 | Informational | Slither | naming-convention: `_dailyCap` | `AgentSpendPolicy.sol:164` | False positive | Underscore-prefixed parameters avoid shadowing state variables. Style only. |
| F-24 | Informational | Slither | naming-convention: `_autoApproveMax` | `AgentSpendPolicy.sol:164` | False positive | Same as F-23. |
| F-25 | Informational | Slither | naming-convention: `_allowlistEnabled` | `AgentSpendPolicy.sol:164` | False positive | Same as F-23. |
| F-26 | Informational | Slither | naming-convention: `_operator` | `AgentSpendPolicy.sol:176` | False positive | Same as F-23. |
| F-27 | Informational | Slither | naming-convention: `_expiry` | `AgentSpendPolicy.sol:188` | False positive | Same as F-23. |
| F-28 | Informational | Slither | naming-convention: `_frozen` | `AgentSpendPolicy.sol:193` | False positive | Same as F-23. |
| F-29 | Informational | Slither | `AgentSpendPolicy.owner` should be immutable | `AgentSpendPolicy.sol:41` | Fixed | Declared `immutable`. Re-run of Slither no longer reports it. |
| F-30 | Informational | Slither | `MerkleAirdrop.owner` should be immutable | `MerkleAirdrop.sol:25` | Fixed | Declared `immutable`. Re-run of Slither no longer reports it. |
| F-31 | Informational | Review | Merkle leaf and node domain separation: an 84-byte leaf cannot collide with a 64-byte internal node | `MerkleAirdrop.sol:82-102` | False positive | Checked and it holds. Internal nodes cannot be replayed as leaves. Tests added. |
| F-32 | Low | Review (round 2) | Custom errors carry no context (`AboveAutoApprove`, `DailyCapExceeded`, `InvalidProof`) | `AgentSpendPolicy.sol:82-83`, `MerkleAirdrop.sol:41` | Open | Adding parameters changes the error selectors and breaks anything that decodes them. Needs your decision (section 4). |
| F-33 | Low | Slither (re-run) | timestamp comparison in the new constructor deadline check | `MerkleAirdrop.sol:55-63` | False positive | Introduced by the F-01 fix. The comparison is the point of the fix. Tested. |

Totals: 33 findings. Fixed 6 (F-01, F-03, F-04, F-05, F-29, F-30). Open 3 (F-02, F-07, F-32). Accepted risk 7 (F-06, F-08 to F-13). False positive 17 (F-14 to F-28, F-31, F-33).

Both reviewers found no Critical or High issues, in either round.

## 3. Tests

**Command run** (from `mcp/`, after fetching `forge-std`):

```
cd mcp && forge test
```

Result: **95 passed, 0 failed, 0 skipped** across 3 suites. Before the review the same command gave 58 passed. One legacy test was replaced (`test_constructor_documentsZeroTokenIsAccepted`, now `test_F04_constructor_revertsOnZeroToken`) and 38 tests were added. Fuzz runs: 1024. Invariant runs: 256 at depth 128.

**Negative controls** (`node scripts/sol-negative-controls.mjs`): 20 of 20 mutants killed, baseline green. This shows that deleting any single guard turns the suite red.

**Slither** (`slither . --filter-paths "lib|node_modules|test-sol"`, run before and after the fixes): 17 results at first, 16 after. The two `immutable-states` results are gone and one new timestamp result appeared (F-33).

**Not run:** `scripts/compile-contracts.mjs` (the npm solc deploy path), because it writes an artifact file. Foundry compiles the same sources with the same compiler version and settings.

| Test file | Suite result |
| --- | --- |
| `mcp/test-sol/AgentSpendPolicy.t.sol` | 57 passed, 0 failed |
| `mcp/test-sol/MerkleAirdrop.t.sol` | 32 passed, 0 failed |
| `mcp/test-sol/AgentSpendPolicy.invariant.t.sol` | 6 passed, 0 failed (unchanged) |
| `mcp/test-sol/mocks/Tokens.sol` | Mock only. Added `HookToken`, a token that re-enters from `transfer()`. |

**New tests and the findings they cover** (all pass):

| Test | Finding |
| --- | --- |
| `test_F01_constructor_revertsOnPastOrCurrentDeadline` | F-01 |
| `test_F01_constructor_acceptsDeadlineOneSecondAhead` | F-01 |
| `testFuzz_F01_constructor_deadlineMustBeStrictlyInTheFuture` | F-01, F-33 |
| `testFuzz_F01_sweepNeverHappensBeforeTheDeadline` | F-01 |
| `test_F02_expiryEqualToNow_stillLetsOperatorPay_sameBlockAndLaterBlock` | F-02 |
| `test_F02_expiryOneSecondBeforeNow_revokesImmediately` | F-02, F-03 |
| `test_F02_setOperatorZero_andSetFrozen_revokeInTheSameBlock` | F-02, F-03 |
| `test_F04_constructor_revertsOnZeroToken` | F-04 |
| `test_F04_constructor_checkOrder_ownerThenTokenThenDeadline` | F-04, F-01 |
| `test_F05_sweepToZero_afterDeadline_revertsZeroAddressAndMovesNothing` | F-05 |
| `test_F05_sweepToValidAddress_stillWorks` | F-05 |
| `test_F05_sweepCheckOrder_notOwner_thenBeforeDeadline_thenZeroAddress` | F-05 |
| `test_F06_claimsStayOpenAfterTheDeadline` | F-06 |
| `test_F06_claimedThenSwept_accountingSumsToFunded` | F-06 |
| `test_F07_noOwnershipTransferEntryPoint_andOwnerIsConstant` (one in each test file) | F-07 |
| `test_F08_dailyCapIsPerCalendarDay_upToTwiceTheCapAcrossMidnight` | F-08 |
| `test_F09_ownerPay_countsTowardTheDay_andIsNotCapChecked` | F-09 |
| `test_F10_payZeroAmount_isAcceptedAndEmitsPaid` | F-10 |
| `test_F11_noReturnToken_makesPayOwnerPayAndWithdrawUnusable` | F-11 |
| `test_F14_constructorOperatorZero_works_andPayByAnyoneRevertsNotOperator` | F-14 |
| `testFuzz_F14_constructorOperatorZero_payRevertsForAnyNonZeroCaller` | F-14 |
| `test_F15_setOperatorZero_worksAndEmitsOperatorSetZero` | F-15 |
| `test_F16_ownerPay_reentrantTransferSeesUpdatedDay` | F-16 |
| `test_F17_withdraw_reentrantTransferCannotWithdrawMoreThanTheBalance` | F-17 |
| `test_F18_pay_reentrantTransferCannotDoubleSpendTheCap` | F-18 |
| `test_F19_sweep_reentrantTokenCannotSweepTwice` | F-19 |
| `test_F20_claim_reentrantTokenCannotDoubleClaim` | F-20 |
| `test_F21_sweepBoundary_blockedAtDeadlineMinusOne_openAtDeadline` | F-21 |
| `test_F22_pay_succeedsAtExpiry_failsAtExpiryPlusOne` | F-22 |
| `testFuzz_F29_owner_returnsConstructorArgument` | F-29 |
| `test_F29_ownerOnlyFunctions_workForOwner_revertForOthers` | F-29 |
| `test_F29_storageWriteCannotChangeOwner` | F-29 |
| `testFuzz_F30_owner_returnsConstructorArgument` | F-30 |
| `test_F30_ownerOnlySweep_worksForOwner_revertsForOthers` | F-30 |
| `test_F30_storageWriteCannotChangeOwner` | F-30 |
| `test_F31_internalNodeCannotBeUsedAsLeaf` | F-31 |
| `testFuzz_F31_randomTripleNotInTreeNeverClaims` | F-31 |

Findings with no dedicated test, because they are comment, style, or tooling items: F-03 (covered indirectly by the F-02 tests), F-12, F-13, F-23 to F-28, F-32.

## 4. Open items

**Open (needs your decision)**

| ID | Risk in plain language | What you need to decide |
| --- | --- | --- |
| F-02 | When the owner "revokes" the agent's key by setting the expiry to the current time, the agent can still pay for the rest of that second, and on fast chains such as Arbitrum One that can cover several blocks. The daily cap, ceiling and allowlist still apply. The live vaults can be revoked immediately with `setOperator(address(0))`, `setFrozen(true)`, or an expiry strictly in the past. | Keep the strict `>` rule (matches the Soroban port and a test that fails if it changes), or switch to `>=` in new deployments, together with the Soroban port. The comments now describe the current behavior accurately. |
| F-07 | There is no way to change the owner of either contract. If the owner key (or the Safe) is lost or compromised, the policy and the funds cannot be moved to a new owner. The live vaults cannot change this. | Whether new deployments should get a two-step ownership transfer. That is a new feature, so it was not added. Note that `owner` is now `immutable`, and adding a transfer would undo that. |
| F-32 | Revert reasons such as `DailyCapExceeded()` and `InvalidProof()` carry no numbers, so monitoring and relayers must rebuild the context from the transaction. Nothing is at risk. | Whether to add parameters to the errors. This changes their selectors and would break any code that decodes the current errors. The live vaults cannot change this. |

**Accepted risk (documented design, no code change)**

| ID | Risk in plain language |
| --- | --- |
| F-06 | After the deadline, recipients can still claim until the owner sweeps. After a sweep, a late claim fails with a token error and not a clear one. Recipients who wait too long can lose their allocation. |
| F-08 | The daily cap resets at 00:00 UTC, so an agent can spend two caps within a few minutes across midnight. |
| F-09 | The owner can use `ownerPay` to fill the day's budget, which blocks the agent for the rest of the day. |
| F-10 | The agent can send zero-value payments that only emit events. |
| F-11 | The vault only works with tokens that return a bool, such as USDC. A USDT-style token would be stuck. |
| F-12 | The source uses a floating pragma. Builds are pinned to 0.8.36 by Foundry and the lockfile. |
| F-13 | Two files declare the same interface name. This only matters if they are imported together. |

**False positives (nothing to decide):** F-14 to F-28, F-31, F-33. The reasons are in the section 2 table.

## 5. Audit Provenance

Round 1 (before the fixes):

| Subagent | Dispatched | Files audited | Corpus rules cited |
|---|---|---|---|
| solidity-auditor | yes | 2 | off-by-one-threshold-comparisons, insufficient-constructor-parameter-validation, missing-zero-address-validation-for-critical-parameters |

| Subagent | Dispatched | Files audited | Corpus rules cited |
|---|---|---|---|
| functional-auditor | yes | 2 | — |

Round 2 (after the fixes):

| Subagent | Dispatched | Files audited | Corpus rules cited |
|---|---|---|---|
| solidity-auditor | yes | 2 | custom-error-context-parameters |

| Subagent | Dispatched | Files audited | Corpus rules cited |
|---|---|---|---|
| functional-auditor | yes | 2 | — |
