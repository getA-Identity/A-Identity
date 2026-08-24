# A1 - Authorization and access control

Agent A1, Phase 3. Scope: `soroban/contracts/agent-spend-policy/src/{lib.rs, policy.rs,
storage.rs, error.rs, event.rs}` and `src/test/**`, read line by line, plus the built wasm
export table.

Everything below was produced on 2026-08-24 against the working tree at `main` (4eb6bdc).
All experiments ran in a scratch copy at `/tmp/a1-scratch`, `/tmp/a1-pristine` and
`/tmp/a1-mut`. Nothing under `soroban/`, `mcp/` or `src/` was modified. No network
transaction was made.

---

## 0. Summary

| # | Severity | Title | Status |
| --- | --- | --- | --- |
| A1-01 | Medium | The owner is permanent: no rotation, no two-step transfer, no upgrade path | Confirmed |
| A1-02 | Low | A contract-address owner or operator is authorized by the invoker rule, with no signature at all | Confirmed |
| A1-03 | Low | `owner != operator` is address-level only; it does not separate authority, and three places in the code claim it does | Confirmed |
| A1-04 | Low | The constructor binds owner, operator, token and policy on the deployer's authority alone, permanently and with no read-back gate | Confirmed |
| A1-05 | Informational | `is_allowed` is an unauthenticated view that writes to the ledger | Confirmed (does not violate INV-04) |
| A1-06 | Informational | There are 13 view functions, not 12 | Confirmed |
| A1-07 | Low | Authorization test-suite gaps: `set_allowed`, third-party callers, argument rebinding, and the fact that no test ever uses a classic account address | Confirmed |

Nothing Critical or High was found in this domain.

### The positive result, stated plainly

The authorization surface is exactly what the threat model says it is, and it is correct.

* The whole crate contains **two** `require_auth` call sites: `lib.rs:117`
  (`operator.require_auth()` in `pay`) and `lib.rs:273` (`owner.require_auth()` in
  `require_owner`). There is no `require_auth_for_args`, no `authorize_as_curr_contract`,
  no `__check_auth`, no deployer call, no upgrade entrypoint.
* The whole crate contains **two** `transfer` call sites: `lib.rs:148` (`withdraw`) and
  `lib.rs:315` (`settle`). `withdraw` is guarded at `lib.rs:138`; `settle` is private and
  is reachable only from `pay` (guarded at 117) and `owner_pay` (guarded at 129).
* Every guard is the **first** statement of its entrypoint, before any storage write.
* `settle`, `require_owner` and `require_valid_payee` are `fn`, not `pub fn`, so
  `#[contractimpl]` does not export them. The built wasm exports exactly 22 contract
  functions: `__constructor`, the 8 mutating entrypoints, and the 13 views. Nothing else.
* Neither guard reads anything an attacker controls. `Owner` is written only by
  `__constructor`; `Operator` is written only by `__constructor` and by the owner-gated
  `set_operator`.
* Both guards use plain `require_auth()`, so each authorization is bound to the current
  invocation's own function name and full argument list. `pay`'s authorization therefore
  commits to `to` and `amount` (pinned by `test::auth::pay_requires_exactly_the_operator_and_nothing_else`,
  and re-verified negatively by my own probe). There is no argument-substitution surface.
* There is no `initialize`, so the unprotected-initializer and re-initialization classes
  are structurally absent rather than merely untested.
* Reentrancy cannot be used to reuse a live authorization context: soroban-env-host 27.0.1
  sets `ContractReentryMode::Prohibited` on every contract call
  (`src/host/frame.rs:110,119`, `src/host.rs:2596-2635`), so the token cannot call back
  into the vault during `balance()` or `transfer()`.

I re-ran the existing negative-control runner (`soroban/audit/run-negative-controls.mjs`)
on a pristine copy and added four mutations of my own that it does not cover. All ten were
caught.

---

## 1. Answers to the five Phase 1 leads

**Lead 1 - "is `operator.require_auth()` in `pay` plus `owner.require_auth()` in
`require_owner` the entire surface, with no third path to money?"**
Confirmed, exhaustively. Evidence in section 0 above: two guards, two transfers, every
transfer dominated by a guard, no exported private helper, 22 wasm exports and no more.

**Lead 2 - "audit the 52 tests: which use `mock_all_auths`, which assert `env.auths()`?"**
Measured, per test, by parsing the suite:

| | count |
| --- | --- |
| tests total | 52 |
| call `mock_all_auths` (via the `s.mock_auths()` helper) | 39 |
| assert on `env.auths()` | 3 |
| **blanket mock AND no `auths()` assertion** | **36** |
| run with authorization enforced (`enforce_auth()` and/or a targeted `env.mock_auths`) | 8 |
| touch no auth-gated path at all | 5 |

So the shape the SDK warns about is present in 36 of 52 tests. It is **not** load-bearing
here, for three reasons that I verified rather than assumed:

1. `setup()` does not mock. `mock_all_auths` is opt-in through `Setup::mock_auths`
   (`test/mod.rs:63-66`), and `Setup::enforce_auth` (`test/mod.rs:74-77`) calls
   `env.set_auths(&[])`, which soroban-sdk 27.0.6 documents as the way to disable mocking
   (`src/env.rs:1334-1338, 1413`). The 36 blanket-mocked tests are all behaviour, policy,
   storage-shape, amount and time tests, where authorization is explicitly not the subject.
2. The 8 enforcing tests are the ones that carry the auth claim, and 7 of them live in
   `test/auth.rs`.
3. The mutation evidence, which is what actually settles it. Existing runner, all six
   controls caught:
   ```
   baseline: green
   operator-require-auth: caught
   owner-require-auth: caught
   negative-amount-guard: caught
   checked-add: caught
   self-payee-guard: caught
   day-bucket-ttl-extension: caught
   All 6 negative controls were caught.
   ```
   The runner only ever *deletes* a guard. It does not test pointing a guard at the wrong
   address, which is the other half of my domain, so I ran four more:
   ```
   M1 constructor owner==operator guard deleted: caught
   M2 set_operator owner==operator guard deleted: caught
   M3 pay authorizes the OWNER instead of the operator: caught
   M4 require_owner authorizes the OPERATOR instead of the owner: caught
   ```
   A suite that mocks all auths and proves nothing would have survived M3 and M4.

