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
