# A6 - Panics, errors, DoS and resource limits

Domain owner: the lead auditor. Two subagent runs of A6 were killed mid-flight by a
machine sleep, the second after it had completed its fuzzing but before it wrote up. The
remaining questions were answered directly rather than by launching a third agent that
would have redone the same work.

Artifacts: `audit/tool-output/A6-probe-tests.rs` (3 probes, all green).

**The fuzz artifacts were NOT preserved.** An earlier version of this document said they
"survived and are archived here" and named `audit/tool-output/A6-fuzz-run3.log` and
`audit/tool-output/A6-fuzz-crash-1-inv05.bin`. Neither file has ever existed in this
repository, on any branch. The fuzz target ran from a scratch copy that was not kept, as
commit `4bc0a78` states: "A6 ran 51,218 executions during the audit but the target lived in
a scratch copy, so it could not be re-run." Every fuzzing figure below is therefore a
report of a run that happened during the audit and **cannot be verified from this
repository**. It is labelled as unverified wherever it appears rather than removed, because
the run did happen and deleting it would misrepresent the record in the other direction.

What IS re-runnable is the committed successor: `soroban/contracts/agent-spend-policy/fuzz/`
(commit `4bc0a78`), 20,136 executions in 61 seconds with no panic reached.

**Result: 0 Critical, 0 High, 0 Medium, 1 Low, 3 Informational.** No panic, no
resource-exhaustion path, and no unreachable-withdraw state was found.

---

## Summary of the domain

| Question | Answer | Evidence |
| --- | --- | --- |
| Is `withdraw` reachable in every state? | **Yes**, 7 of 7 states | probe 1 |
| Does a refusal write anything? | **No**, the whole invocation rolls back | probe 2 |
| Worst-case CPU | **485,587** of 400,000,000 = 0.121%, 824x headroom | probe 3 |
| Worst-case memory | **158,346** of 41,943,040 = 0.378%, 265x headroom | probe 3 |
| Fuzzing | 51,218 runs, no new defect | **unverified**: the run log was not preserved |
| Are error codes pinned? | **Yes**, already | `test/errors.rs:34` |

---

## INV-20: withdraw is reachable in every state the contract can reach

This is the one that would have been Critical. A funded vault that cannot be withdrawn
from is a loss with no attacker in the picture, and by the Blend `BL-001` precedent a
dead-end flow is rated Critical even when nobody gains. This contract has no upgrade path,
so such a state would be unrecoverable.

Seven states were enumerated and each was proven to still allow the owner to empty the
vault:

1. frozen
2. allowlist enabled with an empty list
3. session key revoked into the past
4. daily cap fully exhausted
5. zero cap and zero ceiling
6. operator rotated to a stranger
7. instance idled 3,456,000 ledgers (200 days) past its TTL floor

State 7 is the interesting one and it corroborates A2 from a different direction: A2
proved an archived instance entry is restored with its value, and this probe shows the
owner path still completes afterwards.

`withdraw` is structurally short: `require_owner`, bump, `check_amount`,
`require_valid_payee`, a balance check, transfer. It shares none of the agent ladder's
gates, which is why freeze, expiry, allowlist and cap exhaustion cannot reach it.

**Status: INV-20 confirmed. No finding.**

---

## A refusal writes nothing, including the TTL bump

`bump_instance` is called at the top of every writing entrypoint, *after* the
authorization check but *before* the policy ladder. That ordering raises a fair question:
does a refused payment leave a paid-for write behind?

It does not. `pay`, `owner_pay` and `withdraw` return `Result`, and a returned
`contracterror` is a failed invocation to the host, so the whole footprint rolls back, the
bump included. Proven by seeding the day accumulator, taking a refusal one unit over the
cap, and asserting both `spent_today()` and `balance()` are byte-identical afterwards.

Note the shape of the guard this relies on. The setters that cannot fail
(`set_allowed`, `set_session_key_expiry`, `set_frozen`) return `()`, so there is no path
where a bump survives a refusal.

**Status: no finding.** The refusal costs a fee and changes nothing, which is the correct
and cheapest possible answer.

---

## A6-01 (Low) - the TTL bump is unmetered work an authorized caller can repeat

- **Severity:** Low
- **Impact:** an authorized operator whose payments are all refused still causes an
  instance TTL extension attempt on every call, paying the fee each time. There is no
  gain to an attacker and no state corruption; it is a self-funded no-op.
- **Likelihood:** Low
- **Violates:** n/a
- **Location:** `lib.rs:103,119,130,139,162,180,187,202,209` (`bump_instance` call sites)
- **Category:** DoS
- **Detected by:** manual review, A6
- **Status:** Confirmed, accepted risk

**Description.** Every writing entrypoint bumps before it knows whether the call will
succeed. Because the invocation rolls back on refusal the bump does not persist, so the
cost is the transaction fee and nothing else, borne by the caller. The alternative,
bumping only on success, would mean a vault whose calls are all currently being refused
drifts toward archival, which is worse. The current ordering is the right trade.

**Recommended fix.** None. Documented here so a future reviewer does not "optimise" the
bump to after the ladder without understanding what that costs.

---

## Resource budget, measured

Measured with `env.cost_estimate().budget()` on the most expensive agent path: `pay` with
the allowlist enabled, which adds a persistent read plus its TTL extension on top of the
instance read, the token balance call, the day-bucket read and write, the transfer and the
event.

