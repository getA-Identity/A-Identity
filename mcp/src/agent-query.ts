/**
 * What a query for an agent names, and the one reading of a free reputation answer.
 *
 * Every surface takes the same forms, and they used to read them differently: the paid verdict did
 * not match a CAIP id to a record at all, the MCP read neither, and the REST route took whatever
 * digits ended the string, so an address ending in chosen digits could borrow another agent's record.
 * Pure, with no platform state, so the stdio MCP entry can import it.
 *
 * The forms:
 *   - An address: 0x or 0X, bare or as a CAIP-10 account. An address is chain-agnostic here, because
 *     what a record proved is control of the address.
 *   - A token: "849980", "#849980", or eip155:<chain id>:8004/<id>. Only the last names a chain, and
 *     then only a record anchored on that chain answers: the same number on another chain is an
 *     unrelated agent.
 *   - Anything else is an opaque id. The digits it ends in mean nothing.
 */

/** The EVM address a query names, normalized to a lower-case 0x prefix, or null. */
export function addressInQuery(query: string): string | null {
  const m = query.trim().match(/^(?:eip155:\d+:)?0x([0-9a-fA-F]{40})$/i)
  return m ? `0x${m[1]}` : null
}

/** The token a query names, or null. chainId is null when the query does not say which chain. */
export function tokenInQuery(query: string): { tokenId: string; chainId: number | null } | null {
  const q = query.trim()
  const caip = q.match(/^eip155:(\d+):8004\/(\d{1,78})$/i)
  if (caip) return { tokenId: caip[2], chainId: Number(caip[1]) }
  const bare = q.match(/^#?(\d{1,78})$/)
  return bare ? { tokenId: bare[1], chainId: null } : null
}

/** A platform id, or a token anchored on a record: what names a record without any on-chain read. */
export function recordNamedBy<T extends { id: string; onchainAgentId?: string; chainId?: number }>(agents: T[], query: string): T | null {
  const q = query.trim()
  const byId = agents.find((a) => a.id === q)
  if (byId) return byId
  const token = tokenInQuery(q)
  if (!token) return null
  return agents.find((a) => a.onchainAgentId === token.tokenId && (token.chainId === null || a.chainId === token.chainId)) ?? null
}

type IdentityRead = { partial?: boolean; owner?: string } | null

export type ReputationAnswer<R> =
  /** A record speaks for this query. */
  | { kind: 'record'; reputation: R }
  /** An identity exists and we looked: we hold no record of it. */
  | { kind: 'identity-only'; partial: boolean }
  /** No identity and no record. lookedUp false: nothing was looked up, so this is not "no record". */
  | { kind: 'none'; lookedUp: boolean }

/**
 * The free read behind get_reputation and /api/reputation, so the two cannot disagree. It reaches
 * the same record risk_check does: the record this query names, else the record that proved the
 * address owning its token. An address is the one form looked up in full, so only there is finding
 * nothing a finding. A token read that failed and a made-up string looked up nothing, and saying
 * "no record" there would be a false and reassuring answer about a record that may be revoked.
 */
export async function readReputationAnswer<R>(
  query: string,
  getReputation: (q: string) => unknown,
  resolveIdentity: (q: string) => Promise<IdentityRead>,
): Promise<ReputationAnswer<R>> {
  const isAnswer = (r: unknown): r is R => Boolean(r) && !(typeof r === 'object' && 'error' in (r as object))
  const direct = getReputation(query)
  if (isAnswer(direct)) return { kind: 'record', reputation: direct }
  const identity = await resolveIdentity(query).catch(() => null)
  if (identity && !identity.partial && identity.owner) {
    const viaOwner = getReputation(identity.owner)
    if (isAnswer(viaOwner)) return { kind: 'record', reputation: viaOwner }
  }
  if (identity) return { kind: 'identity-only', partial: identity.partial === true }
  return { kind: 'none', lookedUp: addressInQuery(query) !== null }
}
