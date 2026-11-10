/**
 * Buying one Celo x402 trust check from the visitor's own EVM wallet: the terms, the USDC
 * read, the signature, the paid call, and what each ending means for the money.
 *
 * A browser port of mcp/scripts/celo-x402-buyer.mjs, the proven way to pay this rail, with
 * the private key replaced by the person's wallet. What the wallet is asked to sign, and
 * nothing more: one EIP-3009 TransferWithAuthorization of exactly the quoted amount of the
 * quoted USDC to the quoted payTo. A signature is not a transaction: the first-party Celo
 * facilitator broadcasts it and pays the gas, so the buyer needs USDC and no CELO.
 *
 * Every refusal here happens before the wallet is asked to sign: terms on another network
 * or asset, a payee or a price that is not the one the rail publishes, a wallet short of
 * USDC. The registry's Celo id and the rail's own /api/celo/status are what a quote is held
 * against; nothing about the chain or the token is typed here.
 *
 * No runtime imports, on purpose: mcp/src/frontend-celo-check.test.ts loads this file
 * straight from src/ through Node's type stripping and drives purchase() with a fake wallet,
 * so "a wrong network signs nothing" and "a declined signature sends nothing" are things the
 * suite watches happen, not lines it searches for. Nothing here holds a key.
 */

export type CeloTool = 'verify_agent' | 'reputation_score' | 'risk_check' | 'agent_passport'

/** The one check the page sells: the ALLOW / WARN / DENY verdict with its reasons. */
export const CHECK_TOOL: CeloTool = 'risk_check'

export const STATUS_PATH = '/api/celo/status'
export const toolPath = (tool: CeloTool) => `/api/celo/tools/${tool}`

/** Native USDC on Celo has 6 decimals, like every Circle USDC; the quote's units are read in them. */
export const USDC_DECIMALS = 6

// ---- small helpers ----

const isAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`)

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return typeof e === 'string' ? e : 'unknown error'
}

/** True when the person said no in the wallet, as opposed to the wallet failing. */
function isRejection(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 4001 || /user rejected|rejected by user|user denied|denied by user|cancel/i.test(errorText(e))
}

/** "$0.005", "$0.01", "$2.50". */
export function formatUsd(v: number): string {
  const whole = Number.isInteger(v)
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 6 })}`
}

