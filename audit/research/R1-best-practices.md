# R1 - Soroban / Stellar security best practices (reference material)

Research agent R1. Written 2026-08-24. Input to Phase 3.

This is **reference material, not a review**. No line of `AgentSpendPolicy` was read while
writing it. Every item is framed so a Phase 3 auditor can turn it into a check.

## How to read an entry

Each entry has four fields:

- **Practice** - the rule.
- **Why** - what breaks if it is violated, tied to a threat-model invariant where one applies.
- **Check** - the concrete thing to do against the code or the network.
- **Source** - where it was verified. Claims with no source are marked `UNVERIFIED`.

Priority tags: `[P1]` applies directly to a two-role value-holding vault with day-bucketed
accounting, an allowlist and no upgrade path. `[P2]` applies but is secondary. `[P3]` is
background.

---

## 0. Verified environment facts

These were measured, not recalled. Phase 3 should treat them as the baseline and re-measure
if the audit runs on a later date.

### 0.1 Live network parameters

Measured 2026-08-24 with `stellar` CLI `27.1.0` (`stellar-xdr 27.0.0`):

```
stellar network settings \
  --rpc-url https://mainnet.sorobanrpc.com \
  --network-passphrase "Public Global Stellar Network ; September 2015"

stellar network settings \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

| Setting | pubnet (mainnet) | testnet |
| --- | --- | --- |
| `state_archival.max_entry_ttl` | 3110400 | 3110400 |
| `state_archival.min_temporary_ttl` | **17280** | **720** |
| `state_archival.min_persistent_ttl` | **2073600** | **120960** |
| `state_archival.persistent_rent_rate_denominator` | 1215 | 1215 |
| `state_archival.temp_rent_rate_denominator` | 2430 | 2430 |
| `state_archival.max_entries_to_archive` | 1000 | 1000 |
| `state_archival.eviction_scan_size` | 500000 | 500000 |
| `state_archival.starting_eviction_scan_level` | 7 | 7 |
| `contract_data_key_size_bytes` | 250 | 250 |
| `contract_data_entry_size_bytes` | **65536** | 65536 |
| `contract_max_size_bytes` | 131072 | 131072 |
| `contract_compute_v0.tx_max_instructions` | 400000000 | 400000000 |
| `contract_compute_v0.tx_memory_limit` | 41943040 | 41943040 |
| `contract_events_v0.tx_max_contract_events_size_bytes` | 16384 | 16384 |
| `contract_ledger_cost_v0.tx_max_disk_read_entries` | 200 | 200 |
| `contract_ledger_cost_v0.tx_max_write_ledger_entries` | 200 | 200 |
| `contract_ledger_cost_ext_v0.tx_max_footprint_entries` | 400 | 400 |
| `scp_timing.ledger_target_close_time_milliseconds` | **5000** | 5000 |
| `frozen_ledger_keys.keys` | **3 keys present** | empty |
| `freeze_bypass_txs.tx_hashes` | empty | empty |

Source: live RPC via the CLI documented at
https://developers.stellar.org/docs/networks/resource-limits-fees
(that page carries no numbers; it directs you to `stellar network settings` and
https://lab.stellar.org/network-limits, which is why these were measured).

### 0.2 The three numbers that matter most here

Derived arithmetic from the table above, at the current 5000 ms target close time:

1. **pubnet `min_temporary_ttl` = 17280 ledgers = 86400 s = exactly 24 hours.**
   A temporary entry created on pubnet is guaranteed live for exactly one day and no more.
2. **testnet `min_temporary_ttl` = 720 ledgers = 3600 s = exactly 1 hour.**
   The same code has a **24x shorter** guaranteed temporary lifetime on testnet than on
   pubnet. Anything whose correctness rests on a temporary entry outliving a UTC day is
   correct on pubnet and wrong on testnet, with no code difference. See S-1 and S-2.
3. **Target close time is a tunable in the range 4000-5000 ms** (CAP-0070, Protocol 23).
   At 4000 ms, 17280 ledgers is 69120 s = **19.2 hours**, which is less than a UTC day.
   A guarantee that holds today by exactly zero margin stops holding if validators tune
   the close time down. See S-1.

Sources:
- close-time tunable and its 4000-5000 ms range:
  https://github.com/stellar/stellar-protocol/blob/master/core/cap-0070.md
- current value 5000 ms: measured, section 0.1.

### 0.3 SDK and protocol

| Item | Value | Source |
| --- | --- | --- |
| `soroban-sdk` latest | 27.0.6, published 2026-08-13 | `gh release list --repo stellar/rs-soroban-sdk`; https://docs.rs/soroban-sdk/27.0.6/ |
| Protocol 27 content | CAP-0071 auth delegation + address-bound credentials | https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md |
| OpenZeppelin `stellar-contracts` | 0.7.1, "experimental software", audits in `audits/` | https://github.com/OpenZeppelin/stellar-contracts |

`soroban-sdk` 27.0.x release notes, all read from GitHub releases:

- **27.0.0** - CAP-71 auth delegation support (`CustomAccount::delegate_auth`,
  `CustomAccount::get_delegated_signers`); zero-copy `BytesN::from`.
- **27.0.1** - allowance expiration arg renamed to `live_until_ledger`.
- **27.0.2** - **`register_at` and native constructors switched to recording auth.**
  Relevant to any test that exercises `__constructor`; see V-4.
- **27.0.3** - refreshed `mainnet()` resource limits and fees; SAC event doc comments
  updated to CAP-67 shapes; documented constructor auth mocking on `register`.
- **27.0.4** - docs only (references mainnet limits instead of listing them).
- **27.0.5** - filter empty wasm hash from snapshot lookups; removed dead
  `TOPIC_BYTES_LENGTH_LIMIT`; more SAC event doc fixes.
- **27.0.6** - error on `contracttrait` without a trait impl; docs.

Nothing in 27.0.1 through 27.0.6 is a security fix. Source:
https://github.com/stellar/rs-soroban-sdk/releases

---

## 1. Authorization (A)

### A-1 `[P1]` `require_auth` is the entire authorization surface; nothing else substitutes

**Practice.** On Soroban there is no `msg.sender`. Authorization exists only where a
contract calls `Address::require_auth` or `require_auth_for_args`. The host does
authentication, replay prevention and nonce consumption on the contract's behalf, but only
for addresses the contract actually asks about.

**Why.** Maps to INV-01 and INV-02. A vault whose spend caps all pass but whose
`require_auth` is missing is drainable by anyone: a cap says how much may move, never who
may move it.

**Check.** For every mutating entrypoint, confirm the `require_auth` target is read from
**storage** (`Owner`, `Operator`), never taken from a function argument. An
argument-supplied address that authorizes itself is authorization theatre.

**Source.** https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
("the contract implementation doesn't need to worry about signatures, authentication, and
replay prevention ... as long as the Address type is used"), and
https://developers.stellar.org/docs/build/guides/auth/contract-authorization

### A-2 `[P1]` Authorize at the entry point, not only in the inner call

**Practice.** The docs are explicit: "it's recommended to authorize the `user` at the entry
point. Without that, the authorized inner call can be front-run by anyone."

**Why.** If `pay` relied on the token's own `from.require_auth()` rather than its own
`operator.require_auth()`, an authorization entry signed for the inner transfer could be
replayed outside the policy ladder. For this contract the `from` is the vault itself, so
the token's `from`-side check is satisfied structurally by the direct-call rule and gives
**zero** protection - exactly the point made in threat model section 3.

**Check.** Confirm `operator.require_auth()` happens in `pay` itself and is not delegated
to the token contract. Confirm no entrypoint relies on a downstream contract's auth.

**Source.** https://developers.stellar.org/docs/build/guides/auth/contract-authorization

### A-3 `[P1]` The signed auth tree must match the actual call path exactly

**Practice.** "If the `Address` signs a sequence of calls `A.foo->B.bar->C.baz`, then its
authorization check will fail in case if `A.foo` directly calls `C.baz`." Authorization
trees are matched structurally, and each `require_auth` call needs a corresponding node.

**Why.** Two consequences for Phase 3. First, adding or removing a cross-contract hop in a
future build silently invalidates previously signed auth entries, so the backend that holds
the operator key is coupled to the contract's call shape. Second, an auth tree root does not
have to be the top-level call, so "it's possible to e.g. batch the authorized call together"
with other calls in the same transaction. A signed `pay` auth entry can be bundled by
whoever holds it with arbitrary other operations.

**Check.** Whether the design assumes a `pay` authorization can only appear in a
transaction that does nothing else. It cannot.

**Source.** https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization

### A-4 `[P1]` `require_auth` vs `require_auth_for_args`

**Practice.** They differ only in which arguments the signer commits to.
`require_auth` commits to the invocation's own arguments. `require_auth_for_args` lets the
contract choose, and the docs warn it "should be used with care to ensure there is a
deterministic mapping between the contract invocation arguments and the
`require_auth_for_args` arguments."

**Why.** If a vault used `require_auth_for_args` and omitted `to` or `amount` from the
committed args, a signed authorization would be reusable for a different payee or a
different amount, defeating INV-05, INV-06 and INV-15 without touching any gate.

**Check.** If the contract uses `require_auth_for_args` anywhere, verify that every value
that the policy gates on is inside the committed argument set. If it uses plain
`require_auth`, confirm the entrypoint signature itself carries `to` and `amount` so the
signer commits to them.

**Source.** https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization

### A-5 `[P2]` Contract addresses and account addresses are indistinguishable to `require_auth`

**Practice.** "Developers do not need to consider the type of address used for
authorization; the authorization methods treat the two address types the same."

**Why.** The `owner` and `operator` may be C-addresses (custom accounts) as easily as
G-addresses. A C-address owner brings its own `__check_auth`, its own signer set, and after
Protocol 27 its own delegation chain (see P-1). The vault cannot assume a single keypair.

**Check.** Whether any doc, comment or off-chain assumption in the deployment story says
"the owner is a Stellar account". Also whether `Owner == Operator` rejection (INV-03) is the
only structural separation, since two distinct addresses can still be controlled by one
signer.

**Source.** https://developers.stellar.org/docs/build/guides/auth/contract-authorization

### A-6 `[P2]` Views must not require auth, and auth must not be skippable

**Practice.** Read-only entrypoints carry no `require_auth`, which is correct, but that also
means every view is world-readable and world-callable including in simulation.

**Why.** Maps to INV-04. A view that writes (for example one that extends a TTL as a side
effect of a read) is not a pure view: it can be called by anyone, it costs the caller a fee,
and it changes ledger state. That is usually benign but it is an unauthenticated write
path and must be reasoned about, not waved through.

**Check.** Enumerate every view. For each, confirm it writes nothing except TTL extension,
and that TTL extension by an arbitrary caller cannot be used to keep an entry alive that
the protocol logic wants expired (see S-3).

**Source.** https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization

### A-7 `[P2]` Constructor authorization is the deployer's authorization

**Practice.** "It doesn't really matter whether there are `require_auth` calls inside the
constructor; the address that authorizes creating the contract has to authorize the
constructor call in order to ensure atomicity." Constructor args are part of the
`createContractV2HostFn` variant of `SorobanAuthorizedFunction`.

**Why.** The threat model records `__constructor` as "no auth (atomic at deploy)". That is
correct but the reason is worth stating precisely: the deployer signs the constructor
arguments, so the owner/operator/token/cap values are committed at deploy time by whoever
deployed. There is no separate owner signature on them.

**Check.** Whether the deployment provenance records who signed the create-contract
operation for each of the two live deployments, since that address, not the `owner`
argument, is what actually authorized the initial policy.

**Source.** https://github.com/stellar/stellar-protocol/blob/master/core/cap-0058.md

### A-8 `[P3]` Contract re-entry is prohibited by the host

**Practice.** Verified at source, not from a blog. `soroban-env-host` defines
`ContractReentryMode { Prohibited, SelfAllowed, Allowed }`, and
`CallParams::default_external_call()` sets `reentry_mode: ContractReentryMode::Prohibited`.
Any re-entry in `Prohibited` mode returns
`ScErrorType::Context / ScErrorCode::InvalidAction` with the message
`"Contract re-entry is not allowed"`.

**Why.** Supports P-5 in the threat model. Classic EVM-style reentrancy against this vault
is blocked by the host, so the checks-effects-interactions ordering in `settle` is
defence in depth rather than the only defence. It does **not** protect against a malicious
token that fails, returns a wrong type, or consumes the whole budget - see T-1 and R-1.

**Check.** Confirm no code path relies on being able to re-enter (it would trap), and do
not accept "reentrancy is impossible" as a reason to skip the atomicity test for INV-12.

**Source.** https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/host/frame.rs
(lines around 24-34, 107-130, 1150-1182). Secondary:
https://stellar.org/blog/developers/sorobans-technical-design-decisions-learnings-from-ethereum
("Don't allow contract re-entry - which is what Soroban does!").

---

## 2. Storage durability, TTL and archival (S)

This is the highest-yield section for this contract.

### S-1 `[P1]` Never rely on a TTL extension for safety, and never rely on expiry for safety

**Practice.** Two verbatim rules from the official docs, and they cut in opposite
directions:

- "TTL extensions should never be relied on for functionality or safety."
- "Entry TTL exhaustion should never be relied on for functionality or safety."

Reinforced on the storage-selection page: "it is unsafe to rely on the extensions to
preserve data. There is always a risk of losing temporary data" and "it is unsafe to rely
on an entry expiring as it can be extended by anyone."

**Why.** This is INV-18 head on. A day-bucketed spend counter in temporary storage relies on
the entry surviving to the end of the UTC day. The docs say that reliance is unsafe as a
category. And because the guaranteed floor on pubnet is exactly 86400 s with zero margin
(section 0.2), the invariant currently holds by coincidence of a network parameter, not by
construction.

**Check.** Three separate questions for Phase 3:

1. What TTL does the `SpentOnDay(d)` entry actually get at creation, and is it extended?
2. If the entry expires mid-day, does the counter read as zero and reset the cap? The docs
   confirm temporary entries are unrecoverable: "When a `Temporary` entry's TTL is 0, it is
   deleted from the ledger and is permanently inaccessible" and "Temporary entries are gone
   forever when their TTL expires."
3. Does the contract's own TTL constant assume a 5 s ledger, and what happens at 4 s?

**Source.**
https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/persisting-data
and
https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage
and
https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival

### S-2 `[P1]` The same code has different durability on testnet and pubnet

**Practice.** `min_temporary_ttl` is 17280 on pubnet and 720 on testnet (section 0.1). It is
a network config setting, not a contract constant.

**Why.** A test suite or an e2e run against testnet cannot demonstrate INV-18. On testnet a
temporary entry created with only the protocol minimum dies after one hour. If the contract
does not explicitly extend `SpentOnDay`, the daily cap resets hourly on testnet and daily on
pubnet, from identical wasm (both deployments share sha256
`155eb31c...79239` per the threat model).

**Check.** Whether the contract sets an explicit temporary TTL rather than accepting the
protocol minimum. If it accepts the minimum, this is a live behavioural divergence between
the two advertised deployments and belongs in the report regardless of severity.

**Source.** measured, section 0.1. Semantics:
https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival
("For each entry type, there is a minimum TTL that the entry will have when being created or
restored. This TTL minimum is enforced automatically at the protocol level.")

### S-3 `[P1]` Anyone can extend any entry's TTL

**Practice.** "It is unsafe to rely on an entry expiring as it can be extended by anyone."

**Why.** The inverse risk to S-1. If any logic treats "the entry is gone" as meaning
"that day is over" or "that allowlist grant lapsed", an outsider can defeat it by paying to
extend the entry. For `Allowed(Address)` in persistent storage this matters: if a payee
grant is ever intended to lapse by archival rather than by an explicit `set_allowed(payee,
false)`, that expectation is not enforceable.

**Check.** Confirm allowlist revocation is an explicit write, never an expiry. Confirm the
day bucket is keyed by day so that a resurrected old entry can never be read as the current
day's total (INV-11).

**Source.** https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage

### S-4 `[P1]` Instance storage is one ledger entry with a hard byte cap

**Practice.** "All `Instance` storage is stored in a single contract instance `LedgerEntry`
and shares a single TTL." The live cap is `contract_data_entry_size_bytes = 65536` on both
networks, and `contract_data_key_size_bytes = 250`. The SDK docs describe instance storage
as being for "a small amount of persistent data" that "will be loaded from the ledger every
time the contract instance itself is loaded", with a maximum "in the order of 100 KB
serialized" - the live network value 65536 is the binding number, so prefer it.

**Why.** INV-19. An unbounded key in instance storage grows the single entry until it
exceeds 65536 bytes, at which point **every** entrypoint that loads the instance fails,
`withdraw` included, and with no upgrade path that is permanent. The threat model already
records the `Allowed(Address)` split as the defence; this section supplies the number that
makes the argument concrete.

**Check.** Confirm no untrusted-input-driven key lives in instance storage. Then bound the
worst case: 9 fixed instance keys is trivially safe, so the check is really "can anything
add a tenth".

**Source.** measured, section 0.1;
https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage
("The total size of all the keys and values in the instance storage is limited by the ledger
entry size limit ... on the order of tens to hundreds" of keys; "the network limit can never
go down, so the instance can't ever become non-valid");
https://docs.rs/soroban-sdk/latest/soroban_sdk/storage/struct.Storage.html

### S-5 `[P1]` Archival is recoverable for instance and persistent, unrecoverable for temporary

**Practice.** "When a `Persistent` or `Instance` entry TTL is 0, it is 'archived' and can't
be accessed until it is 'restored'." `RestoreFootprintOp` "will restore archived entries
specified in the read-write set of the footprint" and "**Only persistent and instance
entries can be restored.**" A restored persistent entry gets
`current_ledger_number + 4095`.

**Why.** Settles P-3 in the threat model. If the instance entry archives because no writing
entrypoint has been called for long enough, the `unwrap()`s on `Owner`/`Operator`/`Token`/
`Decimals` are unreachable rather than panicking on `None`, because the invocation fails
before the contract runs. Recovery is `RestoreFootprintOp`, so this is operator burden and a
liveness question, not permanent loss. That distinction should be stated plainly in the
finding rather than implied.

**Check.** Confirm the instance TTL floor. On pubnet `min_persistent_ttl = 2073600` ledgers
is 120 days at 5 s; `max_entry_ttl = 3110400` is 180 days. A 150-day extension constant is
inside the max and above the minimum, so it is valid. Then check whether any **view** path
extends the instance TTL, because a vault that is only read from never bumps.

**Source.**
https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival

### S-6 `[P2]` `extend_ttl` semantics and the off-by-one

**Practice.** The APIs are
`env.storage().persistent().extend_ttl(&key, threshold, extend_to)`,
`env.storage().instance().extend_ttl(threshold, extend_to)`,
`env.storage().temporary().extend_ttl(&key, threshold, extend_to)`,
with `get_ttl` counterparts. `Storage::max_ttl()` returns the network maximum. TTL
"is the number of ledgers left until the instance entry is considered expired, **excluding
the current ledger**", so "newly created entries have TTL one less than the minimum
setting."

**Why.** A `threshold` set equal to or above `extend_to` means the extension never fires or
always fires; both are silent. The off-by-one matters when asserting exact TTLs in tests.

**Check.** For each `extend_ttl` call, verify `threshold < extend_to` and that `extend_to`
does not exceed `max_ttl` (3110400) - the host rejects over-max extensions.

**Source.** https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension ;
https://docs.rs/soroban-sdk/latest/soroban_sdk/storage/struct.Storage.html

### S-7 `[P2]` OpenZeppelin explicitly does not manage instance TTL for you

**Practice.** The OZ Stellar suite states that developers must manage TTL for instance
storage items themselves; the library deliberately does not do it, for flexibility.

**Why.** Confirms there is no ecosystem-standard "TTL is handled" assumption to lean on.
Every contract owns this.

**Source.** https://docs.openzeppelin.com/stellar-contracts

---

## 3. Token integration (T)

### T-1 `[P1]` The token is an arbitrary external contract until proven otherwise

**Practice.** SEP-41 defines the interface, not the behaviour. A conforming address can
still be fee-on-transfer, rebasing, pausable, clawback-enabled or authorization-required.
The docs on mocking make the general point sharply: "Even if the contract publishes an
interface that says it'll return a bool (true/false), contracts can return any type."

**Why.** Threat model P-6. `balance()` is the input to INV-08 and `transfer()` is the
settlement for INV-05. If either lies, vault accounting is wrong while every gate passes.

**Check.** Whether the constructor does anything beyond reading `decimals()` to constrain
the token. It does not have to, but the report should say plainly that the constructor's
`decimals()` read is a SEP-41 liveness probe and not a safety property (threat model P-4).

**Source.** https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md ;
https://developers.stellar.org/docs/build/guides/testing/mocking

### T-2 `[P1]` SEP-41 `transfer` now takes `MuxedAddress` for `to`

**Practice.** Verified against soroban-sdk 27.0.6:

```rust
fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128);
fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128);
fn balance(env: Env, id: Address) -> i128;
fn decimals(env: Env) -> u32;
```

Note the asymmetry: `transfer` takes `MuxedAddress` for `to`, `transfer_from` takes plain
`Address`.

**Why.** Two things for Phase 3. First, if the vault stores or compares payee addresses as
`Address` but the token's `to` is a `MuxedAddress`, the allowlist key space and the transfer
target space are not the same type; confirm the conversion is total and cannot map two
distinct allowlist decisions onto one transfer, or vice versa. Second, `decimals`, `name`
and `symbol` "panic if the contract has not yet been initialized", which is the mechanism
behind the constructor's SEP-41 probe.

**Check.** How `Allowed(Address)` keys relate to whatever is passed as `to`, and whether a
muxed variant of an allowlisted address is treated as allowed or not allowed. Either answer
can be defended, but it must be deliberate (INV-15).

**Source.** https://docs.rs/soroban-sdk/27.0.6/soroban_sdk/token/trait.TokenInterface.html ;
https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md

### T-3 `[P1]` SAC balances held by a contract can be frozen or clawed back by the issuer

**Practice.** For a contract address, the SAC stores "the balance and authorization state
... in contract storage, as opposed to a trustline"; no trustline is needed. If the issuer
has `AUTH_REQUIRED_FLAG`, a contract address "must be explicitly authorized before receiving
balances". With `AUTH_REVOCABLE_FLAG` the admin can deauthorize. With
`AUTH_CLAWBACK_ENABLED_FLAG` set when the balance was created, the issuer can claw the
balance back. Contract balances are 128-bit signed.

**Why.** The vault holds real Circle USDC. Circle is the issuer. A clawback or
deauthorization changes the vault's balance out from under the accounting with no
transaction from either role. INV-08 is a point-in-time check, so it survives; but any
assumption that `balance()` only decreases through `pay`/`owner_pay`/`withdraw` does not.

**Check.** Whether the contract ever caches a balance across calls, and whether the daily
counter's relationship to the balance is ever assumed rather than re-read. Also whether
`withdraw` reachability (INV-20) accounts for a deauthorized vault balance.

**Source.** https://developers.stellar.org/docs/tokens/stellar-asset-contract

### T-4 `[P2]` Protocol 26 added network-level entry freezing; pubnet is using it

**Practice.** CAP-0077 lets validators freeze contract data, contract code, account and
trustline ledger entries via a network config upgrade. "Transactions attempting to access
frozen keys are rejected at validation time with a `txFROZEN_KEY_ACCESSED` error", with a
`freezeBypassTxs` escape hatch. Pubnet currently lists **3 frozen keys** and an empty bypass
list (section 0.1).

**Why.** This is a new, live, protocol-level way for a value-holding contract to become
uninvocable that did not exist before Protocol 26 and that no contract-side code can
mitigate. It belongs in the availability analysis behind INV-20 alongside archival.

**Check.** Nothing to fix in code. State it as a residual risk, note that it requires
validator consensus and is on-chain observable, and note that the current 3 frozen pubnet
keys are not this contract's (verify by comparing key hashes if Phase 3 wants to be
exhaustive).

**Source.** https://github.com/stellar/stellar-protocol/blob/master/core/cap-0077.md
("Every Stellar validator has an inherent ability to censor the traffic ... The 'censorship'
mechanism introduced in this CAP is easily observable and requires consensus of validators
and thus it is not providing any new risks or attack angles.")

---

## 4. Errors and typed refusals (E)

### E-1 `[P1]` `panic_with_error!` with `#[contracterror]`, not bare `panic!`

