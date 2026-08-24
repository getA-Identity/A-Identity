# R3 - Advisory sweep: dependency tree, pinned SDK, protocol deltas

Phase 1 research deliverable. Companion to `audit/00-threat-model.md`.

Every claim below carries a URL or a local file path. Everything was run or fetched on
**2026-08-24** (UTC times shown where the tool printed them). Nothing here is recalled
from memory. Raw tool output is under `audit/tool-output/`.

Scope reminder: this file does not review the contract's own source. Where a finding
touches contract behaviour it is stated as an input for Phase 3, not as a verdict.

---

## 0. Verdict

**The pin `soroban-sdk = "=27.0.6"` is safe to stay on. Do not move it.**

- 27.0.6 is the newest published version of the crate, is not yanked, and is the newest
  release of the repository. There is nothing to upgrade to.
  (`audit/tool-output/crates-io-and-open-issues.txt`,
  `audit/tool-output/sdk-releases-list.txt`)
- Zero RustSec vulnerabilities across all 215 locked dependencies.
  (`audit/tool-output/cargo-audit.txt`)
- All four published GitHub Security Advisories against the Stellar Rust stack have
  fixed-version ranges that 27.0.6 sits above. None applies.
  (`audit/tool-output/github-security-advisories.txt`)
- The one advisory that does fire, `RUSTSEC-2024-0436` on `paste`, is an *unmaintained*
  notice, not a vulnerability, and `paste` is not reachable from the wasm build at all.

That said, the sweep produced **five actionable items**, none of which is "bump the SDK".
They are collected in section 6. The two that matter most:

1. **`cargo audit` gives this project zero coverage of the crates that matter.** The
   RustSec database contains no advisory mentioning `soroban` or `stellar` anywhere,
   while GitHub has four. The CI step named "Advisory audit" is therefore structurally
   incapable of catching a soroban-sdk advisory, and Dependabot alerts (which *would*
   catch them) are disabled on both remotes.
2. **`min_temporary_ttl` on pubnet buys exactly 27.0 hours today, and the break-even
   point against a 24 hour UTC day is a ledger close time of exactly 5.0000 s.** Testnet
   already runs at 5.010 s and sets `min_temporary_ttl` to 720 ledgers, which is
   **1.002 hours**. INV-18 has a much thinner and much more network-dependent margin than
   the threat model assumes.

---

## 1. Dependency tree and RustSec

### 1.1 Tooling actually ran

Both tools were already installed. No install was attempted and no install failed.

```
cargo         1.96.0 (30a34c682 2026-05-25)
rustc         1.96.0 (ac68faa20 2026-05-25)
cargo-audit   0.22.2
cargo-deny    0.20.2
```

The RustSec database clone was synced during the run:

```
851b9c93dc25a711144b70a007b5f3a4bd50e2e9 2026-08-24T10:08:07+02:00 Synchronize IDs (2026-08-22) (#3159)
```

`Cargo.lock` was **not** modified by any of this (`git status --porcelain Cargo.lock`
returned empty afterwards), so the resolution below is the committed one.

### 1.2 `cargo audit`, raw result

Full output: `audit/tool-output/cargo-audit.txt`

```
    Fetching advisory database from `https://github.com/RustSec/advisory-db.git`
      Loaded 1225 security advisories (from /Users/mericcintosun/.cargo/advisory-db)
    Updating crates.io index
    Scanning Cargo.lock for vulnerabilities (215 crate dependencies)
Crate:     paste
Version:   1.0.15
Warning:   unmaintained
Title:     paste - no longer maintained
Date:      2024-10-07
ID:        RUSTSEC-2024-0436
URL:       https://rustsec.org/advisories/RUSTSEC-2024-0436

warning: 1 allowed warning found
EXIT=0
```

Machine-readable summary from `cargo audit --json`
(`audit/tool-output/cargo-audit-deny-warnings.txt`):

```
database advisory count: 1225
lockfile deps: 215
vulnerabilities.found: False count: 0
warning kinds: {'unmaintained': 1}
```

**Zero vulnerabilities. One unmaintained warning.**

Note for CI: plain `cargo audit` exits **0** on this warning, so the existing
`.github/workflows/soroban.yml` "Advisory audit" step passes today. `cargo audit --deny
warnings` exits 1. That is a deliberate choice to make, not a bug.

### 1.3 The `paste` warning does not reach the deployed wasm

`RUSTSEC-2024-0436` (https://rustsec.org/advisories/RUSTSEC-2024-0436) is an
unmaintained-crate notice: the author archived the repository. There is no memory-safety
or correctness claim, and `cargo deny` records `Solution: No safe upgrade is available!`.

Inverted tree for the full host build
(`audit/tool-output/cargo-tree-invert-paste.txt`):

```
paste v1.0.15 (proc-macro)
├── ark-ff v0.5.0 -> ark-bls12-381 / ark-bn254 / ark-ec / ark-poly -> soroban-env-host v27.0.1
└── wasmi_core v0.13.0 -> soroban-wasmi v0.31.1-soroban.20.0.1 -> soroban-env-host v27.0.1
```

Both paths terminate at `soroban-env-host`, which is the **interpreter used by the test
harness**, not code that compiles into the contract. Confirmed directly
(`audit/tool-output/cargo-tree-wasm-invert-paste.txt`):

```
$ cargo tree --target wasm32v1-none -e normal -i paste
warning: nothing to print.
```

**Conclusion: `paste` is a build-and-test-time dependency of the local test runner. It
cannot affect the deployed wasm at
`155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239`. Severity for this
project: informational.**

### 1.4 What actually reaches the wasm

`cargo tree --target wasm32v1-none -e normal` resolves to **74 unique crates** out of the
**216** in `Cargo.lock`. Full list: `audit/tool-output/wasm-crate-set.txt`; full tree:
`audit/tool-output/cargo-tree-wasm-normal.txt`.

The direct chain is short:

```
agent-spend-policy v0.1.0
└── soroban-sdk v27.0.6
    ├── soroban-env-guest v27.0.1 -> soroban-env-common v27.0.1 -> stellar-xdr v27.0.0
    ├── soroban-sdk-macros v27.0.6 (proc-macro)
    ├── stellar-strkey v0.0.16
    ├── bytes-lit v0.0.6 (proc-macro)
    └── visibility v0.1.1 (proc-macro)
