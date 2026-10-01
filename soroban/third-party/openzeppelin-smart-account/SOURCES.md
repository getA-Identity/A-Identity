# Sources and deltas

Every pin behind the three wasm files in this directory's README, with the git command
that shows it, so a reviewer can check each line against OpenZeppelin's repository rather
than against us. Read 2026-10-01 (UTC) from a clone of
https://github.com/OpenZeppelin/stellar-contracts.

## Refs

| Ref | Commit | Date | What it is |
|---|---|---|---|
| `v0.6.0` | `82f97111f9568d32653dd5b3563baf5b73509c89` | | BASE of the v0.7.0 differential audit |
| `v0.7.0-rc.1` | `239a2a707a6deeeb53ce0f5388e059c9ce44db58` | 2026-03-02 | HEAD of the v0.7.0 differential audit |
| (none) | `d55dd379714c7b928dc9d9a3c70ddfdc78ff9abd` | 2026-04-02 | "The fixes for the findings highlighted in this report have all been merged at commit d55dd37" |
| `v0.7.0` | `9e8df92a065bff9ffa595b3697f4bd3c243a6d02` | 2026-04-03 | First release after the audit |
| `v0.7.1` | `3f81125bed3114cc93f5fca6d13240082050269a` | 2026-04-10 | Metadata and workflow release |
| `v0.7.2` | `a9c42169000638da937577f592ebf61a7a3c94ca` | 2026-06-09 | **What we build.** Latest non-prerelease tag on 2026-10-01 |
| (main) | `1e513890ecf79833c9d6e7ef38a9358001c0b111` | 2026-07-07 | What smart-account-kit 0.8.0 built and deployed (its `docs/deployments-protocol-27-2026-07-09.md`) |

`v0.7.2` sits on a release branch cut from `v0.7.1` (two commits: `698cf77 chore: bump
soroban_sdk` and `a9c4216 chore: update to 0.7.2`). `1e513890` is on `main`, 38 commits
after `v0.7.1`, and the workspace there still says version 0.7.1. The `v0.8.0-rc.*`
tags are prereleases and are ancestors of `1e513890`. There is no v0.8.0 or v0.9.0
release.

## The audit report

- File: `audits/Stellar Contracts Library v0.7.0 Audit.pdf` in the OpenZeppelin
  repository.
- Cover: "Stellar Contracts RC v0.7.0 Audit", OpenZeppelin Security, April 6, 2026.
  Timeline 2026-03-02 to 2026-03-19.
- At `v0.7.2` the file is git blob `d182add256f84b0549d5008730c41b9458a867f3`, sha256
  `9514b16815e853d656e0f284fb8d82b98135c04b394595f3c3f97e68804f40f5`. It was replaced in
  `187ad25` (2026-04-07, part of `v0.7.1`). The copy first committed at `v0.7.0` (blob
  `836962f43f45c0a8e85795fca0cd5b4bb672b9d9`, sha256
  `fd303427824057a67ca2d31fbf2e0da2f2f3a16bd0e2022c15f90eb7ee0b59d9`) is dated April 2
  and lacks the "fixes merged at d55dd37" line; the text is otherwise the same.
- Public page: https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit
- Kind: a DIFFERENTIAL audit of `239a2a7` against `82f9711`. The smart account code that
  did not change between v0.6.0 and v0.7.0 was reviewed by earlier reports in the same
  `audits/` directory, not by this one.
