/**
 * Circle Nanopayments — gas-free, sub-cent USDC via Gateway batched settlement.
 *
 * This is the SECOND x402 rail alongside our on-chain self-verifying one (`x402.ts`).
 * Where that settles each call as a real USDC Transfer on Arc, Nanopayments is the
 * x402 `exact` scheme over Circle Gateway's `GatewayWalletBatched` domain: the buyer
 * signs an EIP-3009 authorization OFFCHAIN (zero gas), the seller submits it to Gateway
 * (which verifies + credits instantly and batches the on-chain settlement), and the
 * resource is served immediately. Sub-cent payments become economical because thousands
 * of authorizations net into one on-chain tx.
 *
 * Permissionless on Arc testnet (no Circle API key): the facilitator is Circle's public
 * testnet Gateway, and the buyer's balance is the SAME Gateway Wallet deposit our
 * `gateway.ts` already funds (verifyingContract 0x0077…19b9). Env-gated behind
 * ARC_SIGNER_KEY like every other write path; a clean `prepared` no-op without it.
 *
 * SDK: @circle-fin/x402-batching (server: BatchFacilitatorClient; client: BatchEvmScheme).
 */
import { ARC_EXPLORER, CONTRACTS } from './arc-contracts.js'
import { gatewayBalance, gatewayDeposit } from './gateway.js'
import { x402PayTo } from './x402.js'
import { ARC_CHAIN } from './chains/index.js'

/** Circle's public testnet Gateway (permissionless — no API key). */
const GATEWAY_TESTNET = 'https://gateway-api-testnet.circle.com'
/** Arc testnet as an x402 network id (CAIP-2), from the chain registry. */
const ARC_NETWORK = ARC_CHAIN.caip2
/** Price per call: 0.001 USDC (6-decimal units). A true sub-cent nanopayment. */
const PRICE_UNITS = '1000'

/** The resource a payment buys — required by Gateway's settle endpoint. */
const RESOURCE = {
  url: 'https://a-identity.xyz/api/x402/nano/data',
  description: 'A-Identity — live Arc chain data (nanopayment)',
  mimeType: 'application/json',
}

/** A distinct demo merchant for the one-click demo (Gateway rejects a self-transfer,
 *  so the buyer/server-signer must pay a DIFFERENT address). Real payments to our
 *  seller endpoint come from other wallets, so this only affects the demo. */
const DEMO_SELLER = '0x000000000000000000000000000000000000bEEF'

const usdcUnits = (usd: number) => BigInt(Math.round(usd * 1e6)).toString()

/** The Arc-testnet `exact`/GatewayWalletBatched kind, discovered live + cached. */
type ArcKind = {
  x402Version: number
  scheme: string
  network: string
  extra: Record<string, unknown> & {
    name: string
    version: string
    verifyingContract: string
    assets?: { symbol: string; address: string; decimals: number }[]
  }
}
let arcKindCache: ArcKind | null = null

async function facilitator() {
  const { BatchFacilitatorClient } = await import('@circle-fin/x402-batching/server')
  return new BatchFacilitatorClient({ url: GATEWAY_TESTNET })
}

/** Discover (and cache) the live Arc-testnet batched-payment kind from Gateway. */
async function getArcKind(): Promise<ArcKind | null> {
  if (arcKindCache) return arcKindCache
  const f = await facilitator()
  const supported = (await f.getSupported()) as unknown as { kinds: ArcKind[] }
  const kind = supported.kinds?.find((k) => k.network === ARC_NETWORK && k.scheme === 'exact')
  if (kind) arcKindCache = kind
  return kind ?? null
}

/** Build x402 payment requirements for the Arc batched rail (seller side). */
async function arcRequirements(payTo: string, amountUnits: string) {
  const kind = await getArcKind()
  if (!kind) return null
  const asset = kind.extra.assets?.[0]?.address ?? CONTRACTS.usdc
  return {
    scheme: 'exact',
    network: ARC_NETWORK,
    asset,
    amount: amountUnits,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: kind.extra,
  }
}

/**
 * The 402 body a seller returns: x402 v2 + the GatewayWalletBatched `accepts`. Null when
 * the rail can't be reached / no payTo. The client signs EIP-3009 against `extra` and
 * retries with the payload in PAYMENT-SIGNATURE.
 */
export async function nanoPaymentRequirements(env: NodeJS.ProcessEnv = process.env) {
  const payTo = await x402PayTo(env)
  if (!payTo) return null
  const req = await arcRequirements(payTo, PRICE_UNITS)
  if (!req) return null
  return { x402Version: 2, error: 'payment required', accepts: [req], rail: 'nanopayment' as const }
}

