/**
 * Agent enforcement rails: the on-chain AgentSpendPolicy vault, the Circle Agent
 * Wallet, and treasury auto-yield into USYC.
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import { state, save, ownsAgent, pushActivity, short, inFlightAgentOps, normalizeSubject, type PlatformAgent } from './core.js'
import { deployPolicyVault, payUsdcOnchain } from '../arc-contracts.js'
import {
  vaultChainFor, readVaultPolicy, writeVaultPolicy, writeVaultFrozen, writeVaultAllowed,
  writeVaultSessionExpiry, deployStellarVault, stellarOperatorAddress,
  allowlistEntriesFor,
} from './vault-adapter.js'
import { ARC_CHAIN, CHAINS, addressUrl, isAccountId } from '../chains/index.js'
import type { ChainDescriptor } from '../chains/types.js'
import { createAgentWallet, readCircleWallet } from '../circle-agent.js'
import { chooseStellarVaultOwner } from '../stellar-vault.js'
import { previewTreasury, startAutoYield, type TreasuryPreview, type TreasuryExecution } from '../treasury.js'

// ── on-chain policy vault ────────────────────────────────────────────────────────

/**
 * Which chain a vault is asked for, by registry id or by CAIP-2.
 *
 * Arc is the default because it is the only chain vaults were ever deployed on, so an
 * existing caller that names no chain keeps the exact behaviour it had. A name the registry
 * does not know is refused rather than silently defaulted: a typo that quietly deployed on
 * a different chain would be a vault the owner cannot find.
 */
function resolveVaultChain(want?: string): ChainDescriptor | null {
  const key = (want ?? ARC_CHAIN.id).trim()
  if (!key) return ARC_CHAIN
  return CHAINS.find((c) => c.id === key || c.caip2 === key) ?? null
}

/**
 * The Stellar accounts this caller has proven control of, newest link last.
 *
 * Read from `state.users` rather than through agents.ts, because that module sits two
 * layers above this one. The rows are the same ones /api/user/wallets lists, each written
 * only after a signature over a nonce was verified.
 */
function callerStellarWallets(caller?: string): string[] {
  const key = normalizeSubject(caller)
  if (!key) return []
  return (state.users[key]?.wallets ?? [])
    .filter((w) => w.ecosystem === 'stellar' && isAccountId(w.address))
    .map((w) => w.address)
}

/**
 * Deploy an AgentSpendPolicy on a Stellar network and record it on the agent.
 *
 * Three things are different enough from the Arc path to be worth stating rather than
 * leaving to be inferred from the code:
 *
 *  - The owner MUST be a real G... account belonging to the human, and the operator is
 *    always the chain signer. The contract itself refuses owner == operator, so the
 *    separation the EVM path asks for politely is unbypassable here.
 *  - There is NO funding step. We hold no USDC to send and would not send a user's money
 *    anyway; the vault is funded by sending USDC to the contract id, and the answer says
 *    so with the explorer link rather than leaving a zero balance unexplained.
 *  - Pubnet is real money, so it is refused unless an operator has opted in with
 *    STELLAR_VAULT_ALLOW_PUBNET=true. Testnet needs no flag.
 */
