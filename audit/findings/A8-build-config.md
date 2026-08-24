# A8 - Build configuration, dependencies and operational security

Phase 3 finding set. Domain: release profile, feature-flag leakage, dependency advisories
and pinning, `unsafe`, secrets in the repository and its history, CI security gates,
`.gitignore` hygiene, reproducibility of the deployed wasm hash.

Everything below was run or probed on **2026-08-24** on this machine. Nothing is recalled
from memory and nothing is inherited on trust: every claim carried in from Phase 0/1/2 was
re-derived here, and two of them came back different from how they were handed over. Those
two are called out where they occur.

Builds were done in a throwaway copy at
`/private/tmp/.../scratchpad/sb`. Nothing under `soroban/`, `mcp/` or `src/` was modified.
No key material is printed, reconstructed or transcribed anywhere in this document.

---

## Summary

| ID | Severity | Title |
| --- | --- | --- |
| A8-01 | **High** | No channel in this project can ever surface a soroban-sdk security advisory |
| A8-02 | **Medium** | CI never builds, hashes or verifies the artifact that is actually deployed |
| A8-03 | **Medium** | GitHub secret scanning and push protection are off on a public repo that operates a live mainnet vault |
| A8-04 | Low | Six CI gates that Phase 2 proved find real defects are absent, and no cargo step is `--locked` |
| A8-05 | Low | The `testutils` feature is safe, but the Cargo.toml comment states a guarantee that does not exist |
| A8-06 | Low | `.gitignore:81` hides two subdirectory ignore files; a fresh clone will stage the built wasm (confirms G-2) |
| A8-07 | Low | "Reviewed with the free tooling, with output committed" is published on mainnet and names no committed output |
| A8-08 | Info | Reproducibility is stronger than the docs claim, and is bound to a stellar CLI version pinned nowhere |
| A8-09 | Info | Release profile, `unsafe` and dependency pinning verified clean; cargo-geiger did not actually run |
| A8-10 | Info | CoinFabrik Scout is not referenced anywhere in this repository. Explicitly not a finding |

Counts: 0 Critical, 1 High, 2 Medium, 4 Low, 3 Informational.

**On the gitleaks assessment.** All 7 hits are false positives. Verified independently,
not accepted. The lead auditor's *conclusion* is right; one of the lead auditor's *reasons*
is wrong, and the wrong reason matters. See A8-03, "Independent re-verification of the
gitleaks hits".

---

## A8-01. No channel in this project can ever surface a soroban-sdk security advisory

**Severity:** High
**Impact:** High. A published vulnerability in the single dependency that constitutes the
contract's entire trusted computing base would reach this project only if a human happened
to read a GitHub page. The contract has no upgrade entrypoint (threat model P-1), so the
remediation for an SDK advisory that does apply is `withdraw` -> redeploy -> repoint, with
a new contract id and a provenance update. Time-to-detect is therefore the dominant term in
time-to-remediate, and time-to-detect is currently unbounded.
**Likelihood:** Medium. Five advisories have already been published against this stack, one
of them High severity, and the maintainers backport fixes into every supported line
(22.x, 23.x, 25.x). A `>=27.0.0,<27.0.N` range is a matter of when, not if.
**Violates:** n/a to the contract invariants. This is a process control, not a contract
property. It bears on every invariant equally, because an SDK defect can break any of them
from underneath the source.
**Location:**
- `.github/workflows/soroban.yml:52-57` (the step named "Advisory audit")
- `soroban/deny.toml:10-32` (`[advisories]`, which reads the same database)
- absent: `.github/dependabot.yml`
- repository settings on both remotes
**Category:** Supply chain / vulnerability management
**Detected by:** `cargo audit` 0.22.2 coverage analysis, a full-text scan of the local
RustSec clone, `gh api repos/{repo}/security-advisories`, `gh api graphql
securityVulnerabilities(ecosystem: RUST, ...)`, and `gh api repos/{repo}` for the
Dependabot state. All re-run for this finding.
**Status:** Open. New. Not a duplicate of G-1 or of the negative-control prior art.

### Description

`.github/workflows/soroban.yml` carries a step named "Advisory audit". Its comment states
the intent plainly and correctly:

```yaml
      # A stale or vulnerable dependency is itself a published Soroban audit finding, so
      # it is caught mechanically rather than left to whoever remembers to look.
      - name: Advisory audit
        run: |
          cargo install cargo-audit --locked || true
          cargo audit
```

`cargo audit` reads the RustSec advisory database and nothing else. RustSec has never
carried a Stellar advisory of any kind. That is not "no advisory was found for these
crates"; it is "this database does not cover this ecosystem". A green result there is the
same green you would get for a crate that does not exist.

GitHub, meanwhile, does cover these crates. Six advisories are published against crates
that are in this project's `Cargo.lock`, and one of them is a High-severity defect in
`#[contractimpl]` itself, that is, in the macro layer that generates this contract's
dispatch table.

The other channel that would read GitHub's database, Dependabot, is disabled on both
remotes, and there is no `.github/dependabot.yml` and no `renovate.json` anywhere in the
repository.

So the position is: the only mechanical advisory check this project runs is structurally
incapable of reporting an advisory against the one dependency that matters, and the check
that would be capable of it is switched off. The step is decorative with respect to
soroban-sdk. It is not decorative with respect to the other 209 crates, which is why the
fix is to add a channel rather than to remove this one.

**One correction to the handed-over research.** R3 reports five GHSAs against the Stellar
Rust stack, found by listing advisories per repository. Querying the GitHub Advisory
Database by *crate* instead finds a **sixth**, on a crate that is inside the deployed wasm:

```
GHSA-5873-6fwq-463f  MODERATE  stellar-strkey  vulnerable: < 0.0.8  first patched: 0.0.8
  stellar-strkey vulnerable to panic in SignedPayload::from_payload  (2023-10-25)
```

Our lock carries `stellar-strkey` 0.0.13 and 0.0.16, so it does not apply. The point is not
the advisory. The point is that a careful human sweep by a dedicated research agent, run
today, missed one, and the mechanical query did not. That is the argument for the gate.

### Proof of concept

**1. RustSec carries nothing for this ecosystem.** Local clone, synced today:

```
$ DB=~/.cargo/advisory-db
$ git -C $DB log -1 --format='%H %ci %s'
cebc72be9ffc5707a5b0c70fc662198a1eb231a4 2026-08-24 16:54:28 +0200 Create RUSTSEC-0000-0000.md (#3170)
$ ls $DB/crates | wc -l
     909
$ find $DB -name 'RUSTSEC-*.md' | wc -l
    1206
$ grep -ril soroban $DB | wc -l
       0
$ grep -ril stellar $DB | wc -l
       0
```

909 crate directories, 1206 advisories, zero occurrences of the strings "soroban" or
"stellar" anywhere in the database, including in prose.

**2. GitHub carries six.** `gh api repos/{repo}/security-advisories`, today:

```
--- stellar/rs-soroban-sdk ---
GHSA-x2hw-px52-wp4m CVE-2026-32322 medium `Fr` scalar field equality comparison bypasses modular reduction
GHSA-4chv-4c6w-w254 CVE-2026-26267 high   `#[contractimpl]` macro calls inherent function instead of trait function when names collide
GHSA-96xm-fv9w-pf3f CVE-2026-24889 medium Overflow in Bytes::slice, Vec::slice, GenRange::gen_range for u64
--- stellar/rs-soroban-env ---
GHSA-pm4j-7r4q-ccg8 no-cve      low       Muxed address<->ScVal conversions may break after a conversion failure
--- stellar/rs-stellar-xdr ---
GHSA-x57h-xx53-v53w CVE-2026-29795 medium StringM::from_str bypasses max length validation
```

plus, by crate query rather than by repository:

```
$ gh api graphql -f query='query($p:String!){securityVulnerabilities(ecosystem: RUST, package: $p, first: 50){nodes{advisory{ghsaId severity summary}vulnerableVersionRange firstPatchedVersion{identifier}}}}' -f p=stellar-strkey
GHSA-5873-6fwq-463f MODERATE range=< 0.0.8 patched=0.0.8 :: stellar-strkey vulnerable to panic in SignedPayload::from_payload
```

**3. Dependabot is off on both remotes.** Re-probed today, independent of R3:

```
$ gh api repos/getA-Identity/A-Identity --jq '{private, security_and_analysis}'
{"private":false,"security_and_analysis":{"dependabot_security_updates":{"status":"disabled"}, ...}}
$ gh api repos/mericcintosun/a-identity --jq '{private, security_and_analysis}'
{"private":false,"security_and_analysis":{"dependabot_security_updates":{"status":"disabled"}, ...}}
```

`GET /repos/{owner}/{repo}/vulnerability-alerts` returns 404 on both, which is ambiguous on
its own (404 is also what a token without admin scope gets). The `security_and_analysis`
block reading back is what disambiguates it: that block normally requires admin, and it
says `disabled` in as many words.

**4. There is no config file that would turn it on:**

```
$ ls .github/
workflows
$ find . -name dependabot.yml -o -name renovate.json   # excluding node_modules
(no output)
```

### Recommended fix

Three parts. The first is the gate, the second is the belt-and-braces channel, the third is
one line of honesty in the existing comment.

**Part 1. A CI job that queries the database that actually covers these crates.**

Add `soroban/audit/ghsa-check.mjs`. It parses `Cargo.lock`, batches a GraphQL query against
the GitHub Advisory Database for the RUST ecosystem, and fails the build if any locked
version falls inside a published vulnerable range. It needs no new dependency and no new
credential: `GITHUB_TOKEN` is provided to every Actions run.

This script was written and **run** for this finding, both against the real lock (exit 0,
30 crates carry published advisories, none matching) and against a deliberately vulnerable
synthetic lock (exit 1, three correct hits). Both transcripts are in the Proof of Concept
for A8-01 continued, below the script.

```javascript
#!/usr/bin/env node
// soroban/audit/ghsa-check.mjs
//
// Queries the GitHub Advisory Database for every crate in soroban/Cargo.lock.
//
// Why this exists, and why `cargo audit` is not enough: cargo audit reads RustSec, and
// RustSec has never carried a single Stellar advisory. On 2026-08-24 the database held
// 1206 advisories across 909 crate directories and contained zero occurrences of the
// strings "soroban" or "stellar", in advisory bodies included. GitHub carries six against
// this stack, one of them HIGH (CVE-2026-26267, in the #[contractimpl] macro itself). A
// green `cargo audit` therefore says nothing at all about soroban-sdk. This closes that
// gap. Keep `cargo audit` too: it still covers the other 209 crates.
//
// Requires GITHUB_TOKEN (Actions provides one). Exits 1 on any match, 2 on tool failure.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const LOCK = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Cargo.lock')
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
if (!TOKEN) { console.error('GITHUB_TOKEN is required'); process.exit(2) }

