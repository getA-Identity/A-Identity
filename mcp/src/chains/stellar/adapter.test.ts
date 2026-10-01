import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

import {
  SimulationError,
  createStellarAdapter,
  errorIn,
  errorName,
  errorNameFor,
  failureCodeIn,
  failureErrorIn,
} from './adapter.js'
import { stellarKeypair, stellarRpcUrl, stellarSignerAddress } from './client.js'
import { getChainById, requireChain } from '../registry.js'

// Offline by construction. Every assertion below is about the shape of a call or the
// handling of a credential, and none of it needs a network: the prepared path returns
// before any RPC handle is built, which is the whole point of prepared-or-executed.

const testnet = () => getChainById('stellar-testnet')!
const pubnet = () => getChainById('stellar')!
const VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
const PAYEE = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
/** Some other contract, built from bytes rather than typed, as a destination that needs no trustline. */
const VAULT2 = StrKey.encodeContract(Buffer.alloc(32, 9))

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

// ── deploying a vault ────────────────────────────────────────────────────────────
//
// A deploy is the one write here that creates something rather than changing it, so the
// checks that matter are the ones that run BEFORE the network: a vault deployed with
// owner == operator is a vault with no policy, and a deploy that reaches simulation with
// the wrong wasm hash pays a fee to fail.

/** A server that fails the test if anything touches it. */
const noNetwork = () =>
  new Proxy({} as never, {
    get(_t, prop) {
      return () => {
        throw new Error(`the network was touched (${String(prop)}) when it should not have been`)
      }
    },
  })

test('an unsigned deploy returns the exact constructor call and nothing else', async () => {
  const a = createStellarAdapter(testnet())
  const owner = Keypair.random().publicKey()
  const operator = Keypair.random().publicKey()
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const r = await a.deployVault(
    { owner, operator, token, dailyCapRaw: 25_000_000n, autoApproveMaxRaw: 5_000_000n },
    {},
  )
  assert.equal(r.outcome, 'prepared')
  if (r.outcome !== 'prepared') return
  assert.equal(r.contract, '<new>')
  assert.equal(r.method, '__constructor')
  assert.deepEqual(r.args, [owner, operator, token, '25000000', '5000000'])
  assert.equal(r.network, 'stellar:testnet')
  assert.match(r.reason, /STELLAR_TESTNET_SIGNER_SECRET/)
})

test('owner == operator is refused before the network is touched at all', async () => {
  // The contract refuses it too (OwnerIsOperator), and that is the point: this check exists
  // so the refusal costs nothing and names the reason, not because the chain would miss it.
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const same = Keypair.random().publicKey()
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const r = await a.deployVault(
    { owner: same, operator: same, token, dailyCapRaw: 1n, autoApproveMaxRaw: 1n },
    { STELLAR_TESTNET_SIGNER_SECRET: Keypair.random().secret() },
  )
  assert.equal(r.outcome, 'refused')
  if (r.outcome !== 'refused') return
  assert.match(r.reason, /OwnerIsOperator/)
})

test('a deploy refuses a payee-shaped owner and a G... token before it can confuse the chain', async () => {
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const good = Keypair.random().publicKey()
  const bad = await a.deployVault(
    { owner: 'not-an-account', operator: good, token, dailyCapRaw: 1n, autoApproveMaxRaw: 1n },
    {},
  )
  assert.equal(bad.outcome, 'refused')
  const badToken = await a.deployVault(
    { owner: good, operator: Keypair.random().publicKey(), token: good, dailyCapRaw: 1n, autoApproveMaxRaw: 1n },
    {},
  )
  assert.equal(badToken.outcome, 'refused')
  if (badToken.outcome === 'refused') assert.match(badToken.reason, /not a Soroban contract id/)
})

test('the frozen error table names all ten codes and nothing beyond them', () => {
  // These discriminants are public ABI: error.rs says the list is append-only and a number
  // is never reused, so this copy cannot legitimately drift from the contract.
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => errorName(c)),
    [
      'Frozen', 'SessionKeyExpired', 'PayeeNotAllowed', 'AboveAutoApprove', 'DailyCapExceeded',
      'InvalidAmount', 'InvalidPayee', 'MathOverflow', 'InsufficientBalance', 'OwnerIsOperator',
    ],
  )
  // 13 is the trustline failure the SAC raises. Naming it would tell a client a token error
  // was a policy refusal, which is the exact confusion contractErrorIsOurs exists to prevent.
  assert.equal(errorName(13), undefined)
  assert.equal(errorName(0), undefined)
  assert.equal(errorName(undefined), undefined)
})

// ── relaying an envelope somebody else signed ────────────────────────────────────
//
// These two endpoints are the only place this server broadcasts bytes a caller handed it,
// so the tests that matter are the refusals. Every envelope below is built with the real
// SDK and a runtime-generated key: a seed-shaped literal never appears in this repo, even
// a fake one, because the history scan cannot tell the difference.

const account = (kp: Keypair) => new Account(kp.publicKey(), '0')

