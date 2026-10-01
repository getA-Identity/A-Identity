import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getChainById } from '../chains/registry.js'
import type { ChainDescriptor } from '../chains/types.js'
import { clearDomainCache, eip712DomainSeparator } from '../x402-3009/domain.js'
import { preflight, type Fetched, type Refused } from './safe-get.js'
import {
  cardClaims,
  documentedTokensOf,
  isRevert,
  fold,
  lookalikeTier,
  looksLike,
  parseQuery,
  payCheckChains,
  readChallenge,
  runEvmPayCheck,
  settlementTokenOf,
  type ChainClient,
  type EvmPayCheckResult,
} from './check.js'

// Every chain constant comes from the registry, so these tests follow a descriptor change
// instead of pinning a copy of it.
const RH = getChainById('rhchain') as ChainDescriptor
const ARB = getChainById('arbitrum') as ChainDescriptor
const USDG = settlementTokenOf(RH)!.address as `0x${string}`
const USDC = settlementTokenOf(ARB)!.address as `0x${string}`
const REGISTRY = RH.contracts.identityRegistry as `0x${string}`
const ARB_USDG = documentedTokensOf(ARB)[0].address as `0x${string}`

const FAKE = '0x1111111111111111111111111111111111111111'
const HOMOGLYPH = '0x2222222222222222222222222222222222222222'
const WETH = '0x3333333333333333333333333333333333333333'
const SAME_SYMBOL = '0x7777777777777777777777777777777777777777'
const STEAK = '0x8888888888888888888888888888888888888888'
const AGENT_WALLET = '0x4444444444444444444444444444444444444444'
const FRESH = '0x5555555555555555555555555555555555555555'
const CLONER = '0x6666666666666666666666666666666666666666'
const CARD = 'https://agent.example/.well-known/agent-card.json'

type TokenSpec = { name?: string; symbol?: string; decimals?: number; version?: string; separator?: string; separatorError?: string }

type World = {
  tokens: Record<string, TokenSpec>
  code: Record<string, string>
  nonce: Record<string, number>
  native: Record<string, bigint>
  held: Record<string, number>
  agents: Record<string, { owner: string; uri: string }>
  registryDown?: boolean
  rpcDown?: boolean
  /** What ArbSys.arbChainID() answers; undefined means the precompile is absent (not an Arbitrum chain). */
  arbChainId?: number
  /** ownerOf does not come back at all (a timeout), as opposed to reverting. */
  ownerOfDown?: boolean
  /** These contracts' name/symbol/decimals reads time out. */
  metaDown?: string[]
  /** getCode answers only after this many ms. */
  slowMs?: number
}

const lc = (a: string) => a.toLowerCase()

function world(over: Partial<World> = {}): World {
  const usdgSep = eip712DomainSeparator({ name: 'Global Dollar', version: '1', chainId: RH.evmChainId as number, verifyingContract: USDG })
  const usdcSep = eip712DomainSeparator({ name: 'USD Coin', version: '2', chainId: ARB.evmChainId as number, verifyingContract: USDC })
  return {
    tokens: {
      // USDG has no version(): the proof must come from the candidate list.
      [lc(USDG)]: { name: 'Global Dollar', symbol: 'USDG', decimals: 6, separator: usdgSep },
      [lc(USDC)]: { name: 'USD Coin', symbol: 'USDC', decimals: 6, version: '2', separator: usdcSep },
      [lc(ARB_USDG)]: { name: 'Global Dollar', symbol: 'USDG', decimals: 6, separator: eip712DomainSeparator({ name: 'Global Dollar', version: '1', chainId: ARB.evmChainId as number, verifyingContract: ARB_USDG }) },
      [lc(FAKE)]: { name: 'Global Dollar', symbol: 'USDG', decimals: 6 },
      // Cyrillic DZE in place of the Latin S.
      [lc(HOMOGLYPH)]: { name: 'Gl0bal D0llar', symbol: 'UЅDG', decimals: 6 },
      [lc(WETH)]: { name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 },
      [lc(SAME_SYMBOL)]: { name: 'United States Global Dollars Gold', symbol: 'USDG', decimals: 6 },
      [lc(STEAK)]: { name: 'Steakhouse USDG', symbol: 'steakUSDG', decimals: 18 },
    },
    code: { [lc(USDG)]: '0x60', [lc(USDC)]: '0x60', [lc(FAKE)]: '0x60', [lc(HOMOGLYPH)]: '0x60', [lc(WETH)]: '0x60', [lc(SAME_SYMBOL)]: '0x60', [lc(STEAK)]: '0x60', [lc(REGISTRY)]: '0x60' },
    nonce: { [lc(AGENT_WALLET)]: 13 },
    native: { [lc(AGENT_WALLET)]: 10n ** 15n },
    held: { [lc(AGENT_WALLET)]: 1, [lc(CLONER)]: 1 },
    arbChainId: RH.evmChainId as number,
    agents: {
      '0': { owner: AGENT_WALLET, uri: CARD },
      // A clone: the next token, minted by someone else, pointing at the same card.
      '1': { owner: CLONER, uri: CARD },
    },
    ...over,
  }
}

