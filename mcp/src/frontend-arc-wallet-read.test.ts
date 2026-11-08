import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, type Abi } from 'viem'

/**
 * The Arc vault page reading through the person's wallet when no network node answers the page, run
 * from src/ as it ships: vault-read.ts, receipt.ts, vault-write.ts and vault-events.ts load straight
 * from the repository through Node's type stripping, against a fake network (global fetch, which
 * viem's http transport calls) and a fake EIP-1193 wallet that records every request it gets.
 *
 * What is held here is what the wallet may and may not do. With the RPCs answering it is sent
 * nothing. Its "not found" never counts toward how many hosts answered, so it can never help call a
 * landed transaction replaced. It is asked about a receipt only once every registry host failed with
 * no answer reaching the page, and only after its chain id matched. A wallet that says no is not
 * asked again. A blocked read is said to be one only when nobody answered at all, and its next step
 * follows what the wallet did.
 */

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repo = (rel: string) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8')

type Call = { method: string; params?: readonly unknown[] }
type Provider = { request: (a: Call) => Promise<unknown> }
type ChainLike = { id: string; caip2: string; chainId: number; name: string; testnet: boolean }
type ReadFailure = { kind: string; reason: string; wallet?: string; walletOnly?: boolean }
type Poll = { found: boolean; host?: string; answered: number; total: number }
type Rec = Record<string, unknown>
type ReadModule = {
  ARC_MAINNET: ChainLike
  ARC_TESTNET: ChainLike
  WALLET_HOST: string
  rpcUrls: (chain: ChainLike) => readonly string[]
  readUrls: (chain: ChainLike) => readonly string[]
  hostOf: (url: string) => string
  usdcOf: (chain: ChainLike) => { address: string; decimals: number } | null
  setWalletReadProvider: (p: Provider | null, o?: { walletConnect?: boolean }) => void
  timedProvider: (p: { request: (a: Call) => unknown }) => Provider
  pollReceipt: (chain: ChainLike, hash: string) => Promise<Poll>
  readTransaction: (chain: ChainLike, hash: string) => Promise<Rec | null | undefined>
  readHead: (chain: ChainLike) => Promise<{ block: bigint; host: string }>
  readUsdcFacts: (chain: ChainLike) => Promise<{ ok: boolean; reason?: string; blocked?: boolean; wallet?: string }>
  readVault: (chain: ChainLike, address: string, opts?: { blockNumber?: bigint }) => Promise<{ ok: true; data: Rec } | { ok: false; failure: ReadFailure }>
  readFailureNext: (f: { kind: string; wallet?: string; walletOnly?: boolean }, again: string) => string
  readFailureTitle: (f: { kind: string; walletOnly?: boolean }) => string
  readTriesAgain: (kind: string | undefined) => boolean
  READ_FAILURE_TITLE: Record<string, string>
}
type ReceiptModule = { advance: (chain: ChainLike, record: Rec, tick: number, now?: number) => Promise<{ record: Rec; answered: number; total: number }> }
type EventsModule = { readPaidSince: (chain: ChainLike, vault: string, from: bigint) => Promise<{ ok: boolean; blocked?: boolean; reason?: string }> }
type Explained = { title: string; body?: string; next: string }
type Failure = { code: string; message: string; wallet?: string }
type WriteModule = { prepareFund: (chain: ChainLike, v: Rec, from: string, amount: bigint) => Promise<unknown> }
type CopyModule = { blockedNext: (w: string, again: string) => string; walletOnlyNext: (again: string) => string; SCAN_BLOCKED_NEXT: string; BLOCKED_TITLE: string }

const read = async () => (await import(repoUrl('src/lib/arc/vault-read.ts').href)) as ReadModule
const receipt = async () => (await import(repoUrl('src/lib/arc/receipt.ts').href)) as ReceiptModule
const write = async () => (await import(repoUrl('src/lib/arc/vault-write.ts').href)) as WriteModule
const events = async () => (await import(repoUrl('src/lib/arc/vault-events.ts').href)) as EventsModule
const hosts = async () => (await import(repoUrl('src/lib/arc/hosts.ts').href)) as { walletSaidNo: (e: unknown) => boolean }
const copy = async () => (await import(repoUrl('src/lib/arc/deploy-copy.ts').href)) as CopyModule
const explain = async () => (await import(repoUrl('src/lib/arc/failure-explain.ts').href)) as { explainFailure: (f: Failure) => Explained }
const send = async () => (await import(repoUrl('src/lib/arc/send.ts').href)) as { failureOf: (e: unknown) => Failure }
const contract = async () => (await import(repoUrl('src/lib/contracts/agent-spend-policy.ts').href)) as { AGENT_SPEND_POLICY_ABI: Abi }

const OWNER = '0x1111111111111111111111111111111111111111'
const OPERATOR = '0x2222222222222222222222222222222222222222'
const VAULT = '0x3333333333333333333333333333333333333333'
const HASH = `0x${'ab'.repeat(32)}`
const hex = (n: number | bigint) => `0x${n.toString(16)}`
/** A few turns of the event loop, which mocked timers leave running. */
const turns = async (n: number, until: () => boolean = () => false) => {
  for (let i = 0; i < n && !until(); i += 1) await new Promise((r) => setImmediate(r))
}

// --- a fake network: each registry host answers, says busy, or never answers the page ---