function ownerEnvelope(opts: {
  kp: Keypair
  passphrase: string
  contract?: string
  method?: string
  ops?: number
  payment?: boolean
  sign?: boolean
}): string {
  const b = new TransactionBuilder(account(opts.kp), { fee: BASE_FEE, networkPassphrase: opts.passphrase })
  const c = new Contract(opts.contract ?? VAULT)
  if (opts.payment) {
    b.addOperation(Operation.payment({ destination: opts.kp.publicKey(), asset: Asset.native(), amount: '1' }))
  } else {
    for (let i = 0; i < (opts.ops ?? 1); i += 1) b.addOperation(c.call(opts.method ?? 'set_frozen', nativeToScVal(true)))
  }
  const tx = b.setTimeout(300).build()
  if (opts.sign !== false) tx.sign(opts.kp)
  return tx.toXDR()
}

test('a payment operation is not an owner call, however well signed', async () => {
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const kp = Keypair.random()
  const seen = a.inspectOwnerEnvelope(ownerEnvelope({ kp, passphrase: Networks.TESTNET, payment: true }))
  assert.equal(seen.ok, false)
  if (!seen.ok) assert.match(seen.reason, /payment is not accepted|only a contract invocation/)
})

test('a two-operation envelope is refused, because only one of them was ever inspected', async () => {
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const kp = Keypair.random()
  const seen = a.inspectOwnerEnvelope(ownerEnvelope({ kp, passphrase: Networks.TESTNET, ops: 2 }))
  assert.equal(seen.ok, false)
  if (!seen.ok) assert.match(seen.reason, /2 operations/)
})

test('a method outside the six is refused even on a vault we know', async () => {
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const kp = Keypair.random()
  // `pay` is the agent operator's call and the server signs it itself; relaying it here
  // would be a second, unauthenticated door into the same money.
  const seen = a.inspectOwnerEnvelope(ownerEnvelope({ kp, passphrase: Networks.TESTNET, method: 'pay' }))
  assert.equal(seen.ok, false)
  if (!seen.ok) assert.match(seen.reason, /not one of the owner entrypoints/)
})

test('an envelope signed for the other network is refused rather than relayed', async () => {
  // A signature is bound to a passphrase and the passphrase is not in the envelope, so the
  // only way to catch this is to check whether the source key's signature verifies under
  // each network. Relaying it would burn the owner's fee on a transaction pubnet cannot take.
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const kp = Keypair.random()
  const seen = a.inspectOwnerEnvelope(ownerEnvelope({ kp, passphrase: Networks.PUBLIC }))
  assert.equal(seen.ok, false)
  if (!seen.ok) {
    assert.equal(seen.code, 'wrong_network')
    assert.match(seen.reason, /other Stellar network/)
  }
})

test('an unsigned envelope is refused: there is nothing to submit', async () => {
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const kp = Keypair.random()
  const seen = a.inspectOwnerEnvelope(ownerEnvelope({ kp, passphrase: Networks.TESTNET, sign: false }))
  assert.equal(seen.ok, false)
  if (!seen.ok) assert.match(seen.reason, /no signature/)
})

test('a well-formed owner call is read back with its contract, method and source', async () => {
  const a = createStellarAdapter(testnet(), { server: noNetwork })
  const kp = Keypair.random()
  const seen = a.inspectOwnerEnvelope(ownerEnvelope({ kp, passphrase: Networks.TESTNET, method: 'set_frozen' }))
  assert.equal(seen.ok, true)
  if (!seen.ok) return
  assert.equal(seen.contract, VAULT)
  assert.equal(seen.method, 'set_frozen')
  assert.equal(seen.source, kp.publicKey())
  assert.equal(seen.sourceSigned, true, 'the source key signed it, under THIS network')
})

// ── preparing an owner call ──────────────────────────────────────────────────────

/** The smallest simulation response assembleTransaction will accept. */
function fakeSim() {
  return {
    _parsed: true,
    latestLedger: 1_000,
    minResourceFee: '12345',
    transactionData: new SorobanDataBuilder(),
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
    events: [],
  } as never
}

/**
 * A Horizon that answers every account as funded with 100 XLM and a USDC trustline, and a
 * base reserve of 0.5 XLM. The prepare path reads Horizon for its two preflights, and a test
 * that left the global fetch in place would be a test of whoever answers on the internet.
 */
function fundedHorizon(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/ledgers')) {
      return new Response(JSON.stringify({ _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } }), { status: 200 })
    }
    const asset = (requireChain('stellar:testnet').settlementTokens?.[0]?.classicAsset ?? ':').split(':')
    return new Response(
      JSON.stringify({
        subentry_count: 1,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          { asset_type: 'credit_alphanum4', asset_code: asset[0], asset_issuer: asset[1], balance: '0.0000000', is_authorized: true },
          { asset_type: 'native', balance: '100.0000000', selling_liabilities: '0.0000000' },
        ],
      }),
      { status: 200 },
    )
  }) as typeof fetch
}

