/**
 * Autonomous agent run - the "autonomous economic experience" the Arc track asks for.
 *
 * A human sets a budget once; then the agent runs ON ITS OWN: it makes a sequence of
 * real gasless nanopayments to a service (pay-per-inference / streaming), deciding
 * before each one whether it stays within the budget you set. When the next payment
 * would breach the budget it STOPS ITSELF and pauses for a human - bounded authority,
 * demonstrated live, no human clicking each payment.
 *
 * Programmable payment logic: each settled payment also accrues a **protocol fee**
 * (basis points of volume) routed to an A-Identity treasury - the on-chain proof of
 * the "take a fee per settlement" model. The fee settles as one real nanopayment at
 * the end (aggregated so it clears the rail's sub-cent minimum).
 *
 * Built on the verified Nanopayments rail (`nanopay.ts`). Env-gated behind
 * ARC_SIGNER_KEY; a clean `prepared` no-op without it.
 */
import { nanopayOnce, ensureGatewayBalance, buyerAddress } from './nanopay.js'

/** The demo service the agent pays (distinct from the buyer - Gateway rejects self-pay). */
const SERVICE = '0x000000000000000000000000000000000000bEEF'
/** The A-Identity treasury that collects the protocol fee (distinct demo address). */
const TREASURY_DEFAULT = '0x000000000000000000000000000000000000CAFE'
/** Default protocol fee: 500 bps (5%) of volume - configurable via env. */
const DEFAULT_FEE_BPS = 500

type Payment = { n: number; amountUsd: number; cumulativeUsd: number; ok: boolean; transaction?: string; reason?: string }

/**
 * Run the agent autonomously for up to `maxCalls` payments of `amountUsd` each, stopping
 * when the next payment would exceed `budgetUsd` (the human-set limit). Returns the full
 * trail: each autonomous payment, where/why it stopped, and the protocol fee collected.
 */
export async function runAgentRun(
  input: { maxCalls?: number; amountUsd?: number; budgetUsd?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { executed: false; reason: string }
  | {
      executed: true
      service: string
      treasury: string
      feeBps: number
      budgetUsd: number
      amountUsd: number
      payments: Payment[]
      settledCount: number
      volumeUsd: number
      stoppedReason: 'budget-reached' | 'max-calls' | 'settlement-error'
      pausedForHuman: boolean
      protocolFee: { accruedUsd: number; settled: boolean; transaction?: string; note?: string }
    }
> {
  const buyer = await buyerAddress(env)
  if (!buyer) {
    return {
      executed: false,
      reason: 'No ARC_SIGNER_KEY set. With a funded key the agent runs autonomously: a burst of real gasless nanopayments, stopping itself at the budget you set, with a protocol fee routed to the treasury.',
    }
  }

  // Bound every client-chosen amount: this run deposits/spends the shared server signer,
  // so an over-large amount/budget would drain the house key.
  const amountUsd = Math.min(0.05, Math.max(0, Number.isFinite(input.amountUsd) ? (input.amountUsd as number) : 0.005))
  const maxCalls = Math.max(1, Math.min(12, Math.floor(input.maxCalls ?? 6)))
  const budgetUsd = Math.min(5, Math.max(0, Number.isFinite(input.budgetUsd) ? (input.budgetUsd as number) : amountUsd * 4))
  const feeBps = Number(env.PROTOCOL_FEE_BPS ?? DEFAULT_FEE_BPS)
  const treasury = env.PROTOCOL_FEE_RECIPIENT ?? TREASURY_DEFAULT

  // Fund the Gateway balance once for the whole run (calls + fee headroom).
  await ensureGatewayBalance(maxCalls * amountUsd + 0.5, env)

  const payments: Payment[] = []
  let volumeUsd = 0
  let stoppedReason: 'budget-reached' | 'max-calls' | 'settlement-error' = 'max-calls'

  for (let n = 1; n <= maxCalls; n++) {
    // The agent's own decision: would this payment breach the human-set budget? The budget
    // bounds TOTAL outflow, so we include the protocol fee (bps of volume) that this payment
    // would accrue - otherwise volume + fee could exceed the budget the human set.
    const prospectiveTotal = (volumeUsd + amountUsd) * (1 + feeBps / 10_000)
    if (prospectiveTotal > budgetUsd + 1e-9) {
      stoppedReason = 'budget-reached'
      break
    }
    const res = await nanopayOnce(amountUsd, SERVICE, env)
    if (!res.ok) {
      payments.push({ n, amountUsd, cumulativeUsd: volumeUsd, ok: false, reason: res.reason })
      stoppedReason = 'settlement-error'
      break
    }
    volumeUsd = Number((volumeUsd + amountUsd).toFixed(6))
    payments.push({ n, amountUsd, cumulativeUsd: volumeUsd, ok: true, transaction: res.transaction })
  }

  const settledCount = payments.filter((p) => p.ok).length
  const pausedForHuman = stoppedReason === 'budget-reached'

  // Protocol fee: bps of settled volume, collected to the treasury as one real
  // nanopayment (aggregated so it clears the sub-cent rail minimum of 0.001 USDC).
  const accruedUsd = Number(((volumeUsd * feeBps) / 10_000).toFixed(6))
  let protocolFee: { accruedUsd: number; settled: boolean; transaction?: string; note?: string } = {
    accruedUsd,
    settled: false,
  }
  if (accruedUsd >= 0.001) {
    const fee = await nanopayOnce(accruedUsd, treasury, env)
    protocolFee = fee.ok
      ? { accruedUsd, settled: true, transaction: fee.transaction }
      : { accruedUsd, settled: false, note: fee.reason }
  } else {
    protocolFee = { accruedUsd, settled: false, note: 'below the 0.001 USDC rail minimum; accrued only' }
  }

  return {
    executed: true,
    service: SERVICE,
    treasury,
    feeBps,
    budgetUsd,
    amountUsd,
    payments,
    settledCount,
    volumeUsd,
    stoppedReason,
    pausedForHuman,
    protocolFee,
  }
}