function client(w: World): ChainClient {
  const revert = (what: string) => Promise.reject(new Error(`execution reverted: ${what}`))
  return {
    async getCode({ address }) {
      if (w.slowMs) await new Promise((r) => setTimeout(r, w.slowMs))
      if (w.rpcDown) throw new Error('rpc down')
      return w.code[lc(address)] ?? '0x'
    },
    async getTransactionCount({ address }) {
      return w.nonce[lc(address)] ?? 0
    },
    async getBalance({ address }) {
      return w.native[lc(address)] ?? 0n
    },
    async readContract({ address, functionName, args }) {
      if (w.rpcDown) throw new Error('rpc down')
      const a = lc(address)
      if (a === '0x0000000000000000000000000000000000000064') {
        return w.arbChainId === undefined ? revert('no ArbSys') : BigInt(w.arbChainId)
      }
      if (a === lc(REGISTRY)) {
        if (w.registryDown) throw new Error('registry down')
        if (functionName === 'balanceOf') return BigInt(w.held[lc(String(args?.[0]))] ?? 0)
        if (w.ownerOfDown) throw new Error('HTTP request failed. Status: 429')
        const id = String(args?.[0])
        const agent = w.agents[id]
        if (!agent) return revert('ERC721NonexistentToken')
        if (functionName === 'ownerOf') return agent.owner
        if (functionName === 'tokenURI') return agent.uri
        return revert(functionName)
      }
      if (w.metaDown?.map(lc).includes(a)) throw new Error('The request took too long to respond.')
      const t = w.tokens[a]
      if (!t) return revert('no code')
      switch (functionName) {
        case 'name':
          return t.name ?? revert('name')
        case 'symbol':
          return t.symbol ?? revert('symbol')
        case 'decimals':
          return t.decimals ?? revert('decimals')
        case 'version':
          return t.version ?? revert('version')
        case 'DOMAIN_SEPARATOR':
          if (t.separatorError) throw new Error(t.separatorError)
          return t.separator ?? revert('DOMAIN_SEPARATOR')
        case 'authorizationState':
          return t.separator ? false : revert('authorizationState')
        case 'balanceOf':
          return 0n
        default:
          return revert(functionName)
      }
    },
  }
}

type Page = { status: number; body?: string; headers?: Record<string, string> }

/** A stand-in for the screened GET: the real URL screen runs first, then the pages answer. */
function web(pages: Record<string, Page>, refuse: Record<string, string> = {}) {
  const calls: string[] = []
  const httpGet = async (url: string): Promise<Fetched | Refused> => {
    const pf = preflight(url)
    if ('refused' in pf) return pf
    if (refuse[url]) return { refused: refuse[url] }
    calls.push(url)
    const p = pages[url]
    if (!p) return { status: 404, headers: new Headers(), body: 'not found' }
    return { status: p.status, headers: new Headers(p.headers ?? {}), body: p.body ?? '' }
  }
  return { httpGet, calls }
}

const card = (registrations: unknown[]) => JSON.stringify({ name: 'An agent', registrations })
const ourCard = () => card([{ chain: RH.caip2, agentId: '0', registry: REGISTRY }])

