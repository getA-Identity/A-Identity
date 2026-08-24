/**
 * The Soroban facilitator's public surface.
 *
 * Same real signed entry as settle.test.ts, so what these handlers accept and refuse is
 * measured against bytes a wallet actually produced rather than against a fixture shaped to
 * agree with the code.
 *
 * The rail is driven entirely through env here, never through a mock of itself, because
 * the failure this suite is most worried about is the one where /supported advertises a
 * network that /settle then refuses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Address, Keypair, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'

import {
  resolveStellarNetwork,
  settleHttpStatus,
  stellarFacilitatorChains,
  stellarSettle,
  stellarSupported,
  stellarVerify,
} from './facilitator.js'
import { stellarPaymentKey } from './settle.js'
import type { StellarSettleDeps } from './settle.js'

const ENTRY =
  'AAAAAQAAAAAAAAAAYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMlXBYVzLZQr7AA/TJUAAAAQAAAAAQAAAAEAAAARAAAAAQAAAAIAAAAPAAAACnB1YmxpY19rZXkAAAAAAA0AAAAgYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMkAAAAPAAAACXNpZ25hdHVyZQAAAAAAAA0AAABAjn7CW0+QUgPtXwm1MafD+9JMISgUJ9J2efq4vnp+3LPGoq0CJ2dnTEw7NmDX/ftrPq4S3G9li7qF1FPX1lTCCwAAAAAAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwEAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAAYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMkAAAASAAAAAAAAAABZGy1/LOzYZLW15i28Rz04tIJDNYAx05S+BK1YvpESBgAAAAoAAAAAAAAAAAAAAAAAJiWgAAAAAA=='

const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const BUYER = 'GBRKRUDYKYOSGH4QIYAFONPWXFCFC7K5AYHIVJDNYJAZ33BE5YSMTS6R'
const SELLER = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
const OUTSIDER = 'GBLHNAL57WLA5GKTIGPBHCJTQDNEZFX2CVH53EDUOGWIERNKECRENHQ5'
const NONCE = '6270564785915702252'
const EXPIRES_AT = 4_148_373
const TX = '3da74634e2b09b3e1c15c53a1a0e6d1c1e3f3b2a5d4c6e7f8a9b0c1d2e3f4a5b'
/**
 * A throwaway seed generated for this suite, never funded and never used on any network.
 *
 * It has to be a REAL StrKey rather than a plausible-looking string: the first version of
 * this constant was hand-written, and strkey.ts's CRC16 check refused it, which made every
 * settle test see a rail with no fee payer. That is the checksum guard doing exactly what
 * it was added for, on me.
 */
const FEE_PAYER = 'SCTDATUXOG52GBIVRAUPLJA23FJY5BM2CFCAQ7LGKI2552BWIZLW7P23'

const ENV = {
  X402_STELLAR_NETWORKS: 'stellar:testnet',
  X402_STELLAR_PAYTO: SELLER,
  X402_STELLAR_TESTNET_FEE_PAYER: FEE_PAYER,
  // Present so the OZ fallback is reachable in tests. It does not change which broadcaster
  // the rail picks: with a fee payer configured and no explicit X402_STELLAR_FACILITATOR,
  // self wins, and the settle tests below override the choice through deps instead.
  X402_STELLAR_TESTNET_OZ_KEY: 'test-key',
}

const body = (over: Record<string, unknown> = {}, reqOver: Record<string, unknown> = {}) => ({
  x402Version: 2,
  paymentPayload: { scheme: 'exact', network: 'stellar:testnet', payload: { authEntryXdr: ENTRY }, ...over },
  paymentRequirements: {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: SAC,
    payTo: SELLER,
    maxAmountRequired: '2500000',
    resource: '/api/x402/stellar/tools/find_agent',
    ...reqOver,
  },
})

/**
 * The handlers read `paymentPayload` itself as the payload, matching the EVM facilitator,
 * so the entry sits at the top level of it.
 */
const payloadBody = (over: Record<string, unknown> = {}, reqOver: Record<string, unknown> = {}) => {
  const b = body(over, reqOver)
  return { ...b, paymentPayload: { ...b.paymentPayload, authEntryXdr: ENTRY } }
}

/**
 * A REAL authorization entry, signed here with a throwaway key.
 *
 * Needed because the recorded fixture pays SELLER, so it cannot be used to test settling
 * for a third party: verification refuses it with wrong_recipient before the allowlist
 * matters. A test that worked around that by asserting "not 403" would have been measuring
 * the gate it meant to pass through. This signs the same preimage the production path
 * verifies, so it is a real signature over real XDR, just from a key nobody funded.
 */
