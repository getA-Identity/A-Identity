/**
 * What the page does to the world for an owner's approval: reads the flows waiting on a vault, makes
 * every check again right before a send, posts the receipt. The rules live in handoff-rules.ts; this
 * file gives them the server and the chain.
 *
 * recheckHandoff is the last thing before a wallet opens, and it is asked for the review and again for
 * the send. Each time it reads the flow from the server and the vault from the chain, so nothing on
 * screen is trusted: the flow may have ended, the agent's key may have changed, the vault may have been
 * emptied, the check may have aged out, and another browser may have paid it. Each stop is typed, says
 * nothing was sent, and is told through failure-explain.ts. Then the call is simulated as the owner, by
 * the same prepareOwnerCall every other write on this page uses, and that keeps its fee rule.
 */
import { apiFetch, readJson } from '../api'
import type { Chain } from '../chains'
import { joinScans, paidAfter, parseFlow, receiptStep, recordDiffers, sendStop, type HandoffFlow, type PaidScan, type ReceiptStep } from './handoff-rules'
import { loadHandoffs } from './pending'
import { TxStop, txStop as stop } from './send'
import { readPaidSince } from './vault-events'
import { networkName, readVault, type VaultSnapshot } from './vault-read'
import { sameAddress } from './vault-rules'
import { prepareOwnerCall, type PreparedTx } from './vault-write'

const BASE = '/api/x402/gateway/flows'

export type WaitingRead =
  | { ok: true; flows: HandoffFlow[]; unreadable: number; truncated: boolean; others: { count: number; capped: boolean } }
  | { ok: false; rateLimited: boolean; reason: string }

/** The flows waiting on one vault. A failed read is said to be one, and never reads as nothing waiting. */
export async function readWaitingFlows(vault: string): Promise<WaitingRead> {
  let res: Response
  try {
    res = await apiFetch(`${BASE}?vault=${encodeURIComponent(vault)}`)
  } catch {
    return { ok: false, rateLimited: false, reason: 'Our server could not be reached.' }
  }
  if (res.status === 429) return { ok: false, rateLimited: true, reason: 'Our server is taking too many of these reads right now, and some of them may be other people\'s.' }
  const body = await readJson<{ waiting?: unknown; truncated?: unknown; notFromOperator?: { count?: unknown; capped?: unknown } }>(res)
  if (!res.ok || !Array.isArray(body.waiting)) return { ok: false, rateLimited: false, reason: `Our server could not give the list (it answered ${res.status}).` }
  const flows: HandoffFlow[] = []
  let unreadable = 0
  for (const raw of body.waiting) {
    const f = parseFlow(raw)
    if (f) flows.push(f)
    else unreadable += 1
  }
  const n = body.notFromOperator?.count
  return { ok: true, flows, unreadable, truncated: body.truncated === true, others: { count: typeof n === 'number' && n >= 0 ? n : 0, capped: body.notFromOperator?.capped === true } }
}

export type FlowRead = { ok: true; flow: HandoffFlow } | { ok: false; missing: boolean; reason: string }

/** One flow by id, as the record says it stands right now. */
export async function readFlow(flowId: string): Promise<FlowRead> {
  let res: Response
  try {
    res = await apiFetch(`${BASE}/${encodeURIComponent(flowId)}`)
  } catch {
    return { ok: false, missing: false, reason: 'Our server could not be reached.' }
  }
  if (res.status === 404 || res.status === 400) return { ok: false, missing: true, reason: 'There is no payment with this id.' }
  const body = await readJson<{ flow?: unknown }>(res)
  const flow = res.ok ? parseFlow(body.flow) : null
  return flow ? { ok: true, flow } : { ok: false, missing: false, reason: `Our server could not give this payment's record (it answered ${res.status}).` }
}

export type { PaidScan } from './handoff-rules'

/**
 * The vault's Paid events from this block up, kept for the page's lifetime so a click reads only the
 * blocks since the last read. Nothing is forgotten by reading on: a payment does not un-happen. The answer
 * covers from its own `from`, which can be above the block asked for, and `short` then says why: read
 * paymentsRead for what that means for one flow. `topUpOnly` reads only what is new, so a timer does not
 * start a read that already stopped short all over again.
 */
