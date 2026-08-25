/**
 * Agent enforcement rails: the on-chain AgentSpendPolicy vault, the Circle Agent
 * Wallet, and treasury auto-yield into USYC.
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import { state, save, ownsAgent, pushActivity, short, inFlightAgentOps, type PlatformAgent } from './core.js'
import {
  deployPolicyVault, payUsdcOnchain, readPolicyVault,
  policySetPolicy, policySetFrozen, policySetAllowed, policySetSessionExpiry,
} from '../arc-contracts.js'
import { ARC_CHAIN, addressUrl } from '../chains/index.js'
import { createAgentWallet, readCircleWallet } from '../circle-agent.js'
import { previewTreasury, startAutoYield, type TreasuryPreview, type TreasuryExecution } from '../treasury.js'

// ── on-chain policy vault ────────────────────────────────────────────────────────

/**
 * Provision an on-chain AgentSpendPolicy vault for an agent: deploy a contract
 * that enforces the agent's daily cap + auto-approve ceiling on Arc, and
 * optionally fund it with USDC. Once set, this agent's address payments settle
 * through the vault (chain-enforced), with the server engine as the pre-check.
 * Owner-only; env-gated behind ARC_SIGNER_KEY.
 */
export async function provisionAgentVault(
  agentId: string,
  opts: { fundUsd?: number; caller?: string; ownerAddress?: string } = {},
) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, opts.caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.vaultAddress) return { error: 'Agent already has an on-chain policy vault', vaultAddress: agent.vaultAddress }

  // Human owner of the vault = a REAL wallet distinct from the server signer/operator,
  // so freeze/override/withdraw are owner-gated on-chain. Prefer an explicit address,
  // then the caller when they signed in with a wallet (SIWE → subject is a 0x addr),
  // then the agent's own (browser-held) wallet. Falls back to the signer only if none.
  const isAddr = (s?: string): s is string => !!s && /^0x[0-9a-fA-F]{40}$/.test(s)
  const ownerAddress = isAddr(opts.ownerAddress)
    ? opts.ownerAddress
    : isAddr(opts.caller)
      ? opts.caller
      : isAddr(agent.walletAddress ?? undefined)
        ? (agent.walletAddress as string)
        : undefined

  // Require a REAL human/Safe owner distinct from the server operator. Without one the
  // vault would deploy with owner == operator (the signer), so on-chain freeze/withdraw
  // would not be human-controlled and a signer compromise could drain every vault. Refuse
  // rather than silently collapse the two roles.
  if (!ownerAddress) {
    return {
      error:
        'Provide an ownerAddress (a human/Safe wallet distinct from the server operator): ' +
        'sign in with a wallet, pass ownerAddress, or give the agent a wallet first. The vault ' +
        'owner (freeze/withdraw) must not be the same key that operates it.',
    }
  }

  const opKey = `vault:${agentId}`
  if (inFlightAgentOps.has(opKey)) return { error: 'A vault is already being provisioned for this agent' }
  inFlightAgentOps.add(opKey)
  try {
  const dep = await deployPolicyVault({
    owner: ownerAddress,
    dailyCapUsd: agent.permissions.dailyCapUsd,
    autoApproveUsd: agent.permissions.autoApproveUnderUsd,
  })
  if (!dep.executed) return { error: dep.reason }

  // The chain is recorded EXPLICITLY now, rather than being implied by the fact that this
  // function imports the Arc adapter. It is still Arc and only Arc: `deployPolicyVault`
  // binds the Arc descriptor, so recording anything else here would be a lie. What changes
  // is that a second chain becomes an added descriptor and an added row, not a hunt for
  // every place that assumed one.
  agent.vaultAddress = dep.vault
  agent.vaultChainCaip2 = ARC_CHAIN.caip2
  agent.vaultExplorer = addressUrl(ARC_CHAIN, dep.vault)
  agent.vaultOwner = dep.owner
  agent.vaultOperator = dep.operator
  agent.vaults = [
    ...(agent.vaults ?? []),
    {
      chainCaip2: ARC_CHAIN.caip2,
      address: dep.vault,
      explorer: agent.vaultExplorer,
      owner: dep.owner,
      operator: dep.operator,
      // We hold the deploy receipt for this one, so it is an observation rather than the
      // inference `migrateAgentVaults` writes.
      source: 'deployed',
    },
  ]
  const separated = dep.owner.toLowerCase() !== dep.operator.toLowerCase()
  pushActivity(
    agent,
    `On-chain policy vault deployed at ${short(dep.vault)} (tx ${short(dep.txHash)})` +
      (separated ? ` — human owner ${short(dep.owner)}, agent operator ${short(dep.operator)}` : ''),
  )

  let funding: unknown = null
  if (opts.fundUsd && opts.fundUsd > 0) {
    const f = await payUsdcOnchain(dep.vault, opts.fundUsd)
    funding = f.executed
      ? { amountUsd: opts.fundUsd, txHash: f.txHash, explorerUrl: f.explorerUrl }
      : { error: f.reason }
    if (f.executed) pushActivity(agent, `Funded vault with ${opts.fundUsd} USDC (tx ${short(f.txHash)})`)
  }
  save(state)
  return {
    vaultAddress: agent.vaultAddress,
    vaultExplorer: agent.vaultExplorer,
    owner: dep.owner,
    operator: dep.operator,
    ownerOperatorSeparated: separated,
    deployTx: dep.txHash,
    deployExplorer: dep.explorerUrl,
    funding,
  }
  } finally {
    inFlightAgentOps.delete(opKey)
  }
}

