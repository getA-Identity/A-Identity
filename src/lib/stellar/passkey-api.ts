/**
 * The backend half of the passkey vault demo: the endpoints under /api/stellar/passkey
 * that the page calls with plain JSON. The passkey never touches these. They are the
 * server-side pieces (the vault deploy from our operator, the KYA verdict, the agent's
 * payment from its operator key), each answering in the prepared-or-executed vocabulary
 * the rest of the product uses.
 *
 * Every reader here tolerates extra fields and never throws on a shape it half-recognizes:
 * a missing outcome reads as failed, with the server's own reason where it gave one.
 */
import { apiFetch, explainError, readJson } from '../api'
import { PASSKEY_NETWORK, txUrl } from './passkey'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** GET /api/stellar/passkey/status: configuration flags, read to label the page. */
export type PasskeyStatus = Record<string, unknown>

export async function readPasskeyStatus(): Promise<PasskeyStatus | null> {
  try {
    const res = await apiFetch('/api/stellar/passkey/status', { retries: 1 })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return body && typeof body === 'object' ? (body as PasskeyStatus) : null
  } catch {
    return null
  }
}

export type SponsorReadiness = {
  /** true: the relay can pay; false: it cannot (prepared only); null: the status did not say. */
  ready: boolean | null
  /** The relayer product or key source, when the status names one. */
  product?: string
}

/**
 * Whether this deployment can sponsor fees, read from the status body. Looks under
 * `relayer` first, then at the top level, for the first boolean that answers the question.
 */
export function sponsorReadiness(status: PasskeyStatus | null): SponsorReadiness {
  if (!status) return { ready: null }
  const nested = status.relayer ?? status.relay ?? status.sponsor
  const scopes = [nested, status].filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
  const product = scopes.map((s) => s.product ?? s.mode ?? s.kind).find((v): v is string => typeof v === 'string')
  for (const s of scopes) {
    // keyConfigured is the one the backend actually sends (relayer.keyConfigured); the
    // rest are there so a rename on that side degrades to "it did not say" rather than
    // to a confident wrong answer.
    for (const key of ['keyConfigured', 'configured', 'keySet', 'ready', 'enabled', 'relayerConfigured', 'sponsorConfigured']) {
      if (typeof s[key] === 'boolean') return { ready: s[key] as boolean, product }
    }
  }
  return { ready: null, product }
}

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
    }
  | { outcome: NotSettled; reason: string; txHash?: string; explorerUrl?: string }

type DeployBody = Partial<{
  outcome: string
  vault: string
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

/** POST /api/stellar/passkey/vault/deploy: a fresh vault whose OWNER is the smart account. */
export async function deployPasskeyVault(input: {
  owner: string
  dailyCapUsd: number
  autoApproveUsd: number
  seedUsd?: number
}): Promise<VaultDeploy> {
  const res = await apiFetch('/api/stellar/passkey/vault/deploy', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ network: PASSKEY_NETWORK, ...input }),
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
          explorerUrl: s.explorerUrl ?? (s.txHash ? txUrl(s.txHash) : undefined),
          reason: s.reason,
        }
      : undefined
    return {
      outcome: 'settled',
      vault: body.vault,
      vaultUrl: body.explorerUrl ?? '',
      txHash,
      explorerUrl: body.deploy?.explorerUrl ?? txUrl(txHash),
      ledger: body.deploy?.ledger ?? body.ledger,
      seed,
    }
  }
  return {
    outcome: notSettled(body.outcome),
    reason:
      body.reason ??
      (body.contractErrorName ? `The contract refused it: ${body.contractErrorName}` : explainError(res.status, body.error)),
    txHash,
    explorerUrl: body.deploy?.explorerUrl,
  }
}

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
export async function planAllowlist(input: { contract: string; payee: string; agentId?: string }): Promise<AllowlistPlan> {
  const res = await apiFetch('/api/stellar/passkey/allowlist/plan', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ network: PASSKEY_NETWORK, ...input }),
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

export type AgentPay =
  | { outcome: 'settled'; txHash: string; explorerUrl: string; ledger?: number }
  | { outcome: 'refused'; contractErrorCode?: number; contractErrorName?: string; note?: string }
  | { outcome: 'prepared' | 'failed' | 'pending'; reason: string; txHash?: string; explorerUrl?: string }

type PayBody = Partial<{
  outcome: string
  txHash: string
  explorerUrl: string
  ledger: number
  contractErrorCode: unknown
  contractErrorName: unknown
  note: string
  reason: string
  error: string
}>

/** POST /api/stellar/passkey/agent-pay: the agent's operator calls pay() on the vault. */
export async function agentPay(input: { contract: string; to: string; amountUsd: number }): Promise<AgentPay> {
  const res = await apiFetch('/api/stellar/passkey/agent-pay', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ network: PASSKEY_NETWORK, ...input }),
    timeoutMs: 90_000,
  })
  const body = await readJson<PayBody>(res)
  if (res.ok && body.outcome === 'settled' && body.txHash) {
    return { outcome: 'settled', txHash: body.txHash, explorerUrl: body.explorerUrl ?? txUrl(body.txHash), ledger: body.ledger }
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
    reason: body.reason ?? body.note ?? explainError(res.status, body.error),
    txHash: body.txHash,
    explorerUrl: body.explorerUrl,
  }
}
