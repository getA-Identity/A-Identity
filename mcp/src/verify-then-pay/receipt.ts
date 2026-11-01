/**
 * The only way a verify-then-pay flow becomes executed: the server reads the payment's receipt
 * from the chain itself, from every RPC, and the receipt proves the payment the flow prepared.
 *
 * The caller posts a transaction hash and nothing else; what it claims about that hash is not
 * read at all. The server finds the receipt (chains/evm/receipts.ts, host by host, because a
 * host that lacks a receipt answers null) and then requires, for a successful receipt:
 *
 *   - the vault's own Paid event, emitted by the flow's vault, to the flow's payee, for the
 *     flow's amount (the contract emits it only from pay(), which only the operator may call,
 *     or from ownerPay(), which only the owner may call, and says which in byOwner);
 *   - USDC's own Transfer event, emitted by the registry's USDC, from the vault to the payee,
 *     for the amount. On Arc the receipt also carries the native-balance Transfer of the same
 *     payment in 18 decimals from a system address; that one is not USDC's and never counts;
 *   - a block after the one the verdict came back in (check.verdictBlock), so a payment made
 *     before the check, or while it was still running, cannot be passed off as its result.
 *     The preflight's block is not enough for this: it was read before the check was bought,
 *     and the check takes seconds. What a block proves is when the payment was mined, not
 *     when it was signed; that is as close as the chain can say.
 *
 * The payment's time is the chain's: the block the receipt names is read (from every RPC, and
 * only an answer with the receipt's block hash counts), and its timestamp is recorded as
 * payment.minedAt. The season report times a flow by it, never by when the server happened
 * to read the receipt.
 *
 * A reverted receipt has no logs, so it is matched by the transaction: sent to the vault, with
 * exactly the prepared calldata, by the key the flow prepared it for. A flow waiting for its
 * owner (WARN) is closed only by the owner's call: an operator payment is not the hand-off it
 * prepared. Whatever does not match leaves the row exactly as it was, and one transaction
 * links to one flow at most.
 *
 * A limit, stated rather than implied: the route takes no session, so the first flow a valid
 * receipt is posted for keeps it. Someone who paid for their own check on the same vault,
 * payee and amount could post a payment before its owner does and leave the owner's flow
 * unlinked (TX_LINKED_ELSEWHERE). It costs them a check per attempt and moves no money; the
 * season report counts only flows opened by our own payers' checks, so it cannot take
 * Milestone 1 credit either. Binding a flow to the key that will pay would close it, and the
 * optional separate check payer is why this version does not.
 */
import { parseEventLogs, type Transaction, type TransactionReceipt } from 'viem'
import { blockFromEveryRpc, receiptFromEveryRpc, rpcSourceLabel, transactionFromEveryRpc, txUrl, type ChainDescriptor } from '../chains/index.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import type { VtpFlowDetail, VtpFlowOutcome, VtpFlowRecord } from '../storage.js'
import { flowUrl, storageVtpStore, vtpChain, VTP_PUBLIC_ORIGIN, type VtpDeps } from './context.js'
import { gasCostUsdc, ownerPayCalldata, payCalldata } from './prepare.js'

const TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

const HASH = /^0x[0-9a-fA-F]{64}$/
const OPEN: VtpFlowOutcome[] = ['pending', 'awaiting_human']
const DEFAULT_RECEIPT_BUDGET_MS = 8000
const DEFAULT_PER_CALL_MS = 5000
/** The last moment a JavaScript Date can hold. */
const MAX_DATE_MS = 8.64e15

export type ReceiptRefusalCode =
  | 'VERDICT_BLOCK_UNKNOWN'
  | 'TX_BEFORE_CHECK'
  | 'NO_MATCHING_PAID'
  | 'NO_MATCHING_TRANSFER'
  | 'AGENT_PAID_ON_HANDOFF'
  | 'NOT_THIS_FLOWS_CALL'
  | 'TX_UNREADABLE'

export type ReceiptJudgement =
  | { ok: true; outcome: 'executed'; detail: 'agent_paid' | 'owner_paid'; byOwner: boolean }
  | { ok: true; outcome: 'blocked'; detail: 'reverted_onchain'; byOwner: boolean }
  | { ok: false; code: ReceiptRefusalCode; reason: string }

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase()

