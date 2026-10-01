/**
 * "Before you pay" on an EVM chain we settle on: is this the real dollar, and who gets paid?
 *
 * Two questions an agent (or a person) should have answered before signing a payment on
 * Robinhood Chain or Arbitrum One, answered from the live chain only:
 *
 *   1. Is this token the dollar this chain actually settles in? Robinhood Chain's explorer
 *      lists hundreds of contracts that call themselves "Global Dollar" or "USDG", some with
 *      six-figure holder counts from airdrop spam. A symbol is not an identity. The answer
 *      comes from the address the registry names (the one the issuer documents) plus a live
 *      proof that its EIP-712 signing domain reproduces the token's own DOMAIN_SEPARATOR,
 *      which is the same proof the x402 rail runs before it serves a challenge.
 *   2. Is the payee a registered agent? Read from the chain's canonical ERC-8004 registry.
 *
 * Four inputs, one engine: a token address, a wallet or contract address, an agent id
 * (eip155:<chain>:8004/<n> or #n) and an x402 link, whose 402 challenge is read for the asset
 * it asks for, the domain it tells the buyer to sign against, and who it pays.
 *
 * Chain-generic on purpose, like the rail it guards: a chain gets this check by declaring an
 * identity registry and an eip3009 settlement token in the registry. Nothing here names a
 * chain, a token or an address; all of it is read from the descriptor.
 *
 * Every reason carries a stable machine code (REASON_CODES) and a sentence a person can
 * read. The verdict never says "safe" about something it could not prove: an unprovable
 * domain is "Could not verify", and a registration is labeled as identity, not a review.
 */
import { CHAINS, getChainById } from '../chains/registry.js'
import type { ChainDescriptor, SettlementToken } from '../chains/types.js'
import { addressUrl } from '../chains/explorer.js'
import { EIP3009_ABI } from '../chains/evm/abis.js'
import { evmPublicClient } from '../chains/evm/client.js'
import { provenDomainCached, type DomainResult, type TokenReader } from '../x402-3009/domain.js'
import { safeHttpsGet, type Fetched, type Refused } from './safe-get.js'

export type Verdict = 'safe' | 'careful' | 'dont_pay' | 'unknown'
export type ReasonTone = 'good' | 'warn' | 'bad' | 'neutral'
export type InputKind = 'token' | 'address' | 'agent' | 'x402'

/** Every code a caller can see, with what it means. Stable: agents branch on these. */
export const REASON_CODES = {
  CANONICAL_TOKEN: 'The address is the settlement token the registry names for this chain.',
  DOMAIN_PROVEN: "The token's EIP-712 signing domain reproduces its live DOMAIN_SEPARATOR.",
  DOMAIN_UNVERIFIED: 'The signing domain could not be proven right now, so nothing about it is asserted.',
  NOT_CANONICAL_TOKEN: 'A token that presents itself as the settlement dollar but is not at its address.',
  OTHER_TOKEN: 'A token, but not the dollar this chain settles in.',
  ZERO_ADDRESS: 'The zero address: anything sent there is gone.',
  CONTRACT_ACCOUNT: 'The address is a contract, not a wallet.',
  UNUSED_ADDRESS: 'No transactions, no native balance and no settlement-token balance on this chain.',
  AGENT_OWNER: 'The address holds at least one agent in the chain\'s ERC-8004 identity registry.',
  PAYEE_UNREGISTERED: 'The address holds no agent in the chain\'s ERC-8004 identity registry.',
  REGISTRY_UNREADABLE: 'The identity registry could not be read right now.',
  REGISTERED_AGENT: 'The agent id exists in the chain\'s ERC-8004 identity registry.',
  AGENT_NOT_FOUND: 'No such agent id in the chain\'s ERC-8004 identity registry.',
  CARD_CLAIMS_ID: 'The registration file the agent points to lists this exact agent id back.',
  CARD_DOES_NOT_CLAIM: 'The registration file the agent points to lists registrations, and not this one.',
  CARD_UNCONFIRMED: 'The registration file could not be read or lists no registrations to compare.',
  IDENTITY_NOT_A_REVIEW: 'A registration shows who holds an id. It is not a review of the service.',
  CHALLENGE_CANONICAL_ASSET: 'The 402 challenge asks for the settlement token at its real address.',
  CHALLENGE_WRONG_ASSET: 'The 402 challenge asks for a token that is not the settlement token.',
  DOMAIN_MISMATCH: 'The 402 challenge tells the buyer to sign against a domain the token does not have.',
  CHALLENGE_OTHER_CHAIN: 'The 402 challenge does not ask for payment on this chain.',
} as const
export type ReasonCode = keyof typeof REASON_CODES
export type Reason = { tone: ReasonTone; code: ReasonCode; text: string }

export type CanonicalFacts = {
  symbol: string
  address: string
  explorerUrl: string | null
  domainProven: boolean
  domainName: string | null
  domainVersion: string | null
  domainSeparator: string | null
  provenAt: string | null
  /** Why the proof failed, when it did. */
  unproven: string | null
}

