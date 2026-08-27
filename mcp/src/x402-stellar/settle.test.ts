/**
 * The settle path, tested against a REAL signed authorization entry.
 *
 * ENTRY below is the exact `SorobanAuthorizationEntry` the buyer signed for our own
 * testnet settlement 3da74634 (ledger 4147945): payer GBRKRUDY..., nonce
 * 6270564785915702252, expiring at ledger 4148373, authorizing
 * transfer(GBRKRUDY..., GBMRWLL7..., 2500000) on the testnet USDC SAC. Every field these
 * tests assert was produced by a real wallet against the real network, so a change that
 * makes the decoder or the signature check wrong cannot pass by agreeing with a fixture I
 * invented.
 *
 * The corrupted variants are built by mutating those bytes, which is the only honest way
 * to test a rejection: a hand-written "bad signature" tests the error message, not the
 * check.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Account, Keypair, Networks, SorobanDataBuilder, hash, xdr } from '@stellar/stellar-sdk'

import { getChainById } from '../chains/registry.js'
import { loadStellarSettlementsResult } from '../storage.js'
import type { StellarSettlementRecord } from '../storage.js'
import type { SettlementToken } from '../chains/types.js'
import {
  decodeAuthEntry,
  parseStellarPayload,
  redeemStellarPayment,
  schemeOf,
  stellarTxKey,
  settleStellarPayment,
  stellarPaymentKey,
  feeSpentOnDay,
  FEE_BUDGET_UNKNOWN,
  verifyAuthSignature,
  verifyStellarPayment,
} from './settle.js'
import type { StellarLimits, StellarRequirements, StellarSettleDeps } from './settle.js'

const ENTRY =
  'AAAAAQAAAAAAAAAAYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMlXBYVzLZQr7AA/TJUAAAAQAAAAAQAAAAEAAAARAAAAAQAAAAIAAAAPAAAACnB1YmxpY19rZXkAAAAAAA0AAAAgYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMkAAAAPAAAACXNpZ25hdHVyZQAAAAAAAA0AAABAjn7CW0+QUgPtXwm1MafD+9JMISgUJ9J2efq4vnp+3LPGoq0CJ2dnTEw7NmDX/ftrPq4S3G9li7qF1FPX1lTCCwAAAAAAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwEAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAAYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMkAAAASAAAAAAAAAABZGy1/LOzYZLW15i28Rz04tIJDNYAx05S+BK1YvpESBgAAAAoAAAAAAAAAAAAAAAAAJiWgAAAAAA=='

const CHAIN = getChainById('stellar-testnet')!
const PUBNET = getChainById('stellar')!
const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const BUYER = 'GBRKRUDYKYOSGH4QIYAFONPWXFCFC7K5AYHIVJDNYJAZ33BE5YSMTS6R'
const SELLER = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
const NONCE = '6270564785915702252'
const EXPIRES_AT = 4_148_373
const PAID = 2_500_000n
const TX = '3da74634e2b09b3e1c15c53a1a0e6d1c1e3f3b2a5d4c6e7f8a9b0c1d2e3f4a5b'

const TOKEN: SettlementToken = {
  symbol: 'USDC',
  address: SAC,
  decimals: 7,
  authorization: 'soroban-auth',
  verified: 'derived with `stellar contract id asset` and matched against the literal',
}

const REQ: StellarRequirements = {
  network: 'stellar:testnet',
  asset: SAC,
  payTo: SELLER,
  maxAmountRequired: PAID.toString(),
  resource: '/api/x402/stellar/tools/find_agent',
}

const LIMITS: StellarLimits = {
  minValue: 1n,
  maxValue: 100_000_000n,
  expiryHeadroomLedgers: 10,
  maxFeeStroops: 1_000_000n,
  dailyFeeStroops: 100_000_000n,
}

const payload = (x = ENTRY) => ({ authEntryXdr: x })

/** A ledger far enough behind the expiry that the headroom guard is satisfied. */
const ledgerServer = (sequence: number) => ({
  getLatestLedger: async () => ({ sequence }) as never,
  getAccount: async () => ({}) as never,
  simulateTransaction: async () => ({}) as never,
  sendTransaction: async () => ({}) as never,
})

const baseDeps = (over: Partial<StellarSettleDeps> = {}): StellarSettleDeps => ({
  env: {},
  server: ledgerServer(EXPIRES_AT - 100),
  loadSpent: async () => [],
  persistSpent: async () => {},
  persist: async () => {},
  ...over,
})

// ── decoding real bytes ──────────────────────────────────────────────────────────────

test('a real signed entry decodes to exactly what the buyer authorized', () => {
  const p = parseStellarPayload(payload())
  assert.equal(p.ok, true)
  if (!p.ok) return
  const d = decodeAuthEntry(p.entry)
  assert.equal(d.ok, true, d.ok ? '' : d.reason)
  if (!d.ok) return
  assert.equal(d.auth.payer, BUYER)
  assert.equal(d.auth.nonce, NONCE)
  assert.equal(d.auth.expirationLedger, EXPIRES_AT)
  assert.equal(d.auth.contract, SAC)
  assert.equal(d.auth.fn, 'transfer')
  assert.equal(d.auth.from, BUYER)
  assert.equal(d.auth.to, SELLER)
  assert.equal(d.auth.amount, PAID)
})

