/**
 * GET /api/stellar/tx/:hash: one Stellar transaction, fetched and decoded into the evidence it
 * carries. Public, read-only, signs nothing.
 *
 * The proof pages publish hashes, and a hash is only evidence if a reader can see what it
 * proves without decoding XDR by hand: who paid the fee, which contract function ran with
 * which arguments, whether it succeeded or which typed error refused it, and who authorized
 * it, down to the WebAuthn flags and origin when a passkey signed. Every decision lives in
 * ../chains/stellar/tx-evidence.ts, where it is tested against committed real transactions;
 * this file validates the request, calls it, and picks a status code.
 *
 * The network is never guessed. Testnet and pubnet hashes are the same shape and a hash looked
 * up on the wrong network is simply not found, which would read as "this never happened".
 *
 * A transaction in a ledger never changes, so a found answer is cached for the life of the
 * process. A not-found answer is not cached, because a transaction submitted a moment ago may
 * be in the next ledger.
 */
import { CHAINS, addressUrl, isContractId, txUrl } from '../chains/index.js'
import type { ChainDescriptor } from '../chains/types.js'
// Direct, like stellar-vault-routes.ts reaches into the Stellar adapter: the evidence decoder
// is Stellar-only and is not part of the chains barrel.
import { fetchTxEvidence, type FetchTxResult, type HttpFetch } from '../chains/stellar/tx-evidence.js'
import { sendJson, type RouteCtx } from './shared.js'

const PATH = /^\/api\/stellar\/tx\/([^/]+)$/

/** A Stellar chain by registry id or CAIP-2, or null. */
function stellarChain(want: string | null): ChainDescriptor | null {
  if (!want || !want.trim()) return null
  const key = want.trim()
  return CHAINS.find((c) => c.ecosystem === 'stellar' && (c.id === key || c.caip2 === key)) ?? null
}

/** Found answers only, bounded so an open endpoint cannot grow memory without limit. */
const CACHE_MAX = 256
const cache = new Map<string, Extract<FetchTxResult, { ok: true }>>()

/** TEST ONLY: forget every cached answer. */
export function __clearStellarEvidenceCacheForTests(): void {
  cache.clear()
}

export type StellarEvidenceDeps = { fetch?: HttpFetch; env?: NodeJS.ProcessEnv; retryDelayMs?: number }

/** The JSON body for a found transaction, with every link derived from the registry. */
function view(chain: ChainDescriptor, r: Extract<FetchTxResult, { ok: true }>) {
  const { record, evidence } = r
  const contracts: Record<string, string> = {}
  for (const op of evidence.operations) if (op.contract) contracts[op.contract] = addressUrl(chain, op.contract)
  for (const a of evidence.auth) {
    if (a.rootInvocation.contract) contracts[a.rootInvocation.contract] = addressUrl(chain, a.rootInvocation.contract)
    if (isContractId(a.address)) contracts[a.address] = addressUrl(chain, a.address)
  }
  return {
    network: chain.caip2,
    chainId: chain.id,
    realMoney: !chain.testnet,
    hash: evidence.hash,
    innerHash: evidence.innerHash,
    ledger: record.ledger,
    createdAt: record.createdAt,
    status: evidence.status,
    resultCode: evidence.resultCode,
    sourceAccount: evidence.sourceAccount,
    feeAccount: evidence.feeAccount,
    feeBump: evidence.feeBump,
    feeChargedStroops: evidence.feeChargedStroops,
    operations: evidence.operations,
    auth: evidence.auth,
    summary: evidence.summary,
    caveats: evidence.caveats,
    fetchedFrom: record.fetchedFrom,
    metaFrom: record.metaFrom,
    metaNote: record.metaNote,
    xdr: { envelope: record.envelopeXdr, result: record.resultXdr },
    explorer: {
      tx: txUrl(chain, evidence.hash),
      sourceAccount: addressUrl(chain, evidence.sourceAccount),
      feeAccount: addressUrl(chain, evidence.feeAccount),
      contracts,
    },
    readAt: new Date().toISOString(),
    note:
      'Decoded from the ledger\'s own envelope and result XDR, read live from Soroban RPC or, past RPC\'s ' +
      'retention of about a week, from Horizon. Signer kinds are named from the OpenZeppelin verifier ' +
      'addresses the registry records for this network. Nothing here is a signature of ours.',
  }
}

export function createStellarEvidenceRoutes(deps: StellarEvidenceDeps = {}) {
  return async function handleStellarEvidenceRoutes(ctx: RouteCtx): Promise<boolean> {
    const { req, res, url } = ctx
    if (req.method !== 'GET') return false
    const m = PATH.exec(url.pathname)
    if (!m) return false

    const chain = stellarChain(url.searchParams.get('network'))
    if (!chain) {
      const names = CHAINS.filter((c) => c.ecosystem === 'stellar').map((c) => `${c.id} (${c.caip2})`)
      sendJson(res, 400, { error: 'bad_request', reason: `network must name a Stellar chain: ${names.join(' or ')}. It is never guessed.` })
      return true
    }
    let hash: string
    try {
      hash = decodeURIComponent(m[1] as string).trim().toLowerCase()
    } catch {
      hash = ''
    }
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      sendJson(res, 400, { error: 'bad_request', reason: 'the hash must be 64 hex characters' })
      return true
    }

    const key = `${chain.caip2}:${hash}`
    const hit = cache.get(key)
    if (hit) {
      sendJson(res, 200, view(chain, hit))
      return true
    }

    const r = await fetchTxEvidence(chain, hash, { fetch: deps.fetch, env: deps.env, retryDelayMs: deps.retryDelayMs })
    if (r.ok) {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, r)
      sendJson(res, 200, view(chain, r))
      return true
    }
    const tried = r.tried.map((t) => ({ source: t.source, host: t.host, outcome: t.outcome }))
    if (r.code === 'bad_request') sendJson(res, 400, { error: 'bad_request', reason: r.reason })
    else if (r.code === 'not_found') sendJson(res, 404, { error: 'not_found', reason: r.reason, network: chain.caip2, tried })
    else sendJson(res, 502, { error: 'read_failed', reason: r.reason, network: chain.caip2, tried, at: new Date().toISOString() })
    return true
  }
}

export const handleStellarEvidenceRoutes = createStellarEvidenceRoutes()
