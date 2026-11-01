/**
 * Live reads of an AgentSpendPolicy vault on Arc, straight from the chain, for /app/vault/arc.
 *
 * No backend sits between the page and the chain: every read goes to the RPCs the registry
 * lists (CHAIN_RPC_URLS in the generated src/lib/chains.ts), and nothing here types a chain
 * id, a host, an explorer or a token address. One snapshot is read from ONE host at ONE block:
 * the host's latest block is read first, and the code and every view are then read pinned to
 * that block number, so the values on screen describe a single moment and the stamp under them
 * names it. A host that does not answer, or answers for another chain, passes the snapshot to the
 * next host in registry order.
 *
 * A receipt is different: one host returning null proves nothing on Arc (on 2026-10-11 one of
 * the four mainnet hosts returned none of 19 receipts that exist), so a receipt is asked of
 * every host at once and the first one found decides. A write's effect is then read back pinned
 * to the receipt's own block, on the host that returned the receipt first, so a host one block
 * behind cannot make a landed write look as if it did nothing.
 *
 * A failed read is a result, not an exception, and it carries when and why it failed, so the
 * page can say so instead of showing the previous numbers as if they were current.
 */
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { CHAIN_BY_ID, CHAIN_RPC_URLS, CHAIN_USDC, type Chain } from '../chains'
import { AGENT_SPEND_POLICY_ABI, AGENT_SPEND_POLICY_IMMUTABLES, AGENT_SPEND_POLICY_RUNTIME } from '../contracts/agent-spend-policy'
import { NoHostAnswered, onHosts } from './hosts'
import { firstFound, missingFrom, type DecodedLog, type Expectation } from './tx-rules'
import { isKnownBuild, sameAddress } from './vault-rules'

export type { Expectation, VaultEventName } from './tx-rules'

// --- which chains ---

/** Arc Mainnet: the default, and the only network whose vaults count for Milestone 1. Real USDC. */
export const ARC_MAINNET: Chain = CHAIN_BY_ID['arc-mainnet']
/** Arc testnet. The registry id 'arc' IS the testnet; it is offered here for rehearsal only. */
export const ARC_TESTNET: Chain = CHAIN_BY_ID.arc
/** Mainnet first: that is where a vault the page deploys is meant to live. */
export const ARC_CHAINS: readonly Chain[] = [ARC_MAINNET, ARC_TESTNET]

/** An Arc chain by CAIP-2 or registry id, or null. Never guessed from anything else. */
export function arcChainFor(network: string | null | undefined): Chain | null {
  if (!network) return null
  const n = network.trim()
  return ARC_CHAINS.find((c) => c.caip2 === n || c.id === n) ?? null
}

/** "Arc Mainnet" or "Arc testnet", for a sentence. */
export function networkName(chain: Chain): string {
  return chain.testnet ? 'Arc testnet' : 'Arc Mainnet'
}

/** "mainnet" or "testnet", for analytics, which must never carry an address. */
export function networkWord(chain: Chain): 'mainnet' | 'testnet' {
  return chain.testnet ? 'testnet' : 'mainnet'
}

/** Every RPC the registry lists for the chain, primary first. */
export function rpcUrls(chain: Chain): readonly string[] {
  const list = CHAIN_RPC_URLS[chain.id]
  if (list && list.length) return list
  return chain.rpcUrl ? [chain.rpcUrl] : []
}

/** The host of an RPC URL, for the read stamp. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The registry's USDC on this chain, with its ERC-20 decimals, or null. */
export function usdcOf(chain: Chain): { address: Address; decimals: number } | null {
  const u = CHAIN_USDC[chain.id]
  return u && isAddress(u.address) ? { address: getAddress(u.address), decimals: u.decimals } : null
}

/** Explorer links, derived from the registry's explorer base and never typed. */
export function txUrl(chain: Chain, hash: string): string | null {
  return chain.explorer ? `${chain.explorer}/tx/${hash}` : null
}
export function addressUrl(chain: Chain, address: string): string | null {
  return chain.explorer ? `${chain.explorer}/address/${address}` : null
}

// --- clients ---

const RPC_TIMEOUT_MS = 8000

function viemChainOf(chain: Chain) {
  return defineChain({
    id: chain.chainId as number,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [...rpcUrls(chain)] } },
  })
}

function makeClient(chain: Chain, url: string) {
  return createPublicClient({ chain: viemChainOf(chain), transport: http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) })
}

