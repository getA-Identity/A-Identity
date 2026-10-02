import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Keypair, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import type { Transaction } from '@stellar/stellar-sdk'

import { CHAINS } from '../registry.js'
import type { ChainDescriptor } from '../types.js'
import { networkPassphrase } from './client.js'
import { decodeTxEvidence, fetchTxEvidence, indexerApiBase, type HttpFetch } from './tx-evidence.js'
import {
  PASSKEY_SET_POLICY,
  PUBNET_SET_FROZEN,
  REFUSED_OVER_LIMIT,
  REFUSED_OVER_LIMIT_META,
  TESTNET_SET_FROZEN,
} from './fixtures/tx-evidence-fixtures.js'

/**
 * The evidence decoder against four real transactions, committed as fixtures so no assertion
 * here needs a network. What each one pins is a claim we publish beside its hash: that the
 * 2026-09-19 set_policy was authorized by a WebAuthn signer through the OpenZeppelin verifier
 * with flags UP and UV from origin a-identity.xyz, who paid each fee, and that the over-limit
 * payment was refused with the contract's DailyCapExceeded rather than failing some other way.
 */

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet') as ChainDescriptor
const pubnet = CHAINS.find((c) => c.id === 'stellar') as ChainDescriptor
const TESTNET_PASS = networkPassphrase(testnet)
const PUBNET_PASS = networkPassphrase(pubnet)

test('the passkey set_policy decodes to one WebAuthn signer through a registry verifier, flags 0x05 and our origin', () => {
  const ev = decodeTxEvidence(PASSKEY_SET_POLICY.envelope_xdr, PASSKEY_SET_POLICY.result_xdr, null, TESTNET_PASS, { chain: testnet })
  assert.equal(ev.hash, PASSKEY_SET_POLICY.hash)
  assert.equal(ev.status, 'success')
  assert.equal(ev.resultCode.tx, 'txSuccess')
  assert.deepEqual(ev.resultCode.operations, ['invokeHostFunctionSuccess'])
  assert.equal(ev.feeAccount, PASSKEY_SET_POLICY.fee_account)
  assert.equal(ev.sourceAccount, PASSKEY_SET_POLICY.source_account)
  assert.equal(ev.feeChargedStroops, PASSKEY_SET_POLICY.fee_charged)
  assert.equal(ev.feeBump, false)

  // The operation: execute on the smart account, forwarding set_policy to the passkey vault.
  const [op] = ev.operations
  assert.equal(op?.function, 'execute')
  assert.equal(op?.args?.[0], testnet.contracts.passkeyVault)
  assert.equal(op?.args?.[1], 'set_policy')

  assert.equal(ev.auth.length, 1)
  const [a] = ev.auth
  assert.equal(a?.credential, 'address')
  assert.equal(a?.address, op?.contract, 'the smart account authorizes its own execute')
  assert.equal(a?.rootInvocation.function, 'execute')
  assert.deepEqual(a?.contextRuleIds, [0])
  assert.equal(a?.signers.length, 1)
  const [s] = a?.signers ?? []
  assert.equal(s?.kind, 'webauthn-secp256r1')
  // The rehearsal signed through smart-account-kit's testnet verifier, which the registry
  // now keeps as a FORMER verifier (testnet moved to our own v0.7.2 build on 2026-10-01).
  // It still decodes as WebAuthn, and it is not the current one.
  assert.ok(testnet.contracts.smartAccount?.formerWebauthnVerifiers?.includes(String(s?.verifier)))
  assert.notEqual(s?.verifier, testnet.contracts.smartAccount?.webauthnVerifier)
  assert.equal(s?.publicKeyHex?.length, 130, 'a 65-byte uncompressed P-256 point')
  assert.ok(s?.publicKeyHex?.startsWith('04'))
  assert.equal(s?.credentialIdHex?.length, 64)

  const w = s?.webauthn
  assert.ok(w)
  assert.equal(w.authenticatorData.flagsByte, '0x05')
  assert.deepEqual(w.authenticatorData.flags, { UP: true, UV: true, BE: false, BS: false, AT: false, ED: false })
  assert.equal(w.authenticatorData.signCount, 1)
  assert.equal(w.authenticatorData.rpIdMatchesOrigin, true)
  assert.equal(w.clientDataJSON.type, 'webauthn.get')
  assert.equal(w.clientDataJSON.origin, 'https://a-identity.xyz')
  assert.equal(w.signatureLength, 64)
  // The challenge is the entry's own auth digest, recomputed here, and the P-256 signature
  // verifies under the stored key: the passkey signed exactly this call.
  assert.equal(w.challengeBinding, 'auth-digest')
  assert.equal(w.signatureVerifies, true)
  assert.equal(w.clientDataJSON.challenge, Buffer.from(a?.authDigestHex ?? '', 'hex').toString('base64url'))
})

