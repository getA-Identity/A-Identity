/**
 * The free half of verify-then-pay: what the chain says before anything is paid for.
 *
 * Three questions, each read from Arc Mainnet itself and never from a cache:
 *   - Is the money real: does the vault hold the registry's USDC (its usdc() getter)?
 *   - Is the payee an agent: does it hold an ERC-8004 identity on Arc Mainnet's own
 *     IdentityRegistry (balanceOf, or ownerOf(n) when the caller names the agent)? The
 *     ERC-8004 resolver behind risk_check probes every chain, testnets included, and says
 *     neither which chain nor which owner it found, so this is asked here, on this chain.
 *   - Would the vault pay: its policy getters at the latest block, then pay() simulated
 *     from the operator, then whether the operator can pay the gas.
 *
 * A contract that answered "no" (a revert, a zero balance, a different owner) and a chain
 * that did not answer are different facts and are kept apart all the way to the caller: the
 * first is a refusal, the second is "try again", and neither is ever read as the other.
 */
import { BaseError, ContractFunctionRevertedError, type Abi, type Hex } from 'viem'
import type { ChainDescriptor } from '../chains/index.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { isRevert } from '../evm-pay-check/check.js'

/** The reads this module makes. A viem PublicClient satisfies it; tests pass a fake. */
export type VtpReadClient = {
  getBlock(): Promise<{ number: bigint | null; timestamp: bigint }>
  getGasPrice(): Promise<bigint>
  getBalance(args: { address: Hex }): Promise<bigint>
  getCode(args: { address: Hex }): Promise<Hex | undefined>
  readContract(args: { address: Hex; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>
  simulateContract(args: { address: Hex; abi: Abi | readonly unknown[]; functionName: string; args: readonly unknown[]; account: Hex }): Promise<unknown>
  estimateContractGas(args: { address: Hex; abi: Abi | readonly unknown[]; functionName: string; args: readonly unknown[]; account: Hex }): Promise<bigint>
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const REGISTRY_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The contract's own error name when the chain answered with a revert ("AboveAutoApprove",
 * or the message of a plain Error(string) such as a token's balance check), or null when the
 * chain did not answer at all.
 */
export function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName
      if (name && name !== 'Error' && name !== 'Panic') return name
      return rev.reason ?? rev.shortMessage ?? 'reverted'
    }
  }
  return isRevert(e) ? 'reverted' : null
}

type Got<T> = { ok: true; value: T } | { ok: false; reverted: boolean; error: string }

async function got<T>(p: Promise<T>): Promise<Got<T>> {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    const name = revertName(e)
    return { ok: false, reverted: name !== null, error: name ?? msg(e) }
  }
}

// ── the payee ─────────────────────────────────────────────────────────────────────

export type PayeeRegistration = {
  ok: boolean
  code?: 'PAYEE_UNREGISTERED' | 'PAYEE_AGENT_MISMATCH' | 'REGISTRY_UNREADABLE'
  reason?: string
  /** balanceOf(payee) on the identity registry; null when it could not be read. */
  agentsHeld: number | null
  /** The agent id the caller named, as a decimal token id. */
  tokenId: string | null
  /** ownerOf(tokenId), lowercase, when a token id was named and it exists. */
  agentOwner: string | null
}

