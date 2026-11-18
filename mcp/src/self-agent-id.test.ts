/**
 * Self Agent ID reads: the pure helpers and every refusal path, offline. The live read is
 * exercised by hand against Celo (see the registry comment); nothing here touches an RPC.
 * The lookup paths run against fakeCelo, a Self registry and an ERC-8004 identity registry
 * described in memory and read through the same ChainReads seam production reads the chain with.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetSelfHolderIndexForTests,
  agentKeyFor,
  humanRef,
  humanProofChains,
  supportsHumanProof,
  readHumanProofOn,
  readHumanProofFor,
  sameHumanOn,
  type ChainReads,
  type LinkedIdentity,
  type ViewCall,
} from './self-agent-id.js'
import { CHAINS, getChainById } from './chains/index.js'
import { verifyAgent } from './asp/tools.js'

const ADDR = '0x6A5F1b8e56A19D456b799C2fA00E513244F58Ce6'

// Made-up addresses, lowercased as the lookup passes them.
const OWNER = '0x' + 'a1'.repeat(20)
const KEY = '0x' + 'b2'.repeat(20)
const KEY2 = '0x' + 'b3'.repeat(20)
const WALLET = '0x' + 'c4'.repeat(20)
const STRANGER = '0x' + 'd5'.repeat(20)
const ZERO = '0x' + '0'.repeat(40)

const CELO = getChainById('celo')!
const SELF_REGISTRY = CELO.contracts.selfAgentRegistry!.toLowerCase()
const IDENTITY_REGISTRY = CELO.contracts.identityRegistry!.toLowerCase()

/** One Self Agent ID: the wallet that holds it, its agent key, and its proof. */
type FakeId = { holder: string; key: string; human?: boolean; fresh?: boolean; nullifier?: bigint }

/** What a reverting call throws, so a batch can answer null for it while an outage fails the batch. */
class Revert extends Error {}

/**
 * Celo's Self registry and ERC-8004 identity registry as the reads see them, with no network.
 * An id nobody holds reverts on ownerOf, as the registry does. A function named in `down` fails
 * like an RPC outage: alone it throws, and a batch carrying it fails as a whole. `calls` records
 * every read by function name, and each batch as `batch:<size>`.
 */
function fakeCelo(ids: Record<number, FakeId>, agentWallets: Record<number, string> = {}, down: string[] = []) {
  const calls: string[] = []
  const nullifierOf = (id: number) => ids[id]?.nullifier ?? BigInt(id) * 7919n
  const answer = (c: ViewCall): unknown => {
    if (down.includes(c.functionName)) throw new Error(`fake RPC outage on ${c.functionName}`)
    const arg = c.args[0]
    const at = c.address.toLowerCase()
    if (at === IDENTITY_REGISTRY && c.functionName === 'getAgentWallet') return agentWallets[Number(arg)] ?? ZERO
    if (at !== SELF_REGISTRY) throw new Error(`fake: nothing at ${c.address}`)
    const one = ids[Number(arg)]
    switch (c.functionName) {
      case 'agentKeyToAgentId': {
        const hit = Object.entries(ids).find(([, x]) => agentKeyFor(x.key) === arg)
        return hit ? BigInt(hit[0]) : 0n
      }
      case 'balanceOf':
        return BigInt(Object.values(ids).filter((x) => x.holder === String(arg).toLowerCase()).length)
      case 'ownerOf':
        if (!one) throw new Revert('ERC721NonexistentToken')
        return one.holder
      case 'agentIdToAgentKey':
        return one ? agentKeyFor(one.key) : '0x' + '0'.repeat(64)
      case 'hasHumanProof':
        return one ? (one.human ?? true) : false
      case 'isProofFresh':
        return one ? (one.fresh ?? true) : false
      case 'proofExpiresAt':
        return one ? 1_900_000_000n : 0n
      case 'getHumanNullifier':
        return one ? nullifierOf(Number(arg)) : 0n
      case 'getProofProvider':
        return one ? '0x' + 'e6'.repeat(20) : ZERO
      case 'getAgentCountForHuman':
        return BigInt(Object.keys(ids).filter((id) => nullifierOf(Number(id)) === arg).length)
    }
    throw new Error(`fake: no ${c.functionName}`)
  }
  const reads: ChainReads = {
    async read(c) {
      calls.push(c.functionName)
      return answer(c)
    },
    async readMany(cs) {
      calls.push(`batch:${cs.length}`)
      if (cs.some((c) => down.includes(c.functionName))) throw new Error('fake RPC outage on a batch')
      return cs.map((c) => {
        try {
          return answer(c)
        } catch (e) {
          if (e instanceof Revert) return null
          throw e
        }
      })
    },
  }
  return { ids, reads, calls }
}

