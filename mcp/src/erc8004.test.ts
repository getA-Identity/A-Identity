/** Unit tests for the tokenURI SSRF guard - pure, offline. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafePublicHttpUrl } from './erc8004.js'

test('allows ordinary public http(s) URLs', () => {
  assert.equal(isSafePublicHttpUrl('https://example.com/agent.json'), true)
  assert.equal(isSafePublicHttpUrl('http://a-identity.xyz/meta'), true)
  assert.equal(isSafePublicHttpUrl('https://1.2.3.4/x'), true) // a public literal IP
})

test('blocks loopback, private ranges, and cloud metadata (SSRF)', () => {
  assert.equal(isSafePublicHttpUrl('http://169.254.169.254/latest/meta-data/'), false)
  assert.equal(isSafePublicHttpUrl('http://localhost:8545/'), false)
  assert.equal(isSafePublicHttpUrl('http://127.0.0.1/'), false)
  assert.equal(isSafePublicHttpUrl('http://10.0.0.5/'), false)
  assert.equal(isSafePublicHttpUrl('http://192.168.1.1/'), false)
  assert.equal(isSafePublicHttpUrl('http://172.16.0.1/'), false)
  assert.equal(isSafePublicHttpUrl('http://[::1]/'), false)
  assert.equal(isSafePublicHttpUrl('http://vault.internal/'), false)
})

test('blocks non-http(s) schemes and garbage', () => {
  assert.equal(isSafePublicHttpUrl('file:///etc/passwd'), false)
  assert.equal(isSafePublicHttpUrl('ftp://example.com/'), false)
  assert.equal(isSafePublicHttpUrl('data:application/json,{}'), false)
  assert.equal(isSafePublicHttpUrl('not a url'), false)
})

// ── bare token ids are chain-ambiguous ───────────────────────────────────────────

test('a bare token id is resolved on every identity chain, not just the first', async () => {
  // The bug this replaced: resolve stopped at the first chain in registry order, so typing
  // our own OKX agent number returned an unrelated Arc token's owner as if it were ours.
  // A fake client pair proves the branch without touching a live chain.
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([
    { chainId: 1, chainName: 'first', rpcUrl: 'http://unused', registry: '0x' + '1'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:1' },
    { chainId: 2, chainName: 'second', rpcUrl: 'http://unused', registry: '0x' + '2'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:2' },
  ])
  // Stub the per-chain read so both chains "own" the same token id.
  ;(provider as unknown as { _readToken: unknown })._readToken = async (
    _c: unknown,
    _h: unknown,
    client: { chainName: string; caipPrefix: string },
    tokenId: bigint,
  ) => ({
    agentId: `${client.caipPrefix}:8004/${tokenId}`,
    tokenId: Number(tokenId),
    owner: client.chainName === 'first' ? '0xaaa' : '0xbbb',
    registrationUri: '',
    domain: '',
    valid: true,
    registeredAt: '',
    chain: client.chainName,
  })

  const r = await provider.resolve('7')
  assert.ok(r?.ambiguity, 'a collision must be disclosed, not silently resolved')
  assert.equal(r.ambiguity.matches.length, 2)
  assert.deepEqual(r.ambiguity.matches.map((m) => m.chain), ['first', 'second'])
  assert.deepEqual(r.ambiguity.matches.map((m) => m.caip), ['eip155:1:8004/7', 'eip155:2:8004/7'])
  assert.ok(r.ambiguity.note.includes('does not identify one agent'))
})

test('a token id on exactly one chain carries no ambiguity flag', async () => {
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([
    { chainId: 1, chainName: 'only', rpcUrl: 'http://unused', registry: '0x' + '1'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:1' },
  ])
  ;(provider as unknown as { _readToken: unknown })._readToken = async () => ({
    agentId: 'eip155:1:8004/7', tokenId: 7, owner: '0xaaa', registrationUri: '', domain: '', valid: true,
    registeredAt: '', chain: 'only',
  })
  const r = await provider.resolve('7')
  assert.ok(r)
  assert.equal(r.ambiguity, undefined, 'no collision means no warning')
})

test('a full CAIP id never reports ambiguity, because it names its chain', async () => {
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([
    { chainId: 1, chainName: 'first', rpcUrl: 'http://unused', registry: '0x' + '1'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:1' },
    { chainId: 2, chainName: 'second', rpcUrl: 'http://unused', registry: '0x' + '2'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:2' },
  ])
  ;(provider as unknown as { _readToken: unknown })._readToken = async (
    _c: unknown, _h: unknown, client: { chainName: string }, tokenId: bigint,
  ) => ({ agentId: 'x', tokenId: Number(tokenId), owner: '0xaaa', registrationUri: '', domain: '', valid: true, registeredAt: '', chain: client.chainName })

  const r = await provider.resolve('eip155:2:8004/7')
  assert.equal(r?.chain, 'second', 'the named chain is the one read')
  assert.equal(r?.ambiguity, undefined)
})


// -- Stellar 8004 is a different registry, and must never read as an ERC-8004 answer ---

test('a Stellar 8004 id is answered by the third-party read, labeled third-party', async () => {
  // The routing matters more than the values: a u32 Soroban agent id and an ERC-8004 token
  // id are different identities that happen to be integers, so reading one with the other's
  // client would hand back a stranger. The read itself is injected; its own unit tests live
  // in chains/stellar/stellar8004.test.ts.
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const { getChainById } = await import('./chains/index.js')
  const registry = getChainById('stellar-testnet')!.contracts.stellar8004!.identity
  const provider = new RpcIdentityProvider([
    { chainId: 1, chainName: 'first', rpcUrl: 'http://unused', registry: '0x' + '1'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:1' },
  ])
  let evmReads = 0
  ;(provider as unknown as { _readToken: unknown })._readToken = async () => {
    evmReads += 1
    return null
  }
  ;(provider as unknown as { _readStellar8004: unknown })._readStellar8004 = async (
    chain: { id: string; explorer: string },
    agentId: number,
  ) => ({
    readable: true,
    found: true,
    source: 'third-party',
    live: true,
    chain: chain.id,
    registry: { identity: registry, owner: null, version: '0.1.0', totalAgents: 26, upgradeable: true, pendingUpgrade: null },
    agent: {
      id: agentId,
      owner: 'GBMFTESTONLYNOTAREALACCOUNT',
      wallet: null,
      agentUri: 'data:application/json,{}',
      agentUriKind: 'data',
      registration: { name: 'A-Identity Trust Oracle' },
    },
    label: `stellar:testnet:${registry}#${agentId}`,
    explorerUrl: `${chain.explorer}/contract/${registry}`,
    note: 'third-party registry note',
  })

  const r = await provider.resolve(`stellar:testnet:${registry}#25`)
  assert.ok(r, 'a Stellar 8004 id must resolve through the Stellar reader')
  assert.equal(evmReads, 0, 'no EVM registry may be dialed for a Soroban id')
  assert.equal(r.thirdParty, true, 'a caller must not be able to mistake this for an ERC-8004 read')
  assert.equal(r.chain, 'stellar-testnet', 'the chain is the registry slug, not a CAIP-2 id')
  assert.equal(r.agentId, `stellar:testnet:${registry}#25`)
  assert.equal(r.tokenId, 25)
  assert.equal(r.valid, false, 'a self-hosted registration document cannot mark itself verified')
  assert.equal(r.note, 'third-party registry note')
  assert.equal(r.stellar8004?.readable, true)
})

test('the short Stellar 8004 alias routes the same way', async () => {
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([])
  let asked: { chain: string; agentId: number } | null = null
  ;(provider as unknown as { _readStellar8004: unknown })._readStellar8004 = async (
    chain: { id: string },
    agentId: number,
  ) => {
    asked = { chain: chain.id, agentId }
    return { readable: true, found: false, source: 'third-party', live: true, chain: chain.id, registry: 'C', label: 'l', explorerUrl: 'e', reason: 'no such agent', note: 'n' }
  }
  const r = await provider.resolve('stellar8004:pubnet#7')
  assert.equal(r, null, 'an agent the registry does not have resolves to nothing, like every other miss')
  assert.deepEqual(asked, { chain: 'stellar', agentId: 7 })
})

test('a Stellar 8004 id naming a registry we do not declare is refused, never read on EVM', async () => {
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([
    { chainId: 1, chainName: 'first', rpcUrl: 'http://unused', registry: '0x' + '1'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:1' },
  ])
  let evmReads = 0
  ;(provider as unknown as { _readToken: unknown })._readToken = async () => {
    evmReads += 1
    return null
  }
  let stellarReads = 0
  ;(provider as unknown as { _readStellar8004: unknown })._readStellar8004 = async () => {
    stellarReads += 1
    return null
  }
  const r = await provider.resolve(`stellar:testnet:C${'A'.repeat(55)}#25`)
  assert.equal(r, null)
  assert.equal(stellarReads, 0, 'a registry we do not declare is not read against ours')
  assert.equal(evmReads, 0, 'and the number is not retried as an ERC-8004 token id')
})

test('every EVM query still takes the EVM path unchanged', async () => {
  // The guard against the Stellar branch quietly swallowing something: the shapes are
  // disjoint, so a bare id, a CAIP id and an address must all reach the EVM reader.
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([
    { chainId: 1, chainName: 'only', rpcUrl: 'http://unused', registry: '0x' + '1'.repeat(40) as `0x${string}`, caipPrefix: 'eip155:1' },
  ])
  const seen: string[] = []
  ;(provider as unknown as { _readToken: unknown })._readToken = async (
    _c: unknown, _h: unknown, client: { chainName: string }, tokenId: bigint,
  ) => {
    seen.push(String(tokenId))
    return { agentId: 'x', tokenId: Number(tokenId), owner: '0xaaa', registrationUri: '', domain: '', valid: true, registeredAt: '', chain: client.chainName }
  }
  assert.ok(await provider.resolve('25'))
  assert.ok(await provider.resolve('eip155:1:8004/25'))
  assert.deepEqual(seen, ['25', '25'])
})

// -- registration dates: read from the chain or reported unknown, never invented --------

const DATE_REG = ('0x' + '1'.repeat(40)) as `0x${string}`
const DATE_CHAIN = { chainId: 1, chainName: 'only', rpcUrl: 'http://unused', registry: DATE_REG, caipPrefix: 'eip155:1' }
const MINT_TX = ('0x' + 'a'.repeat(64)) as `0x${string}`
const OTHER_TX = ('0x' + 'b'.repeat(64)) as `0x${string}`
const topicOf = (n: bigint | string) => '0x' + BigInt(n).toString(16).padStart(64, '0')
/** Written out by hand so a typo in the module's constant cannot hide behind itself. */
const TRANSFER_TOPIC_FOR_TEST = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Drive the real `_readToken` with no network: a fake viem client for the chain reads and a
 * stubbed fetch for the tokenURI. `card` is the registration file (null makes tokenURI
 * revert); `receipts` maps a tx hash to what the chain would answer for it.
 */