const BLOCKED = Symbol('no answer reached the page')
const BUSY = Symbol('429')
type Reply = unknown
type Net = (host: string, method: string, params: readonly unknown[]) => Reply | Promise<Reply>

/** Installs `net` as the page's fetch for the run of `fn`, and gives back what each host was asked. */
async function withNet<T>(net: Net, fn: (asked: { host: string; method: string }[]) => Promise<T>): Promise<T> {
  const asked: { host: string; method: string }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
    const host = new URL(url).host
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] }
    asked.push({ host, method: body.method })
    const reply = await net(host, body.method, body.params ?? [])
    if (reply === BLOCKED) throw new TypeError('Failed to fetch')
    const json = { 'Content-Type': 'application/json' }
    if (reply === BUSY) return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429, headers: json })
    if (reply === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `not in this fake: ${body.method}` } }), { status: 200, headers: json })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: reply }), { status: 200, headers: json })
  }) as unknown as typeof fetch
  try {
    return await fn(asked)
  } finally {
    globalThis.fetch = original
  }
}

/** A wallet that records every request and answers through `plan`; a throw is its error. */
function fakeWallet(plan: (method: string, params: readonly unknown[]) => unknown) {
  const calls: string[] = []
  const provider: Provider = {
    request: async ({ method, params }) => {
      calls.push(method)
      return plan(method, params ?? [])
    },
  }
  return { calls, provider }
}

const block = (n: bigint) => ({ number: hex(n), hash: `0x${'cd'.repeat(32)}`, timestamp: hex(1_800_000_000n), baseFeePerGas: hex(20_000_000_000n), transactions: [] })
const receiptJson = { blockHash: `0x${'cd'.repeat(32)}`, blockNumber: hex(100n), contractAddress: null, cumulativeGasUsed: '0x5208', effectiveGasPrice: hex(20_000_000_000n), from: OWNER, gasUsed: '0x5208', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', to: VAULT, transactionHash: HASH, transactionIndex: '0x0', type: '0x2' }
/** A wallet's node on `chainId` that has no receipt and no transaction for anything. */
const emptyWallet = (chainId: number) =>
  fakeWallet((method) => {
    if (method === 'eth_chainId') return hex(chainId)
    if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return null
    if (method === 'eth_getBlockByNumber') return block(100n)
    if (method === 'eth_getTransactionCount') return '0x8'
    throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 })
  })

/** A funding this page sent with nonce 7. */
const funding = (m: ReadModule): Rec => ({
  hash: HASH,
  action: 'fund',
  what: 'Put USDC in',
  network: m.ARC_MAINNET.caip2,
  from: OWNER,
  vault: VAULT,
  submittedAt: new Date(1_000_000).toISOString(),
  expect: [],
  amount: 500_000n,
  outcome: 'pending',
  sent: { maxFeePerGas: 40_000_000_000n, gasPrice: null, nonce: 7, belowFloor: false, from: OWNER },
})

test('with the RPCs answering, the wallet is sent nothing: not for a receipt, a transaction, a nonce or a read', async () => {
  const m = await read()
  const r = await receipt()
  const chain = m.ARC_MAINNET
  const wallet = emptyWallet(chain.chainId)
  m.setWalletReadProvider(wallet.provider)
  try {
    await withNet(
      (host, method) => {
        if (method === 'eth_chainId') return hex(chain.chainId)
        if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return null
        if (method === 'eth_getTransactionCount') return '0x7'
        if (method === 'eth_getBlockByNumber') return block(100n)
        return undefined
      },
      async () => {
        const poll = await m.pollReceipt(chain, HASH)
        assert.deepEqual([poll.found, poll.answered, poll.total], [false, 4, 4], 'four registry hosts said no receipt')
        assert.equal(await m.readTransaction(chain, HASH), null)
        assert.equal((await m.readHead(chain)).host, m.hostOf(m.rpcUrls(chain)[0]))
        // A pending funding polled for a while, deep checks and the nonce read included.
        let rec = funding(m)
        for (let tick = 0; tick < 7; tick += 1) rec = (await r.advance(chain, rec, tick, 2_000_000 + tick * 5_000)).record
        assert.equal(rec.outcome, 'pending')
      },
    )
    assert.deepEqual(wallet.calls, [], 'a locked or unconnected wallet would open a window for these')
    // With a receipt on the first host, the same.
    await withNet(
      (host, method) => (method === 'eth_getTransactionReceipt' ? receiptJson : method === 'eth_chainId' ? hex(chain.chainId) : undefined),
      async () => assert.equal((await m.pollReceipt(chain, HASH)).found, true),
    )
    assert.deepEqual(wallet.calls, [])
  } finally {
    m.setWalletReadProvider(null)
  }
})

