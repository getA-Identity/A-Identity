# R2 - Bug taxonomy from published Soroban/Stellar audit reports

Phase 1 research deliverable. Every class below is anchored to a finding I read in a real
published report, or to authoritative Stellar documentation where no audit finding was
found. Ordered by how likely the class is to matter for `AgentSpendPolicy`.

Invariant references are to `audit/00-threat-model.md`.

## Method and a warning for later phases

Reports were read as text, not as summaries. PDFs were downloaded and extracted locally
with `pypdf` before any claim was made about their contents.

**This mattered.** An automated summariser, asked to summarise the Certora Blend PDF
against a list of categories, returned ten findings with ids `#161`-`#172` and titles such
as "Time-Period Accounting Flaw", "Token Assumption Violation" and "TTL/Archival Issue".
Local text extraction of the same PDF shows the report actually contains six findings,
`BL-001` to `BL-006`, with entirely different titles. The summary was fabricated by
echoing the categories in the question. Later phases must not cite a finding that was only
ever seen through a summariser.

Sources whose full text I extracted and read: Certora/Blend, OtterSec/Soroswap,
Veridise/Soroban Core, Runtime Verification/StellarBroker. Sources read as HTML with
verbatim re-verification of the load-bearing headings and bodies: Code4rena/Reflector V3,
OpenZeppelin Stellar Contracts (two audits), Quarkslab/Allbridge Core.

---

## 1. Missing `require_auth` on a privileged setter

**Concrete example.** Reflector V3, `[H-01] set_invocation_costs_config() fails to
authorize admin allowing anyone to set invocation costs`. Severity: **High** (Code4rena).
The function "is designed to allow the admin to set invocation costs which is charged when
prices are read by the consumer" but carries no authorization check, so any caller can set
it and force token burns on legitimate readers.

**Mechanism.** On Soroban there is no `msg.sender`. A function that reads and writes
privileged config but never calls `require_auth` on the stored admin address is fully
public, and every other check in the function still passes.

**Applies here: yes, this is the single highest-value class.** The threat model already
identifies `operator.require_auth()` in `pay` and `owner.require_auth()` in `require_owner`
as the entire authorization surface. `AgentSpendPolicy` has eight owner-gated mutators and
one operator-gated mutator. One omission on any of them is this exact finding, and on a
mainnet contract with no upgrade path it is unrecoverable in place.
Breaks **INV-01**, **INV-02**.

Source: https://code4rena.com/reports/2025-10-reflector-v3

**Second example, same class, different mechanism.** OpenZeppelin Stellar Contracts RC
v0.7.0, `#[has_role]` Macro Offers Minimal Benefit and Introduces Authorization Risks.
Severity: **High**. The macro checks role *membership* without verifying that the caller
authorized the invocation, decoupling authentication from authorization. A role check that
is not paired with `require_auth` is not an access control.

Source: https://www.openzeppelin.com/news/stellar-contracts-library-v0.3.0-rc.2-audit

**Hunting note for Phase 3/5.** The threat model's own warning applies: a suite using
`mock_all_auths()` passes identically against a contract with the guard deleted. Negative
authorization tests must use real auth or `mock_auths` with an explicit list.

---

## 2. Spend-limit bypass through an unvalidated amount sign

**Concrete example.** OpenZeppelin Stellar Contracts RC v0.7.0, `Spending Limit Policy
Bypass By Specifying Negative Amount`. Severity: **Low** (as OpenZeppelin rated it).

Verbatim: "The spending-limit policy's `enforce` function currently parses the transfer
`amount` as `i128` and uses it directly in accounting without enforcing that `amount` is
strictly positive. However, while the fungible token implementation for this library does
revert on attempts to transfer negative amounts of tokens, such behavior is not required by
the SEP-41 standard and as such, another implementation could potentially treat such
transfer as 0 token transfer. As a result, if a `transfer` call is accepted with a negative
amount by the target token implementation, the policy will reduce `cached_total_spent`,
effectively increasing remaining spend capacity instead of consuming it. Consider
validating `amount >= 0` inside the policy itself to make enforcement independent of
token-specific semantics."

