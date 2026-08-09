import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeMerchantVerdict,
  parseAgentManifest,
  reputationBand,
  merchantCheck,
  type MerchantSignals,
} from './commerce.js'

/**
 * Unit tests for the pure parts of the commerce merchant check: the verdict ladder,
 * the agent-card parser, and the orchestrator with injected deps - no network, no
 * platform state, no RPC (same idiom as reputation.test.ts: test the exact functions
 * production uses, offline).
 */

// A healthy baseline every ladder test perturbs one signal of.
const healthy: MerchantSignals = {
  identityFound: true,
  kya: 'verified',
  reputationScore: 800,
  sybil: 'none',
  manifest: { requested: true, found: true, unreachable: false },
}

test('revoked KYA forces DENY and is the deciding (first) reason', () => {
  const r = computeMerchantVerdict({ ...healthy, kya: 'revoked' })
  assert.equal(r.verdict, 'DENY')
  assert.equal(r.reasons[0].code, 'kya_revoked')
  assert.equal(r.reasons[0].severity, 'deny')
})

test('reputation below 200 is DENY', () => {
  const r = computeMerchantVerdict({ ...healthy, reputationScore: 150 })
  assert.equal(r.verdict, 'DENY')
  assert.ok(r.reasons.some((x) => x.code === 'low_reputation'))
})

test('reputation in [200, 500) is WARN, not DENY', () => {
  const r = computeMerchantVerdict({ ...healthy, reputationScore: 350 })
  assert.equal(r.verdict, 'WARN')
  assert.equal(r.reasons[0].code, 'moderate_reputation')
})

test('a healthy merchant (identity + attested KYA + strong reputation + card) is ALLOW', () => {
  const r = computeMerchantVerdict(healthy)
  assert.equal(r.verdict, 'ALLOW')
  assert.equal(r.reasons.length, 1)
  assert.equal(r.reasons[0].code, 'verified_merchant')
})

test('no on-chain identity is DENY - the documented default for an unverifiable merchant', () => {
  const r = computeMerchantVerdict({ ...healthy, identityFound: false, kya: null, reputationScore: null, sybil: null })
  assert.equal(r.verdict, 'DENY')
  assert.equal(r.reasons[0].code, 'no_onchain_identity')
})

test('sybil-high wash reputation is DENY; sybil-medium is only WARN', () => {
  assert.equal(computeMerchantVerdict({ ...healthy, sybil: 'high' }).verdict, 'DENY')
  const medium = computeMerchantVerdict({ ...healthy, sybil: 'medium' })
  assert.equal(medium.verdict, 'WARN')
  assert.ok(medium.reasons.some((x) => x.code === 'sybil_medium'))
})

test('an unreachable manifest is WARN with its own reason, never a crash', () => {
  const r = computeMerchantVerdict({ ...healthy, manifest: { requested: true, found: false, unreachable: true } })
  assert.equal(r.verdict, 'WARN')
  assert.equal(r.reasons[0].code, 'manifest_unreachable')
})

test('a reachable site with no agent card is WARN with manifest_not_found', () => {
  const r = computeMerchantVerdict({ ...healthy, manifest: { requested: true, found: false, unreachable: false } })
  assert.equal(r.verdict, 'WARN')
  assert.equal(r.reasons[0].code, 'manifest_not_found')
})

test('a verified identity the platform has no history for is WARN (no ALLOW on identity alone)', () => {
  const r = computeMerchantVerdict({ ...healthy, kya: null, reputationScore: null, sybil: null })
  assert.equal(r.verdict, 'WARN')
  assert.equal(r.reasons[0].code, 'no_platform_history')
})

test('every triggered reason is listed and the first decisive one leads', () => {
  const r = computeMerchantVerdict({
    identityFound: false,
    kya: 'revoked',
    reputationScore: 150,
    sybil: 'medium',
    manifest: { requested: true, found: false, unreachable: false },
  })
  assert.equal(r.verdict, 'DENY')
  assert.equal(r.reasons[0].code, 'kya_revoked')
  const codes = r.reasons.map((x) => x.code)
  for (const code of ['kya_revoked', 'no_onchain_identity', 'low_reputation', 'sybil_medium', 'manifest_not_found']) {
    assert.ok(codes.includes(code), `missing reason ${code} in ${codes.join(',')}`)
  }
})

test('reputationBand maps the methodology thresholds exactly (200 / 500 boundaries)', () => {
  assert.equal(reputationBand(199), 'low')
  assert.equal(reputationBand(200), 'moderate')
  assert.equal(reputationBand(499), 'moderate')
  assert.equal(reputationBand(500), 'strong')
})

