import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentSpendPolicyBytecode,
  AgentSpendPolicyDeployedBytecode,
  AgentSpendPolicyImmutableReferences,
  AgentSpendPolicySourceSha256,
} from './AgentSpendPolicy.js'
import { FRONTEND_VAULT_MODULE, renderFrontendVaultModule } from './frontend-view.js'

// The browser deploys the vault from its own copy of the artifact (/app/vault/arc), so there
// are three things that can drift apart: the .sol, the compiled artifact the backend and the
// Sourcify verifier use, and the frontend copy. Commit 33c7df69 found the first two apart
// with nothing noticing. These pin all three together.

/** Compiled to dist/contracts/, so the repository root is three levels up. */
const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))

test('the browser vault module is the compiled artifact, byte for byte', () => {
  assert.equal(
    readFileSync(repo(FRONTEND_VAULT_MODULE), 'utf8'),
    renderFrontendVaultModule(),
    `${FRONTEND_VAULT_MODULE} is stale or was hand-edited. Run: cd mcp && npm run gen:contracts`,
  )
})

test('the vault artifact was compiled from the Solidity source on disk', () => {
  const sha = createHash('sha256').update(readFileSync(repo('mcp/contracts/AgentSpendPolicy.sol'))).digest('hex')
  assert.equal(
    sha,
    AgentSpendPolicySourceSha256,
    'mcp/contracts/AgentSpendPolicy.sol changed after the artifact was compiled. Run: cd mcp && npm run compile && npm run gen:contracts',
  )
})

test('the runtime a vault is checked against is the runtime this creation code deploys', () => {
  // The creation code carries the runtime with its immutables still zero and the constructor
  // writes them in. So the runtime must appear verbatim inside the creation code, and every
  // immutable range must sit inside the runtime and hold zeros there: otherwise "write the
  // owner and token in and compare" would vouch for a build this page does not deploy.
  const creation = AgentSpendPolicyBytecode.slice(2)
  const runtime = AgentSpendPolicyDeployedBytecode.slice(2)
  assert.ok(runtime.length > 0, 'the artifact carries no runtime code')
  assert.ok(creation.includes(runtime), 'the runtime is not the one embedded in the creation code')
  for (const [name, ranges] of Object.entries(AgentSpendPolicyImmutableReferences)) {
    for (const r of ranges) {
      assert.ok(r.start >= 0 && r.start + r.length <= runtime.length / 2, `${name} range ${r.start}+${r.length} lies outside the runtime`)
      assert.equal(runtime.slice(r.start * 2, (r.start + r.length) * 2), '0'.repeat(r.length * 2), `${name} range at ${r.start} is not zero in the runtime`)
    }
  }
})

test('the immutable ranges are kept per immutable, so each one can be checked against its own value', () => {
  // Flattened into one list, the ranges let a check zero them all and compare the rest, which
  // passes a copy whose owner() reads one key while onlyOwner checks another. Grouped by name,
  // the page can require every owner range to hold the owner() it shows.
  const refs = AgentSpendPolicyImmutableReferences
  assert.deepEqual(Object.keys(refs), ['owner', 'usdc'], 'AgentSpendPolicy has exactly two immutables, owner and usdc')
  const all = [...refs.owner, ...refs.usdc].sort((a, b) => a.start - b.start)
  assert.ok(refs.owner.length > 1 && refs.usdc.length > 1, 'each immutable is read in more than one place, which is why one value per name must be enforced')
  for (const r of all) assert.equal(r.length, 32, `an immutable range at ${r.start} is not one 32-byte word`)
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].start + all[i - 1].length <= all[i].start, `immutable ranges at ${all[i - 1].start} and ${all[i].start} overlap`)
})

test('the root artifact check fails when either side cannot be read, and never passes by comparing nothing', () => {
  const backend = 'mcp/src/contracts/AgentSpendPolicy.ts'
  const files = ['scripts/check-vault-artifact.mjs', 'mcp/contracts/AgentSpendPolicy.sol', backend, FRONTEND_VAULT_MODULE]
  /** The ABI of one module replaced by text that is not JSON, as an edit gone wrong would leave it. */
  const mangleAbi = (text: string, name: string) => {
    const head = `export const ${name} = `
    const start = text.indexOf(head)
    const end = text.indexOf(' as const\n', start)
    assert.ok(start >= 0 && end > start, `${name} is gone from the module`)
    return `${text.slice(0, start + head.length)}[not json]${text.slice(end)}`
  }
  const run = (mangle: { backend?: boolean; frontend?: boolean }) => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-artifact-'))
    try {
      for (const rel of files) cpSync(repo(rel), join(dir, rel), { recursive: true })
      if (mangle.backend) writeFileSync(join(dir, backend), mangleAbi(readFileSync(repo(backend), 'utf8'), 'AgentSpendPolicyAbi'))
      if (mangle.frontend) writeFileSync(join(dir, FRONTEND_VAULT_MODULE), mangleAbi(readFileSync(repo(FRONTEND_VAULT_MODULE), 'utf8'), 'AGENT_SPEND_POLICY_ABI'))
      return spawnSync(process.execPath, [join(dir, 'scripts/check-vault-artifact.mjs')], { encoding: 'utf8' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.equal(run({}).status, 0, 'the untouched copies must pass, or the cases below prove nothing')
  for (const mangle of [{ backend: true, frontend: true }, { backend: true }, { frontend: true }]) {
    const r = run(mangle)
    assert.equal(r.status, 1, `${JSON.stringify(mangle)} passed: ${r.stdout}`)
    assert.match(r.stderr, /the ABI could not be read from/, JSON.stringify(mangle))
  }
})