The residual gaps are real but narrow, and they are A1-07.

**Lead 3 - "establish what the constructor's auth behaviour actually is."**
Two facts, one from source and one measured.

Source: `__constructor` (`lib.rs:74-104`) contains no `require_auth` call of any kind, so
it requires nothing from the `owner` or `operator` arguments.

Measured: I built the real wasm and deployed it the production way, with
`Env::deployer().with_address(...).deploy_v2(...)` under recording auth, which is the path
the soroban-sdk 27.0.6 docs prescribe because `register` "cannot be used to test a
constructor's authorization" (`src/env.rs:838-849, 918-929`). The resulting tree:

```
--- constructor auth tree ---
  authorizer: Contract(CAAAA...D2KM)          <- the deployer, and only the deployer
  invocation: CreateContractV2HostFn(CreateContractArgsV2 {
      contract_id_preimage: ...,
      executable: Wasm(Hash(0061cc9f...)),
      constructor_args: VecM([ owner, operator, token, I128(100), I128(100) ]) })
```

So the constructor's authorization is the deploy operation's authorization, it covers all
five constructor arguments as signed payload, and the address named as `owner` never
authorizes anything. That is exactly the CAP-0058 behaviour R1 A-7 describes, it is atomic,
and it makes the front-run-the-initializer class structurally impossible. The consequence
worth carrying forward is A1-04, not a defect in the constructor.

**Lead 4 - "does CAP-0071 `delegate_account_auth` break a stated guarantee?"**
No, not for the live deployments, and the reason is checkable. In soroban-env-host 27.0.1,
`delegate_account_auth` begins with `self.ensure_check_auth_frame("delegate_account_auth")`
(`src/host.rs:3645-3653`), so it can only be called from inside a contract's `__check_auth`.
A classic G-address account has no `__check_auth` and cannot delegate. Both live
deployments use G-addresses for owner and operator
(`soroban/releases/pubnet-v0.1.0.json`: owner `GARC7OFB...`, operator `GDLAJM25...`;
`testnet-v0.1.0.json`: owner `GBLHNAL5...`, operator `GDZXSO4A...`). Delegation therefore
does not apply today.

Two precisions worth recording. First, delegation is not a silent account property: the
delegated signers arrive in the credential the signer supplies for that transaction
(`SOROBAN_CREDENTIALS_ADDRESS_WITH_DELEGATES`), and the host errors with "no delegated
signers were provided" if `__check_auth` asks for one that was not
(`soroban-env-host-27.0.1/src/auth.rs:1026-1075`). Second, the residual risk it points at is
real but is the same risk as A1-02 and A1-03: for any future vault with a C-address owner or
operator, the set of keys that can satisfy `require_auth` is defined by that account
contract and can change without touching the vault.

**Lead 5 - "can `set_operator`'s `owner == operator` refusal be bypassed, including at
construction?"**
Not at the address level. `__constructor` refuses it before writing anything
(`lib.rs:85-87`), `set_operator` refuses it after `require_owner`
(`lib.rs:188-190`), and there is no `set_owner`, so `Owner` never changes after the
constructor and the comparison can never go stale. Mutations M1 and M2 confirm both guards
are covered by the suite. **But the invariant it enforces is weaker than the code claims it
is**, which is A1-03.

---

## 2. Findings

### A1-01 - The owner is permanent: no rotation, no two-step transfer, no upgrade path

* **Severity:** Medium
* **Impact:** An owner key compromise is total and irreversible: the attacker can lift the
  policy, retarget the operator, unfreeze, and `withdraw` the entire balance, and the
  legitimate owner has no move that removes them. An owner key loss is the mirror image:
  `withdraw` becomes unreachable and the balance is locked forever. Neither is patchable
  in place, because there is also no `update_current_contract_wasm`.
* **Likelihood:** Low per unit time, but the exposure is unbounded in time and the
  deployment receipt records that both keys are "burner keys generated for this deploy and
  held in a local CLI keystore, not a multisig and not an HSM".
* **Violates:** INV-20 (`withdraw` remains reachable for the owner for as long as the vault
  holds a balance) in the key-loss case. Formalizes threat-model P-1 and P-2.
* **Location:** absence, verified across `lib.rs:64-325` (no `set_owner` in the
  `#[contractimpl]` block) and confirmed against the built wasm export table (22 contract
  exports, none of them an owner setter or an upgrade entrypoint). The single write to
  `Owner` is `storage.rs:102-104`, called only from `lib.rs:94`.
* **Category:** Admin over-privilege / missing key rotation (R2 class 15; R1 section 903 two-step
  `Ownable`).
* **Detected by:** manual review, corroborated by the wasm export dump.
* **Status:** Confirmed.

**Description.** The threat model records this as P-2 and the release receipt records it as
a caveat, so it is a known and deliberate trade rather than a surprise. It is rated here
because the audit has to price it: R2 class 15's precedent is Quarkslab rating exactly this
shape (Allbridge Core `MED-1 Admin can drain stablecoin liquidity`) as Medium even where it
was the intended design, and OpenZeppelin's Stellar `Ownable` ships a two-step transfer for
precisely this reason.

What makes the Soroban instance sharper than the usual one is that the two normal escape
hatches are both absent by design. There is no upgrade path, so the code cannot grow a
`set_owner` later. And the owner address is fixed at construction, so the owner cannot even
migrate to a safer custody model (a multisig account, or a custom-account contract with a
rotatable signer set) without a full withdraw, redeploy and repoint, which produces a new
contract id and invalidates every published reference to the old one.

The design's own mitigation is real and should be stated with the finding: the balance is
meant to stay small, and on pubnet the cap is 1 USDC per UTC day. That bounds the loss; it
does not bound the permanence.

**Proof of Concept.** This is an absence, so the proof is an exhaustive enumeration rather
than a failing test. From the built wasm's export section:

```
EXPORTS: __constructor, pay, owner_pay, withdraw, set_policy, set_allowed, set_operator,
         set_session_key_expiry, set_frozen, owner, operator, token, decimals, daily_cap,
         auto_approve_max, frozen, allowlist_enabled, session_key_expiry, is_allowed,
         today, spent_today, balance
```