**Applies here: this is the closest published finding to our design.** It is a Stellar
spending-limit policy for a smart account, with the same shape as ours: an `i128` amount, a
running total, a cap, and a downstream SEP-41 `transfer`. The auditors' central point is
that the policy must not outsource sign validation to the token. Our threat model already
says the constructor accepts any SEP-41 address, so the OpenZeppelin argument transfers
directly.
Breaks **INV-09**, and through it **INV-05**, **INV-06** and **INV-11** (a negative amount
makes `SpentOnDay` decrease).

Source: https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit

---

## 3. Storage durability: instance archival making the contract inaccessible

**Concrete example.** OpenZeppelin Stellar Contracts Library v0.3.0-rc.2, `Inconsistent
Instance Storage TTL Extension`. Severity: **Medium**.

Verbatim: "Throughout the codebase, the TTL for instance storage is not extended anywhere
except in the `get_owner` function of the `ownable` trait. This creates an inconsistent
pattern in how TTL extension is handled. Unlike other storage types, extending the TTL of
instance storage affects the entire contract storage and can be costly. At the same time,
not extending the TTL when needed can result in the loss of key functionality and may
render the entire smart contract inaccessible once the TTL expires. As a result, it is
important to clarify whether TTL extension should be handled within the library or
explicitly by integrators."

**Applies here: directly, and it is already flagged as P-3.** `bump_instance` runs on every
writing entrypoint and on no view. A funded vault that is read but never written drifts
toward archival, and `get_owner`/`get_operator`/`get_token`/`get_decimals` all `unwrap()`.
The auditors rated the *inconsistency itself* as Medium, before any loss occurred, which is
a useful severity anchor for Phase 3.
Breaks **INV-20**; threatens P-3.

Source: https://www.openzeppelin.com/news/stellar-contracts-library-v0.3.0-rc.2-audit

---

## 4. Temporary storage used to enforce a security-critical time bound

**Authoritative statement rather than a finding.** Stellar developer documentation,
"Choosing the right storage type", states verbatim:

- "While TTL for the temporary data can be extended, it is unsafe to rely on the extensions
  to preserve data. There is always a risk of losing temporary data."
- "Only the TTL extension made when the entry is created is guaranteed to happen."
- "It is also unsafe to rely on an entry expiring as it can be extended by anyone. When a
  time bound has to be enforced, always include it in the data as well."

**Corroborating audit finding, showing the second direction is real.** OpenZeppelin Stellar
Contracts RC v0.7.0, `Expired Pending Transfers Can Block Renouncing Ownership and Admin
Roles`. Severity: **Low**. Verbatim, in part: "Because Soroban temporary storage entries can
remain live past the explicit deadline due to permissionless TTL extension, the expired
entry persists in storage." The auditors treat "anyone can keep a temporary entry alive"
as a fact to design around, not a hypothesis.

**Applies here: yes, and it cuts both ways.** `SpentOnDay(u64)` is temporary.
- Early loss direction: if the entry can expire before the UTC day ends, the day's spend
  total silently resets to zero and the agent spends more than `daily_cap` in one day.
  This is **INV-18** exactly.
- Late survival direction: an entry kept alive by a third party is harmless for a
  day-keyed map, since the key changes at midnight, but Phase 3 should confirm the key is
  genuinely day-derived and that no other temporary entry carries a deadline.
The documentation's rule "when a time bound has to be enforced, always include it in the
data as well" is worth checking against how the day bucket is keyed and read.
Breaks **INV-18**, and through it **INV-05**.

Sources:
https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage
https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit

---

## 5. Unbounded data in instance storage causing denial of service

**Concrete example.** Soroswap, `OS-SWP-ADV-00 [high] | Incorrect Use Of Instance Storage`.
Severity: **High**, status Resolved (OtterSec, audit conducted December 2023, report dated
2024-02-22). The factory stored the whole `allPairs` vector in instance storage. Verbatim,
in part: "storing vectors of pair addresses (`allPairs`) in the instance storage results in
inadequate storage space, particularly as the data of pair tokens grows limitlessly in a
permissionless manner, swiftly surpassing the constrained storage capacity. Malicious users
may exploit this by flooding the instance storage with fake token pairs, resulting in a
denial of service scenario as the storage space is exhausted."

