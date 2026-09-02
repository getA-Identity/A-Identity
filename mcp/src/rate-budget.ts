/**
 * Which POSTs are rate limited, and how hard.
 *
 * Its own module so a test can read it without importing http.ts, which boots a server on
 * import. That is not a detail: the reason this rule went unchecked for so long is that
 * nothing could look at it cheaply.
 */
/** Per-path rate budget, or null when the path isn't limited. */
export function rateBudget(method: string, pathname: string): { bucket: string; max: number; windowMs: number } | null {
  if (method !== 'POST') return null
  // Auth challenges + guest login: cheap to abuse, keep them tight.
  if (pathname === '/api/auth/nonce' || pathname === '/api/auth/verify' || pathname === '/api/auth/login')
    return { bucket: 'auth', max: 20, windowMs: 60_000 }
  // Passwordless email: sends a real email, so limit hardest.
  if (pathname === '/api/auth/magic/request') return { bucket: 'magic', max: 5, windowMs: 60_000 }
  // Expensive on-chain demo runs (each spends gas / moves real testnet value).
  if (pathname === '/api/arc/agent-run' || (pathname.startsWith('/api/arc/') && pathname.endsWith('-demo')))
    return { bucket: 'demo', max: 8, windowMs: 60_000 }
  // Marketplace release/dispute run a real ERC-8183 escrow lifecycle from the shared signer.
  if (pathname === '/api/marketplace/release' || pathname === '/api/marketplace/dispute')
    return { bucket: 'demo', max: 8, windowMs: 60_000 }
  // Deploying a vault is the single most expensive write this server makes: a whole
  // contract, not a call. Its own bucket, and a tighter one, because a burst of these
  // drains the signer faster than anything else here and each one is permanent.
  if (pathname === '/api/agents/vault') return { bucket: 'vault-deploy', max: 3, windowMs: 60_000 }
  // Every other POST that broadcasts from the shared signer.
  //
  // The reason was already written down two lines up, for release and dispute, and then
  // applied to exactly those two. These seven spend the same wallet in the same way: an
  // ERC-8004 anchor, a ValidationRegistry KYA write and its revocation, an on-chain
  // register, the ERC-8183 job lifecycle, and executeInstruction, which settles real money.
  // The daily cap bounds what an instruction may MOVE; nothing bounded how many broadcasts
  // could be triggered, and gas is spent whether or not the value is small.
  if (
    pathname === '/api/agents/anchor' ||
    pathname === '/api/agents/kya/verify' ||
    pathname === '/api/agents/kya/revoke' ||
    pathname === '/api/arc/register-onchain' ||
    pathname === '/api/arc/create-job' ||
    pathname === '/api/arc/job/dispute' ||
    pathname === '/api/arc/job/claim-refund' ||
    pathname === '/api/instructions/execute' ||
    pathname === '/api/marketplace/hire' ||
    pathname === '/api/marketplace/accept-bid'
  )
    return { bucket: 'onchain-write', max: 10, windowMs: 60_000 }
  // Free writes that create DURABLE ROWS. No gas, which is exactly why they had no budget:
  // this file read "expensive" as "spends the shared signer", and writes that spend no gas
  // were a deliberate blind spot. That is the hole. A posted task, a bid and a registered
  // agent each append to the single state document that is serialized in full on every
  // save, and an open task is additionally a card every visitor to the board renders. A
  // script opening a task a second is free to the attacker and permanent to us.
  //
  // Per-IP, like every bucket here, so this bounds the BURST. The per-person bounds sit in
  // the domain (openTaskComplaint, agentQuotaComplaint) because a session is the thing a
  // person actually has one of; the two are complementary and neither replaces the other.
  //
  // Separate buckets, not one shared one: a burst of bids must not lock a client out of
  // posting their own work, and neither may lock anyone out of registering an agent.
  // Bidding is the most legitimately frequent of the three (a working agent bids on every
  // open task it can serve), so it gets the most room.
  if (pathname === '/api/marketplace/post-task') return { bucket: 'task-post', max: 5, windowMs: 60_000 }
  if (pathname === '/api/marketplace/bid') return { bucket: 'task-bid', max: 20, windowMs: 60_000 }
  // Rating an agent belongs in exactly this class and was the one member of it left
  // outside. It writes a durable row, and unlike a task or a bid it also feeds reputation:
  // agentReputation reads feedback into its behavior and discipline terms. Rated a few
  // times a minute is a person going through a shortlist; rated dozens of times a minute
  // is not a person. The per-rater bounds sit in the domain (feedbackComplaint), the same
  // division of labor post-task and bid already have with openTaskComplaint.
  if (pathname === '/api/marketplace/feedback') return { bucket: 'feedback', max: 6, windowMs: 60_000 }
  // Both agent-creation doors, not just the one: /api/agents is the console's and
  // /api/v1/agents/register is the external self-register. They write the same row, so
  // budgeting only the first would move the spam one path over rather than stop it.
  if (pathname === '/api/agents' || pathname === '/api/v1/agents/register')
    return { bucket: 'agent-create', max: 10, windowMs: 60_000 }
  // The bulk door. Its own REQUEST bucket, because one request here is up to
  // MAX_BATCH_REGISTER rows and counting it as one write against agent-create would be
  // nonsense in both directions: too tight for a caller sending one batch, far too loose
  // for a caller sending fifty. What actually bounds it is the ROW budget below, which the
  // single-agent doors charge too, so the batch cannot be a way around them.
  if (pathname === '/api/v1/agents/register/batch') return { bucket: 'agent-create-batch', max: 5, windowMs: 60_000 }
  // Celo x402 tool calls each cost the server two facilitator round-trips (verify+settle).
  if (pathname.startsWith('/api/celo/tools/')) return { bucket: 'celo', max: 30, windowMs: 60_000 }
  // On the self-facilitated rail WE broadcast, so each settle spends real gas from our
  // own wallet. That makes these the most abusable POSTs on the server: limit settle
  // hardest, tools next, and leave verify generous because it is read-only.
  if (pathname === '/api/facilitator/settle') return { bucket: 'settle', max: 6, windowMs: 60_000 }
  if (pathname === '/api/facilitator/verify') return { bucket: 'verify', max: 60, windowMs: 60_000 }
  // The Stellar rail spends OUR XLM per settle in exactly the same way, so it gets the
  // same shape of limit. Separate buckets, not shared ones: a burst on one chain must not
  // be able to lock a buyer out of the other.
  if (pathname === '/api/x402/stellar/facilitator/settle') return { bucket: 'stellar-settle', max: 6, windowMs: 60_000 }
  if (pathname === '/api/x402/stellar/facilitator/verify') return { bucket: 'stellar-verify', max: 60, windowMs: 60_000 }
  if (pathname.startsWith('/api/x402/stellar/tools/')) return { bucket: 'stellar-tools', max: 20, windowMs: 60_000 }
  if (pathname.startsWith('/api/x402/tools/')) return { bucket: 'x402tools', max: 20, windowMs: 60_000 }
  // MCP can also drive a release (release_escrow tool) which spends the shared signer, so cap
  // the whole /mcp endpoint. A backstop against escrow-release spam via MCP (a per-tool limit is
  // the finer follow-up); normal MCP usage stays well under it.
  if (pathname === '/mcp') return { bucket: 'mcp', max: 40, windowMs: 60_000 }
  return null
}