22 functions. No `set_owner`, no `transfer_owner`, no `upgrade`,
no `update_current_contract_wasm`.

**Recommended fix.**

For the *live* contracts, this cannot be fixed in code. The operational remediation is:

1. Treat the owner key as the single point of total failure it is, and hold it accordingly.
2. Keep enforcing the small-balance discipline that already bounds the loss.
3. Rehearse the recovery that does exist (`withdraw` -> redeploy -> repoint) so that the
   response to a suspected compromise is a drill and not an improvisation.

For the *next* deployment, two changes, in order of value:

1. Deploy with an owner that can rotate its own signers without the vault changing: a
   classic account with multisig, or a custom-account contract. This costs nothing in the
   contract and removes most of the finding. Note it interacts with A1-02: a
   custom-account owner must not expose any callable path that reaches the vault.
2. Add a two-step transfer, so a typo cannot brick the vault:

```rust
// storage.rs
    PendingOwner,

// lib.rs
    /// Nominate a new owner. Nothing changes until the nominee accepts, so a mistyped
    /// address costs nothing.
    pub fn propose_owner(env: Env, new_owner: Address) -> Result<(), Error> {
        Self::require_owner(&env);
        store::bump_instance(&env);
        if store::get_operator(&env) == new_owner {
            return Err(Error::OwnerIsOperator);
        }
        store::set_pending_owner(&env, &new_owner);
        OwnerProposed { new_owner }.publish(&env);
        Ok(())
    }

    /// The nominee proves control of the key before it becomes load-bearing.
    pub fn accept_owner(env: Env) -> Result<(), Error> {
        let pending = store::get_pending_owner(&env).ok_or(Error::NoPendingOwner)?;
        pending.require_auth();
        store::bump_instance(&env);
        store::set_owner(&env, &pending);
        store::clear_pending_owner(&env);
        OwnerChanged { owner: pending }.publish(&env);
        Ok(())
    }
```

Note that `Error::NoPendingOwner` must be a **new** discriminant (11), appended, never a
reused number, per the frozen-ABI rule in `error.rs:3-6`.

**References.**
- R2 class 15, Allbridge Core (Stellar) `MED-1`, Quarkslab, Medium:
  https://blog.quarkslab.com/allbridge-core-stellar.html
- R1 section 903, OpenZeppelin Stellar `Ownable` two-step transfer.
- Threat model P-1, P-2, INV-20.
- `soroban/releases/pubnet-v0.1.0.json`, `caveats[2]`.

---

### A1-02 - A contract-address owner or operator is authorized by the invoker rule, with no signature at all

* **Severity:** Low
* **Impact:** If the stored `operator` is a contract address, anyone who can reach a
  function on that contract which calls `pay` can spend from the vault up to the policy
  limits, with **zero authorization entries in the transaction**. If the stored `owner` is a
  contract address, the same shape reaches `withdraw` and empties the vault entirely,
  ignoring the policy.
* **Likelihood:** Low today: both live deployments use classic G-addresses for owner and
  operator, verified from the deploy receipts, so neither is currently in this state. The
  path into it is live, though: `set_operator` accepts any `Address` and is callable by the
  owner at any time, and "the agent is a smart account" is a natural direction for this
  product.
* **Violates:** the intent of INV-01 and INV-02. As literally worded they are satisfied,
  which is the point of the finding: the stored address *did* authorize the invocation, by
  a rule that requires no key.
* **Location:** `lib.rs:112-121` (`pay`), `lib.rs:271-274` (`require_owner`),
  `lib.rs:185-194` (`set_operator`, which performs no address-kind validation),
  `lib.rs:74-104` (`__constructor`, likewise).
* **Category:** Address-kind confusion / invoker-contract authorization (R1 A-5).
* **Detected by:** manual review, then proven with two Rust tests plus a control.
* **Status:** Confirmed.

**Description.** soroban-env-host 27.0.1 documents four ways an address can satisfy
`require_auth`, and the first one carries no credential at all
(`soroban-env-host-27.0.1/src/auth.rs:96-104`, verbatim):

> "The address of a contract that is an _invoker_. We say that if contract C invokes
> contract D, then C authorized D. This is simple and requires no credentials as the host
> literally observes the call from C to D."

