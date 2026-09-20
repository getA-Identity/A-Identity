import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Address, Keypair, Operation, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk'

import { CHAINS } from '../chains/index.js'
import type { CallOutcome, VaultState } from '../chains/stellar/adapter.js'
import { __resetPlatformStateForTests } from '../platform.js'
import { createRelayBudget, type PasskeyRelayLimits } from '../stellar-passkey.js'
import { handleStellarPasskeyRoutes, type PasskeyAdapter, type PasskeyRouteDeps } from './stellar-passkey-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * The passkey surface at the boundary a browser actually codes against.
 *
 * Everything with a decision in it is tested in ../stellar-passkey.test.ts, where it is
 * pure. What is left here is the part a pure test cannot see: that the XDR a real client
 * sends decodes into the shape those rules were written against, which status code each
 * refusal carries, and, above all, that a refusal happens BEFORE the relayer is called or
 * the ledger is read.
 *
 * That last one is the property rather than a testing convenience. These endpoints sit in
 * front of no session, so a request nobody should be able to make must not cost us a fee, a
 * round trip, or a use of our credential. Every fetch and every adapter call below is
 * counted, and the refusal cases assert the counts are zero.
 *
 * Every key here is generated at runtime. A seed-shaped literal never appears in this repo,
 * even a fake one, because the history scan cannot tell the difference; the same goes for
 * anything that would read as WebAuthn credential material, which is why the authorization
 * entries below carry scvVoid where a real signature would be.
 */

__resetPlatformStateForTests()

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet')!
const WASM = testnet.contracts.smartAccount!.wasmHash
const TOKEN = testnet.settlementTokens![0]!.address

const contractId = (): string => StrKey.encodeContract(randomBytes(32))
const accountId = (): string => Keypair.random().publicKey()

// ── the request and response the handler sees ────────────────────────────────────

function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown> } = {}
  return {
    out,
    res: {
      setHeader: () => {},
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

async function call(method: 'GET' | 'POST', path: string, body: unknown, deps: PasskeyRouteDeps = {}) {
  const { out, res } = fakeRes()
  const req = {
    method,
    headers: {},
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return this
    },
  } as never
  const ctx: RouteCtx = { req, res, url: new URL(`http://localhost${path}`), caller: null, callerId: undefined }
  const handled = await handleStellarPasskeyRoutes(ctx, deps)
  return { handled, status: out.status, body: (out.body ?? {}) as Record<string, unknown> }
}

// ── hand-built XDR, the same structures the smart-account kit sends ──────────────

function invokeFunc(contract: string, method: string, args: xdr.ScVal[] = []): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: method,
      args,
    }),
  )
}

/** The kit's `execute(target, target_fn, target_args)` on a smart account. */
function executeFunc(smartAccount: string, target: string, targetFn: string): xdr.HostFunction {
  return invokeFunc(smartAccount, 'execute', [
    xdr.ScVal.scvAddress(new Address(target).toScAddress()),
    xdr.ScVal.scvSymbol(targetFn),
    xdr.ScVal.scvVec([nativeToScVal(true)]),
  ])
}

function deployFunc(deployer: string, wasmHex: string): xdr.HostFunction {
  const op = Operation.createCustomContract({
    address: new Address(deployer),
    wasmHash: Buffer.from(wasmHex, 'hex'),
    salt: randomBytes(32),
    constructorArgs: [nativeToScVal(true)],
  })
  return op.body().invokeHostFunctionOp().hostFunction()
}

function authorizedFn(func: xdr.HostFunction): xdr.SorobanAuthorizedFunction {
  return func.switch().name === 'hostFunctionTypeInvokeContract'
    ? xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func.invokeContract())
    : xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(func.createContractV2())
}

/** An entry authorizing exactly `func`. `who` null means source-account credentials. */
function authEntry(func: xdr.HostFunction, who: string | null, subs: xdr.SorobanAuthorizedInvocation[] = []): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: who
      ? xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(who).toScAddress(),
            nonce: new xdr.Int64(7),
            signatureExpirationLedger: 99,
            // A real entry carries the passkey's assertion here. Nothing in this repo ever
            // needs one, so it is void: the relay checks WHAT is authorized, and the host
            // checks the signature.
            signature: xdr.ScVal.scvVoid(),
          }),
        )
      : xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: authorizedFn(func), subInvocations: subs }),
  })
}