/** How a non-canonical token relates to the settlement dollar. 'impersonation' copies its name AND symbol. */
export type LookalikeTier = 'impersonation' | 'same_symbol' | 'similar'
export type TokenFacts = { address: string; name: string | null; symbol: string | null; decimals: number | null; canonical: boolean; lookalike: boolean; tier: LookalikeTier | null }
export type AccountFacts = {
  isContract: boolean
  nonce: number | null
  nativeBalance: string | null
  settlementBalance: string | null
  agentsHeld: number | null
}
export type AgentFacts = {
  caip: string
  tokenId: string
  owner: string | null
  tokenUri: string | null
  card: 'claims' | 'does_not_claim' | 'unconfirmed' | null
}
export type ChallengeOffer = {
  network: string
  asset: string | null
  payTo: string | null
  amount: string | null
  domainName: string | null
  domainVersion: string | null
}
export type ChallengeFacts = {
  url: string
  x402Version: number | null
  offers: number
  networks: string[]
  onThisChain: ChallengeOffer | null
}

/**
 * Whether the chain is an Arbitrum chain, read from the chain itself: the ArbSys precompile
 * that every Arbitrum chain (One, Nova, and Orbit chains such as Robinhood Chain) carries at
 * 0x64 answers arbChainID(). Null on a chain without it, never guessed from a name.
 */
export type ArbitrumFacts = { arbSys: string; arbChainId: number; matches: boolean }

export type EvmPayCheckResult = {
  query: string
  chain: { id: string; name: string; caip2: string }
  arbitrum: ArbitrumFacts | null
  kind: InputKind
  address: string | null
  verdict: Verdict
  headline: string
  reasons: Reason[]
  canonical: CanonicalFacts
  token: TokenFacts | null
  account: AccountFacts | null
  agent: AgentFacts | null
  challenge: ChallengeFacts | null
  explorerUrl: string | null
  checkedAt: string
}

export type EvmPayCheckError = { error: string; httpStatus: 400 | 404 | 502 }

/** The slice of a viem public client this module reads through. Injectable for tests. */
export type ChainClient = {
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>
  getTransactionCount(args: { address: `0x${string}` }): Promise<number>
  getBalance(args: { address: `0x${string}` }): Promise<bigint>
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>
}

export type EvmPayCheckDeps = {
  client?: ChainClient
  /** One screened GET of a pasted link (see safe-get.ts). Injectable for tests. */
  httpGet?: (url: string, accept: string) => Promise<Fetched | Refused>
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** The chains this check serves: live EVM chains with an identity registry and an EIP-3009 settlement token. */
export function payCheckChains(chains: ChainDescriptor[]): ChainDescriptor[] {
  return chains.filter((c) => c.ecosystem === 'evm' && !c.testnet && c.status === 'live' && !!c.contracts.identityRegistry && !!settlementTokenOf(c))
}

export function settlementTokenOf(chain: ChainDescriptor): SettlementToken | null {
  return chain.settlementTokens?.find((t) => t.authorization === 'eip3009') ?? null
}

// ── input ──────────────────────────────────────────────────────────────────────────────

export type ParsedQuery =
  | { kind: 'agent'; evmChainId: number | null; tokenId: bigint }
  | { kind: 'address'; address: `0x${string}` }
  | { kind: 'x402'; url: string }

/** What was pasted, or null when it is none of the four shapes. Pure. */
export function parseQuery(q: string): ParsedQuery | null {
  const s = q.trim()
  const caip = s.match(/^eip155:(\d{1,12}):8004\/(\d{1,30})$/i)
  if (caip) return { kind: 'agent', evmChainId: Number(caip[1]), tokenId: BigInt(caip[2]) }
  const hash = s.match(/^(?:agent\s*)?#(\d{1,30})$/i)
  if (hash) return { kind: 'agent', evmChainId: null, tokenId: BigInt(hash[1]) }
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: 'address', address: s as `0x${string}` }
  if (/^https:\/\/\S+$/i.test(s)) return { kind: 'x402', url: s }
  return null
}

// ── lookalikes ─────────────────────────────────────────────────────────────────────────

/**
 * Characters that render like Latin letters in a token list. NFKC folds full-width forms;
 * this folds the Cyrillic and Greek letters that NFKC leaves alone, which is what an
 * impostor uses to make "USDG" look right while being a different string.
 */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'һ': 'h', 'і': 'i', 'ј': 'j', 'ӏ': 'l', 'о': 'o', 'р': 'p', 'ѕ': 's', 'ս': 'u', 'х': 'x', 'у': 'y',
  'ɡ': 'g', 'ɢ': 'g', 'ο': 'o', 'υ': 'u', 'ν': 'v', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'τ': 't', 'ᴜ': 'u', 'ꜱ': 's', 'ᴅ': 'd', 'ʟ': 'l',
  '0': 'o', '$': 's',
}