**Practice.** A contract can either return `Result<_, Error>` or call `panic_with_error!`.
"By default, most ecosystem standards assume that contract functions do not return a
`Result`, so using `panic_with_error!` is recommended." Both behave identically for state:
"if an error is returned or `panic_with_error!` is invoked, the transaction will fail" and
"anything the function has done is rolled back."

**Why.** The product claim here is the typed refusal (threat model section 2). A bare
`panic!`, `unwrap()`, `expect()` or `assert!` produces an untyped trap, which is exactly the
opaque failure the product says it does not have. Scout flags all four as detectors
(`unsafe-unwrap`, `unsafe-expect`, `avoid-panic-error`, `assert-violation`).

**Check.** Grep for `panic!`, `assert!`, `unwrap()`, `expect()` on any path reachable from a
refusal. Distinguish the P-3 instance `unwrap()`s (unreachable except via archival, and
archival fails before the contract runs) from any `unwrap()` on a gate path.

**Source.** https://developers.stellar.org/docs/build/smart-contracts/example-contracts/errors ;
https://developers.stellar.org/docs/build/guides/conventions/error-enum ;
https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities

### E-2 `[P1]` Error codes are a wire ABI; renumbering is a breaking change

**Practice.** `#[contracterror]` enums are `u32` and every variant is assigned an integer.

