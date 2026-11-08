import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ARC_OUR_PAYEES,
  arcSeasonReport,
  liveArcSeasonDeps,
  ARC_PARTNERS,
  ARC_OWNER_HELD_VAULTS,
  ARC_REFUSALS,
  ARC_VERIFY_THEN_PAY_FLOWS,
  ARC_SEASON_TARGETS,
  mergeFlows,
  mergeVaults,
  flowKeysFromRows,
  labelOwners,
  liveFlowRows,
  seasonFlowsFromRows,
  type ArcFlowKeys,
  type ArcSeasonDeps,
  type ArcSeasonSkippedRow,
  type ArcOwnerHeldVault,
  type ArcVerifyThenPayFlow,
} from './arc-season.js'
import { REVOKED_KEY_EXPIRY, committedOurKeys, stateChecks, stateNotes, type VaultState } from './arc-owner-vault.js'
import { getChainById } from './chains/index.js'
import { PROVENANCE } from './chains/provenance.js'
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
    measuredThrough: '2026-11-13',
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

test('a wallet nobody attributed counts as an external check, wallet and flow and toward no team metric, and the note says exactly that', async () => {
  const first = gw({ payer: EXT_B, ts: '2026-10-05T10:00:00Z' })
  const r = await arcSeasonReport(
    deps({
      partners: [{ wallet: EXT_A, team: 'Team A', publicReference: true }],
      gateway: [gw({ payer: EXT_A, ts: '2026-10-05T11:00:00Z' }), first, gw({ payer: EXT_B, ts: '2026-10-12T10:00:00Z' })],
      flows: [flow({ checkNonce: first.authNonce, payer: EXT_B, at: '2026-10-05T10:00:09Z' })],
    }),
  )
  const unattributed = lower(EXT_B)
  const m2 = r.milestone2
  assert.match(m2.unattributed.note, /^1 external wallet\(s\) paid 2 check\(s\) without being attributed to a team\. They count as external checks, external wallets and external flows, and toward no team metric\.$/)
  // The first half of the sentence, on every number it names.
  assert.equal(m2.externalChecks.count, 3)
  assert.ok(r.usage.external.wallets.includes(unattributed))
  assert.ok(r.afterProgram.activeExternalWallets.wallets.includes(unattributed))
  assert.ok(r.afterProgram.weekly.weeks.some((w) => w.activeWallets.includes(unattributed)))
  assert.equal(m2.externalFlows.count, 1)
  // And the second: paying in two weeks, on two days, makes no team of it.
  assert.deepEqual(r.afterProgram.weekly.repeatWallets, [unattributed])
  assert.deepEqual(r.afterProgram.weekly.repeatTeams, [])
  assert.deepEqual(m2.externalTeamsLive.teams.map((t) => t.team), ['Team A'])
  assert.deepEqual(m2.teamActiveOnSeveralDays.teams, [])
  assert.deepEqual(m2.publicReference.names, ['Team A'])
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
  // A reviewer who checks that wallet again sees WARN, and the report says why before they ask.
  assert.match(r.milestone1.refusals.note, /correct under the rule of its day/)
  assert.match(r.milestone1.refusals.note, /changed on 2026-11-04/)
  assert.match(r.milestone1.refusals.note, /sees WARN/)
  // It names the wallet and how many, because "that wallet" alone points at nothing.
  const payee = denyFlow(check.authNonce).payee.toLowerCase()
  assert.ok(r.milestone1.refusals.note.includes(`1 recorded DENY result(s), dated before 2026-11-04, name ${payee}`), r.milestone1.refusals.note)
})

test('the old-rule note is only about DENYs answered under the old rule', async () => {
  const check = gw({ payer: OURS_GATEWAY, ts: '2026-11-04T12:00:00.000Z' })
  const after = await arcSeasonReport(deps({ gateway: [check], flows: [denyFlow(check.authNonce, { at: '2026-11-04T12:00:05.000Z' })], now: () => Date.parse('2026-11-05T00:00:00.000Z') }))
  assert.equal(after.milestone1.refusals.byKind['deny-before-signing'], 1, 'it counts like any other')
  assert.doesNotMatch(after.milestone1.refusals.note, /rule of its day|sees WARN/)

  // A DENY on an agent of ours with a platform record was not the old rule's doing, and a re-check gives DENY.
  const early = gw({ payer: OURS_GATEWAY })
  const own = await arcSeasonReport(deps({ gateway: [early], flows: [denyFlow(early.authNonce, { payee: ARC_OUR_PAYEES[0].address })] }))
  assert.equal(own.milestone1.refusals.byKind['deny-before-signing'], 1)
  assert.doesNotMatch(own.milestone1.refusals.note, /rule of its day|sees WARN/)
})

test('only a linked refusal counts: not a paid flow, and not a revert or a DENY on a nonce that names nothing', async () => {
  const paid = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(
    deps({
      gateway: [paid],
      refusals: [],
      flows: [flow({ checkNonce: paid.authNonce }), flow({ checkNonce: nextNonce(), outcome: 'refused', txHash: '0x' + '44'.repeat(32) }), denyFlow(nextNonce())],
    }),
  )
  assert.equal(r.milestone1.checks.count, 1)
  assert.equal(r.milestone1.refusals.count, 0)
  assert.match(r.milestone1.refusals.note, /^No inspectable refusal yet/)
})

test('a recorded policy revert is an inspectable refusal of the on-chain kind, once, beside a curated entry for the same hash', async () => {
  const reverted = gw({ payer: OURS_GATEWAY })
  const tx = '0x' + '4a'.repeat(32)
  const revert = flow({ checkNonce: reverted.authNonce, outcome: 'refused', txHash: tx, note: "the vault's policy reverted the prepared pay on chain (AboveAutoApprove)" })
  const r = await arcSeasonReport(deps({ gateway: [reverted], refusals: [], flows: [revert] }))
  assert.deepEqual(r.milestone1.checks.linked, { paid: 0, refused: 1 })
  assert.equal(r.milestone1.refusals.count, 1)
  assert.deepEqual(r.milestone1.refusals.byKind, { 'vault-policy-on-chain': 1, 'deny-before-signing': 0 })
  const [item] = r.milestone1.refusals.items
  assert.deepEqual([item.kind, item.txHash, item.explorerUrl, item.note], ['vault-policy-on-chain', tx, txUrl(arc, tx), revert.note])
  assert.match(r.milestone1.refusals.note, /^1 of the 2 kinds committed to: 1 vault-policy refusal\(s\) on chain and 0 DENY/)
  assert.doesNotMatch(r.milestone1.refusals.note, /No inspectable refusal yet/)

  // The same hash curated by hand, whatever its case, is the same refusal.
  const curated = { kind: 'vault-policy-on-chain' as const, txHash: '0x' + '4A'.repeat(32), at: '2026-11-01T10:00:00Z', note: 'curated' }
  const same = await arcSeasonReport(deps({ gateway: [reverted], refusals: [curated], flows: [revert] }))
  assert.equal(same.milestone1.refusals.byKind['vault-policy-on-chain'], 1)
  assert.deepEqual(same.milestone1.refusals.items.map((i) => i.note), ['curated'])

  // Another hash is another refusal, and it is still one kind of two.
  const other = await arcSeasonReport(deps({ gateway: [reverted], refusals: [{ ...curated, txHash: '0x' + '4b'.repeat(32) }], flows: [revert] }))
  assert.equal(other.milestone1.refusals.byKind['vault-policy-on-chain'], 2)
  assert.equal(other.milestone1.refusals.count, 1)

  // With a recorded DENY beside it both kinds are shown, from the log alone.
  const denied = gw({ payer: OURS_GATEWAY })
  const both = await arcSeasonReport(deps({ gateway: [reverted, denied], refusals: [], flows: [revert, denyFlow(denied.authNonce)] }))
  assert.equal(both.milestone1.refusals.count, 2)

  // A reference that is not a hash gives a reviewer nothing to open on chain, so it is not this kind.
  const notAHash = await arcSeasonReport(deps({ gateway: [reverted], refusals: [], flows: [{ ...revert, txHash: 'not-a-hash', evidenceUrl: 'https://a-identity.xyz/flows/x' }] }))
  assert.equal(notAHash.milestone1.refusals.byKind['vault-policy-on-chain'], 0)

  // On a payer that is not ours it is Milestone 2's.
  const external = gw({ payer: EXT_A })
  const theirs = await arcSeasonReport(deps({ gateway: [external], refusals: [], flows: [flow({ checkNonce: external.authNonce, outcome: 'refused', txHash: tx })] }))
  assert.equal(theirs.milestone1.refusals.count, 0)
  assert.equal(theirs.milestone2.externalFlows.linked.refused, 1)

  // A long run is counted and not all listed, as the DENYs are.
  const many = Array.from({ length: 7 }, () => gw({ payer: OURS_GATEWAY }))
  const run = await arcSeasonReport(deps({ gateway: many, refusals: [], flows: many.map((c) => flow({ checkNonce: c.authNonce, outcome: 'refused' })) }))
  assert.equal(run.milestone1.refusals.byKind['vault-policy-on-chain'], 7)
  assert.equal(run.milestone1.refusals.items.length, 5)
  assert.match(run.milestone1.refusals.note, /2 more recorded revert\(s\) are on checks\.items/)
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
  assert.match(c.note, /4 of the flows name a payee that is ours/)
  assert.match(c.note, /5 distinct payee/)
  assert.ok(r.milestone1.refusals.items[0].payeeInternal, 'the refusal that came from it says so too')
  assert.equal(r.milestone1.refusals.items[4].payeeInternal, undefined)
})

