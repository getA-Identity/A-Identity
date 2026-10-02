# Design decisions the audit cannot make

Phase 4 fixed everything that could be fixed without touching the deployed contract. What
is left needs a decision rather than a patch, because **this contract has no upgrade path**.
There is no `update_current_contract_wasm` and no `initialize`, proven at bytecode level by
A7: the deployed wasm does not even import the host functions that would allow it. So every
item below costs a redeploy, and a redeploy costs a new contract id.

The audit protocol says not to improvise an architectural change. These are written up with
their trade-offs and stop here.

## Status board

All five are now decided. The last three were decided on **2026-09-15**, on the maintainer's
instruction to close every open item, and in each case the option adopted is the one this
document had already recommended. A recommendation is the audit's opinion; a decision is the
maintainer's, and these three are now the maintainer's. They can be reversed the same way
they were made, by recording it here.

**Updated 2026-10-01, for v0.1.1.** D-3 is implemented in source: `settle` now runs
`policy::check_amount` first, the committed A3-02 test is un-ignored and green, and the crate
is version 0.1.1. The direction is the opposite of what this document used to prescribe (a
swap inside `withdraw`), and D-3 below says why. Two items that were "bundled into the next
redeploy" are explicitly **deferred past v0.1.1**: A4-01 (error renumbering) and D-2 option
C (the allowlist as a constructor argument). The section "Deferred past v0.1.1" gives the
reasons.

| | Finding(s) | Status |
| --- | --- | --- |
| D-1 | A7-02 High, A1-01 Medium | **DONE 2026-08-25**, option B, `cf35b33`. One residual left open, named in D-1 |
| D-2 | A7-01 Medium | **DECIDED 2026-09-15**, option A now plus C bundled into any redeploy. A7-01 stays OPEN, mitigated: a runbook step and a weekly check, not a contract fix. Option C is **deferred past v0.1.1** (2026-10-01) |
| D-3 | A3-02 Low (live defect in v0.1.0) | **DECIDED 2026-09-15**, option A. **Implemented in v0.1.1 source 2026-10-01** by moving the amount check to the top of `settle`. The deployed v0.1.0 vaults keep the old order until they are replaced. A4-01 no longer rides with it: **deferred past v0.1.1** |
| D-4 | A5-01 Low, A3-07 Info | **DECIDED 2026-09-15**, option A. The contract is unchanged and the corrected wording stands, so A5-01 becomes ACCEPTED |
| D-5 | A4-02 Medium | **DECLINED 2026-08-25**, option A not taken, `51978c5`. Option C is in force |

---

## What a redeploy actually costs

Measured by A7, not estimated.

| | |
| --- | --- |
| Network fees | about **12.34 XLM** (~2.41 USD) for freeze, withdraw, redeploy, repoint, re-arm |
| If the same wasm hash is reused | about **0.099 XLM** (the code entry is already uploaded and lives until ledger 66,177,015, around 2027-01-06) |
| New contract id | yes, unavoidable |
| Repoint surface | 4 files. `mcp/src/chains/registry.ts:126` is hardcoded with no env override |
| Provenance | a new `soroban/releases/` receipt, and the old address marked superseded rather than deleted |

The money is trivial. The real cost is the new address and, per **A7-01**, a policy that
has to be rebuilt by hand with nothing to rebuild it from.

---

## D-1. The permanent owner (A7-02 High, A1-01 Medium)

**The situation.** There is no `set_owner`. The owner chosen in the constructor is
permanent. Losing that key locks the vault balance forever; compromising it is total,
irreversible loss. The current pubnet owner is `GARC7OFB...QJ5R6I5`, a burner generated for
the deploy and held in a local CLI keystore. Not a multisig, not an HSM.

**The good news A7 found, which changes this from a redeploy question to a settings
question.** Per the pinned `soroban-env-host` 27.0.1 (`auth.rs:106-109`), a classic account
satisfies `require_auth` through *classic multisig authorization to its medium threshold*.
So the permanent owner G-address **can be made multisig with a plain `SetOptions`
operation**. No contract change. No redeploy. No new address.

