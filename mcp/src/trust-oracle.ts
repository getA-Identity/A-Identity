/**
 * Trust Oracle dogfood — an agent BUYS a `risk_check` over x402 before it transacts.
 *
 * This is the consumer side of the same Trust Oracle we list on Circle's Agent Marketplace
 * (see ./asp/* + ../marketplace/): one of our own agents pays ~$0.005 over x402 (a gasless
 * Arc-testnet nanopayment via Circle Gateway — the SAME rail as nanopay.ts), and the payment
 * unlocks a pre-transaction ALLOW / WARN / DENY verdict on the counterparty. A live
 * "agent pays an agent for trust" loop, on real Arc testnet.
 *
 * Additive + credential-gated exactly like every write path: a clean `prepared` no-op
 * without ARC_SIGNER_KEY. The risk engine is the same deterministic one the ASP sells.
 */
import { ARC_EXPLORER } from './arc-contracts.js'
import { ARC_CHAIN } from './chains/index.js'
import { buyerAddress, ensureGatewayBalance, nanopayOnce } from './nanopay.js'
import { x402PayTo } from './x402.js'
import { riskCheck } from './asp/tools.js'
import type { TxContext } from './asp/risk.js'

/** The Trust Oracle's list price for a risk_check (matches the ASP service card). */
const RISK_CHECK_PRICE_USD = 0.005
/** Gateway rejects a self-transfer, so the buyer (server signer) pays a DISTINCT seller
 *  when no separate x402 recipient is configured. Same convention as nanopay.ts's demo. */
const DEMO_SELLER = '0x000000000000000000000000000000000000bEEF'

type Verdict = Awaited<ReturnType<typeof riskCheck>>

export type TrustOracleDogfoodResult =
  | { executed: false; reason: string; tool: 'risk_check'; priceUsd: number }
  | {
      executed: true
      marketplace: 'circle-agent-marketplace'
      tool: 'risk_check'
      priceUsd: number
      buyer: string
      payTo: string
      payment: {
        rail: 'x402-nanopayment'
        network: string
        amountUsd: number
        transaction?: string
        explorerUrl?: string
        authorization: { from: string; to: string; value: string; nonce: string }
      }
      gatewayAvailableUsd: number
      deposit: { amountUsd: number; depositTx?: string; explorerUrl?: string } | null
      riskCheck: Pick<Verdict, 'agentId' | 'decision' | 'risk' | 'reasons' | 'signals' | 'checkedAt'>
    }

/**
 * Run the dogfood: a buyer agent pays the Trust Oracle over x402 (Arc nanopayment) and,
 * once the payment settles, receives the risk verdict on `agentId`. Prepared without a key.
 */
export async function runTrustOracleDogfood(
  input: { agentId: string; txContext?: TxContext | null; amountUsd?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TrustOracleDogfoodResult> {
  const agentId = (input.agentId ?? '').trim()
  const amountUsd = input.amountUsd ?? RISK_CHECK_PRICE_USD

  const buyer = await buyerAddress(env)
  if (!buyer) {
    return {
      executed: false,
      tool: 'risk_check',
      priceUsd: amountUsd,
      reason:
        'No ARC_SIGNER_KEY set. With a funded key, a buyer agent pays ~$0.005 over x402 (a gasless Arc nanopayment via Circle Gateway) for a risk_check on the counterparty before it transacts.',
    }
  }

  // 1) ensure the buyer has a Gateway balance (a real deposit tops it up when low).
  const bal = await ensureGatewayBalance(amountUsd + 0.1, env)

  // 2) pay the Trust Oracle over x402. Gateway rejects a self-transfer, so pay the
  //    configured x402 recipient when it differs from the buyer, else a demo merchant.
  const configured = await x402PayTo(env)
  const payTo = configured && configured.toLowerCase() !== buyer.toLowerCase() ? configured : DEMO_SELLER
  const pay = await nanopayOnce(amountUsd, payTo, env)
  if (!pay.ok) {
    return { executed: false, tool: 'risk_check', priceUsd: amountUsd, reason: `x402 payment failed: ${pay.reason}` }
  }

  // 3) payment settled → the resource is unlocked: serve the risk verdict.
  const verdict = await riskCheck(agentId, input.txContext ?? null)

  return {
    executed: true,
    marketplace: 'circle-agent-marketplace',
    tool: 'risk_check',
    priceUsd: amountUsd,
    buyer,
    payTo,
    payment: {
      rail: 'x402-nanopayment',
      network: ARC_CHAIN.caip2,
      amountUsd,
      transaction: pay.transaction,
      explorerUrl: pay.transaction?.startsWith('0x') ? `${ARC_EXPLORER}/tx/${pay.transaction}` : undefined,
      authorization: pay.authorization,
    },
    gatewayAvailableUsd: bal.available,
    deposit: bal.deposit ?? null,
    riskCheck: {
      agentId: verdict.agentId,
      decision: verdict.decision,
      risk: verdict.risk,
      reasons: verdict.reasons,
      signals: verdict.signals,
      checkedAt: verdict.checkedAt,
    },
  }
}