**Why.** INV-22. Two live deployments and a documented refusal ladder (INV-17) mean the
numbers are consumed off-chain. With no upgrade path, the deployed numbering is frozen
forever on those two addresses; any future build that renumbers creates a contract whose
error 5 means something different from the live one's error 5.

**Check.** That the enum is explicitly numbered rather than relying on declaration order,
and that a test pins each numeric value. Then check the ladder order (INV-17) is what the
public error table claims, since ordering is observable and branchable.

**Source.** https://developers.stellar.org/docs/build/guides/conventions/error-enum

### E-3 `[P2]` `panic!` inside a contract poisons fuzzing

**Practice.** Veridise: "Never call `panic!` and related functions to handle errors that may
occur during normal operation: the fuzzer views panics as bugs." Use `panic_with_error!` so
expected refusals are distinguishable from real crashes.

**Why.** A fuzz campaign against a contract that panics on ordinary refusals reports a
finding on the first refused payment and stalls there, hiding real bugs behind noise.

**Check.** Before running any fuzzing in Phase 2 or 5, confirm the harness can distinguish
"policy refused" from "contract crashed". If it cannot, the fuzz results are not evidence.

**Source.** https://veridise.com/blog/audit-insights/building-on-stellar-soroban-grab-this-security-checklist-to-avoid-vulnerabilities/