async function provisionStellarVault(
  agent: PlatformAgent,
  chain: ChainDescriptor,
  opts: { caller?: string; ownerAddress?: string },
) {
  if (!chain.testnet && process.env.STELLAR_VAULT_ALLOW_PUBNET !== 'true') {
    return {
      error:
        `Deploying a vault on ${chain.name} moves real money, so it is opt-in: set ` +
        'STELLAR_VAULT_ALLOW_PUBNET=true on the server to allow it. Nothing was deployed. ' +
        `The rehearsal network needs no flag, so ${CHAINS.find((c) => c.ecosystem === 'stellar' && c.testnet)?.id ?? 'the Stellar testnet'} is available now.`,
    }
  }

  // Permanent once deployed (the contract has no set_owner), so the rules live in one pure,
  // tested function instead of a ternary that quietly took the oldest linked wallet and let a
  // malformed ownerAddress fall through to some other account.
  const choice = chooseStellarVaultOwner({
    ownerAddress: opts.ownerAddress,
    caller: opts.caller,
    linkedWallets: callerStellarWallets(opts.caller),
  })
  if (!choice.ok) {
    return { error: choice.reason, ...(choice.linkedWallets ? { linkedWallets: choice.linkedWallets } : {}) }
  }
  const owner = choice.owner

  const operator = await stellarOperatorAddress(chain)
  if (!operator) {
    return {
      error:
        `${chain.signerEnvVar ?? 'the chain signer'} is not set, so this server has no account to ` +
        `operate a vault on ${chain.name}. Nothing was deployed and nothing was charged: set the ` +
        'key and ask again.',
    }
  }
  if (owner === operator) {
    return {
      error:
        'The owner you gave is this server\'s own operator account. The contract refuses that at ' +
        'construction (OwnerIsOperator), because one key that can both spend past the policy and ' +
        'lift the policy is the same as having no policy. Nothing was deployed.',
    }
  }

  const token = chain.settlementTokens?.[0]
  if (!token) {
    return { error: `${chain.name} declares no settlement token, so a vault has nothing to custody.` }
  }

  const dep = await deployStellarVault(chain, {
    owner,
    operator,
    token: token.address,
    dailyCapUsd: agent.permissions.dailyCapUsd,
    autoApproveUsd: agent.permissions.autoApproveUnderUsd,
  })
  if (dep.outcome !== 'settled') {
    // Nothing is recorded on the agent unless a deploy landed. A `pending` deploy is the
    // one that tempts a lie: it may still land, so it is reported with its hash and left
    // for a human to confirm rather than written down as a vault that might not exist.
    return {
      error: dep.reason,
      outcome: dep.outcome,
      chain: chain.caip2,
      ...('txHash' in dep ? { txHash: dep.txHash, explorerUrl: dep.explorerUrl } : {}),
      ...(dep.outcome === 'prepared' || dep.outcome === 'refused'
        ? { prepared: { contract: dep.contract, method: dep.method, args: dep.args } }
        : {}),
    }
  }

  const explorer = addressUrl(chain, dep.vault)
  agent.vaultAddress = dep.vault
  agent.vaultChainCaip2 = chain.caip2
  agent.vaultExplorer = explorer
  agent.vaultOwner = owner
  agent.vaultOperator = operator
  agent.vaults = [
    ...(agent.vaults ?? []),
    { chainCaip2: chain.caip2, address: dep.vault, explorer, owner, operator, source: 'deployed' },
  ]
  pushActivity(
    agent,
    `On-chain policy vault deployed on ${chain.name} at ${short(dep.vault)} (tx ${short(dep.txHash)})` +
      ` - human owner ${short(owner)}, agent operator ${short(operator)}`,
  )
  save(state)
  return {
    vaultAddress: dep.vault,
    vaultExplorer: explorer,
    chain: chain.caip2,
    owner,
    operator,
    ownerOperatorSeparated: true,
    deployTx: dep.txHash,
    deployExplorer: dep.explorerUrl,
    // Said plainly, because a vault with a zero balance and no explanation reads as broken.
    funding: {
      funded: false,
      note:
        `Fund the vault by sending ${token.symbol} to the contract id ${dep.vault} on ${chain.name}. ` +
        'This server holds no user funds and never moves them, so there is no funding step here.',
      explorerUrl: explorer,
    },
    ownerSigning: 'wallet' as const,
    note:
      'Owner and operator are different accounts, so freeze, withdraw, set_policy, set_allowed, ' +
      'set_session_key_expiry and owner_pay are signed by the owner wallet. Build those through ' +
      'POST /api/stellar/vault/prepare and submit them with POST /api/stellar/vault/submit.',
  }
}