test('a paid flow to our own agent is labeled ours, so no paid flow reads as a payment to someone else', async () => {
  const meridian = ARC_OUR_PAYEES[0].address
  const paid = gw({ payer: OURS_GATEWAY })
  const refused = gw({ payer: OURS_GATEWAY })
  const keys = { owner: OUR_VAULT_OWNER, operator: OPERATOR_KEY }
  const r = await arcSeasonReport(
    deps({ gateway: [paid, refused], refusals: [], flows: [flow({ checkNonce: paid.authNonce, payee: meridian.toLowerCase(), vaultKeys: keys }), denyFlow(refused.authNonce, { payee: OUR_VAULT_OWNER, vaultKeys: keys })] }),
  )
  const c = r.milestone1.checks
  assert.equal(c.internalPayee, 2)
  const item = c.items.find((i) => i.outcome === 'paid') as { payeeInternal?: string }
  assert.match(item.payeeInternal ?? '', /Meridian, our own showcase agent/)
  // Simon, the ALLOW payee since 2026-11-02, is listed the same way.
  assert.ok(ARC_OUR_PAYEES.some((p) => p.address.toLowerCase() === '0x03f1fb189e461b88f3e8ba7100b29b594e5f98a9' && /Simon/.test(p.why)))
  assert.match(c.note, /2 of the flows name a payee that is ours.*That is every flow\./)
  // A payee nobody listed stays unlabeled, and the note does not claim every flow.
  const stranger = gw({ payer: OURS_GATEWAY })
  const r2 = await arcSeasonReport(deps({ gateway: [paid, stranger], refusals: [], flows: [flow({ checkNonce: paid.authNonce, payee: meridian, vaultKeys: keys }), flow({ checkNonce: stranger.authNonce, vaultKeys: keys })] }))
  assert.equal(r2.milestone1.checks.internalPayee, 1)
  assert.doesNotMatch(r2.milestone1.checks.note, /That is every flow/)
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

const vaultEntry = (address: string, over: Partial<ArcOwnerHeldVault> = {}): ArcOwnerHeldVault => ({
  address,
  owner: EXT_B,
  ownerKind: 'unstated',
  deployTx: '0x' + address.slice(2, 42).padEnd(64, '0'),
  deployBlock: '100',
  deployedAt: '2026-11-03',
  note: 'admitted',
  ...over,
})

test('Milestone 1 vaults are the curated list plus the admitted ones, one per address whatever its case, the curated entry first', async () => {
  const curated = vaultEntry(EXT_A, { ownerKind: 'team', note: 'curated' })
  const sameVault = vaultEntry(shouty(EXT_A), { note: 'admitted later' })
  const another = vaultEntry(EXT_C)
  assert.deepEqual(mergeVaults([curated], [sameVault, another, another]).map((v) => v.note), ['curated', 'admitted'])
  const r = await arcSeasonReport(deps({ vaults: [curated], admittedVaults: async () => [sameVault, another] }))
  const v = r.milestone1.vaults
  assert.equal(v.count, 2)
  assert.deepEqual(v.items.map((i) => [i.address, i.ownerKind]), [[EXT_A, 'team'], [EXT_C, 'unstated']])
  assert.match(v.note, /1 of them were admitted automatically.*owner not identified/)
  assert.deepEqual(r.logs.admittedVaults, { readable: true, rows: 2 })
})

test('an unreadable list of admitted vaults is said plainly and counts the curated list alone, never zero or a guess', async () => {
  const r = await arcSeasonReport(
    deps({
      vaults: [vaultEntry(EXT_A, { ownerKind: 'external' })],
      admittedVaults: async () => {
        throw new Error('db down')
      },
    }),
  )
  assert.equal(r.milestone1.vaults.count, 1)
  assert.equal(r.logs.admittedVaults?.readable, false)
  assert.match(r.milestone1.vaults.note, /admitted vaults could not be read on this request, so any vault it holds is missing/)
  assert.equal(r.milestone1.vaults.incomplete, true)
  assert.ok(!JSON.stringify(r).includes('db down'))
  const none = await arcSeasonReport(deps({ admittedVaults: async () => { throw new Error('db down') } }))
  assert.equal(none.milestone1.vaults.count, 0)
  assert.match(none.milestone1.vaults.note, /could not be read/)
  assert.doesNotMatch(none.milestone1.vaults.note, /No owner-held vault yet/)
})

test('a stored row the loader will not count is named and not counted', async () => {
  const r = await arcSeasonReport(
    deps({
      admittedVaults: async (onSkip) => {
        onSkip?.({ vault: EXT_C, reason: 'its owner is one of our keys' })
        return [vaultEntry(EXT_A)]
      },
    }),
  )
  assert.equal(r.milestone1.vaults.count, 1)
  assert.deepEqual(r.logs.admittedVaults?.skipped, [{ vault: EXT_C, reason: 'its owner is one of our keys' }])
  assert.match(r.milestone1.vaults.note, /1 admitted vault row\(s\) are not counted/)
})

test("each vault carries its owner's actions with registry links, and how far the chain was read", async () => {
  const freeze = '0x' + '31'.repeat(32)
  const out = '0x' + '32'.repeat(32)
  const asked: string[] = []
  const r = await arcSeasonReport(
    deps({
      vaults: [vaultEntry(EXT_A)],
      admittedVaults: async () => [vaultEntry(EXT_C)],
      ownerActions: async (vaults) => {
        asked.push(...vaults.map((v) => v.address))
        return new Map([
          [lower(EXT_A), { freezeTxs: [{ txHash: freeze, block: '200' }], withdrawTxs: [{ txHash: out, block: '300' }], read: { state: 'complete' as const, scannedToBlock: '400' } }],
          [lower(EXT_C), { freezeTxs: [], withdrawTxs: [], read: { state: 'reading' as const, scannedToBlock: '150' } }],
        ])
      },
    }),
  )
  assert.deepEqual(asked, [EXT_A, EXT_C], 'every counted vault is read, curated and admitted')
  const [a, c] = r.milestone1.vaults.items
  assert.deepEqual(a.freezeTxs, [{ txHash: freeze, block: '200', explorerUrl: txUrl(arc, freeze) }])
  assert.deepEqual(a.withdrawTxs, [{ txHash: out, block: '300', explorerUrl: txUrl(arc, out) }])
  assert.equal(a.actionsRead.state, 'complete')
  assert.deepEqual(c.freezeTxs, [])
  assert.equal(c.actionsRead.state, 'reading')
  assert.deepEqual(r.milestone1.vaults.ownerActions, { freezes: 1, withdrawals: 1, vaultsNotFullyRead: 1 })
  assert.match(r.milestone1.vaults.note, /signed 1 freeze\(s\) and 1 withdrawal\(s\)/)
  assert.match(r.milestone1.vaults.note, /1 vault\(s\) are not fully read yet/)
})

test('the line beside the vault count says so far while a vault is not fully read, and only then', async () => {
  const reading = await arcSeasonReport(deps({ vaults: [vaultEntry(EXT_A)], ownerActions: async () => new Map([[lower(EXT_A), { freezeTxs: [], withdrawTxs: [], read: { state: 'reading' as const, scannedToBlock: '150' } }]]) }))
  assert.deepEqual(reading.milestone1.vaults.ownerActions, { freezes: 0, withdrawals: 0, vaultsNotFullyRead: 1 })
  const page = readFileSync(new URL('../../src/components/proof/ArcSeasonProgress.tsx', import.meta.url), 'utf8')
  assert.match(page, /signed by an owner wallet\$\{a\.vaultsNotFullyRead \? ' so far' : ''\}`/)
  assert.match(page, /detail=\{ownerActionsLine\(m1\.vaults\.ownerActions\)\}/, 'the payload carries it, and the row hands it over')
})

test('owner actions that cannot be read are said plainly on every vault and publish nothing; the vaults still count', async () => {
  const failing = await arcSeasonReport(
    deps({
      vaults: [vaultEntry(EXT_A)],
      ownerActions: async () => {
        throw new Error('no host answered')
      },
    }),
  )
  assert.equal(failing.milestone1.vaults.count, 1)
  const item = failing.milestone1.vaults.items[0]
  assert.deepEqual(item.freezeTxs, [])
  assert.deepEqual(item.withdrawTxs, [])
  assert.deepEqual(item.actionsRead, { state: 'unreadable', scannedToBlock: null, reason: 'no host answered' })
  assert.equal(failing.milestone1.vaults.ownerActions.vaultsNotFullyRead, 1)
  // With no reader wired, or no answer for the vault, a vault does not read as having done nothing.
  const unwired = await arcSeasonReport(deps({ vaults: [vaultEntry(EXT_A)] }))
  assert.equal(unwired.milestone1.vaults.items[0].actionsRead.state, 'unreadable')
  const silent = await arcSeasonReport(deps({ vaults: [vaultEntry(EXT_A)], ownerActions: async () => new Map() }))
  assert.equal(silent.milestone1.vaults.items[0].actionsRead.state, 'unreadable')
})

test('with no vault, no chain is read for owner actions', async () => {
  let called = false
  const r = await arcSeasonReport(
    deps({
      ownerActions: async () => {
        called = true
        return new Map()
      },
    }),
  )
  assert.equal(called, false)
  assert.deepEqual(r.milestone1.vaults.ownerActions, { freezes: 0, withdrawals: 0, vaultsNotFullyRead: 0 })
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
  assert.deepEqual(r.logs.facilitator, { readable: false, rows: 0, reason: 'the log did not answer on this request' })
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

test("what the repo calls ours is ours here too: its own agents, the committed list, and a key the launch-day vault rotated to", async () => {
  // Our own agents, whatever a caller wires.
  for (const { address } of ARC_OUR_PAYEES) {
    const r = await arcSeasonReport(deps({ gateway: [gw({ payer: address })] }))
    assert.deepEqual([r.milestone2.externalChecks.count, r.usage.internal.checks], [0, 1], address)
  }
  // An address the repo commits as ours that no rail lists as a buyer, such as the oracle validator.
  const validator = '0xee602A161232Aac1436E812676b6626382FC84a9'
  const before = await arcSeasonReport(deps({ gateway: [gw({ payer: validator })] }))
  assert.equal(before.milestone2.externalChecks.count, 1, 'not by itself: the list is what says so')
  const after = await arcSeasonReport(deps({ gateway: [gw({ payer: validator })], committedOurs: committedOurKeys() }))
  assert.deepEqual([after.milestone2.externalChecks.count, after.usage.internal.checks], [0, 1])

  // The launch-day vault gets a new agent key and that key pays: our own run, as the note on that vault says.
  const launch = PROVENANCE.find((p) => p.chain === 'arc-mainnet')!.contracts.find((c) => c.name.startsWith('AgentSpendPolicy'))!.address
  const rotated = '0x' + 'f7'.repeat(20)
  const check = gw({ payer: rotated })
  const paid = flow({ checkNonce: check.authNonce, payer: rotated, vault: launch, vaultKeys: { owner: OUR_VAULT_OWNER, operator: rotated } })
  const own = await arcSeasonReport(deps({ gateway: [check], flows: [paid] }))
  assert.deepEqual([own.milestone2.externalChecks.count, own.milestone2.externalFlows.count, own.milestone1.checks.count], [0, 0, 1])
  assert.equal(own.milestone1.checks.byVault['launch-day'], 1)
  // Through the row feed as well, on a row that maps to no flow.
  const waiting = { flowId: check.authNonce, vault: launch.toLowerCase(), owner: OUR_VAULT_OWNER, operator: rotated, payee: EXT_B, amount: '1000', outcome: 'awaiting_human', detail: 'warn_handoff', check: { payer: rotated } } as unknown as VtpFlowRecord
  const viaRow = await arcSeasonReport(deps({ gateway: [check], flowRows: async (onSkip, onKeys) => { for (const k of flowKeysFromRows([waiting])) onKeys?.(k); return seasonFlowsFromRows([waiting], onSkip) } }))
  assert.equal(viaRow.milestone2.externalChecks.count, 0)
  // A key on any other vault is not ours for it: only that vault's address says so.
  const elsewhere = await arcSeasonReport(deps({ gateway: [check], flows: [{ ...paid, vault: EXT_C }] }))
  assert.equal(elsewhere.milestone2.externalChecks.count, 1)

  assert.match(after.usage.basis, /is an address this repo commits as ours \(admission refuses a vault owner from the same addresses, and our own agents are among them\), owns a vault labeled team/)
  assert.match(after.usage.basis, /through such a vault or through the launch-day vault/)
  assert.match(after.usage.basis, /Everything after the rails' lists counts as internal in this report only: the rails' own proof reads the lists alone/)
  assert.doesNotMatch(after.usage.basis, /X402_3009_INTERNAL_PAYERS\) owns/, 'the comma that was missing')
})

test('the live deps read the committed list with no env: a key only the env knows is not on it', () => {
  const key = '0x' + '77'.repeat(32)
  const d = liveArcSeasonDeps({ X402_3009_FUNDER_KEY: key, X402_PAY_TO: EXT_A } as NodeJS.ProcessEnv)
  assert.deepEqual(d.committedOurs, committedOurKeys())
  assert.ok(!d.committedOurs!.includes(lower(EXT_A)), 'an env receiving wallet is not a committed address')
  assert.ok(!d.committedOurs!.includes(lower(privateKeyToAccount(key as `0x${string}`).address)), 'and neither is the address of an env key')
  for (const { address } of ARC_OUR_PAYEES) assert.ok(d.committedOurs!.includes(lower(address)), address)
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
  assert.deepEqual(r.logs.flows, { readable: false, rows: 0, reason: 'the log did not answer on this request' })
  assert.equal(r.milestone1.checks.count, 1, 'the curated list still counts')
  assert.match(r.milestone1.checks.note, /^The verify-then-pay flow log could not be read on this request, so any flow it holds is missing/)
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
  assert.deepEqual(r.logs.gateway, { readable: false, rows: 0, reason: 'the log did not answer on this request' })
  assert.equal(r.milestone1.checks.count, 0)
  assert.match(r.milestone1.checks.note, /^The Circle Gateway settlement log could not be read on this request, so no check, and no flow linked to one, is counted/)
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

test('a whole-second block time does not drop a paid flow mined in the same second as its check, and only that', async () => {
  const check = gw({ payer: OURS_GATEWAY, ts: '2026-11-02T10:00:05.050Z' })
  const counted = async (f: ArcVerifyThenPayFlow, c = check) => (await arcSeasonReport(deps({ gateway: [c], flows: [f] }))).milestone1.checks.count
  // Mined at 05.950, which the block reports as 05.000.
  assert.equal(await counted(flow({ checkNonce: check.authNonce, at: '2026-11-02T10:00:05.000Z' })), 1, 'same second, named by a transaction')
  assert.equal(await counted(flow({ checkNonce: check.authNonce, at: '2026-11-02T10:00:06.000Z' })), 1, 'a later second')
  assert.equal(await counted(flow({ checkNonce: check.authNonce, at: '2026-11-02T10:00:04.000Z' })), 0, 'an earlier block is still before the check')
  // A DENY has no block: its time is the server's own, in milliseconds, and keeps the full comparison.
  assert.equal(await counted(denyFlow(check.authNonce, { at: '2026-11-02T10:00:05.000Z' })), 0, 'a DENY is compared to the millisecond')
  assert.equal(await counted(denyFlow(check.authNonce, { at: '2026-11-02T10:00:05.060Z' })), 1)
})

test('a recorded flow names its record and its vault, whatever its outcome', () => {
  const nonce = '0x' + 'c1'.repeat(32)
  const tx = '0x' + 'c2'.repeat(32)
  const base = {
    flowId: nonce,
    network: arc.caip2,
    vault: EXT_C,
    payee: CHECKED_PAYEE,
    amount: '10000',
    createdAt: '2026-11-01T10:00:01.000Z',
    verdict: { decision: 'ALLOW' },
    check: { payer: OURS_GATEWAY, gatewayOutcome: 'credited', checkedAt: '2026-11-01T09:59:00.000Z' },
  }
  const payment = { status: 'success', txHash: tx, minedAt: '2026-11-01T10:00:02.000Z', blockNumber: '1', readBackFrom: 'rpc.example' }
  const rows = [
    { ...base, outcome: 'executed', detail: 'agent_paid', payment },
    { ...base, outcome: 'blocked', detail: 'reverted_onchain', payment: { ...payment, status: 'reverted', revertReason: 'AboveAutoApprove' } },
    { ...base, outcome: 'blocked', detail: 'deny', verdict: { decision: 'DENY' } },
  ] as unknown as VtpFlowRecord[]
  const flows = seasonFlowsFromRows(rows)
  assert.deepEqual(flows.map((f) => f.outcome), ['paid', 'refused', 'refused'])
  for (const f of flows) {
    assert.equal(f.vault, EXT_C)
    assert.ok(f.recordUrl?.startsWith('https://a-identity.xyz/') && f.recordUrl.endsWith(nonce), f.recordUrl)
  }
})

test('every flow can be traced end to end: its record, the payment, and the batch as the Gateway row now says', async () => {
  const batch = '0x' + 'd1'.repeat(32)
  const landed = gw({ payer: OURS_GATEWAY, outcome: 'completed', tx: batch })
  const waiting = gw({ payer: OURS_GATEWAY })
  const asRecorded = { network: arc.caip2, payer: lower(OURS_GATEWAY), outcome: 'credited', ts: '2026-10-18T10:00:00Z' }
  const recordUrl = 'https://a-identity.xyz/flows/x'
  const r = await arcSeasonReport(
    deps({
      gateway: [landed, waiting],
      flows: [flow({ checkNonce: landed.authNonce, recordUrl, check: asRecorded }), flow({ checkNonce: waiting.authNonce, recordUrl, check: asRecorded })],
    }),
  )
  const [a, b] = r.milestone1.checks.items
  assert.equal(a.recordUrl, recordUrl)
  assert.equal(a.explorerUrl, txUrl(arc, a.txHash!))
  assert.deepEqual(a.checkSettlement, { outcome: 'completed', readFrom: 'gateway-log', batchTx: batch, batchExplorerUrl: txUrl(arc, batch) })
  assert.deepEqual(b.checkSettlement, { outcome: 'credited', readFrom: 'gateway-log' })
  // The record's frozen copy cannot contradict the row: the item does not carry it.
  assert.equal('check' in a, false)
  assert.match(r.milestone1.checks.note, /net position/)

  // A check whose row aged out says that it is the record's word, and gets no batch.
  const kept = [0, 1, 2].map((i) => gw({ payer: OURS_GATEWAY, ts: `2026-11-01T10:0${i}:00Z` }))
  const old = flow({ payer: OURS_GATEWAY, at: '2026-11-01T09:00:07Z', check: { ...asRecorded, ts: '2026-11-01T09:00:00Z' } })
  const aged = await arcSeasonReport(deps({ gateway: kept, gatewayCap: 3, flowRows: async () => [old] }))
  assert.deepEqual(aged.milestone1.checks.items[0].checkSettlement, { outcome: 'credited', readFrom: 'flow-record' })
})

test('the report says which vault the flows ran through, and that they are our own runs and not external use', async () => {
  const launch = PROVENANCE.find((p) => p.chain === 'arc-mainnet')!.contracts.find((c) => c.name.startsWith('AgentSpendPolicy'))!.address
  const held = '0x' + 'e1'.repeat(20)
  const [c1, c2, c3, c4] = [0, 1, 2, 3].map(() => gw({ payer: OURS_GATEWAY }))
  const r = await arcSeasonReport(
    deps({
      gateway: [c1, c2, c3, c4],
      vaults: [vaultEntry(held)],
      flows: [
        flow({ checkNonce: c1.authNonce, vault: launch }),
        flow({ checkNonce: c2.authNonce, vault: shouty(held) }),
        flow({ checkNonce: c3.authNonce, vault: EXT_C }),
        flow({ checkNonce: c4.authNonce }),
      ],
    }),
  )
  const c = r.milestone1.checks
  assert.deepEqual(c.byVault, { 'launch-day': 1, 'owner-held': 1, other: 1, 'not-recorded': 1 })
  assert.deepEqual(c.items.map((f) => f.vaultKind), ['launch-day', 'owner-held', 'other', 'not-recorded'])
  assert.match(c.note, /1 of the flows ran through the launch-day vault/)
  assert.match(c.note, /1 through an owner-held vault counted in the row above; 2 through another vault or with no vault on record/)
  assert.doesNotMatch(c.note, /separate measures/)
  assert.match(c.note, /Circle's intro to this program asks for external use, and these 4 flows are not that: they are our own runs/)

  // Every flow on our own vault, as today: said outright, next to a card that also counts vaults.
  const own = await arcSeasonReport(deps({ gateway: [c1], flows: [flow({ checkNonce: c1.authNonce, vault: launch })] }))
  assert.match(own.milestone1.checks.note, /separate measures: none of these payments came from an owner's vault/)
  // No flow, no claim about flows.
  assert.doesNotMatch((await arcSeasonReport(deps({ gateway: [c1] }))).milestone1.checks.note, /Circle's intro/)

  // "None came from an owner's vault" is a claim about every flow, so one the report cannot place
  // takes the sentence away, whether or not the list of admitted vaults answered.
  const stranger = '0x' + 'e7'.repeat(20)
  const listDown = async () => {
    throw new Error('db down')
  }
  const unplaced = await arcSeasonReport(deps({ gateway: [c1], flows: [flow({ checkNonce: c1.authNonce, vault: stranger })], admittedVaults: listDown }))
  assert.deepEqual(unplaced.milestone1.checks.byVault, { 'launch-day': 0, 'owner-held': 0, other: 1, 'not-recorded': 0 })
  assert.equal(unplaced.logs.admittedVaults?.readable, false)
  assert.doesNotMatch(unplaced.milestone1.checks.note, /none of these payments/)
  assert.match(unplaced.milestone1.checks.note, /list of admitted vaults could not be read on this request, so a flow through another vault could still be through an owner's/)

  const notYetAdmitted = await arcSeasonReport(deps({ gateway: [c1], flows: [flow({ checkNonce: c1.authNonce, vault: stranger })], admittedVaults: async () => [] }))
  assert.doesNotMatch(notYetAdmitted.milestone1.checks.note, /none of these payments/)
  assert.doesNotMatch(notYetAdmitted.milestone1.checks.note, /could still be through an owner's/)

  const noVaultOnRecord = await arcSeasonReport(deps({ gateway: [c1], flows: [flow({ checkNonce: c1.authNonce })] }))
  assert.equal(noVaultOnRecord.milestone1.checks.byVault['not-recorded'], 1)
  assert.doesNotMatch(noVaultOnRecord.milestone1.checks.note, /none of these payments/)

  const someOwn = await arcSeasonReport(deps({ gateway: [c1, c2], flows: [flow({ checkNonce: c1.authNonce, vault: launch }), flow({ checkNonce: c2.authNonce, vault: stranger })] }))
  assert.equal(someOwn.milestone1.checks.byVault['launch-day'], 1)
  assert.doesNotMatch(someOwn.milestone1.checks.note, /none of these payments/)

  // With the list down the row it compares against is short, so the sentence waits for the list.
  const ownListDown = await arcSeasonReport(deps({ gateway: [c1], flows: [flow({ checkNonce: c1.authNonce, vault: launch })], admittedVaults: listDown }))
  assert.doesNotMatch(ownListDown.milestone1.checks.note, /none of these payments/)
  assert.doesNotMatch(ownListDown.milestone1.checks.note, /could still be through an owner's/)
})

test('the page keeps the note on external checks, so a paying wallet that also owns an unidentified vault is said at any count', async () => {
  const page = readFileSync(new URL('../../src/components/proof/ArcSeasonProgress.tsx', import.meta.url), 'utf8')
  assert.match(page, /metric=\{m2\.externalChecks\} keepNote/)
  const r = await arcSeasonReport(deps({ gateway: [gw({ payer: EXT_A })], admittedVaults: async () => [vaultEntry(EXT_C, { owner: EXT_A })] }))
  assert.equal(r.milestone2.externalChecks.count, 1)
  assert.match(r.milestone2.externalChecks.note, /1 of these wallet\(s\) also own a vault admitted with the owner not identified/)
})

test("a check paid by the owner of a vault labeled team is ours, not a wallet A-Identity does not control", async () => {
  const r = await arcSeasonReport(
    deps({
      vaults: [vaultEntry(EXT_C, { ownerKind: 'team', owner: shouty(EXT_A) }), vaultEntry('0x' + 'e2'.repeat(20), { ownerKind: 'external', owner: EXT_B })],
      gateway: [gw({ payer: EXT_A }), gw({ payer: EXT_B })],
    }),
  )
  assert.equal(r.milestone2.externalChecks.count, 1)
  assert.deepEqual(r.usage.external.wallets, [lower(EXT_B)])
  assert.deepEqual(r.usage.internal.wallets, [lower(EXT_A)])
  assert.equal(r.milestone1.checks.external, 1)
  assert.match(r.usage.basis, /owns a vault labeled team/)
})

test("a check paid by the agent key of a vault labeled team is ours too, whether or not its flow counts for anything yet", async () => {
  const teamVault = '0x' + 'e3'.repeat(20)
  const key = shouty(EXT_C)
  // A WARN still waiting for its owner: a paid check whose row maps to no season flow.
  const waiting = { flowId: '0x' + 'ab'.repeat(32), vault: teamVault, owner: EXT_A, operator: key, payee: EXT_B, amount: '1000', outcome: 'awaiting_human', detail: 'warn_handoff', check: { payer: key } } as unknown as VtpFlowRecord
  assert.deepEqual(seasonFlowsFromRows([waiting]), [], 'so a report reading only mapped flows would never see this key')
  const r = await arcSeasonReport(
    deps({
      vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })],
      gateway: [gw({ payer: EXT_C }), gw({ payer: EXT_B })],
      flowRows: async (onSkip, onKeys) => {
        for (const k of flowKeysFromRows([waiting])) onKeys?.(k)
        return seasonFlowsFromRows([waiting], onSkip)
      },
    }),
  )
  assert.equal(r.milestone2.externalChecks.count, 1)
  assert.deepEqual(r.usage.external.wallets, [lower(EXT_B)])
  assert.deepEqual(r.usage.internal.wallets, [lower(EXT_C)])
  assert.equal(r.afterProgram.activeExternalWallets.wallets.includes(lower(EXT_C)), false)
  assert.match(r.usage.basis, /is the agent key on a recorded verify-then-pay flow through such a vault/)
  assert.match(r.usage.basis, /an agent key with no recorded flow through that vault stays external until it is on a list/)
})

test('a key is not ours for naming a team wallet as its vault\'s owner: only the vault labeled team says so', async () => {
  const teamVault = '0x' + 'e3'.repeat(20)
  const strangersVault = '0x' + 'e4'.repeat(20)
  const row = (vault: string, operator: string) => ({ flowId: '0x' + 'cd'.repeat(32), vault, owner: EXT_A, operator, payee: EXT_B, amount: '1000', outcome: 'awaiting_human', detail: 'warn_handoff', check: { payer: operator } }) as unknown as VtpFlowRecord
  const stranger = lower(EXT_C)
  const r = await arcSeasonReport(
    deps({
      // The owner on the stranger's vault is the team wallet, as any constructor can say. The stranger's vault is on no list.
      vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })],
      gateway: [gw({ payer: stranger })],
      flowRows: async (onSkip, onKeys) => {
        for (const k of flowKeysFromRows([row(strangersVault, stranger)])) onKeys?.(k)
        return seasonFlowsFromRows([row(strangersVault, stranger)], onSkip)
      },
    }),
  )
  assert.equal(r.milestone2.externalChecks.count, 1)
  assert.deepEqual(r.usage.external.wallets, [stranger])
  assert.deepEqual(r.usage.internal.wallets, [])
})

test('a row that holds no flow names no key, and a row an old key wrote keeps naming it', () => {
  const row = (over: Record<string, unknown>) => ({ flowId: '0x' + 'ef'.repeat(32), vault: EXT_A, operator: EXT_B, outcome: 'awaiting_human', detail: 'warn_handoff', ...over }) as unknown as VtpFlowRecord
  assert.deepEqual(flowKeysFromRows([row({})]), [{ vault: EXT_A, operator: EXT_B }])
  // Every outcome that holds a flow, because each of them is a paid check.
  for (const [outcome, detail] of [['pending', 'agent_will_pay'], ['executed', 'owner_paid'], ['blocked', 'deny'], ['failed', 'reverted_not_policy']]) {
    assert.equal(flowKeysFromRows([row({ outcome, detail })]).length, 1, outcome)
  }
  // A reservation holds only the unverified word of whoever posted it, and so does a check the rail refused.
  assert.deepEqual(flowKeysFromRows([row({ outcome: 'opening', detail: 'opening' }), row({ outcome: 'abandoned', detail: 'rail_failed' })]), [])
  // A row the report cannot read is not a key, and it does not stop the others.
  assert.deepEqual(flowKeysFromRows([null as unknown as VtpFlowRecord, row({ operator: 7 }), row({ vault: null }), row({})]), [{ vault: EXT_A, operator: EXT_B }])
  assert.deepEqual(flowKeysFromRows([row({ operator: EXT_B }), row({ operator: EXT_C })]).map((k) => k.operator), [EXT_B, EXT_C], 'both keys, after a setOperator')
})

test('the live loader passes on the key of every row that holds a flow, so a team vault\'s key reads as ours in production and not only in a stub', async () => {
  const io = { getPool: async () => null, file: join(mkdtempSync(join(tmpdir(), 'season-flows-')), 'vtp-flows.json') }
  const teamVault = '0x' + 'e3'.repeat(20)
  const key = shouty(EXT_C)
  // A WARN still waiting for its owner: a paid check whose row maps to no season flow, which is the case the keys exist for.
  const waiting = { flowId: '0x' + 'ab'.repeat(32), network: arc.caip2, vault: teamVault, owner: EXT_A, operator: key, payee: EXT_B, amount: '1000', createdAt: '2026-10-18T10:00:01.000Z', outcome: 'awaiting_human', detail: 'warn_handoff', check: { payer: key } }
  const reserved = { ...waiting, flowId: '0x' + 'cd'.repeat(32), operator: EXT_B, outcome: 'opening', detail: 'opening' }
  writeFileSync(io.file, JSON.stringify([waiting, reserved]))

  const seen: ArcFlowKeys[] = []
  assert.deepEqual(await liveFlowRows(undefined, (k) => seen.push(k), io), [])
  assert.deepEqual(seen, [{ vault: teamVault, operator: key, payer: key }])

  const r = await arcSeasonReport(deps({ vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })], gateway: [gw({ payer: EXT_C })], flowRows: (onSkip, onKeys) => liveFlowRows(onSkip, onKeys, io) }))
  assert.deepEqual(r.usage.internal.wallets, [lower(EXT_C)])
  assert.equal(r.milestone2.externalChecks.count, 0)
  // And it is this loader the route is given.
  assert.equal(liveArcSeasonDeps({} as NodeJS.ProcessEnv).flowRows, liveFlowRows)
})

test('a curated flow through a vault labeled team names its key as a recorded one does', async () => {
  const teamVault = '0x' + 'e3'.repeat(20)
  const check = gw({ payer: EXT_C })
  const r = await arcSeasonReport(deps({ vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })], gateway: [check], flows: [flow({ checkNonce: check.authNonce, vault: teamVault, vaultKeys: { owner: EXT_A, operator: EXT_C } })] }))
  assert.deepEqual(r.usage.internal.wallets, [lower(EXT_C)])
  assert.equal(r.milestone2.externalChecks.count, 0)
  assert.equal(r.milestone1.checks.count, 1, 'and its flow is one of our own runs, as a team owner\'s is')
})

test('with the flow log down, the note on external checks says an agent key of a team vault could be among them', async () => {
  const teamVault = '0x' + 'e3'.repeat(20)
  const down = async () => {
    throw new Error('db down')
  }
  const said = /flow log could not be read on this request, so the agent key of a vault labeled team, or of the launch-day vault, could be counted as external until it answers/
  const withTeam = await arcSeasonReport(deps({ vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })], gateway: [gw({ payer: EXT_C })], flowRows: down }))
  assert.equal(withTeam.milestone2.externalChecks.count, 1)
  assert.match(withTeam.milestone2.externalChecks.note, said)
  // With no team vault the launch-day vault's key is still read from that log, and only that is said.
  const noTeam = (await arcSeasonReport(deps({ gateway: [gw({ payer: EXT_C })], flowRows: down }))).milestone2.externalChecks.note
  assert.doesNotMatch(noTeam, said)
  assert.match(noTeam, /flow log could not be read on this request, so the agent key of the launch-day vault could be counted as external until it answers/)
  assert.doesNotMatch(noTeam, /vault labeled team/)
  // Nothing to say with the log read.
  assert.doesNotMatch((await arcSeasonReport(deps({ vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })], gateway: [gw({ payer: EXT_C })], flowRows: async () => [] }))).milestone2.externalChecks.note, /could be counted as external until it answers/)
})

test('with the flow log down, every number that overcount reaches says so, by a flag the page reads and in its own words', async () => {
  const teamVault = vaultEntry('0x' + 'e3'.repeat(20), { ownerKind: 'team', owner: EXT_A })
  const down = async () => {
    throw new Error('db down')
  }
  const said = /The verify-then-pay flow log could not be read on this request, so the agent key of a vault labeled team, or of the launch-day vault, could be counted as external until it answers\./
  const r = await arcSeasonReport(deps({ vaults: [teamVault], gateway: [gw({ payer: EXT_C })], flowRows: down }))
  // The key is on no list, so it reads as an outside wallet everywhere: this is the overcount itself.
  assert.deepEqual(r.usage.external.wallets, [lower(EXT_C)])
  assert.deepEqual([r.milestone1.checks.external, r.milestone2.externalChecks.count, r.milestone2.unattributed.wallets, r.afterProgram.activeExternalWallets.count, r.afterProgram.weekly.weeks.filter((w) => w.checks > 0).length], [1, 1, 1, 1, 1])
  for (const number of [r.usage.external, r.milestone2.externalChecks, r.milestone2.unattributed, r.afterProgram.activeExternalWallets, r.afterProgram.weekly]) assert.equal(number.mayIncludeTeamKeys, true)
  assert.equal(r.milestone1.checks.externalMayIncludeTeamKeys, true)
  for (const words of [r.usage.basis, r.milestone2.externalChecks.note, r.milestone2.unattributed.note, r.afterProgram.weekly.note, r.afterProgram.note]) assert.match(words, said)
  // That is a number too high, not too low, so it is not the incomplete flag, and the settlement logs did answer.
  assert.equal(r.milestone2.externalChecks.incomplete, undefined)
  assert.equal(r.afterProgram.activeExternalWallets.incomplete, undefined)
  // The count of flows is not a number of external checks, so the page must not read this as its limit.
  assert.equal((r.milestone1.checks as { mayIncludeTeamKeys?: true }).mayIncludeTeamKeys, undefined)

  // Where it cannot be so, nothing is said: the log answered, or nothing external is there to be too high.
  const quiet = [
    await arcSeasonReport(deps({ vaults: [teamVault], gateway: [gw({ payer: EXT_C })], flowRows: async () => [] })),
    await arcSeasonReport(deps({ vaults: [teamVault], gateway: [gw({ payer: OURS_GATEWAY })], flowRows: down })),
  ]
  for (const q of quiet) {
    assert.doesNotMatch(JSON.stringify(q), /[mM]ayIncludeTeamKeys/)
    assert.doesNotMatch(JSON.stringify(q), /could be counted as external until it answers/)
  }
  // With no vault labeled team it can still be so: the launch-day vault's agent key can rotate to one nobody has committed,
  // and the report reads that key from the same log. Such a key's checks count as external until the log answers.
  const rotated = '0x' + 'f7'.repeat(20)
  const noTeam = await arcSeasonReport(deps({ gateway: [gw({ payer: rotated })], flowRows: down }))
  assert.deepEqual(noTeam.usage.external.wallets, [lower(rotated)], 'the overcount itself')
  for (const number of [noTeam.usage.external, noTeam.milestone2.externalChecks, noTeam.milestone2.unattributed, noTeam.afterProgram.activeExternalWallets, noTeam.afterProgram.weekly]) assert.equal(number.mayIncludeTeamKeys, true)
  assert.match(noTeam.milestone2.externalChecks.note, /so the agent key of the launch-day vault could be counted as external until it answers\./)
  // With the log read, that key is the launch-day vault's own and ours, and nothing is said.
  const launchVault = PROVENANCE.find((x) => x.chain === 'arc-mainnet')?.contracts.find((c) => c.name.startsWith('AgentSpendPolicy'))?.address as string
  assert.ok(launchVault, 'the launch-day vault is in the ledger')
  const read = await arcSeasonReport(deps({ gateway: [gw({ payer: rotated })], flowRows: async (_onSkip, onKeys) => (onKeys?.({ vault: launchVault, operator: rotated }), []) }))
  assert.deepEqual(read.usage.internal.wallets, [lower(rotated)])
  assert.equal(read.milestone2.externalChecks.mayIncludeTeamKeys, undefined)

  // A week or a wallet outside the window has no number of its own to flag.
  const old = await arcSeasonReport(deps({ vaults: [teamVault], gateway: [gw({ payer: EXT_C, ts: new Date(NOW - 40 * DAY).toISOString() })], flowRows: down }))
  assert.equal(old.afterProgram.activeExternalWallets.count, 0)
  assert.equal(old.afterProgram.activeExternalWallets.mayIncludeTeamKeys, undefined)
  assert.doesNotMatch(old.afterProgram.note, said)
  assert.equal(old.milestone2.externalChecks.mayIncludeTeamKeys, true)

  const page = readFileSync(new URL('../../src/components/proof/ArcSeasonProgress.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ')
  // A limit in the right direction on every row that shows one of these counts, and never the green of a target met.
  assert.match(page, /if \(m\.incomplete && m\.mayIncludeTeamKeys\) return `about \$\{m\.count\}`/)
  assert.match(page, /return m\.mayIncludeTeamKeys \? `at most \$\{m\.count\}` : String\(m\.count\)/)
  assert.match(page, /const met = metric\.count >= metric\.target && !metric\.mayIncludeTeamKeys/)
  assert.match(page, /After the program: \{countLabel\(after\)\}/)
  // The cell that has no count label says it in its caption.
  assert.match(page, /caption=\{external\.mayIncludeTeamKeys \? 'Wallets A-Identity does not control, and possibly the agent key of a vault labeled team, or of the launch-day vault, until the flow log answers\.'/)
  // The banner: what a settlement log holds is missing from every number, and what the flow log holds is flows.
  assert.match(page, /The \{settlementLogsDown\.join\(' and '\)\} log could not be read on this request, so what it holds is missing from every number below until it answers\./)
  assert.match(page, /The verify-then-pay flow log could not be read on this request, so the flows it holds are missing from the flow and refusal counts below until it answers\./)
  assert.match(page, /\{external\.mayIncludeTeamKeys && ' The agent key of a vault labeled team, or of the launch-day vault, is known from that log, so it could be counted as external, and the external numbers below could be too high\.'\}/)
  assert.doesNotMatch(page, /'verify-then-pay flow'/, 'the flow log is no longer one of the logs that banner speaks for')
})

test('a paying agent key of a vault nobody identified stays external, and the note says it could be ours', async () => {
  const unstated = '0x' + 'e5'.repeat(20)
  // The key paid that flow's check itself, which is the only way this sentence can be said of it.
  const key = (operator: string) => async (_onSkip?: unknown, onKeys?: (k: ArcFlowKeys) => void) => {
    onKeys?.({ vault: unstated, operator, payer: operator })
    return []
  }
  const said = /1 of these wallet\(s\) are the agent key on a flow through a vault admitted with the owner not identified, so one could be a team member's/
  const r = await arcSeasonReport(deps({ vaults: [vaultEntry(unstated, { owner: EXT_B })], gateway: [gw({ payer: EXT_C })], flowRows: key(shouty(EXT_C)) }))
  assert.equal(r.milestone2.externalChecks.count, 1)
  assert.deepEqual(r.usage.external.wallets, [lower(EXT_C)])
  assert.match(r.milestone2.externalChecks.note, said)
  // One wallet that is both is said once, as an owner.
  const both = await arcSeasonReport(deps({ vaults: [vaultEntry(unstated, { owner: EXT_C })], gateway: [gw({ payer: EXT_C })], flowRows: key(EXT_C) }))
  assert.doesNotMatch(both.milestone2.externalChecks.note, said)
  assert.match(both.milestone2.externalChecks.note, /1 of these wallet\(s\) also own a vault/)
  // A key on no such vault is not said to be anything.
  const elsewhere = await arcSeasonReport(deps({ vaults: [vaultEntry('0x' + 'e6'.repeat(20), { owner: EXT_B })], gateway: [gw({ payer: EXT_C })], flowRows: key(EXT_C) }))
  assert.doesNotMatch(elsewhere.milestone2.externalChecks.note, said)
})

test('naming a wallet as a vault\'s operator plants nothing on it: a key is doubted only on a flow it paid for itself, at both feeds', async () => {
  const planted = '0x' + 'e8'.repeat(20)
  const vault = vaultEntry(planted, { owner: EXT_B })
  const said = /are the agent key on a flow through a vault admitted with the owner not identified/
  const target = gw({ payer: EXT_C })

  // A row that holds a flow, as the log feeds it: the stranger paid, the target is only named.
  const row = (payer: string) => ({ flowId: '0x' + 'ab'.repeat(32), vault: planted, owner: EXT_B, operator: EXT_C, payee: EXT_A, amount: '1000', outcome: 'awaiting_human', detail: 'warn_handoff', check: { payer } }) as unknown as VtpFlowRecord
  const fromRows = (r: VtpFlowRecord) => async (onSkip?: (x: ArcSeasonSkippedRow) => void, onKeys?: (k: ArcFlowKeys) => void) => {
    for (const k of flowKeysFromRows([r])) onKeys?.(k)
    return seasonFlowsFromRows([r], onSkip)
  }
  assert.deepEqual(flowKeysFromRows([row(EXT_A)]), [{ vault: planted, operator: EXT_C, payer: EXT_A }])
  const byRow = await arcSeasonReport(deps({ vaults: [vault], gateway: [target], flowRows: fromRows(row(EXT_A)) }))
  assert.doesNotMatch(byRow.milestone2.externalChecks.note, said)
  const selfByRow = await arcSeasonReport(deps({ vaults: [vault], gateway: [target], flowRows: fromRows(row(shouty(EXT_C))) }))
  assert.match(selfByRow.milestone2.externalChecks.note, said)

  // The same through a flow the report mapped or a curated one, with no row feeding keys at all.
  const denied = gw({ payer: EXT_A })
  const byFlow = (payer: string) => flow({ checkNonce: denied.authNonce, outcome: 'refused', txHash: undefined, evidenceUrl: 'https://a-identity.xyz/flows/x', vault: planted, vaultKeys: { owner: EXT_B, operator: EXT_C }, payer })
  const planting = await arcSeasonReport(deps({ vaults: [vault], gateway: [denied, target], flows: [byFlow(EXT_A)] }))
  assert.doesNotMatch(planting.milestone2.externalChecks.note, said)
  const paying = gw({ payer: EXT_C })
  const selfByFlow = await arcSeasonReport(deps({ vaults: [vault], gateway: [paying], flows: [{ ...byFlow(EXT_C), checkNonce: paying.authNonce }] }))
  assert.match(selfByFlow.milestone2.externalChecks.note, said)

  // Counts move in none of these: only the sentence.
  for (const r of [byRow, selfByRow]) assert.equal(r.milestone2.externalChecks.count, 1)
})

test('a vault labeled team needs no such thing: its key is ours whoever paid the row that names it', async () => {
  const teamVault = '0x' + 'e9'.repeat(20)
  const r = await arcSeasonReport(
    deps({
      vaults: [vaultEntry(teamVault, { ownerKind: 'team', owner: EXT_A })],
      gateway: [gw({ payer: EXT_C })],
      flowRows: async (_onSkip, onKeys) => {
        onKeys?.({ vault: teamVault, operator: EXT_C, payer: EXT_B })
        return []
      },
    }),
  )
  assert.deepEqual(r.usage.internal.wallets, [lower(EXT_C)])
  assert.equal(r.milestone2.externalChecks.count, 0)
})

test('a wallet the partner list names is not said to be possibly ours, as an owner or as a key', async () => {
  const partner = { wallet: shouty(EXT_C), team: 'Team C', publicReference: true }
  const stated = /could be a team member's/
  const held = '0x' + 'ea'.repeat(20)

  // Its key pays through a vault someone else owns: the wallet is named, and the owner stays not identified.
  const asKey = await arcSeasonReport(
    deps({
      partners: [partner],
      vaults: [vaultEntry(held, { owner: EXT_B })],
      gateway: [gw({ payer: EXT_C })],
      flowRows: async (_onSkip, onKeys) => {
        onKeys?.({ vault: held, operator: EXT_C, payer: EXT_C })
        return []
      },
    }),
  )
  assert.deepEqual(asKey.milestone2.externalTeamsLive.teams.map((t) => t.team), ['Team C'])
  assert.doesNotMatch(asKey.milestone2.externalChecks.note, stated)
  assert.deepEqual(asKey.milestone1.vaults.byKind, { team: 0, external: 0, unstated: 1 })

  // It deployed the vault from the wallet it pays with: admitted automatically, the vault row says outside the team.
  const asOwner = await arcSeasonReport(deps({ partners: [partner], admittedVaults: async () => [vaultEntry(held, { owner: EXT_C, note: 'the chain cannot say whose wallet this is, so the owner is not identified' })], gateway: [gw({ payer: EXT_C })] }))
  assert.doesNotMatch(asOwner.milestone2.externalChecks.note, stated)
  assert.deepEqual(asOwner.milestone1.vaults.byKind, { team: 0, external: 1, unstated: 0 })
  assert.match(asOwner.milestone1.vaults.note, /0 of them someone on our own team, in their own wallet; 1 someone outside the team; 0 not identified/)
  assert.doesNotMatch(asOwner.milestone1.vaults.note, /admitted automatically after every check passed, with the owner not identified/)
  const [item] = asOwner.milestone1.vaults.items
  assert.equal(item.ownerKind, 'external')
  assert.doesNotMatch(item.note, /not identified/, 'and its own note does not contradict the label')
  assert.doesNotMatch(item.note, /Team C/, 'and it names nobody')

  // A person's entry stands even where it says nobody knows, and the note still does not doubt a wallet the list names.
  const entered = await arcSeasonReport(deps({ partners: [partner], vaults: [vaultEntry(held, { owner: EXT_C })], gateway: [gw({ payer: EXT_C })] }))
  assert.deepEqual(entered.milestone1.vaults.byKind, { team: 0, external: 0, unstated: 1 })
  assert.doesNotMatch(entered.milestone2.externalChecks.note, stated)

  // Without the listing it is what it was.
  const unlisted = await arcSeasonReport(deps({ admittedVaults: async () => [vaultEntry(held, { owner: EXT_C })], gateway: [gw({ payer: EXT_C })] }))
  assert.deepEqual(unlisted.milestone1.vaults.byKind, { team: 0, external: 0, unstated: 1 })
  assert.match(unlisted.milestone2.externalChecks.note, /1 of these wallet\(s\) also own a vault admitted with the owner not identified/)
})

test('labelOwners: a person\'s entry wins, a partner\'s wallet is external, and nothing else moves a label', () => {
  const a = vaultEntry(EXT_A)
  const b = vaultEntry(EXT_B, { owner: EXT_C })
  const c = vaultEntry(EXT_C, { owner: EXT_A })
  const curated = [vaultEntry(shouty(EXT_A), { ownerKind: 'team', note: 'a person said so' })]
  const partners = [{ wallet: EXT_C, team: 'Team C', publicReference: false }, { wallet: EXT_B, team: 'Team B', publicReference: false }]
  assert.deepEqual(labelOwners([a, b, c], curated, partners).map((v) => [v.address, v.ownerKind]), [[EXT_A, 'team'], [EXT_B, 'external'], [EXT_C, 'unstated']])
  assert.equal(labelOwners([a], curated, partners)[0].note, 'a person said so')
  assert.deepEqual(labelOwners([a, b, c], [], []), [a, b, c], 'with nobody having said anything, nothing changes')
  // A person's word stands over the partner list too.
  assert.equal(labelOwners([vaultEntry(EXT_A, { owner: EXT_C })], curated, partners)[0].ownerKind, 'team')
})

test('the guide says who else the season report reads as internal, and where that stops', () => {
  const guide = readFileSync(new URL('../../docs/chains/arc-integration.mdx', import.meta.url), 'utf8').replace(/\s+/g, ' ')
  assert.match(guide, /the agent key on a recorded flow through such a vault/)
  assert.match(guide, /An agent key with no recorded flow through that vault stays external until it is on the list, and the rail's own proof reads the list alone/)
})

test('a wallet that paid and owns a vault nobody identified stays external, and the note says it could be ours', async () => {
  const r = await arcSeasonReport(deps({ vaults: [vaultEntry(EXT_C, { owner: EXT_A })], gateway: [gw({ payer: EXT_A })] }))
  assert.equal(r.milestone2.externalChecks.count, 1)
  assert.match(r.milestone2.externalChecks.note, /1 of these wallet\(s\) also own a vault admitted with the owner not identified/)
})

test('the vault metric splits owners by kind and shows what the chain cannot say', async () => {
  const r = await arcSeasonReport(
    deps({
      vaults: [
        vaultEntry('0x' + 'f1'.repeat(20), { ownerKind: 'team' }),
        vaultEntry('0x' + 'f2'.repeat(20), { ownerKind: 'team' }),
        vaultEntry('0x' + 'f3'.repeat(20), { ownerKind: 'external' }),
        vaultEntry('0x' + 'f4'.repeat(20)),
      ],
    }),
  )
  const v = r.milestone1.vaults
  assert.deepEqual(v.byKind, { team: 2, external: 1, unstated: 1 })
  assert.match(v.note, /2 of them someone on our own team, in their own wallet; 1 someone outside the team; 1 not identified/)
  assert.match(v.note, /chain cannot show which tool sent a deploy/)
})

test('with a settlement log unreadable nothing says that no outside wallet has paid, and the reason stays off the page', async () => {
  const secret = 'connect ECONNREFUSED db.internal.example:5432'
  const d = deps({ facilitator: [fac({ payer: OURS_FACILITATOR })] })
  d.gatewayRows = async () => {
    throw new Error(secret)
  }
  const r = await arcSeasonReport(d)
  const m2 = r.milestone2
  for (const metric of [m2.externalChecks, m2.externalTeamsLive, m2.teamActiveOnSeveralDays, m2.publicReference]) {
    assert.equal(metric.incomplete, true)
    assert.match(metric.note, /Circle Gateway settlement log could not be read on this request, so this is a lower limit/)
    assert.doesNotMatch(metric.note, /^No |Every check settled/)
  }
  assert.equal(r.afterProgram.activeExternalWallets.incomplete, true)
  assert.equal(r.afterProgram.weekly.incomplete, true)
  assert.match(r.afterProgram.weekly.note, /Circle Gateway settlement log could not be read on this request, so this is a lower limit/)
  assert.doesNotMatch(r.afterProgram.weekly.note, /No external check to report/)
  assert.match(r.afterProgram.weekly.note, /Each UTC week will list its external checks/)
  assert.doesNotMatch(m2.unattributed.note, /Every external wallet/)
  assert.equal(r.milestone1.checks.incomplete, true)
  assert.equal(r.milestone1.checks.unlinked, null)
  assert.doesNotMatch(r.milestone1.checks.note, /No verify-then-pay flow yet/)
  assert.ok(!JSON.stringify(r).includes(secret), 'a driver error reaches the public report')

  // A readable report sets no such flag, so an older page and a newer one read it alike.
  const clean = await arcSeasonReport(deps())
  assert.equal(JSON.stringify(clean).includes('"incomplete"'), false)
  assert.match(clean.milestone2.externalChecks.note, /^No paid check from a wallet outside our own yet/)
})

test('with the flow log unreadable nobody is told how many checks have nothing linked, and refusals say why they are short', async () => {
  const check = gw({ payer: OURS_GATEWAY })
  const r = await arcSeasonReport(
    deps({
      gateway: [check],
      flowRows: async () => {
        throw new Error('vtp_flows unreachable')
      },
    }),
  )
  assert.equal(r.milestone1.checks.unlinked, null)
  assert.equal(r.milestone1.checks.incomplete, true)
  assert.doesNotMatch(r.milestone1.checks.note, /No verify-then-pay flow yet|nothing linked/)
  assert.equal(r.milestone1.refusals.incomplete, true)
  assert.match(r.milestone1.refusals.note, /any refusal it holds is missing from this count/)
  assert.equal(r.milestone2.externalFlows.incomplete, true)
  assert.doesNotMatch(r.milestone2.externalFlows.note, /No external verify-then-pay flow has reached/)
  assert.equal(r.milestone2.externalChecks.incomplete, undefined, 'the settlement logs answered')
  assert.ok(!JSON.stringify(r).includes('vtp_flows unreachable'))
})

test("an external team's verify-then-pay flow is listed under Milestone 2, by the same rules, and never in Milestone 1", async () => {
  const theirs = gw({ payer: EXT_A, ts: '2026-11-03T10:00:00.000Z' })
  const ours = gw({ payer: OURS_GATEWAY })
  const tx = nextTx()
  const paid = flow({ checkNonce: theirs.authNonce, payer: EXT_A, at: '2026-11-03T10:00:09.000Z', txHash: tx, recordUrl: 'https://a-identity.xyz/flows/t' })
  const r = await arcSeasonReport(deps({ gateway: [theirs, ours], flows: [paid, flow({ checkNonce: ours.authNonce })] }))
  assert.deepEqual([r.milestone1.checks.count, r.milestone1.checks.external], [1, 1])
  const e = r.milestone2.externalFlows
  assert.deepEqual([e.count, e.linked], [1, { paid: 1, refused: 0 }])
  assert.equal(e.items[0].explorerUrl, txUrl(arc, tx))
  assert.equal(e.items[0].recordUrl, 'https://a-identity.xyz/flows/t')
  assert.equal(r.milestone2.externalChecks.count, 1, 'the check itself still counts once')
  assert.ok(!r.milestone1.checks.items.some((f) => f.txHash === tx))

  // No check, no flow; before the check, no flow; one transaction stands behind one flow only.
  const quiet = await arcSeasonReport(deps({ gateway: [ours], flows: [paid] }))
  assert.equal(quiet.milestone2.externalFlows.count, 0)
  assert.match(quiet.milestone2.externalFlows.note, /^No external verify-then-pay flow has reached a vault payment or a refusal yet/)
  assert.match(quiet.milestone2.externalFlows.note, /A payment waiting for its owner has a public record/)
  const early = await arcSeasonReport(deps({ gateway: [theirs], flows: [flow({ checkNonce: theirs.authNonce, at: '2026-11-03T09:00:00.000Z' })] }))
  assert.equal(early.milestone2.externalFlows.count, 0)
  const reused = await arcSeasonReport(deps({ gateway: [theirs, ours], flows: [flow({ checkNonce: ours.authNonce, txHash: tx }), { ...paid }] }))
  assert.deepEqual([reused.milestone1.checks.count, reused.milestone2.externalFlows.count], [1, 0])
})

test("a team's days are counted across all its wallets, and the dates and the span are stated so a reader can judge them", async () => {
  const r = await arcSeasonReport(
    deps({
      partners: [
        { wallet: EXT_A, team: 'Team A', publicReference: false },
        { wallet: EXT_B, team: 'Team A', publicReference: false },
      ],
      gateway: [
        gw({ payer: EXT_A, ts: '2026-10-19T20:10:00Z' }),
        gw({ payer: EXT_B, ts: '2026-10-20T12:22:00Z' }),
        // Attributed to nobody, on two dates hours apart.
        gw({ payer: EXT_C, ts: '2026-10-19T20:00:00Z' }),
        gw({ payer: EXT_C, ts: '2026-10-20T12:00:00Z' }),
      ],
    }),
  )
  const m = r.milestone2.teamActiveOnSeveralDays
  assert.deepEqual([m.count, m.teams], [1, ['Team A']], 'neither wallet alone paid on two days')
  assert.deepEqual(m.byTeam, [{ team: 'Team A', activeDays: ['2026-10-19', '2026-10-20'], firstTs: '2026-10-19T20:10:00Z', lastTs: '2026-10-20T12:22:00Z' }])
  assert.match(m.note, /Team A on 2026-10-19 and 2026-10-20, 16\.2 hours from the first check to the last/)
  assert.match(m.note, new RegExp(`Wallet ${lower(EXT_C)} paid on 2026-10-19 and 2026-10-20, 16 hours from the first check to the last, and is attributed to no team, so it does not count here`))
  assert.deepEqual(r.milestone2.externalTeamsLive.teams.map((t) => t.team), ['Team A', 'Team A'])

  // One team on one date stays at zero, with the same wallets.
  const one = await arcSeasonReport(
    deps({
      partners: [
        { wallet: EXT_A, team: 'Team A', publicReference: false },
        { wallet: EXT_B, team: 'Team A', publicReference: false },
      ],
      gateway: [gw({ payer: EXT_A, ts: '2026-10-19T01:00:00Z' }), gw({ payer: EXT_B, ts: '2026-10-19T23:00:00Z' })],
    }),
  )
  assert.equal(one.milestone2.teamActiveOnSeveralDays.count, 0)
})

test('weekly usage counts external checks per UTC week, keeps empty weeks, and names the wallets that came back', async () => {
  const r = await arcSeasonReport(
    deps({
      partners: [
        { wallet: EXT_A, team: 'Team A', publicReference: false },
        { wallet: EXT_C, team: 'Team A', publicReference: false },
      ],
      gateway: [
        // Sunday night and Monday morning are different weeks.
        gw({ payer: EXT_A, ts: '2026-10-04T23:59:00Z' }),
        gw({ payer: EXT_B, ts: '2026-10-05T00:01:00Z' }),
        gw({ payer: EXT_B, ts: '2026-10-05T09:00:00Z' }),
        gw({ payer: EXT_B, ts: '2026-10-06T09:00:00Z' }),
        gw({ payer: OURS_GATEWAY, ts: '2026-10-06T09:00:00Z' }),
        gw({ payer: EXT_B, ts: 'not a date' }),
      ],
      facilitator: [fac({ payer: EXT_C, ts: '2026-10-19T11:00:00Z' }), fac({ payer: EXT_B, ts: '2026-10-19T11:00:00Z' })],
      now: () => Date.parse('2026-10-20T12:00:00Z'),
    }),
  )
  const w = r.afterProgram.weekly
  assert.deepEqual(
    w.weeks.map((x) => [x.weekStart, x.weekEnd, x.inProgress, x.checks, x.activeWallets, x.activeDays, x.returningWallets]),
    [
      ['2026-09-28', '2026-10-04', false, 1, [lower(EXT_A)], ['2026-10-04'], []],
      ['2026-10-05', '2026-10-11', false, 3, [lower(EXT_B)], ['2026-10-05', '2026-10-06'], []],
      ['2026-10-12', '2026-10-18', false, 0, [], [], []],
      ['2026-10-19', '2026-10-25', true, 2, [lower(EXT_B), lower(EXT_C)], ['2026-10-19'], [lower(EXT_B)]],
    ],
  )
  assert.deepEqual(w.repeatWallets, [lower(EXT_B)])
  assert.deepEqual(w.repeatTeams, ['Team A'], "a team's weeks are counted across its wallets")
  assert.match(w.note, /1 wallet\(s\) and 1 team\(s\) so far/)
  // Nothing external, nothing listed, and a sentence saying so.
  const none = (await arcSeasonReport(deps({ gateway: [gw({ payer: OURS_GATEWAY })] }))).afterProgram.weekly
  assert.deepEqual([none.weeks, none.repeatWallets, none.repeatTeams], [[], [], []])
  assert.match(none.note, /^No external check to report by week yet/)
})

test('admission takes a key the owner revoked, and no other lapsed key', () => {
  const blockTime = 2_000_000_000n
  const OWNER_KEY = '0x1234567890123456789012345678901234567890'
  const state: VaultState = {
    owner: OWNER_KEY,
    operator: EXT_A,
    usdc: arc.contracts.usdc!,
    dailyCap: 1n,
    autoApproveMax: 1n,
    sessionKeyExpiry: REVOKED_KEY_EXPIRY,
    frozen: false,
    allowlistEnabled: false,
    balance: null,
  }
  const verdictOn = (sessionKeyExpiry: bigint) =>
    stateChecks({
      state: { ...state, sessionKeyExpiry },
      deployer: OWNER_KEY,
      registryUsdc: arc.contracts.usdc!,
      ours: { byAddress: new Map(), envKeysDerived: [], envKeysUnreadable: [], keysCommitted: [], keysNotCompared: [] },
      blockTime,
      runtime: null,
      runtimeRequired: false,
      token: { symbol: 'USDC', decimals: 6 },
      chainId: arc.caip2,
    }).find((c) => c.id === 'session-key-expiry')!
  const revoked = verdictOn(REVOKED_KEY_EXPIRY)
  assert.equal(revoked.ok, true)
  assert.match(revoked.detail, /the owner revoked the agent key/)
  assert.equal(verdictOn(0n).ok, false, 'no end date at all still refuses')
  assert.equal(verdictOn(2n).ok, false, 'any other past value is a key left to lapse')
  assert.equal(verdictOn(blockTime).ok, false)
  assert.equal(verdictOn(blockTime + 1n).ok, true)
  assert.ok(stateNotes({ ...state, sessionKeyExpiry: REVOKED_KEY_EXPIRY }, blockTime).some((n) => n.startsWith('revoked:')))
  assert.equal(stateNotes({ ...state, sessionKeyExpiry: blockTime + 1n }, blockTime).some((n) => n.startsWith('revoked:')), false)
})

test("the Arc ledger lists Simon's identity and the first paid flow, with caveats that keep the ledger from claiming the whole log", () => {
  const entry = PROVENANCE.find((p) => p.chain === 'arc-mainnet')!
  const expected: [string, number, RegExp][] = [
    ['0x7ad5e5b46e752b70c3b7e29bf009d3bcc5dc6aec1a9cc5c9d3ac5cd8d75cad21', 29173344, /Simon is ours/],
    ['0x0723c5e83130dfe3a16cae0de01e7dbfe514b76b2192fb161c8508f61a888652', 29173360, /That wallet is ours as well/],
    ['0x32ea75ef07923f4b2e1955158fa2a25778e3c89ae0cc3dff7b01b0f9a34cfa67', 29173603, /Internal from end to end/],
  ]
  for (const [hash, block, says] of expected) {
    const a = entry.artifacts.find((x) => x.txHash === hash)
    assert.ok(a, `${hash} is not in the ledger`)
    assert.equal(a.blockNumber, block)
    assert.equal(a.onChain, 'arc-mainnet')
    assert.match(a.note ?? '', says)
  }
  assert.ok(entry.caveats.some((c) => /This ledger is not the whole settlement log/.test(c) && /counts those as external/.test(c)))
  assert.ok(!entry.caveats.some((c) => /Every payment recorded here is self-funded/.test(c)))
})
