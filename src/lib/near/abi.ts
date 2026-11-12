/**
 * The NEAR vault's and the risk registry's JSON, as this page reads it.
 *
 * Contracts: near/contracts/agent-spend-policy (types.rs, event.rs, error.rs) and
 * near/contracts/a-identity-registry (types.rs). Every u64 and u128 crosses JSON as a decimal
 * string there, so every one is a bigint here, and every shape is checked field by field: a
 * contract at an address can answer anything, and a reply that is not the vault's shape must
 * read as "not this vault", never as numbers on the page.
 *
 * The registry verdict is read the way the vault reads it (verdict.rs): only `null` or an
 * object whose `verdict` is exactly "ALLOW", "WARN" or "DENY" means something. Anything else is
 * unreadable, which the vault itself treats as a refusal (RegistryUnavailable).
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
import { isNearAccountId } from './ids.ts'
import { u128 } from './units.ts'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isAccount = (v: unknown): v is string => typeof v === 'string' && isNearAccountId(v)
const optString = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined)

/** Every vault build reports a get_config().version that starts with this. */
export const VAULT_VERSION_PREFIX = 'agent-spend-policy '

/** The build this page is written against (lib.rs VERSION): it reads every field of it. */
export const VAULT_VERSION = 'agent-spend-policy 0.2.0'

/**
 * Where a vault's build stands against the one this page is written for. `earlier` is a build
 * before 0.2.0: its holds carry no kind, its refusal counters have no bound and no forget
 * method, and it does not refuse relayed agent calls. `newer` may add fields this page does not
 * show. `unknown` is a version string this page cannot read as one.
 */
