import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arcSeasonReport, liveArcSeasonDeps } from './arc-season.js'
import { CHAINS, getChainById } from './chains/index.js'
import { proofRailIndex } from './chains/proof.js'
import { handleChainRoutes } from './http/chain-routes.js'
import type { RouteCtx } from './http/shared.js'
import {
  liveSettlementsByNetworkDeps,
  settlementsByNetwork,
  SETTLEMENT_LOG_UNREADABLE,
  type SettlementsByNetwork,
  type SettlementsByNetworkDeps,
} from './settlement-networks.js'
import { loadGatewaySettlements, type GatewaySettlementRecord, type X402SettlementRecord } from './storage.js'
import { internalPayers as gatewayInternalPayers } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers } from './x402-3009/rail.js'

/**
 * The Gateway and facilitator logs split by network, fed rows rather than logs.
 *
 * The general proof page could only say "9 internal / 7 external payments across supported
 * networks", and a reader had to verify elsewhere where each external payment settled. The
 * split exists to answer that on the page, so the rules worth pinning are the ones a wrong
 * row would quietly break: which rows count at all (settled ones only), which payers are ours
 * (either rail's list, in any case), which network a row lands on (the registry's, and its
 * own row when the registry does not know it), and that the season report, which Circle
 * judges, counts the same rows the same way.
 */
const arc = getChainById('arc-mainnet')!
const arcTestnet = getChainById('arc')!
const base = getChainById('base')!
const robinhood = getChainById('rhchain')!
const robinhoodTestnet = getChainById('rhchain-testnet')!
const arbitrum = getChainById('arbitrum')!

/** A CAIP-2 id no registry entry carries; the first test asserts that it stays so. */
const UNKNOWN = 'eip155:999999999'

const OURS_GATEWAY = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa'
const OURS_FACILITATOR = '0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const EXT_A = '0x1111111111111111111111111111111111111111'
const EXT_B = '0x2222222222222222222222222222222222222222'
const PAY_TO = '0x000000000000000000000000000000000000dEaD'
const NOW = Date.parse('2026-10-30T12:00:00Z')

const lower = (a: string) => a.toLowerCase()
/** The same address with its hex in upper case, which is how a wallet library may echo it. */
const shouty = (a: string) => '0x' + a.slice(2).toUpperCase()

let nonce = 0
const nextNonce = () => '0x' + (++nonce).toString(16).padStart(64, '0')

function gw(over: Partial<GatewaySettlementRecord> = {}): GatewaySettlementRecord {
  return {
    ts: '2026-10-29T10:00:00Z',
    outcome: 'credited',
    tool: 'risk_check',
    resource: '/api/x402/gateway/tools/risk_check',
    network: arc.caip2,
    asset: 'usdc',
    assetSymbol: 'USDC',
    assetDecimals: 6,
    value: '5000',
    amountUsd: 0.005,
    payer: EXT_A,
    payTo: PAY_TO,
    authNonce: nextNonce(),
    confirmedBy: 'gateway-transfers-api',
    facilitator: 'https://gateway.example',
    ...over,
  }
}

function fac(over: Partial<X402SettlementRecord> = {}): X402SettlementRecord {
  return {
    ts: '2026-10-29T11:00:00Z',
    outcome: 'settled',
    tool: 'verify_agent',
    resource: '/api/x402/tools/verify_agent',
    network: arc.caip2,
    asset: 'usdc',
    assetSymbol: 'USDC',
    assetDecimals: 6,
    value: '1500',
    amountUsd: 0.0015,
    baseUsd: 0.001,
    feeUsd: 0.0005,
    payer: OURS_FACILITATOR,
    payTo: PAY_TO,
    authNonce: nextNonce(),
    tx: '0x' + 'ab'.repeat(32),
    ...over,
  }
}

const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make)

type Over = { gateway?: GatewaySettlementRecord[]; facilitator?: X402SettlementRecord[] } & Partial<SettlementsByNetworkDeps>

/** Rows in, nothing read from disk or a database. */
function deps(over: Over = {}): SettlementsByNetworkDeps {
  const { gateway = [], facilitator = [], ...rest } = over
  return {
    gatewayRows: async () => gateway,
    facilitatorRows: async () => facilitator,
    internalPayers: { gateway: [lower(OURS_GATEWAY)], facilitator: [lower(OURS_FACILITATOR)] },
    now: () => NOW,
    ...rest,
  }
}