const relayBody = (func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[], extra: Record<string, unknown> = {}) => ({
  func: func.toXDR('base64'),
  auth: auth.map((a) => a.toXDR('base64')),
  ...extra,
})

// ── stubs that count what they were asked to do ──────────────────────────────────

const vaultState = (over: Partial<VaultState> = {}): VaultState => ({
  owner: contractId(),
  operator: accountId(),
  token: TOKEN,
  decimals: 7,
  dailyCapRaw: '50000000',
  autoApproveMaxRaw: '10000000',
  frozen: false,
  allowlistEnabled: true,
  sessionKeyExpiry: '0',
  day: '20355',
  spentTodayRaw: '0',
  balanceRaw: '30000000',
  ...over,
})

type Spy = { reads: string[]; fetches: string[] }

function stubs(over: Partial<PasskeyAdapter> = {}): { deps: PasskeyRouteDeps; spy: Spy; signer: string } {
  const spy: Spy = { reads: [], fetches: [] }
  const signer = accountId()
  const adapter: PasskeyAdapter = {
    readVault: async (vault: string) => {
      spy.reads.push(vault)
      return vaultState({ operator: signer })
    },
    deployVault: async () => ({ outcome: 'refused', contract: '<new>', method: '__constructor', args: [], network: testnet.caip2, reason: 'no stub' }),
    readTokenBalance: async () => 0n,
    sacTransferFromSigner: async () => ({ outcome: 'refused', contract: TOKEN, method: 'transfer', args: [], network: testnet.caip2, reason: 'no stub' }),
    policyPay: async () => ({ outcome: 'refused', contract: '', method: 'pay', args: [], network: testnet.caip2, reason: 'no stub' }),
    ...over,
  }
  return {
    spy,
    signer,
    deps: {
      env: {},
      adapter: () => adapter,
      signerAddress: () => signer,
      fetch: (async (url: string) => {
        spy.fetches.push(String(url))
        throw new Error('this test must not reach the relayer')
      }) as unknown as typeof fetch,
      agents: () => [],
      linkedSubjects: () => [],
    },
  }
}

// ── the group's own boundary ─────────────────────────────────────────────────────

test('a path this group does not own is passed on, not swallowed', async () => {
  const r = await call('POST', '/api/stellar/vault/prepare', {})
  assert.equal(r.handled, false, 'returning true here would shadow the vault relay')
})

// ── status ───────────────────────────────────────────────────────────────────────

test('status says what is configured, names the key variable, and carries no credential', async () => {
  const { deps } = stubs()
  const r = await call('GET', '/api/stellar/passkey/status', undefined, deps)
  assert.equal(r.status, 200)
  const relayer = r.body.relayer as Record<string, unknown>
  assert.equal(relayer.product, 'OpenZeppelin Relayer (Channels)')
  assert.equal(relayer.keyVar, 'X402_STELLAR_TESTNET_OZ_KEY')
  assert.equal(relayer.keyConfigured, false, 'an empty env must read as unconfigured, never as ready')
  assert.equal(r.body.testnetOnly, true)
  assert.equal((r.body.smartAccount as Record<string, unknown>).wasmHash, WASM)
  assert.equal(JSON.stringify(r.body).includes('Bearer '), false)
})

test('status refuses pubnet with the reason, rather than answering about testnet', async () => {
  const { deps } = stubs()
  const r = await call('GET', '/api/stellar/passkey/status?network=stellar', undefined, deps)
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'testnet_only')
  assert.match(String(r.body.reason), /TESTNET ONLY/)
})

// ── the relay, fail-closed ───────────────────────────────────────────────────────

test('the relay refuses a body that is neither of the kit\'s two shapes', async () => {
  const { deps, spy } = stubs()
  for (const body of [{}, { func: 'x' }, { auth: ['x'] }, { func: 'x', auth: ['y'], xdr: 'z' }]) {
    const r = await call('POST', '/api/stellar/passkey/relay', body, deps)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.body.success, false)
  }
  assert.deepEqual(spy.fetches, [], 'a malformed body must never reach the relayer')
})

test('the relay refuses pubnet before it decodes anything', async () => {
  const { deps, spy } = stubs()
  const func = deployFunc(accountId(), WASM)
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, accountId())], { network: 'stellar' }), deps)
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'testnet_only')
  assert.deepEqual(spy.fetches, [])
})

