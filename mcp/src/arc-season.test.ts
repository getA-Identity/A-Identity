import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  ARC_GAS_SUPPORT,
  ARC_LINK_TRACE,
  ARC_NOT_TEAM_PAYERS,
  ARC_OUR_SIDE_LINKS,
  ARC_WALLET_LINKS,
  partiesAmong,
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
  type ArcWalletLink,
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
    walletLinks: [],
    notTeamPayers: [],
    ourSideLinks: [],
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

// ── what the founder decided on 2026-11-06, as the curated lists hold it ─────────────

const SLIPPAY_WALLETS = ['0x94a2f2f914862f99bf122b9a932ebc4ae3e555c6', '0xe75d597f414eba88bf4226a3ad8e0fae46b1edc1']
const TRUSTLESS_WORK = '0x40BC51511ad79166FCc3506bea745A928f7E2708'

/** The external rows as the log held them on 2026-11-06, by wallet and time: Slippay's 5 and 2, Trustless Work's 2. */
const seasonRows = () => [
  ...['2026-10-19T20:10:01.533Z', '2026-10-19T20:14:54.600Z', '2026-10-19T20:32:41.900Z', '2026-10-19T20:47:54.500Z', '2026-10-20T12:21:30.812Z'].map((ts) => gw({ payer: SLIPPAY_WALLETS[0], ts, amountUsd: 0.005 })),
  ...['2026-10-20T12:21:50.365Z', '2026-10-20T12:22:30.210Z'].map((ts) => gw({ payer: SLIPPAY_WALLETS[1], ts, amountUsd: 0.005 })),
  ...['2026-11-03T19:39:04.433Z', '2026-11-04T18:18:24.661Z'].map((ts) => gw({ payer: TRUSTLESS_WORK, ts, amountUsd: 0.005 })),
]
const SEASON_READ = Date.parse('2026-11-06T16:00:00Z')

test('Slippay is named with both of its wallets, which read as one team, so external teams live reads 2 of 2', async () => {
  const slippay = ARC_PARTNERS.filter((p) => p.team === 'Slippay')
  assert.deepEqual(slippay.map((p) => p.wallet.toLowerCase()).sort(), SLIPPAY_WALLETS)
  assert.ok(slippay.every((p) => p.publicReference), 'named in the same scope as Trustless Work')
  assert.deepEqual([...new Set(ARC_PARTNERS.map((p) => p.team))].sort(), ['Slippay', 'Trustless Work'])

  const r = await arcSeasonReport(deps({ partners: ARC_PARTNERS, gateway: seasonRows(), now: () => SEASON_READ }))
  const m2 = r.milestone2
  assert.deepEqual([m2.externalTeamsLive.count, m2.externalTeamsLive.target], [2, 2])
  assert.deepEqual([...new Set(m2.externalTeamsLive.teams.map((t) => t.team))], ['Trustless Work', 'Slippay'])
  // One team across its two wallets: its days are both wallets' days, and it is one name wherever names are listed.
  const slip = m2.teamActiveOnSeveralDays.byTeam.find((t) => t.team === 'Slippay')!
  assert.deepEqual(slip.activeDays, ['2026-10-19', '2026-10-20'])
  assert.deepEqual([slip.firstTs, slip.lastTs], ['2026-10-19T20:10:01.533Z', '2026-10-20T12:22:30.210Z'])
  assert.deepEqual(m2.teamActiveOnSeveralDays.teams, ['Slippay', 'Trustless Work'])
  assert.deepEqual(m2.publicReference.names, ['Slippay', 'Trustless Work'])
  assert.deepEqual([m2.unattributed.wallets, m2.unattributed.checks], [0, 0])
  assert.deepEqual(r.usage.external.byWallet.map((w) => [w.wallet, w.team, w.checks]), [
    [SLIPPAY_WALLETS[0], 'Slippay', 5],
    [SLIPPAY_WALLETS[1], 'Slippay', 2],
    [TRUSTLESS_WORK.toLowerCase(), 'Trustless Work', 2],
  ])
  assert.doesNotMatch(m2.teamActiveOnSeveralDays.note, /attributed to no team/)
})

/** The three counted vaults as the chain read them on 2026-11-06: address, owner (the deploy's sender and owner()), deploy hash, block and UTC day. */
const COUNTED_VAULTS = [
  ['0x25e461649e232ae23fF6CBA1e4Cd001F7a056B90', '0x8cd5D3981A1fA059A92722591d25240e6F0f27A5', '0xbd8d1e4ab5d14e6f65837f92becf0a492165bd007e8e9308ad177f7ab3cf9d2f', '29552025', '2026-11-04'],
  ['0xa4D8052998A59017fd6816654F4C9eef62DE8182', '0x39AEfbC8388da12907A21d9De888B288a9fa5794', '0xeedb9cf539988596b145b8f467c15fe489f8f2b6f5ef5b8488bcd991e7a42e7b', '29681265', '2026-11-05'],
  ['0x033FdeECD2f60d2A0Cb78794c4Cd1F191A9DEbE5', '0xeD701bA695FBBaa7f0CD1D4cBe540E86F55C677b', '0xd7ea1ee90de141eb89ac6c10b16d8066fb54d66088550dc9794569d83a5ae7fe', '29751356', '2026-11-06'],
]

test("the three counted vaults are outside the team on the founder's word, and each owner is still not identified", async () => {
  assert.deepEqual(ARC_OWNER_HELD_VAULTS.map((v) => [v.address, v.owner, v.deployTx, v.deployBlock, v.deployedAt]), COUNTED_VAULTS)
  for (const v of ARC_OWNER_HELD_VAULTS) {
    assert.equal(v.ownerKind, 'external', v.address)
    assert.match(v.note, /on 2026-11-06 the founder confirmed that this owner is not a team wallet/, v.address)
    assert.match(v.note, /The owner is not identified: nobody has said whose wallet it is\./, v.address)
  }
  // The rows as the store holds them, admitted with the owner not identified: the entries label them, and each counts once.
  const stored = ARC_OWNER_HELD_VAULTS.map((v) => ({ ...v, address: v.address.toLowerCase(), ownerKind: 'unstated' as const, note: 'Admitted automatically by POST /api/arc/vaults; the owner is not identified.' }))
  const r = await arcSeasonReport(deps({ vaults: ARC_OWNER_HELD_VAULTS, admittedVaults: async () => stored }))
  const v = r.milestone1.vaults
  assert.equal(v.count, 3)
  assert.deepEqual(v.byKind, { team: 0, external: 3, unstated: 0 })
  assert.match(v.note, /0 of them someone on our own team, in their own wallet; 3 someone outside the team; 0 not identified as either\./)
  assert.doesNotMatch(v.note, /admitted automatically after every check passed, with the owner not identified/)
  assert.deepEqual(v.items.map((i) => [i.ownerKind, i.note === ARC_OWNER_HELD_VAULTS[0].note]), [['external', true], ['external', true], ['external', true]])
  // GET /api/arc/vaults labels the stored rows the same way, through the same function and its defaults.
  assert.deepEqual(labelOwners(stored).map((s) => s.ownerKind), ['external', 'external', 'external'])
})

test('the founder wallet is on the internal payer list of both rails, so a check it pays can never read as external', async () => {
  const wallet = '0x432bd8bb5b9e199677e6a3fa72ac9739030953fd'
  assert.ok(gatewayInternalPayers({}).includes(wallet), 'gateway')
  assert.ok(facilitatorInternalPayers({}).includes(wallet), 'facilitator')
  const internal = { gateway: gatewayInternalPayers({}), facilitator: facilitatorInternalPayers({}) }
  const r = await arcSeasonReport(deps({ internalPayers: internal, gateway: [gw({ payer: wallet }), gw({ payer: EXT_A })] }))
  assert.equal(r.usage.internal.checks, 1)
  assert.deepEqual(r.usage.external.wallets, [EXT_A])
  // So admission refuses an owner from it too, and the page's generated key list reads it as ours (frontend-sync.test.ts).
  assert.ok(committedOurKeys().includes(wallet))
})

// ── the rail page and its headline ─────────────

const CHAIN_PROOF = () => readFileSync(new URL('../../src/routes/ChainProof.tsx', import.meta.url), 'utf8')

test('the headline splits our own payments from others, from the same helper on /arc and /proof/arc', async () => {
  type Sums = { count: number; usd: number; assetSymbols: string[]; split: { internal: number; external: number; internalUsd: number; externalUsd: number } | null } | null
  type Source = { byNetwork: Record<string, { count: number; usd: number; assetSymbol: string; internal?: number; internalUsd?: number }> }
  const { sumPaidChecks } = (await import(new URL('../../src/lib/paidChecks.ts', import.meta.url).href)) as { sumPaidChecks: (s: Source[], n: ReadonlySet<string>) => Sums }
  const nets = new Set(['eip155:5042'])
  const gateway = { byNetwork: { 'eip155:5042': { count: 136, usd: 0.68, assetSymbol: 'USDC', internal: 103, internalUsd: 0.503 }, 'eip155:8453': { count: 9, usd: 9, assetSymbol: 'USDC', internal: 9, internalUsd: 9 } } }
  const facilitator = { byNetwork: { 'eip155:5042': { count: 1, usd: 0.031, assetSymbol: 'USDC', internal: 1, internalUsd: 0.031 } } }
  const both = sumPaidChecks([gateway, facilitator], nets)
  assert.deepEqual(both, { count: 137, usd: 0.711, assetSymbols: ['USDC'], split: { internal: 104, external: 33, internalUsd: 0.534, externalUsd: 0.177 } })
  // A log that does not say who paid leaves the split unknown, and a dash is better than a guess.
  assert.equal(sumPaidChecks([gateway, { byNetwork: { 'eip155:5042': { count: 1, usd: 0.031, assetSymbol: 'USDC' } } }], nets)?.split, null)
  // A network no log has rows for says nothing either way.
  assert.deepEqual(sumPaidChecks([gateway], new Set(['eip155:1']))?.split, { internal: 0, external: 0, internalUsd: 0, externalUsd: 0 })

  const page = CHAIN_PROOF()
  assert.match(page, /sales\.split \? `: \$\{sales\.split\.internal\} from our own wallets, \$\{sales\.split\.external\} from other wallets` : ''/)
  assert.match(page, /sales\.split\?\.internalUsd != null \? `: \$\$\{sales\.split\.internalUsd\} from our own wallets, \$\$\{sales\.split\.externalUsd\} from other wallets` : ''/)
  assert.match(page, /split: totals\?\.split \?\? null,/)
  const arcPage = readFileSync(new URL('../../src/routes/Arc.tsx', import.meta.url), 'utf8')
  assert.match(arcPage, /paid checks settled in production: \$\{paidChecks\.split\.internal\} from our own wallets, \$\{paidChecks\.split\.external\} from other wallets/)
})

