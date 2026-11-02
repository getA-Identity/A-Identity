import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  arcSeasonReport,
  liveArcSeasonDeps,
  ARC_PARTNERS,
  ARC_OWNER_HELD_VAULTS,
  ARC_REFUSALS,
  ARC_VERIFY_THEN_PAY_FLOWS,
  ARC_SEASON_TARGETS,
  mergeFlows,
  seasonFlowsFromRows,
  type ArcSeasonDeps,
  type ArcVerifyThenPayFlow,
} from './arc-season.js'
import { getChainById } from './chains/index.js'
import { addressUrl, txUrl } from './chains/explorer.js'
import { internalPayers as gatewayInternalPayers } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers } from './x402-3009/rail.js'
import type { GatewaySettlementRecord, VtpFlowRecord, X402SettlementRecord } from './storage.js'

/**
 * The Arc Acceleration Season report, fed rows rather than logs.
 *
 * Circle judges Deliverable 2 on these numbers with external activity counted apart from
 * our own, so the two rules that matter most are the ones a wrong row would quietly break:
 * which rows are checks at all (settled, on Arc Mainnet, nothing else), and which payers
 * are ours. Everything else here is bookkeeping on top of those two.
 */
const arc = getChainById('arc-mainnet')!
const base = getChainById('base')!