export type ArcClient = ReturnType<typeof makeClient>

const clients = new Map<string, ArcClient>()

export function clientFor(chain: Chain, url: string): ArcClient {
  const key = `${chain.id}|${url}`
  let c = clients.get(key)
  if (!c) {
    c = makeClient(chain, url)
    clients.set(key, c)
  }
  return c
}

/** True when the failure was the contract's own answer (a revert, or no data), not the host's. */
export function isContractAnswer(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false
  return Boolean(
    e.walk(
      (x) =>
        x instanceof ContractFunctionRevertedError ||
        x instanceof ContractFunctionZeroDataError ||
        x instanceof AbiDecodingZeroDataError ||
        x instanceof AbiDecodingDataSizeTooSmallError ||
        (typeof (x as { code?: unknown }).code === 'number' && (x as { code: number }).code === 3),
    ),
  )
}

export class RpcUnreachableError extends Error {
  readonly hosts: string[]
  constructor(chain: Chain, hosts: string[], reason: string) {
    super(`No ${networkName(chain)} RPC answered (${hosts.join(', ')})${reason ? `: ${reason}` : ''}.`)
    this.name = 'RpcUnreachableError'
    this.hosts = hosts
  }
}

function shortReason(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * Run `fn` against the hosts in registry order until one answers, each host's chain id checked
 * first (hosts.ts). Only a host-level failure (no answer, a wrong chain, an HTTP or RPC error that
 * is not a revert) moves on to the next host. A revert is the chain's verdict and is thrown at
 * once, because asking the next host would only get the same verdict later; so is any error `fn`
 * raises itself, which is a decision rather than a fault.
 */
export async function onFirstHost<T>(chain: Chain, fn: (client: ArcClient, host: string) => Promise<T>): Promise<{ value: T; host: string }> {
  const hosts = rpcUrls(chain).map((url) => ({ host: hostOf(url), client: clientFor(chain, url) }))
  try {
    return await onHosts(
      hosts,
      {
        chainId: chain.chainId as number,
        askChainId: (c) => c.getChainId(),
        isFinal: (e) => isContractAnswer(e) || (!(e instanceof BaseError) && !(e instanceof TypeError)),
      },
      fn,
    )
  } catch (e) {
    if (e instanceof NoHostAnswered) throw new RpcUnreachableError(chain, e.tried, e.last ? shortReason(e.last) : '')
    throw e
  }
}

// --- one vault, at one block ---

export type VaultSnapshot = {
  /** CAIP-2. */
  network: string
  chainId: number
  /** Checksummed. */
  address: Address
  /** The RPC host that answered every value below. */
  host: string
  /** The block every value was read at, and that block's timestamp: chain time, not this browser's clock. */
  block: bigint
  chainTime: bigint
  /** When the read completed, in this browser's clock (ISO). */
  readAt: string
  owner: Address
  operator: Address
  usdc: Address
  /** usdc() is the registry's USDC for this chain. */
  usdcMatches: boolean
  dailyCap: bigint
  autoApproveMax: bigint
  frozen: boolean
  allowlistEnabled: boolean
  sessionKeyExpiry: bigint
  today: bigint
  spentToday: bigint
  balance: bigint
  /** The registry's USDC decimals (6): every amount above is in these units. */
  decimals: number
  codeHash: Hex
  codeBytes: number
  /**
   * The on-chain code is exactly the build this page deploys, with the owner and usdc read above
   * written into every one of their immutable slots: the owner shown is the key the vault obeys.
   */
  knownBuild: boolean
  /** dailyCap - spentToday, floored at 0; null when dailyCap is 0 (no cap). */
  remainingToday: bigint | null
  /** The next 00:00 UTC in chain time, UNIX seconds. */
  resetsAt: bigint
  /** The key has an expiry and chain time is past it. */
  expired: boolean
}

export type ReadFailureKind = 'bad_address' | 'no_usdc' | 'no_contract' | 'not_a_vault' | 'wrong_chain' | 'unreachable'
export type ReadFailure = { kind: ReadFailureKind; reason: string; at: string }
export type ReadResult<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure }

const failed = <T>(kind: ReadFailureKind, reason: string): ReadResult<T> => ({ ok: false, failure: { kind, reason, at: new Date().toISOString() } })