const linkedOf = (owner: string, tokenId = 10000n): LinkedIdentity => ({ chain: 'celo', tokenId, owner })
const batches = (calls: string[]) => calls.filter((c) => c.startsWith('batch:')).length

test('agentKeyFor: a bytes32 left-padded, lowercased agent address, as the registry keys it', () => {
  assert.equal(agentKeyFor(ADDR), '0x0000000000000000000000006a5f1b8e56a19d456b799c2fa00e513244f58ce6')
  assert.equal(agentKeyFor(ADDR).length, 66)
  assert.throws(() => agentKeyFor('#6271'), /not an EVM address/)
})

test('humanRef: stable, prefixed, and not the nullifier itself', () => {
  const n = 123456789012345678901234567890n
  assert.equal(humanRef(n), humanRef(n))
  assert.match(humanRef(n), /^self:[0-9a-f]{16}$/)
  assert.notEqual(humanRef(n), humanRef(n + 1n))
  assert.ok(!humanRef(n).includes(n.toString(16)), 'the raw nullifier must not leak through the ref')
})

test('every chain that names a Self registry is an EVM chain, and Celo is among them', () => {
  const chains = humanProofChains()
  assert.ok(chains.length >= 1)
  for (const c of chains) {
    assert.equal(c.ecosystem, 'evm', `${c.id} names a Self registry but is not EVM`)
    assert.match(c.contracts.selfAgentRegistry ?? '', /^0x[0-9a-fA-F]{40}$/)
    // Linked mode is found by a holder scan, one aggregate3 call per chunk of ids.
    assert.match(c.contracts.multicall3 ?? '', /^0x[0-9a-fA-F]{40}$/, `${c.id} names a Self registry and no Multicall3, so linked mode could not be read there`)
  }
  assert.ok(chains.some((c) => c.id === 'celo'))
  assert.equal(supportsHumanProof('celo'), true)
})

test('chains without a registry refuse before any network call, each with its own reason', async () => {
  assert.equal(supportsHumanProof('arc'), false)
  assert.equal(supportsHumanProof('stellar'), false)
  assert.equal(supportsHumanProof('nope'), false)
  const arc = await readHumanProofOn('arc', ADDR)
  assert.equal(arc.supported, false)
  if (!arc.supported) assert.match(arc.reason, /carries no Self Agent ID registry/)
  const stellar = await readHumanProofOn('stellar', ADDR)
  assert.equal(stellar.supported, false)
  if (!stellar.supported) assert.match(stellar.reason, /EVM registry/)
  const unknown = await readHumanProofOn('nope', ADDR)
  assert.equal(unknown.supported, false)
  if (!unknown.supported) assert.match(unknown.reason, /not in the chain registry/)
})

