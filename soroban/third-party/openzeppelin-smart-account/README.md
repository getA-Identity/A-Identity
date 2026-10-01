# OpenZeppelin smart account, built from the audited release

This directory holds no contract source. It records how we build three contracts that
belong to OpenZeppelin, from OpenZeppelin's own repository at a released tag, so that the
wasm hash a passkey wallet runs on can be traced to a named, audited version and rebuilt
by anyone.

| Contract | OpenZeppelin crate | sha256 (= Stellar wasm hash) | Bytes |
|---|---|---|---:|
| Smart account | `examples/multisig-smart-account/account` (`multisig-account-example`) | `a12747ff6c139dc14fc2fd30d200d6bbb5da7b5d59812c047ce1f9cad226b289` | 41,911 |
| WebAuthn verifier | `examples/multisig-smart-account/webauthn-verifier` (`multisig-webauthn-verifier-example`) | `e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76` | 12,105 |
| Ed25519 verifier | `examples/multisig-smart-account/ed25519-verifier` (`multisig-ed25519-verifier-example`) | `60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477` | 1,848 |

Source: [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts)
tag `v0.7.2`, commit `a9c42169000638da937577f592ebf61a7a3c94ca`. Toolchain: Rust 1.91.1,
stellar CLI 27.0.0, `stellar contract build --locked --optimize=true --package <crate>`.

Why it exists: selection bar 1 of SOW 2 deliverable D3 asks for a third-party audit
report at a named version. A wasm hash is the only thing the chain knows about a
contract, so the bar is only checkable if the hash can be rebuilt from the audited tag.
That is what `build.sh` does.

## Whose is what

- **The code and the audit are OpenZeppelin's.** We did not write, modify or audit these
  contracts, and we do not vendor their source here; `build.sh` fetches it.
- **The testnet instances we deploy are ours.** Uploading a wasm and deploying a verifier
  instance from our own account makes the instance ours to point at; it does not make
  the code ours. A Stellar code entry is content-addressed, so whoever uploads the bytes,
  the hash is the same and is what a reviewer should check.
- **Pubnet is not covered by this build.** The pubnet flow keeps using the published
  smart-account-kit deployment of OpenZeppelin's code (account wasm `1b5f4534...`,
  WebAuthn verifier `CB7HENHJ...`; the kit is published from `stellar/smart-account-kit`
  and its deployment account is `GAAH4OT3...`). That build comes from OpenZeppelin's
  `main` at `1e513890`, not from a release tag, and is labelled as such. See "Delta"
  below for exactly how far that is from `v0.7.2`.

## The audit

- Report: "Stellar Contracts RC v0.7.0 Audit" by OpenZeppelin Security, dated
  April 6, 2026, review window 2026-03-02 to 2026-03-19. It sits in the OpenZeppelin
  repository at `audits/Stellar Contracts Library v0.7.0 Audit.pdf` (at `v0.7.2`: git
  blob `d182add2...`, file sha256 `9514b168...`; full ids in [SOURCES.md](SOURCES.md)),
  and is published at https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit.
- Kind: a differential audit of `239a2a7` (v0.7.0-rc.1) against `82f9711` (v0.6.0). Its
  scope lists `packages/accounts/src/smart_account`, `packages/accounts/src/verifiers`
  (including `webauthn.rs` and `ed25519.rs`) and `packages/accounts/src/policies`, plus
  `packages/contract-utils/src/upgradeable`.
- The report states that the fixes for its findings were merged at `d55dd37`. Between
  `d55dd37` and `v0.7.2`, `packages/accounts/src` and `packages/contract-utils/src` are
  unchanged.
- Two honest limits. First, `examples/` is not in the audit scope, and the three crates
  are examples: thin wrappers (94, 89 and 56 lines of `contract.rs`) that expose the
  audited library functions as contract entry points. Second, `v0.7.2` moved
  `soroban-sdk` from 25.3.0 to 26.1.0, and the SDK was never in scope.
- 21 findings, 18 resolved. The one unresolved finding that touches accounts is M-05:
  signer keys are stored raw and the canonical form is used only for duplicate
  detection, which OpenZeppelin kept on purpose for passkeys (the credential id travels
  with the key).

## Compatibility with smart-account-kit 0.8.0

Checked, not assumed. The kit encodes every call through the contract spec in
`smart-account-kit-bindings` 0.4.0, so the spec is what has to match.

- Account: with doc strings removed, all 38 spec entries of our `a12747ff...` build are
  identical to the kit's deployed `1b5f4534...` (fetched read-only from testnet) and to
  the 38 entries baked into `smart-account-kit-bindings` 0.4.0. That covers the
  constructor `__constructor(signers: Vec<Signer>, policies: Map<Address, Val>)`,
  `execute`, `__check_auth`, the context rule, signer and policy functions, `upgrade`,
  the `Signer`, `ContextRule` and `AuthPayload` types, the error enum and the 11 events.