export function vaultBuild(version: string): 'current' | 'earlier' | 'newer' | 'unknown' {
  if (version === VAULT_VERSION) return 'current'
  const m = /^agent-spend-policy (\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return 'unknown'
  const [maj, min] = [Number(m[1]), Number(m[2])]
  return maj > 0 || min > 2 || (min === 2 && Number(m[3]) > 0) ? 'newer' : 'earlier'
}

/** get_config(). */
export type VaultConfig = {
  ownerId: string
  tokenId: string
  /** null: no on-chain verdict check at all. */
  registryId: string | null
  frozen: boolean
  /** Token units per UTC day. 0 means no cap. */
  dailyCap: bigint
  /** Token units per payment. 0 means no ceiling. */
  autoApproveMax: bigint
  allowlistEnabled: boolean
  /** yoctoNEAR the vault attaches to register a new payee on the token. */
  tokenStorageDeposit: bigint
  version: string
  /** Amendment A1. null when the build does not report it, which is a build from before A1. */
  holdUnknown: boolean | null
}

export function parseVaultConfig(v: unknown): VaultConfig | null {
  if (!isObject(v)) return null
  const dailyCap = u128(v.daily_cap)
  const autoApproveMax = u128(v.auto_approve_max)
  const deposit = u128(v.token_storage_deposit)
  if (!isAccount(v.owner_id) || !isAccount(v.token_id)) return null
  if (!(v.registry_id === null || v.registry_id === undefined || isAccount(v.registry_id))) return null
  if (typeof v.frozen !== 'boolean' || typeof v.allowlist_enabled !== 'boolean' || typeof v.version !== 'string') return null
  if (dailyCap === null || autoApproveMax === null || deposit === null) return null
  if (!(v.hold_unknown === undefined || typeof v.hold_unknown === 'boolean')) return null
  return {
    ownerId: v.owner_id,
    tokenId: v.token_id,
    registryId: typeof v.registry_id === 'string' ? v.registry_id : null,
    frozen: v.frozen,
    dailyCap,
    autoApproveMax,
    allowlistEnabled: v.allowlist_enabled,
    tokenStorageDeposit: deposit,
    version: v.version,
    holdUnknown: typeof v.hold_unknown === 'boolean' ? v.hold_unknown : null,
  }
}

/** list_agents() entry: the contract's record of one agent key. */
export type AgentKeyRecord = { publicKey: string; label: string; expiresAtS: bigint; revoked: boolean; addedAtS: bigint }

export function parseAgents(v: unknown): AgentKeyRecord[] | null {
  if (!Array.isArray(v)) return null
  const out: AgentKeyRecord[] = []
  for (const a of v) {
    if (!isObject(a) || typeof a.public_key !== 'string' || typeof a.label !== 'string' || typeof a.revoked !== 'boolean') return null
    const expires = u128(a.expires_at_s)
    const added = u128(a.added_at_s)
    if (expires === null || added === null) return null
    out.push({ publicKey: a.public_key, label: a.label, expiresAtS: expires, revoked: a.revoked, addedAtS: added })
  }
  return out
}

/**
 * What the VAULT saw when it held a payment (types.rs HoldKind), recorded on the hold and on its
 * payment_held event from 0.2.0 on. The hold's `reason` is the vault's code for a held pay but
 * the agent's own free text for a request, and that text can read like a vault code, so what a
 * hold means is read from `kind`, never from `reason`.
 */
export const HOLD_KINDS = ['registry_warn', 'unknown_payee', 'agent_request'] as const
export type HoldKind = (typeof HOLD_KINDS)[number]

/** A hold kind, or null: absent (a build before 0.2.0) or a value this page does not know. */
export function parseHoldKind(v: unknown): HoldKind | null {
  return typeof v === 'string' && (HOLD_KINDS as readonly string[]).includes(v) ? (v as HoldKind) : null
}

/** list_held() entry: a payment waiting for the owner. */
export type HeldPayment = {
  id: string
  paymentId: string
  agentPk: string
  payee: string
  amount: bigint
  memo: string | null
  /** The vault's code for a held pay, or the agent's own words for a request. Never decides what is shown. */
  reason: string
  createdAtS: bigint
  expiresAtS: bigint
  /** What the vault saw; null when the build records none, or one this page does not know. */
  kind: HoldKind | null
  /** The kind exactly as the vault wrote it, for one this page does not know; null when absent. */
  kindText: string | null
}

export function parseHeld(v: unknown): HeldPayment[] | null {
  if (!Array.isArray(v)) return null
  const out: HeldPayment[] = []
  for (const h of v) {
    if (!isObject(h) || !isAccount(h.payee) || typeof h.agent_pk !== 'string' || typeof h.reason !== 'string') return null
    const id = u128(h.id)
    const paymentId = u128(h.payment_id)
    const amount = u128(h.amount)
    const created = u128(h.created_at_s)
    const expires = u128(h.expires_at_s)
    const memo = optString(h.memo)
    if (id === null || paymentId === null || amount === null || created === null || expires === null || memo === undefined) return null
    // Absent on a build before 0.2.0, which is shown as unclassified; a kind that is there must be a string.
    if (!(h.kind === undefined || h.kind === null || typeof h.kind === 'string')) return null
    out.push({
      id: id.toString(),
      paymentId: paymentId.toString(),
      agentPk: h.agent_pk,
      payee: h.payee,
      amount,
      memo,
      reason: h.reason,
      createdAtS: created,
      expiresAtS: expires,
      kind: parseHoldKind(h.kind),
      kindText: typeof h.kind === 'string' ? h.kind : null,
    })
  }
  return out
}

/** list_allowlist(): account ids. */
export function parseAccountList(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every(isAccount)) return null
  return v as string[]
}

/** A per-payee counter (paid_count, refusal_count, guard_refusal_count): a JSON number. */
export function parseCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

export type Verdict = 'ALLOW' | 'WARN' | 'DENY'

/** get_verdict() on the registry, as the vault reads it before every payment. */
export type VerdictRecord = {
  verdict: Verdict
  reasons: string[]
  evidence: string | null
  score: number | null
  codeHash: string | null
  updatedAtNs: bigint | null
  updatedBy: string | null
  expiresAtNs: bigint | null
}

const VERDICTS = new Set<Verdict>(['ALLOW', 'WARN', 'DENY'])

/**
 * `null` is "no verdict" and reads as `{ ok: true, verdict: null }`. A record whose verdict is
 * not one of the three exact strings is unreadable (`ok: false`), as it is for the vault.
 * The decoration (reasons, evidence, timestamps) is read leniently: the vault decides on
 * `verdict` alone, so a malformed decoration loses the decoration, never the verdict.
 */
export function parseVerdict(v: unknown): { ok: true; verdict: VerdictRecord | null } | { ok: false } {
  if (v === null) return { ok: true, verdict: null }
  if (!isObject(v) || typeof v.verdict !== 'string' || !VERDICTS.has(v.verdict as Verdict)) return { ok: false }
  return {
    ok: true,
    verdict: {
      verdict: v.verdict as Verdict,
      reasons: Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string') : [],
      evidence: typeof v.evidence === 'string' ? v.evidence : null,
      score: typeof v.score === 'number' ? v.score : null,
      codeHash: typeof v.code_hash === 'string' ? v.code_hash : null,
      updatedAtNs: u128(v.updated_at_ns),
      updatedBy: typeof v.updated_by === 'string' ? v.updated_by : null,
      expiresAtNs: u128(v.expires_at_ns),
    },
  }
}