// -- parse Cargo.lock -------------------------------------------------------------------
const pkgs = []
let name = null
for (const line of readFileSync(LOCK, 'utf8').split('\n')) {
  const n = line.match(/^name = "(.+)"$/)
  if (n) { name = n[1]; continue }
  const v = line.match(/^version = "(.+)"$/)
  if (v && name) { pkgs.push({ name, version: v[1] }); name = null }
}
if (pkgs.length === 0) { console.error(`no packages parsed from ${LOCK}`); process.exit(2) }

// -- semver compare, enough for crates.io versions --------------------------------------
function cmp(a, b) {
  const split = (s) => { const [core, pre = ''] = s.split('-', 2); return [core.split('.').map(Number), pre] }
  const [ac, ap] = split(a), [bc, bp] = split(b)
  for (let i = 0; i < 3; i++) { const d = (ac[i] ?? 0) - (bc[i] ?? 0); if (d) return d < 0 ? -1 : 1 }
  if (ap === bp) return 0
  if (ap === '') return 1          // a release outranks its own prereleases
  if (bp === '') return -1
  return ap < bp ? -1 : 1
}
// GHSA ranges look like "< 0.0.8", ">= 23.0.0, < 23.5.3", "= 1.2.3"
function inRange(version, range) {
  return range.split(',').every((part) => {
    const m = part.trim().match(/^(<=|>=|<|>|=)\s*(.+)$/)
    if (!m) return false
    const d = cmp(version, m[2].trim())
    return { '<': d < 0, '<=': d <= 0, '>': d > 0, '>=': d >= 0, '=': d === 0 }[m[1]]
  })
}

// -- query GHSA in batches of GraphQL aliases -------------------------------------------
const names = [...new Set(pkgs.map((p) => p.name))].sort()
const BATCH = 60
const advisories = new Map()   // crate -> [{ ghsaId, severity, summary, range, patched }]

for (let i = 0; i < names.length; i += BATCH) {
  const slice = names.slice(i, i + BATCH)
  const query = `query {\n${slice.map((n, j) => `  a${j}: securityVulnerabilities(ecosystem: RUST, package: ${JSON.stringify(n)}, first: 50) { nodes { advisory { ghsaId severity summary } vulnerableVersionRange firstPatchedVersion { identifier } } }`).join('\n')}\n}`
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'a-identity-ghsa-check' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) { console.error(`GHSA query failed: HTTP ${res.status} ${await res.text()}`); process.exit(2) }
  const body = await res.json()
  if (body.errors) { console.error('GHSA query failed:', JSON.stringify(body.errors)); process.exit(2) }
  slice.forEach((n, j) => {
    const nodes = body.data[`a${j}`]?.nodes ?? []
    if (nodes.length) advisories.set(n, nodes.map((x) => ({
      ghsaId: x.advisory.ghsaId, severity: x.advisory.severity, summary: x.advisory.summary,
      range: x.vulnerableVersionRange, patched: x.firstPatchedVersion?.identifier ?? 'none',
    })))
  })
}

// -- report -----------------------------------------------------------------------------
const hits = []
for (const { name, version } of pkgs) {
  for (const a of advisories.get(name) ?? []) {
    if (inRange(version, a.range)) hits.push({ name, version, ...a })
  }
}

console.log(`GHSA check: ${pkgs.length} locked crates, ${names.length} distinct, ${advisories.size} carrying at least one published advisory range.`)
for (const [crate, list] of [...advisories].sort()) {
  const v = [...new Set(pkgs.filter((p) => p.name === crate).map((p) => p.version))].join(', ')
  const bad = hits.filter((h) => h.name === crate).length
  console.log(`  ${crate} ${v}: ${list.length} published range(s), ${bad} matching`)
}
if (hits.length === 0) { console.log('\nNo locked crate falls in a published GHSA vulnerable range.'); process.exit(0) }
console.error(`\n${hits.length} locked crate(s) fall in a published GHSA vulnerable range:`)
for (const h of hits) console.error(`  ${h.ghsaId} ${h.severity} ${h.name} ${h.version} (vulnerable: ${h.range}, first patched: ${h.patched})\n    ${h.summary}`)
process.exit(1)
```

The workflow step, to sit immediately after the existing `cargo audit`:

```yaml
      # cargo audit above reads RustSec, which has NEVER carried a Stellar advisory: 909
      # crate directories, 1206 advisories, zero hits for "soroban" or "stellar" (checked
      # 2026-08-24). It covers the other 209 crates and nothing about the SDK. GitHub's
      # database does cover them, with six published against this stack including a HIGH
      # in #[contractimpl] itself, so it is queried separately rather than assumed.
      - name: GitHub advisory audit (the database that covers soroban-sdk)
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: node audit/ghsa-check.mjs
```

**Part 2. Dependabot, both as a config file and as the repository setting.**

Add `.github/dependabot.yml` at the repository root:

```yaml
# Version updates. The SECURITY alerts that matter for soroban-sdk are a separate switch:
# Settings -> Code security -> Dependabot alerts, which must be enabled on
# getA-Identity/A-Identity (source of truth). This file does not turn those on.
#
# cargo is listed first and deliberately: it is the ecosystem where a missed advisory is
# unpatchable in place, because the deployed contract has no upgrade entrypoint.
version: 2
updates:
  - package-ecosystem: "cargo"
    directory: "/soroban"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    # soroban-sdk is pinned EXACTLY (=27.0.6) on purpose. A version PR here is a signal to
    # a human to go read the release notes and the advisory page, not a thing to auto-merge.
    labels: ["dependencies", "soroban"]

  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5

  - package-ecosystem: "npm"
    directory: "/mcp"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

Then, in repository Settings -> Code security, on **both** remotes:

- enable **Dependabot alerts** (this is the one that reads GHSA, and it is the actual fix)
- enable **Dependabot security updates**

Verify afterwards with the same probe used above; it should flip to `enabled`:

```
gh api repos/getA-Identity/A-Identity --jq '.security_and_analysis.dependabot_security_updates.status'
```

**Part 3. Correct the comment that overstates the coverage.**

`.github/workflows/soroban.yml:52-53` currently reads as though `cargo audit` is the whole
answer. Replace with wording that says what it does and does not cover. Suggested text is
in the full workflow in A8-04.

### Proof of concept, continued: the proposed gate, actually run

Against the real `soroban/Cargo.lock`:

```
$ GITHUB_TOKEN=$(gh auth token) node audit/ghsa-check.mjs
GHSA check: 215 locked crates, 196 distinct, 30 carrying at least one published advisory range.
  ...
  soroban-env-host 27.0.1: 1 published range(s), 0 matching
  soroban-sdk 27.0.6: 6 published range(s), 0 matching
  soroban-sdk-macros 27.0.6: 3 published range(s), 0 matching
  stellar-strkey 0.0.13, 0.0.16: 1 published range(s), 0 matching
  stellar-xdr 27.0.0: 1 published range(s), 0 matching
  ...
No locked crate falls in a published GHSA vulnerable range.
EXIT=0
```

Note what that first line means: **30 of the 196 distinct crates in this tree carry
published GitHub advisories today, and `cargo audit` reports on none of them by that
channel.** They happen not to match. That is the entire current safety margin.

Negative control, a synthetic lock pinning `soroban-sdk` 25.0.1 and `stellar-strkey` 0.0.7:

```
$ GITHUB_TOKEN=$(gh auth token) node audit/ghsa-check.mjs /tmp/fake.lock
3 locked crate(s) fall in a published GHSA vulnerable range:
  GHSA-x2hw-px52-wp4m MODERATE soroban-sdk 25.0.1 (vulnerable: >= 25.0.0, < 25.3.0, first patched: 25.3.0)
    rs-soroban-sdk: `Fr` scalar field equality comparison bypasses modular reduction
  GHSA-96xm-fv9w-pf3f MODERATE soroban-sdk 25.0.1 (vulnerable: >= 25.0.0, < 25.0.2, first patched: 25.0.2)
    soroban-sdk has overflow in Bytes::slice, Vec::slice, GenRange::gen_range for u64
  GHSA-5873-6fwq-463f MODERATE stellar-strkey 0.0.7 (vulnerable: < 0.0.8, first patched: 0.0.8)
    stellar-strkey vulnerable to panic in SignedPayload::from_payload
EXIT=1
```

The gate goes red when it should. That is the property the existing "Advisory audit" step
cannot demonstrate for these crates at any version, because no input exists that would make
it fire.

### References

- RustSec advisory database, local clone HEAD `cebc72be`, 2026-08-24, `~/.cargo/advisory-db`
- https://github.com/stellar/rs-soroban-sdk/security/advisories (GHSA-4chv-4c6w-w254, CVE-2026-26267, high)
- https://github.com/advisories/GHSA-5873-6fwq-463f (stellar-strkey, missed by the repository-level sweep)
- GitHub GraphQL `securityVulnerabilities(ecosystem: RUST, ...)`, https://docs.github.com/graphql/reference/queries
- `audit/research/R3-advisories.md` sections 1.7, 2.1 and 6 (A-1)
- `audit/00-threat-model.md` section 2, "Correction, 2026-08-24", and P-1
- `audit/tool-output/rustsec-db-check.txt`, `audit/tool-output/github-security-advisories.txt`

---

## A8-02. CI never builds, hashes or verifies the artifact that is actually deployed