- Verifiers: our builds are byte-identical to the kit's, so their specs are too
  (`verify`, `canonicalize_key`, `batch_canonicalize_key`). They have no constructor, no
  `upgrade` entry point, and the kit's live instances hold no instance storage (read
  2026-10-01), so a fresh instance needs no arguments and behaves identically.
- The kit takes `accountWasmHash`, `webauthnVerifierAddress` and `ed25519VerifierAddress`
  as configuration, and by default accepts at birth only the configured account hash.
  Pointing it at `a12747ff...` and at our verifier instances is a configuration change,
  not a code change.

## Delta between v0.7.2 and what the kit deployed

Full detail in [SOURCES.md](SOURCES.md). In short, both built here with the same pinned
toolchain:

- WebAuthn and Ed25519 verifiers: byte-identical. The kit's deployed verifier
  instances on testnet (`CC7EKIHQ...`, `CAAVTMCB...`) and pubnet (`CB7HENHJ...`,
  `CBOOZV2B...`) already run exactly what `v0.7.2` builds to.
- Account: `a12747ff...` against `1b5f4534...`. The source difference that reaches the
  account is doc comments. In the binary, the spec section carries those longer doc
  strings (56 bytes), and in the code section two functions trade places with the four
  call sites that name them adjusted. No other byte differs.

## On chain, as read before anything was uploaded

Read-only `getLedgerEntries` on 2026-10-01 around 23:10 UTC, testnet ledger 4974511:

- The `a12747ff...` code entry was ALREADY present on testnet, live until ledger
  4994944 (about 20,400 ledgers, a little over a day). We did not upload it and did not
  identify who did; content addressing means it is the same bytes either way. It will
  archive unless its TTL is extended, which is why the planned upload is
  followed by a TTL extend.
- `e63a030d...` and `60e8798d...` are present on testnet and pubnet, uploaded by the
  smart-account-kit maintainers (deployment account `GAAH4OT3...`).
- `a12747ff...` is absent on pubnet.

Planned, not done: uploading the three wasm files from our testnet deployer and
deploying our own two verifier instances. Until those transactions exist with receipts,
nothing on this page claims an instance of ours.

## Planned testnet deployment

Run by a human holding the `passkey-deployer` identity, after `build.sh` has printed the
three hashes above. Each verifier salt is the sha256 of
`a-identity:OpenZeppelin/stellar-contracts:<full v0.7.2 commit>:testnet:<role>`, so the
salt itself names what was deployed:

| Role | Salt |
|---|---|
| `webauthn-verifier` | `97d1415720d0f50b1e60d7fd5c7183d3e54f6290be326cdc9eeac2ab80370f98` |
| `ed25519-verifier` | `6c7ed5290aed8a389030d6bfd1912bf1db06620cdca4add7cb76b35a7bb747d0` |

```sh
OUT=/path/to/scratch/out   # build.sh's output directory

# 1. Upload. Each command prints the wasm hash; it must equal the table at the top. The
#    two verifier code entries already exist, and the CLI may report that and skip.
stellar contract upload --wasm "$OUT/oz-v0.7.2-multisig_account_example.wasm" --source-account passkey-deployer --network testnet
stellar contract upload --wasm "$OUT/oz-v0.7.2-multisig_webauthn_verifier_example.wasm" --source-account passkey-deployer --network testnet
stellar contract upload --wasm "$OUT/oz-v0.7.2-multisig_ed25519_verifier_example.wasm" --source-account passkey-deployer --network testnet

# 2. Keep the account code alive through the evidence window (about 31 days).
stellar contract extend --wasm-hash a12747ff6c139dc14fc2fd30d200d6bbb5da7b5d59812c047ce1f9cad226b289 --ledgers-to-extend 535679 --durability persistent --source-account passkey-deployer --network testnet

# 3. Predict, then deploy, the two verifier instances. Neither has a constructor.
stellar contract id wasm --salt 97d1415720d0f50b1e60d7fd5c7183d3e54f6290be326cdc9eeac2ab80370f98 --source-account passkey-deployer --network testnet
stellar contract id wasm --salt 6c7ed5290aed8a389030d6bfd1912bf1db06620cdca4add7cb76b35a7bb747d0 --source-account passkey-deployer --network testnet
stellar contract deploy --wasm-hash e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76 --salt 97d1415720d0f50b1e60d7fd5c7183d3e54f6290be326cdc9eeac2ab80370f98 --alias oz-v072-webauthn-verifier --source-account passkey-deployer --network testnet
stellar contract deploy --wasm-hash 60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477 --salt 6c7ed5290aed8a389030d6bfd1912bf1db06620cdca4add7cb76b35a7bb747d0 --alias oz-v072-ed25519-verifier --source-account passkey-deployer --network testnet

# 4. Read back what landed, the way a reviewer would.
stellar contract fetch --id <webauthn verifier id> --network testnet --out-file webauthn.wasm
stellar contract fetch --id <ed25519 verifier id> --network testnet --out-file ed25519.wasm
stellar contract fetch --wasm-hash a12747ff6c139dc14fc2fd30d200d6bbb5da7b5d59812c047ce1f9cad226b289 --network testnet --out-file account.wasm
shasum -a 256 webauthn.wasm ed25519.wasm account.wasm
```