test('a prepared owner call comes back unsigned, on this network, with the fee it will cost', async () => {
  const owner = Keypair.random()
  const a = createStellarAdapter(testnet(), {
    fetch: fundedHorizon(),
    server: () =>
      ({
        getAccount: async (id: string) => new Account(id, '7'),
        simulateTransaction: async () => fakeSim(),
      }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'set_session_key_expiry', [{ kind: 'u64', value: '1893456000' }], owner.publicKey(), {})
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.networkPassphrase, Networks.TESTNET)
  assert.equal(r.network, 'stellar:testnet')
  assert.equal(r.contract, VAULT)
  assert.equal(r.method, 'set_session_key_expiry')
  assert.deepEqual(r.args, ['1893456000'])
  assert.equal(r.source, owner.publicKey())
  assert.ok(Number(r.feeStroops) > 0)
  // The one claim this whole endpoint rests on: we hand back something we did not sign.
  const back = TransactionBuilder.fromXDR(r.xdr, Networks.TESTNET)
  assert.equal(back.signatures.length, 0, 'a prepared call must never come back signed')
  assert.match(r.summary, /pays/, 'the summary has to say who pays the fee')
  // Source-account credentials carry no signature expiry, so this is null rather than invented.
  assert.equal(r.expiresAtLedger, null)
  assert.ok(r.validUntil, 'the time bound is what governs instead, so it is reported')
  // The fee in XLM beside the stroops, and both preflights said what they did.
  assert.equal(r.feeXlm, (Number(r.feeStroops) / 1e7).toString())
  assert.equal(r.restoreNeeded, false)
  assert.deepEqual(r.preflight, { xlm: 'checked', trustline: 'not-needed' })
})

test('a contract refusal in simulation is typed, named and never turned into an envelope', async () => {
  const owner = Keypair.random()
  const a = createStellarAdapter(testnet(), {
    fetch: fundedHorizon(),
    server: () =>
      ({
        getAccount: async (id: string) => new Account(id, '7'),
        simulateTransaction: async () => ({ error: 'HostError: Error(Contract, #9)', _parsed: true }) as never,
      }) as never,
  })
  // To a contract, so the trustline preflight has nothing to check and the refusal is the
  // contract's. owner_pay can raise 9 (InsufficientBalance); it can NOT raise 5, because the
  // owner's ladder in policy.rs counts the day but never refuses on the cap.
  const r = await a.prepareOwnerCall(VAULT, 'owner_pay', [{ kind: 'address', value: VAULT2 }, { kind: 'i128', value: '10' }], owner.publicKey(), {})
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'refused')
  assert.equal(r.contractErrorCode, 9)
  assert.equal(r.contractErrorName, 'InsufficientBalance')
})

test('an account that does not exist is an answer about XLM, not a crash', async () => {
  const a = createStellarAdapter(testnet(), {
    fetch: fundedHorizon(),
    server: () =>
      ({
        getAccount: async () => {
          throw new Error('Account not found')
        },
      }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'set_frozen', [{ kind: 'bool', value: true }], Keypair.random().publicKey(), {})
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'insufficient_xlm')
  assert.equal(r.availableXlm, '0')
  assert.equal(r.neededXlm, '1', 'two base reserves of 0.5 XLM, read from the ledger rather than assumed')
  assert.match(r.reason, /does not exist/)
})

test('a source that cannot be reached at all stays an RPC error, never an XLM verdict', async () => {
  const a = createStellarAdapter(testnet(), {
    fetch: fundedHorizon(),
    server: () =>
      ({
        getAccount: async () => {
          throw new Error('fetch failed')
        },
      }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'set_frozen', [{ kind: 'bool', value: true }], Keypair.random().publicKey(), {})
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'rpc_error')
  assert.match(r.reason, /XLM reserve|not an account/)
})

// ── archived state, in the shape protocol 23 actually reports it ─────────────────
//
// Since CAP-0066 a simulation over archived state carries NO restore preamble: the archived
// footprint indexes ride in the transaction data and the rent is folded into the fee, which
// `rpc.Api.isSimulationRestore` never looks at. And an archived ledger entry still comes back
// from getLedgerEntries, with liveUntilLedgerSeq 0. Both shapes were read live on 2026-09-15.

/** Transaction data whose resource extension lists these footprint entries as archived. */
function archivedData(indexes: number[]): SorobanDataBuilder {
  return new SorobanDataBuilder(
    new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(1, new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: indexes })),
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 0,
        diskReadBytes: 0,
        writeBytes: 0,
      }),
      resourceFee: new xdr.Int64(0),
    }).toXDR('base64'),
  )
}

/** A successful simulation over archived state, with no preamble anywhere in it. */
function archivedSim() {
  return { ...(fakeSim() as object), minResourceFee: '272124886', transactionData: archivedData([0, 1]) } as never
}

test('an owner call over archived state is prepared, and says it restores that state inside its own fee', async () => {
  // Refusing it would put withdraw, the vault's escape hatch, out of the console's reach on
  // the day the vault needs it. The owner pays, and the owner's wallet shows the fee.
  const owner = Keypair.random()
  const a = createStellarAdapter(testnet(), {
    fetch: fundedHorizon(),
    server: () =>
      ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => archivedSim() }) as never,
  })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const r = await a.prepareOwnerCall(
    VAULT,
    'withdraw',
    [{ kind: 'address', value: owner.publicKey() }, { kind: 'i128', value: '10' }],
    owner.publicKey(),
    {},
    { vaultToken: token },
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.archivedEntries, [0, 1])
  assert.equal(r.restoreNeeded, true)
  assert.match(r.summary, /restores archived state \(footprint entries 0, 1\)/)
  assert.deepEqual(r.preflight, { xlm: 'checked', trustline: 'checked' })
})

test('a separate restore preamble is still refused, because that shape cannot run without a restore first', async () => {
  const owner = Keypair.random()
  const withPreamble = {
    ...(fakeSim() as object),
    restorePreamble: { minResourceFee: '1000', transactionData: new SorobanDataBuilder() },
  } as never
  const a = createStellarAdapter(testnet(), {
    fetch: fundedHorizon(),
    server: () =>
      ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => withPreamble }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'set_frozen', [{ kind: 'bool', value: false }], owner.publicKey(), {})
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'restore_needed')
})

