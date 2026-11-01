/**
 * Recorded flows as the Arc Acceleration Season report counts them. Pure.
 *
 * A row becomes a season flow only when it carries something a reviewer can open:
 *   - executed, with a successful receipt the server read: a payment, named by its hash;
 *   - blocked because the vault reverted the prepared call: a refusal, named by its hash;
 *   - blocked by a DENY verdict: a refusal with no transaction, named by its public flow
 *     record on https://a-identity.xyz, which is the evidence that the payment was stopped.
 * Everything else (pending, waiting for the owner, an unusable or unavailable verdict) counts
 * nothing. The report still links each one only to one of our own settled Gateway checks on
 * Arc Mainnet, by nonce and payer, and only when its outcome came after the check.
 *
 * Each season flow carries the check's settlement as its row recorded it (network, payer,
 * outcome, time). The report reads it only when the check's own row has aged out of the
 * retained Gateway log, which keeps its newest rows; vtp_flows keeps every flow.
 *
 * A payment or a revert is timed by the block it was mined in (payment.minedAt, the block's own
 * timestamp), never by when the server read the receipt: a read-back time is always after the
 * check, so it would make "the outcome came after the check" true of everything. The receipt
 * route has already required the block to come after the verdict's; the report's comparison
 * is the second look, on the chain's clock against the check's settlement time.
 */
import type { ArcVerifyThenPayFlow } from '../arc-season.js'
import type { VtpFlowRecord } from '../storage.js'
import { flowUrl, vtpChain, VTP_PUBLIC_ORIGIN } from './context.js'
import { formatUnitsString } from './prepare.js'

export function toSeasonFlow(row: VtpFlowRecord): ArcVerifyThenPayFlow[] {
  const base = {
    checkNonce: row.flowId,
    payer: row.check.payer,
    payee: row.payee,
    check: { network: row.network, payer: row.check.payer, outcome: row.check.gatewayOutcome, ts: row.check.checkedAt },
  }
  const amount = `${formatUnitsString(BigInt(row.amount), vtpChain().usdcDecimals)} USDC`
  const decision = row.verdict?.decision ?? 'no verdict'
  if (row.outcome === 'executed' && row.payment?.status === 'success') {
    return [
      {
        ...base,
        outcome: 'paid',
        txHash: row.payment.txHash,
        at: row.payment.minedAt,
        note: `risk_check ${decision}, then the vault paid ${amount} (${row.detail}) in block ${row.payment.blockNumber}; receipt read back by the server from ${row.payment.readBackFrom}.`,
      },
    ]
  }
  if (row.outcome === 'blocked' && row.detail === 'reverted_onchain' && row.payment) {
    return [
      {
        ...base,
        outcome: 'refused',
        txHash: row.payment.txHash,
        at: row.payment.minedAt,
        note: `risk_check ${decision}, then the vault reverted the prepared ${row.payment.byOwner ? 'ownerPay' : 'pay'} of ${amount} on chain.`,
      },
    ]
  }
  if (row.outcome === 'blocked' && row.detail === 'deny') {
    return [
      {
        ...base,
        outcome: 'refused',
        evidenceUrl: flowUrl(row.flowId, VTP_PUBLIC_ORIGIN),
        at: row.createdAt,
        note: `risk_check DENY stopped a ${amount} payment before anything was signed; the flow record is public.`,
      },
    ]
  }
  return []
}