export async function scanPaid(
  chain: Chain,
  vault: string,
  from: bigint,
  held: PaidScan | null,
  o: { topUpOnly?: boolean; onProgress?: (scan: PaidScan) => void } = {},
): Promise<PaidScan | { failed: string }> {
  if (held && (held.from <= from || o.topUpOnly)) {
    const r = await readPaidSince(chain, vault, held.through + 1n)
    if (!r.ok) return { failed: r.reason }
    if (r.short) return { failed: r.short }
    const joined = joinScans(held, { from: r.from, through: r.through, paid: r.paid, short: held.short })
    return joined ?? { failed: 'the read of new blocks did not meet the one before it' }
  }
  const r = await readPaidSince(chain, vault, from, {
    onProgress: (read) => {
      const now: PaidScan = { ...read, short: null }
      const seen = held ? joinScans(held, now) : now
      if (seen) o.onProgress?.(seen)
    },
  })
  if (!r.ok) return { failed: r.reason }
  const fresh: PaidScan = { from: r.from, through: r.through, paid: r.paid, short: r.short }
  const joined = held ? joinScans(held, fresh) : fresh
  if (joined) return joined
  return r.short ? { failed: r.short } : fresh
}

export type Recheck = { flow: HandoffFlow; live: VaultSnapshot; prepared: PreparedTx; scan: PaidScan }

/**
 * Everything again, right before the wallet: the flow, the vault, who is connected, what this browser has
 * sent, what the vault has paid, and a simulation. `shown` is what the person is looking at, and a flow
 * that no longer says the same stops here. For a send that is what they reviewed, with the call it came to:
 * a record that changed since then stops here too, whatever the row above the review reads by now. Throws a
 * typed stop; returns only when all of it holds.
 */
export async function recheckHandoff(
  chain: Chain,
  vault: string,
  flowId: string,
  w: { account: string | null; chainId: number | null },
  o: { shown?: { payee: string; amount: bigint; data?: string }; scan?: PaidScan | null } = {},
): Promise<Recheck> {
  const read = await readFlow(flowId)
  if (!read.ok) throw stop('handoff_unreadable', `The record of this payment could not be read just now: ${read.reason}`)
  const flow = read.flow
  if (o.shown && (!sameAddress(o.shown.payee, flow.payee) || o.shown.amount !== flow.amount)) {
    throw stop('handoff_changed', `The record now names ${flow.payee} and ${flow.amount} units, and this page showed you ${o.shown.payee} and ${o.shown.amount} units.`)
  }
  const r = await readVault(chain, vault)
  if (!r.ok) throw stop('handoff_unreadable', `The vault could not be read from ${networkName(chain)} just now: ${r.failure.reason}.`)
  const v = r.data
  const refused = sendStop(flow, v, { ...w, chainId: w.chainId, wantChainId: chain.chainId }, loadHandoffs(flow.network, flow.vault))
  if (refused) throw new TxStop(refused)

  if (flow.verdictBlock === null) throw stop('handoff_changed', 'This check was never pinned to a block.')
  const need = flow.verdictBlock + 1n
  const scan = await scanPaid(chain, v.address, need, o.scan ?? null)
  // A read that came back short is not "no payment" for a block below where it stopped.
  const notRead = 'failed' in scan ? scan.failed : scan.from > need ? (scan.short ?? 'the read stopped before it reached the block it needed') : null
  if (notRead !== null || 'failed' in scan) throw stop('handoff_unreadable', `This page reads the vault's recent payments before it offers this, so a payment made elsewhere is not made twice, and that read did not finish: ${notRead}.`)
  const paid = paidAfter(flow, scan.paid)
  if (paid) throw stop('handoff_already_paid', `The vault paid this amount to this payee in block ${paid.block}, after this check, in ${paid.txHash}.`)

  // The simulation, as the owner, with this page's fee rule, and the record's call compared once more.
  const prepared = await prepareOwnerCall(chain, v, { fn: 'ownerPay', to: flow.payee, amount: flow.amount })
  if (recordDiffers(flow, v) !== null || !sameAddress(prepared.from, v.owner) || !sameAddress(prepared.to, v.address) || prepared.data.toLowerCase() !== flow.prepared?.data.toLowerCase()) {
    throw stop('handoff_changed', 'The call this page encoded is not the call the record prepared.')
  }
  if (o.shown?.data !== undefined && prepared.data.toLowerCase() !== o.shown.data.toLowerCase()) {
    throw stop('handoff_changed', 'The call this page would send now is not the call you reviewed.')
  }
  return { flow, live: v, prepared, scan }
}

/** The receipt, to the server that judges it. A failure to reach it is a retry: the transaction is what it is. */
export async function postHandoffReceipt(flowId: string, txHash: string): Promise<ReceiptStep> {
  try {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(flowId)}/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash }),
    })
    return receiptStep(res.status, await readJson(res))
  } catch {
    return receiptStep(0, null)
  }
}
