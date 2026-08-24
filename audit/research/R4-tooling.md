# R4. Analysis tooling for Soroban/Rust/WASM: what actually works

Phase 1 research deliverable. Every claim below is either a pasted local command output or a
cited URL. Nothing is recalled. Probed on 2026-08-24 on this machine.

Target under test: `soroban/contracts/agent-spend-policy` (soroban-sdk `=27.0.6`, Rust
`1.96.0`, `wasm32v1-none`, `crate-type = ["lib", "cdylib"]`, macOS aarch64).

**Every command below was run against a throwaway copy of the workspace**
(`rsync -a --exclude target --exclude .git soroban/ <scratch>/sorocopy/`), never against the
repository, so nothing under `soroban/`, `mcp/` or `src/` was touched. Phase 2 will have to
re-run them in the real tree and will therefore write to `soroban/target/`.

---

## 0. Environment baseline (verified)

```
$ rustc --version
rustc 1.96.0 (ac68faa20 2026-05-25)
$ cargo clippy --version
clippy 0.1.96 (ac68faa20c 2026-05-25)
$ stellar --version
stellar 27.1.0 (8e402ea28202950b272fbabc34caad4d2f64fe87)
stellar-xdr 27.0.0 (5262803470be965e42f80023d12fba12808c774a)
$ rustup toolchain list
stable-aarch64-apple-darwin (active, default)
nightly-aarch64-apple-darwin            # rustc 1.99.0-nightly (da86f4d07 2026-07-24)
nightly-2025-08-07-aarch64-apple-darwin # rustc 1.91.0-nightly (7d82b83ed 2025-08-06)
nightly-2026-01-01-aarch64-apple-darwin
1.96.0-aarch64-apple-darwin
```

Installed tool versions (all confirmed by running `--version`):

```
cargo-audit-audit 0.22.2
cargo-deny 0.20.2
cargo-fuzz 0.13.2
cargo-mutants 27.1.0
cargo-llvm-cov 0.8.7
cargo-geiger 0.13.0
cargo-scout-audit 0.3.16
gitleaks 8.30.1
semgrep      -> not found
cargo-udeps  -> not found
llvm-tools-aarch64-apple-darwin (installed)
Homebrew 6.0.17
```

---

## 1. Master table

