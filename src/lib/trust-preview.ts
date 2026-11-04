/**
 * What a free reputation read says about the platform record behind a preview verdict.
 *
 * The site reads the get_reputation MCP tool, and a found:true there is not a platform record: an
 * identity with no record answers with an identity-only score (mcp/src/server.ts). Three answers,
 * because they mean three different things to the person reading the page:
 *
 *   - record: we hold a record that speaks for this query.
 *   - no-record: we looked and hold none, so we do not know how it has behaved.
 *   - unreadable: the read failed. Nothing was learned, and it must not read as no-record: for a
 *     revoked agent, "no record" would be a false and reassuring thing to show.
 *
 * An address speaks only for a record that proved control of it, the same reading risk_check gives
 * it: reputationForQuery in mcp/src/platform/agents.ts answers an address that way, so a registration
 * that merely names a wallet comes back as no answer, revoked or not. Pure and import-free: the
 * backend suite runs it.
 */
export type RecordRead = 'record' | 'no-record' | 'unreadable'

type RepAnswer<T> = { ok: true; data: { found: boolean; reputation?: T } } | { ok: false; error: string }

export function readRecord<T extends { basis?: string }>(res: RepAnswer<T>): { read: RecordRead; reputation: T | null } {
  if (!res.ok) return { read: 'unreadable', reputation: null }
  const rep = res.data.found ? (res.data.reputation ?? null) : null
  if (!rep || rep.basis?.startsWith('onchain-identity')) return { read: 'no-record', reputation: null }
  return { read: 'record', reputation: rep }
}

/** What the reputation answer says the record holds against the agent, where it says it. */
export type AdverseEcho = {
  behavioral?: { contestedEvidence?: unknown } | null
  discipline?: { rejectedSettlements?: unknown; overrideAttempts?: unknown } | null
}

/**
 * The evidence asp/risk.ts counts, read from what the answer really carries: contested jobs,
 * rejected settlements and guardrail override attempts. Null when it does not carry all three and
 * none is already positive, because nothing seen is not nothing held.
 */
export function adverseRecordOf(rep: AdverseEcho | null | undefined): boolean | null {
  const inputs = [rep?.behavioral?.contestedEvidence, rep?.discipline?.rejectedSettlements, rep?.discipline?.overrideAttempts]
  if (inputs.some((n) => typeof n === 'number' && n > 0)) return true
  return inputs.every((n) => typeof n === 'number') ? false : null
}

export type PreviewVerdict = 'ALLOW' | 'WARN' | 'DENY'

/**
 * asp/risk.ts's line, for a preview at no particular amount. DENY means we hold evidence against the
 * agent, so a low score alone is not one. Null means no verdict, and it means one of two things: the
 * read failed, or the score is low and the read does not show what the record holds. A preview does
 * not invent a verdict from what it cannot see: this page previews, and the paid verdict is the one
 * anybody acts on.
 */
export function previewVerdict(s: {
  score: number
  kya?: string
  verified: boolean
  sybil?: string
  read: RecordRead
  adverseRecord: boolean | null
}): PreviewVerdict | null {
  if (s.read === 'unreadable') return null
  if (s.kya === 'revoked' || s.sybil === 'high') return 'DENY'
  if (s.read === 'no-record') return 'WARN'
  if (s.score < 200) return s.adverseRecord === null ? null : s.adverseRecord ? 'DENY' : 'WARN'
  if (!s.verified || s.kya !== 'verified' || s.score < 500 || s.sybil === 'medium') return 'WARN'
  return 'ALLOW'
}

/**
 * The same line for a roster row, which carries a score and a KYA status and nothing about what the
 * record holds or its Sybil flag. Under 200 it cannot tell WARN from DENY, so it says neither.
 */
export function rosterVerdict(score: number, kya?: string): PreviewVerdict | null {
  if (kya === 'revoked') return 'DENY'
  if (score < 200) return null
  return score < 500 ? 'WARN' : 'ALLOW'
}

/** What the page says when it gives no verdict and the read did not fail. */
export const NO_VERDICT_NOTE = 'This read does not show what our record holds against this agent, so this page gives no verdict on its low score. The paid check decides, and do not pay on this.'
