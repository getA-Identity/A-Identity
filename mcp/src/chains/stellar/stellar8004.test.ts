/**
 * Stellar 8004 reads, offline.
 *
 * Every simulation is injected, so these assert what the module DOES with an answer rather
 * than whether Trion's testnet happened to be up. The live counterpart is
 * mcp/scripts/stellar-8004-check.mjs, which reads the real contracts and reports.
 *
 * Contract ids and account ids are taken from the chain registry or generated, never
 * pasted: an id restated in a test is a second place it can drift from the descriptor.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk'

import { getChainById } from '../registry.js'
import {
  A_IDENTITY_TESTNET_AGENT_ID,
  STELLAR_8004_NOTE,
  decodeDataUri,
  isFetchableAgentUri,
  parseStellar8004Id,
  readStellar8004Agent,
  stellar8004Chains,
  stellar8004Label,
  stellar8004SaleIdentity,
  type Stellar8004Simulate,
} from './stellar8004.js'

const TESTNET = getChainById('stellar-testnet')!
const PUBNET = getChainById('stellar')!
const TESTNET_REGISTRY = TESTNET.contracts.stellar8004!.identity

/** A fake simulator: method name to the ScVal it answers, or a failure mode. */
function fakeSim(table: Record<string, xdr.ScVal | 'restore' | 'error'>): Stellar8004Simulate {
  return async (_contract, method) => {
    const v = table[method]
    if (v === undefined) return { status: 'error', error: `no fake answer for ${method}` }
    if (v === 'restore') return { status: 'restore', reason: `${method} reads archived state` }
    if (v === 'error') return { status: 'error', error: 'the RPC did not answer' }
    return { status: 'ok', retval: v }
  }
}

const OWNER = Keypair.random().publicKey()
const WALLET = Keypair.random().publicKey()
const REGISTRY_OWNER = Keypair.random().publicKey()
const REGISTRATION = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'A-Identity Trust Oracle' }
const DATA_URI = `data:application/json;base64,${Buffer.from(JSON.stringify(REGISTRATION)).toString('base64')}`

function healthyRegistry(extra: Record<string, xdr.ScVal | 'restore' | 'error'> = {}) {
  return {
    version: nativeToScVal('0.1.0'),
    total_agents: nativeToScVal(26, { type: 'u32' }),
    get_owner: new Address(REGISTRY_OWNER).toScVal(),
    pending_upgrade: xdr.ScVal.scvVoid(),
    agent_exists: nativeToScVal(true),
    ...extra,
  }
}

// -- the id parser -----------------------------------------------------------------

test('Trion\'s own label parses, and the registry it names is checked against the descriptor', () => {
  const r = parseStellar8004Id(`stellar:testnet:${TESTNET_REGISTRY}#25`)
  assert.equal(r.kind, 'stellar8004')
  if (r.kind !== 'stellar8004') return
  assert.equal(r.chain, 'stellar-testnet')
  assert.equal(r.network, 'testnet')
  assert.equal(r.agentId, 25)
  assert.equal(r.identityRegistry, TESTNET_REGISTRY)
  assert.equal(r.label, `stellar:testnet:${TESTNET_REGISTRY}#25`)
})

test('the short alias resolves its registry from the descriptor instead of the string', () => {
  const t = parseStellar8004Id('stellar8004:testnet#25')
  assert.equal(t.kind, 'stellar8004')
  if (t.kind !== 'stellar8004') return
  assert.equal(t.identityRegistry, TESTNET_REGISTRY)
  assert.equal(t.chain, 'stellar-testnet')

  // pubnet is CAIP-2's word for the network Trion's label spells mainnet. Both are taken,
  // and the label printed back is theirs, because their explorer has to recognise it.
  const p = parseStellar8004Id('stellar8004:pubnet#7')
  assert.equal(p.kind, 'stellar8004')
  if (p.kind !== 'stellar8004') return
  assert.equal(p.chain, 'stellar')
  assert.equal(p.network, 'mainnet')
  assert.equal(p.label, `stellar:mainnet:${PUBNET.contracts.stellar8004!.identity}#7`)
})

test('an id naming a DIFFERENT registry is refused, not re-pointed at ours', () => {
  // The same source deployed twice is two registries with two id spaces. Reading the number
  // against ours because the shape matched would answer with a stranger's agent.
  const other = `C${'A'.repeat(55)}`
  const r = parseStellar8004Id(`stellar:testnet:${other}#25`)
  assert.equal(r.kind, 'refused')
  if (r.kind !== 'refused') return
  assert.match(r.reason, /different deployment is a different id space/)
})

