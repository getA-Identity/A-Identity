# A7 - Upgradeability, initialization and deployment

Phase 3 finding set. Domain: upgrade entrypoints, storage-layout compatibility across
upgrades, timelocks and multi-party control, deployer/factory and salt behaviour,
constructor front-running, admin key custody.

Everything below was read from the source, decoded from the deployed bytes, or probed from
the live networks on **2026-08-24**. Nothing is recalled from memory. Raw output:
`audit/tool-output/A7-onchain-verification.txt`.

**Method note.** No transaction was signed or submitted on any network. The only network
operations were `stellar contract fetch`, `stellar contract invoke --send=no`,
`getLedgerEntries`, `getEvents`, `getVersionInfo` and Horizon transaction reads.

---

## 0. Headline results

| Question | Answer | Evidence |
| --- | --- | --- |
| Does an upgrade entrypoint exist? | **No**, and not merely absent from the source: the deployed wasm does not import the host function that would make one possible | section 1 |
| Does an `initialize` exist? | **No**. `__constructor` is the only initialization path | section 1 |
| Do the deployed bytes match the recorded hash? | **Yes on both networks**, and the two fetched files are byte-identical to each other | section 2 |
| Does live pubnet state match its release record? | **Yes, all twelve views**, with one 19-minute timestamp discrepancy in the record | section 2 |
| What auth does the constructor require on chain? | Only the deployer account's own signature on `create_contract_v2`. Neither the named owner nor the named operator authorized anything | section 3 |
| Can the deploy be front-run? | **No.** The contract id binds the deployer address, the salt and the network passphrase, all three | section 4 |
| Does CAP-0085 create an upgrade path for this contract? | **No.** R3's claim is confirmed independently | section 5 |

**Findings: 1 High, 1 Medium, 1 Low, 5 Informational.**

| ID | Severity | Title |
| --- | --- | --- |
| A7-01 | Medium | Redeploy, the only remediation path, silently drops the allowlist and re-opens the policy |
| A7-02 | High | The owner is permanent, singular, un-timelocked, and currently a single burner key |
| A7-03 | Low | The documented recovery runbook omits the freeze step and has never been rehearsed |
| A7-04 | Informational | No upgrade path, confirmed at the bytecode level; protocol 28 does not change it |
| A7-05 | Informational | The constructor requires no consent from the addresses it names, and its tests cannot prove otherwise |
| A7-06 | Informational | Deploy front-running is structurally impossible (verified, not assumed) |
| A7-07 | Informational | Anyone may instantiate a byte-identical clone; the wasm hash does not identify this deployment |
| A7-08 | Informational | The pubnet release record's `deployedAt` is 19 minutes later than the on-chain instantiate |

---

## 1. Confirming the absence (question 1, part one)

The source grep is the weak version of this check, so it is stated first and then replaced.

```
$ grep -rn --include="*.rs" -E "update_current_contract_wasm|update_current_contract_executable_ref|initialize|register_contract" soroban/
contracts/agent-spend-policy/src/lib.rs:43://! No `initialize`. Initialization happens in `__constructor`, ...
```

Only prose. No such function exists in the source.

The strong version reads the **deployed** bytes. `stellar contract fetch` on pubnet, then a
direct parse of the wasm export and import sections:

**22 exported contract functions.** Nine mutating (`__constructor`, `pay`, `owner_pay`,
`withdraw`, `set_policy`, `set_allowed`, `set_operator`, `set_session_key_expiry`,
`set_frozen`) and thirteen views. There is no `upgrade`, no `update_wasm`, no `initialize`,
no `migrate`, and **no `set_owner`**.

Small correction to the threat model in passing: its section 5 header says "View
entrypoints (12)" while the list under it names thirteen, and the deployed export table
confirms thirteen. Cosmetic, but the deployed count is the authority.

**22 imported host functions**, resolved against `soroban-env-common` 27.0.1 `env.json`
(the pinned env, read from the local cargo registry). This is the decisive result:

```
  l.6   ledger::update_current_contract_wasm            imported = False
  l.3   ledger::create_contract                         imported = False
  l.e   ledger::create_contract_with_constructor        imported = False
  l.5   ledger::upload_wasm                             imported = False
  a.6   address::get_address_executable                 imported = False
```

The contract cannot call `update_current_contract_wasm` because the wasm module does not
import it. On Soroban a guest may only call host functions it declares in its import
section; there is no dynamic linking, no `dlopen`, no indirect host-call table. So this is
not "the developers did not write an upgrade function", it is "the deployed module is
physically incapable of replacing its own executable". The same import analysis shows no
`create_contract` either, so **there is no factory and no deployer contract anywhere in
this system** - the entire "deployer/factory with weak salt" branch of this domain is
vacuous by construction.

Confirmed: `__constructor` is the only initialization path, it is the only writer of
`Owner`, `Operator`, `Token` and `Decimals`, and it can never run twice because
`create_contract_v2` is the only caller and a contract id can only be created once.

---

## 2. Reproducibility and record accuracy (questions 6 and 7)

### The deployed bytes

```
$ stellar contract fetch --id CB5LYXFK... --rpc-url https://mainnet.sorobanrpc.com \
    --network-passphrase "Public Global Stellar Network ; September 2015" --out-file pubnet.wasm
$ stellar contract fetch --id CAIL6ECR... --rpc-url https://soroban-testnet.stellar.org \
    --network-passphrase "Test SDF Network ; September 2015" --out-file testnet.wasm

155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239  pubnet.wasm    11625 bytes
155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239  testnet.wasm   11625 bytes
$ cmp pubnet.wasm testnet.wasm    # identical
```

Both match `wasm.sha256` and `wasm.bytes` in both release records exactly. Combined with
the lead auditor's local rebuild, the chain is complete: source -> local build -> uploaded
code entry -> live on both networks, one hash throughout.

The deployed metadata is self-describing and agrees with the records:

```
rsver    1.96.0                                          (releases: rustc 1.96.0)
rssdkver 27.0.6#60926a20d1f9f0a669d5fe551636f42a1302f0c0 (releases: sorobanSdk =27.0.6)
cliver   27.1.0#8e402ea28202950b272fbabc34caad4d2f64fe87 (releases: stellarCli 27.1.0)
env-meta Protocol v27                                    (releases: protocolVersion 27)
```

### Live state versus the record, pubnet

All twelve views read with `--send=no`. Every field the record asserts, matches:

| View | Live | Release record | |
| --- | --- | --- | --- |
| `owner` | GARC7OFB...WQJ5R6I5 | `constructor.owner` same | ok |
| `operator` | GDLAJM25...M3QZONO4S | `constructor.operator` same | ok |
| `token` | CCW67TSZ...LEO7SJMI75 | `constructor.token` and `settlementToken.sac` same | ok |
| `decimals` | 7 | `constructor.note` "It read 7" | ok |
| `daily_cap` | 10000000 | `constructor.dailyCap` and `finalState.dailyCap` | ok |
| `auto_approve_max` | 2500000 | `constructor.autoApproveMax` and `finalState.autoApproveMax` | ok |
| `frozen` | false | `finalState.frozen` false | ok |
| `spent_today` | 10000000 | `finalState.spentToday` 10000000 | ok |
| `balance` | 0 | `finalState.balance` 0 | ok |
| `allowlist_enabled` | false | constructor default, never changed | ok |
| `session_key_expiry` | 0 | constructor default, never changed | ok |
| `today` | 20689 | the `Paid` event day in the record | ok |