---

## 5. Testing and verification (V)

### V-1 `[P1]` `mock_all_auths` without `env.auths()` assertions proves nothing

**Practice.** Quoted verbatim from the soroban-sdk 27.0.6 docs for `Env::mock_all_auths`:

> "A test that uses `mock_all_auths` without verifying the resulting authorization tree via
> `auths()` can pass even when a contract is missing a `require_auth` check."

**Why.** This is the single most load-bearing testing rule for this contract. Threat model
section 3 states that deleting `operator.require_auth()` leaves every policy gate passing
while the vault becomes drainable. A suite built on `mock_all_auths` alone passes
identically against that mutant. Phase 2's mutation run should be expected to surface it.

**Check.** For every auth-relevant test: does it assert on `env.auths()`, and does the
assertion pin the **address** and the **arguments**, not just the count? `auths()` returns
`Vec<(Address, AuthorizedInvocation)>` from the last invocation.

**Source.** https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Env.html

### V-2 `[P1]` Negative authorization tests need `mock_auths` or `set_auths`, not `mock_all_auths`

**Practice.** `mock_auths` "selectively mocks specific authorizations. Only matching auth
invocations succeed; unmatched calls fail." `set_auths` "sets authorizations requiring valid
signatures for success. If mocking is already enabled, calling this disables it, reverting
to signature validation."

