/**
 * The backend half of the passkey vault demo: the endpoints under /api/stellar/passkey
 * that the page calls with plain JSON, plus the transaction decoder another route serves.
 * The passkey never touches these. They are the server-side pieces (the vault deploy from
 * our operator, the KYA verdict, the agent's payment from its operator key, the live reads
 * that name who paid and what was signed), each answering in the prepared-or-executed
 * vocabulary the rest of the product uses.
 *
 * Every call names its network. Every reader here tolerates extra fields and never throws
 * on a shape it half-recognizes: a missing outcome reads as failed, with the server's own
 * reason where it gave one.
 */
import { apiFetch, explainError, readJson } from '../api'
import { txUrl, type PasskeyNetwork } from './passkey'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

// ── status ───────────────────────────────────────────────────────────────────────

/** The caps the backend enforces on this network, which the page sizes its defaults from. */
export type PasskeyCaps = {
  dailyCapMaxUsd: number
  perPaymentMaxUsd: number
  seedUsdDefault: number
  seedUsdMax: number
  agentPayMaxUsd: number
  sharedDailyCeilingUsd: number
}

export type PasskeyStatus = {
  network: PasskeyNetwork
  realMoney: boolean
  caps: PasskeyCaps | null
  relayer: { configured: boolean | null; product: string | null; keyVar: string | null }
  operator: { configured: boolean; address: string | null }
  smartAccount: { wasmHash: string; webauthnVerifier: string; verified: string | null } | null
  vaultWasmHash: string | null
  raw: Record<string, unknown>
}

function capsOf(v: unknown): PasskeyCaps | null {
  const c = obj(v)
  if (!c) return null
  const dailyCapMaxUsd = num(c.dailyCapMaxUsd) ?? num(c.dailyCapUsd)
  const perPaymentMaxUsd = num(c.perPaymentMaxUsd) ?? num(c.autoApproveUsd)
  const seedUsdDefault = num(c.seedUsdDefault)
  const seedUsdMax = num(c.seedUsdMax)
  const agentPayMaxUsd = num(c.agentPayMaxUsd)
  const sharedDailyCeilingUsd = num(c.sharedDailyCeilingUsd) ?? num(c.seedDailyTotalUsd)
  if ([dailyCapMaxUsd, perPaymentMaxUsd, seedUsdDefault, seedUsdMax, agentPayMaxUsd, sharedDailyCeilingUsd].some((x) => x === null)) return null
  return { dailyCapMaxUsd: dailyCapMaxUsd!, perPaymentMaxUsd: perPaymentMaxUsd!, seedUsdDefault: seedUsdDefault!, seedUsdMax: seedUsdMax!, agentPayMaxUsd: agentPayMaxUsd!, sharedDailyCeilingUsd: sharedDailyCeilingUsd! }
}

/** GET /api/stellar/passkey/status?network=: what this deployment serves on that network. */
export async function readPasskeyStatus(net: PasskeyNetwork): Promise<PasskeyStatus | null> {
  try {
    const res = await apiFetch(`/api/stellar/passkey/status?network=${encodeURIComponent(net)}`, { retries: 1 })
    if (!res.ok) return null
    const body = obj(await res.json())
    if (!body) return null
    const relayer = obj(body.relayer) ?? {}
    const operator = obj(body.operator) ?? {}
    const sa = obj(body.smartAccount)
    const configured = typeof relayer.configured === 'boolean' ? relayer.configured : typeof relayer.keyConfigured === 'boolean' ? relayer.keyConfigured : null
    return {
      network: net,
      realMoney: body.realMoney === true,
      caps: capsOf(body.caps),
      relayer: { configured, product: str(relayer.product), keyVar: str(relayer.keyVar) },
      operator: { configured: operator.configured === true, address: str(operator.address) ?? str(operator.account) },
      smartAccount: sa && str(sa.wasmHash) && str(sa.webauthnVerifier) ? { wasmHash: String(sa.wasmHash), webauthnVerifier: String(sa.webauthnVerifier), verified: str(sa.verified) } : null,
      vaultWasmHash: str(obj(body.vault)?.wasmHash),
      raw: body,
    }
  } catch {
    return null
  }
}

