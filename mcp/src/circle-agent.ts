/**
 * Circle Agent Wallets — the hosted, wallet-layer enforcement layer (Phase 3).
 *
 * This is the SECOND of A-Identity's three spend-policy layers, and it is entirely
 * ADDITIVE + credential-gated, mirroring how `arc-contracts.ts` gates the on-chain
 * vault behind ARC_SIGNER_KEY:
 *
 *   1. server pre-check          — our engine (platform.ts createInstruction)
 *   2. Circle Agent Wallet       — THIS module: a real Developer-Controlled Wallet
 *                                  on ARC-TESTNET whose outbound USDC transfers are
 *                                  screened by Circle's hosted policy engine at the
 *                                  wallet layer (sanctions / allow-block / freeze).
 *   3. on-chain policy vault     — the trustless source of truth (arc-contracts.ts)
 *
 * Be precise about what Circle enforces: its wallet-layer control is TRANSACTION
 * SCREENING (address allow/blocklist + sanctions + wallet freeze), surfaced as a
 * `transactionScreeningEvaluation` and a DENIED transaction state. Circle does NOT
 * expose a per-wallet daily-USD *transfer* cap as an API primitive — that cap stays
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
/** Native USDC on Arc testnet — the same dollar our vault settles in (6 display decimals). */
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
/** Circle's hosted policy DENIED the transfer — an authoritative "no" (like a vault revert). */
export type CirclePayRejected = { executed: false; rejected: true; reason: string }
/** No creds / infra error / timeout — NOT a policy rejection; caller may fall back. */
export type CirclePayUnavailable = { executed: false; rejected: false; reason: string }
export type CirclePayResult = CirclePayTx | CirclePayRejected | CirclePayUnavailable

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'])

/**
 * Send USDC from a Circle Agent Wallet on Arc. Circle's hosted policy engine screens
 * the transfer at the wallet layer; a screening DENY comes back as a rejection (the
 * caller treats it like a vault policy revert). COMPLETE returns the real tx hash.
 * Anything else (no creds, FAILED, timeout) is reported as "unavailable" so the caller
 * can fall back to another settlement path — never a silent success.
 */
export async function circlePay(
  walletId: string,
  to: string,
  amountUsd: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CirclePayResult> {
  const c = await client(env)
  if (!c) return { executed: false, rejected: false, reason: NOT_CONFIGURED }
  try {
    const created = await c.createTransaction({
      walletId,
      blockchain: ARC_BLOCKCHAIN as never,
      tokenAddress: ARC_USDC,
      destinationAddress: to,
      amount: [usdAmount(amountUsd)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as never)
    const txId = (created.data as { id?: string } | undefined)?.id
    if (!txId) return { executed: false, rejected: false, reason: 'Circle createTransaction returned no id' }

    const final = await pollTransaction(c, txId)
    if (final.state === 'COMPLETE' && final.txHash) {
      return { executed: true, txHash: final.txHash, explorerUrl: tx(final.txHash) }
    }
    if (final.state === 'DENIED') {
      return { executed: false, rejected: true, reason: screeningReason(final) }
    }
    const detail = final.errorReason ? `${final.state}: ${final.errorReason}` : `Circle transaction ${final.state}`
    return { executed: false, rejected: false, reason: detail }
  } catch (err) {
    return { executed: false, rejected: false, reason: msg(err) }
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
  c: CircleDeveloperControlledWalletsClient,
  id: string,
  tries = 20,
  delayMs = 2000,
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