test('a WebAuthn signer always carries the caveat that the chain cannot tell a device from a software key', () => {
  const ev = decodeTxEvidence(PASSKEY_SET_POLICY.envelope_xdr, PASSKEY_SET_POLICY.result_xdr, null, TESTNET_PASS, { chain: testnet })
  assert.ok(ev.caveats.some((c) => /software P-256 key/.test(c) && /flags and the origin/.test(c)))
  assert.match(ev.summary, /WebAuthn \(secp256r1\) passkey/)
  assert.match(ev.summary, /flags UP, UV/)
  assert.match(ev.summary, /origin https:\/\/a-identity\.xyz/)
  assert.match(ev.summary, new RegExp(`paid by ${PASSKEY_SET_POLICY.fee_account.slice(0, 6)}`))
})

test('the challenge binding depends on the network: the same entry under the pubnet passphrase does not match', () => {
  const ev = decodeTxEvidence(PASSKEY_SET_POLICY.envelope_xdr, PASSKEY_SET_POLICY.result_xdr, null, PUBNET_PASS, { chain: testnet })
  assert.equal(ev.auth[0]?.signers[0]?.webauthn?.challengeBinding, 'no-match')
})

test('a verifier the registry does not record for that chain is reported as unknown, never guessed', () => {
  const ev = decodeTxEvidence(PASSKEY_SET_POLICY.envelope_xdr, PASSKEY_SET_POLICY.result_xdr, null, TESTNET_PASS, { chain: pubnet })
  const s = ev.auth[0]?.signers[0]
  assert.equal(s?.kind, 'unknown')
  assert.equal(s?.webauthn, null)
  assert.ok(s?.note)
})

test('the refused over-limit payment decodes to txFailed, a trapped host function and DailyCapExceeded from the meta', () => {
  const ev = decodeTxEvidence(REFUSED_OVER_LIMIT.envelope_xdr, REFUSED_OVER_LIMIT.result_xdr, REFUSED_OVER_LIMIT_META, TESTNET_PASS, { chain: testnet })
  assert.equal(ev.hash, REFUSED_OVER_LIMIT.hash)
  assert.equal(ev.status, 'failed')
  assert.equal(ev.resultCode.tx, 'txFailed')
  assert.deepEqual(ev.resultCode.operations, ['invokeHostFunctionTrapped'])
  assert.equal(ev.resultCode.contractError?.code, 5)
  assert.equal(ev.resultCode.contractError?.name, 'DailyCapExceeded')
  assert.equal(ev.resultCode.contractError?.contract, testnet.contracts.spendVault)
  assert.equal(ev.operations[0]?.function, 'pay')
  assert.equal(ev.feeAccount, REFUSED_OVER_LIMIT.fee_account)
  assert.equal(ev.feeChargedStroops, REFUSED_OVER_LIMIT.fee_charged)
  assert.match(ev.summary, /error 5 \(DailyCapExceeded\)/)
  assert.match(ev.summary, /fee was still charged/)
})

test('without meta the refusal is still a failure, and the decoder says the error code is unrecoverable instead of inventing one', () => {
  const ev = decodeTxEvidence(REFUSED_OVER_LIMIT.envelope_xdr, REFUSED_OVER_LIMIT.result_xdr, null, TESTNET_PASS, { chain: testnet })
  assert.equal(ev.status, 'failed')
  assert.equal(ev.resultCode.contractError, null)
  assert.ok(ev.caveats.some((c) => /No result meta/.test(c)))
})

/** A contract-scoped `error` diagnostic event, base64, the shape a failed call emits per frame. */
function errorEventXdr(contract: string, code: number): string {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(contract) as never,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvString('escalating Ok(ScErrorType::Contract) frame-exit to Err'),
        }),
      ),
    }),
  }).toXDR('base64')
}

/** The refused pay envelope, decoded against these diagnostic events instead of its own meta. */
function refusedWith(events: string[]) {
  return decodeTxEvidence(REFUSED_OVER_LIMIT.envelope_xdr, REFUSED_OVER_LIMIT.result_xdr, null, TESTNET_PASS, {
    chain: testnet,
    diagnosticEventsXdr: events,
  })
}

