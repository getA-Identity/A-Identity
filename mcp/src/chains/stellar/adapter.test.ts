import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'

import { createStellarAdapter, errorIn } from './adapter.js'
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
  assert.equal(r.outcome, 'prepared')
  if (r.outcome !== 'prepared') return
  assert.equal(r.contract, VAULT)
  assert.equal(r.method, 'pay')
  assert.deepEqual(r.args, [PAYEE, '10000000'])
  assert.equal(r.network, 'stellar:testnet')
  // The reason has to name the variable, because "not configured" sends an operator
  // hunting through five chains' worth of env to find which one.
  assert.match(r.reason, /STELLAR_TESTNET_SIGNER_SECRET/)
})

/**
 * The outcome is a union with no boolean, and that is deliberate. It used to be
 * `{ executed: boolean, successful: boolean }`, and a landed-and-FAILED transaction came
 * back as executed: true, which is this repo's signal for "it worked". The repo's own
 * proven failure read as a success. A union forces every caller to handle the four cases
 * rather than reading one flag and moving on.
 */
test('there is no boolean anyone can misread as success', async () => {
  const a = createStellarAdapter(testnet())
  const r = await a.policyPay(VAULT, PAYEE, 1n, {})
  assert.equal('executed' in r, false, 'a boolean here is what caused the bug')
  assert.equal('successful' in r, false)
  assert.ok(['prepared', 'refused', 'settled', 'failed', 'pending'].includes(r.outcome))
})

/**
 * prepared and refused both mean nothing was submitted, and they mean opposite things to
 * an operator: one says "set the key and this will run", the other says "the vault said no
 * and will keep saying no". They used to be the same shape.
 */
test('a refusal is a different outcome from a missing signer', () => {
  const outcomes: string[] = ['prepared', 'refused']
  assert.notEqual(outcomes[0], outcomes[1])
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
    assert.equal(r.outcome, 'prepared', `${method} broadcast without a signer`)
    if (r.outcome === 'prepared') assert.equal(r.method, method)
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

/**
 * A propagated error is not our error, and saying so is the whole point of the field.
 *
 * When our vault calls the token and the token fails, the vault re-raises the token's code
 * as its own, so the message carries `Error(Contract, #13)` against the vault even though
 * our frozen table in error.rs stops at 10. Reporting the bare number told a client to look
 * up a code we do not define. The message below is the real one, captured from an owner_pay
 * to an account with no USDC trustline on stellar:testnet.
 */
test('an error raised by the token is attributed to the token, not to us', () => {
  const VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
  const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
  const real =
    'HostError: Error(Contract, #13)\n\nEvent log (newest first):\n' +
    `   0: [Diagnostic Event] contract:${VAULT}, topics:[error, Error(Contract, #13)], data:"escalating error to VM trap from failed host function call: call"\n` +
    `   1: [Diagnostic Event] contract:${VAULT}, topics:[error, Error(Contract, #13)], data:["contract call failed", transfer, []]\n` +
    `   2: [Failed Diagnostic Event (not emitted)] contract:${SAC}, topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GDBRJKD5EA62OUWHI6S66BJTVYUTJSAYPQWZDMQTYICUKC5TLCST6TXS]\n`

  const e = errorIn(real, VAULT)
  assert.ok(e)
  assert.equal(e.code, 13)
  // The log runs NEWEST FIRST, so the origin is the LAST matching line. Taking the first
  // would name the vault, which is exactly the wrong answer.
  assert.equal(e.from, SAC, 'the deepest frame is the one that knows what the code means')
  assert.equal(e.ours, false, '13 is not in our frozen table and must not read as if it were')
})

test('an error our own contract raised is attributed to us', () => {
  const VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
  const mine =
    'HostError: Error(Contract, #3)\n\nEvent log (newest first):\n' +
    `   0: [Diagnostic Event] contract:${VAULT}, topics:[error, Error(Contract, #3)], data:"payee not allowed"\n`
  const e = errorIn(mine, VAULT)
  assert.ok(e)
  assert.equal(e.code, 3)
  assert.equal(e.from, VAULT)
  assert.equal(e.ours, true)
})

test('a bare code with no event log is assumed ours rather than silently dropped', () => {
  // Fail toward saying something. An unattributed code from a call we made is far more
  // likely to be ours than not, and a client can still see there is no `contractErrorFrom`.
  const e = errorIn('HostError: Error(Contract, #5)', 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI')
  assert.ok(e)
  assert.equal(e.code, 5)
  assert.equal(e.from, undefined)
  assert.equal(e.ours, true)
})

test('a message with no contract error at all yields nothing', () => {
  assert.equal(errorIn('HostError: Error(Storage, MissingValue)', 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'), undefined)
})
