import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData } from 'viem'
import {
  ARC_MIN_MAX_FEE_WEI,
  DEFAULT_MAX_FEE_CAP_WEI,
  feesFor,
  formatUnitsString,
  gasCostUsdc,
  gasLimitFor,
  ownerPayCalldata,
  payCalldata,
  prepareOwnerPay,
  preparePay,
} from './prepare.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { getChainById } from '../chains/index.js'

/**
 * The calls handed back for someone else's key to send. Two properties matter more than any
 * other: the calldata says exactly pay(payee, amount) with the request's own payee and amount,
 * and the fee is one Arc will include, because below 20 gwei it drops the transaction without
 * an error or a receipt.
 */
const arc = getChainById('arc-mainnet')!
const GWEI = 1_000_000_000n
const VAULT = '0x' + 'a1'.repeat(20)
const OWNER = '0x' + 'b2'.repeat(20)
const OPERATOR = '0x' + 'c3'.repeat(20)
const PAYEE = '0x' + 'd4'.repeat(20)

test('the fee is never under the 20 gwei floor, is 2 x gasPrice + tip above it, and is clamped or refused at the cap', () => {
  assert.equal(ARC_MIN_MAX_FEE_WEI, 20n * GWEI)
  const low = feesFor(5n * GWEI)
  assert.ok(low.ok)
  if (low.ok) {
    assert.equal(low.fees.maxFeePerGas, 20n * GWEI)
    assert.equal(low.fees.maxPriorityFeePerGas, GWEI)
    assert.equal(low.fees.clamped, false)
  }
  // What Arc Mainnet answered on 2026-11-01: 20.001 gwei.
  const today = feesFor(20_001_000_000n)
  assert.ok(today.ok && today.fees.maxFeePerGas === 41_002_000_000n)
  const mid = feesFor(50n * GWEI)
  assert.ok(mid.ok && mid.fees.maxFeePerGas === 101n * GWEI)

  // 2 x 150 + 1 is past the 200 gwei cap, but 150 + 1 still fits under it: clamp, and say so.
  const busy = feesFor(150n * GWEI)
  assert.ok(busy.ok)
  if (busy.ok) {
    assert.equal(busy.fees.maxFeePerGas, DEFAULT_MAX_FEE_CAP_WEI)
    assert.equal(busy.fees.clamped, true)
  }
  // Past the cap even at price + tip: refuse rather than prepare a fee that would sit unmined.
  const spike = feesFor(200n * GWEI)
  assert.equal(spike.ok, false)
  if (!spike.ok) assert.equal(spike.code, 'GasPriceAboveCap')
  assert.throws(() => feesFor(GWEI, { capWei: 10n * GWEI }), RangeError)
})

test('pay and ownerPay calldata decode to exactly the request payee and amount', () => {
  const pay = decodeFunctionData({ abi: AgentSpendPolicyAbi, data: payCalldata(PAYEE, 250_000n) })
  assert.equal(pay.functionName, 'pay')
  assert.deepEqual(pay.args?.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [PAYEE, 250_000n])
  const own = decodeFunctionData({ abi: AgentSpendPolicyAbi, data: ownerPayCalldata(PAYEE, 250_000n) })
  assert.equal(own.functionName, 'ownerPay')
  assert.deepEqual(own.args?.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [PAYEE, 250_000n])
})

test('a prepared call carries the registry chain id, value 0, its sender, a gas limit with headroom and its gas cost in USDC', () => {
  const fees = feesFor(20_001_000_000n)
  assert.ok(fees.ok)
  if (!fees.ok) return
  const p = preparePay(arc, { vault: VAULT, operator: OPERATOR, payee: PAYEE, amount: 250_000n, gasEstimate: 116_370n, fees: fees.fees, simulation: { ok: true } })
  assert.equal(p.chainId, arc.evmChainId)
  assert.equal(p.from, OPERATOR)
  assert.equal(p.to, VAULT)
  assert.equal(p.value, '0')
  assert.equal(p.function, 'pay(address,uint256)')
  assert.deepEqual(p.args, [PAYEE, '250000'])
  assert.equal(p.data, payCalldata(PAYEE, 250_000n))
  assert.equal(p.fees.gas, gasLimitFor(116_370n).toString())
  assert.equal(p.fees.gas, '139644')
  assert.ok(BigInt(p.fees.maxFeePerGas) >= ARC_MIN_MAX_FEE_WEI)
  assert.equal(p.fees.floorWei, '20000000000')
  // 139644 gas x 41.002 gwei = 0.005725683288 USDC of native gas, rounded up to the unit.
  assert.equal(p.fees.maxCostUsdc, '0.005726')

  const o = prepareOwnerPay(arc, { vault: VAULT, owner: OWNER, payee: PAYEE, amount: 250_000n, gasEstimate: null, fees: fees.fees, simulation: { ok: false, error: 'TransferFailed' } })
  assert.equal(o.from, OWNER)
  assert.equal(o.function, 'ownerPay(address,uint256)')
  assert.equal(o.fees.gas, null)
  assert.equal(o.fees.maxCostUsdc, null)
  assert.deepEqual(o.simulation, { ok: false, error: 'TransferFailed' })
})

test('amounts are formatted with string math, and gas cost uses the registry decimals of both faces of USDC', () => {
  assert.equal(formatUnitsString(250_000n, 6), '0.25')
  assert.equal(formatUnitsString(1n, 6), '0.000001')
  assert.equal(formatUnitsString(10_000n, 6), '0.01')
  assert.equal(formatUnitsString(3_000_000n, 6), '3')
  assert.equal(arc.nativeCurrency?.decimals, 18)
  assert.equal(arc.usdcDecimals, 6)
  // One wei of native gas still costs a whole unit of the 6-decimal face once rounded up.
  assert.equal(gasCostUsdc(arc, 1n), '0.000001')
  assert.equal(gasCostUsdc(arc, 10n ** 12n), '0.000001')
  assert.equal(gasCostUsdc(arc, 90_341n * 20_100_000_000n), '0.001816')
})