test('the own-rail headline counts ours as the rest of the settled rows, and says nothing when the log cannot say', async () => {
  type Split = { internal: number; external: number; internalUsd: null; externalUsd: null } | null
  const { ownRailSplit } = (await import(new URL('../../src/lib/paidChecks.ts', import.meta.url).href)) as { ownRailSplit: (total: number, external?: number | null) => Split }
  assert.deepEqual(ownRailSplit(12, 3), { internal: 9, external: 3, internalUsd: null, externalUsd: null })
  assert.deepEqual(ownRailSplit(5, 0), { internal: 5, external: 0, internalUsd: null, externalUsd: null })
  assert.equal(ownRailSplit(12, undefined), null, 'a log that does not tell our wallets apart')
  assert.equal(ownRailSplit(12, null), null)
  assert.equal(ownRailSplit(3, 4), null, 'more external than settled is no split')
  assert.equal(ownRailSplit(3, -1), null)
  assert.equal(ownRailSplit(3, 1.5), null)
  // Stellar, Algorand and Celo read their headline split from the helper, and nothing else builds one.
  const page = CHAIN_PROOF()
  assert.match(page, /\n    split: ownRailSplit\(p\.totalSettlements, p\.externalSettlements\),\n/)
  assert.equal(page.split('totalSettlements - ').length - 1, 0, 'no split is worked out on the page itself')
})