function signEntry(opts: { payer: Keypair; to: string; amount: bigint; expiresAt: number; passphrase?: string }): string {
  const nonce = xdr.Int64.fromString('987654321012345678')
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(SAC).toScAddress(),
        functionName: 'transfer',
        args: [
          new Address(opts.payer.publicKey()).toScVal(),
          new Address(opts.to).toScVal(),
          nativeToScVal(opts.amount, { type: 'i128' }),
        ],
      }),
    ),
    subInvocations: [],
  })
  const digest = hash(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(opts.passphrase ?? Networks.TESTNET)),
        nonce,
        signatureExpirationLedger: opts.expiresAt,
        invocation,
      }),
    ).toXDR(),
  )
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(opts.payer.publicKey()).toScAddress(),
        nonce,
        signatureExpirationLedger: opts.expiresAt,
        signature: xdr.ScVal.scvVec([
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(opts.payer.rawPublicKey()) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(opts.payer.sign(digest)) }),
          ]),
        ]),
      }),
    ),
    rootInvocation: invocation,
  }).toXDR('base64')
}

const deps = (over: Partial<StellarSettleDeps> = {}): StellarSettleDeps => ({
  env: ENV,
  server: {
    getLatestLedger: async () => ({ sequence: EXPIRES_AT - 100 }) as never,
    getAccount: async () => ({}) as never,
    simulateTransaction: async () => ({}) as never,
    sendTransaction: async () => ({}) as never,
  },
  loadSpent: async () => [],
  persistSpent: async () => {},
  persist: async () => {},
  ...over,
})

// ── network resolution ───────────────────────────────────────────────────────────────

test('a Stellar network resolves by slug and by CAIP-2', () => {
  assert.equal(resolveStellarNetwork('stellar-testnet')?.caip2, 'stellar:testnet')
  assert.equal(resolveStellarNetwork('stellar:testnet')?.caip2, 'stellar:testnet')
  assert.equal(resolveStellarNetwork('stellar')?.caip2, 'stellar:pubnet')
})

/**
 * The check that is not pedantry: `celo` is a real descriptor, so without an ecosystem
 * guard it would resolve here and be carried into code that builds a Soroban RPC client
 * out of an EVM chain.
 */
test('a real EVM chain does not resolve as a Stellar network', () => {
  for (const evm of ['celo', 'eip155:42220', 'arbitrum', 'rhchain']) {
    assert.equal(resolveStellarNetwork(evm), null, `${evm} must not resolve here`)
  }
  assert.equal(resolveStellarNetwork(''), null)
  assert.equal(resolveStellarNetwork(42), null)
})

test('the servable chains are derived from the registry, never listed', () => {
  const ids = stellarFacilitatorChains(ENV).map((c) => c.id)
  assert.ok(ids.includes('stellar-testnet'))
  assert.ok(ids.every((id) => id.startsWith('stellar')))
})

// ── /supported ───────────────────────────────────────────────────────────────────────

test('supported advertises both wire shapes and the passphrase a buyer must sign against', () => {
  const r = stellarSupported(ENV)
  assert.equal(r.httpStatus, 200)
  const kinds = r.body.kinds as Record<string, unknown>[]
  const v2 = kinds.find((k) => k.x402Version === 2 && k.network === 'stellar:testnet')
  const v1 = kinds.find((k) => k.x402Version === 1 && k.network === 'stellar-testnet')
  assert.ok(v2, 'a v2 kind keyed on CAIP-2')
  assert.ok(v1, 'a v1 kind keyed on the registry slug')
  const extra = v2!.extra as Record<string, unknown>
  assert.equal(extra.networkPassphrase, 'Test SDF Network ; September 2015')
  assert.equal(extra.authorization, 'soroban-auth')
  assert.equal(extra.function, 'transfer')
  // The absent EIP-712 field is explained rather than left as a hole.
  assert.match(String(extra.domainProving), /no per-token domain to prove/)
  assert.equal(extra.domainSeparator, undefined)
})

/**
 * A rail that cannot broadcast must not appear as a payable kind. A buyer who signs against
 * an advertised kind and can never settle is worse off than one who was told no.
 */