test('func that is not XDR at all is refused with what is wrong, and costs nothing', async () => {
  const { deps, spy } = stubs()
  const r = await call('POST', '/api/stellar/passkey/relay', { func: 'this is not base64 XDR', auth: [] }, deps)
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /HostFunction/)
  assert.deepEqual(spy.fetches, [])
  assert.deepEqual(spy.reads, [])
})

test('a smart-account deploy against the registry\'s wasm hash is accepted, and without a key it is prepared', async () => {
  const { deps, spy } = stubs()
  const deployer = accountId()
  const func = deployFunc(deployer, WASM)
  const body = relayBody(func, [authEntry(func, deployer)])
  const r = await call('POST', '/api/stellar/passkey/relay', body, deps)
  // Prepared-or-executed: the request was understood and accepted, and nothing was posted.
  assert.equal(r.status, 501)
  assert.equal(r.body.success, false)
  assert.equal(r.body.outcome, 'prepared')
  assert.equal(r.body.rule, 'smart-account-deploy')
  assert.match(String(r.body.reason), /X402_STELLAR_TESTNET_OZ_KEY is unset/)
  // The payload is the exact thing that would be posted, with the key named, not carried.
  const payload = r.body.payload as Record<string, unknown>
  assert.deepEqual(payload.body, { params: { func: body.func, auth: body.auth } })
  assert.equal((payload.headers as Record<string, string>).Authorization, 'Bearer <X402_STELLAR_TESTNET_OZ_KEY>')
  assert.match(String(payload.url), /channels\.openzeppelin\.com/)
  assert.deepEqual(spy.fetches, [], 'a prepared answer forwards nothing')
})

test('REFUSAL: a deploy of any other wasm is not paid for, however well it is signed', async () => {
  const { deps, spy } = stubs()
  const deployer = accountId()
  const func = deployFunc(deployer, 'ab'.repeat(32))
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, deployer)]), deps)
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /only executable this relay pays to create/)
  assert.deepEqual(spy.fetches, [])
})

test('REFUSAL: an authorization entry that names a DIFFERENT call cannot ride along', async () => {
  const { deps, spy } = stubs()
  const smartAccount = contractId()
  const vault = contractId()
  const func = executeFunc(smartAccount, vault, 'set_policy')
  // Signed authority for a withdraw, presented alongside a set_policy.
  const wrong = authEntry(executeFunc(smartAccount, vault, 'withdraw'), smartAccount)
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [wrong]), deps)
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /authorizes something other than this exact/)
  assert.deepEqual(spy.reads, [], 'a refusal on the payload must not cost a ledger read')
})

test('REFUSAL: execute() carrying pay is refused, because pay is the operator\'s call', async () => {
  const { deps } = stubs()
  const smartAccount = contractId()
  const vault = contractId()
  const func = executeFunc(smartAccount, vault, 'pay')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), deps)
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /only a vault owner entrypoint is relayed/)
})

test('REFUSAL: a source-account authorization would be the relayer authorizing itself', async () => {
  const { deps } = stubs()
  const smartAccount = contractId()
  const func = executeFunc(smartAccount, contractId(), 'set_frozen')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, null)]), deps)
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /channel account/)
})

test('REFUSAL: a vault this server does not operate is not one it will pay for', async () => {
  const { deps, spy } = stubs({ readVault: async (v: string) => { spy.reads.push(v); return vaultState() } })
  const smartAccount = contractId()
  const vault = contractId()
  const func = executeFunc(smartAccount, vault, 'set_allowed')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), deps)
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'not_our_vault')
  assert.deepEqual(spy.reads, [vault], 'the operator is read live, from the vault the request names')
  assert.deepEqual(spy.fetches, [])
})

test('REFUSAL: a vault read that does not answer stops the request at 502', async () => {
  const { deps, spy } = stubs({ readVault: async () => { throw new Error('ETIMEDOUT') } })
  const smartAccount = contractId()
  const func = executeFunc(smartAccount, contractId(), 'set_policy')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), deps)
  assert.equal(r.status, 502)
  assert.equal(r.body.code, 'rpc_error')
  assert.deepEqual(spy.fetches, [])
})

