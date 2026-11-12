/**
 * How a NEAR verdict reads inside the trust tools' existing answers.
 *
 * verify_agent, risk_check, trust_preview, counterparty_check, agent_passport and
 * reputation_score all score through asp/tools.ts gather(), and their output shapes are
 * registered (OKX.AI listings, the Gateway and marketplace OpenAPI documents). So a NEAR testnet
 * account gets the SAME fields every other target gets, and the NEAR evidence travels in the
 * text fields those shapes already carry: risk_check's and counterparty_check's `reasons`, and
 * the `note` of verify_agent's liveness and of trust_preview's upgrade block. No field is added.
 *
 * The decision is the engine's, unchanged: the verdict the NEAR SDK computes for the account at
 * the block the answer names. Nothing here re-scores it, and the amount does not move it (the SDK
 * decides without one; on NEAR the payer's spend vault caps amounts on chain).
 *
 * Every line is plain ASCII and names its own label: testnet, read live, nothing settled.
 */
import type { NearCheckAnswer, NearCheckResult } from './check.js'

/** Where the full answer is served for free, in the public form an agent can call. */
export const NEAR_CHECK_PUBLIC_URL = 'https://a-identity.xyz/api/near/check'

/** The CLI's own tags for a reason's severity, so the two read the same. */
const TAG: Record<string, string> = { deny: 'DENY', warn: 'WARN', positive: 'PLUS', info: 'INFO' }

/** risk_check's level for each verdict, the same mapping assessRisk uses. */
export const NEAR_RISK_LEVEL = { ALLOW: 'low', WARN: 'medium', DENY: 'high' } as const

const freeUrl = (account: string) => `${NEAR_CHECK_PUBLIC_URL}?account=${account}`

/** The headline: what was decided, by what, at which block, and how to recompute it. */
export function nearVerdictLine(a: NearCheckAnswer): string {
  const kind = a.warn_kind ? `, a ${a.warn_kind} warning` : ''
  return (
    `NEAR testnet account ${a.account}: ${a.verdict} (score ${a.score} of 1000${kind}), decided by A-Identity's NEAR verdict engine ` +
    `${a.engine_version} (policy ${a.policy_id}) from chain data read live at block #${a.block.height} (${a.block_time}). ` +
    `It is the verdict the NEAR SDK computes: ${a.recompute.command} prints the same verdict and chain_sha256 ${a.chain_sha256}.`
  )
}

/** One engine reason, as the CLI prints it: tag, code, what was seen, and where it came from. */
export function nearReasonLine(r: NearCheckAnswer['reasons'][number]): string {
  const cleared = r.cleared_by ? ` (cleared by ${r.cleared_by})` : ''
  return `${TAG[r.severity] ?? r.severity.toUpperCase()} ${r.code}${cleared}: ${r.detail} [${r.source}]`
}

/** What A-Identity's own on-chain registry said, as read in the same snapshot. */
export function nearRegistryLine(a: NearCheckAnswer): string {
  const r = a.registry
  if (r.state === 'not_configured') return 'No A-Identity registry was configured for this read.'
  if (r.state === 'not_deployed') return `A-Identity's on-chain registry ${r.id} has no contract at block #${a.block.height}, so it holds no verdict on this account.`
  if (r.state === 'unreadable') return `A-Identity's on-chain registry ${r.id} could not be read (${r.why ?? 'no answer'}), so the engine counted it as unreadable, never as clean.`
  const reports = `${r.open_reports ?? 0} open report(s) not yet reviewed`
  if (!r.verdict) return `A-Identity's on-chain registry ${r.id} holds no verdict on this account; ${reports}.`
  const why = r.reasons.length ? ` (${r.reasons.join(', ')})` : ''
  const by = r.written_by ? `, written by ${r.written_by}` : ''
  const at = r.written_at ? ` at ${r.written_at}` : ''
  return `A-Identity's on-chain registry ${r.id} says ${r.verdict}${why}${by}${at}; ${reports}.`
}

