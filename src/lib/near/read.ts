/**
 * One live read of a NEAR vault: everything the console shows, from the chain, with no wallet.
 *
 * The account comes first, because it decides what the rest can mean. An account that does not
 * exist is the "not deployed yet" state, read live rather than assumed; an account with no code
 * is a deploy that has not happened; a contract whose get_config is not the vault's shape is
 * "not this vault", and none of its numbers are shown. Only then are the vault's views read, all
 * at the latest FINAL block, together with the account's access keys and the final block's own
 * clock, which is the clock the contract enforces days and expiries by.
 *
 * A read the chain answered is never mixed with one it did not: the whole snapshot fails when a
 * view the page needs is unreadable. The token and registry reads that only decorate it (the
 * token's name, the balance) degrade on their own and say so, and so do the two counter totals
 * vault 0.2.0 added (guard_refusal_payees, refusal_payees): an earlier build has neither, which
 * the page states rather than treating that vault as unreadable.
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
import {
  parseAccountList,
  parseAgents,
  parseCount,
  parseHeld,
  parseVaultConfig,
  parseVerdict,
  VAULT_VERSION_PREFIX,
  type AgentKeyRecord,
  type HeldPayment,
  type VaultConfig,
} from './abi.ts'
import type { VerdictRead } from './model.ts'
import { finalBlock, viewAccessKeys, viewAccount, viewCall, type AccessKey, type RpcDeps, type ViewResult } from './rpc.ts'
import { u128 } from './units.ts'

/** The vault's own bounds (lib.rs): MAX_PENDING_HELD and MAX_ALLOWLIST, so one page of each is all of it. */
export const MAX_HELD = 20
export const MAX_ALLOWLIST = 100
/** MAX_GUARD_PAYEES and MAX_REFUSAL_PAYEES (lib.rs, 0.2.0 on): most payees with each kind of refusal counter. */
export const MAX_GUARD_PAYEES = 100
export const MAX_REFUSAL_PAYEES = 100

/**
 * How many payees hold a refusal counter (vault 0.2.0 on): `guard` counts the payees the agent
 * recorded a refusal of (guard_refusal_payees), `registry` the payees a registry DENY was counted
 * against (refusal_payees), each at most 100. `not-reported` is a build without these views,
 * which also has no bound and no forget method; `unread` is a read that did not answer.
 */
export type CounterSlots = { state: 'read'; guard: number; registry: number } | { state: 'not-reported' } | { state: 'unread'; why: string }

/** The two counter views' answers, as one statement. */
export function counterSlotsOf(guard: ViewResult | null, registry: ViewResult | null): CounterSlots {
  if (guard === null || registry === null) return { state: 'unread', why: 'no host answered' }
  // A build before 0.2.0 has neither view: the chain answers MethodNotFound, which is a fact about the build.
  if (!guard.ok) return guard.why === 'no-method' ? { state: 'not-reported' } : { state: 'unread', why: guard.detail }
  if (!registry.ok) return registry.why === 'no-method' ? { state: 'not-reported' } : { state: 'unread', why: registry.detail }
  const g = parseCount(guard.value)
  const r = parseCount(registry.value)
  if (g === null || r === null) return { state: 'unread', why: 'an answer that is not a count' }
  return { state: 'read', guard: g, registry: r }
}

export type TokenFacts = {
  id: string
  symbol: string | null
  name: string | null
  decimals: number | null
  /** The vault's token is the USDC the registry documents for NEAR testnet. */
  documented: boolean
}

export type VaultSnapshot = {
  vaultId: string
  /** When this browser finished the read. */
  readAt: string
  /** The final blocks the values came from (each view is answered at the latest final block). */
  blocks: { min: number; max: number }
  hosts: string[]
  /** The final block's clock, in Unix seconds. */
  chainNowS: bigint
  account: { amountYocto: bigint; lockedYocto: bigint; storageUsage: number; codeHash: string }
  config: VaultConfig
  /** The vault's UTC day index. */
  today: bigint
  spentToday: bigint
  /** null: no cap. */
  remainingToday: bigint | null
  agents: AgentKeyRecord[]
  held: HeldPayment[]
  allowlist: string[]
  keys: AccessKey[]
  token: TokenFacts
  /** The vault's token balance (ft_balance_of), null when the token did not answer. */
  balance: bigint | null
  /** Whether the vault is registered on its token (storage_balance_of), null when unknown. */
  registeredOnToken: boolean | null
  /** Whether the registry the vault reads exists as a contract, null when it has none or it was not read. */
  registryLive: boolean | null
  /** How many payees hold each kind of refusal counter, out of 100 (0.2.0 on). */
  counters: CounterSlots
}