test('a passkey-signed owner call on a vault we operate is forwarded, and the answer keeps the kit\'s shape', async () => {
  const smartAccount = contractId()
  const vault = contractId()
  const hash = 'a1'.repeat(32)
  const { deps, spy, signer } = stubs()
  const posted: { url?: string; auth?: string; body?: unknown } = {}
  const withKey: PasskeyRouteDeps = {
    ...deps,
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' },
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async (v: string) => {
        spy.reads.push(v)
        return vaultState({ owner: smartAccount, operator: signer })
      },
    }),
    fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posted.url = String(url)
      posted.auth = init.headers.Authorization
      posted.body = JSON.parse(init.body)
      return { status: 200, json: async () => ({ success: true, data: { transactionId: 'tx-abc', status: 'submitted', hash } }) }
    }) as unknown as typeof fetch,
  }
  const func = executeFunc(smartAccount, vault, 'set_policy')
  const body = relayBody(func, [authEntry(func, smartAccount)])
  const r = await call('POST', '/api/stellar/passkey/relay', body, withKey)
  assert.equal(r.status, 200)
  assert.equal(r.body.success, true)
  // What the kit's RelayerClient reads: success, and a hash it can poll.
  assert.equal(r.body.hash, hash)
  assert.deepEqual(r.body.data, { transactionId: 'tx-abc', status: 'submitted', hash })
  assert.match(String(r.body.explorerUrl), new RegExp(hash))
  assert.equal(r.body.rule, 'smart-account-execute')
  assert.equal(r.body.vault, vault)
  // And what went out: the key as a real bearer, the kit's object under params, untouched.
  assert.equal(posted.auth, 'Bearer test-key-value')
  assert.deepEqual(posted.body, { params: { func: body.func, auth: body.auth } })
  assert.match(String(posted.url), /channels\.openzeppelin\.com/)
})

test('a relayer refusal is passed back with its own message and code, not flattened into a 500', async () => {
  const smartAccount = contractId()
  const { deps, spy, signer } = stubs()
  const withKey: PasskeyRouteDeps = {
    ...deps,
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' },
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async (v: string) => {
        spy.reads.push(v)
        return vaultState({ owner: smartAccount, operator: signer })
      },
    }),
    fetch: (async () => ({ status: 400, json: async () => ({ success: false, error: 'SIMULATION_FAILED' }) })) as unknown as typeof fetch,
  }
  const func = executeFunc(smartAccount, contractId(), 'set_allowed')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), withKey)
  assert.equal(r.status, 400)
  assert.equal(r.body.success, false)
  assert.equal(r.body.errorCode, 'SIMULATION_FAILED')
})

test('a relayer that cannot be reached is a 502 that says so, never a silent success', async () => {
  const smartAccount = contractId()
  const { deps, spy, signer } = stubs()
  const withKey: PasskeyRouteDeps = {
    ...deps,
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' },
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async (v: string) => {
        spy.reads.push(v)
        return vaultState({ owner: smartAccount, operator: signer })
      },
    }),
    fetch: (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch,
  }
  const func = executeFunc(smartAccount, contractId(), 'set_frozen')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), withKey)
  assert.equal(r.status, 502)
  assert.equal(r.body.code, 'relayer_unreachable')
  assert.equal(r.body.success, false)
})

// ── what the relay may spend, across everyone ─────────────────────────────

/**
 * The two bounds that exist because this relay spends a credential of ours rather than the
 * caller's own gas, tested at the boundary where the ORDER is the property: the global rate
 * limit has to refuse before the body is read, and the fee reserve has to refuse after the
 * request has been judged relayable but before our key leaves the process. The arithmetic
 * itself is tested in ../stellar-passkey.test.ts, where it is pure.
 */

const tinyLimits: PasskeyRelayLimits = {
  perIp: { bucket: 'passkey-relay', max: 10, windowMs: 60_000 },
  global: { max: 1, windowMs: 60_000 },
  fee: { ceilingStroops: 1_100_000n, dailyStroops: 1_100_000n, windowMs: 86_400_000 },
}

