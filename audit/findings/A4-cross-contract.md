# A4 - Cross-contract calls and token integration

Phase 3 deliverable. Domain: every cross-contract call in
`soroban/contracts/agent-spend-policy/src/lib.rs`, the SEP-41 assumptions behind them, and
the invariants INV-08, INV-10, INV-12 and INV-15, plus the structural properties P-5 and
P-6.

There is exactly one external dependency: the address stored under `DataKey::Token` at
construction. It is called three ways, at four sites:

| Site | Call | Guarded by |
| --- | --- | --- |
| `lib.rs:92` (`__constructor`) | `decimals()` | nothing; the call itself is the probe |
| `lib.rs:145` (`withdraw`) | `balance(here)` | `require_owner` |
| `lib.rs:148` (`withdraw`) | `transfer(here, to, amount)` | `require_owner`, `check_amount`, `require_valid_payee`, balance |
| `lib.rs:266` (`balance` view) | `balance(here)` | nothing; unauthenticated view |
| `lib.rs:305` (`settle`) | `balance(here)` | the caller's `require_auth` |
| `lib.rs:315` (`settle`) | `transfer(here, to, amount)` | the full policy ladder |

Everything below is backed by a test I wrote and ran, or by exact tool output. Work was
done in a scratch copy (`rsync -a soroban/ /tmp/a4-scratch/`); nothing under `soroban/`,
`mcp/` or `src/` was modified. Two read-only HTTP GET/POST queries were made against
Horizon and the pubnet RPC. **No transaction was submitted to any network.**

Artifacts:

* `audit/tool-output/A4-hostile-token-tests.rs` - the 23 tests, verbatim. Drop into
  `src/test/`, add `mod a4_cross_contract;` to `src/test/mod.rs`, `cargo test`.
* `audit/tool-output/A4-test-results.txt` - the run (23 passed, and 75/75 with the
  existing suite).
* `audit/tool-output/A4-diagnostics.txt` - raw host errors, the Horizon issuer read, the
  decoded pubnet balance entry, and the host source lines quoted below.

---

## 0. Summary

| # | Severity | Title | Status |
| --- | --- | --- | --- |
| A4-01 | **Medium** | The token's error codes collide with this contract's, and a full payee trustline is reported to the caller as `OwnerIsOperator` | Confirmed, PoC |
| A4-02 | **Medium** | Circle can freeze this vault permanently: `AUTH_REVOCABLE` is set, and a deauthorized balance blocks `withdraw` while `balance()` still reports the funds | Confirmed, PoC |
| A4-03 | Low | Settlement is never verified: `transfer` is called and the result is assumed, so a fee-on-transfer, rebasing or no-op token makes `Paid`, `spent_today` and the real outflow three different numbers | Confirmed, PoC (deployment risk) |
| A4-04 | Low | Three payee-side failures produce untyped aborts rather than typed refusals, and a muxed destination is unpayable | Confirmed, PoC |
| A4-05 | Informational | The constructor's `decimals()` read is a liveness probe, not a safety property, and `Decimals` is inert in every gate | Confirmed (P-4, P-6) |

Nothing Critical or High. Nothing in this domain lets an unauthorized party move money.

### The lead question, answered plainly

**There is no MuxedAddress allowlist bypass. Not a partial one, not a latent one.** The
mux type space cannot reach `pay` at all, and it is closed at two independent layers:

1. `pay` declares `to: Address`. `impl TryFromVal<Env, Val> for Address`
   (`soroban-sdk-27.0.6/src/address.rs:110-118`) goes through
   `AddressObject::try_from_val`, which is tag-checked. A `MuxedAddressObject` has a
   different tag, so the argument never deserializes.
2. Below that, `soroban-env-host-27.0.1/src/host_object.rs:221-231` will only inject
   `ScAddress::Account` or `ScAddress::Contract` into an `AddressObject`. `MuxedAccount`,
   `ClaimableBalance` and `LiquidityPool` are all rejected with `Object/InvalidInput`.

Observed: passing a muxed `to` to `pay` returns `Err(Err(Abort))` with the diagnostic
`caught panic 'called Result::unwrap() on an Err value: ConversionError' from contract
function 'Symbol(pay)'`. Nothing moves, no gate is reached, no allowlist decision is made.
And the conversion the contract *does* perform, `&Address -> MuxedAddress` at the
`transfer` call site, is the identity on the address part with `id() == None`
(`muxed_address.rs:178-185`), so the address the allowlist checked is exactly the address
the token credits.

`require_valid_payee` cannot be evaded either, and for a second reason on top of the
above: the two addresses it protects are the vault and the token, both **contract**
addresses, and `MuxedAddress::new` panics with `"contract addresses can not be
multiplexed"` (`muxed_address.rs:403`). Only classic accounts can be multiplexed at all.

The residue is not a bypass, it is a limitation and a wrong error shape: see A4-04.

---

## A4-01 - The token's error codes collide with this contract's, and the caller cannot tell them apart