Veridise independently names the same class in its published Soroban checklist: instance
storage "loads all data with each contract interaction, leading to increased costs and
potential DoS vulnerabilities", with the mitigation being to spread unbounded data across
persistent slots.

**Applies here: as a regression guard rather than an open bug.** The threat model records
that `Allowed(Address)` was deliberately placed in persistent storage for exactly this
reason. That is the documented mitigation to a High-severity finding in a real report, so
Phase 3 should confirm nothing has since crept into the instance map whose count is driven
by input, and Phase 4 should treat this as a permanent design rule.
Breaks **INV-19**, and through it **INV-20** (instance bloat bricks `withdraw` too).

Sources:
https://github.com/soroswap/core/blob/main/audits/2024-02-22_soroswap_ottersec_audit.pdf
https://veridise.com/blog/audit-insights/building-on-stellar-soroban-grab-this-security-checklist-to-avoid-vulnerabilities/

---

## 6. "Dead-end" flows: resource limits make a required path unexecutable

**Concrete example.** Blend, `BL-001 - "Dead-end" flows (resource limits)`. Severity:
**CRITICAL** (Certora, January 2024). Under specific user states the Soroban resource limit
is invariably hit, "causing some code and underlying logic to be impossible to execute". In
Blend's case the health check read reserve information per asset, so IO scaled linearly
with asset count and users holding many assets could become unliquidatable. Certora
recommended a hard cap on the scaling factor plus an 80-90 percent resource high-water mark
enforced across the unit test suite.

**Applies here: yes, in a reduced but real form.** Our contract has no loops over
user-controlled collections, so the classic version does not apply. What does apply is the
severity precedent: an owner path that cannot execute is rated Critical even though no
attacker gains funds, which matches the threat model's asset 3 ("availability of
`withdraw`"). Combined with class 3 above and no upgrade entrypoint, an unexecutable
`withdraw` is the worst realistic outcome for this contract.
Breaks **INV-20**.