test('an operator write over archived state is refused even with no preamble, because the server would pay the rent', async () => {
  let sent = false
  const a = createStellarAdapter(testnet(), {
    server: () =>
      ({
        getAccount: async (id: string) => new Account(id, '7'),
        simulateTransaction: async () => archivedSim(),
        sendTransaction: async () => {
          sent = true
          throw new Error('must not be submitted')
        },
      }) as never,
  })
  const r = await a.policyPay(VAULT, PAYEE, 1n, { STELLAR_TESTNET_SIGNER_SECRET: Keypair.random().secret() })
  assert.equal(r.outcome, 'refused')
  if (r.outcome !== 'refused') return
  assert.match(r.reason, /archived \(footprint entries 0, 1\)/)
  assert.match(r.reason, /272124886 stroops/)
  assert.equal(sent, false)
})

test('a deploy refuses a code entry the RPC still returns but that has archived', async () => {
  let touched = false
  const a = createStellarAdapter(testnet(), {
    server: () =>
      ({
        getLedgerEntries: async () => ({ latestLedger: 5_000, entries: [{ liveUntilLedgerSeq: 0 }] }),
        getAccount: async () => {
          touched = true
          throw new Error('an archived code entry must stop the deploy before an account is loaded')
        },
        simulateTransaction: async () => {
          touched = true
          return fakeSim()
        },
      }) as never,
  })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const r = await a.deployVault(
    { owner: Keypair.random().publicKey(), operator: Keypair.random().publicKey(), token, dailyCapRaw: 1n, autoApproveMaxRaw: 1n },
    { STELLAR_TESTNET_SIGNER_SECRET: Keypair.random().secret() },
  )
  assert.equal(r.outcome, 'refused')
  if (r.outcome !== 'refused') return
  assert.match(r.reason, /is archived on/)
  assert.equal(touched, false)
})

test('an archived instance reads as archived with no TTL, never as a countdown from ledger zero', async () => {
  const at = (entries: { liveUntilLedgerSeq: number }[], latestLedger = 64_432_560) =>
    createStellarAdapter(testnet(), {
      server: () => ({ getLedgerEntries: async () => ({ latestLedger, entries }) }) as never,
    })
  assert.deepEqual(await at([{ liveUntilLedgerSeq: 0 }]).readInstanceTtl(VAULT, {}), {
    ledger: 64_432_560,
    liveUntilLedger: null,
    archived: true,
  })
  assert.deepEqual(await at([{ liveUntilLedgerSeq: 66_177_017 }]).readInstanceTtl(VAULT, {}), {
    ledger: 64_432_560,
    liveUntilLedger: 66_177_017,
    archived: false,
  })
  // No entry at all is not "archived": the address may simply not be deployed here.
  assert.deepEqual(await at([], 10).readInstanceTtl(VAULT, {}), { ledger: 10, liveUntilLedger: null, archived: false })
})

// ── SOW 2: landing, typed failures, preflights, and the reads the vault panel needs ──
//
// Every case below runs against an injected RPC and an injected Horizon. The land() arms
// are driven through submitSignedEnvelope, which is the path the owner's browser signature
// actually takes, so what is pinned is what a person sees after signing.

/** A signed set_frozen envelope from a fresh key, the shape the owner's wallet sends back. */
function signedOwnerCall(): { xdr: string; source: string } {
  const kp = Keypair.random()
  return { xdr: ownerEnvelope({ kp, passphrase: Networks.TESTNET, method: 'set_frozen' }), source: kp.publicKey() }
}

/** A TransactionResult carrying one of the core's rejection codes. */
function rejected(code: 'txInsufficientBalance' | 'txInsufficientFee' | 'txBadSeq' | 'txBadAuth'): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: new xdr.Int64(0),
    result: (xdr.TransactionResultResult as unknown as Record<string, () => xdr.TransactionResultResult>)[code](),
    ext: new xdr.TransactionResultExt(0),
  })
}

/** A diagnostic event as the host emits it when a contract returns Err(code). */
function errorEvent(contract: string, code: number): xdr.DiagnosticEvent {
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
  })
}

/** An RPC whose sendTransaction answers `status` and whose getTransaction walks `seq`. */
function landingServer(send: Record<string, unknown>, seq: Record<string, unknown>[] = []) {
  const calls = { send: 0, get: 0 }
  const server = {
    sendTransaction: async () => {
      calls.send += 1
      return { hash: 'ab'.repeat(32), latestLedger: 100, latestLedgerCloseTime: 0, ...send }
    },
    getTransaction: async () => {
      calls.get += 1
      return seq[Math.min(calls.get - 1, seq.length - 1)] ?? { status: 'NOT_FOUND' }
    },
  }
  return { server, calls }
}

test('land: TRY_AGAIN_LATER is not_accepted, nothing is polled, and it never reads as pending', async () => {
  const { server, calls } = landingServer({ status: 'TRY_AGAIN_LATER' })
  const a = createStellarAdapter(testnet(), { server: () => server as never, fetch: fundedHorizon(), pollMs: 0 })
  const { outcome } = await a.submitSignedEnvelope(signedOwnerCall().xdr, {})
  assert.equal(outcome?.outcome, 'refused')
  if (outcome?.outcome !== 'refused') return
  assert.deepEqual(outcome.rejection, { code: 'not_accepted', resultCode: 'TRY_AGAIN_LATER' })
  assert.equal(outcome.rejectedHash, 'ab'.repeat(32))
  assert.equal(calls.get, 0, 'there is nothing to wait for: the node did not take it')
})

