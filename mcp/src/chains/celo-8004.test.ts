import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData } from 'viem'
import {
  CELO_8004_FILE,
  CELO_8004_URI,
  SET_AGENT_URI_ABI,
  aigoraRegistrationIssues,
  aigoraX402ChallengeIssues,
  x402PricedWebEndpoints,
  celoAgentId,
  celoAgentRegistry,
  celoChain,
  setAgentUriCall,
} from './celo-8004.js'
import { provenanceFor } from './provenance.js'
import { isRetired } from './retired.js'

/** Compiled to dist/chains/, so the repo root is three levels up. */
const repo = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')
const published = () => JSON.parse(repo(CELO_8004_FILE)) as Record<string, unknown>

const VALID = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Example agent',
  description: 'An example agent whose description is comfortably longer than fifty characters.',
  services: [{ name: 'MCP', endpoint: 'https://example.com/mcp', version: '2025-06-18' }],
  onAigora: true,
}

test('the published Celo registration passes every Aigora blocking rule', () => {
  assert.deepEqual(aigoraRegistrationIssues(published()), [])
})

test('the Celo registration lists on Aigora as ours, and names our agent on the registry the chain registry holds', () => {
  const doc = published()
  assert.equal(doc.onAigora, true)
  assert.equal(doc.via, 'a-identity')
  assert.equal(doc.active, true)
  assert.deepEqual(doc.registrations, [{ agentId: Number(celoAgentId()), agentRegistry: celoAgentRegistry() }])
  assert.equal(celoAgentId(), '9759')
})

test('the Celo registration claims x402 only through priced web rows that are our Celo x402 routes', () => {
  // Aigora preflights every priced web row of a document that claims x402. On 2026-11-19 our
  // Celo tool routes failed it (400 to an unsigned POST, CORS for our own origin only); on
  // 2026-11-22 risk_check passed every rule in aigoraX402ChallengeIssues, read live by
  // scripts/celo-8004-aigora.mjs. A browser page with a price would fail it, so the only priced
  // web rows are tool routes, and the live run of that script is what backs the claim.
  const doc = published()
  assert.equal(doc.x402Support, true)
  const priced = x402PricedWebEndpoints(doc)
  assert.ok(priced.length > 0)
  for (const e of priced) assert.match(e, /^https:\/\/a-identity\.xyz\/api\/celo\/tools\/[a-z_]+$/)
  assert.ok(!priced.some((e) => e.endsWith('/check/celo')), 'the browser page must not carry a price')

  // The preflight judge, on the challenge risk_check served on 2026-11-22.
  const chain = celoChain()
  const owner = '0xcb8824ffaf30687e36374c08ec52298b62871bdf'
  const url = 'https://a-identity.xyz/api/celo/tools/risk_check'
  const requirement = {
    scheme: 'exact', network: chain.caip2, amount: '5000', asset: chain.contracts.usdc,
    payTo: owner, maxTimeoutSeconds: 600, extra: { name: 'USDC', version: '2' },
  }
  const challenge = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [{ ...requirement, ...over }], ...top })).toString('base64')
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })
  const options = { status: 204, headers: headers({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, PAYMENT-SIGNATURE' }) }
  const post = (pr: string, extra: Record<string, string> = {}) => ({
    status: 402,
    headers: headers({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE', 'payment-required': pr, ...extra }),
  })
  const judge = (p: { status: number; headers: ReturnType<typeof headers> }, o = options, wallet = owner) =>
    aigoraX402ChallengeIssues({ url, registeringWallet: wallet, options: o, post: p })

  assert.deepEqual(judge(post(challenge())), [])
  assert.deepEqual(judge(post(challenge()), options, '0x0000000000000000000000000000000000000001'), ['x402_payto_not_registrant'])
  assert.deepEqual(judge(post(challenge({ maxTimeoutSeconds: 601 }))), ['x402_timeout_too_long'])
  assert.deepEqual(judge(post(challenge({ maxAmountRequired: '5000' }))), ['x402_legacy_amount_field'])
  assert.deepEqual(judge(post(challenge({ scheme: 'upto' }))), ['x402_scheme_not_exact'])
  assert.deepEqual(judge(post(challenge({ extra: {} }))), ['x402_no_eip3009_domain'])
  assert.deepEqual(judge(post(challenge({ asset: '0x0000000000000000000000000000000000000002' }))), ['x402_asset_not_usdc'])
  assert.deepEqual(judge(post(challenge({}, { x402Version: 1 }))), ['x402_not_v2'])
  assert.deepEqual(judge(post(challenge({}, { resource: { url: 'https://a-identity.xyz/check/celo' } }))), ['x402_resource_mismatch'])
  assert.deepEqual(judge(post(challenge({ network: 'eip155:8453' }))), ['x402_no_celo_requirement'])
  assert.deepEqual(judge(post(challenge(), { 'access-control-expose-headers': '' })), ['x402_cors_response'])
  assert.deepEqual(judge(post('')), ['x402_challenge_missing'])
  // What /check/celo answered on 2026-11-22: a page, not a payment route.
  assert.deepEqual(
    judge({ status: 405, headers: headers({}) }, { status: 204, headers: headers({}) }),
    ['x402_cors_preflight', 'x402_not_402'],
  )
  assert.deepEqual(judge({ status: 308, headers: headers({}) }), ['x402_redirect', 'x402_not_402'])
})

test('the Celo registration names no retired address and uses plain ASCII', () => {
  const raw = repo(CELO_8004_FILE)
  for (const a of raw.match(/0x[0-9a-fA-F]{40}/g) ?? []) assert.equal(isRetired(a), false, `${a} is retired`)
  assert.match(raw, /^[\x20-\x7e\n]*$/, 'non-ASCII character in the registration')
})

test('every service the Celo registration advertises is our own https host', () => {
  // The OASF row is capability metadata whose endpoint names the OASF schema, not a service.
  for (const s of (published().services as { name: string; endpoint: string }[]).filter((s) => s.name !== 'OASF')) {
    assert.equal(new URL(s.endpoint).protocol, 'https:')
    assert.equal(new URL(s.endpoint).hostname, 'a-identity.xyz')
  }
  assert.ok(CELO_8004_URI.endsWith(`/${CELO_8004_FILE.replace(/^public\//, '')}`))
})

test('Aigora rules: onAigora must be the boolean true, never the string', () => {
  assert.deepEqual(aigoraRegistrationIssues(VALID), [])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, onAigora: 'true' }), ['on_aigora_not_true'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, onAigora: undefined }), ['on_aigora_not_true'])
})

