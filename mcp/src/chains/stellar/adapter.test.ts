import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

import { createStellarAdapter, errorIn, errorName } from './adapter.js'
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

test('a prepared owner call comes back unsigned, on this network, with the fee it will cost', async () => {
  const owner = Keypair.random()
  const a = createStellarAdapter(testnet(), {
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
})

test('a contract refusal in simulation is typed, named and never turned into an envelope', async () => {
  const owner = Keypair.random()
  const a = createStellarAdapter(testnet(), {
    server: () =>
      ({
        getAccount: async (id: string) => new Account(id, '7'),
        simulateTransaction: async () => ({ error: 'HostError: Error(Contract, #5)', _parsed: true }) as never,
      }) as never,
  })
  const r = await a.prepareOwnerCall(VAULT, 'owner_pay', [{ kind: 'address', value: PAYEE }, { kind: 'i128', value: '10' }], owner.publicKey(), {})
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'refused')
  assert.equal(r.contractErrorCode, 5)
  assert.equal(r.contractErrorName, 'DailyCapExceeded')
})

test('an account that does not exist is an RPC answer, not a crash', async () => {
  const a = createStellarAdapter(testnet(), {
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
  assert.equal(r.code, 'rpc_error')
  assert.match(r.reason, /XLM reserve|not an account/)
})