test('a code a callee raised and the vault re-emitted is attributed to the callee, the first raiser, and is not named', () => {
  const vault = testnet.contracts.spendVault as string
  // A stand-in token contract: a random id, so nothing here claims a real address.
  const token = StrKey.encodeContract(randomBytes(32))
  // Emission order, oldest first: the token raises, then the vault re-emits as it unwinds.
  const nested = refusedWith([errorEventXdr(token, 13), errorEventXdr(vault, 13)])
  assert.equal(nested.resultCode.contractError?.code, 13)
  assert.equal(nested.resultCode.contractError?.contract, token)
  assert.equal(nested.resultCode.contractError?.name, null)
  // #9 is a code pay CAN raise, so blaming the vault would name it InsufficientBalance.
  const inTable = refusedWith([errorEventXdr(token, 9), errorEventXdr(vault, 9)])
  assert.equal(inTable.resultCode.contractError?.contract, token)
  assert.equal(inTable.resultCode.contractError?.name, null)
  assert.match(inTable.resultCode.contractError?.nameBasis ?? '', /^Not named/)
})

test('a vault code is named only when the called entrypoint can raise it: #10 against pay stays a number', () => {
  const vault = testnet.contracts.spendVault as string
  const ev = refusedWith([errorEventXdr(vault, 10)])
  assert.equal(ev.resultCode.contractError?.code, 10)
  assert.equal(ev.resultCode.contractError?.contract, vault)
  assert.equal(ev.resultCode.contractError?.name, null)
  const own = refusedWith([errorEventXdr(vault, 5)])
  assert.equal(own.resultCode.contractError?.name, 'DailyCapExceeded')
})

test('the owner freezes on testnet and pubnet carry source-account credentials: the transaction source is the authorizer and the fee payer', () => {
  for (const [fx, pass, chain] of [
    [TESTNET_SET_FROZEN, TESTNET_PASS, testnet],
    [PUBNET_SET_FROZEN, PUBNET_PASS, pubnet],
  ] as const) {
    const ev = decodeTxEvidence(fx.envelope_xdr, fx.result_xdr, null, pass, { chain })
    assert.equal(ev.hash, fx.hash)
    assert.equal(ev.status, 'success')
    assert.equal(ev.operations[0]?.contract, chain.contracts.spendVault)
    assert.equal(ev.operations[0]?.function, 'set_frozen')
    assert.deepEqual(ev.operations[0]?.args, [true])
    assert.equal(ev.auth.length, 1)
    assert.equal(ev.auth[0]?.credential, 'source_account')
    assert.equal(ev.auth[0]?.address, fx.source_account)
    assert.deepEqual(ev.auth[0]?.signers, [])
    assert.equal(ev.feeAccount, fx.fee_account)
    assert.equal(ev.feeAccount, ev.sourceAccount)
    assert.match(ev.summary, /as the transaction source/)
  }
})

test('a fee bump names its outer source as the fee payer and keeps the inner source as the source', () => {
  const inner = TransactionBuilder.fromXDR(PASSKEY_SET_POLICY.envelope_xdr, TESTNET_PASS) as Transaction
  const sponsor = Keypair.random()
  const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, '1000000', inner, TESTNET_PASS)
  bump.sign(sponsor)
  const original = xdr.TransactionResult.fromXDR(PASSKEY_SET_POLICY.result_xdr, 'base64')
  const result = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('400000'),
    result: xdr.TransactionResultResult.txFeeBumpInnerSuccess(
      new xdr.InnerTransactionResultPair({
        transactionHash: inner.hash(),
        result: new xdr.InnerTransactionResult({
          feeCharged: original.feeCharged(),
          result: xdr.InnerTransactionResultResult.txSuccess(original.result().results()),
          ext: new xdr.InnerTransactionResultExt(0),
        }),
      }),
    ),
    ext: new xdr.TransactionResultExt(0),
  })
  const ev = decodeTxEvidence(bump.toEnvelope().toXDR('base64'), result.toXDR('base64'), null, TESTNET_PASS, { chain: testnet })
  assert.equal(ev.feeBump, true)
  assert.equal(ev.feeAccount, sponsor.publicKey())
  assert.equal(ev.sourceAccount, PASSKEY_SET_POLICY.source_account)
  assert.equal(ev.innerHash, PASSKEY_SET_POLICY.hash)
  assert.notEqual(ev.hash, PASSKEY_SET_POLICY.hash)
  assert.equal(ev.status, 'success')
  assert.equal(ev.resultCode.tx, 'txFeeBumpInnerSuccess')
  assert.equal(ev.resultCode.inner, 'txSuccess')
  assert.equal(ev.feeChargedStroops, '400000')
  assert.match(ev.summary, /through a fee bump/)
})