**Severity:** Medium
**Impact:** Medium. Every build gate in CI runs against a binary that is not the one on
pubnet: different size, different bytes, different hash. The 128KB size gate therefore
measures the wrong number, and no automated check anywhere ties a commit to the
`155eb31c...` hash that `soroban/releases/*.json`, `mcp/src/chains/registry.ts` and
`mcp/src/chains/provenance.ts` all publish as the identity of the live mainnet contract. A
source change that alters the deployed artifact is invisible to CI as such.
**Likelihood:** High. It is the current state on every run, not a scenario.
**Violates:** n/a directly. It weakens the evidence behind INV-22 (error codes stable
across both deployed networks and any future build), because "any future build" is exactly
what CI would otherwise pin.
**Location:** `.github/workflows/soroban.yml:59-69`; claim at `soroban/README.md:90`
**Category:** Build integrity / CI
**Detected by:** Building the workspace both ways in a scratch copy and comparing.
**Status:** Open. New.

### Description

CI builds the wasm with:

```yaml
      - name: Build the wasm
        run: cargo build --release --target wasm32v1-none
```

The deployed artifact was not built that way. `stellar contract build` wraps `cargo rustc`
with two environment variables that plain `cargo build` does not set, and both of them
change the emitted bytes:

```
$ stellar contract build --print-commands-only
CARGO_BUILD_RUSTFLAGS=--remap-path-prefix=/Users/mericcintosun/.cargo/registry/src= \
SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 \
cargo rustc --manifest-path=contracts/agent-spend-policy/Cargo.toml --crate-type=cdylib --target=wasm32v1-none --release
```

`--remap-path-prefix` strips absolute cargo registry paths out of the binary.
`SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2` drops unreferenced contract-spec
entries. Together they are the difference between 28,728 bytes and 11,625 bytes.

`soroban/README.md:90` states that `.github/workflows/soroban.yml` "runs all of it", where
"it" is the list at lines 82-88 that includes `stellar contract build`. It does not. That
is the one inaccurate claim in an otherwise carefully hedged document.

The consequences, in order of how much they matter:

1. **No commit is ever tied to the deployed hash.** The mainnet vault holds real USDC and
   cannot be upgraded. The hash is the only identity it has. Nothing mechanical asserts it.
2. **The size gate measures a binary 2.5x larger than the real one.** It passes today
   because 28,728 is comfortably under 131,072, but it is reporting a number that has no
   operational meaning. If it ever fires, it fires on the wrong artifact.
3. **The CI build leaves developer paths in the binary** (see Proof of Concept), which is
   only a hygiene point while nobody publishes the CI artifact, and would become a real one
   the moment somebody did.

### Proof of concept

Both builds run from an identical scratch copy of `soroban/`, same source, same lock, same
toolchain, minutes apart.

```
$ cd <scratch>/sb && cargo build --release --target wasm32v1-none      # what CI runs
$ ls -l target/wasm32v1-none/release/agent_spend_policy.wasm
-rwxr-xr-x  1 ...  28728 ...
$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
0061cc9ffdc7124a4a69dcf89781f83311951782846957dca635e63a1c76f5a0

$ strings -a target/wasm32v1-none/release/agent_spend_policy.wasm | grep '/Users/'
/Users/mericcintosun/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/soroban-sdk-27.0.6/src/env.rs
/Users/mericcintosun/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/soroban-sdk-27.0.6/src/ledger.rs
```

```
$ cd <scratch>/sb && stellar contract build                            # what was deployed
$ ls -l target/wasm32v1-none/release/agent_spend_policy.wasm
-rw-r--r--  1 ...  11625 ...
$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239
$ strings -a target/wasm32v1-none/release/agent_spend_policy.wasm | grep '/Users/'
(no output)
```

11,625 bytes and `155eb31c...` are exactly what `soroban/releases/pubnet-v0.1.0.json` and
`soroban/releases/testnet-v0.1.0.json` record. The CI artifact is a different binary.

### Recommended fix

Replace the build and size steps, and add a hash gate that reads the release record rather
than a literal. The full workflow is in A8-04; the two steps in isolation:

```yaml
      # Build the way the contract is actually SHIPPED. `cargo build --release` produces a
      # DIFFERENT binary: stellar contract build additionally sets
      # --remap-path-prefix (strips developer paths) and spec shaking (drops unreferenced
      # spec entries), which is the difference between 28,728 bytes and 11,625. Gating the
      # cargo build gated a binary nobody deploys.
      - name: Build the wasm the way it ships
        run: stellar contract build --locked

      # The network rejects a contract over 128KB. Catching that here beats catching it at
      # deploy, when the fix is a rebuild rather than a redeploy.
      - name: Contract size gate
        run: |
          WASM=target/wasm32v1-none/release/agent_spend_policy.wasm
          SIZE=$(stat -c%s "$WASM")
          echo "$WASM is $SIZE bytes"
          test "$SIZE" -lt 131072 || { echo "over the 128KB network limit"; exit 1; }

      # The mainnet vault holds real USDC and has NO upgrade entrypoint, so its wasm hash is
      # the only identity it has. This asserts that the tree still builds to the bytes the
      # release records publish, and it is read from those records rather than pasted, so
      # there is one place to change when a new version is cut.
      #
      # Read the limit honestly: this proves the tree matches the RECORD. It does not prove
      # the record matches the LEDGER. `stellar contract fetch` does that, and it needs
      # network access, so it belongs in a scheduled job rather than on every push.
      - name: Deployed wasm hash gate
        run: |
          EXPECTED=$(node -e "console.log(require('./releases/pubnet-v0.1.0.json').wasm.sha256)")
          ACTUAL=$(shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm | cut -d' ' -f1)
          echo "expected $EXPECTED"
          echo "actual   $ACTUAL"
          test "$EXPECTED" = "$ACTUAL" || {
            echo "The tree no longer builds to the hash the release record publishes."
            echo "If this change is intended, cut a new release record. If it is not, this"
            echo "is the gate doing its job. Note the hash is also a function of the stellar"
            echo "CLI version (it lands in contractmetav0 as cliver), so check that first."
            exit 1
          }
```

Pin the CLI so the last gate is meaningful (see A8-08):

```yaml
      - name: Install the pinned stellar CLI
        # The CLI version is baked into the wasm as contractmetav0 `cliver`, so it is part
        # of the hash. 27.1.0 is what cut the pubnet release; see releases/*.json toolchain.
        run: cargo install --locked stellar-cli --version 27.1.0
```

Finally correct `soroban/README.md:90`, which claims CI runs the list above it including
`stellar contract build`. After this change the claim becomes true.

### References

- `.github/workflows/soroban.yml:59-69`
- `soroban/README.md:82-91`
- `soroban/releases/pubnet-v0.1.0.json`, `.wasm.sha256` and `.wasm.bytes`
- `mcp/src/chains/registry.ts:122,203`; `mcp/src/chains/provenance.ts:260,342`
- `stellar contract build --print-commands-only`, stellar-cli 27.1.0

---

## A8-03. GitHub secret scanning and push protection are off on a public repo that operates a live mainnet vault

**Severity:** Medium
**Impact:** High if it ever fires, which is what carries the severity despite a low
likelihood. The pubnet vault's owner key is, by the project's own release record, "a burner
key generated for this deploy and held in a local CLI keystore, not a multisig and not an
HSM". The contract has no `set_owner` (threat model P-2) and no upgrade path (P-1), so a
leaked owner key is total, unrecoverable loss of the vault balance with no rotation
available. The repository is public. There is currently no mechanical barrier of any kind
between a stray `git add` and a published key: no push protection, no secret scanning, and
no gitleaks step in CI.
**Likelihood:** Low. The history is clean today (verified below, twice, by two different
methods), the developer is evidently careful, and `mcp/.gitignore` covers the recovery file
by name. Low is not zero, and this class of loss is not recoverable after the fact.
**Violates:** INV-02 in effect. Every owner-gated invariant reduces to "the owner key is
secret". This is the control that keeps it secret from the repository.
**Location:** repository settings on `getA-Identity/A-Identity` and `mericcintosun/a-identity`;
absent gitleaks step in `.github/workflows/`
**Category:** Secrets management / operational security
**Detected by:** `gh api repos/{repo}` `security_and_analysis`; independent re-verification
of the Phase 2 gitleaks run; two additional history scans.
**Status:** Open. New. R3 reported the Dependabot half of this block; the secret-scanning
half is reported here for the first time.

### Description

The same `security_and_analysis` probe that establishes A8-01 returns three more `disabled`
lines that nobody has yet acted on. All three of these features are **free on public
repositories**:

```
$ gh api repos/getA-Identity/A-Identity --jq '.security_and_analysis'
{
  "dependabot_security_updates":        {"status":"disabled"},
  "secret_scanning":                    {"status":"disabled"},
  "secret_scanning_non_provider_patterns": {"status":"disabled"},
  "secret_scanning_push_protection":    {"status":"disabled"},
  "secret_scanning_validity_checks":    {"status":"disabled"}
}
```

Identical on `mericcintosun/a-identity`.

Push protection is the one that matters most here. It rejects the push that contains the
key, before it is on the internet. Without it, the recovery for a committed key is not
`git rebase`; it is rotating the key, and this contract has no rotation.

`gitleaks` is installed on the developer machine (8.30.1) and was run for Phase 2, but it
is not in any workflow, so nothing runs it on a push.

### Independent re-verification of the gitleaks hits

The brief asked for this to be checked rather than accepted. It was.

**Verdict: all 7 hits are false positives. The conclusion holds. One of the stated reasons
does not, and the wrong reason is worth correcting because it would mislead the next
reviewer.**

**Hits 1-2, the release JSONs.** Read directly:

```
$ sed -n '24p' soroban/releases/pubnet-v0.1.0.json
    "token": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
$ sed -n '23p' soroban/releases/testnet-v0.1.0.json
    "token": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
```

These are Stellar **contract** addresses (C-prefixed strkeys), the USDC SAC on each
network. They appear a second time in the same files under `settlementToken.sac` and a
third time in `mcp/src/chains/registry.ts`. A contract id is public by construction: it is
a deterministic function of the classic asset and the network passphrase. gitleaks fired on
the JSON key literally being named `token`. Confirmed false positive.

**Hits 3-7, the EVM keys.** Four distinct 64-hex literals across four test files. The keys
were never printed, transcribed or stored; each was read from its file and passed straight
into `privateKeyToAccount`, and only the resulting public address was emitted:

```
mcp/src/x402-3009/engine.test.ts     -> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
mcp/src/x402.test.ts   (payerKey)    -> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
mcp/src/x402.test.ts   (attackerKey) -> 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
mcp/src/chains/evm/adapter.test.ts   -> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
```

