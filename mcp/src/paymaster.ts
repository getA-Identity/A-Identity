/**
 * Circle Paymaster - who pays the agent's gas, answered honestly per chain.
 *
 * Circle Paymaster is an ERC-4337 token paymaster: a smart account signs an EIP-2612
 * permit over its own USDC, the paymaster fronts the gas, and the user is charged in
 * USDC instead of the chain's native token. That is the right primitive on a chain whose
 * gas is ETH.
 *
 * On Arc it is not, and this module says so rather than shipping a decorative
 * integration. Two facts, both checkable:
 *
 *   1. **Arc's native gas token IS USDC** (see the chain registry). An agent on Arc
 *      already pays gas in USDC by construction, so a token paymaster is redundant here.
 *   2. **The published Arc Testnet paymaster addresses have no contract behind them.**
 *      Circle's addresses page lists Arc Testnet for v0.7 and v0.8, but `eth_getCode`
 *      returns `0x` at both, on more than one Arc RPC. The same v0.8 address on Base
 *      Sepolia returns real bytecode. Circle's own supported-chains table omits Arc,
 *      so the two pages disagree and the chain is the tiebreaker.
 *
 * So: `paymasterStatus()` probes the chain rather than trusting a doc, and the encoder
 * below is the real integration, ready for the chains where the contract exists (and for
 * Arc the moment Circle deploys there). Nothing here pretends.
 */
import { ARC_CHAIN, getChainByEvmId } from './chains/registry.js'

/** Circle Paymaster, as published on developers.circle.com/paymaster/addresses-and-events. */
export const CIRCLE_PAYMASTER = {
  /** EntryPoint v0.7 */
  v07: '0x31BE08D380A21fc740883c0BC434FcFc88740b58',
  /** EntryPoint v0.8 */
  v08: '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
} as const

export type GasStory = {
  chain: string
  evmChainId: number
  /** How gas is actually paid for an agent on this chain. */
  gasPaidIn: string
  /** Whether a token paymaster adds anything here. */
  paymasterRelevant: boolean
  /** Live probe: is Circle Paymaster actually deployed at the published address? */
  paymasterDeployed: boolean | null
  address: string
  note: string
}

/** `eth_getCode` against a chain's RPC. Returns null when the RPC cannot be reached. */
async function hasCode(rpcUrl: string, address: string): Promise<boolean | null> {
  try {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(12_000),
    })
    const j = (await r.json()) as { result?: string }
    if (typeof j.result !== 'string') return null
    return j.result.length > 2
  } catch {
    return null
  }
}

/**
 * Where the agent's gas comes from on a given chain, probed rather than asserted.
 * No key, no write, safe to call from a cold UI.
 */
export async function paymasterStatus(
  evmChainId: number = ARC_CHAIN.evmChainId as number,
  rpcOverride?: string,
): Promise<GasStory> {
  const chain = getChainByEvmId(evmChainId)
  const rpc = rpcOverride ?? chain?.rpcUrls?.[0]
  const nativeIsUsdc = (chain?.nativeCurrency?.symbol ?? '').toUpperCase() === 'USDC'
  const address = CIRCLE_PAYMASTER.v08

  const deployed = rpc ? await hasCode(rpc, address) : null

  return {
    chain: chain?.name ?? `chain ${evmChainId}`,
    evmChainId,
    gasPaidIn: nativeIsUsdc ? 'USDC (native gas token)' : (chain?.nativeCurrency?.symbol ?? 'the chain native token'),
    // The point of the whole product line: paying gas in USDC where you otherwise could not.
    paymasterRelevant: !nativeIsUsdc,
    paymasterDeployed: deployed,
    address,
    note: nativeIsUsdc
      ? 'Gas is already denominated in USDC on this chain, so an agent needs no token paymaster and no second asset. This is the property Arc exists for.'
      : deployed === false
        ? 'Circle publishes a paymaster address for this chain but no contract is deployed at it yet.'
        : deployed === null
          ? 'Could not reach an RPC to probe the paymaster contract.'
          : 'Circle Paymaster is deployed here: an agent can pay gas in USDC by signing an EIP-2612 permit.',
  }
}

/**
 * The real integration, kept small and pure so it is testable without a chain.
 *
 * Circle Paymaster reads its instructions from `paymasterData`: a version byte, the USDC
 * address being permitted, the permitted amount, and the account's EIP-2612 signature.
 * Callers pass this to a bundler alongside the UserOperation; Circle Paymaster is only
 * the paymaster, so a bundler (Pimlico, in our case) is still required.
 */
export function encodePaymasterData(input: {
  usdc: `0x${string}`
  permitAmount: bigint
  permitSignature: `0x${string}`
}): `0x${string}` {
  const { usdc, permitAmount, permitSignature } = input
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdc)) throw new Error('encodePaymasterData: usdc must be a 20-byte address')
  if (permitAmount <= 0n) throw new Error('encodePaymasterData: permitAmount must be positive')
  if (!permitSignature.startsWith('0x')) throw new Error('encodePaymasterData: permitSignature must be hex')

  const version = '00' // uint8 mode selector, 0 = permit
  const token = usdc.slice(2).toLowerCase()
  const amount = permitAmount.toString(16).padStart(64, '0') // uint256
  return `0x${version}${token}${amount}${permitSignature.slice(2)}` as `0x${string}`
}

/** The gas limits Circle's own quickstart uses for the paymaster steps. */
export const PAYMASTER_GAS = {
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 15_000n,
} as const
