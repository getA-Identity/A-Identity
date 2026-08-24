# Threat model — AgentSpendPolicy (Soroban)

Phase 0 deliverable. Everything here is read from the code or probed from the live
network on 2026-08-24. Nothing is recalled from memory; version and advisory claims carry
their source.

Note on directories: this report lives in `audit/` at the repository root, per the audit
protocol. The pre-existing `soroban/audit/` is not a report directory, it is a tool
(`run-negative-controls.mjs`) that Phase 2 will run.

---

## 1. Scope

**In scope**

```
soroban/contracts/agent-spend-policy/src/**   lib.rs, policy.rs, storage.rs, error.rs, event.rs
soroban/contracts/agent-spend-policy/Cargo.toml
soroban/Cargo.toml                            workspace + release profile
soroban/rust-toolchain.toml
the built wasm artifact and its metadata
```

**Out of scope** (confirmed with the maintainer)

```
mcp/**              the TypeScript backend, including the code that calls this contract
src/**              the frontend
mcp/contracts/*.sol the EVM sibling contract
```

Out-of-scope code is still relevant as an *actor*: the backend holds the operator key on
some deployments, so "what the server can do" is part of the trust model even though the
server's own code is not being audited here.

---

## 2. What the contract is

A single-tenant vault. It custodies a SEP-41 token on behalf of one AI agent and enforces
that agent's spending policy on the ledger rather than in a server. Two roles:

- **owner** — a human. Sets the policy, freezes, overrides, withdraws.
- **operator** — the agent. May only call `pay`, and only inside the policy.

The product claim is the *typed refusal*: when a payment is refused, the caller gets a
named reason it can branch on, not an opaque trap. That makes the error table part of the
security surface, not just ergonomics.

### Deployments

| Network | Contract | Status |
| --- | --- | --- |
| `stellar:pubnet` (**mainnet, real money**) | `CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP` | live since 2026-08-24, holds real Circle USDC |
| `stellar:testnet` | `CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI` | live since 2026-08-15, test money |

Both run the same wasm, sha256 `155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239`.

### Toolchain and dependency posture

| Item | Value | How verified |
| --- | --- | --- |
| `soroban-sdk` | `=27.0.6`, exact pin, no caret | `soroban/Cargo.toml` |
| Latest stable on crates.io | `27.0.6`, published 2026-08-13, not yanked | crates.io API, 2026-08-24 |
| RustSec advisories | **the 404 means nothing, see below** | corrected 2026-08-24 after R3 |
| Rust toolchain | pinned `1.96.0`, target `wasm32v1-none` | `rust-toolchain.toml` |
| Release profile | `overflow-checks = true`, `panic = "abort"`, `lto`, `strip` | `soroban/Cargo.toml` |
| `unsafe` blocks | none | grep over `src/` |
| Upgrade entrypoint | none (`update_current_contract_wasm` absent) | grep over `contracts/` |

**Correction, 2026-08-24.** The first version of this table reported "no RustSec advisory
for soroban-sdk, soroban-env-host or stellar-xdr" as a reassuring result. It is not a
result at all. Phase 1 research (R3) established, and the lead auditor confirmed against
the local advisory database, that **RustSec has never carried a single Stellar advisory**:
909 crate directories, zero mentioning `soroban` or `stellar`. A 404 there is what you get
for an ecosystem the database does not cover, not evidence that the ecosystem is clean.

That matters beyond wording, because it makes a CI step decorative.
`.github/workflows/soroban.yml` runs `cargo audit` under the name "Advisory audit", and
`cargo audit` reads exactly that database. GitHub, meanwhile, does carry advisories for
these crates, including a high-severity one against rs-soroban-sdk. So the project's only
mechanical advisory channel is structurally incapable of reporting the advisories that
would actually apply to it. That is a Phase 3 finding for A8, not a note.