test('the wallet never counts toward how many hosts answered, so a landed funding is never called replaced through it', async () => {
  const m = await read()
  const r = await receipt()
  const chain = m.ARC_MAINNET
  const registry = m.rpcUrls(chain).map((u) => m.hostOf(u))
  const blocked: Net = () => BLOCKED
  try {
    // Every registry host blocked, and a wallet on another network: asked its chain id, then nothing.
    const elsewhere = emptyWallet(1)
    m.setWalletReadProvider(elsewhere.provider)
    await withNet(blocked, async () => {
      const poll = await m.pollReceipt(chain, HASH)
      assert.deepEqual([poll.found, poll.answered, poll.total], [false, 0, registry.length])
      assert.equal(await m.readTransaction(chain, HASH), undefined, 'too few answered to say')
    })
    assert.deepEqual([...new Set(elsewhere.calls)], ['eth_chainId'], 'never asked for a receipt on chain 1')

    // A wallet on this chain that has nothing: its "not found" is not an answer.
    const empty = emptyWallet(chain.chainId)
    m.setWalletReadProvider(empty.provider)
    await withNet(blocked, async () => {
      const poll = await m.pollReceipt(chain, HASH)
      assert.deepEqual([poll.found, poll.answered, poll.total], [false, 0, registry.length])
      assert.equal(await m.readTransaction(chain, HASH), undefined, 'a wallet that has nothing does not make the transaction absent')
    })
    assert.ok(empty.calls.includes('eth_getTransactionReceipt'), 'asked, because no registry host answered at all')

    // A wallet that has the receipt is the answer, named as the wallet.
    const has = fakeWallet((method) => (method === 'eth_chainId' ? hex(chain.chainId) : method === 'eth_getTransactionReceipt' ? receiptJson : null))
    m.setWalletReadProvider(has.provider)
    await withNet(blocked, async () => {
      const poll = await m.pollReceipt(chain, HASH)
      assert.equal(poll.found, true)
      assert.equal(poll.host, m.WALLET_HOST)
      assert.equal(poll.total, registry.length)
    })

    // The case that once called a landed funding replaced: two hosts busy, two without the receipt
    // (one host returning null for receipts that exist is routine on Arc), the nonce already used.
    for (const wallet of [emptyWallet(1), emptyWallet(chain.chainId)]) {
      m.setWalletReadProvider(wallet.provider)
      await withNet(
        (host, method) => {
          if (host === registry[0] || host === registry[1]) return BUSY
          if (method === 'eth_chainId') return hex(chain.chainId)
          if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return null
          if (method === 'eth_getTransactionCount') return '0x8'
          return undefined
        },
        async () => {
          let rec = funding(m)
          const start = 2_000_000
          for (const [tick, at] of [[0, 0], [1, 25_000], [2, 50_000]] as const) {
            const out = await r.advance(chain, rec, tick, start + at)
            assert.deepEqual([out.answered, out.total], [2, registry.length], 'two of the four registry hosts, and nobody else')
            rec = out.record
            assert.equal(rec.outcome, 'pending', `check ${tick}`)
            assert.equal(rec.nonceUsedAt, undefined, 'two of four is not enough to start the watch')
          }
          assert.equal(await m.readTransaction(chain, HASH), undefined, 'two of four is too few to say nobody has it')
        },
      )
      assert.deepEqual(wallet.calls, [], 'a host that answered 429 did answer, so the wallet is not asked')
    }
  } finally {
    m.setWalletReadProvider(null)
  }
})

test('a wallet that says no to a read is not asked again until it or its account changes', async () => {
  const { walletSaidNo } = await hosts()
  assert.equal(walletSaidNo(Object.assign(new Error('Unauthorized'), { code: 4100 })), true)
  assert.equal(walletSaidNo(Object.assign(new Error('User rejected the request.'), { code: 4001 })), true)
  assert.equal(walletSaidNo(new Error('Wallet is locked')), true)
  assert.equal(walletSaidNo(new Error('The requested account has not been authorized by the user.')), true)
  assert.equal(walletSaidNo({ shortMessage: 'wrapped', cause: { cause: { code: 4100 } } }), true, "inside viem's wrappers")
  assert.equal(walletSaidNo(new Error('request blocked by client')), false, '"blocked" is not "locked"')
  assert.equal(walletSaidNo(Object.assign(new Error('Failed to fetch'), { code: -32603 })), false)
  assert.equal(walletSaidNo(null), false)

  const m = await read()
  const chain = m.ARC_MAINNET
  const locked = fakeWallet((method) => {
    if (method === 'eth_chainId') return hex(chain.chainId)
    throw Object.assign(new Error('The requested method and/or account has not been authorized by the user.'), { code: 4100 })
  })
  m.setWalletReadProvider(locked.provider)
  try {
    await withNet(
      () => BLOCKED,
      async () => {
        await m.pollReceipt(chain, HASH)
        assert.deepEqual(locked.calls, ['eth_chainId', 'eth_getTransactionReceipt'])
        locked.calls.length = 0
        // Every later read leaves it alone: a receipt, a transaction, a snapshot, a head.
        await m.pollReceipt(chain, HASH)
        await m.readTransaction(chain, HASH)
        const v = await m.readVault(chain, VAULT)
        assert.equal(v.ok, false)
        await assert.rejects(m.readHead(chain), (e: unknown) => {
          const x = e as { name?: string; blocked?: boolean; wallet?: string }
          assert.equal(x.name, 'RpcUnreachableError')
          assert.equal(x.blocked, true)
          assert.equal(x.wallet, 'failed', 'the copy says the wallet could not read either')
          return true
        })
        assert.deepEqual(locked.calls, [], 'a locked wallet is not woken again')
        assert.equal(m.readUrls(chain).length, m.rpcUrls(chain).length)
        // A new account (the hook registers the wallet again) is asked again.
        m.setWalletReadProvider(null)
        m.setWalletReadProvider(locked.provider)
        await m.pollReceipt(chain, HASH)
        assert.deepEqual(locked.calls, ['eth_chainId', 'eth_getTransactionReceipt'])
      },
    )
    // A read that took its host list before the wallet said no (a receipt poll beside a vault read)
    // sends it nothing either once it gets to it.
    m.setWalletReadProvider(null)
    m.setWalletReadProvider(locked.provider)
    locked.calls.length = 0
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let first = true
    await withNet(
      async () => {
        if (first) {
          first = false
          await held
        }
        return BLOCKED
      },
      async () => {
        const vault = m.readVault(chain, VAULT)
        await m.pollReceipt(chain, HASH)
        assert.deepEqual(locked.calls, ['eth_chainId', 'eth_getTransactionReceipt'], 'the poll got the no')
        release()
        const v = await vault
        assert.ok(!v.ok)
        assert.deepEqual(locked.calls, ['eth_chainId', 'eth_getTransactionReceipt'], 'the vault read, already under way, asked nothing more')
      },
    )
  } finally {
    m.setWalletReadProvider(null)
  }
  // The hook registers a wallet only while it holds an account from it, and again on every change.
  const hook = repo('src/components/app/arc/useArcWallet.ts')
  assert.match(hook, /if \(!wallet \|\| !account\) return\s*const p = wallet\.provider\s*setWalletReadProvider\(p, \{ walletConnect: wallet\.name === 'WalletConnect' \}\)\s*return \(\) => clearWalletReadProvider\(p\)\s*\}, \[wallet, account\]\)/)
})

