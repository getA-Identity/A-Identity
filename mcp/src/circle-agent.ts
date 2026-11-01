/**
 * Circle Agent Wallets - the hosted, wallet-layer enforcement layer (Phase 3).
 *
 * This is the SECOND of A-Identity's three spend-policy layers, and it is entirely
 * ADDITIVE + credential-gated, mirroring how `arc-contracts.ts` gates the on-chain
 * vault behind ARC_SIGNER_KEY:
 *
 *   1. server pre-check          - our engine (platform.ts createInstruction)
 *   2. Circle Agent Wallet       - THIS module: a real Developer-Controlled Wallet
 *                                  on ARC-TESTNET whose outbound USDC transfers are
 *                                  screened by Circle's hosted policy engine at the
 *                                  wallet layer (sanctions / allow-block / freeze).
 *   3. on-chain policy vault     - the trustless source of truth (arc-contracts.ts)
 *
 * Be precise about what Circle enforces: its wallet-layer control is TRANSACTION
 * SCREENING (address allow/blocklist + sanctions + wallet freeze), surfaced as a
 * `transactionScreeningEvaluation` and a DENIED transaction state. Circle does NOT
 * expose a per-wallet daily-USD *transfer* cap as an API primitive - that cap stays
 * enforced by our server pre-check and, when present, the on-chain vault. We never
 * overclaim Circle as on-chain enforcement; that is the vault's job.
 *
 * No keys are stored here. When CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET are unset the
 * whole module no-ops cleanly, so local / CI / demo runs without creds behave exactly
 * as before (agents simply never get a Circle wallet, and the Circle path is skipped).
 *
 * Env vars:
 *   CIRCLE_API_KEY        TEST_API_KEY:<id>:<secret> (sandbox) from console.circle.com
 *   CIRCLE_ENTITY_SECRET  64-hex entity secret (generate + register, keep recovery file)
 *   CIRCLE_WALLET_SET_ID  optional: reuse a specific wallet set instead of creating one
 *   CIRCLE_API_BASE       optional: override the API base URL (default https://api.circle.com)
 *
 * Signatures verified against @circle-fin/developer-controlled-wallets and the Circle
 * codegen MCP: createWalletSet / createWallets / createTransaction / getTransaction /
 * requestTestnetTokens / getWallet / getWalletTokenBalance. ARC-TESTNET is a supported
 * blockchain; Arc's native USDC token is 0x3600…0000 (6 display decimals).
 */