test('Aigora rules: name and description lengths', () => {
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, name: ' ' }), ['name_required'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, name: 'x'.repeat(65) }), ['name_too_long'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, description: 'x'.repeat(49) }), ['description_too_short'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, description: 'x'.repeat(1025) }), ['description_too_long'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, description: 'x'.repeat(50) }), [])
})

test('Aigora rules: services are one to seven web, MCP or A2A rows with valid versions', () => {
  const row = (i: number) => ({ name: 'web', endpoint: `https://example.com/${i}` })
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [] }), ['no_service'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [1, 2, 3, 4, 5, 6, 7].map(row) }), [])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [1, 2, 3, 4, 5, 6, 7, 8].map(row) }), ['too_many_services'])
  // The OASF capability carrier is metadata, not a callable row, so it does not count.
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [row(1), { name: 'OASF', skills: [] }] }), [])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [{ name: 'x402', endpoint: 'https://e.com' }] }), ['service_type_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [row(1), row(1)] }), ['service_dup'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [{ name: 'web', endpoint: '' }] }), ['endpoint_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [{ name: 'MCP', endpoint: 'https://e.com', version: '1.0' }] }), ['mcp_version_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [{ name: 'A2A', endpoint: 'https://e.com', version: '1.0' }] }), ['a2a_version_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, services: [{ name: 'A2A', endpoint: 'https://e.com', version: '1.0.0' }] }), [])
})

test('Aigora rules: images are https or ipfs, and an x402 claim needs a priced web endpoint', () => {
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, image: 'ipfs://bafy' }), [])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, image: 'http://e.com/a.png' }), ['image_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: true }), ['x402_endpoint_required'])
  const web = (price?: string) => ({ name: 'web', endpoint: 'https://example.com/pay', ...(price ? { price } : {}) })
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: true, services: [web()] }), ['x402_endpoint_required'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: true, services: [web('0')] }), ['x402_endpoint_required'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: true, services: [web('0.005')] }), [])
  // A priced MCP row is not what Aigora preflights.
  assert.deepEqual(x402PricedWebEndpoints({ services: [{ ...VALID.services[0], price: '0.005' }, web('0.005')] }), ['https://example.com/pay'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: 'false' }), ['x402_support_not_boolean'])
  assert.deepEqual(aigoraRegistrationIssues(null), ['not_an_object'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, type: 'agent' }), ['type_invalid'])
})