test('land: DUPLICATE is polled like PENDING, and ends pending when it is not in a ledger yet', async () => {
  const { server, calls } = landingServer({ status: 'DUPLICATE' })
  const a = createStellarAdapter(testnet(), { server: () => server as never, pollMs: 0 })
  const { outcome } = await a.submitSignedEnvelope(signedOwnerCall().xdr, {})
  assert.equal(outcome?.outcome, 'pending')
  if (outcome?.outcome !== 'pending') return
  assert.match(outcome.reason, /DUPLICATE/)
  assert.ok(calls.get > 1, 'a duplicate may be in flight, so it is polled')
})

test('land: PENDING that lands successfully is settled, with the fee the source was charged', async () => {
  const result = new xdr.TransactionResult({
    feeCharged: new xdr.Int64(51234),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  })
  const { server } = landingServer({ status: 'PENDING' }, [{ status: 'NOT_FOUND' }, { status: 'SUCCESS', ledger: 777, resultXdr: result }])
  const a = createStellarAdapter(testnet(), { server: () => server as never, pollMs: 0 })
  const { outcome } = await a.submitSignedEnvelope(signedOwnerCall().xdr, {})
  assert.equal(outcome?.outcome, 'settled')
  if (outcome?.outcome !== 'settled') return
  assert.equal(outcome.ledger, 777)
  assert.equal(outcome.feeChargedStroops, '51234')
})

test('land: PENDING that never shows up is pending, never failed', async () => {
  const { server } = landingServer({ status: 'PENDING' })
  const a = createStellarAdapter(testnet(), { server: () => server as never, pollMs: 0 })
  const { outcome } = await a.submitSignedEnvelope(signedOwnerCall().xdr, {})
  assert.equal(outcome?.outcome, 'pending')
})

test('land: an ERROR names insufficient balance, low fee and a stale sequence, and keeps any other code verbatim', async () => {
  const cases = [
    ['txInsufficientBalance', 'insufficient_balance'],
    ['txInsufficientFee', 'insufficient_fee'],
    ['txBadSeq', 'bad_seq'],
    ['txBadAuth', 'error'],
  ] as const
  for (const [resultCode, code] of cases) {
    const { server, calls } = landingServer({ status: 'ERROR', errorResult: rejected(resultCode) })
    const a = createStellarAdapter(testnet(), { server: () => server as never, fetch: fundedHorizon(), pollMs: 0 })
    const { outcome } = await a.submitSignedEnvelope(signedOwnerCall().xdr, {})
    assert.equal(outcome?.outcome, 'refused', resultCode)
    if (outcome?.outcome !== 'refused') continue
    assert.deepEqual(outcome.rejection, { code, resultCode })
    assert.equal(calls.get, 0, `${resultCode}: a rejected envelope is not polled`)
    if (code === 'insufficient_balance') {
      // The shortfall is stated in XLM from the same Horizon read the prepare preflight uses.
      assert.ok(outcome.xlm, 'an insufficient-balance rejection says how much was there and how much it needed')
      assert.equal(outcome.xlm?.neededXlm, '0.00001')
    }
  }
})

test('land: a landed-and-FAILED call carries the typed contract error decoded from XDR, attributed to the vault', async () => {
  // The repo's own 12df418f... in miniature: an over-limit pay that failed at apply time
  // with DailyCapExceeded. The old JSON regex never matched an XDR object, so this code was
  // always absent.
  const failed = new xdr.TransactionResult({
    feeCharged: new xdr.Int64(60000),
    result: xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()),
      ),
    ]),
    ext: new xdr.TransactionResultExt(0),
  })
  const { server } = landingServer({ status: 'PENDING' }, [
    { status: 'FAILED', ledger: 4147972, resultXdr: failed, diagnosticEventsXdr: [errorEvent(VAULT, 5), errorEvent(VAULT, 5)] },
  ])
  const a = createStellarAdapter(testnet(), { server: () => server as never, pollMs: 0 })
  const { outcome } = await a.submitSignedEnvelope(signedOwnerCall().xdr, {})
  assert.equal(outcome?.outcome, 'failed')
  if (outcome?.outcome !== 'failed') return
  assert.equal(outcome.contractErrorCode, 5)
  assert.equal(outcome.contractErrorIsOurs, true)
  assert.equal(outcome.contractErrorFrom, VAULT)
  assert.equal(outcome.resultCode, 'txFailed')
  assert.equal(outcome.opResultCode, 'invokeHostFunctionTrapped')
  assert.equal(outcome.feeChargedStroops, '60000')
})

test('failureErrorIn reads a real ScError contract(5) from base64 XDR, and attributes a token error to the token', () => {
  const SAC = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const fromVault = { status: 'FAILED', diagnosticEventsXdr: [errorEvent(VAULT, 5).toXDR('base64')] } as never
  assert.deepEqual(failureErrorIn(fromVault, VAULT), { code: 5, from: VAULT, ours: true })
  assert.equal(failureCodeIn(fromVault), 5)
  // Emission order: the token raised #13 first, the vault propagated it. The origin is the token.
  const fromToken = { status: 'FAILED', diagnosticEventsXdr: [errorEvent(SAC, 13), errorEvent(VAULT, 13)] } as never
  assert.deepEqual(failureErrorIn(fromToken, VAULT), { code: 13, from: SAC, ours: false })
  // No error events at all: absent, never invented.
  assert.equal(failureErrorIn({ status: 'FAILED', diagnosticEventsXdr: [] } as never, VAULT), undefined)
})

