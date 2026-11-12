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
import { getChainById, CHAINS, addressUrl, isNearAccountId } from '../chains/index.js'
import type { BroadcastHooks, ChainDescriptor, VaultResult } from '../chains/types.js'
import type { PlatformAgent } from './core.js'

/**
 * The vault's limits, in the units the platform thinks in, whatever the chain thinks in.
 *
 * The first four fields are the original contract and every existing caller reads them.
 * The rest are OPTIONAL and additive: the EVM adapter has always returned them and this
 * view threw them away, which is why `platform/instructions.ts` could not label a Stellar
 * settlement `session-key` (the expiry was read and then dropped one layer above the
 * place that needed it). Optional rather than required because a chain with no vault port
 * answers null for the whole view, and a future one may answer only part of it.
 */
export type VaultPolicyView = {
  dailyCapUsd: number
  autoApproveUsd: number
  allowlistEnabled: boolean
  frozen: boolean
  spentTodayUsd?: number
  balanceUsd?: number
  /** UNIX seconds. 0 means NO time bound at all, which is the opposite of a session key. */
  sessionKeyExpiry?: number
  sessionKeyExpired?: boolean
  owner?: string
  operator?: string
  explorer?: string
}

export type VaultWriteResult =
  | { ok: true; txHash?: string; explorerUrl?: string }
  /** `ownerGated` means we hold no key that may sign it, which is a different thing from
   *  the contract saying no, and the caller shows the two differently. */
  | { ok: false; reason: string; ownerGated?: boolean; explorerUrl?: string }

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
export function fromCallOutcome(r: { outcome: string; reason?: string; txHash?: string; error?: string; explorerUrl?: string }): VaultWriteResult {
  switch (r.outcome) {
    case 'settled':
      return { ok: true, ...(r.txHash ? { txHash: r.txHash } : {}), ...(r.explorerUrl ? { explorerUrl: r.explorerUrl } : {}) }
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

/** True for a chain whose vaults this platform cannot speak to: no adapter here, so every
 *  vault call refuses before it reaches the Soroban adapter, the only non-EVM one there is. */
function hasNoVaultPort(chain: ChainDescriptor): boolean {
  return chain.ecosystem === 'algorand' || chain.ecosystem === 'near'
}

/** The one refusal every vault write shares on a chain with no vault port yet. The
 *  AgentSpendPolicy exists in Solidity and Rust; the Algorand (AVM) port is planned and
 *  routing its calls into the Soroban adapter would produce StrKey errors wearing the
 *  wrong chain's name. NEAR is refused the same way, in its own words: no NEAR adapter is
 *  wired into the platform, and the sentence does not depend on what is deployed there. */
function noVaultPortYet(chain: ChainDescriptor): VaultWriteResult {
  if (chain.ecosystem === 'near') {
    return {
      ok: false,
      reason: `The platform does not operate vaults on ${chain.name}: no NEAR vault adapter is wired here, so nothing was submitted.`,
    }
  }
  return {
    ok: false,
    reason: `No AgentSpendPolicy vault is deployed on ${chain.name} yet; the ${chain.ecosystem} port is planned and nothing was submitted.`,
  }
}

// ── the surface platform/vault.ts uses ───────────────────────────────────────────

export async function readVaultPolicy(agent: PlatformAgent, vault: string): Promise<VaultPolicyView | null> {
  const chain = vaultChainFor(agent)
  if (!chain) return null
  if (hasNoVaultPort(chain)) return null
  if (chain.ecosystem === 'evm') {
    const { readPolicyVault } = await import('../arc-contracts.js')
    const v = await readPolicyVault(vault)
    return {
      dailyCapUsd: v.dailyCapUsd,
      autoApproveUsd: v.autoApproveUsd,
      allowlistEnabled: v.allowlistEnabled,
      frozen: v.frozen,
      // Already computed by the EVM adapter and previously discarded here. Passing them
      // through is what lets one caller (the session-key label) ask one question of one
      // view whatever chain the vault is on.
      spentTodayUsd: v.spentTodayUsd,
      balanceUsd: v.balanceUsd,
      sessionKeyExpiry: v.sessionKeyExpiry,
      sessionKeyExpired: v.sessionKeyExpired,
      owner: v.owner,
      operator: v.operator,
      explorer: v.explorer,
    }
  }
  const a = await stellar(chain)
  const v = await a.readVault(vault)
  const expiry = Number(v.sessionKeyExpiry)
  return {
    dailyCapUsd: fromRaw(chain, v.dailyCapRaw),
    autoApproveUsd: fromRaw(chain, v.autoApproveMaxRaw),
    allowlistEnabled: v.allowlistEnabled,
    frozen: v.frozen,
    spentTodayUsd: fromRaw(chain, v.spentTodayRaw),
    balanceUsd: fromRaw(chain, v.balanceRaw),
    // Same meaning as the EVM side, including the one that trips people up: 0 is NO bound.
    sessionKeyExpiry: Number.isFinite(expiry) ? expiry : 0,
    sessionKeyExpired: Number.isFinite(expiry) && expiry !== 0 && Math.floor(Date.now() / 1000) > expiry,
    owner: v.owner,
    operator: v.operator,
    explorer: addressUrl(chain, vault),
  }
}

export async function writeVaultPolicy(
  agent: PlatformAgent,
  vault: string,
  want: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean },
): Promise<VaultWriteResult> {
  const chain = vaultChainFor(agent)
  if (!chain) return { ok: false, reason: `Unknown vault chain ${agent.vaultChainCaip2}` }
  if (hasNoVaultPort(chain)) return noVaultPortYet(chain)
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
  if (hasNoVaultPort(chain)) return noVaultPortYet(chain)
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
  if (hasNoVaultPort(chain)) return noVaultPortYet(chain)
  if (chain.ecosystem === 'evm') {
    const { policySetAllowed } = await import('../arc-contracts.js')
    const r = await policySetAllowed(vault, payee, allowed)
    return r.executed ? { ok: true, txHash: r.txHash } : { ok: false, reason: r.reason }
  }
  const a = await stellar(chain)
  return fromCallOutcome(await a.policySetAllowed(vault, payee, allowed))
}

/**
 * Set the session key's expiry on whichever chain this vault lives on.
 *
 * The missing write. `platform/vault.ts` called the Arc adapter's `policySetSessionExpiry`
 * unconditionally, so granting a session key to an agent whose vault is on Soroban sent a
 * C... contract id into an EVM adapter and failed with a message about an address. The
 * grant is the ONE owner control the product offers as a routine action, so it is the one
 * that most needed to know which chain it was on.
 *
 * Note what the Stellar arm can and cannot do. `set_session_key_expiry` calls
 * `owner.require_auth()`, the vault's owner is the human's own account by construction
 * (the contract refuses owner == operator), and we hold only the operator key. So this
 * arm returns `prepared` in the ordinary case, which `fromCallOutcome` reports as
 * `ownerGated`. The caller turns that into an owner-signed transaction through
 * /api/stellar/vault/prepare rather than pretending the grant happened.
 */
export async function writeVaultSessionExpiry(
  agent: PlatformAgent,
  vault: string,
  expiryUnix: number,
): Promise<VaultWriteResult> {
  const chain = vaultChainFor(agent)
  if (!chain) return { ok: false, reason: `Unknown vault chain ${agent.vaultChainCaip2}` }
  if (hasNoVaultPort(chain)) return noVaultPortYet(chain)
  // Same meaning on both chains: 0 is no time bound, so neither a 0 nor a value that floors or clamps to it is sent.
  const expiry = Math.floor(expiryUnix)
  if (!(expiry >= 1)) return { ok: false, reason: 'An expiry of 0 means the agent key never expires, so it is not written. To revoke, ask for a revoke.' }
  if (chain.ecosystem === 'evm') {
    const { policySetSessionExpiry } = await import('../arc-contracts.js')
    const r = await policySetSessionExpiry(vault, expiry)
    // Deliberately NOT flagged ownerGated on a missing key: on this chain the caller
    // distinguishes "the contract said NotOwner" from "no key at all" by the reason, and
    // it did so before this function existed. Widening the flag here would change what the
    // console shows for an unconfigured signer.
    return r.executed ? { ok: true, txHash: r.txHash, explorerUrl: r.explorerUrl } : { ok: false, reason: r.reason }
  }
  const a = await stellar(chain)
  const r = await a.policySetSessionExpiry(vault, BigInt(expiry))
  return fromCallOutcome(r)
}

/**
 * Pay out of the vault, on whichever chain it lives on, in the EVM shape the caller uses.
 *
 * `platform/instructions.ts` branches on `Prepared | Reverted | Executed` and matches
 * revert reasons against the frozen `VAULT_POLICY_ERRORS` name set. Returning the Soroban
 * five-arm outcome there would have meant rewriting that ladder for one chain, so the arms
 * are mapped here instead, once, where the reasoning can be written down:
 *
 *  - `settled` is the only success, and it carries the receipt.
 *  - `refused` with one of OUR typed codes is a POLICY refusal, so it is reported with the
 *    error's NAME (DailyCapExceeded, SessionKeyExpired, ...) because that is what the
 *    caller matches on and what decides which human action is needed. A code that came out
 *    of the token instead propagates with its own number and is NOT named, so a missing
 *    trustline can never be read as a cap refusal.
 *  - `failed` is reverted too: it landed, it moved nothing, and nobody may call it success.
 *  - `pending` and `prepared` are neither executed nor reverted. That distinction is what
 *    lets the caller refuse to fall through to a different settlement rail, which on
 *    Stellar would mean paying a G... payee from an EVM signer.
 */
export async function payFromVault(
  agent: PlatformAgent,
  vault: string,
  to: string,
  amountUsd: number,
  byOwner: boolean,
  hooks?: BroadcastHooks,
): Promise<VaultResult> {
  const chain = vaultChainFor(agent)
  if (!chain) {
    return { executed: false, reverted: true, reason: `Unknown vault chain ${agent.vaultChainCaip2}` }
  }
  if (hasNoVaultPort(chain)) {
    const no = noVaultPortYet(chain)
    return { executed: false, reverted: true, reason: no.ok ? '' : no.reason }
  }
  if (chain.ecosystem === 'evm') {
    const { policyPay, policyOwnerPay } = await import('../arc-contracts.js')
    return byOwner ? policyOwnerPay(vault, to, amountUsd, undefined, hooks) : policyPay(vault, to, amountUsd, undefined, hooks)
  }

  const a = await stellar(chain)
  const { errorName } = await import('../chains/stellar/adapter.js')
  const raw = toRaw(chain, amountUsd)
  const r = byOwner ? await a.policyOwnerPay(vault, to, raw, undefined, hooks) : await a.policyPay(vault, to, raw, undefined, hooks)
  return vaultResultFromOutcome(r, errorName)
}

/**
 * One look at a settlement sent earlier, on the chain this agent's vault is on.
 *
 * Only Stellar has a reader of its own here, and today that covers every hash this can be
 * asked about. A vault is recorded on an agent only when one was deployed on Arc or Stellar
 * (platform/vault.ts), and a chain with no vault port (Algorand, NEAR) refuses every vault
 * call before anything is broadcast. So every other hash held for an agent was sent by the
 * Arc rails, and Arc's reader is the right one. Before platform/vault.ts may record a NEAR
 * vault, the NEAR vault work must add a NEAR reader here, and a stop like the Stellar one in
 * platform/instructions.ts so that vault's payments never fall through to the Arc rails;
 * otherwise a NEAR hash would be asked of Arc.
 */
export async function vaultReceiptStatus(agent: PlatformAgent | undefined, hash: string, held?: { nonce?: number; from?: string }) {
  const chain = agent?.vaultAddress ? vaultChainFor(agent) : null
  if (chain?.ecosystem === 'stellar') return (await stellar(chain)).receiptStatus(hash)
  const { receiptStatusOnchain } = await import('../arc-contracts.js')
  return receiptStatusOnchain(hash, undefined, held)
}

/**
 * The five Soroban arms, mapped onto the three the settlement ladder branches on.
 *
 * Pure and exported so each arm is pinned by a test rather than by a live vault. The name
 * resolver is injected for one reason: `errorName` lives beside the Stellar SDK, and
 * importing it eagerly here would pull that SDK into every EVM settlement.
 */
export function vaultResultFromOutcome(
  r: {
    outcome: string
    reason?: string
    txHash?: string
    explorerUrl?: string
    contractErrorCode?: number
    contractErrorIsOurs?: boolean
  },
  nameOf: (code: number | undefined) => string | undefined,
): VaultResult {
  switch (r.outcome) {
    case 'settled':
      return { executed: true, txHash: r.txHash ?? '', explorerUrl: r.explorerUrl ?? '' }
    case 'refused': {
      // A code the vault itself raised is a POLICY refusal and is reported by NAME, because
      // the name is what VAULT_POLICY_ERRORS matches and what decides which human action is
      // needed. A code that propagated out of the token keeps its prose reason, so a missing
      // trustline can never be read as a cap refusal.
      const named = r.contractErrorIsOurs ? nameOf(r.contractErrorCode) : undefined
      return { executed: false, reverted: true, reason: named ?? r.reason ?? 'refused with no reason given' }
    }
    case 'failed':
      return { executed: false, reverted: true, reason: r.reason ?? 'the transaction landed and failed' }
    case 'pending':
      // Neither executed nor reverted, and that is the whole point: it may still land, so
      // the caller must not settle it again on another rail and must not call it failed. With
      // a hash it is the same arm an EVM payment with no receipt takes, so the hash is kept and
      // read before anything else is sent.
      if (r.txHash) {
        return {
          executed: false,
          reverted: false,
          unconfirmed: true,
          txHash: r.txHash,
          explorerUrl: r.explorerUrl ?? '',
          reason: `pending: ${r.txHash}. ${r.reason ?? ''}`.trim(),
        }
      }
      return { executed: false, reverted: false, reason: `pending: no hash. ${r.reason ?? ''}`.trim() }
    default:
      return { executed: false, reverted: false, reason: r.reason ?? `unrecognised outcome ${r.outcome}` }
  }
}

/** The account the server would operate a Stellar vault as, or null when it holds no key
 *  for this network. Public data: an address, never a secret. */
export async function stellarOperatorAddress(chain: ChainDescriptor): Promise<string | null> {
  if (chain.ecosystem !== 'stellar') return null
  const { stellarSignerAddress } = await import('../chains/stellar/client.js')
  return stellarSignerAddress(chain)
}

/** Deploy a fresh AgentSpendPolicy on a Stellar chain. Prepared-or-executed, like every
 *  other write here: without the chain signer it returns the exact constructor call. */
export async function deployStellarVault(
  chain: ChainDescriptor,
  input: { owner: string; operator: string; token: string; dailyCapUsd: number; autoApproveUsd: number },
) {
  const a = await stellar(chain)
  return a.deployVault({
    owner: input.owner,
    operator: input.operator,
    token: input.token,
    dailyCapRaw: toRaw(chain, input.dailyCapUsd),
    autoApproveMaxRaw: toRaw(chain, input.autoApproveUsd),
  })
}

/**
 * The expiry a revoke writes. Both vault contracts check the key with a strict rule, pay
 * reverts only once the chain time is greater than the expiry (`block.timestamp > expiry` on
 * EVM, the same comparison on Soroban). So an expiry of the current second leaves the key
 * valid until that second ends, and on a fast chain that is several blocks (Arc Studio review
 * finding F-02, in OLYMPIX_SUBMISSION.md). 0 cannot stand in either, because 0 means no time bound at all. 1 is the
 * smallest expiry that is already in the past on every chain, so the revoke holds from the
 * block that includes it.
 */
export const REVOKED_SESSION_EXPIRY = 1

/**
 * The expiry a grant, extend or revoke request asks for, or null when the request names
 * none. Pure, so the revoke rule is pinned by a test without a chain.
 */
export function sessionKeyExpiryFor(
  input: { durationHours?: number; expiryUnix?: number; revoke?: boolean },
  now: number,
): number | null {
  if (input.revoke) return REVOKED_SESSION_EXPIRY
  // 0, or anything that floors to it, would mean no time bound at all, so it names no expiry.
  if (typeof input.expiryUnix === 'number' && Number.isFinite(input.expiryUnix) && input.expiryUnix >= 1) return Math.floor(input.expiryUnix)
  if (typeof input.durationHours === 'number' && input.durationHours > 0) return now + Math.floor(input.durationHours * 3600)
  return null
}

/** Said when a permissions save holds a limit the vault would read as the opposite of what it means. */
export const ZERO_LIMIT_NOT_WRITTEN =
  'A limit of 0 stops spending in the server policy, but on the vault 0 means no limit, so it was not written to the vault, which keeps its current limits. To stop the agent on-chain, freeze the vault.'

/** Said when the vault's current policy could not be read, so a whole-policy write would be blind. */
export const VAULT_UNREAD_NOT_WRITTEN =
  "This vault's current policy could not be read, so its limits and allowlist setting were not changed. Save again to retry. The server policy is updated meanwhile."

/**
 * What a permissions save may write to a vault, from the saved permissions and the vault's live
 * policy. Pure, so the rules are pinned without a chain. setPolicy overwrites both caps and the
 * allowlist flag in one call, so:
 *   - a limit that is 0 in token units is not written: off-chain 0 means stop, on-chain 0 means no limit;
 *   - nothing is written over a policy that could not be read, except a freeze, which can only stop;
 *   - the flag goes off only when the off-chain list itself changed, so saving a cap cannot switch
 *     off an allowlist the owner turned on at the contract.
 */
export function vaultPolicyPlan(input: {
  permissions: { dailyCapUsd: number; autoApproveUnderUsd: number; payeeAllowlist: readonly unknown[]; frozen: boolean }
  live: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean; frozen: boolean } | null
  allowlistChanged: boolean
}) {
  const { permissions: p, live, allowlistChanged } = input
  const micro = (n: number) => Math.round(n * 1e6)
  const want = {
    dailyCapUsd: p.dailyCapUsd,
    autoApproveUsd: p.autoApproveUnderUsd,
    allowlistEnabled: p.payeeAllowlist.length > 0 || (!allowlistChanged && live?.allowlistEnabled === true),
    frozen: p.frozen,
  }
  const zeroLimit = micro(want.dailyCapUsd) < 1 || micro(want.autoApproveUsd) < 1
  const policyDrift =
    live !== null &&
    !zeroLimit &&
    (micro(live.dailyCapUsd) !== micro(want.dailyCapUsd) ||
      micro(live.autoApproveUsd) !== micro(want.autoApproveUsd) ||
      live.allowlistEnabled !== want.allowlistEnabled)
  return {
    want,
    zeroLimit,
    policyDrift,
    frozenDrift: live ? live.frozen !== want.frozen : want.frozen,
    notWritten: zeroLimit ? ZERO_LIMIT_NOT_WRITTEN : live === null ? VAULT_UNREAD_NOT_WRITTEN : null,
  }
}

/** The address shape this chain's vault allowlist accepts. An EVM vault takes 0x
 *  addresses; a Soroban one takes StrKey, and mirroring one onto the other silently
 *  writes an entry that can never match a payee. A NEAR payee is an account id, so only
 *  a valid one is kept: a checksummed 0x address is not one (NEAR ids are lowercase), and
 *  a lowercase one is kept because on NEAR it names that key's eth-implicit account.
 *  Exhaustive on purpose: a new ecosystem is a compile error here, not a silent default. */
export function allowlistEntriesFor(chain: ChainDescriptor, entries: string[]): string[] {
  switch (chain.ecosystem) {
    case 'evm':
      return entries.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))
    case 'algorand':
      return entries.filter((x) => /^[A-Z2-7]{58}$/.test(x))
    case 'near':
      return entries.filter((x) => isNearAccountId(x))
    case 'stellar':
      return entries.filter((x) => /^[GC][A-Z2-7]{55}$/.test(x))
  }
}

export { getChainById }
