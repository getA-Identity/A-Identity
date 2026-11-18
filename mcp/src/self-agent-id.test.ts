/**
 * Self Agent ID reads: the pure helpers and every refusal path, offline. The live read is
 * exercised by hand against Celo (see the registry comment); nothing here touches an RPC.
 * The lookup paths run against fakeCelo, a Self registry and an ERC-8004 identity registry
 * described in memory and read through the same ChainReads seam production reads the chain with.
 * The production side of that seam (chainReadsOver) runs over a viem client whose RPC is a
 * function in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, multicall3Abi } from 'viem'
import {
  __resetSelfHolderIndexForTests,
  agentKeyFor,
  chainReadsOver,
  humanRef,
  humanProofChains,
  supportsHumanProof,
  readHumanProofOn,
  readHumanProofFor,
  sameHumanOn,
  type ChainReads,
  type HumanProofFoundBy,
  type LinkedIdentity,
  type ViewCall,
} from './self-agent-id.js'
import { CHAINS, getChainById } from './chains/index.js'
import { SELF_AGENT_REGISTRY_ABI } from './chains/evm/abis.js'
import { counterpartyCheck, verifyAgent, type GatherDeps } from './asp/tools.js'

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

const linkedOf = (owner: string, tokenId: bigint | null = 10000n): LinkedIdentity => ({ chain: 'celo', tokenId, owner })
const batches = (calls: string[]) => calls.filter((c) => c.startsWith('batch:')).length

/** How each lookup handed `onFound` reached its Self Agent ID, in order; a lookup that found none adds nothing. */
function foundLog() {
  const log: HumanProofFoundBy[] = []
  return { log, onFound: (how: HumanProofFoundBy) => void log.push(how) }
}

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
  // Nothing was found, so the caller is not told of a find (onFound).
  const how = foundLog()
  __resetSelfHolderIndexForTests()
  const holdingsDown = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: OWNER }, ['balanceOf'])
  const unread = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => holdingsDown.reads, onFound: how.onFound })
  assert.ok(unread.supported && 'error' in unread && !('registered' in unread), JSON.stringify(unread))
  assert.deepEqual(how.log, [])
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
  // The read that did not answer may have missed an ID keyed to the agent itself, which would have
  // been reported instead, so the find is ambiguous (no same-human signal rests on it) and the note
  // names that read.
  const cannotRuleOut = 'did not answer, so this read cannot rule out a Self Agent ID keyed to an address this agent is known by, which it would have reported instead.'
  __resetSelfHolderIndexForTests()
  const foundAnyway = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: OWNER }, ['agentKeyToAgentId'])
  const found = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => foundAnyway.reads, onFound: how.onFound })
  assert.ok(found.supported && 'registered' in found && found.registered && found.agentId === '197', JSON.stringify(found))
  assert.equal(how.log.pop(), 'holder-ambiguous')
  if (found.supported && 'registered' in found) {
    assert.ok(found.note.includes(`Self's linked mode, where the ID is held by a wallet the human named when registering and the agent key is a separate address. The agent-key read of ${OWNER} ${cannotRuleOut}`), found.note)
  }
  // Every read that did not answer is named: a second known address, the agent wallet's key read,
  // and the agent wallet read itself.
  __resetSelfHolderIndexForTests()
  const walletKeyDown = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: WALLET }, ['agentKeyToAgentId'])
  const viaWalletDown = await readHumanProofFor('celo', [STRANGER, OWNER], { erc8004: linkedOf(OWNER), reads: () => walletKeyDown.reads, onFound: how.onFound })
  assert.ok(viaWalletDown.supported && 'registered' in viaWalletDown && viaWalletDown.agentId === '197', JSON.stringify(viaWalletDown))
  assert.equal(how.log.pop(), 'holder-ambiguous')
  if (viaWalletDown.supported && 'registered' in viaWalletDown) {
    assert.ok(viaWalletDown.note.includes(`The agent-key read of ${STRANGER}, the agent-key read of ${OWNER} and the agent-key read of this agent's ERC-8004 agent wallet (${WALLET}) ${cannotRuleOut}`), viaWalletDown.note)
  }
  __resetSelfHolderIndexForTests()
  const walletDown = fakeCelo({ 197: { holder: OWNER, key: KEY } }, { 10000: WALLET }, ['getAgentWallet'])
  const noWallet = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => walletDown.reads, onFound: how.onFound })
  assert.ok(noWallet.supported && 'registered' in noWallet && noWallet.agentId === '197', JSON.stringify(noWallet))
  assert.equal(how.log.pop(), 'holder-ambiguous')
  if (noWallet.supported && 'registered' in noWallet) {
    assert.ok(noWallet.note.includes(`The read of this agent's ERC-8004 agent wallet ${cannotRuleOut}`), noWallet.note)
  }
  // During that outage an ID keyed by the owner itself is reached through linked mode, and its
  // key is checked rather than assumed foreign: it is the owner, so the answer says it is verified,
  // and names it for what it is, Self's simple registration, not linked mode.
  __resetSelfHolderIndexForTests()
  const ownKey = fakeCelo({ 194: { holder: OWNER, key: OWNER } }, {}, ['agentKeyToAgentId'])
  const own = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9907n), reads: () => ownKey.reads, onFound: how.onFound })
  assert.ok(own.supported && 'registered' in own && own.agentId === '194', JSON.stringify(own))
  if (own.supported && 'registered' in own) {
    assert.ok(
      own.note.startsWith(`Self Agent ID #194 is held by this agent's owner, ${OWNER}, and keyed to it: Self's simple registration, where the human's own wallet is the agent key. This read found it through the IDs the owner holds, because the agent-key read did not return it.`),
      own.note,
    )
    assert.ok(own.note.includes(`Its agent key, ${OWNER}, is among the addresses this read knows this agent by, so the agent key is verified as well.`), own.note)
    assert.ok(!own.note.includes('is not among the addresses this read knows this agent by'), own.note)
    assert.ok(!own.note.includes("Self's linked mode") && !own.note.includes('the agent key is a separate address'), own.note)
    // The read that did not answer is the read of this very key, which would have answered this ID.
    assert.ok(!own.note.includes('cannot rule out'), own.note)
  }
  assert.equal(how.log.pop(), 'agent-key', 'its agent key is an address the agent is known by')
  // The same outage with a second ID beside it, bound to another human: the one keyed to the owner
  // is reported, as the agent-key read would have answered, and the note does not call the pick a guess.
  __resetSelfHolderIndexForTests()
  const ownAndLinked = fakeCelo({ 194: { holder: OWNER, key: OWNER }, 197: { holder: OWNER, key: KEY } }, {}, ['agentKeyToAgentId'])
  const both = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9907n), reads: () => ownAndLinked.reads, onFound: how.onFound })
  assert.ok(both.supported && 'registered' in both && both.agentId === '194', JSON.stringify(both))
  if (both.supported && 'registered' in both) {
    assert.ok(
      both.note.startsWith(
        `This agent's owner, ${OWNER}, holds 2 Self Agent IDs, #194 and #197: Self's linked mode, where the ID is held by a wallet the human named when registering and the agent key is a separate address, except #194, keyed to the owner itself (Self's simple registration, where the human's own wallet is the agent key).`,
      ),
      both.note,
    )
    assert.ok(both.note.includes('They are bound to 2 different humans; this read reports #194, the one keyed to the owner itself, which the agent-key read did not return.'), both.note)
    assert.ok(!both.note.includes('if any, is this agent') && !both.note.includes('cannot rule out'), both.note)
  }
  assert.equal(how.log.pop(), 'agent-key')

  // balanceOf counts more IDs than the read found, here because a run of 500 ids nobody holds ends
  // the scan before #800 (the limit extendHolderIndex states). The answer says so instead of
  // reading as all there is, and the find is ambiguous, so no same-human signal rests on it.
  __resetSelfHolderIndexForTests()
  const gap = fakeCelo({ 197: { holder: OWNER, key: KEY }, 800: { holder: OWNER, key: KEY2 } })
  const short = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => gap.reads, onFound: how.onFound })
  assert.ok(short.supported && 'registered' in short && short.agentId === '197', JSON.stringify(short))
  if (short.supported && 'registered' in short) {
    assert.ok(short.note.startsWith(`Self Agent ID #197 is held by this agent's owner, ${OWNER}: Self's linked mode`), short.note)
    assert.ok(short.note.includes('balanceOf reports 2 Self Agent IDs held by this owner and this read found 1, so it may not name every ID the owner holds or every human they are bound to.'), short.note)
  }
  assert.equal(how.log.pop(), 'holder-ambiguous')
  assert.deepEqual(how.log, [])

  // The production batch reader (chainReadsOver, what liveReads builds over the chain's RPCs), over
  // a viem client whose RPC is the function below. A call that reverts inside the batch answers
  // null; a batch the RPC failed, an answer of the wrong length, and an answer that does not decode
  // each fail the batch, and so does a chain with no Multicall3. None of them reads as "no holder".
  const registry = CELO.contracts.selfAgentRegistry as `0x${string}`
  const multicall = CELO.contracts.multicall3 as `0x${string}`
  type Call3 = { target: string; allowFailure: boolean; callData: string }
  type Result3 = { success: boolean; returnData: `0x${string}` }
  let answerBatch: (calls: readonly Call3[]) => Result3[] = () => []
  let sent: readonly Call3[] = []
  const rpc: string[] = []
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method, params }) {
          rpc.push(method)
          const [call] = (params ?? []) as [{ to?: string; data?: `0x${string}` }]
          if (method !== 'eth_call' || !call?.to || !call.data) throw new Error(`fake RPC: no ${method}`)
          if (call.to.toLowerCase() === SELF_REGISTRY) return encodeFunctionResult({ abi: SELF_AGENT_REGISTRY_ABI, functionName: 'balanceOf', result: 2n })
          if (call.to.toLowerCase() !== multicall.toLowerCase()) throw new Error(`fake RPC: nothing at ${call.to}`)
          const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data })
          if (decoded.functionName !== 'aggregate3') throw new Error(`fake RPC: ${decoded.functionName}`)
          sent = decoded.args[0]
          return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: answerBatch(sent) })
        },
      },
      { retryCount: 0 },
    ),
  })
  const live = chainReadsOver(client, multicall, CELO.name)
  const ownerOf = (id: bigint): ViewCall => ({ address: registry, abi: SELF_AGENT_REGISTRY_ABI, functionName: 'ownerOf', args: [id] })
  const holds = (holder: string): Result3 => ({ success: true, returnData: encodeFunctionResult({ abi: SELF_AGENT_REGISTRY_ABI, functionName: 'ownerOf', result: holder as `0x${string}` }) })
  const ERC721_ERRORS = [{ type: 'error', name: 'ERC721NonexistentToken', inputs: [{ name: 'tokenId', type: 'uint256' }] }] as const
  const nonexistent = (id: bigint): Result3 => ({ success: false, returnData: encodeErrorResult({ abi: ERC721_ERRORS, errorName: 'ERC721NonexistentToken', args: [id] }) })
  assert.equal(await live.read({ address: registry, abi: SELF_AGENT_REGISTRY_ABI, functionName: 'balanceOf', args: [OWNER] }), 2n)
  answerBatch = (calls) => [holds(OWNER), nonexistent(198n)].slice(0, calls.length)
  const answered = await live.readMany([ownerOf(197n), ownerOf(198n)])
  assert.equal(answered.length, 2)
  assert.equal(String(answered[0]).toLowerCase(), OWNER)
  assert.equal(answered[1], null, 'a call that reverted inside the batch is no holder')
  assert.equal(sent.length, 2)
  assert.ok(sent.every((c) => c.allowFailure === true && c.target.toLowerCase() === SELF_REGISTRY), JSON.stringify(sent))
  answerBatch = () => [holds(OWNER)]
  await assert.rejects(live.readMany([ownerOf(197n), ownerOf(198n)]), /Multicall3 answered 1 results for 2 calls/)
  answerBatch = () => [{ success: true, returnData: '0x' }]
  await assert.rejects(live.readMany([ownerOf(197n)]))
  answerBatch = () => {
    throw new Error('fake RPC outage')
  }
  await assert.rejects(live.readMany([ownerOf(197n)]))
  const sentBefore = rpc.length
  const nowhere = chainReadsOver(client, undefined, 'Nowhere')
  assert.deepEqual(await nowhere.readMany([]), [])
  await assert.rejects(nowhere.readMany([ownerOf(197n)]), /Nowhere names no Multicall3 contract/)
  assert.equal(rpc.length, sentBefore, 'neither one reached the RPC')
})