export async function readPayeeRegistration(client: VtpReadClient, chain: ChainDescriptor, payee: string, tokenId: bigint | null): Promise<PayeeRegistration> {
  const registry = chain.contracts.identityRegistry as Hex | undefined
  const base = { agentsHeld: null, tokenId: tokenId != null ? tokenId.toString() : null, agentOwner: null }
  if (!registry) return { ...base, ok: false, code: 'REGISTRY_UNREADABLE', reason: `${chain.name} declares no identity registry in the registry descriptor` }
  const [bal, own] = await Promise.all([
    got(client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'balanceOf', args: [payee as Hex] })),
    tokenId != null ? got(client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'ownerOf', args: [tokenId] })) : Promise.resolve(null),
  ])
  const agentsHeld = bal.ok ? Number(bal.value as bigint) : null
  if (tokenId != null && own) {
    if (own.ok) {
      const owner = String(own.value).toLowerCase()
      if (owner === payee.toLowerCase()) return { ...base, ok: true, agentsHeld, agentOwner: owner }
      return { ...base, ok: false, code: 'PAYEE_AGENT_MISMATCH', agentsHeld, agentOwner: owner, reason: `agent #${tokenId} on ${chain.name} is owned by ${owner}, not by the payee` }
    }
    if (own.reverted) return { ...base, ok: false, code: 'PAYEE_UNREGISTERED', agentsHeld, reason: `${chain.name}'s IdentityRegistry has no agent #${tokenId} (ownerOf reverted)` }
    return { ...base, ok: false, code: 'REGISTRY_UNREADABLE', agentsHeld, reason: `ownerOf(${tokenId}) could not be read: ${own.error}` }
  }
  if (!bal.ok) return { ...base, ok: false, code: 'REGISTRY_UNREADABLE', reason: `balanceOf(payee) could not be read on ${chain.name}'s IdentityRegistry: ${bal.error}` }
  if (agentsHeld !== null && agentsHeld > 0) return { ...base, ok: true, agentsHeld }
  return { ...base, ok: false, code: 'PAYEE_UNREGISTERED', agentsHeld, reason: `the payee holds no ERC-8004 agent on ${chain.name}'s IdentityRegistry` }
}

// ── the vault ─────────────────────────────────────────────────────────────────────

export type VaultFacts = {
  hasCode: boolean | null
  usdc: string | null
  owner: string | null
  operator: string | null
  frozen: boolean | null
  /** 0 = no time bound. */
  sessionKeyExpiry: bigint | null
  allowlistEnabled: boolean | null
  payeeAllowed: boolean | null
  autoApproveMax: bigint | null
  dailyCap: bigint | null
  spentToday: bigint | null
  /** The vault's USDC, 6 decimals. */
  balance: bigint | null
  blockNumber: bigint | null
  blockTimestamp: bigint | null
  /** Wei, 18 decimals. */
  gasPrice: bigint | null
  /** The operator's native balance, wei, 18 decimals. */
  operatorGas: bigint | null
  operatorHasCode: boolean | null
}

export type VaultRead = {
  facts: VaultFacts
  /** Reads the chain did not answer, by name. */
  unreadable: string[]
  /** Getters the contract reverted, by name: it is not the contract it was said to be. */
  reverted: string[]
}

const GETTERS = ['usdc', 'owner', 'operator', 'frozen', 'sessionKeyExpiry', 'allowlistEnabled', 'autoApproveMax', 'dailyCap', 'spentToday', 'balance'] as const

