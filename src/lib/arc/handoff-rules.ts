/**
 * The rules behind an owner's approval on the vault page, as pure functions. This page asks a person
 * to sign a transfer of real money from a link, so each rule here answers one way that goes wrong.
 *
 * Type-only imports plus vault-rules.ts and pending.ts (which import nothing at runtime), named with
 * their .ts extension, on purpose: mcp/src/frontend-arc-handoff.test.ts loads this file straight from
 * src/ through Node's type stripping and tests what each rule RETURNS.
 *
 * PHISHING. A check costs 0.005 USDC and may name any vault, so a stranger can open a flow on someone
 * else's vault with a payee of their own, and the record looks like any other: its owner, its operator
 * and its prepared call are all real. What ties a request to the agent is who paid for the check: Gateway
 * settles only an authorization signed by check.payer, and its ledger must show that payer. So a flow
 * is a request from the agent only when the check's payer is the vault's operator NOW, read from the
 * chain, and was its operator when checked, read from the record. A key that was replaced because it
 * leaked does not keep its requests. Anything else gets no action, on the list or from a direct link.
 * The list shows only a count of them. A direct link shows a plain warning and neither payee nor amount,
 * because the amount and the address are what a phisher wants on screen beside an owner's wallet. What
 * this page knows is who paid, not who asked, so that warning says the page cannot show it came from the
 * agent. A real request from a separate payer key reads that way too, and still gets no action.
 *
 * A key that was revoked or ran out does not keep its requests either. The server refuses a new request
 * from one, because the owner has stopped that agent, and one made just before must not go on asking.
 * Freezing is not the same act: ownerPay works on a frozen vault by design, so a request stays open and
 * the card says who it came from.
 *
 * What that does not do. A payer that is the operator proves that key paid for a check, not that the
 * payment is a good idea: an agent whose key was stolen can ask its owner for anything, and this page
 * shows such a request as what it is, one from the agent's key. The Gateway authorization does not name
 * the payee either, so whoever held a signed authorization of the operator's before it settled could
 * spend it on a check of their own. And the record comes from our server, so a compromised server could
 * write any payer: the payee and the amount on screen are exactly what the wallet is asked to send, and
 * that is as far as this page can go.
 *
 * A vault can also name a victim as its owner at deploy, with a stranger as its operator. The money that
 * moves is that vault's own, never the owner's wallet, so what such a link can cost is a network fee.
 *
 * WHAT IS SIGNED IS WHAT IS SHOWN. owner(), the operator and the balance come from the chain, never from
 * the record. ownerPay(to, amount) is encoded here from what is displayed and compared with the call the
 * record prepared. On any difference there is no action. The wallet is sent the encoding, not the record's.
 *
 * DOUBLE PAYMENT. The contract knows nothing of flows, so two sends pay twice. A hash is kept by flow in
 * this browser before and after the wallet is asked (pending.ts), and no second send is offered until that
 * hash has a final answer. A speed-up gives the same payment a new hash, so a hash that was replaced is
 * not an answer until the vault's own Paid events have been read: see holdOf and paidAfter. And paidAfter
 * also stops a send on a flow some other browser or wallet already paid, whatever this browser remembers.
 * A payment BEFORE the check is no bar, because a new check is how a second payment is meant to happen,
 * but the card says so (paidBefore), since an agent that asks again can be asking for the same invoice.
 * What the page cannot stop is a person answering two wallet prompts, so a second hash stays on the record
 * and is followed and named beside the first (alsoSent in pending.ts, otherSends here). Nor can it close a
 * prompt, and signing one pays whatever has happened since, so it says to decline one that has no reason left
 * (promptLine).
 *
 * STALENESS. A verdict ages: a record can be revoked, or a Sybil cluster found, the moment after it. See
 * HANDOFF_MAX_AGE_SECONDS. A vault's state ages faster, so it is read again and the call simulated right
 * before each send (handoff-send.ts).
 *
 * Amounts are BigInt base units. Text from a record is data: it reaches the page as React text nodes and
 * is never used as a link or as markup. A link is derived here from a checked address or hash.
 */
import { holdsFlow, type HandoffSend, type TxRecord } from './pending.ts'
import type { TxFailure } from './send'
import { formatUnitsExact, sameAddress } from './vault-rules.ts'

/**
 * How long after its check a hand-off is offered: 24 hours, by the chain's clock. A person has to be able
 * to find it, and an agent can ask while its owner is asleep, so anything much under a working day sends
 * owners back for a new check they did not need. A check costs 0.005 USDC and a few seconds, and past a
 * day our answer may be wrong with nobody having seen it change, so past that the page wants a fresh
 * one. The chain's clock, because a browser's can be anything.
 */
export const HANDOFF_MAX_AGE_SECONDS = 86_400n

/** The selector of ownerPay(address,uint256). The test holds it to the contract's ABI and to viem's encoding. */
export const OWNER_PAY_SELECTOR = '0x84f6db2e'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const UINT = /^[0-9]{1,78}$/
/** A record's reasons are the server's words, kept to what a person reads. */
const MAX_REASONS = 12
const MAX_REASON_CHARS = 600

/**
 * How far before a check the vault's payments are read, for the line that says it already paid this: six
 * hours, about five log windows. An agent that asks again for one invoice does so in the same working
 * session, and this read happens every time the page opens, so a day of it would be eighteen windows
 * from two hosts each, before an owner sees a button. At about two blocks a second.
 */
export const PAID_LOOKBACK_BLOCKS = 43_200n
export const PAID_LOOKBACK_WORDS = '6 hours'

const pad32 = (hex: string) => hex.padStart(64, '0')

/** ownerPay(to, amount), encoded from these two values and nothing else. The one encoder the page has. */
export function ownerPayCalldata(to: string, amount: bigint): `0x${string}` {
  if (!ADDRESS.test(to)) throw new RangeError('ownerPay needs a 0x address')
  if (amount < 0n || amount >= 2n ** 256n) throw new RangeError('ownerPay needs an amount that fits a uint256')
  return `${OWNER_PAY_SELECTOR}${pad32(to.slice(2).toLowerCase())}${pad32(amount.toString(16))}` as `0x${string}`
}