/** The label every NEAR answer carries, with the free URL of the full answer. */
export function nearHonestLine(account: string): string {
  return `Testnet only, read live, and nothing settles on NEAR through A-Identity yet: this is a verdict, not a payment. The full answer is free: GET ${freeUrl(account)}`
}

/**
 * What the snapshot itself notes about its sources, as the CLI prints it: today the attribution
 * NearBlocks' terms ask for whenever its API was read. Empty when there is nothing to note.
 */
const notesOf = (a: NearCheckAnswer): string[] => a.notes.filter((n) => n.trim() !== '')
const notesText = (a: NearCheckAnswer): string => notesOf(a).map((n) => ` ${n}`).join('')

/** risk_check's and counterparty_check's reasons for a computed NEAR verdict. */
export function nearReasons(a: NearCheckAnswer, amountUsd?: number): string[] {
  const amount =
    typeof amountUsd === 'number'
      ? [
          `The amount ($${amountUsd}) does not enter a NEAR verdict, so it is the same for any amount, as the SDK's is; on NEAR the payer's spend vault caps amounts on chain.`,
        ]
      : []
  return [nearVerdictLine(a), ...a.reasons.map(nearReasonLine), nearRegistryLine(a), ...amount, ...notesOf(a), nearHonestLine(a.account)]
}

/** The one reason when no NEAR verdict could be computed: why, and that it is not evidence. */
export function nearFailureReason(account: string, result: Exclude<NearCheckResult, NearCheckAnswer>): string {
  return (
    `No NEAR verdict could be computed for ${account} just now: ${result.error} We hold no evidence against it from this read: ` +
    `we stayed strict because we could not look, and the NEAR SDK answers "no verdict" in the same case (cd near && npm run verdict -- ${account}). Ask again shortly.`
  )
}

/** verify_agent's and agent_passport's liveness note for a NEAR account: there is no endpoint to probe. */
export function nearLivenessNote(account: string, result: NearCheckResult): string {
  const head =
    `NEAR testnet account ${account}: a NEAR account registers no endpoint to probe, and it has no ERC-8004 identity or KYA we anchor, ` +
    'so verified stays false and kya_status unknown. '
  if ('error' in result) return head + nearFailureReason(account, result)
  const deciding = result.reasons.filter((r) => (r.severity === 'deny' || r.severity === 'warn') && !r.cleared_by).map((r) => r.code)
  const by = deciding.length ? ` on ${deciding.join(', ')}` : ''
  return `${head}A-Identity's NEAR verdict on it is ${result.verdict}${by}, score ${result.score}, at block #${result.block.height}; ${result.recompute.command} recomputes it.${notesText(result)} ${nearHonestLine(account)}`
}

/** trust_preview's upgrade note for a NEAR account, appended to the usual one. */
export function nearPreviewNote(account: string, result: NearCheckResult): string {
  if ('error' in result) return `NEAR testnet account ${account}: ${nearFailureReason(account, result)} The band above is the strict default, not evidence.`
  return (
    `NEAR testnet account ${account}: the band comes from A-Identity's NEAR verdict engine at block #${result.block.height}, and the paid tools return its verdict.${notesText(result)} ` +
    nearHonestLine(account)
  )
}

/** reputation_score's basis for a NEAR account: what the score is, and what the breakdown is not. */
export function nearReputationBasis(result: NearCheckResult): string {
  if ('error' in result) return 'no verifiable signals: no NEAR verdict could be computed for this read'
  return (
    `NEAR testnet verdict engine score (${result.engine_version}, policy ${result.policy_id}, block #${result.block.height}): it starts at 600, loses for each deny and warning, gains for each positive, ` +
    'and is clamped into the verdict\'s band (DENY 0-199, WARN 200-499, ALLOW 500-1000). The platform breakdown reads 0 because we hold no platform history for a NEAR account'
  )
}
