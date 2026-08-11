/**
 * Live on-chain stats for the ASP. Reads payTo's current USD₮0 balance on X Layer
 * mainnet - since payTo only ever receives from our ASP, this is the live cumulative
 * revenue. Raw JSON-RPC eth_call, timeout-guarded, no extra deps, never throws.
 * Served at GET /stats and fetched by the /proof page so the number reads "live".
 */
const RPC = process.env.XLAYER_RPC_URL ?? 'https://rpc.xlayer.tech'
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736'
// Read the balance of the address the OKX middleware actually settles to (PAY_TO_ADDRESS),
// so "live revenue" can never point at a stale hardcoded wallet on a different deploy.
//
// There is deliberately NO fallback address. The previous default became unspendable when its
// key was lost, so a missing env var would have silently reported a balance nobody can reach.
// An empty string reads as unconfigured, which is the honest answer to a missing recipient.
const PAY_TO = (process.env.PAY_TO_ADDRESS ?? '').toLowerCase()

export type LiveStats = {
  network: string
  payTo: string
  asset: string
  /** Live cumulative USD₮0 held at payTo (all of it received from ASP calls); null if the read fails. */
  payToReceivedUsdt0: number | null
  checkedAt: string
}

// Short in-memory cache: /stats is public and does an on-chain read, so cache the
// result briefly to keep the endpoint fast and avoid hammering the RPC under repeated
// (or hostile) traffic. Correct for a single instance; a scaled deploy would share it.
let cache: { at: number; value: LiveStats } | null = null
const CACHE_TTL_MS = 45_000

export async function getLiveStats(): Promise<LiveStats> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  const base = {
    network: 'X Layer mainnet (eip155:196)',
    payTo: PAY_TO,
    asset: 'USD₮0',
    checkedAt: new Date().toISOString(),
  }
  // No recipient configured: say so instead of building a malformed balanceOf call and
  // letting the RPC error fall into the catch below, which would report the same null for
  // "not configured" and "the read failed". Those are different facts.
  if (!PAY_TO) {
    const value = { ...base, payToReceivedUsdt0: null }
    cache = { at: Date.now(), value }
    return value
  }
  try {
    // balanceOf(payTo): selector 0x70a08231 + 32-byte left-padded address.
    const data = '0x70a08231' + '0'.repeat(24) + PAY_TO.slice(2).toLowerCase()
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDT0, data }, 'latest'] }),
      signal: AbortSignal.timeout(5000),
    })
    const j = (await res.json()) as { result?: string }
    const raw = BigInt(j.result ?? '0x0')
    const value = { ...base, payToReceivedUsdt0: Number(raw) / 1_000_000 }
    cache = { at: Date.now(), value }
    return value
  } catch {
    const value = { ...base, payToReceivedUsdt0: null }
    cache = { at: Date.now(), value }
    return value
  }
}