The account wasm is uploaded and never deployed as a singleton: every passkey wallet
deploys its own instance with its signer as a constructor argument, through the kit.
Reusing the kit's existing testnet verifier instances (`CC7EKIHQ...`, `CAAVTMCB...`)
would be technically equivalent, because they run the same bytes and hold no state; we
deploy our own so that every contract a D3 wallet touches on testnet is either content
we rebuilt or an instance we created.

## Known issues we carry, stated rather than discovered later

**OpenZeppelin issue #876**, "Auth digest is not bound to an account and delegated
signers authorize an opaque hash" (https://github.com/OpenZeppelin/stellar-contracts/issues/876,
opened and closed 2026-09-10). The digest a signer signs is
`sha256(signature_payload || context_rule_ids)`, and the host's `signature_payload` does
not name the account, so a signature collected for one smart account also verifies on
another account that lists the same external key, given the same nonce, expiration and
invocation tree. The fix, PR #868, was merged into the `v0.9.0` branch, which is
unreleased; `v0.7.2` and the kit's `1b5f4534...` both carry the issue, and there is no
released tag without it. Our exposure is low and the reason is specific: our passkey
signs only invocations rooted at the account's own `execute`, so the account's address is
the root contract of the signed invocation tree, and the relay refuses anything else.
Replaying that signature on another account would need a different root, which is a
different payload. It would matter for a passkey registered on several accounts that
authorized calls rooted elsewhere, which is not a flow we offer.

**The WebAuthn verifier does not check origin or `rpIdHash`.** OpenZeppelin documents
this in `packages/accounts/src/verifiers/webauthn.rs`: origin validation, RP ID hash
validation, the signature counter, extensions and attestation are omitted. What it does
check is the `webauthn.get` type, that the challenge is the base64url of the signature
payload, the User Present and User Verified flags, the backup flags' consistency, and the
secp256r1 signature over `authenticatorData || sha256(clientDataJSON)`. Every one of
those inputs can be produced by a software P-256 key. **So the chain cannot tell a device
authenticator from a software key.** That is why the 2026-09-19 testnet passkey artifacts,
signed by a software P-256 key in `mcp/scripts/stellar-passkey-proof.mjs`, verify on chain
and are still not D3 evidence. Device provenance has to be shown off chain, by a real
device at https://a-identity.xyz/stellar?network=testnet, never inferred from a
successful `__check_auth`.

## Rebuild and compare

```sh
# Builds v0.7.2 in a scratch directory and prints each sha256 against the table above.
soroban/third-party/openzeppelin-smart-account/build.sh

# Same, but first rebuilds the kit's commit 1e513890 and requires its three published
# hashes, which proves this machine's toolchain before you trust a v0.7.2 hash.
soroban/third-party/openzeppelin-smart-account/build.sh --kit-check /path/to/scratch
```

The script installs Rust 1.91.1 beside your default toolchain (never over it), downloads
the stellar CLI 27.0.0 release tarball and checks it against GitHub's published sha256,
clones the tag shallowly, refuses to build if the tag does not resolve to
`a9c42169...`, and exits non-zero on any hash mismatch. It needs `rustup`, `git`, `curl`
and network access to GitHub and crates.io. It never signs or submits anything.

To compare a build with what is on chain (read-only):

```sh
stellar contract fetch --wasm-hash a12747ff6c139dc14fc2fd30d200d6bbb5da7b5d59812c047ce1f9cad226b289 --network testnet --out-file account.wasm
stellar contract fetch --id <verifier contract id> --network testnet --out-file verifier.wasm
shasum -a 256 account.wasm verifier.wasm
```

## Reproducibility, honestly

- On this machine (macOS, Apple silicon), the v0.7.2 hashes came out identical from
  three separate builds: one from an exported source tree, and two runs of `build.sh`,
  each from a fresh shallow clone with fresh cargo target directories.
- The same toolchain also reproduced, byte for byte, the three hashes smart-account-kit
  published for `1e513890`, which its maintainers built and published independently of
  us. That is evidence the pinned toolchain is portable. It is not a guarantee: Rust does
  not promise bit-reproducible wasm across hosts, and we have not run `build.sh` on Linux.
- Somebody else also arrived at `a12747ff...`: that code entry was already on testnet
  before we uploaded anything (see "On chain" above). We cannot say who uploaded it or
  how they built it, so we note it rather than count it as an independent reproduction.
- The toolchain pin matters. The same source built with Rust 1.96.0 and stellar CLI
  27.1.0 gives a different account hash and a different WebAuthn verifier hash.
- If your hashes differ, compare the contract spec (`stellar contract info interface
  --wasm <file>`) and the code section before concluding anything about the source.

## Files

- `build.sh`: the pinned rebuild described above.
- `SOURCES.md`: every ref, blob and delta behind this page, with the git command for each.
- `receipt-build-2026-10-01.json`: the build we ran, its hashes, the ABI comparison and
  the read-only chain reads it was checked against.