/** USDC base units as a number of dollars: 5000 -> "0.005", 1000000 -> "1.00". */
export function formatUsdc(units: bigint): string {
  const s = units.toString().padStart(USDC_DECIMALS + 1, '0')
  const whole = s.slice(0, -USDC_DECIMALS)
  const frac = s.slice(-USDC_DECIMALS).replace(/0+$/, '')
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}`
}

/** The base units a dollar price is, at USDC's decimals. */
export function usdcUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS))
}

// ---- what the rail publishes about itself ----

/** What /api/celo/status says, as far as a payment is checked against it. */
export type RailStatus = {
  network: string
  chain: string
  payTo: string
  facilitator: string
  usdc: string
  explorer: string | null
  prices: Partial<Record<CeloTool, number>>
}

/**
 * The rail's own status, or null when it is not configured or does not say what a payment
 * needs to be checked against: the USDC it settles in, where it pays to, what it charges.
 */
export function readStatus(body: unknown): RailStatus | null {
  const b = body as
    | {
        configured?: unknown
        network?: unknown
        chain?: unknown
        payTo?: unknown
        facilitator?: unknown
        tools?: unknown
        chains?: Record<string, { usdc?: unknown; explorer?: unknown } | undefined>
      }
    | null
  if (!b || typeof b !== 'object' || b.configured !== true) return null
  if (typeof b.network !== 'string' || typeof b.chain !== 'string' || !isAddress(b.payTo) || typeof b.facilitator !== 'string') return null
  const chain = b.chains?.[b.chain]
  if (!chain || !isAddress(chain.usdc)) return null
  const prices: Partial<Record<CeloTool, number>> = {}
  for (const t of Array.isArray(b.tools) ? (b.tools as { name?: unknown; priceUsd?: unknown }[]) : []) {
    if (t && typeof t.name === 'string' && typeof t.priceUsd === 'number' && t.priceUsd > 0) prices[t.name as CeloTool] = t.priceUsd
  }
  return {
    network: b.network,
    chain: b.chain,
    payTo: b.payTo,
    facilitator: b.facilitator,
    usdc: chain.usdc,
    explorer: typeof chain.explorer === 'string' ? chain.explorer : null,
    prices,
  }
}

// ---- the terms: the server's 402, held against the registry and the rail ----

/**
 * A refusal made before anything was signed. The message is a sentence for the person: what
 * did not add up. The page adds what happened to the money.
 */
export class PayRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayRefusal'
  }
}

export type Terms = {
  tool: CeloTool
  /** CAIP-2 id of the network the payment settles on. */
  network: string
  chainId: number
  /** The USDC contract the authorization is signed against. */
  asset: string
  payTo: string
  /** Base units of USDC, exactly the published price. */
  amount: bigint
  amountUsd: number
  /** How long the signed authorization stays valid. */
  validSeconds: number
  /** The token's EIP-712 domain, as the 402 carries it. */
  domain: { name: string; version: string }
}

/**
 * The terms of one check from the server's 402, refused unless they are the ones the page
 * shows: the registry's Celo, the rail's own USDC and payTo, the published price, the exact
 * scheme. Anything else is a quote this page will not ask a wallet to sign.
 */
export function readTerms(a: { tool: CeloTool; status: RailStatus; expectedNetwork: string; httpStatus: number; body: unknown }): Terms {
  if (a.httpStatus !== 402) {
    throw new PayRefusal(
      a.httpStatus === 501 ? 'The Celo rail is not configured on the server right now.' : `The server did not quote a price (HTTP ${a.httpStatus}).`,
    )
  }
  const b = a.body as { x402Version?: unknown; accepts?: unknown } | null
  if (!b || typeof b !== 'object' || b.x402Version !== 2 || !Array.isArray(b.accepts) || !b.accepts[0]) {
    throw new PayRefusal('The quote is not an x402 version 2 challenge.')
  }
  const r = b.accepts[0] as Record<string, unknown>
  if (r.scheme !== 'exact') throw new PayRefusal(`The quote asks for the "${String(r.scheme)}" scheme; this page pays the exact scheme only.`)
  if (a.status.network !== a.expectedNetwork) throw new PayRefusal(`The rail reports network ${a.status.network}, not Celo (${a.expectedNetwork}).`)
  if (r.network !== a.expectedNetwork) throw new PayRefusal(`The quote is for network ${String(r.network)}, not Celo (${a.expectedNetwork}).`)
  if (!isAddress(r.asset) || !sameAddress(r.asset, a.status.usdc)) {
    throw new PayRefusal(`The quote asks for token ${String(r.asset)}, not the USDC the rail is configured with (${a.status.usdc}).`)
  }
  if (!isAddress(r.payTo) || !sameAddress(r.payTo, a.status.payTo)) {
    throw new PayRefusal(`The quote pays ${String(r.payTo)}, not the rail's own address (${a.status.payTo}).`)
  }
  const priceUsd = a.status.prices[a.tool]
  if (typeof priceUsd !== 'number' || !(priceUsd > 0)) throw new PayRefusal(`The rail publishes no price for ${a.tool}.`)
  if (typeof r.maxAmountRequired !== 'string' || !/^\d+$/.test(r.maxAmountRequired)) throw new PayRefusal('The quote names no amount.')
  const amount = BigInt(r.maxAmountRequired)
  if (amount !== usdcUnits(priceUsd)) {
    throw new PayRefusal(`The quote asks for ${formatUsdc(amount)} USDC; the published price is ${formatUsd(priceUsd)}.`)
  }
  const chainId = Number(/^eip155:(\d+)$/.exec(a.expectedNetwork)?.[1])
  if (!Number.isFinite(chainId)) throw new PayRefusal(`${a.expectedNetwork} is not an EVM network id.`)
  const extra = r.extra as { name?: unknown; version?: unknown } | undefined
  if (!extra || typeof extra.name !== 'string' || typeof extra.version !== 'string') {
    throw new PayRefusal('The quote carries no EIP-712 domain for the token, so the wallet cannot be asked to sign.')
  }
  const validSeconds = typeof r.maxTimeoutSeconds === 'number' && r.maxTimeoutSeconds > 0 ? Math.floor(r.maxTimeoutSeconds) : 600
  return {
    tool: a.tool,
    network: a.expectedNetwork,
    chainId,
    asset: r.asset,
    payTo: r.payTo,
    amount,
    amountUsd: priceUsd,
    validSeconds,
    domain: { name: extra.name, version: extra.version },
  }
}