/** The held reasons the vault writes for a held pay (lib.rs). A request's reason is the agent's own text, whatever it says. */
export const REASON_REGISTRY_WARN = 'RegistryWarn'
export const REASON_UNKNOWN_PAYEE = 'UnknownPayee'

/** A hold as the owner reads it: the label and the sentence come from `kind` alone. */
export type HoldReading = {
  /** The pill. */
  label: 'Registry warned' | 'Unknown payee' | 'Agent asked' | 'Unclassified'
  tone: 'warn' | 'accent' | 'muted'
  /** Why the vault held it, in one sentence, from `kind` alone. */
  title: string
  /**
   * The agent's own text from request_payment, when the reason is certainly the agent's: the
   * vault writes no other text than its two codes, and only with the kind they name. Shown as
   * the agent's words, never as the vault's. Null for a held pay, whose reason is the vault's code.
   */
  agentWords: string | null
  /** A hold with no kind (a build before 0.2.0): the stored reason, which that build does not attribute. */
  unattributed: string | null
}

export function readHold(h: { kind: HoldKind | null; kindText?: string | null; reason: string }): HoldReading {
  const text = h.reason.trim() === '' ? null : h.reason
  const vaultCode = (h.kind === 'registry_warn' && h.reason === REASON_REGISTRY_WARN) || (h.kind === 'unknown_payee' && h.reason === REASON_UNKNOWN_PAYEE)
  switch (h.kind) {
    case 'registry_warn':
      return { label: 'Registry warned', tone: 'warn', title: 'The registry answered WARN for this payee when the vault held the payment', agentWords: vaultCode ? null : text, unattributed: null }
    case 'unknown_payee':
      return {
        label: 'Unknown payee',
        tone: 'warn',
        title: 'Never judged: the registry had no verdict on this payee, you had not listed it, and the vault had never paid it',
        agentWords: vaultCode ? null : text,
        unattributed: null,
      }
    case 'agent_request':
      return {
        label: 'Agent asked',
        tone: 'accent',
        title: 'The agent asked for your approval about a payee the registry allowed, or one the vault already knew',
        agentWords: text,
        unattributed: null,
      }
    default:
      return {
        label: 'Unclassified',
        tone: 'muted',
        title: h.kindText
          ? `Unclassified: the vault recorded a kind this page does not know ("${h.kindText}"), so it does not guess from the reason text`
          : 'Unclassified: this vault build does not record why it held a payment, so the page does not guess from the reason text',
        agentWords: null,
        unattributed: text,
      }
  }
}

/** The methods a function-call key the vault creates may call: the contract's AGENT_METHODS. */
export const AGENT_METHODS = ['pay', 'request_payment', 'record_refusal'] as const

/** True when a key's method list is exactly the agent's three methods, in any order. */
export function isAgentMethodList(methods: readonly string[]): boolean {
  return methods.length === AGENT_METHODS.length && AGENT_METHODS.every((m) => methods.includes(m))
}

// -- what a transaction did --------------------------------------------------------------

/** The vault's event standard (event.rs). */
export const VAULT_EVENT_STANDARD = 'a_identity_vault'

export type ChainEvent = {
  standard: string
  event: string
  data: Record<string, unknown>
  receiptId: string
  /** The account whose receipt logged it: the only account it can speak for. */
  executorId: string
}

type OutcomeLike = { id?: unknown; outcome?: { executor_id?: unknown; logs?: unknown; status?: unknown } }

function outcomes(raw: unknown): OutcomeLike[] {
  if (!isObject(raw)) return []
  const list: unknown[] = [raw.transaction_outcome, ...(Array.isArray(raw.receipts_outcome) ? raw.receipts_outcome : [])]
  return list.filter(isObject) as OutcomeLike[]
}

/**
 * Every NEP-297 event in a transaction, one entry per data object. An event counts only for the
 * account that logged it, so the caller filters by `executorId`: any contract can log any text.
 */