async function check(q: string, w: World = world(), net = web({ [CARD]: { status: 200, body: ourCard() } }), chainId = 'rhchain') {
  const out = await runEvmPayCheck(q, chainId, { client: client(w), httpGet: net.httpGet, now: () => Date.parse('2026-09-30T12:00:00Z') })
  return out
}

function ok(out: Awaited<ReturnType<typeof check>>): EvmPayCheckResult {
  assert.ok(!('error' in out), `expected a result, got ${JSON.stringify(out)}`)
  return out as EvmPayCheckResult
}

const codes = (r: EvmPayCheckResult) => r.reasons.map((x) => x.code)

beforeEach(() => clearDomainCache())

// ── pure pieces ──────────────────────────────────────────────────────────────────────

test('parseQuery: the four shapes, and nothing else', () => {
  assert.deepEqual(parseQuery(`${RH.caip2}:8004/0`), { kind: 'agent', evmChainId: RH.evmChainId, tokenId: 0n })
  assert.deepEqual(parseQuery('#12'), { kind: 'agent', evmChainId: null, tokenId: 12n })
  assert.deepEqual(parseQuery('agent #7'), { kind: 'agent', evmChainId: null, tokenId: 7n })
  assert.equal(parseQuery(`  ${USDG}  `)?.kind, 'address')
  assert.equal(parseQuery('https://seller.example/api/tool')?.kind, 'x402')
  assert.equal(parseQuery('http://seller.example/api/tool'), null, 'plain http is not read')
  assert.equal(parseQuery('0x1234'), null)
  assert.equal(parseQuery('USDG'), null)
})

test('looksLike: a symbol or name that presents as the settlement dollar, folded for homoglyphs', () => {
  const usdg = { symbol: 'USDG', name: 'Global Dollar' }
  assert.equal(looksLike(usdg, { symbol: 'USDG', name: 'Totally Real' }), true)
  assert.equal(looksLike(usdg, { symbol: 'GD', name: 'Global Dollar' }), true)
  assert.equal(looksLike(usdg, { symbol: 'UЅDG', name: null }), true, 'Cyrillic S')
  assert.equal(looksLike(usdg, { symbol: 'USDG.e', name: null }), true)
  assert.equal(looksLike(usdg, { symbol: 'US0G', name: null }), false, 'a different letter is a different token, not a lookalike of this one')
  assert.equal(looksLike(usdg, { symbol: 'WETH', name: 'Wrapped Ether' }), false)
  assert.equal(looksLike({ symbol: 'USDC', name: 'USD Coin' }, { symbol: 'U$DC', name: null }), true)
  assert.equal(fold('ＵＳＤＧ'), 'usdg', 'full-width folds through NFKC')
})

test('lookalikeTier: a copy, a same-symbol token, and one that only mentions the name are told apart', () => {
  const usdg = { symbol: 'USDG', name: 'Global Dollar' }
  assert.equal(lookalikeTier(usdg, { symbol: 'USDG', name: 'Global Dollar' }), 'impersonation')
  assert.equal(lookalikeTier(usdg, { symbol: 'U\u0405DG', name: 'Gl0bal D0llar' }), 'impersonation')
  assert.equal(lookalikeTier(usdg, { symbol: 'USDG', name: 'United States Global Dollars Gold' }), 'same_symbol')
  assert.equal(lookalikeTier(usdg, { symbol: 'steakUSDG', name: 'Steakhouse USDG' }), 'similar')
  assert.equal(lookalikeTier(usdg, { symbol: 'WETH', name: 'Wrapped Ether' }), null)
  // Arbitrum's bridged USDC.e is a real, different token: same symbol, never "impersonation".
  assert.equal(lookalikeTier({ symbol: 'USDC', name: 'USD Coin' }, { symbol: 'USDC', name: 'USD Coin (Arb1)' }), 'same_symbol')
})