test('anything that is not a Stellar 8004 id falls through rather than being refused', () => {
  // 'other' and 'refused' must not be the same answer: the first keeps resolving, the
  // second stops.
  for (const q of ['7', '#6271', 'eip155:196:8004/6271', '0x' + 'a'.repeat(40), 'stellar:testnet', '']) {
    assert.equal(parseStellar8004Id(q).kind, 'other', q)
  }
})

test('an id outside the u32 range is refused, because Soroban ids are u32', () => {
  const r = parseStellar8004Id('stellar8004:testnet#9999999999')
  assert.equal(r.kind, 'refused')
  if (r.kind !== 'refused') return
  assert.match(r.reason, /u32/)
})

// -- the read ----------------------------------------------------------------------

test('a live read is labeled third-party, carries the registry state, and decodes a data: URI', async () => {
  const r = await readStellar8004Agent(TESTNET, 25, {
    simulate: fakeSim(
      healthyRegistry({
        agent_uri: nativeToScVal(DATA_URI),
        find_owner: new Address(OWNER).toScVal(),
        get_agent_wallet: new Address(WALLET).toScVal(),
      }),
    ),
  })
  assert.equal(r.readable, true)
  if (!r.readable || !r.found) return assert.fail(JSON.stringify(r))
  assert.equal(r.source, 'third-party')
  assert.equal(r.live, true)
  assert.equal(r.chain, 'stellar-testnet')
  assert.equal(r.registry.identity, TESTNET_REGISTRY)
  assert.equal(r.registry.owner, REGISTRY_OWNER)
  assert.equal(r.registry.version, '0.1.0')
  assert.equal(r.registry.totalAgents, 26)
  assert.equal(r.registry.upgradeable, true)
  assert.equal(r.registry.pendingUpgrade, null)
  assert.equal(r.agent.id, 25)
  assert.equal(r.agent.owner, OWNER)
  assert.equal(r.agent.wallet, WALLET)
  assert.equal(r.agent.agentUriKind, 'data')
  assert.deepEqual(r.agent.registration, REGISTRATION)
  assert.equal(r.label, `stellar:testnet:${TESTNET_REGISTRY}#25`)
  // Derived from the descriptor's explorer, never typed.
  assert.equal(r.explorerUrl, `${TESTNET.explorer}/contract/${TESTNET_REGISTRY}`)
  assert.equal(r.note, STELLAR_8004_NOTE)
})

test('the note says the four things a caller must not get wrong', () => {
  assert.match(STELLAR_8004_NOTE, /third-party/)
  assert.match(STELLAR_8004_NOTE, /u32/)
  assert.match(STELLAR_8004_NOTE, /binds no foreign-chain identity/)
  assert.match(STELLAR_8004_NOTE, /upgradeable/)
  assert.match(STELLAR_8004_NOTE, /not our identity anchor/)
  assert.match(STELLAR_8004_NOTE, /KYA cannot be anchored here/)
})

test('an https agent_uri is fetched through an injected fetch, with the registration parsed', async () => {
  let asked = ''
  const r = await readStellar8004Agent(PUBNET, 7, {
    simulate: fakeSim(
      healthyRegistry({
        agent_uri: nativeToScVal('https://a-identity.xyz/.well-known/stellar-8004.json'),
        find_owner: new Address(OWNER).toScVal(),
        get_agent_wallet: xdr.ScVal.scvVoid(),
      }),
    ),
    fetch: (async (url: string) => {
      asked = String(url)
      return { ok: true, text: async () => JSON.stringify(REGISTRATION) }
    }) as unknown as typeof globalThis.fetch,
  })
  assert.equal(r.readable && r.found, true)
  if (!r.readable || !r.found) return
  assert.equal(asked, 'https://a-identity.xyz/.well-known/stellar-8004.json')
  assert.equal(r.agent.agentUriKind, 'https')
  assert.deepEqual(r.agent.registration, REGISTRATION)
  // Option::None came back for the wallet, and null is the honest rendering of it.
  assert.equal(r.agent.wallet, null)
})