```

The remaining ~142 locked crates (`soroban-env-host`, `soroban-wasmi`, `ed25519-dalek`,
`curve25519-dalek`, `ark-*`, `k256`, `p256`, `sha3`, `rand`, `chrono`, `time`, ...) are
reachable only through `soroban-sdk`'s `testutils` feature and the
`soroban-ledger-snapshot` dev path. Verified with `cargo tree -i` for each dalek crate
(`audit/tool-output/` and the transcript in section 1.6).

This split matters for triage: a future advisory on a host-only crate is a
developer-machine and CI concern, not an on-chain concern. A future advisory on any of the
74 is potentially on-chain.

**Caveat worth stating plainly:** most of those 74 are proc-macro and build-time crates
(`syn`, `quote`, `proc-macro2`, `serde_derive`, `darling`, `prettyplease`, `schemars`,
`serde_with_macros`, `wasmparser`). They execute arbitrary code on the build machine and
they shape the emitted wasm. They are a real supply-chain surface even though none of
their object code ships. `cargo audit` currently reports none of them as vulnerable.

### 1.5 `cargo deny`

Full output: `audit/tool-output/cargo-deny.txt`

```
cargo-deny 0.20.2
2026-08-24 14:51:21 [WARN] unable to find a config path, falling back to default config
```

There is **no `deny.toml` in `soroban/`**. Results with that caveat:

| Check | Result | Meaning |
| --- | --- | --- |
| `advisories` | **FAILED** | same single `RUSTSEC-2024-0436` on `paste`; `cargo deny` denies unmaintained by default where `cargo audit` warns |
| `bans` | **ok** | no banned crates, no duplicate-version policy violation under defaults |
| `sources` | **ok** | every dependency comes from `registry+https://github.com/rust-lang/crates.io-index`; no git or path sources sneak in |
| `licenses` | **FAILED** | **not a real finding** |

The licenses failure is a configuration artifact and must not be reported as a finding.
With no `deny.toml`, the default allow-list is empty, so `cargo deny` rejects everything
including the workspace's own crate:

```
error[rejected]: failed to satisfy license requirements
  ┌─ .../contracts/agent-spend-policy/Cargo.toml:6:12
6 │ license = "MIT"
  │            ━━━  rejected: license is not explicitly allowed
```

The `sources ok` line is the genuinely useful result here: it proves no dependency is
being pulled from an unpinned git ref.

### 1.6 Notable crate versions, checked against the classic advisories

From `Cargo.lock`. The crypto crates that historically carry RustSec entries are all at or
above their patched versions:

| Crate | Locked | Note |
| --- | --- | --- |
| `ed25519-dalek` | 2.2.0 | above 2.0, so clear of the pre-2.0 double-public-key signing oracle class |
| `curve25519-dalek` | 4.1.3 and 5.0.0 | 4.1.3 is the version that fixed the Scalar29/Scalar52 timing variability; 5.0.0 is newer still |
| `k256` / `p256` / `ecdsa` / `elliptic-curve` | 0.13.4 / 0.13.2 / 0.16.9 / 0.13.8 | no advisory fires |
| `sha2` / `sha3` | 0.10.9 / 0.10.9 | no advisory fires |
| `rand` / `rand_core` / `getrandom` | 0.8.7 / 0.6.4 / 0.2.17 | host-only |
| `time` / `chrono` | 0.3.55 / 0.4.45 | host-only |
| `zeroize` / `subtle` | 1.9.0 / 2.6.1 | host-only |

All of these are host-side only. `cargo tree -i` confirms:

```
$ cargo tree -i ed25519-dalek
ed25519-dalek v2.2.0
├── soroban-env-host v27.0.1 ...
└── soroban-sdk v27.0.6 ...
```