/** Read an agent's live on-chain vault policy + balance (no key needed). */
/** Circle's CLI names chains its own way; Arc Testnet is the one this product runs on. */
const CIRCLE_CLI_CHAIN = 'ARC-TESTNET'

/**
 * The agent's limits, compiled into the Circle CLI commands that reproduce them at
 * Circle's own wallet-policy layer. Read-only and generative: we never run the CLI,
 * because an Agent Wallet is user-controlled and applying a policy needs the owner's
 * interactive confirmation. See `circle-cli.ts` for why that matters.
 */
export async function getAgentCirclePolicyPlan(agentId: string, email?: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  const address = agent.walletAddress ?? agent.vaultAddress
  if (!address) return { error: 'This agent has no wallet address yet.' }
  const { compilePolicyPlan, bootstrapCommands } = await import('../circle-cli.js')
  return {
    bootstrap: bootstrapCommands(email),
    ...compilePolicyPlan({
      address,
      chain: CIRCLE_CLI_CHAIN,
      permissions: {
        dailyCapUsd: agent.permissions.dailyCapUsd,
        autoApproveUnderUsd: agent.permissions.autoApproveUnderUsd,
        payeeAllowlist: agent.permissions.payeeAllowlist,
        frozen: agent.permissions.frozen,
      },
      email,
    }),
  }
}

export async function getAgentVault(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!agent.vaultAddress) return { vaultAddress: null }
  const live = await readPolicyVault(agent.vaultAddress)
  return { vaultAddress: agent.vaultAddress, ...live }
}

/**
 * Grant / extend / revoke the agent's on-chain SESSION KEY: set the UNIX time after which
 * the agent's `pay` reverts (SessionKeyExpired). Owner-only on-chain; the server can sign it
 * only when it is the vault owner (owner==operator) — otherwise it's ownerGated (the human
 * signs from their own wallet), mirroring syncVaultPolicy. Revoke sets the expiry to now.
 */