Source: https://certora.cdn.prismic.io/certora/65b2a04e615e73009ec3ef2d_BlendCertoraReport.pdf
(landing page: https://www.certora.com/reports/blend)

---

## 7. Period and window accounting that does not reconcile with elapsed time

**Concrete example.** Blend, `BL-002 - BLND reward loss during interval between emission
cycles`. Severity: **MEDIUM**. The emitter mints continuously against the ledger timestamp,
while the backstop distributes "a week's quanta of BLND in discrete, non overlapping
periods, which have arbitrary start and end periods". If the cycle update is invoked at
T+2 weeks instead of T+1, two weeks of emission entered the backstop but only one week was
distributed, and a week of BLND is stranded. Certora's recommendation was to track an index
"directly coupled to the time passed" rather than discrete manually triggered buckets.

**Applies here: the failure mode is inverted but the analysis is the same.** Our cap is a
discrete, non-overlapping UTC-day bucket keyed by `SpentOnDay(u64)`. Blend's bug was value
stranded when a period was skipped; ours would be *budget released early or twice* if the
day key can be made to advance or reset off-schedule. Phase 3 should push on: how the day
number is derived from the ledger timestamp, what happens exactly at the boundary, whether
two payments straddling midnight can each get a full cap, and whether ledger timestamp
monotonicity is assumed anywhere.
Breaks **INV-05**, **INV-11**, **INV-18**.

Source: as class 6.

---

## 8. Authorization that does not bind the policy it was signed against

**Concrete example.** OpenZeppelin Stellar Contracts RC v0.7.0, `Unbound context_rule_ids
Allow Rule Selection Downgrade After Signature Collection`. Severity: **High**. Verbatim,
in part: "a sponsor can alter `context_rule_ids` after signatures are collected, selecting
a weaker rule (fewer signers or fewer policies) for the same invocation ... authorization
succeeds under the downgraded rule without invalidating signatures. This defeats
protections like spending limits or threshold policies that signers expected to apply."

**Mechanism.** The signature covers the invocation but not the policy selected to judge it,
so the caller picks the weakest policy after the fact.

**Applies here: as a design question rather than a code bug.** `AgentSpendPolicy` has one
fixed policy per contract, so there is no rule id to downgrade. The transferable question
is the reverse one: what exactly does the operator's `require_auth` bind to? If it binds
only the invocation and not the arguments, a relayer or an outer contract in the auth tree
has room to move. This connects to class 9.
Breaks **INV-01**, and would break **INV-06** and **INV-05** downstream.

Source: https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit

---

## 9. Authorization-tree position and phishing through nested `require_auth`

**Concrete example.** Soroswap, `OS-SWP-SUG-02 | Authorization Required For Token Transfer`.
Severity: **Informational** (OtterSec general finding). Verbatim, in part: "an issue arises
when the router uses `require_auth` during the initial smart contract call, as malicious
contracts can exploit this by inserting fraudulent authorization objects into the
authorization tree. This deceptive tactic can lead to phishing attacks ... Gaining wrongful
authorization for external calls through `transfer`, they can exploit this to execute
unauthorized transfers, stealing the user's entire balance of any token." OtterSec noted
this is the pattern proposed by the Stellar Development Foundation, and recommended
frontend warnings plus excluding unverified tokens.

**Applies here: partially, and worth reasoning about explicitly.** Our `pay` moves the
vault's own balance, so the token's `from`-side authorization is satisfied structurally by
the direct-call rule, as the threat model states. That removes the classic version of this
attack. What remains is the composability question: when `pay` is invoked from inside
another contract's auth tree, what else can ride along on the operator's signed
authorization, and does the operator key holder see the full tree before signing. Given the
operator key sits on a server in some deployments, this is a real operational surface.
Relates to **INV-01**.

Source: as class 5 (Soroswap OtterSec report).

---

## 10. One limit shared across incompatible units or decimals

**Concrete example.** OpenZeppelin Stellar Contracts RC v0.7.0, `Spending-Limit Policy
Allows Default Rule`. Severity: **Low**. Verbatim, in part: "this policy is allowed to be
used when applying the `Default` context rule, which can be used to call any contract,
including arbitrary token contracts. This can result in a situation where transferring two
different tokens, possibly with different decimals number, can be counted towards the same
spending limit."

**Applies here: as a check on P-4.** `AgentSpendPolicy` binds one token at construction, so
the multi-token version cannot occur. But the same reasoning applies to `Decimals`: it is
read from the token at construction, exposed as a view, and never consulted by any gate.
The cap and the ceiling are therefore raw base units. Phase 3 should confirm this is
documented where the owner sets `daily_cap`, because "1 USDC per day" and "1 unit per day"
differ by 10^6 and the contract never checks which one the owner meant.
Relates to **INV-05**, **INV-06**, P-4.

Source: https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit

---

## 11. Missing same-address validation

**Concrete examples, two reports.**

Blend, `BL-005 - Lack of validation that filler state is different from the user address in
fill_user_liq_auction`. Severity: **LOW**. Verbatim, in part: "We recommend adding a check
here that the liquidator address is not the same as the liquidated address. While it is
currently impossible to create a situation where this occurs, relatively minor changes to
the code in the future could expose this issue to exploitation." Blend's response was
"Acknowledged and won't fix".

Soroswap, `OS-SWP-SUG-01 | Missing Address Check`. Severity: **Informational**. `Pair::new`
had no check that the two addresses differ, so a pair could be created with two identical
addresses, violating the semantics of a pair. Fixed in commit `83c17c3`.

**Applies here: yes, twice over.** `INV-10` (never transfer to the vault's own address or
the token's address) and `INV-03` (`Owner != Operator`) are both instances of this class.
The threat model records that the constructor and `set_operator` refuse `owner == operator`,
so INV-03 has a guard to verify. INV-10 needs Phase 3 to confirm the payee-validity gate
exists on all three value-moving paths, not just `pay`. Note prior-work item G-1: the EVM
sibling lacks this gate, so the two implementations differ here.

Breaks **INV-10**, **INV-03**.

Sources: as classes 6 and 5.

---

## 12. `i128` arithmetic: unchecked addition and the `MIN / -1` trap

**Concrete examples.**

Soroswap, `OS-SWP-SUG-00 | Integer Overflow`. Severity: **Informational**.
`receive_balance` computed `balance + amount` on `i128` with no check; OtterSec recommended
`checked_add`. Fixed in commit `716822e`.

OpenZeppelin Stellar Contracts RC v0.7.0, `Checked I256 Truncating Division Can Trap on
MIN / -1 Overflow`. Severity: **Low**. `checked_mul_div` lacked a guard for the
`I256::MIN / -1` case before dividing.

**Applies here: as a regression guard.** The threat model says `policy.rs` already uses
explicit `checked_add` precisely because `overflow-checks = true` lives in an editable
profile, which is the correct posture and matches OtterSec's recommendation. Phase 3 should
confirm every accumulation and comparison on the cap path is checked, and that the
`i128::MIN` negation case cannot be reached if any negation exists.
Breaks **INV-05**, **INV-11**.

Sources: as class 5; https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit

---

## 13. Allowlist/blocklist bypass through a path that skips the check

**Concrete example.** OpenZeppelin Stellar Contracts Library v0.3.0-rc.2, `Missing Checks on
Spender in Fungible BlockList Extension`. Severity: **Medium**. `transfer_from` failed to
validate whether the *spender* was blocklisted, so a blocked address could still drain
pre-approved allowances. The same audit separately notes as documentation-level that
AllowList and BlockList traits "claim total transfer prevention" while in fact permitting
transfers via pre-approvals.

**Mechanism.** The list is enforced on the obvious path and not on a second path that
reaches the same effect.

**Applies here: yes.** `owner_pay` bypasses the allowlist by design (INV-15 says so
explicitly), and `withdraw` moves value with no allowlist check at all. The class does not
say that is wrong; it says the gap must be intentional, documented, and matched by what the
product claims. Phase 3 should verify the allowlist is enforced on every path that is
supposed to have it, and Phase 5 should test that a non-allowlisted payee is refused by
`pay` under every combination of the other switches.
Breaks **INV-15**.

Source: https://www.openzeppelin.com/news/stellar-contracts-library-v0.3.0-rc.2-audit

---

## 14. Constructor and initializer state modelled indirectly

**Concrete examples.**

Blend, `BLRC-004 - Non-idiomatic initialization check in various initialization flows`
(recommendation, not a severity-rated finding). The pool, emitter and backstop each detected
re-initialization by checking whether an unrelated parameter such as the admin had been set.
Certora: "it constitutes secondary logic that does not directly represent the initialization
state" and recommended a dedicated `IsInitialized` key. Blend's response: "Acknowledged and
fixed".

OpenZeppelin Stellar Contracts Library v0.3.0-rc.2, `Lack of Validation`. Severity: **Low**.
Verbatim: "The `set_admin` and `set_owner` functions are designed to be called only once
within the lifecycle of a smart contract ... However, there is no validation preventing the
setter functions from being called multiple times."

**Applies here: mostly favourably, with one thing to confirm.** `AgentSpendPolicy` uses
`__constructor`, which is atomic at deploy and structurally immune to both findings: there
is no separate `initialize` to call twice and no initialization flag to model indirectly.
That is the strongest form of the recommended fix and Phase 3 should say so. What remains to
check is the constructor's own validation: it reads `decimals()` from the token as a
deploy-time SEP-41 proof, and refuses `owner == operator` and negative cap or ceiling. Phase
3 should confirm there is no reachable state where instance keys are absent other than
archival (P-3).
Relates to **INV-03**, **INV-16**.

Sources: as class 6;
https://www.openzeppelin.com/news/stellar-contracts-library-v0.3.0-rc.2-audit

---

## 15. Admin over-privilege rated as a finding in its own right

**Concrete example.** Allbridge Core (Stellar), `MED-1 Admin can drain stablecoin liquidity`.
Severity: **Medium** (Quarkslab). The admin held enough privilege over pool management,
via `set_bridge`, to withdraw stablecoin reserves. The finding was left unresolved, with
Allbridge committing to a cross-chain DAO. The same report carries `Lack of input
sanitization in admin functions` (Low) for setters that do not validate their parameters.

**Applies here: yes, and it must be stated rather than assumed away.** Our threat model
already says the owner has total authority over the balance and that nothing is enforced
against the owner. Quarkslab's precedent is that auditors rate exactly that as Medium even
when it is the intended design. Combined with P-2 (no owner rotation, no `set_owner`), an
owner key compromise is total and permanent loss, and an owner key loss locks the balance
forever. Phase 4 should carry this as an accepted-and-documented risk with the mitigation
the design actually offers, which is keeping the balance small.
Relates to P-2, and to the trust table in threat model section 3.

Source: https://blog.quarkslab.com/allbridge-core-stellar.html

---

## 16. Non-standard token behaviour and SEP-41 assumptions

**Concrete examples.** The OpenZeppelin negative-amount finding in class 2 is the sharpest
statement of this class: reverting on a negative transfer "is not required by the SEP-41
standard and as such, another implementation could potentially treat such transfer as 0
token transfer". OtterSec's Soroswap engagement covered "interactions with unknown tokens",
and the Soroswap scope note records that pair tokens "may be Soroban native tokens
implementing the Soroban token interface or Stellar assets", which are not the same thing.

Documented Stellar behaviour that a SAC-backed token can exhibit, from official docs rather
than an audit: an issuer with `AUTH_REQUIRED` means a contract address must be explicitly
authorized via `set_auth` before it can hold a balance, and issuers retain `clawback`,
`set_auth` and `AUTH_REVOCABLE` control over assets held by contract addresses.

**Applies here: yes, as a deployment risk, exactly as P-6 states.** The audited deployments
point at Circle's USDC SAC, but the constructor accepts any SEP-41 address. A token that
claws back, deauthorizes the vault, charges a fee on transfer, or rebases breaks the
contract's accounting or its liveness while the contract itself is unchanged.
Threatens **INV-08**, **INV-05**, **INV-20**; P-6.

Sources: https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit
https://developers.stellar.org/docs/tokens/stellar-asset-contract
as class 5 (Soroswap scope and OtterSec engagement notes)

---

## 17. Overloaded or misleading errors treated as a security defect

**Concrete example.** OpenZeppelin Stellar Contracts Library v0.3.0-rc.2, `Overloaded Error
Obscures Distinct Failure Cases`, filed under Notes and Additional Information. Verbatim:
"The current implementations of certain errors conflate multiple, semantically distinct
failure scenarios into a single generic error, significantly impairing clarity and
troubleshooting for developers." The examples were `AccessControlError::AccountNotFound` and
`AccessControlError::Unauthorized` masking index-out-of-bounds conditions and missing role
admins. The same report separately flags a misleading revert message: an expired pending
transfer reverts with `TransferInProgress`, which the auditors call out as misleading.

**Applies here: this is our product claim, so it is a first-class finding surface.** The
threat model states the typed refusal is a security property, not ergonomics: a refusal that
reports the wrong reason routes the human-in-the-loop to the wrong recovery. Published
audits do rate error conflation and misleading messages as findings, which justifies Phase 3
treating a mis-ordered or mis-attributed refusal as a real finding rather than a nit.
Breaks **INV-17**, **INV-22**.

Source: https://www.openzeppelin.com/news/stellar-contracts-library-v0.3.0-rc.2-audit

---

## 18. Panic or index-out-of-bounds on a publicly reachable path

**Concrete example.** Reflector V3, `[M-02] Expiration vector length mismatch causes panic
in extend_ttl() when assets are added with zero initial expiration period`. Severity:
**Medium**. When assets were added with a zero expiration period, the expiration vector grew
shorter than the asset list, so `extend_ttl()` panicked with an index-out-of-bounds error
when users tried to extend TTL by burning tokens.

Veridise's published Soroban checklist names the adjacent class: `Vec<T>` and `Map<K,V>`
elements are converted to `Val` at the host boundary and "there is no guarantee that these
values can be properly converted back to their expected types", so unvalidated collection
inputs can halt execution during retrieval. It also advises using `panic_with_error!` rather
than bare `panic!`.

**Applies here: narrowly.** `AgentSpendPolicy` takes no collection arguments, which removes
most of this surface. The residue is P-3: `get_owner`, `get_operator`, `get_token` and
`get_decimals` all `unwrap()`, and the Reflector finding is the precedent that a panic on a
publicly reachable path is a Medium, not a nit.
Breaks **INV-20**.

Sources: https://code4rena.com/reports/2025-10-reflector-v3
https://veridise.com/blog/audit-insights/building-on-stellar-soroban-grab-this-security-checklist-to-avoid-vulnerabilities/

---

## 19. Bounds check that does not match the specification

**Concrete example.** Blend, `BL-006 - Incorrect bounds check of reactivity constant in
require_valid_reserve_metadata`. Severity: **INFO**. The whitepaper bounded the reactivity
constant between 0.001 and 0.00001; the code only checked that it was above 0.0005. Certora
asked for the code or the whitepaper to be reconciled. Blend's response: "Acknowledged and
fixed".

**Applies here: yes, against the sentinel semantics.** **INV-16** says a zero `daily_cap`,
a zero `auto_approve_max` and a zero `SessionKeyExpiry` each mean "no bound", never "bound
of zero". That is a specification claim about a bounds check, and this class is precisely
the case where code and stated spec drift apart. Phase 3 should test all three sentinels
against the documentation and the frontend copy.
Breaks **INV-16**.

Source: as class 6.

---

## 20. Validating the counterparty contract's type or provenance

**Concrete example.** Blend, `BL-003 - Incomplete validation of contract types in backstop
deposit flow`. Severity: **HIGH**. The pool address supplied to a backstop deposit was never
checked to belong to that backstop instance, or to be a pool at all, so it was "possible to
deposit to the backstop, and potentially earn interest and rewards without ever risking any
funds". Certora recommended an explicit check that the address was instantiated by the
correct factory. Certora noted the practical impact was limited by parallel constraints
elsewhere, but still rated it High.

**Applies here: as the constructor's token check.** The threat model records P-4: `decimals`
is read from the token at construction and never used in logic, its real function being a
deploy-time proof that the address implements SEP-41. That is a weaker version of the check
Certora asked for. It proves the address responds to one SEP-41 method; it does not prove
the address is the intended token or that it behaves. Phase 3 should confirm P-4 is stated
honestly and that no gate has come to depend on `Decimals`.
Relates to P-4, P-6, **INV-08**.

Source: as class 6.

---

## 21. Events and record integrity

**Concrete example.** OpenZeppelin Stellar Contracts RC v0.7.0, `transfer_from Emits a
Non-SEP-41 Transfer Event Payload`. Severity: **Low**. The event carried a struct payload
where SEP-41 requires a single `i128` data field.

**Applies here: yes, because the event is the audit trail.** The threat model is explicit
that the `Paid` event is the audit trail and the running total in storage is not, since
`SpentOnDay` is temporary and expires. That makes event shape and completeness load-bearing
for reconstructing spend history after the temporary entry is gone. `INV-21` requires
exactly one event per successful state change, naming what changed.
Breaks **INV-21**.

Source: https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit

---

## 22. Rounding direction in fee or share arithmetic

**Concrete example.** Soroswap, `OS-SWP-ADV-02 [low] | Rounding Error In Fee Calculation`.
Severity: **Low**, Resolved. "The fee calculation in `swap` is prone to round-down division,
rounding down the fee."

**Applies here: probably not.** `AgentSpendPolicy` does no division, no share maths and no
fee. Listed for completeness and so Phase 3 can dismiss it explicitly rather than silently.
Likely `n/a`.

Source: as class 5.

---

## 23. Reentrancy through a cross-contract call - UNVERIFIED as a realized Soroban bug

I did not find a published Soroban audit report containing a confirmed reentrancy finding.
The strongest statements I could verify are indirect: CoinFabrik's Scout tooling detects
"whether cross-contract calls precede later storage writes", and a search result attributed
to that body of work reports that only one instance of self-reentrancy was found and that it
did not constitute a vulnerability. **I could not open a primary report confirming that
sentence, so treat it as UNVERIFIED.**

**Applies here: the ordering is already correct.** P-5 records that `settle` writes
`spent_on_day` before calling `transfer`, which is the reentrancy-safe ordering, and that
the whole invocation rolls back together if the transfer traps. Phase 3 should confirm both
halves. Note also Certora's Blend recommendation `BLRC-002`, which is adjacent and verified:
a cached-then-written-back state design was called "error-prone" because "future changes to
the code may omit the writeback operation, or add escape paths in which the transaction may
exit successfully before the writeback occurs".
Relates to **INV-12**, P-5.

Sources: https://www.coinfabrik.com/blog/scouting-for-vulnerabilities-in-stellar-smart-contracts/
as class 6 (BLRC-002).

---

## Appendix A. Reports read, with what each was good for

| Report | Firm, date | Read as | Value here |
| --- | --- | --- | --- |
| OpenZeppelin Stellar Contracts RC v0.7.0 | OpenZeppelin, April 2026 | HTML, headings and bodies re-verified verbatim | Best source by far. Contains an audited **spending-limit policy** for a Stellar smart account. Classes 2, 3, 4, 8, 10, 12, 16, 21 |
| OpenZeppelin Stellar Contracts Library v0.3.0-rc.2 | OpenZeppelin, September 2025 | HTML, verbatim re-verified | Instance TTL, allowlist bypass, initializer, overloaded errors. Classes 1, 3, 13, 14, 17 |
| Blend | Certora, January 2024 | PDF, full text extracted locally | Resource-limit dead ends, period accounting, same-address, counterparty validation. Classes 6, 7, 11, 14, 19, 20, 23 |
| Soroswap core | OtterSec, Dec 2023, report 2024-02-22 | PDF, full text extracted locally | Instance-storage DoS, auth tree phishing, i128, rounding. Classes 5, 9, 11, 12, 22 |
| Reflector V3 | Code4rena, Oct-Nov 2025 | HTML, headings re-verified verbatim | Missing admin auth, panic DoS. Classes 1, 18 |
| Allbridge Core (Stellar) | Quarkslab | HTML | Admin over-privilege rated Medium. Class 15 |
| StellarBroker | Runtime Verification, April 2025 | PDF, full text extracted locally | Findings are fee-specific (A1-A3) and did not yield a class for this contract. Its invariant-first methodology matches ours |
| Stellar Soroban Core | Veridise, v2.1 August 2025 | PDF, full text extracted locally | Host-level. Findings V-SOR-VUL-001 to 007 are mostly metering and naming. Not contract-level; no class drawn |

## Appendix B. Where I found nothing

- **No published Soroban audit finding on reentrancy.** See class 23.
- **No published Soroban audit finding on SAC clawback or `AUTH_REQUIRED` bricking a
  custody contract.** The behaviour is documented by Stellar, but I could not find an
  auditor who has written it up as a finding. Class 16 is therefore anchored on
  documentation for that half, and on the OpenZeppelin SEP-41 argument for the other.
- **The Stellar Security Portal aggregator** (`sorobansecurity.com`, now redirecting to
  `stellarsecurityportal.com`) renders its report index client-side and exposes no
  unauthenticated JSON at `/api/reports`. It could not be enumerated. A human browsing it
  may find further reports for a later pass.
- **Phoenix, Aquarius, YieldBlox, FxDAO and Slender**: I did not locate primary published
  reports for these within this pass. Not asserting anything about them.