test('a network with no broadcaster is reported unavailable, not advertised', () => {
  const r = stellarSupported({ X402_STELLAR_NETWORKS: 'stellar:testnet', X402_STELLAR_PAYTO: SELLER })
  const kinds = r.body.kinds as unknown[]
  const unavailable = r.body.unavailable as { network: string; reason: string }[]
  assert.equal(kinds.length, 0, 'nothing may be advertised')
  // Looked up by network rather than by position. This asserted `unavailable[0]` until
  // pubnet declared a USDC SAC of its own on 2026-08-24 and took that slot, which is the
  // facilitator being MORE honest rather than less: it now says out loud that it knows
  // about pubnet and does not sell there. An index made a true report look like a failure.
  const testnet = unavailable.find((u) => u.network === 'stellar:testnet')
  assert.ok(testnet, `stellar:testnet must be reported unavailable; got ${unavailable.map((u) => u.network).join(', ')}`)
  assert.match(testnet.reason, /no fee payer|cannot broadcast|OpenZeppelin/i)
  // And every Stellar network carrying a settlement token has to be accounted for one way
  // or the other. A chain that is neither advertised nor explained is one a buyer has to
  // guess about.
  const pubnet = unavailable.find((u) => u.network === 'stellar:pubnet')
  assert.ok(pubnet, 'stellar:pubnet declares a SAC, so it must be advertised or explained, never silently dropped')
  assert.ok(pubnet.reason.length > 0)
})

/**
 * Shipping a facilitator on a chain that already has one reads as a claim to be first
 * unless the sentence is there. It is there, and this test keeps it there.
 */
test('supported credits OpenZeppelin Channels as prior art rather than implying we are first', () => {
  const f = stellarSupported(ENV).body.facilitator as Record<string, unknown>
  const prior = f.priorArt as Record<string, unknown>
  assert.match(String(prior.note), /predates this one/)
  assert.match(String(prior.note), /fallback/)
  assert.match(String(f.confirmation), /we read the transfer event ourselves/)
  assert.equal(f.selfHosted, true)
})

test('settle is closed by default and says so in the same breath as verify being open', () => {
  const closed = (stellarSupported(ENV).body.facilitator as Record<string, unknown>).settle as Record<string, unknown>
  assert.equal(closed.open, false)
  assert.match(String(closed.note), /\/verify and \/supported are open/)

  const open = (
    stellarSupported({ ...ENV, X402_STELLAR_PUBLIC_SETTLE: 'true' }).body.facilitator as Record<string, unknown>
  ).settle as Record<string, unknown>
  assert.equal(open.open, true)
})

// ── /verify ──────────────────────────────────────────────────────────────────────────

test('a real payment verifies and names its payer', async () => {
  const r = await stellarVerify(payloadBody(), deps())
  assert.equal(r.httpStatus, 200)
  assert.equal(r.body.isValid, true, String(r.body.invalidReason ?? ''))
  assert.equal(r.body.payer, BUYER)
  assert.equal(r.body.network, 'stellar:testnet')
})

test('verify refuses a body missing either half rather than guessing the other', async () => {
  for (const bad of [{}, { paymentPayload: {} }, { paymentRequirements: {} }]) {
    const r = await stellarVerify(bad, deps())
    assert.equal(r.httpStatus, 400)
    assert.equal(r.body.code, 'malformed_payload')
  }
})

/**
 * A G... issuer where a C... contract belongs is the exact confusion that puts a transfer
 * on the wrong thing, so the shapes are checked as the RIGHT shapes and not merely as
 * non-empty strings.
 */
test('an asset that is not a contract id and a payTo that is not an account are both refused', async () => {
  const wrongAsset = await stellarVerify(payloadBody({}, { asset: SELLER }), deps())
  assert.equal(wrongAsset.httpStatus, 400)
  assert.match(String(wrongAsset.body.invalidReason), /must be a Soroban contract id/)

  const wrongPayTo = await stellarVerify(payloadBody({}, { payTo: SAC }), deps())
  assert.equal(wrongPayTo.httpStatus, 400)
  assert.match(String(wrongPayTo.body.invalidReason), /must be a Stellar account id/)
})

test('a payload and requirements naming different networks is an error, not a preference', async () => {
  const r = await stellarVerify(payloadBody({ network: 'stellar:pubnet' }), deps())
  assert.equal(r.httpStatus, 400)
  assert.equal(r.body.code, 'unsupported_network')
  assert.match(String(r.body.invalidReason), /the payload names stellar:pubnet/)
})

test('an EVM network reaches no Stellar code path', async () => {
  const r = await stellarVerify(payloadBody({}, { network: 'celo' }), deps())
  assert.equal(r.httpStatus, 400)
  assert.equal(r.body.code, 'unsupported_network')
})