| | Measured | Pubnet limit | Used | Headroom |
| --- | --- | --- | --- | --- |
| CPU instructions | 485,587 | 400,000,000 | 0.121% | 824x |
| Memory bytes | 158,346 | 41,943,040 | 0.378% | 265x |

Pubnet limits read from the live network on 2026-08-24. There is no plausible input that
closes an 824x gap: the contract has no loops over caller-controlled data, and A2
confirmed the instance map stays at exactly 9 keys under 300 attacker-shaped writes.

Note on the API: `Env::budget()` is deprecated in soroban-sdk 27.0.6 in favour of
`env.cost_estimate().budget()`, confirmed by compiling against both.

The probe pins the assertion at 10% of each limit rather than at the measured value, so it
reports a real regression instead of silently re-baselining on every SDK bump.

---

## Fuzzing: 51,218 runs, no new defect (reported, not verifiable here)

**Evidence status.** This whole section rests on a run whose artifacts were not preserved.
The log is not in the repository, the crash input is not in the repository, and the target
that produced them lived in a scratch copy that is gone. The figure and the crash strings
below are reproduced from the run as it was reported at the time; nothing in this repository
can confirm them. Treat them as a record of what was done, not as evidence. The verifiable
fuzzing result for this contract is the committed target in
`soroban/contracts/agent-spend-policy/fuzz/`, 20,136 executions, no panic reached.

The A6 run built a fuzz target over the entrypoints taking untrusted input and
reported 51,218 executions. Two earlier runs crashed, both on the same assertion:

```
INV-05 violated: spent 18446743094943547164 > cap 18446743094540894209
INV-05 violated: spent 5192236122099288965505452645285631 > cap 429496679227
```

That is `owner_pay` accumulating past the daily cap, which A5 and A3 had already found and
which is a defect in the invariant text rather than in the contract. The fuzzer
rediscovering it independently, from random input rather than from reading the ladder, is
worth recording as corroboration: three methods, one conclusion.

Once the assertion was corrected to the true invariant, the third run finished clean. No
`panic!` was reached. The Soroban fuzzing rule is that any `panic!` is a bug, so a clean
run over this input space is a meaningful result and not merely an absence of one.

The crash input was **not** archived. An earlier version of this document said it was, at
`audit/tool-output/A6-fuzz-crash-1-inv05.bin`; that file does not exist and never did. The
crash is not lost as a finding, only as an artifact: the same defect is A5-01 and A3-07,
both of which carry committed tests, and INV-05 has been corrected in the threat model.

**Status: no new finding.**

---

## A6-02 (Informational) - error-code stability is already enforced

The threat model asked whether anything pins the numeric error codes, since a renumbering
would silently change what two deployed contracts appear to say and there is no upgrade
path to correct it.

Something does: `test/errors.rs:34` asserts `variant as u32 == code` for every variant,
and `error.rs:35` carries `#[repr(u32)]`. INV-22 is guarded. Recorded so the register
shows the question was asked and answered, not skipped.

---

## A6-03 (Informational) - clippy's production-code surface is four lines

With `unwrap_used`, `expect_used`, `panic`, `indexing_slicing` and
`arithmetic_side_effects` all enabled, production code produces exactly four hits, all
`unwrap()` in `storage.rs`. Zero panics, zero indexing, zero unchecked arithmetic. Every
other hit is in `src/test/`.

The four were at `storage.rs:99,107,115,123` when A6 ran and are at
`storage.rs:144,152,160,168` today, moved down by the `const _: () = assert!(...)` block
that commit `0d9bd70` added above them. Re-verified 2026-08-25: the library alone still
fails with exactly 4 errors under that lint set. None of these lints is enabled anywhere in
the build, so this is a hand-run measurement, not a gate. See A8-04.

A2 proved those four are unreachable by archival, since an archived instance entry is
restored with its value rather than returning `None`. They are therefore not a latent
panic, and A6 found no other route to `None`.

---

## A6-04 (Informational) - entry and key size limits are far away

`contract_data_entry_size_bytes` is 65,536 and `contract_data_key_size_bytes` is 250 on
both networks. Every key this contract writes is a `DataKey` enum variant carrying at most
one `Address` or one `u64`; every value is an `Address`, `i128`, `u64`, `bool` or `u32`.
Nothing is caller-sized. No entrypoint iterates the allowlist, so the persistent side
cannot be made to produce a large read either.

---

## Unconfirmed

1. **Fuzz coverage depth, and the campaign is unverifiable from here.** 51,218 runs at
   roughly 11 executions per second is a shallow campaign by fuzzing standards, and its
   artifacts were not preserved, so the figure cannot be checked against anything in this
   repository. It found nothing new, but absence over an unverifiable budget is weaker
   evidence still. Phase 5 committed a re-runnable target (20,136 executions); a longer run
   with a committed seed corpus is still outstanding.
2. **CAP-0077 entry freezing.** Protocol 26 lets validators freeze ledger entries by
   settings upgrade, and pubnet currently lists 3 frozen keys. If this contract's entries
   were ever frozen, `withdraw` would be unreachable and no contract code could prevent
   it. That is outside the contract's control and could not be exercised, so it is stated
   as a residual risk rather than a finding.
3. **The deployed wasm's export table** was not re-derived here; A7 covered it and found
   22 exports with no hidden entrypoint.