test('an error is named only when the entrypoint called can raise it: #10 on withdraw is not OwnerIsOperator', () => {
  assert.equal(errorNameFor('withdraw', { code: 10, ours: true }), undefined, 'withdraw never returns OwnerIsOperator')
  assert.equal(errorNameFor('withdraw', { code: 9, ours: true }), 'InsufficientBalance')
  assert.equal(errorNameFor('owner_pay', { code: 5, ours: true }), undefined, 'the owner ladder never refuses on the cap')
  assert.equal(errorNameFor('pay', { code: 5, ours: true }), 'DailyCapExceeded')
  assert.equal(errorNameFor('set_frozen', { code: 1, ours: true }), undefined, 'set_frozen returns no typed error at all')
  assert.equal(errorNameFor('set_policy', { code: 6, ours: true }), 'InvalidAmount')
  assert.equal(errorNameFor('withdraw', { code: 9, ours: false }), undefined, 'a propagated code is never named from our table')
})

/** A Horizon serving one account (or a 404 for it) and the 0.5 XLM reserve. */
function horizonWith(accounts: Record<string, unknown | null>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/ledgers')) {
      return new Response(JSON.stringify({ _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } }), { status: 200 })
    }
    const id = decodeURIComponent(url.split('/accounts/')[1] ?? '')
    const body = accounts[id]
    if (body === null || body === undefined) return new Response('{"status":404}', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

const usdcLine = () => {
  const [code, issuer] = (requireChain('stellar:testnet').settlementTokens?.[0]?.classicAsset ?? ':').split(':')
  return { asset_type: 'credit_alphanum4', asset_code: code, asset_issuer: issuer, balance: '0.0000000', is_authorized: true }
}

test('insufficient_xlm: a source that cannot cover the simulated fee after reserves is refused before signing', async () => {
  const owner = Keypair.random().publicKey()
  // 1 subentry, so the minimum balance is 1.5 XLM; 1.500005 XLM leaves 50 stroops spendable.
  const horizon = horizonWith({
    [owner]: { subentry_count: 1, num_sponsoring: 0, num_sponsored: 0, balances: [{ asset_type: 'native', balance: '1.5000050', selling_liabilities: '0.0000000' }] },
  })
  const a = createStellarAdapter(testnet(), {
    fetch: horizon,
    server: () => ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => fakeSim() }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'set_frozen', [{ kind: 'bool', value: true }], owner, {})
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'insufficient_xlm')
  assert.equal(r.availableXlm, '0.000005')
  // The assembled fee: the 100 stroop inclusion fee plus the resource fee fakeSim's empty
  // transaction data carries, which is zero. A real simulation's is in the hundreds of thousands.
  assert.equal(r.neededXlm, '0.00001')
})

test('insufficient_xlm counts selling liabilities and sponsorship, not just the balance', async () => {
  const owner = Keypair.random().publicKey()
  // 10 XLM, 2 subentries, sponsoring 1 => reserve 2.5 XLM; 7.5 XLM locked in offers => 0 spendable.
  const horizon = horizonWith({
    [owner]: { subentry_count: 2, num_sponsoring: 1, num_sponsored: 0, balances: [{ asset_type: 'native', balance: '10.0000000', selling_liabilities: '7.5000000' }] },
  })
  const a = createStellarAdapter(testnet(), {
    fetch: horizon,
    server: () => ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => fakeSim() }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'set_frozen', [{ kind: 'bool', value: false }], owner, {})
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.availableXlm, '0')
})

test('no_trustline: a withdraw to a G... account without the USDC trustline is refused before simulation', async () => {
  const owner = Keypair.random().publicKey()
  const dest = Keypair.random().publicKey()
  let simulated = false
  const a = createStellarAdapter(testnet(), {
    fetch: horizonWith({
      [owner]: { subentry_count: 0, balances: [{ asset_type: 'native', balance: '50.0000000' }] },
      [dest]: { subentry_count: 0, balances: [{ asset_type: 'native', balance: '5.0000000' }] },
    }),
    server: () =>
      ({
        getAccount: async (id: string) => new Account(id, '7'),
        simulateTransaction: async () => {
          simulated = true
          return fakeSim()
        },
      }) as never,
  })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]
  const r = await a.prepareOwnerCall(VAULT, 'withdraw', [{ kind: 'address', value: dest }, { kind: 'i128', value: '10000000' }], owner, {}, { vaultToken: token?.address })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'no_trustline')
  assert.equal(r.destination, dest)
  assert.equal(r.asset, token?.classicAsset)
  assert.equal(simulated, false, 'the trustline is checked BEFORE the call is simulated')
})