`0x70997970...C8` is Hardhat/Anvil default account #1 and `0x9965507D...dc` is default
account #5. These are printed on every `anvil` startup and documented in the Hardhat
manual. They are not secrets and cannot be made into secrets. `adapter.test.ts:168` even
asserts the derived address as `expected`, so the file states which key it is.

The fifth is `'x402_live_testkey'` in `mcp/src/celo-x402.test.ts:32`, a literal English
string that says what it is. Confirmed false positive.

**The correction.** The handed-over assessment justified these partly by "confirmed
zero-balance on our live mainnets". Re-probed today across all six EVM mainnets in
`mcp/src/chains/registry.ts`, that is not true:

| Chain | 0x70997970...C8 | 0x9965507D...dc |
| --- | --- | --- |
| X Layer | 0 | 0 |
| Base | 0 | 0 |
| Arbitrum One | 0 | 0 |
| Robinhood Chain mainnet | 0 | 0 |
| Avalanche C-Chain | **237,913,444,000 wei (2.4e-7 AVAX)** | 0 |
| Celo | **202,500,000,000 wei (2.0e-7 CELO)** | **1,067,806,339,000,922 wei (0.00107 CELO)** |

Nonce counts confirm what those balances are: 0x9965507D has 171,504 transactions on Base
and 9,736 on Arbitrum One. These addresses are continuously swept by bots worldwide. The
dust is inbound spam that arrived faster than a sweeper could take it.

That does not change the verdict, and it should not: **balance is the wrong test.** A key
published in Hardhat's documentation is not a secret at any balance, and a zero balance
would not have made it one. The test that actually matters is whether these addresses are
ever used as configuration rather than as test fixtures. They are not:

```
$ grep -rn '70997970\|9965507D\|9965507d' --exclude-dir=node_modules --exclude-dir=.git .
mcp/src/chains/evm/adapter.test.ts:168:  const expected = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
```

One occurrence, in a test assertion. Never a `payTo`, never a fee payer, never an operator,
never an owner. That is the finding-free answer, and it is a stronger one than the balance
argument.

### Two additional history scans gitleaks would not have done

gitleaks ships no Stellar rule, and this project's highest-value key material is Stellar.
So two more passes were run over the full history, `git rev-list --all`:

```
$ git grep -I -n -E '\bS[A-Z2-7]{55}\b' $(git rev-list --all) --
(no output)
```

No Stellar secret seed (the `S...` strkey shape) has ever existed in any commit on any
branch. That is the check that most matters for the pubnet vault owner key, and it comes
back clean.

```
$ git grep -I -n -iE '(priv(ate)?[_-]?key|secret|mnemonic|seed)[^\n]{0,20}[:=][^\n]{0,10}["'"'"'](0x)?[0-9a-fA-F]{64}["'"'"']' $(git rev-list --all) --
(no output)
```

No key-shaped literal assigned to a key-named variable anywhere in history beyond the four
Hardhat defaults gitleaks already surfaced.

Tracked files that could hold credentials:

```
$ git ls-files | grep -iE '\.env|secret|\.pem$|\.p12$|credential'
.env.example
$ git log --all --diff-filter=A --name-only -- '*.env' '.env' '.env.*' '*.pem' '*.key'
1bdf81c Initial commit ...
.env.example
```

`.env.example` is the only one, and it contains documentation and placeholders.

### mcp/circle-recovery.dat

Checked as asked:

```
$ ls -la mcp/circle-recovery.dat
-rw-r--r--@ 1 ...  144 Jul 10 05:51 mcp/circle-recovery.dat
$ git check-ignore -v mcp/circle-recovery.dat
mcp/.gitignore:6:circle-recovery.dat	mcp/circle-recovery.dat
$ git ls-files mcp/circle-recovery.dat
(empty)
$ git log --all -- mcp/circle-recovery.dat
(empty)
```

Still on disk, 144 bytes. Correctly ignored, never tracked, never in any commit on any
branch. Its contents were not read: they are not needed to establish any of that, and the
file's name and the ignore rule beside it are enough to classify it as recovery material
for a Circle entity secret.

The residual risk is not git. It is that a 144-byte credential file sits inside the working
tree, protected by a single line in a single `.gitignore`, on a machine that also holds the
pubnet vault owner key. Any `tar`, `zip`, `rsync`, backup or agent working-directory copy
that does not honour `.gitignore` takes it along. Moving it outside the repository
directory entirely would cost nothing and remove the class.

### Recommended fix

**1. Turn on the three free settings, on both remotes.** Settings -> Code security:

- Secret scanning: **on**
- Push protection: **on** (this is the one that prevents the loss rather than reporting it)
- Validity checks: **on**

Verify:

```
gh api repos/getA-Identity/A-Identity --jq '.security_and_analysis'
gh api repos/mericcintosun/a-identity  --jq '.security_and_analysis'
```

**2. Add gitleaks to CI**, so the deploy mirror and any fork are covered too, and so the
result is a build status rather than a thing someone ran once. Note this belongs in
`ci.yml` rather than `soroban.yml`, because it is repository-wide and must not be gated on
a `soroban/**` path filter:

```yaml
      # A committed key is not recoverable by reverting the commit: it is recoverable only
      # by rotating the key, and the Soroban vault has no set_owner. So this runs on every
      # push over the FULL history, not the diff.
      - name: Secret scan (full history)
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ github.token }}
          GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false"
```

with `fetch-depth: 0` on the checkout step for that job.

**3. Add a `.gitleaks.toml` allowlist** so the seven known false positives do not train
anyone to ignore the output. A scanner that always shows seven hits is a scanner nobody
reads:

```toml
# Allowlist for the seven KNOWN false positives, each justified individually. Anything not
# listed here is a real hit. Fingerprints are stable across reruns; they were taken from
# audit/tool-output/P2-gitleaks.json on 2026-08-24.
title = "A-Identity"

[allowlist]
description = "Verified false positives. See audit/findings/A8-build-config.md, A8-03."
paths = [
  # Public Stellar CONTRACT ids (C-prefixed strkeys) for the USDC SAC on each network,
  # under a JSON key literally named "token". A contract id is a deterministic function of
  # the classic asset and the network passphrase; it is public by construction.
  '''soroban/releases/.*\.json''',
]
regexes = [
  # Hardhat/Anvil default accounts #1 and #5. Printed by every `anvil` startup and in the
  # Hardhat manual, so they are not secret at any balance. Used ONLY as test fixtures:
  # grep confirms the only occurrence outside a *.test.ts is an `expected` assertion.
  # Derived addresses, for the reviewer who wants to check without handling the key:
  #   0x70997970C51812dc3A010C7d01b50e0d17dc79C8  (#1)
  #   0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc  (#5)
  '''x402_live_testkey''',
]
```

Fill the two key regexes by fingerprint rather than by pasting the literals, using
`[[rules.allowlist]]` `stopwords` or the `--baseline-path` flag against a committed
baseline generated from `audit/tool-output/P2-gitleaks.json`. A baseline is the better
mechanism here precisely because it does not require the key to appear in a config file.

**4. Move `mcp/circle-recovery.dat` out of the repository directory** and reference it by
an absolute path from the environment. The `.gitignore` line stays as a second layer.

### References

- `gh api repos/{owner}/{repo}` `security_and_analysis`, both remotes, 2026-08-24
- https://docs.github.com/code-security/secret-scanning/push-protection-for-repositories-and-organizations
- `audit/tool-output/P2-gitleaks.txt`, `audit/tool-output/P2-gitleaks.json` (7 hits, 411 commits)
- Hardhat default accounts: https://hardhat.org/hardhat-network/docs/reference#accounts
- `soroban/releases/pubnet-v0.1.0.json`, `caveats[2]` (burner key, no multisig, no HSM)
- `audit/00-threat-model.md` P-1, P-2

---

## A8-04. Six CI gates that Phase 2 proved find real defects are absent, and no cargo step is `--locked`

**Severity:** Low
**Impact:** Medium on assurance, none on the deployed contract directly. Phase 2 ran seven
tools against this tree. Five of them found something. Only two of the seven are in CI, so
five findings-producing checks are one-shot artifacts of an audit rather than standing
gates, and will not fire on the next change.
**Likelihood:** High that a regression in one of these classes ships unnoticed, over a long
enough horizon.
**Violates:** n/a. This is assurance coverage, not a contract property.
**Location:** `.github/workflows/soroban.yml`
**Category:** CI / assurance
**Detected by:** Comparing the workflow against `audit/tool-output/P2-*.txt`.
**Status:** Open. Partly new.

### Description

**One correction to the brief.** The brief states that
`soroban/audit/run-negative-controls.mjs` "currently is NOT in CI". It is, and has been
since commit `b2f0540`:

```yaml
      - name: Negative controls (the suite must go red without each guard)
        run: node audit/run-negative-controls.mjs
```

`.github/workflows/soroban.yml:75-76`, committed, not a working-tree edit (`git diff HEAD`
on the file is empty). It is also the single most valuable step in the file, and the
workflow's header comment argues for it well. It should not be reported as missing.

What is actually missing:

| Gate | In CI? | What Phase 2 found with it | Cost |
| --- | --- | --- | --- |
| `cargo fmt --check` | yes | - | seconds |
| `cargo clippy --all-targets -D warnings` | yes | - | seconds |
| `cargo test` | yes | 52 pass | ~1s |
| `cargo audit` | yes | 0 vulns, 1 allowed warning | ~30s |
| wasm build + size gate | yes, but on the wrong artifact (A8-02) | - | ~30s |
| negative controls | **yes** | 6 of 6 guards caught | ~1m |
| **clippy security lint set** | **no** | 4 `unwrap()` (threat model P-3) plus `arithmetic_side_effects` hits | seconds |
| **`cargo llvm-cov` with a floor** | **no** | 93.94% regions, 93.45% lines, `lib.rs` functions only 76% | ~30s |
| **`cargo mutants`** | **no** | **22 of 137 mutants MISSED**, including `replace < with <= in check_balance` and both comparisons in `set_policy` | ~5m |
| **`cargo fuzz` smoke** | **no** | no fuzz target exists yet (see A8-05) | minutes |
| **`cargo deny check`** | **no** | all four checks ok, but only since `deny.toml` was written today | ~20s |
| **`gitleaks`** | **no** | 7 hits, all false positives (A8-03) | ~10s |
| **GHSA query** | **no** | the A8-01 gap | ~10s |

