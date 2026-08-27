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