Relevant upstream context: `rs-soroban-env` **v27.0.1** exists for exactly one reason,
"Pin ed25519-dalek to 2.x.y in order to not upgrade downstream builds to v3"
(https://github.com/stellar/rs-soroban-env/releases/tag/v27.0.1). Our lock resolves
`soroban-env-host` to 27.0.1, so we have that pin.

### 1.7 The gap that `cargo audit` cannot close

This is the most important result in section 1.

The freshly synced RustSec clone (1225 advisories, HEAD `851b9c93`, 2026-08-24) contains
**no directory and no text mention of any Stellar crate**
(`audit/tool-output/rustsec-db-check.txt`):

```
ABSENT : crates/soroban-sdk
ABSENT : crates/soroban-sdk-macros
ABSENT : crates/soroban-env-host
ABSENT : crates/soroban-env-common
ABSENT : crates/soroban-env-guest
ABSENT : crates/stellar-xdr
ABSENT : crates/stellar-strkey
ABSENT : crates/soroban-wasmi
ABSENT : crates/soroban-spec

=== any advisory file mentioning soroban/stellar anywhere in db ===
(grep soroban done)      <- zero hits
(grep stellar done)      <- zero hits
```

Meanwhile GitHub carries four published advisories against those crates (section 2). The
lead auditor's 404 result is confirmed and widened: it is not that a directory happens to
be missing, it is that **RustSec has never mirrored a Stellar advisory**.

`.github/workflows/soroban.yml` lines 52-57 currently read:

```yaml
      # A stale or vulnerable dependency is itself a published Soroban audit finding, so
      # it is caught mechanically rather than left to whoever remembers to look.
      - name: Advisory audit
        run: |
          cargo install cargo-audit --locked || true
          cargo audit
```

The comment's intent is right; the mechanism does not cover the SDK. And the other channel
that would cover it is off. Checked with `gh api`:

```
=== getA-Identity/A-Identity ===   private: False   dependabot_security_updates = disabled
--- vulnerability-alerts endpoint --- HTTP/2.0 404 Not Found
=== mericcintosun/a-identity ===   private: False   dependabot_security_updates = disabled
--- vulnerability-alerts endpoint --- HTTP/2.0 404 Not Found
```

There is also no `.github/dependabot.yml` and no `renovate.json` in the repository.

*Honest caveat on that probe:* `GET /repos/{owner}/{repo}/vulnerability-alerts` returns
204 when enabled and 404 when disabled, but also 404 without admin scope. The
`security_and_analysis` block did read back, which normally requires admin, so "disabled"
is the credible reading. Confirm in the repository Settings page before acting.

**Net position: today this project has no automated channel that would ever surface a
soroban-sdk advisory.** That is the finding, not a hypothetical.

---

## 2. GitHub Security Advisories and the 27.0.x release notes

### 2.1 Published advisories against the Stellar Rust stack

Queried `gh api repos/{repo}/security-advisories` on 2026-08-24. Full output:
`audit/tool-output/github-security-advisories.txt`

| GHSA | CVE | Sev | Summary | Vulnerable ranges | Applies to 27.0.6? |
| --- | --- | --- | --- | --- | --- |
| [GHSA-x2hw-px52-wp4m](https://github.com/stellar/rs-soroban-sdk/security/advisories/GHSA-x2hw-px52-wp4m) | CVE-2026-32322 | medium | `Fr` scalar field equality comparison bypasses modular reduction (BN254, BLS12-381) | `soroban-sdk` `>=25.0.0,<25.3.0`; `>=23.0.0,<23.5.3`; `<22.0.11` | **No** |
| [GHSA-4chv-4c6w-w254](https://github.com/stellar/rs-soroban-sdk/security/advisories/GHSA-4chv-4c6w-w254) | CVE-2026-26267 | **high** | `#[contractimpl]` macro calls the inherent function instead of the trait function when names collide | `soroban-sdk-macros` `>=25.0.0,<=25.1.0`; `>=23.0.0,<=23.5.1`; `<=22.0.9` | **No** |
| [GHSA-96xm-fv9w-pf3f](https://github.com/stellar/rs-soroban-sdk/security/advisories/GHSA-96xm-fv9w-pf3f) | CVE-2026-24889 | medium | Overflow in `Bytes::slice`, `Vec::slice`, `GenRange::gen_range` for u64 | `soroban-sdk` `>=25.0.0,<=25.0.1`; `>=23.0.0,<=23.5.0`; `<=22.0.8` | **No** |
| [GHSA-pm4j-7r4q-ccg8](https://github.com/stellar/rs-soroban-env/security/advisories/GHSA-pm4j-7r4q-ccg8) | none | low | Muxed address <-> `ScVal` conversions may break after a conversion failure | `soroban-env-host` `<26.0.0` | **No** (ours is 27.0.1) |
| [GHSA-x57h-xx53-v53w](https://github.com/stellar/rs-stellar-xdr/security/advisories/GHSA-x57h-xx53-v53w) | CVE-2026-29795 | medium | `StringM::from_str` bypasses max length validation | `stellar-xdr` `<=25.0.0` | **No** (ours is 27.0.0) |

For completeness, `stellar/stellar-core` carries two, both long fixed and both below the
protocol version pubnet runs: GHSA-3p8h-7v82-ffvq (Memo mutability with Soroban auth
signatures, `<22.0.0`) and GHSA-mgx8-frjx-x33m / CVE-2024-32985 (remote P2P crash,
`<20.4.0`). Pubnet is on stellar-core 27.1.0 (section 3.4).

**Result: no published advisory affects the pinned stack.** Note the shape of those ranges
though. The SDK maintains parallel 22.x, 23.x, 25.x support lines, and a fix is backported
into each. A future advisory will very likely publish a `>=27.0.0,<27.0.N` range, and
nothing in this repository is currently wired to see it.

Also worth flagging for its own sake: **GHSA-4chv-4c6w-w254 is a high-severity bug in the
`#[contractimpl]` macro itself.** It is a reminder that in Soroban the macro layer is part
of the trusted computing base, not boilerplate. The 27.0.6 release includes "Error on
contracttrait without a trait impl" (#1992), which hardens the same area.

### 2.2 Release notes, 27.0.0 through 27.0.6

Full bodies: `audit/tool-output/sdk-release-notes-27.0.0-27.0.6.txt`

| Version | Published | Security-relevant to a 27.0.6 user |
| --- | --- | --- |
| v27.0.0 | 2026-07-08 | **CAP-71 auth delegation for custom accounts** (#1896). `CustomAccount::delegate_auth` and `CustomAccount::get_delegated_signers`. See section 3.2. Also a zero-copy `BytesN::from` rewrite (#1888) and migration docs for `cfg` attribute and export-arg changes (#1886). |
| v27.0.1 | 2026-07-21 | Renames the allowance expiration argument to `live_until_ledger` (#1932). Repins the `stellar-env-*` crates to fix a dependent version constraint. |
| v27.0.2 | 2026-07-23 | **Test-harness auth semantics changed.** "Fix `register_at` to switch to recording auth for constructors" (#1933) and "Switch to recording auth for native constructors" (#1943). Directly relevant to a contract with a `__constructor`: constructor authorization behaves differently in tests on 27.0.0/27.0.1 than on 27.0.2+. Phase 5 input. |
| v27.0.3 | 2026-07-28 | **"Refresh `mainnet()` resource limits and fees" (#1946)**. Any budget or cost assertion written before this sees different numbers. "Document constructor auth mocking on register" (#1950). `BytesIter` rewritten to index rather than re-slice (#1935). SAC event doc-comments updated to CAP-67 shapes (#1956). |
| v27.0.4 | 2026-07-31 | CI and docs only. No functional change. |
| v27.0.5 | 2026-08-03 | "Filter empty wasm hash from snapshot lookups" (#1905), testutils. Removes the dead `TOPIC_BYTES_LENGTH_LIMIT` constant (#1977). More CAP-67 SAC event doc corrections. |
| v27.0.6 | 2026-08-13 | **"Error on contracttrait without a trait impl" (#1992)**. Hardening in the same macro area as GHSA-4chv-4c6w-w254. Docs example update (#2001). |

Nothing in the 27.0.x line is a security fix for a vulnerability. The two items a
27.0.6 user should carry forward are the **constructor recording-auth change in 27.0.2**
and the **refreshed `mainnet()` limits in 27.0.3**, both of which change what a test
proves rather than what the contract does.

`rs-soroban-env` notes for the same window
(`audit/tool-output/env-releases-and-migration-docs.txt`):

- v27.0.0 (2026-06-03): implements CAP-71, and adds "a recording auth parameter for
  switching between v1/v2 Address credential recording" (#1689).
- v27.0.1 (2026-07-20): the `ed25519-dalek` 2.x pin, nothing else. This is the version in
  our lock.

---

## 3. Protocol 22 to 27: what changed that touches this contract

Mapped from the CAP headers in `stellar/stellar-protocol`, fetched 2026-08-24. Index:
`audit/tool-output/cap-index-files.txt`; headers were read from each CAP's own preamble.

### 3.1 The map

| Protocol | CAPs | Bearing on this contract |
| --- | --- | --- |
| 22 | CAP-0058 constructors, CAP-0059 BLS12-381, CAP-0060 Wasmi register machine | CAP-0058 is why `__constructor` exists and is atomic at deploy |
| 23 | CAP-0062 Soroban live state prioritization, CAP-0063 parallel tx scheduling, CAP-0065 reusable module cache, **CAP-0066 in-memory read resource + automatic restoration**, CAP-0067 unified asset events, CAP-0068 `get_address_executable`, CAP-0069 string/bytes conversions, CAP-0070 SCP timing | archival, fee model, and the SAC event shapes all move here |
| 24 | **CAP-0076 P23 state archival bug remediation** | a real archival correctness incident, now fixed |
| 25 | CAP-0074 BN254, CAP-0075 Poseidon | not applicable |
| 26 | CAP-0073 SAC creates G-account balances, **CAP-0077 freeze ledger entries via network config**, CAP-0078 limited TTL extensions, CAP-0079 muxed strkey, CAP-0080 ZK BN254, **CAP-0081 TTL-ordered eviction**, CAP-0082 checked 256-bit arithmetic | liveness and eviction ordering |
| 27 | **CAP-0071 / 0071-01 / 0071-02 authentication delegation and address-bound Soroban credentials** | the authorization surface |

### 3.2 Authorization (protocol 27, CAP-0071)

Source: `core/cap-0071-01.md` and `core/cap-0071-02.md` in `stellar/stellar-protocol`,
both `Status: Final`, `Protocol version: 27`.

**CAP-0071-01, authentication delegation.** New host functions
`delegate_account_auth(address)` and `get_delegated_signers_for_current_auth_check()`,
both `min_supported_protocol: 27` (verified in
`rs-soroban-env` v27.0.1 `soroban-env-common/env.json`). A custom (contract) account's
`__check_auth` can now delegate to another address using a single authorization entry, and
delegation can nest recursively, with the signature payload and authorization context
inherited from the top-level address.

The CAP is explicit that this capability is not new in kind, only in ergonomics: "Custom
accounts on Stellar had the capability to delegate their authentication logic to a
different address starting from their introduction in protocol 20", via
`require_auth_for_args` inside `__check_auth`.

**What this means for the threat model.** Section 3 of `00-threat-model.md` says the
entire authorization surface is `operator.require_auth()` and `owner.require_auth()`. That
remains true. What CAP-0071 changes is *who can satisfy those calls* when `Owner` or
`Operator` is a C-address rather than a G-address: a contract account's `__check_auth` can
now cheaply and recursively hand off to an arbitrary delegate chain, and one authorization
entry covers the whole chain. The effective signer set behind a C-address owner is
therefore whatever that account contract decides, and it can change without any
transaction touching this vault.

The env.json doc-comment for `get_delegated_signers_for_current_auth_check` is worth
quoting because it is a footgun for anyone writing an account contract:

> **Important**: These are user-provided inputs and should be treated accordingly, in a
> similar fashion to the actual signatures. Specifically, the account contract must ensure
> that these signers actually belong to it, and perform authentication for every one of
> them via `delegate_account_auth`.

That obligation belongs to whatever account contract is used as owner or operator, not to
this contract. Phase 3 should record it as a deployment-time assumption, in the same family
as P-6 ("the token is chosen at deploy and is trusted thereafter").

**CAP-0071-02, address-bound credentials.** Adds `SOROBAN_CREDENTIALS_ADDRESS_V2`, whose
signature payload is the `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS` preimage,
which includes the signer's address. The motivation is a narrow replay case: "in the rare
case that multiple accounts share the same private keys and the invocation payload does not
otherwise bind the signer address, using the legacy `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`
payload would allow potential replay attacks between accounts sharing the same keys."

The old `SOROBAN_CREDENTIALS_ADDRESS` is **not deprecated** and stays valid: "we keep the
existing credential type and preimage type valid, so that clients can choose to switch to
the new preimage type at their own pace". The CAP notes a possible deprecation "in the
future protocol (28 or later)".

This is a client-side choice, not a contract-side one. It affects whoever builds and signs
transactions against the vault, which per the threat model may be the out-of-scope backend
holding the operator key. Nothing about it forces a contract change.

### 3.3 Storage archival and TTL

**Temporary entries are permanently unrecoverable.** Stellar docs, State Archival page,
fetched 2026-08-24
(https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival):

> When a `Temporary` entry's TTL is 0, it is deleted from the ledger and is permanently
> inaccessible.

versus

> When a `Persistent` or `Instance` entry TTL is 0, it is 'archived' and can't be accessed
> until it is 'restored'.

**Automatic restoration arrived in protocol 23.** Same page:

> Starting in Protocol 23 (CAP-66: Soroban In-Memory Read Resource), archived `Persistent`
> or `Instance` contract entries can be automatically restored before a host function runs

CAP-0066's own summary agrees: "This also proposes automatic restoration for archived
entries via `InvokeHostFunctionOp`", and "any archived key present in the footprint is
automatically restored."

**This is direct input to threat-model P-3.** P-3 leaves open whether instance-entry
archival is "a liveness and operator-burden question rather than a permanent loss". On
protocol 23 and above the answer is the milder one: the instance entry is archived, not
destroyed, and from p23 it is restored automatically when it appears in the footprint of an
`InvokeHostFunctionOp`, rather than needing a separate explicit `RestoreFootprint`
operation. The rent still has to be paid, so it is a cost and a fee-bump question, not a
loss-of-funds question. Phase 3 (A2, A6) can close P-3 on that basis.

**Extending a temporary entry's TTL past the maximum traps.** From
`rs-soroban-env` v27.0.1 `soroban-env-common/env.json`, `extend_contract_data_ttl`:

> If attempting to extend the entry past the maximum allowed value (defined as the current
> ledger + `max_entry_ttl` - 1), and the entry is `Persistent`, its new
> `live_until_ledger_seq` will be clamped to the max; **if the entry is `Temporary`, the
> function traps.**

This is long-standing behaviour, not a protocol-27 regression: the same sentence appears on
the v1 function (no `min_supported_protocol`, so present since protocol 20) and on the
CAP-0078 v2 function (`min_supported_protocol: 26`). Persistent and instance entries clamp;
temporary entries trap. Worth recording because the asymmetry is easy to miss.

**CAP-0081, TTL-ordered eviction (protocol 26).** Eviction order changed from
bucket-file-position order to `(liveUntilLedgerSeq, LedgerKey)` order, lowest TTL first,
and temporary and persistent entries now get separate independent per-ledger eviction
limits (`maxTempEntriesToEvict` versus `maxPersistentEntriesToArchive`). The CAP states the
old ordering "is very complex, implementation specific, and led to a correctness bug in
Protocol 23."

The practical consequence: eviction is now deterministic in the entry's own TTL, so a
temporary entry does not get evicted before its `liveUntilLedgerSeq`, and it does not
compete with persistent entries for an eviction budget. This is a strengthening of INV-18,
not a threat to it.

**CAP-0076, the protocol 23 archival corruption (fixed in protocol 24).** For the record,
because it is the only case of real on-chain data loss in this window. A protocol 23 bug
archived persistent entries with "an arbitrary historical state ... instead of the most
recent state". 478 mainnet ledger entries were affected; 394 were never restored and were
amended in place at the protocol 24 upgrade, and `31879035` stroops were added back to the
fee pool to account for two contract XLM balances that were burned by restoring a stale
lower balance. Our contract was deployed **2026-08-24 (pubnet)** and **2026-08-15
(testnet)**, both far after the protocol 24 remediation, so it is not in scope. Cited
because it is the strongest available evidence that state archival is the highest-risk
subsystem in the protocol, which is exactly the subsystem INV-18, INV-19 and INV-20 depend
on.

**CAP-0077, freeze ledger entries via network configuration (protocol 26).** Validators can
now vote, via a normal settings upgrade, to add a ledger key to
`CONFIG_SETTING_FROZEN_LEDGER_KEYS`. Contract data and contract code entries are eligible.
A Soroban transaction with a frozen entry in its footprint "will be considered invalid,
which would cause them to never be included into ledger."

This is a new, protocol-level actor in the availability model. The threat model's actor
table lists "the network" as trusted only for the ledger timestamp and sequence. As of
protocol 26 the validator set can also make this contract's entries unreachable by
consensus, which would make `withdraw` unreachable (INV-20) with no on-chain recourse and
no upgrade path (P-1). It is a remediation mechanism aimed at corruption and known-hacked
entries, not a plausible adversary, but it belongs in the actor table for completeness.

### 3.4 Live network parameters, and the INV-18 margin

This is the most consequential number in this report.

Probed 2026-08-24 14:55 UTC (`audit/tool-output/live-protocol-probe-2026-08-24.txt`):

```
pubnet  https://mainnet.sorobanrpc.com
  version 27.1.1, captiveCoreVersion "stellar-core 27.1.0", protocolVersion 27
  latest ledger 64104157, protocolVersion 27
testnet https://soroban-testnet.stellar.org
  version 28.0.0, captiveCoreVersion "stellar-core 28.0.0", protocolVersion 27
  latest ledger 4312054, protocolVersion 27
```

Both networks run **protocol 27**, matching the pin. Note that the testnet RPC already runs
a stellar-core **28.0.0** binary while still voting protocol 27.

Live `StateArchivalSettings`, read via `getLedgerEntries` on `ConfigSettingID 10` and
decoded with `stellar xdr decode` (`audit/tool-output/pubnet-state-archival-settings.txt`):

| Setting | pubnet | testnet |
| --- | --- | --- |
| `max_entry_ttl` | 3,110,400 | 3,110,400 |
| `min_temporary_ttl` | **17,280** | **720** |
| `min_persistent_ttl` | 2,073,600 | 120,960 |
| `persistent_rent_rate_denominator` | 1215 | 1215 |
| `temp_rent_rate_denominator` | 2430 | 2430 |
| `max_entries_to_archive` | 1000 | 1000 |

Measured ledger close intervals over the last 17,280 ledgers, from Horizon
(`audit/tool-output/pubnet-ledger-rate.txt`, `audit/tool-output/ttl-span-math.txt`):

```
pubnet  ledger 64086913 2026-08-23T11:53:15Z -> 64104193 2026-08-24T14:58:35Z
        mean close interval 5.644 s  (5.625 s over the last 172,800 ledgers)
testnet ledger  4294821 2026-08-23T14:56:23Z ->  4312101 2026-08-24T14:59:09Z
        mean close interval 5.010 s
```

Converted to wall-clock:

| | pubnet | testnet |
| --- | --- | --- |
| `min_temporary_ttl` in hours | **27.00 h** | **1.002 h** |
| `min_persistent_ttl` in days | 135.0 d | 7.01 d |
| `max_entry_ttl` in days | 202.5 d | (same ledgers, ~180 d at 5.0 s) |

Two things follow, and both are Phase 3 input rather than findings here.

**(a) The pubnet margin on INV-18 is 12.5 percent, and the break-even is exact.**
`86400 / 17280 = 5.0000` seconds. A temporary entry that receives only the protocol
minimum survives a full 24 hour UTC day if and only if the mean ledger close time is above
5.0000 s. Pubnet is at 5.625 s today, so 27.0 hours, so INV-18 holds with about three
hours to spare. Testnet already runs at 5.010 s, which is 0.2 percent above break-even.
The Stellar network's nominal target is 5 s and the protocol 23 parallelism work
(CAP-0063, CAP-0065, CAP-0066) is aimed at going faster. If pubnet's close time ever
reaches the 5 s target, `min_temporary_ttl` alone yields exactly 24.0 hours with zero
margin against a day boundary. Phase 3 should establish whether the contract relies on the
protocol minimum or extends the entry's TTL explicitly. If it relies on the minimum, this
is a slow-moving, network-parameter-dependent risk to INV-18 rather than a bug in the code.

**(b) testnet and pubnet differ by a factor of 24 on this parameter.** A temporary entry on
testnet that gets only the protocol minimum lives **one hour**, not one day. Any behaviour
verified against the testnet deployment at `CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI`
that depends on a temporary entry surviving a UTC day is not evidence about the pubnet
deployment, and vice versa. `min_persistent_ttl` differs similarly, 135 days versus 7 days,
which is the clock behind threat-model P-3.

### 3.5 The fee and resource model

Protocol 23 changed the Soroban read resource model materially. CAP-0066 splits reads into
disk reads and in-memory reads: "By making this distinction at the protocol level, read
limits for Soroban data can greatly increase." CAP-0062 moved evicted persistent entries
into a separate archival BucketList so live Soroban state can be held entirely in memory.
CAP-0063 introduced parallelism-friendly transaction scheduling, and CAP-0065 a reusable
module cache.

For a small contract with a handful of ledger entries and one cross-contract call, the
practical effect is that reads got cheaper and limits got higher, not tighter. The concrete
thing to carry forward is on the SDK side, not the protocol side: **soroban-sdk 27.0.3
refreshed the `mainnet()` resource limits and fees** (#1946). Any test that asserts on a
budget number written before 27.0.3 is asserting against stale figures.

CAP-0067 (unified asset events, protocol 23) is worth a line because the vault calls a SAC.
It changed both the Classic-side and the Stellar Asset Contract-side event shapes so that
`transfer`, `mint`, `burn`, `clawback`, `fee` and `set_authorized` are "semantically
correct and compatible with SEP-41". The 27.0.3 and 27.0.5 SDK releases both contain doc
corrections catching up to these shapes. Anything off-chain that parses SAC events, which
is out of scope here but is how the backend would reconcile a `Paid` event against the
token's own `transfer` event, needs to be on the CAP-67 shapes.

### 3.6 Protocol 28 is real and is coming

Not a finding, a scheduling fact for a mainnet deployment with no upgrade path.

- `stellar-core` **v28.0.0** was released 2026-08-13:
  "This release bumps the protocol to version 28, which includes CAP-0083, CAP-0085, and
  CAP-0086." (https://github.com/stellar/stellar-core/releases/tag/v28.0.0)
- `rs-soroban-env` **v28.0.2** exists (2026-08-17).
- The testnet RPC endpoint already serves a stellar-core 28.0.0 binary while voting p27.
- There is **no soroban-sdk 28.x on crates.io**; `max_stable_version` is 27.0.6. So there
  is nothing to move to even if one wanted to, which is another reason the pin is correct
  today.

The p28 CAPs, read from their preambles:

- **CAP-0083** validators may vote to drop a transaction set from the ledger being voted
  on, plus relaxed PREPARE validation. Consensus-layer performance. No contract impact.
- **CAP-0085** externally managed contract executables, a beacon-proxy equivalent, "thus
  allowing for atomic upgrades of many contracts at once". **This does not create an
  upgrade path for an already-deployed immutable contract.** Adoption is via
  `update_current_contract_executable_ref`, which the CAP describes as behaving "similarly
  to `update_current_contract_wasm`", meaning it is a host function the contract must call
  on itself. A contract whose wasm contains no such call cannot be switched to an external
  ref by anyone. Threat-model P-1 and P-2 are unchanged by protocol 28.
- **CAP-0086** host functions for sparse Symbol-keyed map creation and unpacking, to make
  `contracttype` UDT schema migration possible. Its motivation contains a line any Soroban
  contract that stores `contracttype` values should read: the existing
  `map_new_from_linear_memory` / `map_unpack_to_linear_memory` pair traps if the map does
  not *exactly* match the expected schema, and "There are known cases where this has
  rendered contracts unusable after an update." Since this vault cannot be updated, it
  cannot hit that failure mode in place, but any *successor* contract that reads storage
  written by this one must keep the stored struct and enum shapes byte-identical or provide
  its own migration. Phase 4 should note it against the "withdraw, redeploy, repoint"
  remediation path in P-1.

---

## 4. soroban-sdk 27.x errata and open issues

Checked `gh api repos/stellar/rs-soroban-sdk/issues?state=open&sort=updated` on 2026-08-24.
Full output: `audit/tool-output/crates-io-and-open-issues.txt` and
`audit/tool-output/sdk-open-issues-detail.txt`.

**There is no errata document and no known-issues page for the 27.0.x line.** The release
notes in section 2.2 are the entire public record. No 27.x version is yanked; every
published 27.x version is live on crates.io.

Open issues that a 27.0.6 user should be aware of:

| Issue | Label | Relevance |
| --- | --- | --- |
| [#1736](https://github.com/stellar/rs-soroban-sdk/issues/1736) `Persistent::all()` and `Temporary::all()` return data from all contracts, not just the current contract | bug | **testutils correctness.** The `all()` helper filters only on durability and never checks the entry's `contract` field, unlike `Instance::all()` which does. In a multi-contract test (this vault plus a token) "Tests may pass when they should fail, or return incorrect data silently" and "Duplicate keys across contracts overwrite each other via last-write-wins". Still open against `main`. Phase 5 input: if the suite uses `persistent().all()` or `temporary().all()` to assert on storage, those assertions are unsound. |
| [#1748](https://github.com/stellar/rs-soroban-sdk/issues/1748) PRNG docs should emphasize blind-rerun risk | bug | Not applicable to a contract with no PRNG use, but the mechanism is worth knowing: PRNG state is deliberately **not** rolled back by `try_call`, so an attacker can loop `try_call` until a favourable draw. Recorded so a future feature does not walk into it. |
| [#2013](https://github.com/stellar/rs-soroban-sdk/issues/2013) Block all test-only fns inside contract functions | feature request | Upstream acknowledges it is "easy to use a test only function inside a contract function during dev and testing before getting to a production build". PR #2010 blocked some; the rest are still reachable. A guard the SDK does not yet give you. |
| [#1866](https://github.com/stellar/rs-soroban-sdk/issues/1866) Supply chain security | (none) | Open since 2026-05-08. The SDK repository does **not** currently do SLSA build provenance, trusted publishing to crates.io, or SBOM generation. Relevant to the section 1.4 point that 74 crates, most of them proc-macros, execute at build time and shape the wasm. |
| [#1857](https://github.com/stellar/rs-soroban-sdk/issues/1857) Type alias for function signatures produces invalid specs | bug | Spec generation correctness. Only bites if the contract uses type aliases in a function signature. |
| [#1975](https://github.com/stellar/rs-soroban-sdk/issues/1975) Test wasm builds are not byte-reproducible | (none) | About the SDK's own test fixtures, not user contracts. Recorded because the threat model pins a wasm sha256; if a byte-reproducibility question ever arises for our own build, this is prior art on the upstream side. |

MSRV note: crates.io records `rust_version: 1.91.0` for every published 27.x release. The
repository pins 1.96.0 in `rust-toolchain.toml`, comfortably above.

---

## 5. What was checked and came back clean

Stated plainly so the absence is on the record and does not get re-derived.

- **No RustSec vulnerability** on any of the 215 locked crates. Checked with cargo-audit
  0.22.2 against advisory-db HEAD `851b9c93`, 2026-08-24.
- **No RustSec advisory of any kind** for `soroban-sdk`, `soroban-sdk-macros`,
  `soroban-env-host`, `soroban-env-common`, `soroban-env-guest`, `stellar-xdr`,
  `stellar-strkey`, `soroban-wasmi`, `soroban-spec`. Checked by directory presence and by
  full-text grep over the entire local advisory-db clone, 2026-08-24. Zero hits for either
  "soroban" or "stellar".
- **No GitHub Security Advisory** affects `soroban-sdk` 27.0.6, `soroban-env-host` 27.0.1
  or `stellar-xdr` 27.0.0. Checked 2026-08-24, four advisories reviewed, all with ranges
  below ours.
- **No yanked crate** in the dependency tree, and 27.0.6 itself is not yanked.
- **No git or path dependency**; `cargo deny check sources` returns ok, so every crate
  comes from the crates.io registry.
- **No 27.0.x security fix** was missed: 27.0.6 is the newest and the notes for 27.0.0
  through 27.0.6 contain no vulnerability fix.
- **No protocol 22-to-27 change breaks `require_auth`.** CAP-0071 extends what a custom
  account may do inside `__check_auth`; it does not change what `require_auth` means for
  the calling contract.

---

## 6. Actionable items

Ordered by what a maintainer should do first. None of these is "change the SDK pin".

**A-1. Close the advisory blind spot. (highest value, cheapest fix)**
`cargo audit` cannot see a soroban-sdk advisory, because RustSec has never carried one
(section 1.7). Enable **Dependabot alerts** on `getA-Identity/A-Identity` (Settings ->
Code security), which reads the GHSA database where all four Stellar advisories live.
Keep the `cargo audit` step for the rest of the tree, and add a watch on
https://github.com/stellar/rs-soroban-sdk/security/advisories so a human sees a 27.0.x
range the day it publishes. Consider updating the workflow comment at
`.github/workflows/soroban.yml:52` so it does not overstate the coverage it provides.

**A-2. Hand section 3.4 to Phase 3 as INV-18 input.**
`min_temporary_ttl` is 17,280 ledgers on pubnet and 720 on testnet. At the measured pubnet
rate that is 27.0 hours, and the break-even against a 24 hour day is a ledger close time of
exactly 5.0000 s. Phase 3 must establish whether `SpentOnDay(d)` relies on the protocol
minimum or extends its own TTL. If it relies on the minimum, INV-18 is protected by a 12.5
percent margin that is a network parameter away from vanishing, and it is already violated
on testnet by a factor of 24.

**A-3. Tell Phase 5 about the 27.0.2 constructor auth change and issue #1736.**
Constructor authorization in the test harness switched to recording auth in 27.0.2
(#1933, #1943), so constructor-auth tests written against 27.0.0/27.0.1 semantics prove
something different now. Separately, `persistent().all()` and `temporary().all()` are
known to return entries from *all* contracts (issue #1736, still open), so any storage
assertion built on them is unsound in a multi-contract test. Also: soroban-sdk 27.0.3
refreshed the `mainnet()` resource limits and fees, invalidating any older budget
assertion.

**A-4. Add the two new protocol-level actors to the threat model.**
(a) CAP-0071 delegation: if `Owner` or `Operator` is ever a C-address, the effective signer
set behind that address is defined by that account contract and can change without any
transaction touching the vault. Record it beside P-6.
(b) CAP-0077 entry freezing: from protocol 26 the validator set can, by settings upgrade,
make this contract's ledger entries unreachable, which takes `withdraw` (INV-20) offline
with no upgrade path to route around it. Low likelihood, but it belongs in the actor table.

**A-5. Decide the `paste` and `cargo deny` posture explicitly.**
`RUSTSEC-2024-0436` is informational for this project: `paste` is test-harness-only and
unreachable from the wasm (section 1.3), and there is no upgrade available. Either accept
it in writing or add a `soroban/deny.toml` with an `[advisories] ignore` entry plus a real
`[licenses] allow` list, so `cargo deny` becomes usable in CI instead of failing on an
empty default license allow-list. Do not report the licenses failure as a finding.

---

## 7. Raw output index

All under `audit/tool-output/`:

| File | Contents |
| --- | --- |
| `cargo-audit.txt` | tool version, UTC timestamp, full `cargo audit` run, exit code |
| `cargo-audit-deny-warnings.txt` | advisory-db HEAD, `cargo audit --deny warnings`, JSON summary |
| `cargo-deny.txt` | `cargo deny check advisories` and `check bans licenses sources`, full |
| `cargo-tree-full.txt` | full host-target dependency tree, 428 lines |
| `cargo-tree-wasm-normal.txt` | `--target wasm32v1-none -e normal` tree |
| `cargo-tree-invert-paste.txt` | `cargo tree -i paste`, host target |
| `cargo-tree-wasm-invert-paste.txt` | `cargo tree --target wasm32v1-none -e normal -i paste` ("nothing to print") |
| `wasm-crate-set.txt` | the 74 crates reachable from the wasm build |
| `rustsec-db-check.txt` | per-crate directory check and full-text grep of the advisory-db clone |
| `github-security-advisories.txt` | GHSA listings for rs-soroban-sdk, rs-soroban-env, rs-stellar-xdr, stellar-core |
| `sdk-releases-list.txt` | every rs-soroban-sdk release tag with publication date |
| `sdk-release-notes-27.0.0-27.0.6.txt` | full release-note bodies for the 27.0.x line |
| `env-releases-and-migration-docs.txt` | rs-soroban-env release notes, v25 through v28.0.2 |
| `stellar-core-releases.txt` | stellar-core releases including the v28.0.0 protocol 28 note |
| `cap-index-files.txt` | the CAP file listing used to build the protocol map |
| `crates-io-and-open-issues.txt` | crates.io version and yank state, plus open SDK issues |
| `sdk-open-issues-detail.txt` | full bodies of issues #1866, #2013, #1736, #1748 |
| `live-protocol-probe-2026-08-24.txt` | `getVersionInfo` and `getLatestLedger` for pubnet and testnet |
| `pubnet-state-archival-settings.txt` | decoded `StateArchivalSettings` for both networks |
| `pubnet-ledger-rate.txt` | measured pubnet ledger close interval |
| `ttl-span-math.txt` | measured testnet rate and the TTL-to-wall-clock conversions |

CAP texts were read from `https://raw.githubusercontent.com/stellar/stellar-protocol/master/core/cap-00NN.md`
and `env.json` from `https://raw.githubusercontent.com/stellar/rs-soroban-env/v27.0.1/soroban-env-common/env.json`,
both on 2026-08-24.