The mutation result is the one that should decide the priority order. `cargo mutants`
reports `MISSED contracts/agent-spend-policy/src/policy.rs:120:16: replace < with <= in
check_balance`, which means the balance gate's boundary is not pinned by any test, and two
missed comparison mutants in `set_policy`. Those are exactly the "do not assume the
existing 52 tests cover what their names suggest" cases the threat model reserved section 8
for. They are A2/A3 findings to write up, but the CI consequence belongs here: nothing
stops that number from getting worse.

**Separately, no cargo invocation in the workflow uses `--locked`.** `soroban/Cargo.lock`
is committed, and `cargo build` / `cargo test` will silently rewrite it if a manifest and
the lock disagree. Since `cargo audit`, `cargo deny` and the proposed GHSA check all read
`Cargo.lock`, a CI run that regenerated it would be auditing a resolution that is not the
one in the repository. The blast radius today is small, because `soroban-sdk` is pinned
exactly, but `--locked` is one word and it makes the audit steps mean what they say.

Two smaller notes on the same file:

- `cargo install cargo-audit --locked || true` installs an unpinned tool from crates.io on
  every run and swallows the failure. The `|| true` is there because the install is a
  no-op when the cache is warm, which is reasonable, but it also means a genuinely broken
  install is only noticed one step later. `--version` pinning would make the step
  reproducible.
- `actions/checkout@v4`, `Swatinem/rust-cache@v2` and `actions/setup-node@v4` are mutable
  tags. This is a low concern here and only here: the repository's default workflow
  permission is `read` (`gh api repos/.../actions/permissions/workflow` returns
  `{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}`), so a
  compromised action cannot write to the repository. Pin to commit SHAs anyway when
  convenient; do not treat it as urgent.
- The size gate's `find ... -name '*.wasm' | head -1` can select a copy from `target/.../deps/`
  rather than the top-level artifact. Naming the path directly removes the ambiguity.

### Proof of concept

```
$ tail -3 audit/tool-output/P2-cargo-mutants-full.txt
137 mutants tested in 5m: 22 missed, 109 caught, 6 unviable
MUTANTS_DONE exit=2

$ tail -6 audit/tool-output/P2-llvm-cov.txt
lib.rs      316  24  92.41%   25  6  76.00%   180  18  90.00%
policy.rs    68   2  97.06%    5  0 100.00%    42   0 100.00%
storage.rs  161   7  95.65%   25  2  92.00%   114   4  96.49%
TOTAL       545  33  93.94%   55  8  85.45%   336  22  93.45%

$ tail -4 audit/tool-output/P2-clippy-security.txt
error: could not compile `agent-spend-policy` (lib) due to 4 previous errors
error: could not compile `agent-spend-policy` (lib test) due to 11 previous errors

$ tail -1 audit/tool-output/P2-cargo-deny.txt
advisories ok, bans ok, licenses ok, sources ok

$ cat audit/tool-output/P2-negative-controls.txt
baseline: green
operator-require-auth: caught
owner-require-auth: caught
negative-amount-guard: caught
checked-add: caught
self-payee-guard: caught
day-bucket-ttl-extension: caught
All 6 negative controls were caught.
```

Note the state of the two newest artifacts: `soroban/deny.toml` is **untracked** and
`soroban/contracts/agent-spend-policy/Cargo.toml` is **modified but uncommitted**
(`git status --porcelain`). Neither is visible to CI yet.

### Recommended fix

The full replacement workflow, incorporating A8-01, A8-02 and A8-04. Two jobs, so the
five-minute mutation run does not sit in front of the fast feedback:

```yaml
name: Soroban

# Scoped to soroban/**, so installing a Rust toolchain does not tax every frontend
# commit. ci.yml stays node-only and knows nothing about Rust.
#
# The step worth protecting is `Negative controls`. It deletes the contract's
# authorization guard and requires the test suite to go RED. Everything above it proves the
# contract passes its tests; only that step proves the tests would notice if the contract
# stopped being safe, which is a different claim and the one that matters here: `pay` moves
# the vault's own balance, so the authorization surface collapses onto a single line, and
# the standard Soroban test harness (mock_all_auths) is precisely what hides its absence.

on:
  push:
    paths:
      - 'soroban/**'
      - '.github/workflows/soroban.yml'
  pull_request:
    paths:
      - 'soroban/**'
      - '.github/workflows/soroban.yml'

permissions:
  contents: read

defaults:
  run:
    working-directory: soroban

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # rust-toolchain.toml pins the channel, the wasm32v1-none target and the
      # components, so there is nothing to restate here. A version named in two places is
      # a version that will disagree with itself.
      - name: Show the pinned toolchain
        run: rustc --version && cargo --version

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: soroban

      - name: Format
        run: cargo fmt --check

      - name: Clippy
        run: cargo clippy --all-targets --locked -- -D warnings

      # A second, stricter clippy pass, WARNING-only on purpose. The lints below are the
      # ones that find the classes this contract actually cares about, and today they fire
      # on four documented unwrap()s in storage.rs that the threat model records as P-3.
      # Making them -D would either break the build or force blanket allow() attributes,
      # and an allow() nobody reads is worse than a warning somebody does. Revisit once
      # P-3 is resolved one way or the other.
      - name: Clippy (security lint set, advisory)
        continue-on-error: true
        run: |
          cargo clippy --lib -p agent-spend-policy --locked -- \
            -W clippy::arithmetic_side_effects \
            -W clippy::unwrap_used \
            -W clippy::expect_used \
            -W clippy::indexing_slicing \
            -W clippy::panic

      - name: Unit tests
        run: cargo test --locked

      # Coverage with a FLOOR, not a report. A number nobody fails on is a number nobody
      # reads. 90 is set just under the 93.45% line coverage measured on 2026-08-24, so it
      # catches a real regression without going red on noise.
      - name: Coverage floor
        run: |
          cargo install --locked cargo-llvm-cov --version 0.8.7
          rustup component add llvm-tools-preview
          cargo llvm-cov --locked --summary-only --ignore-filename-regex 'src/test' \
            --fail-under-lines 90

      # RustSec, for the 209 crates that are not part of the Stellar stack. Read its limit
      # honestly: RustSec has NEVER carried a Stellar advisory (909 crate directories, 1206
      # advisories, zero hits for "soroban" or "stellar" on 2026-08-24), so a green result
      # here says nothing whatsoever about soroban-sdk. The step below is the one that does.
      - name: Advisory audit (RustSec)
        run: |
          cargo install --locked cargo-audit --version 0.22.2
          cargo audit

      # GitHub's advisory database DOES cover these crates: six published against this
      # stack, one of them HIGH (CVE-2026-26267, in the #[contractimpl] macro itself). All
      # six are below our pin today, which is luck rather than coverage, and this makes it
      # coverage. Dependabot alerts should be on as well; this does not depend on them.
      - name: GitHub advisory audit (the database that covers soroban-sdk)
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: node audit/ghsa-check.mjs

      # Advisories again but also bans, licenses and sources. `sources` is the quietly
      # useful one: it fails if any dependency ever starts coming from an unpinned git ref
      # instead of crates.io.
      - name: Dependency policy
        run: |
          cargo install --locked cargo-deny --version 0.20.2
          cargo deny --locked check

      # The CLI version is baked into the wasm as contractmetav0 `cliver`, so it is part of
      # the artifact hash. 27.1.0 is what cut the pubnet release; see releases/*.json.
      - name: Install the pinned stellar CLI
        run: cargo install --locked stellar-cli --version 27.1.0

      # Build the way the contract is actually SHIPPED. `cargo build --release` produces a
      # DIFFERENT binary: stellar contract build additionally sets --remap-path-prefix
      # (strips developer paths) and spec shaking (drops unreferenced spec entries), which
      # is the difference between 28,728 bytes and 11,625. Gating the cargo build gated a
      # binary nobody deploys.
      - name: Build the wasm the way it ships
        run: stellar contract build --locked

      # The network rejects a contract over 128KB. Catching that here beats catching it at
      # deploy, when the fix is a rebuild rather than a redeploy.
      - name: Contract size gate
        run: |
          WASM=target/wasm32v1-none/release/agent_spend_policy.wasm
          SIZE=$(stat -c%s "$WASM")
          echo "$WASM is $SIZE bytes"
          test "$SIZE" -lt 131072 || { echo "over the 128KB network limit"; exit 1; }

      # The mainnet vault holds real USDC and has NO upgrade entrypoint, so its wasm hash is
      # the only identity it has. This asserts the tree still builds to the bytes the
      # release records publish, read from those records rather than pasted.
      #
      # It proves the tree matches the RECORD, not that the record matches the LEDGER.
      # `stellar contract fetch` does the latter and needs network access, so it belongs in
      # a scheduled job.
      - name: Deployed wasm hash gate
        run: |
          EXPECTED=$(node -e "console.log(require('./releases/pubnet-v0.1.0.json').wasm.sha256)")
          ACTUAL=$(shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm | cut -d' ' -f1)
          echo "expected $EXPECTED"
          echo "actual   $ACTUAL"
          test "$EXPECTED" = "$ACTUAL" || {
            echo "The tree no longer builds to the hash the release record publishes."
            echo "If this change is intended, cut a new release record. If it is not, this"
            echo "is the gate doing its job. The hash is also a function of the stellar CLI"
            echo "version (contractmetav0 cliver), so check that pin first."
            exit 1
          }

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Negative controls (the suite must go red without each guard)
        run: node audit/run-negative-controls.mjs

  # Five minutes, so it runs beside the fast job rather than in front of it. This is the
  # check that answers "do the 52 tests assert anything", which is a different question
  # from "do they pass". On 2026-08-24 the answer was 22 of 137 mutants missed.
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: soroban
      - name: Mutation testing
        run: |
          cargo install --locked cargo-mutants --version 27.1.0
          # Baselined at the measured 22. Lower it as tests are added; never raise it
          # without saying why in the commit message.
          cargo mutants --locked --timeout 120 --in-place || true
          MISSED=$(grep -c '^MISSED' mutants.out/outcomes.json 2>/dev/null || \
                   grep -c '^MISSED' mutants.out/caught.txt 2>/dev/null || echo 0)
          echo "missed mutants: $MISSED"
          test "$MISSED" -le 22 || { echo "mutation score regressed"; exit 1; }
```