The SDK pin being *exactly* the current latest is worth stating plainly, because the
common finding here is the opposite. Phase 2 will still run `cargo audit` and
`cargo deny` against the full dependency tree, since the advisory check above covers only
the three named crates.

---

## 3. Actors and trust boundaries

| Actor | Controls | Trusted for | NOT trusted for |
| --- | --- | --- | --- |
| **owner** | every policy setter, `owner_pay`, `withdraw` | everything; total authority over the balance | nothing is enforced against the owner except arithmetic, balance and payee validity |
| **operator** (agent) | `pay` only | initiating payments | amount, payee, or frequency — all are gated |
| **anyone** | 13 view functions, TTL extension | nothing | — |
| **the token contract** | is called for `balance` and `transfer` | returning honest balances and moving the right amount | it is an external contract chosen at deploy time; if it misbehaves, vault accounting is wrong |
| **the network** | ledger timestamp, ledger sequence | the UTC day boundary and the session-key clock | — |

**The single load-bearing line.** On EVM this contract had two independent guards:
`msg.sender`, supplied by the chain and unforgeable, and the token's allowance accounting
underneath. Neither exists on Soroban. `pay` moves the vault's *own* balance, so the
token's `from`-side authorization is satisfied structurally by Soroban's direct-call rule,
and Soroban has no `msg.sender` at all. **The entire authorization surface is
`operator.require_auth()` in `pay` and `owner.require_auth()` in `require_owner`.** Delete
either and every policy gate still passes while the vault becomes drainable by anyone: a
cap says how much may move, never who may move it.

This is also why `mock_all_auths()` is dangerous here and why Phase 5's negative
authorization tests are non-negotiable — a suite that mocks all auths passes identically
against a contract with the guard removed.

---

## 4. Assets at risk

1. **The vault's token balance.** Real Circle USDC on pubnet. Capped at 1 USDC/day by
   policy, but the *balance* itself is bounded only by what the owner funds.
2. **The daily budget.** Griefing it (burning the cap without moving value) denies the
   legitimate agent for the rest of the UTC day.
3. **Availability of `withdraw`.** If the contract can be bricked, the balance is lost
   even though no attacker gains it. Given there is no upgrade path, bricking is
   effectively permanent.
4. **The truthfulness of the typed error.** A refusal that reports the wrong reason routes
   the human-in-the-loop to the wrong recovery. This is a security property here, not a UX
   one.

---

## 5. Attack surface

**Mutating entrypoints (9)**

| Function | Auth | Notes |
| --- | --- | --- |
| `__constructor(owner, operator, token_id, daily_cap, auto_approve_max)` | none (atomic at deploy) | reads `decimals()` from the token; refuses `owner == operator`, negative cap/ceiling |
| `pay(to, amount)` | `operator` | the agent path, full gate ladder |
| `owner_pay(to, amount)` | `owner` | bypasses freeze/ceiling/allowlist, still charged to the cap |
| `withdraw(to, amount)` | `owner` | not charged to the cap |
| `set_policy(daily_cap, auto_approve_max, allowlist_enabled)` | `owner` | refuses negatives |
| `set_allowed(payee, ok)` | `owner` | persistent per-payee entry |
| `set_operator(operator)` | `owner` | refuses `owner == operator` |
| `set_session_key_expiry(expiry)` | `owner` | 0 means unbounded |
| `set_frozen(frozen)` | `owner` | kill switch |

**View entrypoints (13)** — `owner`, `operator`, `token`, `decimals`, `daily_cap`,
`auto_approve_max`, `frozen`, `allowlist_enabled`, `session_key_expiry`, `is_allowed`,
`today`, `spent_today`, `balance`. No auth, no writes. `balance` makes a cross-contract
call; `is_allowed` extends a TTL as a side effect of a read.

**Storage**