- Scope, as listed in the report, includes `packages/accounts/src/smart_account/{mod,storage}.rs`,
  `packages/accounts/src/verifiers/{mod,ed25519,webauthn}.rs` and
  `packages/accounts/src/policies/{mod,simple_threshold,spending_limit,weighted_threshold}.rs`.
  **`examples/` is not in scope.** The three crates we build are examples: thin contract
  wrappers (94, 89 and 56 lines of `contract.rs`) around the audited library.
  `packages/contract-utils/src/upgradeable/` (the account's `upgrade` helper) is in scope.
  `soroban-sdk` is a dependency outside the scope.
- 21 issues, 18 resolved. Unresolved: M-05 (raw signer keys stored, canonical form used
  only for duplicate detection; acknowledged as a design choice for passkeys), L-07 and
  L-08 (governor, not used here). The smart account findings H-01, M-06, L-04, L-05, L-06,
  L-09, N-04 and N-05 are marked resolved.

## Source delta: audited fixes (d55dd37) to v0.7.2

```sh
git diff --stat d55dd37 v0.7.2 -- packages/accounts/src packages/contract-utils/src examples/multisig-smart-account
```

- `packages/accounts/src`: no change.
- `packages/contract-utils/src`: no change.
- `examples/multisig-smart-account/*/Cargo.toml`: 4 added lines each
  (`authors.workspace = true` and `[package.metadata.stellar] cargo_inherit = true`).
  No Rust source changes.
- Workspace: `soroban-sdk` 25.3.0 to 26.1.0 (`698cf77`), crate versions 0.7.0 to 0.7.2,
  `Cargo.lock` regenerated for the SDK bump.

So the smart account, verifier and policy library code we build is byte-for-byte the
source the audit's fixes landed at. What is new relative to the audited tree is the SDK
version and the build metadata.

## Source delta: v0.7.2 to 1e513890 (what the kit deployed)

```sh
git diff v0.7.2 1e513890 -- packages/accounts/src packages/accounts/Cargo.toml
git diff --stat v0.7.2 1e513890 -- examples/multisig-smart-account
```

- `packages/accounts/src/smart_account/{mod,storage}.rs`: doc comments only (event
  topic and data descriptions, `76ab671`, `278fbea`).
- `packages/accounts/src/policies/spending_limit.rs`: a zero-amount early return in
  `enforce` (`ce548e0`, "zero transfer fix"), plus its test. This is the spending-limit
  POLICY contract, which is not one of the three crates and is not linked into the
  account.
- `packages/accounts/Cargo.toml`: one dev-dependency removed.
- `packages/contract-utils/src`: new `crypto/grumpkin.rs` and `math/exp_ln.rs`, and
  fixed-point math edits. The account uses only `upgradeable`, which is unchanged.
- `examples/multisig-smart-account`: no change.
- Workspace: same `soroban-sdk` 26.1.0; crate versions say 0.7.1 at `1e513890` against
  0.7.2 at the tag.

## Binary delta: our v0.7.2 build against the kit's deployed wasm

Same toolchain both sides (Rust 1.91.1, stellar CLI 27.0.0), built on this machine:

| Crate | v0.7.2 (ours) | 1e513890 (kit, reproduced) |
|---|---|---|
| `multisig-account-example` | `a12747ff6c139dc14fc2fd30d200d6bbb5da7b5d59812c047ce1f9cad226b289`, 41,911 bytes | `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`, 41,855 bytes |
| `multisig-webauthn-verifier-example` | `e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76`, 12,105 bytes | identical |
| `multisig-ed25519-verifier-example` | `60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477`, 1,848 bytes | identical |

The two verifiers are byte-identical, so the verifier instances smart-account-kit already
deployed run exactly the code the v0.7.2 tag builds to.

For the account, a section-by-section comparison of the two wasm files finds:

- `contractspecv0`: 56 bytes longer at v0.7.2. With every doc string removed, all 38
  spec entries (17 functions, 5 structs, 4 unions, 1 error enum, 11 events) are
  identical. The only differences are the doc strings of `update_context_rule_name` and
  `update_context_rule_valid_until`, which `1e513890` corrected.
- Code section: same size (20,800 bytes) and the same 99 function bodies. Functions 94
  and 95 trade places, and the four call sites that reference them change their call
  index (136 against 137). No other byte differs. The function section (type index per
  function) differs by the same swap.
- `contractenvmetav0`, both `contractmetav0` sections, imports, exports, data, globals,
  memory and table: identical.

## Toolchain

OpenZeppelin does not pin one. `rust-toolchain.toml` at `v0.7.2` says `channel =
"stable"`, and the publish workflow installs whatever stellar CLI release is newest
through the install script on the stellar-cli `main` branch. We pin
the toolchain smart-account-kit recorded for its deployment, because it is the one that
demonstrably reproduces published hashes:

- Rust 1.91.1 (`rustc 1.91.1 (ed61e7d7e 2025-11-07)`), target `wasm32v1-none`
- stellar CLI 27.0.0 (`5a7c5fe76530bf4248477ac812fc757146b98cc4`), release tarball
  checked against GitHub's published sha256
- `stellar contract build --locked --optimize=true --package <crate>`

The same v0.7.2 source built with Rust 1.96.0 and stellar CLI 27.1.0 gives a different
account wasm (`f6f40f18...`, 41,484 bytes) and a different WebAuthn verifier
(`71df7b7a...`, 12,290 bytes). The pin is not decoration.
