/**
 * The six paid Algorand services as the /check page sells them: the live price list, what
 * each one is sent, and how each paid answer is read back. Pure functions only, so a Node
 * script can check them against the backend the page talks to.
 *
 * Nothing here decides a verdict. The backend computes every answer; these readers only
 * check that a 200 body has the shape the page is about to show, and anything off-shape is
 * treated as "paid, but the answer could not be shown" rather than guessed at.
 */
import { readReport, type PaidReport, type PaidTool } from './x402pay'

// ---- prices ----

export type Prices = {
  pay_check: number
  verify_agent: number
  reputation_score: number
  risk_check: number
  agent_passport: number
  batch: { perAgentUsd: number; maxAgents: number }
}

const usd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10_000 ? v : null)

/**
 * The live price list out of GET /api/x402/algorand/status (challenge.prices), or null when
 * the rail is not configured or any price is missing. A partial list is no list: every Pay
 * button shows a price that the 402 is then checked against, so none may be made up.
 */
export function readPrices(status: unknown): Prices | null {
  const s = status as { configured?: unknown; challenge?: { prices?: Record<string, unknown> } } | null
  if (!s || s.configured !== true) return null
  const p = s.challenge?.prices
  if (!p || typeof p !== 'object') return null
  const b = (p.agent_batch_audit ?? null) as { perAgentUsd?: unknown; maxAgents?: unknown } | null
  const out = {
    pay_check: usd(p.pay_check),
    verify_agent: usd(p.verify_agent),
    reputation_score: usd(p.reputation_score),
    risk_check: usd(p.risk_check),
    agent_passport: usd(p.agent_passport),
    perAgentUsd: usd(b?.perAgentUsd),
    maxAgents: typeof b?.maxAgents === 'number' && Number.isInteger(b.maxAgents) && b.maxAgents >= 1 ? b.maxAgents : null,
  }
  if (Object.values(out).some((v) => v === null)) return null
  return {
    pay_check: out.pay_check!,
    verify_agent: out.verify_agent!,
    reputation_score: out.reputation_score!,
    risk_check: out.risk_check!,
    agent_passport: out.agent_passport!,
    batch: { perAgentUsd: out.perAgentUsd!, maxAgents: out.maxAgents! },
  }
}

/** A batch costs the per-agent price times the distinct agents it names, as the backend quotes it. */
export const batchUsd = (perAgentUsd: number, count: number) => Math.round(perAgentUsd * count * 1e6) / 1e6

// ---- inputs ----

/** What one call is sent. The body string is also the call's identity: same body, same question. */
export type ServiceInput =
  | { tool: 'pay_check'; address: string }
  | { tool: 'verify_agent' | 'reputation_score' | 'agent_passport'; agentId: string }
  | { tool: 'risk_check'; agentId: string; amountUsd: number | null }
  | { tool: 'agent_batch_audit'; agentIds: string[] }

export function bodyFor(input: ServiceInput): string {
  switch (input.tool) {
    case 'pay_check':
      return JSON.stringify({ address: input.address })
    case 'risk_check':
      return JSON.stringify(input.amountUsd === null ? { agentId: input.agentId } : { agentId: input.agentId, txContext: { amountUsd: input.amountUsd } })
    case 'agent_batch_audit':
      return JSON.stringify({ agentIds: input.agentIds })
    default:
      return JSON.stringify({ agentId: input.agentId })
  }
}

/** A short label for the question an answer belongs to: the id, the address, or the list size. */
export function labelFor(input: ServiceInput): string {
  switch (input.tool) {
    case 'pay_check':
      return input.address
    case 'agent_batch_audit':
      return input.agentIds.length === 1 ? '1 agent' : `${input.agentIds.length} agents`
    case 'risk_check':
      return input.amountUsd === null ? input.agentId : `${input.agentId}, $${input.amountUsd.toLocaleString('en-US')} deal`
    default:
      return input.agentId
  }
}

/** The backend's own cap on one agent id (mcp/src/x402-algorand/batch.ts). */
export const MAX_ID_LENGTH = 200

/** Parsed field: a value, nothing typed yet (problem null), or a sentence saying what is wrong. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string | null }

/** One agent id: "#0", a CAIP id, a 0x owner address, or a platform id. One token, no spaces. */
export function readAgentId(raw: string): Parsed<string> {
  const id = raw.trim()
  if (!id) return { ok: false, problem: null }
  if (/\s/.test(id)) return { ok: false, problem: 'Enter one agent id, like #0.' }
  if (id.length > MAX_ID_LENGTH) return { ok: false, problem: 'That agent id is too long.' }
  return { ok: true, value: id }
}

/**
 * A list of agent ids, one per line or separated by commas or spaces. Trimmed and
 * de-duplicated in order, the way the backend counts them, so the price shown is the price
 * the 402 quotes.
 */
export function readAgentIds(raw: string, max: number): { ids: string[]; problem: string | null } {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[\s,]+/)) {
    const id = part.trim()
    if (!id || seen.has(id)) continue
    if (id.length > MAX_ID_LENGTH) return { ids, problem: 'One of those agent ids is too long.' }
    seen.add(id)
    ids.push(id)
  }
  if (ids.length > max) return { ids, problem: `One check covers at most ${max} agents. This list has ${ids.length}.` }
  return { ids, problem: null }
}