**Why.** INV-01 and INV-02 are negative properties: "succeeds **only if**". You cannot prove
an "only if" with a mock that makes everything succeed. The proof shape is: authorize the
wrong address, assert the call fails with the right error.

**Check.** That there is at least one test per owner-gated entrypoint where a non-owner
address is the one that authorizes, and one for `pay` where a non-operator authorizes. Nine
mutating entrypoints means at least nine such tests.

**Source.** https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Env.html

### V-3 `[P2]` `mock_all_auths_allowing_non_root_auth` hides front-running

**Practice.** It "permits authorizations outside the root invocation. This suits testing
contracts bundling calls without atomicity requirements, where any contract call could be
frontrun." The auth starter guide separately notes that `mock_all_auths()` "skips
`__check_auth()`" so it gives no coverage of custom-account logic; test that via
`env.try_invoke_contract_check_auth`.

**Why.** Directly connects to A-3: an authorization whose root is not the top-level call can
be bundled by anyone. If the suite uses the non-root-auth variant, it has assumed away
exactly that risk.

**Check.** Grep for `mock_all_auths_allowing_non_root_auth`. If present, ask why.

**Source.** https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Env.html ;
https://developers.stellar.org/docs/build/guides/auth/contract-authorization

### V-4 `[P2]` Constructor auth behaviour changed inside the 27.0.x line

**Practice.** soroban-sdk **27.0.2** switched `register_at` and native constructors to
**recording auth**. 27.0.3 added docs for constructor auth mocking on `register`. The
testing docs add: "constructor auth checks succeed for contracts registered with either
function, without requiring `mock_all_auths()` to be called first", and "to have auth in a
constructor execute as it will in production the contract must be deployed in the test using
the standard deployment functions after being built to Wasm."

**Why.** A constructor test that passes under the native test registration is not evidence
about production constructor auth. This contract's entire initial policy is set in
`__constructor` and there is no `set_owner`, so a constructor bug is unfixable.

**Check.** Whether the constructor tests use native registration or a real wasm deployment.
If native only, the constructor's production auth path is untested.

**Source.** https://github.com/stellar/rs-soroban-sdk/releases/tag/v27.0.2 ;
https://developers.stellar.org/docs/build/guides/testing/test-contract-auth

### V-5 `[P1]` TTL behaviour is testable; test it against both networks' parameters

**Practice.** `env.ledger().with_mut(|li| { ... })` exposes `sequence_number`,
`min_persistent_entry_ttl`, `min_temp_entry_ttl`, `max_entry_ttl`. Read TTLs back with
`env.storage().temporary().get_ttl(&key)`, `.persistent().get_ttl(&key)`,
`.instance().get_ttl()`, inside `env.as_contract(&contract_id, || { ... })`.

**Why.** This is how INV-18 becomes a test rather than an argument. Set
`min_temp_entry_ttl = 720` (testnet) and `= 17280` (pubnet), advance `sequence_number` by
17280, and assert the day counter is still readable.

**Check.** Does the suite contain any such test at all? If it does, does it use the real
network values from section 0.1 or invented ones?

**Source.** https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension

### V-6 `[P2]` Prefer integration tests against the real token over mocks

**Practice.** "Mocking introduces assumptions about the behavior of another contract ...
contracts can return any type." The docs recommend testing against a real contract, noting
"the Soroban Rust SDK makes it just as easy to test against a real contract as it does to
test against a mock."

**Why.** The vault's money paths all run through the token. A mock token that always
succeeds cannot demonstrate INV-12 (a failing transfer leaves `SpentOnDay` unchanged).

**Check.** Whether the atomicity test uses a token that can be made to fail. The SDK ships
`StellarAssetClient` for registering a real SAC in tests.

**Source.** https://developers.stellar.org/docs/build/guides/testing/mocking ;
https://docs.rs/soroban-sdk/latest/soroban_sdk/token/struct.StellarAssetClient.html

### V-7 `[P2]` Fuzzing setup requirements

**Practice.** `cargo-fuzz` over libfuzzer, nightly toolchain required. The contract crate
must declare `crate-type = ["cdylib", "rlib"]` and must expose the `testutils` feature,
because "when `testutils` is activated, the Soroban SDK's `contracttype` macro emits
additional code needed for running fuzz tests." On macOS add `--sanitizer=thread` to work
around a known linking issue. Fuzz tests can be reused as property tests via `proptest` and
`proptest-arbitrary-interop`.

**Why.** Relevant because the toolchain here is pinned to Rust 1.96.0 and the target is
`wasm32v1-none`; fuzzing needs a native nightly build, which is a different build
configuration from the deployed artifact. Anything found by fuzzing must be re-confirmed
against the wasm profile, especially anything overflow-related, since
`overflow-checks = true` is a profile setting the fuzz build may not share.

**Check.** Whether the crate is already `rlib`-capable. If it is `cdylib` only, fuzzing
requires a manifest change, which is a finding-adjacent observation about verifiability
rather than a vulnerability.

**Source.** https://developers.stellar.org/docs/build/guides/testing/fuzzing ;
https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fuzzing

---

## 6. Arithmetic, resources and DoS (R)

### R-1 `[P2]` Per-transaction budget is finite and the token spends from it

**Practice.** Live pubnet limits (section 0.1): `tx_max_instructions` 400,000,000,
`tx_memory_limit` 41,943,040 bytes, `tx_max_disk_read_entries` 200,
`tx_max_write_ledger_entries` 200, `tx_max_footprint_entries` 400,
`tx_max_contract_events_size_bytes` 16,384.

**Why.** A hostile or merely expensive token can consume the transaction budget inside
`transfer()`, causing `pay` to fail after `SpentOnDay` was written. Because the whole
invocation rolls back together, INV-12 survives - but the failure mode is a griefing vector
against INV-20 if it also affects `withdraw`. Also relevant to INV-21: 16 KB is the
per-transaction event budget, so events are not free.

**Check.** Confirm `withdraw` has the shortest possible path (no allowlist read, no day
bucket write) so it remains affordable under adverse conditions.

**Source.** measured, section 0.1;
https://developers.stellar.org/docs/networks/resource-limits-fees