The catch: it only works while the key is still held. It is a thing to do now or not at all.

**Options.**

| | What it means | Cost | Leaves |
| --- | --- | --- | --- |
| **A. Do nothing** | Burner key stays sole owner | 0 | Single point of total loss on a vault holding real USDC |
| **B. `SetOptions` the owner into a 2-of-3** | Add two signers, set medium threshold to 2 | one transaction, ~0.00001 XLM | Same contract, same address, no single key |
| **C. Redeploy with a multisig owner from the start** | New vault, owner is an already-multisig account | ~12.34 XLM + new id + policy rebuild | Cleanest story, highest disruption |
| **D. Accept, and cap the exposure** | Keep the burner, keep the balance at or near zero between demos | 0 | Honest, and matches what the vault holds today (0 USDC) |

### DONE, 2026-08-25: option B was taken

The owner account is now a **2-of-3 multisig**. Same account, same address, contract not
redeployed, wasm hash unchanged.

| | |
| --- | --- |
| Signers | the original owner key, plus `GCLZKYSS...K3DIFS` and `GDZQN2S2...QGDD75Q` |
| Thresholds | low 2, med 2, high 2 |
| Verified | one signature is now rejected with `txBadAuth`; two signatures calling `set_frozen(false)` on the vault landed at ledger 64,120,302 |

High threshold is 2 as well, deliberately: removing a signer needs two signatures, so one
stolen key cannot strip the others.

**One correction to what is written below.** This section said "close to free", which counted
the transaction fees and missed the reserve. Each extra signer raises the account's minimum
balance by 0.5 XLM, so 1 XLM is now locked that was previously spendable. The fees really
were negligible; the reserve was not, and the account had to be topped up before the change
would go through at all.

**Residual risk, and it is the maintainer's to close.** Three signers means losing any two
locks the account permanently. And all three keys are currently in the same local keystore,
which makes this change worth nothing against the threat it was made for: a laptop
compromise still takes all three. At least one key has to move somewhere else.

---

**Original recommendation, kept for the record: B, and it is close to free.** It removes the single point of failure
without a new address, without rebuilding the policy, and without touching the artifact
whose hash is published everywhere. D is a reasonable companion to B, not a substitute.

**Not recommended: C on its own.** Redeploying to solve only this trades a 0.00001 XLM
transaction for a new contract id and a hand-rebuilt allowlist.

---

## D-2. A redeploy silently drops the allowlist (A7-01 Medium)

**The situation.** The constructor takes five arguments and hardcodes `frozen = false`,
`allowlist_enabled = false` and `session_key_expiry = 0`. The allowlist itself lives in
`Allowed(Address)` persistent entries keyed to the contract id, so a redeploy loses all of
them. There is no view that enumerates the allowlist, and pubnet RPC event retention is only
about 7.9 days (measured: 120,959 ledgers), so after eight days there is no way to read back
what the old vault allowed.

**This is live on testnet today.** Its `allowlist_enabled` is `true`, diverged from the
release record by later legitimate traffic. A redeploy there right now would silently
re-open the policy.

**Options.**

| | What it means | Trade-off |
| --- | --- | --- |
| **A. Record the allowlist off-chain before any redeploy** | A pre-redeploy step that reads the `AllowlistSet` events and writes them into the release receipt | Free, works today, but relies on doing it within the 7.9-day event window |
| **B. Add an enumerating view** | `allowed_payees() -> Vec<Address>` | Needs a redeploy to add, and reintroduces an unbounded read the storage design deliberately avoids (INV-19) |
| **C. Take the allowlist as a constructor argument** | Redeploy carries it forward atomically | Needs a redeploy; bounds the constructor's input size |
| **D. Accept** | Document that a redeploy resets the policy and that re-arming is manual | Free, but the failure mode is silent, which is what makes it Medium |