test('cardClaims: both registration shapes, and a file that lists someone else', () => {
  const want = { caip2: RH.caip2, registry: REGISTRY, tokenId: '0' }
  assert.equal(cardClaims({ registrations: [{ chain: RH.caip2, registry: REGISTRY, agentId: '0' }] }, want), 'claims')
  assert.equal(cardClaims({ registrations: [{ agentId: 0, agentRegistry: `${RH.caip2}:${REGISTRY.toUpperCase().replace('0X', '0x')}` }] }, want), 'claims')
  assert.equal(cardClaims({ registrations: [{ chain: RH.caip2, registry: REGISTRY, agentId: '0' }] }, { ...want, tokenId: '1' }), 'does_not_claim')
  assert.equal(cardClaims({ registrations: [] }, want), 'unconfirmed')
  assert.equal(cardClaims(null, want), 'unconfirmed')
})

test('readChallenge: the v2 header wins, the v1 body still reads', () => {
  const v2 = { x402Version: 2, accepts: [{ network: RH.caip2 }] }
  const h = new Headers({ 'payment-required': Buffer.from(JSON.stringify(v2)).toString('base64') })
  assert.equal(readChallenge(h, '')?.x402Version, 2)
  assert.equal(readChallenge(new Headers(), JSON.stringify({ x402Version: 1, accepts: [{ network: RH.id }] }))?.accepts.length, 1)
  assert.equal(readChallenge(new Headers(), '<html>'), null)
})

test('payCheckChains: Robinhood Chain and Arbitrum One qualify, a testnet does not', () => {
  const ids = payCheckChains([RH, ARB, getChainById('rhchain-testnet') as ChainDescriptor]).map((c) => c.id)
  assert.deepEqual(ids, ['rhchain', 'arbitrum'])
})

// ── tokens ───────────────────────────────────────────────────────────────────────────

test('the real USDG, with its domain proven against the live separator, is the only token called real', async () => {
  const r = ok(await check(USDG))
  assert.equal(r.kind, 'token')
  assert.equal(r.verdict, 'safe')
  assert.equal(r.headline, 'This is the real USDG')
  assert.deepEqual(codes(r), ['CANONICAL_TOKEN', 'DOMAIN_PROVEN'])
  assert.equal(r.canonical.domainProven, true)
  assert.equal(r.canonical.domainVersion, '1')
  assert.equal(r.token?.canonical, true)
})

test('the chain proves it is an Arbitrum chain from its own ArbSys precompile, and a chain without one says nothing', async () => {
  const r = ok(await check(USDG))
  assert.deepEqual(r.arbitrum, { arbSys: '0x0000000000000000000000000000000000000064', arbChainId: RH.evmChainId, matches: true })
  const none = ok(await check(USDG, world({ arbChainId: undefined })))
  assert.equal(none.arbitrum, null)
})

test('the real USDG with an unprovable domain is "Could not verify", never safe', async () => {
  const w = world()
  w.tokens[lc(USDG)] = { ...w.tokens[lc(USDG)], separator: '0x' + 'ab'.repeat(32) }
  const r = ok(await check(USDG, w))
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.headline, 'Could not verify')
  assert.ok(codes(r).includes('DOMAIN_UNVERIFIED'))
  assert.equal(r.canonical.domainProven, false)
  assert.ok(r.canonical.unproven)
})

test('an impostor calling itself Global Dollar / USDG: do not pay, and the real address is named', async () => {
  const r = ok(await check(FAKE))
  assert.equal(r.verdict, 'dont_pay')
  assert.equal(r.headline, "Not the real USDG. Don't pay with it")
  assert.deepEqual(codes(r), ['NOT_CANONICAL_TOKEN'])
  assert.ok(r.reasons[0].text.includes(USDG), 'the answer names where the real USDG is')
  assert.equal(r.token?.lookalike, true)
})

test('a homoglyph impostor is caught too', async () => {
  const r = ok(await check(HOMOGLYPH))
  assert.equal(r.verdict, 'dont_pay')
  assert.deepEqual(codes(r), ['NOT_CANONICAL_TOKEN'])
})