/**
 * Provision an on-chain AgentSpendPolicy vault for an agent: deploy a contract
 * that enforces the agent's daily cap + auto-approve ceiling, and optionally fund
 * it with USDC. Once set, this agent's address payments settle
 * through the vault (chain-enforced), with the server engine as the pre-check.
 * Owner-only; env-gated behind the chain's own signer key.
 *
 * `chain` names where, by registry id or CAIP-2, and defaults to Arc so every existing
 * caller behaves exactly as it did. Stellar takes the separate path above, because the two
 * chains disagree about what an address is, what a decimal is and who may sign an owner
 * call, and pretending otherwise is what produced a vault story that only worked on one of
 * them.
 */
export async function provisionAgentVault(
  agentId: string,
  opts: { fundUsd?: number; caller?: string; ownerAddress?: string; chain?: string } = {},
) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, opts.caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.vaultAddress) return { error: 'Agent already has an on-chain policy vault', vaultAddress: agent.vaultAddress }

  const chain = resolveVaultChain(opts.chain)
  if (!chain) {
    return { error: `Unknown chain ${opts.chain}: name a registry id or a CAIP-2 id from GET /api/chains.` }
  }
  if (chain.ecosystem === 'algorand') {
    return {
      error:
        `No AgentSpendPolicy vault is deployed on ${chain.name} yet; the AVM port is planned and ` +
        'nothing was deployed.',
    }
  }
  if (chain.ecosystem === 'evm' && chain.id !== ARC_CHAIN.id) {
    return {
      error:
        `Vault deployment on ${chain.name} is planned, not built: the EVM deployer is bound to ` +
        `${ARC_CHAIN.name}. Nothing was deployed.`,
    }
  }

  if (chain.ecosystem === 'stellar') {
    const opKey = `vault:${agentId}`
    if (inFlightAgentOps.has(opKey)) return { error: 'A vault is already being provisioned for this agent' }
    inFlightAgentOps.add(opKey)
    try {
      return await provisionStellarVault(agent, chain, opts)
    } finally {
      inFlightAgentOps.delete(opKey)
    }
  }

  // Human owner of the vault = a REAL wallet distinct from the server signer/operator,
  // so freeze/override/withdraw are owner-gated on-chain. Prefer an explicit address,
  // then the caller when they signed in with a wallet (SIWE -> subject is a 0x addr),
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
      (separated ? ` - human owner ${short(dep.owner)}, agent operator ${short(dep.operator)}` : ''),
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
  // Through the dispatcher, so an owner reading a Soroban vault's limits gets the vault's
  // real numbers rather than an EVM adapter's error about an address.
  const live = await readVaultPolicy(agent, agent.vaultAddress)
  const chain = vaultChainFor(agent)
  const owner = live?.owner ?? agent.vaultOwner ?? null
  const operator = live?.operator ?? agent.vaultOperator ?? null
  // Who signs the owner-only calls, DERIVED rather than asserted: they differ, so the
  // owner's own wallet has to. On Stellar this is always 'wallet', because the contract
  // refuses owner == operator at construction; on Arc it depends on how the vault was
  // deployed. A vault whose owner or operator we cannot read is reported as 'server',
  // which is the same assumption the settlement path has always made for those rows.
  const ownerSigning: 'server' | 'wallet' =
    owner && operator && owner.toLowerCase() !== operator.toLowerCase() ? 'wallet' : 'server'
  return {
    vaultAddress: agent.vaultAddress,
    chain: agent.vaultChainCaip2 ?? null,
    ...(live ?? {}),
    chainId: chain?.id ?? null,
    chainName: chain?.name ?? null,
    ecosystem: chain?.ecosystem ?? null,
    owner,
    operator,
    explorer: live?.explorer ?? agent.vaultExplorer ?? null,
    ownerSigning,
    ownerSigningNote:
      ownerSigning === 'wallet'
        ? 'Owner and operator are different accounts, so set_policy, set_frozen, set_allowed, ' +
          'set_session_key_expiry, withdraw and owner_pay must be signed by the owner wallet. ' +
          'On Stellar, build them with POST /api/stellar/vault/prepare and broadcast them with ' +
          'POST /api/stellar/vault/submit.'
        : 'The server signer is also this vault owner, so owner calls are signed here.',
    /**
     * Whether the on-chain read answered at all. Absent limits mean the RPC did not answer,
     * not that the cap is zero, and the two look identical without this. Named `liveRead`
     * rather than `live` because /api/stellar/vaults already uses `live` for an object.
     */
    liveRead: live !== null,
  }
}