`spent_today` still reads 10000000 because the probe ran inside the same UTC day 20689 as
the deploy, so the temporary day bucket has not yet rolled. That also means this run is
**not** evidence for or against INV-18; the day boundary has not been crossed.

### Live state versus the record, testnet

The five constructor arguments all match. `allowlist_enabled` now reads **true** and the
balance is 13.988 USDC rather than the 14 implied by the record's two artifacts. Neither is
a discrepancy: the testnet record carries no `finalState` block and explicitly self-labels
as superseded ("Superseded on 2026-08-15, when the Soroban x402 rail went end to end on
this contract"). The divergence is later legitimate `set_policy` and settlement traffic.
It is called out here only because it is the concrete instance of the migration hazard in
A7-01: **the live testnet vault's real policy is strictly stronger than what its own
constructor arguments would rebuild.**

---

## 3. What the constructor actually requires on chain (question 2)

The pubnet instantiate transaction, decoded from its envelope:

```
tx 847dc7e99e73f6c0062e5aed29599f41226998053fe7b6c35e48e9cf64a6ee2d, ledger 64103418
operation: invoke_host_function / create_contract_v2
  executable.wasm  155eb31c...79239
  constructor_args [ GARC7OFB..(owner), GDLAJM25..(operator), CCW67TSZ..(token),
                     i128 10000000, i128 2500000 ]
  auth: EXACTLY ONE entry
    credentials     = source_account
    root_invocation = create_contract_v2_host_fn, carrying those same five args
    sub_invocations = []
  signatures: 1
```

`sub_invocations` is **empty**. That is the whole answer. When a constructor body calls
`require_auth`, the host records or enforces a sub-invocation under the create entry. There
is none here, because `__constructor` contains no `require_auth` call at all. The testnet
deploy has the identical shape.

So the on-chain authorization requirement for this constructor is exactly one thing: the
transaction source account, which is also the deployer named in the contract id preimage,
signed the `create_contract_v2` operation. Neither `owner` nor `operator` had to consent to
being named. `GDLAJM25...` (the pubnet operator) never signed anything at deploy time.

**Whether the constructor tests are evidence about production.** The three constructor
tests live in `contracts/agent-spend-policy/src/test/amounts.rs` and use native
registration with no auth mocking:

```rust
#[test] #[should_panic]
fn the_constructor_refuses_a_negative_daily_cap() {
    let env = Env::default();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    env.register(crate::AgentSpendPolicy, (Address::generate(&env), Address::generate(&env),
                                           sac.address(), -1i128, 0i128));
}
```
plus the negative-ceiling and owner-is-operator twins.

Split the question in two, because the answer differs.

- **Argument validation: yes, this is evidence.** `owner == operator`, `daily_cap < 0` and
  `auto_approve_max < 0` are checked before any authorization is consulted, on values that
  arrive in the signed envelope. The check is auth-independent, so recording versus
  enforcing auth cannot change its outcome. The panics these tests observe are the same
  panics the network would produce.
- **Authorization: no, and it never could be.** R3 established that soroban-sdk 27.0.2
  switched `register_at` and native constructors to **recording** auth (#1933, #1943), and
  the pubnet deploy used 27.0.6, which is above that line. Under recording auth a
  `require_auth` inside a constructor is satisfied by being recorded rather than by being
  checked, so a constructor test using `env.register` cannot distinguish "the constructor
  demands the owner's signature" from "the constructor demands nothing". These tests do not
  claim to test authorization, so this is not a defect in them; it is a limit on what the
  suite can ever prove about this entrypoint, and the reason the decoded deploy transaction
  above is the only real evidence.

**And it is unfixable.** There is no upgrade and no re-init, so the five constructor
arguments on the pubnet contract are permanent for the life of that contract id. Any defect
in constructor logic on a live vault is remediated only by A7-03's sequence. This is why the
constructor deserves more scrutiny per line than any other function in the contract.

---

## 4. Front-running the deploy (question 3)

Assessed and **negative**. Recorded here because "checked and clean" is a result.

The contract id is not chosen, it is derived. Recomputed from first principles against the
signed preimage in the deploy transaction:

```
id = strkey_C( sha256( u32(ENVELOPE_TYPE_CONTRACT_ID=8)
                    || sha256(network passphrase)
                    || u32(CONTRACT_ID_PREIMAGE_FROM_ADDRESS=0)
                    || SCAddress(deployer account)
                    || salt ) )

deployer GARC7OFBBQCZJ5N3LCI7HTTYJ2MMPDAFDNGIHSQMZ7EPJ5EAWQJ5R6I5
salt     4adffd6ec91f8609539d04fa0b97d30254d74ad4987d127af0900634ca83eede
derived  CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP   == the deployed id
```

Three counterfactuals, same code path:

```
same salt, attacker's key     -> CBRJSH5VVTPENQRE3SKFPR64OSMARV5EMPVTAH3OOQRDA7OV74TTLVGO
same deployer+salt, testnet   -> CATSYLYNJWCJLEQUBXOXLGZUMQHTUONN5VOCKESP5XJPQTLXD7QMOQHO
same deployer, salt+1         -> CB6CZKHP56TNPM6QHDNH3TO7PG54CL6MVAHPABVC65CVCFCOAKDBPUP5
```

The deployer's account key is inside the hash preimage. An observer who watches the mempool,
learns the salt, and races the transaction cannot produce the same id, because they cannot
produce a `create_contract_v2` whose preimage names an account they do not control. The
address-squatting class that exists on EVM `CREATE2` does not exist here.

Three further doors, all closed:

- **Argument tampering.** The `constructor_args` appear inside `root_invocation` of the
  signed auth entry, not only in the operation body. Altering a single argument invalidates
  the signature.
- **A gap between deploy and init.** There is none. `create_contract_v2` creates the
  instance and runs `__constructor` in one host function inside one operation. The
  front-run-the-initializer class the source comment claims is structurally absent, is in
  fact structurally absent.
- **Salt weakness.** `stellar contract deploy --salt <SALT>` is optional and was not used;
  the CLI generated the salt. Both observed salts are 32 bytes of high entropy and differ
  between the two deploys. This does not matter much either way: because the deployer
  address is in the preimage, a predictable salt would only make the id predictable, and a
  reused (deployer, salt) pair would make the deploy **fail** rather than be hijackable.
  Salt entropy is not load-bearing on Soroban the way it is on EVM.

The only real residual is a denial-of-service on the deployer's own transaction, which is
just "someone else got a ledger slot" and costs nothing.

---

## 5. CAP-0085 verified independently (question 5)

R3 claims protocol 28's CAP-0085 does not create an upgrade path for an already-deployed
immutable contract. Verified from the CAP text itself
(`https://raw.githubusercontent.com/stellar/stellar-protocol/master/core/cap-0085.md`,
Status: Implemented, Protocol version: 28), not from R3's summary of it.

Two adoption mechanisms exist, and neither reaches an existing contract:

1. **`update_current_contract_executable_ref`**, a host function. CAP-0085 line 238: "the
   current contract's executable is replaced with the executable reference. Similarly to
   `update_current_contract_wasm` host function, the update is applied only after the
   current contract function returns successfully." Like `update_current_contract_wasm`, it
   is a call the contract makes on **itself**, from inside its own wasm. Our deployed wasm
   imports neither, and cannot grow an import.
2. **`InvokeHostFunctionOp`**. Line 246: "the `CREATE_CONTRACT` and `CREATE_CONTRACT_V2`
   variants of the operation are updated to handle the `CONTRACT_EXECUTABLE_EXTERNAL_REF`
   variant". Only the *create* variants. There is no operation that changes an existing
   contract's executable from outside, in protocol 28 or before.

There is also a hard secondary lock: the deployed wasm's `contractenvmetav0` section pins
**Protocol v27**, and the p28 host functions do not exist in the env this module was
compiled against. A wasm that has never been rebuilt cannot import a function that did not
exist when it was built.

**P-1 and P-2 are unchanged by protocol 28.** The claim holds.

CAP-0086 is the p28 item that does bear on this domain, and it cuts the other way: it exists
because `map_new_from_linear_memory` / `map_unpack_to_linear_memory` trap when a
`contracttype` map does not exactly match the expected schema, and "There are known cases
where this has rendered contracts unusable after an update." This vault cannot be updated in
place, so it cannot hit that. But a **successor** contract that tried to read storage
written by this one would have to keep `DataKey` and every stored value shape byte-identical.
See A7-01: the successor does not read the predecessor's storage at all, which sidesteps the
trap and creates a different problem.

---

# Findings

---

## A7-01 - Redeploy, the only remediation path, silently drops the allowlist and re-opens the policy

**Severity:** Medium
**Impact:** Medium. After a forced migration the successor vault runs with the allowlist
gate disabled and empty, the freeze off, and the session key unbounded, regardless of the
predecessor's settings. If the operator key is live at that moment, the agent can pay any
payee up to the cap until the owner manually rebuilds the policy.
**Likelihood:** Medium. It does not fire in normal operation, but redeploy is the *only*
remediation for any Critical or High finding on a live vault, so this is the guaranteed
consequence of every fix that touches deployed behaviour. It would fire today on testnet,
where `allowlist_enabled` is live and true.
**Violates:** INV-15 (allowlist enforcement), INV-13, INV-14; P-1.
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:74-107` (`__constructor`),
`soroban/contracts/agent-spend-policy/src/storage.rs:82` and `:187-212` (the `Allowed`
persistent map).
**Category:** Storage layout compatibility across upgrades / absence of a migration path.
**Detected by:** Manual review of the constructor against the storage module, cross-checked
against live `allowlist_enabled` on both networks and against the pubnet RPC event
retention window.
**Status:** Open. Not a duplicate of P-1; P-1 states that redeploy is the remediation, this
states that redeploy is not state-preserving.

### Description

The vault holds nine instance keys plus an unbounded persistent map. `__constructor` accepts
**five** arguments and hardcodes the rest:

```rust
store::set_frozen(&env, false);
store::set_allowlist_enabled(&env, false);
store::set_session_key_expiry(&env, 0);
```

`Allowed(Address)` lives in persistent storage keyed to the contract id
(`storage.rs:200-212`). A redeploy produces a new contract id, therefore a new, empty
persistent map. Nothing migrates. Nothing warns.

Three separate problems compound:

1. **The successor deploys weaker than the predecessor.** `allowlist_enabled` is forced to
   `false` at construction and there is no constructor argument for it, so a vault whose
   whole point was payee restriction comes back with the restriction off. The other two
   hardcoded defaults are permissive in the same direction: `frozen = false` and
   `session_key_expiry = 0`, which per INV-16 means "no bound", not "expired".
2. **The allowlist is write-only from the ledger's point of view.** There is no view that
   enumerates `Allowed`. `is_allowed(payee)` answers only for a payee you already know. To
   rebuild the set, the owner must replay the `AllowlistSet` event history.
3. **The event history has a retention floor.** Probed on the pubnet RPC on 2026-08-24:

   ```
   getEvents startLedger=1
   -> "startLedger must be within the ledger range: 63983637 - 64104596"
   ```

   120,959 ledgers, about **7.9 days** at the measured 5.625 s close time. Past that window
   the only reconstruction path is deep history (Hubble/Galexie) or the operator's own
   off-chain records. So an incident discovered more than eight days after the last
   `set_allowed` call cannot rebuild the allowlist from a public RPC at all.

CAP-0086 (protocol 28) is the reason not to solve this by having the successor read the
predecessor's storage: `contracttype` schema mismatches trap, and upstream records cases
where that "rendered contracts unusable after an update". The fix belongs in the constructor
signature and in the runbook, not in cross-contract storage reads.

### Proof of Concept

No transaction required. Read the live testnet vault, then read what its own release record
would rebuild.

```
$ stellar contract invoke --id CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI \
    --rpc-url https://soroban-testnet.stellar.org \
    --network-passphrase "Test SDF Network ; September 2015" \
    --source-account GBLHNAL5... --send=no -- allowlist_enabled
true
```

`soroban/releases/testnet-v0.1.0.json` records five constructor arguments and no allowlist
state. Redeploying from that record reproduces `allowlist_enabled = false` and an empty
`Allowed` map. The live gate is on; the reconstructed gate is off. The record is not wrong,
it records everything the constructor can accept. The constructor is what cannot express
the state.

### Recommended Fix (diff sketch)

Two parts. The first is for the successor contract and does not touch the live one.

```diff
--- a/soroban/contracts/agent-spend-policy/src/lib.rs
+++ b/soroban/contracts/agent-spend-policy/src/lib.rs
@@ pub fn __constructor(
         env: Env,
         owner: Address,
         operator: Address,
         token_id: Address,
         daily_cap: i128,
         auto_approve_max: i128,
+        // Migration parity. A redeploy is this contract's only remediation path, so the
+        // constructor must be able to reproduce the policy the predecessor was actually
+        // running. Defaulting these to the permissive value made the successor weaker
+        // than the vault it replaced, silently.
+        allowlist_enabled: bool,
+        allowed: Vec<Address>,
+        session_key_expiry: u64,
+        frozen: bool,
     ) {
@@
-        store::set_frozen(&env, false);
-        store::set_allowlist_enabled(&env, false);
-        store::set_session_key_expiry(&env, 0);
+        store::set_frozen(&env, frozen);
+        store::set_allowlist_enabled(&env, allowlist_enabled);
+        store::set_session_key_expiry(&env, session_key_expiry);
+        for payee in allowed.iter() {
+            store::set_allowed(&env, &payee, true);
+        }
```

Note the tradeoff to weigh before adopting it: `allowed` is caller-supplied and unbounded,
so it must be bounded (a small constant, or "seed the first N and set the rest with
`set_allowed`") or it becomes a deploy-time resource-limit failure and a fee-inflation
vector. Deploying `frozen = true` by default and lifting it after funding is also worth
considering; it makes the migration window fail closed.

The second part is free and applies to the contracts already deployed:

```diff
--- a/soroban/releases/pubnet-v0.1.0.json
+++ b/soroban/releases/pubnet-v0.1.0.json
+  "policyState": {
+    "note": "Read live on <date>, and NOT reconstructible from `constructor` above: the
+             constructor hardcodes these three and cannot express the allowlist at all.
+             This block is what a successor vault must be brought to by hand after a
+             redeploy. Re-read it with the twelve view functions before any migration.",
+    "allowlistEnabled": false,
+    "sessionKeyExpiry": 0,
+    "frozen": false,
+    "allowed": []
+  },
```

and the same block, populated, in `testnet-v0.1.0.json`. Record it now rather than at
incident time: after about eight days the events that would reconstruct it are gone from
the public RPC.

### References

- `soroban/contracts/agent-spend-policy/src/lib.rs:74-107`, `src/storage.rs:82,187-212`
- `audit/00-threat-model.md` P-1, INV-15, INV-16
- CAP-0086, "Motivation": `https://raw.githubusercontent.com/stellar/stellar-protocol/master/core/cap-0086.md`
- `audit/tool-output/A7-onchain-verification.txt` sections 6 and 9

---

## A7-02 - The owner is permanent, singular, un-timelocked, and currently a single burner key

**Severity:** High
**Impact:** Critical. The owner can `withdraw` the entire balance in one transaction with no
cap, no delay and no second signature (`withdraw` is exempt from the daily cap by design,
INV-07), can lift every policy bound with `set_policy`, and can hand the agent role to any
address with `set_operator`. Owner-key compromise is instant, total and irreversible. Owner-
key loss locks the balance forever: `withdraw` is owner-only and there is no recovery path,
no rotation and no upgrade.
**Likelihood:** Low to Medium, and entirely custody-dependent. The pubnet owner is, by the
project's own record, "a burner key generated for this deploy and held in a local CLI
keystore, not a multisig and not an HSM". Single copy, single machine, no quorum. The live
pubnet balance is 0 today, so present exposure is bounded by the funding decision, not by
the design.
**Violates:** INV-02, INV-20; P-2.
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:74-107` (`owner` fixed at
construction), `:137-152` (`withdraw`), `:249-252` (`require_owner`). Absence of `set_owner`
confirmed in the deployed export table. Custody stated in
`soroban/releases/pubnet-v0.1.0.json` `caveats[2]`.
**Category:** Upgrade without timelock or multi-party control / admin key custody.
**Detected by:** Bytecode export-table analysis of the fetched wasm, plus the release
record's own custody caveat, plus the pinned `soroban-env-host` 27.0.1 authorization docs.
**Status:** Open. This is the assessment P-2 asked for, not a new discovery. It must not be
counted as a novel finding by a reviewer deduplicating against the threat model.

### Description

Three distinct properties travel together and are worth separating, because only two of
them are actually permanent.

**Permanent (in the contract).** The `Owner` instance key is written once by
`__constructor` and never again. `set_owner` does not exist in the deployed export table.
No upgrade can add it (section 1). For the life of contract id `CB5LYXFK...`, the owner is
`GARC7OFB...`.

**Permanent (in the contract), and this is the more important half.** There is no timelock
and no multi-party control on any owner action. `withdraw`, `set_policy`, `set_operator`,
`set_frozen` and `owner_pay` each take effect in the transaction that carries them. There
is no delay in which a human could observe a hostile `set_policy` and react, and the
contract's own kill switch does not help: `set_frozen` gates only `pay`, so freezing does
not stop an attacker who holds the owner key from calling `withdraw`.

**Not permanent, and this is the finding's one piece of good news.** The owner *address* is
fixed, but the signer set behind that address is not. From the pinned
`soroban-env-host` 27.0.1 `src/auth.rs:106-109`, describing what may satisfy
`require_auth`:

> 2. The address of a Stellar classic account, identified by `AccountID`, that must supply
> `SorobanAddressCredentials` for any `AuthorizedInvocation` it authorizes, **satisfying the
> account's classic multisig authorization to its medium threshold**.

`GARC7OFB...` is a classic account. A classic `SetOptions` operation on that account, which
touches this contract not at all, can add signers and raise the medium threshold. From that
point every owner-authorized invocation of this vault requires an M-of-N quorum, and the
contract needs no change, no redeploy and no new contract id. The same holds for the
transaction-source-account credential path, where the transaction signatures must already
have met the account's thresholds before the Soroban host is instantiated.

The catch, and it is the whole reason this is High rather than Informational: **`SetOptions`
requires the current master key at high threshold.** The mitigation is only available while
the key is still held and still uncompromised. It is a thing to do now, not a thing to do
during an incident.

R3's action item A-4(a) is the sibling of this for C-addresses under CAP-0071. Worth
recording that the G-address case needs no protocol-27 feature at all; classic multisig has
been available since Stellar's first ledger.

### Proof of Concept

Read-only, no transaction.

```
$ stellar contract info interface --wasm pubnet.wasm | grep -c "fn set_owner"
0
$ stellar contract invoke --id CB5LYXFK... --send=no -- owner
"GARC7OFBBQCZJ5N3LCI7HTTYJ2MMPDAFDNGIHSQMZ7EPJ5EAWQJ5R6I5"
```

`owner` is unchanged from the constructor argument recorded at deploy, and no entrypoint
exists that could change it. `withdraw`'s cost bound is the balance, not the cap:

```rust
// lib.rs:137, withdraw. Note what is absent: no daily-cap consultation, no ceiling,
// no allowlist, no freeze check. Only require_owner, amount validity, payee validity
// and balance.
pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
    Self::require_owner(&env);
    ...
}
```

The current account state of `GARC7OFB...` (signers and thresholds) is readable at
`https://horizon.stellar.org/accounts/GARC7OFBBQCZJ5N3LCI7HTTYJ2MMPDAFDNGIHSQMZ7EPJ5EAWQJ5R6I5`
and is the thing to check before and after applying any of the options below.

### Recommended Fix (diff sketch)

This is a design decision, not a bug, so the deliverable is the decision rather than a
patch. Four options, in DESIGN-DECISIONS terms.

**Option 1 - Accept, and bound the exposure by funding policy. (status quo, zero cost)**

Keep the single key. The mitigation is that the vault holds 1 USDC against a 1 USDC/day cap.
This is the trade the project already wrote down, and it is defensible for a demonstration
vault. It stops being defensible the first time the vault is funded with an amount whose
loss would matter. Make that explicit as a written ceiling.

```diff
--- a/soroban/README.md
+++ b/soroban/README.md
+## Funding ceiling (owner-key custody)
+
+The pubnet owner is a single key in a local CLI keystore. There is no `set_owner`, no
+timelock and no quorum on `withdraw`, so a compromise of that one key is a total loss of
+whatever the vault holds, immediately. Until the owner account is converted to multisig
+(Option 2 below) the vault MUST NOT be funded above <N> USDC. This is the only control
+standing between key custody and the balance.
```

**Option 2 - Convert the owner account to classic multisig. (recommended, no contract change)**

Apply `SetOptions` to `GARC7OFB...`: add K signers held on separate devices, set
`med_threshold` to require a quorum, and decide the master weight deliberately. Every owner
action on the vault then needs the quorum, enforced by the host at the medium threshold, and
the contract is untouched. This is the only option that fixes the deployed pubnet vault
without a redeploy.

Two warnings, both capable of turning this into a permanent loss:
- Setting `master_weight = 0` makes the change unreversible without the new quorum. If the
  signer set is misconfigured, the account, and therefore the vault, is locked forever.
- Rehearse the exact `SetOptions` on testnet against `GBLHNAL5...` first, then verify by
  reading the account's signers back from Horizon before touching pubnet.

The operator key is worth a note here: it is *not* in this bind. `set_operator` exists, so
operator compromise is recoverable in one owner transaction. Only the owner is one-way.

**Option 3 - Successor vault owned by a contract account. (next deploy only)**

`Address` in Soroban is an `SCAddress`, which is an account or a contract. Passing a C-address
as `owner` is already supported by the current code with no change; a custom account contract
can implement whatever quorum, timelock or social-recovery policy it likes in `__check_auth`,
and under CAP-0071 it may delegate recursively. But it must be chosen at deploy time, and it
moves a piece of the trusted computing base into a contract that would then need its own
audit. R3 quotes the upstream warning that a delegating account contract "must ensure that
these signers actually belong to it". Strictly more powerful than Option 2, strictly more to
get wrong.

**Option 4 - Add a timelock to `withdraw` in the successor. (rejected by default, recorded)**

A queue-then-execute `withdraw` would give a compromise window in which the freeze and the
operator rotation are still useful. Rejected here because it directly contradicts INV-20
("`withdraw` remains reachable for the owner for as long as the vault holds a balance") and
adds a second state machine to the exact function that is the escape hatch for every other
finding. Recorded so the decision is visible rather than implicit.

### References

- `soroban-env-host` 27.0.1 `src/auth.rs:95-120` (local:
  `~/.cargo/registry/src/index.crates.io-*/soroban-env-host-27.0.1/src/auth.rs`)
- `soroban/releases/pubnet-v0.1.0.json` `caveats[2]`
- `audit/00-threat-model.md` P-2, INV-02, INV-07, INV-20
- `audit/research/R3-advisories.md` section 3.2 and action item A-4(a) (CAP-0071, the
  C-address sibling of this finding)

---

## A7-03 - The documented recovery runbook omits the freeze step and has never been rehearsed

**Severity:** Low
**Impact:** Low to Medium. In an incident the operator follows a three-step sequence that
leaves the agent's payment path live for the whole of step one. If the Critical being
remediated is exploitable through `pay`, which is the most likely shape given that
`operator.require_auth()` is the entire authorization surface, the vault keeps bleeding at
up to the daily cap while the owner prepares the withdrawal.
**Likelihood:** Low. Requires an incident. But the runbook is the artifact that determines
what happens when one occurs, and it is the artifact P-1 promises.
**Violates:** n/a, this is a process finding against P-1 rather than an invariant. It bears
on INV-20 (`withdraw` must stay reachable) because the runbook is what makes reachability
useful.
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:38-41` (the source comment
that states the sequence), `soroban/releases/pubnet-v0.1.0.json`
`artifacts[2].detail` (the same sequence, same omission).
**Category:** Upgrade without timelock or multi-party control (operational half).
**Detected by:** Manual review of the stated remediation against the contract's actual gate
semantics, plus a cost reconstruction from the live ledger.
**Status:** Open.

### Description

Both the source and the release record state the sequence as **withdraw -> redeploy ->
repoint**. Checked against what the contract actually does, it should be **freeze ->
withdraw -> redeploy -> repoint -> re-arm**, and the two additional steps are the ones that
matter.

`set_frozen(true)` blocks `pay` and nothing else. `owner_pay` and `withdraw` bypass the
freeze by design (INV-13). That asymmetry is exactly what an emergency stop needs: it stops
the agent while leaving the owner's exit open. It is one owner transaction, it costs about
0.004 XLM, and the record itself demonstrates that it works and that it reverses
(`c003e3fe...` on, `8bccb734...` off). Leaving it out of the runbook wastes the one control
the contract has that is designed for precisely this moment.

The closing step is A7-01: the successor comes up with the allowlist off, the freeze off and
no session bound, so "repoint" is not the last step. "Re-arm the policy, then verify with
the twelve views" is.

Two caveats worth writing into the runbook rather than discovering during an incident:

- Freeze does not help if the finding is in `withdraw`, `owner_pay` or the token
  interaction, and it does not help at all if the compromised thing is the owner key
  (A7-02). Then there is no on-chain move left.
- CAP-0077 (protocol 26) lets the validator set freeze this contract's ledger entries by
  settings upgrade, which would take `withdraw` offline with no recourse and no upgrade path
  to route around it (R3 section 3.3, action item A-4(b)). Not a plausible adversary, but it
  is the one scenario in which the runbook has no first step.

**What it costs, measured rather than estimated.** Both figures come from the live ledger:

| Step | Cost | Basis |
| --- | --- | --- |
| `set_frozen(true)` | ~0.004 XLM | record: "every subsequent contract call cost between 0.0007 and 0.004" |
| `withdraw` | ~0.004 XLM | same |
| Re-upload a *fixed* wasm | ~12.23 XLM | measured: pubnet upload tx `4230a328...` charged 12.2319214 XLM for 11,625 bytes |
| Instantiate | ~0.099 XLM | measured: pubnet instantiate tx `847dc7e9...` charged 0.0992122 XLM |
| Re-fund the successor | ~0.004 XLM | one SAC transfer |
| Re-arm the policy | ~0.004 XLM x (1 + number of allowlist entries) | `set_policy` plus one `set_allowed` each |
| **Total** | **about 12.34 XLM, about 2.41 USD** | at the record's own DEX fill of 0.19495 USDC per XLM |

One nuance that halves the bill in the common case. If the redeploy reuses the **same** wasm
hash, the upload is free, because the code entry already exists on the ledger and is paid
for. Verified live:

```
getLedgerEntries, pubnet, 2026-08-24
  contract_code 155eb31c...  liveUntilLedgerSeq 66177015   (latest ledger 64104554)
```

2,072,461 ledgers ahead, about 135 days at the measured 5.625 s close, so around 2027-01-06.
Until then a same-wasm redeploy costs only the 0.099 XLM instantiate. A redeploy carrying an
actual fix is a new hash and pays the full 12.23 XLM upload.

**So the money is not the cost.** The cost is: a new contract id, every reference to the old
one going stale, and a manual policy rebuild with no enumeration to rebuild it from. The
repoint surface is small and was measured:

```
mcp/src/chains/registry.ts:126   spendVault: 'CB5LYXFK...'   (hardcoded, no env override)
mcp/src/chains/provenance.ts     the artifact ledger behind /proof/:rail
soroban/releases/pubnet-v0.1.0.json
audit/00-threat-model.md
```

No `public/` surface and no OKX.AI listing references this contract id, so the ASP
registrations under `mcp/src/asp/` are unaffected by a vault redeploy. Because `registry.ts`
holds it as a literal with no environment override, a repoint is a code change plus a Render
redeploy plus (per CLAUDE.md) a `npm run prerender` before the frontend build.

### Proof of Concept

Not an exploit. The gap is demonstrable by reading the contract's own gate order: `pay`
routes through `settle`, which builds a `Snapshot` including `frozen`, and
`policy::check_operator_pay` rejects on it; `withdraw` never reads `frozen` at all
(`lib.rs:137-152`). So freezing is a strictly-dominant first move for the owner, and its
omission from the runbook is a pure loss.

### Recommended Fix (diff sketch)

```diff
--- a/soroban/contracts/agent-spend-policy/src/lib.rs
+++ b/soroban/contracts/agent-spend-policy/src/lib.rs
@@
 //! No `upgrade` entrypoint. An upgrade path is a second total-authority door and it makes
 //! the admin-centralization finding worse, which is the wrong trade for a contract whose
-//! whole claim is bounded authority. The escape hatch is the one that already exists:
-//! `withdraw`, redeploy, repoint.
+//! whole claim is bounded authority. The escape hatch is the one that already exists, and
+//! it has five steps, not three:
+//!
+//!   1. `set_frozen(true)`. Stops `pay` and nothing else: `owner_pay` and `withdraw`
+//!      bypass the freeze by design, so this closes the agent path while leaving the
+//!      owner's exit open. One transaction, about 0.004 XLM. Do this first.
+//!   2. `withdraw` the full balance to the owner.
+//!   3. Redeploy the fix. A new wasm hash pays a fresh upload (about 12.23 XLM at 11,625
+//!      bytes); reusing the same hash costs only the instantiate (about 0.099 XLM) while
+//!      the code entry is still live.
+//!   4. Repoint `mcp/src/chains/registry.ts` and `mcp/src/chains/provenance.ts`, and cut
+//!      a new release record. The contract id changes; nothing else can be reused.
+//!   5. Re-arm the policy by hand. The constructor cannot express `allowlist_enabled`,
+//!      the `Allowed` set, `frozen` or `session_key_expiry`, so the successor comes up
+//!      permissive. Re-apply them, then verify with all twelve view functions.
+//!
+//! Steps 1 and 5 both assume the owner key is intact. If the owner key is what was
+//! compromised, none of this is available: see audit finding A7-02.
```

Then rehearse the whole sequence on testnet once, against
`CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI`, and commit the transcript to
`audit/tool-output/`. An unrehearsed runbook for a contract with no upgrade path is a plan,
not a control.

### References

- `soroban/contracts/agent-spend-policy/src/lib.rs:38-41,137-152,207-213`
- `soroban/releases/pubnet-v0.1.0.json` `artifacts[1].feeXlm`, `artifacts[2].feeXlm`,
  `funding.note2`, `artifacts[8]` (the freeze on and off)
- `audit/tool-output/A7-onchain-verification.txt` sections 5 and 7
- `audit/research/R3-advisories.md` section 3.3 (CAP-0077) and action item A-4(b)

---

## A7-04 - No upgrade path, confirmed at the bytecode level; protocol 28 does not change it

**Severity:** Informational
**Impact:** n/a. This entry records a verified structural property, not a defect. It is
here because P-1 is the premise of every other finding's remediation cost, so it is worth
holding to a higher standard of proof than a grep.
**Likelihood:** n/a
**Violates:** n/a. Confirms P-1.
**Location:** The deployed wasm at `155eb31c...79239`, import and export sections.
**Category:** Access control on `update_current_contract_wasm`.
**Detected by:** Direct parse of the fetched wasm's section 2 (imports) and section 7
(exports), resolved against `soroban-env-common` 27.0.1 `env.json`; plus the CAP-0085 text.
**Status:** Verified, no action.

### Description

Section 1 and section 5 above carry the full argument. In summary:

- No `upgrade`, `update_wasm`, `initialize`, `migrate` or `set_owner` among the 22
  exported contract functions (9 mutating, 13 views).
- The module does not import `ledger::update_current_contract_wasm` (`l.6`),
  `ledger::create_contract` (`l.3`), `ledger::create_contract_with_constructor` (`l.e`) or
  `ledger::upload_wasm` (`l.5`). A Soroban guest can only call host functions it declares
  as imports, so the capability is absent from the deployed artifact, not merely unused by
  it. There is also no factory or deployer contract anywhere in the system.
- CAP-0085's `update_current_contract_executable_ref` is a self-call, exactly like
  `update_current_contract_wasm`, and its `InvokeHostFunctionOp` support covers only
  `CREATE_CONTRACT` and `CREATE_CONTRACT_V2`. No operation changes an existing contract's
  executable.
- `contractenvmetav0` pins Protocol v27, so the p28 host functions did not exist when this
  module was built.

**Consequence, stated plainly, because it is the load-bearing one.** There is no privileged
door to attack: no admin upgrade key to steal, no proxy slot to collide with, no
implementation contract to selfdestruct, no storage-slot layout to shift out from under a
delegatecall. The entire "malicious or compromised upgrade" class is absent. The price is
that every Critical or High finding in this audit costs a full migration to fix, at the
operational cost in A7-03 and with the state-loss hazard in A7-01. That is a defensible
trade for a vault whose product claim is bounded authority. It is the audit's job to make
sure the trade is priced, not to reverse it.

### Proof of Concept

```
$ stellar contract fetch --id CB5LYXFK... --out-file pubnet.wasm   # read-only
$ # parse import section, resolve against soroban-env-common 27.0.1 env.json
  l.6   ledger::update_current_contract_wasm            imported = False
  l.3   ledger::create_contract                         imported = False
  l.e   ledger::create_contract_with_constructor        imported = False
  l.5   ledger::upload_wasm                             imported = False
$ stellar contract info env-meta --wasm pubnet.wasm
  Protocol: v27
```

Full listing of all 22 imports in `audit/tool-output/A7-onchain-verification.txt` section 3.

### Recommended Fix (diff sketch)

None. One documentation nit, so the strongest available evidence is the one on record:

```diff
--- a/audit/00-threat-model.md
+++ b/audit/00-threat-model.md
-| Upgrade entrypoint | none (`update_current_contract_wasm` absent) | grep over `contracts/` |
+| Upgrade entrypoint | none | the DEPLOYED wasm does not import `ledger::update_current_contract_wasm` (host fn `l.6`); see A7 section 1. A grep over `contracts/` proves only that the source lacks it. |
```

### References

- `audit/tool-output/A7-onchain-verification.txt` sections 2 and 3
- CAP-0085 lines 238 and 246: `https://raw.githubusercontent.com/stellar/stellar-protocol/master/core/cap-0085.md`
- `soroban-env-common` 27.0.1 `env.json` (local cargo registry)
- `audit/00-threat-model.md` P-1; `audit/research/R3-advisories.md` section 3.6

---

## A7-05 - The constructor requires no consent from the addresses it names, and its tests cannot prove otherwise

**Severity:** Informational
**Impact:** Negligible for the deployed vaults. Nobody is harmed by being named the owner or
operator of a vault someone else funds. The consequence is about identity, not about funds:
nothing on chain binds a vault to a claimed operator, so a third party cannot infer
provenance from the constructor arguments alone.
**Likelihood:** n/a
**Violates:** n/a. Refines threat-model section 5, which lists `__constructor` auth as
"none (atomic at deploy)" without saying what that means on chain.
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:74-107`;
`soroban/contracts/agent-spend-policy/src/test/amounts.rs:84-137`.
**Category:** Constructor arguments / admin key custody assumptions.
**Detected by:** Decoding the auth entries of both deploy transactions from Horizon; reading
the constructor tests against the soroban-sdk 27.0.2 release notes.
**Status:** Verified, documentation only.

### Description

Full argument in section 3 above. The three results:

1. **On chain, the constructor requires exactly one signature**: the deployer's, on
   `create_contract_v2`. The auth entry carries `credentials: source_account` and
   `sub_invocations: []`, which is what an empty constructor-body authorization looks like.
   The pubnet operator `GDLAJM25...` never signed anything.
2. **The constructor's argument validation is production-real.** `owner == operator`,
   negative cap, negative ceiling are checked before any auth is consulted, on values
   carried in the signed envelope, so the three `#[should_panic]` tests in `amounts.rs` are
   valid evidence about network behaviour.
3. **The constructor's authorization behaviour cannot be tested by that suite.** SDK 27.0.2
   switched native constructors to recording auth (#1933, #1943) and the deploy used 27.0.6.
   Under recording auth a constructor `require_auth` is recorded, not enforced, so
   `env.register` cannot distinguish an enforced constructor guard from an absent one. This
   is a limit on the harness, not a defect in these tests, which do not claim to test auth.

And the constructor is **unfixable**. No upgrade, no `initialize`, no re-init. The five
pubnet constructor arguments are permanent for the life of contract id `CB5LYXFK...`, which
is why they get more scrutiny per line than anything else here, and why the deploy
transaction rather than the test suite is the evidence of record.

### Proof of Concept

```
$ curl -s https://horizon.stellar.org/transactions/847dc7e9...ee2d | jq -r .envelope_xdr \
  | stellar xdr decode --type TransactionEnvelope --input single-base64 --output json-formatted

  "auth": [ { "credentials": "source_account",
              "root_invocation": { "function": { "create_contract_v2_host_fn": { ... } },
                                   "sub_invocations": [] } } ]
```

`sub_invocations: []` is the finding. The testnet deploy `718f050b...` has the same shape.

### Recommended Fix (diff sketch)

No code change. Record what the deploy proved, so a later reader does not re-derive it or,
worse, assume the opposite:

```diff
--- a/audit/00-threat-model.md
+++ b/audit/00-threat-model.md
-| `__constructor(owner, operator, token_id, daily_cap, auto_approve_max)` | none (atomic at deploy) | reads `decimals()` ... |
+| `__constructor(owner, operator, token_id, daily_cap, auto_approve_max)` | the DEPLOYER's signature on `create_contract_v2`, and nothing else. Verified from the deploy tx auth entry: `credentials: source_account`, `sub_invocations: []`. Neither the named owner nor the named operator consents to being named. | reads `decimals()` ... |
```

and, in the test file, one comment so the boundary is not lost:

```diff
--- a/soroban/contracts/agent-spend-policy/src/test/amounts.rs
+++ b/soroban/contracts/agent-spend-policy/src/test/amounts.rs
@@
 /// A negative cap compares as "always under budget" and a negative ceiling as "always
 /// over it". Both are silently wrong rather than loud, so they are refused at
 /// construction, where the mistake is still free. This SDK has no fallible `register`, so
 /// the assertion is the panic itself.
+///
+/// What these three tests prove and do not prove. They prove ARGUMENT VALIDATION, which is
+/// auth-independent and therefore identical on chain. They prove nothing about constructor
+/// AUTHORIZATION: soroban-sdk 27.0.2 switched native constructors to recording auth
+/// (#1933, #1943), so a `require_auth` here would be recorded rather than enforced and
+/// `env.register` could not tell the difference. The evidence for what the constructor
+/// actually requires on chain is the deploy transaction's auth entry, not this suite.
```

### References

- Pubnet deploy tx `847dc7e99e73f6c0062e5aed29599f41226998053fe7b6c35e48e9cf64a6ee2d`
- Testnet deploy tx `718f050b962b6e645d8cca5cc053d9f1c11a7264d3ddc266f7e36661bd82c68c`
- `audit/research/R3-advisories.md` section 2.2 (27.0.2) and action item A-3
- `audit/tool-output/A7-onchain-verification.txt` section 5

---

## A7-06 - Deploy front-running is structurally impossible (verified, not assumed)

**Severity:** Informational
**Impact:** None. Recorded because the source comment at `lib.rs:43-45` makes a security
claim ("the front-run-the-initializer class is structurally absent rather than merely tested
against") and a claim in the code deserves independent confirmation.
**Likelihood:** n/a
**Violates:** n/a
**Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:43-45`; the
`contract_id_preimage` of both deploy transactions.
**Category:** Deployer/factory salt and address prediction; constructor front-running.
**Detected by:** Recomputing the contract id from the XDR preimage in Python and comparing
against the deployed id, plus three counterfactuals.
**Status:** Verified, no action.

### Description

Full argument in section 4 above. The claim holds, and for a stronger reason than the source
comment gives. The comment credits atomicity: `__constructor` runs inside
`create_contract_v2`, so there is no unowned window. True, and sufficient. But even a
non-atomic Soroban deploy could not be front-run for the address, because the contract id
preimage contains the **deployer's account key**. Re-derived and matched exactly; changing
the deployer key, the network passphrase or the salt each produces a completely different
id. An attacker cannot construct a `create_contract_v2` whose preimage names an account they
do not control, so the EVM `CREATE2` squatting class has no analogue here.

Constructor arguments are covered by the signature: they appear inside `root_invocation` of
the auth entry, not only in the operation body. Salt entropy is not load-bearing for the
same reason the address cannot be squatted; both observed salts are CLI-generated, 32 bytes
of high entropy, and differ between deploys, which is more than the threat requires.

### Proof of Concept

```
id = strkey_C(sha256( u32(8) || sha256(passphrase) || u32(0) || SCAddress(deployer) || salt ))

deployer GARC7OFBBQCZJ5N3LCI7HTTYJ2MMPDAFDNGIHSQMZ7EPJ5EAWQJ5R6I5
salt     4adffd6ec91f8609539d04fa0b97d30254d74ad4987d127af0900634ca83eede
derived  CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP   == deployed id

same salt, attacker key       -> CBRJSH5VVTPENQRE3SKFPR64OSMARV5EMPVTAH3OOQRDA7OV74TTLVGO
same deployer+salt, testnet   -> CATSYLYNJWCJLEQUBXOXLGZUMQHTUONN5VOCKESP5XJPQTLXD7QMOQHO
same deployer, salt+1         -> CB6CZKHP56TNPM6QHDNH3TO7PG54CL6MVAHPABVC65CVCFCOAKDBPUP5
```

### Recommended Fix (diff sketch)

None. Optionally sharpen the source comment so it rests on the stronger reason:

```diff
--- a/soroban/contracts/agent-spend-policy/src/lib.rs
+++ b/soroban/contracts/agent-spend-policy/src/lib.rs
 //! No `initialize`. Initialization happens in `__constructor`, atomically at deploy, so
 //! there is no window in which the contract exists unowned and the front-run-the-
 //! initializer class is structurally absent rather than merely tested against.
+//! The address cannot be squatted either, for a separate reason: a Soroban contract id is
+//! sha256 over a preimage containing the DEPLOYER's account key, the salt and the network
+//! passphrase, so no observer can create a contract at an id derived from an account they
+//! do not control. There is no CREATE2-style counterfactual-address attack here.
```

### References

- `audit/tool-output/A7-onchain-verification.txt` section 4
- `stellar-xdr` `HashIDPreimage`, `ENVELOPE_TYPE_CONTRACT_ID = 8`,
  `CONTRACT_ID_PREIMAGE_FROM_ADDRESS`

---

## A7-07 - Anyone may instantiate a byte-identical clone; the wasm hash does not identify this deployment

**Severity:** Informational
**Impact:** Low, and it lands on buyers rather than on the vault. A third party can deploy a
vault at their own address running the exact bytes at `155eb31c...79239`, with any owner,
operator, token, cap and ceiling they choose. Its `stellar contract fetch` hash will match
this project's published hash exactly. Anyone verifying a vault by wasm hash alone would
accept it.
**Likelihood:** Low. There is no direct gain, since the clone's funds are the cloner's. The
plausible use is presentation: pointing at a lookalike while citing this project's audit and
reproducibility claims.
**Violates:** n/a
**Location:** The uploaded code entry `155eb31c...79239` on pubnet, ledger 64103416.
**Category:** Deployment.
**Detected by:** Reading the pubnet deploy pair: upload (`4230a328...`) and instantiate
(`847dc7e9...`) are separate transactions against a separate, unowned `contract_code` ledger
entry.
**Status:** Open, documentation only.

### Description

A Soroban `ContractCodeEntry` is keyed by the wasm hash and has no owner. Once uploaded it
is a shared public resource: any account may `create_contract_v2 --wasm-hash 155eb31c...`
and get their own instance. The pubnet deploy makes this visible because the CLI split it
into two transactions (the testnet deploy did both in one), but the property is the same
either way.

This is not a vulnerability, and there is nothing to fix in the contract. It is a
verification instruction. The correct identity check is two-part and ordered:

1. The **contract id** is the identity. `CB5LYXFK...` on pubnet, `CAIL6ECR...` on testnet.
2. The **wasm hash** then tells you what code that id runs.

Hash first is the wrong order and accepts any clone. The release records currently lead with
the hash-verification instruction ("Pull the deployed bytes with `stellar contract fetch`
... and sha256 them against `wasm.sha256`") without stating that the hash alone proves
nothing about which deployment you are looking at.

Note the same asymmetry protects against the inverse confusion: because the contract id
binds the deployer, an id that matches the record is definitively this project's deploy.

### Proof of Concept

The two-transaction split is the demonstration:

```
4230a328bf06  ledger 64103416  2026-08-24T13:45:53Z  fee 12.2319214 XLM  upload_wasm
847dc7e99e73  ledger 64103418  2026-08-24T13:46:04Z  fee  0.0992122 XLM  create_contract_v2
```

The code entry created by the first is unowned and is now live until ledger 66177015. Any
account may build a `create_contract_v2` against that hash. No experiment was run, because
running one would require transacting.

### Recommended Fix (diff sketch)

```diff
--- a/soroban/releases/pubnet-v0.1.0.json
+++ b/soroban/releases/pubnet-v0.1.0.json
-  "note": "... Pull the deployed bytes with `stellar contract fetch --id C... --network pubnet --out-file` and sha256 them against `wasm.sha256` below.",
+  "note": "... Verify in this order, and the order matters. First the CONTRACT ID: `contractId` below is the identity, because a Soroban contract id is derived from the deployer's account key, the salt and the network passphrase, so only this project could have created it. Then the BYTES: `stellar contract fetch --id <that id> --network pubnet --out-file`, sha256 against `wasm.sha256`. The hash on its own identifies nothing: an uploaded code entry is unowned and public, so anyone may instantiate a byte-identical vault with entirely different constructor arguments and it will fetch to the same hash.",
```

Same edit in `testnet-v0.1.0.json`.

### References

- Pubnet upload tx `4230a328bf063cc005e8fea00c45a9d38af57968b8ee166cbb5a11fb92b51fba`
- `audit/tool-output/A7-onchain-verification.txt` sections 1, 5 and 7

---

## A7-08 - The pubnet release record's `deployedAt` is 19 minutes later than the on-chain instantiate

**Severity:** Informational
**Impact:** Negligible on its own. It matters only because the release record is the
provenance artifact this project asks reviewers to trust, and a timestamp that does not
match the ledger invites a reviewer to doubt the fields that do match.
**Likelihood:** n/a
**Violates:** n/a
**Location:** `soroban/releases/pubnet-v0.1.0.json`, `deployedAt`.
**Category:** Deployment record accuracy.
**Detected by:** Horizon `created_at` on both deploy transactions versus the record.
**Status:** Open, one-line fix.

### Description

```
record   deployedAt  2026-08-24T14:05:00Z
horizon  4230a328... 2026-08-24T13:45:53Z   upload
horizon  847dc7e9... 2026-08-24T13:46:04Z   instantiate, contract created
```

19 minutes late, and the round `:00` seconds suggests it was typed rather than read from the
ledger. Everything else in the record was checked and is exact: both `txHash` values, both
`ledger` numbers, both `feeXlm` values to seven decimals, the wasm hash, the byte count, all
five constructor arguments, and the whole `finalState` block. This is the only field that
does not reconcile.

The testnet record's `deployedAt` (`2026-08-15T02:05:46Z`) matches its transaction's
Horizon `created_at` exactly, which is the pattern to restore.

For completeness on the release records generally: `finalState` in the pubnet record matches
the live contract on all six fields (section 2). The testnet record has no `finalState` and
its live state has since diverged (`allowlist_enabled` now true, balance 13.988 USDC), but
the record explicitly self-labels as superseded, so it is accurate as-cut. The migration
hazard that divergence implies is A7-01, not a record defect.

### Proof of Concept

```
$ curl -s https://horizon.stellar.org/transactions/847dc7e99e73f6c0062e5aed29599f41226998053fe7b6c35e48e9cf64a6ee2d \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['created_at'], d['ledger'], d['successful'])"
2026-08-24T13:46:04Z 64103418 True
```

### Recommended Fix (diff sketch)

```diff
--- a/soroban/releases/pubnet-v0.1.0.json
+++ b/soroban/releases/pubnet-v0.1.0.json
-  "deployedAt": "2026-08-24T14:05:00Z",
+  "deployedAt": "2026-08-24T13:46:04Z",
+  "deployedAtNote": "Horizon `created_at` of the instantiate transaction 847dc7e9..., ledger 64103418, read from the ledger rather than typed. The upload that preceded it closed at 13:45:53Z.",
```

### References

- `soroban/releases/pubnet-v0.1.0.json`
- `audit/tool-output/A7-onchain-verification.txt` section 5

---

# Unconfirmed

Stated so they are on the record as suspicions rather than results, and so nobody
re-derives them as findings.

1. **Whether the owner key exists in more than one copy.** The release record says "a local
   CLI keystore". This audit did not inspect key material and will not. The severity of
   A7-02 rests on a statement by the maintainer, not on a verified custody model. If the key
   is backed up somewhere, the loss half of A7-02 softens and the compromise half worsens.
   Establishing this is a maintainer question, not an audit one.

2. **Whether `stellar-cli` 27.1.0's default salt is drawn from a CSPRNG.** Both observed
   salts look like 32 bytes of high entropy and differ, which is consistent with a CSPRNG,
   but the CLI is a compiled binary here and its source was not read. This does not affect
   A7-06: on Soroban a weak salt cannot be exploited for address squatting, because the
   deployer's key is in the preimage. It would only make the id predictable in advance,
   which is not a capability that buys an attacker anything here.

3. **Whether any third party has recorded the pubnet contract id outside this repository.**
   The repoint surface measured in A7-03 covers this repository only (4 files) and `public/`
   was checked and does not carry it, so the OKX.AI listings under `mcp/src/asp/` are
   unaffected. External references (a partner integration, a hackathon submission, a
   published document) would widen the cost of a redeploy and cannot be enumerated from
   here.

4. **Whether the constructor's `token::Client::new(...).decimals()` call can be made to
   trap or to return a hostile value by a non-SEP-41 address.** The call is the deploy-time
   SEP-41 proof (P-4, P-6) and it is inside the unfixable constructor, which puts it in this
   domain's blast radius. But the behaviour of a hostile token is A4's question and was not
   tested here. Flagged only because a defect there would be permanent on any vault deployed
   against a bad token, with no remediation short of A7-03's full sequence.

5. **Whether `spent_today` survives the UTC day boundary on pubnet.** The probe ran inside
   day 20689, the same day as the deploy, so this run says nothing about INV-18. R3 action
   item A-2 owns it. Recorded here only so the `spent_today = 10000000` reading in section 2
   is not later mistaken for evidence of TTL survival.
