import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  // immutable range must sit inside the runtime and hold zeros there: otherwise "zero those
  // ranges and compare" would vouch for a build this page does not deploy.
  const creation = AgentSpendPolicyBytecode.slice(2)
  const runtime = AgentSpendPolicyDeployedBytecode.slice(2)
  assert.ok(runtime.length > 0, 'the artifact carries no runtime code')
  assert.ok(creation.includes(runtime), 'the runtime is not the one embedded in the creation code')
  assert.ok(AgentSpendPolicyImmutableReferences.length > 0, 'AgentSpendPolicy has two immutables, so it must carry their ranges')
  for (const r of AgentSpendPolicyImmutableReferences) {
    assert.ok(r.start >= 0 && r.start + r.length <= runtime.length / 2, `immutable range ${r.start}+${r.length} lies outside the runtime`)
    assert.equal(runtime.slice(r.start * 2, (r.start + r.length) * 2), '0'.repeat(r.length * 2), `immutable range at ${r.start} is not zero in the runtime`)
  }
})
