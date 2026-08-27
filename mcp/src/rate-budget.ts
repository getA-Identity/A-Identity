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
