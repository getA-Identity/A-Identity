/**
 * Live reads of an AgentSpendPolicy vault on Arc, straight from the chain, for /app/vault/arc.
 *
 * No backend sits between the page and the chain: every read goes to the RPCs the registry
 * lists (CHAIN_RPC_URLS in the generated src/lib/chains.ts), and nothing here types a chain
 * id, a host, an explorer or a token address. One snapshot is read from ONE host at ONE block:
 * the host's latest block is read first, and the code and every view are then read pinned to
 * that block number, so the values on screen describe a single moment and the stamp under them
 * names it. A host that does not answer, or answers for another chain, passes the snapshot to the
 * next host in registry order. So does one host saying there is no code or no vault, which may only
 * mean it is behind or broken: that verdict takes two hosts (agreedAbsence, hosts.ts).
 *
 * A receipt is different: one host returning null proves nothing on Arc (on 2026-10-11 one of
 * the four mainnet hosts returned none of 19 receipts that exist), so a receipt is asked of
 * every host at once and the first one found decides. A write's effect is then read back pinned
 * to the receipt's own block, on the host that returned the receipt first, so a host one block
 * behind cannot make a landed write look as if it did nothing.
 *
 * When the browser reaches none of those RPCs (most often Brave Shields, an ad blocker, a VPN or a
 * filtering DNS), a wallet that holds an account on this page is asked after them, as one more host
 * for a snapshot, a balance or a simulation: its own node answers the same calls, and it is asked its
 * chain id first like every other host, so a wallet on another network is never read as this one. Its
 * answers are stamped "your wallet", never a registry host, and only an answer it HAS counts: its "no
 * code here" never makes two hosts agree that a vault is absent.
 *
 * A receipt or a transaction is stricter still, because "nobody has it" can end a watch with
 * "replaced": the registry's hosts alone say how many answered. The wallet is asked only on a check
 * where every one of them failed without an HTTP answer, and it can only add a receipt or a
 * transaction it has. So while the RPCs answer, a receipt check sends the wallet nothing, and a
 * locked wallet that would open a window for such a read is never woken by this page.
 *
 * A failed read is a result, not an exception, and it carries when and why it failed, so the
 * page can say so instead of showing the previous numbers as if they were current. Every runtime
 * import is named with its .ts extension, so the suite in mcp/src loads this file straight from
 * src/ and drives it against a fake network.
 */
import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  custom,
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
import { CHAIN_BY_ID, CHAIN_RPC_URLS, CHAIN_USDC, type Chain } from '../chains.ts'
import { AGENT_SPEND_POLICY_ABI, AGENT_SPEND_POLICY_IMMUTABLES, AGENT_SPEND_POLICY_RUNTIME } from '../contracts/agent-spend-policy.ts'
import type { Eip1193 } from '../evm-chain'
import { BLOCKED_TITLE, blockedNext, walletOnlyNext, type WalletReadState } from './deploy-copy.ts'
import { NoHostAnswered, agreedAbsence, isContractAnswer, noneAnswered, onHosts, walletSaidNo } from './hosts.ts'
import { firstFound, heardEnough, missingFrom, type DecodedLog, type Expectation } from './tx-rules.ts'
import { isKnownBuild, readableDate, sameAddress } from './vault-rules.ts'

export { isContractAnswer }
export type { WalletReadState }
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
  if (url === WALLET_URL) return WALLET_HOST
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
    if (url === WALLET_URL) {
      if (!walletProvider) throw new WalletNotAsked('no wallet is connected to read through')
      c = createPublicClient({ chain: viemChainOf(chain), transport: custom(gatedProvider(walletProvider), { retryCount: 0 }) }) as unknown as ArcClient
    } else c = makeClient(chain, url)
    clients.set(key, c)
  }
  return c
}

// --- the connected wallet, asked after the registry's hosts ---

/** How a wallet's node is named in a read stamp and an error. Not a URL, so never a registry host. */
export const WALLET_HOST = 'your wallet'
/** The pseudo URL that stands for the wallet in a host list. clientFor and hostOf know it. */
const WALLET_URL = 'wallet:connected'
/** After every registry host failed without an answer and the wallet answered, the wallet is asked first on that chain for this long. */
const WALLET_FIRST_MS = 60_000