async function readTokenWith(
  card: Record<string, unknown> | null,
  receipts: Record<string, unknown> = {},
  blockTimestamp = 0n,
) {
  const { RpcIdentityProvider } = await import('./erc8004.js')
  const provider = new RpcIdentityProvider([DATE_CHAIN])
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'ownerOf') return '0x' + 'c'.repeat(40)
      if (functionName === 'tokenURI' && card) return 'https://agent.example/card.json'
      throw new Error('execution reverted')
    },
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (!(hash in receipts)) throw new Error('receipt not found')
      return receipts[hash]
    },
    getBlock: async () => ({ timestamp: blockTimestamp }),
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(card ?? {}), { status: 200 })) as typeof fetch
  try {
    return await (provider as unknown as {
      _readToken: (c: unknown, h: unknown, chain: typeof DATE_CHAIN, id: bigint) => Promise<Record<string, unknown> | null>
    })._readToken(() => client, () => undefined, DATE_CHAIN, 0n)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('an undated registration reports registeredAt unknown, never the day it was asked', async () => {
  // The bug: the EVM read defaulted registeredAt to TODAY, so our Arc Mainnet agent #0,
  // minted 2026-09-16 with a registration file that carries no date, was reported as
  // registered on whatever day anyone resolved it.
  const plain = await readTokenWith({ name: 'agent' })
  assert.equal(plain?.registeredAt, '', 'no date anywhere means unknown')
  assert.equal(plain?.registeredAtSource, undefined)

  const reverted = await readTokenWith(null)
  assert.ok(reverted, 'an unreadable tokenURI still resolves the identity')
  assert.equal(reverted.registeredAt, '')

  // A registration file that names a transaction which did NOT mint this token earns nothing:
  // here the receipt holds an ERC-20 style Transfer (three topics) and a mint of token 7.
  const misleading = await readTokenWith(
    { registrations: [{ chain: 'eip155:1', registry: DATE_REG, agentId: '0', tx: OTHER_TX }] },
    {
      [OTHER_TX]: {
        status: 'success',
        blockNumber: 5n,
        logs: [
          { address: DATE_REG, topics: [TRANSFER_TOPIC_FOR_TEST, topicOf(0n), topicOf(9n)] },
          { address: DATE_REG, topics: [TRANSFER_TOPIC_FOR_TEST, topicOf(0n), topicOf(9n), topicOf(7n)] },
        ],
      },
    },
    1_000n,
  )
  assert.equal(misleading?.registeredAt, '', 'a pointer the chain does not back is ignored')

  // A date the agent wrote about itself is kept, normalized, and labeled as its own word;
  // one that is not a date is dropped rather than passed through.
  const selfDated = await readTokenWith({ registeredAt: '2025-01-02T10:00:00Z' })
  assert.equal(selfDated?.registeredAt, '2025-01-02')
  assert.equal(selfDated?.registeredAtSource, 'self-reported')
  const garbage = await readTokenWith({ registeredAt: 'yesterday' })
  assert.equal(garbage?.registeredAt, '')
  const notAString = await readTokenWith({ registeredAt: 20250102 })
  assert.equal(notAString?.registeredAt, '')
})

test('a mint named by the registration file is verified on chain and dated by its block', async () => {
  const { TRANSFER_TOPIC, mintTxHint, receiptMintsToken } = await import('./erc8004.js')
  const { toEventSelector } = await import('viem')
  assert.equal(TRANSFER_TOPIC, toEventSelector('Transfer(address,address,uint256)'))
  assert.equal(TRANSFER_TOPIC_FOR_TEST, TRANSFER_TOPIC)

  const mintReceipt = {
    status: 'success',
    blockNumber: 100n,
    logs: [{ address: DATE_REG.toUpperCase().replace('0X', '0x'), topics: [TRANSFER_TOPIC, topicOf(0n), topicOf('0x' + 'c'.repeat(40)), topicOf(0n)] }],
  }
  const minted = await readTokenWith(
    {
      // The on-chain date wins over whatever the file claims about itself.
      registeredAt: '2020-01-01',
      registrations: [{ chain: 'eip155:1', registry: DATE_REG, agentId: '0', caip: `eip155:1:${DATE_REG}/0`, tx: MINT_TX }],
    },
    { [MINT_TX]: mintReceipt },
    BigInt(Date.parse('2026-09-16T12:19:45Z') / 1000),
  )
  assert.equal(minted?.registeredAt, '2026-09-16')
  assert.equal(minted?.registeredAtSource, 'onchain-mint')

  // A reverted mint transaction proves nothing.
  assert.equal(receiptMintsToken({ ...mintReceipt, status: 'reverted' }, DATE_REG, 0n), false)
  // Another contract minting the same id is not this registry's mint.
  assert.equal(receiptMintsToken(mintReceipt, '0x' + '2'.repeat(40), 0n), false)
  assert.equal(receiptMintsToken(mintReceipt, DATE_REG, 1n), false)
  assert.equal(receiptMintsToken(null, DATE_REG, 0n), false)

  // The hint is matched on registry AND token id, in both the ERC-8004 file form and ours.
  assert.equal(mintTxHint([{ agentRegistry: `eip155:1:${DATE_REG}`, agentId: 0, tx: MINT_TX }], 'eip155:1', DATE_REG, 0n), MINT_TX)
  assert.equal(mintTxHint([{ caip: `eip155:1:${DATE_REG}/0`, agentId: '0', tx: MINT_TX }], 'eip155:1', DATE_REG, 0n), MINT_TX)
  assert.equal(mintTxHint([{ chain: 'eip155:2', registry: DATE_REG, agentId: '0', tx: MINT_TX }], 'eip155:1', DATE_REG, 0n), null)
  assert.equal(mintTxHint([{ chain: 'eip155:1', registry: DATE_REG, agentId: '1', tx: MINT_TX }], 'eip155:1', DATE_REG, 0n), null)
  assert.equal(mintTxHint([{ chain: 'eip155:1', registry: DATE_REG, agentId: '0', tx: '0x1234' }], 'eip155:1', DATE_REG, 0n), null)
  assert.equal(mintTxHint('not a list', 'eip155:1', DATE_REG, 0n), null)
})