export const READ_FAILURE_TITLE: Record<ReadFailureKind, string> = {
  bad_address: 'That is not an EVM address',
  no_usdc: 'The registry lists no USDC for this network',
  no_contract: 'No contract at that address on this network',
  not_a_vault: 'This contract does not answer like an AgentSpendPolicy vault',
  wrong_chain: 'An RPC answered for a different chain',
  unreachable: 'No RPC answered',
}

export const READ_FAILURE_NEXT: Record<ReadFailureKind, string> = {
  bad_address: 'A vault address is 0x followed by 40 hexadecimal characters. Paste it again.',
  no_usdc: 'This page reads Arc vaults only. Pick Arc Mainnet or Arc testnet.',
  no_contract:
    'Check the network: a vault on Arc testnet does not exist on Arc Mainnet, and the other way round. A vault deployed seconds ago may need one more read.',
  not_a_vault: 'Paste the vault contract address, not the owner, the operator or the USDC contract.',
  wrong_chain: 'Nothing was read from that host. Press Refresh; if it persists, the registry entry for this chain needs a look.',
  unreachable: 'Check your connection, then press Refresh. Nothing is shown in place of the values until a read succeeds.',
}

/**
 * Read one vault live, every value pinned to one block on one host. By default that block is the
 * host's latest. With `blockNumber`, every value is read AT that block (a host that has not
 * reached it is skipped), which is how a write's effect is read back at its receipt's block;
 * `preferHost` is asked first, the host that returned the receipt.
 */
export async function readVault(
  chain: Chain,
  address: string,
  opts: { blockNumber?: bigint; preferHost?: string } = {},
): Promise<ReadResult<VaultSnapshot>> {
  if (!isAddress(address.trim(), { strict: false })) return failed('bad_address', 'the text is not 0x followed by 40 hexadecimal characters')
  const vault = getAddress(address.trim())
  const usdc = usdcOf(chain)
  if (!usdc) return failed('no_usdc', `${chain.name} has no USDC entry in the registry`)
  const tried: string[] = []
  let lastReason = ''
  const urls = [...rpcUrls(chain)]
  if (opts.preferHost) urls.sort((a, b) => Number(hostOf(b) === opts.preferHost) - Number(hostOf(a) === opts.preferHost))
  for (const url of urls) {
    const host = hostOf(url)
    tried.push(host)
    const client = clientFor(chain, url)
    try {
      const id = await client.getChainId()
      if (id !== chain.chainId) {
        lastReason = `${host} answered for chain ${id}, not ${chain.chainId}`
        continue
      }
      const latest = await client.getBlock({ blockTag: 'latest' })
      if (opts.blockNumber !== undefined && latest.number < opts.blockNumber) {
        lastReason = `${host} is at block ${latest.number}, not yet at ${opts.blockNumber}`
        continue
      }
      const head = opts.blockNumber === undefined || latest.number === opts.blockNumber ? latest : await client.getBlock({ blockNumber: opts.blockNumber })
      const blockNumber = head.number
      const code = await client.getCode({ address: vault, blockNumber })
      if (!code || code === '0x') return failed('no_contract', `${host} has no code at ${vault} at block ${blockNumber}`)
      const at = { address: vault, abi: AGENT_SPEND_POLICY_ABI, blockNumber } as const
      let views
      try {
        views = await Promise.all([
          client.readContract({ ...at, functionName: 'owner' }),
          client.readContract({ ...at, functionName: 'operator' }),
          client.readContract({ ...at, functionName: 'usdc' }),
          client.readContract({ ...at, functionName: 'dailyCap' }),
          client.readContract({ ...at, functionName: 'autoApproveMax' }),
          client.readContract({ ...at, functionName: 'frozen' }),
          client.readContract({ ...at, functionName: 'allowlistEnabled' }),
          client.readContract({ ...at, functionName: 'sessionKeyExpiry' }),
          client.readContract({ ...at, functionName: 'today' }),
          client.readContract({ ...at, functionName: 'spentToday' }),
          client.readContract({ ...at, functionName: 'balance' }),
        ] as const)
      } catch (e) {
        if (isContractAnswer(e)) return failed('not_a_vault', 'one of its views reverted or returned nothing, so it is not an AgentSpendPolicy vault')
        throw e
      }
      const [ownerRaw, operator, tokenRaw, dailyCap, autoApproveMax, frozen, allowlistEnabled, sessionKeyExpiry, today, spentToday, balance] = views
      const owner = getAddress(ownerRaw)
      const token = getAddress(tokenRaw)
      const remainingToday = dailyCap === 0n ? null : dailyCap > spentToday ? dailyCap - spentToday : 0n
      return {
        ok: true,
        data: {
          network: chain.caip2,
          chainId: chain.chainId as number,
          address: vault,
          host,
          block: blockNumber,
          chainTime: head.timestamp,
          readAt: new Date().toISOString(),
          owner,
          operator: getAddress(operator),
          usdc: token,
          usdcMatches: sameAddress(token, usdc.address),
          dailyCap,
          autoApproveMax,
          frozen,
          allowlistEnabled,
          sessionKeyExpiry,
          today,
          spentToday,
          balance,
          decimals: usdc.decimals,
          codeHash: keccak256(code),
          codeBytes: (code.length - 2) / 2,
          // The owner() and usdc() it just answered, written into every slot of each: a copy
          // whose owner() reads one key while onlyOwner checks another is not this build.
          knownBuild: isKnownBuild(code, AGENT_SPEND_POLICY_RUNTIME, AGENT_SPEND_POLICY_IMMUTABLES, { owner, usdc: token }),
          remainingToday,
          resetsAt: (today + 1n) * 86400n,
          expired: sessionKeyExpiry !== 0n && head.timestamp > sessionKeyExpiry,
        },
      }
    } catch (e) {
      lastReason = `${host}: ${shortReason(e)}`
    }
  }
  if (lastReason.includes('answered for chain')) return failed('wrong_chain', lastReason)
  return failed('unreachable', `tried ${tried.join(', ')}${lastReason ? `; last: ${lastReason}` : ''}`)
}