import type { CircleDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { ARC_EXPLORER, payUsdcOnchain } from './arc-contracts.js'
import { ARC_CHAIN } from './chains/index.js'

/** Arc Testnet, in Circle's blockchain vocabulary. */
const ARC_BLOCKCHAIN = 'ARC-TESTNET'
/** Native USDC on Arc testnet - the same dollar our vault settles in (6 display decimals). */
const ARC_USDC = ARC_CHAIN.contracts.usdc as string
/** Default USDC to seed a new Circle wallet with, from our Arc signer. */
const DEFAULT_FUND_USD = 0.5

const NOT_CONFIGURED =
  'Circle Agent Wallets not configured. Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET to enable this layer.'

const tx = (h: string) => `${ARC_EXPLORER}/tx/${h}`
const addressUrl = (a: string) => `${ARC_EXPLORER}/address/${a}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Circle takes a human-decimal token amount; clamp to USDC's 6 display decimals. */
function usdAmount(n: number): string {
  const s = (Math.round(n * 1e6) / 1e6).toFixed(6)
  return s.replace(/\.?0+$/, '') || '0'
}

/** True when both Circle credentials are present. The single gate for this whole module. */
export function circleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET)
}

// ── client (lazy singleton; the SDK is only loaded when creds exist) ─────────────

let _client: CircleDeveloperControlledWalletsClient | null = null

async function client(env: NodeJS.ProcessEnv): Promise<CircleDeveloperControlledWalletsClient | null> {
  if (!circleEnabled(env)) return null
  if (_client) return _client
  const { initiateDeveloperControlledWalletsClient } = await import('@circle-fin/developer-controlled-wallets')
  _client = initiateDeveloperControlledWalletsClient({
    apiKey: env.CIRCLE_API_KEY as string,
    entitySecret: env.CIRCLE_ENTITY_SECRET as string,
    baseUrl: env.CIRCLE_API_BASE || undefined,
  })
  return _client
}

/** Reuse CIRCLE_WALLET_SET_ID when set; otherwise create one wallet set per process. */
let _walletSetId: string | null = null
async function ensureWalletSet(
  c: CircleDeveloperControlledWalletsClient,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (env.CIRCLE_WALLET_SET_ID) return env.CIRCLE_WALLET_SET_ID
  if (_walletSetId) return _walletSetId
  const res = await c.createWalletSet({ name: 'A-Identity Agent Wallets' })
  const id = res.data?.walletSet?.id
  if (!id) throw new Error('Circle createWalletSet returned no wallet set id')
  _walletSetId = id
  return id
}

// ── provisioning ─────────────────────────────────────────────────────────────────

export type CircleProvisioned = {
  provisioned: true
  walletId: string
  walletAddress: string
  blockchain: string
  explorerUrl: string
  /** Result of the optional top-up, funded from our Arc signer (Circle's faucet
   *  does not cover ARC-TESTNET). */
  funded: { amountUsd: number; txHash: string; explorerUrl: string } | { error: string } | null
}
export type CircleUnavailable = { provisioned: false; reason: string }

/**
 * Provision a Circle Agent Wallet (Developer-Controlled EOA) on ARC-TESTNET for an
 * agent, optionally faucet-funding it so it can pay gas + send USDC. Returns a
 * credential-gated no-op ({ provisioned: false }) when Circle is not configured, so
 * the caller behaves exactly as before without creds.
 */
export async function createAgentWallet(
  input: { name: string; refId?: string; fund?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CircleProvisioned | CircleUnavailable> {
  const c = await client(env)
  if (!c) return { provisioned: false, reason: NOT_CONFIGURED }
  try {
    const walletSetId = await ensureWalletSet(c, env)
    const res = await c.createWallets({
      accountType: 'EOA',
      blockchains: [ARC_BLOCKCHAIN as never],
      count: 1,
      walletSetId,
      metadata: [{ name: input.name, refId: input.refId }],
    })
    const w = res.data?.wallets?.[0]
    if (!w) return { provisioned: false, reason: 'Circle createWallets returned no wallet' }

    let funded: CircleProvisioned['funded'] = null
    if (input.fund) funded = await fundFromSigner(w.address, DEFAULT_FUND_USD, env)

    return {
      provisioned: true,
      walletId: w.id,
      walletAddress: w.address,
      blockchain: w.blockchain,
      explorerUrl: addressUrl(w.address),
      funded,
    }
  } catch (err) {
    return { provisioned: false, reason: msg(err) }
  }
}

/** Circle's testnet faucet does not cover ARC-TESTNET (returns 403), so fund the new
 *  Circle wallet from our Arc signer instead. USDC on Arc is native + ERC-20, so one
 *  transfer gives the wallet both spendable USDC and gas. Best-effort; needs ARC_SIGNER_KEY. */
async function fundFromSigner(
  address: string,
  amountUsd: number,
  env: NodeJS.ProcessEnv,
): Promise<{ amountUsd: number; txHash: string; explorerUrl: string } | { error: string }> {
  const r = await payUsdcOnchain(address, amountUsd, env)
  return r.executed ? { amountUsd, txHash: r.txHash, explorerUrl: r.explorerUrl } : { error: r.reason }
}

// ── settlement (mirrors the vault result shape so executeInstruction is uniform) ──

/** Real on-chain settlement executed by Circle from the agent's wallet. */
export type CirclePayTx = { executed: true; txHash: string; explorerUrl: string }
/** Circle's hosted policy DENIED the transfer - an authoritative "no" (like a vault revert). */
export type CirclePayRejected = { executed: false; rejected: true; reason: string }
/** No creds, or Circle definitely did not take it, or it ended FAILED or CANCELLED. Nothing
 *  moved and nothing will, so the caller may fall back. */
export type CirclePayUnavailable = { executed: false; rejected: false; reason: string }
/**
 * Circle may have this transfer and has not finished it: the polls ran out, a poll threw, or the
 * create call failed in a way that does not say it was refused. It can still complete, so no
 * other rail may pay this. `transactionId` is there to read it by; without one, the same
 * idempotency key finds out, because Circle answers it with the transfer it already has.
 */
export type CirclePayPending = { executed: false; rejected: false; pending: true; transactionId?: string; reason: string }
export type CirclePayResult = CirclePayTx | CirclePayRejected | CirclePayUnavailable | CirclePayPending

/** Injected by tests. Production passes nothing and gets the lazy client and a real sleep. */
export type CirclePayDeps = {
  /** Sent to Circle so that sending the same instruction again cannot make a second transfer. */
  idempotencyKey?: string
  client?: Pick<CircleDeveloperControlledWalletsClient, 'createTransaction' | 'getTransaction'>
  pollDelayMs?: number
}

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'])
/** How many reads one request waits for, inside the proxy's 30 second cut. A transfer that takes
 *  longer is held with its id and read again, so the wait does not need to outlast it. */
const POLL_TRIES = 8
const POLL_DELAY_MS = 2_000

/** Whether a failed create call is Circle saying no, rather than a request that may have arrived.
 *  A 4xx answered the request and refused it. A timeout or a 5xx did not say. */
function createWasRefused(err: unknown): boolean {
  const e = err as { response?: { status?: unknown }; status?: unknown } | null
  const status = Number(e?.response?.status ?? e?.status)
  return status >= 400 && status < 500
}

/**
 * Send USDC from a Circle Agent Wallet on Arc. Circle's hosted policy engine screens
 * the transfer at the wallet layer; a screening DENY comes back as a rejection (the
 * caller treats it like a vault policy revert). COMPLETE returns the real tx hash.
 * No creds, a refused create, FAILED and CANCELLED are "unavailable", so the caller can fall
 * back to another settlement path. Once Circle may hold the transfer the answer is pending and
 * never unavailable: it can still complete, and falling back would pay twice.
 */
export async function circlePay(
  walletId: string,
  to: string,
  amountUsd: number,
  env: NodeJS.ProcessEnv = process.env,
  deps: CirclePayDeps = {},
): Promise<CirclePayResult> {
  const c = deps.client ?? (await client(env))
  if (!c) return { executed: false, rejected: false, reason: NOT_CONFIGURED }
  let created: Awaited<ReturnType<CircleDeveloperControlledWalletsClient['createTransaction']>>
  try {
    created = await c.createTransaction({
      ...(deps.idempotencyKey ? { idempotencyKey: deps.idempotencyKey } : {}),
      walletId,
      blockchain: ARC_BLOCKCHAIN as never,
      tokenAddress: ARC_USDC,
      destinationAddress: to,
      amount: [usdAmount(amountUsd)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as never)
  } catch (err) {
    if (createWasRefused(err)) return { executed: false, rejected: false, reason: msg(err) }
    return { executed: false, rejected: false, pending: true, reason: `the request to Circle did not answer (${msg(err)}), so whether it took the transfer is unknown` }
  }
  const txId = (created.data as { id?: string } | undefined)?.id
  if (!txId) return { executed: false, rejected: false, pending: true, reason: 'Circle accepted the request and returned no transaction id' }

  let final: CircleTxView
  try {
    final = await pollTransaction(c, txId, POLL_TRIES, deps.pollDelayMs ?? POLL_DELAY_MS)
  } catch (err) {
    return { executed: false, rejected: false, pending: true, transactionId: txId, reason: `Circle has transaction ${txId} and could not be read (${msg(err)})` }
  }
  if (final.state === 'COMPLETE' && final.txHash) {
    return { executed: true, txHash: final.txHash, explorerUrl: tx(final.txHash) }
  }
  if (final.state === 'DENIED') {
    return { executed: false, rejected: true, reason: screeningReason(final) }
  }
  if (final.state === 'FAILED' || final.state === 'CANCELLED') {
    return { executed: false, rejected: false, reason: final.errorReason ? `${final.state}: ${final.errorReason}` : `Circle transaction ${final.state}` }
  }
  return { executed: false, rejected: false, pending: true, transactionId: txId, reason: `Circle transaction ${txId} is ${final.state} and has not finished` }
}

/** One look at a transfer Circle may still be working on. Reads only, and never fails. */
export async function circleTransferStatus(
  transactionId: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: Pick<CirclePayDeps, 'client'> = {},
): Promise<
  | { status: 'success'; txHash: string; explorerUrl: string }
  | { status: 'denied'; reason: string }
  | { status: 'reverted'; reason: string }
  | { status: 'unknown'; reason: string }
> {
  const c = deps.client ?? (await client(env))
  if (!c) return { status: 'unknown', reason: NOT_CONFIGURED }
  try {
    const r = await c.getTransaction({ id: transactionId })
    const t = (r.data?.transaction ?? {}) as CircleTxView
    if (t.state === 'COMPLETE' && t.txHash) return { status: 'success', txHash: t.txHash, explorerUrl: tx(t.txHash) }
    if (t.state === 'DENIED') return { status: 'denied', reason: screeningReason(t) }
    if (t.state === 'FAILED' || t.state === 'CANCELLED') return { status: 'reverted', reason: t.errorReason ? `${t.state}: ${t.errorReason}` : `Circle transaction ${t.state}` }
    return { status: 'unknown', reason: `Circle transaction ${transactionId} is ${t.state ?? 'in an unknown state'}` }
  } catch (err) {
    return { status: 'unknown', reason: msg(err) }
  }
}

type CircleTxView = {
  state: string
  txHash?: string
  errorReason?: string
  transactionScreeningEvaluation?: { actions?: string[]; ruleName?: string }
}

/** Poll a Circle transaction until it reaches a terminal state (or times out). */
async function pollTransaction(
  c: Pick<CircleDeveloperControlledWalletsClient, 'getTransaction'>,
  id: string,
  tries: number,
  delayMs: number,
): Promise<CircleTxView> {
  let last: CircleTxView = { state: 'PENDING' }
  for (let i = 0; i < tries; i++) {
    const r = await c.getTransaction({ id })
    const t = (r.data?.transaction ?? {}) as CircleTxView
    if (t.state) last = t
    if (t.state && TERMINAL.has(t.state)) return t
    await sleep(delayMs)
  }
  return { ...last, state: last.state && !TERMINAL.has(last.state) ? 'TIMEOUT' : last.state }
}

/** Turn a screening evaluation into an honest, human rejection reason. */
function screeningReason(t: CircleTxView): string {
  const ev = t.transactionScreeningEvaluation
  const rule = ev?.ruleName ? ` (rule: ${ev.ruleName})` : ''
  const actions = ev?.actions?.length ? ` [${ev.actions.join(', ')}]` : ''
  return `Circle hosted policy denied the transfer at the wallet layer${rule}${actions}`
}

// ── live read ─────────────────────────────────────────────────────────────────────

export type CircleWalletState =
  | {
      configured: true
      walletId: string
      walletAddress: string | null
      blockchain: string | null
      state: string | null
      balances: { amount: string; symbol?: string; tokenAddress?: string }[]
      explorer: string | null
    }
  | { configured: false; reason: string }

/** Live Circle Agent Wallet state + balances (needs creds; read-only). */
export async function readCircleWallet(
  walletId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CircleWalletState> {
  const c = await client(env)
  if (!c) return { configured: false, reason: NOT_CONFIGURED }
  try {
    const [wRes, bRes] = await Promise.all([
      c.getWallet({ id: walletId }),
      c.getWalletTokenBalance({ id: walletId, includeAll: true }),
    ])
    const wallet = wRes.data?.wallet
    const balances = (bRes.data?.tokenBalances ?? []).map((b) => {
      const token = (b as { token?: { symbol?: string; tokenAddress?: string } }).token
      return { amount: b.amount, symbol: token?.symbol, tokenAddress: token?.tokenAddress }
    })
    return {
      configured: true,
      walletId,
      walletAddress: wallet?.address ?? null,
      blockchain: wallet?.blockchain ?? null,
      state: wallet?.state ?? null,
      balances,
      explorer: wallet?.address ? addressUrl(wallet.address) : null,
    }
  } catch (err) {
    return { configured: false, reason: msg(err) }
  }
}