### R-2 `[P2]` Do not rely on the release profile for overflow safety

**Practice.** Scout classes `integer-overflow-or-underflow` as Critical, noting arithmetic
"create[s] numeric values outside valid range when overflow-checks are disabled". Values are
`i128` throughout SEP-41.

**Why.** The threat model already says not to assume `overflow-checks = true` persists.
This is the ecosystem source that agrees. Explicit `checked_add` is the correct posture.

**Check.** Every arithmetic op on money or time paths uses a checked/saturating form, and
each has a defined behaviour on overflow that maps to a typed error rather than a trap
(INV-17). Also check `divide-before-multiply` if any proportional math exists.

**Source.** https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities

### R-3 `[P2]` Unbounded storage is the documented Soroban DoS class

**Practice.** Veridise: "Ensure that unbounded data is not stored in Instance Storage, as it
loads all data with each contract interaction, leading to increased costs and potential DoS
vulnerabilities. Additionally, even Persistent Storage risks issues if data accumulates in
single structures rather than distributed slots." Scout has `dos-unbounded-operation` and
`dos-unexpected-revert-with-vector` ("use Mapping instead of Vec").

**Why.** INV-19. The `Allowed(Address)` design (one persistent entry per payee, not a Vec in
instance storage) is the recommended shape. Confirm that is what is implemented and that
nothing iterates the allowlist.

**Check.** No `Vec` accumulates in storage. No loop's iteration count is attacker-controlled.

**Source.** https://veridise.com/blog/audit-insights/building-on-stellar-soroban-grab-this-security-checklist-to-avoid-vulnerabilities/ ;
https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities

### R-4 `[P3]` `Vec<T>` / `Map<K,V>` round-tripping through the host is not type-safe

**Practice.** Veridise: "When the elements of a `Vec<T>` or `Map<K, V>` are transmitted to
the Host environment, they are converted to `Val`s. However, there is no guarantee that these
values can be properly converted back to their expected types ... attempting to retrieve and
use them later could halt contract execution."

**Why.** Only applies if the contract stores or accepts collections. Probably not applicable
here (9 scalar instance keys, scalar persistent and temporary values), in which case Phase 3
should mark it `n/a` explicitly rather than omit it.

**Source.** https://veridise.com/blog/audit-insights/building-on-stellar-soroban-grab-this-security-checklist-to-avoid-vulnerabilities/

---

## 7. Time (C)

### C-1 `[P1]` Ledger close time is validator-influenced, monotonic, and up to 60 s ahead

**Practice.** "The close time is a UNIX timestamp indicating when the ledger closes. Its
accuracy depends on the system clock of the validator proposing the block. Consequently, SCP
may confirm a close time that lags a few seconds behind or up to 60 seconds ahead." It is
"strictly monotonic - guaranteed to be greater than the close time of an earlier ledger."

**Why.** The UTC day boundary (INV-05, INV-11, INV-18) and the session key expiry (INV-14)
are both computed from this timestamp. A validator can push the clock up to 60 seconds
forward. That means: the day boundary can be crossed up to 60 s early, giving one extra
partial cap window per day at the margin; and a session key can be made to appear expired up
to 60 s early. Both are small, both are real, and neither is a bug so much as a documented
bound that the finding should state.

**Check.** Whether any logic treats the timestamp as exact rather than as a bound. Whether
`SessionKeyExpiry` comparison is `>` or `>=` at the boundary, given a 60 s uncertainty band
makes exact-boundary behaviour unobservable in practice but still worth pinning in a test.

**Source.** https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/ledgers

### C-2 `[P2]` Timestamps are not randomness

**Practice.** Scout classes `insufficiently-random-values` as Critical: using predictable
block attributes such as timestamp for randomness enables manipulation.

**Why.** Not expected to apply here. Mark `n/a` if the contract derives nothing but the day
index and the session comparison from the clock.

**Source.** https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities

---

## 8. Protocol 27 specifics (P)

### P-1 `[P1]` CAP-0071: auth delegation changes who can satisfy `require_auth`

**Practice.** Protocol 27 activates CAP-0071, split into CAP-71-01 (authentication
delegation) and CAP-71-02 (address-bound credentials V2). Three new credential types:
`SOROBAN_CREDENTIALS_ADDRESS_V2`, `SOROBAN_CREDENTIALS_ADDRESS_WITH_DELEGATES`, and envelope
type `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS`.

Delegation: a custom (contract) account can delegate its `__check_auth` to another address
via the `delegate_account_auth` host function, "which may only be called from within a
contract's reserved `__check_auth` function". Delegation can nest. soroban-sdk 27.0.0 exposes
this as `CustomAccount::delegate_auth` and `CustomAccount::get_delegated_signers`.

**Why.** This is the protocol-27 fact most relevant to this contract. If the `owner` or
`operator` is a C-address, the set of keys that can satisfy `owner.require_auth()` is now
determined by that account's delegation chain, which the vault cannot see and cannot bound.
The vault's trust model says "the owner is trusted for everything"; after Protocol 27 that
trust extends transitively through an arbitrary delegation chain.

**Important:** the CAP is explicit that this does **not** change what `require_auth`
guarantees to the calling contract. It "simply provides a standardized protocol mechanism for
accounts to implement authentication delegation internally, rather than relying on
workarounds within the authorization framework." So this is a trust-model note, not a
vulnerability.

**Check.** Whether the live `owner` and `operator` on pubnet are G-addresses or C-addresses.
If G-addresses, delegation does not apply and the note is informational. Record which.

