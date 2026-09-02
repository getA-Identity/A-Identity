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

/**
 * The state that would have slipped through silently.
 *
 * `unclaimed` was added to the KYA union after `revoked` and `unverified` already had
 * branches here. A union grows without breaking anything in a ladder built from
 * equality checks, so the new state would have collected NO reason at all and rendered
 * as safer than an unverified agent, which is backwards: unverified at least belongs to
 * the account that made it. This test is what makes that a failure rather than a shrug.
 */
test('an unclaimed record warns, and says the owning party never spoke to us', () => {
  const r = computeMerchantVerdict({ ...healthy, kya: 'unclaimed' })
  assert.equal(r.verdict, 'WARN')
  assert.equal(r.reasons[0].code, 'kya_unclaimed')
  assert.equal(r.reasons[0].severity, 'warn')
  assert.match(r.reasons[0].detail, /never claimed it here/)
})

test('unclaimed is not quietly treated as unverified: the two carry different reasons', () => {
  const unclaimed = computeMerchantVerdict({ ...healthy, kya: 'unclaimed' })
  const unverified = computeMerchantVerdict({ ...healthy, kya: 'unverified' })
  assert.notEqual(unclaimed.reasons[0].code, unverified.reasons[0].code)
  assert.equal(unverified.reasons[0].code, 'kya_unverified')
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

/**
 * ERC-8004 renamed the agent card's `endpoints` field to `services` on 2026-01-25, and
 * cards in the wild carry either. Reading only the old name meant a merchant serving a
 * spec-current card looked like it declared no payment rail at all, so merchant_check
 * answered "no x402 here" about a merchant that does accept x402. Both names are read,
 * and a card carrying both must not report a rail twice.
 */
test('a card declaring its rails under the renamed `services` field is read, and so is the pre-spec `endpoints`', () => {
  // Spec-current: `services` only, no `endpoints` anywhere in the card.
  const current = parseAgentManifest({
    name: 'Spec-Current Storefront',
    registrations: [{ agentId: 7, agentAddress: 'eip155:99999:8004/7' }],
    services: [
      { name: 'checkout', endpoint: 'https://shop.example/x402/quote' },
      { name: 'tools', endpoint: 'https://shop.example/mcp' },
    ],
  })
  assert.ok(current)
  assert.deepEqual(current.rails, ['mcp', 'x402'], 'a `services` card must not read as offering no rail')

  // Pre-spec: `endpoints` only. Still in circulation, so it still has to work.
  const legacy = parseAgentManifest({
    name: 'Pre-Spec Storefront',
    endpoints: { mcp: 'https://legacy.example/mcp', pay: 'https://legacy.example/x402/quote' },
  })
  assert.ok(legacy)
  assert.deepEqual(legacy.rails, ['mcp', 'x402'])

  // Both names, same rails: the merge is a set, so nothing is listed twice.
  const both = parseAgentManifest({
    name: 'Transitional Storefront',
    services: [{ name: 'checkout', endpoint: 'https://shop.example/x402/quote' }],
    endpoints: { mcp: 'https://shop.example/mcp' },
  })
  assert.ok(both)
  assert.deepEqual(both.rails, ['mcp', 'x402'])
})

test('merchantCheck reports the rails of a spec-current card, so a paying agent is not told there is no x402', async () => {
  const card = {
    name: 'Spec-Current Storefront',
    registrations: [{ agentId: 7, agentAddress: 'eip155:99999:8004/7' }],
    services: [{ name: 'checkout', endpoint: 'https://shop.example/x402/quote' }],
  }
  const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => card })) as unknown as typeof fetch
  const r = await merchantCheck(
    { url: 'https://shop.example' },
    {
      fetchImpl: fakeFetch,
      resolveIdentity: async (q) =>
        q === 'eip155:99999:8004/7'
          ? { agentId: q, tokenId: 7, owner: '0x' + 'c'.repeat(40), registrationUri: '', domain: 'shop.example', valid: false, registeredAt: '2026-01-01', chain: 'arc' }
          : null,
      platformView: async () => ({
        agentId: 'agent_shop',
        name: 'Spec-Current Storefront',
        kya: 'verified',
        score: 760,
        settledOnchain: 4,
        sybil: { level: 'none' },
      }),
    },
  )
  assert.ok(!('error' in r), 'expected a verdict result')
  const v = r as Exclude<typeof r, { error: string }>
  assert.equal(v.manifest?.found, true)
  assert.deepEqual(v.manifest?.rails, ['x402'], 'the rail the card declares has to reach the answer, not just the parser')
  assert.equal(v.verdict, 'ALLOW')
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