const side = (count: number, usd: number) => ({ count, usd })
const split = (internal: [number, number], external: [number, number]) => ({
  internal: side(...internal),
  external: side(...external),
})
const NONE = split([0, 0], [0, 0])

/** The shape of 2026-10-30: every external payment a Gateway check on Arc Mainnet, and the
 *  facilitator's rows all ours, one on Arc Mainnet and five across three other mainnets. */
function liveShapedRows() {
  return {
    gateway: [
      ...times(3, () => gw({ payer: OURS_GATEWAY })),
      ...times(4, () => gw({ payer: EXT_A })),
      ...times(3, () => gw({ payer: EXT_B, outcome: 'completed', tx: '0x' + 'cd'.repeat(32) })),
    ],
    facilitator: [
      fac({ network: arc.caip2 }),
      ...times(2, () => fac({ network: robinhood.caip2 })),
      ...times(2, () => fac({ network: arbitrum.caip2 })),
      fac({ network: base.caip2 }),
    ],
  }
}

test('each network is split per rail into internal and external, named from the registry', async () => {
  assert.ok(!CHAINS.some((c) => c.caip2 === UNKNOWN), `${UNKNOWN} joined the registry; pick another unknown id`)
  const r = await settlementsByNetwork(deps(liveShapedRows()))

  assert.equal(r.asOf, new Date(NOW).toISOString())
  assert.deepEqual(
    r.networks.map((n) => n.chain),
    ['arc-mainnet', 'base', 'rhchain', 'arbitrum'],
  )
  // Registry id, display name and CAIP-2, all from the registry entry, never restated.
  for (const n of r.networks) {
    const c = getChainById(n.chain!)!
    assert.deepEqual({ name: n.name, caip2: n.caip2, testnet: n.testnet }, { name: c.name, caip2: c.caip2, testnet: c.testnet })
  }
  const [onArc, onBase, onRobinhood, onArbitrum] = r.networks
  assert.deepEqual(onArc.byRail, { gateway: split([3, 0.015], [7, 0.035]), facilitator: split([1, 0.0015], [0, 0]) })
  assert.deepEqual(onBase.byRail, { gateway: NONE, facilitator: split([1, 0.0015], [0, 0]) })
  assert.deepEqual(onRobinhood.byRail, { gateway: NONE, facilitator: split([2, 0.003], [0, 0]) })
  assert.deepEqual(onArbitrum.byRail, { gateway: NONE, facilitator: split([2, 0.003], [0, 0]) })

  // Each rail across every network reconciles with its own log: the deliverable's
  // "9 internal / 7 external" is 3 + 6 internal and 7 + 0 external, now with a network each.
  assert.deepEqual(r.totals, { gateway: split([3, 0.015], [7, 0.035]), facilitator: split([6, 0.009], [0, 0]) })
  assert.equal(r.logs.gateway.label, 'Circle Gateway')
  assert.equal(r.logs.gateway.path, '/api/x402/gateway/proof')
  assert.equal(r.logs.facilitator.label, 'EIP-3009 facilitator')
  assert.equal(r.logs.facilitator.path, '/api/facilitator/proof')
  assert.match(r.basis, /either rail's published list/)
  assert.match(r.basis, /never added to the other/)
})

test('only settled rows count, and every row read is still reported', async () => {
  const r = await settlementsByNetwork(
    deps({
      gateway: [
        gw({ outcome: 'credited' }),
        gw({ outcome: 'completed', tx: '0x' + 'cd'.repeat(32) }),
        gw({ outcome: 'failed' }),
        gw({ outcome: 'unconfirmed', payer: EXT_B }),
      ],
      facilitator: [
        fac({ network: base.caip2 }),
        fac({ network: base.caip2, outcome: 'reverted', payer: EXT_A }),
        fac({ network: base.caip2, outcome: 'ambiguous', payer: EXT_A }),
        // A network whose only row reverted has nothing settled, so it is not listed at all.
        fac({ network: robinhood.caip2, outcome: 'reverted' }),
      ],
    }),
  )
  assert.deepEqual(
    r.networks.map((n) => n.chain),
    ['arc-mainnet', 'base'],
  )
  assert.deepEqual(r.networks[0].byRail.gateway, split([0, 0], [2, 0.01]))
  assert.deepEqual(r.networks[1].byRail.facilitator, split([1, 0.0015], [0, 0]))
  assert.deepEqual(r.totals, { gateway: split([0, 0], [2, 0.01]), facilitator: split([1, 0.0015], [0, 0]) })
  // The rows read include the ones that did not count, so a reader can see they exist.
  for (const log of [r.logs.gateway, r.logs.facilitator]) {
    assert.equal(log.readable, true)
    assert.equal(log.rows, 4)
    assert.equal('reason' in log, false)
  }
  assert.equal(r.logs.gateway.counts, 'rows credited or completed')
  assert.equal(r.logs.facilitator.counts, 'rows settled')
})

test('a network the registry does not know keeps its own row under its CAIP-2 id, after every network it does know', async () => {
  const r = await settlementsByNetwork(
    deps({
      gateway: [
        // A row that recorded no network at all: kept, labeled, and last.
        gw({ network: undefined as unknown as string, payer: EXT_B, amountUsd: 0.001 }),
        gw({ network: UNKNOWN, payer: EXT_A }),
      ],
      facilitator: [fac({ network: UNKNOWN, payer: EXT_A }), fac({ network: base.caip2 })],
    }),
  )
  assert.deepEqual(
    r.networks.map((n) => n.caip2),
    [base.caip2, UNKNOWN, ''],
  )
  const [onBase, unknown, unrecorded] = r.networks
  assert.deepEqual(
    { chain: unknown.chain, name: unknown.name, caip2: unknown.caip2, testnet: unknown.testnet },
    { chain: null, name: UNKNOWN, caip2: UNKNOWN, testnet: null },
  )
  assert.deepEqual(unknown.byRail, { gateway: split([0, 0], [1, 0.005]), facilitator: split([0, 0], [1, 0.0015]) })
  assert.deepEqual(
    { chain: unrecorded.chain, name: unrecorded.name, testnet: unrecorded.testnet },
    { chain: null, name: 'Network not recorded', testnet: null },
  )
  assert.deepEqual(unrecorded.byRail, { gateway: split([0, 0], [1, 0.001]), facilitator: NONE })
  // Never folded into a registry network, and never dropped from the totals.
  assert.deepEqual(onBase.byRail, { gateway: NONE, facilitator: split([1, 0.0015], [0, 0]) })
  assert.deepEqual(r.totals, { gateway: split([0, 0], [2, 0.006]), facilitator: split([1, 0.0015], [1, 0.0015]) })
})

test("a payer is internal on either rail's list, in any case, whichever rail it paid through", async () => {
  const r = await settlementsByNetwork(
    deps({
      // The lists are matched case-insensitively whatever case they are published in.
      internalPayers: { gateway: [shouty(OURS_GATEWAY)], facilitator: [OURS_FACILITATOR] },
      gateway: [
        // A wallet on the facilitator's list paying through Gateway is still ours.
        gw({ payer: shouty(OURS_FACILITATOR) }),
        gw({ payer: shouty(EXT_A) }),
      ],
      // And a wallet on Gateway's list paying through the facilitator.
      facilitator: [fac({ payer: lower(OURS_GATEWAY) }), fac({ payer: lower(EXT_B) })],
    }),
  )
  assert.deepEqual(r.networks[0].byRail, {
    gateway: split([1, 0.005], [1, 0.005]),
    facilitator: split([1, 0.0015], [1, 0.0015]),
  })
})

test('Arc Mainnet leads, then the other mainnets, then the testnets, in registry order', async () => {
  const r = await settlementsByNetwork(
    deps({
      gateway: [gw({ network: arcTestnet.caip2 }), gw({ network: arc.caip2 })],
      facilitator: [
        fac({ network: UNKNOWN }),
        fac({ network: robinhoodTestnet.caip2 }),
        fac({ network: arbitrum.caip2 }),
        fac({ network: base.caip2 }),
      ],
    }),
  )
  assert.deepEqual(
    r.networks.map((n) => n.chain),
    ['arc-mainnet', 'base', 'arbitrum', 'arc', 'rhchain-testnet', null],
  )
  assert.deepEqual(
    r.networks.map((n) => n.testnet),
    [false, false, false, true, true, null],
  )
})

test('on Arc Mainnet the split matches the season report for the same rows, to the last digit', async () => {
  const rows = {
    gateway: [
      gw({ payer: OURS_GATEWAY }),
      gw({ payer: EXT_A, outcome: 'completed', tx: '0x' + 'cd'.repeat(32) }),
      gw({ payer: EXT_B, amountUsd: 0.001 }),
      gw({ payer: shouty(OURS_FACILITATOR), amountUsd: 0.001 }),
      gw({ payer: EXT_A, outcome: 'failed' }),
      // Elsewhere: the season ignores these and the split lists them on their own rows.
      gw({ payer: EXT_A, network: arcTestnet.caip2 }),
    ],
    facilitator: [
      fac({ payer: OURS_FACILITATOR, amountUsd: 0.1 }),
      fac({ payer: lower(OURS_GATEWAY), amountUsd: 0.2 }),
      fac({ payer: EXT_B, amountUsd: 0.1 }),
      fac({ payer: EXT_A, amountUsd: 0.2 }),
      fac({ payer: EXT_A, outcome: 'ambiguous' }),
      fac({ payer: EXT_A, network: base.caip2 }),
    ],
  }
  const shared = deps(rows)
  const season = await arcSeasonReport({ ...shared, partners: [], vaults: [], refusals: [], flows: [] })
  const r = await settlementsByNetwork(shared)
  const onArc = r.networks.find((n) => n.chain === 'arc-mainnet')!
  assert.equal(onArc.caip2, season.network)
  for (const rail of ['gateway', 'facilitator'] as const) {
    for (const who of ['internal', 'external'] as const) {
      const theirs = season.usage[who].byRail[rail]
      assert.deepEqual(onArc.byRail[rail][who], { count: theirs.checks, usd: theirs.usd }, `${rail} ${who}`)
    }
  }
  // Not vacuous: both sides of both rails carry rows, and the float sums needed rounding.
  assert.deepEqual(onArc.byRail.gateway, split([2, 0.006], [2, 0.006]))
  assert.deepEqual(onArc.byRail.facilitator, split([2, 0.3], [2, 0.3]))
  assert.equal(r.networks.length, 3)
})

test('a log that fails or does not answer in time contributes nothing and says so', async () => {
  const failed = await settlementsByNetwork(
    deps({
      gateway: [gw()],
      facilitatorRows: async () => {
        throw new Error('connect ECONNREFUSED db.internal.example:5432')
      },
    }),
  )
  // Said in our words: the storage error, which can name a host or a path, is not published.
  assert.deepEqual(failed.logs.facilitator, {
    label: 'EIP-3009 facilitator',
    path: '/api/facilitator/proof',
    counts: 'rows settled',
    readable: false,
    rows: 0,
    reason: SETTLEMENT_LOG_UNREADABLE,
  })
  assert.doesNotMatch(JSON.stringify(failed), /db\.internal\.example|ECONNREFUSED/)
  assert.equal(failed.logs.gateway.readable, true)
  assert.deepEqual(failed.totals, { gateway: split([0, 0], [1, 0.005]), facilitator: NONE })

  const hung = await settlementsByNetwork(
    deps({
      gatewayRows: () => new Promise<GatewaySettlementRecord[]>(() => undefined),
      facilitator: [fac({ network: base.caip2 })],
      deadlineMs: 25,
    }),
  )
  assert.equal(hung.logs.gateway.readable, false)
  assert.match(hung.logs.gateway.reason ?? '', /did not answer within 25 ms/)
  assert.deepEqual(
    hung.networks.map((n) => n.chain),
    ['base'],
  )
  assert.equal(hung.logs.facilitator.readable, true)
})

test("the live deps are the season report's loaders and lists", () => {
  const env = { X402_GATEWAY_INTERNAL_PAYERS: EXT_A, X402_3009_INTERNAL_PAYERS: shouty(EXT_B) } as NodeJS.ProcessEnv
  const d = liveSettlementsByNetworkDeps(env)
  assert.deepEqual(d.internalPayers, liveArcSeasonDeps(env).internalPayers)
  assert.deepEqual(d.internalPayers.gateway, gatewayInternalPayers(env))
  assert.deepEqual(d.internalPayers.facilitator, facilitatorInternalPayers(env))
  assert.equal(d.gatewayRows, loadGatewaySettlements)
  assert.equal(typeof d.facilitatorRows, 'function')
  // No test clock and no shortened deadline leak into the live route.
  assert.equal(d.now, undefined)
  assert.equal(d.deadlineMs, undefined)
})

function fakeRes() {
  const out: { status?: number; headers: Record<string, string>; body?: Record<string, unknown> } = { headers: {} }
  return {
    out,
    res: {
      setHeader(name: string, value: string) {
        out.headers[name.toLowerCase()] = value
      },
      writeHead(status: number) {
        out.status = status
        return this
      },
      end(payload?: string) {
        if (payload) out.body = JSON.parse(payload) as Record<string, unknown>
      },
    } as never,
  }
}

async function getRails(splitByNetwork: () => Promise<SettlementsByNetwork>) {
  const { out, res } = fakeRes()
  const ctx: RouteCtx = {
    req: { method: 'GET', headers: {} } as never,
    res,
    url: new URL('http://localhost/api/proof/rails'),
    caller: null,
    callerId: undefined,
  }
  const handled = await handleChainRoutes(ctx, { splitByNetwork })
  return { handled, ...out }
}

test('GET /api/proof/rails adds the split beside a rail index left exactly as it was', async () => {
  const want = await settlementsByNetwork(deps(liveShapedRows()))
  const r = await getRails(async () => want)
  assert.equal(r.handled, true)
  assert.equal(r.status, 200)
  // The rail index is byte for byte what it was, so a page that predates the split reads on.
  assert.deepEqual(r.body?.rails, JSON.parse(JSON.stringify(proofRailIndex())))
  assert.deepEqual(Object.keys(r.body ?? {}), ['rails', 'settlementsByNetwork'])
  assert.deepEqual(r.body?.settlementsByNetwork, JSON.parse(JSON.stringify(want)))
  // Counted on every read, so nothing in front of it may serve an old count.
  assert.equal(r.headers['cache-control'], 'no-store')
})

test('a split that throws is left out, and the rail index still answers', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  const rails = JSON.parse(JSON.stringify(proofRailIndex()))
  const rejected = await getRails(async () => {
    throw new Error('the split broke')
  })
  const thrown = await getRails(() => {
    throw new Error('the split broke before its first await')
  })
  for (const r of [rejected, thrown]) {
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body ?? {}), ['rails'])
    assert.deepEqual(r.body?.rails, rails)
  }
})