Two notes on that YAML. The mutant-counting line depends on the `cargo-mutants` output
layout and should be adjusted against a real run before it is trusted; `cargo mutants
--json` is the more stable source. And the coverage floor of 90 is set from today's
measurement, not from a round number.

`gitleaks` deliberately does **not** appear above: it belongs in `ci.yml`, which is not
path-filtered on `soroban/**`. See A8-03.

### References

- `.github/workflows/soroban.yml` (all lines)
- `audit/tool-output/P2-cargo-mutants-full.txt`, `P2-llvm-cov.txt`, `P2-clippy-security.txt`,
  `P2-cargo-deny.txt`, `P2-negative-controls.txt`, `P2-gitleaks.txt`
- `audit/research/R4-tooling.md` section 1 (master table) and section 6
- `gh api repos/getA-Identity/A-Identity/actions/permissions/workflow`

---

## A8-05. The `testutils` feature is safe, but the Cargo.toml comment states a guarantee that does not exist

**Severity:** Low
**Impact:** Low. The artifact is not affected. The comment is, and a comment that gives the
wrong reason for a correct conclusion is how the conclusion gets lost when the reason stops
being true.
**Likelihood:** n/a for artifact leakage: it is currently impossible, for a reason stronger
than the one documented.
**Violates:** n/a
**Location:** `soroban/contracts/agent-spend-policy/Cargo.toml`, `[features]` block
**Category:** Build configuration / feature-flag leakage
**Detected by:** Reading `stellar contract build --help`, then attempting the leak in a
scratch copy.
**Status:** Open, documentation only. The feature itself is verified safe.

### Description

The feature added today is:

```toml
[features]
# Opt-in ONLY, and deliberately absent from any `default` list. `cargo fuzz` builds the
# contract as a library and needs the SDK's test harness to construct an `Env`, so without
# a named feature there is no way to reach it from a fuzz target. Keeping it out of
# `default` is what stops it reaching the release artifact: `stellar contract build` does
# not pass `--features`, so the deployed wasm never sees it. audit/tool-output/ records the
# check that the built wasm is unchanged by this edit.
testutils = ["soroban-sdk/testutils"]
```

The conclusion is correct. Three independent proofs are below, and the wasm hash is
unchanged at `155eb31c...`.

The stated reason is not correct. `stellar contract build` has `--features`,
`--all-features` and `--no-default-features`. The comment reads as though the CLI cannot
pass the flag; what is true is that the *default invocation* does not.

The real guarantee is much stronger and worth writing down in its place: **`soroban-sdk`'s
`testutils` feature cannot be compiled for `wasm32v1-none` at all.** It pulls in
`serde_json`, `rand` and other std-only crates that are not available on the contract
target, so an attempt fails with 180 compile errors before any wasm is produced. There is
no `--features` invocation that ships a testutils-enabled contract; the build breaks
first. That is fail-closed, and it is a better argument than "the CLI does not pass the
flag".

One more load-bearing line was found while testing this, and it is not documented anywhere:
**`resolver = "2"` in `soroban/Cargo.toml` is a security setting here.** The contract's
`[dev-dependencies]` enable `soroban-sdk/testutils`. Under resolver v1, Cargo unifies
features across normal, build and dev dependencies, so that dev-dependency feature would be
enabled in the normal build too. Tested: with `resolver = "1"`, `stellar contract build`
fails outright. Fail-closed again, but only by luck of the target, and the line deserves a
comment saying what it protects.

Finally: **there is no fuzz target in the tree.** `find soroban -name 'fuzz*'` returns
nothing, and `soroban/contracts/agent-spend-policy/` contains only `Cargo.toml`, `src` and
`test_snapshots`. The feature that exists to serve `cargo fuzz` currently serves nothing.
It is also uncommitted (`git status --porcelain` shows the manifest modified).

### Proof of concept

**1. The default build is unchanged.** In a scratch copy at a completely different absolute
path, with the `testutils` feature present in the manifest:

```
$ cd /private/tmp/.../scratchpad/sb && stellar contract build
...
✅ Build Complete
$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239
```

Byte-identical to the deployed pubnet and testnet artifact.

**2. The CLI does accept `--features`. The build fails anyway.**

```
$ stellar contract build --help | sed -n '/^Features:/,/^Other:/p'
Features:
      --features <FEATURES>
          Build with the list of features activated, space or comma separated
      --all-features
          Build with the all features activated
      --no-default-features
          Build with the default feature not activated

$ stellar contract build --all-features
...
error[E0433]: cannot find module or crate `serde_json` in this scope
   --> .../soroban-sdk-27.0.6/src/testutils.rs:216:12
error[E0433]: cannot find module or crate `rand` in this scope
   --> .../soroban-sdk-27.0.6/src/testutils.rs:568:5
error: could not compile `soroban-sdk` (lib) due to 180 previous errors
❌ error: exit status exit status: 101

$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239   # untouched
```

There is no artifact to ship, and the previous one is left alone.

**3. `resolver = "2"` is load-bearing, and fails closed if lost.** Same scratch copy, one
character changed:

```
$ sed -i 's/^resolver = "2"/resolver = "1"/' Cargo.toml
$ stellar contract build
...
error: could not compile `serde_core` (lib) due to 5829 previous errors
❌ error: exit status exit status: 101
$ ls target/wasm32v1-none/release/*.wasm
(no such file)
```

The dev-dependency `testutils` feature unifies into the normal build under resolver v1 and
drags std-only crates onto the wasm target, which cannot compile them. Losing the line is
loud, not silent. That is the good outcome, and it should be stated rather than
rediscovered.

### Recommended fix

Replace the comment with the guarantee that is actually true, and add one to the workspace
manifest:

```toml
[features]
# Opt-in ONLY, and deliberately absent from any `default` list, so the default build never
# sees it.
#
# It cannot reach the release artifact even on purpose. `stellar contract build` DOES accept
# --features and --all-features, so "the CLI does not pass the flag" would be the wrong
# reason to feel safe. The real reason is that soroban-sdk's `testutils` cannot compile for
# wasm32v1-none at all: it needs serde_json, rand and other std-only crates that the
# contract target does not have. `stellar contract build --all-features` dies with 180
# errors and produces nothing. Verified 2026-08-24; the default build still hashes to
# 155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239.
#
# It exists because `cargo fuzz` builds the contract as a library and needs the SDK's test
# harness to construct an `Env`.
testutils = ["soroban-sdk/testutils"]
```

```toml
[workspace]
# resolver = "2" is a security setting here, not boilerplate. [dev-dependencies] enable
# soroban-sdk/testutils; under resolver v1 Cargo unifies features across normal, build and
# dev dependencies, so that feature would be enabled in the RELEASE build too. Verified by
# flipping it to "1" in a scratch copy on 2026-08-24: the wasm build then fails outright
# rather than shipping quietly, but do not rely on that as the guard. Keep it at "2".
resolver = "2"
```

And either land the fuzz target the feature exists for, or revert the feature until the
target lands. `audit/research/R4-fuzz-target-reference.rs` and
`R4-fuzz-Cargo.toml.reference` are ready to use. A feature flag with no consumer is a thing
someone will eventually enable to see what happens.

### References

- `soroban/contracts/agent-spend-policy/Cargo.toml`, `soroban/Cargo.toml`
- `stellar contract build --help`, stellar-cli 27.1.0
- Cargo feature resolver v2: https://doc.rust-lang.org/cargo/reference/resolver.html#feature-resolver-version-2
- `audit/research/R3-advisories.md` section 4, SDK issue #2013 ("Block all test-only fns
  inside contract functions"), which is upstream acknowledging this class

---

## A8-06. `.gitignore:81` hides two subdirectory ignore files; a fresh clone will stage the built wasm

**Severity:** Low
**Impact:** Low to Medium. In a fresh clone, `soroban/.gitignore` does not exist, so
`target/`, `mutants.out*/` and `*.wasm` are not ignored by anything: the root `.gitignore`
has no rule for any of them. A routine `git add -A` in a clone stages the built wasm and
the whole target directory. Committing a wasm creates precisely the reproducibility claim
`soroban/README.md` and both release records explicitly refuse to make, and committing
`target/` publishes developer absolute paths (A8-02 shows they are in the cargo-built
binary).
**Likelihood:** Medium. It needs a second clone or a second contributor, which is a normal
thing to have.
**Violates:** n/a
**Location:** `.gitignore:81`
**Category:** Repository hygiene
**Detected by:** `git check-ignore -v`, plus a simulated fresh clone.
**Status:** Open. **Duplicate of the prior review's G-2**, verified and quantified here
rather than re-reported as new.

### Description

Line 81 of the root `.gitignore` is a bare `.gitignore`:

```
73  # Dev tooling / scaffold artifacts (kept local, not for the public repo)
74  .agents/
75  .claude/
76  install.cmd
77  skills-lock.json
78  A-Identity-Architecture.pdf
79  aidentity-review-video.mp4
80  A-Identity_Robinhood_Full_Runbook.md
81  .gitignore
82  A-Identity_Robinhood_Runbook_Site.html
```

A pattern with no slash matches at every level, so this ignores every `.gitignore` in the
repository, including the root one. The comment above it is about scaffold artifacts, which
suggests the line was meant to exclude a tool-generated file and was written too broadly.

Two ignore files predate the line and are tracked, so Git keeps honouring them:
`mcp/.gitignore` and `sdk/.gitignore`. Two do not, and are invisible:
`soroban/.gitignore` and `trust-guard/.gitignore`. Neither has ever been committed on any
branch.

The `soroban/` one is the one that matters, and it is not a throwaway. It carries a
six-line comment explaining why no wasm is committed, which is a piece of the project's
reproducibility posture that currently exists only on one developer's disk:

```
1  target/
2  mutants.out*/
3  *.wasm
4
5  # Deliberately NOT committed. Rust wasm builds are not bit-reproducible across machines
6  # by default, so committing one would invite a reproducibility claim we cannot honor.
...
```

### Proof of concept