/**
 * Grant / extend / revoke the agent's on-chain SESSION KEY: set the UNIX time after which
 * the agent's `pay` reverts (SessionKeyExpired). Owner-only on-chain; the server can sign it
 * only when it is the vault owner (owner==operator) - otherwise it's ownerGated (the human
 * signs from their own wallet), mirroring syncVaultPolicy. Revoke sets the expiry to now.
 *
 * WHICH key this grants, said plainly because the word "session key" invites the wrong
 * picture: it is the vault's existing `operator` address, and this call gives that address
 * a deadline. No key material is created, transmitted or stored by this function, here or
 * anywhere downstream. That is the whole reason a session key can exist in this product at
 * all: the private half was never ours to hold, so a time bound is the only thing there is
 * to grant. The ERC-4337 variant in `aa-wallet.ts`, where the session key is a fresh signer
 * with its own private key, is deliberately a demo that mints and discards that key inside
 * one request; persisting it so the server could settle with it later would be secret-at-
 * rest and autonomous key custody, which this project does not do.
 *
 * The returned `sessionKey` is the operator ADDRESS, which is public and already stored on
 * the agent record. `platform/instructions.ts` reads the resulting expiry back off the
 * chain and labels settlements it authorised `enforcedBy: 'session-key'`.
 */