// The page's reader, src/lib/settlement-networks.ts, run as it ships through Node's type
// stripping (see frontend-stellar.test.ts for why that is safe for an import-free file).

type PageSide = { count: number | null; usd: number | null }
type PageCell = { internal: PageSide; external: PageSide }
type PageRail = 'gateway' | 'facilitator'
type PageSplit = {
  asOf: string | null
  basis: string | null
  logs: Record<PageRail, { label: string; path: string | null; readable: boolean }>
  rows: { chain: string | null; name: string; caip2: string; testnet: boolean | null; byRail: Record<PageRail, PageCell | null> }[]
  totals: Record<PageRail, PageCell | null>
}
type PageModule = {
  readNetworkSplit: (raw: unknown) => PageSplit | null
  keepLastGoodSplit: (prev: PageSplit | null, next: PageSplit | null) => PageSplit | null
  SPLIT_RAILS: readonly PageRail[]
  SPLIT_LEADING_CHAIN: string
}

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const loadPage = async () => (await import(repoUrl('src/lib/settlement-networks.ts').href)) as PageModule

test('the page reads the split the backend sends, Arc Mainnet first', async () => {
  const { readNetworkSplit, SPLIT_RAILS, SPLIT_LEADING_CHAIN } = await loadPage()
  const backend = await settlementsByNetwork(deps(liveShapedRows()))
  const wire = JSON.parse(JSON.stringify(backend)) as { networks: unknown[] }
  const page = readNetworkSplit(wire)!

  assert.equal(page.asOf, backend.asOf)
  assert.equal(page.basis, backend.basis)
  assert.deepEqual(page.rows, backend.networks)
  assert.deepEqual(page.totals, backend.totals)
  for (const rail of SPLIT_RAILS) {
    assert.deepEqual(page.logs[rail], { label: backend.logs[rail].label, path: backend.logs[rail].path, readable: true })
  }
  assert.deepEqual([...SPLIT_RAILS], Object.keys(backend.totals))

  // Arc Mainnet leads on the page even from a backend that sends another order, and every
  // other row keeps the order it was sent in.
  assert.ok(getChainById(SPLIT_LEADING_CHAIN), `${SPLIT_LEADING_CHAIN} is not a registry id`)
  const reversed = readNetworkSplit({ ...wire, networks: [...wire.networks].reverse() })!
  assert.deepEqual(
    reversed.rows.map((n) => n.chain),
    ['arc-mainnet', 'arbitrum', 'rhchain', 'base'],
  )
})