let walletProvider: Eip1193 | null = null
/**
 * A phone wallet over WalletConnect. Its reads are not relayed to the phone: they leave from this
 * page for the registry's own first host, so a read no registry host answered is never asked of it.
 * It is kept only so the page can say why connecting it did not help.
 */
let walletRelays = false
/** The wallet said no to a read (walletSaidNo): it is not asked again until it or its account changes. */
let walletRefused = false
/** Per chain id: until when the wallet is asked first. */
const walletFirstUntil = new Map<string, number>()

/** A wallet read that was never sent: the wallet was forgotten, or it said no to an earlier read. */
class WalletNotAsked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WalletNotAsked'
  }
}

/**
 * The wallet's provider, used for reads only, and only while the wallet hook holds an account from
 * it: a locked wallet, or one this site is not connected to, can open its own Unlock or Connect
 * window for a read, so it is never registered. Set again whenever the wallet or its account
 * changes, which is also what lets a wallet that said no be asked again.
 */
export function setWalletReadProvider(p: Eip1193 | null, o: { walletConnect?: boolean } = {}): void {
  const relays = Boolean(p && o.walletConnect)
  if (p === walletProvider && relays === walletRelays) return
  walletProvider = p
  walletRelays = relays
  walletRefused = false
  walletFirstUntil.clear()
  for (const key of [...clients.keys()]) if (key.endsWith(`|${WALLET_URL}`)) clients.delete(key)
}

/** Clears the wallet only if it is still `p`, so one page unmounting never drops another's wallet. */
export function clearWalletReadProvider(p: Eip1193): void {
  if (walletProvider === p) setWalletReadProvider(null)
}

/** True when a read may be sent to the wallet at all. */
function walletAskable(): boolean {
  return walletProvider !== null && !walletRelays && !walletRefused
}

/**
 * A wallet request that gives up after the same time an RPC does, so a sleeping phone wallet cannot
 * hang a read. The timer is cleared however the request ends, a provider that throws at once included.
 */
export function timedProvider(p: Eip1193): Eip1193 {
  return {
    request: (a) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`your wallet did not answer ${a.method} within ${RPC_TIMEOUT_MS / 1000} seconds`)), RPC_TIMEOUT_MS)
        let sent: Promise<unknown>
        try {
          sent = Promise.resolve(p.request(a))
        } catch (e) {
          clearTimeout(t)
          reject(e)
          return
        }
        sent.then(
          (v) => {
            clearTimeout(t)
            resolve(v)
          },
          (e) => {
            clearTimeout(t)
            reject(e)
          },
        )
      }),
  }
}

/**
 * The wallet as a read host: nothing is sent once it was forgotten or said no to a read, and a "no"
 * (4100, 4001, locked) stops every later read until the wallet or its account changes.
 */
function gatedProvider(p: Eip1193): Eip1193 {
  const timed = timedProvider(p)
  return {
    request: async (a) => {
      if (walletProvider !== p) throw new WalletNotAsked('your wallet is no longer connected to this page')
      if (walletRefused) throw new WalletNotAsked('your wallet said no to an earlier read, so it is not asked again until it or its account changes')
      try {
        return await timed.request(a)
      } catch (e) {
        if (walletProvider === p && walletSaidNo(e)) walletRefused = true
        throw e
      }
    },
  }
}

/**
 * Every place this page reads a snapshot, a balance or a simulation from: the registry's RPCs in
 * order, then the wallet, when one may be asked. On a chain where every registry host failed without
 * an answer a moment ago and the wallet answered, the wallet goes first for a minute, so a blocked
 * browser does not wait on four dead hosts for every read. Receipts and transactions do not use this
 * list: see pollReceipt.
 */
export function readUrls(chain: Chain): readonly string[] {
  const urls = rpcUrls(chain)
  if (!walletAskable()) return urls
  return Date.now() < (walletFirstUntil.get(chain.id) ?? 0) ? [WALLET_URL, ...urls] : [...urls, WALLET_URL]
}

/** True when `host` is the wallet's node rather than a registry RPC. */
export function isWalletHost(host: string): boolean {
  return host === WALLET_HOST
}

