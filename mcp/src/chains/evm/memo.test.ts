import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, stringToHex } from 'viem'
import { memoIdFor, encodeMemo, decodeMemo, type MemoInput } from './memo.js'
import { createEvmAdapter } from './adapter.js'
import { ARC_CHAIN, getChainById } from '../registry.js'

// No signer -> forces the prepared/no-key path deterministically.
const NO_SIGNER: NodeJS.ProcessEnv = {}

const SAMPLE: MemoInput = {
  agentId: 'agt_meridian',
  instructionId: 'ix_abc123',
  service: 'payment',
  policyDecision: 'auto_approved',
}

test('memoIdFor is deterministic and matches keccak256(stringToHex(ref))', () => {
  const id = memoIdFor('ix_abc123')
  assert.match(id, /^0x[0-9a-f]{64}$/)
  assert.equal(id, memoIdFor('ix_abc123')) // stable
  assert.equal(id, keccak256(stringToHex('a-identity:ix:ix_abc123'))) // the documented formula
})

test('different instruction ids yield different memo ids', () => {
  assert.notEqual(memoIdFor('ix_a'), memoIdFor('ix_b'))
})

test('encodeMemo produces the compact reason and a memoId tied to the instruction', () => {
  const { memoId, memoBytes, reason } = encodeMemo(SAMPLE)
  assert.equal(memoId, memoIdFor(SAMPLE.instructionId))
  assert.equal(reason, JSON.stringify({ a: 'agt_meridian', i: 'ix_abc123', s: 'payment', d: 'auto_approved' }))
  // memoBytes is the hex of the reason and round-trips back through decodeMemo.
  assert.equal(memoBytes, stringToHex(reason))
  assert.equal(decodeMemo(memoBytes), reason)
})

test('decodeMemo returns the raw input on non-UTF8 / malformed hex instead of throwing', () => {
  assert.doesNotThrow(() => decodeMemo('0xzz'))
  assert.equal(decodeMemo('0xzz'), '0xzz')
})

test('without a signer, payUsdcWithMemo returns the exact prepared Memo call (Arc)', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.payUsdcWithMemo('0x1111111111111111111111111111111111111111', 0.05, SAMPLE, NO_SIGNER)
  assert.equal(res.executed, false)
  assert.ok('contract' in res) // prepared (not a revert) without a signer
  if (res.executed === false && 'contract' in res) {
    // Wrapped through the Arc Memo precompile, not a bare USDC transfer.
    assert.equal(res.contract, '0x5294E9927c3306DcBaDb03fe70b92e01cCede505')
    assert.equal(res.function, 'memo(address target, bytes data, bytes32 memoId, bytes memoData)')
    // args = [usdc, transferCalldata, memoId, memoBytes]
    assert.equal((res.args[0] as string).toLowerCase(), ARC_CHAIN.contracts.usdc!.toLowerCase())
    assert.equal(res.args[2], encodeMemo(SAMPLE).memoId)
    assert.equal(res.args[3], encodeMemo(SAMPLE).memoBytes)
  }
})

test('on a chain without a Memo precompile, payUsdcWithMemo degrades to a bare transfer', async () => {
  const base = getChainById('base')! // planned EVM chain, no contracts.memo
  const adapter = createEvmAdapter(base)
  const res = await adapter.payUsdcWithMemo('0x1111111111111111111111111111111111111111', 0.05, SAMPLE, NO_SIGNER)
  assert.equal(res.executed, false)
  assert.ok('contract' in res) // prepared fallback (not a revert) without a signer
  if (res.executed === false && 'contract' in res) {
    // Falls back to payUsdc's prepared USDC transfer - no memo wrapper.
    assert.equal((res.contract as string).toLowerCase(), base.contracts.usdc!.toLowerCase())
    assert.equal(res.function, 'transfer(address to, uint256 amount)')
  }
})
