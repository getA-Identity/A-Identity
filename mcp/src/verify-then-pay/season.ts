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
 */
import type { ArcVerifyThenPayFlow } from '../arc-season.js'
import type { VtpFlowRecord } from '../storage.js'
import { flowUrl, vtpChain, VTP_PUBLIC_ORIGIN } from './context.js'
import { formatUnitsString } from './prepare.js'

export function toSeasonFlow(row: VtpFlowRecord): ArcVerifyThenPayFlow[] {
  const base = { checkNonce: row.flowId, payer: row.check.payer, payee: row.payee }
  const amount = `${formatUnitsString(BigInt(row.amount), vtpChain().usdcDecimals)} USDC`
  const decision = row.verdict?.decision ?? 'no verdict'
  if (row.outcome === 'executed' && row.payment?.status === 'success') {
    return [
      {
        ...base,
        outcome: 'paid',
        txHash: row.payment.txHash,
        at: row.payment.readBackAt,
        note: `risk_check ${decision}, then the vault paid ${amount} (${row.detail}); receipt read back by the server from ${row.payment.readBackFrom}.`,
      },
    ]
  }
  if (row.outcome === 'blocked' && row.detail === 'reverted_onchain' && row.payment) {
    return [
      {
        ...base,
        outcome: 'refused',
        txHash: row.payment.txHash,
        at: row.payment.readBackAt,
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