export async function grantAgentSessionKey(
  agentId: string,
  input: { durationHours?: number; expiryUnix?: number; revoke?: boolean },
  caller?: string,
): Promise<{ granted: boolean; reason?: string; ownerGated?: boolean; sessionKeyExpiry?: number; expiresInSeconds?: number; txHash?: string; explorerUrl?: string }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { granted: false, reason: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { granted: false, reason: 'Forbidden: not the agent owner' }
  if (!agent.vaultAddress) return { granted: false, reason: 'Agent has no on-chain vault. Provision a vault first.' }

  const now = Math.floor(Date.now() / 1000)
  let expiry: number
  if (input.revoke) expiry = now
  else if (typeof input.expiryUnix === 'number' && input.expiryUnix >= 0) expiry = Math.floor(input.expiryUnix)
  else if (typeof input.durationHours === 'number' && input.durationHours > 0) expiry = now + Math.floor(input.durationHours * 3600)
  else return { granted: false, reason: 'Provide durationHours (>0), an expiryUnix, or revoke:true.' }

  const res = await policySetSessionExpiry(agent.vaultAddress, expiry)
  if (res.executed) {
    pushActivity(agent, input.revoke
      ? `Session key revoked on-chain (tx ${short(res.txHash)})`
      : `Session key granted, expires ${new Date(expiry * 1000).toISOString()} (tx ${short(res.txHash)})`)
    save(state)
    return { granted: true, sessionKeyExpiry: expiry, expiresInSeconds: input.revoke ? 0 : Math.max(0, expiry - now), txHash: res.txHash, explorerUrl: res.explorerUrl }
  }
  if (res.reverted && res.reason === 'NotOwner') {
    return { granted: false, ownerGated: true, sessionKeyExpiry: expiry, reason: 'The vault owner must sign this from their own wallet (owner ≠ operator).' }
  }
  return { granted: false, reason: res.reverted ? res.reason : (res.reason ?? 'no signer configured') }
}

export type VaultSyncResult = {
  synced: boolean
  reason?: string
  /** True when the on-chain change is owner-signed and the server can't sign it. */
  ownerGated?: boolean
  txs?: { setPolicy?: string; setFrozen?: string }
  /** The limits we wanted on-chain, so an owner can push them from their own wallet. */
  want?: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean; frozen: boolean }
  note?: string
}

/** USDC micro-units, for exact (float-safe) on-chain vs off-chain comparisons. */
const micro = (n: number) => Math.round(n * 1e6)

/**
 * Push an agent's off-chain permissions onto its on-chain AgentSpendPolicy vault, so a
 * limit changed in the UI actually re-enforces on Arc — not only in the server pre-check.
 * setPolicy / setFrozen / setAllowed are owner-only; the server signer can sign them ONLY
 * when it is the vault owner (owner==operator). With the intended owner≠operator separation
 * the human owner must sign the change from their own wallet, so we say that plainly (and
 * return the target limits) instead of letting the chain-enforced policy silently drift from
 * the UI. Diffs against the live on-chain state first, so a change to off-chain-only fields
 * (e.g. agent-to-human) never spends gas. Best-effort: a failure never undoes the off-chain
 * update that already happened.
 */