test('a vault read is a result, never a throw, and is blocked only when nobody answered at all', async () => {
  const m = await read()
  const { AGENT_SPEND_POLICY_ABI: abi } = await contract()
  const chain = m.ARC_MAINNET
  const registry = m.rpcUrls(chain).map((u) => m.hostOf(u))
  const values: Record<string, unknown> = {
    owner: OWNER,
    operator: OPERATOR,
    usdc: OPERATOR,
    dailyCap: 0n,
    autoApproveMax: 0n,
    frozen: false,
    allowlistEnabled: false,
    sessionKeyExpiry: 0n,
    today: 1n,
    spentToday: 0n,
    balance: 0n,
  }
  /** A wallet's node holding a vault, whose network moves to `then` after its first chain id. */
  const vaultWallet = (then: number) => {
    let asks = 0
    return fakeWallet((method, params) => {
      if (method === 'eth_chainId') return hex(asks++ === 0 ? chain.chainId : then)
      if (method === 'eth_getBlockByNumber') return block(100n)
      if (method === 'eth_getCode') return '0x6080'
      if (method === 'eth_call') {
        const { functionName } = decodeFunctionData({ abi, data: (params[0] as { data: `0x${string}` }).data })
        return encodeFunctionResult({ abi, functionName, result: values[functionName] } as unknown as Parameters<typeof encodeFunctionResult>[0])
      }
      return null
    })
  }
  try {
    await withNet(
      () => BLOCKED,
      async () => {
        // No wallet: blocked, and the way through offers connecting one.
        const none = await m.readVault(chain, VAULT)
        assert.ok(!none.ok)
        assert.equal(none.failure.kind, 'blocked')
        assert.equal(none.failure.wallet, 'none')
        assert.doesNotMatch(none.failure.reason, /revert/i)

        // The wallet forgotten while the registry hosts were being asked: a failure, not a throw.
        const gone = emptyWallet(chain.chainId)
        m.setWalletReadProvider(gone.provider)
        let first = true
        const midRead = await withNet(
          () => {
            if (first) {
              first = false
              m.setWalletReadProvider(null)
            }
            return BLOCKED
          },
          () => m.readVault(chain, VAULT),
        )
        assert.ok(!midRead.ok, 'a wallet forgotten mid-read is one more host that failed')
        assert.equal(midRead.failure.kind, 'blocked')
        assert.equal(midRead.failure.wallet, 'none')
        assert.deepEqual(gone.calls, [])
        // The same for a read whose hosts were all set up before it began: nothing reaches the wallet.
        m.setWalletReadProvider(gone.provider)
        let once = true
        await withNet(
          () => {
            if (once) {
              once = false
              m.setWalletReadProvider(null)
            }
            return BLOCKED
          },
          () =>
            assert.rejects(m.readHead(chain), (e: unknown) => {
              assert.equal((e as { wallet?: string }).wallet, 'none')
              return true
            }),
        )
        assert.deepEqual(gone.calls, [], 'a forgotten wallet is sent nothing')

        // A wallet that read the whole vault and then answered for another network: thrown away.
        const moved = vaultWallet(chain.chainId + 1)
        m.setWalletReadProvider(moved.provider)
        const mixed = await m.readVault(chain, VAULT)
        assert.ok(!mixed.ok, 'two chains in one snapshot')
        assert.equal(mixed.failure.kind, 'blocked')
        assert.equal(mixed.failure.wallet, 'other_chain')
        assert.equal(moved.calls.filter((c) => c === 'eth_chainId').length, 2, 'asked again at the end of the read')
        // The same wallet staying on this network is read through, and stamped as the wallet.
        const stays = vaultWallet(chain.chainId)
        m.setWalletReadProvider(stays.provider)
        const good = await m.readVault(chain, VAULT)
        assert.ok(good.ok)
        assert.equal(good.data.host, m.WALLET_HOST)

        // The wallet alone answering "no code" is an answer: not a blocked browser, and not a verdict.
        const noCode = emptyWallet(chain.chainId)
        m.setWalletReadProvider(fakeWallet((method, params) => (method === 'eth_getCode' ? '0x' : noCode.provider.request({ method, params }))).provider)
        const alone = await m.readVault(chain, VAULT)
        assert.ok(!alone.ok)
        assert.equal(alone.failure.kind, 'unreachable', 'someone answered, so this browser reaches the network')
        assert.equal(alone.failure.walletOnly, true)
        assert.match(alone.failure.reason, /only your wallet answered: your wallet has no code/)
        assert.equal(m.readFailureTitle(alone.failure), 'Only your wallet answered')
        const next = m.readFailureNext(alone.failure, 'press Refresh')
        assert.match(next, /one node's word is not enough to show this vault or to say there is none here/)
        assert.match(next, /then press Refresh\./)
        assert.doesNotMatch(next, /may be busy/, 'a page no answer reached is not told the nodes are busy')
        // The same for a wallet whose views return nothing, and one not yet at the block asked for.
        m.setWalletReadProvider(fakeWallet((method) => (method === 'eth_chainId' ? hex(chain.chainId) : method === 'eth_getBlockByNumber' ? block(100n) : method === 'eth_getCode' ? '0x6080' : '0x')).provider)
        const notVault = await m.readVault(chain, VAULT)
        assert.ok(!notVault.ok)
        assert.deepEqual([notVault.failure.kind, notVault.failure.walletOnly], ['unreachable', true])
        assert.match(notVault.failure.reason, /only your wallet answered: your wallet: one of its views reverted or returned nothing/)
        m.setWalletReadProvider(emptyWallet(chain.chainId).provider)
        const behind = await m.readVault(chain, VAULT, { blockNumber: 200n })
        assert.ok(!behind.ok)
        assert.deepEqual([behind.failure.kind, behind.failure.walletOnly], ['unreachable', true])
        assert.match(behind.failure.reason, /only your wallet answered: your wallet is at block 100, not yet at 200/)
        // A wallet on another network from the start is the person's choice: blocked, never the registry's wrong chain.
        m.setWalletReadProvider(emptyWallet(1).provider)
        const elsewhere = await m.readVault(chain, VAULT)
        assert.ok(!elsewhere.ok)
        assert.deepEqual([elsewhere.failure.kind, elsewhere.failure.wallet], ['blocked', 'other_chain'])
        assert.match(elsewhere.failure.reason, /; your wallet answered for chain 1, not 5042$/)
      },
    )
    // One registry host saying "no code" and the wallet saying the same are not two hosts agreeing:
    // the wallet's node is often that same host, added to the wallet by this page.
    m.setWalletReadProvider(fakeWallet((method) => (method === 'eth_chainId' ? hex(chain.chainId) : method === 'eth_getBlockByNumber' ? block(100n) : method === 'eth_getCode' ? '0x' : null)).provider)
    const absent = await withNet(
      (host, method) => {
        if (host !== registry[0]) return BUSY
        if (method === 'eth_chainId') return hex(chain.chainId)
        if (method === 'eth_getBlockByNumber') return block(100n)
        if (method === 'eth_getCode') return '0x'
        return undefined
      },
      () => m.readVault(chain, VAULT),
    )
    assert.ok(!absent.ok)
    assert.notEqual(absent.failure.kind, 'no_contract')
    // Nor are one registry host's views returning nothing and the wallet's doing the same.
    const empty = (method: string) => (method === 'eth_chainId' ? hex(chain.chainId) : method === 'eth_getBlockByNumber' ? block(100n) : method === 'eth_getCode' ? '0x6080' : '0x')
    m.setWalletReadProvider(fakeWallet(empty).provider)
    const hollow = await withNet((host, method) => (host !== registry[0] ? BUSY : empty(method)), () => m.readVault(chain, VAULT))
    assert.ok(!hollow.ok)
    assert.notEqual(hollow.failure.kind, 'not_a_vault')
    // One registry host saying "no code" with the rest unanswered: someone answered, and it was not the wallet.
    m.setWalletReadProvider(null)
    const one = await withNet(
      (host, method) => {
        if (host !== registry[0]) return BLOCKED
        if (method === 'eth_chainId') return hex(chain.chainId)
        if (method === 'eth_getBlockByNumber') return block(100n)
        if (method === 'eth_getCode') return '0x'
        return undefined
      },
      () => m.readVault(chain, VAULT),
    )
    assert.ok(!one.ok)
    assert.equal(one.failure.kind, 'unreachable')
    assert.equal(one.failure.walletOnly, undefined)
    assert.equal(m.readFailureTitle(one.failure), m.READ_FAILURE_TITLE.unreachable)
    assert.doesNotMatch(one.failure.reason, /only your wallet/)
    // One registry host answering 429 means the network does answer: busy, not blocked.
    const busy = await withNet((host) => (host === registry[0] ? BUSY : BLOCKED), () => m.readVault(chain, VAULT))
    assert.ok(!busy.ok)
    assert.equal(busy.failure.kind, 'unreachable')
    // A registry host on another chain is named by its own words, not by the host that failed last.
    m.setWalletReadProvider(emptyWallet(chain.chainId).provider)
    const wrong = await withNet((host, method) => (host === registry[0] && method === 'eth_chainId' ? hex(1) : BLOCKED), () => m.readVault(chain, VAULT))
    assert.ok(!wrong.ok)
    assert.equal(wrong.failure.kind, 'wrong_chain')
    assert.equal(wrong.failure.reason, `${registry[0]} answered for chain 1, not ${chain.chainId}`)
  } finally {
    m.setWalletReadProvider(null)
  }
})

test('the wallet goes first only after every registry host failed with no answer, and only on that chain', async () => {
  const m = await read()
  const mainnet = m.ARC_MAINNET
  const testnet = m.ARC_TESTNET
  const first = (chain: ChainLike) => m.hostOf(m.readUrls(chain)[0])
  const last = (chain: ChainLike) => m.hostOf(m.readUrls(chain).at(-1) ?? '')
  try {
    m.setWalletReadProvider(emptyWallet(mainnet.chainId).provider)
    assert.equal(last(mainnet), m.WALLET_HOST, 'after the registry hosts by default')
    await withNet(
      () => BLOCKED,
      async () => assert.equal((await m.readHead(mainnet)).host, m.WALLET_HOST),
    )
    assert.equal(first(mainnet), m.WALLET_HOST, 'a blocked browser does not wait on four dead hosts again')
    assert.equal(last(testnet), m.WALLET_HOST, 'an answer on mainnet says nothing about testnet')

    // A burst of 429s is the network answering: the registry stays first.
    m.setWalletReadProvider(null)
    m.setWalletReadProvider(emptyWallet(mainnet.chainId).provider)
    await withNet(
      () => BUSY,
      async () => assert.equal((await m.readHead(mainnet)).host, m.WALLET_HOST),
    )
    assert.equal(last(mainnet), m.WALLET_HOST)
  } finally {
    m.setWalletReadProvider(null)
  }
})

test('a wallet that never answers is given up on in the time an RPC gets, and one that throws at once clears its timer', async () => {
  const m = await read()
  const chain = m.ARC_MAINNET
  const asleep = fakeWallet((method) => (method === 'eth_chainId' ? hex(chain.chainId) : new Promise(() => {})))
  m.setWalletReadProvider(asleep.provider)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withNet(
      () => BLOCKED,
      async () => {
        let settled: unknown = 'pending'
        void m.readHead(chain).then(
          () => (settled = 'answered'),
          (e: unknown) => (settled = e),
        )
        await turns(500, () => asleep.calls.includes('eth_getBlockByNumber'))
        assert.ok(asleep.calls.includes('eth_getBlockByNumber'), 'the wallet was asked for the block')
        mock.timers.tick(7_999)
        await turns(50)
        assert.equal(settled, 'pending', 'given the same 8 seconds an RPC gets')
        mock.timers.tick(1)
        await turns(500, () => settled !== 'pending')
        assert.notEqual(settled, 'pending', 'a wallet that never answers would hold the read forever')
        const e = settled as { name?: string; blocked?: boolean; wallet?: string }
        assert.deepEqual([e.name, e.blocked, e.wallet], ['RpcUnreachableError', true, 'failed'])
      },
    )
  } finally {
    mock.timers.reset()
    m.setWalletReadProvider(null)
  }

  // A wallet request that throws at once still clears its timer.
  const made: { h: unknown; ms: number | undefined }[] = []
  const cleared: unknown[] = []
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const h = realSet(fn, ms)
    made.push({ h, ms })
    return h
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(h)
    realClear(h)
  }) as unknown as typeof clearTimeout
  try {
    const timed = m.timedProvider({
      request: () => {
        throw new Error('thrown at once')
      },
    })
    await assert.rejects(timed.request({ method: 'eth_chainId' }), /thrown at once/)
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  const timer = made.find((t) => t.ms === 8000)
  assert.ok(timer, 'the wallet request has its own time limit')
  assert.ok(cleared.includes(timer.h), 'the 8 second timer is left running')
})