export type VaultRead =
  | { state: 'missing'; vaultId: string; blockHeight: number | null; host: string; readAt: string }
  | { state: 'no-code'; vaultId: string; blockHeight: number; host: string; readAt: string }
  | { state: 'not-vault'; vaultId: string; reason: string; codeHash: string; blockHeight: number; host: string; readAt: string }
  | { state: 'live'; snapshot: VaultSnapshot }

/** What a failed view says, for the not-vault note. */
function viewProblem(method: string, r: ViewResult): string {
  if (r.ok) return `${method} answered a shape that is not the vault's`
  if (r.why === 'no-method') return `it has no ${method} method`
  if (r.why === 'panic') return `${method} panicked: ${r.detail}`
  return `${method} failed: ${r.detail}`
}

export async function readNearVault(
  urls: readonly string[],
  vaultId: string,
  documentedUsdc: { address: string; decimals: number } | null,
  deps: RpcDeps = {},
): Promise<VaultRead> {
  const account = await viewAccount(urls, vaultId, deps)
  if (!account.exists) return { state: 'missing', vaultId, blockHeight: account.blockHeight, host: account.host, readAt: new Date().toISOString() }
  if (!account.hasContract) return { state: 'no-code', vaultId, blockHeight: account.blockHeight, host: account.host, readAt: new Date().toISOString() }

  const [cfg, today, spent, remaining, agents, held, allow, keys, block] = await Promise.all([
    viewCall(urls, vaultId, 'get_config', {}, deps),
    viewCall(urls, vaultId, 'today', {}, deps),
    viewCall(urls, vaultId, 'spent_today', {}, deps),
    viewCall(urls, vaultId, 'remaining_today', {}, deps),
    viewCall(urls, vaultId, 'list_agents', {}, deps),
    viewCall(urls, vaultId, 'list_held', { from_index: '0', limit: String(MAX_HELD) }, deps),
    viewCall(urls, vaultId, 'list_allowlist', { from_index: '0', limit: String(MAX_ALLOWLIST) }, deps),
    viewAccessKeys(urls, vaultId, deps),
    finalBlock(urls, deps),
  ])
  const notVault = (reason: string) =>
    ({ state: 'not-vault', vaultId, reason, codeHash: account.codeHash, blockHeight: account.blockHeight, host: account.host, readAt: new Date().toISOString() }) as const

  const config = cfg.ok ? parseVaultConfig(cfg.value) : null
  if (!config) return notVault(viewProblem('get_config', cfg))
  if (!config.version.startsWith(VAULT_VERSION_PREFIX)) return notVault(`get_config reports "${config.version}", not an agent-spend-policy build`)
  const todayN = today.ok ? u128(today.value) : null
  if (todayN === null) return notVault(viewProblem('today', today))
  const spentN = spent.ok ? u128(spent.value) : null
  if (spentN === null) return notVault(viewProblem('spent_today', spent))
  // null is an answer here: no cap. Only a value that is neither null nor a U128 is a problem.
  if (!remaining.ok || (remaining.value !== null && u128(remaining.value) === null)) return notVault(viewProblem('remaining_today', remaining))
  const remainingN = remaining.value === null ? null : u128(remaining.value)
  const agentList = agents.ok ? parseAgents(agents.value) : null
  if (!agentList) return notVault(viewProblem('list_agents', agents))
  const heldList = held.ok ? parseHeld(held.value) : null
  if (!heldList) return notVault(viewProblem('list_held', held))
  const allowList = allow.ok ? parseAccountList(allow.value) : null
  if (!allowList) return notVault(viewProblem('list_allowlist', allow))

  // The decoration: the token, the registry and the counter totals. Each degrades on its own.
  const tokenId = config.tokenId
  const [meta, balance, storage, registry, guardSlots, refusalSlots] = await Promise.all([
    viewCall(urls, tokenId, 'ft_metadata', {}, deps).catch(() => null),
    viewCall(urls, tokenId, 'ft_balance_of', { account_id: vaultId }, deps).catch(() => null),
    viewCall(urls, tokenId, 'storage_balance_of', { account_id: vaultId }, deps).catch(() => null),
    config.registryId ? viewAccount(urls, config.registryId, deps).catch(() => null) : Promise.resolve(null),
    viewCall(urls, vaultId, 'guard_refusal_payees', {}, deps).catch(() => null),
    viewCall(urls, vaultId, 'refusal_payees', {}, deps).catch(() => null),
  ])
  const m = meta?.ok && typeof meta.value === 'object' && meta.value !== null ? (meta.value as Record<string, unknown>) : null
  const documented = documentedUsdc !== null && tokenId === documentedUsdc.address
  const metaDecimals = typeof m?.decimals === 'number' && Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= 30 ? m.decimals : null
  const token: TokenFacts = {
    id: tokenId,
    symbol: typeof m?.symbol === 'string' ? m.symbol : null,
    name: typeof m?.name === 'string' ? m.name : null,
    decimals: metaDecimals ?? (documented ? documentedUsdc.decimals : null),
    documented,
  }

  const heights = [account.blockHeight, ...[cfg, today, spent, remaining, agents, held, allow].map((r) => r.blockHeight ?? 0), keys.blockHeight, block.height].filter(
    (h) => h > 0,
  )
  const hosts = [...new Set([account.host, cfg.host, keys.host, block.host])]

  return {
    state: 'live',
    snapshot: {
      vaultId,
      readAt: new Date().toISOString(),
      blocks: { min: Math.min(...heights), max: Math.max(...heights) },
      hosts,
      chainNowS: block.timestampNs / 1_000_000_000n,
      account: { amountYocto: account.amountYocto, lockedYocto: account.lockedYocto, storageUsage: account.storageUsage, codeHash: account.codeHash },
      config,
      today: todayN,
      spentToday: spentN,
      remainingToday: remainingN,
      agents: agentList,
      held: heldList,
      allowlist: allowList,
      keys: keys.keys,
      token,
      balance: balance?.ok ? u128(balance.value) : null,
      registeredOnToken: storage?.ok ? storage.value !== null : null,
      registryLive: registry === null ? null : registry.exists ? registry.hasContract : false,
      counters: counterSlotsOf(guardSlots, refusalSlots),
    },
  }
}

