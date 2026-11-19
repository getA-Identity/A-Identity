import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData } from 'viem'
import {
  CELO_8004_FILE,
  CELO_8004_URI,
  SET_AGENT_URI_ABI,
  aigoraRegistrationIssues,
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

test('the Celo registration claims no x402 support until a live check can back the claim', () => {
  // Aigora blocks an x402 claim whose priced endpoint fails its live 402 preflight, and on
  // 2026-11-19 our Celo tool routes answered an unsigned POST with 400 and allowed only our
  // own origin in CORS. Flipping this to true is a decision with a live check behind it.
  assert.equal(published().x402Support, false)
})

test('the Celo registration names no retired address and uses plain ASCII', () => {
  const raw = repo(CELO_8004_FILE)
  for (const a of raw.match(/0x[0-9a-fA-F]{40}/g) ?? []) assert.equal(isRetired(a), false, `${a} is retired`)
  assert.match(raw, /^[\x20-\x7e\n]*$/, 'non-ASCII character in the registration')
})

test('every service the Celo registration advertises is our own https host', () => {
  for (const s of published().services as { endpoint: string }[]) {
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

test('Aigora rules: images are https or ipfs, and an x402 claim is refused without a live check', () => {
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, image: 'ipfs://bafy' }), [])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, image: 'http://e.com/a.png' }), ['image_invalid'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: true }), ['x402_claim_unverified'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, x402Support: 'false' }), ['x402_support_not_boolean'])
  assert.deepEqual(aigoraRegistrationIssues(null), ['not_an_object'])
  assert.deepEqual(aigoraRegistrationIssues({ ...VALID, type: 'agent' }), ['type_invalid'])
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