// ---- the buyer's USDC, read through the wallet ----

/** The eth_call that reads the buyer's USDC: ERC-20 balanceOf(address), selector 0x70a08231. */
export function balanceOfCall(asset: string, holder: string): { to: string; data: string } {
  if (!isAddress(holder)) throw new PayRefusal(`${String(holder)} is not an EVM address.`)
  return { to: asset, data: '0x70a08231' + holder.toLowerCase().slice(2).padStart(64, '0') }
}

/** A hex word from eth_call as base units; null when the answer is not hex. */
export function unitsFromHex(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) return null
  return v.length <= 2 ? 0n : BigInt(v)
}

/** One sentence when the wallet cannot cover the check, null when it can. */
export function fundsProblem(balance: bigint, need: bigint): string | null {
  if (balance >= need) return null
  if (balance === 0n) return `Your wallet holds no USDC on Celo. This check costs ${formatUsdc(need)} USDC.`
  return `Your wallet holds ${formatUsdc(balance)} USDC on Celo; this check costs ${formatUsdc(need)} USDC.`
}

// ---- what the wallet signs ----

export type Authorization = {
  from: string
  to: string
  /** Decimal strings: a wallet's typed-data signer takes uint256 as text. */
  value: string
  validAfter: string
  validBefore: string
  /** 32 random bytes, hex: the facilitator refuses a nonce it has seen. */
  nonce: string
}

export function nonceHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('a nonce is 32 bytes')
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function authorizationFor(terms: Terms, from: string, nonce: string, nowSeconds: number): Authorization {
  return {
    from,
    to: terms.payTo,
    value: terms.amount.toString(),
    validAfter: '0',
    validBefore: String(nowSeconds + terms.validSeconds),
    nonce,
  }
}

export const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const

/**
 * The EIP-712 typed data for eth_signTypedData_v4: the token's domain from the 402, the chain
 * from the registry, the token as verifyingContract. The same object the buyer script signs.
 */
export function typedDataFor(terms: Terms, auth: Authorization) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION],
    },
    primaryType: 'TransferWithAuthorization' as const,
    domain: { name: terms.domain.name, version: terms.domain.version, chainId: terms.chainId, verifyingContract: terms.asset },
    message: auth,
  }
}

/** The X-PAYMENT header: base64 of the x402 v2 exact payload the server decodes. */
export function paymentHeader(terms: Terms, auth: Authorization, signature: string): string {
  const json = JSON.stringify({ x402Version: 2, scheme: 'exact', network: terms.network, payload: { signature, authorization: auth } })
  return btoa(json)
}

// ---- what came back ----

export type Verdict = 'ALLOW' | 'WARN' | 'DENY'

export type PaidAnswer = {
  decision: Verdict | null
  risk: string | null
  reasons: string[]
  agentId: string
  tx: string | null
  payer: string | null
  settledAt: string | null
  amountUsd: number | null
  /** The Celo-side identity read the rail adds to every paid answer. */
  celo: { agentId: string; owner: string; registry: string; explorer: string } | { reason: string } | null
  /** The whole 200 body, settlement included. */
  raw: Record<string, unknown>
}