const OURS_GATEWAY = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa'
const OURS_FACILITATOR = '0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const EXT_A = '0x1111111111111111111111111111111111111111'
const EXT_B = '0x2222222222222222222222222222222222222222'
const EXT_C = '0x3333333333333333333333333333333333333333'
const PAY_TO = '0x000000000000000000000000000000000000dEaD'
const NOW = Date.parse('2026-10-19T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const lower = (a: string) => a.toLowerCase()
/** The same address with its hex in upper case, which is how a wallet library may echo it. */
const shouty = (a: string) => '0x' + a.slice(2).toUpperCase()

let nonce = 0
const nextNonce = () => '0x' + (++nonce).toString(16).padStart(64, '0')

function gw(over: Partial<GatewaySettlementRecord> = {}): GatewaySettlementRecord {
  return {
    ts: '2026-10-18T10:00:00Z',
    outcome: 'credited',
    tool: 'risk_check',
    resource: '/api/x402/gateway/tools/risk_check',
    network: arc.caip2,
    asset: 'usdc',
    assetSymbol: 'USDC',
    assetDecimals: 6,
    value: '1000',
    amountUsd: 0.001,
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
    ts: '2026-10-18T11:00:00Z',
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
    payer: EXT_A,
    payTo: PAY_TO,
    authNonce: nextNonce(),
    tx: '0x' + 'ab'.repeat(32),
    ...over,
  }
}

const CHECKED_PAYEE = '0x6666666666666666666666666666666666666666'

/** One transaction proves one flow, so each flow gets its own unless a test says otherwise. */
let txCounter = 0x55
const nextTx = () => '0x' + (++txCounter).toString(16).padStart(64, '5')

function flow(over: Partial<ArcVerifyThenPayFlow> = {}): ArcVerifyThenPayFlow {
  return {
    checkNonce: nextNonce(),
    payee: CHECKED_PAYEE,
    outcome: 'paid',
    txHash: nextTx(),
    at: '2026-11-01T10:00:00Z',
    note: 'ALLOW, the vault paid',
    ...over,
  }
}

type Over = { gateway?: GatewaySettlementRecord[]; facilitator?: X402SettlementRecord[] } & Partial<
  Omit<ArcSeasonDeps, 'gatewayRows' | 'facilitatorRows'>
>

/** Rows in, nothing read from disk; the curated lists empty unless a test fills them. */
function deps(over: Over = {}): ArcSeasonDeps {
  const { gateway = [], facilitator = [], ...rest } = over
  return {
    gatewayRows: async () => gateway,
    facilitatorRows: async () => facilitator,
    internalPayers: { gateway: [lower(OURS_GATEWAY)], facilitator: [lower(OURS_FACILITATOR)] },
    now: () => NOW,
    partners: [],
    vaults: [],
    refusals: [],
    flows: [],
    ...rest,
  }
}

const EMPTY_SIDE = {
  checks: 0,
  usd: 0,
  wallets: [],
  activeDays: [],
  byRail: { gateway: { checks: 0, usd: 0 }, facilitator: { checks: 0, usd: 0 } },
}

test('the zero state reports every metric at 0 with its target and a reason, on the registry network', async () => {
  const r = await arcSeasonReport(deps())
  assert.equal(r.chain, 'arc-mainnet')
  assert.equal(r.network, arc.caip2)
  assert.equal(r.asOf, new Date(NOW).toISOString())
  assert.deepEqual(r.program, {
    name: 'Arc Acceleration Season',
    deliverable2Due: '2026-10-30',
    milestone1Due: '2026-11-05',
    milestone2Due: '2026-11-06',
  })
  assert.deepEqual(r.logs, { gateway: { readable: true, rows: 0 }, facilitator: { readable: true, rows: 0 } })
  assert.deepEqual(r.usage.internal, EMPTY_SIDE)
  assert.deepEqual(r.usage.external, { ...EMPTY_SIDE, byWallet: [] })

  const m1 = r.milestone1
  assert.deepEqual([m1.vaults.count, m1.vaults.target], [0, 5])
  assert.deepEqual([m1.checks.count, m1.checks.target, m1.checks.internal, m1.checks.external], [0, 100, 0, 0])
  assert.deepEqual([m1.checks.linked, m1.checks.unlinked, m1.checks.items], [{ paid: 0, refused: 0 }, 0, []])
  assert.deepEqual([m1.refusals.count, m1.refusals.target], [0, 2])
  assert.deepEqual(m1.refusals.byKind, { 'vault-policy-on-chain': 0, 'deny-before-signing': 0 })
  assert.equal(m1.evidence, 'https://a-identity.xyz/proof/arc')

  const m2 = r.milestone2
  assert.deepEqual([m2.externalTeamsLive.count, m2.externalTeamsLive.target], [0, 2])
  assert.deepEqual([m2.externalChecks.count, m2.externalChecks.target], [0, 30])
  assert.deepEqual([m2.teamActiveOnSeveralDays.count, m2.teamActiveOnSeveralDays.target], [0, 1])
  assert.deepEqual([m2.publicReference.count, m2.publicReference.target], [0, 1])
  assert.deepEqual([m2.unattributed.wallets, m2.unattributed.checks], [0, 0])

  const after = r.afterProgram.activeExternalWallets
  assert.deepEqual([after.count, after.target, after.windowDays, after.wallets], [0, 5, 28, []])

  // Every zero carries a sentence saying why, so the page never has to show a bare 0.
  for (const note of [
    m1.vaults.note,
    m1.checks.note,
    m1.refusals.note,
    m2.externalTeamsLive.note,
    m2.externalChecks.note,
    m2.teamActiveOnSeveralDays.note,
    m2.publicReference.note,
    r.usage.basis,
    r.afterProgram.note,
    r.note,
  ]) {
    assert.ok(note.length > 40, `too short to explain anything: ${note}`)
  }
  assert.match(r.note, /revised by Circle on 2026-10-19/)
})

test('a check is counted only on Arc Mainnet and only with a settled outcome', async () => {
  const r = await arcSeasonReport(
    deps({
      gateway: [
        gw(),
        gw({ outcome: 'completed', tx: '0x' + 'cd'.repeat(32) }),
        gw({ outcome: 'failed' }),
        gw({ outcome: 'unconfirmed' }),
        gw({ network: base.caip2 }),
      ],
      facilitator: [fac(), fac({ outcome: 'reverted' }), fac({ outcome: 'ambiguous' }), fac({ network: base.caip2 })],
    }),
  )
  assert.equal(r.usage.external.checks, 3)
  assert.deepEqual(r.usage.external.byRail, { gateway: { checks: 2, usd: 0.002 }, facilitator: { checks: 1, usd: 0.0015 } })
  // Both Gateway rows that pass are external, so Milestone 1 reports them only as the
  // external checks it leaves to Milestone 2.
  assert.deepEqual([r.milestone1.checks.count, r.milestone1.checks.external], [0, 2])
  // The rows read are reported before filtering, so a reader can see how many were dropped.
  assert.deepEqual(r.logs, { gateway: { readable: true, rows: 5 }, facilitator: { readable: true, rows: 4 } })
})

test("internal and external are split by the union of both rails' own-wallet lists, whatever the case", async () => {
  const r = await arcSeasonReport(
    deps({
      gateway: [gw({ payer: shouty(OURS_GATEWAY) }), gw({ payer: OURS_FACILITATOR }), gw({ payer: EXT_A })],
      facilitator: [fac({ payer: lower(OURS_FACILITATOR) }), fac({ payer: OURS_GATEWAY }), fac({ payer: shouty(EXT_B) })],
    }),
  )
  assert.equal(r.usage.internal.checks, 4)
  assert.equal(r.usage.external.checks, 2)
  assert.deepEqual(r.usage.internal.wallets, [lower(OURS_GATEWAY), lower(OURS_FACILITATOR)].sort())
  assert.deepEqual(r.usage.external.wallets, [lower(EXT_A), lower(EXT_B)])
  assert.equal(r.usage.internal.usd, 0.005)
  assert.equal(r.usage.external.usd, 0.0025)
  assert.deepEqual(r.usage.internal.byRail, { gateway: { checks: 2, usd: 0.002 }, facilitator: { checks: 2, usd: 0.003 } })
  // The wallets are published lowercased, so the same wallet never appears twice.
  assert.deepEqual(r.usage.external.byWallet.map((w) => w.wallet), [lower(EXT_A), lower(EXT_B)])
})

test('Milestone 1 counts verify-then-pay flows, not checks, and leaves external checks to Milestone 2', async () => {
  const own = gw({ payer: OURS_GATEWAY })
  const ext = gw({ payer: EXT_A })
  const r = await arcSeasonReport(
    deps({
      gateway: [own, gw({ payer: OURS_GATEWAY }), ext, gw({ payer: EXT_A })],
      facilitator: [fac({ payer: OURS_FACILITATOR }), fac({ payer: EXT_B })],
      flows: [
        flow({ checkNonce: own.authNonce }),
        // An external team's check followed by its own vault payment is still Milestone 2's.
        flow({ checkNonce: ext.authNonce }),
      ],
    }),
  )
  const { count, internal, external, linked, unlinked, rail } = r.milestone1.checks
  assert.deepEqual(
    { count, internal, external, linked, unlinked, rail },
    { count: 1, internal: 2, external: 2, linked: { paid: 1, refused: 0 }, unlinked: 1, rail: 'circle-gateway' },
  )
  assert.equal(r.usage.internal.byRail.facilitator.checks, 1)
  assert.equal(r.usage.external.byRail.facilitator.checks, 1)
  // Milestone 2's external count is rail-agnostic, and it is where the external checks live.
  assert.equal(r.milestone2.externalChecks.count, 3)
  assert.match(r.milestone1.checks.note, /1 of 100 verify-then-pay flows/)
  assert.match(r.milestone1.checks.note, /count under Milestone 2, not here, so no check counts twice/)
})

test('a flow counts once, only on our own settled Gateway check on Arc Mainnet, and only with evidence', async () => {
  const paid = gw({ payer: OURS_GATEWAY })
  const denied = gw({ payer: OURS_GATEWAY })
  const reverted = gw({ payer: OURS_GATEWAY })
  const noEvidence = gw({ payer: OURS_GATEWAY })
  const noPayee = gw({ payer: OURS_GATEWAY })
  const paidBeforeCheck = gw({ payer: OURS_GATEWAY, ts: '2026-10-18T10:00:00Z' })
  const offNetwork = gw({ payer: OURS_GATEWAY, network: base.caip2 })
  const unsettled = gw({ payer: OURS_GATEWAY, outcome: 'unconfirmed' })
  const viaFacilitator = fac({ payer: OURS_FACILITATOR })
  const paidTx = '0x' + '33'.repeat(32)
  const revertTx = '0x' + '44'.repeat(32)
  const denyEntry = 'https://a-identity.xyz/proof/arc#deny-1'
  const r = await arcSeasonReport(
    deps({
      gateway: [paid, denied, reverted, noEvidence, noPayee, paidBeforeCheck, offNetwork, unsettled],
      facilitator: [viaFacilitator],
      flows: [
        // Named in upper case: a nonce matches whatever the case.
        flow({ checkNonce: shouty(paid.authNonce), txHash: paidTx }),
        // The same check linked twice is still one flow.
        flow({ checkNonce: paid.authNonce, txHash: paidTx }),
        flow({ checkNonce: denied.authNonce, outcome: 'refused', txHash: undefined, evidenceUrl: denyEntry }),
        flow({ checkNonce: reverted.authNonce, outcome: 'refused', txHash: revertTx }),
        // A payment with no Paid transaction gives a reviewer nothing to open.
        flow({ checkNonce: noEvidence.authNonce, txHash: undefined, evidenceUrl: 'https://a-identity.xyz/proof/arc' }),
        // Without the checked payee nobody can match the verdict to the Paid event.
        flow({ checkNonce: noPayee.authNonce, payee: '' }),
        // A payment that came before its check was not verified first.
        flow({ checkNonce: paidBeforeCheck.authNonce, at: '2026-10-18T09:59:59Z' }),
        flow({ checkNonce: offNetwork.authNonce }),
        flow({ checkNonce: unsettled.authNonce }),
        // Only Gateway checks are Milestone 1's, so a facilitator settlement links nothing.
        flow({ checkNonce: viaFacilitator.authNonce }),
        // A nonce that names no row counts nothing.
        flow({ checkNonce: nextNonce() }),
      ],
    }),
  )
  const c = r.milestone1.checks
  assert.deepEqual([c.count, c.internal, c.unlinked], [3, 6, 3])
  assert.deepEqual(c.linked, { paid: 1, refused: 2 })
  assert.deepEqual(
    c.items.map((i) => i.explorerUrl),
    [txUrl(arc, paidTx), null, txUrl(arc, revertTx)],
  )
  assert.equal(c.items[1].evidenceUrl, denyEntry)
  assert.match(c.note, /3 of 100 verify-then-pay flows/)
  assert.match(c.note, /1 vault payment\(s\) and 2 refusal\(s\)/)
})

test("active days are distinct UTC days, bounded by the wallet's first and last check in time order", async () => {
  const r = await arcSeasonReport(
    deps({
      gateway: [
        gw({ payer: EXT_A, ts: '2026-10-20T23:59:59Z' }),
        gw({ payer: EXT_A, ts: '2026-10-21T00:00:01Z' }),
        gw({ payer: EXT_A, ts: '2026-10-21T13:00:00Z' }),
        // Local midnight-plus-two in a +03:00 zone is still the 20th in UTC, and the
        // earliest of the four even though it sorts last as a string.
        gw({ payer: EXT_A, ts: '2026-10-21T02:00:00+03:00' }),
        gw({ payer: EXT_B, ts: 'not a date' }),
      ],
    }),
  )
  const [a, b] = r.usage.external.byWallet
  assert.equal(a.wallet, lower(EXT_A))
  assert.equal(a.checks, 4)
  assert.deepEqual(a.activeDays, ['2026-10-20', '2026-10-21'])
  assert.equal(a.firstTs, '2026-10-21T02:00:00+03:00')
  assert.equal(a.lastTs, '2026-10-21T13:00:00Z')
  // An unparseable timestamp still counts the check; it just cannot name a day.
  assert.equal(b.checks, 1)
  assert.deepEqual(b.activeDays, [])
  assert.deepEqual(r.usage.external.activeDays, ['2026-10-20', '2026-10-21'])
})

test('a partner is live once its wallet paid, on several days only with two UTC days, and public only when flagged', async () => {
  const r = await arcSeasonReport(
    deps({
      partners: [
        { wallet: shouty(EXT_A), team: 'Team A', publicReference: true },
        { wallet: EXT_B, team: 'Team B', publicReference: false },
        { wallet: EXT_C, team: 'Team C, signed up and never paid', publicReference: true },
      ],
      gateway: [gw({ payer: EXT_A, ts: '2026-10-17T10:00:00Z' }), gw({ payer: EXT_A, ts: '2026-10-18T10:00:00Z' })],
      facilitator: [fac({ payer: EXT_B, ts: '2026-10-18T10:00:00Z' }), fac({ payer: EXT_B, ts: '2026-10-18T22:00:00Z' })],
    }),
  )
  const m2 = r.milestone2
  assert.equal(m2.externalTeamsLive.count, 2)
  assert.deepEqual(m2.externalTeamsLive.teams.map((t) => [t.team, t.wallet, t.checks, t.publicReference]), [
    ['Team A', lower(EXT_A), 2, true],
    ['Team B', lower(EXT_B), 2, false],
  ])
  assert.deepEqual([m2.teamActiveOnSeveralDays.count, m2.teamActiveOnSeveralDays.teams], [1, ['Team A']])
  assert.deepEqual([m2.publicReference.count, m2.publicReference.names], [1, ['Team A']])
  assert.deepEqual(r.usage.external.byWallet.map((w) => w.team), ['Team A', 'Team B'])
  assert.deepEqual([m2.unattributed.wallets, m2.unattributed.checks], [0, 0])
})

test('an external wallet nobody attributed is reported as unattributed, never folded into a team', async () => {
  const r = await arcSeasonReport(
    deps({
      partners: [{ wallet: EXT_A, team: 'Team A', publicReference: false }],
      gateway: [gw({ payer: EXT_A }), gw({ payer: EXT_B }), gw({ payer: EXT_B })],
    }),
  )
  assert.deepEqual([r.milestone2.unattributed.wallets, r.milestone2.unattributed.checks], [1, 2])
  assert.equal(r.milestone2.externalTeamsLive.count, 1)
  assert.equal(r.milestone2.externalChecks.count, 3)
  assert.match(r.milestone2.unattributed.note, /1 external wallet\(s\) paid 2 check\(s\)/)
  const b = r.usage.external.byWallet.find((w) => w.wallet === lower(EXT_B))!
  assert.equal(b.team, undefined)
})

// ── recorded DENYs and whose wallet they name ────────────────────────────────────────

const OUR_VAULT_OWNER = '0x' + 'b7'.repeat(20)
const OPERATOR_KEY = '0x' + 'a9'.repeat(20)
const OUR_PAY_TO = '0x' + 'c8'.repeat(20)
const denyFlow = (nonce: string, over: Partial<ArcVerifyThenPayFlow> = {}) =>
  flow({ checkNonce: nonce, outcome: 'refused', txHash: undefined, evidenceUrl: `https://a-identity.xyz/api/x402/gateway/flows/${nonce}`, note: 'risk_check DENY stopped a payment', ...over })

test('a recorded DENY with a public record fills the refusal metric, with no hand-committed entry', async () => {
  const check = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(deps({ gateway: [check], flows: [denyFlow(check.authNonce)], refusals: [] }))
  assert.equal(r.milestone1.refusals.count, 1)
  assert.deepEqual(r.milestone1.refusals.byKind, { 'vault-policy-on-chain': 0, 'deny-before-signing': 1 })
  const [item] = r.milestone1.refusals.items
  assert.equal(item.evidenceUrl, `https://a-identity.xyz/api/x402/gateway/flows/${check.authNonce}`)
  assert.equal(item.explorerUrl, null)
  assert.match(r.milestone1.refusals.note, /1 DENY result\(s\) stopped before signing/)
})

test('only a linked DENY with a record counts: not a paid flow, an on-chain revert, or a nonce that names nothing', async () => {
  const paid = gw({ payer: OURS_GATEWAY })
  const reverted = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(
    deps({
      gateway: [paid, reverted],
      refusals: [],
      flows: [flow({ checkNonce: paid.authNonce }), flow({ checkNonce: reverted.authNonce, outcome: 'refused', txHash: '0x' + '44'.repeat(32) }), denyFlow(nextNonce())],
    }),
  )
  assert.equal(r.milestone1.checks.count, 2)
  assert.equal(r.milestone1.refusals.count, 0)
})

test('a curated entry for the same record does not count twice, and a long run is counted and not all listed', async () => {
  const checks = Array.from({ length: 8 }, () => gw({ payer: OURS_GATEWAY }))
  const flows = checks.map((c) => denyFlow(c.authNonce))
  const curated = { kind: 'deny-before-signing' as const, evidenceUrl: flows[0].evidenceUrl, at: flows[0].at, note: 'curated' }
  const r = await arcSeasonReport(deps({ gateway: checks, flows, refusals: [curated] }))
  assert.equal(r.milestone1.refusals.byKind['deny-before-signing'], 8)
  assert.equal(r.milestone1.refusals.items.length, 6, 'the curated entry and the first five')
  assert.match(r.milestone1.refusals.note, /2 more DENY record\(s\) are on checks.items/)
})

test('the refusal metric counts kinds: any number of DENYs is 1 of 2 until a revert is on chain too', async () => {
  const checks = Array.from({ length: 9 }, () => gw({ payer: OURS_GATEWAY }))
  const flows = checks.map((c) => denyFlow(c.authNonce))
  const denyOnly = await arcSeasonReport(deps({ gateway: checks, flows, refusals: [] }))
  assert.equal(denyOnly.milestone1.refusals.count, 1, 'nine of one kind do not stand in for the other')
  assert.deepEqual(denyOnly.milestone1.refusals.byKind, { 'vault-policy-on-chain': 0, 'deny-before-signing': 9 })
  assert.match(denyOnly.milestone1.refusals.note, /^1 of the 2 kinds committed to: 0 vault-policy refusal\(s\) on chain and 9 DENY/)

  const reverted = { kind: 'vault-policy-on-chain' as const, txHash: '0x' + '33'.repeat(32), at: '2026-10-26T10:00:00Z', note: 'reverted AboveAutoApprove' }
  const both = await arcSeasonReport(deps({ gateway: checks, flows, refusals: [reverted] }))
  assert.equal(both.milestone1.refusals.count, 2)
  assert.equal(both.milestone1.refusals.target, 2)
  assert.deepEqual(both.milestone1.refusals.byKind, { 'vault-policy-on-chain': 1, 'deny-before-signing': 9 })
})

test('the page lists every flow, each with something a reviewer can open', async () => {
  const check = gw({ payer: OURS_GATEWAY })
  const paidCheck = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(deps({ gateway: [check, paidCheck], flows: [denyFlow(check.authNonce), flow({ checkNonce: paidCheck.authNonce })] }))
  const items = r.milestone1.checks.items
  assert.equal(items.length, 2)
  for (const f of items) assert.ok(f.explorerUrl || f.evidenceUrl, 'a counted flow always has a link')
  const page = readFileSync(new URL('../../src/components/proof/ArcSeasonProgress.tsx', import.meta.url), 'utf8')
  assert.match(page, /<FlowList items=\{m1\.checks\.items\} \/>/)
  assert.match(page, /m1\.refusals\.byKind/, 'the row says how many of each kind stand behind its two')
})

test('a flow whose payee is ours or the vault key is labeled, counted, and said in the note', async () => {
  const toOwner = gw({ payer: OURS_GATEWAY })
  const toOperator = gw({ payer: OURS_GATEWAY })
  const toRail = gw({ payer: OURS_GATEWAY })
  const toBuyer = gw({ payer: OURS_GATEWAY })
  const toStranger = gw({ payer: OURS_GATEWAY })
  const keys = { owner: OUR_VAULT_OWNER, operator: OPERATOR_KEY }
  const r = await arcSeasonReport(
    deps({
      gateway: [toOwner, toOperator, toRail, toBuyer, toStranger],
      refusals: [],
      ourPayTo: [OUR_PAY_TO],
      flows: [
        denyFlow(toOwner.authNonce, { payee: shouty(OUR_VAULT_OWNER), vaultKeys: keys }),
        denyFlow(toOperator.authNonce, { payee: OPERATOR_KEY, vaultKeys: keys }),
        denyFlow(toRail.authNonce, { payee: OUR_PAY_TO, vaultKeys: keys }),
        denyFlow(toBuyer.authNonce, { payee: lower(OURS_FACILITATOR), vaultKeys: keys }),
        denyFlow(toStranger.authNonce, { vaultKeys: keys }),
      ],
    }),
  )
  const c = r.milestone1.checks
  assert.equal(c.count, 5, 'they are real settled checks, so they still count')
  assert.equal(c.internalPayee, 4)
  assert.equal(c.refusedPayees, 5)
  assert.deepEqual(c.items.map((i) => Boolean((i as { payeeInternal?: string }).payeeInternal)), [true, true, true, true, false])
  assert.match((c.items[0] as { payeeInternal?: string }).payeeInternal ?? '', /owner/)
  assert.match(c.note, /4 of the flows name a payee that is our own wallet or the vault's own key/)
  assert.match(c.note, /5 distinct payee/)
  assert.ok(r.milestone1.refusals.items[0].payeeInternal, 'the refusal that came from it says so too')
  assert.equal(r.milestone1.refusals.items[4].payeeInternal, undefined)
})

test('a season with no such flow says nothing about them', async () => {
  const check = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(deps({ gateway: [check], flows: [denyFlow(check.authNonce, { vaultKeys: { owner: OUR_VAULT_OWNER, operator: OPERATOR_KEY } })] }))
  assert.equal(r.milestone1.checks.internalPayee, 0)
  assert.doesNotMatch(r.milestone1.checks.note, /our own wallet or the vault/)
})

test('vault and refusal items derive their explorer links from the registry and count by list length', async () => {
  const deployTx = '0x' + '11'.repeat(32)
  const refusalTx = '0x' + '22'.repeat(32)
  const r = await arcSeasonReport(
    deps({
      vaults: [{ address: EXT_A, owner: EXT_B, ownerKind: 'external', deployTx, deployedAt: '2026-10-25', note: 'deployed from the browser' }],
      refusals: [
        { kind: 'vault-policy-on-chain', txHash: refusalTx, at: '2026-10-26T10:00:00Z', note: 'reverted AboveAutoApprove' },
        {
          kind: 'deny-before-signing',
          evidenceUrl: 'https://a-identity.xyz/api/agents/audit-log?id=1',
          at: '2026-10-26T11:00:00Z',
          note: 'DENY, nothing signed',
        },
      ],
    }),
  )
  const { vaults, refusals } = r.milestone1
  assert.equal(vaults.count, 1)
  assert.equal(vaults.items[0].explorerUrl, addressUrl(arc, EXT_A))
  assert.equal(vaults.items[0].deployExplorerUrl, txUrl(arc, deployTx))
  assert.ok(vaults.items[0].explorerUrl.startsWith(arc.explorer!))
  assert.doesNotMatch(vaults.note, /No owner-held vault yet/)
  assert.equal(vaults.items[0].ownerKind, 'external')
  // Past 0 the note still says the launch-day vault is not counted, and the page keeps showing it.
  assert.match(vaults.note, /launch-day vault 0x[0-9a-fA-F]{40} is owned by our operating wallet and is not among them/)
  const page = readFileSync(new URL('../../src/components/proof/ArcSeasonProgress.tsx', import.meta.url), 'utf8')
  assert.match(page, /metric=\{m1\.vaults\} keepNote/)
  assert.match(page, /ownerKind\?: 'team' \| 'external'/, 'a backend from before the label must still render')
  assert.equal(refusals.count, 2)
  assert.deepEqual(refusals.byKind, { 'vault-policy-on-chain': 1, 'deny-before-signing': 1 })
  assert.equal(refusals.items[0].explorerUrl, txUrl(arc, refusalTx))
  // A DENY that stopped the payment before signing has no transaction, so no link is invented.
  assert.equal(refusals.items[1].explorerUrl, null)
  assert.equal(refusals.items[1].evidenceUrl, 'https://a-identity.xyz/api/agents/audit-log?id=1')
})

test('with the curated lists empty, the notes say why the launch-day vault and refusal do not count', async () => {
  const r = await arcSeasonReport(deps({ vaults: [], refusals: [], partners: [] }))
  // The address comes from the provenance ledger, not from a second copy in the report.
  assert.match(r.milestone1.vaults.note, /launch-day vault 0x[0-9a-fA-F]{40} was deployed from our server key with our operating wallet as its owner/)
  assert.match(r.milestone1.vaults.note, /not owner-held and is not counted/)
  assert.match(r.milestone1.refusals.note, /simulation/)
  assert.match(r.milestone1.refusals.note, /no hash and is not counted/)
  assert.match(r.milestone1.checks.note, /No verify-then-pay flow yet/)
  assert.match(r.milestone2.externalTeamsLive.note, /only after its wallet has paid/)
})

test('every curated entry carries what its kind needs, so the lists can fill without the report lying', () => {
  // Passes on the empty lists of 2026-10-19 and guards the day they fill: a partner with no
  // wallet, a vault with no deploy hash or a refusal with neither a hash nor an audit link
  // would count toward a metric while giving a reviewer nothing to open.
  const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a)
  const isHash = (h: string) => /^0x[0-9a-fA-F]{64}$/.test(h)
  for (const p of ARC_PARTNERS) {
    assert.ok(isAddress(p.wallet), `partner ${p.team} has no wallet address`)
    assert.ok(p.team.trim().length > 0, `partner ${p.wallet} has no team name`)
  }
  for (const v of ARC_OWNER_HELD_VAULTS) {
    assert.ok(isAddress(v.address) && isAddress(v.owner), `vault ${v.address} needs an address and an owner`)
    assert.ok(v.ownerKind === 'team' || v.ownerKind === 'external', `vault ${v.address} does not say whether its owner is team or external`)
    assert.ok(isHash(v.deployTx), `vault ${v.address} has no deploy hash`)
    assert.match(v.deployedAt, /^\d{4}-\d{2}-\d{2}$/)
  }
  for (const r of ARC_REFUSALS) {
    if (r.kind === 'vault-policy-on-chain') assert.ok(r.txHash && isHash(r.txHash), 'an on-chain refusal needs its reverted transaction')
    else assert.ok(r.evidenceUrl?.startsWith('https://'), 'a DENY before signing needs an audit entry anyone can open')
    assert.ok(Number.isFinite(Date.parse(r.at)), `refusal at ${r.at} is not a timestamp`)
  }
  for (const f of ARC_VERIFY_THEN_PAY_FLOWS) {
    assert.ok(isHash(f.checkNonce), `flow at ${f.at} does not name its check's settlement nonce`)
    assert.ok(isAddress(f.payee), `flow at ${f.at} does not name the payee it checked`)
    if (f.outcome === 'paid') assert.ok(f.txHash && isHash(f.txHash), 'a paid flow needs the vault Paid transaction')
    else
      assert.ok(
        (f.txHash && isHash(f.txHash)) || f.evidenceUrl?.startsWith('https://'),
        'a refused flow needs its reverted transaction or an audit entry anyone can open',
      )
    assert.ok(Number.isFinite(Date.parse(f.at)), `flow at ${f.at} is not a timestamp`)
  }
  // The targets are Circle's revision of Deliverable 1, pinned so a later edit is a decision.
  assert.deepEqual(ARC_SEASON_TARGETS, {
    ownerHeldVaults: 5,
    gatewayChecks: 100,
    inspectableRefusals: 2,
    externalTeamsLive: 2,
    externalChecks: 30,
    teamsActiveOnSeveralDays: 1,
    publicReferences: 1,
    activeExternalWallets: 5,
    activeWindowDays: 28,
  })
})

test('the after-program reference counts external wallets with a check inside the last 28 days', async () => {
  const r = await arcSeasonReport(
    deps({
      gateway: [
        gw({ payer: EXT_A, ts: new Date(NOW - 3 * DAY).toISOString() }),
        gw({ payer: EXT_B, ts: new Date(NOW - 30 * DAY).toISOString() }),
        gw({ payer: OURS_GATEWAY, ts: new Date(NOW - 1 * DAY).toISOString() }),
      ],
    }),
  )
  const after = r.afterProgram.activeExternalWallets
  assert.deepEqual([after.count, after.wallets], [1, [lower(EXT_A)]])
  assert.equal(after.since, new Date(NOW - 28 * DAY).toISOString())
  // Outside the window the wallet is still an external payer, just not an active one.
  assert.equal(r.usage.external.wallets.length, 2)
})

test('an unreadable facilitator log is reported as unreadable rather than as zero demand', async () => {
  const d = deps({ gateway: [gw({ payer: EXT_A })] })
  d.facilitatorRows = async () => {
    throw new Error('postgres unreachable')
  }
  const r = await arcSeasonReport(d)
  assert.deepEqual(r.logs.facilitator, { readable: false, rows: 0, reason: 'postgres unreachable' })
  assert.deepEqual(r.logs.gateway, { readable: true, rows: 1 })
  assert.equal(r.usage.external.checks, 1)
})

test("the live deps read both rails' own internal-payer lists, so neither rail's wallets can read as external", () => {
  const env = { X402_GATEWAY_INTERNAL_PAYERS: EXT_A, X402_3009_INTERNAL_PAYERS: EXT_B } as NodeJS.ProcessEnv
  const d = liveArcSeasonDeps(env)
  assert.deepEqual(d.internalPayers.gateway, gatewayInternalPayers(env))
  assert.deepEqual(d.internalPayers.facilitator, facilitatorInternalPayers(env))
  assert.ok(d.internalPayers.gateway.includes(lower(EXT_A)))
  assert.ok(d.internalPayers.facilitator.includes(lower(EXT_B)))
  // The hardcoded wallets of both rails are in, with or without the env additions.
  const bare = liveArcSeasonDeps({} as NodeJS.ProcessEnv)
  assert.ok(bare.internalPayers.gateway.length >= 1 && bare.internalPayers.facilitator.length >= 1)
})

test('flows the server recorded count like curated ones, once per check nonce, with the curated entry first', async () => {
  const paid = gw({ payer: OURS_GATEWAY })
  const denied = gw({ payer: OURS_GATEWAY })
  const curated = flow({ checkNonce: paid.authNonce, note: 'curated by hand' })
  const recorded = [
    flow({ checkNonce: shouty(paid.authNonce), note: 'recorded by the server', payer: OURS_GATEWAY }),
    flow({ checkNonce: denied.authNonce, outcome: 'refused', txHash: undefined, evidenceUrl: `https://a-identity.xyz/api/x402/gateway/flows/${denied.authNonce}`, payer: OURS_GATEWAY }),
    // A recorded flow whose check is not one of ours counts nothing, as a curated one would.
    flow({ checkNonce: nextNonce(), payer: OURS_GATEWAY }),
  ]
  const r = await arcSeasonReport(deps({ gateway: [paid, denied], flows: [curated], flowRows: async () => recorded }))
  const c = r.milestone1.checks
  assert.deepEqual([c.count, c.linked], [2, { paid: 1, refused: 1 }])
  assert.equal(c.items[0].note, 'curated by hand')
  assert.equal(c.items[1].evidenceUrl, `https://a-identity.xyz/api/x402/gateway/flows/${denied.authNonce}`)
  assert.deepEqual(r.logs.flows, { readable: true, rows: 3 })
  assert.deepEqual(mergeFlows([curated], recorded).map((f) => f.note), ['curated by hand', recorded[1].note, recorded[2].note])
})

test('an unreadable flow log is reported as unreadable, and the count says what it is missing instead of reading zero', async () => {
  const paid = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(
    deps({
      gateway: [paid],
      flows: [flow({ checkNonce: paid.authNonce })],
      flowRows: async () => {
        throw new Error('vtp_flows unreachable')
      },
    }),
  )
  assert.deepEqual(r.logs.flows, { readable: false, rows: 0, reason: 'vtp_flows unreachable' })
  assert.equal(r.milestone1.checks.count, 1, 'the curated list still counts')
  assert.match(r.milestone1.checks.note, /^The verify-then-pay flow log could not be read on this request \(vtp_flows unreachable\)/)
  // Without a loader wired, there is no flow log to report on at all.
  assert.equal((await arcSeasonReport(deps())).logs.flows, undefined)
})

test('one payment transaction links one flow, whatever its case and whichever list it came from', async () => {
  const first = gw({ payer: OURS_GATEWAY })
  const second = gw({ payer: OURS_GATEWAY })
  const third = gw({ payer: OURS_GATEWAY })
  const tx = '0x' + 'ab'.repeat(32)
  const r = await arcSeasonReport(
    deps({
      gateway: [first, second, third],
      flows: [flow({ checkNonce: first.authNonce, txHash: tx, note: 'curated' })],
      flowRows: async () => [
        flow({ checkNonce: second.authNonce, txHash: '0x' + 'AB'.repeat(32), note: 'the same payment under another check' }),
        flow({ checkNonce: third.authNonce, note: 'a payment of its own' }),
      ],
    }),
  )
  const c = r.milestone1.checks
  assert.deepEqual(c.items.map((f) => f.note), ['curated', 'a payment of its own'])
  assert.deepEqual([c.count, c.linked.paid, c.unlinked], [2, 2, 1])

  // A flow that did not link holds no transaction: the next one with that hash can still count.
  const early = gw({ payer: OURS_GATEWAY, ts: '2026-11-01T11:00:00Z' })
  const later = await arcSeasonReport(
    deps({
      gateway: [early, first],
      flowRows: async () => [flow({ checkNonce: early.authNonce, txHash: tx, at: '2026-11-01T10:00:00Z', note: 'before its check' }), flow({ checkNonce: first.authNonce, txHash: tx, note: 'after its check' })],
    }),
  )
  assert.deepEqual(later.milestone1.checks.items.map((f) => f.note), ['after its check'])
})

test('one malformed flow row is skipped and named in logs.flows, and the rest still count', async () => {
  const check = gw({ payer: OURS_GATEWAY })
  const nonce = check.authNonce
  const good = {
    flowId: nonce,
    network: arc.caip2,
    payee: CHECKED_PAYEE,
    amount: '10000',
    createdAt: '2026-11-01T10:00:01.000Z',
    outcome: 'blocked',
    detail: 'deny',
    verdict: { decision: 'DENY' },
    check: { payer: OURS_GATEWAY, gatewayOutcome: 'credited', checkedAt: '2026-11-01T09:59:00.000Z' },
  } as unknown as VtpFlowRecord
  const bad = [{ ...good, flowId: '0x' + 'ee'.repeat(32), amount: 'twelve' }, { ...good, flowId: '0x' + 'dd'.repeat(32), check: undefined }, { outcome: 'blocked' }, null] as unknown as VtpFlowRecord[]

  const seen: unknown[] = []
  assert.equal(seasonFlowsFromRows([bad[0], good, bad[1], bad[2], bad[3]], (row) => seen.push(row)).length, 1)
  assert.equal(seen.length, 4)
  assert.deepEqual((seen[0] as { flowId: unknown }).flowId, bad[0].flowId)
  assert.deepEqual((seen[2] as { flowId: unknown }).flowId, null)

  const r = await arcSeasonReport(deps({ gateway: [check], flowRows: async (onSkip) => seasonFlowsFromRows([bad[0], good], onSkip) }))
  assert.equal(r.milestone1.checks.count, 1, 'the bad row hides nothing')
  assert.equal(r.logs.flows?.readable, true)
  assert.equal(r.logs.flows?.rows, 1)
  assert.equal(r.logs.flows?.skipped?.length, 1)
  assert.equal(r.logs.flows?.skipped?.[0].flowId, bad[0].flowId)
  assert.match(r.logs.flows?.skipped?.[0].reason ?? '', /twelve/)
  assert.match(r.milestone1.checks.note, /1 verify-then-pay flow row\(s\) could not be read and are not counted/)

  // Nothing skipped, nothing said.
  const clean = await arcSeasonReport(deps({ gateway: [check], flowRows: async (onSkip) => seasonFlowsFromRows([good], onSkip) }))
  assert.deepEqual(clean.logs.flows, { readable: true, rows: 1 })
  assert.doesNotMatch(clean.milestone1.checks.note, /could not be read/)
})

test("a flow that names its payer links only to that payer's check, because a nonce is unique per payer", async () => {
  const check = gw({ payer: OURS_GATEWAY })
  const other = await arcSeasonReport(deps({ gateway: [check], flowRows: async () => [flow({ checkNonce: check.authNonce, payer: OURS_FACILITATOR })] }))
  assert.equal(other.milestone1.checks.count, 0)
  const same = await arcSeasonReport(deps({ gateway: [check], flowRows: async () => [flow({ checkNonce: check.authNonce, payer: shouty(OURS_GATEWAY) })] }))
  assert.equal(same.milestone1.checks.count, 1)
})

test('the live deps read the verify-then-pay flow log, mapped to season flows', async () => {
  const d = liveArcSeasonDeps({} as NodeJS.ProcessEnv)
  assert.equal(typeof d.flowRows, 'function')
  assert.ok(Array.isArray(await d.flowRows!()))
})

test('an unreadable Gateway log is reported as unreadable, and Milestone 1 says so instead of reading zero checks', async () => {
  const d = deps({ flowRows: async () => [flow({ payer: OURS_GATEWAY })] })
  d.gatewayRows = async () => {
    throw new Error('postgres unreachable')
  }
  const r = await arcSeasonReport(d)
  assert.deepEqual(r.logs.gateway, { readable: false, rows: 0, reason: 'postgres unreachable' })
  assert.equal(r.milestone1.checks.count, 0)
  assert.match(r.milestone1.checks.note, /^The Circle Gateway settlement log could not be read on this request \(postgres unreachable\), so no check, and no flow linked to one, is counted/)
  // The live deps read it through the loader that tells the two apart.
  assert.ok(Array.isArray(await liveArcSeasonDeps({} as NodeJS.ProcessEnv).gatewayRows()))
})

test("a recorded flow whose check aged out of a full Gateway log links by its own record's settlement, and only then", async () => {
  // The log keeps its newest three rows here; the flow's check is older than all of them.
  const kept = [0, 1, 2].map((i) => gw({ payer: OURS_GATEWAY, ts: `2026-11-01T10:0${i}:00Z` }))
  const echo = { network: arc.caip2, payer: lower(OURS_GATEWAY), outcome: 'credited', ts: '2026-11-01T09:00:00Z' }
  const old = flow({ payer: OURS_GATEWAY, at: '2026-11-01T09:00:07Z', check: echo })
  const r = await arcSeasonReport(deps({ gateway: kept, gatewayCap: 3, flowRows: async () => [old] }))
  const c = r.milestone1.checks
  assert.deepEqual([c.count, c.agedOut, c.internal, c.unlinked], [1, 1, 3, 3])
  assert.match(c.note, /1 of the flows link by the settlement their own flow record holds: the Gateway log keeps its newest 3 rows/)

  // Every other case links nothing: a log that is not full, a check newer than the oldest row
  // kept (its row should be there), a payer that is not ours, another network, an unsettled
  // check, an outcome before the check, and a log that cannot be read.
  const none = async (over: Parameters<typeof deps>[0], f = old) => (await arcSeasonReport(deps({ gateway: kept, gatewayCap: 3, flowRows: async () => [f], ...over }))).milestone1.checks.count
  assert.equal(await none({ gatewayCap: 4 }), 0, 'the log is not full, so nothing aged out of it')
  assert.equal(await none({}, flow({ payer: OURS_GATEWAY, at: '2026-11-01T10:05:00Z', check: { ...echo, ts: '2026-11-01T10:01:30Z' } })), 0)
  assert.equal(await none({}, flow({ payer: EXT_A, at: '2026-11-01T09:00:07Z', check: { ...echo, payer: lower(EXT_A) } })), 0)
  assert.equal(await none({}, flow({ payer: OURS_GATEWAY, at: '2026-11-01T09:00:07Z', check: { ...echo, network: base.caip2 } })), 0)
  assert.equal(await none({}, flow({ payer: OURS_GATEWAY, at: '2026-11-01T09:00:07Z', check: { ...echo, outcome: 'failed' } })), 0)
  assert.equal(await none({}, flow({ payer: OURS_GATEWAY, at: '2026-11-01T08:59:00Z', check: echo })), 0)
  const dark = deps({ gatewayCap: 3, flowRows: async () => [old] })
  dark.gatewayRows = async () => {
    throw new Error('postgres unreachable')
  }
  assert.equal((await arcSeasonReport(dark)).milestone1.checks.count, 0)
})