test('an unreachable registration document is a missing field, not a failed read', async () => {
  const r = await readStellar8004Agent(TESTNET, 25, {
    simulate: fakeSim(
      healthyRegistry({
        agent_uri: nativeToScVal('https://a-identity.xyz/.well-known/stellar-8004.json'),
        find_owner: new Address(OWNER).toScVal(),
        get_agent_wallet: xdr.ScVal.scvVoid(),
      }),
    ),
    fetch: (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch,
  })
  assert.equal(r.readable && r.found, true)
  if (!r.readable || !r.found) return
  assert.equal(r.agent.registration, null)
  assert.equal(r.agent.agentUri, 'https://a-identity.xyz/.well-known/stellar-8004.json')
})

test('an agent the registry does not have is found:false, with the registry still readable', async () => {
  const r = await readStellar8004Agent(TESTNET, 9999, {
    simulate: fakeSim(healthyRegistry({ agent_exists: nativeToScVal(false) })),
  })
  assert.equal(r.readable, true)
  if (!r.readable) return assert.fail('a registry that answered is readable')
  assert.equal(r.found, false)
  if (r.found) return
  assert.match(r.reason, /has no agent 9999/)
  assert.match(r.reason, /its own\s+space/)
  assert.equal(r.registry, TESTNET_REGISTRY)
})

test('archived state is its own answer, never "no such agent"', async () => {
  // Soroban archives entries as a matter of course. The pubnet Identity registry was in
  // exactly this state on 2026-09-09 with a 36.64 XLM restore in the footprint, and a
  // reader told "not found" would have published an absence nobody observed.
  const r = await readStellar8004Agent(PUBNET, 7, {
    simulate: fakeSim(healthyRegistry({ total_agents: 'restore' })),
  })
  assert.equal(r.readable, false)
  if (r.readable) return
  assert.equal(r.reason, 'archived')
  assert.equal(r.live, false)
  assert.equal(r.source, 'third-party')
  assert.match(r.detail, /archived/)
  assert.equal(r.explorerUrl, `${PUBNET.explorer}/contract/${PUBNET.contracts.stellar8004!.identity}`)
})

test('an RPC that will not answer is unreachable, and says so', async () => {
  const r = await readStellar8004Agent(TESTNET, 25, {
    simulate: fakeSim(healthyRegistry({ get_owner: 'error' })),
  })
  assert.equal(r.readable, false)
  if (r.readable) return
  assert.equal(r.reason, 'unreachable')
  assert.match(r.detail, /did not answer/)
})

test('a chain with no stellar8004 descriptor throws rather than reading the wrong contract', async () => {
  const arc = getChainById('arc')!
  await assert.rejects(() => readStellar8004Agent(arc, 1), /declares no contracts.stellar8004.identity/)
})

// -- helpers and the point of sale ---------------------------------------------------

test('a data: URI decodes from base64 or percent-encoding, and garbage decodes to null', () => {
  assert.equal(decodeDataUri(DATA_URI), JSON.stringify(REGISTRATION))
  assert.equal(decodeDataUri('data:application/json,%7B%22a%22%3A1%7D'), '{"a":1}')
  assert.equal(decodeDataUri('https://example.com/x.json'), null)
})

test('an agent-controlled URI cannot point our fetch at an internal target', () => {
  assert.equal(isFetchableAgentUri('https://a-identity.xyz/.well-known/stellar-8004.json'), true)
  assert.equal(isFetchableAgentUri('http://a-identity.xyz/x.json'), false) // https only here
  assert.equal(isFetchableAgentUri('https://169.254.169.254/latest/meta-data/'), false)
  assert.equal(isFetchableAgentUri('https://localhost/x'), false)
  assert.equal(isFetchableAgentUri('https://10.0.0.5/x'), false)
  assert.equal(isFetchableAgentUri('https://[::1]/x'), false)
  assert.equal(isFetchableAgentUri('not a url'), false)
})

test('both Stellar networks declare a registry, and the label is built from the descriptor', () => {
  const ids = stellar8004Chains().map((c) => c.id).sort()
  assert.deepEqual(ids, ['stellar', 'stellar-testnet'])
  assert.equal(stellar8004Label(TESTNET, 25), `stellar:testnet:${TESTNET_REGISTRY}#25`)
  assert.equal(stellar8004Label(PUBNET, 7), `stellar:mainnet:${PUBNET.contracts.stellar8004!.identity}#7`)
})

test('the point-of-sale identity says KYA cannot be anchored on Stellar, and claims no pubnet id', () => {
  const i = stellar8004SaleIdentity()
  assert.equal(i.anchoredOn, 'evm')
  assert.match(i.note, /ERC-8004 is EVM-only/)
  assert.match(i.note, /KYA cannot be anchored on Stellar/)
  assert.equal(i.passport, 'https://a-identity.xyz/.well-known/agent-card.json')
  assert.equal(i.stellar8004.testnet, `stellar:testnet:${TESTNET_REGISTRY}#${A_IDENTITY_TESTNET_AGENT_ID}`)
  assert.equal(i.stellar8004.pubnet, null, 'nothing is claimed on pubnet until a registration lands')
  assert.match(i.stellar8004.note, /not our anchor/)
})