test('a non-address query, and a read that fails, are errors on a supported chain, never "unregistered"', async () => {
  const r = await readHumanProofOn('celo', '#6271')
  assert.equal(r.supported, true)
  assert.ok(r.supported && 'error' in r && /not an EVM address/.test(r.error))

  // The owner's holdings could not be read: unknown, in the error shape, never registered false.
  __resetSelfHolderIndexForTests()
  const holdingsDown = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: OWNER }, ['balanceOf'])
  const unread = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => holdingsDown.reads })
  assert.ok(unread.supported && 'error' in unread && !('registered' in unread), JSON.stringify(unread))
  if (unread.supported && 'error' in unread) {
    assert.equal(unread.address, OWNER)
    assert.match(unread.error, /unknown, not unregistered/)
    assert.match(unread.error, /linked mode/)
  }

  // The holder scan could not be made: the same.
  __resetSelfHolderIndexForTests()
  const scanDown = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: OWNER }, ['ownerOf'])
  const unscanned = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => scanDown.reads })
  assert.ok(unscanned.supported && 'error' in unscanned && /unknown, not unregistered/.test(unscanned.error), JSON.stringify(unscanned))

  // An agent-key read failed and the owner holds nothing: still unknown, because the key that
  // could not be read may be registered.
  __resetSelfHolderIndexForTests()
  const keyDown = fakeCelo({ 5: { holder: STRANGER, key: STRANGER } }, {}, ['agentKeyToAgentId'])
  const keyUnread = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => keyDown.reads })
  assert.ok(keyUnread.supported && 'error' in keyUnread && keyUnread.error.includes(`agent key ${OWNER}`), JSON.stringify(keyUnread))

  // A failed read on one path does not hide a find on another: a key outage, and the owner's ID found.
  __resetSelfHolderIndexForTests()
  const foundAnyway = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: OWNER }, ['agentKeyToAgentId'])
  const found = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => foundAnyway.reads })
  assert.ok(found.supported && 'registered' in found && found.registered && found.agentId === '197', JSON.stringify(found))
  // During that outage an ID keyed by the owner itself is reached through linked mode, and its
  // key is checked rather than assumed foreign: it is the owner, so the answer says it is verified.
  __resetSelfHolderIndexForTests()
  const ownKey = fakeCelo({ 194: { holder: OWNER, key: OWNER } }, {}, ['agentKeyToAgentId'])
  const own = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9907n), reads: () => ownKey.reads })
  assert.ok(own.supported && 'registered' in own && own.agentId === '194', JSON.stringify(own))
  if (own.supported && 'registered' in own) {
    assert.ok(own.note.includes(`Its agent key, ${OWNER}, is among the addresses this read knows this agent by, so the agent key is verified as well.`), own.note)
    assert.ok(!own.note.includes('is not among the addresses this read knows this agent by'), own.note)
  }
})

