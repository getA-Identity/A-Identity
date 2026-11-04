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
 * An address needs a record that proved control of it, the same reading risk_check gives it
 * (recordAtAddress in mcp/src/platform/agents.ts): a registration can name anyone's wallet. This
 * read carries the KYA status and not the proof, so a revoked record is taken at its word here
 * and the paid check is the one that decides. Pure and import-free: the backend suite runs it.
 */
export type RecordRead = 'record' | 'no-record' | 'unreadable'

type RepAnswer<T> = { ok: true; data: { found: boolean; reputation?: T } } | { ok: false; error: string }

export function readRecord<T extends { basis?: string; kya?: string }>(res: RepAnswer<T>, query: string): { read: RecordRead; reputation: T | null } {
  if (!res.ok) return { read: 'unreadable', reputation: null }
  const rep = res.data.found ? (res.data.reputation ?? null) : null
  if (!rep || rep.basis?.startsWith('onchain-identity')) return { read: 'no-record', reputation: null }
  if (/^0x[0-9a-fA-F]{40}$/.test(query.trim()) && rep.kya !== 'verified' && rep.kya !== 'revoked') return { read: 'no-record', reputation: null }
  return { read: 'record', reputation: rep }
}