/** The chain's latest block: its number, its time and its base fee. */
export async function readHead(chain: Chain): Promise<{ block: bigint; time: bigint; baseFeePerGas: bigint | null; host: string }> {
  const { value, host } = await onFirstHost(chain, (c) => c.getBlock({ blockTag: 'latest' }))
  return { block: value.number, time: value.timestamp, baseFeePerGas: value.baseFeePerGas ?? null, host }
}

/** The native balance (18 decimals on Arc: the same USDC that pays gas), or null when no host answered. */
export async function readNativeBalance(chain: Chain, address: string): Promise<bigint | null> {
  if (!isAddress(address)) return null
  try {
    return (await onFirstHost(chain, (c) => c.getBalance({ address: getAddress(address) }))).value
  } catch {
    return null
  }
}

/** The registry USDC's ERC-20 balance for an address, in its 6-decimal units. */
export async function readUsdcBalance(chain: Chain, address: string): Promise<bigint | null> {
  const usdc = usdcOf(chain)
  if (!usdc || !isAddress(address)) return null
  try {
    return (await onFirstHost(chain, (c) => c.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(address)] }))).value
  } catch {
    return null
  }
}

/**
 * The USDC contract's own symbol and decimals, read live and checked against the registry,
 * failing closed: a mismatch would make every amount on the page wrong by a power of ten.
 */
export async function readUsdcFacts(chain: Chain): Promise<{ ok: true; symbol: string; decimals: number } | { ok: false; reason: string }> {
  const usdc = usdcOf(chain)
  if (!usdc) return { ok: false, reason: `${chain.name} has no USDC entry in the registry.` }
  try {
    const { value } = await onFirstHost(chain, (c) =>
      Promise.all([
        c.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'symbol' }),
        c.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'decimals' }),
      ]),
    )
    const [symbol, decimals] = value
    if (Number(decimals) !== usdc.decimals)
      return { ok: false, reason: `The USDC contract reports ${decimals} decimals and the registry says ${usdc.decimals}. Refusing to move money until they agree.` }
    if (symbol !== 'USDC') return { ok: false, reason: `The registry's USDC contract reports the symbol "${symbol}". Refusing to move money until that is explained.` }
    return { ok: true, symbol, decimals: Number(decimals) }
  } catch (e) {
    return { ok: false, reason: `The USDC contract could not be read: ${shortReason(e)}` }
  }
}