test('readHumanProofFor: agent-key mode, linked mode through the owner, and none are each said as what they are; no EVM address is unsupported', async () => {
  const r = await readHumanProofFor('celo', ['#6271', 'stellar:pubnet:G...'])
  assert.equal(r.supported, false)
  if (!r.supported) assert.match(r.reason, /No EVM address/)

  // Linked mode, as AIgora (ERC-8004 #10000) read on Celo on 2026-11-18: its owner holds Self
  // Agent ID #197, whose agent key is a separate address, and its agent wallet is its owner.
  __resetSelfHolderIndexForTests()
  const aigora = fakeCelo({ 5: { holder: STRANGER, key: STRANGER }, 197: { holder: OWNER, key: KEY } }, { 10000: OWNER })
  const linked = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => aigora.reads })
  assert.ok(linked.supported && 'registered' in linked && linked.registered, JSON.stringify(linked))
  if (linked.supported && 'registered' in linked) {
    assert.equal(linked.agentId, '197')
    assert.equal(linked.address, OWNER, 'the address asked is the holder, not the agent key')
    assert.equal(linked.humanBacked, true)
    assert.equal(linked.fresh, true)
    assert.equal(linked.agentsForSameHuman, 1)
    assert.equal(linked.humanRef, humanRef(197n * 7919n))
    assert.ok(linked.note.startsWith(`Self Agent ID #197 is held by this agent's owner, ${OWNER}: Self's linked mode`), linked.note)
    assert.ok(linked.note.includes(`Its agent key, ${KEY}, is not among the addresses this read knows this agent by, so this read verified who holds the ID, not that this agent signs with that key.`), linked.note)
    // The key was not verified, so the proof is said to be the ID's, not this agent's.
    assert.ok(linked.note.includes('A unique human vouched for that ID'), linked.note)
    assert.ok(!linked.note.includes('vouched for this agent'), linked.note)
  }
  // Every key first (the owner, then the agent wallet, which is the owner here and is not asked
  // twice), then the holdings: one scan to the last held id, one past it, one read of what it held.
  assert.deepEqual(aigora.calls.filter((c) => c === 'agentKeyToAgentId').length, 1)
  assert.ok(aigora.calls.indexOf('getAgentWallet') < aigora.calls.indexOf('balanceOf'))
  assert.equal(batches(aigora.calls), 3)

  // The scan is kept: a second lookup reads only past the last held id.
  const again = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => aigora.reads })
  assert.deepEqual(again, linked)
  assert.equal(batches(aigora.calls), 5, 'one scan batch from where the last one stopped, one read of the held ids')
  // And an id burned since is read again and dropped, so the answer rests on what the owner holds now.
  delete aigora.ids[197]
  aigora.ids[198] = { holder: OWNER, key: KEY2 }
  const moved = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => aigora.reads })
  assert.ok(moved.supported && 'registered' in moved && moved.agentId === '198', JSON.stringify(moved))
  assert.equal(batches(aigora.calls), 8, 'a scan that finds a new id reads one chunk past it')

  // Two IDs held by one owner and bound to two humans, as the owner of AbaPay (ERC-8004 #9687)
  // holds Self #105 and #196: both are named, the newest fresh one is reported, and the answer
  // says the registry does not tie either to this agent.
  __resetSelfHolderIndexForTests()
  const abapay = fakeCelo({ 105: { holder: OWNER, key: KEY, nullifier: 11n }, 196: { holder: OWNER, key: KEY2, nullifier: 22n } }, { 9687: WALLET })
  const two = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9687n), reads: () => abapay.reads })
  assert.ok(two.supported && 'registered' in two && two.agentId === '196', JSON.stringify(two))
  if (two.supported && 'registered' in two) {
    assert.ok(two.note.startsWith(`This agent's owner, ${OWNER}, holds 2 Self Agent IDs, #105 and #196: Self's linked mode`), two.note)
    assert.ok(two.note.includes("They are bound to 2 different humans, and the registry does not say which of them, if any, is this agent's; this read reports #196, the newest with a fresh human proof."), two.note)
    assert.ok(two.note.includes(`Its agent key, ${KEY2}, is not among the addresses this read knows this agent by`), two.note)
  }
  // Its agent wallet is not a key, and it was asked as one before the holdings were read.
  assert.equal(abapay.calls.filter((c) => c === 'agentKeyToAgentId').length, 2)
  assert.ok(abapay.calls.indexOf('getAgentWallet') < abapay.calls.indexOf('balanceOf'))

  // Agent-key mode, as vet402 (ERC-8004 #9907) whose owner is its Self agent key: found first,
  // and the answer is exactly the one the lookup gave before linked mode existed.
  __resetSelfHolderIndexForTests()
  const vet402 = fakeCelo({ 194: { holder: OWNER, key: OWNER } })
  const keyed = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9907n), reads: () => vet402.reads })
  const before = await readHumanProofFor('celo', [OWNER], { reads: () => vet402.reads })
  assert.deepEqual(keyed, before)
  assert.ok(keyed.supported && 'registered' in keyed && keyed.agentId === '194' && keyed.address === OWNER, JSON.stringify(keyed))
  if (keyed.supported && 'registered' in keyed) {
    assert.equal(keyed.note, 'A unique human vouched for this agent with a passport-derived zero-knowledge proof verified by Self on Celo. Third-party registry, read live; it says a human exists, not who they are.')
  }
  assert.ok(!vet402.calls.includes('getAgentWallet') && !vet402.calls.includes('balanceOf'), 'a key that matched ends the lookup')

  // The ERC-8004 agent wallet as an agent key: found, and the answer says through what.
  __resetSelfHolderIndexForTests()
  const walletKeyed = fakeCelo({ 50: { holder: STRANGER, key: WALLET } }, { 9000: WALLET })
  const viaWallet = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9000n), reads: () => walletKeyed.reads })
  assert.ok(viaWallet.supported && 'registered' in viaWallet && viaWallet.agentId === '50' && viaWallet.address === WALLET, JSON.stringify(viaWallet))
  if (viaWallet.supported && 'registered' in viaWallet) {
    assert.ok(viaWallet.note.startsWith(`Found through this agent's ERC-8004 agent wallet, ${WALLET}, which is the agent key of Self Agent ID #50. A unique human vouched for this agent`), viaWallet.note)
  }

  // None: no address it is known by is a key, and its owner holds no ID, so the owner is not scanned for.
  __resetSelfHolderIndexForTests()
  const nobody = fakeCelo({ 5: { holder: STRANGER, key: STRANGER } }, { 10001: WALLET })
  const miss = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 10001n), reads: () => nobody.reads })
  assert.ok(miss.supported && 'registered' in miss && miss.registered === false, JSON.stringify(miss))
  if (miss.supported && 'registered' in miss) {
    assert.equal(miss.agentId, null)
    assert.equal(miss.humanBacked, false)
    assert.equal(miss.address, OWNER)
    assert.ok(miss.note.startsWith('No Self Agent ID was found for this agent on Celo.'), miss.note)
    assert.ok(miss.note.includes(`(${OWNER} and ${WALLET}) is one; in linked mode a wallet holds the ID, and this agent's owner holds none.`), miss.note)
  }
  assert.equal(batches(nobody.calls), 0)

  // Through verify_agent: a Celo ERC-8004 agent reaches linked mode and the response keeps its
  // fields, and an Arc agent's lookup is not given an identity to read it through.
  __resetSelfHolderIndexForTests()
  const seen: unknown[] = []
  const deps = (chain: string) => ({
    resolveIdentity: async () => ({ agentId: `${getChainById(chain)!.caip2}:8004/10000`, tokenId: 10000, owner: OWNER, registrationUri: '', domain: '', valid: false, registeredAt: '', chain: chain as 'celo' }),
    readValidation: (async () => null) as never,
    readHumanProof: (async (anchor: string, candidates: string[], opts: Parameters<typeof readHumanProofFor>[2] = {}) => {
      seen.push(opts.erc8004 ?? null)
      return readHumanProofFor(anchor, candidates, { ...opts, reads: () => aigora.reads })
    }) as typeof readHumanProofFor,
  })
  aigora.ids[197] = { holder: OWNER, key: KEY }
  delete aigora.ids[198]
  const v = await verifyAgent(`${CELO.caip2}:8004/10000`, deps('celo'))
  assert.deepEqual(Object.keys(v), ['tool', '_meta', 'agentId', 'verified', 'kya_status', 'revoked', 'liveness', 'identity', 'kya_onchain', 'human_proof', 'platform', 'source', 'checkedAt'])
  assert.deepEqual(seen[0], { chain: 'celo', tokenId: 10000n, owner: OWNER })
  const hp = v.human_proof
  assert.ok(hp && hp.supported && 'registered' in hp && hp.registered && hp.agentId === '197', JSON.stringify(hp))
  assert.deepEqual(Object.keys(hp), ['supported', 'chain', 'registry', 'standard', 'source', 'address', 'registered', 'agentId', 'humanBacked', 'fresh', 'expiresAt', 'provider', 'agentsForSameHuman', 'humanRef', 'note'])
  await verifyAgent('#10000', deps('arc'))
  assert.equal(seen[1], null)
})

test('sameHumanOn: null on a chain that cannot answer, never a guessed false', async () => {
  assert.equal(await sameHumanOn('arc', 1n, 2n), null)
  assert.equal(await sameHumanOn('stellar', 1n, 2n), null)
  // The registry field is opt-in per chain: nothing outside the descriptor decides support.
  assert.equal(CHAINS.filter((c) => c.contracts.selfAgentRegistry).length, humanProofChains().length)
})