### DECIDED, 2026-09-15: option A now, option C bundled into any redeploy

Decided on the maintainer's instruction to close every open item, and it matches the
recommendation that had been on file since 2026-08-25. **A** is in force now: the allowlist
is recorded off-chain before any redeploy. **C**, taking the allowlist as a constructor
argument, is carried into whatever redeploy happens next; it is not worth one on its own.
**B** is rejected for the reason it always was, that it contradicts INV-19 deliberately.
**D** is what happens by default and is not a decision.

What A actually is, now that it exists: `mcp/scripts/stellar-vault-allowlist.mjs`, a step in
the redeploy runbook in `soroban/README.md`, and a weekly `--check` in
`.github/workflows/stellar-ops.yml`. The snapshots it writes are committed at
`soroban/releases/pubnet-allowlist.json` and `soroban/releases/testnet-allowlist.json`.

**Two limits of A, stated rather than implied, because they are what keeps A7-01 open.**

First, the 7.9-day event window is not a recovery route any more, it is already closed. Both
vaults were read on 2026-09-15 and `getEvents` returned zero events for either one: the
August `AllowlistSet` writes have expired out of RPC retention. So the snapshot is built by
PROBING `is_allowed(payee)` for every candidate the repo can name, not by reading history.
That makes `allowed` a lower bound. A payee nobody named is invisible to the script and
would still be lost by a redeploy.

Second, A is a process, and a process can be skipped. Only C makes the carry-forward atomic,
which is why C is still bundled rather than dropped.

What the first run found, which is the finding this decision exists for: **pubnet has
`allowlist_enabled: false` and no named candidate on its list; testnet has
`allowlist_enabled: true` and exactly one payee armed,
`GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI`, the x402 seller.** A redeploy on
testnet today would drop that one entry and come up with an empty, unenforced list, which is
exactly the silent re-opening this finding predicted.

A7-01 therefore stays **OPEN, mitigated**. The runbook step is in place and the drift check
runs weekly; the contract property that a redeploy drops the entries is unchanged and cannot
change without a new contract id.

---

**Original recommendation, kept for the record: A now, and C bundled into any redeploy that happens for
another reason.** A is a runbook change and costs nothing. B contradicts a deliberate
storage decision and should not be adopted just to make C unnecessary.

---

## D-3. The refusal ladder's first rung differs by path (A3-02 Low, live defect)

**The situation.** `settle` checks the payee before the amount; `withdraw` checks the amount
before the payee. So `pay(vault, 0)` returns `InvalidPayee` (7) and `withdraw(vault, 0)`
returns `InvalidAmount` (6). Same two violations, same contract, two different answers.
That is the v0.1.0 wasm, `155eb31c...`, which is what every deployed vault runs: pubnet CB5LYXFK..., testnet CAIL6ECR..., the 2026-09-19 passkey rehearsal vaults CBGTXWFB... and CCV2MMK4..., and any vault the /stellar page deployed on pubnet.

This matters more here than it would elsewhere, because the typed refusal *is* the product:
a caller is meant to branch on the reason. It violates INV-17 and INV-22.

The failing test was committed `#[ignore]`d with the finding id in the attribute, so `cargo
test` printed it on every run until v0.1.1 un-ignored it.

**Options.**

| | Trade-off |
| --- | --- |
| **A. Fix in the next redeploy** | One line added at the top of `settle`. Free if a redeploy happens anyway |
| **B. Redeploy for this alone** | Not worth a new contract id for a Low |
| **C. Document the divergence** | Honest, cheap, leaves a wrong answer in production |

### DECIDED, 2026-09-15: option A, bundled into the next redeploy

Decided on the maintainer's instruction to close every open item, and it matches the
recommendation on file. **B** is rejected: a new contract id is too much to spend on a Low.
**C** is rejected as a substitute, though the divergence is documented anyway, because
documenting a wrong answer is not the same as deciding to keep it.

### IMPLEMENTED IN SOURCE, 2026-10-01: v0.1.1, in `settle`, not in `withdraw`