test('the page shows nothing extra for a backend that sends no split, and never reads a gap as zero', async () => {
  const { readNetworkSplit } = await loadPage()
  // A backend deployed before the split sends no field at all.
  assert.equal(readNetworkSplit(undefined), null)
  for (const junk of [null, 'split', 42, [], {}, { networks: 'none' }]) {
    assert.equal(readNetworkSplit(junk), null, `read ${JSON.stringify(junk)} as a split`)
  }

  // A split with nothing settled is still a split, and the page says so in words.
  const empty = readNetworkSplit({ networks: [] })!
  assert.deepEqual(empty.rows, [])
  assert.deepEqual(
    { gateway: empty.logs.gateway.label, facilitator: empty.logs.facilitator.label },
    { gateway: 'Circle Gateway', facilitator: 'EIP-3009 facilitator' },
  )

  const gappy = readNetworkSplit({
    logs: { facilitator: { label: 'EIP-3009 facilitator', readable: false } },
    networks: [
      { chain: 'base', name: 'Base', caip2: base.caip2, testnet: false, byRail: { gateway: { internal: { count: 2 }, external: {} } } },
      { chain: 'base', name: 'no CAIP-2 at all' },
    ],
  })!
  assert.equal(gappy.rows.length, 1)
  assert.deepEqual(gappy.rows[0].byRail, {
    gateway: { internal: { count: 2, usd: null }, external: { count: null, usd: null } },
    facilitator: null,
  })
  assert.equal(gappy.logs.facilitator.readable, false)
  assert.equal(gappy.logs.gateway.readable, true)
  assert.deepEqual(gappy.totals, { gateway: null, facilitator: null })
})

