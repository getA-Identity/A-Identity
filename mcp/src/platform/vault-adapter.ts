/**
 * Which adapter speaks to THIS agent's vault.
 *
 * `platform/vault.ts` used to import every policy write straight from `arc-contracts.js`,
 * which is the EVM adapter bound to the Arc descriptor. That was true for as long as a
 * vault could only be on Arc. It stopped being true when an AgentSpendPolicy was deployed
 * to Stellar pubnet and funded with real USDC, and the agent record already describes the
 * chain a vault lives on (`vaultChainCaip2`, and the `vaults[]` array beside it).
 *
 * Sent through the Arc adapter anyway, a Soroban contract id would fail somewhere further
 * down with a message about an address, which reads as a broken chain rather than a gap
 * here. So the choice of adapter is made once, in this file, from the vault's own chain.
 *
 * Two things have to be normalised for that choice to be invisible to the caller, and both
 * are places where the two chains genuinely disagree rather than merely differ in spelling:
 *
 *  1. AMOUNTS. The EVM adapter takes and returns USD; the Soroban one takes raw base units
 *     at the token's own precision, which is 7 on Stellar and 6 on every EVM chain we
 *     settle on. Converting in one place is what stops a 1 USDC cap from being pushed as
 *     100 USDC on a chain with an extra decimal.
 *  2. RESULT SHAPE. EVM writes answer `Prepared | Executed`, a boolean. Soroban writes
 *     answer a five-arm outcome, because `{executed: true}` was reporting a transaction
 *     that landed and FAILED as a success. Collapsing that back to a boolean would undo
 *     the fix, so the arms are mapped deliberately and `pending` is NOT called success:
 *     a submitted-but-unconfirmed policy write has not changed the policy yet.
 */
import { getChainById, CHAINS } from '../chains/index.js'
import type { ChainDescriptor } from '../chains/types.js'
import type { PlatformAgent } from './core.js'

/** The vault's limits, in the units the platform thinks in, whatever the chain thinks in. */
export type VaultPolicyView = {
  dailyCapUsd: number
  autoApproveUsd: number
  allowlistEnabled: boolean
  frozen: boolean
}

export type VaultWriteResult =
  | { ok: true; txHash?: string }
  /** `ownerGated` means we hold no key that may sign it, which is a different thing from
   *  the contract saying no, and the caller shows the two differently. */
  | { ok: false; reason: string; ownerGated?: boolean }

/**
 * The chain an agent's vault lives on.
 *
 * A row written before `vaultChainCaip2` existed is Arc, and that is an observation rather
 * than a guess: `provisionAgentVault` bound the Arc adapter unconditionally, so no other
 * vault could have been created. `migrateAgentVaults` in core.ts fills the field in on the
 * same reasoning and marks those rows `source: 'migrated'`.
 */
export function vaultChainFor(agent: PlatformAgent): ChainDescriptor | null {
  if (!agent.vaultChainCaip2) return CHAINS.find((c) => c.id === 'arc') ?? null
  return CHAINS.find((c) => c.caip2 === agent.vaultChainCaip2) ?? null
}

/** True when this vault is one the EVM adapter can speak to. */
export function isEvmVault(agent: PlatformAgent): boolean {
  return vaultChainFor(agent)?.ecosystem === 'evm'
}

/** Base units for a USD amount on this chain's settlement token. Stellar is 7 decimals,
 *  every EVM stablecoin we settle in is 6, and getting that wrong is a 10x mispricing. */
export function toRaw(chain: ChainDescriptor, usd: number): bigint {
  const decimals = chain.settlementTokens?.[0]?.decimals ?? chain.usdcDecimals ?? 6
  return BigInt(Math.round(usd * 10 ** decimals))
}

export function fromRaw(chain: ChainDescriptor, raw: string | bigint): number {
  const decimals = chain.settlementTokens?.[0]?.decimals ?? chain.usdcDecimals ?? 6
  return Number(BigInt(raw)) / 10 ** decimals
}

/**
 * Map a Soroban outcome onto the caller's boolean, without losing what it said.
 *
 * `pending` is deliberately NOT success. The transaction is submitted and may land, but
 * the policy on the ledger is still the old one until it does, and telling an owner their
 * limit is in force when it is in flight is the failure this whole module exists to avoid.
 */
export function fromCallOutcome(r: { outcome: string; reason?: string; txHash?: string; error?: string }): VaultWriteResult {
  switch (r.outcome) {
    case 'settled':
      return { ok: true, ...(r.txHash ? { txHash: r.txHash } : {}) }
    case 'prepared':
      return { ok: false, ownerGated: true, reason: r.reason ?? 'No signer for this chain, so nothing was submitted.' }
    case 'refused':
      return { ok: false, reason: `The vault refused it in simulation: ${r.error ?? r.reason ?? 'no reason given'}` }
    case 'failed':
      return { ok: false, reason: `The transaction landed and failed: ${r.error ?? r.reason ?? 'no reason given'}` }
    case 'pending':
      return {
        ok: false,
        reason:
          `Submitted (${r.txHash ?? 'no hash'}) but not yet in a ledger, so the on-chain policy is ` +
          'still the previous one. Re-read the vault before treating the new limits as in force.',
      }
    default:
      return { ok: false, reason: `Unrecognised outcome from the Stellar adapter: ${r.outcome}` }
  }
}