**Source.** https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md ;
https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071-01.md
(Security Concerns, verbatim: "Delegated signers increase the account implementation
complexity and thus may increase the probability of it being vulnerable to exploits. However,
this CAP doesn't significantly change the risk surface, as similar functionality already
exists in the protocol.") ;
https://github.com/stellar/rs-soroban-sdk/releases/tag/v27.0.0

### P-2 `[P2]` CAP-71-02: address-bound credentials fix a shared-key replay gap

**Practice.** The legacy `SOROBAN_CREDENTIALS_ADDRESS` payload does not include the signer's
address. Where multiple accounts share private keys and the payload does not otherwise bind
the signer, that permits replay across those accounts.
`SOROBAN_CREDENTIALS_ADDRESS_V2` binds the address into the signed payload.

Verbatim: "This CAP improves replay protection for non-delegated address credentials in
shared-key scenarios." And: "This CAP does not introduce any backward incompatibilities.
However, the old credential type may be considered deprecated in the future."

**Why.** Contract-side, "contracts themselves experience no changes ... The distinction is
transparent at the contract level." It is the **client** that opts in. So this is a note for
whichever component signs `pay` authorizations (the out-of-scope backend), not for the
contract. Worth one line in the report so the reader knows it was considered and dismissed
for the right reason.

**Check.** `n/a` for the contract. Flag to the maintainer that the signing client should
prefer V2 credentials, and that the old type may be deprecated.

**Source.** https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071-02.md

### P-3 `[P2]` Protocol 23 through 26 context worth knowing

- **Protocol 23 (Whisk, 2025-09-03)** - unified Classic and Soroban event streams; SAC emits
  mint/burn instead of transfer when the issuer is involved; new fee events; CAP-0070 made
  ledger close time a configurable setting (see 0.2).
- **Protocol 24 (2025-10-22)** - stability release; **constructor support in Soroban**.
- **Protocol 25 (2026-01-22)** - CAP-0074 BN254 host functions, CAP-0075 Poseidon hashes.
- **Protocol 26 (2026-05-06)** - CAP-0073 SAC creating G-account balances, **CAP-0077 freezing
  ledger entries** (see T-4). The SAC docs also reference a `trust` function for creating
  trustlines from contracts, added in Protocol 26.
- **Protocol 27 (testnet 2026-06-18)** - CAP-0071.

Note for INV-21: soroban-sdk 27.0.3 and 27.0.5 both updated SAC event doc-comments to
**CAP-67 shapes**. If Phase 3 or an off-chain consumer parses SAC events (as opposed to this
contract's own 7 events), the shapes changed. This contract's own events are unaffected.

**Source.** https://developers.stellar.org/docs/networks/software-versions ;
https://github.com/stellar/rs-soroban-sdk/releases

---

## 9. No upgrade path (U)

### U-1 `[P1]` Absence of `update_current_contract_wasm` is a defensible choice, and Scout agrees

**Practice.** Scout's Critical detector is
`unprotected-update-current-contract-wasm`: "Users are allowed to call
`update_current_contract_wasm()`, they can intentionally modify the contract." The Stellar
guide on upgrading stresses "Admin authorization: Before upgrading, the contract checks if
the action is authorized by the `Admin` address. This is crucial to prevent unauthorized
upgrades."

**Why.** Threat model P-1 frames the absent upgrade path as a cost. It is also a removed
attack surface: there is no upgrade function to leave unprotected, and the deployed wasm
hash is a permanent commitment. The report should present it as a trade-off with both signs,
not only as a liability.

**Check.** Confirm the absence by grep (the threat model already did). Then confirm the
documented remediation path (`withdraw`, redeploy, repoint) is actually reachable: it depends
entirely on INV-20, which depends on S-5 (instance archival is restorable) and T-3 (the
balance is not deauthorized). Those three form one chain and should be assessed together.

**Source.** https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities ;
https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts

### U-2 `[P2]` No owner rotation: compare against the ecosystem-standard Ownable

**Practice.** OpenZeppelin's Stellar `Ownable` uses a **two-step** transfer: "The current
owner initiates transfer by specifying the new owner and expiration ledger" and "the
designated new owner must explicitly accept". "Until the transfer is accepted, the original
owner retains full control and can override or cancel the transfer." It also exposes
`renounce_ownership()` with the warning "Once `renounce_ownership()` is called, there is no
way to restore ownership." The `#[only_owner]` macro "expands to code that retrieves the
owner from storage and requires authorization before executing the function body."

**Why.** Threat model P-2: no `set_owner` at all. That is stricter than OZ's default and
avoids the classic one-step-transfer-to-a-typo failure entirely, at the cost of permanent key
risk. The `#[only_owner]` expansion description is also a useful independent confirmation of
A-1: the owner is read **from storage**, then authorized.

**Check.** State the trade-off explicitly against this named ecosystem baseline rather than
asserting "no rotation is bad". Note that OZ's own guidance treats permanent loss of
ownership as an accepted, documented outcome (`renounce_ownership`), so a deliberately
non-rotatable owner is within ecosystem norms for a small-balance single-tenant vault.

**Source.** https://docs.openzeppelin.com/stellar-contracts/access/ownable ;
https://github.com/OpenZeppelin/stellar-contracts

### U-3 `[P3]` OpenZeppelin Stellar contracts are audited but self-described as experimental

**Practice.** README, verbatim: "This is experimental software and is provided on an 'as is'
and 'as available' basis. We do not give any warranties and will not be liable for any losses
incurred through any use of this code base." Current version 0.7.1. Audits live in
`audits/`; published reports cover 0.1.0, v0.3.0-rc.2 and RC v0.7.0. SDF and OpenZeppelin
have a two-year partnership with 40 auditor-weeks allocated and a bug bounty for the library.
There is a `vault` module in the token namespace.

**Why.** If Phase 4 proposes "use OpenZeppelin instead" for any remediation, that
recommendation carries an experimental-software disclaimer and a version-pinning obligation.
The existence of an OZ `vault` module is worth a look as a comparison baseline for shape,
though it is an ERC-4626-style tokenised vault and probably not the same primitive as this
spend-policy vault. `UNVERIFIED` whether OZ's vault module is a relevant comparison; not
inspected.

**Source.** https://github.com/OpenZeppelin/stellar-contracts ;
https://docs.openzeppelin.com/stellar-contracts ;
https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit ;
https://stellar.org/blog/foundation-news/sdf-partners-with-openzeppelin-to-enhance-stellar-smart-contract-development

---

## 10. Tooling Phase 2 can run

| Tool | What it gives | Source |
| --- | --- | --- |
| `cargo-scout-audit` / scout-soroban | ~21 Soroban detectors, listed in section 11 | https://github.com/CoinFabrik/scout-audit ; https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities |
| `cargo-fuzz` (nightly, `--sanitizer=thread` on macOS) | libfuzzer over contract entrypoints | https://developers.stellar.org/docs/build/guides/testing/fuzzing |
| `proptest` + `proptest-arbitrary-interop` | fuzz harnesses reused as property tests | https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fuzzing |
| `stellar network settings` | live limits, the numbers in section 0.1 | https://developers.stellar.org/docs/networks/resource-limits-fees |
| Stellar Lab network limits | same, in a browser | https://lab.stellar.org/network-limits |
| Soroban Security Portal (Inferara) | database of Soroban audits and vulnerability reports | https://developers.stellar.org/docs/tools/developer-tools/security-tools |
| Soroban Security Detector SDK | build custom static-analysis scanners, ships prebuilt checks | https://developers.stellar.org/docs/tools/developer-tools/security-tools |
| Stellar threat-modeling guide | SDF's own methodology, for cross-checking Phase 0 | https://developers.stellar.org/docs/build/security-docs/threat-modeling/threat-modeling-how-to |
| Code coverage guide | lcov into the IDE, Coverage Gutters | https://developers.stellar.org/docs/build/guides/testing/code-coverage |

`UNVERIFIED`: I did not run Scout, the Security Portal, or the Detector SDK, and did not
confirm they currently support soroban-sdk 27.x. Phase 2 must confirm tool/SDK compatibility
before treating a clean run as evidence.

---

## 11. Scout detector list (for Phase 2 triage)

Full published list, with Scout's own severity labels. Reproduced so Phase 3 can mark each
applicable / `n/a` rather than leaving gaps.

| Detector | Severity |
| --- | --- |
| Integer overflow or underflow | Critical |
| Insufficiently random values | Critical |
| Unprotected update of current contract wasm | Critical |
| Set contract storage | Critical |
| Avoid unsafe block | Critical |
| Unprotected mapping operation | Critical |
| Unrestricted transfer from | Critical |
| Incorrect exponentiation | Critical |
| Divide before multiply | Medium |
| Unsafe unwrap | Medium |
| Unsafe expect | Medium |
| DoS unbounded operation | Medium |
| DoS unexpected revert with vector | Medium |
| Unsafe map get | Medium |
| Zero or test address | Medium |
| Unused return enum | Minor |
| Avoid `core::mem::forget` | Enhancement |
| Avoid panic error | Enhancement |
| Soroban version | Enhancement |
| Iterators over indexing | Enhancement |
| Assert violation | Enhancement |

Two are worth calling out for this contract specifically:

- **Unrestricted transfer from** (Critical): "Allowing arbitrary `from` addresses in
  transfers might enable the withdrawal of funds from any actor." Here the `from` is always
  the vault itself, which is why the token's `from`-side auth gives nothing (A-2). Confirm
  no path lets a caller choose `from`.
- **Zero or test address** (Medium): "Assigning zero address can lead to loss of control over
  the contract" permanently. Soroban has no zero address in the EVM sense, but the analogue
  here is a constructor that accepts an owner the deployer does not control. With no
  `set_owner`, that is unrecoverable. Check the constructor's validation of `owner`,
  `operator` and `token` beyond `owner != operator` and the `decimals()` probe.

**Source.** https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities

---

## 12. Cross-reference: invariant to check

Convenience index. An invariant absent from this table has no best-practice item in this
briefing and must be argued from the code alone.

| Invariant | Items in this briefing |
| --- | --- |
| INV-01, INV-02 (auth) | A-1, A-2, A-4, A-5, V-1, V-2, U-2 |
| INV-03 (owner != operator) | A-5, section 11 (zero-or-test-address) |
| INV-04 (views do not mutate) | A-6, S-3 |
| INV-05, INV-06 (caps) | A-4, R-2, C-1 |
| INV-07, INV-11, INV-12 (accounting) | A-8, R-1, S-3, V-6 |
| INV-08 (balance) | T-1, T-3 |
| INV-09, INV-10 (amount and payee validity) | R-2, T-2 |
| INV-13, INV-14, INV-15 (policy semantics) | C-1, S-3, T-2 |
| INV-16 (zero means unbounded) | E-2, C-1 |
| INV-17 (refusal ladder) | E-1, E-2, R-2 |
| INV-18 (day bucket durability) | **S-1, S-2, S-5, S-6, V-5, C-1** |
| INV-19 (instance bounded) | **S-4, R-3** |
| INV-20 (withdraw reachable) | **S-5, T-3, T-4, R-1, U-1** |
| INV-21 (events) | R-1, P-3 |
| INV-22 (stable error codes) | E-1, E-2 |

---

## 13. What I could not verify

- The numeric limits page at `developers.stellar.org/docs/networks/resource-limits-fees`
  carries **no numbers**; it defers to Stellar Lab and the CLI. Section 0.1 is therefore a
  measurement with a date, not a citation, and will drift.
- `rs-soroban-sdk` has no `CHANGELOG.md` on `main` (404). Release notes on GitHub Releases
  are the only version history; section 0.3 is compiled from those.
- I found no single official Stellar "smart contract security best practices" page. The
  `docs/build/security-docs` section covers threat modeling, on-chain monitoring and web
  security, not Soroban contract vulnerability classes. The vulnerability-class material in
  this briefing comes from Veridise and CoinFabrik, which are reputable ecosystem sources
  but are **not** SDF-official. Weighted accordingly in the report.
- Whether Scout, the Soroban Security Portal, or the Security Detector SDK support
  soroban-sdk 27.x. Not tested.
- Whether OpenZeppelin's `tokens/vault` module is a meaningful comparison baseline for this
  contract's shape. Not inspected.
- The identity of the 3 currently frozen pubnet ledger keys (section 0.1). Not decoded.
- Exact `min_temporary_ttl` on futurenet or any other network. Only pubnet and testnet were
  measured.

---

## 14. Source index

Stellar official:

- https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
- https://developers.stellar.org/docs/build/guides/auth/contract-authorization
- https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival
- https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/persisting-data
- https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage
- https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension
- https://developers.stellar.org/docs/build/guides/testing/test-contract-auth
- https://developers.stellar.org/docs/build/guides/testing/fuzzing
- https://developers.stellar.org/docs/build/guides/testing/mocking
- https://developers.stellar.org/docs/build/guides/testing/code-coverage
- https://developers.stellar.org/docs/build/guides/conventions/error-enum
- https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts
- https://developers.stellar.org/docs/build/smart-contracts/example-contracts/errors
- https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fuzzing
- https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/ledgers
- https://developers.stellar.org/docs/networks/resource-limits-fees
- https://developers.stellar.org/docs/networks/software-versions
- https://developers.stellar.org/docs/tokens/stellar-asset-contract
- https://developers.stellar.org/docs/tools/developer-tools/security-tools
- https://developers.stellar.org/docs/build/security-docs/threat-modeling/threat-modeling-how-to
- https://lab.stellar.org/network-limits

Protocol CAPs and SEPs:

- https://github.com/stellar/stellar-protocol/blob/master/core/cap-0058.md (constructors)
- https://github.com/stellar/stellar-protocol/blob/master/core/cap-0070.md (close time)
- https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md (P27 auth)
- https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071-01.md (delegation)
- https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071-02.md (address-bound)
- https://github.com/stellar/stellar-protocol/blob/master/core/cap-0077.md (entry freezing)
- https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md (token)

SDK and host:

- https://docs.rs/soroban-sdk/27.0.6/soroban_sdk/token/trait.TokenInterface.html
- https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Env.html
- https://docs.rs/soroban-sdk/latest/soroban_sdk/storage/struct.Storage.html
- https://docs.rs/soroban-sdk/latest/soroban_sdk/token/struct.StellarAssetClient.html
- https://github.com/stellar/rs-soroban-sdk/releases
- https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/host/frame.rs

OpenZeppelin:

- https://github.com/OpenZeppelin/stellar-contracts
- https://docs.openzeppelin.com/stellar-contracts
- https://docs.openzeppelin.com/stellar-contracts/access/ownable
- https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit
- https://www.openzeppelin.com/news/stellar-contracts-library-v0.3.0-rc.2-audit
- https://www.openzeppelin.com/news/stellar-contracts-library-0.1.0-audit
- https://stellar.org/blog/foundation-news/sdf-partners-with-openzeppelin-to-enhance-stellar-smart-contract-development

Ecosystem (not SDF-official, weight accordingly):

- https://veridise.com/blog/audit-insights/building-on-stellar-soroban-grab-this-security-checklist-to-avoid-vulnerabilities/
- https://coinfabrik.github.io/scout-soroban/docs/vulnerabilities
- https://github.com/CoinFabrik/scout-audit
- https://stellar.org/blog/developers/sorobans-technical-design-decisions-learnings-from-ethereum