test('verify reports an invalid payment as 200 with a reason, the way x402 clients expect', async () => {
  const r = await stellarVerify(payloadBody({}, { maxAmountRequired: '9999999' }), deps())
  assert.equal(r.httpStatus, 200, 'a well-formed request that fails verification is not an HTTP error')
  assert.equal(r.body.isValid, false)
  assert.equal(r.body.code, 'wrong_amount')
})

test('verify never broadcasts, even for a payment that would settle', async () => {
  let broadcast = false
  await stellarVerify(payloadBody(), deps({ ozSubmit: async () => { broadcast = true; return { ok: true, txHash: TX } } }))
  assert.equal(broadcast, false)
})

// ── /settle ──────────────────────────────────────────────────────────────────────────

const settleDeps = (over: Partial<StellarSettleDeps> = {}) =>
  deps({
    broadcaster: 'oz',
    ozSubmit: async () => ({ ok: true, txHash: TX }),
    confirm: (async () => ({
      confirmed: true, txHash: TX, ledger: 4_147_945, from: BUYER,
      amountRaw: '2500000', asset: SAC, authNonce: NONCE,
    })) as never,
    ...over,
  })

test('settling for our own payTo works and reports the network it settled on', async () => {
  const r = await stellarSettle(payloadBody(), settleDeps())
  assert.equal(r.httpStatus, 200, String(r.body.errorReason ?? ''))
  assert.equal(r.body.success, true)
  assert.equal(r.body.network, 'stellar:testnet')
  assert.equal(r.body.transaction, TX)
})

test('settling for somebody else is refused until they are allowlisted', async () => {
  const refused = await stellarSettle(payloadBody({}, { payTo: OUTSIDER }), settleDeps())
  assert.equal(refused.httpStatus, 403)
  assert.equal(refused.body.code, 'payto_not_allowlisted')

  // Past the gate means the NEXT check runs. The recorded entry pays SELLER, so with
  // requirements naming OUTSIDER the honest answer is wrong_recipient: proof the request
  // reached verification rather than being turned away at the door. Asserting merely
  // "not 403" would have measured the gate it meant to pass through.
  const allowed = await stellarSettle(
    payloadBody({}, { payTo: OUTSIDER }),
    settleDeps({ env: { ...ENV, X402_STELLAR_ALLOWED_PAYTO: OUTSIDER } }),
  )
  assert.notEqual(allowed.httpStatus, 403, 'an allowlisted payTo must get past the gate')
  assert.equal(allowed.body.code, 'wrong_recipient')
})

/**
 * A StrKey is case-significant base32. The EVM habit of lowercasing both sides of an
 * address comparison would turn every entry on this allowlist into a string that matches
 * nothing, and the guard would look present while doing nothing.
 */
test('the allowlist compares StrKeys exactly and a lowercased entry does not silently pass', async () => {
  const r = await stellarSettle(
    payloadBody({}, { payTo: OUTSIDER }),
    settleDeps({ env: { ...ENV, X402_STELLAR_ALLOWED_PAYTO: OUTSIDER.toLowerCase() } }),
  )
  assert.equal(r.httpStatus, 403, 'a lowercased StrKey is not that account')
})

test('a settlement for a third party is recorded as facilitated for them', async () => {
  const stranger = Keypair.random()
  const entry = signEntry({ payer: stranger, to: OUTSIDER, amount: 2_500_000n, expiresAt: EXPIRES_AT })
  const rows: Record<string, unknown>[] = []
  const r = await stellarSettle(
    {
      x402Version: 2,
      paymentPayload: { scheme: 'exact', network: 'stellar:testnet', authEntryXdr: entry },
      paymentRequirements: { scheme: 'exact', network: 'stellar:testnet', asset: SAC, payTo: OUTSIDER, maxAmountRequired: '2500000' },
    },
    settleDeps({
      env: { ...ENV, X402_STELLAR_ALLOWED_PAYTO: OUTSIDER },
      confirm: (async () => ({
        confirmed: true, txHash: TX, ledger: 4_147_945, from: stranger.publicKey(),
        amountRaw: '2500000', asset: SAC, authNonce: '987654321012345678',
      })) as never,
      persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) },
    }),
  )
  assert.equal(r.httpStatus, 200, String(r.body.errorReason ?? ''))
  assert.equal(rows[0]?.facilitatedFor, OUTSIDER)
  assert.equal(rows[0]?.tool, 'facilitator')
  assert.equal(rows[0]?.payTo, OUTSIDER)
})