/** The optional deal size for risk_check, in dollars. Empty means "not given". */
export function readDealSize(raw: string): Parsed<number | null> {
  const t = raw.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!t) return { ok: true, value: null }
  const v = Number(t)
  if (!/^[0-9]+(\.[0-9]+)?$/.test(t) || !Number.isFinite(v) || v > 1e12) return { ok: false, problem: 'Enter the deal size as a number, like 25.' }
  return { ok: true, value: v }
}

const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/

/** The same rule the backend's hostOf applies to a service link. */
function isServiceLink(raw: string): boolean {
  if (!raw || /\s/.test(raw)) return false
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname.toLowerCase().replace(/^www\./, ''))
  } catch {
    return false
  }
}

/** What pay_check is sent: an Algorand address, or the link of an x402 seller. */
export function readPayAddress(raw: string): Parsed<string> {
  const a = raw.trim()
  if (!a) return { ok: false, problem: null }
  if (ALGORAND_ADDRESS.test(a) || isServiceLink(a)) return { ok: true, value: a }
  return { ok: false, problem: 'Enter an Algorand address or a service link.' }
}

// ---- answers ----

export type Decision = 'ALLOW' | 'WARN' | 'DENY'
const DECISIONS: Decision[] = ['ALLOW', 'WARN', 'DENY']
const isDecision = (v: unknown): v is Decision => DECISIONS.includes(v as Decision)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

export type VerifyAnswer = { verified: boolean; kyaStatus: string; revoked: boolean }
export type ReputationAnswer = { score: number; name: string | null; breakdown: { key: string; value: number }[] }
export type RiskAnswer = { decision: Decision; reasons: string[]; amountUsd: number | null }
export type PassportAnswer = {
  decision: Decision
  reasons: string[]
  score: number | null
  kyaStatus: string | null
  verified: boolean
  name: string | null
}
export type BatchRow = { agentId: string; decision: Decision; reasons: string[] }
export type BatchAnswer = { summary: Record<Decision, number>; results: BatchRow[] }

export type Answer =
  | { tool: 'pay_check'; report: PaidReport }
  | { tool: 'verify_agent'; a: VerifyAnswer }
  | { tool: 'reputation_score'; a: ReputationAnswer }
  | { tool: 'risk_check'; a: RiskAnswer }
  | { tool: 'agent_passport'; a: PassportAnswer }
  | { tool: 'agent_batch_audit'; a: BatchAnswer }

/** The order the page names a score's parts in, each with its plain name. */
export const BREAKDOWN: { key: string; label: string }[] = [
  { key: 'settlement', label: 'payments' },
  { key: 'validation', label: 'clean record' },
  { key: 'tenure', label: 'time active' },
  { key: 'behavior', label: 'job outcomes' },
  { key: 'discipline', label: 'policy discipline' },
]

function readVerify(j: Record<string, unknown>): VerifyAnswer | null {
  if (typeof j.verified !== 'boolean' || typeof j.kya_status !== 'string') return null
  return { verified: j.verified, kyaStatus: j.kya_status, revoked: j.revoked === true }
}

function readReputation(j: Record<string, unknown>): ReputationAnswer | null {
  const score = num(j.score)
  if (score === null) return null
  const b = obj(j.breakdown) ?? {}
  const breakdown = BREAKDOWN.flatMap(({ key }) => (num(b[key]) === null ? [] : [{ key, value: num(b[key]) as number }]))
  return { score, name: text(j.name), breakdown }
}

function readRisk(j: Record<string, unknown>): RiskAnswer | null {
  if (!isDecision(j.decision) || !Array.isArray(j.reasons)) return null
  const tx = obj(obj(j.signals)?.txContext)
  return { decision: j.decision, reasons: strings(j.reasons), amountUsd: num(tx?.amountUsd) }
}

function readPassport(j: Record<string, unknown>): PassportAnswer | null {
  const risk = obj(j.risk)
  if (!risk || !isDecision(risk.decision) || typeof j.verified !== 'boolean') return null
  return {
    decision: risk.decision,
    reasons: strings(risk.reasons),
    score: num(obj(j.reputation)?.score),
    kyaStatus: text(obj(j.kya)?.status),
    verified: j.verified,
    name: text(j.name),
  }
}

function readBatch(j: Record<string, unknown>): BatchAnswer | null {
  if (!Array.isArray(j.results)) return null
  const results: BatchRow[] = []
  for (const r of j.results) {
    const row = obj(r)
    const id = text(row?.agentId)
    if (!row || !id || !isDecision(row.decision)) return null
    results.push({ agentId: id, decision: row.decision, reasons: strings(row.reasons) })
  }
  // Counted from the rows themselves, so the summary and the list can never disagree.
  const summary: Record<Decision, number> = { ALLOW: 0, WARN: 0, DENY: 0 }
  for (const r of results) summary[r.decision] += 1
  return { summary, results }
}

/** Read a paid 200 body as the answer the page shows for `tool`, or null when it is not one. */
export function readAnswer(tool: PaidTool, json: Record<string, unknown>): Answer | null {
  switch (tool) {
    case 'pay_check': {
      const report = readReport(json)
      return report ? { tool, report } : null
    }
    case 'verify_agent': {
      const a = readVerify(json)
      return a ? { tool, a } : null
    }
    case 'reputation_score': {
      const a = readReputation(json)
      return a ? { tool, a } : null
    }
    case 'risk_check': {
      const a = readRisk(json)
      return a ? { tool, a } : null
    }
    case 'agent_passport': {
      const a = readPassport(json)
      return a ? { tool, a } : null
    }
    case 'agent_batch_audit': {
      const a = readBatch(json)
      return a ? { tool, a } : null
    }
  }
}
