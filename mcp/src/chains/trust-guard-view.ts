/**
 * What @a-identity/trust-guard knows about Arc Mainnet, rendered from the registry.
 *
 * trust-guard is a separate published package and cannot import from mcp/src, so, like the
 * frontend's src/lib/chains.ts (public-view.ts), it gets a GENERATED file:
 * trust-guard/src/arc-mainnet.generated.ts, written by `cd mcp && npm run gen:chains`. A wrong
 * value there would point a real payment somewhere else, which is why it is never typed by
 * hand and why trust-guard-sync.test.ts fails the build when the file on disk differs from
 * this renderer's output.
 *
 * Two things come from outside the registry, each from the one place the backend itself
 * reads them: the fee floor from verify-then-pay/prepare.ts, and the slice of the vault's ABI
 * the SDK needs from the compiled contract, so a selector or an error name cannot drift.
 */
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { ARC_MIN_MAX_FEE_WEI } from '../verify-then-pay/prepare.js'
import { getChainById } from './registry.js'

/** The functions of the vault the SDK calls or reads. Paid and every error come along. */
const VAULT_FUNCTIONS: readonly string[] = [
  'pay',
  'ownerPay',
  'usdc',
  'owner',
  'operator',
  'frozen',
  'sessionKeyExpiry',
  'allowlistEnabled',
  'allowed',
  'autoApproveMax',
  'dailyCap',
  'spentToday',
  'balance',
]

type AbiEntry = { type: string; name?: string }

/** The vault ABI slice, in the contract's own order. Throws if the contract lost an entry. */
export function trustGuardVaultAbi(): readonly AbiEntry[] {
  const abi = AgentSpendPolicyAbi as readonly AbiEntry[]
  for (const name of [...VAULT_FUNCTIONS, 'Paid']) {
    if (!abi.some((e) => e.name === name)) throw new Error(`AgentSpendPolicy has no ${name}, which trust-guard needs`)
  }
  return abi.filter((e) => e.type === 'error' || (e.type === 'event' && e.name === 'Paid') || (e.type === 'function' && VAULT_FUNCTIONS.includes(e.name ?? '')))
}

/** The Arc Mainnet values the SDK uses, every one read from the registry's descriptor. */
export function trustGuardArcMainnet() {
  const c = getChainById('arc-mainnet')
  if (!c) throw new Error('the registry has no arc-mainnet')
  const { evmChainId, cctpDomain, explorer, gateway, nativeCurrency } = c
  const { usdc, identityRegistry } = c.contracts
  if (evmChainId == null || cctpDomain == null || !explorer || !gateway || !nativeCurrency || !usdc || !identityRegistry) {
    throw new Error('the arc-mainnet descriptor lost a value trust-guard needs')
  }
  return {
    id: c.id,
    caip2: c.caip2,
    chainId: evmChainId,
    usdc,
    usdcDecimals: c.usdcDecimals,
    nativeDecimals: nativeCurrency.decimals,
    identityRegistry,
    gatewayWallet: gateway.wallet,
    gatewayFacilitator: gateway.facilitator,
    gatewayDomain: cctpDomain,
    rpcUrls: [...c.rpcUrls],
    explorer,
  }
}

/** The text of trust-guard/src/arc-mainnet.generated.ts. */
export function renderTrustGuardArc(): string {
  const chain = JSON.stringify(trustGuardArcMainnet(), null, 2).replace(/\n\}$/, `,\n  "minMaxFeePerGasWei": ${ARC_MIN_MAX_FEE_WEI}n\n}`)
  return `// GENERATED from mcp/src/chains/registry.ts and mcp/src/contracts/AgentSpendPolicy.ts.
// Never hand-edit: run cd mcp && npm run gen:chains. mcp/src/chains/trust-guard-sync.test.ts
// fails the build if this file differs from the registry.

/** Arc Mainnet as the A-Identity chain registry declares it. USDC is 6 decimals as an ERC-20
 *  and 18 as the native gas balance. Below minMaxFeePerGasWei, Arc drops a transaction with
 *  no error and no receipt. */
export const ARC_MAINNET = ${chain} as const

/** The part of the AgentSpendPolicy vault's ABI this package uses. */
export const ARC_VAULT_ABI = ${JSON.stringify(trustGuardVaultAbi(), null, 2)} as const
`
}