/**
 * The other half of the same idea: settling for OURSELVES must not carry facilitatedFor,
 * because that field is what a proof page uses to tell "we sold something" from "we ran
 * the rail for someone else".
 */
test('settling for our own payTo carries no facilitatedFor', async () => {
  const rows: Record<string, unknown>[] = []
  await stellarSettle(payloadBody(), settleDeps({ persist: async (rec) => { rows.push(rec as unknown as Record<string, unknown>) } }))
  assert.equal(rows[0]?.facilitatedFor, undefined)
})

test('an unconfigured network answers 501 rather than pretending to settle', async () => {
  const r = await stellarSettle(payloadBody(), settleDeps({ env: {} }))
  assert.equal(r.httpStatus, 501)
  assert.equal(r.body.code, 'not_configured')
})

/**
 * The status code carries the same distinction the codes do. A broadcast we cannot confirm
 * is 202, not 502: 502 tells the caller the payment failed, and we do not know that.
 */
test('a broadcast we cannot confirm answers 202, never 502', async () => {
  const r = await stellarSettle(
    payloadBody(),
    settleDeps({
      confirm: (async () => ({ confirmed: false, txHash: TX, code: 'not_found', reason: 'not visible yet' })) as never,
    }),
  )
  assert.equal(r.httpStatus, 202)
  assert.equal(r.body.success, false)
  assert.equal(r.body.ambiguous, true)
  assert.equal(r.body.transaction, TX)
})

test('a transaction that landed and failed answers 502, because that one is decided', async () => {
  const r = await stellarSettle(
    payloadBody(),
    settleDeps({
      confirm: (async () => ({ confirmed: false, txHash: TX, code: 'tx_failed', reason: 'landed and failed' })) as never,
    }),
  )
  assert.equal(r.httpStatus, 502)
  assert.equal(r.body.code, 'settlement_failed')
  assert.equal(r.body.ambiguous, undefined)
})

/**
 * The fee guards live after simulation in the self path, which is the right order (a
 * simulation costs nothing and catches a replay before we think about budgets) and means a
 * stubbed network cannot reach them. So the mapping is tested where it lives, over every
 * code rather than over the two a stub can produce.
 */
test('the http status carries the same distinction the settle codes carry', () => {
  assert.equal(settleHttpStatus({ code: 'fee_budget_exhausted' }), 503, 'a spent budget is come back later')
  assert.equal(settleHttpStatus({ code: 'no_broadcaster' }), 501, 'no broadcaster is a configuration fact')
  assert.equal(settleHttpStatus({ code: 'unconfirmed', ambiguous: true }), 202, 'unconfirmed is not failed')
  assert.equal(settleHttpStatus({ code: 'settlement_failed' }), 502)
  assert.equal(settleHttpStatus({ code: 'fee_ceiling' }), 502)
  assert.equal(settleHttpStatus({ code: 'bad_signature' }), 502)
  // Nothing that is merely unconfirmed may ever come back as a failure.
  for (const code of ['unconfirmed', 'broadcast_failed'] as const) {
    assert.equal(settleHttpStatus({ code, ambiguous: true }), 202, `${code} with ambiguous must not read as failed`)
  }
})

test('a replayed authorization is refused before anything is broadcast', async () => {
  let broadcast = false
  const r = await stellarSettle(
    payloadBody(),
    settleDeps({
      loadSpent: async () => [stellarPaymentKey('stellar:testnet', SAC, BUYER, NONCE)],
      ozSubmit: async () => { broadcast = true; return { ok: true, txHash: TX } },
    }),
  )
  assert.equal(r.body.code, 'already_redeemed')
  assert.equal(broadcast, false)
})

/**
 * The whole point of a facilitator's /supported: what it advertises must be what /settle
 * will actually do. This asserts the pair rather than each alone.
 */
test('every advertised network can actually be settled on', async () => {
  const kinds = stellarSupported(ENV).body.kinds as { network: string; x402Version: number }[]
  const v2 = kinds.filter((x) => x.x402Version === 2)
  // Guard against passing vacuously: an empty advertisement would satisfy the loop below
  // while proving nothing, which is how this test would rot into decoration.
  assert.ok(v2.length > 0, 'this test proves nothing unless something is advertised')
  for (const k of v2) {
    const r = await stellarSettle(payloadBody({}, { network: k.network }), settleDeps())
    assert.notEqual(r.httpStatus, 501, `${k.network} is advertised but /settle says it is not configured`)
  }
})