export async function grantAgentSessionKey(
  agentId: string,
  input: { durationHours?: number; expiryUnix?: number; revoke?: boolean },
  caller?: string,
): Promise<{
  granted: boolean
  reason?: string
  ownerGated?: boolean
  /** The vault this bound applies to, and the operator address it bounds. Public data. */
  vaultAddress?: string
  sessionKey?: string
  /** Stated on every answer so nobody has to infer it from silence. */
  custody?: string
  sessionKeyExpiry?: number
  expiresInSeconds?: number
  txHash?: string
  explorerUrl?: string
  /** On a chain where the owner is not us, the exact call their wallet has to sign. */
  prepared?: { contract: string; method: string; args: unknown[]; network: string }
}> {
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

  // Carried on every arm below, including the refusals: the one question an operator is
  // entitled to have answered without reading the source.
  const identity = {
    vaultAddress: agent.vaultAddress,
    ...(agent.vaultOperator ? { sessionKey: agent.vaultOperator } : {}),
    custody:
      'This grants a time bound to the vault operator address. No session-key private key is created, ' +
      'transmitted or stored by this server.',
  }

  // On Soroban the answer is known before any round trip, and saying so costs nothing.
  // `set_session_key_expiry` calls `owner.require_auth()`, the owner is the human's own
  // G... account by construction (the contract refuses owner == operator at deploy), and
  // this server holds only the operator key. So there is no configuration under which we
  // could sign this, and simulating it would spend a request to be told what the contract
  // guarantees. Answer ownerGated with the exact call, which is what the wallet then signs.
  const vaultChain = vaultChainFor(agent)
  if (vaultChain?.ecosystem === 'stellar') {
    return {
      granted: false,
      ownerGated: true,
      ...identity,
      sessionKeyExpiry: expiry,
      expiresInSeconds: input.revoke ? 0 : Math.max(0, expiry - now),
      prepared: {
        contract: agent.vaultAddress,
        method: 'set_session_key_expiry',
        args: [String(expiry)],
        network: vaultChain.caip2,
      },
      reason:
        'This vault is owned by your own Stellar wallet, so only that wallet can grant or revoke ' +
        'the session key. Nothing was submitted. Build the transaction with POST ' +
        `/api/stellar/vault/prepare ({ network: "${vaultChain.id}", contract: "${agent.vaultAddress}", ` +
        `source: <your G... account>, action: "set_session_key_expiry", args: { expiryUnix: ${expiry} } }), ` +
        'sign it in your wallet, and send it to POST /api/stellar/vault/submit.',
    }
  }

  const res = await writeVaultSessionExpiry(agent, agent.vaultAddress, expiry)
  if (res.ok) {
    pushActivity(agent, input.revoke
      ? `Session key revoked on-chain (tx ${short(res.txHash ?? '')})`
      : `Session key granted, expires ${new Date(expiry * 1000).toISOString()} (tx ${short(res.txHash ?? '')})`)
    save(state)
    return { granted: true, ...identity, sessionKeyExpiry: expiry, expiresInSeconds: input.revoke ? 0 : Math.max(0, expiry - now), txHash: res.txHash, explorerUrl: res.explorerUrl }
  }
  if (res.reason === 'NotOwner') {
    return { granted: false, ownerGated: true, ...identity, sessionKeyExpiry: expiry, reason: 'The vault owner must sign this from their own wallet (owner is not the operator).' }
  }
  return { granted: false, ...identity, reason: res.reason }
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
 * limit changed in the UI actually re-enforces on Arc - not only in the server pre-check.
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
  // Which adapter speaks to THIS vault is decided in vault-adapter.ts, from the vault's own
  // chain, because an AgentSpendPolicy now exists on Soroban as well as on Arc and handing
  // a C... contract id to an EVM adapter fails with a message about an address.
  const vaultChain = vaultChainFor(agent)
  if (!vaultChain) {
    return { synced: false, reason: `This agent's vault names chain ${agent.vaultChainCaip2}, which is not in the registry.` }
  }
  const p = agent.permissions
  const want = {
    dailyCapUsd: p.dailyCapUsd,
    autoApproveUsd: p.autoApproveUnderUsd,
    allowlistEnabled: p.payeeAllowlist.length > 0,
    frozen: p.frozen,
  }

  // Only write what actually changed on-chain. A read never needs a key.
  let live: Awaited<ReturnType<typeof readVaultPolicy>> = null
  try { live = await readVaultPolicy(agent, vault) } catch { live = null }
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
      const sp = await writeVaultPolicy(agent, vault, {
        dailyCapUsd: want.dailyCapUsd, autoApproveUsd: want.autoApproveUsd, allowlistEnabled: want.allowlistEnabled,
      })
      if (!sp.ok) return { synced: false, ...(sp.ownerGated ? { ownerGated: true, want } : {}), reason: `Vault setPolicy failed: ${sp.reason}` }
      txs.setPolicy = sp.txHash
    }
    if (frozenDrift) {
      const sf = await writeVaultFrozen(agent, vault, want.frozen)
      if (sf.ok) txs.setFrozen = sf.txHash
    }
    // Mirror raw-address allowlist entries onto the vault, in BOTH directions. The chain's
    // allowed set is not enumerable, so `vaultMirroredPayees` is our record of what we
    // wrote; a payee dropped from the off-chain list is revoked on-chain rather than left
    // allowed forever. Best-effort per entry, and the record only advances for the writes
    // that actually landed, so a failed revoke is retried on the next sync instead of being
    // forgotten. `agent://` payees are not mirrored: the vault only understands addresses.
    const wantPayees = allowlistEntriesFor(vaultChain, p.payeeAllowlist)
    const mirrored = agent.vaultMirroredPayees ?? []
    const key = (x: string) => x.toLowerCase()
    const wantKeys = new Set(wantPayees.map(key))
    const stillMirrored = mirrored.filter((addr) => wantKeys.has(key(addr)))
    for (const addr of mirrored.filter((addr) => !wantKeys.has(key(addr)))) {
      const ok = await writeVaultAllowed(agent, vault, addr, false).then((r) => r.ok).catch(() => false)
      if (!ok) stillMirrored.push(addr) // could not revoke: keep it on the books and retry
    }
    const mirroredKeys = new Set(mirrored.map(key))
    for (const addr of wantPayees.filter((addr) => !mirroredKeys.has(key(addr)))) {
      const ok = await writeVaultAllowed(agent, vault, addr, true).then((r) => r.ok).catch(() => false)
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
 * agent - the second, hosted enforcement layer alongside the on-chain vault. Once set,
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