test('REFUSAL: the global rate limit stops the second caller before the body is even read', async () => {
  const { deps, spy } = stubs()
  const withBudget: PasskeyRouteDeps = { ...deps, relayBudget: createRelayBudget(tinyLimits) }
  const func = executeFunc(contractId(), contractId(), 'set_policy')
  const body = relayBody(func, [authEntry(func, contractId())])
  // The first is refused later, on its own merits; what matters is that it was admitted.
  const first = await call('POST', '/api/stellar/passkey/relay', body, withBudget)
  assert.notEqual(first.status, 429, 'the first request in a window must not be rate limited')
  // The second is refused by the limit, and a body it would otherwise have rejected as
  // garbage proves the refusal happened before the body was looked at.
  const second = await call('POST', '/api/stellar/passkey/relay', { nonsense: true }, withBudget)
  assert.equal(second.status, 429)
  assert.equal(second.body.code, 'relay_global_rate_limit')
  assert.equal(second.body.success, false)
  assert.equal(second.body.retryAfterSeconds, 60)
  assert.match(String(second.body.reason), /ALL callers/)
  assert.deepEqual(spy.fetches, [], 'a rate limited request must never reach the relayer')
  assert.deepEqual(spy.reads, [], 'and must never cost a ledger read')
})

test('REFUSAL: the day\'s fee reserve stops the next forward, after the key check and before the key is used', async () => {
  const smartAccount = contractId()
  const vault = contractId()
  const { deps, spy, signer } = stubs()
  let posts = 0
  const withKey: PasskeyRouteDeps = {
    ...deps,
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' },
    relayBudget: createRelayBudget({ ...tinyLimits, global: { max: 50, windowMs: 60_000 } }),
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async (v: string) => {
        spy.reads.push(v)
        return vaultState({ owner: smartAccount, operator: signer })
      },
    }),
    fetch: (async () => {
      posts += 1
      return { status: 200, json: async () => ({ success: true, data: { transactionId: 'tx-1', status: 'submitted', hash: 'e1'.repeat(32) } }) }
    }) as unknown as typeof fetch,
  }
  const send = () => {
    const func = executeFunc(smartAccount, vault, 'set_policy')
    return call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), withKey)
  }

  const first = await send()
  assert.equal(first.status, 200)
  assert.equal(posts, 1)
  // Channels named no fee, so the whole ceiling stands against the day and says so.
  const fee = first.body.fee as Record<string, unknown>
  assert.equal(fee.reservedStroops, '1100000')
  assert.equal(fee.chargedStroops, null, 'a fee we were not told is null, never 0')
  assert.equal(fee.basis, 'reserved')

  const second = await send()
  assert.equal(second.status, 429)
  assert.equal(second.body.code, 'relay_fee_budget_exhausted')
  assert.equal(posts, 1, 'the relayer key must not be used once the day is committed')
  assert.match(String(second.body.reason), /relayer key was not used/)
  // The refusal publishes the same numbers the status endpoint does, so a caller reading a
  // 429 can see what it is up against.
  assert.equal((second.body.limits as Record<string, unknown>).relaysLeft, 0)
})

test('a relayer refusal that names no transaction hands its reserve back to the day', async () => {
  const smartAccount = contractId()
  const { deps, spy, signer } = stubs()
  const budget = createRelayBudget({ ...tinyLimits, global: { max: 50, windowMs: 60_000 }, fee: { ceilingStroops: 1_100_000n, dailyStroops: 2_200_000n, windowMs: 86_400_000 } })
  const withKey: PasskeyRouteDeps = {
    ...deps,
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' },
    relayBudget: budget,
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async (v: string) => {
        spy.reads.push(v)
        return vaultState({ owner: smartAccount, operator: signer })
      },
    }),
    fetch: (async () => ({ status: 400, json: async () => ({ success: false, error: 'SIMULATION_FAILED' }) })) as unknown as typeof fetch,
  }
  const func = executeFunc(smartAccount, contractId(), 'set_allowed')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), withKey)
  assert.equal(r.status, 400)
  assert.equal((r.body.fee as Record<string, unknown>).basis, 'not-broadcast')
  // Nothing was broadcast, so nothing was paid, so the day is whole again. Otherwise a
  // caller sending shape-valid payloads Channels rejects could burn the demo for free.
  assert.equal(budget.snapshot().fee.relaysLeft, 2)
  assert.equal(budget.snapshot().fee.reservedStroops, '0')
})