/** What the vault and its registry hold about one payee. */
export type PayeeFacts = {
  payee: string
  verdict: VerdictRead
  paidCount: number | null
  /** Registry DENY refusals only: the count another vault may read as a signal. */
  refusalCount: number | null
  /** Refusals the agent recorded itself: its word, not a fact about the payee. */
  guardRefusals: number | null
}

/** How many allowlist entries are read on their own; the rest wait for a person to check them. */
export const ALLOWLIST_READ_LIMIT = 12

/**
 * The payees whose facts the page reads, in the order it shows them: the ones a person checked,
 * then EVERY held payment's payee, because the owner decides on each hold with its verdict in
 * view (the vault holds at most MAX_HELD, so that is bounded), then the allowlist up to
 * ALLOWLIST_READ_LIMIT. Each payee once.
 */
export function payeesInView(s: Pick<VaultSnapshot, 'held' | 'allowlist'>, checked: readonly string[]): string[] {
  const first = [...new Set([...checked, ...s.held.map((h) => h.payee)])]
  const listed = s.allowlist.filter((p) => !first.includes(p)).slice(0, ALLOWLIST_READ_LIMIT)
  return [...first, ...listed]
}

/** Read the facts for a list of payees, a few at a time so a long list does not flood the hosts. */
export async function readPayees(
  urls: readonly string[],
  vaultId: string,
  registryId: string | null,
  payees: readonly string[],
  deps: RpcDeps = {},
  concurrency = 3,
): Promise<PayeeFacts[]> {
  const one = async (payee: string): Promise<PayeeFacts> => {
    const count = (method: string) =>
      viewCall(urls, vaultId, method, { payee }, deps).then(
        (r) => (r.ok ? parseCount(r.value) : null),
        () => null,
      )
    const verdict: Promise<VerdictRead> = registryId
      ? viewCall(urls, registryId, 'get_verdict', { account_id: payee }, deps).then(
          // A registry that ran and could not answer is what the vault sees as unreadable; a
          // host that could not be reached says nothing about the registry, so it reads as not asked.
          (r) => (r.ok ? parseVerdict(r.value) : { ok: false }),
          () => null,
        )
      : Promise.resolve(null)
    const [v, paid, refused, guard] = await Promise.all([verdict, count('paid_count'), count('refusal_count'), count('guard_refusal_count')])
    return { payee, verdict: v, paidCount: paid, refusalCount: refused, guardRefusals: guard }
  }
  const out: PayeeFacts[] = []
  for (let i = 0; i < payees.length; i += concurrency) {
    out.push(...(await Promise.all(payees.slice(i, i + concurrency).map(one))))
  }
  return out
}