/**
 * The defaults the page offers, derived from the caps rather than written down, so a
 * default can never exceed what the backend will accept on the network in view. The
 * payment is half the seed (so two can settle), never above the per-payment ceiling or
 * the agent-pay cap, and rounded to the token's seven decimals.
 */
export function defaultsFor(caps: PasskeyCaps): { dailyCapUsd: number; autoApproveUsd: number; seedUsd: number; payUsd: number } {
  const round7 = (n: number) => Math.floor(n * 1e7) / 1e7
  const autoApproveUsd = caps.perPaymentMaxUsd
  const seedUsd = Math.min(caps.seedUsdDefault, caps.seedUsdMax)
  const payUsd = round7(Math.min(caps.agentPayMaxUsd, autoApproveUsd, seedUsd > 0 ? seedUsd / 2 : caps.agentPayMaxUsd))
  return { dailyCapUsd: caps.dailyCapMaxUsd, autoApproveUsd, seedUsd, payUsd }
}

// ── the vault deploy ─────────────────────────────────────────────────────────────

type NotSettled = 'prepared' | 'refused' | 'failed' | 'pending'

function notSettled(o: unknown): NotSettled {
  return o === 'prepared' || o === 'refused' || o === 'pending' ? o : 'failed'
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length ? out : undefined
}

/**
 * The USDC the server moved into the new vault so the demo has something to pay with.
 * It can legitimately not happen (the operator was short, or seedUsd was 0), which the
 * page has to say, because an empty vault is why a later payment fails.
 */
export type SeedResult = {
  amountUsd: number
  /** 'settled' when it moved; 'skipped', 'none', 'error' and the rest when it did not. */
  outcome: string
  txHash?: string
  explorerUrl?: string
  reason?: string
}

/** Who paid a transaction's network fee, as the backend named it. */
export type FeePayerNamed = { account: string; who: 'operator' | 'relayer' }

export type VaultDeploy =
  | {
      outcome: 'settled'
      vault: string
      /** The vault's own contract page, which is not the deploy transaction. */
      vaultUrl: string
      txHash: string
      explorerUrl: string
      ledger?: number
      seed?: SeedResult
      operator: string | null
      feePayer: FeePayerNamed | null
      /** owner() read back from the new vault, live. */
      ownerReadBack: { owner: string | null; matches: boolean | null; read: string }
    }
  | { outcome: NotSettled; reason: string; code?: string; txHash?: string; explorerUrl?: string }

type DeployBody = Partial<{
  outcome: string
  code: string
  vault: string
  operator: string | null
  feePayer: { account?: unknown; who?: unknown } | null
  ownerReadBack: { owner?: unknown; matches?: unknown; read?: unknown } | null
  /** The vault contract's explorer page. The deploy transaction lives under `deploy`. */
  explorerUrl: string
  deploy: { txHash?: string; explorerUrl?: string; ledger?: number } | null
  seed: { amountUsd?: number; outcome?: string; txHash?: string; explorerUrl?: string; reason?: string } | null
  /** Only on the paths that never nest, so both are read. */
  txHash: string
  ledger: number
  reason: string
  error: string
  contractErrorName: string
}>

function feePayerOf(v: unknown): FeePayerNamed | null {
  const f = obj(v)
  const account = str(f?.account)
  if (!account) return null
  return { account, who: f?.who === 'operator' ? 'operator' : 'relayer' }
}

/**
 * POST /api/stellar/passkey/vault/deploy: a fresh vault whose OWNER is the smart account.
 * The passkey's public key goes with it: the backend reads the account's signers off the
 * ledger and deploys only when that key is its one and only signer.
 */
