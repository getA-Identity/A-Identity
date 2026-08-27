import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTrustOracleDogfood } from './trust-oracle.js'

// No signer -> forces the prepared/no-key path deterministically (no network I/O).
const NO_SIGNER: NodeJS.ProcessEnv = {}

test('without a signer, the Trust Oracle dogfood returns a prepared no-op (not executed)', async () => {
  const res = await runTrustOracleDogfood({ agentId: '#849980' }, NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false) {
    assert.equal(res.tool, 'risk_check')
    assert.equal(res.priceUsd, 0.005)
    assert.match(res.reason, /ARC_SIGNER_KEY/)
  }
})

test('the dogfood price defaults to the risk_check list price ($0.005)', async () => {
  const res = await runTrustOracleDogfood({ agentId: '#849980', amountUsd: undefined }, NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false) assert.equal(res.priceUsd, 0.005)
})