export async function syncVaultPolicy(agent: PlatformAgent): Promise<VaultSyncResult> {
  const vault = agent.vaultAddress
  if (!vault) return { synced: false, reason: 'Agent has no on-chain vault' }
  const p = agent.permissions
  const want = {
    dailyCapUsd: p.dailyCapUsd,
    autoApproveUsd: p.autoApproveUnderUsd,
    allowlistEnabled: p.payeeAllowlist.length > 0,
    frozen: p.frozen,
  }

  // Only write what actually changed on-chain. A read never needs a key.
  let live: Awaited<ReturnType<typeof readPolicyVault>> | null = null
  try { live = await readPolicyVault(vault) } catch { live = null }
  const policyDrift =
    !live ||
    micro(live.dailyCapUsd) !== micro(want.dailyCapUsd) ||
    micro(live.autoApproveUsd) !== micro(want.autoApproveUsd) ||
    live.allowlistEnabled !== want.allowlistEnabled
  const frozenDrift = !live || live.frozen !== want.frozen
  if (!policyDrift && !frozenDrift) return { synced: true, txs: {}, note: 'On-chain vault already matches these limits.' }

  // Owner-gated on-chain: the server can sign owner calls only when owner==operator.
  const serverIsOwner =
    !agent.vaultOwner || !agent.vaultOperator ||
    agent.vaultOwner.toLowerCase() === agent.vaultOperator.toLowerCase()
  if (!serverIsOwner) {
    return {
      synced: false,
      ownerGated: true,
      want,
      reason:
        'On-chain vault limits are owner-signed and this vault is owned by your own wallet ' +
        '(owner≠operator by design). Re-sign setPolicy from the owner wallet to push these limits ' +
        'on-chain; the server holds only the operator key. Off-chain policy is updated meanwhile.',
    }
  }

  try {
    const txs: { setPolicy?: string; setFrozen?: string } = {}
    if (policyDrift) {
      const sp = await policySetPolicy(vault, {
        dailyCapUsd: want.dailyCapUsd, autoApproveUsd: want.autoApproveUsd, allowlistEnabled: want.allowlistEnabled,
      })
      if (!sp.executed) return { synced: false, reason: `Vault setPolicy failed: ${sp.reason}` }
      txs.setPolicy = sp.txHash
    }
    if (frozenDrift) {
      const sf = await policySetFrozen(vault, want.frozen)
      if (sf.executed) txs.setFrozen = sf.txHash
    }
    // Mirror raw-address allowlist entries onto the vault, in BOTH directions. The chain's
    // allowed set is not enumerable, so `vaultMirroredPayees` is our record of what we
    // wrote; a payee dropped from the off-chain list is revoked on-chain rather than left
    // allowed forever. Best-effort per entry, and the record only advances for the writes
    // that actually landed, so a failed revoke is retried on the next sync instead of being
    // forgotten. `agent://` payees are not mirrored: the vault only understands addresses.
    const wantPayees = p.payeeAllowlist.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))
    const mirrored = agent.vaultMirroredPayees ?? []
    const key = (x: string) => x.toLowerCase()
    const wantKeys = new Set(wantPayees.map(key))
    const stillMirrored = mirrored.filter((addr) => wantKeys.has(key(addr)))
    for (const addr of mirrored.filter((addr) => !wantKeys.has(key(addr)))) {
      const ok = await policySetAllowed(vault, addr, false).then(() => true).catch(() => false)
      if (!ok) stillMirrored.push(addr) // could not revoke: keep it on the books and retry
    }
    const mirroredKeys = new Set(mirrored.map(key))
    for (const addr of wantPayees.filter((addr) => !mirroredKeys.has(key(addr)))) {
      const ok = await policySetAllowed(vault, addr, true).then(() => true).catch(() => false)
      if (ok) stillMirrored.push(addr)
    }
    agent.vaultMirroredPayees = stillMirrored
    pushActivity(
      agent,
      `On-chain vault policy synced (cap $${want.dailyCapUsd}, ceiling $${want.autoApproveUsd}${want.frozen ? ', frozen' : ''})`,
    )
    return { synced: true, txs }
  } catch (e) {
    return { synced: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── Circle Agent Wallet (hosted, wallet-layer enforcement) ───────────────────────

/**
 * Provision a Circle Agent Wallet (Developer-Controlled EOA on ARC-TESTNET) for an
 * agent — the second, hosted enforcement layer alongside the on-chain vault. Once set,
 * this agent's address payments can settle THROUGH Circle, whose hosted policy engine
 * screens each transfer at the wallet layer (sanctions / allow-block / freeze). Owner-
 * only; credential-gated behind CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (no-op without).
 */
export async function provisionCircleWallet(
  agentId: string,
  opts: { fund?: boolean; caller?: string } = {},
) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, opts.caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.circleWalletId)
    return { error: 'Agent already has a Circle Agent Wallet', circleWalletId: agent.circleWalletId }

  const res = await createAgentWallet(
    { name: agent.name, refId: agent.id, fund: opts.fund ?? true },
    process.env,
  )
  if (!res.provisioned) return { error: res.reason }

  agent.circleWalletId = res.walletId
  agent.circleWalletAddress = res.walletAddress
  agent.circleWalletExplorer = res.explorerUrl
  pushActivity(agent, `Circle Agent Wallet provisioned on Arc: ${short(res.walletAddress)}`)
  save(state)
  return {
    circleWalletId: res.walletId,
    circleWalletAddress: res.walletAddress,
    circleWalletExplorer: res.explorerUrl,
    blockchain: res.blockchain,
    funded: res.funded,
  }
}