```
$ git check-ignore -v soroban/.gitignore
.gitignore:81:.gitignore	soroban/.gitignore
$ git check-ignore -v trust-guard/.gitignore
.gitignore:81:.gitignore	trust-guard/.gitignore

$ git log --all -- soroban/.gitignore trust-guard/.gitignore
(empty: never committed, on any branch)

$ git ls-files | grep -i gitignore
.gitignore
mcp/.gitignore
sdk/.gitignore
```

The two survivors survive only because they were already tracked when line 81 landed. Git
does not apply ignore rules to tracked paths, which is why the ordinary check hides the
problem:

```
$ git check-ignore -v mcp/.gitignore
(no output: reported as NOT ignored, because it is tracked)
$ git check-ignore -v --no-index mcp/.gitignore
.gitignore:81:.gitignore	mcp/.gitignore
```

`--no-index` is what shows the rule matching it. If `mcp/.gitignore` were ever removed and
re-added, it would vanish too, and with it the line that keeps `circle-recovery.dat` out of
the repository (A8-03).

**The consequence, simulated.** A throwaway repository containing only the root
`.gitignore`, which is exactly what a fresh clone has:

```
$ mkdir clonetest && cd clonetest && git init -q .
$ cp /Users/mericcintosun/A-Identity/.gitignore .
$ mkdir -p soroban/target/wasm32v1-none/release
$ touch soroban/target/wasm32v1-none/release/agent_spend_policy.wasm
$ git add -A -n
add 'soroban/target/wasm32v1-none/release/agent_spend_policy.wasm'
```

Staged. The root `.gitignore` contains no `target/` and no `*.wasm` rule, confirmed by
reading all 108 lines of it. The only reason the wasm is not in the repository today is
that the one machine that builds it has an untracked file the remote has never seen.

### Recommended fix

Two edits.

**1. Narrow line 81 to what it was meant to exclude.** If the intent was a generated
`.gitignore` in a scaffold directory, name it:

```diff
 # Dev tooling / scaffold artifacts (kept local, not for the public repo)
 .agents/
 .claude/
 install.cmd
 skills-lock.json
 A-Identity-Architecture.pdf
 aidentity-review-video.mp4
 A-Identity_Robinhood_Full_Runbook.md
-.gitignore
+# NOTE: a bare `.gitignore` used to sit here. A pattern with no slash matches at EVERY
+# level, so it made soroban/.gitignore and trust-guard/.gitignore untracked-and-ignored,
+# and a fresh clone would stage soroban/target/ and the built wasm on `git add -A`.
+# If a scaffold-generated ignore file needs excluding, name its path:
+#   stellar-build/.gitignore
 A-Identity_Robinhood_Runbook_Site.html
```

**2. Commit the two rescued files**, and add a belt-and-braces rule to the root for the two
patterns that matter most, so this cannot recur silently:

```bash
git add -f soroban/.gitignore trust-guard/.gitignore
```

```diff
+# Rust build output. Also covered by soroban/.gitignore, which is committed; this is the
+# copy that survives if that file is ever removed. A committed wasm would create exactly
+# the bit-reproducibility claim soroban/README.md refuses to make.
+target/
+*.wasm
+mutants.out*/
```

Note that `*.wasm` at the root is safe today: `git ls-files | grep '\.wasm$'` returns
nothing, so no tracked file would be affected.

### References

- `.gitignore:81`; `soroban/.gitignore`; `trust-guard/.gitignore`; `mcp/.gitignore:6`
- gitignore pattern semantics: https://git-scm.com/docs/gitignore#_pattern_format
- prior internal review, item G-2 (2026-08-22)
- `soroban/README.md:116-119` ("No committed wasm")

---

## A8-07. "Reviewed with the free tooling, with output committed" is published on mainnet and names no committed output

**Severity:** Low
**Impact:** Low technically, Medium reputationally. The claim is in the pubnet deploy record
and in the code that renders the public `/proof/:rail` endpoint. It is the kind of
verifiable statement this project otherwise gets right, and it is the one that a reviewer
can check in ten seconds and find unbacked.
**Likelihood:** High that a reviewer checks. It is a public artifact whose entire purpose is
to be checked.
**Violates:** n/a. Bears on the project's own honest-status ground rule.
**Category:** Documentation accuracy / operational honesty
**Location:** `soroban/releases/pubnet-v0.1.0.json:155`; `mcp/src/chains/provenance.ts:327`
**Detected by:** Following the claim to the directory it implies.
**Status:** Open. New. Adjacent to A5/A7 territory; recorded here because it is a claim
about tooling.

### Description

```
soroban/releases/pubnet-v0.1.0.json:155
  "Not audited. The contract has been reviewed with the free tooling we could actually run,
   with output committed, plus an adversarial review that found and fixed real defects, plus
   a negative-control runner ..."

mcp/src/chains/provenance.ts:327
  'Not audited. The contract has been reviewed with the free tooling we could actually run,
   named, with output committed, plus an adversarial review ...'
```

Both say "with output committed". Neither names a path. At the time the pubnet record was
committed there was no committed tool output anywhere:

```
$ git log --format='%h %ci %s' -1 -- soroban/releases/pubnet-v0.1.0.json
500a4d6 2026-08-24 17:13:12 +0300 feat(stellar): deploy the spend vault to Stellar mainnet and publish the proof
$ git log --oneline --diff-filter=A --format='%h %ci %s' -1 -- audit/
fa47ebb 2026-08-24 18:05:06 +0300 docs(audit): correct the threat model's advisory claim ...
$ ls soroban/audit/
run-negative-controls.mjs
```

The only directory that could have held it, `soroban/audit/`, contains one script. The
`audit/tool-output/` directory that does hold committed output was created 52 minutes
later, by this audit, and is the auditor's directory rather than the project's.

The provenance.ts variant adds "named", which is also not satisfied: no tool is named in
either string.

The rest of that caveat block is unusually good, and that is the point. "Not audited ...
and we will not call it one", the burner-key disclosure, the payer-and-payee-are-both-ours
disclosure. This one clause is the only overclaim in it, and it is load-bearing for the
credibility of the rest.

Related, from A8-02: `soroban/README.md:90` says CI "runs all of it plus `cargo audit` and
a 128KB size gate", where "it" includes `stellar contract build`. CI does not run
`stellar contract build`.

### Recommended fix

Either make it true or make it precise. Making it true is easy and better:

**1.** Commit the Phase 2 raw output under a project-owned path, for example
`soroban/audit/tool-output/`, and name it in the claim.

**2.** Rewrite the caveat so it names the tools and the path:

```
"Not audited. The contract has been reviewed with the free tooling we could actually run,
 named individually with its raw output committed under soroban/audit/tool-output/: cargo
 clippy (including the arithmetic, unwrap and panic lint set), cargo test, cargo llvm-cov,
 cargo mutants, cargo audit, cargo deny and gitleaks. Two Soroban-specific static analyzers
 were tried and are recorded as NOT usable rather than as clean runs: CoinFabrik Scout
 cannot compile against soroban-sdk 27 and prints a false green, and OpenZeppelin
 soroban-scanner panics on every input. Plus an adversarial review that found and fixed real
 defects, and a negative-control runner that deletes each guard in turn and requires the
 suite to go red. That is not an audit and we will not call it one."
```

The Scout sentence is worth including for its own sake: it is a stronger honesty signal
than the tool list, and it is the exact thing most projects would quietly omit.

**3.** Update `mcp/src/chains/provenance.ts:327` to match, and correct
`soroban/README.md:90`.

### References

- `soroban/releases/pubnet-v0.1.0.json:155`, `caveats[1]`
- `mcp/src/chains/provenance.ts:327`
- `soroban/README.md:90`
- `audit/research/R4-tooling.md` sections 2 and 2b

---

## A8-08. Reproducibility is stronger than the docs claim, and is bound to a stellar CLI version pinned nowhere

**Severity:** Informational
**Impact:** Low. Nobody is misled today, because the docs *understate* the property. The
risk is the opposite one: an honest third party who rebuilds with a newer stellar CLI gets
a different hash and reasonably concludes the published hash is wrong.
**Likelihood:** Medium. The CLI is on a fast release cadence and nothing in the repository
pins it.
**Violates:** n/a. Supports INV-22.
**Location:** `soroban/releases/*.json` `toolchain.stellarCli`; `soroban/rust-toolchain.toml`;
`.github/workflows/soroban.yml`
**Category:** Build reproducibility
**Detected by:** Rebuilding at a foreign path, then inspecting `contractmetav0`.
**Status:** Open, informational. The claim as written is not wrong.

### Description

The question posed was how strong the reproducibility claim is, given the documentation says
Rust wasm is not bit-reproducible across machines. The answer is: **stronger than the
project claims, and bounded by a variable the project records but does not enforce.**

`soroban/releases/pubnet-v0.1.0.json` hedges carefully:

> "The same source, the same pinned toolchain and the same target produced the same hash on
> the same machine ... That is a reproducibility observation on one machine, not a claim
> that the build is reproducible everywhere."

That hedge is more conservative than the evidence. The build reproduces at a **completely
different absolute path** on the same machine, which the "same machine" wording does not
capture and which is the property most naive Rust builds lack:

```
$ cd /private/tmp/claude-501/.../scratchpad/sb && stellar contract build
$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239
```

The mechanism is visible and is the CLI's doing, not luck:

```
$ stellar contract build --print-commands-only
CARGO_BUILD_RUSTFLAGS=--remap-path-prefix=/Users/mericcintosun/.cargo/registry/src= ...
```

The remap is why `strings` finds no `/Users/` in the shipped artifact while it finds two in
the `cargo build --release` one (A8-02).

**The bound.** The artifact embeds a `contractmetav0` section, and that section is inside
the hashed bytes:

```
$ stellar contract info meta --wasm target/wasm32v1-none/release/agent_spend_policy.wasm
Contract meta:
 • rsver: 1.96.0 (Rust version)
 • rssdkver: 27.0.6#60926a20d1f9f0a669d5fe551636f42a1302f0c0 (Soroban SDK version and its commit hash)
 • cliver: 27.1.0#8e402ea28202950b272fbabc34caad4d2f64fe87
```

Proof that the meta section is hashed, rather than sitting outside the digest:

```
$ stellar contract build --meta auditprobe=1
$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
ac4a84c91bbccc70976b2679f11a4e773525ca87380743160d7b562c0640ab9f
$ stellar contract build                       # same source, no extra meta
$ shasum -a 256 target/wasm32v1-none/release/agent_spend_policy.wasm
155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239
```