/** What a receipt proves about one flow. Pure. */
export function judgeReceipt(chain: ChainDescriptor, flow: VtpFlowRecord, receipt: TransactionReceipt, tx: Transaction | null): ReceiptJudgement {
  const vault = lc(flow.vault)
  const payee = lc(flow.payee)
  const amount = BigInt(flow.amount)
  const verdictBlock = flow.check.verdictBlock
  if (typeof verdictBlock !== 'string' || !/^[0-9]+$/.test(verdictBlock)) {
    return { ok: false, code: 'VERDICT_BLOCK_UNKNOWN', reason: "this flow's check was never pinned to a block after its verdict, so no payment can be shown to come after it" }
  }
  if (receipt.blockNumber <= BigInt(verdictBlock)) {
    return { ok: false, code: 'TX_BEFORE_CHECK', reason: `the transaction is in block ${receipt.blockNumber}, not after block ${verdictBlock}, the latest block when the check's verdict came back` }
  }
  if (receipt.status === 'success') {
    const paid = parseEventLogs({ abi: AgentSpendPolicyAbi, eventName: 'Paid', logs: receipt.logs }).filter(
      (l) => lc(l.address) === vault && lc(l.args.to) === payee && l.args.amount === amount,
    )
    if (!paid.length) return { ok: false, code: 'NO_MATCHING_PAID', reason: `the receipt carries no Paid event from the vault to the payee for ${flow.amount} units` }
    const byOwner = paid[0].args.byOwner
    if (flow.outcome === 'awaiting_human' && !byOwner) {
      return { ok: false, code: 'AGENT_PAID_ON_HANDOFF', reason: 'the verdict was WARN and this flow waits for the owner, but this payment was made by the operator, not through ownerPay' }
    }
    const usdc = lc(chain.contracts.usdc)
    const moved = parseEventLogs({ abi: TRANSFER_ABI, eventName: 'Transfer', logs: receipt.logs }).filter(
      (l) => lc(l.address) === usdc && lc(l.args.from) === vault && lc(l.args.to) === payee && l.args.value === amount,
    )
    if (!moved.length) return { ok: false, code: 'NO_MATCHING_TRANSFER', reason: `the receipt carries no USDC Transfer from the vault to the payee for ${flow.amount} units` }
    return { ok: true, outcome: 'executed', detail: byOwner ? 'owner_paid' : 'agent_paid', byOwner }
  }
  if (!tx) return { ok: false, code: 'TX_UNREADABLE', reason: 'the receipt is reverted and the transaction itself could not be read, so what was attempted is unknown' }
  const input = lc(tx.input)
  if (lc(tx.to) === vault && input === lc(payCalldata(payee, amount)) && lc(tx.from) === lc(flow.operator) && flow.outcome === 'pending') {
    return { ok: true, outcome: 'blocked', detail: 'reverted_onchain', byOwner: false }
  }
  if (lc(tx.to) === vault && input === lc(ownerPayCalldata(payee, amount)) && lc(tx.from) === lc(flow.owner)) {
    return { ok: true, outcome: 'blocked', detail: 'reverted_onchain', byOwner: true }
  }
  return { ok: false, code: 'NOT_THIS_FLOWS_CALL', reason: "the reverted transaction is not this flow's prepared call from the key it was prepared for" }
}

export type VtpReceiptResult = {
  tool: 'verify_then_pay_receipt'
  flowId: string | null
  /** True when the server read a receipt that proves something about this flow and recorded
   *  it: a payment (executed) or the vault reverting the prepared call (blocked). */
  verified: boolean
  outcome: VtpFlowOutcome | null
  detail: VtpFlowDetail | null
  code?: string
  reason?: string
  payment?: VtpFlowRecord['payment']
  record: { url: string } | null
  /** Post the same hash again later: nothing was decided yet. */
  retry?: boolean
  next: string
}

type Res = { httpStatus: number; body: VtpReceiptResult }

