import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SorobanDataBuilder, rpc, xdr } from '@stellar/stellar-sdk'

import {
  FailoverSorobanServer,
  isLiveLedgerEntry,
  isTransportError,
  simulationArchivedEntries,
  simulationNeedsRestore,
  sorobanServer,
  stellarRpcUrl,
  stellarRpcUrls,
  type SorobanReads,
  type FailoverReadMethod,
} from './client.js'
import { getChainById, requireChain } from '../registry.js'
import type { ChainDescriptor } from '../types.js'

/**
 * Offline by construction, and it has to be: the point of this file is what happens when a
 * host cannot be reached, which is not something a test should go to the network to find
 * out. Two seams make that possible without pretending:
 *
 * - The PRIMARY is the real `rpc.Server` this class extends, and its failure is produced by
 *   replacing `httpClient.post`. So every assertion below runs the SDK's own request path,
 *   its own parsers and its own error shapes. Nothing about the primary is simulated except
 *   the socket.
 * - The FALLBACKS are fakes, injected through the constructor's `makeServer` seam, because
 *   a fallback that answered for real would need a second network.
 *
 * The hosts are .invalid (RFC 2606), so a mistake here fails as a test rather than as a
 * request to somebody's RPC.
 */
const PRIMARY = 'https://primary.invalid/rpc'
const FALLBACK = 'https://fallback.invalid/rpc'
const SECOND_FALLBACK = 'https://second.invalid/rpc'

const testnet = () => getChainById('stellar-testnet')!
const pubnet = () => getChainById('stellar')!

/** A fallback handle that records what it was asked, so "never touched" is an assertion
 *  about a list rather than a hope. `sendTransaction` is included on purpose: the fake is
 *  ABLE to broadcast, which is what makes the test that it is never asked mean something. */
function fakeHost(
  behaviour: Partial<Record<FailoverReadMethod | 'sendTransaction', () => unknown>>,
): { server: SorobanReads; calls: string[] } {
  const calls: string[] = []
  const server: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const [name, run] of Object.entries(behaviour)) {
    server[name] = async () => {
      calls.push(name)
      return run!()
    }
  }
  return { server: server as unknown as SorobanReads, calls }
}

/** What Node's fetch actually produces for a host that will not connect: a bare "fetch
 *  failed" with the real code one level down on `cause`. */
function networkError(message = 'fetch failed'): Error {
  return new Error(message, { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
}

/** An axios-shaped HTTP failure, which is how the SDK's client reports a non-2xx. */
function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
    isAxiosError: true,
  })
}

/** Make the primary's transport throw, without touching the method under test. */
function primaryThrows(server: rpc.Server, thrown: unknown): void {
  server.httpClient.post = async () => {
    throw thrown
  }
}

/** Make the primary's transport return a JSON-RPC body, so the SDK's own parsing and error
 *  raising run exactly as they would against a live host. */
function primaryAnswers(server: rpc.Server, body: unknown): void {
  server.httpClient.post = (async () => ({
    data: body,
    headers: {},
    config: {},
    status: 200,
    statusText: 'OK',
  })) as typeof server.httpClient.post
}

/** The SDK reads `toXDR()` off a transaction and posts the result, so this is every part
 *  of a transaction the paths under test can observe. */
/** getAccount checks the address is a real StrKey before it reaches the transport, so the
 *  test needs a real one. Generated rather than pasted: no key-shaped literal belongs in
 *  this repo, not even a public one. */
const ACCOUNT = Keypair.random().publicKey()

const TX = { toXDR: () => 'AAAAAgAAAAA=' } as unknown as Parameters<rpc.Server['sendTransaction']>[0]
const LEDGER_KEY = { toXDR: () => 'AAAAAA==' } as unknown as Parameters<rpc.Server['getLedgerEntries']>[0]

function failover(
  fallbacks: { server: SorobanReads }[],
  lines: string[],
  urls: string[] = [PRIMARY, FALLBACK],
): FailoverSorobanServer {
  let next = 0
  return new FailoverSorobanServer(urls, undefined, {
    makeServer: () => fallbacks[next++]!.server,
    log: (line) => lines.push(line),
  })
}