One added meta key changes the hash; removing it restores it exactly. So the deployed hash
is a function of three versions, and the repository enforces only two of them:

| Input | Recorded | Enforced |
| --- | --- | --- |
| rustc 1.96.0 | `releases/*.json`, `rust-toolchain.toml` | yes, `rust-toolchain.toml` |
| soroban-sdk 27.0.6 | `releases/*.json`, `Cargo.toml` | yes, `= 27.0.6` exact pin |
| **stellar-cli 27.1.0** | `releases/*.json` only | **no** |

A contributor with stellar-cli 27.1.1 builds correct, honest, identical-source bytes that
hash differently, and the release record gives them no way to know why.

### Recommended fix, in order of how much each buys

**1. Pin the CLI where the other two are pinned.** `rust-toolchain.toml` cannot express it,
so state it in CI and in the README's build block:

```yaml
      - name: Install the pinned stellar CLI
        # The CLI version lands in the wasm as contractmetav0 `cliver`, which is inside the
        # hashed bytes: `stellar contract build --meta k=v` changes the sha256 and removing
        # it restores it exactly. So the CLI version is as much a part of the artifact
        # identity as rustc and the SDK, and it is the only one of the three that
        # rust-toolchain.toml and Cargo.toml cannot pin.
        run: cargo install --locked stellar-cli --version 27.1.0
```

**2. Run the hash gate on ubuntu-latest** (A8-02). This is the step that actually upgrades
the claim: today it is "reproducible at two paths on one macOS arm64 machine". If CI
reproduces `155eb31c...` on Linux x86_64, it becomes "reproducible across two operating
systems and two architectures", verifiable by anyone reading the Actions log. If it does
**not** reproduce, that is a more valuable thing to learn than any of it, and the honest
move is then to say so in the release record.

**3. Record the exact recipe next to the hash.** Add to each release JSON:

```json
  "wasm": {
    "sha256": "155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239",
    "bytes": 11625,
    "limitBytes": 131072,
    "buildCommand": "cd soroban && stellar contract build --locked",
    "reproducedAt": [
      "macOS 15 arm64, 2026-08-24, at two different absolute paths",
      "ubuntu-latest x86_64, via .github/workflows/soroban.yml, every push"
    ],
    "note": "The hash is a function of THREE versions, not two: rustc (contractmetav0 rsver), soroban-sdk (rssdkver) and the stellar CLI (cliver). All three are listed under toolchain above. `cargo build --release --target wasm32v1-none` does NOT reproduce this: stellar contract build additionally sets --remap-path-prefix and spec shaking, and produces 28,728 bytes rather than 11,625. Pull the deployed bytes with `stellar contract fetch --id C... --network pubnet --out-file` and sha256 them."
  }
```

**4. Add a scheduled job that fetches the deployed bytes and hashes them.** The CI gate
proves tree-equals-record. Only `stellar contract fetch` proves record-equals-ledger, which
is the claim a reader of `/proof/:rail` actually cares about. Weekly is enough; the contract
cannot be upgraded, so the only way that assertion breaks is if the record is wrong.

### References

- `soroban/releases/pubnet-v0.1.0.json` `wasm.note`, `toolchain`
- `soroban/README.md:116-119`
- `stellar contract info meta --wasm ...`, stellar-cli 27.1.0
- `audit/research/R3-advisories.md` section 4, SDK issue #1975 (upstream's own
  non-reproducible test wasm builds, recorded there as prior art)

---

## A8-09. Release profile, `unsafe` and dependency pinning verified clean; cargo-geiger did not actually run

**Severity:** Informational
**Category:** Build configuration / dependencies
**Status:** Verified. No action except the geiger gap.

Every item handed over as "already established" was re-derived. All confirmed, with one
qualification at the end.

**Release profile**, `soroban/Cargo.toml`:

```toml
[profile.release]
opt-level = "z"
overflow-checks = true      # confirmed
debug = 0
strip = "symbols"           # confirmed
debug-assertions = false    # confirmed
panic = "abort"             # confirmed
codegen-units = 1
lto = true                  # confirmed
```

All as claimed. Two notes:

- `overflow-checks = true` is correct and the accompanying comment already makes the right
  argument: `policy.rs` uses explicit `checked_add` anyway, because a profile setting is a
  thing a future edit can lose while a typed error is a thing a client can read. That is
  the position threat model section 8 asks for.
- `[profile.release-with-logs]` inherits `release` and sets `debug-assertions = true`.
  Nothing in CI, in the README build block or in either release record uses it. It is inert
  today. Worth a one-line comment saying it is a local debugging profile and must never be
  used to cut a release, since `stellar contract build --profile release-with-logs` would
  accept it and produce a differently-hashed artifact.

**Toolchain**, `soroban/rust-toolchain.toml`: channel `1.96.0`, targets
`["wasm32v1-none"]`, components `["rustfmt", "clippy"]`. Confirmed, and `rustc --version`
reports `1.96.0 (ac68faa20 2026-05-25)`. The comment correctly notes that
`wasm32-unknown-unknown`, which appears in some documentation, is wrong for this platform.
That detail is also what defeats CoinFabrik Scout (A8-10).

**SDK pin:** `soroban-sdk = "=27.0.6"`, exact, no caret, in `[workspace.dependencies]`.
27.0.6 is the newest published version, not yanked. Re-confirmed against the six-advisory
GHSA set in A8-01: none applies.

**`unsafe`:**

```
$ grep -rn unsafe soroban/contracts/
(no output)
```

Zero `unsafe` blocks in first-party code. **However, `cargo geiger` did not run.** The
committed output is an error, not a result:

```
$ cat audit/tool-output/P2-cargo-geiger.txt
manifest path `.../soroban/Cargo.toml` is a virtual manifest, but this command requires
running against an actual package in this workspace
```

So the question geiger was there to answer, how much `unsafe` is in the 74 crates that
reach the wasm, is **unanswered**. R4 section 1 already gives the fix (run it from
`soroban/contracts/agent-spend-policy`, not the workspace root). Someone should run it and
commit a real result, or record explicitly that it was not run. An error message filed among
results is the same shape of problem as the Scout false green, just less dangerous.

**Dependency posture,** re-derived rather than quoted:

- `cargo audit`: 215 locked crates, 0 vulnerabilities, 1 allowed warning
  (`RUSTSEC-2024-0436`, `paste` 1.0.15, unmaintained). Correctly ignored in `deny.toml` with
  the reasoning written out, and correctly unreachable from the wasm:
  `cargo tree --target wasm32v1-none -e normal -i paste` prints "nothing to print".
- `cargo deny` with the `deny.toml` written today: `advisories ok, bans ok, licenses ok,
  sources ok`. `sources ok` is the quietly valuable line: every crate resolves from
  crates.io, no git or path dependency anywhere.
- `deny.toml` itself is well-written, and its `[advisories]` comment already states the
  RustSec coverage gap that A8-01 is about. It is currently **untracked**.
- One observation `cargo deny` surfaces as a warning: `stellar-strkey` appears at both
  0.0.13 and 0.0.16 in the lock, along with `block-buffer`, `hashbrown` and others.
  `multiple-versions = "warn"` is the right setting. The wasm build resolves to 0.0.16.

---

## A8-10. CoinFabrik Scout is not referenced anywhere in this repository

**Severity:** Informational. **Explicitly not a finding.**
**Category:** Tooling claims
**Status:** Checked, negative.

R4 established that `cargo scout-audit` 0.3.16 is a false green against this crate: its
build fails because soroban-sdk's `build.rs` rejects the `wasm32-unknown-unknown` target
Scout uses, and it nonetheless prints `Analyzed 0 0 0 0`, writes `"findings": []` and exits
0. The brief asked whether that false green has been laundered into this repository as
evidence of review.

It has not:

```
$ grep -rni scout --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=audit .
(only matches are blockscout.com explorer URLs in README.md, ARCHITECTURE.md,
 mcp/scripts/*.mjs, mcp/src/chains/registry.ts and mcp/src/celo-x402.test.ts)
```

No workflow runs it, no document names it, no claim rests on it. The only place Scout is
discussed is `audit/research/R4-tooling.md`, which records it correctly as unusable.

The related concern is real and is filed separately as A8-07: the mainnet release record
claims "free tooling ... with output committed" without naming any tool or path. The fix
proposed there names Scout and soroban-scanner explicitly as **tried and not usable**,
which converts a vague claim into a specific and unusually honest one.

---

## Appendix: what was verified rather than accepted

| Handed-over claim | Result |
| --- | --- |
| Release profile settings as listed | Confirmed, verbatim |
| No `unsafe` anywhere | Confirmed for first-party code; dependency tree UNVERIFIED (geiger did not run) |
| `soroban-sdk = "=27.0.6"`, current latest | Confirmed |
| cargo audit: 0 vulns / 215 crates, 1 allowed warning | Confirmed, re-run |
| cargo deny after today's deny.toml: all four ok | Confirmed |
| RustSec has never carried a Stellar advisory | Confirmed independently: 909 crate dirs, 1206 advisories, 0 hits |
| GHSA carries 5 against the Stellar stack | **Corrected: 6.** `GHSA-5873-6fwq-463f` on `stellar-strkey`, a crate inside the wasm |
| Dependabot disabled on both remotes | Confirmed, and **widened**: secret scanning and push protection are off too |
| gitleaks: 7 hits, all false positives | **Confirmed**, by address derivation and by reading each site |
| ... "zero-balance on our live mainnets" | **Corrected: false.** Dust on Avalanche and Celo. Irrelevant to the verdict; balance is the wrong test |
| `testutils` not in any default list; wasm hash unchanged | Confirmed; hash reproduces at a foreign path |
| `stellar contract build` cannot enable `testutils` | **Corrected in reasoning:** it accepts `--features`/`--all-features`. The build then fails with 180 errors, which is a stronger guarantee |
| `run-negative-controls.mjs` is NOT in CI | **Corrected: it is**, `.github/workflows/soroban.yml:75-76`, committed |
| Reproducibility is a one-machine observation | **Stronger than claimed:** path-independent. Bounded by an unpinned CLI version |
| Scout false green referenced in this repo | Not present. No finding |