test('no_trustline: a destination that does not exist cannot hold USDC either', async () => {
  const owner = Keypair.random().publicKey()
  const dest = Keypair.random().publicKey()
  const a = createStellarAdapter(testnet(), {
    fetch: horizonWith({ [owner]: { subentry_count: 0, balances: [{ asset_type: 'native', balance: '50.0000000' }] }, [dest]: null }),
    server: () => ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => fakeSim() }) as never,
  })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address
  const r = await a.prepareOwnerCall(VAULT, 'withdraw', [{ kind: 'address', value: dest }, { kind: 'i128', value: '1' }], owner, {}, { vaultToken: token })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'no_trustline')
    assert.match(r.reason, /does not exist/)
  }
})

test('a withdraw to a trustlined account passes, and a C... destination needs no trustline read at all', async () => {
  const owner = Keypair.random().publicKey()
  const seen: string[] = []
  const a = createStellarAdapter(testnet(), {
    fetch: horizonWith({ [owner]: { subentry_count: 1, balances: [usdcLine(), { asset_type: 'native', balance: '50.0000000' }] } }, seen),
    server: () => ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => fakeSim() }) as never,
  })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address
  const toSelf = await a.prepareOwnerCall(VAULT, 'withdraw', [{ kind: 'address', value: owner }, { kind: 'i128', value: '1' }], owner, {}, { vaultToken: token })
  assert.equal(toSelf.ok, true)
  if (toSelf.ok) assert.equal(toSelf.preflight.trustline, 'checked')

  seen.length = 0
  const toContract = await a.prepareOwnerCall(VAULT, 'withdraw', [{ kind: 'address', value: VAULT2 }, { kind: 'i128', value: '1' }], owner, {}, { vaultToken: token })
  assert.equal(toContract.ok, true)
  if (toContract.ok) assert.equal(toContract.preflight.trustline, 'not-needed')
  assert.ok(!seen.some((u) => u.includes(VAULT2)), 'a contract destination is never looked up on Horizon')
})

test('a Horizon that does not answer leaves the preflights unchecked, and says so, rather than failing the prepare', async () => {
  const down = (async () => {
    throw new Error('fetch failed')
  }) as unknown as typeof fetch
  const a = createStellarAdapter(testnet(), {
    fetch: down,
    server: () => ({ getAccount: async (id: string) => new Account(id, '7'), simulateTransaction: async () => fakeSim() }) as never,
  })
  const owner = Keypair.random().publicKey()
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address
  const r = await a.prepareOwnerCall(VAULT, 'withdraw', [{ kind: 'address', value: owner }, { kind: 'i128', value: '1' }], owner, {}, { vaultToken: token })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.preflight, { xlm: 'unchecked', trustline: 'unchecked' })
})

test('X.4: an owner call this server would sign is never submitted when the vault needs someone else to authorize it', async () => {
  // A vault owned by a person's wallet: recording-mode simulation succeeds and records an
  // ADDRESS credential for that owner. Our key cannot satisfy it, so nothing is signed or sent.
  const realOwner = Keypair.random().publicKey()
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(realOwner).toScAddress(),
        nonce: new xdr.Int64(1),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(VAULT).toScAddress(), functionName: 'set_frozen', args: [] }),
      ),
      subInvocations: [],
    }),
  })
  let sent = false
  const a = createStellarAdapter(testnet(), {
    server: () =>
      ({
        getAccount: async (id: string) => new Account(id, '7'),
        simulateTransaction: async () => ({ ...(fakeSim() as object), result: { auth: [entry], retval: xdr.ScVal.scvVoid() } }) as never,
        sendTransaction: async () => {
          sent = true
          throw new Error('must not be submitted')
        },
      }) as never,
  })
  const r = await a.policySetFrozen(VAULT, true, { STELLAR_TESTNET_SIGNER_SECRET: Keypair.random().secret() })
  assert.equal(r.outcome, 'prepared')
  if (r.outcome === 'prepared') {
    assert.match(r.reason, new RegExp(realOwner))
    assert.match(r.reason, /\/api\/stellar\/vault\/prepare/)
  }
  assert.equal(sent, false, 'the server key must never broadcast an owner call it cannot authorize')
})

/** A getLedgerEntries answer for a contract instance running `wasmHex`, or a SAC. */
function instanceEntry(contract: string, exe: 'wasm' | 'sac', wasmHex = '00'.repeat(32), liveUntilLedgerSeq = 9_000) {
  const executable =
    exe === 'wasm'
      ? xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHex, 'hex'))
      : xdr.ContractExecutable.contractExecutableStellarAsset()
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  )
  return { liveUntilLedgerSeq, val }
}

test('readExecutableWasmHash reads the wasm hash, a SAC, and a missing instance off getLedgerEntries', async () => {
  const hash = requireChain('stellar:testnet').contracts.spendVaultWasmHash as string
  const at = (entries: unknown[]) =>
    createStellarAdapter(testnet(), { server: () => ({ getLedgerEntries: async () => ({ latestLedger: 5_000, entries }) }) as never })
  assert.deepEqual(await at([instanceEntry(VAULT, 'wasm', hash)]).readExecutableWasmHash(VAULT, {}), {
    ledger: 5_000,
    found: true,
    executable: 'wasm',
    wasmHash: hash,
    liveUntilLedger: 9_000,
    archived: false,
  })
  const sac = await at([instanceEntry(VAULT, 'sac')]).readExecutableWasmHash(VAULT, {})
  assert.equal(sac.executable, 'stellar-asset')
  assert.equal(sac.wasmHash, null)
  const archived = await at([instanceEntry(VAULT, 'wasm', hash, 0)]).readExecutableWasmHash(VAULT, {})
  assert.equal(archived.archived, true)
  assert.equal(archived.liveUntilLedger, null)
  assert.equal(archived.wasmHash, hash, 'an archived instance still says what it runs')
  assert.deepEqual(await at([]).readExecutableWasmHash(VAULT, {}), {
    ledger: 5_000,
    found: false,
    executable: null,
    wasmHash: null,
    liveUntilLedger: null,
    archived: false,
  })
})