export function eventsOf(raw: unknown): ChainEvent[] {
  const out: ChainEvent[] = []
  for (const o of outcomes(raw)) {
    const executorId = typeof o.outcome?.executor_id === 'string' ? o.outcome.executor_id : ''
    const receiptId = typeof o.id === 'string' ? o.id : ''
    const logs = Array.isArray(o.outcome?.logs) ? o.outcome.logs : []
    for (const line of logs) {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue
      let v: unknown
      try {
        v = JSON.parse(line.slice('EVENT_JSON:'.length))
      } catch {
        continue
      }
      if (!isObject(v) || typeof v.standard !== 'string' || typeof v.event !== 'string') continue
      const items = Array.isArray(v.data) ? v.data : [v.data]
      for (const d of items) out.push({ standard: v.standard, event: v.event, data: isObject(d) ? d : {}, receiptId, executorId })
    }
  }
  return out
}

/** The vault's own events in a transaction. */
export function vaultEventsOf(raw: unknown, vaultId: string): ChainEvent[] {
  return eventsOf(raw).filter((e) => e.standard === VAULT_EVENT_STANDARD && e.executorId === vaultId)
}

/** NEP-141 transfers the token itself logged: the settlement evidence for money that moved. */
export function tokenTransfersOf(raw: unknown, tokenId: string): { from: string; to: string; amount: bigint }[] {
  return eventsOf(raw)
    .filter((e) => e.standard === 'nep141' && e.event === 'ft_transfer' && e.executorId === tokenId)
    .flatMap((e) => {
      const amount = u128(e.data.amount)
      return typeof e.data.old_owner_id === 'string' && typeof e.data.new_owner_id === 'string' && amount !== null
        ? [{ from: e.data.old_owner_id, to: e.data.new_owner_id, amount }]
        : []
    })
}

/** The transaction's hash and signer as the outcome names them. */
export function txIdentity(raw: unknown): { hash: string; signerId: string; receiverId: string } | null {
  if (!isObject(raw) || !isObject(raw.transaction)) return null
  const { hash, signer_id: signer, receiver_id: receiver } = raw.transaction
  if (typeof hash !== 'string' || typeof signer !== 'string' || typeof receiver !== 'string') return null
  return { hash, signerId: signer, receiverId: receiver }
}

/** A failure inside a receipt or the transaction, in the words a person can act on. */
function failureText(status: unknown): string | null {
  if (!isObject(status) || !('Failure' in status)) return null
  const raw = JSON.stringify(status.Failure)
  // A contract panic carries the vault's stable error name: "Smart contract panicked: NotOwner".
  const panic = /Smart contract panicked: ([A-Za-z0-9_ .:'-]+)/.exec(raw)
  if (panic) return panic[1].trim()
  const exec = /"ExecutionError":"([^"]+)"/.exec(raw)
  if (exec) return exec[1]
  const kind = /"kind":\{"([A-Za-z]+)"/.exec(raw)
  return kind ? kind[1] : 'the transaction failed'
}

export type TxVerdict =
  /** The transaction and every receipt succeeded. */
  | { ok: true }
  /** Something failed: the transaction itself, or a receipt after it (a callback, a token call). */
  | { ok: false; reason: string; where: 'transaction' | 'receipt' }

/**
 * Whether a FINAL transaction did what it was sent to do. A transaction can succeed while a
 * receipt it scheduled fails (a token transfer, a deleted key), so both are checked.
 */
export function txVerdict(raw: unknown): TxVerdict {
  if (!isObject(raw)) return { ok: false, reason: 'no outcome', where: 'transaction' }
  const top = failureText(raw.status)
  if (top) return { ok: false, reason: top, where: 'transaction' }
  for (const o of outcomes(raw)) {
    const r = failureText(o.outcome?.status)
    if (r) return { ok: false, reason: r, where: 'receipt' }
  }
  return { ok: true }
}

/** The vault's PayOutcome (pay, request_payment, record_refusal, owner_pay), from the final return value. */
export type PayOutcome = { status: 'sent' | 'refused' | 'held' | 'failed'; paymentId: string; reason: string | null; heldId: string | null }

export function payOutcomeOf(raw: unknown): PayOutcome | null {
  if (!isObject(raw) || !isObject(raw.status) || typeof raw.status.SuccessValue !== 'string' || raw.status.SuccessValue === '') return null
  let v: unknown
  try {
    const bin = atob(raw.status.SuccessValue)
    v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
  if (!isObject(v) || typeof v.payment_id !== 'string' || !['sent', 'refused', 'held', 'failed'].includes(String(v.status))) return null
  return {
    status: v.status as PayOutcome['status'],
    paymentId: v.payment_id,
    reason: typeof v.reason === 'string' ? v.reason : null,
    heldId: typeof v.held_id === 'string' ? v.held_id : null,
  }
}