// ── fetching, with an injected fetcher ────────────────────────────────────────────

type Call = { url: string; method: string }
type Reply = { status: number; body?: unknown } | Error

/** A fetcher that answers by URL prefix, in order, and records every call. */
function fakeFetch(routes: [prefix: string, reply: Reply][]): { fetch: HttpFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const hit = routes.find(([p]) => url.startsWith(p))
    if (!hit) throw new Error(`unexpected fetch ${url}`)
    const r = hit[1]
    if (r instanceof Error) throw r
    return { status: r.status, json: async () => r.body }
  }
  return { fetch, calls }
}

const rpcNotFound: Reply = { status: 200, body: { jsonrpc: '2.0', id: 1, result: { status: 'NOT_FOUND', latestLedger: 1 } } }
const horizonOf = (fx: typeof REFUSED_OVER_LIMIT): Reply => ({ status: 200, body: { ...fx } })
const NO_ENV = {} as NodeJS.ProcessEnv
const FAST = { env: NO_ENV, retryDelayMs: 0 }

function rpcRoutes(chain: ChainDescriptor, reply: Reply): [string, Reply][] {
  return chain.rpcUrls.map((u) => [u, reply])
}

test('RPC past its window falls back to Horizon, and indexer meta is accepted only beside an identical envelope and result', async () => {
  const indexer = indexerApiBase(testnet) as string
  assert.ok(indexer)
  const { fetch, calls } = fakeFetch([
    ...rpcRoutes(testnet, rpcNotFound),
    [testnet.horizonUrls?.[0] as string, horizonOf(REFUSED_OVER_LIMIT)],
    [indexer, { status: 200, body: { body: REFUSED_OVER_LIMIT.envelope_xdr, result: REFUSED_OVER_LIMIT.result_xdr, meta: REFUSED_OVER_LIMIT_META } }],
  ])
  const r = await fetchTxEvidence(testnet, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST })
  assert.ok(r.ok)
  assert.equal(r.record.fetchedFrom, 'horizon')
  assert.equal(r.record.ledger, REFUSED_OVER_LIMIT.ledger)
  assert.equal(r.record.status, 'FAILED')
  assert.equal(r.record.metaFrom, 'stellar-expert')
  assert.equal(r.evidence.resultCode.contractError?.name, 'DailyCapExceeded')
  assert.ok(r.evidence.caveats.some((c) => /third-party indexer/.test(c)))
  // Every RPC host the registry declares was asked first, then Horizon, then the indexer.
  assert.deepEqual(
    calls.map((c) => c.url.slice(0, 30)),
    [...testnet.rpcUrls, `${testnet.horizonUrls?.[0]}/transactions/`, `${indexer}/tx/`].map((u) => u.slice(0, 30)),
  )
})

test('indexer meta that arrives beside a different envelope is refused, so the error stays unnamed', async () => {
  const indexer = indexerApiBase(testnet) as string
  const { fetch } = fakeFetch([
    ...rpcRoutes(testnet, rpcNotFound),
    [testnet.horizonUrls?.[0] as string, horizonOf(REFUSED_OVER_LIMIT)],
    [indexer, { status: 200, body: { body: TESTNET_SET_FROZEN.envelope_xdr, result: REFUSED_OVER_LIMIT.result_xdr, meta: REFUSED_OVER_LIMIT_META } }],
  ])
  const r = await fetchTxEvidence(testnet, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST })
  assert.ok(r.ok)
  assert.equal(r.record.resultMetaXdr, null)
  assert.equal(r.record.metaFrom, null)
  assert.ok(r.record.metaNote)
  assert.equal(r.evidence.resultCode.contractError, null)
  assert.ok(r.record.tried.some((t) => t.source === 'indexer' && t.outcome === 'mismatch'))
})

