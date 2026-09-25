#!/usr/bin/env node
/**
 * On-chain integration test for the Arc `Memo` audit trail, against real Arc testnet by
 * default, or any registry chain that declares `contracts.memo` with --chain (arc-mainnet).
 * Settles USDC THROUGH the Memo precompile (the same `payUsdcWithMemoOnchain` path
 * `executeInstruction` uses), then reads the emitted `Memo` event back by its indexed
 * `memoId` to prove the "why" of a payment is provably on-chain and reconcilable —
 * not just a server log. Pays back to the signer, so only gas is spent.
 *
 * Run:  node --env-file=.env scripts/test-memo.mjs   (needs a funded ARC_SIGNER_KEY)
 *       node --env-file=.env scripts/test-memo.mjs --chain arc-mainnet   (ARC_MAINNET_SIGNER_KEY)
 */
import { encodeMemo } from '../dist/chains/evm/memo.js'
import { getChainById } from '../dist/chains/registry.js'
import { createEvmAdapter } from '../dist/chains/evm/adapter.js'
import { privateKeyToAccount } from 'viem/accounts'

const i = process.argv.indexOf('--chain')
const chain = getChainById(i >= 0 ? process.argv[i + 1] : 'arc')
if (!chain || !chain.contracts.memo) { console.error('error: --chain must be a registry chain that declares contracts.memo'); process.exit(1) }
const adapter = createEvmAdapter(chain)
const signerKey = process.env[chain.signerEnvVar]
if (!signerKey) { console.error(`error: ${chain.signerEnvVar} is not set`); process.exit(1) }
const signer = privateKeyToAccount(signerKey).address
const payUsdcWithMemoOnchain = (to, usd, memo) => adapter.payUsdcWithMemo(to, usd, memo)
const readMemosOnchain = (filter) => adapter.readMemos(filter)
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`)
  cond ? pass++ : fail++
}

console.log(`chain: ${chain.name} (${chain.caip2})`)
console.log('signer / payer:', signer, '\n')

// A realistic settlement memo: which agent paid, for which instruction, what, and the decision.
const instructionId = `ix_memo_test_${signer.slice(2, 10)}_${process.pid}`
const memoInput = {
  // On Arc Mainnet the payer is agent #0's owner, so the memo names that agent.
  agentId: chain.testnet ? 'agt_meridian' : `${chain.caip2}:8004/0`,
  instructionId,
  service: 'payment',
  policyDecision: 'auto_approved',
}
const expected = encodeMemo(memoInput)

// 1. Settle $0.01 USDC through the Memo precompile (back to the signer → only gas spent).
const res = await payUsdcWithMemoOnchain(signer, 0.01, memoInput)
ok('settle $0.01 USDC wrapped in a Memo', res.executed === true, res.executed ? res.txHash : res.reason)
if (!res.executed) process.exit(1)
console.log('   tx   :', res.explorerUrl)
console.log('   memoId:', res.memoId)
console.log('   memo :', res.memo)
ok('memoId matches the deterministic id for this instruction', res.memoId === expected.memoId, res.memoId)
ok('on-chain reason payload is the expected JSON', res.memo === expected.reason, res.memo)

// 2. Read the Memo event back by its indexed memoId — the reconciliation query.
const read = await readMemosOnchain({ memoId: res.memoId, maxBlocks: 200 })
ok('Memo precompile is supported on this chain', read.supported === true, read.contract)
const hit = read.memos.find((m) => m.txHash.toLowerCase() === res.txHash.toLowerCase())
ok('the settlement is indexable on-chain by memoId', !!hit, hit ? `block ${hit.blockNumber}` : `found ${read.memos.length} in window`)
if (hit) {
  ok('on-chain sender is preserved as our EOA (CallFrom)', hit.sender.toLowerCase() === signer.toLowerCase(), hit.sender)
  ok('on-chain target is the USDC contract', hit.target.toLowerCase() === chain.contracts.usdc.toLowerCase(), hit.target)
  ok('decoded on-chain reason round-trips', hit.memo === expected.reason, hit.memo)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
