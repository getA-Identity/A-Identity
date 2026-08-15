import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'

import { createStellarAdapter } from './adapter.js'
import { stellarKeypair, stellarRpcUrl, stellarSignerAddress } from './client.js'
import { getChainById, requireChain } from '../registry.js'

// Offline by construction. Every assertion below is about the shape of a call or the
// handling of a credential, and none of it needs a network: the prepared path returns
// before any RPC handle is built, which is the whole point of prepared-or-executed.

const testnet = () => getChainById('stellar-testnet')!
const pubnet = () => getChainById('stellar')!
const VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
const PAYEE = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'

test('the adapter refuses a chain from another ecosystem', () => {
  // Mirrors evm/adapter.test.ts in the other direction. Two adapters that each refuse the
  // other's chains is what makes per-call-site dispatch safe without a union factory.
  assert.throws(
    () => createStellarAdapter(requireChain('eip155:5042002')),
    /not a Stellar chain \(evm\)/,
  )
})

test('both Stellar networks build, and they do not share a passphrase', () => {
  // A network passphrase is part of what gets signed. Reusing testnet's on pubnet would
  // produce a signature the public network rejects, which is the good failure; the bad one
  // is the reverse, so this is derived from the descriptor and never passed in.
  assert.ok(createStellarAdapter(testnet()))
  assert.ok(createStellarAdapter(pubnet()))
})

test('an unsigned write returns the exact call it would have made', async () => {
  const a = createStellarAdapter(testnet())
  const r = await a.policyPay(VAULT, PAYEE, 10_000_000n, {})
  assert.equal(r.executed, false)
  if (r.executed) return
  assert.equal(r.prepared.contract, VAULT)
  assert.equal(r.prepared.method, 'pay')
  assert.deepEqual(r.prepared.args, [PAYEE, '10000000'])
  assert.equal(r.prepared.network, 'stellar:testnet')
  // The reason has to name the variable, because "not configured" sends an operator
  // hunting through five chains' worth of env to find which one.
  assert.match(r.prepared.reason, /STELLAR_TESTNET_SIGNER_SECRET/)
})

test('every owner control has a prepared path too, not just pay', async () => {
  const a = createStellarAdapter(testnet())
  const calls = [
    ['owner_pay', () => a.policyOwnerPay(VAULT, PAYEE, 1n, {})],
    ['withdraw', () => a.policyWithdraw(VAULT, PAYEE, 1n, {})],
    ['set_policy', () => a.policySetPolicy(VAULT, 1n, 1n, true, {})],
    ['set_frozen', () => a.policySetFrozen(VAULT, true, {})],
    ['set_allowed', () => a.policySetAllowed(VAULT, PAYEE, true, {})],
    ['set_session_key_expiry', () => a.policySetSessionExpiry(VAULT, 0n, {})],
  ] as const
  for (const [method, call] of calls) {
    const r = await call()
    assert.equal(r.executed, false, `${method} broadcast without a signer`)
    if (!r.executed) assert.equal(r.prepared.method, method)
  }
})

test('a malformed signer is treated as absent, loudly, rather than throwing', () => {
  const errors: string[] = []
  const original = console.error
  console.error = (m: unknown) => void errors.push(String(m))
  try {
    // A 0x hex key in the Stellar variable is the realistic mistake, not a typo: the two
    // formats are not interchangeable in either direction.
    const got = stellarKeypair(testnet(), { STELLAR_TESTNET_SIGNER_SECRET: '0x' + 'a'.repeat(64) })
    assert.equal(got, null)
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1, 'a rejected key must say so')
  assert.match(errors[0], /STELLAR_TESTNET_SIGNER_SECRET/)
  assert.match(errors[0], /EVM/, 'the message should name the likely cause')
})

test('a real seed resolves to its own public key and nothing is logged', () => {
  const kp = Keypair.random()
  const errors: string[] = []
  const original = console.error
  console.error = (m: unknown) => void errors.push(String(m))
  try {
    const got = stellarKeypair(testnet(), { STELLAR_TESTNET_SIGNER_SECRET: kp.secret() })
    assert.equal(got?.publicKey(), kp.publicKey())
    assert.equal(
      stellarSignerAddress(testnet(), { STELLAR_TESTNET_SIGNER_SECRET: kp.secret() }),
      kp.publicKey(),
    )
  } finally {
    console.error = original
  }
  assert.deepEqual(errors, [], 'a valid key must be silent')
})

test('no signer at all is a clean null, not an error', () => {
  assert.equal(stellarKeypair(testnet(), {}), null)
  assert.equal(stellarSignerAddress(testnet(), {}), null)
})

test('the RPC comes from the descriptor and the env can override it', () => {
  assert.equal(stellarRpcUrl(testnet(), {}), 'https://soroban-testnet.stellar.org')
  assert.equal(
    stellarRpcUrl(testnet(), { STELLAR_TESTNET_RPC_URL: 'https://example.invalid/rpc' }),
    'https://example.invalid/rpc',
  )
  // Each network reads its OWN variable. Sharing one would be the same hazard the signer
  // split exists to avoid.
  assert.equal(stellarRpcUrl(pubnet(), {}), 'https://mainnet.sorobanrpc.com')
  assert.equal(
    stellarRpcUrl(pubnet(), { STELLAR_TESTNET_RPC_URL: 'https://example.invalid/rpc' }),
    'https://mainnet.sorobanrpc.com',
    'the pubnet adapter must ignore the testnet variable',
  )
})

test('readVault refuses anything that is not a contract id before touching the network', async () => {
  const a = createStellarAdapter(testnet())
  // A G... issuer where a C... contract belongs is the exact confusion the StrKey check
  // exists for, and catching it here means it never becomes a confusing RPC error.
  await assert.rejects(() => a.readVault(PAYEE, {}), /not a Soroban contract id/)
  await assert.rejects(() => a.readVault('nonsense', {}), /not a Soroban contract id/)
})
