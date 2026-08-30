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
  // Both agent-creation doors, not just the one: /api/agents is the console's and
  // /api/v1/agents/register is the external self-register. They write the same row, so
  // budgeting only the first would move the spam one path over rather than stop it.
  if (pathname === '/api/agents' || pathname === '/api/v1/agents/register')
    return { bucket: 'agent-create', max: 10, windowMs: 60_000 }
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