// ── volume budgets: what is counted is ROWS, not requests ───────────────────────────
//
// Everything above counts requests, which is the right unit exactly as long as one request
// writes one row. Bulk registration breaks that assumption: a single POST to
// /api/v1/agents/register/batch writes up to MAX_BATCH_REGISTER agents. Budgeting it per
// request would hand a caller fifty times the allowance the one-at-a-time door gives,
// which is not a batch endpoint, it is a documented way around the limit.
//
// So agent rows get a second budget counted in rows, charged by EVERY door that writes one
// (the console's /api/agents, the API's /api/v1/agents/register, and the batch). One
// ledger, so neither door is a route around the other.
//
// Keyed on the ACCOUNT rather than the address, because the ceiling this pairs with
// (agentQuotaComplaint) is per account, and a budget that disagreed with the ceiling about
// whose rows these are would be two rules pretending to be one. The per-IP request buckets
// above still bound the burst from a single address, so the two are complementary.
//
// Process-local, like the limiter in http.ts and for the same reason: a horizontally
// scaled deploy moves both to a shared store together.
const volumeBuckets = new Map<string, { count: number; resetAt: number }>()

/**
 * Agent rows one account may create per minute, by account tier.
 *
 * 'default' is 10, the same number the per-request agent-create bucket has always allowed,
 * so an ordinary account's real allowance is unchanged by any of this. 'operator' is the
 * tier a human grants by naming an account in an env allowlist (see accountTier in
 * marketplace.ts): the same decision that lets a fleet EXIST also lets it arrive in a
 * sane amount of time, because a ceiling of 2000 filled at 10 rows a minute is more than
 * three hours of uploading, which sends an operator straight back to opening extra
 * accounts. Nobody is in this tier until someone sets the variable.
 */
export const AGENT_CREATE_VOLUME: Record<string, { max: number; windowMs: number }> = {
  default: { max: 10, windowMs: 60_000 },
  operator: { max: 200, windowMs: 60_000 },
}

/** The row budget for a tier. An unknown tier gets the ordinary one, never the bigger one. */
export function agentCreateVolume(tier: string): { max: number; windowMs: number } {
  return AGENT_CREATE_VOLUME[tier] ?? AGENT_CREATE_VOLUME.default
}

/** What charging a row costs the caller: whether it fit, and when the window reopens. */
export type VolumeCharge = { ok: boolean; used: number; max: number; resetAt: number }

/**
 * Charge one row to a fixed-window volume bucket.
 *
 * Returns rather than throws, and reports `resetAt`, so a caller can always say the honest
 * thing: a 429 with a real Retry-After for a single write, or a named per-row refusal
 * inside a batch. Nothing here drops a row quietly.
 */
export function chargeVolume(key: string, max: number, windowMs: number, now = Date.now()): VolumeCharge {
  const b = volumeBuckets.get(key)
  if (!b || b.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs }
    volumeBuckets.set(key, fresh)
    return { ok: max >= 1, used: 1, max, resetAt: fresh.resetAt }
  }
  b.count += 1
  return { ok: b.count <= max, used: b.count, max, resetAt: b.resetAt }
}

/**
 * Charge one agent row to an account's budget, at its tier.
 *
 * The single helper all three registration doors call, so they cannot end up counting
 * differently. `tier` is a plain string on purpose: this module owns the numbers and
 * marketplace.ts owns who is in which tier, so neither has to import the other.
 */
export function chargeAgentCreate(account: string, tier: string, now = Date.now()): VolumeCharge {
  const { max, windowMs } = agentCreateVolume(tier)
  return chargeVolume(`agent-create:${account}`, max, windowMs, now)
}

// Drop expired volume buckets so the map cannot grow without bound, mirroring the sweep
// http.ts runs over its own. unref() so this timer never keeps a process alive on its own,
// which matters here because the tests import this module directly.
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of volumeBuckets) if (v.resetAt <= now) volumeBuckets.delete(k)
}, 5 * 60 * 1000).unref()