test('a refresh that loses a log keeps the last split where every log answered, as the tiles do', async () => {
  const { readNetworkSplit, keepLastGoodSplit } = await loadPage()
  const read = async (over: Over) => readNetworkSplit(JSON.parse(JSON.stringify(await settlementsByNetwork(deps(over)))))!
  const good = await read(liveShapedRows())
  const newer = await read({ ...liveShapedRows(), now: () => NOW + 60_000 })
  const lost = await read({
    ...liveShapedRows(),
    facilitatorRows: async () => {
      throw new Error('connection reset')
    },
  })
  assert.equal(lost.logs.facilitator.readable, false)

  // Nothing kept and nothing sent: a backend that predates the split shows nothing.
  assert.equal(keepLastGoodSplit(null, null), null)
  // A log never read says so.
  assert.equal(keepLastGoodSplit(null, lost), lost)
  // A refresh that fails, or sends no split, keeps the last good read with its own asOf.
  assert.equal(keepLastGoodSplit(good, lost), good)
  assert.equal(keepLastGoodSplit(good, null), good)
  // Anything at least as complete as what is shown replaces it.
  assert.equal(keepLastGoodSplit(good, newer), newer)
  assert.equal(keepLastGoodSplit(lost, good), good)
  const lostAgain = { ...lost, asOf: newer.asOf }
  assert.equal(keepLastGoodSplit(lost, lostAgain), lostAgain)
})