The vault cannot tell a C-address from a G-address, and the SDK guidance is explicitly that
it should not have to ("Developers do not need to consider the type of address used for
authorization", R1 A-5). That guidance is sound for the normal case, where a custom account
guards its own entrypoints. It stops being sound when a contract is named as the *subject*
of an authority the vault treats as a key: for a G-address the authority is a signature
meeting the account's medium threshold, while for a C-address it can be nothing more than
"some code called us".

`lib.rs:26-29` states the security claim as "if that line were missing, any funded account
on the network could drain the vault". The line is not missing. But with a contract operator
that has a reachable path to `pay`, the outcome is the same and the line is still there.

Note what this finding is *not*. It is not a defect in the current deployments, and it is
not an argument for rejecting contract addresses: A1-01's best mitigation is precisely a
custom-account owner. The two findings together define the safe shape: a contract owner or
operator is fine, and often better, **provided that contract exposes no callable path that
reaches the vault**.

**Proof of Concept.** Both tests below pass on current code, i.e. the drain succeeds. Full
file at `audit/tool-output/A1-probe-tests.rs`; drop it in as `src/test/a1_poc.rs` and add `mod a1_poc;` to
`src/test/mod.rs`.

```rust
/// A contract that simply forwards to `pay`. Stands in for an "agent" implemented as a
/// smart account / passkey account / router rather than as a classic G-account.
#[contract]
pub struct OperatorShim;

#[contractimpl]
impl OperatorShim {
    pub fn go(env: Env, vault: Address, to: Address, amount: i128) {
        AgentSpendPolicyClient::new(&env, &vault).pay(&to, &amount);
    }
}

#[test]
fn poc_a_contract_operator_lets_anyone_spend_with_no_signature_at_all() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let payee = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    // The owner points the operator at a contract, not a keypair.
    let shim = env.register(OperatorShim, ());
    let vault = env.register(
        AgentSpendPolicy,
        (owner, shim.clone(), token_id.clone(), 100 * UNIT, 100 * UNIT),
    );

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&vault, &(10 * UNIT));

    // Full enforcing auth, zero authorization entries. Nobody signed anything.
    env.set_auths(&[]);

    OperatorShimClient::new(&env, &shim).go(&vault, &payee, &UNIT);

    assert_eq!(
        token::Client::new(&env, &token_id).balance(&payee),
        UNIT,
        "a payment settled with no authorization entry in the transaction"
    );
}
```

The owner variant is the sharper one, because it is not bounded by the policy:

```rust
#[contractimpl]
impl OwnerShim {
    pub fn drain(env: Env, vault: Address, to: Address, amount: i128) {
        AgentSpendPolicyClient::new(&env, &vault).withdraw(&to, &amount);
    }
}

#[test]
fn poc_a_contract_owner_lets_anyone_withdraw_the_entire_balance() {
    // ... vault registered with owner = shim, daily_cap = 1, auto_approve_max = 1 ...
    env.set_auths(&[]);
    OwnerShimClient::new(&env, &shim).drain(&vault, &attacker, &(10 * UNIT));
    assert_eq!(
        token::Client::new(&env, &token_id).balance(&attacker),
        10 * UNIT,
        "the whole vault left with no authorization entry in the transaction"
    );
}
```

And the control, which also passes, proving the two above succeed because of the invoker
rule and not because `set_auths(&[])` failed to enforce:

```rust
#[test]
fn poc_control_a_shim_that_is_not_the_operator_still_fails() {
    // identical, except the stored operator is a generated address and not the shim
    env.set_auths(&[]);
    assert!(OperatorShimClient::new(&env, &shim)
        .try_go(&vault, &payee, &UNIT)
        .is_err());
    assert_eq!(token::Client::new(&env, &token_id).balance(&payee), 0);
}
```

```
test test::a1_poc::poc_a_contract_operator_lets_anyone_spend_with_no_signature_at_all ... ok
test test::a1_poc::poc_a_contract_owner_lets_anyone_withdraw_the_entire_balance ... ok
test test::a1_poc::poc_control_a_shim_that_is_not_the_operator_still_fails ... ok
```

**Recommended fix.** Documentation and process, not code. Do **not** blanket-reject contract
addresses: that would forbid the multisig and custom-account owners that A1-01 wants.

1. State the rule where an operator is chosen. Suggested text for the doc comment above
   `set_operator` and for `soroban/README.md`:

```rust
    /// Rotate the agent key.
    ///
    /// The operator may be a classic account (G...) or a contract (C...), and the two are
    /// NOT equivalent for security. Soroban satisfies `require_auth` for a contract
    /// address by the invoker rule: if contract C calls this vault, the host treats C as
    /// having authorized the call, with no credential of any kind. So a contract operator
    /// is only as strong as its own entrypoints. Naming a contract here that exposes any
    /// reachable path to `pay` makes this vault spendable by whoever can reach that path.
    /// The same applies, without the policy ceiling, to a contract owner and `withdraw`.
    pub fn set_operator(env: Env, operator: Address) -> Result<(), Error> {
```

2. Add a deployment/rotation checklist item: if `owner` or `operator` starts with `C`,
   record which contract it is and what guards its entrypoints, in the release receipt
   alongside the existing `constructor` block.

3. Optional, for a future version, if the product decides operators must be keypairs:
   a StrKey prefix check is possible inside a contract but costs a 56-byte string copy on
   a path that runs at deploy and on rotation only, so the cost is acceptable:

```rust
fn require_account_address(env: &Env, a: &Address) -> Result<(), Error> {
    let mut buf = [0u8; 56];
    a.to_string().copy_into_slice(&mut buf);
    if buf[0] != b'G' {
        return Err(Error::NotAnAccount); // new discriminant, appended
    }
    Ok(())
}
```
   Weigh this against A1-01: it would also forbid a custom-account owner. My recommendation
   is 1 and 2, not 3.

**References.**
- soroban-env-host 27.0.1, `src/auth.rs:96-104` (invoker-contract authorization).
- R1 A-5, "Contract addresses and account addresses are indistinguishable to
  `require_auth`":
  https://developers.stellar.org/docs/build/guides/auth/contract-authorization
- `soroban/releases/pubnet-v0.1.0.json`, `testnet-v0.1.0.json` (owner and operator are
  G-addresses on both networks).

---

### A1-03 - `owner != operator` is address-level only; it does not separate authority, and three places in the code claim it does

* **Severity:** Low
* **Impact:** The stated purpose of the `OwnerIsOperator` guard is that "a single key that
  can both spend past the policy and lift the policy is the same as no policy". Two
  distinct addresses can be satisfied by one key, in which case the guard passes and the
  policy is exactly as absent as if the guard had failed. The consequence is the loss of a
  guarantee the product asserts, not a new attack: reaching the state requires the owner to
  have configured it.
* **Likelihood:** Low. It requires the owner account to list the operator's signer at
  medium weight (or, for C-addresses, a `__check_auth` that accepts it). Nothing in the
  current deployments does this. But nothing detects it either, and it is exactly the kind
  of convenience a busy operator adds later.
* **Violates:** INV-03, in intent. As worded ("`Owner != Operator` holds at construction and
  after every `set_operator`") the invariant is enforced correctly; the wording is what is
  too weak.
* **Location:** `lib.rs:82-87` (constructor guard and its comment), `lib.rs:188-190`
  (`set_operator` guard), `error.rs:56-60` (the ABI doc comment),
  `src/test/behaviour.rs:236-247` (the test comment).
* **Category:** Missing same-address validation, and the limits of it (R2 class 11); R1 A-5.
* **Detected by:** manual review against the host's authentication rules.
* **Status:** Confirmed as a documentation-versus-reality gap. The *mechanism* is confirmed
  from host source; I could not build a test for the classic-account case (see
  section 3, Unconfirmed).

**Description.** Three places in the codebase assert that the guard is airtight:

- `lib.rs:83-84`: "The TypeScript vault path already refuses this; refusing it here makes it
  unbypassable."
- `error.rs:58-59`: "The TypeScript vault path already refuses this
  (`mcp/src/platform/vault.ts`); enforcing it here makes it unbypassable."
- `src/test/behaviour.rs:240-241`: "the contract makes it unbypassable."

What the guard actually enforces is that two *addresses* differ. What it is claimed to
enforce is that two *authorities* differ. Those are not the same thing on Stellar, in either
address family:

- **Classic accounts.** soroban-env-host 27.0.1, `src/auth.rs:106-109`, verbatim: an account
  address must supply credentials "satisfying the account's classic multisig authorization to
  its medium threshold". A Stellar account's signer set is mutable by that account. If the
  owner account `GARC...` adds the operator key `GDLA...` as a signer with weight at or above
  its medium threshold, then the operator key satisfies `owner.require_auth()`, the two
  addresses remain distinct, the guard remains satisfied, and one key now both spends past
  the policy and lifts it.
- **Contract accounts.** A custom account decides for itself, in `__check_auth`, what
  satisfies it, and after CAP-0071 it may additionally delegate to another address
  (`soroban-env-host-27.0.1/src/host.rs:3645-3653`, `src/auth.rs:1026-1075`). Two distinct
  C-addresses can accept the same signer.

The contract has no way to see or prevent any of this, and should not try. The fix is to
stop claiming otherwise.

**Proof of Concept.** Mechanism, from the host source that runs on-chain:

```
soroban-env-host-27.0.1/src/auth.rs:106-109
//!   2. The address of a Stellar classic account, identified by `AccountID`,
//!      that must supply `SorobanAddressCredentials` for any
//!      `AuthorizedInvocation` it authorizes, satisfying the account's classic
//!      multisig authorization to its medium threshold.
```

The guard itself works exactly as advertised at the address level, which mutations M1 and M2
confirm:

```
M1 constructor owner==operator guard deleted: caught
M2 set_operator owner==operator guard deleted: caught
```

I could not build a unit test that gives a generated address a custom signer set; see
section 3.

**Recommended fix.** Correct the three claims. Suggested replacement for `error.rs:56-60`:

```rust
    /// Owner and operator are the same address. Refused at construction and on
    /// `set_operator`, because a single compromised key would then be able to both spend
    /// past the policy and lift the policy. The TypeScript vault path already refuses this
    /// (`mcp/src/platform/vault.ts`).
    ///
    /// Note the limit of this guard, because it is easy to over-read. It compares
    /// ADDRESSES, not authorities. Two distinct addresses can be satisfied by one key: a
    /// classic account authorizes at its medium threshold, so an owner account that lists
    /// the operator's signer defeats the separation while still passing this check, and a
    /// custom account decides for itself what satisfies it. Keeping the two roles under
    /// genuinely separate control is a deployment responsibility that no on-chain check
    /// can take over.
    OwnerIsOperator = 10,
```

and drop the word "unbypassable" from `lib.rs:82-84` and `src/test/behaviour.rs:240-241`.
Add the signer-independence requirement to the deployment checklist so it is verified rather
than assumed.

**References.**
- soroban-env-host 27.0.1, `src/auth.rs:106-109`, `src/host.rs:3645-3653`,
  `src/auth.rs:1026-1075`.
- R1 A-5, final sentence: "whether `Owner == Operator` rejection (INV-03) is the only
  structural separation, since two distinct addresses can still be controlled by one signer."
- R1 P-1, CAP-0071: https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md
- R2 class 11, missing same-address validation.

---

### A1-04 - The constructor binds owner, operator, token and policy on the deployer's authority alone, permanently, with no read-back gate

* **Severity:** Low
* **Impact:** A wrong `owner` argument at deploy is unrecoverable. Because there is no
  `set_owner` (A1-01) and no upgrade path, a vault deployed with an owner nobody controls
  can never be corrected, and anything funded into it is permanently lost. The named owner
  does not authorize the constructor, so the mistake produces no signal at deploy time.
* **Likelihood:** Low. It is a deployer error rather than an attack, and it is caught by any
  read-back of `owner()` before funding.
* **Violates:** n/a directly. It is the mechanism that turns INV-20 and P-2 from a key-loss
  risk into a deploy-time risk.
* **Location:** `lib.rs:74-104` (`__constructor`). Validation present: `owner != operator`
  (85-87), non-negative cap and ceiling (88-90), and a `decimals()` probe of the token (92).
  Validation absent: anything about `owner`.
* **Category:** Constructor and initializer modelling (R2 class 14); constructor
  authorization is the deployer's authorization (R1 A-7).
* **Detected by:** manual review, then measured with a real-wasm `Env::deployer` deployment.
* **Status:** Confirmed.

**Description.** The good news first, because it is the larger half. Using `__constructor`
rather than an `initialize` entrypoint is the strongest available form of the fix R2 class 14
recommends: there is no separate initializer to call twice, no `IsInitialized` flag modelled
indirectly through an unrelated key, and no window in which the contract exists unowned. The
front-run-the-initializer class is structurally absent. `lib.rs:43-45` says exactly this and
it is correct.

What remains is the consequence of that atomicity. The deployer signs
`CreateContractV2HostFn` with the constructor arguments as part of the signed payload, so the
initial owner, operator, token and policy are asserted entirely by whoever ran the deploy.
The address named as owner never consents. Combined with the permanence in A1-01, the deploy
transaction is a single irreversible act with no second signature and no confirmation step.

The token argument has a natural guard already: `decimals()` is read at `lib.rs:92`, so an
address that does not implement SEP-41 fails at deploy. `owner` has no analogue, and cannot
easily have one, since requiring `owner.require_auth()` in the constructor would make every
deploy a two-signature transaction. That is a legitimate design choice; the compensating
control belongs in the process.

**Proof of Concept.** Deployed the production way (real wasm, `Env::deployer`), which is what
the soroban-sdk 27.0.6 docs prescribe for constructor auth because `register` "cannot be used
to test a constructor's authorization" (`src/env.rs:838-849`):

```rust
#[test]
fn poc_the_constructor_requires_no_authorization_from_the_owner() {
    // ...
    env.mock_all_auths();
    let hash = env.deployer().upload_contract_wasm(WASM);
    let vault = env.deployer()
        .with_address(deployer.clone(), salt)
        .deploy_v2(hash, (owner.clone(), operator, token_id, 100i128, 100i128));

    let auths = env.auths();
    assert!(!auths.iter().any(|(who, _)| *who == owner),
        "the address named as owner authorized the constructor");
    assert!(auths.iter().any(|(who, _)| *who == deployer));
}
```

Output:

```
--- constructor auth tree ---
  authorizer: Contract(CAAAA...D2KM)
  invocation: CreateContractV2HostFn(CreateContractArgsV2 { ...
      executable: Wasm(Hash(0061cc9f...)),
      constructor_args: VecM([Address(...owner...), Address(...operator...),
                              Address(...token...), I128(100), I128(100)]) })
test test::a1_poc::poc_the_constructor_requires_no_authorization_from_the_owner ... ok
```

One authorizer, the deployer, over all five arguments. The owner is absent.

**Recommended fix.** Process, since the constructor's behaviour is correct as designed.

1. Make read-back before funding a mandatory, recorded step. The pubnet receipt already
   records the constructor arguments and a `finalState` block; add a `verifiedAfterDeploy`
   block that records the values read *back off the chain* and states that no funds moved
   before it was checked:

```jsonc
  "verifiedAfterDeploy": {
    "checkedAt": "2026-08-24T14:07:00Z",
    "method": "stellar contract invoke --id CB5LYXFK... --network pubnet -- owner",
    "owner": "GARC7OFB...",       // matches constructor.owner
    "operator": "GDLAJM25...",    // matches constructor.operator
    "token": "CCW67TSZ...",       // matches constructor.token
    "decimals": 7,
    "note": "Read back before the vault was funded. The named owner never signs the
             constructor, so this read-back is the only confirmation that the address is
             the one intended and is controlled."
  }
```

2. For a future version, consider requiring `owner.require_auth()` in the constructor. It
   makes deploys need the owner's signature as well as the deployer's, which is friction, but
   it converts an unrecoverable typo into a failed transaction. Given that this contract has
   no upgrade path and no owner rotation, the trade is more favourable here than it would
   normally be.

**References.**
- R1 A-7: https://github.com/stellar/stellar-protocol/blob/master/core/cap-0058.md
- R2 class 14 (Blend `BLRC-004`; OpenZeppelin Stellar Contracts Library v0.3.0-rc.2
  `Lack of Validation`).
- soroban-sdk 27.0.6, `src/env.rs:838-849, 918-929`.

---

### A1-05 - `is_allowed` is an unauthenticated view that writes to the ledger

* **Severity:** Informational
* **Impact:** None found. It is an unauthenticated write path, which must be reasoned about
  rather than waved through, and the reasoning comes out clean.
* **Likelihood:** n/a
* **Violates:** nothing. **INV-04 holds**: the write is a TTL extension, not policy state,
  and no value moves.
* **Location:** `storage.rs:189-198` (`is_allowed`), reached from the view at `lib.rs:252-254`
  and from the payment snapshot at `lib.rs:301`.
* **Category:** Views must not require auth, and auth must not be skippable (R1 A-6);
  TTL-as-permission (R1 S-3).
* **Detected by:** manual review, then proven with a TTL-observing test.
* **Status:** Confirmed, benign.

**Description.** `is_allowed` extends the payee entry's TTL when the entry is present and
true. Called through the public `is_allowed` view, that means any anonymous caller can cause
a ledger write. Three things make it harmless, and all three are worth recording because each
one is a place where a similar contract goes wrong:

1. **Revocation is by removal, not by expiry.** `set_allowed(payee, false)` removes the entry
   (`storage.rs:207-211`), and `is_allowed` on an absent entry returns `false` without
   extending. So an attacker cannot keep a revoked payee alive by pinging the view.
2. **The session key bound does not use storage expiry either.** `policy.rs:71-77` compares a
   stored deadline against the ledger clock and says why: "Anyone can extend any entry's TTL,
   so 'the entry expired, therefore the permission ended' is broken by design." That is
   exactly the anti-pattern, correctly avoided.
3. **Rent for the extension is paid by the caller**, not by the vault, so there is no
   griefing angle against the owner.

The remaining 12 views write nothing at all.

**Proof of Concept.** Passes on current code; it demonstrates the write rather than a defect.

```rust
#[test]
fn poc_the_is_allowed_view_extends_a_ttl_with_no_authorization() {
    // owner allowlists the payee, then the ledger advances past LONG_TTL_THRESHOLD
    s.advance_ledgers(1_700_000);
    // Fully enforcing, zero authorization entries, an anonymous caller.
    s.enforce_auth();
    assert!(s.client().is_allowed(&s.payee));
    assert_eq!(read_ttl(), LONG_TTL_EXTEND, "an unauthenticated view wrote to the ledger");
}
```

```
ttl before=2592000 after 1000 ledgers=892000 after an anonymous is_allowed()=2592000
test test::a1_poc::poc_the_is_allowed_view_extends_a_ttl_with_no_authorization ... ok
```

And the INV-04 sweep over the whole view set, also passing:

```
test test::a1_poc::coverage_all_thirteen_views_need_no_auth_and_mutate_no_policy_state ... ok
```

**Recommended fix.** None required. Optionally add one line to the doc comment on the
`is_allowed` view so a reader does not have to follow it into `storage.rs` to learn that a
read costs a write:

```rust
    /// True when the payee has a live allowlist entry.
    ///
    /// Not a pure read: a live entry has its TTL extended as a side effect, so calling this
    /// writes to the ledger. That is deliberate and harmless (revocation removes the entry
    /// rather than letting it expire, and the caller pays for the extension), but it means
    /// this view costs more than the other twelve.
    pub fn is_allowed(env: Env, payee: Address) -> bool {
```

**References.** R1 A-6, R1 S-3; `policy.rs:71-77`.

---

### A1-06 - There are 13 view functions, not 12

* **Severity:** Informational
* **Impact:** A miscount in the audit's own scoping document. Harmless in itself, but a view
  that is not on the list is a view nobody checks.
* **Violates:** n/a
* **Location:** `lib.rs:216-267`; threat model `00-threat-model.md` section 5, heading "View
  entrypoints (12)".
* **Detected by:** counting `pub fn` in the `#[contractimpl]` block, cross-checked against
  the wasm export section.
* **Status:** Confirmed.

**Description.** The threat model's heading says 12 and the list under it names 13: `owner`,
`operator`, `token`, `decimals`, `daily_cap`, `auto_approve_max`, `frozen`,
`allowlist_enabled`, `session_key_expiry`, `is_allowed`, `today`, `spent_today`, `balance`.
`today` is the one usually dropped. The task brief for this agent inherited the 12.

**Proof of Concept.**

```
$ grep -c "^    pub fn " lib.rs
22
```

22 = 1 constructor + 8 mutating entrypoints + 13 views, matching the 22 function exports in
the built wasm.

I checked all 13, and INV-04 holds for every one of them
(`coverage_all_thirteen_views_need_no_auth_and_mutate_no_policy_state`). `is_allowed` is the
only one that writes anything, and only a TTL (A1-05). `balance` is the only one that makes a
cross-contract call, to the deploy-time token; that is A4's ground, not mine, and no
authorization consequence follows from it because the host prohibits reentry.

**Recommended fix.** Change "View entrypoints (12)" to "(13)" in `00-threat-model.md`
section 5.

---

### A1-07 - Authorization test-suite gaps

* **Severity:** Low
* **Impact:** Assurance, not behaviour. Every gap below describes a property the current code
  gets **right**: I wrote the missing tests and all of them pass. What is missing is the
  tripwire that would catch a regression, in a contract with no upgrade path where a
  regression can only be fixed by redeploying.
* **Violates:** n/a
* **Location:** `src/test/auth.rs:25-237`, `src/test/mod.rs:107-139`,
  `src/test/amounts.rs:85-137`.
* **Detected by:** parsing the suite for `mock_all_auths` versus `env.auths()`, then writing
  the missing tests.
* **Status:** Confirmed (as gaps; the underlying behaviour is correct).

**Description.** The headline number looks alarming and is not: 39 of 52 tests call
`mock_all_auths` and only 3 assert on `env.auths()`, so 36 sit in exactly the category the
soroban-sdk docs warn about. Section 1, lead 2 explains why that is fine here, and the
ten-for-ten mutation result is the evidence. `src/test/mod.rs:1-9` shows the authors already
understood the hazard and designed the harness around it. This finding is only about what is
left over.

**Gap 1. `set_allowed` is the one owner function missing from the wrong-signer loop.**
`the_operator_cannot_call_any_owner_function` (`auth.rs:93-128`) iterates six of the seven
owner functions: `set_frozen`, `set_policy`, `set_operator`, `set_session_key_expiry`,
`withdraw`, `owner_pay`. `set_allowed` is absent. It is covered by
`every_owner_setter_without_auth_fails` (the no-auth case) but never by the
authorized-as-the-wrong-address case.

**Gap 2. No third-party case.** Every negative test uses the owner or the operator as the
wrong signer. There is no test where a party with no role at all presents a valid
authorization for an owner function.

**Gap 3. Argument rebinding is pinned only positively, and only for `pay`.**
`pay_requires_exactly_the_operator_and_nothing_else` asserts the recorded tree's arguments,
which is good. There is no negative: an authorization scoped to `(payeeA, X)` being presented
against a call to `(payeeB, Y)`. That negative is what actually proves the binding is
enforced rather than merely recorded.

**Gap 4. `env.auths()` pinning is thin on the owner side.**
`owner_pay_is_authorized_by_the_owner_not_the_operator` asserts `auths.len() == 1` and the
address, but not the function name or the arguments. No owner setter has any tree assertion.

**Gap 5. No test ever uses a classic account address.** In soroban-sdk 27.0.6,
`Address::generate` returns a **contract** address (`src/address.rs:434-440`:
`ScAddress::Contract(ContractId(Hash(...)))`). Both live deployments use G-addresses. So the
entire suite exercises the C-address authorization path, and the classic-account
medium-threshold path that production actually runs on is never exercised, nor is any
`__check_auth`. The SDK's position is that a contract need not distinguish them, and that is
right for this contract's logic, so this is a coverage note rather than a defect. It is also
the reason A1-03 has no unit-test proof.

**Gap 6. The three constructor tests use bare `#[should_panic]`.**
`the_constructor_refuses_an_owner_that_is_also_the_operator` and the two negative-amount
constructor tests (`amounts.rs:85-137`) assert only that *something* panicked, with no
`expected =`. They would pass if the constructor panicked for an unrelated reason.

**Gap 7. The negative-control runner tests deletion only.** All six controls remove a guard.
None points a guard at the wrong address, which is the other principal way an authorization
check fails. My M3 and M4 fill that in, and both were caught, so this is a gap in the runner
rather than in the suite.

**Proof of Concept.** The missing tests, all passing on current code:

```
test test::a1_poc::coverage_the_operator_cannot_call_set_allowed ... ok
test test::a1_poc::coverage_a_stranger_cannot_call_any_owner_function ... ok
test test::a1_poc::coverage_operator_auth_for_one_payee_cannot_be_reused_for_another ... ok
test test::a1_poc::coverage_all_thirteen_views_need_no_auth_and_mutate_no_policy_state ... ok
```

Gap 5, from the SDK source:

```rust
// soroban-sdk-27.0.6/src/address.rs:434-440
fn generate(env: &Env) -> Self {
    Self::try_from_val(
        env,
        &ScAddress::Contract(ContractId(Hash(env.with_generator(|mut g| g.address())))),
    )
    .unwrap()
}
```

**Recommended fix.**

1. Add `("set_allowed", (s.payee.clone(), true).into_val(&s.env))` to the loop at
   `auth.rs:98-105` and the matching arm at `auth.rs:117-124`. One line each.
2. Add the stranger loop, the argument-rebinding negative, and the view-purity sweep. All
   four are written and passing in `audit/tool-output/A1-probe-tests.rs`; they can be lifted into
   `src/test/auth.rs` as they stand.
3. Extend `owner_pay_is_authorized_by_the_owner_not_the_operator` to pin the function name
   and arguments the way the `pay` test already does.
4. Give the three constructor tests an expectation, e.g.
   `#[should_panic(expected = "Error(Contract, #10)")]`, so they cannot pass on the wrong
   panic. Verify the exact rendering once and pin it.
5. Add M3 and M4 to `soroban/audit/run-negative-controls.mjs` as two more controls. They cost
   one `cargo test` each and they cover the half of the auth failure space the runner
   currently misses:

```js
  {
    name: 'pay-authorizes-the-right-address',
    file: 'lib.rs',
    find: '        let operator = store::get_operator(&env);\n        operator.require_auth();\n',
    replace: '        let operator = store::get_owner(&env);\n        operator.require_auth();\n',
    breaks:
      'pay demands the OWNER signature instead of the operator. The guard is still present, so a deletion-only control set does not notice. The agent stops working and the owner gains a second, unbounded-by-ceiling spend path.',
    caughtBy: 'test::auth::pay_requires_exactly_the_operator_and_nothing_else, and three others',
  },
  {
    name: 'require-owner-authorizes-the-right-address',
    file: 'lib.rs',
    find: '        let owner = store::get_owner(env);\n        owner.require_auth();\n',
    replace: '        let owner = store::get_operator(env);\n        owner.require_auth();\n',
    breaks:
      'Every owner function accepts the OPERATOR signature. A compromised agent key can then lift the policy that bounds it and withdraw the balance, which is the exact outcome the two-role split exists to prevent.',
    caughtBy: 'test::auth::the_operator_cannot_call_any_owner_function, and three others',
  },
```
6. Optional, and the most valuable of the set if the product ever names a C-address owner or
   operator: keep `poc_a_contract_operator_lets_anyone_spend_with_no_signature_at_all` and its
   owner twin in the suite as **documentation tests**, renamed to say what they pin, so that
   the invoker rule's consequence is a fact the suite states out loud rather than a fact
   somebody has to rediscover.

**References.**
- soroban-sdk 27.0.6, `src/env.rs:1387-1397` (`mock_auths`), `1470-1472` (`mock_all_auths`),
  `1334-1338` (`set_auths`), `1614-1629` (`auths`), `src/address.rs:434-440`.
- R1 V-1, V-2, V-4; threat model section 8.

---

## 3. Unconfirmed

Three things I could not prove, recorded so nobody mistakes them for cleared.

**U-1. The classic-account shared-signer collapse of INV-03 (A1-03) has no unit-test proof.**
soroban-sdk 27.0.6's testutils expose no way to give an address a custom signer set or
threshold: `Address::generate` yields a contract address, and `StellarAssetIssuer`
(`src/testutils.rs:626-690`) exposes account flags only, not signers. A test would need to
edit the `LedgerEntryData::Account` entry directly, which the SDK does not surface. The
finding therefore rests on soroban-env-host 27.0.1 `src/auth.rs:106-109` as a statement of
protocol semantics, which I read in the host source that ships with the pinned SDK, and not
on a demonstration. I am confident in the mechanism and I did not demonstrate it.

**U-2. I did not verify the ABI of the *deployed* wasm.** My export table comes from a local
build of the same source. My build hashes to `0061cc9f...` at 28,728 bytes; the release
receipt records `155eb31c...` at 11,625 bytes, which is the expected difference between a
plain `cargo build --release --target wasm32v1-none` and a `stellar contract build`.
Confirming that the bytes on pubnet export exactly those 22 functions and no others needs
`stellar contract fetch`, a network read I did not perform. This is A8's ground; I flag it
because "no hidden entrypoint" is an authorization claim and I proved it about the source and
a local build, not about the deployed object.

**U-3. CAP-0071 read at one remove in part.** I verified `delegate_account_auth`'s
`__check_auth`-only gating and its account/contract dispatch directly in
soroban-env-host 27.0.1 (`src/host.rs:3645-3663`, `src/auth.rs:1026-1075`). I did not read
the CAP text itself; the summary and the "does not change what `require_auth` guarantees"
quotation come from R1 P-1. The conclusion (not applicable to the live G-address
deployments) rests on the host source and the deploy receipts, both of which I read
directly.

---

## 4. Things checked and found clean

Recorded so the next reader knows they were looked at, not skipped.

| Check | Result |
| --- | --- |
| Missing `require_auth` on any mutating entrypoint | None. 8 of 8 guarded, each as the first statement. |
| `require_auth` on the wrong address | None. Mutations M3 and M4 both caught. |
| `require_auth` vs `require_auth_for_args` mismatch | Not applicable. `require_auth_for_args` is never used, so every authorization is bound to the invocation's own full argument list. |
| Authorization checked after state mutation | None. Every guard precedes every write, including `bump_instance`. |
| Unprotected initializer / re-initialization | Structurally absent. No `initialize`; `__constructor` runs once, atomically, and is not re-callable. |
| Role check reading attacker-controllable storage | None. `Owner` is written only by the constructor; `Operator` only by the constructor and the owner-gated `set_operator`. |
| Privileged function reachable via cross-contract call | Reachable, correctly gated. The only case where the gate is satisfied without a key is a contract-address role holder, which is A1-02. |
| Auth-relevant fail-open on a missing storage read | None. The four auth- and identity-critical reads (`get_owner`, `get_operator`, `get_token`, `get_decimals`) use `unwrap()` and fail closed; only the policy values use permissive `unwrap_or` defaults. The asymmetry is correct. |
| Reentrancy reusing a live auth context | Impossible. `ContractReentryMode::Prohibited` is the host default (`soroban-env-host-27.0.1/src/host/frame.rs:110,119`; `src/host.rs:2596-2635`). |
| Contract lending its own authority to a sub-call | Never. `authorize_as_curr_contract` does not appear in the crate. |
| Nested auth / phishing under the operator's signature (R2 class 9) | Clean. `pay`'s authorization has an empty `sub_invocations` list, pinned by `test::auth::the_operator_never_authorizes_the_token_transfer`. Nothing can ride along under it. |
| Views mutating policy state or moving value (INV-04) | Holds for all 13. Only `is_allowed` writes, and only a TTL (A1-05). |
| Hidden or extra wasm exports | None. 22 contract exports, matching the 22 `pub fn` in the source exactly. |
| Upgrade entrypoint | Absent, by design. |