test('a transport failure is told apart from an answer', () => {
  // Retryable: nobody answered, so asking again is asking the same question.
  assert.equal(isTransportError(new Error('fetch failed')), true)
  assert.equal(isTransportError(networkError()), true, 'the real code sits on cause')
  assert.equal(isTransportError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true)
  assert.equal(isTransportError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true)
  assert.equal(isTransportError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true)
  assert.equal(isTransportError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })), true)
  assert.equal(isTransportError(new Error('socket hang up')), true)
  assert.equal(isTransportError(new Error('timeout of 10000 ms exceeded')), true)
  assert.equal(isTransportError(new Error('The operation was aborted')), true)
  assert.equal(isTransportError(httpError(429)), true, 'rate limiting is what a second host is for')
  assert.equal(isTransportError(httpError(500)), true)
  assert.equal(isTransportError(httpError(502)), true)
  assert.equal(isTransportError(httpError(503)), true)

  // Answers. Every one of these is the host telling us something, and a second host asked
  // the same question would tell us the same thing or, worse, something different.
  assert.equal(isTransportError(httpError(400)), false)
  assert.equal(isTransportError(httpError(404)), false)
  assert.equal(
    isTransportError({ code: -32601, message: 'method not found' }),
    false,
    'a JSON-RPC error is an answer; its code is a number, which is what tells it apart',
  )
  assert.equal(isTransportError({ code: -32602, message: 'invalid parameters' }), false)
  assert.equal(isTransportError(new Error('the contract does not exist')), false)
  assert.equal(isTransportError({ error: 'HostError: Error(Contract, #4)' }), false, 'a simulation error is a result')
  assert.equal(isTransportError(null), false)
  assert.equal(isTransportError(undefined), false)
  assert.equal(isTransportError('fetch failed'), false, 'a bare string is not an error we can classify')
})

test('the env override is the primary and the registry hosts stay behind it', () => {
  // The precedence is resolveRpcUrls', unchanged: the override replaces the FIRST url and
  // the rest of the descriptor's list survives as fallbacks. Losing that would mean
  // pointing a deployment at a private RPC quietly gave it a single point of failure.
  const overridden = stellarRpcUrls(testnet(), { STELLAR_TESTNET_RPC_URL: 'https://private.invalid/rpc' })
  assert.equal(overridden[0], 'https://private.invalid/rpc')
  assert.deepEqual(overridden.slice(1), testnet().rpcUrls.slice(1))
  assert.deepEqual(stellarRpcUrls(testnet(), {}), testnet().rpcUrls)
  assert.deepEqual(stellarRpcUrls(pubnet(), {}), pubnet().rpcUrls)

  // Each network reads its OWN variable, the same rule the signer split follows.
  assert.deepEqual(stellarRpcUrls(pubnet(), { STELLAR_TESTNET_RPC_URL: 'https://private.invalid/rpc' }), pubnet().rpcUrls)

  // stellarRpcUrl is the primary and nothing else, because scripts build handles from it.
  assert.equal(stellarRpcUrl(testnet(), {}), testnet().rpcUrls[0])
  assert.equal(stellarRpcUrl(testnet(), { STELLAR_TESTNET_RPC_URL: 'https://private.invalid/rpc' }), 'https://private.invalid/rpc')

  // If this ever fails, the failover has nothing to fail over to and the outage it exists
  // for is back, silently.
  assert.ok(stellarRpcUrls(pubnet(), {}).length >= 2, 'pubnet must declare a fallback host')
  assert.ok(stellarRpcUrls(testnet(), {}).length >= 2, 'testnet must declare a fallback host')
})