test('a blocked read says what was seen, the way through follows what the wallet did, and it never says reverted', async () => {
  const { blockedNext, walletOnlyNext, BLOCKED_TITLE } = await copy()
  const { explainFailure } = await explain()
  const { failureOf } = await send()
  const m = await read()
  assert.equal(BLOCKED_TITLE, 'No network node answered this page')
  assert.equal(m.READ_FAILURE_TITLE.blocked, BLOCKED_TITLE)
  const states = ['none', 'other_chain', 'failed', 'walletconnect'] as const
  const told = states.map((w) => blockedNext(w, 'press Refresh'))
  for (const [i, text] of [...told, walletOnlyNext('press Refresh')].entries()) {
    const w = states[i] ?? 'wallet only'
    assert.match(text, /Most often something in this browser stops the requests: Brave Shields, an ad or tracker blocker, a VPN or a filtering DNS\./, w)
    assert.match(text, /A lost connection looks the same/, w)
    assert.match(text, /then press Refresh\./, `${w}: the button the person sees`)
    assert.doesNotMatch(text, /which means|did not let|reverted|press the button again|the blocker/, `${w} asserts a cause, or points at no button`)
  }
  assert.equal(new Set(told).size, states.length, 'each wallet state has its own way through')
  assert.match(told[0], /Connect wallet at the top of this page/)
  assert.match(told[1], /Press Switch in the wallet strip at the top of this page/)
  assert.match(told[2], /Your wallet could not read for this page either: a VPN or a filtering DNS can stop it too/)
  assert.doesNotMatch(told[2], /Connect wallet|connect a/, 'a wallet that could not read is not offered as the way through')
  assert.match(told[3], /this page sends that wallet's reads to these same network nodes/)
  assert.doesNotMatch(told[3], /Connect wallet|reads through your wallet|read through it/, 'a phone wallet is not a way past it')
  // The vault page names its own button; the setup says it reads again by itself.
  assert.match(m.readFailureNext({ kind: 'blocked', wallet: 'other_chain' }, 'press Refresh'), /Press Switch in the wallet strip/)
  assert.equal(m.readFailureNext({ kind: 'blocked' }, 'press Refresh'), told[0])
  assert.equal(m.readFailureNext({ kind: 'no_contract' }, 'press Refresh'), m.readFailureNext({ kind: 'no_contract', wallet: 'failed' }, 'x'))
  const page = repo('src/routes/app/ArcVault.tsx')
  assert.match(page, /Read failed at \{localTime\(read\.failure\.at\)\}: \{readFailureTitle\(read\.failure\)\}\./)
  assert.match(page, /\{readFailureNext\(read\.failure, 'press Refresh, or wait: this page tries again by itself'\)\}/)
  assert.match(repo('src/components/app/arc/DeployFlow.tsx'), /readFailureNext\(r\.failure, `wait: this page reads it again by itself every \$\{REREAD_MS \/ 1000\} seconds`\)/)

  // A write that stopped on a blocked read carries the wallet's state to its notice.
  for (const w of states) {
    const f = failureOf(Object.assign(new Error('No Arc Mainnet network node answered this page (a, b).'), { name: 'RpcUnreachableError', blocked: true, wallet: w }))
    assert.equal(f.code, 'rpc_blocked')
    assert.equal(f.wallet, w)
    const notice = explainFailure(f)
    assert.equal(notice.title, `${BLOCKED_TITLE}.`)
    assert.equal(notice.next, `Nothing was sent. ${blockedNext(w, 'try again')}`)
  }
  assert.equal(failureOf(Object.assign(new Error('x'), { name: 'RpcUnreachableError', blocked: true, wallet: 'nonsense' })).wallet, 'none')
  assert.equal(failureOf(Object.assign(new Error('x'), { name: 'RpcUnreachableError' })).code, 'rpc_unreachable')
  // The deploy's own USDC read passes the wallet's state on too.
  assert.match(repo('src/components/app/arc/DeployFlow.tsx'), /message: facts\.reason, wallet: facts\.wallet \}\)/)

  // The wallet's own failure text, which viem may word as a revert, never reaches a blocked read.
  const chain = m.ARC_MAINNET
  const broken = fakeWallet((method) => {
    if (method === 'eth_chainId') return hex(chain.chainId)
    if (method === 'eth_getBlockByNumber') return block(100n)
    if (method === 'eth_getCode') return '0x6080'
    throw Object.assign(new Error('Failed to fetch'), { code: -32603 })
  })
  m.setWalletReadProvider(broken.provider)
  try {
    await withNet(
      () => BLOCKED,
      async () => {
        const facts = await m.readUsdcFacts(chain)
        assert.equal(facts.ok, false)
        assert.equal(facts.blocked, true)
        assert.equal(facts.wallet, 'failed')
        assert.doesNotMatch(String(facts.reason), /revert/i)
        const v = await m.readVault(chain, VAULT)
        assert.ok(!v.ok)
        assert.equal(v.failure.kind, 'blocked')
        assert.equal(v.failure.wallet, 'failed')
        assert.doesNotMatch(v.failure.reason, /revert/i)
      },
    )
    // A phone wallet is never asked: its reads leave from this page for the same hosts.
    const phone = emptyWallet(chain.chainId)
    m.setWalletReadProvider(phone.provider, { walletConnect: true })
    const v = await withNet(() => BLOCKED, () => m.readVault(chain, VAULT))
    assert.ok(!v.ok)
    assert.equal(v.failure.wallet, 'walletconnect')
    assert.deepEqual(phone.calls, [])
  } finally {
    m.setWalletReadProvider(null)
  }
})