test('the same symbol under another name: do not pay with it, and never called a fake', async () => {
  const r = ok(await check(SAME_SYMBOL))
  assert.equal(r.verdict, 'dont_pay')
  assert.equal(r.headline, 'Not the USDG Robinhood Chain settles in')
  assert.equal(r.token?.tier, 'same_symbol')
  assert.doesNotMatch(r.reasons[0].text, /fake|copies/i)
})

test('a token that only mentions USDG is a be-careful, not a do-not-pay', async () => {
  const r = ok(await check(STEAK))
  assert.equal(r.verdict, 'careful')
  assert.equal(r.token?.tier, 'similar')
  assert.deepEqual(codes(r), ['NOT_CANONICAL_TOKEN'])
})

test('a failed domain proof never echoes the RPC error, which can carry a provider key', async () => {
  const w = world()
  w.tokens[lc(USDG)] = { ...w.tokens[lc(USDG)], separatorError: 'HTTP request failed. URL: https://rpc.example/v2/SECRETKEY123' }
  const r = ok(await check(USDG, w))
  assert.equal(r.verdict, 'unknown')
  assert.doesNotMatch(JSON.stringify(r), /SECRETKEY123|rpc\.example/)
})

test('an unrelated token is flagged as not the settlement dollar, not as a fake', async () => {
  const r = ok(await check(WETH))
  assert.equal(r.verdict, 'careful')
  assert.deepEqual(codes(r), ['OTHER_TOKEN'])
})

// ── payees ───────────────────────────────────────────────────────────────────────────

test('a wallet holding a registered agent: identity, labeled as identity and not a review', async () => {
  const r = ok(await check(AGENT_WALLET))
  assert.equal(r.kind, 'address')
  assert.equal(r.verdict, 'safe')
  assert.equal(r.headline, 'A registered agent')
  assert.deepEqual(codes(r), ['AGENT_OWNER', 'IDENTITY_NOT_A_REVIEW'])
  assert.equal(r.account?.agentsHeld, 1)
  assert.equal(r.account?.nonce, 13)
})

test('an unused, unregistered address: be careful, and say a typo looks like this', async () => {
  const r = ok(await check(FRESH))
  assert.equal(r.verdict, 'careful')
  assert.deepEqual(codes(r).sort(), ['PAYEE_UNREGISTERED', 'UNUSED_ADDRESS'])
})

test('an unreadable registry is unknown, never a registration', async () => {
  const r = ok(await check(AGENT_WALLET, world({ registryDown: true })))
  assert.equal(r.verdict, 'unknown')
  assert.ok(codes(r).includes('REGISTRY_UNREADABLE'))
  assert.equal(r.account?.agentsHeld, null)
})

test('the zero address is a do-not-pay', async () => {
  const r = ok(await check('0x0000000000000000000000000000000000000000'))
  assert.equal(r.verdict, 'dont_pay')
  assert.deepEqual(codes(r), ['ZERO_ADDRESS'])
})

test('a chain that cannot be read is a 502, not a verdict', async () => {
  const out = await check(FRESH, world({ rpcDown: true }))
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 502)
})

// ── agent ids ────────────────────────────────────────────────────────────────────────

test('agent #0 whose registration file lists it back is registered', async () => {
  const r = ok(await check(`${RH.caip2}:8004/0`))
  assert.equal(r.kind, 'agent')
  assert.equal(r.verdict, 'safe')
  assert.equal(r.headline, 'Agent #0 is registered')
  assert.deepEqual(codes(r), ['REGISTERED_AGENT', 'CARD_CLAIMS_ID', 'IDENTITY_NOT_A_REVIEW'])
  assert.equal(r.agent?.owner, AGENT_WALLET)
  assert.equal(r.agent?.card, 'claims')
})

test('a clone that points at someone else\'s registration file is caught', async () => {
  const r = ok(await check('#1'))
  assert.equal(r.verdict, 'careful')
  assert.ok(codes(r).includes('CARD_DOES_NOT_CLAIM'))
  assert.equal(r.agent?.owner, CLONER)
})

test('an agent id the registry does not have: do not pay whoever presents it', async () => {
  const r = ok(await check('#999'))
  assert.equal(r.verdict, 'dont_pay')
  assert.deepEqual(codes(r), ['AGENT_NOT_FOUND'])
})