| Durability | Keys | Rationale as documented |
| --- | --- | --- |
| instance | `Owner`, `Operator`, `Token`, `Decimals`, `DailyCap`, `AutoApproveMax`, `Frozen`, `AllowlistEnabled`, `SessionKeyExpiry` | small, global, read on nearly every call; one ledger entry |
| persistent | `Allowed(Address)` | per-payee, unbounded in count, so deliberately not instance |
| temporary | `SpentOnDay(u64)` | one per UTC day; expired reads as zero, which is correct for a past day |

The instance/persistent split is a deliberate defence against instance-storage exhaustion:
an unbounded key in the instance map would grow the single entry until every entrypoint
bricks, `withdraw` included.

**Cross-contract calls** — only to `store::get_token()`: `decimals()` once at construction,
then `balance()` and `transfer()` on the money paths.

**Events (7)** — `Paid`, `Withdrawn`, `PolicyUpdated`, `AllowlistSet`, `OperatorSet`,
`SessionKeyExpirySet`, `FrozenSet`. The `Paid` event is the audit trail; the running total
in storage is not (it is temporary and expires).

**Errors (10)** — frozen numbering, `Frozen=1` … `OwnerIsOperator=10`.

---

## 6. Structural properties that shape the audit

These are not findings. They are facts that determine what a finding would mean.

**P-1. No upgrade path.** There is no `update_current_contract_wasm`. Any Critical or High
finding cannot be patched in place on the live pubnet contract. The remediation is
`withdraw` → redeploy → repoint, which means a new contract id and a provenance update.
Phase 4 must treat this as the cost of every fix that touches deployed behaviour.

**P-2. No owner rotation.** There is no `set_owner`. The owner address chosen in the
constructor is permanent. Losing the owner key locks the balance forever; compromising it
is total loss. The only mitigation in the design is that the balance is meant to stay
small.

**P-3. Instance storage is read with `unwrap()`.** `get_owner`, `get_operator`, `get_token`
and `get_decimals` all `unwrap()`. The constructor always writes them, so the only way to
reach `None` is archival of the instance entry. `bump_instance` is called on every writing
entrypoint but **not on any view**, so a vault that is never written to drifts toward
archival on a `LONG_TTL_EXTEND` (150 days) clock. Archived instance state is restorable
via `RestoreFootprint`, so this is a liveness and operator-burden question rather than a
permanent loss — Phase 3 (A2, A6) must establish which.

**P-4. `Decimals` is stored but unused in logic.** Read from the token at construction,
exposed as a view, never consulted by any gate. Its real function is as a deploy-time
proof that the address implements SEP-41. Worth confirming it cannot drift into being
load-bearing.

**P-5. State is written before the external call.** `settle` writes `spent_on_day` and
then calls `transfer`. This is the reentrancy-safe ordering, and the whole invocation
rolls back together if the transfer traps. A2/A4 should confirm both halves.

**P-6. The token is chosen at deploy and is trusted thereafter.** The audited deployments
point at Circle's USDC SAC, whose behaviour is known. The contract does not require this:
any SEP-41 address may be passed to the constructor, so fee-on-transfer, rebasing,
clawback and authorization-required behaviours are in scope for A4 as *deployment* risks
even where the current deployments avoid them.

---

## 7. System invariants

Every finding in Phase 3 must reference one of these, or state `n/a` and justify it.

### Authorization

- **INV-01** — `pay` succeeds only if the address stored under `Operator` authorized the
  invocation. No argument may substitute for it.
- **INV-02** — `owner_pay`, `withdraw`, `set_policy`, `set_allowed`, `set_operator`,
  `set_session_key_expiry` and `set_frozen` succeed only if the address stored under
  `Owner` authorized the invocation.
- **INV-03** — `Owner != Operator` holds at construction and after every `set_operator`.
- **INV-04** — No view function mutates policy state or moves value.

### Money