export async function deployPasskeyVault(
  net: PasskeyNetwork,
  input: { owner: string; ownerPublicKey: string; dailyCapUsd: number; autoApproveUsd: number; seedUsd?: number },
): Promise<VaultDeploy> {
  const res = await apiFetch('/api/stellar/passkey/vault/deploy', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ network: net, ...input }),
    timeoutMs: 120_000,
  })
  const body = await readJson<DeployBody>(res)
  // The deploy transaction is nested under `deploy`; the top-level explorerUrl is the
  // vault's contract page. Reading the top level as the transaction would report a
  // perfectly good deployment as a failure, so both are read from where they live.
  const txHash = body.deploy?.txHash ?? body.txHash
  if (res.ok && body.outcome === 'settled' && body.vault && txHash) {
    const s = body.seed
    const seed: SeedResult | undefined = s
      ? {
          amountUsd: s.amountUsd ?? 0,
          outcome: s.outcome ?? (s.txHash ? 'settled' : 'none'),
          txHash: s.txHash,
          explorerUrl: s.explorerUrl ?? (s.txHash ? txUrl(net, s.txHash) : undefined),
          reason: s.reason,
        }
      : undefined
    const back = obj(body.ownerReadBack)
    return {
      outcome: 'settled',
      vault: body.vault,
      vaultUrl: body.explorerUrl ?? '',
      txHash,
      explorerUrl: body.deploy?.explorerUrl ?? txUrl(net, txHash),
      ledger: body.deploy?.ledger ?? body.ledger,
      seed,
      operator: str(body.operator),
      feePayer: feePayerOf(body.feePayer),
      ownerReadBack: { owner: str(back?.owner), matches: typeof back?.matches === 'boolean' ? back.matches : null, read: str(back?.read) ?? 'not read' },
    }
  }
  return {
    outcome: notSettled(body.outcome),
    code: body.code,
    reason:
      body.reason ??
      (body.contractErrorName ? `The contract refused it: ${body.contractErrorName}` : explainError(res.status, body.error)),
    txHash,
    explorerUrl: body.deploy?.explorerUrl,
  }
}

// ── live reads ───────────────────────────────────────────────────────────────────

export type VaultRead = {
  owner: string
  operator: string
  frozen: boolean
  allowlistEnabled: boolean
  decimals: number
  balanceRaw: string
  dailyCapRaw: string
  autoApproveMaxRaw: string
  spentTodayRaw: string
  ownerIsDemoSmartAccount: boolean
  checkedAt: string
}