test('the Celo profile shows a square logo, a cover, every public link and an OASF row', () => {
  const doc = published()
  // The 64px favicon looked broken on Aigora's profile; the avatar is a padded square.
  assert.equal(doc.image, 'https://a-identity.xyz/logo/avatar-1024.png')
  assert.equal(doc.cover, 'https://a-identity.xyz/og-image.png')
  const platforms = (doc.external_links as { platform: string }[]).map((l) => l.platform)
  for (const p of ['website', 'x', 'github', 'discord']) assert.ok(platforms.includes(p), `missing ${p} link`)
  const oasf = (doc.services as { name: string; skills?: string[]; domains?: string[] }[]).find((s) => s.name === 'OASF')
  assert.ok(oasf?.skills?.length && oasf.domains?.length)
  // The images are served from our own public/ folder, so a renamed file fails here.
  for (const u of [doc.image, doc.cover] as string[]) {
    assert.ok(existsSync(fileURLToPath(new URL(`../../../public${new URL(u).pathname}`, import.meta.url))), `${u} is not in public/`)
  }
})

test('Aigora rules: service prices and descriptions, OASF limits, categories and links', () => {
  const withService = (extra: Record<string, unknown>) => ({ ...VALID, services: [{ ...VALID.services[0], ...extra }] })
  assert.deepEqual(aigoraRegistrationIssues(withService({ price: '0.005', description: 'ok' })), [])
  assert.deepEqual(aigoraRegistrationIssues(withService({ price: '0.0000001' })), ['service_price_invalid'])
  assert.deepEqual(aigoraRegistrationIssues(withService({ price: 0.5 })), ['service_price_invalid'])
  assert.deepEqual(aigoraRegistrationIssues(withService({ price: '1000001' })), ['service_price_too_high'])
  assert.deepEqual(aigoraRegistrationIssues(withService({ description: 'x'.repeat(257) })), ['service_description_too_long'])
  const oasf = (skills: number, domains: number) => ({
    ...VALID,
    services: [...VALID.services, { name: 'OASF', skills: Array(skills).fill('s'), domains: Array(domains).fill('d') }],
  })
  assert.deepEqual(aigoraRegistrationIssues(oasf(12, 8)), [])
  assert.deepEqual(aigoraRegistrationIssues(oasf(13, 9)), ['too_many_skills', 'too_many_domains'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, categories: ['data', 'automation'] }), [])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, categories: ['trust'] }), ['category_unknown'])
  const link = (platform: string, url: string) => ({ ...VALID, external_links: [{ platform, url }] })
  assert.deepEqual(aigoraRegistrationIssues(link('x', 'https://x.com/a')), [])
  assert.deepEqual(aigoraRegistrationIssues(link('mastodon', 'https://e.com')), ['link_platform_invalid'])
  assert.deepEqual(aigoraRegistrationIssues(link('x', 'http://x.com/a')), ['link_url_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, external_links: Array(9).fill({ platform: 'x', url: 'https://x.com/a' }) }), ['too_many_links'])
})

test('setAgentURI is prepared for the owner to sign, against Celo\'s IdentityRegistry, never executed', () => {
  const call = setAgentUriCall(celoAgentId())
  const chain = celoChain()
  assert.equal(call.status, 'prepared')
  assert.equal(call.chainId, chain.evmChainId)
  assert.equal(call.to, chain.contracts.identityRegistry)
  const decoded = decodeFunctionData({ abi: SET_AGENT_URI_ABI, data: call.data })
  assert.equal(decoded.functionName, 'setAgentURI')
  assert.deepEqual(decoded.args, [9759n, CELO_8004_URI])
  assert.match(call.cast, /--account <KEYSTORE_NAME>$/)
  assert.doesNotMatch(call.cast, /--private-key|--mnemonic/)
  // The owner the ledger names is the wallet that must sign; it is not a retired one.
  assert.equal(isRetired(provenanceFor('celo')?.agent?.owner), false)
})