/** The Soroban adapter, built lazily so a missing Stellar SDK never costs an EVM deploy. */
async function stellar(chain: ChainDescriptor) {
  const { createStellarAdapter } = await import('../chains/stellar/adapter.js')
  return createStellarAdapter(chain)
}

/** The one refusal every vault write shares on a chain with no vault port yet. The
 *  AgentSpendPolicy exists in Solidity and Rust; the Algorand (AVM) port is planned and
 *  routing its calls into the Soroban adapter would produce StrKey errors wearing the
 *  wrong chain's name. */
function noVaultPortYet(chain: ChainDescriptor): VaultWriteResult {
  return {
    ok: false,
    reason: `No AgentSpendPolicy vault is deployed on ${chain.name} yet; the ${chain.ecosystem} port is planned and nothing was submitted.`,
  }
}

// ── the surface platform/vault.ts uses ───────────────────────────────────────────

export async function readVaultPolicy(agent: PlatformAgent, vault: string): Promise<VaultPolicyView | null> {
  const chain = vaultChainFor(agent)
  if (!chain) return null
  if (chain.ecosystem === 'algorand') return null
  if (chain.ecosystem === 'evm') {
    const { readPolicyVault } = await import('../arc-contracts.js')
    const v = await readPolicyVault(vault)
    return {
      dailyCapUsd: v.dailyCapUsd,
      autoApproveUsd: v.autoApproveUsd,
      allowlistEnabled: v.allowlistEnabled,
      frozen: v.frozen,
    }
  }
  const a = await stellar(chain)
  const v = await a.readVault(vault)
  return {
    dailyCapUsd: fromRaw(chain, v.dailyCapRaw),
    autoApproveUsd: fromRaw(chain, v.autoApproveMaxRaw),
    allowlistEnabled: v.allowlistEnabled,
    frozen: v.frozen,
  }
}

export async function writeVaultPolicy(
  agent: PlatformAgent,
  vault: string,
  want: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean },
): Promise<VaultWriteResult> {
  const chain = vaultChainFor(agent)
  if (!chain) return { ok: false, reason: `Unknown vault chain ${agent.vaultChainCaip2}` }
  if (chain.ecosystem === 'algorand') return noVaultPortYet(chain)
  if (chain.ecosystem === 'evm') {
    const { policySetPolicy } = await import('../arc-contracts.js')
    const r = await policySetPolicy(vault, want)
    return r.executed ? { ok: true, txHash: r.txHash } : { ok: false, reason: r.reason }
  }
  const a = await stellar(chain)
  return fromCallOutcome(
    await a.policySetPolicy(vault, toRaw(chain, want.dailyCapUsd), toRaw(chain, want.autoApproveUsd), want.allowlistEnabled),
  )
}

export async function writeVaultFrozen(agent: PlatformAgent, vault: string, frozen: boolean): Promise<VaultWriteResult> {
  const chain = vaultChainFor(agent)
  if (!chain) return { ok: false, reason: `Unknown vault chain ${agent.vaultChainCaip2}` }
  if (chain.ecosystem === 'algorand') return noVaultPortYet(chain)
  if (chain.ecosystem === 'evm') {
    const { policySetFrozen } = await import('../arc-contracts.js')
    const r = await policySetFrozen(vault, frozen)
    return r.executed ? { ok: true, txHash: r.txHash } : { ok: false, reason: r.reason }
  }
  const a = await stellar(chain)
  return fromCallOutcome(await a.policySetFrozen(vault, frozen))
}

export async function writeVaultAllowed(
  agent: PlatformAgent,
  vault: string,
  payee: string,
  allowed: boolean,
): Promise<VaultWriteResult> {
  const chain = vaultChainFor(agent)
  if (!chain) return { ok: false, reason: `Unknown vault chain ${agent.vaultChainCaip2}` }
  if (chain.ecosystem === 'algorand') return noVaultPortYet(chain)
  if (chain.ecosystem === 'evm') {
    const { policySetAllowed } = await import('../arc-contracts.js')
    const r = await policySetAllowed(vault, payee, allowed)
    return r.executed ? { ok: true, txHash: r.txHash } : { ok: false, reason: r.reason }
  }
  const a = await stellar(chain)
  return fromCallOutcome(await a.policySetAllowed(vault, payee, allowed))
}

/** The address shape this chain's vault allowlist accepts. An EVM vault takes 0x
 *  addresses; a Soroban one takes StrKey, and mirroring one onto the other silently
 *  writes an entry that can never match a payee. */
export function allowlistEntriesFor(chain: ChainDescriptor, entries: string[]): string[] {
  switch (chain.ecosystem) {
    case 'evm':
      return entries.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))
    case 'algorand':
      return entries.filter((x) => /^[A-Z2-7]{58}$/.test(x))
    default:
      return entries.filter((x) => /^[GC][A-Z2-7]{55}$/.test(x))
  }
}

export { getChainById }