| Tool | Supports Soroban? | Exact install | Exact run | What it catches | Source |
| --- | --- | --- | --- | --- | --- |
| **clippy** (security lint set) | Yes, native | ships with the pinned toolchain (`components = ["clippy"]` in `rust-toolchain.toml`) | `cd soroban && cargo clippy --lib -p agent-spend-policy -- -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::expect_used -W clippy::indexing_slicing -W clippy::panic -W clippy::pedantic` | unchecked arithmetic, `unwrap`/`expect`, slice indexing, bare `panic!`. **Already found the 4 `unwrap()`s from threat-model P-3.** | local run, section 4 |
| **cargo llvm-cov** | Yes, works out of the box | `cargo install cargo-llvm-cov` + `rustup component add llvm-tools-preview` (already present) | `cd soroban && cargo llvm-cov --summary-only --ignore-filename-regex 'src/test'` | which lines/regions the 52 tests never touch | local run, section 6 |
| **cargo mutants** | Yes | `cargo install --locked cargo-mutants` | `cd soroban && cargo mutants --timeout 120` (137 mutants) | tests that assert nothing; the exact deliverable for threat-model §8 "do not assume the existing 52 tests cover what their names suggest" | local run, section 6 |
| **cargo fuzz** + `SorobanArbitrary` | Yes, **verified end to end on this contract** | `rustup install nightly`; `rustup component add rust-src --toolchain nightly`; `cargo install --locked cargo-fuzz` | `cd soroban/contracts/agent-spend-policy && cargo +nightly fuzz run --sanitizer=thread --build-std fuzz_target_1 -- -max_total_time=600` | invariant violations (INV-05/09/11) over random amounts, caps and timestamps; unexpected host traps | [Stellar fuzzing guide](https://developers.stellar.org/docs/build/guides/testing/fuzzing); local run, section 3 |
| **cargo audit** | Yes (dependency-level, chain-agnostic) | `cargo install cargo-audit` | `cd soroban && cargo audit` | RustSec advisories in `Cargo.lock` | local run, section 7 |
| **cargo deny** | Yes (dependency-level) | `cargo install --locked cargo-deny` | `cd soroban && cargo deny check` - **needs a `deny.toml` first** | advisories + duplicate crates + license policy | local run, section 7 |
| **cargo geiger** | Partly - must run from the package dir, not the workspace root | `cargo install cargo-geiger` | `cd soroban/contracts/agent-spend-policy && cargo geiger --output-format Ascii` | `unsafe` in the crate and its whole dependency tree | local run, section 7 |
| **gitleaks** | N/A to Soroban, but relevant to the repo | `brew install gitleaks` (present, 8.30.1) | `gitleaks dir /Users/mericcintosun/A-Identity` or `gitleaks git /Users/mericcintosun/A-Identity` | committed keys. Relevant because threat-model §3 says the backend holds the operator key on some deployments | local `gitleaks --help` |
| **Soroban budget/cost assertions** | Yes, `soroban-sdk` `testutils` API | already available (`dev-dependencies` enable `testutils`) | in a `#[test]`: `env.cost_estimate().resources().instructions`, `.budget().cpu_instruction_cost()` | resource-exhaustion / DoS bounds on `pay` and `withdraw` | local run, section 5 |
| **CoinFabrik Scout** (`cargo scout-audit`) | **Claims Soroban support, but CANNOT analyze this crate. Reports a FALSE GREEN.** | `cargo install cargo-scout-audit` (0.3.16 present) | `cd soroban && cargo scout-audit --output-format json --output-path <path>` | 36 Soroban detectors (listed in section 2) - **none of which ran here** | local run, section 2 |
| **OpenZeppelin `soroban-scanner`** | **Exists, is free (AGPL-3.0), and is BROKEN: panics on every input, release binary and source build alike.** | see section 2b | `soroban-scanner scan <src> --project-root <crate>` | 5 detectors (section 2b) | local run, section 2b |
| **OpenZeppelin Inspector** | Only as a host for `soroban-scanner`, which does not work | `curl -L -o inspector https://github.com/OpenZeppelin/openzeppelin-inspector/releases/download/v1.0.0/inspector-1.0.0-macos-arm64 && chmod +x inspector` | `inspector scanner install /path/to/soroban-scanner` then `inspector scan <project_root>` | nothing on its own; it is a scanner runner | [repo](https://github.com/OpenZeppelin/openzeppelin-inspector) |
| **semgrep** | **No useful Rust rules exist in the free tier. Not worth installing.** | `brew install semgrep` | `semgrep --config=p/rust <path>` | nothing for Rust in the community ruleset (0 rules, section 8) | local GitHub tree analysis, section 8 |
| **cargo-udeps** | Yes technically, but near-zero value here (1 dependency) | `cargo install cargo-udeps --locked` | `cargo +nightly udeps` | unused dependencies | [README](https://github.com/est31/cargo-udeps/blob/master/README.md) |

Out of scope by the audit protocol and not researched: Slither, Mythril, Echidna, Manticore,
Aderyn, Securify, Foundry/Forge. All are EVM/Solidity bytecode tools; none of them read Rust
or Soroban WASM.

---

## 2. CoinFabrik Scout: supports Soroban on paper, silently fails here

Scout is real, current, and Soroban-aware. Its own help text names Soroban:

```
$ cargo scout-audit --version
cargo-scout-audit 0.3.16
$ cargo scout-audit --help
Scout is an extensible open-source tool intended to assist Ink! and Soroban smart contract
developers and auditors detect common security issues and deviations from best practices.
```

`--list-detectors` run inside the workspace enumerates **36 Soroban detectors**:

```
$ cd soroban && cargo scout-audit --list-detectors
 1. avoid-unsafe-block          13. missing-new-admin-auth        25. unnecessary-admin-parameter
 2. unsafe-expect               14. unused-return-enum            26. integer-overflow-or-underflow
 3. empty-expect                15. front-running                 27. unprotected-update-current-contract-wasm
 4. divide-before-multiply      16. unnecessary-lint-allow        28. insufficiently-random-values
 5. incorrect-exponentiation    17. set-contract-storage          29. contract-import-dependency
 6. avoid-panic-error           18. unsafe-map-get                30. avoid-core-mem-forget
 7. assert-violation            19. vec-could-be-mapping          31. token-interface-events
 8. overflow-check              20. token-interface-inference     32. unrestricted-transfer-from
 9. unsafe-unwrap               21. ineffective-extend-ttl        33. dos-unexpected-revert-with-storage
10. known-vulnerabilities       22. avoid-vec-map-input           34. unprotected-mapping-operation
11. dos-unbounded-operation     23. soroban-version               35. storage-change-events
12. dynamic-storage             24. uncached-storage-modification 36. iterators-over-indexing
```

Several of those map straight onto this contract's threat model: `unsafe-unwrap` (P-3),
`ineffective-extend-ttl` (INV-18/20), `dynamic-storage` and `dos-unbounded-operation`
(INV-19), `unprotected-mapping-operation` and `missing-new-admin-auth` (INV-01/02),
`storage-change-events` (INV-21), `soroban-version`.

### 2a. The blocker: Scout's pinned nightly cannot compile soroban-sdk 27

```
$ cargo scout-audit --toolchain
nightly-2025-08-07
$ rustc +nightly-2025-08-07 --version
rustc 1.91.0-nightly (7d82b83ed 2025-08-06)
```

That compiler is a year old and cannot build this SDK:

```
$ cargo +nightly-2025-08-07 check
error[E0658]: use of unstable library feature `round_char_boundary`
  --> ~/.cargo/registry/src/index.crates.io-.../soroban-sdk-macros-27.0.6/src/doc.rs:25:25
   |
25 |     let safe_len = docs.floor_char_boundary(max);
   |                         ^^^^^^^^^^^^^^^^^^^
   = note: this compiler was built on 2025-08-06; consider upgrading it if it is out of date
error: could not compile `soroban-sdk-macros` (lib) due to 1 previous error
```

Under Scout's own driver the same run dies slightly earlier, in the SDK build script:

```
error: failed to run custom build command for `soroban-sdk v27.0.6`
  thread 'main' panicked at .../soroban-sdk-27.0.6/build.rs:14:17:
  Rust compiler 1.82+ with target 'wasm32-unknown-unknown' is unsupported by the Soroban
  Environment, use 'wasm32v1-none' available with Rust 1.84+.
warning: build failed, waiting for other jobs to finish...
```

Passing the right target does not help (`cargo scout-audit ... -- --target wasm32v1-none`
produces the identical failure).

### 2b. The dangerous part: Scout still reports success

After that build failure, Scout prints:

```
Summary:
+--------------------+----------+----------+--------+-------+-------------+
| Crate              | Status   | Critical | Medium | Minor | Enhancement |
+--------------------+----------+----------+--------+-------+-------------+
| agent_spend_policy | Analyzed | 0        | 0      | 0     | 0           |
+--------------------+----------+----------+--------+-------+-------------+
<path>/scout-report.json successfully generated.
EXIT=0
```

and writes `"total_vulnerabilities": 0, "findings": []` with `"status": "Analyzed"`. Exit code
is **0**.

> **This is a false green and must not appear in the audit as a clean Scout run.** Zero
> detectors executed against zero lines of this contract. If the report is going to mention
> Scout at all, it has to say "Scout could not analyze the crate", with this output attached.

Possible Phase 2 paths, in order of preference: (a) skip Scout and say why; (b) watch for a
Scout release that bumps the pinned nightly (crates.io shows the crate was last updated
2026-02-13, i.e. before soroban-sdk 27 shipped on 2026-08-13, so a fix is unlikely to exist
yet); (c) do not attempt to downgrade the SDK just to appease a linter - the exact pin is a
deliberate property of this project.

Sources: [CoinFabrik/scout-audit](https://github.com/CoinFabrik/scout-audit),
[Scout docs](https://coinfabrik.github.io/scout-audit/docs/intro), local runs above.

---

## 2b. OpenZeppelin `soroban-scanner` / Soroban Security Detectors SDK: free, and broken

It exists, it is free, and it is AGPL-3.0.

- Repo: <https://github.com/OpenZeppelin/soroban-security-detectors-sdk> (license
  `AGPL-3.0`, last commit `f3888e0` dated **2025-10-01**, i.e. ~11 months stale).
- Latest release `v0.0.2`, published **2025-07-04**, with prebuilt
  `soroban-scanner-macos-latest-v0.0.2.zip` (a **x86_64** Mach-O, so it runs under Rosetta on
  this machine).
- Install from source, as documented in the README:
  ```
  git clone https://github.com/OpenZeppelin/soroban-security-detectors-sdk.git
  cd soroban-security-detectors-sdk
  cargo build --workspace
  ```
- Run, as documented:
  ```
  soroban-scanner scan path/to/your/contracts
  soroban-scanner scan path/to/your/contracts --detectors auth_missing unchecked_ft_transfer
  ```

Its actual detector set, read out of the binary itself, is **five** checks (the README's
`auth_missing` and `unchecked_ft_transfer` examples do not exist in the shipped set):

```
$ ./soroban-scanner metadata
version 0.0.1
- contract-without-functions                | medium | ['audit','reportable','completeness']
- file-without-no-std                       | medium | ['audit','compatibility','no_std']
- temporary-storage-value-used-as-condition | medium | ['audit','reportable','completeness']
- contract-can-panic                        | medium | ['audit','reportable']
- extend-ttl-with-max-ttl                   | medium | ['audit','reportable','completeness']
```

`temporary-storage-value-used-as-condition` would be directly on point here (`SpentOnDay` is
temporary storage and INV-18 is exactly about that), so this is worth caring about.

### The blocker: it panics on every input

Both the released binary and a fresh native `arm64` build from `main` panic identically, on
this contract, on each of its five source files individually, and on a two-line
`#![no_std] pub fn f() {}` file:

```
$ ./soroban-scanner scan <src> --project-root <crate>
thread 'main' panicked at sdk/src/ast_types_builder.rs:254:60:
Invalid UTF-8 sequence: FromUtf8Error { bytes: [97, 195, 40, 100],
  error: Utf8Error { valid_up_to: 1, error_len: Some(1) } }
```

Backtrace pins the cause, and it is not our code:

```
   3: soroban_security_detectors_sdk::ast_types_builder::ParserCtx::build_literal_expression
  ...
  12: soroban_security_detectors_sdk::extern_prelude::insert_into_extern_prelude
  13: soroban_security_detectors_sdk::build_codebase
  14: soroban_scanner::main
```

The offending line, read from the cloned source at `sdk/src/ast_types_builder.rs:254`:

```rust
syn::Lit::ByteStr(lit_bstr) => Literal::BString(Rc::new(LBString {
    id, location,
    value: String::from_utf8(lit_bstr.value()).expect("Invalid UTF-8 sequence"),
})),
```

The scanner parses a bundled extern prelude before it ever looks at the target crate, that
prelude contains a non-UTF-8 byte-string literal, and the SDK `expect()`s it into a panic.
Every scan therefore fails, for everyone, on any input. All five source files verified as
valid UTF-8 first (`python3 -c "open(f,'rb').read().decode('utf-8')"` returns OK for each).

**Verdict: unusable in Phase 2.** Record it as "evaluated, does not run", with this output.
It is a one-line upstream fix (`from_utf8_lossy`) if anyone wants to carry a patch, but a
patched fork is not audit evidence.

**OpenZeppelin Inspector** is a separate, real, free tool
(<https://github.com/OpenZeppelin/openzeppelin-inspector>, AGPL-3.0, release `v1.0.0`
published 2025-04-25, with a `inspector-1.0.0-macos-arm64` asset). It is only a *runner* for
scanners: `inspector scanner install /path/to/soroban-scanner`, then
`inspector scan <project_root> [--detectors ...] [--output-format json]`. Since the only
Soroban scanner it can host is the broken one above, Inspector adds nothing here. Do not
confuse it with **Defender Code Inspector**, which is the hosted Solidity product.

---

## 3. `cargo fuzz` with `SorobanArbitrary`: WORKS, verified on this contract

### The documented pattern

From the SDK's own module docs (`soroban-sdk-27.0.6/src/testutils/arbitrary.rs`, read
locally) and the [Stellar fuzzing
guide](https://developers.stellar.org/docs/build/guides/testing/fuzzing):

- `SorobanArbitrary` bridges `arbitrary`'s "bytes to Rust value" model to Soroban's
  "values live in an `Env`" model, via an associated `Prototype` type:
  ```rust
  pub trait SorobanArbitrary:
      TryFromVal<Env, Self::Prototype> + IntoVal<Env, Val> + TryFromVal<Env, Val>
  {
      type Prototype: for<'a> Arbitrary<'a>;
  }
  ```
- Implemented for `i32/u32/i64/u64/i128/u128/I256/U256/()/bool`, `Error`, `Bytes`, `BytesN`,
  `Vec`, `Map`, `Address`, `Symbol`, `Val`, and derived automatically for every
  `#[contracttype]` - **only when `testutils` is on**.
- Fuzz-target inputs name the prototype:
  `fuzz_target!(|input: <Vec<Address> as SorobanArbitrary>::Prototype| { ... })`, then
  `input.into_val(&env)`.
- The SDK reexports `arbitrary` and `Arbitrary` at
  `soroban_sdk::testutils::arbitrary::{arbitrary, Arbitrary}`. The SDK pins
  `arbitrary = "~1.3.0"`, so a fuzz crate that adds `arbitrary` itself must use `1.3`, or the
  derive will target a different trait.

### The panic rule, stated correctly

The task brief phrased this as "any `panic!` is treated as a bug". The docs say something
sharper, and the distinction matters for this contract:

> "Each contract function can be invoked with a `try_` variant, which captures any errors,
> including panics and crashes... **Without using the `try_` variant, a panic from within a
> contract will immediately cause the fuzz test to fail, but in most cases a panic within a
> contract does not indicate a bug - it is simply how a Soroban contract cancels a
> transaction.**"
> - <https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fuzzing>

So: `cargo-fuzz` treats *any* panic that escapes the target as a failure, which is why every
contract call in a fuzz target must go through `try_`. What separates a bug from a normal
refusal is then which half of the nested `Result` you land in, and *that* is where
`panic_with_error!` earns its keep. From `soroban-sdk-27.0.6/src/error.rs`:

```rust
pub enum InvokeError {
    /// Abort occurs if the invoke contract panicks with a [`panic!`], or a host
    /// function of the environment has a failure, or a runtime error occurs.
    Abort,
    /// Contract error occurs if the invoked contract function exited returning
    /// an error or called [`panic_with_error!`] with a [`contracterror`].
    Contract(u32),
}
```

`try_pay(..)` returns `Result<Result<T, T::Error>, Result<Error, InvokeError>>`. Therefore:

| Outcome | Meaning | Fuzz verdict |
| --- | --- | --- |
| `Ok(Ok(v))` | success | assert the invariant |
| `Err(Ok(e))` | typed `#[contracterror]`, i.e. `panic_with_error!` or a returned `Err` | expected refusal, not a bug |
| `Ok(Err(_))` | success with an undecodable return type | bug |
| `Err(Err(InvokeError::Abort))` | a bare `panic!`, `unwrap()`, arithmetic overflow, or a failed `require_auth` | **bug, unless it is a `require_auth` you deliberately provoked** |

This contract already encodes the same reasoning in `src/test/mod.rs::assert_error`, which
distinguishes `Err(Ok(e))` from `Err(Err(host))`. A fuzz target should assert the same shape:
every refusal that is *not* an authorization test must be `Err(Ok(_))`. That is the direct
mechanical test of INV-17 and of the "typed refusal" product claim.

Also note `fuzz_catch_panic` is **deprecated** in 27.0.6:
`#[deprecated(note = "use [Env::try_invoke] or the try_ functions on a contract client")]`.
Do not use it.

### Verified working setup, with the three gotchas this workspace hits

Prerequisite the repo does not yet satisfy: **the contract crate must define a `testutils`
feature** that forwards to `soroban-sdk/testutils`. Right now `testutils` is only enabled via
`[dev-dependencies]`, which the fuzz crate (a separate crate) cannot reach. Add:

```toml
[features]
testutils = ["soroban-sdk/testutils"]
```

`crate-type = ["lib", "cdylib"]` is already correct - "lib" is rlib, which is what the fuzz
crate links against. Keep building the wasm with `stellar contract build`, because
[the docs warn](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fuzzing)
that "cargo has a feature/bug that inhibits LTO of cdylibs when a crate is both a 'cdylib' and
'rlib'", worked around by `stellar contract build` or `cargo rustc --crate-type cdylib`
rather than a plain `cargo build`.

Then, in a scratch copy:

```
$ cargo fuzz init                       # writes fuzz/Cargo.toml + fuzz/fuzz_targets/fuzz_target_1.rs
$ cargo +nightly fuzz build --sanitizer=thread fuzz_target_1
error: current package believes it's in a workspace when it's not:
current:   .../contracts/agent-spend-policy/fuzz/Cargo.toml
workspace: .../soroban/Cargo.toml
```

**Gotcha 1 - the workspace.** `soroban/Cargo.toml` has `members = ["contracts/*"]`, which does
not glob into `contracts/agent-spend-policy/fuzz`, but the directory is still inside the
workspace root. Fix by appending an empty `[workspace]` table to `fuzz/Cargo.toml`. That also
detaches the fuzz crate from the workspace `[profile.release]` (`panic = "abort"`, `lto`),
which is what you want.

```
$ cargo +nightly fuzz build --sanitizer=thread fuzz_target_1
error: mixing `-Zsanitizer` will cause an ABI mismatch in crate `cfg_if`
  = note: `-Zsanitizer=thread` in this crate is incompatible with `-Zsanitizer` being unset
    in dependency `core`
```

**Gotcha 2 - sanitizer ABI.** `--sanitizer=thread` (mandatory on macOS, per
[rs-soroban-sdk#1056](https://github.com/stellar/rs-soroban-sdk/issues/1056)) requires the
standard library to be rebuilt with the same sanitizer. Pass `--build-std`.

```
$ cargo +nightly fuzz build --sanitizer=thread --build-std fuzz_target_1
error: ".../nightly-aarch64-apple-darwin/lib/rustlib/src/rust/library/Cargo.lock" does not
exist, unable to build with the standard library, try:
        rustup component add rust-src --toolchain nightly-aarch64-apple-darwin
```

**Gotcha 3 - `rust-src`.** `rustup component add rust-src --toolchain nightly`. (Done on this
machine during research.) After that:

```
$ cargo +nightly fuzz build --sanitizer=thread --build-std fuzz_target_1
   Compiling agent-spend-policy v0.1.0 (.../contracts/agent-spend-policy)
   Compiling agent-spend-policy-fuzz v0.0.0 (.../contracts/agent-spend-policy/fuzz)
    Finished `release` profile [optimized + debuginfo] target(s) in 1m 12s

$ cargo +nightly fuzz run --sanitizer=thread --build-std fuzz_target_1 -- -max_total_time=60
#19874  DONE   cov: 5315 ft: 7162 corp: 76/8775b lim: 122 exec/s: 325 rss: 96Mb
Done 19874 runs in 61 second(s)
```

**19,874 executions, ~325/s, no crash, INV-05 held throughout.** The nightly used was
`rustc 1.99.0-nightly (da86f4d07 2026-07-24)`; the year-old `nightly-2025-08-07` will not work
(see section 2a).

The exact target that produced that run (kept at
`audit/research/R4-fuzz-target-reference.rs` for Phase 2 to lift):

```rust
#![no_main]
use agent_spend_policy::{AgentSpendPolicy, AgentSpendPolicyClient};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::arbitrary::Arbitrary;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env};

#[derive(Debug, Arbitrary)]
pub struct Input {
    pub daily_cap: i128,
    pub auto_approve_max: i128,
    pub amounts: [i128; 4],
    pub timestamps: [u64; 2],
    pub freeze: bool,
}

fuzz_target!(|input: Input| {
    let daily_cap = input.daily_cap.saturating_abs();
    let auto_approve_max = input.auto_approve_max.saturating_abs();

    let env = Env::default();
    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();

    let contract_id = env.register(
        AgentSpendPolicy,
        (owner, operator, token_id.clone(), daily_cap, auto_approve_max),
    );
    let client = AgentSpendPolicyClient::new(&env, &contract_id);

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&contract_id, &1_000_000_000);
    if input.freeze { client.set_frozen(&true); }

    for (i, amount) in input.amounts.iter().enumerate() {
        if let Some(ts) = input.timestamps.get(i) { env.ledger().set_timestamp(*ts); }
        let _ = client.try_pay(&payee, amount);       // try_, never pay()
        if daily_cap != 0 {
            assert!(client.spent_today() <= daily_cap, "INV-05 violated");
        }
        assert!(client.spent_today() >= 0, "spent_today went negative");
    }
});
```

Note the `mock_all_auths()` in there: this target deliberately fuzzes *money* invariants, not
authorization, so it mocks auth exactly the way `src/test/mod.rs` does for funding. Per
threat-model §3, a **second** fuzz target with auth ENFORCED is needed to attack INV-01/02,
and it must assert `Err(Err(InvokeError::Abort))` rather than `Err(Ok(_))`.

The fuzz crate manifest that worked:

```toml
[package]
name = "agent-spend-policy-fuzz"
version = "0.0.0"
publish = false
edition = "2021"

[package.metadata]
cargo-fuzz = true

[dependencies]
libfuzzer-sys = "0.4"
arbitrary = { version = "1.3", features = ["derive"] }
soroban-sdk = { version = "=27.0.6", features = ["testutils"] }

[dependencies.agent-spend-policy]
path = ".."
features = ["testutils"]

[[bin]]
name = "fuzz_target_1"
path = "fuzz_targets/fuzz_target_1.rs"
test = false
doc = false
bench = false

[workspace]
```

Fuzz coverage, if wanted, is documented as `rustup component add --toolchain nightly
llvm-tools-preview` then `cargo +nightly fuzz coverage --sanitizer thread fuzz_target_1`
(same source).

---

## 4. Clippy lints: all six names confirmed to exist in Rust 1.96

Verified by compiling a scratch crate with each lint individually and grepping for
`unknown lint` / `renamed` / `removed`:

```
OK      clippy::arithmetic_side_effects
OK      clippy::unwrap_used
OK      clippy::expect_used
OK      clippy::indexing_slicing
OK      clippy::panic
OK      clippy::pedantic
OK      clippy::unwrap_in_result
OK      clippy::missing_panics_doc
OK      clippy::as_conversions
PROBLEM clippy::integer_arithmetic -> lint `clippy::integer_arithmetic` has been renamed to
                                      `clippy::arithmetic_side_effects`
```

So `clippy::integer_arithmetic` is dead - use `arithmetic_side_effects`. The other five names
in the brief are all current.

### What they actually find on this contract

Baseline is clean:

```
$ cargo clippy --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 13.15s
```

With the security set on the library only:

```
$ cargo clippy --lib -p agent-spend-policy -- \
    -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::expect_used \
    -W clippy::indexing_slicing -W clippy::panic -W clippy::pedantic
  28 warning: this argument is passed by value, but not consumed in the function body
  13 warning: this method could have a `#[must_use]` attribute
   5 warning: docs for function returning `Result` missing `# Errors` section
   4 warning: used `unwrap()` on an `Option` value
   1 warning: item in documentation is missing backticks
   (51 warnings total)
```

The four `unwrap()`s, with locations:

```
contracts/agent-spend-policy/src/storage.rs:99
contracts/agent-spend-policy/src/storage.rs:107
contracts/agent-spend-policy/src/storage.rs:115
contracts/agent-spend-policy/src/storage.rs:123
```

These are exactly `get_owner`, `get_operator`, `get_token`, `get_decimals` - threat-model
**P-3**, independently confirmed by a tool. Phase 3 can cite this rather than only prose.

Notably **zero** `arithmetic_side_effects`, **zero** `indexing_slicing`, **zero** `panic`
findings. The `checked_add` discipline described in `soroban/Cargo.toml` holds under the lint.

`clippy::pedantic` contributes 41 of the 51 warnings and none of them are security-relevant
(`needless_pass_by_value` on `Env`/`Address` arguments is idiomatic Soroban). **Recommendation:
run pedantic once for the record, report on the non-pedantic five.**

Everything above is a command-line `-W`; adding a `[lints]` table to the crate would modify
`soroban/`, which R4 must not do.

---

## 5. Resource / budget instrumentation: current API names confirmed

The brief's assumption that "the SDK has cost/budget APIs" is correct, but the entry point
moved. `Env::budget()` is **deprecated** in 27.0.6:

```rust
/// Get the budget that tracks the resources consumed for the environment.
#[deprecated(note = "use cost_estimate().budget()")]
pub fn budget(&self) -> Budget
```

The current surface, read from
`soroban-sdk-27.0.6/src/testutils/cost_estimate.rs` and `src/testutils.rs`:

| Call | Returns | Notes |
| --- | --- | --- |
| `env.cost_estimate()` | `CostEstimate` | gated on `#[cfg(any(test, feature = "testutils"))]` |
| `.resources()` | `InvocationResources` | fields `instructions`, `mem_bytes`, `disk_read_entries`, `write_entries`, `ledger_entries`, `disk_read_bytes`, `write_bytes`, `contract_events_size_bytes`. Panics if called before any invocation. |
| `.fee()` | `FeeEstimate` | field `total`. Fees are a **hardcoded snapshot of Mainnet as of 2026-07-10** per the SDK's own doc comment; refresh with `stellar network settings --network mainnet`. |
| `.budget()` | `Budget` | `.cpu_instruction_cost() -> u64`, `.memory_bytes_cost() -> u64`, `.tracker(ContractCostType) -> CostTracker`, `.print()`, `.reset_default()`, `.reset_unlimited()`, `.reset_limits(cpu, mem)`, `.reset_tracker()` |
| `.enforce_resource_limits(InvocationResourceLimits)` | `()` | by default `InvocationResourceLimits::mainnet()` limits are **already enforced** |
| `.disable_resource_limits()` | `()` | |

`InvocationResourceLimits::mainnet()` (via the `NetworkInvocationResourceLimits` trait) is a
2026-07-10 snapshot of pubnet: `instructions: 400_000_000`, `mem_bytes: 41_943_040`,
`disk_read_entries: 200`, `write_entries: 200`, `ledger_entries: 400`,
`disk_read_bytes: 200_000`, `write_bytes: 132_096`, `contract_events_size_bytes: 16_384`,
`max_contract_data_key_size_bytes: 250`, `max_contract_data_entry_size_bytes: 65_536`,
`max_contract_code_entry_size_bytes: 131_072`.

**Gotcha:** the `InvocationResourceLimits` *type* is not re-exported by `soroban-sdk` - it
lives in `soroban_env_host`. Naming it requires adding `soroban-env-host = "=27.0.1"` as a
dev-dependency:

```
error[E0603]: struct `InvocationResourceLimits` is private
```

So the practical assertion style avoids naming the type at all. Verified working, in a scratch
crate against soroban-sdk `=27.0.6`:

```rust
let cpu = env.cost_estimate().budget().cpu_instruction_cost();
let mem = env.cost_estimate().budget().memory_bytes_cost();
let res = env.cost_estimate().resources();
assert!(res.instructions < 400_000_000);   // pubnet ceiling
assert!(res.write_entries <= 200);
```

Actual output from that run (a trivial `add(2,3)` contract, so treat as a floor, not a
benchmark):

```
cpu_instruction_cost   = 15934
memory_bytes_cost      = 5787
resources.instructions = 11747
resources.mem_bytes    = 1217
resources.write_entries = 0
fee.total              = 9
```

Two caveats the SDK itself flags and the audit should repeat: (1) native Rust tests
**underestimate** CPU relative to real WASM, because "all the costs related to VM
instantiation and execution, as well as Wasm reads/rent bumps will be missed"; (2) for exact
numbers, simulate against RPC. So budget assertions here are a regression guard against a
future edit blowing up a hot path, not a claim about production cost.

Note also `EnvTestConfig` in 27.0.6 has exactly one field, `capture_snapshot_at_drop`. The
`resources()` panic message references enabling metering in `EnvTestConfig`, but no such knob
exists in this version - metering is simply on.

---

## 6. `cargo mutants` and `cargo llvm-cov` on this crate

### llvm-cov: works, no wasm/cdylib problem at all

It compiles for the host, so `crate-type = ["lib", "cdylib"]` and `wasm32v1-none` are
irrelevant to it. `testutils` comes in through `[dev-dependencies]` automatically.

```
$ cargo llvm-cov --summary-only
test result: ok. 52 passed; 0 failed; ...
TOTAL   2116 regions  45 missed  97.87%   1046 lines  30 missed  97.13%
```

That headline number is inflated because the `src/test/` files count themselves. Excluding
them:

```
$ cargo llvm-cov --summary-only --ignore-filename-regex 'src/test'
Filename      Regions  Missed  Cover    Functions  Missed  Executed  Lines  Missed  Cover
lib.rs            316      24  92.41%          25       6    76.00%    180      18  90.00%
policy.rs          68       2  97.06%           5       0   100.00%     42       0 100.00%
storage.rs        161       7  95.65%          25       2    92.00%    114       4  96.49%
TOTAL             545      33  93.94%          55       8    85.45%    336      22  93.45%
```

**Use the `--ignore-filename-regex 'src/test'` number (93.45% lines, 85.45% functions), not
97.13%.** Also worth chasing: `error.rs` and `event.rs` do not appear at all, and 6 of 25
functions in `lib.rs` are never executed - likely view functions, which INV-04 says must be
proven side-effect free.

### cargo mutants: works, 137 mutants

```
$ cargo mutants --list
... 137 mutants, e.g.:
contracts/agent-spend-policy/src/storage.rs:220:30: replace / with * in today
contracts/agent-spend-policy/src/storage.rs:226:5: replace get_spent_on_day -> i128 with 0
contracts/agent-spend-policy/src/storage.rs:226:5: replace get_spent_on_day -> i128 with 1
contracts/agent-spend-policy/src/storage.rs:226:5: replace get_spent_on_day -> i128 with -1
contracts/agent-spend-policy/src/storage.rs:235:5: replace set_spent_on_day with ()
```

A partial run over `policy.rs` alone (32 of the 137 mutants) already found a survivor:

```
$ cargo mutants -f contracts/agent-spend-policy/src/policy.rs --timeout 120
ok       Unmutated baseline in 28s build + 1s test
MISSED   contracts/agent-spend-policy/src/policy.rs:120:16: replace < with <= in
         check_balance in 0s build + 1s test
32 mutants tested in 86s: 1 missed, 31 caught
EXIT=2
```

The mutated line is:

```rust
fn check_balance(balance: i128, amount: i128) -> Result<(), Error> {
    if balance < amount {                  // mutant: balance <= amount
        return Err(Error::InsufficientBalance);
    }
    Ok(())
}
```

Turning `<` into `<=` makes the vault refuse a payment of *exactly* its whole balance with
`InsufficientBalance`, and **all 52 tests still pass**. So nothing in the suite asserts that
spending the full balance succeeds - a boundary case on INV-08 and on the truthfulness of
the typed error (threat-model asset 4). Hand this to Phase 3 as a live lead, and note the
run rate: 32 mutants in 86s including a 28s baseline build, so all 137 should land in roughly
five to eight minutes.

Gotchas, in decreasing order of how much they will bite:

1. **The `cdylib` is a non-issue.** cargo-mutants has mutated `cdylib`, `rlib` and every other
   `*lib` target since 1.0.0 (2022-08-21): "Generate mutations in `cdylib`, `rlib`, and every
   other `*lib` target. For example, this correctly exercises Wasm projects."
   (<https://mutants.rs/changelog.html>). Nothing special is needed.
2. **It runs the host test suite**, so `testutils` arrives via `[dev-dependencies]`
   automatically. No feature flag required.
3. **It writes.** cargo-mutants builds into `target/` (and copies the tree per job). Phase 2
   running it in the real repo will dirty `soroban/target/`, which is `.gitignore`d, but
   budget the time: 137 mutants at roughly a build+test cycle each.
4. **Use `--timeout`.** Give it an explicit ceiling so a mutant that turns a bounded loop
   unbounded does not hang the run.
5. **`mock_all_auths` blind spot.** Threat model §3 warns a suite that mocks all auths passes
   identically against a contract with the guard removed. Mutants will confirm or refute that
   mechanically: a `replace require_auth with ()`-shaped mutant surviving is the finding.

---

## 7. Dependency and unsafe tooling

```
$ cargo audit
    Loaded 1225 security advisories (from ~/.cargo/advisory-db)
    Scanning Cargo.lock for vulnerabilities (215 crate dependencies)
Crate:     paste
Version:   1.0.15
Warning:   unmaintained
Title:     paste - no longer maintained
Date:      2024-10-07
ID:        RUSTSEC-2024-0436
URL:       https://rustsec.org/advisories/RUSTSEC-2024-0436
warning: 1 allowed warning found
```

Zero vulnerabilities; one unmaintained transitive crate. Consistent with the threat model's
"none for `soroban-sdk`, `soroban-env-host`, `stellar-xdr`" finding, and extends it to the
whole tree.

```
$ cargo deny check
advisories FAILED, bans ok, licenses FAILED, sources ok
 168 error[rejected]: failed to satisfy license requirements
   1 error[unmaintained]: paste - no longer maintained
  14 warning[duplicate]: block-buffer, cpufeatures, crate-git-revision, crypto-common,
      curve25519-dalek, darling, darling_core, darling_macro, digest, fiat-crypto,
      hashbrown, stellar-strkey, syn (2 versions each)
```

**`cargo deny` needs a `deny.toml` before it says anything useful.** Without one it rejects
168 crates purely because no license allow-list is configured; that is noise, not a finding.
The only real signals are the same `paste` advisory and the duplicate-version list. Phase 2
should write a `deny.toml` (which lives in `soroban/`, so the lead must do it, not R4).

```
$ cd contracts/agent-spend-policy && cargo geiger --output-format Ascii
73/234     10710/16349  221/271  44/44  434/658
error: Found 28 warnings
```

Gotcha: run it **from the package directory**; from the workspace root it refuses -
"manifest path ... is a virtual manifest, but this command requires running against an actual
package in this workspace". The counts cover the entire dependency tree including proc-macro
and dev dependencies, so they say little about the contract itself; the threat model already
established `unsafe` blocks: none, by grep. Low value here, cheap to run.

---

## 8. semgrep and cargo-udeps

**semgrep - install command works, but there is nothing to run.**

- macOS install: `brew install semgrep` (Homebrew 6.0.17 present).
- Rust is **Generally available** in *Semgrep Code* with "cross-function dataflow analysis,
  40+ Pro rules" (<https://docs.semgrep.dev/supported-languages>). Those Pro rules are the
  **paid** engine, not the OSS CLI.
- The free community ruleset has **zero** Rust rules. Enumerating the full
  `semgrep/semgrep-rules` tree (`develop`, not truncated) by top-level language directory:

  ```
  python 337, terraform 363, generic 256, yaml 181, javascript 173, ai 131, java 125,
  ruby 94, go 78, php 65, csharp 52, solidity 50, dockerfile 37, problem-based-packs 37,
  scala 27, typescript 25, ocaml 24, apex 18, c 16, package_managers 16, kotlin 14,
  elixir 7, bash 6, html 6, clojure 5, swift 4, json 3
  rust: 0
  ```
  No `soroban` or `stellar` path anywhere in the repo either.

**Verdict: do not install semgrep for this audit.** It would only run hand-written rules, and
`rg` already does that at lower cost. If someone insists, the honest framing is "custom rules
authored for this audit", not "semgrep found X".

**cargo-udeps - installable, near-zero value.**

- Install: `cargo install cargo-udeps --locked`.
- Run: `cargo +nightly udeps`. The README is explicit that "while compilation of this tool
  also works on Rust stable, it needs Rust nightly to actually run", because it passes `-Z`
  flags (<https://github.com/est31/cargo-udeps/blob/master/README.md>).
- This crate has exactly one dependency (`soroban-sdk`) plus one dev-dependency (the same
  crate with `testutils`). There is nothing for udeps to find. **Skip it**, or run it once at
  the workspace level for completeness and expect a clean result.

---

## 9. Recommended run order for Phase 2

Ordered by evidence-per-minute, cheapest first. Everything writes to `soroban/target/`, which
is git-ignored; nothing here mutates tracked files except where flagged.

**Tier 0 - free, seconds, run first**

1. `cd soroban && cargo clippy --all-targets -- -D warnings` - establish the clean baseline.
2. `cd soroban && cargo clippy --lib -p agent-spend-policy -- -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::expect_used -W clippy::indexing_slicing -W clippy::panic`
   - the security set without `pedantic`. Expect the 4 `storage.rs` unwraps (P-3) and nothing
   else. Save the output.
3. `cd soroban && cargo clippy --lib -p agent-spend-policy -- -W clippy::pedantic` - once, for
   the record, then set aside; it is 41 warnings of style.
4. `cd soroban && cargo audit` - expect the single `paste` RUSTSEC-2024-0436 warning.
5. `gitleaks dir /Users/mericcintosun/A-Identity` - the operator key lives outside this
   contract, so this covers the actor the threat model names.

**Tier 1 - minutes, high signal**

6. `cd soroban && cargo llvm-cov --summary-only --ignore-filename-regex 'src/test'` - then
   `cargo llvm-cov --html` to see which of `lib.rs`'s 6 unexecuted functions and 18 unhit
   lines matter. Cross-check against the 12 view functions and INV-04.
7. `cd soroban/contracts/agent-spend-policy && cargo geiger --output-format Ascii` - from the
   package directory, not the workspace root.
8. Write a `deny.toml` with a license allow-list, then `cd soroban && cargo deny check`. Until
   the config exists the 168 license errors are noise; do not report them.
9. Run `soroban/audit/run-negative-controls.mjs` - the prior art the threat model §9 says to
   run rather than reinvent.

**Tier 2 - tens of minutes, the two that actually test the tests**

10. `cd soroban && cargo mutants --timeout 120` (137 mutants, ~5-8 minutes). Every survivor is
    a Phase 3 candidate; `mutants.out/missed.txt` is the deliverable. One survivor is already
    known from R4's partial run (`policy.rs:120` `check_balance`, section 6). Pay special
    attention to survivors around `require_auth` and around the `settle`
    write-then-transfer ordering (P-5).
11. Add the `testutils` feature to `contracts/agent-spend-policy/Cargo.toml`, `cargo fuzz init`,
    append `[workspace]` to `fuzz/Cargo.toml`, then
    `cargo +nightly fuzz run --sanitizer=thread --build-std fuzz_target_1 -- -max_total_time=1800`.
    Use the reference target in section 3. Then write a **second** target with auth ENFORCED
    (no `mock_all_auths`) that asserts every `pay` from a non-operator lands in
    `Err(Err(InvokeError::Abort))` - that is the mechanical test of INV-01/INV-02, and the one
    thing `mock_all_auths()` can never prove.

**Tier 3 - budget assertions (write new tests, coordinate with the lead)**

12. Add resource assertions to the money paths using
    `env.cost_estimate().resources().instructions` / `.write_entries`, bounded by the pubnet
    ceilings in section 5. This is the guard for the "instance storage exhaustion bricks
    `withdraw`" concern (INV-19/INV-20).

**Do not run**

- **Scout** (`cargo scout-audit`) - cannot compile soroban-sdk 27, and reports
  `Analyzed / 0 findings / exit 0` anyway. If it appears in the report at all, it must appear
  as "could not analyze", with section 2a's output.
- **OpenZeppelin `soroban-scanner`** and therefore **Inspector** - panics on every input,
  release binary and source build alike (section 2b).
- **semgrep** - zero free Rust rules (section 8).
- **cargo-udeps** - one dependency; nothing to find.
- **Slither, Mythril, Echidna, Manticore, Aderyn, Securify, Foundry/Forge** - EVM/Solidity
  only, forbidden by the audit protocol, not researched.

---

## 10. Blockers the lead needs to decide on

1. **Both Soroban-specific static analyzers are dead on arrival.** Scout cannot build against
   soroban-sdk 27 and lies about it; OpenZeppelin's scanner panics on any input. That means
   **there is no working Soroban-aware static analyzer for this contract today**, and the
   audit's static-analysis coverage rests on clippy plus manual review. This should be stated
   in the report rather than papered over - and it strengthens the case for spending the time
   on mutation testing and fuzzing instead.
2. **Fuzzing requires a source change to `soroban/`.** The contract crate must declare
   `[features] testutils = ["soroban-sdk/testutils"]`. R4 was not permitted to make it. It is
   additive, does not change the wasm, and does not touch the deployed hash, but it is a
   tracked-file edit and needs the lead's sign-off.
3. **`cargo deny` needs a `deny.toml`** in `soroban/` before its output is meaningful. Also a
   tracked-file addition.
4. **`rustup component add rust-src --toolchain nightly` was run** on this machine during
   research (required by `cargo fuzz --build-std`). No repo file was touched; noting it for
   reproducibility.

---

## 11. Raw evidence saved alongside this report

| File | What it is |
| --- | --- |
| `audit/tool-output/R4-scout-audit-run.txt` | full `cargo scout-audit` run log, including the soroban-sdk build-script panic and the "Analyzed / 0" summary printed after it |
| `audit/tool-output/R4-scout-report.json` | the JSON Scout emitted: `"total_vulnerabilities": 0`, `"findings": []`, `"status": "Analyzed"` |
| `audit/tool-output/R4-cargo-mutants-policy-rs.txt` | the partial mutation run over `policy.rs` (1 missed, 31 caught) |
| `audit/research/R4-fuzz-target-reference.rs` | the fuzz target that completed 19,874 runs |
| `audit/research/R4-fuzz-Cargo.toml.reference` | the fuzz crate manifest that builds, including the trailing `[workspace]` |