function reply(httpStatus: number, flowId: string | null, over: Partial<VtpReceiptResult> & Pick<VtpReceiptResult, 'next'>, origin: string): Res {
  return {
    httpStatus,
    body: { tool: 'verify_then_pay_receipt', flowId, verified: false, outcome: null, detail: null, record: flowId ? { url: flowUrl(flowId, origin) } : null, ...over },
  }
}

/** POST /api/x402/gateway/flows/:flowId/receipt {txHash}. Idempotent: the same hash again
 *  returns what was recorded. Never broadcasts, never signs. */
export async function recordVtpReceipt(flowIdRaw: unknown, txHashRaw: unknown, deps: VtpDeps = {}): Promise<Res> {
  const chain = vtpChain()
  const store = deps.store ?? storageVtpStore()
  const origin = deps.origin ?? VTP_PUBLIC_ORIGIN
  const now = deps.now ?? (() => Date.now())
  if (typeof flowIdRaw !== 'string' || !HASH.test(flowIdRaw)) {
    return reply(400, null, { code: 'INVALID_INPUT', reason: 'flowId must be the 32-byte authorization nonce (0x + 64 hex)', next: 'Use the flowId verify_then_pay returned.' }, origin)
  }
  if (typeof txHashRaw !== 'string' || !HASH.test(txHashRaw)) {
    return reply(400, null, { code: 'INVALID_INPUT', reason: 'txHash must be a 32-byte transaction hash (0x + 64 hex)', next: 'Send the hash of the pay() or ownerPay() transaction.' }, origin)
  }
  const flowId = flowIdRaw.toLowerCase()
  const hash = txHashRaw.toLowerCase()
  const read = await store.load(flowId)
  if (!read.ok) return reply(503, flowId, { code: 'FLOW_STORE_UNREADABLE', reason: read.reason, retry: true, next: 'The flow log could not be read; nothing changed. Post the same hash again shortly.' }, origin)
  const flow = read.row
  if (!flow) return reply(404, flowId, { code: 'UNKNOWN_FLOW', reason: 'no flow with this id', next: 'Use the flowId verify_then_pay returned for a paid check.' }, origin)

  const recorded = (f: VtpFlowRecord, httpStatus = 200): Res =>
    reply(httpStatus, flowId, { verified: true, outcome: f.outcome, detail: f.detail, payment: f.payment, next: 'Already recorded from the chain: this is what the receipt proved.' }, origin)
  if (flow.payment?.txHash === hash) return recorded(flow)
  if (!OPEN.includes(flow.outcome)) {
    return reply(409, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'FLOW_ENDED', reason: `this flow is ${flow.outcome} (${flow.detail})${flow.payment ? ` with transaction ${flow.payment.txHash}` : ''}; it takes no receipt now`, next: 'Nothing changed.' }, origin)
  }
  const linked = await store.findByTx(hash)
  if (!linked.ok) return reply(503, flowId, { code: 'FLOW_STORE_UNREADABLE', reason: linked.reason, retry: true, next: 'The flow log could not be read; nothing changed. Post the same hash again shortly.' }, origin)
  if (linked.flowId && linked.flowId !== flowId) {
    return reply(409, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'TX_LINKED_ELSEWHERE', reason: `that transaction is already linked to flow ${linked.flowId}`, next: 'One transaction proves one flow. Nothing changed.' }, origin)
  }

  const opts = { perCallTimeoutMs: DEFAULT_PER_CALL_MS, ...deps.receipts }
  const r = await receiptFromEveryRpc(chain, hash, { timeoutMs: DEFAULT_RECEIPT_BUDGET_MS, ...opts })
  if (r.status === 'unreachable') {
    return reply(503, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'RPC_UNREACHABLE', reason: `no ${chain.name} RPC answered`, retry: true, next: 'Nothing changed. Post the same hash again shortly.' }, origin)
  }
  if (r.status === 'not_found') {
    const t = await transactionFromEveryRpc(chain, hash, { ...opts, timeoutMs: 0 })
    const known = t.status === 'found'
    return reply(
      202,
      flowId,
      {
        outcome: flow.outcome,
        detail: flow.detail,
        code: known ? 'RECEIPT_PENDING' : 'TX_NOT_FOUND',
        reason: known ? 'the transaction is known but no RPC has its receipt yet' : `no ${chain.name} RPC knows this transaction yet`,
        retry: true,
        next: known
          ? 'Nothing changed yet. Post the same hash again once it is mined.'
          : `Nothing changed. If it was sent with maxFeePerGas under 20 gwei, ${chain.name} dropped it and it will never land; otherwise post the same hash again shortly.`,
      },
      origin,
    )
  }
  const receipt = r.value
  let tx: Transaction | null = null
  if (receipt.status === 'reverted') {
    const t = await transactionFromEveryRpc(chain, hash, { ...opts, timeoutMs: 0 })
    if (t.status !== 'found') {
      return reply(503, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'TX_UNREADABLE', reason: 'the receipt is reverted and no RPC returned the transaction itself', retry: true, next: 'Nothing changed. Post the same hash again shortly.' }, origin)
    }
    tx = t.value
  }
  const j = judgeReceipt(chain, flow, receipt, tx)
  if (!j.ok) return reply(422, flowId, { outcome: flow.outcome, detail: flow.detail, code: j.code, reason: j.reason, next: 'The receipt does not prove this flow, so nothing changed.' }, origin)

  // When the chain says it happened: the block the receipt names, and no other block at that height.
  const blockHash = typeof receipt.blockHash === 'string' && HASH.test(receipt.blockHash) ? receipt.blockHash : undefined
  const b = await blockFromEveryRpc(chain, { number: receipt.blockNumber, hash: blockHash }, { ...opts, timeoutMs: 0 })
  const minedMs = b.status === 'found' ? Number(b.value.timestamp) * 1000 : Number.NaN
  if (b.status !== 'found' || !Number.isFinite(minedMs) || minedMs <= 0 || minedMs > MAX_DATE_MS) {
    return reply(503, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'BLOCK_UNREADABLE', reason: `no ${chain.name} RPC returned block ${receipt.blockNumber} with the receipt's block hash and a usable timestamp, so the payment's time is unknown`, retry: true, next: 'Nothing changed. Post the same hash again shortly.' }, origin)
  }

  const at = new Date(now()).toISOString()
  const gasUsed = receipt.gasUsed ?? 0n
  const price = receipt.effectiveGasPrice ?? 0n
  const payment: NonNullable<VtpFlowRecord['payment']> = {
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    minedAt: new Date(minedMs).toISOString(),
    status: receipt.status,
    byOwner: j.byOwner,
    from: lc(receipt.from),
    to: receipt.to ? lc(receipt.to) : null,
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: price.toString(),
    costUsdc: gasCostUsdc(chain, gasUsed * price),
    readBackAt: at,
    readBackFrom: rpcSourceLabel(chain, r.url),
    explorerUrl: txUrl(chain, hash),
  }
  const u = await store.update(flowId, { outcome: j.outcome, detail: j.detail, payment, updatedAt: at }, OPEN)
  if (!u.ok) {
    if (u.conflict === 'tx_linked') {
      return reply(409, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'TX_LINKED_ELSEWHERE', reason: u.reason, next: 'One transaction proves one flow. Nothing changed.' }, origin)
    }
    return reply(503, flowId, { outcome: flow.outcome, detail: flow.detail, code: 'FLOW_STORE_UNREADABLE', reason: u.reason, retry: true, next: 'The receipt proved the flow but the record could not be written. Post the same hash again.' }, origin)
  }
  if (!u.updated) {
    if (u.row?.payment?.txHash === hash) return recorded(u.row)
    return reply(409, flowId, { outcome: u.row?.outcome ?? null, detail: u.row?.detail ?? null, code: 'FLOW_ENDED', reason: 'the flow moved on while this receipt was being read', next: 'Nothing changed by this request.' }, origin)
  }
  return reply(
    200,
    flowId,
    {
      verified: true,
      outcome: u.row.outcome,
      detail: u.row.detail,
      payment,
      next:
        j.outcome === 'executed'
          ? `Recorded from the chain: the vault paid ${flow.payee} ${flow.amount} units in block ${payment.blockNumber}, read back from ${payment.readBackFrom}.`
          : `Recorded from the chain: the vault reverted the prepared call in block ${payment.blockNumber}. Nothing moved; the revert is the record.`,
    },
    origin,
  )
}