**Severity:** Medium
**Impact:** High (the typed refusal is the product, and it lies)
**Likelihood:** Medium (a payee with a capped USDC trustline is ordinary)
**Violates:** INV-17 (a caller must be able to branch on the reason), INV-22 (a given
numeric code always means the same condition)
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:315` (`settle`),
`lib.rs:148` (`withdraw`); the error table is
`soroban/contracts/agent-spend-policy/src/error.rs:36-64`
**Category:** Ignored or misinterpreted return values / error-namespace collision
**Detected by:** manual review of the host's builtin `ContractError` table, then a PoC
against the real Stellar Asset Contract
**Status:** Confirmed with a passing PoC

### Description

`settle` and `withdraw` call `token::Client::transfer`, not `try_transfer`. When the token
raises a contract error, the SDK client escalates it and this contract's frame aborts. The
error does **not** get relabelled on the way out: it reaches this contract's caller as
`Error(Contract, #N)` attributed to the invocation, and the generated
`AgentSpendPolicyClient::try_pay` decodes `N` against **this contract's** error enum.

The builtin Stellar Asset Contract's error table
(`soroban-env-host-27.0.1/src/builtin_contracts/contract_error.rs:9-30`) and this
contract's (`error.rs:36-61`) both live in `ScErrorType::Contract` and overlap
one-for-one on 2..=10:

| code | this contract says | the SAC says |
| --- | --- | --- |
| 2 | `SessionKeyExpired` | `OperationNotSupportedError` |
| 3 | `PayeeNotAllowed` | `AlreadyInitializedError` |
| 4 | `AboveAutoApprove` | `UnauthorizedError` |
| 5 | `DailyCapExceeded` | `AuthenticationError` |
| 6 | `InvalidAmount` | `AccountMissingError` |
| 7 | `InvalidPayee` | `AccountIsNotClassic` |
| 8 | `MathOverflow` | `NegativeAmountError` |
| 9 | `InsufficientBalance` | `AllowanceError` |
| 10 | `OwnerIsOperator` | `BalanceError` |

Two of these are reachable through this contract:

* **Code 10, reachable on the audited pubnet configuration.** The payee is a classic
  account whose USDC trustline limit would be exceeded by the incoming amount.
  `transfer_trustline_balance` returns `ContractError::BalanceError` "resulting balance is
  not within the allowed range"
  (`balance.rs:613-626`). The caller is told **`OwnerIsOperator`**: "owner and operator are
  the same address". That is not merely wrong, it is an answer `pay` can never legitimately
  give, and it routes the human-in-the-loop to check a key configuration instead of asking
  the payee to raise their trustline limit.
* **Code 6, reachable for a native-XLM deployment.** For the native asset there is no
  trustline, `is_account_authorized` returns true without one
  (`balance.rs:786-806`), and a payee account that does not exist hits `read_account_entry`
  -> `AccountMissingError = 6` (`balance.rs:550-563`). The caller is told `InvalidAmount`.
  The amount was fine; the payee did not exist.

Codes above 10 do not collide and arrive as an undecodable `InvokeError::Contract(N)`,
which is ugly but honest: `TrustlineMissingError = 13` and `BalanceDeauthorizedError = 11`
both behave that way today. That is luck, not design. The two tables were never
coordinated, and `error.rs`'s own header calls the discriminants "frozen public ABI"
without noticing that it shares the namespace with the token it calls.

No money is lost. The whole invocation rolls back, `spent_today` is unchanged. This is a
truthfulness defect, and the threat model is explicit that truthfulness is a security
property here, not a UX one (section 4, item 4).

### Proof of Concept

`a_full_payee_trustline_is_reported_to_the_caller_as_owner_is_operator`, run against the
**real** builtin SAC (`env.register_stellar_asset_contract_v2`), not a mock:

```rust
let payee = make_classic_payee_with_trustline(&env, "GBZDSBUY...JKMO", sac.asset(), 95, 100);
let res = c.try_pay(&payee, &100);   // limit 100, already holding 95
assert_eq!(res, Err(Ok(Error::OwnerIsOperator)));
assert_eq!(c.spent_today(), 0);
c.pay(&payee, &5);                   // inside the limit, so the setup is real
```

Observed output before the assertion was tightened:

```
FULL TRUSTLINE RESULT: Err(Ok(OwnerIsOperator))
```

Companions in the same file: `a_missing_payee_trustline_escapes_as_a_raw_token_error_code`
(code 13, undecodable) and `a_token_error_code_is_indistinguishable_from_a_policy_error_code`
(code 11, undecodable).

### Recommended Fix (diff sketch)

The clean fix is to stop sharing the namespace. Renumber this contract's codes out of the
builtin range - but `error.rs` correctly says the discriminants are frozen ABI, and there
is no upgrade path (P-1), so renumbering means a redeploy. For a **redeploy only**:

```diff
 pub enum Error {
-    Frozen = 1,
+    // Start at 1000. The builtin Stellar Asset Contract uses 1..=15 in the SAME
+    // ScErrorType::Contract namespace, so any code in that range is ambiguous
+    // between "this policy refused" and "the token refused".
+    Frozen = 1000,
...
-    OwnerIsOperator = 10,
+    OwnerIsOperator = 1009,
+    /// The token refused the transfer. `token_code` is the token's own code.
+    TokenRefused = 1010,
 }
```

For the **live contract**, which cannot be renumbered, catch and relabel instead - this is
a source change for the next deploy, and simultaneously a documentation duty for the
current one:

```diff
-        token::Client::new(env, &tok).transfer(&here, to, &amount);
+        // Do not let the token's error code escape wearing this contract's error table.
+        if token::Client::new(env, &tok)
+            .try_transfer(&here, to, &amount)
+            .is_err()
+        {
+            return Err(Error::TokenRefused);
+        }
```

Note that `try_transfer` only catches errors the token *returns*; a host-level trap still
aborts. That is fine: a host trap is not decodable as a contract error and cannot be
confused with one.

Until a redeploy happens, the mitigations are documentation-only and belong in
`mcp/` and the console: **any client decoding this contract's error codes must treat
`Err(Ok(_))` from `pay`, `owner_pay` or `withdraw` as ambiguous, and cross-check that the
reported reason is consistent with the policy state it can read** (for example, a `pay`
that reports `OwnerIsOperator` is definitionally a token error, because `set_operator`
already made that state unreachable).

### References

* `soroban-env-host-27.0.1/src/builtin_contracts/contract_error.rs:9-30`
* `soroban-env-host-27.0.1/src/builtin_contracts/stellar_asset_contract/balance.rs:604-626`
  (BalanceError on a full trustline), `:550-563` (AccountMissingError), `:786-806`
  (native has no trustline check)
* `soroban/contracts/agent-spend-policy/src/error.rs:1-30` (the frozen-ABI header)
* R2 bug taxonomy class 17, "Overloaded or misleading errors treated as a security defect"

---

## A4-02 - Circle can freeze this vault permanently, and `balance()` will keep reporting the funds

**Severity:** Medium
**Impact:** High (every outflow path including `withdraw` stops; INV-20 fails)
**Likelihood:** Low (requires Circle to act against this specific address)
**Violates:** INV-20 (`withdraw` remains reachable while the vault holds a balance),
INV-17 (the refusal is untyped)
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:137-151` (`withdraw`),
`lib.rs:265-267` (`balance` view), `lib.rs:290-324` (`settle`)
**Category:** Ignoring authorization-required / authorization-revocable flags on a
SAC-backed asset
**Detected by:** live Horizon read of the issuer flags, live RPC read of the vault's own
balance entry, then a PoC against the real SAC with the issuer flag set
**Status:** Confirmed, and it applies to the live pubnet deployment

### Description

Verified live on 2026-08-24, not recalled:

```
GET https://horizon.stellar.org/accounts/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
home_domain: circle.com
flags: {"auth_required": false, "auth_revocable": true,
        "auth_immutable": false, "auth_clawback_enabled": false}
```

That is the issuer named in `soroban/releases/pubnet-v0.1.0.json`. Taking the four flags in
turn, against what the host actually does:

* **`auth_required` false.** Good news: a contract address does not need explicit
  authorization before receiving. The vault could be funded without Circle's involvement,
  and a future vault can be too.
* **`auth_clawback_enabled` false.** Good news, and stronger than it looks. The
  clawback bit is stamped **per balance entry at creation** from the issuer's flag at that
  moment (`balance.rs:128-132`), and it is preserved on every later write, including by
  `set_authorized` (`balance.rs:277-289`) and by `spend_balance_no_authorization_check`
  (`balance.rs:173-200`). The entry is never deleted, even at a zero amount. So **even if
  Circle enabled clawback tomorrow, this vault's existing balance entry would keep
  `clawback: false` and could not be clawed back.** Read live from pubnet:

  ```
  POST https://mainnet.sorobanrpc.com getLedgerEntries
    contract CCW67TSZ...MI75 (USDC SAC), key ScVec[Symbol("Balance"), Address(CB5LYXFK...KWSYP)]
  decoded: {"amount": "0", "authorized": true, "clawback": false}
  ```

* **`auth_revocable` true. This is the live risk.** Circle, as the SAC admin, may call
  `set_authorized(CB5LYXFK...KWSYP, false)` at any time. `set_authorized` requires exactly
  the `AUTH_REVOCABLE` flag Circle has (`balance.rs:262-268`) and writes
  `authorized = false` onto the vault's existing entry. From that moment, `spend_balance`
  refuses with `ContractError::BalanceDeauthorizedError` (`balance.rs:220-231`), so `pay`,
  `owner_pay` **and `withdraw`** all fail. The owner has no recovery: there is no upgrade
  path (P-1), and no contract-side action can re-authorize. Only Circle can undo it.

The failure mode is made worse by an asymmetry in the SAC that this contract inherits:
`read_balance` for a contract address returns `balance.amount` with **no `authorized`
check** (`balance.rs:44-70`). So `AgentSpendPolicy::balance()` keeps reporting the full
amount, the policy ladder's `check_balance` passes on that number, and only the `transfer`
at the bottom fails. Every dashboard, the `/proof/stellar` page and the spend-preflight API
will show a funded, healthy vault that cannot move a unit.

For the audited deployment specifically, the exposure right now is bounded: the pubnet
vault's balance entry reads `amount: 0`, and the policy caps the day at 1 USDC. This is a
design finding about a live contract that will hold money again, not a live loss.

### Proof of Concept

`a_revoked_authorization_freezes_every_outflow_path_including_withdraw`, using the real
builtin SAC and setting the same flag Circle's issuer already has:

```rust
StellarAssetClient::new(&env, &token_id).mint(&contract_id, &1_000);
assert_eq!(c.balance(), 1_000);

sac.issuer().set_flag(IssuerFlags::RevocableFlag);              // Circle's is already set
StellarAssetClient::new(&env, &token_id).set_authorized(&contract_id, &false);

assert_eq!(c.balance(), 1_000);   // the view still reports funds the vault cannot move
for res in [c.try_pay(&payee, &1), c.try_owner_pay(&payee, &1), c.try_withdraw(&owner, &1)] {
    match res { Err(Err(_)) => {}, _ => panic!("must fail, and untyped") }
}

// recoverable ONLY by the issuer, never by the owner
StellarAssetClient::new(&env, &token_id).set_authorized(&contract_id, &true);
c.withdraw(&owner, &1_000);       // now it works
```

`a_token_error_code_is_indistinguishable_from_a_policy_error_code` pins the exact code:
`Err(Err(Contract(11)))`, i.e. `BalanceDeauthorizedError`, which is one past this
contract's highest code and therefore undecodable rather than misdecoded. See A4-01.

A mock-token equivalent, `a_deauthorized_balance_bricks_withdraw_with_an_untyped_error`,
covers the same shape for a non-SAC token.

### Recommended Fix (diff sketch)

Nothing in the contract can prevent an issuer from deauthorizing it. What the contract can
do is stop lying about it, and what the operators must do is treat it as a live residual.

1. Make the view honest, so monitoring can see the difference between "funded" and
   "spendable". This requires a redeploy:

```diff
     pub fn balance(env: Env) -> i128 {
         token::Client::new(&env, &store::get_token(&env)).balance(&env.current_contract_address())
     }
+
+    /// True if the token would actually let this vault spend. For a SAC-backed asset
+    /// this is the issuer's authorization flag on our balance entry, which `balance()`
+    /// deliberately ignores.
+    pub fn spendable(env: Env) -> bool {
+        let tok = store::get_token(&env);
+        token::StellarAssetClient::new(&env, &tok)
+            .try_authorized(&env.current_contract_address())
+            .unwrap_or(Ok(true))
+            .unwrap_or(true)
+    }
```

   (`authorized(id)` is part of the SAC admin interface, not of SEP-41, so the call has to
   be a `try_` that degrades to "assume spendable" for a plain SEP-41 token.)

2. Operationally, and immediately, with no code change: keep the pubnet vault's balance at
   the working minimum, which the 1 USDC/day cap already implies, and treat a
   deauthorization as an incident with exactly one remedy - contact Circle. Record that in
   `soroban/releases/pubnet-v0.1.0.json` next to the `settlementToken.verified` note, which
   currently records three checks on the token's identity and none on the issuer's powers
   over it.

3. State the clawback result there too. It is a genuinely reassuring, independently
   verifiable fact and it belongs in the provenance record: `auth_clawback_enabled` is
   false, and the vault's own balance entry is stamped `clawback: false` permanently.

### References

* Horizon, 2026-08-24: issuer `GA5ZSEJY...KZVN`, `auth_revocable: true`
* pubnet RPC `getLedgerEntries`, 2026-08-24: the vault's balance entry, decoded
* `soroban-env-host-27.0.1/src/builtin_contracts/stellar_asset_contract/balance.rs`
  `:44-70` (read_balance ignores `authorized`), `:100-135` (clawback stamped at creation),
  `:220-231` (spend_balance refuses), `:262-289` (set_authorized needs AUTH_REVOCABLE)
* https://developers.stellar.org/docs/tokens/stellar-asset-contract
* R1 T-3, R2 class 16

---

## A4-03 - Settlement is asserted, never verified: no balance delta anywhere

**Severity:** Low for the audited pubnet and testnet deployments; **Medium** for any
redeployment of this code against a token that is not a Stellar Asset Contract
**Impact:** Medium (the on-chain audit trail, the daily accumulator and the real outflow
diverge)
**Likelihood:** Low for the audited deployments (the SAC moves exactly `amount` or traps);
High for a fee-on-transfer or rebasing token
**Violates:** INV-05 (in the sense that the sum recorded is not the sum moved), INV-08 as
an assumption, P-6
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:314-322` (`settle`),
`lib.rs:145-149` (`withdraw`)
**Category:** Fee-on-transfer / rebasing tokens breaking balance accounting
**Detected by:** mock SEP-41 tokens run against the real vault
**Status:** Confirmed, PoC; a deployment risk, not a live one

### Description

`settle` writes the day total, calls `transfer`, emits `Paid { to, day, amount, by_owner }`
and returns `Ok(())`. Between the `transfer` and the `Paid` there is nothing: no re-read of
`balance()`, no delta, no comparison of what left the vault against what was recorded.
The contract's model of a payment is "I asked, therefore it happened".

Against Circle's USDC SAC that model is sound, and the code comment at `lib.rs:288-289`
gives the right reason: the SAC moves exactly `amount` or traps, and a trap rolls the whole
invocation back. But the constructor accepts any address that answers `decimals()`
(A4-05), so the model is an assumption about the deployment, not a property of the
contract. Three misbehaviours break it, each in a different place:

* **Fee on transfer.** The vault debits `amount`, the day is charged `amount`, `Paid`
  reports `amount`, and the payee receives less. The vault's own balance accounting stays
  self-consistent because `balance()` is re-read on every call, so no gate breaks; what
  breaks is the audit trail, which the storage docs
  (`storage.rs:30-33`) explicitly designate as the record of truth: "The audit trail does
  not live in this storage. It lives in the `Paid` event."
* **Silent no-op.** The sharpest case. A token whose `transfer` returns without moving
  anything makes `pay` succeed, emit `Paid`, and consume the daily cap while the vault
  still holds every unit. That is a free, repeatable denial of the agent's whole budget
  by the token, with an on-chain record saying the money was paid.
* **Rebasing.** The day counter and the balance end up in different units. The balance
  gate is not fooled, because it re-reads, but `spent_today` compared against `daily_cap`
  silently changes meaning mid-day.

The good news, which is worth pinning because it is easy to assume the opposite: the
generated SEP-41 client **does** type-check the return value. A token whose `transfer`
returns a `bool` instead of nothing produces a `ConversionError` and aborts the whole
invocation (`Error(WasmVm, InvalidAction)`), so the vault does not proceed on a token that
reports failure. It just cannot name the failure.

`withdraw` has the same shape at `lib.rs:145-148`: read `balance`, compare, `transfer`,
emit `Withdrawn { to, amount }`, no verification.

### Proof of Concept

Three tests, all against the real vault with a mock SEP-41 token
(`a4_cross_contract.rs`, `HostileToken`):

```rust
// fee_on_transfer_makes_the_paid_record_overstate_what_the_payee_got
r.client().pay(&r.payee, &1_000);
assert_eq!(r.client().spent_today(), 1_000);   // the day is charged in full
assert_eq!(r.token().balance(&r.payee), 900);  // the payee receives less
assert_eq!(r.client().balance(), 9_000);       // the vault is debited in full

// a_silently_noop_transfer_still_emits_paid_and_burns_the_daily_cap
r.client().pay(&r.payee, &1_000);              // daily_cap is 1_000
assert_eq!(r.token().balance(&r.payee), 0);    // nothing moved
assert_eq!(r.client().balance(), 10_000);      // the vault still holds everything
assert_eq!(r.client().spent_today(), 1_000);   // yet the whole cap is consumed
assert_eq!(r.client().try_pay(&r.payee, &1), Err(Ok(Error::DailyCapExceeded)));

// a_rebasing_token_desynchronises_the_day_counter_from_the_balance
```

and the positive result:

```rust
// the_vault_ignores_a_transfer_return_value_that_says_it_failed - it does NOT ignore it
let res = c.try_pay(&payee, &1_000);   // token's transfer returns `false`
match res { Err(Err(_)) => {}, other => panic!("{other:?}") }
assert_eq!(c.spent_today(), 0);        // and the day counter rolled back
```

### Recommended Fix (diff sketch)

Charge the day for what actually left the vault, not for what was asked. This is a
redeploy-only change:

```diff
     fn settle(env: &Env, to: &Address, amount: i128, by_owner: bool) -> Result<(), Error> {
         Self::require_valid_payee(env, to)?;
...
         store::set_spent_on_day(env, day, next);
-        token::Client::new(env, &tok).transfer(&here, to, &amount);
+        let before = snapshot.vault_balance;
+        token::Client::new(env, &tok).transfer(&here, to, &amount);
+        // The token is an external contract. Believe the ledger, not the call.
+        let moved = before
+            .checked_sub(token::Client::new(env, &tok).balance(&here))
+            .ok_or(Error::MathOverflow)?;
+        if moved != amount {
+            return Err(Error::TokenRefused);   // new code; see A4-01
+        }
         Paid { to: to.clone(), day, amount, by_owner }.publish(env);
```

Two notes on this sketch, because a naive version is worse than none:

* `moved != amount` is the right comparison for this contract, and `moved < amount` is
  not. A vault that silently tolerates a fee is a vault whose `daily_cap` no longer means
  what the owner set. Refusing is the honest behaviour, and it costs nothing against a SAC,
  where `moved == amount` always.
* It adds one `balance()` cross-contract call per payment. That is a real cost the current
  design deliberately avoids (see the `decimals` comment at `lib.rs:71-73`). The trade is
  worth taking on a custody contract; state it rather than hide it.

If the change is judged too expensive, the alternative is to constrain the token instead of
verifying it, which is cheaper and covers the audited case exactly - see A4-05.

### References

* `soroban/contracts/agent-spend-policy/src/storage.rs:30-33` (the `Paid` event is the
  audit trail)
* R1 T-1; R2 class 16
* https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md

---

## A4-04 - Three payee-side failures produce untyped aborts, and a muxed destination is simply unpayable

**Severity:** Low
**Impact:** Low (no value at risk; the caller loses the branchable reason)
**Likelihood:** High (a payee with no USDC trustline is the single most common Stellar
payment mistake, and this project has already hit it once)
**Violates:** INV-17, at its edges
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:112` (`pay` signature),
`lib.rs:279-284` (`require_valid_payee`), `lib.rs:315` (`settle`'s transfer)
**Category:** Address type confusion between accounts and contracts / calling contract
addresses supplied by untrusted callers
**Detected by:** targeted tests plus SDK and host source
**Status:** Confirmed, PoC

### Description

The contract's stated product is the typed refusal: "the returned error is the product: it
says exactly why the human-in-the-loop path should take over, in a form the caller can
match on rather than parse" (`lib.rs:110-111`). Three payee-shaped failures fall outside
that promise, and none of them is in the ten-code table:

1. **A muxed (`M...`) destination cannot be paid at all.** `pay(to: Address)` cannot hold
   a muxed address (see section 0), so the call fails at argument deserialization with
   `Err(Err(Abort))` and a `ConversionError` panic. Security-wise this is a clean closure.
   Product-wise it is a permanent limitation of a payments vault: muxed addresses are how
   custodial venues address a shared account, and SEP-41 `transfer` was widened to
   `MuxedAddress` in this very SDK version precisely to support them. With no upgrade path
   (P-1), this vault will never be able to pay one.
2. **A classic payee with no trustline for the token** produces
   `TrustlineMissingError = 13` from the SAC (`balance.rs:567-581`), reaching the caller as
   an undecodable `InvokeError::Contract(13)`. The project has already met this failure -
   `soroban/releases/testnet-v0.1.0.json` records "the first faucet attempt went nowhere
   because neither classic account had a USDC trustline" - and the contract still has no
   name for it.
3. **A deauthorized payee** (the issuer revoked the *payee's* authorization, not the
   vault's) produces `BalanceDeauthorizedError = 11`, likewise undecodable.

Related and worth recording as a closed question: there is no broader address-type
confusion here. An `AddressObject` can only ever hold `ScAddress::Account` or
`ScAddress::Contract` (`host_object.rs:221-231`), so `ClaimableBalance` and `LiquidityPool`
destinations are impossible, and `require_valid_payee`'s two comparisons are exhaustive
over the addresses it needs to exclude. The contract does not, and need not, distinguish
account payees from contract payees anywhere else.

### Proof of Concept

```rust
// muxed_payee_cannot_be_passed_to_pay_at_all
let seed = MuxedAddress::generate(&env);       // only ACCOUNTS can be multiplexed
let muxed = MuxedAddress::new(seed, 42);
let args = vec![&env, muxed.to_val(), 100i128.into_val(&env)];
let res = env.try_invoke_contract::<(), Error>(&contract_id, &Symbol::new(&env,"pay"), args);
assert!(res.is_err());                          // Err(Err(Abort)), ConversionError
assert_eq!(token.balance(&account), 0);

// plain_address_through_the_same_raw_path_succeeds  <- the positive control
// muxed_variant_cannot_bypass_a_denying_allowlist   <- both directions
// muxed_variant_cannot_evade_require_valid_payee    <- InvalidPayee, by name
// a_contract_address_cannot_be_multiplexed          <- panics in the SDK
// a_missing_payee_trustline_escapes_as_a_raw_token_error_code
assert_eq!(c.try_pay(&ghost, &100), Err(Err(InvokeError::Contract(13))));
```

### Recommended Fix (diff sketch)

Redeploy-only, and item 1 is a product decision rather than a bug fix:

```diff
-    pub fn pay(env: Env, to: Address, amount: i128) -> Result<(), Error> {
+    /// `to` is a `MuxedAddress` so a custodial (`M...`) destination can be paid. The
+    /// allowlist and `require_valid_payee` operate on `to.address()`, which is total and
+    /// identity-preserving, so the multiplexing id changes who is CREDITED off-chain and
+    /// never who is ALLOWED on-chain.
+    pub fn pay(env: Env, to: MuxedAddress, amount: i128) -> Result<(), Error> {
         let operator = store::get_operator(&env);
         operator.require_auth();
         store::bump_instance(&env);
-        Self::settle(&env, &to, amount, false)
+        Self::settle(&env, &to, amount, false)   // settle keys every check on to.address()
     }
```

`MuxedAddress` is a superset at the interface level - "if a contract accepts `MuxedAddress`
as an input, then its callers may still pass `Address` into the call successfully"
(`muxed_address.rs:31-37`) - so this widening breaks no existing client. It must be done
deliberately, with the allowlist keyed on `to.address()`, because a `MuxedAddress` cannot
be a storage key by design.

For items 2 and 3, the fix is the same `try_transfer` relabelling as A4-01: whatever the
token refuses with, hand the caller one code that means "the token refused" rather than a
number from a table they do not have.

### References

* `soroban-sdk-27.0.6/src/token.rs:154` (`transfer` takes `MuxedAddress`), `:178`
  (`transfer_from` takes `Address`)
* `soroban-sdk-27.0.6/src/muxed_address.rs:24-44, 178-185, 403`
* `soroban-sdk-27.0.6/src/address.rs:110-118`
* `soroban-env-host-27.0.1/src/host_object.rs:215-245`
* `soroban/releases/testnet-v0.1.0.json` (the project's own trustline incident)

---

## A4-05 - The constructor's `decimals()` read is a liveness probe, not a safety property

**Severity:** Informational
**Impact:** n/a
**Likelihood:** n/a
**Violates:** n/a. Confirms P-4 and P-6 as stated in the threat model.
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:69-104` (`__constructor`),
`lib.rs:228-230` (the only reader of `Decimals`) (the `decimals` view), `storage.rs:122-124`
**Category:** Assuming a token is a Stellar Asset Contract when it may be a custom SEP-41
implementation
**Detected by:** grep plus a behavioural test
**Status:** Confirmed

### Description

Two claims to settle, both confirmed:

**P-4, `Decimals` is inert.** `store::get_decimals` has exactly one caller in the crate,
the `decimals()` view at `lib.rs:229`. No gate in `policy.rs` takes it; `Snapshot`
(`policy.rs:21-33`) has no decimals field. `daily_cap` and `auto_approve_max` are therefore
raw base units, and a test confirms the ceiling is compared unscaled. This is not a latent
trap in the sense of something that could silently become load-bearing - there is no setter
and no other reader, and `policy.rs` cannot reach `Env` at all by construction, so a future
edit that made decimals load-bearing would have to add a field to `Snapshot` and a line to
`settle`, both visible in review. It **is** a latent trap in a different sense, which is
A5's and A6's ground rather than mine: "1 USDC per day" and "1 unit per day" differ by
10^7 and nothing in the contract knows which the owner meant.

**P-6, the constructor constrains nothing.** `token::Client::new(&env, &token_id).decimals()`
at `lib.rs:92` is a liveness probe and only that. It proves the address is a contract that
answers a function named `decimals` returning a `u32`. It does not prove SEP-41 conformance
(nothing calls `transfer` or `balance` at construction), does not prove the token is a SAC,
does not prove the decimals value is truthful, and does not prove anything about the token's
behaviour. The doc comment at `lib.rs:71-73` says a non-SEP-41 address "fails at deploy",
which is true only of an address that fails this one probe; every hostile token in this
audit's test file passes it.

There is one cheap, high-value hardening available for a redeploy, and it is worth stating
because it turns A4-03's whole class from "a risk" into "structurally absent" for the
deployments this project actually makes: require the token to be a Stellar Asset Contract
by round-tripping its asset identity.

### Proof of Concept

```rust
// decimals_is_inert_in_every_gate - the ceiling is compared in raw units
assert_eq!(r.client().decimals(), 7);
assert_eq!(r.client().daily_cap(), 1_000);
assert_eq!(r.client().try_pay(&r.payee, &501), Err(Ok(Error::AboveAutoApprove)));

// the_constructor_rejects_an_address_with_no_decimals_function  - passes (should_panic)
// the_constructor_accepts_any_contract_that_answers_decimals    - a SILENT_NOOP token
assert_eq!(r.client().decimals(), 7);
```

and by grep, in the scratch copy:

```
$ grep -rn "get_decimals" contracts/agent-spend-policy/src/
lib.rs:229:        store::get_decimals(&env)
storage.rs:122:pub fn get_decimals(env: &Env) -> u32 {
```

### Recommended Fix (diff sketch)

Redeploy-only. Optional, and it deliberately narrows what this contract can be pointed at:

```diff
         let decimals = token::Client::new(&env, &token_id).decimals();
+        // Constrain the token to a Stellar Asset Contract. `name()` on a SAC is the
+        // canonical "CODE:ISSUER" string, and the SAC id is a deterministic function of
+        // that asset plus the network passphrase, so a token that answers `name()` with
+        // something whose derived SAC id is not `token_id` is not a SAC. This makes the
+        // fee-on-transfer, rebasing and silent-no-op classes structurally absent rather
+        // than merely improbable - at the cost of never being able to hold a custom
+        // SEP-41 token.
```

I am **not** proposing this as a diff, because the derivation needs the network passphrase
and there is no host function to derive a SAC id from an asset inside a contract. The
implementable version of the same idea is a constructor argument the deployer must supply
and the release record must carry - which is what
`soroban/releases/*.json` already does by hand. So the honest recommendation is: leave the
code, and record in `mcp/` and the release JSON that **this contract's safety against
A4-03 rests entirely on the deploy-time choice of token, and that choice is unverifiable
on chain.** The threat model already says this (P-6); the deploy receipts do not.

### References

* Threat model P-4, P-6
* R1 T-1; R2 class 10 ("One limit shared across incompatible units or decimals")

---

## Confirmations, not findings

Each of these was a live suspicion going in. Each is closed, and each has a passing test.

**P-5, both halves, confirmed.**

* *Re-entry is prohibited by the host.* Verified at source in the exact version this
  contract pins: `soroban-env-host-27.0.1/src/host/frame.rs:108-114` sets
  `reentry_mode: ContractReentryMode::Prohibited` in `default_external_call()`, and
  `:946-953` returns `ScErrorType::Context / ScErrorCode::InvalidAction` with the message
  `"Contract re-entry is not allowed"` for any re-entry in that mode. Note the check uses
  the *position of the contract id anywhere on the context stack*, not just the immediate
  caller, so a token calling back into the vault (distance 1) is refused exactly as a
  direct self-call would be. Confirmed behaviourally with a token that calls
  `vault.pay()` from inside `transfer`: `HostError: Error(Context, InvalidAction)`
  (`a_token_that_calls_back_into_pay_is_refused_by_the_host`, and the propagating variant
  in `A4-diagnostics.txt`). No code path in this contract relies on re-entering anything.
* *Write-before-call is the safe ordering, and a trapping transfer rolls back the
  accumulator.* Confirmed for INV-12 by
  `a_trapping_transfer_rolls_back_the_day_counter`: pay 100, switch the token to trap,
  pay 100 again and watch it fail, switch back, `spent_today()` is still 100. The same
  rollback is confirmed incidentally in four other tests. The checks-effects-interactions
  ordering at `lib.rs:314-315` is defence in depth here rather than the only defence, and
  it is correct.

**INV-09 holds independently of the token.** `check_amount` at `policy.rs:55-60` fires
before anything else in both ladders, so a token that treats a negative transfer as a
zero-value no-op - the exact OpenZeppelin finding in R2 class 2 - cannot decrement the
accumulator. Confirmed with such a token in
`the_vaults_own_sign_guard_holds_against_a_permissive_token`, including via `owner_pay`.
The policy does not outsource sign validation, which is precisely what the OpenZeppelin
auditors asked for.

**INV-10 holds, and `withdraw`'s share of it is not a lockup path.** `withdraw` calls
`require_valid_payee` at `lib.rs:141`, so the owner cannot withdraw to the vault or to the
token. That is intended and correct: both are value-destroying, and neither is a route out.
Every other address remains available, so the owner is never locked in. Confirmed by
`withdraw_refuses_the_vault_and_the_token_but_not_the_owner`, which also re-confirms INV-07
(`withdraw` leaves `spent_today` at 0).

**The SEP-41 client type-checks the return value.** A token whose `transfer` returns a
`bool` where SEP-41 declares nothing causes a `ConversionError` and aborts the invocation,
with the day counter rolled back. The vault does not proceed on a token that reports
failure. See A4-03's positive result.

---

## Unconfirmed

Stated as suspicions, not findings, because I could not prove them within this domain.

* **Auth-tree composability (R2 class 9).** When `pay` is invoked from inside another
  contract's authorization tree, what else can ride along on the operator's signed
  authorization, and does the key holder see the full tree before signing? The
  vault's own `from`-side is satisfied structurally by the direct-call rule, so the classic
  Soroswap shape does not apply, but "the operator key sits on a server in some
  deployments" makes this an operational surface I could not close from the contract alone.
  Belongs to A1 and A8 jointly.
* **Whether `moved != amount` would ever fire against a real SAC.** I assert it cannot,
  from `spend_balance`/`receive_balance` moving exactly `amount` or erroring. I did not
  fuzz it across every SAC path (issuer-as-payee, native asset, max-balance boundaries).
* **Whether any client in `mcp/` actually decodes this contract's error codes numerically**,
  which is what turns A4-01 from a latent defect into a realized one. `mcp/` is out of
  scope for this audit; the finding is written as if some client does, because the contract's
  own documentation instructs them to.