/** GET /api/stellar/passkey/vault: one vault, read live. Null when it could not be read. */
export async function readPasskeyVault(net: PasskeyNetwork, contract: string): Promise<VaultRead | null> {
  try {
    const res = await apiFetch(`/api/stellar/passkey/vault?contract=${encodeURIComponent(contract)}&network=${encodeURIComponent(net)}`, { retries: 1 })
    if (!res.ok) return null
    const b = obj(await res.json())
    if (!b || !str(b.owner)) return null
    return {
      owner: String(b.owner),
      operator: String(b.operator ?? ''),
      frozen: b.frozen === true,
      allowlistEnabled: b.allowlistEnabled === true,
      decimals: num(b.decimals) ?? 7,
      balanceRaw: String(b.balanceRaw ?? '0'),
      dailyCapRaw: String(b.dailyCapRaw ?? '0'),
      autoApproveMaxRaw: String(b.autoApproveMaxRaw ?? '0'),
      spentTodayRaw: String(b.spentTodayRaw ?? '0'),
      ownerIsDemoSmartAccount: b.ownerIsDemoSmartAccount === true,
      checkedAt: str(b.checkedAt) ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export type FeePayerRead =
  | { state: 'found'; feeAccount: string; sourceAccount: string; feeBump: boolean; feeChargedStroops: string | null; who: 'operator' | 'relayer'; status: string }
  | { state: 'not-yet' }
  | { state: 'unavailable'; reason: string }

/**
 * GET /api/stellar/passkey/fee-payer: who the ledger charged for a transaction. A hash the
 * RPC does not know yet answers 404, which is "not yet" for a few seconds after a submit,
 * so the caller may ask again.
 */
export async function readFeePayer(net: PasskeyNetwork, hash: string): Promise<FeePayerRead> {
  try {
    const res = await apiFetch(`/api/stellar/passkey/fee-payer?hash=${encodeURIComponent(hash)}&network=${encodeURIComponent(net)}`, { retries: 1 })
    const b = obj(await res.json().catch(() => null)) ?? {}
    if (res.status === 404) return { state: 'not-yet' }
    if (!res.ok || !str(b.feeAccount)) return { state: 'unavailable', reason: str(b.reason) ?? explainError(res.status, str(b.error) ?? undefined) }
    return {
      state: 'found',
      feeAccount: String(b.feeAccount),
      sourceAccount: String(b.sourceAccount ?? ''),
      feeBump: b.feeBump === true,
      feeChargedStroops: str(b.feeChargedStroops),
      who: b.who === 'operator' ? 'operator' : 'relayer',
      status: str(b.status) ?? 'unknown',
    }
  } catch (e) {
    return { state: 'unavailable', reason: e instanceof Error ? e.message : 'the read did not go through' }
  }
}

/** One signer inside a decoded authorization, as GET /api/stellar/tx/:hash describes it. */
export type DecodedSigner = {
  kind: 'webauthn-secp256r1' | 'ed25519' | 'delegated' | 'unknown'
  verifier: string | null
  publicKeyHex: string | null
  authenticatorFlags: { UP: boolean; UV: boolean; BE: boolean; BS: boolean; AT: boolean; ED: boolean } | null
  signCount: number | null
  clientDataType: string | null
  origin: string | null
}

export type DecodedAuth = {
  credential: string | null
  address: string | null
  nonce: string | null
  signatureExpirationLedger: number | null
  rootInvocation: { contract: string | null; function: string | null }
  signers: DecodedSigner[]
}

export type TxEvidence =
  | {
      state: 'found'
      hash: string
      status: string | null
      sourceAccount: string | null
      feeAccount: string | null
      feeChargedStroops: string | null
      auth: DecodedAuth[]
      summary: string | null
      caveat: string | null
      explorerTx: string | null
    }
  | { state: 'absent' }
  | { state: 'unavailable'; reason: string }

const flagsOf = (v: unknown): DecodedSigner['authenticatorFlags'] => {
  const f = obj(v)
  if (!f) return null
  const b = (k: string) => f[k] === true
  return { UP: b('UP'), UV: b('UV'), BE: b('BE'), BS: b('BS'), AT: b('AT'), ED: b('ED') }
}

/**
 * GET /api/stellar/tx/:hash?network=: the transaction decoded, authorization by
 * authorization, by a route another part of this product serves. When that route is not
 * deployed the answer is 404 with no body of ours, read as `absent` so the page can say
 * the decoder is not available rather than show an error.
 */
export async function readTxEvidence(net: PasskeyNetwork, hash: string): Promise<TxEvidence> {
  try {
    const res = await apiFetch(`/api/stellar/tx/${encodeURIComponent(hash)}?network=${encodeURIComponent(net)}`, { retries: 1 })
    const b = obj(await res.json().catch(() => null))
    if (res.status === 404 && !str(b?.hash)) return { state: 'absent' }
    if (!res.ok || !b) return { state: 'unavailable', reason: str(b?.reason) ?? explainError(res.status, str(b?.error) ?? undefined) }
    const auth = Array.isArray(b.auth) ? b.auth : []
    return {
      state: 'found',
      hash: str(b.hash) ?? hash,
      status: str(b.status),
      sourceAccount: str(b.sourceAccount),
      feeAccount: str(b.feeAccount),
      feeChargedStroops: b.feeChargedStroops === undefined || b.feeChargedStroops === null ? null : String(b.feeChargedStroops),
      auth: auth.map((a) => {
        const e = obj(a) ?? {}
        const root = obj(e.rootInvocation) ?? {}
        const signers = Array.isArray(e.signers) ? e.signers : []
        return {
          credential: str(e.credential),
          address: str(e.address),
          nonce: e.nonce === undefined || e.nonce === null ? null : String(e.nonce),
          signatureExpirationLedger: num(e.signatureExpirationLedger),
          rootInvocation: { contract: str(root.contract), function: str(root.function) },
          signers: signers.map((s) => {
            const x = obj(s) ?? {}
            const kind = x.kind === 'webauthn-secp256r1' || x.kind === 'ed25519' || x.kind === 'delegated' ? x.kind : 'unknown'
            return {
              kind,
              verifier: str(x.verifier),
              publicKeyHex: str(x.publicKeyHex),
              authenticatorFlags: flagsOf(x.authenticatorFlags),
              signCount: num(x.signCount),
              clientDataType: str(x.clientDataType),
              origin: str(x.origin),
            } as DecodedSigner
          }),
        }
      }),
      summary: str(b.summary),
      caveat: str(b.caveat),
      explorerTx: str(obj(b.explorer)?.tx),
    }
  } catch (e) {
    return { state: 'unavailable', reason: e instanceof Error ? e.message : 'the read did not go through' }
  }
}

// ── the allowlist plan ───────────────────────────────────────────────────────────

export type Decision = 'ALLOW' | 'WARN' | 'DENY'

const isDecision = (v: unknown): v is Decision => v === 'ALLOW' || v === 'WARN' || v === 'DENY'

export type AllowlistPlan = {
  decision: Decision
  risk?: number | string
  reasons: string[]
  /** How the payee is tied to an agent: 'linked-wallet', 'declared' or 'none'. */
  binding: string
  /** The one write the passkey can sign, or null when the verdict writes nothing (WARN). */
  chainAction: { method: 'set_allowed'; payee: string; ok: boolean } | null
  serverWarning?: string
  enforcement?: Record<string, string>
}

type PlanBody = Partial<{
  decision: unknown
  risk: unknown
  reasons: unknown
  binding: unknown
  chainAction: { method?: unknown; payee?: unknown; ok?: unknown } | null
  serverWarning: unknown
  enforcement: unknown
  reason: string
  error: string
}>

/** POST /api/stellar/passkey/allowlist/plan: the risk engine's verdict and the write it implies. */
export async function planAllowlist(net: PasskeyNetwork, input: { contract: string; payee: string; agentId?: string }): Promise<AllowlistPlan> {
  const res = await apiFetch('/api/stellar/passkey/allowlist/plan', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ network: net, ...input }),
    timeoutMs: 60_000,
  })
  const body = await readJson<PlanBody>(res)
  if (!res.ok || !isDecision(body.decision)) throw new Error(body.reason ?? explainError(res.status, body.error))
  const a = body.chainAction
  const chainAction =
    a && a.method === 'set_allowed' && typeof a.payee === 'string' && typeof a.ok === 'boolean'
      ? { method: 'set_allowed' as const, payee: a.payee, ok: a.ok }
      : null
  return {
    decision: body.decision,
    risk: typeof body.risk === 'number' || typeof body.risk === 'string' ? body.risk : undefined,
    reasons: Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === 'string') : [],
    binding: typeof body.binding === 'string' ? body.binding : 'none',
    chainAction,
    serverWarning: typeof body.serverWarning === 'string' ? body.serverWarning : undefined,
    enforcement: stringMap(body.enforcement),
  }
}