**A correction to this section first.** Until 2026-10-01 it prescribed "the two-line reorder
in `withdraw`, so `require_valid_payee` runs before `policy::check_amount` exactly as `settle`
does", and the runbook in `soroban/README.md` said the same. That direction was wrong, on
three independent counts:

1. **It would have left the committed test red.**
   `a_doubly_invalid_input_names_the_same_first_reason_on_every_money_path` asserts
   `InvalidAmount` on all three paths. Swapping the lines in `withdraw` makes all three
   return `InvalidPayee`, so the one test this finding exists to turn green would have failed
   on the commit that claimed to fix it.
2. **It contradicts INV-17.** The invariant puts `InvalidAmount` on the first rung, and the
   finding itself (`findings/A3-arithmetic.md`, A3-02) says that on the invariant's own terms
   `settle` is the side that is wrong, and recommends exactly the `settle` edit.
3. **It contradicts `test/errors.rs`,** whose gate-order test says in its comments that the
   amount is checked before anything else and payee validity comes next.

What shipped in the v0.1.1 source:

1. `policy::check_amount(amount)?` is the first line of `settle`, ahead of
   `require_valid_payee`, with a comment citing A3-02 and INV-17. `withdraw` is unchanged and
   stays amount-first. The ladders in `policy.rs` still call `check_amount` as their own first
   rung; that call is a pure function over the same value, so it can never answer differently
   from the one in `settle`, and keeping it leaves `policy.rs` correct on its own for the
   fuzzer and the property sweep. There is exactly one effective first rung.
2. `a_doubly_invalid_input_names_the_same_first_reason_on_every_money_path` is un-ignored and
   passes. No other test asserted `InvalidPayee` for a doubly-invalid input, so no other test
   changed meaning: every existing `InvalidPayee` assertion pairs the bad payee with a
   positive amount.
3. The crate is version 0.1.1. The release wasm built with `stellar contract build` (CLI
   27.1.0, rustc 1.96.0) on macOS arm64 is
   `353e4264f51e6173b9a2a60603239914cbb1456956e912374caf4d9b358db7c0`, 11,605 bytes. The same
   machine rebuilds the v0.1.0 source to `155eb31c...`, the deployed hash, so the change in
   hash is the source change and not the machine.

**The CI drift gate is the one thing this change cannot finish by itself.** The reason this
section used to give for not editing the source, that `.github/workflows/soroban.yml` pins
`LINUX_X64` and a macOS machine cannot produce the Linux value, is still true. It is a
reason to re-record a literal from the first CI log, not a reason to keep a known wrong
answer in the source. So the gate goes red once, on the push that changes the source, for
exactly the reason it exists, and a follow-up commit records the new Linux hash from that
run's log.

**What this does NOT do.** It does not fix the deployed v0.1.0 vaults. They have no upgrade
path, and they answer the old order until a v0.1.1 vault replaces each of them. A3-02 is
therefore FIXED in source and stays open against each deployed v0.1.0 vault; the remediation
log says which.

**What does not ship with it.** The other `#[ignore]`d test in that file belongs to D-4,
asserts INV-05 as originally written, and is false by design under D-4 option A. It stays
ignored, and its reason string now says the decision was made and which way.

---

**Original recommendation, kept for the record: A.** Hold it until a redeploy is happening for another
reason, then take it. It is genuinely two lines. (It turned out to be one line, in the other
function.)

---

## Deferred past v0.1.1: A4-01 and D-2 option C

Both were written down as "bundled into the next redeploy". v0.1.1 is that redeploy, and both
are deliberately left out of it. Decided by the maintainer on 2026-10-01.