/** Every registry host failed, and not one of them with an HTTP answer that reached this page. */
function noRegistryAnswer(chain: Chain, failures: readonly { host?: string; error: unknown }[]): boolean {
  const registry = failures.filter((f) => f.host === undefined || !isWalletHost(f.host))
  return registry.length === rpcUrls(chain).length && noneAnswered(registry)
}

/**
 * The wallet answered a read that every registry host failed without an answer: on this chain it is
 * asked first for a minute. A registry host that answered anything (a 429 included) keeps them first.
 */
function noteWalletAnswered(chain: Chain, host: string, failures: readonly { host: string; error: unknown }[]): void {
  if (isWalletHost(host) && noRegistryAnswer(chain, failures)) walletFirstUntil.set(chain.id, Date.now() + WALLET_FIRST_MS)
}

/**
 * One lookup through the wallet, for a check on which every registry host failed without an HTTP
 * answer. It is asked its chain id first, and only an answer it HAS comes back: a wallet that has
 * nothing, is on another network, said no or failed gives null, which says nothing about the chain
 * and never counts as a host that answered.
 */
async function walletHas<T>(chain: Chain, ask: (c: ArcClient) => Promise<T>): Promise<T | null> {
  if (!walletAskable()) return null
  try {
    const c = clientFor(chain, WALLET_URL)
    if ((await c.getChainId()) !== chain.chainId) return null
    return await ask(c)
  } catch {
    return null
  }
}

export class RpcUnreachableError extends Error {
  readonly hosts: string[]
  /**
   * Every registry RPC failed and no HTTP answer from any of them reached this page: most often
   * something in the browser stopped the requests, and a lost connection looks the same. The message
   * then names only the hosts, never the last error, which may be a wallet's words ("reverted").
   */
  readonly blocked: boolean
  readonly wallet: WalletReadState
  constructor(chain: Chain, hosts: string[], reason: string, opts: { blocked?: boolean; wallet?: WalletReadState } = {}) {
    const blocked = opts.blocked ?? false
    super(
      blocked
        ? `No ${networkName(chain)} network node answered this page (${hosts.filter((h) => !isWalletHost(h)).join(', ')}).`
        : `No ${networkName(chain)} RPC answered (${hosts.join(', ')})${reason ? `: ${reason}` : ''}.`,
    )
    this.name = 'RpcUnreachableError'
    this.hosts = hosts
    this.blocked = blocked
    this.wallet = opts.wallet ?? 'none'
  }
}

/** True when `e` is, or was caused by, a wallet read that was never sent (viem wraps it). */
function notAsked(e: unknown): boolean {
  let x = e as { cause?: unknown } | null | undefined
  for (let i = 0; i < 12 && x && typeof x === 'object'; i += 1) {
    if (x instanceof WalletNotAsked) return true
    x = x.cause as { cause?: unknown } | null | undefined
  }
  return false
}

/** What became of the wallet on a read that failed, from its own failure if it was asked. */
function walletStateOf(failures: readonly { host: string; error: unknown }[]): WalletReadState {
  if (walletProvider && walletRelays) return 'walletconnect'
  const mine = failures.find((f) => isWalletHost(f.host))
  if (!mine) return walletProvider && walletRefused ? 'failed' : 'none'
  // Forgotten while the read was under way: there is no wallet now.
  if (notAsked(mine.error) && !walletProvider) return 'none'
  return mine.error instanceof Error && /answered for chain/.test(mine.error.message) ? 'other_chain' : 'failed'
}