test('readHumanProofFor: agent-key mode, linked mode through the owner, and none are each said as what they are; no EVM address is unsupported', async () => {
  const r = await readHumanProofFor('celo', ['#6271', 'stellar:pubnet:G...'])
  assert.equal(r.supported, false)
  if (!r.supported) assert.match(r.reason, /No EVM address/)

  // Linked mode, as AIgora (ERC-8004 #10000) read on Celo on 2026-11-18: its owner holds Self
  // Agent ID #197, whose agent key is a separate address, and its agent wallet is its owner.
  // How each find was reached is told beside the answer (onFound), for counterparty_check.
  const how = foundLog()
  __resetSelfHolderIndexForTests()
  const aigora = fakeCelo({ 5: { holder: STRANGER, key: STRANGER }, 197: { holder: OWNER, key: KEY } }, { 10000: OWNER })
  const linked = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER), reads: () => aigora.reads, onFound: how.onFound })
  assert.ok(linked.supported && 'registered' in linked && linked.registered, JSON.stringify(linked))
  assert.equal(how.log.pop(), 'holder', 'one ID held by the owner, bound to one human')
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
  const two = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9687n), reads: () => abapay.reads, onFound: how.onFound })
  assert.ok(two.supported && 'registered' in two && two.agentId === '196', JSON.stringify(two))
  assert.equal(how.log.pop(), 'holder-ambiguous', "the IDs the owner holds name two humans, so the pick is not this agent's known human")
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
  const keyed = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9907n), reads: () => vet402.reads, onFound: how.onFound })
  const before = await readHumanProofFor('celo', [OWNER], { reads: () => vet402.reads, onFound: how.onFound })
  assert.deepEqual(keyed, before)
  assert.deepEqual(how.log.splice(0), ['agent-key', 'agent-key'])
  assert.ok(keyed.supported && 'registered' in keyed && keyed.agentId === '194' && keyed.address === OWNER, JSON.stringify(keyed))
  if (keyed.supported && 'registered' in keyed) {
    assert.equal(keyed.note, 'A unique human vouched for this agent with a passport-derived zero-knowledge proof verified by Self on Celo. Third-party registry, read live; it says a human exists, not who they are.')
  }
  assert.ok(!vet402.calls.includes('getAgentWallet') && !vet402.calls.includes('balanceOf'), 'a key that matched ends the lookup')

  // The ERC-8004 agent wallet as an agent key: found, and the answer says through what.
  __resetSelfHolderIndexForTests()
  const walletKeyed = fakeCelo({ 50: { holder: STRANGER, key: WALLET } }, { 9000: WALLET })
  const viaWallet = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 9000n), reads: () => walletKeyed.reads, onFound: how.onFound })
  assert.ok(viaWallet.supported && 'registered' in viaWallet && viaWallet.agentId === '50' && viaWallet.address === WALLET, JSON.stringify(viaWallet))
  assert.equal(how.log.pop(), 'agent-wallet')
  if (viaWallet.supported && 'registered' in viaWallet) {
    assert.ok(viaWallet.note.startsWith(`Found through this agent's ERC-8004 agent wallet, ${WALLET}, which is the agent key of Self Agent ID #50. A unique human vouched for this agent`), viaWallet.note)
  }

  // None: no address it is known by is a key, and its owner holds no ID, so the owner is not scanned for.
  __resetSelfHolderIndexForTests()
  const nobody = fakeCelo({ 5: { holder: STRANGER, key: STRANGER } }, { 10001: WALLET })
  const miss = await readHumanProofFor('celo', [OWNER], { erc8004: linkedOf(OWNER, 10001n), reads: () => nobody.reads, onFound: how.onFound })
  assert.ok(miss.supported && 'registered' in miss && miss.registered === false, JSON.stringify(miss))
  assert.deepEqual(how.log, [], 'nothing found, nothing told')
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

  // By its owner's address: on Celo that resolves to a partial identity, because Forno refuses
  // getLogs from block 0, so which token the owner holds is not listed. balanceOf on the ERC-8004
  // registry still proved the owner, so the holder read answers with the same ID, and the agent
  // wallet, which needs a token id, is not read.
  const ownerForm = {
    ...deps('celo'),
    resolveIdentity: async () => ({ agentId: `${CELO.caip2}:8004/owned-by-${OWNER}`, tokenId: 0, owner: OWNER, registrationUri: '', domain: '', valid: false, registeredAt: '', chain: 'celo' as const, partial: true }),
  }
  const mark = aigora.calls.length
  const byOwner = await verifyAgent(OWNER, ownerForm)
  assert.deepEqual(seen[2], { chain: 'celo', tokenId: null, owner: OWNER })
  assert.equal(byOwner.identity?.partial, true)
  const hpOwner = byOwner.human_proof
  assert.ok(hpOwner && hpOwner.supported && 'registered' in hpOwner && hpOwner.registered && hpOwner.agentId === '197' && hpOwner.address === OWNER, JSON.stringify(hpOwner))
  assert.deepEqual(Object.keys(hpOwner), Object.keys(hp))
  const ownerReads = aigora.calls.slice(mark)
  assert.ok(ownerReads.includes('balanceOf') && !ownerReads.includes('getAgentWallet'), ownerReads.join(','))
})