test('a write prepared while no node answers stops before the wallet, with the way through its state allows', async () => {
  const m = await read()
  const w = await write()
  const { explainFailure } = await explain()
  const { blockedNext } = await copy()
  const chain = m.ARC_MAINNET
  const usdc = m.usdcOf(chain)
  assert.ok(usdc)
  // A vault of the page's own build, as a read would have shown it: only the network is in the way.
  const v: Rec = {
    network: chain.caip2,
    chainId: chain.chainId,
    address: VAULT,
    host: m.hostOf(m.rpcUrls(chain)[0]),
    block: 100n,
    chainTime: 1_800_000_000n,
    readAt: new Date(1_000_000).toISOString(),
    owner: OWNER,
    operator: OPERATOR,
    usdc: usdc.address,
    usdcMatches: true,
    dailyCap: 0n,
    autoApproveMax: 0n,
    frozen: false,
    allowlistEnabled: false,
    sessionKeyExpiry: 0n,
    today: 1n,
    spentToday: 0n,
    balance: 0n,
    decimals: usdc.decimals,
    codeHash: '0x',
    codeBytes: 0,
    knownBuild: true,
    remainingToday: null,
    resetsAt: 86_400n,
    expired: false,
  }
  const stopOf = async (net: Net): Promise<Failure> => {
    try {
      await withNet(net, () => w.prepareFund(chain, v, OWNER, 1n))
    } catch (e) {
      const f = (e as { failure?: Failure }).failure
      assert.ok(f, `a typed stop, not ${String(e)}`)
      return f
    }
    return assert.fail('a transfer was prepared with no node answering')
  }
  try {
    const none = await stopOf(() => BLOCKED)
    assert.deepEqual([none.code, none.wallet], ['rpc_blocked', 'none'])
    assert.equal(explainFailure(none).next, `Nothing was sent. ${blockedNext('none', 'try again')}`)
    assert.doesNotMatch(none.message, /revert/i)
    m.setWalletReadProvider(emptyWallet(1).provider)
    const elsewhere = await stopOf(() => BLOCKED)
    assert.deepEqual([elsewhere.code, elsewhere.wallet], ['rpc_blocked', 'other_chain'])
    // emptyWallet answers the chain id and fails the code read with -32603, which viem can word as a revert.
    m.setWalletReadProvider(emptyWallet(chain.chainId).provider)
    const failedToo = await stopOf(() => BLOCKED)
    assert.deepEqual([failedToo.code, failedToo.wallet], ['rpc_blocked', 'failed'])
    assert.doesNotMatch(failedToo.message, /revert/i)
    // A network that answers 429 is busy, and busy is not blocked.
    m.setWalletReadProvider(null)
    const busy = await stopOf(() => BUSY)
    assert.equal(busy.code, 'rpc_unreachable')
    assert.equal(busy.wallet, undefined)
  } finally {
    m.setWalletReadProvider(null)
  }
})