export async function readVaultFacts(client: VtpReadClient, vault: string, payee: string): Promise<VaultRead> {
  const v = vault as Hex
  const read = (functionName: string, args: readonly unknown[] = []) => got(client.readContract({ address: v, abi: AgentSpendPolicyAbi, functionName, args }))
  const [code, block, gasPrice, allowed, ...getters] = await Promise.all([
    got(client.getCode({ address: v })),
    got(client.getBlock()),
    got(client.getGasPrice()),
    read('allowed', [payee as Hex]),
    ...GETTERS.map((g) => read(g)),
  ])
  const unreadable: string[] = []
  const reverted: string[] = []
  const val = <T>(name: string, r: Got<unknown>, map: (x: unknown) => T): T | null => {
    if (r.ok) return map(r.value)
    ;(r.reverted ? reverted : unreadable).push(name)
    return null
  }
  const byName = Object.fromEntries(GETTERS.map((g, i) => [g, getters[i]])) as Record<(typeof GETTERS)[number], Got<unknown>>
  // A vault built before the session-key getter existed answers it with a revert; that is
  // "no time bound", the same reading the adapter's readVault gives it.
  const expiryRead = byName.sessionKeyExpiry
  let sessionKeyExpiry: bigint | null = null
  if (expiryRead.ok) sessionKeyExpiry = expiryRead.value as bigint
  else if (expiryRead.reverted) sessionKeyExpiry = 0n
  else unreadable.push('sessionKeyExpiry')
  if (!block.ok) unreadable.push('block')

  const facts: VaultFacts = {
    hasCode: val('code', code, (c) => typeof c === 'string' && c !== '0x' && c.length > 2),
    usdc: val('usdc', byName.usdc, (x) => String(x).toLowerCase()),
    owner: val('owner', byName.owner, (x) => String(x).toLowerCase()),
    operator: val('operator', byName.operator, (x) => String(x).toLowerCase()),
    frozen: val('frozen', byName.frozen, (x) => x === true),
    sessionKeyExpiry,
    allowlistEnabled: val('allowlistEnabled', byName.allowlistEnabled, (x) => x === true),
    payeeAllowed: val('allowed', allowed, (x) => x === true),
    autoApproveMax: val('autoApproveMax', byName.autoApproveMax, (x) => x as bigint),
    dailyCap: val('dailyCap', byName.dailyCap, (x) => x as bigint),
    spentToday: val('spentToday', byName.spentToday, (x) => x as bigint),
    balance: val('balance', byName.balance, (x) => x as bigint),
    blockNumber: block.ok ? block.value.number : null,
    blockTimestamp: block.ok ? block.value.timestamp : null,
    gasPrice: val('gasPrice', gasPrice, (x) => x as bigint),
    operatorGas: null,
    operatorHasCode: null,
  }
  if (facts.operator && facts.operator !== ZERO_ADDRESS) {
    const [gas, opCode] = await Promise.all([got(client.getBalance({ address: facts.operator as Hex })), got(client.getCode({ address: facts.operator as Hex }))])
    facts.operatorGas = val('operatorGas', gas, (x) => x as bigint)
    facts.operatorHasCode = val('operatorCode', opCode, (c) => typeof c === 'string' && c !== '0x' && c.length > 2)
  }
  return { facts, unreadable, reverted }
}

export type VaultRefusalCode =
  | 'NOT_A_VAULT'
  | 'VAULT_TOKEN_MISMATCH'
  | 'VaultUnreadable'
  | 'NotOperator'
  | 'IsFrozen'
  | 'SessionKeyExpired'
  | 'PayeeNotAllowed'
  | 'AboveAutoApprove'
  | 'DailyCapExceeded'
  | 'InsufficientVaultBalance'

export type GateResult = { ok: true } | { ok: false; code: VaultRefusalCode; reason: string; httpStatus: 422 | 503 }

/** Is this a contract answering the AgentSpendPolicy getters, holding the registry's USDC? */
export function assessVaultAsset(read: VaultRead, registryUsdc: string, chainName: string): GateResult {
  const f = read.facts
  if (f.hasCode === false) return { ok: false, code: 'NOT_A_VAULT', httpStatus: 422, reason: `there is no contract at this vault address on ${chainName}` }
  if (f.hasCode === null || f.usdc === null) {
    if (read.reverted.includes('usdc')) return { ok: false, code: 'NOT_A_VAULT', httpStatus: 422, reason: 'the contract reverts usdc(), so it is not an AgentSpendPolicy vault' }
    return { ok: false, code: 'VaultUnreadable', httpStatus: 503, reason: `${chainName} did not answer: ${read.unreadable.join(', ') || 'code, usdc'}` }
  }
  if (f.usdc !== registryUsdc.toLowerCase()) {
    return { ok: false, code: 'VAULT_TOKEN_MISMATCH', httpStatus: 422, reason: `the vault's usdc() is ${f.usdc}, not the registry's USDC ${registryUsdc}` }
  }
  return { ok: true }
}

/**
 * Would the vault's pay() accept this payment at the latest block? The same gates in the
 * contract's own order, compared against the block's timestamp rather than our clock. The
 * session key needs `expiryMarginSec` of life left, because the prepared call is sent after
 * the check, not now.
 */