/** Lower-case, fold confusables and drop everything but letters and digits. Pure. */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .split('')
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * How a token relates to the settlement dollar, or null when it does not present itself as it.
 * Pure, and deliberately in tiers, because they call for different words:
 *  - impersonation: its folded name AND symbol equal the real token's. A fake.
 *  - same_symbol: the same symbol under another name. Not the settlement dollar, but it may be
 *    a legitimate different token (Arbitrum's bridged USDC.e is "USD Coin (Arb1)", "USDC"), so
 *    the answer never calls it fake.
 *  - similar: the symbol or name merely contains the real one (steakUSDG, "USDG.e").
 * A decimals match or a working EIP-712 domain proves nothing here: an impersonator can
 * answer eip712Domain() with the real name and version over its own address.
 */
export function lookalikeTier(canonical: { symbol: string; name: string | null }, token: { symbol: string | null; name: string | null }): LookalikeTier | null {
  const z = (s: string) => s.replace(/o/g, '0')
  const cs = z(fold(canonical.symbol))
  const cn = canonical.name ? fold(canonical.name) : ''
  const ts = token.symbol ? z(fold(token.symbol)) : ''
  const tn = token.name ? fold(token.name) : ''
  const sameSymbol = !!cs && ts === cs
  const sameName = !!cn && tn === cn
  if (sameSymbol && (sameName || !cn)) return 'impersonation'
  if (sameSymbol) return 'same_symbol'
  if (sameName) return 'impersonation'
  if (cs && (ts.includes(cs) || z(tn).includes(cs))) return 'similar'
  if (cn && cn.length >= 4 && (tn.includes(cn) || ts.includes(cn))) return 'similar'
  return null
}

/** True when a token presents itself as the settlement dollar in any tier. Pure. */
export function looksLike(canonical: { symbol: string; name: string | null }, token: { symbol: string | null; name: string | null }): boolean {
  return lookalikeTier(canonical, token) !== null
}

// ── small helpers ──────────────────────────────────────────────────────────────────────

const ZERO = '0x0000000000000000000000000000000000000000'
/** ArbSys, the Arbitrum system precompile. Part of the Arbitrum protocol, not of any one chain. */
const ARBSYS = '0x0000000000000000000000000000000000000064'
const ARBSYS_ABI = [{ type: 'function', name: 'arbChainID', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const

const BALANCE_OF_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const
const TOKEN_META_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const
const AGENT_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

function units(v: bigint, decimals: number): string {
  const neg = v < 0n
  const x = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = x / base
  const frac = (x % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

async function attempt<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await p }
  } catch {
    return { ok: false }
  }
}

// ── the chain reads ────────────────────────────────────────────────────────────────────

type Ctx = {
  chain: ChainDescriptor
  client: ChainClient
  token: SettlementToken
  canonical: CanonicalFacts
  canonicalName: string | null
  httpGet: (url: string, accept: string) => Promise<Fetched | Refused>
}

/**
 * Why a proof failed, in words that are ours. The prover's own reason is never echoed: an RPC
 * error message can carry the provider URL, and an operator's RPC override can carry an API key.
 */
const UNPROVEN: Record<string, string> = {
  no_domain_separator: 'the token did not answer DOMAIN_SEPARATOR()',
  name_unreadable: 'the token did not answer name()',
  no_matching_candidate: 'no candidate domain reproduces the live DOMAIN_SEPARATOR',
  decimals_mismatch: 'the token reports different decimals than the registry declares',
  not_eip3009: 'the token does not answer authorizationState, so it is not EIP-3009',
  no_evm_chain_id: 'the chain has no EVM chain id',
  rpc_error: 'the chain could not be read',
}

async function proveCanonical(chain: ChainDescriptor, token: SettlementToken, client: ChainClient, injected: boolean): Promise<{ facts: CanonicalFacts; name: string | null }> {
  const address = token.address as `0x${string}`
  const reader: TokenReader = (fn, args) => client.readContract({ address, abi: EIP3009_ABI as readonly unknown[], functionName: fn, args: args ?? [] })
  // The production path shares the rail's cache, so a check and a 402 challenge agree on the
  // same proof; a test injects its client and gets a fresh proof every time.
  let res: DomainResult
  try {
    res = await provenDomainCached(chain, token, injected ? { reader } : {})
  } catch {
    res = { ok: false, code: 'rpc_error', reason: '' }
  }
  const base = { symbol: token.symbol, address: token.address, explorerUrl: addressUrl(chain, token.address) }
  if (res.ok) {
    return {
      name: res.proven.domain.name,
      facts: {
        ...base,
        domainProven: true,
        domainName: res.proven.domain.name,
        domainVersion: res.proven.domain.version,
        domainSeparator: res.proven.domainSeparator,
        provenAt: res.proven.provenAt,
        unproven: null,
      },
    }
  }
  const name = await attempt(client.readContract({ address, abi: TOKEN_META_ABI as readonly unknown[], functionName: 'name' }))
  return {
    name: name.ok ? String(name.value) : null,
    facts: { ...base, domainProven: false, domainName: null, domainVersion: null, domainSeparator: null, provenAt: null, unproven: UNPROVEN[res.code] ?? UNPROVEN.rpc_error },
  }
}

async function agentsHeld(ctx: Ctx, address: `0x${string}`): Promise<number | null> {
  const registry = ctx.chain.contracts.identityRegistry as `0x${string}`
  const r = await attempt(ctx.client.readContract({ address: registry, abi: BALANCE_OF_ABI as readonly unknown[], functionName: 'balanceOf', args: [address] }))
  return r.ok ? Number(r.value as bigint) : null
}

async function readAccount(ctx: Ctx, address: `0x${string}`, isContract: boolean): Promise<AccountFacts> {
  const [nonce, native, bal, held] = await Promise.all([
    attempt(ctx.client.getTransactionCount({ address })),
    attempt(ctx.client.getBalance({ address })),
    attempt(ctx.client.readContract({ address: ctx.token.address as `0x${string}`, abi: BALANCE_OF_ABI as readonly unknown[], functionName: 'balanceOf', args: [address] })),
    agentsHeld(ctx, address),
  ])
  const nativeDecimals = ctx.chain.nativeCurrency?.decimals ?? 18
  return {
    isContract,
    nonce: nonce.ok ? nonce.value : null,
    nativeBalance: native.ok ? units(native.value, nativeDecimals) : null,
    settlementBalance: bal.ok ? units(bal.value as bigint, ctx.token.decimals) : null,
    agentsHeld: held,
  }
}

/** Registration facts for a payee, as reasons. Shared by the address and x402 paths. */
function payeeReasons(ctx: Ctx, acct: AccountFacts, out: Reason[]): void {
  const native = ctx.chain.nativeCurrency?.symbol ?? 'native gas'
  if (acct.agentsHeld === null) {
    out.push({ tone: 'neutral', code: 'REGISTRY_UNREADABLE', text: `The ${ctx.chain.name} agent registry could not be read right now, so registration is unknown.` })
  } else if (acct.agentsHeld > 0) {
    out.push({ tone: 'good', code: 'AGENT_OWNER', text: `Holds ${acct.agentsHeld} registered agent${acct.agentsHeld === 1 ? '' : 's'} in ${ctx.chain.name}'s ERC-8004 identity registry.` })
    out.push({ tone: 'neutral', code: 'IDENTITY_NOT_A_REVIEW', text: 'A registration shows who holds an agent id. It is not a review of the service behind it.' })
  } else {
    out.push({ tone: 'warn', code: 'PAYEE_UNREGISTERED', text: `Not a registered agent: it holds no identity in ${ctx.chain.name}'s ERC-8004 registry.` })
  }
  const unused = acct.nonce === 0 && acct.nativeBalance === '0' && acct.settlementBalance === '0' && !acct.isContract
  if (unused) {
    out.push({ tone: 'warn', code: 'UNUSED_ADDRESS', text: `Never used on ${ctx.chain.name}: no transactions, no ${native}, no ${ctx.token.symbol}. A mistyped address looks exactly like this.` })
  }
  if (acct.isContract) out.push({ tone: 'neutral', code: 'CONTRACT_ACCOUNT', text: 'This address is a contract, not a wallet.' })
}

function tokenReasons(ctx: Ctx, t: TokenFacts, out: Reason[]): void {
  const sym = ctx.token.symbol
  if (t.canonical) {
    out.push({ tone: 'good', code: 'CANONICAL_TOKEN', text: `This is ${sym} at the address its issuer documents for ${ctx.chain.name}, read live.` })
    if (ctx.canonical.domainProven) {
      out.push({
        tone: 'good',
        code: 'DOMAIN_PROVEN',
        text: `Its signing domain ("${ctx.canonical.domainName}", version ${ctx.canonical.domainVersion}) reproduces the live DOMAIN_SEPARATOR, so a payment signed for it can settle.`,
      })
    } else {
      out.push({ tone: 'warn', code: 'DOMAIN_UNVERIFIED', text: `Its signing domain could not be proven right now: ${ctx.canonical.unproven ?? 'no reason given'}. Do not sign a payment for it until it can be.` })
    }
    return
  }
  const label = t.name && t.symbol ? `"${t.name}" (${t.symbol})` : t.symbol ?? t.name ?? 'a token'
  const where = `the ${sym} ${ctx.chain.name} settles in is at ${ctx.token.address}`
  if (t.tier === 'impersonation') {
    out.push({ tone: 'bad', code: 'NOT_CANONICAL_TOKEN', text: `This is not ${sym}. It copies the name and symbol, ${label}, but ${where}. Anything paid in this token is not ${sym}.` })
  } else if (t.tier === 'same_symbol') {
    out.push({ tone: 'bad', code: 'NOT_CANONICAL_TOKEN', text: `This uses the symbol ${t.symbol} under another name, ${label}. It is not the ${sym} ${ctx.chain.name} settles in, which is at ${ctx.token.address}.` })
  } else if (t.tier === 'similar') {
    out.push({ tone: 'warn', code: 'NOT_CANONICAL_TOKEN', text: `${label} is a different token whose name mentions ${sym}. It is not ${sym}; ${where}.` })
  } else {
    out.push({ tone: 'warn', code: 'OTHER_TOKEN', text: `${label} is a token, but not ${sym}, the dollar ${ctx.chain.name} settles in.` })
  }
}

async function readToken(ctx: Ctx, address: `0x${string}`): Promise<TokenFacts | null> {
  const [name, symbol, decimals] = await Promise.all(
    (['name', 'symbol', 'decimals'] as const).map((fn) => attempt(ctx.client.readContract({ address, abi: TOKEN_META_ABI as readonly unknown[], functionName: fn }))),
  )
  // A contract that answers symbol() and decimals() is treated as a token; a name alone is
  // not enough, since registries and vaults have names too.
  if (!symbol.ok || !decimals.ok) return null
  const t = { name: name.ok ? String(name.value) : null, symbol: String(symbol.value), decimals: Number(decimals.value) }
  return {
    address,
    ...t,
    canonical: false,
    ...(() => {
      const tier = lookalikeTier({ symbol: ctx.token.symbol, name: ctx.canonicalName }, t)
      return { lookalike: tier !== null, tier }
    })(),
  }
}

// ── the four paths ─────────────────────────────────────────────────────────────────────

type PathOut = { kind: InputKind; address: string | null; reasons: Reason[]; token?: TokenFacts | null; account?: AccountFacts | null; agent?: AgentFacts | null; challenge?: ChallengeFacts | null; positive: string | null }

async function checkAddress(ctx: Ctx, address: `0x${string}`): Promise<PathOut | EvmPayCheckError> {
  const reasons: Reason[] = []
  if (same(address, ZERO)) {
    reasons.push({ tone: 'bad', code: 'ZERO_ADDRESS', text: 'This is the zero address. Anything sent to it is gone for good.' })
    return { kind: 'address', address, reasons, positive: null }
  }
  if (same(address, ctx.token.address)) {
    const t: TokenFacts = { address, name: ctx.canonicalName, symbol: ctx.token.symbol, decimals: ctx.token.decimals, canonical: true, lookalike: false, tier: null }
    tokenReasons(ctx, t, reasons)
    return { kind: 'token', address, reasons, token: t, positive: ctx.canonical.domainProven ? `This is the real ${ctx.token.symbol}` : null }
  }
  const code = await attempt(ctx.client.getCode({ address }))
  if (!code.ok) return { error: `${ctx.chain.name} could not be read right now. Try again in a minute.`, httpStatus: 502 }
  const isContract = !!code.value && code.value !== '0x'
  if (isContract) {
    const t = await readToken(ctx, address)
    if (t) {
      tokenReasons(ctx, t, reasons)
      return { kind: 'token', address, reasons, token: t, positive: null }
    }
  }
  const account = await readAccount(ctx, address, isContract)
  payeeReasons(ctx, account, reasons)
  return { kind: 'address', address, reasons, account, positive: account.agentsHeld && account.agentsHeld > 0 ? 'A registered agent' : null }
}

type Registration = { chain?: unknown; agentId?: unknown; registry?: unknown; agentRegistry?: unknown }

/** Does a registration file list (chain, registry, id) back? Both the ERC-8004 shape
 *  ({agentId, agentRegistry: "eip155:<id>:<addr>"}) and the {chain, registry, agentId} shape. Pure. */
export function cardClaims(card: unknown, want: { caip2: string; registry: string; tokenId: string }): 'claims' | 'does_not_claim' | 'unconfirmed' {
  const regs = (card as { registrations?: unknown })?.registrations
  if (!Array.isArray(regs) || regs.length === 0) return 'unconfirmed'
  for (const r of regs as Registration[]) {
    if (!r || typeof r !== 'object') continue
    if (String(r.agentId ?? '') !== want.tokenId) continue
    const joined = typeof r.agentRegistry === 'string' ? r.agentRegistry : `${String(r.chain ?? '')}:${String(r.registry ?? '')}`
    if (joined.toLowerCase() === `${want.caip2}:${want.registry}`.toLowerCase()) return 'claims'
  }
  return 'does_not_claim'
}

async function checkAgent(ctx: Ctx, tokenId: bigint): Promise<PathOut> {
  const registry = ctx.chain.contracts.identityRegistry as `0x${string}`
  const caip = `${ctx.chain.caip2}:8004/${tokenId}`
  const reasons: Reason[] = []
  const owner = await attempt(ctx.client.readContract({ address: registry, abi: AGENT_ABI as readonly unknown[], functionName: 'ownerOf', args: [tokenId] }))
  if (!owner.ok) {
    reasons.push({ tone: 'bad', code: 'AGENT_NOT_FOUND', text: `There is no agent #${tokenId} in ${ctx.chain.name}'s ERC-8004 identity registry. Anyone presenting this id is not registered here.` })
    return { kind: 'agent', address: null, reasons, agent: { caip, tokenId: tokenId.toString(), owner: null, tokenUri: null, card: null }, positive: null }
  }
  const holder = String(owner.value)
  reasons.push({ tone: 'good', code: 'REGISTERED_AGENT', text: `Agent #${tokenId} is registered on ${ctx.chain.name}, held by ${short(holder)}.` })
  const uri = await attempt(ctx.client.readContract({ address: registry, abi: AGENT_ABI as readonly unknown[], functionName: 'tokenURI', args: [tokenId] }))
  const tokenUri = uri.ok ? String(uri.value) : null

  let card: AgentFacts['card'] = 'unconfirmed'
  if (tokenUri && /^https:\/\//i.test(tokenUri)) {
    const got = await ctx.httpGet(tokenUri, 'application/json')
    if (!('refused' in got) && got.status === 200) {
      let json: unknown = null
      try {
        json = JSON.parse(got.body)
      } catch {
        json = null
      }
      card = cardClaims(json, { caip2: ctx.chain.caip2, registry, tokenId: tokenId.toString() })
    }
  }
  const host = tokenUri ? (() => { try { return new URL(tokenUri).host } catch { return null } })() : null
  if (card === 'claims') {
    reasons.push({ tone: 'good', code: 'CARD_CLAIMS_ID', text: `Its registration file${host ? ` at ${host}` : ''} lists agent #${tokenId} on ${ctx.chain.name} back, so the file and the id agree.` })
  } else if (card === 'does_not_claim') {
    reasons.push({
      tone: 'warn',
      code: 'CARD_DOES_NOT_CLAIM',
      text: `Its registration file${host ? ` at ${host}` : ''} lists other registrations but not agent #${tokenId} on ${ctx.chain.name}. Whoever holds this id may have borrowed someone else's file.`,
    })
  } else {
    reasons.push({ tone: 'neutral', code: 'CARD_UNCONFIRMED', text: tokenUri ? 'Its registration file could not be read or lists no registrations, so the file and the id could not be compared.' : 'It has no readable registration file.' })
  }
  reasons.push({ tone: 'neutral', code: 'IDENTITY_NOT_A_REVIEW', text: 'A registration shows who holds an agent id. It is not a review of the service behind it.' })
  return { kind: 'agent', address: holder, reasons, agent: { caip, tokenId: tokenId.toString(), owner: holder, tokenUri, card }, positive: `Agent #${tokenId} is registered` }
}

type RawOffer = { network?: unknown; asset?: unknown; payTo?: unknown; amount?: unknown; maxAmountRequired?: unknown; extra?: { name?: unknown; version?: unknown; chainId?: unknown; verifyingContract?: unknown } }

/** The x402 challenge in a 402 response: the v2 PAYMENT-REQUIRED header (base64 JSON), else the JSON body. Pure. */
export function readChallenge(headers: Headers, body: string): { x402Version: number | null; accepts: RawOffer[] } | null {
  const candidates: unknown[] = []
  const header = headers.get('payment-required')
  if (header) {
    try {
      candidates.push(JSON.parse(Buffer.from(header, 'base64').toString('utf8')))
    } catch {
      /* fall through to the body */
    }
  }
  try {
    candidates.push(JSON.parse(body))
  } catch {
    /* not JSON */
  }
  for (const c of candidates) {
    const accepts = (c as { accepts?: unknown })?.accepts
    if (Array.isArray(accepts)) {
      const v = Number((c as { x402Version?: unknown }).x402Version)
      return { x402Version: Number.isFinite(v) ? v : null, accepts: accepts.filter((a) => a && typeof a === 'object') as RawOffer[] }
    }
  }
  return null
}

async function checkChallenge(ctx: Ctx, url: string): Promise<PathOut | EvmPayCheckError> {
  const got = await ctx.httpGet(url, 'application/json')
  if ('refused' in got) return { error: got.refused, httpStatus: 400 }
  if (got.status >= 300 && got.status < 400) {
    const to = (() => {
      try {
        return new URL(got.headers.get('location') ?? '', url).host
      } catch {
        return null
      }
    })()
    return { error: `That link redirects${to ? ` to ${to}` : ''}, and redirects are not followed. Paste the address it redirects to.`, httpStatus: 400 }
  }
  if (got.status !== 402) {
    return { error: `That link answered ${got.status}, not 402 Payment Required, so it is not asking for an x402 payment.`, httpStatus: 400 }
  }
  const ch = readChallenge(got.headers, got.body)
  if (!ch) return { error: 'That link answered 402 but carries no x402 challenge (no accepts list).', httpStatus: 400 }

  const networks = [...new Set(ch.accepts.map((a) => String(a.network ?? '')).filter(Boolean))]
  const mine = ch.accepts.find((a) => {
    const n = String(a.network ?? '').toLowerCase()
    return n === ctx.chain.caip2.toLowerCase() || n === ctx.chain.id.toLowerCase()
  })
  const reasons: Reason[] = []
  if (!mine) {
    reasons.push({ tone: 'neutral', code: 'CHALLENGE_OTHER_CHAIN', text: `It asks for payment on ${networks.join(', ') || 'no named network'}, not on ${ctx.chain.name}, so there is nothing here to check on this chain.` })
    return { kind: 'x402', address: null, reasons, challenge: { url, x402Version: ch.x402Version, offers: ch.accepts.length, networks, onThisChain: null }, positive: null }
  }
  const offer: ChallengeOffer = {
    network: String(mine.network),
    asset: typeof mine.asset === 'string' ? mine.asset : null,
    payTo: typeof mine.payTo === 'string' ? mine.payTo : null,
    amount: mine.amount != null ? String(mine.amount) : mine.maxAmountRequired != null ? String(mine.maxAmountRequired) : null,
    domainName: typeof mine.extra?.name === 'string' ? mine.extra.name : null,
    domainVersion: typeof mine.extra?.version === 'string' ? mine.extra.version : null,
  }
  const challenge: ChallengeFacts = { url, x402Version: ch.x402Version, offers: ch.accepts.length, networks, onThisChain: offer }
  const sym = ctx.token.symbol
  let assetOk = false
  if (!offer.asset || !/^0x[0-9a-fA-F]{40}$/.test(offer.asset)) {
    reasons.push({ tone: 'bad', code: 'CHALLENGE_WRONG_ASSET', text: `It names no token address on ${ctx.chain.name}, so there is no way to tell what it would take.` })
  } else if (!same(offer.asset, ctx.token.address)) {
    const t = await readToken(ctx, offer.asset as `0x${string}`)
    const label = t?.symbol ? `${t.symbol} at ${short(offer.asset)}` : short(offer.asset)
    reasons.push({
      tone: 'bad',
      code: 'CHALLENGE_WRONG_ASSET',
      text: `It asks to be paid in ${label}, which is not ${sym}. The ${sym} ${ctx.chain.name} settles in is at ${ctx.token.address}.`,
    })
  } else {
    assetOk = true
    reasons.push({ tone: 'good', code: 'CHALLENGE_CANONICAL_ASSET', text: `It asks for ${sym} at its real address on ${ctx.chain.name}.` })
  }

  // The domain a challenge hands the buyer is what the buyer signs. If it is not the token's
  // proven domain, the signature cannot settle there, and a challenge that gets it wrong on
  // purpose is asking for a signature meant for something else.
  const extraChain = mine.extra?.chainId != null ? Number(mine.extra.chainId) : null
  const extraContract = typeof mine.extra?.verifyingContract === 'string' ? mine.extra.verifyingContract : null
  if (assetOk && ctx.canonical.domainProven) {
    const mismatch =
      (offer.domainName !== null && offer.domainName !== ctx.canonical.domainName) ||
      (offer.domainVersion !== null && offer.domainVersion !== ctx.canonical.domainVersion) ||
      (extraChain !== null && extraChain !== ctx.chain.evmChainId) ||
      (extraContract !== null && !same(extraContract, ctx.token.address))
    if (mismatch) {
      reasons.push({
        tone: 'bad',
        code: 'DOMAIN_MISMATCH',
        text: `It tells you to sign against a domain ("${offer.domainName ?? '?'}", version ${offer.domainVersion ?? '?'}) that is not ${sym}'s proven one ("${ctx.canonical.domainName}", version ${ctx.canonical.domainVersion}). Do not sign it.`,
      })
    } else {
      reasons.push({ tone: 'good', code: 'DOMAIN_PROVEN', text: `The signing domain it hands you matches ${sym}'s live DOMAIN_SEPARATOR.` })
    }
  } else if (assetOk) {
    reasons.push({ tone: 'warn', code: 'DOMAIN_UNVERIFIED', text: `${sym}'s signing domain could not be proven right now, so the domain this challenge hands you cannot be checked.` })
  }

  let account: AccountFacts | null = null
  if (offer.payTo && /^0x[0-9a-fA-F]{40}$/.test(offer.payTo)) {
    const payTo = offer.payTo as `0x${string}`
    if (same(payTo, ZERO)) {
      reasons.push({ tone: 'bad', code: 'ZERO_ADDRESS', text: 'It pays the zero address. Anything sent there is gone for good.' })
    } else {
      const code = await attempt(ctx.client.getCode({ address: payTo }))
      const isContract = code.ok && !!code.value && code.value !== '0x'
      const t = isContract ? await readToken(ctx, payTo) : null
      if (t) {
        reasons.push({ tone: 'bad', code: 'CHALLENGE_WRONG_ASSET', text: `It pays a token contract (${t.symbol ?? short(payTo)}), not a wallet. Money sent there is usually stuck.` })
      } else {
        account = await readAccount(ctx, payTo, isContract)
        payeeReasons(ctx, account, reasons)
      }
    }
  }
  const registered = !!account?.agentsHeld && account.agentsHeld > 0
  return { kind: 'x402', address: offer.payTo, reasons, challenge, account, positive: assetOk && registered ? `Real ${sym}, paid to a registered agent` : null }
}

// ── the check ──────────────────────────────────────────────────────────────────────────

const HEADLINES: Record<Verdict, string> = {
  safe: 'Looks right',
  careful: 'Be careful',
  dont_pay: "Don't pay",
  unknown: 'Could not verify',
}

const ORDER: ReasonTone[] = ['bad', 'warn', 'good', 'neutral']

export async function runEvmPayCheck(q: string, chainId: string, deps: EvmPayCheckDeps = {}): Promise<EvmPayCheckResult | EvmPayCheckError> {
  let chain = getChainById(chainId)
  if (!chain || !payCheckChains([chain]).length) return { error: `There is no pay check for ${chainId}.`, httpStatus: 404 }
  const parsed = parseQuery(q)
  if (!parsed) {
    return { error: 'Paste a token or wallet address (0x...), an agent id (eip155:<chain>:8004/<n> or #n), or an https x402 link.', httpStatus: 400 }
  }
  // A CAIP agent id names its own chain. Follow it when it is one we check; refuse when it
  // is not, rather than reading the same number off an unrelated registry.
  if (parsed.kind === 'agent' && parsed.evmChainId !== null && parsed.evmChainId !== chain.evmChainId) {
    const other = payCheckChains(CHAINS).find((c) => c.evmChainId === parsed.evmChainId)
    if (!other) return { error: `That agent id is on chain ${parsed.evmChainId}, which this check does not read.`, httpStatus: 400 }
    chain = other
  }
  const token = settlementTokenOf(chain)!
  const env = deps.env ?? process.env
  const injected = !!deps.client
  const client = deps.client ?? ((await evmPublicClient(chain, env)) as unknown as ChainClient)
  const now = deps.now ? deps.now() : Date.now()

  const [{ facts: canonical, name: canonicalName }, arbId] = await Promise.all([
    proveCanonical(chain, token, client, injected),
    attempt(client.readContract({ address: ARBSYS, abi: ARBSYS_ABI as readonly unknown[], functionName: 'arbChainID' })),
  ])
  const arbitrum: ArbitrumFacts | null = arbId.ok
    ? { arbSys: ARBSYS, arbChainId: Number(arbId.value as bigint), matches: Number(arbId.value as bigint) === chain.evmChainId }
    : null
  const ctx: Ctx = { chain, client, token, canonical, canonicalName, httpGet: deps.httpGet ?? ((u, a) => safeHttpsGet(u, a)) }

  const out =
    parsed.kind === 'address'
      ? await checkAddress(ctx, parsed.address)
      : parsed.kind === 'agent'
        ? await checkAgent(ctx, parsed.tokenId)
        : await checkChallenge(ctx, parsed.url)
  if ('error' in out) return out

  const reasons = [...out.reasons].sort((a, b) => ORDER.indexOf(a.tone) - ORDER.indexOf(b.tone))
  const has = (tone: ReasonTone) => reasons.some((r) => r.tone === tone)
  let verdict: Verdict
  if (has('bad')) verdict = 'dont_pay'
  else if (reasons.some((r) => r.code === 'DOMAIN_UNVERIFIED')) verdict = 'unknown'
  else if (has('warn')) verdict = 'careful'
  else if (out.positive) verdict = 'safe'
  else verdict = 'unknown'

  let headline = HEADLINES[verdict]
  if (verdict === 'safe' && out.positive) headline = out.positive
  if (verdict === 'dont_pay' && out.token?.tier === 'impersonation') headline = `Not the real ${token.symbol}. Don't pay with it`
  else if (verdict === 'dont_pay' && out.token?.tier === 'same_symbol') headline = `Not the ${token.symbol} ${chain.name} settles in`

  return {
    query: q.trim(),
    chain: { id: chain.id, name: chain.name, caip2: chain.caip2 },
    arbitrum,
    kind: out.kind,
    address: out.address,
    verdict,
    headline,
    reasons,
    canonical,
    token: out.token ?? null,
    account: out.account ?? null,
    agent: out.agent ?? null,
    challenge: out.challenge ?? null,
    explorerUrl: out.address && /^0x[0-9a-fA-F]{40}$/.test(out.address) ? addressUrl(chain, out.address) : null,
    checkedAt: new Date(now).toISOString(),
  }
}
