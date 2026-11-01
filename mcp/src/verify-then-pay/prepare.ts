/**
 * The calls verify-then-pay hands back, built from the request's own inputs and nothing else.
 *
 * Pure: no RPC, no key. The hosted server never signs; these are the exact transactions the
 * operator (pay) or the owner (ownerPay) would send, with fees Arc will actually include.
 *
 * Fees, and why they look like this:
 *   - Arc drops a transaction whose maxFeePerGas is below 20 gwei, silently: no error and no
 *     receipt. So 20 gwei is a floor, never a target.
 *   - Above the floor, maxFeePerGas = 2 x eth_gasPrice + the tip, the usual headroom for a
 *     base fee that moves while the transaction waits (on launch day it went from about 35 to
 *     about 187 gwei).
 *   - A cap bounds what one payment may be priced at. Past it the fee is clamped to the cap
 *     while the current price plus the tip still fits under it; when even that does not fit,
 *     the payment is refused rather than prepared with a fee that would not be included.
 * Gas is paid in native USDC, 18 decimals; the payment itself is the 6-decimal ERC-20 face of
 * the same balance. Both decimal counts come from the registry.
 */
import { encodeFunctionData, type Hex } from 'viem'
import type { ChainDescriptor } from '../chains/index.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'

const GWEI = 1_000_000_000n

/** Below this Arc drops the transaction without an error. */
export const ARC_MIN_MAX_FEE_WEI = 20n * GWEI
export const DEFAULT_TIP_WEI = 1n * GWEI
export const DEFAULT_MAX_FEE_CAP_WEI = 200n * GWEI
/** Headroom on a gas estimate, in percent, for the limit a prepared call carries. */
export const GAS_HEADROOM_PCT = 20n

export type Fees = {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  floorWei: bigint
  capWei: bigint
  /** True when 2 x gasPrice + tip was above the cap and the fee was clamped to it. */
  clamped: boolean
  gasPriceWei: bigint
}

export type FeesResult = { ok: true; fees: Fees } | { ok: false; code: 'GasPriceAboveCap'; reason: string; gasPriceWei: bigint; capWei: bigint }

export function feesFor(gasPriceWei: bigint, opts: { tipWei?: bigint; capWei?: bigint } = {}): FeesResult {
  const tip = opts.tipWei ?? DEFAULT_TIP_WEI
  const cap = opts.capWei ?? DEFAULT_MAX_FEE_CAP_WEI
  if (cap < ARC_MIN_MAX_FEE_WEI) throw new RangeError(`a fee cap below the ${ARC_MIN_MAX_FEE_WEI} wei floor could never be included`)
  if (gasPriceWei < 0n || tip < 0n) throw new RangeError('gas price and tip cannot be negative')
  if (gasPriceWei + tip > cap) {
    return {
      ok: false,
      code: 'GasPriceAboveCap',
      reason: `the gas price is ${gasPriceWei} wei, so even the price plus the tip is above the ${cap} wei cap; a payment priced under the cap would not be included right now`,
      gasPriceWei,
      capWei: cap,
    }
  }
  const wanted = 2n * gasPriceWei + tip
  const floored = wanted > ARC_MIN_MAX_FEE_WEI ? wanted : ARC_MIN_MAX_FEE_WEI
  const clamped = floored > cap
  const maxFeePerGas = clamped ? cap : floored
  return {
    ok: true,
    fees: { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas, floorWei: ARC_MIN_MAX_FEE_WEI, capWei: cap, clamped, gasPriceWei },
  }
}

/** A gas estimate with headroom, rounded up. */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * (100n + GAS_HEADROOM_PCT) + 99n) / 100n
}

/** Format base units as a decimal string, trailing zeros trimmed: 250000 at 6 -> "0.25". */
export function formatUnitsString(v: bigint, decimals: number): string {
  const neg = v < 0n
  const x = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = x / base
  const frac = (x % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/**
 * A native gas amount (wei, the chain's native decimals) as USDC at the ERC-20's decimals,
 * rounded UP to the last unit, as a decimal string. On Arc both are the same balance, so this
 * is exact up to the rounding: 116370 gas at 41 gwei is "0.004772".
 */
export function gasCostUsdc(chain: ChainDescriptor, wei: bigint): string {
  const native = chain.nativeCurrency?.decimals ?? 18
  const shift = 10n ** BigInt(Math.max(0, native - chain.usdcDecimals))
  const units = (wei + shift - 1n) / shift
  return formatUnitsString(units, chain.usdcDecimals)
}

export function payCalldata(payee: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'pay', args: [payee as Hex, amount] })
}

export function ownerPayCalldata(payee: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'ownerPay', args: [payee as Hex, amount] })
}

export type PreparedCall = {
  chainId: number
  from: string
  to: string
  value: '0'
  data: string
  function: 'pay(address,uint256)' | 'ownerPay(address,uint256)'
  args: [string, string]
  fees: {
    maxFeePerGas: string
    maxPriorityFeePerGas: string
    floorWei: string
    capWei: string
    clamped: boolean
    /** The gas limit to send with, an estimate plus headroom; null when it could not be estimated. */
    gas: string | null
    /** gas x maxFeePerGas in USDC, the most this call can cost in gas; null without a gas limit. */
    maxCostUsdc: string | null
  }
  /** The call simulated (eth_call) from its sender at the latest block, after the verdict. */
  simulation: { ok: true } | { ok: false; error: string }
}

function prepared(
  chain: ChainDescriptor,
  kind: 'pay' | 'ownerPay',
  input: { vault: string; from: string; payee: string; amount: bigint; gasEstimate: bigint | null; fees: Fees; simulation: PreparedCall['simulation'] },
): PreparedCall {
  if (chain.evmChainId == null) throw new Error(`${chain.id} has no EVM chain id`)
  const gas = input.gasEstimate != null ? gasLimitFor(input.gasEstimate) : null
  return {
    chainId: chain.evmChainId,
    from: input.from,
    to: input.vault,
    value: '0',
    data: kind === 'pay' ? payCalldata(input.payee, input.amount) : ownerPayCalldata(input.payee, input.amount),
    function: kind === 'pay' ? 'pay(address,uint256)' : 'ownerPay(address,uint256)',
    args: [input.payee, input.amount.toString()],
    fees: {
      maxFeePerGas: input.fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: input.fees.maxPriorityFeePerGas.toString(),
      floorWei: input.fees.floorWei.toString(),
      capWei: input.fees.capWei.toString(),
      clamped: input.fees.clamped,
      gas: gas != null ? gas.toString() : null,
      maxCostUsdc: gas != null ? gasCostUsdc(chain, gas * input.fees.maxFeePerGas) : null,
    },
    simulation: input.simulation,
  }
}

/** vault.pay(payee, amount), sent by the vault's operator: the agent path after ALLOW. */
export function preparePay(
  chain: ChainDescriptor,
  input: { vault: string; operator: string; payee: string; amount: bigint; gasEstimate: bigint | null; fees: Fees; simulation: PreparedCall['simulation'] },
): PreparedCall {
  return prepared(chain, 'pay', { ...input, from: input.operator })
}

/** vault.ownerPay(payee, amount), sent by the vault's owner: the hand-off after WARN. */
export function prepareOwnerPay(
  chain: ChainDescriptor,
  input: { vault: string; owner: string; payee: string; amount: bigint; gasEstimate: bigint | null; fees: Fees; simulation: PreparedCall['simulation'] },
): PreparedCall {
  return prepared(chain, 'ownerPay', { ...input, from: input.owner })
}