test('a CAIP id for another chain this check serves is read on that chain', async () => {
  const w = world()
  w.agents['5'] = { owner: AGENT_WALLET, uri: 'ipfs://not-fetched' }
  const r = ok(await check(`${ARB.caip2}:8004/5`, w))
  assert.equal(r.chain.id, 'arbitrum')
  assert.equal(r.canonical.symbol, 'USDC')
  assert.ok(codes(r).includes('CARD_UNCONFIRMED'))
})

test('a CAIP id for a chain this check does not serve is refused, not read off another registry', async () => {
  const out = await check('eip155:999999:8004/0')
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 400)
})

// ── x402 links ───────────────────────────────────────────────────────────────────────

const SELLER = 'https://seller.example/api/tool'

function challenge(offer: Record<string, unknown>, others: Record<string, unknown>[] = []): Page {
  const body = { x402Version: 2, accepts: [offer, ...others] }
  return { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(body)).toString('base64') }, body: JSON.stringify(body) }
}

const goodOffer = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: RH.caip2,
  asset: USDG,
  payTo: AGENT_WALLET,
  amount: '21000',
  extra: { name: 'Global Dollar', version: '1', chainId: RH.evmChainId, verifyingContract: USDG },
  ...over,
})

test('a challenge asking for real USDG, with its proven domain, paying a registered agent', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer()) })))
  assert.equal(r.kind, 'x402')
  assert.equal(r.verdict, 'safe')
  assert.equal(r.headline, 'Real USDG, paid to a registered agent')
  assert.deepEqual(codes(r), ['CHALLENGE_CANONICAL_ASSET', 'DOMAIN_PROVEN', 'AGENT_OWNER', 'IDENTITY_NOT_A_REVIEW'])
  assert.equal(r.challenge?.onThisChain?.amount, '21000')
  assert.equal(r.address, AGENT_WALLET)
})

test('a challenge asking for a fake USDG is refused and names the real one', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer({ asset: FAKE, extra: { name: 'Global Dollar', version: '1' } })) })))
  assert.equal(r.verdict, 'dont_pay')
  assert.ok(codes(r).includes('CHALLENGE_WRONG_ASSET'))
  const wrong = r.reasons.find((x) => x.code === 'CHALLENGE_WRONG_ASSET')!
  assert.ok(wrong.text.includes(USDG))
})

test('a challenge handing the buyer the wrong signing domain is refused', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer({ extra: { name: 'Global Dollar', version: '2' } })) })))
  assert.equal(r.verdict, 'dont_pay')
  assert.ok(codes(r).includes('DOMAIN_MISMATCH'))
})

test('a challenge that pays an unregistered wallet is a be-careful', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer({ payTo: FRESH })) })))
  assert.equal(r.verdict, 'careful')
  assert.ok(codes(r).includes('PAYEE_UNREGISTERED'))
})

test('a challenge that only asks for payment elsewhere says so', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer({ network: 'eip155:1' })) })))
  assert.equal(r.verdict, 'unknown')
  assert.deepEqual(codes(r), ['CHALLENGE_OTHER_CHAIN'])
  assert.equal(r.challenge?.onThisChain, null)
})

test('the v1 network slug is matched too', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: { status: 402, body: JSON.stringify({ x402Version: 1, accepts: [goodOffer({ network: RH.id })] }) } })))
  assert.equal(r.verdict, 'safe')
})

test('a link that is not a 402 is an input error', async () => {
  const out = await check(SELLER, world(), web({ [SELLER]: { status: 200, body: 'hello' } }))
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 400)
})

test('a link the screened GET refuses is an input error, and nothing is read', async () => {
  const net = web({ [SELLER]: challenge(goodOffer()) }, { [SELLER]: 'That link resolves to a private network, so it is not read.' })
  const out = await check(SELLER, world(), net)
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 400)
  assert.match(out.error, /private network/)
  assert.equal(net.calls.length, 0)
})

test('a literal IP link is refused before any request', async () => {
  const net = web({})
  const out = await check('https://127.0.0.1/admin', world(), net)
  assert.ok('error' in out)
  assert.equal(net.calls.length, 0)
})