test('a payload without authEntryXdr is refused rather than half-read', () => {
  for (const bad of [null, 'a string', {}, { authEntryXdr: '' }, { authEntryXdr: 'not-xdr' }]) {
    const r = parseStellarPayload(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not parse`)
  }
})

/**
 * Source-account credentials authorize whoever SUBMITS the transaction. On this rail we
 * submit, so accepting one would make us the payer of a transfer we are being asked to
 * broadcast. It is not a malformed payload; it is a well-formed authorization for the
 * wrong party, which is why it has its own code.
 */
test('source-account credentials are refused with their own reason', () => {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: xdr.SorobanAuthorizationEntry.fromXDR(ENTRY, 'base64').rootInvocation(),
  })
  const d = decodeAuthEntry(entry)
  assert.equal(d.ok, false)
  if (!d.ok) {
    assert.equal(d.code, 'source_account_credentials')
    assert.match(d.reason, /we submit, so that would make us the payer/)
  }
})

// ── the signature, checked against the real one ──────────────────────────────────────

test('the real signature verifies over the network it was signed for', () => {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(ENTRY, 'base64')
  const d = decodeAuthEntry(entry)
  assert.equal(d.ok, true)
  if (!d.ok) return
  assert.deepEqual(verifyAuthSignature(CHAIN, d.auth), { ok: true })
})

/**
 * The load-bearing property of a rail that sells on two networks: the network id is inside
 * the preimage, so the SAME bytes that are valid on testnet must be worthless on pubnet.
 * If this ever passes, a buyer can pay us in play money and get a real answer.
 */
test('a testnet signature does not verify against pubnet', () => {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(ENTRY, 'base64')
  const d = decodeAuthEntry(entry)
  assert.equal(d.ok, true)
  if (!d.ok) return
  const r = verifyAuthSignature(PUBNET, d.auth)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /different network passphrase/)
})

test('one flipped byte in the signature is caught', () => {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(ENTRY, 'base64')
  // A real entry wraps the {public_key, signature} map in a VEC, because Soroban allows an
  // account to satisfy one authorization with several signatures. Reading it as a bare map
  // throws, which is how this test found out rather than assuming.
  const sigVec = entry.credentials().address().signature().vec()!
  const sigMap = sigVec[0].map()!
  const sigBytes = Buffer.from(sigMap[1].val().bytes())
  sigBytes[0] ^= 0x01
  sigMap[1] = new xdr.ScMapEntry({ key: sigMap[1].key(), val: xdr.ScVal.scvBytes(sigBytes) })
  entry.credentials().address().signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap(sigMap)]))

  const d = decodeAuthEntry(entry)
  assert.equal(d.ok, true)
  if (!d.ok) return
  const r = verifyAuthSignature(CHAIN, d.auth)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /does not verify/)
})

/**
 * A valid signature by the WRONG key. This is the attack the shape check alone would miss:
 * the entry is credentialed to the buyer, the bytes are a real ed25519 signature, and only
 * comparing the embedded public key to the credentialed address catches it.
 */
test('a real signature from a different key does not pass as the payer', () => {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(ENTRY, 'base64')
  const attacker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7))
  const ca = entry.credentials().address()
  const digest = hash(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: ca.nonce(),
        signatureExpirationLedger: ca.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    ).toXDR(),
  )
  ca.signature(
    xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(attacker.rawPublicKey()) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(attacker.sign(digest)) }),
      ]),
    ]),
  )

  const d = decodeAuthEntry(entry)
  assert.equal(d.ok, true)
  if (!d.ok) return
  const r = verifyAuthSignature(CHAIN, d.auth)
  assert.equal(r.ok, false, 'a valid signature by the wrong key must not be accepted')
  if (!r.ok) assert.match(r.reason, /credentialed to .* but signed by/)
})

// ── verify, end to end ───────────────────────────────────────────────────────────────

test('a payment matching the quote verifies', async () => {
  const r = await verifyStellarPayment({ chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS, deps: baseDeps() })
  assert.equal(r.isValid, true, r.isValid ? '' : r.invalidReason)
  if (r.isValid) {
    assert.equal(r.auth.payer, BUYER)
    assert.equal(r.key, stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE))
  }
})

test('requirements naming another network are refused before anything is decoded', async () => {
  const r = await verifyStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: { ...REQ, network: 'stellar:pubnet' },
    payload: payload(), limits: LIMITS, deps: baseDeps(),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'unsupported_network')
})

test('paying the right amount to the wrong account is not a payment to us', async () => {
  const r = await verifyStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: { ...REQ, payTo: BUYER },
    payload: payload(), limits: LIMITS, deps: baseDeps(),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'wrong_recipient')
})

test('exact means exact, in both directions', async () => {
  for (const [asked, label] of [['2400000', 'underpay'], ['2600000', 'overpay']] as const) {
    const r = await verifyStellarPayment({
      chain: CHAIN, token: TOKEN, requirements: { ...REQ, maxAmountRequired: asked },
      payload: payload(), limits: LIMITS, deps: baseDeps(),
    })
    assert.equal(r.isValid, false, `${label} must be refused`)
    if (!r.isValid) assert.equal(r.code, 'wrong_amount')
  }
})

test('an authorization for a different contract is not our asset', async () => {
  const other: SettlementToken = { ...TOKEN, address: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' }
  const r = await verifyStellarPayment({ chain: CHAIN, token: other, requirements: { ...REQ, asset: other.address }, payload: payload(), limits: LIMITS, deps: baseDeps() })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'unsupported_asset')
})

test('a signature whose expiry the ledger has passed is expired, not merely tight', async () => {
  const r = await verifyStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({ server: ledgerServer(EXPIRES_AT + 1) }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) {
    assert.equal(r.code, 'expired')
    assert.match(r.invalidReason, /the network is at/)
  }
})

/**
 * The headroom guard, in LEDGERS. Nine left against a floor of ten: still valid, and still
 * refused, because a signature that expires while we are submitting costs us the fee and
 * shows the buyer a failure indistinguishable from a bad signature.
 */
test('a signature with too few ledgers left is refused before we spend a fee on it', async () => {
  const r = await verifyStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({ server: ledgerServer(EXPIRES_AT - 9) }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) {
    assert.equal(r.code, 'expiring_too_soon')
    assert.match(r.invalidReason, /Nothing was broadcast/)
  }
})

test('an authorization already in the spent set cannot be redeemed twice', async () => {
  const key = stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE)
  const r = await verifyStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({ loadSpent: async () => [key] }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'already_redeemed')
})

/**
 * Fail CLOSED. An unreadable replay guard means we cannot know whether this was redeemed,
 * and the only safe answer to that is no. The dangerous alternative reads as resilience.
 */
test('an unreadable replay guard refuses rather than passing', async () => {
  const r = await verifyStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({ loadSpent: async () => { throw new Error('db down') } }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) {
    assert.equal(r.code, 'rpc_error')
    assert.match(r.invalidReason, /refusing rather than risking a replay/)
  }
})

test('the replay key is namespaced so it cannot collide with the EVM rails', () => {
  const key = stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE)
  assert.equal(key, `stellar:testnet/sep41:${SAC}/soroban-auth/${BUYER}/${NONCE}`.toLowerCase())
  assert.doesNotMatch(key, /erc20|3009|^0x/)
})

/**
 * The bug this test exists for, which a unit suite could not have found: persistSpentPayment
 * lowercases what it stores, having been written for EVM hashes where that is free. A
 * StrKey is case-significant, so a key written through that normaliser came back different
 * from the one we compare against, and our own replay guard never fired on Stellar at all.
 * It surfaced only by replaying a real payment against the live rail.
 *
 * The property, stated so it cannot regress: a key must survive the store's normalisation
 * unchanged. Anything else means writing one string and reading for another.
 */
test('the replay key survives the durable store normalisation unchanged', () => {
  const key = stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE)
  assert.equal(key, key.toLowerCase(), 'persistSpentPayment lowercases; a key that changes there is never found again')
  // And still unique: base32 A-Z2-7 maps one-to-one onto lowercase, so nothing collides.
  const other = stellarPaymentKey('stellar:testnet', SAC, SELLER, NONCE)
  assert.notEqual(key, other)
})

// ── settle, and what "settled" is allowed to mean ────────────────────────────────────

const settleDeps = (over: Partial<StellarSettleDeps> = {}): StellarSettleDeps =>
  baseDeps({
    broadcaster: 'oz',
    ozSubmit: async () => ({ ok: true, txHash: TX }),
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key' },
    meta: { tool: 'find_agent', baseUsd: 0.25 },
    ...over,
  })

const confirmed = (over: Record<string, unknown> = {}) =>
  (async () => ({
    confirmed: true, txHash: TX, ledger: 4_147_945, from: BUYER,
    amountRaw: PAID.toString(), asset: SAC, authNonce: NONCE, ...over,
  })) as never

test('a settlement is a sale only when our own read confirms it', async () => {
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({ confirm: confirmed(), persist: async (rec) => { rows.push(rec) } }),
  })
  assert.equal(r.success, true, r.success ? '' : r.errorReason)
  if (r.success) {
    assert.equal(r.transaction, TX)
    assert.equal(r.ledger, 4_147_945)
    assert.equal(r.broadcaster, 'oz')
    assert.match(r.explorerUrl, /stellar\.expert.*\/tx\//)
  }
  assert.equal(rows.length, 1)
  const rec = rows[0] as Record<string, unknown>
  assert.equal(rec.outcome, 'settled')
  // The field that makes the sentence mean something when a third party moved the money.
  assert.equal(rec.confirmedBy, 'soroban-rpc')
  assert.equal(rec.broadcaster, 'oz')
})

/**
 * The deliberate negative test the plan calls the whole honesty posture in one case: a
 * broadcaster claims success with a hash that never landed. Nothing may be sold, and the
 * row must say ambiguous rather than reverted, because "we could not see it" is not
 * "the ledger rejected it".
 */
test('a facilitator reporting a hash that never landed sells nothing', async () => {
  const rows: Record<string, unknown>[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({
      confirm: (async () => ({ confirmed: false, txHash: TX, code: 'not_found', reason: 'not visible after 30s' })) as never,
      persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) },
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'unconfirmed')
    assert.equal(r.ambiguous, true)
    assert.equal(r.transaction, TX)
  }
  assert.equal(rows[0].outcome, 'ambiguous')
})

test('a transaction that landed and failed is reverted, which is a decision', async () => {
  const rows: Record<string, unknown>[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({
      confirm: (async () => ({ confirmed: false, txHash: TX, code: 'tx_failed', reason: 'landed and failed', ledger: 4_147_945 })) as never,
      persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) },
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'settlement_failed')
    assert.equal(r.ambiguous, undefined, 'a landed failure is not ambiguous')
  }
  assert.equal(rows[0].outcome, 'reverted')
})

/**
 * The blindness codes must not be collapsible into the verdict code. This is the same
 * distinction confirm.ts draws between no_event_data and no_matching_transfer, enforced one
 * layer up so a future edit cannot quietly merge them.
 */
test('every unconfirmed reason stays unconfirmed, and only tx_failed reverts', async () => {
  for (const code of ['not_found', 'beyond_retention', 'no_matching_transfer', 'no_event_data', 'wrong_authorization', 'unreachable']) {
    const rows: Record<string, unknown>[] = []
    const r = await settleStellarPayment({
      chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
      deps: settleDeps({
        confirm: (async () => ({ confirmed: false, txHash: TX, code, reason: code })) as never,
        persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) },
      }),
    })
    assert.equal(r.success, false)
    if (!r.success) assert.equal(r.code, 'unconfirmed', `${code} must not read as a decision`)
    assert.equal(rows[0].outcome, 'ambiguous', `${code} must not be recorded as reverted`)
  }
})

test('a chain with no fee payer and no OZ key refuses cleanly instead of crashing', async () => {
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({ env: {}, confirm: confirmed() }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'no_broadcaster')
    assert.match(r.errorReason, /Nothing was\s+submitted and nothing was charged/)
  }
})

test('X402_STELLAR_FACILITATOR=oz without a key does not silently fall back to us', async () => {
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({
      env: { X402_STELLAR_FACILITATOR: 'oz', X402_STELLAR_TESTNET_FEE_PAYER: 'SBAA3EOGVYIOBPZJZBNPQJ3F6VD3ZFTLGCLJ4X4WLQBRJBQBSY7AR4CE' },
      confirm: confirmed(),
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'no_broadcaster')
})

test('an OZ refusal is reported as a broadcast failure and records nothing', async () => {
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({
      ozSubmit: async () => ({ ok: false, reason: 'channel out of funds' }),
      persist: async (rec) => { rows.push(rec) },
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'broadcast_failed')
    assert.match(r.errorReason, /channel out of funds/)
  }
  assert.equal(rows.length, 0, 'nothing was broadcast, so there is nothing to record')
})

/**
 * An OZ REFUSAL and an OZ THROW are different things and must not share an answer.
 *
 * A refusal is decided: they looked at it and said no, so nothing was submitted. A throw is
 * not: the request may never have left, or it may have arrived and the response not come
 * back, and nothing on this side can tell those apart. broadcastOurselves has said exactly
 * that in a comment since it was written and returns `ambiguous`. The OZ path returned a
 * plain broadcast_failed, so the caller answered 502 and told a buyer their payment had
 * failed when OZ may well have submitted it.
 */
test('an OZ throw is undecided, not a failure', async () => {
  const rows: { outcome?: string }[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({
      ozSubmit: async () => { throw new Error('socket hang up') },
      persist: async (rec) => { rows.push(rec as { outcome?: string }) },
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.ambiguous, true, 'a throw cannot be reported as a decided failure')
    assert.equal(r.code, 'unconfirmed')
    assert.match(r.errorReason, /cannot tell whether it submitted/)
    assert.equal(r.transaction, undefined, 'OZ assembles the envelope, so there is no hash to hand back')
  }
  // No hash means no row anyone could act on, which is the same rule the native path uses.
  assert.equal(rows.length, 0)
})

test('an OZ refusal is still decided, so the two do not collapse into one answer', async () => {
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({ ozSubmit: async () => ({ ok: false, reason: 'channel out of funds' }) }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'broadcast_failed')
    assert.notEqual(r.ambiguous, true, 'OZ answered, so this is a verdict and not an unknown')
  }
})

test('a verify failure never reaches a broadcaster', async () => {
  let called = false
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: { ...REQ, payTo: BUYER }, payload: payload(), limits: LIMITS,
    deps: settleDeps({ ozSubmit: async () => { called = true; return { ok: true, txHash: TX } } }),
  })
  assert.equal(r.success, false)
  assert.equal(called, false, 'a payment to the wrong account must not be broadcast')
})

test('the replay key is written only after the money is confirmed', async () => {
  const written: string[] = []
  await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({
      confirm: (async () => ({ confirmed: false, txHash: TX, code: 'not_found', reason: 'x' })) as never,
      persistSpent: async (k: string) => { written.push(k) },
    }),
  })
  // Not deepEqual against [], which narrows `written` to never[] for the rest of the test.
  assert.equal(written.length, 0, 'an unconfirmed settlement must stay redeemable')

  await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({ confirm: confirmed(), persistSpent: async (k: string) => { written.push(k) } }),
  })
  // TWO keys, and the second is the fix for a real hole found by an adversarial review and
  // then reproduced live: the authorization namespace and the hash namespace were disjoint,
  // so a transaction we broadcast and were paid for could be re-presented on the `settled`
  // scheme and sell the tool again. Burning both is what makes one payment one sale.
  assert.deepEqual(written.sort(), [
    stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE),
    stellarTxKey('stellar:testnet', TX),
  ].sort())
})

/**
 * The hole itself, as a test. Settle through soroban-auth, then try the same hash on the
 * settled scheme against the spent set the first path actually wrote.
 */
test('a payment we already settled cannot be re-sold through the settled scheme', async () => {
  const spent: string[] = []
  const VAULT_ISH = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
  await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({ confirm: confirmed(), persistSpent: async (k: string) => { spent.push(k) } }),
  })
  const again = await redeemStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT_ISH,
    deps: baseDeps({ loadSpent: async () => spent, confirm: confirmed() }),
  })
  assert.equal(again.success, false, 'one payment, one sale')
  if (!again.success) assert.equal(again.code, 'already_redeemed')
})

/**
 * The restriction that closes the hole at its source rather than after the fact. A plain
 * account can sign an authorization entry, so it never needs the weaker binding; letting one
 * in is what made a gasless purchase re-presentable at all.
 */
test('the settled scheme refuses an account payer and points at the better path', async () => {
  const r = await redeemStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: BUYER,
    deps: redeemDeps(),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'malformed_payload')
    assert.match(r.errorReason, /not a Soroban contract id/)
    assert.match(r.errorReason, /send authEntryXdr instead/)
  }
})

test('a failed replay-guard write is loud but does not undo a completed sale', async () => {
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: settleDeps({
      confirm: confirmed(),
      persistSpent: async () => { throw new Error('db down') },
    }),
  })
  assert.equal(r.success, true, 'the money moved; a bookkeeping failure must not report otherwise')
})

// ── the `settled` scheme: a payment the buyer already made ───────────────────────────

test('the scheme is decided by what the payload carries, not by what it claims', () => {
  assert.deepEqual(schemeOf({ authEntryXdr: ENTRY }), { ok: true, scheme: 'soroban-auth' })
  assert.deepEqual(schemeOf({ txHash: TX }), { ok: true, scheme: 'settled' })
  // Both is refused rather than resolved in someone's favour: there is no reading of that
  // payload where guessing is better than asking.
  const both = schemeOf({ authEntryXdr: ENTRY, txHash: TX })
  assert.equal(both.ok, false)
  if (!both.ok) assert.match(both.reason, /send one/)
  assert.equal(schemeOf({}).ok, false)
  assert.equal(schemeOf(null).ok, false)
})

const VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'

const redeemDeps = (over: Partial<StellarSettleDeps> = {}): StellarSettleDeps =>
  baseDeps({
    confirm: (async () => ({
      confirmed: true, txHash: TX, ledger: 4_149_294, from: VAULT,
      amountRaw: PAID.toString(), asset: SAC, authNonce: '', binding: 'tx-hash',
    })) as never,
    meta: { tool: 'risk_check', baseUsd: 0.005 },
    ...over,
  })

test('a payment made through the vault is redeemed and recorded as the buyer having paid', async () => {
  const rows: Record<string, unknown>[] = []
  const r = await redeemStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT,
    deps: redeemDeps({ persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) } }),
  })
  assert.equal(r.success, true, r.success ? '' : r.errorReason)
  if (r.success) {
    assert.equal(r.payer, VAULT)
    // Zero, and it must be: we broadcast nothing here. Recording 'self' with a fee would
    // credit us with a cost the agent actually paid, in the field that exists to say who did.
    assert.equal(r.feeStroops, '0')
    assert.equal(r.broadcaster, 'buyer')
  }
  assert.equal(rows[0].outcome, 'settled')
  assert.equal(rows[0].broadcaster, 'buyer')
  assert.equal(rows[0].payer, VAULT)
  assert.equal(rows[0].confirmedBy, 'soroban-rpc', 'whoever paid, we still read it ourselves')
})

test('the same hash cannot be redeemed twice', async () => {
  const key = stellarTxKey('stellar:testnet', TX)
  const r = await redeemStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT,
    deps: redeemDeps({ loadSpent: async () => [key] }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'already_redeemed')
})

test('the redemption key survives the store normalisation, like its sibling', () => {
  const key = stellarTxKey('stellar:testnet', TX)
  assert.equal(key, key.toLowerCase())
  assert.notEqual(key, stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE))
})

test('a hash that is not a Stellar hash is refused before any network call', async () => {
  let looked = false
  for (const bad of [`0x${TX}`, TX.toUpperCase(), 'nope', '']) {
    const r = await redeemStellarPayment({
      chain: CHAIN, token: TOKEN, requirements: REQ, txHash: bad, from: VAULT,
      deps: redeemDeps({ confirm: (async () => { looked = true; return {} }) as never }),
    })
    assert.equal(r.success, false, `${bad} must not be accepted`)
  }
  assert.equal(looked, false, 'a malformed hash must not cost an RPC call')
})

/**
 * The weaker binding is bounded, not absent. A hash whose transfer does not match this
 * purchase buys nothing, and the code says the claim failed rather than that WE could not
 * see it: nothing was broadcast by us here, so there is no blindness of ours to report.
 */
test('a hash that does not carry this payment buys nothing', async () => {
  // A VERDICT about the hash: we looked and it is not what was claimed.
  for (const code of ['no_matching_transfer', 'wrong_authorization']) {
    const r = await redeemStellarPayment({
      chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT,
      deps: redeemDeps({ confirm: (async () => ({ confirmed: false, txHash: TX, code, reason: code })) as never }),
    })
    assert.equal(r.success, false)
    if (!r.success) assert.equal(r.code, 'payment_not_found')
  }
})

/**
 * And the codes that are NOT a verdict. The first version folded these into
 * payment_not_found, which rail.ts treats as retryable and answers with a fresh 402: an
 * agent whose vault had already paid would be told the payment does not exist and, following
 * the spec, would pay again. Our RPC being unreachable, charged to the buyer.
 */
test('a hash we merely cannot see is unconfirmed, and the buyer is told to come back', async () => {
  for (const code of ['unreachable', 'no_event_data', 'not_found', 'beyond_retention']) {
    const rows: Record<string, unknown>[] = []
    const r = await redeemStellarPayment({
      chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT,
      deps: redeemDeps({
        confirm: (async () => ({ confirmed: false, txHash: TX, code, reason: `${code}.` })) as never,
        persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) },
      }),
    })
    assert.equal(r.success, false)
    if (!r.success) {
      assert.equal(r.code, 'unconfirmed', `${code} must not read as a refusal`)
      assert.equal(r.ambiguous, true)
      assert.match(r.errorReason, /not disputed/)
    }
    // And it is written down, so an operator can find the orphaned payment later.
    assert.equal(rows[0]?.outcome, 'ambiguous', `${code} must leave a record`)
    assert.equal(rows[0]?.broadcaster, 'buyer')
  }
})

test('a transaction the buyer sent that reverted is named as such', async () => {
  const r = await redeemStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT,
    deps: redeemDeps({ confirm: (async () => ({ confirmed: false, txHash: TX, code: 'tx_failed', reason: 'landed and failed' })) as never }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'settlement_failed')
})

/**
 * The `from` the buyer declares is checked against the ledger, not trusted, so a hash that
 * carries no transfer from that address buys nothing.
 *
 * It is NOT an entitlement check, and the first version of this comment said it was. `from`
 * is buyer-declared and every field of a landed transaction is public, so whoever presents
 * the hash first is served. What bounds this path is one-hash-one-redemption plus the
 * contract-payer restriction, not the identity of the caller. See WEAKER_BINDING.
 */
test('the declared payer is passed to the confirmation, not taken on trust', async () => {
  let sawFrom = ''
  await redeemStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, txHash: TX, from: VAULT,
    deps: redeemDeps({
      confirm: (async (_c: unknown, _h: unknown, expect: { from: string; authNonce: string | null }) => {
        sawFrom = expect.from
        assert.equal(expect.authNonce, null, 'the hash-bound path passes null explicitly, never a made-up nonce')
        return { confirmed: false, txHash: TX, code: 'not_found', reason: 'x' }
      }) as never,
    }),
  })
  assert.equal(sawFrom, VAULT)
})

/**
 * F-05. The daily fee budget was documented as fail-closed and was not.
 *
 * `feeSpentOnDay` wraps its work in a try/catch and returns MAX_SAFE_INTEGER on a throw,
 * with a comment saying an unreadable log means we stop broadcasting rather than assume
 * zero. But `loadStellarSettlements` catches its own read error and returns `[]`, so the
 * throw never happens: an unreachable database read as "nothing spent today" and the
 * budget gate passed.
 *
 * On testnet that spends test XLM. On pubnet it spends the operator's real XLM, without a
 * ceiling, for as long as the database stays unreachable. Render's free tier makes that a
 * routine condition rather than a hypothetical.
 *
 * These tests inject the loader, so they exercise the real `feeSpentOnDay` rather than a
 * reimplementation of it.
 */
test('F-05: an unreadable settlement log spends the fee budget, it does not zero it', async () => {
  const at = new Date('2026-08-24T12:00:00Z')
  const unreadable = async () => ({ ok: false as const, reason: 'ECONNREFUSED 10.0.0.1:5432' })
  const spent = await feeSpentOnDay('stellar:pubnet', at, unreadable)
  assert.equal(
    spent,
    FEE_BUDGET_UNKNOWN,
    'a log we cannot read must report the budget as spent. Returning 0 here is what let an ' +
      'unreachable database turn the daily fee ceiling off entirely.',
  )
})

test('F-05: an empty log is genuinely zero, and is not confused with an unreadable one', async () => {
  const at = new Date('2026-08-24T12:00:00Z')
  const empty = async () => ({ ok: true as const, rows: [] })
  assert.equal(await feeSpentOnDay('stellar:pubnet', at, empty), 0n)
})

test('F-05: fees are summed for this network and this day only', async () => {
  const at = new Date('2026-08-24T12:00:00Z')
  const rows = [
    { network: 'stellar:pubnet', ts: '2026-08-24T01:00:00Z', feeStroops: '100' },
    { network: 'stellar:pubnet', ts: '2026-08-24T23:00:00Z', feeStroops: '250' },
    // another network: a pubnet fee and a testnet fee are not comparable quantities
    { network: 'stellar:testnet', ts: '2026-08-24T02:00:00Z', feeStroops: '9999' },
    // yesterday
    { network: 'stellar:pubnet', ts: '2026-08-23T23:59:59Z', feeStroops: '8888' },
    // a malformed row must not break the guard it feeds
    { network: 'stellar:pubnet', ts: '2026-08-24T03:00:00Z', feeStroops: 'not-a-number' },
  ] as unknown as StellarSettlementRecord[]
  const spent = await feeSpentOnDay('stellar:pubnet', at, async () => ({ ok: true as const, rows }))
  assert.equal(spent, 350n)
})

/**
 * The producer half of F-05, and the reason it exists is a mistake worth recording.
 *
 * The three tests above inject the loader, so they prove `feeSpentOnDay` handles an
 * `ok: false` correctly. They do NOT prove anything emits one. A negative control caught
 * that: reverting `loadStellarSettlementsResult` to swallow its read error and return
 * `{ ok: true, rows: [] }` left all three of them green, which is exactly the shape of the
 * original bug. A test that mocks the thing that was broken cannot detect that it broke.
 *
 * These call the real function with a failing pool, so the classification under test is
 * the one that runs in production.
 */
test('F-05 (producer): a database that will not answer is reported unreadable, not empty', async () => {
  const boom = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
  }
  const r = await loadStellarSettlementsResult(boom)
  assert.equal(r.ok, false, 'an unreachable database must not read as an empty settlement log')
  if (!r.ok) assert.match(r.reason, /ECONNREFUSED/)
})

test('F-05 (producer): an unreadable log makes the real fee guard report the budget spent', async () => {
  // The two halves wired together, with no stub between them: this is the end-to-end
  // statement the daily fee ceiling actually depends on.
  const boom = async () => {
    throw new Error('connect ETIMEDOUT')
  }
  const spent = await feeSpentOnDay('stellar:pubnet', new Date('2026-08-24T12:00:00Z'), () =>
    loadStellarSettlementsResult(boom),
  )
  assert.equal(spent, FEE_BUDGET_UNKNOWN)
})

test('F-05 (producer): no configured database is empty, not unreadable', async () => {
  // A first run with no DATABASE_URL and no settlements file is genuinely zero spend.
  // Conflating that with a read failure would fail closed forever on a fresh deploy.
  const r = await loadStellarSettlementsResult(async () => null)
  assert.equal(r.ok, true, 'an unconfigured database with no file is a first run, not a failure')
})

// ── F-04: the self path, the one that spends OUR XLM ─────────────────────────────────
//
// Everything above this line either injects `broadcaster: 'oz'` or exercises the `settled`
// scheme, where the buyer already paid and we spend nothing. The `self` path was covered by
// none of it, and `rail.ts` makes `self` the DEFAULT whenever a fee payer exists, so the
// untested path was the shipped one. A regression in the stroop arithmetic, or a reordering
// that broadcast before the budget check, would have passed the whole suite.
//
// These tests drive `broadcastOurselves` through the same seams the rest of the file uses:
// a fake RPC object for `deps.server`, a fake fee log for `deps.feeSpentTodayStroops`, and a
// fee payer supplied through `deps.env`. `sendTransaction` is the seam that decides whether
// this test file can tell "refused" from "broadcast and then refused": every guard test
// below asserts it was never called, because that is the finding.
//
// Negative controls, run against a compiled copy so nothing in the repo was touched. Each
// mutation was reverted afterwards, and each failed exactly the tests it should:
//   - remove the ceiling guard, and the two fee_ceiling tests fail
//   - remove the daily budget guard, and the fee_budget_exhausted and F-05 tests fail
//   - force feeStroops to 0, and the happy path plus all three guard tests fail
//   - move the submit BEFORE both guards, and all four guard tests fail
// The last one is the regression this section exists for: a reordering that broadcasts
// first and checks afterwards. Before these tests, all four mutations passed the suite.

/**
 * A throwaway fee payer, derived rather than pasted so no secret literal lives in the repo.
 * It has never held anything and never will; nothing here reaches a network.
 */
const FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9))
const FEE_PAYER_ENV = { X402_STELLAR_TESTNET_FEE_PAYER: FEE_PAYER.secret() }

/**
 * A simulation response in the shape the RPC actually returns, so `rpc.assembleTransaction`
 * runs for real rather than against a hand-shaped object it would never see.
 *
 * The fee the settle path reads is the ASSEMBLED transaction's fee, which is the inclusion
 * fee the builder starts from (100 stroops) plus the resource fee simulation quotes. Both
 * halves are real arithmetic done by the SDK, which is the point: a test that asserted
 * `feeStroops === resourceFee` would agree with a bug that dropped the inclusion fee.
 */
const INCLUSION_FEE = 100n
const simSuccess = (resourceFeeStroops: number) => ({
  latestLedger: EXPIRES_AT - 100,
  minResourceFee: String(resourceFeeStroops),
  transactionData: new SorobanDataBuilder().setResourceFee(resourceFeeStroops).build().toXDR('base64'),
  results: [{ xdr: xdr.ScVal.scvVoid().toXDR('base64'), auth: [] }],
  events: [],
})

/** What a self broadcast touches, with every touch recorded so ORDER can be asserted. */
type SelfRpc = {
  server: StellarSettleDeps['server']
  calls: string[]
  sent: number
}

const selfRpc = (over: {
  simulate?: () => Promise<unknown>
  send?: () => Promise<unknown>
} = {}): SelfRpc => {
  const calls: string[] = []
  const state = {
    calls,
    sent: 0,
    server: {
      getLatestLedger: async () => {
        calls.push('getLatestLedger')
        return { sequence: EXPIRES_AT - 100 } as never
      },
      getAccount: async () => {
        calls.push('getAccount')
        // A real Account, so the builder increments a real sequence number.
        return new Account(FEE_PAYER.publicKey(), '1') as never
      },
      simulateTransaction: async () => {
        calls.push('simulateTransaction')
        return (await (over.simulate ?? (async () => simSuccess(33_053)))()) as never
      },
      sendTransaction: async () => {
        calls.push('sendTransaction')
        state.sent += 1
        return (await (over.send ?? (async () => ({ status: 'PENDING', hash: TX })))()) as never
      },
    },
  }
  return state as SelfRpc
}

const selfDeps = (rpcSeam: SelfRpc, over: Partial<StellarSettleDeps> = {}): StellarSettleDeps =>
  baseDeps({
    broadcaster: 'self',
    env: FEE_PAYER_ENV,
    server: rpcSeam.server,
    feeSpentTodayStroops: async () => 0n,
    meta: { tool: 'find_agent', baseUsd: 0.25 },
    ...over,
  })

test('a self broadcast records that we broadcast it and what the fee actually cost us', async () => {
  const seam = selfRpc()
  const rows: Record<string, unknown>[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, { confirm: confirmed(), persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) } }),
  })
  assert.equal(r.success, true, r.success ? '' : r.errorReason)
  if (r.success) {
    assert.equal(r.broadcaster, 'self')
    assert.equal(r.transaction, TX)
    assert.equal(r.feeStroops, (INCLUSION_FEE + 33_053n).toString())
  }
  assert.equal(seam.sent, 1, 'the happy path is the one case that is supposed to submit')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'settled')
  assert.equal(rows[0].broadcaster, 'self')
  // Non-zero and exact. A row that says 'self' with feeStroops '0' is the shape of the bug
  // the module docstring records from testnet, where a settlement we paid 33,153 stroops for
  // was written down as having cost us nothing.
  assert.equal(rows[0].feeStroops, (INCLUSION_FEE + 33_053n).toString())
  assert.notEqual(rows[0].feeStroops, '0')
})

test('a simulated fee above the rail ceiling is refused and nothing is submitted', async () => {
  const seam = selfRpc({ simulate: async () => simSuccess(2_000_000) })
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, { confirm: confirmed(), persist: async (rec) => { rows.push(rec) } }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'fee_ceiling')
    assert.match(r.errorReason, /above this rail's ceiling of 1000000/)
    assert.match(r.errorReason, /Nothing was broadcast/)
    assert.equal(r.ambiguous, undefined, 'a refusal before submission is not ambiguous')
  }
  // The finding, stated as an assertion: the guard runs BEFORE the submit, not after it.
  assert.equal(seam.sent, 0, 'a fee above the ceiling must be refused without spending it')
  assert.equal(seam.calls.includes('sendTransaction'), false)
  assert.equal(rows.length, 0, 'nothing was broadcast, so there is nothing to record')
})

test('a fee ceiling refusal does not even read the daily fee log', async () => {
  // Ordering, stated the other way round: the ceiling is cheaper than the log read, so it
  // comes first. Asserting it keeps a future edit from reordering the two and making every
  // over-ceiling settlement pay for a database round trip.
  const seam = selfRpc({ simulate: async () => simSuccess(2_000_000) })
  let readTheLog = false
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, {
      confirm: confirmed(),
      feeSpentTodayStroops: async () => { readTheLog = true; return 0n },
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'fee_ceiling')
  assert.equal(readTheLog, false)
  assert.equal(seam.sent, 0)
})

test('a day whose fee budget is already spent refuses before anything is submitted', async () => {
  const seam = selfRpc()
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, {
      // One stroop short of the budget, so the fee this settlement quotes tips it over.
      feeSpentTodayStroops: async () => LIMITS.dailyFeeStroops - 1n,
      confirm: confirmed(),
      persist: async (rec) => { rows.push(rec) },
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'fee_budget_exhausted')
    assert.match(r.errorReason, /today's settlement fee budget is spent/)
    assert.match(r.errorReason, /Nothing was broadcast and nothing was charged/)
  }
  assert.equal(seam.sent, 0, 'the daily budget is a guard only if it fires before the submit')
  assert.equal(seam.calls.includes('sendTransaction'), false)
  assert.equal(rows.length, 0)
})

test('the guards run in the order simulate, ceiling, budget, and only then submit', async () => {
  // The whole sequence in one assertion, so a reordering is visible rather than inferred.
  // A settlement that fits both ceilings walks the full path exactly once.
  const seam = selfRpc()
  const order: string[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, {
      feeSpentTodayStroops: async () => { order.push('feeLog'); return 0n },
      confirm: confirmed(),
    }),
  })
  assert.equal(r.success, true, r.success ? '' : r.errorReason)
  const simulated = seam.calls.indexOf('simulateTransaction')
  const submitted = seam.calls.indexOf('sendTransaction')
  assert.ok(simulated >= 0 && submitted > simulated, 'the fee is read from simulation, before submission')
  assert.deepEqual(order, ['feeLog'], 'the daily budget is read exactly once, and it is read')
  // The fee log is consulted between the simulation and the submission, never after it.
  assert.equal(seam.calls.slice(submitted).includes('simulateTransaction'), false)
})

test('a simulation that fails costs nothing and says so', async () => {
  // A replay and an insufficient balance both land here, which is why simulation runs before
  // the ceiling checks rather than after them: it is the cheapest refusal we have.
  const seam = selfRpc({ simulate: async () => ({ id: '1', latestLedger: 1, error: 'HostError: Error(Auth, ExistingValue)', events: [] }) })
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, { confirm: confirmed(), persist: async (rec) => { rows.push(rec) } }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'simulation_failed')
    assert.match(r.errorReason, /the settlement would fail: HostError: Error\(Auth, ExistingValue\)/)
  }
  assert.equal(seam.sent, 0)
  assert.equal(rows.length, 0)
})

test('a simulation call that throws is a simulation failure, not a broadcast failure', async () => {
  const seam = selfRpc({ simulate: async () => { throw new Error('RPC 502') } })
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, { confirm: confirmed() }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'simulation_failed')
    assert.match(r.errorReason, /could not simulate the settlement: RPC 502/)
  }
  assert.equal(seam.sent, 0, 'a settlement we could not simulate must not be broadcast blind')
})

/**
 * F-05, proven on the path that spends the money.
 *
 * The F-05 tests above call `feeSpentOnDay` directly. This one drives the SAME function
 * through the settle path with an unreadable log behind it, which is the statement the
 * operator's XLM actually depends on: when we cannot say what we have spent today, we stop
 * broadcasting instead of assuming zero.
 */
test('F-05 on the self path: an unreadable fee log stops the broadcast rather than assuming zero', async () => {
  const seam = selfRpc()
  const unreadable = async () => ({ ok: false as const, reason: 'ECONNREFUSED 10.0.0.1:5432' })
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, {
      // The real guard, reading a log that will not answer. Not a stub returning the
      // sentinel: a stub would agree with a version of feeSpentOnDay that had the bug.
      feeSpentTodayStroops: () => feeSpentOnDay(CHAIN.caip2, new Date('2026-08-24T12:00:00Z'), unreadable),
      confirm: confirmed(),
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'fee_budget_exhausted')
  assert.equal(
    seam.sent,
    0,
    'an unreadable fee log must fail closed. Broadcasting here is how an unreachable database ' +
      'turns the daily ceiling off and spends the operator XLM without a limit.',
  )
})

test('the sentinel a broken fee log returns is larger than any budget a rail could set', () => {
  // Why the test above refuses rather than passing: FEE_BUDGET_UNKNOWN is compared against
  // the configured budget, so it only fails closed while it stays above it.
  assert.ok(FEE_BUDGET_UNKNOWN > LIMITS.dailyFeeStroops)
  assert.ok(FEE_BUDGET_UNKNOWN > 1_000_000_000n, 'a rail-sized daily budget must not exceed the sentinel')
})

test('a network that rejects the submission is a decided failure and records nothing', async () => {
  const seam = selfRpc({ send: async () => ({ status: 'ERROR', errorResult: 'tx_insufficient_fee', hash: TX }) })
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, { confirm: confirmed(), persist: async (rec) => { rows.push(rec) } }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'broadcast_failed')
    assert.match(r.errorReason, /the network rejected the settlement/)
    assert.equal(r.ambiguous, undefined, 'the network looked at it and said no, which is a decision')
  }
  assert.equal(rows.length, 0)
})

/**
 * The branch that decides whether a buyer whose money may have moved is told it failed.
 *
 * A throw out of `sendTransaction` cannot distinguish "the request never left" from "it
 * arrived and the reply did not come back". Reporting broadcast_failed would answer 502 to
 * someone whose transaction may be in the ledger, so the path hands back the locally
 * computed hash and calls it unconfirmed instead.
 */
test('a submission that throws is unconfirmed and carries the hash to follow up', async () => {
  const seam = selfRpc({ send: async () => { throw new Error('socket hang up') } })
  const rows: unknown[] = []
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: selfDeps(seam, { confirm: confirmed(), persist: async (rec) => { rows.push(rec) } }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'unconfirmed', 'a throw we cannot classify must never read as a failed payment')
    assert.equal(r.ambiguous, true)
    assert.match(r.transaction ?? '', /^[0-9a-f]{64}$/, 'the hash is computed locally, without the network')
    assert.match(r.errorReason, /we cannot tell whether it landed: socket hang up/)
    assert.match(r.errorReason, /nothing has been marked spent/)
  }
  // The row is the point. A transaction that may be in the ledger, whose fee we may have
  // paid, has to be findable afterwards, and its fee has to reach the log `feeSpentOnDay`
  // sums or the daily budget never sees what an unstable RPC cost us.
  assert.equal(rows.length, 1, 'an ambiguous broadcast must leave a record an operator can find')
  const rec = rows[0] as { outcome: string; tx: string; feeStroops?: string }
  assert.equal(rec.outcome, 'ambiguous', 'not settled and not reverted: we do not know')
  assert.equal(rec.tx, (r as { transaction?: string }).transaction)
  assert.ok(BigInt(rec.feeStroops ?? '0') > 0n, 'the fee we may have paid is recorded, not dropped')
})

test('self is chosen with no facilitator set, and refuses cleanly when it has no fee payer', async () => {
  // `self` is the default whenever a fee payer exists, which is the reason this whole
  // section had to exist. With the variable unset and a real fee payer present, the rail
  // picks self without being told to.
  const chosen = selfRpc()
  const picked = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({
      env: FEE_PAYER_ENV, server: chosen.server, feeSpentTodayStroops: async () => 0n,
      meta: { tool: 'find_agent', baseUsd: 0.25 }, confirm: confirmed(),
    }),
  })
  assert.equal(picked.success, true, picked.success ? '' : picked.errorReason)
  if (picked.success) assert.equal(picked.broadcaster, 'self')

  // And the mirror: told to broadcast ourselves with nothing to pay the fee, we name the
  // variable to set rather than crashing or falling back to someone else's rail.
  const seam = selfRpc()
  const r = await settleStellarPayment({
    chain: CHAIN, token: TOKEN, requirements: REQ, payload: payload(), limits: LIMITS,
    deps: baseDeps({ broadcaster: 'self', env: {}, server: seam.server, confirm: confirmed() }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'no_broadcaster')
    assert.match(r.errorReason, /X402_STELLAR_TESTNET_FEE_PAYER/)
  }
  assert.equal(seam.sent, 0)
})