// ── the agent's payment ──────────────────────────────────────────────────────────

export type AgentPay =
  | { outcome: 'settled'; txHash: string; explorerUrl: string; ledger?: number; feePayer: FeePayerNamed | null }
  | { outcome: 'refused'; contractErrorCode?: number; contractErrorName?: string; note?: string }
  | { outcome: 'prepared' | 'failed' | 'pending'; reason: string; code?: string; txHash?: string; explorerUrl?: string }

type PayBody = Partial<{
  outcome: string
  code: string
  txHash: string
  explorerUrl: string
  ledger: number
  feePayer: unknown
  contractErrorCode: unknown
  contractErrorName: unknown
  note: string
  reason: string
  error: string
}>

/** POST /api/stellar/passkey/agent-pay: the agent's operator calls pay() on the vault. */
export async function agentPay(net: PasskeyNetwork, input: { contract: string; to: string; amountUsd: number }): Promise<AgentPay> {
  const res = await apiFetch('/api/stellar/passkey/agent-pay', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ network: net, ...input }),
    timeoutMs: 90_000,
  })
  const body = await readJson<PayBody>(res)
  if (res.ok && body.outcome === 'settled' && body.txHash) {
    return { outcome: 'settled', txHash: body.txHash, explorerUrl: body.explorerUrl ?? txUrl(net, body.txHash), ledger: body.ledger, feePayer: feePayerOf(body.feePayer) }
  }
  if (body.outcome === 'refused') {
    return {
      outcome: 'refused',
      contractErrorCode: typeof body.contractErrorCode === 'number' ? body.contractErrorCode : undefined,
      contractErrorName: typeof body.contractErrorName === 'string' ? body.contractErrorName : undefined,
      note: body.note ?? body.reason,
    }
  }
  const outcome = body.outcome === 'prepared' || body.outcome === 'pending' ? body.outcome : 'failed'
  // A prepared pay() carries its explanation in `note` rather than `reason`, because
  // nothing failed: the call was built and deliberately not submitted.
  return {
    outcome,
    code: body.code,
    reason: body.reason ?? body.note ?? explainError(res.status, body.error),
    txHash: body.txHash,
    explorerUrl: body.explorerUrl,
  }
}