test('a redirect is reported with its target host and not followed', async () => {
  const out = await check(SELLER, world(), web({ [SELLER]: { status: 302, headers: { location: 'https://elsewhere.example/pay' } } }))
  assert.ok('error' in out)
  assert.match(out.error, /elsewhere\.example/)
})

// ── a read that did not come back is never a verdict ─────────────────────────────

test('isRevert: a contract saying no is an answer, a transport failure is not', () => {
  assert.equal(isRevert(new Error('execution reverted: ERC721NonexistentToken')), true)
  assert.equal(isRevert({ name: 'ContractFunctionExecutionError', message: 'x', cause: { name: 'ContractFunctionRevertedError', message: 'y' } }), true)
  assert.equal(isRevert(new Error('HTTP request failed. Status: 429')), false)
  assert.equal(isRevert(new Error('The request took too long to respond.')), false)
})

test('an agent read that times out says nothing was decided, never "no such agent"', async () => {
  const out = await check('#0', world({ ownerOfDown: true }))
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 502)
  assert.match(out.error, /nothing was decided/)
})

test('a lookalike whose symbol() times out is not waved through as a wallet', async () => {
  const out = await check(FAKE, world({ metaDown: [FAKE] }))
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 502)
})

test('a check that runs past its deadline answers nothing was decided', async () => {
  const out = await runEvmPayCheck(FRESH, 'rhchain', { client: client(world({ slowMs: 200 })), httpGet: web({}).httpGet, deadlineMs: 50 })
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 502)
  assert.match(out.error, /did not answer within/)
})

// ── a dollar the issuer documents, on a chain we settle in another ───────────────────

test('Paxos USDG on Arbitrum One is the real USDG, and the answer says our rail there settles in USDC', async () => {
  const r = ok(await check(ARB_USDG, world(), web({}), 'arbitrum'))
  assert.equal(r.verdict, 'safe')
  assert.equal(r.headline, 'This is the real USDG')
  assert.deepEqual(codes(r), ['DOCUMENTED_TOKEN', 'DOMAIN_PROVEN'])
  assert.match(r.reasons[0].text, /Paxos/)
  assert.match(r.reasons[0].text, /USDC/)
})

test('a copy of USDG on Arbitrum One is named against the USDG Paxos documents there', async () => {
  const r = ok(await check(FAKE, world(), web({}), 'arbitrum'))
  assert.equal(r.verdict, 'dont_pay')
  assert.equal(r.headline, "Not the real USDG. Don't pay with it")
  assert.ok(r.reasons[0].text.includes(ARB_USDG))
})

// ── challenges that hide something ───────────────────────────────────────────────────

test('a challenge with an honest offer and a lookalike one is judged by the lookalike', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer(), [goodOffer({ asset: FAKE })]) })))
  assert.equal(r.verdict, 'dont_pay')
  assert.ok(codes(r).includes('CHALLENGE_WRONG_ASSET'))
  assert.ok(codes(r).includes('CHALLENGE_SEVERAL_OFFERS'))
  assert.equal(r.challenge?.offersOnThisChain, 2)
})

test('a challenge that names the right token but no signing domain is a be-careful', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer({ extra: {} })) })))
  assert.equal(r.verdict, 'careful')
  assert.ok(codes(r).includes('CHALLENGE_NO_DOMAIN'))
})

test('a challenge that pays a token contract is refused under its own code', async () => {
  const r = ok(await check(SELLER, world(), web({ [SELLER]: challenge(goodOffer({ payTo: WETH })) })))
  assert.equal(r.verdict, 'dont_pay')
  assert.ok(codes(r).includes('PAYEE_IS_TOKEN_CONTRACT'))
})

// ── the edges ────────────────────────────────────────────────────────────────────────

test('garbage input is a 400 that says what to paste', async () => {
  const out = await check('hello there')
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 400)
  assert.match(out.error, /agent id/)
})

test('a chain with no pay check is a 404', async () => {
  const out = await check(USDG, world(), web({}), 'rhchain-testnet')
  assert.ok('error' in out)
  assert.equal(out.httpStatus, 404)
})