/** Whether no registry host's answer reached this page at all, and what the wallet did, from each host's failure. */
function judgeFailures(chain: Chain, failures: readonly { host: string; error: unknown }[]): { blocked: boolean; wallet: WalletReadState } {
  return { blocked: noRegistryAnswer(chain, failures), wallet: walletStateOf(failures) }
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
  const hosts = readUrls(chain).map((url) => ({ host: hostOf(url), client: clientFor(chain, url) }))
  try {
    const r = await onHosts(
      hosts,
      {
        chainId: chain.chainId as number,
        askChainId: (c) => c.getChainId(),
        isFinal: (e) => isContractAnswer(e) || (!(e instanceof BaseError) && !(e instanceof TypeError)),
      },
      fn,
    )
    noteWalletAnswered(chain, r.host, r.failures)
    return { value: r.value, host: r.host }
  } catch (e) {
    if (e instanceof NoHostAnswered) {
      const judged = judgeFailures(chain, e.failures)
      throw new RpcUnreachableError(chain, e.tried, e.last ? shortReason(e.last) : '', judged)
    }
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

export type ReadFailureKind = 'bad_address' | 'no_usdc' | 'no_contract' | 'not_a_vault' | 'wrong_chain' | 'unreachable' | 'blocked'
/**
 * `wallet` is set on 'blocked': what the wallet did on the same read, which decides the way through.
 * `walletOnly` is set on 'unreachable' when no registry host's answer reached the page and only the
 * wallet answered, with no vault: one node's word, which the reason names and nothing decides on.
 */
export type ReadFailure = { kind: ReadFailureKind; reason: string; at: string; wallet?: WalletReadState; walletOnly?: boolean }
export type ReadResult<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure }

const failed = <T>(kind: ReadFailureKind, reason: string, more: { wallet?: WalletReadState; walletOnly?: boolean } = {}): ReadResult<T> => ({
  ok: false,
  failure: { kind, reason, at: new Date().toISOString(), ...more },
})

export const READ_FAILURE_TITLE: Record<ReadFailureKind, string> = {
  bad_address: 'That is not an EVM address',
  no_usdc: 'The registry lists no USDC for this network',
  no_contract: 'No contract at that address on this network',
  not_a_vault: 'This contract does not answer like an AgentSpendPolicy vault',
  wrong_chain: 'An RPC answered for a different chain',
  unreachable: 'The network did not answer',
  blocked: BLOCKED_TITLE,
}

export const READ_FAILURE_NEXT: Record<ReadFailureKind, string> = {
  bad_address: 'A vault address is 0x followed by 40 hexadecimal characters. Paste it again.',
  no_usdc: 'This page reads Arc vaults only. Pick Arc Mainnet or Arc testnet.',
  no_contract:
    'Check the network: a vault on Arc testnet does not exist on Arc Mainnet, and the other way round. A vault deployed seconds ago may need one more read.',
  not_a_vault: 'Paste the vault contract address, not the owner, the operator or the USDC contract.',
  wrong_chain: 'Nothing was read from that host. Press Refresh; if it persists, the registry entry for this chain needs a look.',
  unreachable:
    'This says nothing about the vault: network nodes limit how fast a page can ask, and they may be busy. This page tries again by itself, and Refresh does the same. Nothing is shown in place of the values until a read succeeds.',
  // Shown through readFailureNext, which knows what the wallet did: this is the case with no wallet.
  blocked: blockedNext('none', 'press Refresh'),
}

/** The title of a failed read: one only the wallet answered is said as that, not as no answer at all. */
export function readFailureTitle(f: Pick<ReadFailure, 'kind' | 'walletOnly'>): string {
  return f.kind === 'unreachable' && f.walletOnly ? 'Only your wallet answered' : READ_FAILURE_TITLE[f.kind]
}

/**
 * The next step for a failed read. One no network node answered depends on what the wallet did on
 * that read, and `again` says how this page tries again where the person reads it.
 */
export function readFailureNext(f: Pick<ReadFailure, 'kind' | 'wallet' | 'walletOnly'>, again: string): string {
  if (f.kind === 'blocked') return blockedNext(f.wallet ?? 'none', again)
  if (f.kind === 'unreachable' && f.walletOnly) return walletOnlyNext(again)
  return READ_FAILURE_NEXT[f.kind]
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
  const said: { kind: 'no_contract' | 'not_a_vault'; reason: string }[] = []
  // Hosts that answered for this chain: a chain id that matched, then any answer at all, "no code"
  // and "not yet at that block" included. One of them is enough to say this browser is not blocked.
  const answered: string[] = []
  let walletSaid = ''
  let lastReason = ''
  const fails: { host: string; error: unknown }[] = []
  let wrongChain: string | null = null
  // Only the registry's hosts can agree that a vault is absent: the wallet adds only a vault it has.
  const registryCount = rpcUrls(chain).length
  const urls = [...readUrls(chain)]
  if (opts.preferHost) urls.sort((a, b) => Number(hostOf(b) === opts.preferHost) - Number(hostOf(a) === opts.preferHost))
  for (const url of urls) {
    const host = hostOf(url)
    const viaWallet = isWalletHost(host)
    tried.push(host)
    try {
      // Inside the try: a wallet forgotten while earlier hosts were asked is one more host that failed.
      const client = clientFor(chain, url)
      const id = await client.getChainId()
      if (id !== chain.chainId) {
        lastReason = `${host} answered for chain ${id}, not ${chain.chainId}`
        // A wallet on another network is the person's choice, not a fault in the registry's entry.
        if (!viaWallet) wrongChain = lastReason
        fails.push({ host, error: new Error(lastReason) })
        continue
      }
      const latest = await client.getBlock({ blockTag: 'latest' })
      if (opts.blockNumber !== undefined && latest.number < opts.blockNumber) {
        lastReason = `${host} is at block ${latest.number}, not yet at ${opts.blockNumber}`
        answered.push(host)
        if (viaWallet) walletSaid = lastReason
        continue
      }
      const head = opts.blockNumber === undefined || latest.number === opts.blockNumber ? latest : await client.getBlock({ blockNumber: opts.blockNumber })
      const blockNumber = head.number
      const code = await client.getCode({ address: vault, blockNumber })
      if (!code || code === '0x') {
        lastReason = `${host} has no code at ${vault} at block ${blockNumber}`
        answered.push(host)
        if (viaWallet) walletSaid = lastReason
        if (viaWallet) continue
        said.push({ kind: 'no_contract', reason: lastReason })
        const agreed = agreedAbsence(said, registryCount)
        if (agreed) return failed(agreed.kind, agreed.reason)
        continue
      }
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
        if (!isContractAnswer(e)) throw e
        lastReason = `${host}: one of its views reverted or returned nothing`
        answered.push(host)
        if (viaWallet) walletSaid = lastReason
        if (viaWallet) continue
        said.push({ kind: 'not_a_vault', reason: 'one of its views reverted or returned nothing, so it is not an AgentSpendPolicy vault' })
        const agreed = agreedAbsence(said, registryCount)
        if (agreed) return failed(agreed.kind, agreed.reason)
        continue
      }
      // A wallet can change network while it is read, and then every later call was answered by the
      // other chain: its snapshot is kept only if it still answers for this one.
      if (viaWallet) {
        const after = await client.getChainId()
        if (after !== chain.chainId) {
          lastReason = `${host} answered for chain ${after}, not ${chain.chainId}, by the end of the read`
          fails.push({ host, error: new Error(lastReason) })
          continue
        }
      }
      const [ownerRaw, operator, tokenRaw, dailyCap, autoApproveMax, frozen, allowlistEnabled, sessionKeyExpiry, today, spentToday, balance] = views
      const owner = getAddress(ownerRaw)
      const token = getAddress(tokenRaw)
      noteWalletAnswered(chain, host, fails)
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
      fails.push({ host, error: e })
    }
  }
  if (wrongChain) return failed('wrong_chain', wrongChain)
  // Blocked only when no host gave any answer at all: one that answered, the wallet included, shows
  // this browser does reach the network, and what it said is named.
  const judged = judgeFailures(chain, fails)
  if (judged.blocked) {
    const registry = tried.filter((h) => !isWalletHost(h)).join(', ')
    // Every registry host failed unanswered, so whoever answered was the wallet: one node's word,
    // which never says a vault is absent, so it is named and the page reads again.
    if (answered.length)
      return failed('unreachable', `tried ${registry}; no answer from any of them reached this page, and only your wallet answered: ${walletSaid}`, { walletOnly: true })
    const mine = fails.find((f) => isWalletHost(f.host))
    const wallet = judged.wallet === 'other_chain' && mine ? `; ${shortReason(mine.error)}` : judged.wallet === 'failed' ? '; your wallet could not read for this page either' : ''
    return failed('blocked', `tried ${registry}; no answer from any of them reached this page${wallet}`, { wallet: judged.wallet })
  }
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
export async function readUsdcFacts(
  chain: Chain,
): Promise<{ ok: true; symbol: string; decimals: number } | { ok: false; reason: string; noAnswer?: boolean; blocked?: boolean; wallet?: WalletReadState }> {
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
    // No host answering says nothing about the contract, or about what the person typed.
    return {
      ok: false,
      reason: `The USDC contract could not be read: ${shortReason(e)}`,
      noAnswer: e instanceof RpcUnreachableError,
      blocked: e instanceof RpcUnreachableError && e.blocked,
      ...(e instanceof RpcUnreachableError && e.blocked ? { wallet: e.wallet } : {}),
    }
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

/** A transaction as this page keeps it, from the host that returned it. */
function sentOf(tx: Awaited<ReturnType<ArcClient['getTransaction']>>, host: string): SentTx {
  return {
    from: getAddress(tx.from),
    nonce: tx.nonce,
    chainId: typeof tx.chainId === 'number' ? tx.chainId : null,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
    gasPrice: tx.gasPrice ?? null,
    gas: tx.gas,
    to: tx.to ? getAddress(tx.to) : null,
    host,
  }
}

/**
 * The transaction from the first host that has it; null when enough hosts answered and none does;
 * undefined when too few answered to say. A host that errored or was rate limited said nothing.
 * Only the registry's hosts are counted. The wallet is asked only when every one of them failed
 * without an HTTP answer, and only a transaction it has is taken: its "not found" says nothing.
 */
export async function readTransaction(chain: Chain, hash: Hex): Promise<SentTx | null | undefined> {
  const urls = rpcUrls(chain)
  let answered = 0
  const failures: { error: unknown }[] = []
  for (const url of urls) {
    try {
      return sentOf(await clientFor(chain, url).getTransaction({ hash }), hostOf(url))
    } catch (e) {
      if (e instanceof TransactionNotFoundError) answered += 1
      else failures.push({ error: e })
    }
  }
  if (answered === 0 && noRegistryAnswer(chain, failures)) {
    const mine = await walletHas(chain, (c) => c.getTransaction({ hash }))
    if (mine) return sentOf(mine, WALLET_HOST)
  }
  return heardEnough(answered, urls.length) ? null : undefined
}

export type ReceiptPoll =
  | { found: true; receipt: TransactionReceipt; host: string; answered: number; total: number }
  | { found: false; answered: number; total: number }

/**
 * Ask EVERY registry host for the receipt at once; the first receipt found decides. A host saying
 * "not found" decides nothing, and neither does a host that did not answer: they only count toward
 * how many hosts were asked, and only the registry's hosts are counted, so `total` is always their
 * number. The wallet is asked only on a check where every one of them failed without an HTTP answer,
 * after its chain id matched, and only a receipt it has is taken: its "not found" is never an answer.
 */
export async function pollReceipt(chain: Chain, hash: Hex): Promise<ReceiptPoll> {
  const urls = rpcUrls(chain)
  const failures: { error: unknown }[] = []
  const r = await firstFound(
    urls.map((url) =>
      clientFor(chain, url)
        .getTransactionReceipt({ hash })
        .catch((e: unknown) => {
          failures.push({ error: e })
          throw e
        }),
    ),
    (e) => e instanceof TransactionReceiptNotFoundError,
  )
  if (r.found) return { found: true, receipt: r.value, host: hostOf(urls[r.index]), answered: r.answered, total: r.total }
  if (noRegistryAnswer(chain, failures)) {
    const mine = await walletHas(chain, (c) => c.getTransactionReceipt({ hash }))
    if (mine) return { found: true, receipt: mine, host: WALLET_HOST, answered: r.answered, total: r.total }
  }
  return r
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
export { localTime, localDateTime, viewerTimeZone } from '../local-time.ts'

/** UNIX seconds as "2026-11-08 14:02 UTC". */
export function utcDateTime(unixSeconds: bigint): string {
  const d = readableDate(unixSeconds)
  if (d === null) return String(unixSeconds)
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** "0x1234...abcd". */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a
}
