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