test('a read no network node answered is tried again by the page, and again once a wallet holds an account', async () => {
  const m = await read()
  for (const kind of ['unreachable', 'blocked']) assert.equal(m.readTriesAgain(kind), true, kind)
  for (const kind of ['bad_address', 'no_usdc', 'no_contract', 'not_a_vault', 'wrong_chain', undefined]) assert.equal(m.readTriesAgain(kind), false, String(kind))
  const page = repo('src/routes/app/ArcVault.tsx')
  assert.match(page, /if \(!readTriesAgain\(failedKind\)\) return\s*const t = setInterval/)
  // A read made before the wallet held an account here is made again once it does, after the wallet
  // hook (called above it) has registered the wallet in the same commit.
  assert.match(page, /const blockedWithoutWallet = failedKind === 'blocked' && read\.failure\?\.wallet === 'none'/)
  assert.match(page, /if \(blockedWithoutWallet && wallet\.account\) void load\(\)/)
  assert.ok(page.indexOf('const wallet = useArcWallet()') < page.indexOf('const blockedWithoutWallet'))
})

test('a payments read no network node answered offers nothing, says why, and never asks the wallet', async () => {
  const m = await read()
  const e = await events()
  const chain = m.ARC_MAINNET
  const registry = m.rpcUrls(chain).map((u) => m.hostOf(u))
  const wallet = emptyWallet(chain.chainId)
  m.setWalletReadProvider(wallet.provider)
  try {
    const stopped = await withNet(() => BLOCKED, () => e.readPaidSince(chain, VAULT, 1n))
    assert.equal(stopped.ok, false)
    assert.equal(stopped.blocked, true)
    const busy = await withNet((host) => (host === registry[0] ? BUSY : BLOCKED), () => e.readPaidSince(chain, VAULT, 1n))
    assert.equal(busy.ok, false)
    assert.equal(busy.blocked, false, 'a 429 is the network answering')
    assert.deepEqual(wallet.calls, [], 'a payment missing from one wallet node must never free one')
  } finally {
    m.setWalletReadProvider(null)
  }
  const { explainFailure } = await explain()
  const { SCAN_BLOCKED_NEXT } = await copy()
  const told = explainFailure({ code: 'handoff_blocked', message: 'that read did not finish' })
  assert.equal(told.title, "This page cannot check the vault's recent payments from this browser.")
  assert.equal(told.next, `Nothing was sent. ${SCAN_BLOCKED_NEXT}`)
  assert.match(told.next, /so it offers no payment/)
  assert.match(told.next, /then reload this page/)
  assert.match(told.next, /never your wallet/)
  assert.match(told.next, /A lost connection looks the same/)
  assert.doesNotMatch(told.next, /Wait a minute/)
  // Both places that stop on that read say so.
  const approvals = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(approvals, /setScanBlocked\(got\.blocked === true\)/)
  assert.match(approvals, /code: scanBlocked && scanFailed !== null \? 'handoff_blocked' : 'handoff_unreadable'/)
  const handoff = repo('src/lib/arc/handoff-send.ts')
  assert.equal([...handoff.matchAll(/if \(!r\.ok\) return \{ failed: r\.reason, blocked: r\.blocked === true \}/g)].length, 2)
  assert.match(handoff, /if \('failed' in scan && scan\.blocked\) throw stop\('handoff_blocked', why\)/)
})