test('parseAgentManifest extracts name, ERC-8004 registrations, rails and interfaces from an agent card', () => {
  const parsed = parseAgentManifest({
    name: 'Acme Storefront Agent',
    registrations: [{ agentId: 42, agentAddress: 'eip155:99999:8004/42', chainId: 99999 }],
    supportedInterfaces: ['a2a', { transport: 'jsonrpc' }],
    endpoints: { mcp: 'https://acme.example/mcp', pay: 'https://acme.example/x402/quote' },
  })
  assert.ok(parsed)
  assert.equal(parsed.name, 'Acme Storefront Agent')
  assert.deepEqual(parsed.registrations, [{ caip: 'eip155:99999:8004/42', agentId: '42', chain: '99999' }])
  assert.deepEqual(parsed.rails, ['mcp', 'x402'])
  assert.deepEqual(parsed.interfaces, ['a2a', 'jsonrpc'])
})

test('parseAgentManifest reads the A-Identity AMP manifest shape; a non-object is null', () => {
  const parsed = parseAgentManifest({
    protocol: 'a-identity/amp',
    agent: { name: 'Meridian', erc8004: 'eip155:99999:8004/7' },
    amp: { execute: 'x402 / nanopayments per call' },
  })
  assert.ok(parsed)
  assert.equal(parsed.name, 'Meridian')
  assert.deepEqual(parsed.registrations, [{ caip: 'eip155:99999:8004/7' }])
  assert.ok(parsed.rails.includes('amp') && parsed.rails.includes('x402'))
  assert.equal(parseAgentManifest('just a string'), null)
  assert.equal(parseAgentManifest(null), null)
})

test('merchantCheck requires a url or an agentId - a clean error, not a verdict', async () => {
  const r = await merchantCheck({})
  assert.ok('error' in r, 'expected an error result')
  assert.match((r as { error: string }).error, /url and\/or an agentId/)
})

test('merchantCheck refuses an SSRF-rejected url cleanly and never fetches it', async () => {
  let fetched = 0
  const spyFetch = (async () => {
    fetched += 1
    throw new Error('must not be called')
  }) as unknown as typeof fetch
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://localhost:3399/x', 'ftp://example.com/card']) {
    const r = await merchantCheck({ url }, { fetchImpl: spyFetch })
    assert.ok('error' in r, `expected a clean error for ${url}`)
  }
  assert.equal(fetched, 0, 'the SSRF guard must run before any fetch')
})

test('merchantCheck end-to-end with injected deps: 404s tolerated, identity resolved from the card, platform view applied', async () => {
  const card = {
    name: 'Acme Storefront Agent',
    registrations: [{ agentId: 42, agentAddress: 'eip155:99999:8004/42' }],
  }
  const fakeFetch = (async (input: string | URL) => {
    const href = String(input)
    if (href.endsWith('/.well-known/agent.json')) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => card }
  }) as unknown as typeof fetch
  const r = await merchantCheck(
    { url: 'merchant.example' }, // bare domain: normalized to https://
    {
      fetchImpl: fakeFetch,
      resolveIdentity: async (q) =>
        q === 'eip155:99999:8004/42'
          ? { agentId: q, tokenId: 42, owner: '0x' + 'a'.repeat(40), registrationUri: '', domain: 'merchant.example', valid: false, registeredAt: '2026-01-01', chain: 'arc' }
          : null,
      platformView: async () => ({
        agentId: 'agent_acme',
        name: 'Acme Storefront Agent',
        kya: 'verified',
        score: 812,
        settledOnchain: 12,
        sybil: { level: 'none' },
      }),
    },
  )
  assert.ok(!('error' in r), 'expected a verdict result')
  const v = r as Exclude<typeof r, { error: string }>
  assert.equal(v.verdict, 'ALLOW')
  assert.equal(v.identity?.tokenId, 42)
  assert.equal(v.manifest?.found, true)
  assert.match(v.manifest?.url ?? '', /agent-card\.json$/)
  assert.equal(v.reputation?.band, 'strong')
  assert.equal(v.reputation?.kya, 'verified')
  assert.ok(!Number.isNaN(Date.parse(v.checkedAt)), 'checkedAt must be a parseable timestamp')
})

test('merchantCheck treats a 200 that is not JSON (SPA catch-all page) as no card, not a crash', async () => {
  const htmlFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    },
  })) as unknown as typeof fetch
  const r = await merchantCheck(
    { url: 'https://spa.example', agentId: 'eip155:99999:8004/9' },
    {
      fetchImpl: htmlFetch,
      resolveIdentity: async (q) =>
        q === 'eip155:99999:8004/9'
          ? { agentId: q, tokenId: 9, owner: '0x' + 'b'.repeat(40), registrationUri: '', domain: '', valid: false, registeredAt: '2026-01-01', chain: 'arc' }
          : null,
      platformView: async () => null,
    },
  )
  assert.ok(!('error' in r))
  const v = r as Exclude<typeof r, { error: string }>
  assert.equal(v.manifest?.found, false)
  assert.equal(v.manifest?.unreachable, false)
  assert.equal(v.verdict, 'WARN')
  const codes = v.reasons.map((x) => x.code)
  assert.ok(codes.includes('manifest_not_found') && codes.includes('no_platform_history'), codes.join(','))
})