test('the rail page renders each guarded claim under its own condition only', () => {
  const page = CHAIN_PROOF()
  // The testnet chip is on both places a network's status shows, and the old green chip is left only inside NetworkChip.
  assert.match(page, /\{liveNet && <NetworkChip net=\{liveNet\} \/>\}/)
  assert.match(page, /\n {24}<NetworkChip net=\{net\} \/>\n/)
  assert.equal(page.split("<Chip tone={net.status === 'live' ? 'ok' : 'warn'}>{net.status}</Chip>").length - 1, 1, 'only inside NetworkChip')
  assert.doesNotMatch(page, /liveNet\.status === 'live'/)
  // The caveats and the headline split each render on their own condition, with nothing in front of it.
  assert.match(page, /\n {10}\{proof && proof\.networks\.some\(\(n\) => n\.caveats\.length > 0\) && \(\n/)
  assert.match(page, /\n {18}\{sales && !sales\.allInternal && sales\.count && sales\.split \? `: \$\{sales\.split\.internal\} from our own wallets, \$\{sales\.split\.external\} from other wallets` : ''\}\n/)
  assert.match(page, /\n {18}\{sales && !sales\.allInternal && sales\.split\?\.internalUsd != null \? `: \$\$\{sales\.split\.internalUsd\} from our own wallets, \$\$\{sales\.split\.externalUsd\} from other wallets` : ''\}\n/)
})

test('the rail page says what it is: a testnet is not green, caveats are in the open, and the first paint claims no outage', () => {
  const page = CHAIN_PROOF()
  assert.match(page, /isTestnet\(net\) \? <Chip tone="warn">testnet<\/Chip>/)
  assert.match(page, /const isTestnet = \(net: Network\) => CHAINS\.find\(\(c\) => c\.caip2 === net\.caip2\)\?\.testnet \?\? false/)
  assert.match(page, /proof\?\.networks\.find\(\(n\) => n\.status === 'live' && !isTestnet\(n\)\)/, 'the summary chip does not settle on a testnet either')
  // Caveats are rendered outside the folded ledger, for every network, and the old no-render comment is gone.
  const caveats = page.indexOf('What this does not prove')
  assert.ok(caveats > -1 && caveats < page.indexOf('Show the full ledger'), 'above the fold')
  assert.match(page, /net\.caveats\.map\(\(c\) => \(/)
  assert.doesNotMatch(page, /intentionally not rendered/)
  // Copy that used to overclaim.
  assert.doesNotMatch(page, /Click any number/)
  assert.match(page, /Open a transaction link on this page to see it on-chain\./)
  assert.doesNotMatch(page, /re-read live from the chain on each load\.'/, 'the description does not promise every transaction')
  assert.match(page, /Agent ownership and contract code are re-read live from the chain on each load; payments come from the settlement logs\./)
  // The waiting state says what is true at any read: the numbers load live, and they have not loaded. No claim about the backend.
  assert.doesNotMatch(page, /BACKEND_UNREACHABLE/)
  assert.match(page, /The numbers on this page load live from GET \/api\/proof\/\$\{rail\} and the settlement logs, and they have not loaded yet\./)
  assert.doesNotMatch(page, /still in the prerendered HTML/)
})

test('the deploy flow says a vault counts once its end date is set, at the second confirmation and where an owner can stop', () => {
  const copy = readFileSync(new URL('../../src/lib/arc/deploy-copy.ts', import.meta.url), 'utf8')
  assert.match(copy, /COUNTS_ONCE_END_DATE = 'A vault counts on \/proof\/arc only on Arc Mainnet, and only once this end date is set: a deploy alone does not count\.'/)
  assert.match(copy, /does: `Gives the agent's key an end date[^`]*\$\{COUNTS_ONCE_END_DATE\}`/)
  assert.match(copy, /Your vault exists but you stopped before step 2'[^}]*the vault does not count on \/proof\/arc/)
  const flow = readFileSync(new URL('../../src/components/app/arc/DeployFlow.tsx', import.meta.url), 'utf8')
  assert.match(flow, /\{CALL_FEE_ABOUT\} in network fees\. \{COUNTS_ONCE_END_DATE\}/, 'the banner at step 2, where a deploy that stopped is left')
  // The vault's own page says it while the end date is missing.
  const notice = readFileSync(new URL('../../src/components/app/arc/VaultCountNotice.tsx', import.meta.url), 'utf8')
  assert.match(notice, /can count on \{PROOF_LINK\} once its agent key has an end date/)
})

// ── who stands behind the numbers: the hand trace of 2026-11-08, as the curated lists hold it ─────────────

/** The three vaults the server admitted after the founder's statement of 2026-11-06, as the chain read them: nobody has spoken for them. */
const NEW_VAULTS: [string, string, string, string, string][] = [
  ['0x9aCeD7d5442aED2c8aCB0Ab249B46b3A17aF0619', '0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9', '0x6bda1b2faa57bf0f4330fbb8aef38152a9a0f19ddfe465c31d94837fa59ee9ab', '29879919', '2026-11-06'],
  ['0x30E423f2b00eb8654a021AaA2bd9acAd20A1ff79', '0x363daf2A42D5055Dac91163f0eA29ca05c378f01', '0xdb11b831e432660077a05cdced0614a880b5872e2a2a12eb7eb87617053602e9', '29967114', '2026-11-07'],
  ['0xcB7e3b8b323B897E7E4303245dc98DE130B2Ed41', '0x56755b84a0825d82f9be97C8Ab057cCDC3Dc1a43', '0x6725e2e3e1f1066e774bd35d6dee10627f12e0416d18ea96f55f4ffc9c354c47', '30080119', '2026-11-07'],
]
const ADMITTED_NOTE = 'Admitted automatically by POST /api/arc/vaults; the owner is not identified.'
/** The six rows as the store holds them on 2026-11-08, every one with the owner not identified. */
const sixStoredVaults = () =>
  [...ARC_OWNER_HELD_VAULTS.map((v): [string, string, string, string, string] => [v.address, v.owner, v.deployTx, v.deployBlock!, v.deployedAt]), ...NEW_VAULTS].map(([address, owner, deployTx, deployBlock, deployedAt]) => ({
    address: address.toLowerCase(),
    owner: owner.toLowerCase(),
    ownerKind: 'unstated' as const,
    deployTx,
    deployBlock,
    deployedAt,
    note: ADMITTED_NOTE,
  }))

const V6_VAULT = '0xcb7e3b8b323b897e7e4303245dc98de130b2ed41'
const V6_OWNER = '0x56755b84a0825d82f9be97c8ab057ccdc3dc1a43'
const V6_OPERATOR = '0x1d54499fa6cff560f217a2cd1013b4e12c8d7f5f'
const LIVE_READ = Date.parse('2026-11-08T18:57:15Z')

/** What the flow log names for vault 0xcB7e...Ed41 on 2026-11-08: its agent key, on flows that key and the owner paid for. The
 *  flows themselves are in the test of the seven external flows below; here only the keys, which is all a party line reads. */
const liveFlowKeys = (): ArcFlowKeys[] => [
  { vault: V6_VAULT, operator: V6_OPERATOR, payer: V6_OPERATOR },
  { vault: V6_VAULT, operator: V6_OPERATOR, payer: V6_OWNER },
]

/** The 33 external rows as the Gateway log held them on 2026-11-08, by wallet and time. */
const liveExternalRows = () => [
  ...Array.from({ length: 14 }, (_, i) => gw({ payer: V6_OPERATOR, ts: new Date(Date.parse('2026-11-07T22:41:28.193Z') + i * 2_700_000).toISOString(), amountUsd: 0.005 })),
  ...Array.from({ length: 6 }, (_, i) => gw({ payer: V6_OWNER, ts: new Date(Date.parse('2026-11-08T09:11:21.993Z') + i * 800).toISOString(), amountUsd: 0.005 })),
  ...seasonRows(),
  ...['2026-11-05T06:51:48.403Z', '2026-11-05T06:51:50.285Z'].map((ts) => gw({ payer: ARC_NOT_TEAM_PAYERS[0], ts, amountUsd: 0.005 })),
  gw({ payer: ARC_NOT_TEAM_PAYERS[1], ts: '2026-11-05T17:56:32.918Z', amountUsd: 0.005 }),
  gw({ payer: ARC_NOT_TEAM_PAYERS[2], ts: '2026-11-05T21:04:22.284Z', amountUsd: 0.005 }),
]

const liveShape = () =>
  arcSeasonReport(
    deps({
      vaults: ARC_OWNER_HELD_VAULTS,
      admittedVaults: async () => sixStoredVaults(),
      walletLinks: ARC_WALLET_LINKS,
      notTeamPayers: ARC_NOT_TEAM_PAYERS,
      ourSideLinks: ARC_OUR_SIDE_LINKS,
      partners: ARC_PARTNERS,
      gateway: liveExternalRows(),
      flowRows: async (_onSkip, onKeys) => {
        for (const keys of liveFlowKeys()) onKeys?.(keys)
        return []
      },
      now: () => LIVE_READ,
    }),
  )

test('the vault count says how many owner wallets stand behind it and how many are linked, and does not move for it', async () => {
  const r = await liveShape()
  const v = r.milestone1.vaults
  assert.deepEqual([v.count, v.target], [6, 5], 'the count stays what it is')
  assert.deepEqual(v.byKind, { team: 0, external: 3, unstated: 3 }, 'the three the founder spoke for, and the three nobody has')
  assert.deepEqual([v.owners.distinct, v.owners.parties], [6, 5])
  assert.equal(v.owners.summary, '6 vaults from 6 owner wallets; two of the owner wallets are linked on chain, so they may be one party: at most 5 parties.')
  assert.ok(v.note.includes(v.owners.summary), 'the note the API carries says it too')
  assert.equal(v.owners.linked.length, 1)
  const [link] = v.owners.linked
  assert.deepEqual(link.owners, ['0x39AEfbC8388da12907A21d9De888B288a9fa5794', '0xeD701bA695FBBaa7f0CD1D4cBe540E86F55C677b'], 'as the counted vaults spell them, and only those')
  assert.deepEqual(link.vaults, ['0xa4D8052998A59017fd6816654F4C9eef62DE8182', '0x033FdeECD2f60d2A0Cb78794c4Cd1F191A9DEbE5'])
  assert.equal(link.tracedOn, '2026-11-08')
  assert.match(link.note, /may belong to one party/)
  assert.match(link.confidence, /medium for 0x39AE\.\.\.5794 with 0xeD70\.\.\.677b/)
  // Each hash links from the registry, and the first two are what ties the owners and the agent key.
  const funded = '0x4ffaba3861c5f37469daebadebce5f48023f2920e85bc66288ebae5c6de0d139'
  const fundedOperator = '0x57940cfcb58bd8f3663e47663b94c3cacb3749f0ed274a8c486e5410a33e9d07'
  assert.deepEqual(link.evidence.slice(0, 2).map((e) => [e.txHash, e.explorerUrl]), [[funded, txUrl(arc, funded)], [fundedOperator, txUrl(arc, fundedOperator)]])
  assert.match(link.evidence[0].what, /0\.99 USDC of it went to 0xeD70\.\.\.677b/)
  assert.match(link.evidence[1].what, /the agent key of vault 0xa4D8\.\.\.8182/)
  assert.match(v.note, /Each link was traced by hand, not read live on this request, and the transactions behind it are named with it; the count does not move for it\./)
  // The one party that owns a counted vault and also paid.
  assert.equal(v.owners.alsoPaid.length, 1)
  assert.deepEqual([v.owners.alsoPaid[0].vaults, [...v.owners.alsoPaid[0].wallets].sort(), v.owners.alsoPaid[0].checks], [['0xcb7e3b8b323b897e7e4303245dc98de130b2ed41'], [V6_OPERATOR, V6_OWNER].sort(), 20])
  assert.match(v.note, /The party behind vault 0xcb7e\.\.\.ed41 also paid 20 external checks, counted under Milestone 2 and never here\./)
  // The founder's word of 2026-11-06 is on the three vaults labeled external, and the note says it does not reach the rest.
  assert.match(v.note, /The founder's statement of 2026-11-06 does not cover these\./)
})

test('owner wallets count once whatever their case, and a link counts only between owners of counted vaults', async () => {
  const a = vaultEntry('0x' + 'f1'.repeat(20), { owner: EXT_A })
  const b = vaultEntry('0x' + 'f2'.repeat(20), { owner: shouty(EXT_A) })
  const c = vaultEntry('0x' + 'f3'.repeat(20), { owner: EXT_B })
  const link: ArcWalletLink = { wallets: [EXT_B, EXT_C], tracedOn: '2026-11-06', confidence: 'High.', note: 'traced', evidence: [{ txHash: '0x' + '9a'.repeat(32), what: 'a transfer' }] }
  const same = await arcSeasonReport(deps({ vaults: [a, b, c], walletLinks: [link] }))
  assert.deepEqual([same.milestone1.vaults.owners.distinct, same.milestone1.vaults.owners.parties], [2, 2])
  assert.equal(same.milestone1.vaults.owners.summary, '3 vaults from 2 owner wallets.')
  assert.deepEqual(same.milestone1.vaults.owners.linked, [], 'EXT_C owns no counted vault, so the link says nothing about this count')
  assert.doesNotMatch(same.milestone1.vaults.note, /traced by hand/)
  const linked = await arcSeasonReport(deps({ vaults: [a, c], walletLinks: [{ ...link, wallets: [shouty(EXT_A), EXT_B, EXT_C] }] }))
  assert.equal(linked.milestone1.vaults.owners.summary, '2 vaults from 2 owner wallets; two of the owner wallets are linked on chain, so they may be one party: at most 1 party.')
  assert.equal(linked.milestone1.vaults.owners.parties, 1)
  assert.deepEqual(linked.milestone1.vaults.owners.linked[0].owners, [EXT_A, EXT_B], 'as the counted vaults spell them, and only those')
  assert.equal((await arcSeasonReport(deps({ vaults: [a] }))).milestone1.vaults.owners.summary, '1 vault from 1 owner wallet.')
  const none = (await arcSeasonReport(deps({}))).milestone1.vaults.owners
  assert.deepEqual(none, { distinct: 0, parties: 0, linked: [], alsoPaid: [], summary: '0 vaults from 0 owner wallets.' })
})

test('a list of admitted vaults that could not be read leaves the owner count short and names no ceiling', async () => {
  const a = vaultEntry('0x' + 'f1'.repeat(20), { owner: EXT_A })
  const b = vaultEntry('0x' + 'f2'.repeat(20), { owner: EXT_B })
  const link: ArcWalletLink = { wallets: [EXT_A, EXT_B], tracedOn: '2026-11-06', confidence: 'High.', note: 'traced', evidence: [{ txHash: '0x' + '9a'.repeat(32), what: 'a transfer' }] }
  const r = await arcSeasonReport(
    deps({
      vaults: [a, b],
      walletLinks: [link],
      admittedVaults: async () => {
        throw new Error('the list did not answer')
      },
    }),
  )
  assert.equal(r.milestone1.vaults.incomplete, true)
  assert.equal(r.milestone1.vaults.owners.summary, '2 vaults from 2 owner wallets; two of the owner wallets are linked on chain, so they may be one party. The list of admitted vaults could not be read, so there may be more.')
  assert.doesNotMatch(r.milestone1.vaults.owners.summary, /at most/, 'a ceiling from a short list would be a guess')
  assert.equal(r.milestone1.vaults.owners.parties, null, 'and the field the API publishes is no ceiling either')
  const full = await arcSeasonReport(deps({ vaults: [a, b], walletLinks: [link] }))
  assert.match(full.milestone1.vaults.owners.summary, /at most 1 party/)
  assert.equal(full.milestone1.vaults.owners.parties, 1)
})

test('parties join only wallets that are in the list, whatever a group also holds, and a ceiling never adds up to more than the wallets', () => {
  const [a, b, c] = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20), '0x' + 'c3'.repeat(20)]
  assert.deepEqual(partiesAmong([a, b, c], []).map((p) => p.length).sort(), [1, 1, 1])
  assert.deepEqual(partiesAmong([a, b, c], [[shouty(a), b]]).map((p) => p.length).sort(), [1, 2], 'any case')
  assert.deepEqual(partiesAmong([a, c], [[a, b], [b, c]]).map((p) => p.length).sort(), [1, 1], 'a wallet outside the list does not bridge two groups')
  assert.deepEqual(partiesAmong([a, b, c], [[a, b], [b, c]]).map((p) => p.length), [3], 'groups that share a wallet are one party')
  assert.deepEqual(partiesAmong([a, a.toUpperCase().replace('0X', '0x')], []).map((p) => p.length), [1])
})

test('the external checks say how many wallets and parties stand behind them, without moving a count', async () => {
  const r = await liveShape()
  const m2 = r.milestone2
  assert.deepEqual([m2.externalChecks.count, m2.externalChecks.target], [33, 30], 'checks do not move')
  const p = m2.externalChecks.payers
  assert.deepEqual([p.wallets, p.parties], [8, 6])
  assert.equal(p.summary, "33 checks from 8 wallets, at most 6 parties: two wallets linked on chain paid 20, and Slippay's two wallets paid 7.")
  assert.ok(m2.externalChecks.note.includes(p.summary))
  assert.deepEqual(p.whoPaid, { team: { wallets: 3, checks: 9 }, 'not-team': { wallets: 3, checks: 4 }, 'not-identified': { wallets: 2, checks: 20 } })
  assert.equal(p.linked.length, 1, 'the one traced group with two or more paying wallets')
  assert.deepEqual([[...p.linked[0].wallets].sort(), p.linked[0].checks, p.linked[0].team], [[V6_OPERATOR, V6_OWNER].sort(), 20, undefined])
  // Slippay's two wallets are one party on the team list alone: no traced group of theirs is published.
  // The 20 are the crux: a reader must not take them for 20 separate users, or the 33 for the program's demand.
  // They are said to be one party because they are one vault's owner and its agent key, which the flow log names.
  assert.match(m2.externalChecks.note, /20 of the 33 come from one party nobody has identified: 0x5675\.\.\.1a43 and 0x1d54\.\.\.7f5f, the owner and agent key of vault 0xcb7e\.\.\.ed41, linked on chain; the other 13 come from 6 wallets\./)
  assert.match(m2.externalChecks.note, /By who stands behind them: 9 checks from 3 wallets of named teams; 4 checks from 3 wallets the founder confirmed on 2026-11-06 are not team wallets; 20 checks from 2 wallets nobody has identified\./)
  // Each wallet row says it too, so a list of wallets does not read as a list of people.
  const row = (w: string) => r.usage.external.byWallet.find((x) => x.wallet === w)!
  assert.deepEqual(row(V6_OPERATOR).linkedWith, [V6_OWNER])
  assert.equal(row(V6_OWNER).identity, 'not-identified')
  assert.deepEqual(row(SLIPPAY_WALLETS[0]).linkedWith, [SLIPPAY_WALLETS[1]])
  assert.equal(row(SLIPPAY_WALLETS[1]).identity, 'team')
  assert.equal(row(ARC_NOT_TEAM_PAYERS[0]).identity, 'not-team')
  assert.equal(row(ARC_NOT_TEAM_PAYERS[0]).linkedWith, undefined)
  assert.deepEqual([m2.unattributed.wallets, m2.unattributed.checks], [5, 24])
  assert.match(m2.unattributed.note, /3 of them \(4 checks\) the founder confirmed on 2026-11-06 are not team wallets; 2 \(20 checks\) nobody has identified, each counted as external until someone says otherwise\./)
  // What moves is teams, days and the new labels: and the checks the two rows above stand on stay what they are.
  assert.equal(r.usage.external.checks, 33)
  assert.equal(r.usage.external.wallets.length, 8)
  assert.deepEqual([m2.externalTeamsLive.count, m2.teamActiveOnSeveralDays.count, m2.publicReference.count], [2, 2, 2])
})

test('a log that could not be read leaves the payers unknown, and names no ceiling', async () => {
  const r = await arcSeasonReport({
    ...deps({ facilitator: [fac({ payer: EXT_A })] }),
    gatewayRows: async () => {
      throw new Error('down')
    },
  })
  const p = r.milestone2.externalChecks.payers
  assert.equal(r.milestone2.externalChecks.incomplete, true)
  assert.equal(p.summary, '1 check from 1 wallet in the logs that could be read, so more wallets may have paid.')
  assert.doesNotMatch(p.summary, /at most/)
  assert.match(r.afterProgram.note, /a log that could not be read leaves the parties unknown/)
  // The fields the API publishes say the same: no ceiling from a log that could not be read.
  assert.equal(p.parties, null)
  assert.equal(r.afterProgram.activeExternalWallets.incomplete, true)
  assert.equal(r.afterProgram.activeExternalWallets.parties, null)
  // With no wallet at all it says that plainly, and with no links it does not invent one.
  const none = await arcSeasonReport(deps({}))
  assert.equal(none.milestone2.externalChecks.payers.summary, 'No external wallet has paid a check yet.')
  const two = await arcSeasonReport(deps({ gateway: [gw({ payer: EXT_A }), gw({ payer: EXT_B })] }))
  assert.equal(two.milestone2.externalChecks.payers.summary, '2 checks from 2 wallets, and no two of them are linked by a trace or a shared team.')
  assert.deepEqual([two.milestone2.externalChecks.payers.parties, two.afterProgram.activeExternalWallets.parties], [2, 2])
  assert.match(two.afterProgram.note, /It counts wallets, not parties: 2 wallets, and no two of them are linked by a trace or a shared team\./)
  const one = await arcSeasonReport(deps({ gateway: [gw({ payer: EXT_A })] }))
  assert.equal(one.milestone2.externalChecks.payers.summary, '1 check from 1 wallet.')
  assert.match(one.afterProgram.note, /It counts wallets, not parties: 1 wallet\./)
})

test('a log that could not be read leaves no sentence saying that no team ran a flow, or that no wallet paid', async () => {
  const TEAM = '0x' + 'b2'.repeat(20)
  const partners = [{ wallet: TEAM, team: 'Named Team', publicReference: false }]
  const down = async (): Promise<never> => {
    throw new Error('down')
  }
  // The flow log is down and the Gateway log answers: the team counts from its check, and nobody can say it ran no flow.
  const flowLogDown = await arcSeasonReport({ ...deps({ partners, gateway: [gw({ payer: TEAM })] }), flowRows: down })
  assert.equal(flowLogDown.logs.flows?.readable, false)
  assert.equal(flowLogDown.milestone2.externalTeamsLive.count, 1)
  assert.doesNotMatch(flowLogDown.milestone2.externalTeamsLive.note, /No named team has run a verify-then-pay flow/)
  const flowLogEmpty = await arcSeasonReport({ ...deps({ partners, gateway: [gw({ payer: TEAM })] }), flowRows: async () => [] })
  assert.match(flowLogEmpty.milestone2.externalTeamsLive.note, /No named team has run a verify-then-pay flow yet\./)
  // The Gateway log is down and the flow log answers: the team counts from a check it paid on the facilitator rail, and a
  // flow links only through a Gateway row, so nobody can say it ran no flow either.
  const gatewayDown = await arcSeasonReport({ ...deps({ partners, facilitator: [fac({ payer: TEAM })] }), gatewayRows: down, flowRows: async () => [] })
  assert.deepEqual([gatewayDown.logs.gateway.readable, gatewayDown.logs.flows?.readable], [false, true])
  assert.equal(gatewayDown.milestone2.externalTeamsLive.count, 1)
  assert.doesNotMatch(gatewayDown.milestone2.externalTeamsLive.note, /No named team has run/)
  // Both settlement logs are down: the payers line says what was not read, not that no wallet has paid.
  const bothDown = await arcSeasonReport({ ...deps({}), gatewayRows: down, facilitatorRows: down })
  assert.equal(bothDown.milestone2.externalChecks.incomplete, true)
  assert.equal(bothDown.milestone2.externalChecks.payers.summary, 'No external wallet was found in the logs that could be read on this request, and that says nothing about a log that could not be read.')
  assert.doesNotMatch(JSON.stringify(bothDown), /No external wallet has paid/)
})

test('the party with the most checks is named first in the payers line, whatever order its wallets sit in', async () => {
  const [a, b, c, d] = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20), '0x' + 'c3'.repeat(20), '0x' + 'd4'.repeat(20)]
  const link = (wallets: string[]): ArcWalletLink => ({ wallets, tracedOn: '2026-11-08', confidence: 'High.', note: 'traced by hand, a test row', evidence: [{ txHash: '0x' + '9a'.repeat(32), what: 'a transfer in a test' }] })
  const rows = [...Array.from({ length: 9 }, () => gw({ payer: a })), gw({ payer: b }), ...Array.from({ length: 6 }, () => gw({ payer: c })), ...Array.from({ length: 6 }, () => gw({ payer: d }))]
  const r = await arcSeasonReport(deps({ gateway: rows, walletLinks: [link([a, b]), link([c, d])] }))
  assert.equal(r.milestone2.externalChecks.payers.summary, '22 checks from 4 wallets, at most 2 parties: two wallets linked on chain paid 12, and two wallets linked on chain paid 10.')
})

test('a team that pays from two wallets is one party whether or not a link was traced', async () => {
  const partners = [
    { wallet: EXT_A, team: 'One Team', publicReference: false },
    { wallet: EXT_B, team: 'One Team', publicReference: false },
  ]
  const r = await arcSeasonReport(
    deps({
      partners,
      gateway: [gw({ payer: EXT_A }), gw({ payer: EXT_B })],
      vaults: [vaultEntry('0x' + 'f1'.repeat(20), { owner: EXT_A }), vaultEntry('0x' + 'f2'.repeat(20), { owner: EXT_B })],
    }),
  )
  assert.deepEqual([r.milestone1.vaults.owners.distinct, r.milestone1.vaults.owners.parties], [2, 1], 'owners read through the same party')
  assert.equal(r.milestone2.externalChecks.payers.parties, 1)
  assert.equal(r.milestone2.externalChecks.payers.summary, "2 checks from 2 wallets, at most 1 party: One Team's two wallets paid 2.")
  assert.equal(r.afterProgram.activeExternalWallets.parties, 1)
  assert.match(r.afterProgram.note, /One Team's two wallets are one team/)
})

test('every curated link names two or more wallets and a transaction for each thing it says, and names no one outside consent', () => {
  assert.ok(ARC_WALLET_LINKS.length >= 8)
  const allText = JSON.stringify({ links: ARC_WALLET_LINKS, ourSide: ARC_OUR_SIDE_LINKS, trace: ARC_LINK_TRACE, gas: ARC_GAS_SUPPORT })
  for (const l of ARC_WALLET_LINKS) {
    assert.ok(l.wallets.length >= 2 && l.wallets.every((w) => /^0x[0-9a-fA-F]{40}$/.test(w)), l.note)
    assert.match(l.tracedOn, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(l.confidence.length > 2 && l.note.length > 20, l.note)
    assert.ok(l.evidence.length > 0 && l.evidence.every((e) => /^0x[0-9a-fA-F]{64}$/.test(e.txHash ?? '') && e.what.length > 12), l.note)
  }
  // Every wallet is in one group: two groups that overlapped would silently be one party.
  const every = ARC_WALLET_LINKS.flatMap((l) => l.wallets.map((w) => w.toLowerCase()))
  assert.equal(new Set(every).size, every.length, 'a wallet appears in two groups')
  // The two agents the trace found by their platform listing stay unnamed here, and so does every person on the team. A team
  // that has not agreed to be named is held by the next test, which does not write the name either.
  for (const notNamed of [/yaman/i, /antigravity/i, /meric/i, /aybars/i, /m[uü]ge/i, /ezgin/i, /mert\b/i]) {
    assert.doesNotMatch(allText, notNamed, `${notNamed} is named outside consent`)
  }
  assert.deepEqual([...new Set(ARC_PARTNERS.map((p) => p.team))].sort(), ['Slippay', 'Trustless Work'], 'and the partner list stays these two')
  // The third platform wallet shares naming only: no chain link, so it is in no group and no count.
  assert.ok(!every.includes('0xbfbe3b342b7e7cf3cde3c0783b58abd889fac70f'))
  // An address written short is one the data holds in full: a typo here would be a public claim about the wrong wallet.
  const full = [
    ...every,
    ...ARC_OWNER_HELD_VAULTS.flatMap((v) => [v.address, v.owner]),
    ...NEW_VAULTS.flatMap(([address, owner]) => [address, owner]),
    '0x17126d2f33c988fcf11952423d4585bf94b1cf67', // the contract 0x39AE...5794 deployed
    '0x3a972a45afd1156d7c6ca4d01056df46984cc72c', // the split's third recipient
    '0x432bd8bb5b9e199677e6a3fa72ac9739030953fd', // the team member's wallet
    '0xec0642f7e585764fe0069c9ee43e3505f8d73144', // the dust sender
  ].map((a) => a.toLowerCase())
  const shortForms = [...new Set(allText.match(/0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}/g) ?? [])]
  assert.ok(shortForms.length > 30)
  for (const a of shortForms) {
    const [head, tail] = a.toLowerCase().split('...')
    assert.ok(full.some((w) => w.startsWith(head) && w.endsWith(tail)), `${a} is written short and held in full nowhere`)
  }
})

/**
 * Teams that have not agreed to be named. Their names are not written in this repo: it is public, and a test that wrote them
 * would be the first place to name them. They are read from .private/names-outside-consent.txt, which is gitignored, in the
 * nearest .private/ above this file, one name per line. Null where there is none, as in CI, and the test below is then
 * reported as skipped, with the reason.
 */
function namesOutsideConsent(): { line: number; name: string }[] | null {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const path = join(dir, '.private', 'names-outside-consent.txt')
    if (existsSync(path)) {
      return readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((text, i) => ({ line: i + 1, name: text.trim().toLowerCase() }))
        .filter((l) => l.name !== '' && !l.name.startsWith('#'))
    }
    if (dirname(dir) === dir) return null
  }
}
const OUTSIDE_CONSENT = namesOutsideConsent()

test('the season trace, its report and their source name no team that has not agreed to be named', { skip: OUTSIDE_CONSENT ? false : 'the names are kept out of this public repo, in a gitignored .private/names-outside-consent.txt that this checkout does not have' }, async () => {
  const names = OUTSIDE_CONSENT ?? []
  assert.ok(names.length > 0, 'the private list names no one, so this test would hold nothing')
  const curated = { ARC_PARTNERS, ARC_OWNER_HELD_VAULTS, ARC_REFUSALS, ARC_VERIFY_THEN_PAY_FLOWS, ARC_NOT_TEAM_PAYERS, ARC_WALLET_LINKS, ARC_OUR_SIDE_LINKS, ARC_LINK_TRACE, ARC_GAS_SUPPORT }
  const sources = ['../src/arc-season.ts', '../src/arc-season-links.ts', '../src/arc-season.test.ts', '../../src/components/proof/ArcSeasonProgress.tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
  const text = [JSON.stringify({ curated, report: await liveShape() }), ...sources].join('\n').toLowerCase()
  for (const { line, name } of names) {
    // Said by its line and never by the name, because a failure prints in a log that someone may paste.
    assert.ok(name.length >= 3, `line ${line} of the private list is too short to be a name`)
    assert.ok(!text.includes(name), `the name on line ${line} of the private list is written in the season trace, its report or their source`)
  }
})

test("a named team's wallets are published only as the wallets that paid, and the trace says the rest are left out", async () => {
  const teamOf = new Map(ARC_PARTNERS.map((p) => [lower(p.wallet), p.team]))
  const teams = [...new Set(ARC_PARTNERS.map((p) => p.team))]
  for (const l of ARC_WALLET_LINKS) {
    const wallets = l.wallets.map(lower)
    const named = new Set(wallets.map((w) => teamOf.get(w)).filter(Boolean))
    const text = JSON.stringify(l)
    // A group that holds a named team's wallet, or names a team, holds nothing but that one team's paying wallets.
    if (named.size > 0 || teams.some((t) => text.includes(t))) {
      assert.ok(named.size === 1 && wallets.every((w) => teamOf.has(w)), `a group with a named team holds another wallet: ${l.note}`)
    }
  }
  const line = ARC_LINK_TRACE.limits.find((l) => /^Left out of the groups/.test(l))
  assert.ok(line)
  assert.match(line, /the wallets behind the named teams' paying wallets\. Slippay and Trustless Work agreed to be named as an integration on this page, which does not cover their other wallets\./)
  // The team list still makes one party of Slippay's two paying wallets, so the ceiling of parties does not move.
  const r = await liveShape()
  assert.deepEqual([r.milestone2.externalChecks.payers.wallets, r.milestone2.externalChecks.payers.parties], [8, 6])
  assert.match(r.milestone2.externalChecks.payers.summary, /and Slippay's two wallets paid 7\.$/)
  assert.deepEqual(r.usage.external.byWallet.find((w) => w.wallet === SLIPPAY_WALLETS[0])?.linkedWith, [SLIPPAY_WALLETS[1]])
})

test('the trace says what it read on each network: every movement on Arc Mainnet, and only our own transfers on Arc Testnet', () => {
  const { reads } = ARC_LINK_TRACE
  assert.match(reads, /on Arc Mainnet, every USDC movement from or to 49 tracked addresses, blocks 20,800,000 to 30,221,494 \(2026-09-14 to 2026-11-08\)/)
  assert.match(reads, /on Arc Testnet, only the USDC transfers from our wallets to the tracked owners, agent keys, payers, payee and funders, blocks 64,800,000 to 71,411,457 \(2026-09-30 to 2026-11-08\)/)
  const noFunding = ARC_OUR_SIDE_LINKS.find((x) => x.kind === 'none-found' && /No funding from our side/.test(x.note))!
  assert.match(noFunding.note, /every USDC movement of the tracked wallets was read on Arc Mainnet, and every USDC transfer from our wallets to them on Arc Testnet,/)
  assert.match(noFunding.note, /On Arc Mainnet the operating wallet sent USDC only to/, 'what our wallets sent elsewhere was read on Arc Mainnet only')
  // The Arc Testnet scan read only transfers from our wallets to the tracked ones, so nothing says it read every movement there.
  const all = JSON.stringify({ reads, limits: ARC_LINK_TRACE.limits, ourSide: ARC_OUR_SIDE_LINKS })
  assert.doesNotMatch(all, /on Arc Mainnet and Arc Testnet|every USDC movement[^;.]*\(2026-09-14 to 2026-11-08\), and on Arc Testnet/)
})

test('the two flow records that name other vault owners as payees are disclosed, and are not read as a link', async () => {
  const line = ARC_LINK_TRACE.limits.find((l) => /^Two flow records of 2026-11-08/.test(l))
  assert.ok(line, 'the trace says what the flow records show')
  assert.match(line, /each opened by a check that 0x1d54\.\.\.7f5F, the agent key of vault 0xcB7e\.\.\.Ed41, paid for, name 0x39AE\.\.\.5794 and 0x8cd5\.\.\.27A5, the owners of vaults 0xa4D8\.\.\.8182 and 0x25e4\.\.\.6B90, as payees/)
  assert.match(line, /so nothing was paid\. A payee named in a flow is not treated as a link: the owner addresses are public on this page, and anyone can name them\./)
  // Every date in the trace is a UTC day, and both reads of those records fell on the trace's own day.
  assert.match(line, new RegExp(`when read on ${ARC_LINK_TRACE.tracedOn}, so nothing was paid`))
  // The two named are the owners the counted vaults carry, and the payer is that vault's agent key.
  const ownerOf = (vault: string) => ARC_OWNER_HELD_VAULTS.find((v) => v.address.toLowerCase().startsWith(vault.toLowerCase()))!.owner
  assert.deepEqual([ownerOf('0xa4D8'), ownerOf('0x25e4')], ['0x39AEfbC8388da12907A21d9De888B288a9fa5794', '0x8cd5D3981A1fA059A92722591d25240e6F0f27A5'])
  assert.ok(ARC_WALLET_LINKS[0].wallets.some((w) => lower(w) === V6_OPERATOR))
  // Not a link: no group holds the payer with either owner, and the parties behind the vaults do not move.
  for (const owner of ['0x39aefbc8388da12907a21d9de888b288a9fa5794', '0x8cd5d3981a1fa059a92722591d25240e6f0f27a5']) {
    assert.ok(!ARC_WALLET_LINKS.some((l) => l.wallets.map(lower).includes(owner) && l.wallets.map(lower).includes(V6_OPERATOR)), owner)
  }
  const r = await liveShape()
  assert.ok(r.linkedWallets.limits.includes(line), 'published with the report')
  assert.deepEqual([r.milestone1.vaults.owners.distinct, r.milestone1.vaults.owners.parties], [6, 5])
})

test('no wallet the trace names is on a list of ours, so the line that says none is stays true', () => {
  const ours = new Set([...committedOurKeys(), ...gatewayInternalPayers({}), ...facilitatorInternalPayers({}), ...ARC_OUR_PAYEES.map((p) => p.address)].map(lower))
  const named = [
    ...ARC_WALLET_LINKS.flatMap((l) => l.wallets),
    ...ARC_OWNER_HELD_VAULTS.map((v) => v.owner),
    ...NEW_VAULTS.map(([, owner]) => owner),
    ...ARC_NOT_TEAM_PAYERS,
    ...ARC_PARTNERS.map((p) => p.wallet),
  ].map(lower)
  assert.ok(named.length > 30)
  for (const w of named) assert.ok(!ours.has(w), `${w} is named by the trace and is on a list of ours`)
  assert.ok(ARC_OUR_SIDE_LINKS.some((x) => x.kind === 'none-found' && /is on a published internal payer list of ours or the committed list of our keys, and none is one of our own agents\./.test(x.note)))
})

test('a linked party is said to be one nobody has identified only when none of its wallets is, and the who-paid line names only the kinds that paid', async () => {
  const [a, b, c] = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20), '0x' + 'c3'.repeat(20)]
  const link: ArcWalletLink = { wallets: [a, b], tracedOn: '2026-11-08', confidence: 'High.', note: 'traced by hand, a test row', evidence: [{ txHash: '0x' + '9a'.repeat(32), what: 'a transfer in a test' }] }
  const rows = [gw({ payer: a }), gw({ payer: a }), gw({ payer: b }), gw({ payer: c })]
  // One of the two linked wallets was said not to be the team's: the party is not one nobody has identified.
  const mixed = await arcSeasonReport(deps({ gateway: rows, walletLinks: [link], notTeamPayers: [a] }))
  assert.doesNotMatch(mixed.milestone2.externalChecks.note, /one party nobody has identified/)
  assert.match(mixed.milestone2.externalChecks.note, /By who stands behind them: 2 checks from 1 wallet the founder confirmed on 2026-11-06 are not team wallets; 2 checks from 2 wallets nobody has identified\.$/)
  // Two wallets a link ties, and nothing else known of them: they may be one party, and that is all a link says.
  const unknown = await arcSeasonReport(deps({ gateway: rows, walletLinks: [link] }))
  assert.match(unknown.milestone2.externalChecks.note, /By who stands behind them: 4 checks from 3 wallets nobody has identified\. 3 of the 4 come from wallets linked on chain, which may be one party nobody has identified: 0xa1a1\.\.\.a1a1 and 0xb2b2\.\.\.b2b2; the other 1 come from 1 wallet\.$/)
  // Only named teams paid: the line names them and no other kind.
  const teams = await arcSeasonReport(deps({ partners: ARC_PARTNERS, gateway: seasonRows(), now: () => SEASON_READ }))
  assert.match(teams.milestone2.externalChecks.note, /By who stands behind them: 9 checks from 3 wallets of named teams\.$/)
})

test("linked payers are said to be one party only when they are one vault's owner and its agent key, and may be one otherwise", async () => {
  const note = async (over: Over) => (await arcSeasonReport(deps({ now: () => LIVE_READ, ...over }))).milestone2.externalChecks.note
  // The medium group of the trace: two vault owners, one of whom paid the other its only USDC. Each pays, and the line says
  // they may be one party, as the group's own confidence and the owners line do.
  const [A, B] = ['0x39aefbc8388da12907a21d9de888b288a9fa5794', '0xed701ba695fbbaa7f0cd1d4cbe540e86f55c677b']
  const medium = ARC_WALLET_LINKS.find((l) => l.wallets.map(lower).includes(A))!
  assert.match(medium.confidence, /medium for 0x39AE\.\.\.5794 with 0xeD70\.\.\.677b/)
  const twoOwners = await note({ gateway: [gw({ payer: A }), gw({ payer: A }), gw({ payer: B }), gw({ payer: EXT_C })], walletLinks: ARC_WALLET_LINKS, vaults: ARC_OWNER_HELD_VAULTS })
  assert.match(twoOwners, / 3 of the 4 come from wallets linked on chain, which may be one party nobody has identified: 0x39ae\.\.\.5794 and 0xed70\.\.\.677b; the other 1 come from 1 wallet\.$/)
  assert.doesNotMatch(twoOwners, /come from one party/)

  // A vault's owner and the agent key the flow log names for it are one party, owner first whatever order the link holds them.
  const [OWNER, KEY, KEY2] = ['0x' + 'd1'.repeat(20), '0x' + 'd2'.repeat(20), '0x' + 'd3'.repeat(20)]
  const VAULT = '0x' + 'e1'.repeat(20)
  const traced = (wallets: string[]): ArcWalletLink => ({ wallets, tracedOn: '2026-11-08', confidence: 'High.', note: 'traced by hand, a test row', evidence: [{ txHash: '0x' + '9a'.repeat(32), what: 'a transfer in a test' }] })
  const keysRead = (keys: ArcFlowKeys[]) => async (_onSkip?: unknown, onKeys?: (k: ArcFlowKeys) => void) => {
    for (const k of keys) onKeys?.(k)
    return []
  }
  const pair = { gateway: [gw({ payer: OWNER }), gw({ payer: KEY }), gw({ payer: KEY }), gw({ payer: EXT_C })], walletLinks: [traced([KEY, OWNER])], vaults: [vaultEntry(VAULT, { owner: OWNER })] }
  const onePair = await note({ ...pair, flowRows: keysRead([{ vault: VAULT, operator: KEY, payer: KEY }]) })
  assert.match(onePair, / 3 of the 4 come from one party nobody has identified: 0xd1d1\.\.\.d1d1 and 0xd2d2\.\.\.d2d2, the owner and agent key of vault 0xe1e1\.\.\.e1e1, linked on chain; the other 1 come from 1 wallet\./)
  // The same two with the flow log down: nothing on this read says the key is the vault's, so they may be one party.
  const logDown = await note({ ...pair, flowRows: async () => { throw new Error('down') } })
  assert.match(logDown, / 3 of the 4 come from wallets linked on chain, which may be one party nobody has identified: 0xd2d2\.\.\.d2d2 and 0xd1d1\.\.\.d1d1;/)
  // A flow's own record of the vault's keys says the same as the flow log, for a vault the counted list does not hold.
  const fromRecord = await note({ ...pair, vaults: [], flows: [flow({ vault: VAULT, vaultKeys: { owner: OWNER, operator: KEY } })] })
  assert.match(fromRecord, /come from one party nobody has identified: 0xd1d1\.\.\.d1d1 and 0xd2d2\.\.\.d2d2, the owner and agent key of vault 0xe1e1\.\.\.e1e1,/)
  // Two agent keys of one vault, without the owner: each was named by the owner, and they may be two people.
  const twoKeys = await note({ gateway: [gw({ payer: KEY }), gw({ payer: KEY2 })], walletLinks: [traced([KEY, KEY2])], vaults: [vaultEntry(VAULT, { owner: OWNER })], flowRows: keysRead([{ vault: VAULT, operator: KEY }, { vault: VAULT, operator: KEY2 }]) })
  assert.match(twoKeys, /come from wallets linked on chain, which may be one party nobody has identified/)
  // Two records that disagree on a vault's owner do not make the two wallets an owner and its agent key.
  const twoOwnersOnRecord = await note({ ...pair, walletLinks: [traced([OWNER, KEY2])], gateway: [gw({ payer: OWNER }), gw({ payer: KEY2 })], flows: [flow({ vault: VAULT, vaultKeys: { owner: KEY2, operator: KEY } })] })
  assert.match(twoOwnersOnRecord, /come from wallets linked on chain, which may be one party nobody has identified/)
  // An owner and the agent key of another vault: no one vault holds both.
  const twoVaults = await note({ ...pair, vaults: [vaultEntry(VAULT, { owner: OWNER }), vaultEntry('0x' + 'e2'.repeat(20), { owner: EXT_B })], flowRows: keysRead([{ vault: '0x' + 'e2'.repeat(20), operator: KEY }]) })
  assert.match(twoVaults, /come from wallets linked on chain, which may be one party nobody has identified/)
  // An owner with two agent keys is one party with all three named, the owner first.
  const three = await note({ gateway: [gw({ payer: KEY2 }), gw({ payer: KEY }), gw({ payer: OWNER }), gw({ payer: EXT_C })], walletLinks: [traced([KEY2, KEY, OWNER])], vaults: [vaultEntry(VAULT, { owner: OWNER })], flowRows: keysRead([{ vault: VAULT, operator: KEY }, { vault: VAULT, operator: KEY2 }]) })
  assert.match(three, / 3 of the 4 come from one party nobody has identified: 0xd1d1\.\.\.d1d1 and 0xd3d3\.\.\.d3d3 and 0xd2d2\.\.\.d2d2, the owner and two agent keys of vault 0xe1e1\.\.\.e1e1, linked on chain; the other 1 come from 1 wallet\./)
})

test('the links to our own side are labeled as ours or disclosed, each with what it rests on', async () => {
  const r = await liveShape()
  const ourSide = r.linkedWallets.ourSide
  assert.equal(ourSide.filter((x) => x.kind === 'ours').length, 1)
  const ours = ourSide.find((x) => x.kind === 'ours')!
  assert.match(ours.note, /0x432b\.\.\.53fd is a team member's own wallet/)
  assert.deepEqual(ours.evidence.map((e) => e.txHash), ['0x437f31171291c797516d28bfea583cf6324285060c3f8b481deecf13156899cf'])
  assert.equal(ours.evidence[0].explorerUrl, txUrl(arc, ours.evidence[0].txHash!))
  const disclosed = ourSide.filter((x) => x.kind === 'disclosed')
  assert.ok(disclosed.some((x) => /paid our agent Simon 0\.001 USDC/.test(x.note) && x.evidence[0].txHash === '0x1d11b1f3fff1dea60242e637eb330303c10d2f01fff99deceaf944ce23e9edd4'))
  assert.ok(disclosed.some((x) => /0x8d58\.\.\.7bca.*signed in to our web app/.test(x.note) && x.evidence[0].explorerUrl === 'https://a-identity.xyz/api/marketplace?all=1'))
  assert.ok(disclosed.some((x) => /0xec06\.\.\.3144 sent our buyer wallet/.test(x.note)), 'dust is disclosed too, with no relation found')
  assert.equal(ourSide.filter((x) => x.kind === 'none-found').length, 3)
  assert.ok(ourSide.some((x) => /No funding from our side/.test(x.note)))
  assert.ok(ourSide.some((x) => /None of the owners, agent keys, external payers, funders or the external payee 0x2442\.\.\.77c4/.test(x.note)))
  assert.deepEqual(r.linkedWallets.limits, ARC_LINK_TRACE.limits)
  assert.match(r.linkedWallets.reads, /by hand on 2026-11-08, not on this request/)
  assert.deepEqual(r.linkedWallets.groups.map((g) => g.wallets), ARC_WALLET_LINKS.map((l) => l.wallets))
  assert.ok(r.linkedWallets.groups.every((g) => g.evidence.every((e) => e.explorerUrl === (e.txHash ? txUrl(arc, e.txHash) : e.url))))
  // The statement of the trace reads as what it is: hand-made, dated, and not read on this request.
  assert.match(r.note, /Links between wallets are curated as well: traced by hand on a date, not read live, and they move no count\./)
})

test('with no list named, the report reads the curated links, the labeled payers and the links to our side, as the live route does', async () => {
  const r = await arcSeasonReport({ ...deps({ gateway: [gw({ payer: ARC_NOT_TEAM_PAYERS[0] })] }), walletLinks: undefined, notTeamPayers: undefined, ourSideLinks: undefined })
  assert.equal(r.linkedWallets.groups.length, ARC_WALLET_LINKS.length)
  assert.equal(r.linkedWallets.ourSide.length, ARC_OUR_SIDE_LINKS.length)
  assert.equal(r.usage.external.byWallet[0].identity, 'not-team')
})

test('the vault note says what the key comparison covers, when a vault counts, and how gas support stands', async () => {
  const r = await liveShape()
  const note = r.milestone1.vaults.note
  assert.match(note, /deployed by the owner's own wallet, which is none of the keys of ours it was compared with; GET \/api\/arc\/vaults names any key it could not be compared with\./)
  assert.doesNotMatch(note, /A-Identity's servers never held/, 'not a claim the comparison cannot carry')
  assert.match(note, /A vault counts once its agent key has an end date, the second confirmation on \/app\/vault\/arc: a deploy that stopped before that, or a deploy on Arc Testnet, is not counted\./)
  assert.equal(ARC_GAS_SUPPORT.owners, 0)
  assert.match(note, new RegExp(`None has so far, as read from that wallet's sends on ${ARC_GAS_SUPPORT.readOn}, and any such transfer is public on chain`))
  // The zero state says it as well, so it is true however the report is read.
  const empty = await arcSeasonReport(deps({}))
  assert.match(empty.milestone1.vaults.note, /A vault counts once its agent key has an end date/)
  assert.match(empty.milestone1.vaults.note, /None has so far, as read from that wallet's sends/)
})

test('the roadmap claims only the key comparison for a counted vault, as the season note does', () => {
  const roadmap = readFileSync(new URL('../../src/lib/roadmap.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(roadmap, /one we never held/)
  assert.equal(roadmap.split('a vault counts only when its owner key is none of the keys of ours it was compared with').length - 1, 1, 'the season report item')
  assert.equal(roadmap.split('A vault counts only when its owner key is none of the keys of ours it was compared with').length - 1, 1, 'the M1 item')
  assert.match(roadmap, /the vaults count as their owners deploy them, and \/proof\/arc has the live count and who stands behind it\./)
  // ROADMAP.md is generated from the same data, and check:roadmap fails the build while the two disagree.
  const markdown = readFileSync(new URL('../../ROADMAP.md', import.meta.url), 'utf8').replace(/\s+/g, ' ')
  assert.doesNotMatch(markdown, /one we never held|the five vaults wait on their owners/)
})

test('the M2 rows say what they mean, and the public reference says what it is', async () => {
  const r = await liveShape()
  const m2 = r.milestone2
  assert.match(m2.externalTeamsLive.note, /2 of 2 external teams have paid at least one check on Arc Mainnet from a wallet attributed to them: Slippay, 7 checks from 2 wallets; Trustless Work, 2 checks from 1 wallet\./)
  assert.match(m2.externalTeamsLive.note, /That is all this row means: a team counts once one of its wallets has paid one check, and it says nothing about how much a team uses it\./)
  assert.match(m2.publicReference.note, /Slippay, with its OK, confirmed by our founder on 2026-11-06; Trustless Work, with its own written OK of 2026-11-03\./)
  assert.match(m2.publicReference.note, /The reference is this page and the Milestone 2 report, where each is named as an integration; no other public page is linked here\./)
  // A flow is not claimed for a team that has none.
  assert.match(m2.externalTeamsLive.note, /No named team has run a verify-then-pay flow yet\./)
  const after = r.afterProgram
  assert.deepEqual([after.activeExternalWallets.count, after.activeExternalWallets.target, after.activeExternalWallets.parties], [8, 5, 6])
  assert.equal(after.activeExternalWallets.linkedSummary, "It counts wallets, not parties: 8 wallets, at most 6 parties, because two wallets are linked on chain and Slippay's two wallets are one team.")
  assert.match(after.note, /This number is that window as of this read, not the measurement itself, which starts after 2026-11-13\./)
  assert.ok(after.note.includes(after.activeExternalWallets.linkedSummary))
  assert.match(after.weekly.note, /Active wallets are wallets, not parties: a team or a linked party that pays from two wallets counts twice\./)
})

test('the team row only says no named team has a flow when none has, and an external flow from someone else does not change that', async () => {
  const payer = '0x' + 'a1'.repeat(20)
  const namedPayer = '0x' + 'b2'.repeat(20)
  const partners = [{ wallet: namedPayer, team: 'Named Team', publicReference: false }]
  const stranger = gw({ payer, authNonce: nextNonce(), ts: '2026-11-08T08:50:00.000Z' })
  const named = gw({ payer: namedPayer, authNonce: nextNonce(), ts: '2026-11-08T08:50:00.000Z' })
  const flowOf = (c: GatewaySettlementRecord, by: string) => flow({ checkNonce: c.authNonce, payer: by, at: '2026-11-08T08:51:00.000Z' })
  const onlyStranger = await arcSeasonReport(deps({ partners, gateway: [stranger, named], flows: [flowOf(stranger, payer)] }))
  assert.match(onlyStranger.milestone2.externalTeamsLive.note, /No named team has run a verify-then-pay flow yet\./)
  const teamFlow = await arcSeasonReport(deps({ partners, gateway: [stranger, named], flows: [flowOf(named, namedPayer)] }))
  assert.doesNotMatch(teamFlow.milestone2.externalTeamsLive.note, /No named team has run/)
})

const V6_PAYEE = '0x24427be91913774187b8547071284506767a77c4'
/** One external check, and a flow through vault 0xcB7e...Ed41 opened by it, as its record holds it. */
const v6Flow = (payer: string, payee: string, outcome: 'paid' | 'refused', at = '2026-11-08T08:51:00.000Z') => {
  const check = gw({ payer, authNonce: nextNonce(), ts: '2026-11-08T08:50:00.000Z' })
  const refused = outcome === 'refused' ? { txHash: undefined, evidenceUrl: `https://a-identity.xyz/api/x402/gateway/flows/${check.authNonce}` } : {}
  return { check, flow: flow({ checkNonce: check.authNonce, payer, payee, outcome, vault: V6_VAULT, vaultKeys: { owner: V6_OWNER, operator: V6_OPERATOR }, at, ...refused }) }
}
const externalFlowsOf = async (rows: { check: GatewaySettlementRecord; flow: ArcVerifyThenPayFlow }[], over: Over = {}) =>
  (await arcSeasonReport(deps({ gateway: rows.map((x) => x.check), flows: rows.map((x) => x.flow), now: () => LIVE_READ, ...over }))).milestone2.externalFlows

test('an external flow counts as a payment only when it paid, and one party is said as fact only through the vault keys and a traced link together', async () => {
  // The seven external flows of 2026-11-08 in their shape: the one refused names the vault's owner, and four pay 0x2442...77c4.
  const rows = [
    v6Flow(V6_OPERATOR, V6_OWNER, 'paid', '2026-11-07T22:41:32.000Z'),
    v6Flow(V6_OPERATOR, V6_PAYEE, 'paid', '2026-11-08T08:50:22.000Z'),
    v6Flow(V6_OPERATOR, ARC_OUR_PAYEES[1].address, 'paid', '2026-11-08T08:50:26.000Z'),
    v6Flow(V6_OPERATOR, V6_PAYEE, 'paid', '2026-11-08T08:50:33.000Z'),
    v6Flow(V6_OPERATOR, V6_OWNER, 'refused', '2026-11-08T08:51:29.711Z'),
    v6Flow(V6_OPERATOR, V6_PAYEE, 'paid', '2026-11-08T08:55:37.000Z'),
    v6Flow(V6_OWNER, V6_PAYEE, 'paid', '2026-11-08T09:11:23.000Z'),
  ]
  rows[0].check.ts = '2026-11-07T22:41:28.193Z'
  const ef = await externalFlowsOf(rows, { walletLinks: ARC_WALLET_LINKS })
  assert.deepEqual([ef.count, ef.linked], [7, { paid: 6, refused: 1 }])
  // The first is the vault's agent key paying its owner, and the first traced group holds both, so it is tied both ways.
  assert.deepEqual(ef.items.map((i) => [i.outcome, i.payeeTiedBy]), [
    ['paid', ['vault-keys', 'link']],
    ['paid', ['link']],
    ['paid', undefined],
    ['paid', ['link']],
    ['refused', ['vault-keys', 'link']],
    ['paid', ['link']],
    ['paid', ['link']],
  ])
  assert.deepEqual(ef.items.map((i) => i.payeeTiedToPayer), [true, true, undefined, true, true, true, true])
  assert.deepEqual(ef.items.map((i) => i.payeeInternal), ["the payee is this vault's owner", undefined, ARC_OUR_PAYEES[1].why, undefined, "the payee is this vault's owner", undefined, undefined])
  assert.equal(
    ef.note,
    "7 verify-then-pay flows opened by a check from a wallet A-Identity does not control, by the same linking rules as Milestone 1 and counted apart from it: 6 paid and 1 refused, and a refused flow paid nothing. Of the flows that paid: 1 paid the vault's own owner or operator from a check one of the same vault's keys paid for, and a traced link ties the two, so it is one party paying itself; 4 paid a wallet a traced link ties to the wallet that paid for the check, so they may be one party paying itself; 1 paid one of our own wallets or agents.",
  )
  assert.doesNotMatch(ef.note, /6 of them pay|they are one party|our own agent\./)
  // Without the trace, the same first flow is tied by the vault's keys alone, and that is not said as fact.
  const untraced = await externalFlowsOf(rows.slice(0, 1))
  assert.deepEqual(untraced.items.map((i) => i.payeeTiedBy), [['vault-keys']])
  assert.match(untraced.note, /Of the flows that paid: 1 paid the vault's own owner or operator from a check one of the same vault's keys paid for, and no traced link ties the two, so it may be one party paying itself, since a vault's owner can name anyone's wallet as its operator\.$/)
})

test('a check a stranger paid for ties nothing to the stranger, even when the flow names the vault owner', async () => {
  const STRANGER = '0x' + 'c3'.repeat(20)
  // Anyone can buy a check that names any vault: the payee is still this vault's owner, and the payer is nobody the vault knows.
  const refused = await externalFlowsOf([v6Flow(STRANGER, V6_OWNER, 'refused')])
  assert.equal(refused.items[0].payeeTiedToPayer, undefined)
  assert.equal(refused.items[0].payeeTiedBy, undefined)
  assert.equal(refused.items[0].payeeInternal, "the payee is this vault's owner")
  assert.equal(refused.note, '1 verify-then-pay flow opened by a check from a wallet A-Identity does not control, by the same linking rules as Milestone 1 and counted apart from it: 0 paid and 1 refused, and a refused flow paid nothing.')
  const paid = await externalFlowsOf([v6Flow(STRANGER, V6_OWNER, 'paid'), v6Flow(STRANGER, EXT_B, 'paid')])
  assert.deepEqual(paid.items.map((i) => i.payeeTiedToPayer), [undefined, undefined])
  assert.match(paid.note, /: 2 paid and 0 refused\. Of the flows that paid: 1 paid the vault's own owner or operator from a check a wallet outside the vault's keys paid for; 1 paid a wallet that neither the vault's keys nor a traced link ties to the wallet that paid for the check\.$/)
  assert.doesNotMatch(paid.note, /one party/)
  // A link ties a payee only to a payer in the same group: a stranger paying a linked wallet is not that party.
  const toLinked = await externalFlowsOf([v6Flow(STRANGER, V6_PAYEE, 'paid')], { walletLinks: ARC_WALLET_LINKS })
  assert.equal(toLinked.items[0].payeeTiedToPayer, undefined)
  assert.doesNotMatch(toLinked.note, /one party/)
})

test("a vault's keys paying each other are one party only when a traced link holds both, because an owner can name anyone's wallet as its operator", async () => {
  // An owner names a merchant's wallet as its vault's operator, buys a check on the vault, and the vault pays the merchant:
  // the two key slots hold two parties, and only a trace can say otherwise.
  const OWNER = '0x' + 'a7'.repeat(20)
  const MERCHANT = '0x' + 'b8'.repeat(20)
  const merchantRow = v6Flow(OWNER, MERCHANT, 'paid')
  merchantRow.flow.vault = '0x' + 'c9'.repeat(20)
  merchantRow.flow.vaultKeys = { owner: OWNER, operator: MERCHANT }
  const merchant = await externalFlowsOf([merchantRow])
  assert.deepEqual(merchant.items.map((i) => [i.payeeTiedToPayer, i.payeeTiedBy, i.payeeInternal]), [[true, ['vault-keys'], "the payee is this vault's operator"]])
  assert.match(merchant.note, /Of the flows that paid: 1 paid the vault's own owner or operator from a check one of the same vault's keys paid for, and no traced link ties the two, so it may be one party paying itself, since a vault's owner can name anyone's wallet as its operator\.$/)
  assert.doesNotMatch(merchant.note, /it is one party|each is one party/)
  // Both ways round, with no trace: each may be one party.
  const both = () => [v6Flow(V6_OWNER, V6_OPERATOR, 'paid'), v6Flow(V6_OPERATOR, V6_OWNER, 'paid')]
  const untraced = await externalFlowsOf(both())
  assert.deepEqual(untraced.items.map((i) => [i.payeeTiedBy, i.payeeInternal]), [
    [['vault-keys'], "the payee is this vault's operator"],
    [['vault-keys'], "the payee is this vault's owner"],
  ])
  assert.match(untraced.note, /Of the flows that paid: 2 paid the vault's own owner or operator from a check one of the same vault's keys paid for, and no traced link ties the two, so they may be one party paying itself, since a vault's owner can name anyone's wallet as its operator\.$/)
  // With the trace that holds the owner and its agent key, each is one party paying itself.
  const traced = await externalFlowsOf(both(), { walletLinks: [ARC_WALLET_LINKS[0]] })
  assert.deepEqual(traced.items.map((i) => i.payeeTiedBy), [['vault-keys', 'link'], ['vault-keys', 'link']])
  assert.match(traced.note, /Of the flows that paid: 2 paid the vault's own owner or operator from a check one of the same vault's keys paid for, and a traced link ties the two, so each is one party paying itself\.$/)
  // A link that holds the payee and some other wallet, and not the payer, ties nothing more: the keys alone still say may be.
  const other = await externalFlowsOf([v6Flow(V6_OWNER, V6_OPERATOR, 'paid')], { walletLinks: [{ ...ARC_WALLET_LINKS[0], wallets: [V6_OPERATOR, V6_PAYEE] }] })
  assert.deepEqual(other.items.map((i) => i.payeeTiedBy), [['vault-keys']])
  assert.match(other.note, /so it may be one party paying itself/)
})

test('an external flow that pays our receiving wallet is said to pay one of our own wallets, not an agent', async () => {
  const OPERATING = '0x' + 'c8'.repeat(20)
  const row = v6Flow(V6_OPERATOR, OPERATING, 'paid')
  row.flow.vaultKeys = undefined
  const ef = await externalFlowsOf([row], { ourPayTo: [OPERATING] })
  assert.equal(ef.items[0].payeeInternal, 'the payee is one of our own wallets')
  assert.match(ef.note, /Of the flows that paid: 1 paid one of our own wallets or agents\.$/)
  // Without the receiving wallet named as ours it is somebody else, and said so.
  const elsewhere = await externalFlowsOf([v6Flow(V6_OPERATOR, OPERATING, 'paid')])
  assert.match(elsewhere.note, /1 paid a wallet that neither the vault's keys nor a traced link ties to the wallet that paid for the check\.$/)
})

test('the page shows the wallet and party counts beside the numbers, and each link with what it rests on', () => {
  const page = readFileSync(new URL('../../src/components/proof/ArcSeasonProgress.tsx', import.meta.url), 'utf8')
  const oneLine = page.replace(/\s+/g, ' ')
  assert.match(page, /<VaultOwnersLine owners=\{m1\.vaults\.owners\} \/>/, 'the page says it, beside the count')
  assert.ok(oneLine.indexOf('metric={m1.vaults} keepNote') < oneLine.indexOf('<VaultOwnersLine') && oneLine.indexOf('<VaultOwnersLine') < oneLine.indexOf('metric={m1.checks}'), 'right under the vault row')
  // The plain sentence comes first, as the row's lead, above the long note.
  assert.match(oneLine, /metric=\{m1\.vaults\} keepNote lead=\{m1\.vaults\.items\.length > 0 \? m1\.vaults\.owners\?\.summary : undefined\}/)
  assert.match(oneLine, /metric=\{m2\.externalChecks\} keepNote lead=\{m2\.externalChecks\.count > 0 \? m2\.externalChecks\.payers\?\.summary : undefined\}/)
  assert.ok(oneLine.indexOf('{lead && <p') > -1 && oneLine.indexOf('{lead && <p') < oneLine.indexOf('{detail && <p') && oneLine.indexOf('{detail && <p') < oneLine.indexOf('metric.note && ('), 'the lead reads first, then the detail, then the note')
  assert.match(page, /<PayersLine payers=\{m2\.externalChecks\.payers\} \/>/)
  assert.ok(oneLine.indexOf('metric={m2.externalChecks} keepNote') < oneLine.indexOf('<PayersLine'), 'right under the checks row')
  assert.match(page, /Traced by hand on \{tracedOn\}, not read live\./)
  assert.match(page, /The \$\{evidence\.length\} transactions behind this link/)
  assert.match(page, /<OutLink href=\{e\.explorerUrl\}>/)
  assert.match(page, /\{report\.linkedWallets && <LinkedWalletsSection data=\{report\.linkedWallets\} \/>\}/)
  assert.match(page, /ours: 'Ours, labeled'/)
  assert.match(page, /disclosed: 'Disclosed'/)
  assert.match(page, /'none-found': 'Looked for and not found'/)
  assert.match(page, /Every group of wallets the trace tied together, outside the named teams' own wallets \(\{data\.groups\.length\}\)/)
  assert.match(page, /linked with \{w\.linkedWith\.map/)
  assert.match(page, /not a team wallet, on the founder's word of 2026-11-06/)
  assert.match(page, /parties=\{m2\.externalChecks\.incomplete \? undefined : m2\.externalChecks\.payers\?\.parties\}/, 'no ceiling from a log that could not be read')
  // A ceiling is shown only when it is a number below the wallets: null from an unread log, or as many parties as wallets, says nothing.
  assert.match(page, /\['Wallets', typeof parties === 'number' && parties < side\.wallets\.length \? `\$\{side\.wallets\.length\}, at most \$\{parties\} parties` : String\(side\.wallets\.length\)\]/)
  // Every M2 row keeps its note: the note says what the row means, and three of them were hidden past zero.
  for (const row of ['m2.externalTeamsLive', 'm2.externalChecks', 'm2.teamActiveOnSeveralDays', 'm2.publicReference']) {
    assert.match(page, new RegExp(`metric=\\{${row.replace('.', '\\.')}\\} keepNote`), row)
  }
  // The after-program note is on the page.
  assert.match(page, /\{report\.afterProgram\.note\}/)
  // A flow row says the reason itself, and the tied label is only on the rows with no other reason.
  assert.match(page, /\(\{f\.payeeInternal\}\)/)
  assert.match(page, /f\.payeeTiedToPayer && <span[^>]*> \(the payee is tied to the wallet that paid for the check\)<\/span>/)
  assert.doesNotMatch(page, /payee is ours/)
  // Each line renders on its own condition, with nothing in front of it, so a section cannot go quiet while a test still passes.
  assert.match(page, /\n {6}\{lead && <p className="[^"]*">\{lead\}<\/p>\}\n/)
  assert.match(page, /\n {14}\{m1\.vaults\.owners && m1\.vaults\.items\.length > 0 && <VaultOwnersLine owners=\{m1\.vaults\.owners\} \/>\}\n/)
  assert.match(page, /\n {14}\{m2\.externalChecks\.payers && m2\.externalChecks\.count > 0 && <PayersLine payers=\{m2\.externalChecks\.payers\} \/>\}\n/)
  assert.match(page, /\n {14}\{m2\.externalFlows && \(\n/)
  assert.match(page, /\n {18}\{m2\.externalFlows\.items\.length > 0 && <FlowList items=\{m2\.externalFlows\.items\} title="External flows, newest first" \/>\}\n/)
  assert.match(page, /\n {10}\{report\.linkedWallets && <LinkedWalletsSection data=\{report\.linkedWallets\} \/>\}\n/)
  assert.match(page, /external wallets active in the last \{after\.windowDays\} days\.\n {10}<\/p>\n {10}<p className="[^"]*">\{report\.afterProgram\.note\}<\/p>\n/)
  // What the trace read, what it found on our side and how far it goes are each on the page, and so is how strong a link is.
  assert.match(page, /\n {6}<p className="[^"]*">\{data\.reads\}<\/p>\n/)
  assert.match(page, /\n {8}\{data\.ourSide\.map\(\(item\) => \(\n/)
  assert.match(page, /\n {8}\{data\.limits\.map\(\(l\) => \(\n/)
  assert.match(page, /\n {8}\{note\} \{confidence\} Traced by hand on \{tracedOn\}, not read live\.\n/)
  assert.match(page, /\n {8}\{w\.identity === 'not-identified' && <span className="[^"]*"> not identified<\/span>\}\n/)
  // A section the prerendered snapshot shows says where the numbers come from, and nothing about the backend being down.
  assert.doesNotMatch(page, /BACKEND_UNREACHABLE/)
  assert.match(page, /load live from GET \/api\/arc\/season, and they have not loaded yet/)
})