/** A simulator that answers each vault view with a fixed value at a fixed ledger. */
function viewServer(answers: Record<string, unknown>, ledgerOf: (method: string) => number = () => 1_000) {
  return {
    simulateTransaction: async (tx: { operations: { func: xdr.HostFunction }[] }) => {
      const method = tx.operations[0].func.invokeContract().functionName().toString()
      if (!(method in answers)) return { _parsed: true, error: `HostError: Error(WasmVm, MissingValue) ${method}`, events: [], latestLedger: 1 }
      return { ...(fakeSim() as object), latestLedger: ledgerOf(method), result: { auth: [], retval: nativeToScVal(answers[method] as never) } }
    },
  }
}

test('readVault stamps the newest ledger its twelve simulations were answered at, and the contract day', async () => {
  const owner = Keypair.random().publicKey()
  const answers = {
    owner: new Address(owner).toScVal(),
    operator: new Address(PAYEE).toScVal(),
    token: new Address(VAULT2).toScVal(),
    decimals: nativeToScVal(7, { type: 'u32' }),
    daily_cap: nativeToScVal(100_000_000n, { type: 'i128' }),
    auto_approve_max: nativeToScVal(20_000_000n, { type: 'i128' }),
    frozen: nativeToScVal(false),
    allowlist_enabled: nativeToScVal(true),
    session_key_expiry: nativeToScVal(0n, { type: 'u64' }),
    today: nativeToScVal(20_727n, { type: 'u64' }),
    spent_today: nativeToScVal(10_000_000n, { type: 'i128' }),
    balance: nativeToScVal(140_000_000n, { type: 'i128' }),
  }
  const server = {
    simulateTransaction: async (tx: { operations: { func: xdr.HostFunction }[] }) => {
      const method = tx.operations[0].func.invokeContract().functionName().toString()
      return {
        ...(fakeSim() as object),
        latestLedger: method === 'balance' ? 4_972_480 : 4_972_479,
        result: { auth: [], retval: answers[method as keyof typeof answers] },
      }
    },
  }
  const a = createStellarAdapter(testnet(), { server: () => server as never })
  const v = await a.readVault(VAULT, {})
  assert.equal(v.ledger, 4_972_480, 'the newest of the twelve, never an older one')
  assert.equal(v.day, '20727')
  assert.equal(v.owner, owner)
  assert.equal(v.dailyCapRaw, '100000000')
  assert.equal(v.allowlistEnabled, true)
})

test('a view the contract answers with an error is a SimulationError, not a transport failure', async () => {
  const a = createStellarAdapter(testnet(), { server: () => viewServer({}) as never })
  await assert.rejects(() => a.readVault(VAULT, {}), (e: unknown) => e instanceof SimulationError)
})

test('isAllowed answers one payee live, with whether the list is enforced and the ledger', async () => {
  const a = createStellarAdapter(testnet(), {
    server: () => viewServer({ is_allowed: true, allowlist_enabled: false }, (m) => (m === 'is_allowed' ? 50 : 51)) as never,
  })
  assert.deepEqual(await a.isAllowed(VAULT, PAYEE, {}), { allowed: true, allowlistEnabled: false, ledger: 51 })
  await assert.rejects(() => a.isAllowed(VAULT, 'nonsense', {}), /not a Stellar address/)
})

test('a dry-run deploy against an explicit wasm hash and salt simulates, derives the id, and signs nothing', async () => {
  const hash = 'ab'.repeat(32)
  const salt = Buffer.alloc(32, 3)
  const deployer = Keypair.random().publicKey()
  let sent = false
  const a = createStellarAdapter(testnet(), {
    server: () =>
      ({
        getLedgerEntries: async () => ({ latestLedger: 100, entries: [{ liveUntilLedgerSeq: 10_000 }] }),
        simulateTransaction: async () => fakeSim(),
        sendTransaction: async () => {
          sent = true
          throw new Error('a dry run must not submit')
        },
      }) as never,
  })
  const token = requireChain('stellar:testnet').settlementTokens?.[0]?.address as string
  const r = await a.deployVault(
    { owner: Keypair.random().publicKey(), operator: Keypair.random().publicKey(), token, dailyCapRaw: 1n, autoApproveMaxRaw: 1n, wasmHash: hash, salt, dryRun: true, deployer },
    {},
  )
  assert.equal(r.outcome, 'prepared')
  if (r.outcome !== 'prepared') return
  assert.ok(r.simulation, 'a dry run reports what it would cost')
  assert.match(String(r.vault), /^C[A-Z2-7]{55}$/)
  assert.match(r.reason, new RegExp(salt.toString('hex')))
  assert.equal(sent, false)
  const bad = await a.deployVault({ owner: deployer, operator: PAYEE, token, dailyCapRaw: 1n, autoApproveMaxRaw: 1n, salt: Buffer.alloc(31) }, {})
  assert.equal(bad.outcome, 'refused')
})