test('sameHumanOn: null on a chain that cannot answer, never a guessed false', async () => {
  assert.equal(await sameHumanOn('arc', 1n, 2n), null)
  assert.equal(await sameHumanOn('stellar', 1n, 2n), null)
  // The registry field is opt-in per chain: nothing outside the descriptor decides support.
  assert.equal(CHAINS.filter((c) => c.contracts.selfAgentRegistry).length, humanProofChains().length)

  // counterparty_check's sameHuman with Self's linked mode in the reads. An ID an owner holds is a
  // same-human signal only when the read found every ID that owner holds and they name one human,
  // and the reason then says it was read through the owner; otherwise sameHuman is null, never a
  // guess. As on Celo on 2026-11-18, where AbaPay's owner holds #105 and #196, bound to two humans,
  // and the lookup reports #196 while saying the registry does not tie either one to the agent.
  __resetSelfHolderIndexForTests()
  const SOLO = '0x' + 'f7'.repeat(20)
  const PAYEE = '0x' + 'f8'.repeat(20)
  const TWIN = '0x' + 'f9'.repeat(20)
  const SOLO2 = '0x' + 'fa'.repeat(20)
  const registry = fakeCelo({
    105: { holder: OWNER, key: KEY, nullifier: 11n },
    196: { holder: OWNER, key: KEY2, nullifier: 22n },
    197: { holder: SOLO, key: WALLET, nullifier: 22n },
    198: { holder: SOLO2, key: STRANGER, nullifier: 22n },
    300: { holder: PAYEE, key: PAYEE, nullifier: 22n },
    301: { holder: TWIN, key: TWIN, nullifier: 22n },
  })
  const ownerOfToken: Record<string, string> = { 9687: OWNER, 10000: SOLO, 10001: SOLO2, 9907: PAYEE, 9908: TWIN }
  const asked: [bigint, bigint][] = []
  const deps: GatherDeps = {
    resolveIdentity: async (q) => {
      const token = q.split('/').pop() ?? ''
      return { agentId: q, tokenId: Number(token), owner: ownerOfToken[token], registrationUri: '', domain: '', valid: false, registeredAt: '', chain: 'celo' }
    },
    readValidation: (async () => null) as never,
    readHumanProof: ((anchor: string, candidates: string[], opts: Parameters<typeof readHumanProofFor>[2] = {}) =>
      readHumanProofFor(anchor, candidates, { ...opts, reads: () => registry.reads })) as typeof readHumanProofFor,
    sameHuman: async (_chain, a, b) => {
      asked.push([a, b])
      return registry.ids[Number(a)].nullifier === registry.ids[Number(b)].nullifier
    },
  }
  const agent = (token: number) => `${CELO.caip2}:8004/${token}`
  const tail = '; a settlement between them builds no independent reputation.'
  const sameHumanReasons = (reasons: string[]) => reasons.filter((r) => r.includes('same verified human'))

  // The payer's owner holds IDs bound to two humans, and the one reported shares the counterparty's
  // human: no answer and no reason, either way round, and the registry is not asked.
  for (const [from, to] of [[9687, 9907], [9907, 9687]]) {
    const split = await counterpartyCheck(agent(from), agent(to), null, deps)
    assert.equal(split.sameHuman, null, `#${from} paying #${to}`)
    assert.deepEqual(sameHumanReasons(split.reasons), [], JSON.stringify(split.reasons))
  }
  assert.deepEqual(asked, [])

  // The payer's owner holds one ID, bound to the counterparty's human: the signal stands, and its
  // reason says what was read, that the owner holds it, not that the agent is keyed to it.
  const solo = await counterpartyCheck(agent(10000), agent(9907), null, deps)
  assert.equal(solo.sameHuman, true)
  assert.deepEqual(asked.splice(0), [[197n, 300n]])
  assert.deepEqual(sameHumanReasons(solo.reasons), [`The payer's owner holds a Self Agent ID bound to the same verified human as the counterparty (same passport nullifier, read through Self's linked mode)${tail}`])
  const soloBack = await counterpartyCheck(agent(9907), agent(10000), null, deps)
  assert.equal(soloBack.sameHuman, true)
  assert.deepEqual(sameHumanReasons(soloBack.reasons), [`The counterparty's owner holds a Self Agent ID bound to the same verified human as the payer (same passport nullifier, read through Self's linked mode)${tail}`])
  const owners = await counterpartyCheck(agent(10000), agent(10001), null, deps)
  assert.equal(owners.sameHuman, true)
  assert.deepEqual(sameHumanReasons(owners.reasons), [`The payer's owner and the counterparty's owner each hold a Self Agent ID bound to the same verified human (same passport nullifier, read through Self's linked mode)${tail}`])

  // Both IDs keyed by the agents' own owners, the agent-key find: the reason it always gave.
  const keyed = await counterpartyCheck(agent(9907), agent(9908), null, deps)
  assert.equal(keyed.sameHuman, true)
  assert.deepEqual(sameHumanReasons(keyed.reasons), [`Payer and counterparty are bound to the same verified human in the Self Agent ID registry (same passport nullifier)${tail}`])

  // With the agent-key reads down, the payer's owner's one ID settles nothing: the read that did not
  // answer may have missed an ID keyed to the payer itself, bound to another human. So the payer the
  // healthy read above answered true for is null now, never a guessed true or false, and the
  // registry is not asked. The counterparty's ID is keyed to its owner, so it is still found by key.
  __resetSelfHolderIndexForTests()
  const keysDown = fakeCelo(registry.ids, {}, ['agentKeyToAgentId'])
  const outage: GatherDeps = {
    ...deps,
    readHumanProof: ((anchor: string, candidates: string[], opts: Parameters<typeof readHumanProofFor>[2] = {}) =>
      readHumanProofFor(anchor, candidates, { ...opts, reads: () => keysDown.reads })) as typeof readHumanProofFor,
  }
  const askedBefore = asked.length
  for (const [from, to] of [[10000, 9907], [9907, 10000]]) {
    const unsure = await counterpartyCheck(agent(from), agent(to), null, outage)
    assert.equal(unsure.sameHuman, null, `#${from} paying #${to} during an agent-key outage`)
    assert.deepEqual(sameHumanReasons(unsure.reasons), [], JSON.stringify(unsure.reasons))
  }
  assert.equal(asked.length, askedBefore)
})