test('a chain with one url gets the plain client, and a chain with several gets the failover one', () => {
  const both = sorobanServer(testnet(), {})
  assert.ok(both instanceof FailoverSorobanServer)
  assert.deepEqual((both as FailoverSorobanServer).fallbackUrls, stellarRpcUrls(testnet(), {}).slice(1))

  // One url is the whole list: there is nothing to fall back to, so the wrapper would only
  // ever be a no-op and the handle stays exactly what it has always been.
  const single: ChainDescriptor = { ...testnet(), rpcUrls: ['https://single.invalid/rpc'] }
  const one = sorobanServer(single, {})
  assert.equal(one instanceof FailoverSorobanServer, false)
  assert.equal(one.serverURL.host, 'single.invalid')

  assert.throws(() => sorobanServer(requireChain('eip155:5042002'), {}), /is not a Stellar chain/)
})

/**
 * FIRST of the tests that actually trigger a failover, and it has to stay first: the notice
 * is one per PROCESS, so whichever failover happens first is the one that prints it.
 */
test('a read falls over to the next host, and says so once per process', async () => {
  const lines: string[] = []
  const fallback = fakeHost({ getLatestLedger: () => ({ sequence: 4_680_843 }) })
  const server = failover([fallback], lines)
  primaryThrows(server, networkError())

  assert.equal((await server.getLatestLedger()).sequence, 4_680_843)
  assert.equal((await server.getLatestLedger()).sequence, 4_680_843)
  assert.deepEqual(fallback.calls, ['getLatestLedger', 'getLatestLedger'], 'both reads were answered')

  assert.equal(lines.length, 1, 'a host that is down must not write a line per request')
  assert.match(lines[0]!, /primary\.invalid/)
  assert.match(lines[0]!, /fallback\.invalid/)
  assert.match(lines[0]!, /getLatestLedger/)
})

test('the reads the rails depend on all fail over', async () => {
  const lines: string[] = []
  const fallback = fakeHost({
    getTransaction: () => ({ status: 'SUCCESS', txHash: 'ab' }),
    simulateTransaction: () => ({ id: '1', latestLedger: 7 }),
    _getLedgerEntries: () => ({ entries: [], latestLedger: 7 }),
    getFeeStats: () => ({ latestLedger: 7 }),
  })
  const server = failover([fallback], lines)
  primaryThrows(server, networkError())

  // confirm.ts reads the receipt with this one, which is the read that decides whether a
  // payment settled, so it is the one that must not depend on a single host.
  assert.equal((await server.getTransaction('ab')).status, 'SUCCESS')
  // settle.ts quotes the fee and simulates before it ever signs.
  assert.equal((await server.simulateTransaction(TX)).latestLedger, 7)
  assert.equal((await server.getFeeStats()).latestLedger, 7)
  // The proof page's live check and the vault reads. The public method is not overridden;
  // it reaches the wire through the raw one, which is, and that is what fails over.
  assert.deepEqual((await server.getLedgerEntries(LEDGER_KEY)).entries, [])

  assert.deepEqual(fallback.calls, ['getTransaction', 'simulateTransaction', 'getFeeStats', '_getLedgerEntries'])
})

/**
 * The reason the failover sits on the raw ledger-entry read rather than on `getAccount`.
 *
 * `getAccountEntry` is `catch { throw new Error('Account not found: ' + address) }`: the SDK
 * turns "nobody answered" into "the account does not exist", and an honest failover cannot
 * retry a decided answer like that. Catching it one layer down is what keeps the settlement
 * path's sequence-number read from depending on a single host. `getTrustline`,
 * `getClaimableBalance` and `getContractData` erase their errors the same way and are fixed
 * by the same override.
 */
test('an account read reaches the second host, under an SDK that erases the reason', async () => {
  const lines: string[] = []
  const fallback = fakeHost({ _getLedgerEntries: () => ({ entries: [], latestLedger: 7 }) })
  const server = failover([fallback], lines)
  primaryThrows(server, networkError())

  let thrown: unknown
  try {
    await server.getAccount(ACCOUNT)
  } catch (e) {
    thrown = e
  }
  assert.match(String(thrown), /Account not found/, "the SDK's wording, on an answer that did come from a live host")
  assert.deepEqual(fallback.calls, ['_getLedgerEntries'], 'the second host was asked, and it simply has no such account')
})