export type HandoffVerdict = {
  decision: string | null
  effective: string | null
  risk: string | null
  reasons: string[]
  reputationScore: number | null
  /** Set when the server's own checks overrode the decision. */
  overridden: boolean
}

/** One flow record, shaped and checked. Everything here is the server's word. */
export type HandoffFlow = {
  flowId: string
  network: string
  vault: string
  owner: string
  operator: string
  payee: string
  amount: bigint
  outcome: string
  detail: string
  /** The gate in pay() that makes this the owner's, whatever the verdict said. */
  ownerOnly: 'PayeeNotAllowed' | 'AboveAutoApprove' | null
  /** Who paid for the check, and how Gateway's ledger left it. */
  payer: string
  settled: boolean
  /** The check's settlement time, ISO, and the same in UNIX seconds; null when it does not parse. */
  checkedAt: string
  checkedAtSec: bigint | null
  /** A payment answers this check only in a later block. null: no payment can. */
  verdictBlock: bigint | null
  verdict: HandoffVerdict | null
  prepared: { from: string; to: string; data: string; fn: string; args: [string, string] } | null
  payment: { txHash: string; blockNumber: string; status: string; byOwner: boolean | null; revertReason: string | null } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A flow record as the page may read it, or null when it is not one. A shape nobody expected gets no action. */
export function parseFlow(raw: unknown): HandoffFlow | null {
  if (!isObject(raw)) return null
  const flowId = str(raw.flowId)
  const network = str(raw.network)
  const vault = str(raw.vault)
  const owner = str(raw.owner)
  const operator = str(raw.operator)
  const payee = str(raw.payee)
  const amount = str(raw.amount)
  const outcome = str(raw.outcome)
  const detail = str(raw.detail)
  const check = isObject(raw.check) ? raw.check : null
  const payer = str(check?.payer)
  if (!flowId || !HASH.test(flowId) || !network || !outcome || !detail) return null
  if (!vault || !ADDRESS.test(vault) || !owner || !ADDRESS.test(owner) || !operator || !ADDRESS.test(operator)) return null
  if (!payee || !ADDRESS.test(payee) || !amount || !UINT.test(amount) || !payer || !ADDRESS.test(payer)) return null
  const checkedAt = str(check?.checkedAt) ?? ''
  const ms = Date.parse(checkedAt)
  const vb = str(check?.verdictBlock)
  const v = isObject(raw.verdict) ? raw.verdict : null
  const reasons = Array.isArray(v?.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string').slice(0, MAX_REASONS).map((r) => r.slice(0, MAX_REASON_CHARS)) : []
  const p = isObject(raw.prepared) ? raw.prepared : null
  const args = Array.isArray(p?.args) && typeof p.args[0] === 'string' && typeof p.args[1] === 'string' ? ([p.args[0], p.args[1]] as [string, string]) : null
  const prepared = p && str(p.from) && str(p.to) && str(p.data) && str(p.function) && args ? { from: p.from as string, to: p.to as string, data: p.data as string, fn: p.function as string, args } : null
  const pay = isObject(raw.payment) ? raw.payment : null
  const txHash = str(pay?.txHash)
  return {
    flowId: flowId.toLowerCase(),
    network,
    vault,
    owner,
    operator,
    payee,
    amount: BigInt(amount),
    outcome,
    detail,
    ownerOnly: raw.ownerOnly === 'PayeeNotAllowed' || raw.ownerOnly === 'AboveAutoApprove' ? raw.ownerOnly : null,
    payer,
    settled: check?.gatewayOutcome === 'credited' || check?.gatewayOutcome === 'completed',
    checkedAt,
    checkedAtSec: Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null,
    verdictBlock: vb && /^[0-9]{1,30}$/.test(vb) ? BigInt(vb) : null,
    verdict: v
      ? {
          decision: str(v.decision),
          effective: str(v.effective),
          risk: str(v.risk),
          reasons,
          reputationScore: typeof v.reputationScore === 'number' && Number.isFinite(v.reputationScore) ? v.reputationScore : null,
          overridden: typeof v.overriddenBecause === 'string',
        }
      : null,
    prepared,
    payment:
      pay && txHash && HASH.test(txHash)
        ? {
            txHash: txHash.toLowerCase(),
            blockNumber: str(pay.blockNumber) ?? '',
            status: str(pay.status) ?? '',
            byOwner: typeof pay.byOwner === 'boolean' ? pay.byOwner : null,
            revertReason: str(pay.revertReason),
          }
        : null,
  }
}

/** The chain's word on the vault: the page's own snapshot satisfies this. */
export type LiveVault = {
  network: string
  address: string
  owner: string
  operator: string
  balance: bigint
  chainTime: bigint
  decimals: number
  knownBuild: boolean
  usdcMatches: boolean
  /** The agent key has an end date and the chain's clock is past it: revoked, or ran out. */
  expired: boolean
}

export type HandoffStanding =
  | { kind: 'approvable' }
  /** The chain proved a payment, and the server read it. */
  | { kind: 'settled' }
  /** The prepared call was sent and reverted: nothing moved, and the flow is over. */
  | { kind: 'reverted'; why: string | null }
  /** DENY, or an answer treated as one. */
  | { kind: 'refused'; why: string }
  /** Not the owner's to pay: an ALLOW the agent sends itself, or something that never became a flow. */
  | { kind: 'not_the_owners'; why: string }
  | { kind: 'not_this_vault'; why: string }
  /** A stranger's check, or one a key paid for that is not the operator now. */
  | { kind: 'not_from_agent'; payer: string; operator: string }
  /** The agent key that asked has since been revoked, or ran out. */
  | { kind: 'key_stopped'; payer: string }
  | { kind: 'record_differs'; what: string }
  | { kind: 'no_human' }
  | { kind: 'pays_agent' }
  | { kind: 'stale'; ageSeconds: bigint | null }
  | { kind: 'no_balance'; have: bigint }

/**
 * Where this flow stands against the chain. Only 'approvable' can lead to an action. The order matters:
 * a finished flow says so first, whoever paid for it; a stranger's is named as that before anything about
 * its age or its amount, because those are not this owner's business.
 */
export function standingOf(f: HandoffFlow, live: LiveVault): HandoffStanding {
  if (f.network !== live.network || !sameAddress(f.vault, live.address)) return { kind: 'not_this_vault', why: f.network !== live.network ? `this flow is on ${f.network}, not on the network this page is reading` : `this flow names the vault ${f.vault}, not this one` }
  if (f.outcome === 'executed' && f.payment?.status === 'success') return { kind: 'settled' }
  if (f.outcome === 'failed' || (f.outcome === 'blocked' && f.detail === 'reverted_onchain')) return { kind: 'reverted', why: f.payment?.revertReason ?? null }
  if (f.outcome === 'blocked') return { kind: 'refused', why: f.detail === 'deny' ? 'The check answered DENY.' : f.detail === 'warn_no_human_gate' ? "The check answered WARN, and this vault's owner and operator are one key, so there was nobody to hand it to." : 'The check was paid, and its answer could not be used, so it is treated as a DENY.' }
  if (f.outcome !== 'awaiting_human') return { kind: 'not_the_owners', why: f.outcome === 'pending' ? 'This one is the agent\'s to send, and it is not waiting for you.' : `This flow reads ${f.outcome}, so it is not waiting for you.` }
  const e = f.verdict?.effective
  if (f.verdict === null || f.verdict.overridden || (e !== 'ALLOW' && e !== 'WARN') || f.verdict.decision !== e) return { kind: 'refused', why: 'The check did not answer ALLOW or WARN.' }
  if (!f.settled || !sameAddress(f.payer, live.operator) || !sameAddress(f.operator, live.operator)) return { kind: 'not_from_agent', payer: f.payer, operator: live.operator }
  if (live.expired) return { kind: 'key_stopped', payer: f.payer }
  const differs = recordDiffers(f, live)
  if (differs) return { kind: 'record_differs', what: differs }
  if (sameAddress(live.owner, live.operator)) return { kind: 'no_human' }
  if (sameAddress(f.payee, live.operator)) return { kind: 'pays_agent' }
  if (f.checkedAtSec === null || f.checkedAtSec > live.chainTime + 300n) return { kind: 'stale', ageSeconds: null }
  const age = live.chainTime > f.checkedAtSec ? live.chainTime - f.checkedAtSec : 0n
  if (age > HANDOFF_MAX_AGE_SECONDS) return { kind: 'stale', ageSeconds: age }
  if (live.balance < f.amount) return { kind: 'no_balance', have: live.balance }
  return { kind: 'approvable' }
}

/** What the record says differently from the chain and from its own payee and amount, or null. */
export function recordDiffers(f: HandoffFlow, live: Pick<LiveVault, 'owner' | 'address'>): string | null {
  if (!sameAddress(f.owner, live.owner)) return `the record names the owner ${f.owner}, and the chain says ${live.owner}`
  const p = f.prepared
  if (!p) return 'the record holds no prepared call'
  if (p.fn !== 'ownerPay(address,uint256)') return `the record prepared ${p.fn}, not ownerPay`
  if (!sameAddress(p.to, live.address)) return `the record prepared a call to ${p.to}, not to this vault`
  if (!sameAddress(p.from, live.owner)) return `the record prepared a call from ${p.from}, not from the vault's owner`
  if (!sameAddress(p.args[0], f.payee) || p.args[1] !== f.amount.toString()) return 'the arguments the record prepared are not the payee and the amount it describes'
  if (f.verdictBlock === null) return 'the record was never pinned to a block after its verdict, so no payment could be shown to come after it'
  if (p.data.toLowerCase() !== ownerPayCalldata(f.payee, f.amount)) return 'the call the record prepared is not ownerPay of the payee and the amount it describes'
  return null
}

/** Why the connected wallet cannot act here, or null. Read every time, because a wallet can move at any moment. */
export function walletBlock(w: { account: string | null; chainId: number | null }, live: Pick<LiveVault, 'owner'>, chainId: number | null): 'connect' | 'not_owner' | 'wrong_chain' | null {
  if (!w.account) return 'connect'
  if (!sameAddress(w.account, live.owner)) return 'not_owner'
  if (chainId === null || w.chainId !== chainId) return 'wrong_chain'
  return null
}

/** A build this page does not deploy, or another token: no call is built for it. */
const OUR_BUILD_ONLY = "This vault's code is not the build this page deploys, or it holds another token, so this page builds no calls for it."

/**
 * Why this must not go to a wallet right now, as a failure the page can explain, or null. Asked with
 * what was just read, right before each send. What the vault's Paid events say is asked after this,
 * because it takes a read: see paidAfter.
 */
export function sendStop(f: HandoffFlow, live: LiveVault, w: { account: string | null; chainId: number | null; wantChainId: number | null }, records: readonly HandoffSend[]): TxFailure | null {
  if (!live.knownBuild || !live.usdcMatches) return { code: 'not_this_build', message: OUR_BUILD_ONLY }
  const s = standingOf(f, live)
  switch (s.kind) {
    case 'approvable':
      break
    case 'settled':
      return { code: 'handoff_already_paid', message: 'The server has already read a payment for this from the chain.' }
    case 'reverted':
      return { code: 'handoff_ended', message: `This payment was sent and reverted${s.why ? ` (${s.why})` : ''}, so this flow is over.` }
    case 'refused':
    case 'not_the_owners':
    case 'not_this_vault':
      return { code: 'handoff_ended', message: s.why }
    case 'not_from_agent':
      return { code: 'handoff_not_from_agent', message: `The check was paid for by ${s.payer}, and this vault's agent key is ${s.operator}.` }
    case 'key_stopped':
      return { code: 'handoff_key_stopped', message: `The check was paid for by ${s.payer}, and that key has since been revoked or has run out.` }
    case 'record_differs':
      return { code: 'handoff_changed', message: `The record does not match: ${s.what}.` }
    case 'no_human':
      return { code: 'handoff_changed', message: "This vault's owner and agent are one key, so there is no person behind this approval to tell apart from the agent." }
    case 'pays_agent':
      return { code: 'handoff_changed', message: "This pays your agent's own key. To give it USDC for network fees, use Withdraw and check the address yourself." }
    case 'stale':
      return { code: 'handoff_stale', message: s.ageSeconds === null ? 'The time of this check cannot be read, so its age cannot be known.' : 'This check is more than 24 hours old, and an answer that old may no longer be right.' }
    case 'no_balance':
      return { code: 'handoff_no_balance', message: `The vault holds ${formatUnitsExact(s.have, live.decimals)} USDC, and this pays ${formatUnitsExact(f.amount, live.decimals)} USDC.` }
  }
  const blocked = walletBlock(w, live, w.wantChainId)
  if (blocked === 'connect') return { code: 'no_wallet', message: 'Connect the wallet that owns this vault to approve this.' }
  if (blocked === 'not_owner') return { code: 'account_mismatch', message: `Your connected account is ${w.account}, and this vault's owner is ${live.owner}. Nothing was sent.` }
  if (blocked === 'wrong_chain') return { code: 'wrong_chain', message: 'Your wallet is on another network than this payment. Nothing was sent.' }
  if (holdFor(f, records).held) return { code: 'handoff_held', message: 'This browser has already sent this, or a payment like it, and has no final answer for it yet.' }
  return null
}

// --- has this been paid already ---

export type PaidEvent = { to: string; amount: bigint; byOwner: boolean; block: bigint; txHash: string }

/**
 * A payment from this vault of this amount to this payee, after this flow's verdict came back. The
 * contract cannot tell two invoices apart, so one of these means this check has had its payment, whichever
 * key, browser or wallet sent it: a second one needs a new check, which then has a later block than it.
 * Prefers the owner's own, since that is the one a receipt can close this flow with.
 */
export function paidAfter(f: Pick<HandoffFlow, 'payee' | 'amount' | 'verdictBlock'>, events: readonly PaidEvent[]): PaidEvent | null {
  if (f.verdictBlock === null) return null
  const after = f.verdictBlock
  const hits = events.filter((e) => e.block > after && e.amount === f.amount && sameAddress(e.to, f.payee))
  return hits.find((e) => e.byOwner) ?? hits[0] ?? null
}

/**
 * The newest payment of this amount to this payee in the hours before this check, whoever sent it. It does
 * not stop anything: paying a payee the same amount twice can be meant, and a new check is how that is
 * done. It is what a person wants to see beside a button if it is the same invoice.
 */
export function paidBefore(f: Pick<HandoffFlow, 'payee' | 'amount' | 'verdictBlock'>, events: readonly PaidEvent[]): PaidEvent | null {
  if (f.verdictBlock === null) return null
  const floor = f.verdictBlock - PAID_LOOKBACK_BLOCKS
  let newest: PaidEvent | null = null
  for (const e of events) {
    if (e.block > f.verdictBlock || e.block <= floor || e.amount !== f.amount || !sameAddress(e.to, f.payee)) continue
    if (!newest || e.block > newest.block) newest = e
  }
  return newest
}

/**
 * What a read of the vault's Paid events covers, one contiguous range. `short` is why a read stopped before
 * the block it was asked for. What is in the range is still known, so a check inside it is still answered.
 */
export type PaidScan = { from: bigint; through: bigint; paid: PaidEvent[]; short: string | null }

/** Two reads as one, or null when there is a gap between them: nothing may be claimed about a gap. */
export function joinScans(held: PaidScan, fresh: PaidScan): PaidScan | null {
  if (fresh.from > held.through + 1n || held.from > fresh.through + 1n) return null
  const seen = new Set<string>()
  const paid: PaidEvent[] = []
  for (const e of [...held.paid, ...fresh.paid]) {
    const key = `${e.txHash.toLowerCase()}:${e.to.toLowerCase()}:${e.amount}`
    if (seen.has(key)) continue
    seen.add(key)
    paid.push(e)
  }
  return { from: fresh.from < held.from ? fresh.from : held.from, through: fresh.through > held.through ? fresh.through : held.through, paid, short: fresh.short }
}

/**
 * This browser still has to look for this send's payment: it has no final answer, or the person said
 * nothing was sent a short while ago. A person can press that with a slow wallet's prompt still open.
 */
export const RELEASE_WATCH_MS = 10 * 60_000

export function stillWatched(r: HandoffSend | null | undefined, now: number): boolean {
  if (!r || r.server) return false
  const h = holdOf(r)
  if (h.held) return true
  return typeof r.releasedAt === 'string' && now - Date.parse(r.releasedAt) < RELEASE_WATCH_MS
}

/**
 * The lowest block the page reads the vault's payments from: only for flows it could offer, and for what
 * this browser is still following. Nothing else may reach this read. A flow has no way to close, so an old
 * one stays on the list, and anyone can send a link naming any old flow on any vault, and neither gets to
 * make the owner's browser read a week of logs. It reads back past the check for an offered flow, and only
 * from the check for a followed one, whose question is whether its own payment landed. A flow the person freed
 * is both, and the offer is asked first: paymentsRead holds its button back for the hours before the check.
 */
export function scanStart(rows: readonly { f: HandoffFlow; s: HandoffStanding }[], records: readonly HandoffSend[], declined: readonly string[], now: number): bigint | null {
  let from: bigint | null = null
  for (const { f, s } of rows) {
    if (f.verdictBlock === null || s.kind === 'not_this_vault') continue
    const after = f.verdictBlock + 1n
    const record = records.find((r) => holdsFlow(r, f.flowId))
    let wanted: bigint | null = null
    if (s.kind === 'approvable' && !declined.includes(f.flowId) && !holdOf(record).held) wanted = after > PAID_LOOKBACK_BLOCKS ? after - PAID_LOOKBACK_BLOCKS : 0n
    else if (stillWatched(record, now)) wanted = after
    if (wanted !== null && (from === null || wanted < from)) from = wanted
  }
  return from
}

/**
 * Whether the read answered for this one flow, whatever it managed for any other, so one old flow cannot
 * stop the page offering a fresh one. 'ok': it read from the check up, and the hours before it.
 * 'no_lookback': from the check up, and not the hours before. 'failed': it did not reach this check, and
 * nothing is offered. A read in flight is 'reading' until it answers or stops.
 */
export function paymentsRead(f: Pick<HandoffFlow, 'verdictBlock'>, scan: Pick<PaidScan, 'from' | 'short'> | null, failed: string | null): 'reading' | 'failed' | 'ok' | 'no_lookback' {
  if (f.verdictBlock === null) return 'failed'
  const stopped = failed !== null || (scan?.short ?? null) !== null
  if (!scan || scan.from > f.verdictBlock + 1n) return stopped ? 'failed' : 'reading'
  const after = f.verdictBlock + 1n
  const lookback = after > PAID_LOOKBACK_BLOCKS ? after - PAID_LOOKBACK_BLOCKS : 0n
  if (scan.from <= lookback) return 'ok'
  return stopped ? 'no_lookback' : 'reading'
}

// --- what this browser sent ---

export type Hold =
  | { held: false }
  /** The wallet was asked and no hash came back. If it sent it, the Paid events will show it. */
  | { held: true; why: 'asked' }
  /** A hash on its way, with no final answer yet. */
  | { held: true; why: 'pending'; hash: string }
  /** It may still land: no receipt was seen, and nothing shows it can no longer land. */
  | { held: true; why: 'maybe'; hash: string }
  /** It landed, or a payment was found, and the server has not given its final answer. */
  | { held: true; why: 'landed'; hash: string }
  /** This flow has had its payment attempt, with this final answer. */
  | { held: true; why: 'answered'; hash: string }

/**
 * Whether what this browser sent still stands in the way of a send. Only two things free a flow: a hash
 * that was replaced with no payment of it found on chain, and the person saying they checked their
 * wallet. 'replaced' means the nonce went to something else, and a speed-up is exactly that, so nothing
 * here frees a flow on 'replaced' until the Paid events were read (replacedClear is set by whoever read them).
 */
export function holdOf(s: HandoffSend | null | undefined): Hold {
  if (!s) return { held: false }
  const own = holdOfRecord(s)
  const others = otherSends(s)
  if (others.length === 0) return own
  // With more than one send, the one that can still move money speaks for the record.
  const holds = [own, ...others.map((t) => holdOfTx(s, t))]
  for (const why of HOLD_ORDER) {
    const h = holds.find((x) => x.held && x.why === why)
    if (h) return h
  }
  return { held: false }
}

/** Strongest first. An answer outranks a landed hash, because the answer is what that hash was waiting for. */
const HOLD_ORDER = ['pending', 'maybe', 'asked', 'answered', 'landed'] as const

/**
 * The transactions on a record of more than one send that its own lines do not speak for: every one beside
 * the first, and once the server has answered, every one but the hash it answered about. A hash the read found
 * as the payment is spoken for already. One that was replaced can no longer land, so it holds nothing and is
 * followed no further: what replaced it is another hash, which the wallet's activity and the vault's show.
 */
export function otherSends(s: HandoffSend): TxRecord[] {
  if (!s.alsoSent?.length) return []
  const spoken = (s.server?.txHash ?? s.paidBy ?? '').toLowerCase()
  return (s.server ? [...(s.tx ? [s.tx] : []), ...s.alsoSent] : s.alsoSent).filter((t) => t.outcome !== 'replaced' && t.hash.toLowerCase() !== spoken)
}

/**
 * There is a second hash on this record that can have paid, which is what the card's alert waits for. A send
 * carried from an earlier claim, with nothing beside it, is one send. And a hash that came back after the read
 * found a payment can be that payment's own first hash, which a speed-up replaced, so beside paidBy it is followed
 * and not counted until the chain says it landed: a single prompt must not read as two payments. A send the person
 * said is dropped or cancelled, which no receipt ever showed, stops counting as holdOfTx stops holding it.
 */
export function moreThanOneSend(s: HandoffSend): boolean {
  if (otherSends(s).length === 0) return false
  const sends = [...(s.tx ? [s.tx] : []), ...(s.alsoSent ?? [])].filter((t) => t.outcome !== 'replaced' && !(t.outcome === 'untracked' && s.released) && !(s.paidBy && (t.outcome === 'pending' || t.likelyReplaced)))
  return new Set([...sends.map((t) => t.hash.toLowerCase()), ...(s.paidBy ? [s.paidBy.toLowerCase()] : [])]).size > 1
}

/** Said when a send beside the first was replaced. It left the record's alert, and if the wallet sped it up, what replaced it can pay. */
export function replacedSendLine(s: HandoffSend): string | null {
  if (s.paidBy || !s.alsoSent?.some((t) => t.outcome === 'replaced')) return null
  return "Another transaction for this request was replaced in your wallet, so that hash can no longer land. If your wallet sped it up, what replaced it can still pay: the vault's recent activity on this page shows what it paid."
}

function holdOfRecord(s: HandoffSend): Hold {
  const hash = s.paidBy ?? s.tx?.hash
  if (s.server) return { held: true, why: 'answered', hash: hash ?? '' }
  if (s.paidBy) return { held: true, why: 'landed', hash: s.paidBy }
  if (!s.tx) return s.released ? { held: false } : { held: true, why: 'asked' }
  return holdOfTx(s, s.tx)
}

function holdOfTx(s: HandoffSend, tx: TxRecord): Hold {
  switch (tx.outcome) {
    case 'pending':
      return { held: true, why: 'pending', hash: tx.hash }
    case 'settled':
    case 'unexpected':
    case 'reverted':
      return { held: true, why: 'landed', hash: tx.hash }
    case 'replaced':
      return s.replacedClear || s.released ? { held: false } : { held: true, why: 'maybe', hash: tx.hash }
    case 'untracked':
      return s.released ? { held: false } : { held: true, why: 'maybe', hash: tx.hash }
  }
}

/**
 * What holds this flow back: its own record, or an unresolved send of the same amount to the same payee
 * from this vault, since a second flow is no reason to pay the same invoice while the first may still land.
 */
export function holdFor(f: Pick<HandoffFlow, 'flowId' | 'payee' | 'amount'>, records: readonly HandoffSend[]): Hold {
  const own = holdOf(records.find((r) => holdsFlow(r, f.flowId)))
  if (own.held) return own
  for (const r of records) {
    if (holdsFlow(r, f.flowId) || !sameAddress(r.payee, f.payee) || r.amount !== f.amount) continue
    const other = holdOf(r)
    // A send that got its answer is over. A new check after it is how a second payment is meant to happen.
    if (other.held && other.why !== 'answered') return other
  }
  return { held: false }
}

/**
 * This send holds the rest of the page's controls: it may still move money. A transaction that landed is
 * final on chain and only our server's record of it is outstanding, so the owner's own controls do not
 * wait for our backend. A second send of this payment still does: see holdFor.
 */
export function holdsPage(r: HandoffSend): boolean {
  const h = holdOf(r)
  return h.held && h.why !== 'answered' && h.why !== 'landed'
}

/**
 * Whether this flow's card is what this browser sent, with its tracker, rather than what the flow's record
 * says. Only that tracker finishes a record: it follows the hash, posts it, and writes the server's answer.
 * So a record with no answer keeps it on a flow another browser or a phone already closed. The post gets the
 * recorded answer or a refusal. Without it a pending hash holds the page's controls, and a landed one every
 * later check of the same payee and amount, with nothing on screen to finish or stop. A record of more than one
 * send stays there, because the flow's own card names one transaction, and the other may have paid too. So does
 * a refusal on a flow that is over: another hash closed it, and the flow's card says nothing of this one, which
 * may have paid beside it, or reverted beside a card that names a payment. What keeps the records bounded
 * still drops such a refusal in the end, past the newest fifty answers.
 */
export function followedHere(r: HandoffSend | null | undefined, s: HandoffStanding): boolean {
  if (!r || !holdOf(r).held) return false
  return !r.server || !flowIsOver(s) || otherSends(r).length > 0 || r.server.state === 'refused'
}

/** The flow's record says it is finished, one way or the other: nothing more can happen to it. */
export function flowIsOver(s: HandoffStanding): boolean {
  return s.kind === 'settled' || s.kind === 'reverted'
}

/** How long a final answer is shown for a record whose flow did not read back. */
export const ANSWER_SHOWN_MS = 10 * 60_000

/**
 * What this browser sent whose flow could not be read just now, and still has something to say: no final
 * answer yet, one given in the last few minutes, or a transaction the answer does not speak for, which nothing
 * else on the page names. An old answer has nothing to add, and only a few flows are read back, so without this
 * every older approval would stay on the page as a card with nothing in it.
 */
export function unreadRecords(records: readonly HandoffSend[], flowIds: readonly string[], now: number): HandoffSend[] {
  return records.filter((r) => {
    if (flowIds.some((id) => holdsFlow(r, id))) return false
    const h = holdOf(r)
    if (!h.held) return false
    if (h.why !== 'answered' || otherSends(r).length > 0) return true
    return now - Date.parse(r.server?.at ?? '') < ANSWER_SHOWN_MS
  })
}

/** The order this browser's flows are read back in, of which only the first few are read: what has no answer, what names a transaction the answer does not, then the rest. */
export function readOrder(records: readonly HandoffSend[]): HandoffSend[] {
  const rank = (r: HandoffSend) => (!r.server ? 0 : otherSends(r).length > 0 ? 1 : 2)
  return [...records].sort((a, b) => rank(a) - rank(b))
}

/** A host is read if it is within 100 blocks of the best, about 50 seconds, so a read this long after a replacement has seen it. */
export const REPLACED_WATCH_MS = 60_000

/**
 * What a read of the vault's Paid events says about a send with no answer. A payment of this amount to
 * this payee from the owner, after this check, is this send's whatever hash it has: that is how a
 * wallet's speed-up shows up, and a wallet asked with no hash back. A replacement that shows no payment
 * is a cancel, but only a read well after it can say so, and only one that came down to this check: a
 * read that stopped short is answered, not failed, and what it did not reach holds no news either way.
 * A person's "nothing was sent", and a quiet replacement, free the flow and prove nothing: a slow wallet
 * can still send it. If the payment shows up after that it is this send's too, and what the page says and
 * does goes back to following it.
 */
export function afterScan(s: HandoffSend, f: Pick<HandoffFlow, 'payee' | 'amount' | 'verdictBlock'>, scan: Pick<PaidScan, 'from' | 'paid'>, now: number): HandoffSend {
  if (s.server || s.paidBy) return s
  const h = holdOf(s)
  if (h.held ? h.why !== 'asked' && h.why !== 'maybe' : !s.released && !s.replacedClear) return s
  const hit = paidAfter(f, scan.paid)
  if (hit?.byOwner) return { ...s, paidBy: hit.txHash.toLowerCase() }
  if (!h.held || s.tx?.outcome !== 'replaced') return s
  if (f.verdictBlock === null || scan.from > f.verdictBlock + 1n) return s
  if (!s.replacedSeenAt) return { ...s, replacedSeenAt: new Date(now).toISOString() }
  return now - Date.parse(s.replacedSeenAt) >= REPLACED_WATCH_MS ? { ...s, replacedClear: true } : s
}

/**
 * The hash to post for this send, once there is one the chain has an answer about. Of two, the one that paid.
 * A revert waits while another is still on its way, because the post would end the flow, and that one can
 * still pay it.
 */
export function hashToPost(s: HandoffSend): string | null {
  if (s.server) return null
  if (s.paidBy) return s.paidBy
  const sends = [...(s.tx ? [s.tx] : []), ...(s.alsoSent ?? [])]
  const paid = sends.find((t) => t.outcome === 'settled')
  if (paid) return paid.hash
  if (sends.some((t) => t.outcome === 'pending')) return null
  return sends.find((t) => t.outcome === 'unexpected' || t.outcome === 'reverted')?.hash ?? null
}

// --- what the server said ---

export type ReceiptStep =
  /** Post it again later: nothing was decided. */
  | { step: 'retry'; waitMs: number; reason: string }
  /** The chain proved this flow's payment. */
  | { step: 'settled' }
  /** The chain proved the prepared call reverted, and the flow ended on it. */
  | { step: 'ended'; outcome: string; detail: string | null; reason: string | null }
  /** The payment answers another check on the same vault, payee and amount, or is already linked to it. Post the same hash there. */
  | { step: 'moved'; flowId: string; reason: string }
  /** The server read it and it does not prove this flow. Final for this hash, and it is not settled. */
  | { step: 'refused'; code: string; reason: string }

const RETRY_MS = 5_000
const RATE_WINDOW_MS = 61_000

/** The status and body of POST .../receipt as what the page does next. Anything unrecognized is a retry, never settled. */
export function receiptStep(status: number, body: unknown): ReceiptStep {
  const b = isObject(body) ? body : {}
  const reason = str(b.reason) ?? str(b.next) ?? (status === 0 ? 'our server could not be reached' : `the server answered ${status}`)
  if (status === 429) return { step: 'retry', waitMs: RATE_WINDOW_MS, reason }
  if (b.verified === true && b.outcome === 'executed' && isObject(b.payment) && b.payment.status === 'success') return { step: 'settled' }
  if (b.verified === true && (b.outcome === 'failed' || b.outcome === 'blocked')) return { step: 'ended', outcome: b.outcome, detail: str(b.detail), reason: str(b.reason) ?? str(b.next) }
  if (b.retry === true || status === 202 || status >= 500 || status === 0) return { step: 'retry', waitMs: RETRY_MS, reason }
  if ((b.code === 'TX_ANSWERS_LATER_CHECK' || b.code === 'TX_LINKED_ELSEWHERE') && typeof b.answersFlow === 'string' && HASH.test(b.answersFlow)) return { step: 'moved', flowId: b.answersFlow.toLowerCase(), reason }
  // Our route names what it refused. A 4xx with no code is an edge or a proxy in front of it, and says nothing about the payment.
  if (status >= 400 && typeof b.code === 'string') return { step: 'refused', code: b.code, reason }
  return { step: 'retry', waitMs: RETRY_MS, reason }
}

// --- what the person reads ---

/** What approving does to today's budget, from the chain's own numbers. ownerPay adds to spentOnDay with no cap check. */
export function budgetEffect(amount: bigint, live: { spentToday: bigint; dailyCap: bigint }): { after: bigint; stopsAgent: boolean; overBy: bigint; leftForAgent: bigint | null } {
  const after = live.spentToday + amount
  if (live.dailyCap === 0n) return { after, stopsAgent: false, overBy: 0n, leftForAgent: null }
  return {
    after,
    stopsAgent: after >= live.dailyCap,
    overBy: after > live.dailyCap ? after - live.dailyCap : 0n,
    leftForAgent: after >= live.dailyCap ? 0n : live.dailyCap - after,
  }
}

/** The budget line. Whatever the numbers, it says this counts toward today and can stop the agent until 00:00 UTC. */
export function budgetLine(amount: bigint, live: { spentToday: bigint; dailyCap: bigint; decimals: number }): string {
  const usd = (x: bigint) => `${formatUnitsExact(x, live.decimals)} USDC`
  const e = budgetEffect(amount, live)
  const lead = `Approving counts toward today's budget, even though your payment is not limited by it, and a payment big enough can stop your agent until 00:00 UTC.`
  if (live.dailyCap === 0n) return `${lead} This vault has no daily cap, so it will not stop your agent today.`
  if (e.stopsAgent)
    return `${lead} This one does: ${usd(live.spentToday)} of the ${usd(live.dailyCap)} budget is used today, and this makes it ${usd(e.after)}, so your agent's own payments will be refused until 00:00 UTC.`
  return `${lead} This one leaves ${usd(e.leftForAgent ?? 0n)} of the ${usd(live.dailyCap)} budget for your agent today.`
}

/** Said when the vault is frozen, because ownerPay still works then, by design. */
export const FROZEN_LINE = "This vault is frozen, so your agent cannot pay anything. You still can: approving this sends the money even while the vault is frozen, and it stays frozen afterwards. If you froze it because you do not trust this agent's key, this request came from that key."

/**
 * What a verdict means, in words, ahead of the server's own reasons. A flow record carries the reasons and
 * not the signals behind them, so a WARN is told apart by those. The test feeds this the real scorer's
 * reasons, so a change in mcp/src/asp/risk.ts cannot quietly change which sentence an owner reads. The
 * lead must not say a payee is not bad directly above a reason that says we hold evidence against it.
 */
export function verdictMeaning(effective: string | null, reasons: readonly string[] = []): string {
  const evidence = reasons.some((r) => r.includes('holds evidence against it'))
  if (effective === 'ALLOW') return evidence ? 'ALLOW: the check holds a strong record of this payee, and that record also holds evidence against it. Read the reasons below before you approve.' : 'ALLOW: the check holds a strong record of this payee.'
  if (effective !== 'WARN') return 'This check did not answer ALLOW or WARN.'
  if (evidence) return 'WARN: our record holds evidence against this payee, though not enough for us to refuse it. Read the reasons below before you approve.'
  if (reasons.some((r) => r.includes('Possible Sybil signals'))) return 'WARN: our record shows signs that this payee may be building its reputation with itself. Read the reasons below before you approve.'
  if (reasons.some((r) => r.includes('we hold no record of it'))) return 'WARN: we do not know enough about this payee to vouch for it. That does not mean it is bad, and it does not mean it is clean.'
  return 'WARN: we do not vouch for this payment. Read the reasons below before you approve.'
}

/** The gate that made this the owner's still stands, as far as this page can read it. An allowlist entry is not read here. */
export function ownerOnlyStands(code: HandoffFlow['ownerOnly'], amount: bigint, live: { autoApproveMax: bigint; allowlistEnabled: boolean }): boolean {
  if (code === 'AboveAutoApprove') return live.autoApproveMax !== 0n && amount > live.autoApproveMax
  if (code === 'PayeeNotAllowed') return live.allowlistEnabled
  return false
}

/** Why it is the owner's to pay, when the verdict alone did not decide that, against the vault's limits now and not at the check. */
export function ownerOnlyLine(code: HandoffFlow['ownerOnly'], amount: bigint, live: { autoApproveMax: bigint; allowlistEnabled: boolean; decimals: number }): string | null {
  if (code === null) return null
  if (!ownerOnlyStands(code, amount, live)) return "When your agent checked this, it could not pay it itself. The vault's limits have changed since, so its key may be able to pay this by itself now."
  if (code === 'AboveAutoApprove') return `Your agent cannot pay this itself: it is above the ${formatUnitsExact(live.autoApproveMax, live.decimals)} USDC limit on a single payment. Only you can.`
  return "When your agent checked this, the payee was not on the vault's allowlist, so its key could not pay it. If that is still so, only you can."
}

type CardState = { sent: boolean; held: boolean; paid: boolean; canAct: boolean }

/** The card's heading. It asks only while it can be approved here, and not once something was sent. */
export function cardHeading(s: HandoffStanding, o: CardState): { heading: string; asks: boolean } {
  const asks = o.canAct && (s.kind === 'approvable' || s.kind === 'no_balance') && !o.held && !o.paid
  if (asks) return { heading: 'Your agent asks you to pay this', asks }
  return { heading: o.sent ? 'What this browser sent for this request' : 'A payment your agent asked for', asks }
}

/** The next step on a request this page builds no call for, which it would otherwise leave with no button and nothing to do. */
export function notHereLine(s: HandoffStanding, o: CardState): string | null {
  if (o.canAct || (s.kind !== 'approvable' && s.kind !== 'no_balance') || o.held || o.paid) return null
  return 'This page does not send this one. To pay it, send ownerPay from the owner key: the guide has a sample.'
}

/** The wallet was asked for this flow and no hash came back, so a prompt may still be open in it, wherever that wallet is. */
export function promptMayBeOpen(r: HandoffSend): boolean {
  return !r.tx && !r.hashBack
}

/**
 * What a prompt that may still be open has become, or null while it still stands for what it asked. ownerPay names
 * no flow and the contract keeps no list of what it paid, so a signature pays whatever has happened since. The
 * wallet's prompt is out of this page's reach, and this is the page's one way to stop it. `paid` is what the read
 * of the vault found, whoever's key it was.
 */
export function promptLine(r: HandoffSend | null | undefined, o: { paid: boolean; standing?: HandoffStanding }): string | null {
  if (!r || !promptMayBeOpen(r)) return null
  if (o.paid || r.paidBy || r.server || o.standing?.kind === 'settled' || r.alsoSent?.some((t) => t.outcome === 'settled')) return 'A prompt for this may still be open in your wallet. This payment already left the vault, so decline it: signing it pays this amount again.'
  if (o.standing?.kind === 'reverted') return 'A prompt for this may still be open in your wallet. This request is over, so decline it: signing it still sends this amount from the vault.'
  return null
}

/** What the tracker says when the wallet was asked and nothing came back. It invites a signature only while one still has a reason. */
export function noAnswerLine(promptEnded: boolean): string {
  const rest = 'If your wallet sent it, this page sees the payment land and carries on. Do not start another one from here.'
  return promptEnded ? rest : `If a prompt is still open in your wallet, you can answer it there. ${rest}`
}

/**
 * The hash was replaced and the vault's activity, read well after that, shows no payment of it. Only that read
 * can say so. The person pressing that they checked frees the flow too, and it reads nothing, so a speed-up
 * that paid is still possible then: see the line on what they said.
 */
export function replacedWithNoPayment(r: HandoffSend): boolean {
  return !holdOf(r).held && r.tx?.outcome === 'replaced' && r.replacedClear === true
}

/**
 * The first line of a refusal. On a flow that is over, another hash closed it and this hash was refused for that
 * alone, so what matters is what this one did: it may have paid as well, or reverted with nothing moved.
 */
export function refusedLead(r: HandoffSend, s?: HandoffStanding): string {
  if (!s || !flowIsOver(s) || !r.server) return 'Our server does not take this transaction as proof of this payment, so nothing is marked as settled.'
  const hash = r.server.txHash.toLowerCase()
  const send = [...(r.tx ? [r.tx] : []), ...(r.alsoSent ?? [])].find((t) => t.hash.toLowerCase() === hash)
  const closed = s.kind === 'settled' ? 'Another transaction paid this request and closed it, and this one is not on its record.' : 'Another transaction reverted and closed this request, and this one is not on its record.'
  if (send?.outcome === 'settled' || r.paidBy?.toLowerCase() === hash) return s.kind === 'settled' ? `${closed} This one paid as well: the vault paid this amount twice.` : `${closed} This one paid: the vault moved this amount, whatever the record of this request says.`
  if (send?.outcome === 'reverted') return `${closed} This one reverted, so nothing moved from it, and the network fee was still charged.`
  return `${closed} Look at this one to see what it did.`
}

/** What the card says of a hash the server recorded as reverted. With another send on the record, that one is still its own question. */
export function endedWords(others: number): { lead: string; next: string } {
  if (others > 0) return { lead: 'This one reverted: it moved nothing, and the network fee was still charged.', next: 'This request is over. The other transaction is on its own line here, and if it landed it paid.' }
  return { lead: 'This payment was sent and reverted. Nothing moved, and the network fee was still charged.', next: 'This request is over. If you still mean to pay, ask your agent to check the payee again.' }
}

/** A plain length of time, for how old a check is. */
export function agePhrase(seconds: bigint): string {
  if (seconds < 60n) return 'under a minute'
  if (seconds < 3600n) return `${seconds / 60n} minute${seconds / 60n === 1n ? '' : 's'}`
  if (seconds < 172_800n) return `${seconds / 3600n} hour${seconds / 3600n === 1n ? '' : 's'}`
  return `${seconds / 86_400n} days`
}

/**
 * Said on a direct link to a flow whose check was not paid by this vault's operator. This page knows who
 * paid, not who asked: a real request can come this way, from a separate payer key or from before a key
 * was replaced. So it says what is known, and refuses either way.
 */
export function notFromAgentLine(s: { payer: string; operator: string }): string {
  return `The check behind this link was paid for by ${s.payer}, and this vault's agent key is ${s.operator}, so this page cannot show that it came from your agent. Anyone can buy a check that names any vault. Do not send money because of it unless you know why. If someone you do not know sent you this link and asked you to approve a payment, treat it as an attempt to trick you. Nothing here can be approved.`
}

/** Said on a request from a key the owner has since stopped, or that ran out. */
export function keyStoppedLine(s: { payer: string }): string {
  return `The key ${s.payer} paid for this check, and it has since been revoked or has run out. A stopped key does not get to ask, so this is not offered. If you still mean to pay it, give your agent a working key and ask it for a new check.`
}