/** How a purchase stopped short of an answer, each with what happened to the money. */
export type Stop =
  | { kind: 'cancelled' }
  | { kind: 'refusal'; text: string }
  | { kind: 'wallet'; wallet: string; text: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ambiguous'; payTo: string }
  | { kind: 'paid_unreadable'; tx: string | null }
  | { kind: 'unexpected'; status: number }

export type End = { kind: 'paid'; answer: PaidAnswer } | { kind: 'stopped'; stop: Stop }

const VERDICTS: readonly Verdict[] = ['ALLOW', 'WARN', 'DENY']

/**
 * The paid call's answer, by status. Only a 200 with paid:true is an answer; every other
 * status is a stop that says whether money moved, read from the body the server documents.
 */
export function readAnswer(httpStatus: number, body: unknown, payTo: string): End {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const settlement = (b.settlement && typeof b.settlement === 'object' ? b.settlement : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  if (httpStatus === 200 && b.paid === true) {
    const result = (b.result && typeof b.result === 'object' ? b.result : {}) as Record<string, unknown>
    const decision = VERDICTS.find((v) => v === result.decision) ?? null
    const identity = result.celoIdentity as Record<string, unknown> | undefined
    const celo =
      identity && identity.read === true && typeof identity.owner === 'string'
        ? { agentId: str(identity.agentId) ?? '', owner: identity.owner, registry: str(identity.registry) ?? '', explorer: str(identity.explorer) ?? '' }
        : identity && identity.read === false
          ? { reason: str(identity.reason) ?? 'not read' }
          : null
    return {
      kind: 'paid',
      answer: {
        decision,
        risk: str(result.risk),
        reasons: Array.isArray(result.reasons) ? result.reasons.filter((r): r is string => typeof r === 'string') : [],
        agentId: str(result.agentId) ?? '',
        tx: str(settlement.tx),
        payer: str(settlement.payer),
        settledAt: str(settlement.settledAt),
        amountUsd: typeof b.priceUsd === 'number' ? b.priceUsd : null,
        celo,
        raw: b,
      },
    }
  }
  const error = str(b.error) ?? ''
  if (httpStatus === 400) return { kind: 'stopped', stop: { kind: 'refusal', text: error || 'the server did not accept the input' } }
  if (httpStatus === 402) return { kind: 'stopped', stop: { kind: 'refused', reason: str(b.verifyError) ?? 'the payment did not verify' } }
  if (httpStatus === 501) return { kind: 'stopped', stop: { kind: 'unavailable', reason: 'the Celo rail is not configured on the server' } }
  if (httpStatus === 502) {
    // The server says which facilitator call failed. A settle that timed out may still have
    // landed on-chain, so it is the one ending that is not "nothing was charged".
    if (/settle/i.test(error)) return { kind: 'stopped', stop: { kind: 'ambiguous', payTo } }
    return { kind: 'stopped', stop: { kind: 'unavailable', reason: str(b.reason) ?? error ?? 'the facilitator did not answer' } }
  }
  if (httpStatus === 500 && Object.keys(settlement).length > 0) return { kind: 'stopped', stop: { kind: 'paid_unreadable', tx: str(settlement.tx) } }
  return { kind: 'stopped', stop: { kind: 'unexpected', status: httpStatus } }
}

/** One line per ending, each saying what happened to the money. Only true sentences. */
export function stopText(stop: Stop): string {
  switch (stop.kind) {
    case 'cancelled':
      return 'Payment cancelled. Nothing was charged.'
    case 'refusal':
      return `${sentence(stop.text)} Nothing was charged.`
    case 'wallet':
      return `${stop.wallet}: ${sentence(stop.text)} Nothing was charged.`
    case 'refused':
      return `The facilitator did not accept the payment: ${stop.reason}. Nothing was charged.`
    case 'unavailable':
      return `The check could not be made right now: ${stop.reason}. Nothing was charged.`
    case 'ambiguous':
      return `The facilitator did not answer in time, and your payment may still have gone through. Check ${stop.payTo} on the explorer before paying again.`
    case 'paid_unreadable':
      return stop.tx
        ? `Your payment went through, but the answer could not be shown. Receipt: ${stop.tx}.`
        : 'Your payment went through, but the answer could not be shown. It is recorded on /proof/celo.'
    case 'unexpected':
      return `The server answered HTTP ${stop.status}. If your wallet shows a payment, it is on /proof/celo.`
  }
}

/** Endings after which this screen does not offer the same payment again: money may be out. */
export const moneyMayBeOut = (stop: Stop) => stop.kind === 'ambiguous' || stop.kind === 'paid_unreadable' || stop.kind === 'unexpected'

// ---- one purchase, step by step ----

export type Step = 'quoting' | 'checking' | 'signing' | 'confirming'

/** The wallet a payment comes from: its name for the screen, its account, and its EIP-1193 request. */
export type PayWallet = { name: string; from: string; request: (method: string, params: unknown[]) => Promise<unknown> }

/**
 * One check bought from the Celo rail: the terms, the USDC, the signature, the paid call.
 *
 * The caller owns the screen: it is told each step, and says through `alive()` whether it
 * still wants the result. Until the signed payment leaves the page, a caller that moved on
 * (cancelled, closed, left) gets null back and nothing is sent. After it leaves, the outcome
 * is always returned, because from then on it may carry a payment.
 */
export async function purchase(a: {
  tool: CeloTool
  agentId: string
  status: RailStatus
  /** The registry's Celo CAIP-2 id: the only network a quote may name. */
  expectedNetwork: string
  wallet: PayWallet
  /** GET the tool's endpoint: the 402 with the terms. */
  quote: () => Promise<{ status: number; body: unknown }>
  /** POST the tool's endpoint with X-PAYMENT and the JSON body. One send, never retried. */
  post: (header: string, body: string) => Promise<{ status: number; body: unknown }>
  randomBytes: () => Uint8Array
  /** Unix seconds now. */
  now: () => number
  step: (s: Step) => void
  alive: () => boolean
}): Promise<End | null> {
  a.step('quoting')
  let terms: Terms
  try {
    const q = await a.quote()
    terms = readTerms({ tool: a.tool, status: a.status, expectedNetwork: a.expectedNetwork, httpStatus: q.status, body: q.body })
  } catch (e) {
    if (!a.alive()) return null
    return { kind: 'stopped', stop: e instanceof PayRefusal ? { kind: 'refusal', text: e.message } : { kind: 'unavailable', reason: errorText(e) } }
  }
  if (!a.alive()) return null

  // The balance is a courtesy read: a wallet that cannot answer it still gets to sign, and
  // the facilitator's own check is what refuses a payment the wallet cannot cover.
  a.step('checking')
  let balance: bigint | null = null
  try {
    balance = unitsFromHex(await a.wallet.request('eth_call', [balanceOfCall(terms.asset, a.wallet.from), 'latest']))
  } catch {
    balance = null
  }
  if (!a.alive()) return null
  if (balance !== null) {
    const problem = fundsProblem(balance, terms.amount)
    if (problem) return { kind: 'stopped', stop: { kind: 'refusal', text: problem } }
  }

  a.step('signing')
  const auth = authorizationFor(terms, a.wallet.from, nonceHex(a.randomBytes()), a.now())
  let signature: string
  try {
    const s = await a.wallet.request('eth_signTypedData_v4', [a.wallet.from, JSON.stringify(typedDataFor(terms, auth))])
    if (typeof s !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(s)) throw new Error('The wallet returned no usable signature.')
    signature = s
  } catch (e) {
    if (!a.alive()) return null
    return { kind: 'stopped', stop: isRejection(e) ? { kind: 'cancelled' } : { kind: 'wallet', wallet: a.wallet.name, text: errorText(e) } }
  }
  // Leaving before the payment is sent drops the signature: it never leaves this function.
  if (!a.alive()) return null

  a.step('confirming')
  let res: { status: number; body: unknown }
  try {
    res = await a.post(paymentHeader(terms, auth, signature), JSON.stringify({ agentId: a.agentId }))
  } catch {
    // The signed payment left the page and no answer came back: the server may have settled it.
    return { kind: 'stopped', stop: { kind: 'ambiguous', payTo: terms.payTo } }
  }
  return readAnswer(res.status, res.body, terms.payTo)
}

/** "9759" and "#9759" are the same id; anything else is passed as typed. */
export function normalizeAgentId(raw: string): string {
  const q = raw.trim()
  return /^\d{1,78}$/.test(q) ? `#${q}` : q.slice(0, 200)
}

/** Where to open a settlement on the chain's explorer. */
export const txUrl = (explorer: string, tx: string) => `${explorer.replace(/\/+$/, '')}/tx/${tx}`
export const addressUrl = (explorer: string, address: string) => `${explorer.replace(/\/+$/, '')}/address/${address}`