test('a relayer that never answers keeps its reserve, because we cannot know what it cost', async () => {
  const smartAccount = contractId()
  const { deps, spy, signer } = stubs()
  const budget = createRelayBudget({ ...tinyLimits, global: { max: 50, windowMs: 60_000 }, fee: { ceilingStroops: 1_100_000n, dailyStroops: 2_200_000n, windowMs: 86_400_000 } })
  const withKey: PasskeyRouteDeps = {
    ...deps,
    env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' },
    relayBudget: budget,
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async (v: string) => {
        spy.reads.push(v)
        return vaultState({ owner: smartAccount, operator: signer })
      },
    }),
    fetch: (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch,
  }
  const func = executeFunc(smartAccount, contractId(), 'set_frozen')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, smartAccount)]), withKey)
  assert.equal(r.status, 502)
  assert.equal(r.body.code, 'relayer_unreachable')
  assert.equal((r.body.fee as Record<string, unknown>).basis, 'reserved')
  assert.equal(budget.snapshot().fee.relaysLeft, 1, 'an unknown outcome is charged, not forgiven')
})

test('a request that never reaches the relayer never charges the day', async () => {
  // The order the relay is built around: a payload this gate refuses must not cost a fee
  // reserve, a ledger read, or a use of our key. The reserve is the last thing charged.
  const { deps, spy } = stubs()
  const budget = createRelayBudget(tinyLimits)
  const withBudget: PasskeyRouteDeps = { ...deps, env: { X402_STELLAR_TESTNET_OZ_KEY: 'test-key-value' }, relayBudget: budget }
  const func = invokeFunc(contractId(), 'transfer')
  const r = await call('POST', '/api/stellar/passkey/relay', relayBody(func, [authEntry(func, contractId())]), withBudget)
  assert.equal(r.status, 400, 'transfer is not an owner entrypoint')
  assert.deepEqual(spy.fetches, [])
  assert.equal(budget.snapshot().fee.relaysForwarded, 0, 'a refused request reserves nothing')
  assert.equal(budget.snapshot().fee.relaysLeft, 1)
  // But it did use its place in the global window, which is what a rate limit is for.
  assert.equal(budget.snapshot().global.used, 1)
})

// ── the status endpoint publishes them ─────────────────────────────────

test('status publishes the global limit and the fee reserve, live from the budget being charged', async () => {
  const { deps } = stubs()
  const budget = createRelayBudget()
  const r = await call('GET', '/api/stellar/passkey/status', undefined, { ...deps, relayBudget: budget })
  assert.equal(r.status, 200)
  const limits = r.body.limits as Record<string, Record<string, unknown>>
  assert.equal(limits.perIp.max, 10)
  assert.equal(limits.global.max, 100)
  assert.equal(limits.fee.ceilingStroops, '1100000')
  assert.equal(limits.fee.relaysLeft, 100)
  assert.equal(limits.fee.basis, 'nothing-forwarded')
  assert.match(String(limits.fee.note), /Reserved, not measured/)
  // Reading the status must not consume any of what it reports.
  assert.equal(limits.global.used, 0)
  assert.equal(budget.snapshot().fee.relaysForwarded, 0)
})

// ── the deploy ───────────────────────────────────────────────────────────────────

test('the deploy refuses an account owner and an over-cap policy, before the key is touched', async () => {
  const { deps, spy } = stubs()
  const bad = [
    { owner: accountId(), dailyCapUsd: 5, autoApproveUsd: 1 },
    { owner: contractId(), dailyCapUsd: 50, autoApproveUsd: 1 },
    { owner: contractId(), dailyCapUsd: 5, autoApproveUsd: 5 },
    { owner: contractId(), dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: 5 },
  ]
  for (const body of bad) {
    const r = await call('POST', '/api/stellar/passkey/vault/deploy', body, deps)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.body.code, 'bad_request')
    assert.ok(r.body.caps, 'a refused cap should say what the caps are')
  }
  assert.deepEqual(spy.reads, [])
})

test('the deploy without a signer returns the exact constructor call and submits nothing', async () => {
  const { deps } = stubs()
  const owner = contractId()
  const r = await call('POST', '/api/stellar/passkey/vault/deploy', { owner, dailyCapUsd: 5, autoApproveUsd: 1 }, { ...deps, signerAddress: () => null })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.equal(r.body.outcome, 'prepared')
  const args = r.body.constructorArgs as Record<string, unknown>
  assert.equal(args.owner, owner)
  assert.equal(args.operator, null)
  assert.equal(args.token, TOKEN)
  assert.equal(args.dailyCapRaw, '50000000')
  assert.match(String(r.body.reason), /STELLAR_TESTNET_SIGNER_SECRET/)
})