**A4-01, renumbering this contract's error codes clear of the SAC's range.** Deferred because
it is an ABI break. The discriminants are public, frozen by `test/errors.rs`, and decoded by
number outside this crate: the backend carries a code-to-name table in
`mcp/src/chains/stellar/adapter.ts` and the frontend another in `src/lib/stellar/passkey.ts`.
Moving the codes would make each table wrong for whichever vault version it is not talking
to, and while v0.1.0 and v0.1.1 vaults coexist the decoders would have to know which version
they are reading. That needs its own design line recording the new range and every reader,
and it does not belong in a release whose point is a one-line ordering fix. A4-01 stays OPEN.

**D-2 option C, taking the allowlist as a constructor argument.** Deferred because it changes
the constructor, which is permanent per deploy and is called by every deploy path, receipt
and rehearsal we have. A new constructor shape means new deploy tooling, new receipt fields
and a new argument-size bound to decide, for a carry-forward that option A already performs
as a runbook step. D-2 option A stays in force, and A7-01 stays OPEN, mitigated.

Both remain the right changes for a later version. Neither is cancelled.

---

## D-4. `owner_pay` is charged to the cap but not limited by it (A5-01, A3-07 Low)

**The situation.** `check_owner_pay` runs the amount guard, the checked arithmetic and the
balance guard, and no cap comparison. The operator ladder has one; the owner ladder does
not. So `owner_pay` increments the day accumulator and is never bounded by it. A5 moved 51
times the cap in one UTC day this way, and the fuzzer found it independently.

**This is deliberate and matches Solidity.** The defect was in the invariant text and in the
provenance copy, both now corrected. Impact is Low because the owner already controls the
whole balance through an uncapped `withdraw`, so nothing escalates.

**But it is not Informational**, because the per-day cap is the product's central claim, and
"the human override bypasses the gates, not the budget" is a sentence this project published
and had to retract.

**Options.**

| | Trade-off |
| --- | --- |
| **A. Leave the contract, keep the corrected wording** | Free. The claim is now accurate: the cap binds the AGENT, not the human |
| **B. Add a cap gate to `owner_pay` in a future redeploy** | Makes the simpler sentence true again, but removes the override's usefulness in exactly the case it exists for: settling something out of band after the day's budget is spent |
| **C. Add a separate, higher owner ceiling** | More faithful to intent, more surface, more to explain |

### DECIDED, 2026-09-15: option A, the contract keeps this behaviour

Decided on the maintainer's instruction to close every open item, and it matches the
recommendation on file. The contract is **not** changed, and the corrected wording stands.

**B** is rejected because it would remove the override's usefulness in exactly the case the
override exists for: settling something out of band after the day's budget is spent. An
override bounded by the budget it is overriding is not an override. **C**, a separate higher
owner ceiling, is more faithful to the intent and is rejected on cost: it is a redeploy, more
surface and more to explain, for a Low whose impact is already zero because the owner
controls the whole balance through an uncapped `withdraw` anyway.

The sentence this project publishes, and it is short: **the daily cap bounds the agent; the
owner is bounded by the balance and by nothing else.** `owner_pay` is charged to the day
accumulator and is not limited by it, deliberately, matching the Solidity original. The
documentation half was already done, `1466845` and `3ccb10d`, which is why A3-07 is FIXED.

Nothing needs to ship for this. A5-01 becomes **ACCEPTED**: a known property, decided, with
the published claim already matching the code.

One loose end this decision created, now closed: the `#[ignore]`d test
`inv_05_as_written_the_sum_of_pay_and_owner_pay_stays_under_the_cap` in
`src/test/arithmetic.rs` used to carry the reason string "KNOWN OPEN ... a decision that has
not been made". Since v0.1.1 (2026-10-01) it reads "decided 2026-09-15 (D-4 option A):
owner_pay is charged to the day but not limited by it; stays ignored by design". The test
stays ignored and stays in the tree, because it is the cheapest statement of what the
contract does not do.

---

**Original recommendation, kept for the record: A.** B would break the override's purpose. The honest
sentence is short: the daily cap bounds the agent; the owner is bounded by the balance and by
nothing else.

---

## D-5. Circle can freeze this vault, and no contract change can prevent it (A4-02 Medium)

