import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'

import { CHAINS } from '../chains/index.js'
import { __resetPlatformStateForTests } from '../platform.js'
import { handleStellarVaultRoutes } from './stellar-vault-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * The route surface, at the boundary a frontend actually codes against.
 *
 * Everything with a decision in it is tested in ../stellar-vault.test.ts, where it is pure.
 * What is left here is the part a pure test cannot see: which status code each refusal
 * carries, that a refusal happens BEFORE any network call, and that a path this group does
 * not own is passed on rather than swallowed.
 *
 * Every case below is refused before an RPC handle is built, which is why this file is
 * offline. That is not a testing convenience: it is the property being asserted. A
 * malformed body, a stranger's wallet or an unknown vault must never cost a round trip,
 * because these two endpoints are reachable by anyone with a verified session.
 */

// Persistence off, and no agents, so `ownedVaults` is empty for every caller here.
__resetPlatformStateForTests()

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet')!
const VAULT = testnet.contracts.spendVault as string

/** The smallest ServerResponse a handler here actually uses. */
function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown> } = {}
  const headers: Record<string, unknown> = {}
  return {
    out,
    res: {
      setHeader: (k: string, v: unknown) => {
        headers[k] = v
      },
      writeHead(status: number) {
        out.status = status
        return this
      },
      end: (payload?: string) => {
        if (payload) out.body = JSON.parse(payload) as Record<string, unknown>
      },
    } as never,
  }
}

async function post(path: string, body: unknown, caller?: { subject: string; method: 'wallet' | 'email' }) {
  const { out, res } = fakeRes()
  const req = {
    method: 'POST',
    headers: {},
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return this
    },
  } as never
  const ctx: RouteCtx = {
    req,
    res,
    url: new URL(`http://localhost${path}`),
    caller: caller ? ({ subject: caller.subject, method: caller.method } as never) : null,
    callerId: caller?.subject,
  }
  const handled = await handleStellarVaultRoutes(ctx)
  return { handled, ...out }
}

test('a path this group does not own is passed on, not swallowed', async () => {
  const { handled } = await post('/api/agents/vault', {})
  assert.equal(handled, false, 'returning true here would shadow the Arc vault route')
})

test('a network that is not a Stellar chain is refused before anything else happens', async () => {
  // Never guessed. The two networks differ by a passphrase, and guessing is exactly how a
  // testnet signature ends up presented to pubnet.
  for (const network of [undefined, '', 'arc', 'eip155:5042002', 'stellar:nope']) {
    const r = await post('/api/stellar/vault/prepare', { network, contract: VAULT, source: Keypair.random().publicKey(), action: 'set_frozen', args: { frozen: true } })
    assert.equal(r.status, 400, `${String(network)} must not be accepted as a Stellar network`)
    assert.equal((r.body as { code?: string }).code, 'bad_request')
  }
})

test('an action outside the six is refused with the list, not with a generic error', async () => {
  const r = await post('/api/stellar/vault/prepare', {
    network: testnet.id,
    contract: VAULT,
    source: Keypair.random().publicKey(),
    action: 'pay',
    args: {},
  })
  assert.equal(r.status, 400)
  assert.match(String((r.body as { reason?: string }).reason), /set_policy/)
})

test('a caller who has not proven that wallet is refused 403, with no round trip spent', async () => {
  // The open-relay case, and the reason the cheap half of the gate runs first: an
  // unauthorized caller must not be able to make this server do an RPC call.
  const stranger = Keypair.random().publicKey()
  const r = await post(
    '/api/stellar/vault/prepare',
    { network: testnet.id, contract: VAULT, source: stranger, action: 'set_frozen', args: { frozen: true } },
    { subject: Keypair.random().publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 403)
  assert.equal((r.body as { code?: string }).code, 'not_your_wallet')
})

test('a contract neither the registry nor an owned agent names is 404, before any read', async () => {
  const me = Keypair.random()
  const r = await post(
    '/api/stellar/vault/prepare',
    {
      network: testnet.id,
      // A real contract id on this network (the USDC SAC), which is still not a vault of ours.
      contract: testnet.settlementTokens?.[0]?.address,
      source: me.publicKey(),
      action: 'set_frozen',
      args: { frozen: true },
    },
    { subject: me.publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 404)
  assert.equal((r.body as { code?: string }).code, 'unknown_vault')
})

test('bad arguments are caught before the wallet check, so the caller learns the real problem first', async () => {
  const me = Keypair.random()
  const r = await post(
    '/api/stellar/vault/prepare',
    { network: testnet.id, contract: VAULT, source: me.publicKey(), action: 'set_policy', args: { dailyCapUsd: 25, autoApproveUsd: 5 } },
    { subject: me.publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 400)
  assert.match(String((r.body as { reason?: string }).reason), /allowlistEnabled/)
})

test('submit refuses an envelope that is not one, without contacting the network', async () => {
  const me = Keypair.random()
  const r = await post(
    '/api/stellar/vault/submit',
    { network: testnet.id, xdr: 'this is not base64 XDR' },
    { subject: me.publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 400)
  assert.equal((r.body as { code?: string }).code, 'bad_request')
})

test('submit requires an xdr at all, and says which field is missing', async () => {
  const r = await post('/api/stellar/vault/submit', { network: testnet.id }, { subject: Keypair.random().publicKey(), method: 'wallet' })
  assert.equal(r.status, 400)
  assert.match(String((r.body as { reason?: string }).reason), /xdr/)
})