test('a settled deploy reports both hashes, and a seed the operator cannot cover is skipped rather than attempted', async () => {
  const vault = contractId()
  const owner = contractId()
  const { deps, signer } = stubs({
    deployVault: async () => ({ outcome: 'settled', vault, txHash: 'b2'.repeat(32), ledger: 4760409, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${'b2'.repeat(32)}` }),
    // The operator holds less than the seed, which is read rather than discovered by paying
    // a fee for a transfer the SAC would refuse.
    readTokenBalance: async () => 100n,
    sacTransferFromSigner: async () => {
      throw new Error('the seed must not be attempted when the balance cannot cover it')
    },
  })
  const r = await call('POST', '/api/stellar/passkey/vault/deploy', { owner, dailyCapUsd: 5, autoApproveUsd: 1 }, deps)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.vault, vault)
  assert.equal(r.body.ownerKind, 'smart-account')
  assert.equal(r.body.operator, signer)
  assert.equal((r.body.deploy as Record<string, unknown>).ledger, 4760409)
  const seed = r.body.seed as Record<string, unknown>
  assert.equal(seed.outcome, 'skipped')
  assert.match(String(seed.reason), /less than the 0\.2 requested/)
})

test('a deploy the contract refuses is reported as refused, with our own error named', async () => {
  const { deps } = stubs({
    deployVault: async () => ({
      outcome: 'refused',
      contract: '<new>',
      method: '__constructor',
      args: [],
      network: testnet.caip2,
      reason: 'the deploy was refused: Error(Contract, #10)',
      contractErrorCode: 10,
      contractErrorIsOurs: true,
    }),
  })
  const r = await call('POST', '/api/stellar/passkey/vault/deploy', { owner: contractId(), dailyCapUsd: 5, autoApproveUsd: 1 }, deps)
  assert.equal(r.status, 409)
  assert.equal(r.body.ok, false)
  assert.equal(r.body.contractErrorName, 'OwnerIsOperator')
  assert.equal((r.body.seed as Record<string, unknown>).outcome, 'none')
})

// ── the agent payment ────────────────────────────────────────────────────────────

test('the agent payment refuses more than a dollar, and a vault this server does not operate', async () => {
  const { deps } = stubs()
  const over = await call('POST', '/api/stellar/passkey/agent-pay', { contract: contractId(), to: accountId(), amountUsd: 5 }, deps)
  assert.equal(over.status, 400)
  assert.equal(over.body.maxUsd, 1)

  // readVault answers with some other operator, which is the live fact that decides.
  const { deps: other } = stubs({ readVault: async () => vaultState() })
  const r = await call('POST', '/api/stellar/passkey/agent-pay', { contract: contractId(), to: accountId(), amountUsd: 0.5 }, other)
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'not_operator')
})

test('a payment the vault refuses carries the typed error and says why there is no hash', async () => {
  const to = accountId()
  const vault = contractId()
  const { deps, signer } = stubs()
  const refusing: PasskeyRouteDeps = {
    ...deps,
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async () => vaultState({ operator: signer }),
      policyPay: async (): Promise<CallOutcome> => ({
        outcome: 'refused',
        contract: vault,
        method: 'pay',
        args: [to, '5000000'],
        network: testnet.caip2,
        reason: 'the contract refused it before it could be submitted: Error(Contract, #3)',
        contractErrorCode: 3,
        contractErrorIsOurs: true,
      }),
    }),
  }
  const r = await call('POST', '/api/stellar/passkey/agent-pay', { contract: vault, to, amountUsd: 0.5 }, refusing)
  assert.equal(r.status, 409)
  assert.equal(r.body.ok, false)
  assert.equal(r.body.outcome, 'refused')
  assert.equal(r.body.contractErrorCode, 3)
  assert.equal(r.body.contractErrorName, 'PayeeNotAllowed')
  assert.match(String(r.body.note), /refused in simulation, so no transaction exists/)
})

test('a settled payment reports the hash, the ledger and an explorer link', async () => {
  const vault = contractId()
  const hash = 'c3'.repeat(32)
  const { deps, signer } = stubs()
  const paid: PasskeyRouteDeps = {
    ...deps,
    adapter: () => ({
      ...(deps.adapter!(testnet) as PasskeyAdapter),
      readVault: async () => vaultState({ operator: signer }),
      policyPay: async (): Promise<CallOutcome> => ({ outcome: 'settled', txHash: hash, ledger: 4760415, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}` }),
    }),
  }
  const r = await call('POST', '/api/stellar/passkey/agent-pay', { contract: vault, to: accountId(), amountUsd: 0.5 }, paid)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.txHash, hash)
  assert.equal(r.body.ledger, 4760415)
  assert.equal(r.body.operator, signer)
})