export function assessVaultPolicy(read: VaultRead, amount: bigint, opts: { expiryMarginSec: number }): GateResult {
  const f = read.facts
  if (read.reverted.length) {
    return { ok: false, code: 'NOT_A_VAULT', httpStatus: 422, reason: `the contract reverts ${read.reverted.join(', ')}, so it is not an AgentSpendPolicy vault` }
  }
  const missing = (
    [
      ['owner', f.owner],
      ['operator', f.operator],
      ['frozen', f.frozen],
      ['sessionKeyExpiry', f.sessionKeyExpiry],
      ['allowlistEnabled', f.allowlistEnabled],
      ['allowed', f.payeeAllowed],
      ['autoApproveMax', f.autoApproveMax],
      ['dailyCap', f.dailyCap],
      ['spentToday', f.spentToday],
      ['balance', f.balance],
      ['block number', f.blockNumber],
      ['block timestamp', f.blockTimestamp],
    ] as const
  )
    .filter(([, v]) => v === null)
    .map(([k]) => k)
  if (missing.length) return { ok: false, code: 'VaultUnreadable', httpStatus: 503, reason: `the chain did not answer: ${missing.join(', ')}` }
  if (f.operator === ZERO_ADDRESS) return { ok: false, code: 'NotOperator', httpStatus: 422, reason: 'the vault has no operator, so no key can call pay()' }
  if (f.frozen) return { ok: false, code: 'IsFrozen', httpStatus: 422, reason: 'the vault is frozen by its owner' }
  const expiry = f.sessionKeyExpiry as bigint
  if (expiry !== 0n && (f.blockTimestamp as bigint) + BigInt(opts.expiryMarginSec) > expiry) {
    return { ok: false, code: 'SessionKeyExpired', httpStatus: 422, reason: `the operator's session key expires at ${expiry} (unix), within ${opts.expiryMarginSec} s of the latest block or before it` }
  }
  if (f.allowlistEnabled && !f.payeeAllowed) return { ok: false, code: 'PayeeNotAllowed', httpStatus: 422, reason: 'the vault has its allowlist on and the payee is not on it' }
  const ceiling = f.autoApproveMax as bigint
  if (ceiling !== 0n && amount > ceiling) return { ok: false, code: 'AboveAutoApprove', httpStatus: 422, reason: `the amount is above the vault's per-payment ceiling of ${ceiling} units; only the owner can pay it (ownerPay)` }
  const cap = f.dailyCap as bigint
  if (cap !== 0n && (f.spentToday as bigint) + amount > cap) {
    return { ok: false, code: 'DailyCapExceeded', httpStatus: 422, reason: `the vault has spent ${f.spentToday} of its ${cap} units today (UTC day of the latest block), so this payment would pass the cap` }
  }
  if ((f.balance as bigint) < amount) return { ok: false, code: 'InsufficientVaultBalance', httpStatus: 422, reason: `the vault holds ${f.balance} units, less than the ${amount} to pay` }
  return { ok: true }
}

// ── simulation ────────────────────────────────────────────────────────────────────

export type SimResult = { ok: true; gas: bigint } | { ok: false; reverted: boolean; error: string }

/** The call simulated (eth_call) from its sender at the latest block, then its gas estimated.
 *  Nothing is signed: eth_call takes a from address and no signature. */
export async function simulateVaultCall(
  client: VtpReadClient,
  kind: 'pay' | 'ownerPay',
  input: { vault: string; from: string; payee: string; amount: bigint },
): Promise<SimResult> {
  const call = { address: input.vault as Hex, abi: AgentSpendPolicyAbi, functionName: kind, args: [input.payee as Hex, input.amount] as const, account: input.from as Hex }
  const sim = await got(client.simulateContract(call))
  if (!sim.ok) return { ok: false, reverted: sim.reverted, error: sim.error }
  const gas = await got(client.estimateContractGas(call))
  if (!gas.ok) return { ok: false, reverted: gas.reverted, error: gas.error }
  return { ok: true, gas: gas.value }
}