/** allowed(payee) on the vault, live; null when no host answered. */
export async function readAllowed(chain: Chain, vault: string, payee: string): Promise<{ allowed: boolean; block: bigint; host: string } | null> {
  if (!isAddress(vault) || !isAddress(payee)) return null
  try {
    const { value, host } = await onFirstHost(chain, async (c) => {
      const head = await c.getBlock({ blockTag: 'latest' })
      const allowed = await c.readContract({
        address: getAddress(vault),
        abi: AGENT_SPEND_POLICY_ABI,
        functionName: 'allowed',
        args: [getAddress(payee)],
        blockNumber: head.number,
      })
      return { allowed, block: head.number }
    })
    return { ...value, host }
  } catch {
    return null
  }
}

/** The code at an address on the first host that answers; '0x' when there is none, null when no host answered. */
export async function readCode(chain: Chain, address: string): Promise<Hex | null> {
  if (!isAddress(address)) return null
  try {
    return ((await onFirstHost(chain, (c) => c.getCode({ address: getAddress(address) }))).value ?? '0x') as Hex
  } catch {
    return null
  }
}

/** An account's nonce ('latest' counts mined transactions only), or null when no host answered. */
export async function readNonce(chain: Chain, address: string, blockTag: 'latest' | 'pending'): Promise<number | null> {
  if (!isAddress(address)) return null
  try {
    return (await onFirstHost(chain, (c) => c.getTransactionCount({ address: getAddress(address), blockTag }))).value
  } catch {
    return null
  }
}

/** The fee fields a transaction was actually sent with, from the first host that has it. */
export type SentTx = {
  from: Address
  nonce: number
  chainId: number | null
  maxFeePerGas: bigint | null
  maxPriorityFeePerGas: bigint | null
  gasPrice: bigint | null
  gas: bigint
  to: Address | null
  host: string
}

export async function readTransaction(chain: Chain, hash: Hex): Promise<SentTx | null> {
  for (const url of rpcUrls(chain)) {
    try {
      const tx = await clientFor(chain, url).getTransaction({ hash })
      return {
        from: getAddress(tx.from),
        nonce: tx.nonce,
        chainId: typeof tx.chainId === 'number' ? tx.chainId : null,
        maxFeePerGas: tx.maxFeePerGas ?? null,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
        gasPrice: tx.gasPrice ?? null,
        gas: tx.gas,
        to: tx.to ? getAddress(tx.to) : null,
        host: hostOf(url),
      }
    } catch (e) {
      if (e instanceof TransactionNotFoundError) continue
    }
  }
  return null
}

export type ReceiptPoll =
  | { found: true; receipt: TransactionReceipt; host: string; answered: number; total: number }
  | { found: false; answered: number; total: number }

/**
 * Ask EVERY host for the receipt at once; the first receipt found decides. A host saying
 * "not found" decides nothing, and neither does a host that did not answer: they only count
 * toward how many hosts were asked.
 */
export async function pollReceipt(chain: Chain, hash: Hex): Promise<ReceiptPoll> {
  const urls = rpcUrls(chain)
  const r = await firstFound(
    urls.map((url) => clientFor(chain, url).getTransactionReceipt({ hash })),
    (e) => e instanceof TransactionReceiptNotFoundError,
  )
  return r.found ? { found: true, receipt: r.value, host: hostOf(urls[r.index]), answered: r.answered, total: r.total } : r
}

// --- what a receipt carries ---

/**
 * Every log in the receipt that decodes as one of the vault's events or as an ERC-20 Transfer,
 * with the address that emitted it. Which of them a write needed is tx-rules.ts's question.
 */
export function decodeLogs(receipt: TransactionReceipt): DecodedLog[] {
  const shape = (l: { address: string; eventName: string; args: unknown }): DecodedLog => ({
    address: l.address,
    eventName: l.eventName,
    args: (l.args ?? {}) as Record<string, unknown>,
  })
  return [
    ...parseEventLogs({ abi: AGENT_SPEND_POLICY_ABI, logs: receipt.logs }).map(shape),
    ...parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).map(shape),
  ]
}

/** Which expectations the receipt does NOT meet, as plain descriptions. Empty means all met. */
export function missingFromReceipt(receipt: TransactionReceipt, expect: readonly Expectation[]): string[] {
  return missingFrom(decodeLogs(receipt), expect)
}

// --- formatting ---

/** "14:02:11" in the viewer's own clock. */
export { localTime, localDateTime, viewerTimeZone } from '../stellar/vault-read'

/** UNIX seconds as "2026-11-08 14:02 UTC". */
export function utcDateTime(unixSeconds: bigint): string {
  const d = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(d.getTime())) return String(unixSeconds)
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** "0x1234...abcd". */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a
}