// ── the allowlist plan ───────────────────────────────────────────────────────────

test('an unbound payee is DENY with an on-chain revoke, and no scorer is run for it', async () => {
  const payee = accountId()
  const { deps } = stubs()
  let scored = 0
  const r = await call(
    'POST',
    '/api/stellar/passkey/allowlist/plan',
    { contract: contractId(), payee },
    { ...deps, riskCheck: async () => { scored += 1; throw new Error('unreachable') } },
  )
  assert.equal(r.status, 200)
  assert.equal(r.body.binding, 'none')
  assert.equal(r.body.decision, 'DENY')
  assert.deepEqual(r.body.chainAction, { method: 'set_allowed', payee, ok: false })
  assert.equal(scored, 0, 'with no agent there is nothing to score')
  assert.ok(Array.isArray(r.body.reasons) && (r.body.reasons as string[]).length > 0)
})

test('a linked wallet resolves the agent, and ALLOW becomes an on-chain entry', async () => {
  const payee = accountId()
  const { deps } = stubs()
  const r = await call(
    'POST',
    '/api/stellar/passkey/allowlist/plan',
    { contract: contractId(), payee },
    {
      ...deps,
      agents: () => [{ id: 'agent-9', name: 'Auditor', owner: payee.toLowerCase() }],
      linkedSubjects: () => [payee],
      riskCheck: async (agentId: string) => ({ decision: 'ALLOW' as const, risk: 'low', reasons: [`${agentId} is verified`], signals: { kyaVerified: true } }),
    },
  )
  assert.equal(r.status, 200)
  assert.equal(r.body.binding, 'linked-wallet')
  assert.deepEqual(r.body.agent, { id: 'agent-9', name: 'Auditor' })
  assert.equal(r.body.decision, 'ALLOW')
  assert.deepEqual(r.body.chainAction, { method: 'set_allowed', payee, ok: true })
  assert.equal(r.body.serverWarning, null)
  assert.match(String(r.body.source), /risk_check/)
})

test('WARN is server-side only: nothing is planned on chain and the reasons come back', async () => {
  const payee = accountId()
  const { deps } = stubs()
  const r = await call(
    'POST',
    '/api/stellar/passkey/allowlist/plan',
    { contract: contractId(), payee, agentId: 'agent-3' },
    { ...deps, riskCheck: async () => ({ decision: 'WARN' as const, risk: 'medium', reasons: ['Moderate reputation (410)'], signals: {} }) },
  )
  assert.equal(r.status, 200)
  assert.equal(r.body.binding, 'declared')
  assert.equal(r.body.decision, 'WARN')
  assert.equal(r.body.chainAction, null)
  assert.match(String(r.body.serverWarning), /Moderate reputation/)
  // The mapping is published beside the plan, so a client never has to infer it.
  assert.match(String((r.body.enforcement as Record<string, string>).allowlist), /binary/)
})

test('a scorer that does not answer stops the plan at 502 rather than defaulting it', async () => {
  const { deps } = stubs()
  const r = await call(
    'POST',
    '/api/stellar/passkey/allowlist/plan',
    { contract: contractId(), payee: accountId(), agentId: 'agent-4' },
    { ...deps, riskCheck: async () => { throw new Error('RPC down') } },
  )
  assert.equal(r.status, 502)
  assert.equal(r.body.code, 'risk_unavailable')
})

test('the plan refuses a malformed vault or payee before it looks anything up', async () => {
  const { deps } = stubs()
  for (const body of [{ contract: accountId(), payee: accountId() }, { contract: contractId(), payee: 'nope' }, {}]) {
    const r = await call('POST', '/api/stellar/passkey/allowlist/plan', body, deps)
    assert.equal(r.status, 400, JSON.stringify(body))
  }
})