/**
 * Settle a base64 PAYMENT-SIGNATURE against Gateway (verify + credit, batched on-chain).
 * Returns the settlement or a reason. Used by the seller endpoint.
 */
export async function settleNano(
  paymentSignatureB64: string,
): Promise<{ ok: true; settle: unknown } | { ok: false; reason: string }> {
  try {
    const payTo = await x402PayTo()
    if (!payTo) return { ok: false, reason: 'x402 not configured (no payTo / signer key)' }
    const req = await arcRequirements(payTo, PRICE_UNITS)
    if (!req) return { ok: false, reason: 'Gateway batched rail unavailable for Arc testnet' }
    const payload = JSON.parse(Buffer.from(paymentSignatureB64, 'base64').toString())
    const f = await facilitator()
    const settle = (await f.settle({ resource: RESOURCE, ...payload }, req as never)) as {
      success: boolean
      errorReason?: string
      message?: string
    }
    if (!settle.success) return { ok: false, reason: settle.errorReason ?? settle.message ?? 'settlement failed' }
    return { ok: true, settle }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The real resource served after a nanopayment settles. */
export function nanoResource(settle: unknown) {
  return {
    paid: true,
    rail: 'nanopayment',
    settle,
    resource: { title: 'Live Arc chain data (gasless nanopayment)', chainId: ARC_CHAIN.evmChainId, servedAt: new Date().toISOString() },
  }
}

// ── one-click demo (server signer is the buyer) ──────────────────────────────────

async function buyerSigner(env: NodeJS.ProcessEnv) {
  const key = env.ARC_SIGNER_KEY
  if (!key) return null
  const { privateKeyToAccount } = await import('viem/accounts')
  return privateKeyToAccount(key as `0x${string}`)
}

/** The server signer's address (the demo buyer), or null without a key. */
export async function buyerAddress(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return (await buyerSigner(env))?.address ?? null
}

/**
 * Ensure the buyer has at least `minUsd` in its Gateway balance, topping up with a
 * real deposit if low. Reused before an autonomous run so the loop never stalls.
 */
export async function ensureGatewayBalance(
  minUsd: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ available: number; deposit?: { amountUsd: number; depositTx?: string; explorerUrl?: string } }> {
  const account = await buyerSigner(env)
  if (!account) return { available: 0 }
  const bal = await gatewayBalance(account.address)
  let available = 'error' in bal ? 0 : bal.available
  let deposit: { amountUsd: number; depositTx?: string; explorerUrl?: string } | undefined
  if (available < minUsd) {
    const topUp = Math.max(1, Math.ceil(minUsd - available + 0.5))
    const dep = await gatewayDeposit(topUp, env)
    if (dep.executed) {
      deposit = { amountUsd: topUp, depositTx: dep.depositTx, explorerUrl: dep.depositUrl }
      const b2 = await gatewayBalance(account.address)
      available = 'error' in b2 ? available : b2.available
    }
  }
  return { available, deposit }
}

/**
 * Sign + settle ONE gasless nanopayment to `payTo` (assumes a Gateway balance already
 * exists — call ensureGatewayBalance first). The reusable unit an autonomous agent
 * loops over: an EIP-3009 authorization signed off-chain, settled through Circle Gateway.
 */
export async function nanopayOnce(
  amountUsd: number,
  payTo: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { ok: true; authorization: { from: string; to: string; value: string; nonce: string }; transaction?: string }
  | { ok: false; reason: string }
> {
  const account = await buyerSigner(env)
  if (!account) return { ok: false, reason: 'No ARC_SIGNER_KEY set.' }
  const kind = await getArcKind()
  if (!kind) return { ok: false, reason: 'Gateway batched rail unavailable for Arc testnet.' }
  const req = await arcRequirements(payTo, usdcUnits(amountUsd))
  if (!req) return { ok: false, reason: 'Could not build Arc payment requirements.' }
  const { BatchEvmScheme } = await import('@circle-fin/x402-batching/client')
  const scheme = new BatchEvmScheme({
    address: account.address,
    signTypedData: (p) => account.signTypedData(p as Parameters<typeof account.signTypedData>[0]),
  })
  const created = (await scheme.createPaymentPayload(2, req as never)) as {
    payload: { authorization: { from: string; to: string; value: string; nonce: string } }
  }
  const f = await facilitator()
  const settle = (await f
    .settle({ resource: RESOURCE, ...created, accepted: req } as never, req as never)
    .catch((e: unknown) => ({ success: false, errorReason: e instanceof Error ? e.message : String(e) }))) as {
    success: boolean
    errorReason?: string
    message?: string
    transaction?: string
  }
  if (!settle.success) return { ok: false, reason: settle.errorReason ?? settle.message ?? 'settlement failed' }
  return { ok: true, authorization: created.payload.authorization, transaction: settle.transaction }
}

/**
 * One-click Nanopayment demo, fully server-side (the server signer plays the buyer):
 *  1) ensure a Gateway balance on Arc (top-up deposit if low — reuses gateway.ts),
 *  2) sign an EIP-3009 authorization OFFCHAIN (zero gas) via BatchEvmScheme,
 *  3) settle it through Circle Gateway (verified + credited, batched on-chain),
 *  4) return the trail (authorization + settlement + before/after Gateway balance).
 * Env-gated; a clean `prepared` result without a signer key.
 */
export async function runNanopayDemo(
  input: { amountUsd?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { executed: false; reason: string; verifyingContract?: string }
  | {
      executed: true
      amountUsd: number
      network: string
      payTo: string
      verifyingContract: string
      gatewayBalanceBefore: number
      gatewayBalanceAfter: number
      deposit: { amountUsd: number; depositTx?: string; explorerUrl?: string } | null
      authorization: { from: string; to: string; value: string; nonce: string }
      settle: { success: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string; explorerUrl?: string }
    }
> {
  const account = await buyerSigner(env)
  const kind = await getArcKind()
  if (!account) {
    return {
      executed: false,
      reason: 'No ARC_SIGNER_KEY set. With a funded key this signs an EIP-3009 authorization (0 gas) and settles a gasless nanopayment through Circle Gateway on Arc.',
      verifyingContract: kind?.extra.verifyingContract,
    }
  }
  if (!kind) return { executed: false, reason: 'Circle Gateway batched rail is not advertising Arc testnet right now.' }

  const amountUsd = input.amountUsd ?? 0.001
  // Gateway rejects a self-transfer, so the buyer (server signer) pays a DISTINCT
  // seller: the configured payTo when it differs from the buyer, else a demo merchant.
  const configured = await x402PayTo(env)
  const payTo = configured && configured.toLowerCase() !== account.address.toLowerCase() ? configured : DEMO_SELLER
  const req = await arcRequirements(payTo, usdcUnits(amountUsd))
  if (!req) return { executed: false, reason: 'Could not build Arc payment requirements.' }

  // 1) ensure the buyer has a Gateway balance (deposit tops up when low)
  const before = await gatewayBalance(account.address)
  const availBefore = 'error' in before ? 0 : before.available
  let deposit: { amountUsd: number; depositTx?: string; explorerUrl?: string } | null = null
  if (availBefore < amountUsd + 0.1) {
    const dep = await gatewayDeposit(1, env)
    if (dep.executed) deposit = { amountUsd: 1, depositTx: dep.depositTx, explorerUrl: dep.depositUrl }
  }
  const afterDep = await gatewayBalance(account.address)
  const availAfter = 'error' in afterDep ? availBefore : afterDep.available

  // 2) sign the EIP-3009 authorization OFFCHAIN (zero gas) via the batching scheme
  const { BatchEvmScheme } = await import('@circle-fin/x402-batching/client')
  const scheme = new BatchEvmScheme({
    address: account.address,
    signTypedData: (p) => account.signTypedData(p as Parameters<typeof account.signTypedData>[0]),
  })
  const created = (await scheme.createPaymentPayload(2, req as never)) as {
    x402Version: number
    payload: { authorization: { from: string; to: string; value: string; nonce: string } }
  }

  // 3) settle through Circle Gateway (verify + credit + batch on-chain). The `resource`
  // is required by Gateway's settle endpoint.
  const f = await facilitator()
  const settle = (await f
    .settle({ resource: RESOURCE, ...created, accepted: req } as never, req as never)
    .catch((e: unknown) => ({ success: false, errorReason: e instanceof Error ? e.message : String(e) }))) as {
    success: boolean
    errorReason?: string
    message?: string
    transaction?: string
    network?: string
    payer?: string
  }

  return {
    executed: true,
    amountUsd,
    network: ARC_NETWORK,
    payTo,
    verifyingContract: kind.extra.verifyingContract,
    gatewayBalanceBefore: availBefore,
    gatewayBalanceAfter: availAfter,
    deposit,
    authorization: {
      from: created.payload.authorization.from,
      to: created.payload.authorization.to,
      value: created.payload.authorization.value,
      nonce: created.payload.authorization.nonce,
    },
    settle: {
      success: settle.success,
      errorReason: settle.errorReason ?? settle.message,
      transaction: settle.transaction,
      network: settle.network,
      payer: settle.payer,
      explorerUrl: settle.transaction?.startsWith('0x') ? `${ARC_EXPLORER}/tx/${settle.transaction}` : undefined,
    },
  }
}