test('an HTTP 502 from the primary is failed over, a 400 is not', async () => {
  const lines: string[] = []
  const first = fakeHost({ getLatestLedger: () => ({ sequence: 1 }) })
  const server = failover([first], lines)

  primaryThrows(server, httpError(502))
  assert.equal((await server.getLatestLedger()).sequence, 1)

  primaryThrows(server, httpError(400))
  let thrown: unknown
  try {
    await server.getLatestLedger()
  } catch (e) {
    thrown = e
  }
  assert.match(String(thrown), /400/)
  assert.deepEqual(first.calls, ['getLatestLedger'], 'the 400 was an answer, so nobody else was asked')
})

test('a JSON-RPC error is an answer, so no second host is asked to overturn it', async () => {
  const lines: string[] = []
  const fallback = fakeHost({ getLatestLedger: () => ({ sequence: 1 }) })
  const server = failover([fallback], lines)
  // Thrown by the SDK verbatim: the plain object the host put in `error`.
  primaryAnswers(server, { error: { code: -32601, message: 'method not found' } })

  let thrown: unknown
  try {
    await server.getLatestLedger()
  } catch (e) {
    thrown = e
  }
  assert.deepEqual(thrown, { code: -32601, message: 'method not found' })
  assert.deepEqual(fallback.calls, [], 'an RPC that does not implement a method will not implement it on the retry')
})

test('a failed simulation is returned rather than thrown, so nothing retries it', async () => {
  const lines: string[] = []
  const fallback = fakeHost({ simulateTransaction: () => ({ id: '2', latestLedger: 9 }) })
  const server = failover([fallback], lines)
  primaryAnswers(server, { result: { id: '1', latestLedger: 7, error: 'HostError: Error(Contract, #4)' } })

  const sim = await server.simulateTransaction(TX)
  assert.ok(rpc.Api.isSimulationError(sim), 'the SDK returns the failure as a response')
  assert.deepEqual(fallback.calls, [], 'a contract that refuses refuses identically on every host')
})

test('a submission never fails over', async () => {
  const lines: string[] = []
  // This fake CAN broadcast. That is the point: it is able to answer and is not asked.
  const fallback = fakeHost({ sendTransaction: () => ({ status: 'PENDING', hash: 'deadbeef' }) })
  const server = failover([fallback], lines)
  primaryThrows(server, networkError())

  let thrown: unknown
  try {
    await server.sendTransaction(TX)
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown instanceof Error)
  assert.equal(
    isTransportError(thrown),
    true,
    'the failure is exactly the kind a READ would have retried, which is what makes this a decision rather than an oversight',
  )
  assert.deepEqual(
    fallback.calls,
    [],
    'a resubmitted envelope gets the second host to answer about the FIRST submission, and settle.ts reads that as decided',
  )
})

test('a fallback that is also unreachable moves to the next one, and the last failure is what surfaces', async () => {
  const lines: string[] = []
  const dead = fakeHost({
    getLatestLedger: () => {
      throw networkError('socket hang up')
    },
  })
  const alive = fakeHost({ getLatestLedger: () => ({ sequence: 3 }) })
  const server = failover([dead, alive], lines, [PRIMARY, FALLBACK, SECOND_FALLBACK])
  primaryThrows(server, networkError())
  assert.equal((await server.getLatestLedger()).sequence, 3)
  assert.deepEqual(dead.calls, ['getLatestLedger'])
  assert.deepEqual(alive.calls, ['getLatestLedger'])

  const allDead = fakeHost({
    getLatestLedger: () => {
      throw networkError('the last one')
    },
  })
  const hopeless = failover([allDead], lines)
  primaryThrows(hopeless, networkError('the primary'))
  let thrown: unknown
  try {
    await hopeless.getLatestLedger()
  } catch (e) {
    thrown = e
  }
  assert.match(String(thrown), /the last one/, 'the caller sees the last host it tried, not a swallowed list')
})