test('an RPC that still has the transaction answers alone, with its createdAt turned into ISO and its meta kept', async () => {
  const { fetch, calls } = fakeFetch(
    rpcRoutes(testnet, {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: 'FAILED',
          ledger: REFUSED_OVER_LIMIT.ledger,
          createdAt: String(Date.parse(REFUSED_OVER_LIMIT.created_at) / 1000),
          envelopeXdr: REFUSED_OVER_LIMIT.envelope_xdr,
          resultXdr: REFUSED_OVER_LIMIT.result_xdr,
          resultMetaXdr: REFUSED_OVER_LIMIT_META,
        },
      },
    }),
  )
  const r = await fetchTxEvidence(testnet, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST })
  assert.ok(r.ok)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(r.record.fetchedFrom, 'rpc')
  assert.equal(r.record.metaFrom, 'rpc')
  assert.equal(r.record.createdAt, new Date(REFUSED_OVER_LIMIT.created_at).toISOString())
  assert.equal(r.evidence.resultCode.contractError?.code, 5)
})

test('not found everywhere is not_found; nobody answering is read_failed; the two are never confused', async () => {
  const gone = fakeFetch([...rpcRoutes(testnet, rpcNotFound), [testnet.horizonUrls?.[0] as string, { status: 404 }]])
  const a = await fetchTxEvidence(testnet, 'ab'.repeat(32), { fetch: gone.fetch, ...FAST })
  assert.equal(a.ok, false)
  assert.equal(!a.ok && a.code, 'not_found')

  const down = fakeFetch([...rpcRoutes(testnet, new Error('fetch failed')), [testnet.horizonUrls?.[0] as string, { status: 503 }]])
  const b = await fetchTxEvidence(testnet, 'ab'.repeat(32), { fetch: down.fetch, ...FAST })
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.code, 'read_failed')
  assert.ok(!b.ok && b.tried.every((t) => t.outcome === 'unreachable'))
})

test('RPC saying not found while Horizon cannot be read is read_failed, because RPC only remembers a week', async () => {
  const { fetch } = fakeFetch([...rpcRoutes(testnet, rpcNotFound), [testnet.horizonUrls?.[0] as string, { status: 429 }]])
  const r = await fetchTxEvidence(testnet, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST })
  assert.equal(!r.ok && r.code, 'read_failed')
  assert.match(!r.ok ? r.reason : '', /about a week/)
})

test('one Horizon 404 is asked again before it counts, since a public Horizon is a pool of nodes', async () => {
  let horizonCalls = 0
  const base = fakeFetch(rpcRoutes(testnet, rpcNotFound))
  const fetch: HttpFetch = async (url, init) => {
    if (url.startsWith(testnet.horizonUrls?.[0] as string)) {
      horizonCalls += 1
      const body = { ...REFUSED_OVER_LIMIT }
      return horizonCalls === 1 ? { status: 404, json: async () => ({}) } : { status: 200, json: async () => body }
    }
    return base.fetch(url, init)
  }
  const r = await fetchTxEvidence(testnet, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST, indexerMeta: false })
  assert.ok(r.ok)
  assert.equal(horizonCalls, 2)
})

test('a host that serves a different transaction than the hash asked for is a mismatch, never evidence', async () => {
  const { fetch } = fakeFetch([...rpcRoutes(testnet, rpcNotFound), [testnet.horizonUrls?.[0] as string, horizonOf(TESTNET_SET_FROZEN)]])
  const r = await fetchTxEvidence(testnet, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST, indexerMeta: false })
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.tried.some((t) => t.source === 'horizon' && t.outcome === 'mismatch'))
})

test('a malformed hash or a non-Stellar chain is refused before any fetch', async () => {
  const { fetch, calls } = fakeFetch([])
  const a = await fetchTxEvidence(testnet, 'not-a-hash', { fetch, ...FAST })
  assert.equal(!a.ok && a.code, 'bad_request')
  const evm = CHAINS.find((c) => c.ecosystem === 'evm') as ChainDescriptor
  const b = await fetchTxEvidence(evm, REFUSED_OVER_LIMIT.hash, { fetch, ...FAST })
  assert.equal(!b.ok && b.code, 'bad_request')
  assert.equal(calls.length, 0)
})

test('the indexer base is derived from the registry explorer, and only for Stellar', () => {
  const base = indexerApiBase(testnet) as string
  const explorer = new URL(testnet.explorer as string)
  assert.equal(new URL(base).host, `api.${explorer.host}`)
  assert.equal(new URL(base).pathname, explorer.pathname)
  assert.equal(indexerApiBase(CHAINS.find((c) => c.ecosystem === 'evm') as ChainDescriptor), null)
})