- **INV-05** — For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
  successfully moved by **`pay`** on day `d` is `<= daily_cap`.
  **Corrected 2026-08-24.** This originally said "by `pay` and `owner_pay`", which two
  Phase 3 agents independently proved false. `check_owner_pay` in policy.rs applies the
  amount guard, the checked arithmetic and the balance guard, and NO cap comparison; the
  operator ladder has one at policy.rs:89 and the owner ladder does not. So `owner_pay`
  is CHARGED to the day accumulator and is not LIMITED by it, and A5 demonstrated moving
  51 times the cap in one UTC day through it. The contract's own comment was accurate
  ("counts toward the daily cap ... so on-chain accounting stays honest about total
  outflow" describes the record, not a limit); the invariant text was the defect.
- **INV-06** — Every amount successfully moved by `pay` is `<= auto_approve_max` when
  `auto_approve_max != 0`.
- **INV-07** — `withdraw` never changes `SpentOnDay`.
- **INV-08** — No entrypoint moves more than the vault's balance at the moment of the call.
- **INV-09** — Every amount that moves value is strictly positive.
- **INV-10** — `pay`, `owner_pay` and `withdraw` never transfer to the vault's own address
  or to the token's address.
- **INV-11** — `SpentOnDay(d)` is monotonically non-decreasing while day `d` is current.
- **INV-12** — A transfer that fails leaves `SpentOnDay` unchanged (atomicity).

### Policy semantics

- **INV-13** — While `Frozen`, `pay` always fails; `owner_pay` and `withdraw` still work.
- **INV-14** — While `SessionKeyExpiry != 0 && now > SessionKeyExpiry`, `pay` always fails;
  owner paths are unaffected.
- **INV-15** — While `AllowlistEnabled`, `pay` succeeds only to a payee with a live
  `Allowed` entry; `owner_pay` bypasses the allowlist.
- **INV-16** — A zero `daily_cap`, a zero `auto_approve_max` and a zero
  `SessionKeyExpiry` each mean "no bound", never "bound of zero".
- **INV-17** — The refusal ladder order is fixed and observable:
  `InvalidAmount` → `Frozen` → `SessionKeyExpired` → `PayeeNotAllowed` →
  `AboveAutoApprove` → `DailyCapExceeded` → `InsufficientBalance`. A caller must be able
  to branch on the reason.

### Durability and liveness

- **INV-18** — `SpentOnDay(d)` survives to the end of UTC day `d`. If it can expire early,
  the cap silently resets and the agent can spend more than `daily_cap` in one day.
- **INV-19** — The instance entry cannot grow without bound. No key whose count is driven
  by untrusted input may live in instance storage.
- **INV-20** — `withdraw` remains reachable for the owner for as long as the vault holds a
  balance.

### Integrity of the record

- **INV-21** — Every successful state change emits exactly one event naming what changed.
- **INV-22** — Error codes are stable: a given numeric code always means the same
  condition, across both deployed networks and any future build.

---

## 8. What Phase 3 must not assume

- Do not assume the token is Circle's USDC SAC. The constructor accepts any address.
- Do not assume `mock_all_auths()` proves anything about `require_auth` placement.
- Do not assume `overflow-checks = true` will always be set; `policy.rs` uses explicit
  `checked_add` precisely because a profile is editable.
- Do not assume the existing 52 tests cover what their names suggest; Phase 2's mutation
  run is what establishes that.
- Do not assume a refusal is free of side effects merely because it produces no
  transaction on Soroban — that is true for simulation, not for apply-time failure.

---

## 9. Prior work to deduplicate against

An earlier internal review (2026-08-22, 18 parallel agents, ~195 findings) covered the
wider repository. Two of its items touch this contract and are still open:

- **G-1** — the EVM sibling lacks the payee-validity gate this contract has. Out of scope
  here by the scope decision, but it means the "behaviour-identical port" claim is not
  exactly true, which A5 should note where the code comments assert parity.
- The negative-control runner in `soroban/audit/` is prior art for Phase 2 and should be
  run rather than reinvented.

Findings that merely restate these must be marked as duplicates, not counted as new.