/** Read an agent's live Circle Agent Wallet state + balances (needs creds). */
export async function getAgentCircleWallet(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!agent.circleWalletId) return { circleWalletId: null }
  const live = await readCircleWallet(agent.circleWalletId)
  return { circleWalletId: agent.circleWalletId, circleWalletAddress: agent.circleWalletAddress, ...live }
}

// ── treasury: idle-balance auto-yield into USYC (Circle's yield-bearing token) ────

/** Default working-capital cap: idle balance above this is what auto-yield would deploy. */
const DEFAULT_YIELD_CAP_USD = 25

/**
 * Live treasury view for an agent: real multi-asset balances (USDC/EURC/USYC) read
 * from Arc, the deployable idle amount above the cap, and the projected USYC earnings
 * the owner reviews before authorizing. Read-only, no key. Uses the saved cap if the
 * owner has one, else the query cap, else the default.
 */
export async function getAgentTreasury(
  agentId: string,
  capUsd?: number,
): Promise<{ error: string } | (TreasuryPreview & { autoYieldEnabled: boolean; authorizedAt?: string })> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  // The agent's idle stablecoin lives in its own wallet, or in its Circle Agent Wallet
  // when that's the funded one. Read wherever the balance actually is.
  const address = agent.walletAddress ?? agent.circleWalletAddress
  if (!address) return { error: 'Agent has no wallet yet; create one or provision a Circle wallet first' }
  const cap = capUsd ?? agent.treasury?.capUsd ?? DEFAULT_YIELD_CAP_USD
  const preview = await previewTreasury(address, cap)
  return { ...preview, autoYieldEnabled: agent.treasury?.autoYieldEnabled ?? false, authorizedAt: agent.treasury?.authorizedAt }
}

/**
 * Owner authorizes auto-yield at a working-capital cap: persists the authorization
 * (enabled + cap) and returns the on-chain USYC deployment plan. The USDC->USYC mint is
 * gated on USYC allowlisting (like every other write here); the authorization + cap are
 * real state either way. Owner-only.
 */
export async function startAgentAutoYield(
  agentId: string,
  capUsd: number,
  caller?: string,
): Promise<{ error: string } | { treasury: PlatformAgent['treasury']; execution: TreasuryExecution }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  const address = agent.walletAddress ?? agent.circleWalletAddress
  if (!address) return { error: 'Agent has no wallet yet; create one or provision a Circle wallet first' }
  const cap = Math.max(0, capUsd)

  const execution = await startAutoYield(address, cap)
  agent.treasury = { autoYieldEnabled: true, capUsd: cap, authorizedAt: new Date().toISOString() }
  pushActivity(
    agent,
    `Auto-yield authorized: idle over $${cap} earmarked for USYC` +
      (execution.deployableUsd > 0 ? ` (~$${execution.projection.monthlyUsd}/mo projected on $${execution.deployableUsd})` : ''),
  )
  save(state)
  return { treasury: agent.treasury, execution }
}

/** Owner turns auto-yield off (leaves any USYC position untouched; just stops earmarking). */
export function stopAgentAutoYield(agentId: string, caller?: string): { error: string } | { treasury: PlatformAgent['treasury'] } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  agent.treasury = { autoYieldEnabled: false, capUsd: agent.treasury?.capUsd ?? DEFAULT_YIELD_CAP_USD, authorizedAt: agent.treasury?.authorizedAt }
  pushActivity(agent, 'Auto-yield turned off by a human')
  save(state)
  return { treasury: agent.treasury }
}