test('a fallback that answers, even to refuse, ends the search', async () => {
  const lines: string[] = []
  const refuses = fakeHost({
    getTransaction: () => {
      throw Object.assign(new Error('invalid hash'), { code: -32602 })
    },
  })
  const never = fakeHost({ getTransaction: () => ({ status: 'SUCCESS' }) })
  const server = failover([refuses, never], lines, [PRIMARY, FALLBACK, SECOND_FALLBACK])
  primaryThrows(server, networkError())

  let thrown: unknown
  try {
    await server.getTransaction('nonsense')
  } catch (e) {
    thrown = e
  }
  assert.match(String(thrown), /invalid hash/)
  assert.deepEqual(never.calls, [], 'the second fallback was never asked to overturn an answer')
})

test('a fallback that cannot be built is dropped rather than taking the primary down', () => {
  const lines: string[] = []
  const server = new FailoverSorobanServer([PRIMARY, FALLBACK], undefined, {
    makeServer: (url) => {
      throw new Error(`cannot build ${url}`)
    },
    log: (line) => lines.push(line),
  })
  assert.deepEqual(server.fallbackUrls, [])
  assert.equal(server.serverURL.host, 'primary.invalid', 'the primary is untouched')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /ignoring the RPC fallback/)
})

// ── archived state ───────────────────────────────────────────────────────────────

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

const simulated = (over: Record<string, unknown>) =>
  ({
    _parsed: true,
    id: '1',
    latestLedger: 100,
    events: [],
    minResourceFee: '272124886',
    transactionData: new SorobanDataBuilder(),
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
    ...over,
  }) as unknown as rpc.Api.SimulateTransactionResponse

test('archived state is caught in the shape protocol 23 reports it, which the SDK helper cannot see', () => {
  // Read live on 2026-09-15 against a pubnet contract whose instance and code had lapsed: no
  // restore preamble at all, the archived footprint indexes in the transaction data, and the
  // rent folded into minResourceFee.
  const folded = simulated({ transactionData: archivedData([0, 1]) })
  assert.equal(rpc.Api.isSimulationRestore(folded), false, 'the SDK helper reads only the preamble, which is the gap')
  assert.deepEqual(simulationArchivedEntries(folded), [0, 1])
  assert.equal(simulationNeedsRestore(folded), true)

  // The pre-protocol-23 shape still counts.
  const preamble = simulated({ restorePreamble: { minResourceFee: '1000', transactionData: new SorobanDataBuilder() } })
  assert.equal(simulationNeedsRestore(preamble), true)
  assert.deepEqual(simulationArchivedEntries(preamble), [])

  // Warm state and a failed simulation are neither.
  assert.equal(simulationNeedsRestore(simulated({})), false)
  const failed = { _parsed: true, id: '1', latestLedger: 100, events: [], error: 'HostError' } as unknown as rpc.Api.SimulateTransactionResponse
  assert.equal(simulationNeedsRestore(failed), false)
  assert.deepEqual(simulationArchivedEntries(failed), [])
})

test('a ledger entry is live only when its TTL reaches past the ledger it was read at', () => {
  // An archived entry still comes back from getLedgerEntries, with liveUntilLedgerSeq 0.
  assert.equal(isLiveLedgerEntry({ liveUntilLedgerSeq: 0 }, 64_432_560), false)
  assert.equal(isLiveLedgerEntry({ liveUntilLedgerSeq: 66_177_017 }, 64_432_560), true)
  // Live for the NEXT ledger, which is where a transaction sent now would land.
  assert.equal(isLiveLedgerEntry({ liveUntilLedgerSeq: 100 }, 100), false)
  assert.equal(isLiveLedgerEntry({ liveUntilLedgerSeq: 101 }, 100), true)
  assert.equal(isLiveLedgerEntry({}, 100), false)
  assert.equal(isLiveLedgerEntry(undefined, 100), false)
})