**The situation.** Circle's pubnet USDC issuer has `auth_revocable = true`, verified on
chain. If Circle deauthorizes the vault's balance, `withdraw` stops working while
`balance()` keeps reporting the funds, because the SAC's balance read and its transfer
authorization are separate things.

**No contract change fixes this.** It is a property of the asset, not of the vault. Options
are about disclosure and asset choice, not code.

**Options.**

| | Trade-off |
| --- | --- |
| **A. Disclose it in the provenance caveats** | Free, honest, and it is currently NOT disclosed |
| **B. Use a non-revocable asset** | Would mean not using Circle USDC, which is the whole point of the rail |
| **C. Keep balances small** | Already the policy: 1 USDC daily cap, and the vault holds 0 today |

### DECLINED, 2026-08-25: option A was not taken

The maintainer decided not to publish the Circle freeze disclosure, and removed the
"What is not true here" box from `/proof/:rail` entirely at the same time.

Recorded here rather than dropped, because an accepted risk that nobody wrote down is
indistinguishable from one nobody noticed. The facts are unchanged: the pubnet USDC issuer
sets `auth_revocable`, Circle can deauthorize the vault's balance, and if it does then
`withdraw` stops working while `balance()` keeps reporting the funds. Option **C**, keeping
balances small, is in force and is what bounds the exposure.

The caveat data itself is not gone. `provenance.ts` still carries every caveat, every
response from `GET /api/proof/:rail` still includes them, and
`chains/provenance.test.ts` still fails the build if a chain publishes an empty or
throwaway caveat list. The limitations remain machine-readable and remain enforced; they
are no longer rendered on the page.

---

**Original recommendation, kept for the record: A plus C.** B is not a real option. A is a gap that should close regardless
of what is decided here: a reader of `/proof/stellar` is told the vault is bounded by its
policy and is not told the issuer can freeze it.

---

## Summary

| | Decision | Status | Option taken | Needs redeploy |
| --- | --- | --- | --- | --- |
| D-1 | Permanent owner | **DONE 2026-08-25**, `cf35b33`, one residual open | **B**, `SetOptions` to a 2-of-3 | no |
| D-2 | Redeploy drops the allowlist | **DECIDED 2026-09-15**, A in force; C **deferred past v0.1.1** (2026-10-01) | **A** now, **C** in a later version | partly |
| D-3 | Ladder order differs by path | **DECIDED 2026-09-15**, **implemented in v0.1.1 source 2026-10-01** (`settle` amount-first) | **A**, carried by the v0.1.1 redeploy | yes |
| D-4 | `owner_pay` not capped | **DECIDED 2026-09-15**, nothing to ship | **A**, keep the corrected wording | no |
| D-5 | Circle can freeze | **DECLINED 2026-08-25**, `51978c5`, option C in force | **A + C**, disclose and stay small | no |

Three of the five need no redeploy at all. D-3 is the one the v0.1.1 redeploy carries. D-2's
constructor change and A4-01 were meant to ride with it and are deferred past v0.1.1, for the
reasons in "Deferred past v0.1.1". The sequence is written out step by step under "Redeploy
runbook" in `soroban/README.md`.

**A decision is not a fix, and this board must not be read as though it were.** D-4 needed
nothing shipped and its finding is now ACCEPTED. D-2 shipped a runbook step, a script and a
weekly drift check, which mitigate A7-01 without changing the contract property that causes
it, so A7-01 stays OPEN. D-3 shipped nothing on 2026-09-15; on 2026-10-01 it shipped in the
v0.1.1 source, which fixes A3-02 for any vault built from that source and for neither of the
v0.1.0 vaults already deployed. A4-01 stays OPEN, deferred past v0.1.1. Two of the three rows
that changed on 2026-09-15 still have open findings underneath them, and that is the honest
state rather than a tidier one.

All three were decided on the maintainer's instruction on 2026-09-15, and in every case the
option adopted is the one this document had recommended since 2026-08-25. The maintainer can
reverse any of them by recording it here.
