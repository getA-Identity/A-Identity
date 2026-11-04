import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodeFunctionData, toFunctionSelector, type Hex } from 'viem'
import { AgentSpendPolicyAbi } from './contracts/AgentSpendPolicy.js'
import { getChainById } from './chains/index.js'

/**
 * An owner's approval on the vault page: the rules that stand between a link someone sent and a signature
 * that moves real USDC, run from src/ as they ship, the way frontend-arc-vault.test.ts runs the page's
 * other rules. What they RETURN is the guard. The whole path, in a browser against a fork, is in
 * scripts/rehearse-arc-vault-fork.mjs. Every section below is one way this goes wrong.
 */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repo = (rel: string) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8')

type Flow = Record<string, unknown> & { flowId: string; payee: string; amount: bigint; verdictBlock: bigint | null }
type Live = Record<string, unknown>
type Standing = { kind: string; what?: string; why?: string; ageSeconds?: bigint | null; have?: bigint }
type Failure = { code: string; message: string }
type Send = Record<string, unknown> & { flowId: string; payee: string; amount: bigint; tx?: Record<string, unknown> }
type Paid = { to: string; amount: bigint; byOwner: boolean; block: bigint; txHash: string }
type Scan = { from: bigint; through: bigint; paid: Paid[]; short: string | null }
type Rules = {
  HANDOFF_MAX_AGE_SECONDS: bigint
  OWNER_PAY_SELECTOR: string
  REPLACED_WATCH_MS: number
  FROZEN_LINE: string
  ownerPayCalldata: (to: string, amount: bigint) => string
  parseFlow: (raw: unknown) => Flow | null
  standingOf: (f: Flow, live: Live) => Standing
  walletBlock: (w: { account: string | null; chainId: number | null }, live: Live, chainId: number | null) => string | null
  sendStop: (f: Flow, live: Live, w: { account: string | null; chainId: number | null; wantChainId: number | null }, records: Send[]) => Failure | null
  paidAfter: (f: Flow, events: Paid[]) => Paid | null
  holdOf: (s: Send | null | undefined) => { held: boolean; why?: string; hash?: string }
  holdFor: (f: Flow, records: Send[]) => { held: boolean; why?: string }
  hashToPost: (s: Send) => string | null
  afterScan: (s: Send, f: Flow, scan: { from: bigint; paid: Paid[] }, now: number) => Send
  receiptStep: (status: number, body: unknown) => { step: string; waitMs?: number; flowId?: string; code?: string; reason?: string | null }
  budgetEffect: (amount: bigint, live: Live) => { after: bigint; stopsAgent: boolean; overBy: bigint; leftForAgent: bigint | null }
  budgetLine: (amount: bigint, live: Live) => string
  ownerOnlyLine: (code: unknown, amount: bigint, live: Live) => string | null
  ownerOnlyStands: (code: unknown, amount: bigint, live: Live) => boolean
  verdictMeaning: (e: string | null, reasons?: string[]) => string
  agePhrase: (s: bigint) => string
  notFromAgentLine: (s: { payer: string; operator: string }) => string
  keyStoppedLine: (s: { payer: string }) => string
  PAID_LOOKBACK_BLOCKS: bigint
  paidBefore: (f: Flow, events: Paid[]) => Paid | null
  joinScans: (held: Scan, fresh: Scan) => Scan | null
  scanStart: (rows: { f: Flow; s: Standing }[], records: Send[], declined: string[], now: number) => bigint | null
  paymentsRead: (f: Flow, scan: Scan | null, failed: string | null) => string
  stillWatched: (r: Send | null, now: number) => boolean
  RELEASE_WATCH_MS: number
  ANSWER_SHOWN_MS: number
  holdsPage: (r: Send) => boolean
  unreadRecords: (records: Send[], flowIds: string[], now: number) => Send[]
  cardHeading: (s: Standing, o: { sent: boolean; held: boolean; paid: boolean }) => { heading: string; asks: boolean }
}
const rules = async () => (await import(repoUrl('src/lib/arc/handoff-rules.ts').href)) as Rules

type Pending = {
  loadHandoffs: (network: string, vault: string) => Send[]
  saveHandoff: (r: Send) => void
  clearHandoff: (network: string, vault: string, flowId: string) => void
  loadDeclined: (network: string, vault: string) => string[]
  saveDeclined: (network: string, vault: string, flowId: string, declined: boolean) => void
  claimHandoff: (r: Send, refused: (rs: Send[]) => boolean, locks?: { request: <T>(name: string, fn: () => T) => Promise<T> } | null) => Promise<boolean>
}
const pending = async () => (await import(repoUrl('src/lib/arc/pending.ts').href)) as Pending

const arc = getChainById('arc-mainnet')!
const NETWORK = arc.caip2
const VAULT = '0x' + 'a1'.repeat(20)
const OWNER = '0x' + 'b2'.repeat(20)
const AGENT = '0x' + 'c3'.repeat(20)
const PAYEE = '0x' + 'd4'.repeat(20)
const STRANGER = '0x' + '99'.repeat(20)
const FLOW = '0x' + 'ab'.repeat(32)
const TX = '0x' + '77'.repeat(32)
const TX2 = '0x' + '78'.repeat(32)
const AMOUNT = 500_000n
const CHECKED = '2026-11-04T10:00:00.000Z'
const CHECKED_SEC = BigInt(Date.parse(CHECKED) / 1000)
const CHAIN_ID = arc.evmChainId as number

const encode = (to: string, amount: bigint) => encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'ownerPay', args: [to as Hex, amount] })

/** The record, as GET /api/x402/gateway/flows answers it for a hand-off from the agent. */
function record(over: Record<string, unknown> = {}, check: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    flowId: FLOW,
    network: NETWORK,
    createdAt: CHECKED,
    updatedAt: CHECKED,
    vault: VAULT,
    owner: OWNER,
    operator: AGENT,
    payee: PAYEE,
    payeeAgentId: null,
    asset: '0x' + 'e5'.repeat(20),
    amount: AMOUNT.toString(),
    amountUsd: 0.5,
    check: { authNonce: FLOW, transferId: 't', gatewayOutcome: 'credited', payer: AGENT, value: '5000', tool: 'risk_check', checkedAt: CHECKED, checkedAtBlock: '90', verdictBlock: '100', ...check },
    verdict: { decision: 'WARN', effective: 'WARN', risk: 'medium', reasons: ['we hold no record of this address'], reputationScore: 60, agentId: PAYEE, checkedAt: CHECKED },
    payOnWarn: false,
    prepared: { from: OWNER, to: VAULT, data: encode(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] },
    outcome: 'awaiting_human',
    detail: 'warn_handoff',
    ...over,
  }
}

const live = (over: Live = {}): Live => ({
  network: NETWORK,
  address: VAULT,
  owner: OWNER,
  operator: AGENT,
  balance: 1_000_000n,
  chainTime: CHECKED_SEC + 3600n,
  decimals: 6,
  knownBuild: true,
  usdcMatches: true,
  dailyCap: 1_000_000n,
  spentToday: 0n,
  autoApproveMax: 250_000n,
  allowlistEnabled: true,
  expired: false,
  ...over,
})

async function flow(over: Record<string, unknown> = {}, check: Record<string, unknown> = {}): Promise<Flow> {
  const f = (await rules()).parseFlow(record(over, check))
  assert.ok(f, 'the record parses')
  return f
}

const WALLET = { account: OWNER, chainId: CHAIN_ID, wantChainId: CHAIN_ID }
const send = (over: Partial<Send> = {}): Send => ({ v: 1, network: NETWORK, vault: VAULT, flowId: FLOW, payee: PAYEE, amount: AMOUNT, from: OWNER, askedAt: CHECKED, token: 'tab-a', ...over })
const txRecord = (outcome: string, over: Record<string, unknown> = {}) => ({ hash: TX, action: 'ownerPay', what: 'Pay', network: NETWORK, from: OWNER, vault: VAULT, submittedAt: CHECKED, expect: [], outcome, ...over })

// ── what is signed is what is shown ───────────────────────────────────────────────

test('the one encoder the page has is the contract\'s ownerPay, byte for byte, whatever the case of the address', async () => {
  const r = await rules()
  assert.equal(r.OWNER_PAY_SELECTOR, toFunctionSelector('ownerPay(address,uint256)'))
  for (const [to, amount] of [
    [PAYEE, 1n],
    [PAYEE, AMOUNT],
    ['0x03f1fb189E461B88f3e8bA7100B29B594E5f98A9', 2n ** 256n - 1n],
    ['0x0000000000000000000000000000000000000001', 0n],
  ] as [string, bigint][]) {
    assert.equal(r.ownerPayCalldata(to, amount), encode(to, amount))
  }
  assert.throws(() => r.ownerPayCalldata('not an address', 1n), RangeError)
  assert.throws(() => r.ownerPayCalldata(PAYEE, -1n), RangeError)
  assert.throws(() => r.ownerPayCalldata(PAYEE, 2n ** 256n), RangeError)
  // The browser's own copy of the ABI has the same function, so this cannot drift from what the page reads.
  assert.match(repo('src/lib/contracts/agent-spend-policy.ts'), /"?name"?: ?"ownerPay"/)
})

test('a hand-off from the agent, fresh, on a vault that can pay it, can be approved', async () => {
  const r = await rules()
  assert.deepEqual(r.standingOf(await flow(), live()), { kind: 'approvable' })
  assert.equal(r.sendStop(await flow(), live(), WALLET, []), null)
})

for (const [what, over, finds] of [
  ['the record prepared another payee', { prepared: { from: OWNER, to: VAULT, data: encode(STRANGER, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } }, /not ownerPay of the payee/],
  ['the record prepared another amount', { prepared: { from: OWNER, to: VAULT, data: encode(PAYEE, AMOUNT + 1n), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } }, /not ownerPay of the payee/],
  ['the arguments are not what it describes', { prepared: { from: OWNER, to: VAULT, data: encode(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [STRANGER, AMOUNT.toString()] } }, /arguments/],
  ['the call goes to another contract', { prepared: { from: OWNER, to: STRANGER, data: encode(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } }, /not to this vault/],
  ['the call is from another key', { prepared: { from: STRANGER, to: VAULT, data: encode(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } }, /not from the vault's owner/],
  ['the call is pay()', { prepared: { from: OWNER, to: VAULT, data: encode(PAYEE, AMOUNT), function: 'pay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } }, /not ownerPay/],
  ['no call was prepared', { prepared: null }, /no prepared call/],
  ['the record names another owner than the chain', { owner: STRANGER }, /the chain says/],
] as [string, Record<string, unknown>, RegExp][]) {
  test(`${what}: no action`, async () => {
    const r = await rules()
    const s = r.standingOf(await flow(over), live())
    assert.equal(s.kind, 'record_differs')
    assert.match(String(s.what), finds)
    assert.equal(r.sendStop(await flow(over), live(), WALLET, [])?.code, 'handoff_changed')
  })
}

test('a check never pinned to a block gets no action: no receipt could ever close it', async () => {
  const r = await rules()
  const s = r.standingOf(await flow({}, { verdictBlock: null }), live())
  assert.equal(s.kind, 'record_differs')
  assert.match(String(s.what), /never pinned/)
})

test('owner() and the balance are read from the chain and never from the record', async () => {
  const r = await rules()
  const f = await flow({ owner: OWNER })
  assert.equal(r.walletBlock({ account: OWNER, chainId: CHAIN_ID }, live(), CHAIN_ID), null)
  // The record says this key is the owner. The chain says otherwise, so it is not.
  assert.equal(r.sendStop(f, live({ owner: STRANGER }), WALLET, [])?.code, 'handoff_changed')
  assert.equal(r.standingOf(f, live({ balance: AMOUNT - 1n })).kind, 'no_balance')
  assert.equal(r.standingOf(f, live({ balance: AMOUNT })).kind, 'approvable')
  assert.equal(r.sendStop(f, live({ balance: 0n }), WALLET, [])?.code, 'handoff_no_balance')
})

test('the connected wallet has to be the owner, on the registry\'s chain, or there is no action', async () => {
  const r = await rules()
  const f = await flow()
  assert.equal(r.sendStop(f, live(), { account: null, chainId: CHAIN_ID, wantChainId: CHAIN_ID }, [])?.code, 'no_wallet')
  assert.equal(r.sendStop(f, live(), { account: AGENT, chainId: CHAIN_ID, wantChainId: CHAIN_ID }, [])?.code, 'account_mismatch')
  assert.equal(r.sendStop(f, live(), { account: OWNER, chainId: 1, wantChainId: CHAIN_ID }, [])?.code, 'wrong_chain')
  assert.equal(r.sendStop(f, live(), { account: OWNER, chainId: null, wantChainId: CHAIN_ID }, [])?.code, 'wrong_chain')
  assert.equal(r.sendStop(f, live(), { account: OWNER, chainId: CHAIN_ID, wantChainId: null }, [])?.code, 'wrong_chain')
  assert.equal(r.sendStop(f, live(), { account: OWNER.toUpperCase().replace('0X', '0x'), chainId: CHAIN_ID, wantChainId: CHAIN_ID }, []), null, 'the same address in capitals')
})

test('a vault this page does not build calls for gets no action, however good the record looks', async () => {
  const r = await rules()
  assert.equal(r.sendStop(await flow(), live({ knownBuild: false }), WALLET, [])?.code, 'not_this_build')
  assert.equal(r.sendStop(await flow(), live({ usdcMatches: false }), WALLET, [])?.code, 'not_this_build')
})

// ── phishing ──────────────────────────────────────────────────────────────────────

test("a stranger's check on someone else's vault looks like any other record and gets no action, named as what it is", async () => {
  const r = await rules()
  const f = await flow({}, { payer: STRANGER })
  const s = r.standingOf(f, live())
  assert.deepEqual(s, { kind: 'not_from_agent', payer: STRANGER, operator: AGENT })
  const stop = r.sendStop(f, live(), WALLET, [])
  assert.equal(stop?.code, 'handoff_not_from_agent')
  const said = r.notFromAgentLine({ payer: STRANGER, operator: AGENT })
  assert.ok(said.includes(STRANGER) && said.includes(AGENT))
  assert.match(said, /cannot show that it came from your agent/)
  assert.doesNotMatch(said, /did not come from your agent/, 'it knows who paid, not who asked: a separate payer key reads this way too')
  assert.match(said, /Do not send money/)
  assert.doesNotMatch(said, new RegExp(PAYEE), 'it does not put the payee on screen')
})

test("a key that was replaced does not keep its requests: the agent's key is the one on chain now", async () => {
  const r = await rules()
  // Paid by the operator of the moment, and the owner has since replaced that key, perhaps because it leaked.
  assert.equal(r.standingOf(await flow(), live({ operator: STRANGER })).kind, 'not_from_agent')
})

test('a key that paid before it was made the operator is not the agent asking either', async () => {
  const r = await rules()
  // Paid while another key was the operator; that key is the operator now. Both have to agree.
  assert.equal(r.standingOf(await flow({ operator: STRANGER }, { payer: AGENT }), live()).kind, 'not_from_agent')
})

test('a check Gateway never settled is not a check anyone paid for', async () => {
  const r = await rules()
  assert.equal(r.standingOf(await flow({}, { gatewayOutcome: 'none' }), live()).kind, 'not_from_agent')
  assert.equal(r.standingOf(await flow({}, { gatewayOutcome: 'completed' }), live()).kind, 'approvable')
})

test('a link to a flow on another vault or another network gets no action on this vault', async () => {
  const r = await rules()
  assert.equal(r.standingOf(await flow({ vault: STRANGER }), live()).kind, 'not_this_vault')
  assert.equal(r.standingOf(await flow({ network: 'eip155:1' }), live()).kind, 'not_this_vault')
  assert.equal(r.sendStop(await flow({ vault: STRANGER }), live(), WALLET, [])?.code, 'handoff_ended')
})

test('a vault with one key has no person behind an approval, and a payment to the agent\'s own key is not offered', async () => {
  const r = await rules()
  assert.equal(r.standingOf(await flow({ owner: AGENT, prepared: { from: AGENT, to: VAULT, data: encode(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } }), live({ owner: AGENT })).kind, 'no_human')
  const toAgent = { payee: AGENT, prepared: { from: OWNER, to: VAULT, data: encode(AGENT, AMOUNT), function: 'ownerPay(address,uint256)', args: [AGENT, AMOUNT.toString()] } }
  assert.equal(r.standingOf(await flow(toAgent), live()).kind, 'pays_agent')
})

// ── DENY and refused flows ────────────────────────────────────────────────────────

for (const [what, over, kind] of [
  ['a DENY', { outcome: 'blocked', detail: 'deny', prepared: null, verdict: { decision: 'DENY', effective: 'DENY', reasons: ['revoked'] } }, 'refused'],
  ['an answer that could not be used', { outcome: 'blocked', detail: 'verdict_unusable' }, 'refused'],
  ['a WARN on a vault with no human', { outcome: 'blocked', detail: 'warn_no_human_gate' }, 'refused'],
  ['a record that says it waits and carries a DENY', { verdict: { decision: 'DENY', effective: 'DENY', reasons: [] } }, 'refused'],
  ['a record that says it waits and carries no verdict', { verdict: null }, 'refused'],
  ['a verdict our checks overrode', { verdict: { decision: 'ALLOW', effective: 'DENY', reasons: [], overriddenBecause: 'X' } }, 'refused'],
  ['an answer whose decision and effective decision differ', { verdict: { decision: 'DENY', effective: 'WARN', reasons: [] } }, 'refused'],
  ['a flow the agent sends itself', { outcome: 'pending', detail: 'agent_will_pay' }, 'not_the_owners'],
  ['a reverted call', { outcome: 'failed', detail: 'reverted_not_policy', payment: { txHash: TX, status: 'reverted', revertReason: 'out of gas' } }, 'reverted'],
  ['a settled payment', { outcome: 'executed', detail: 'owner_paid', payment: { txHash: TX, status: 'success', blockNumber: '120', byOwner: true } }, 'settled'],
] as [string, Record<string, unknown>, string][]) {
  test(`${what} never gets an action`, async () => {
    const r = await rules()
    const f = await flow(over)
    assert.equal(r.standingOf(f, live()).kind, kind)
    assert.notEqual(r.sendStop(f, live(), WALLET, []), null)
  })
}

test('an ALLOW on a payment only the owner can make can be approved, and says why it is the owner\'s', async () => {
  const r = await rules()
  const f = await flow({ detail: 'owner_only_handoff', ownerOnly: 'AboveAutoApprove', verdict: { decision: 'ALLOW', effective: 'ALLOW', reasons: ['strong'] } })
  assert.equal(r.standingOf(f, live()).kind, 'approvable')
  assert.match(String(r.ownerOnlyLine(f.ownerOnly, AMOUNT, live())), /cannot pay this itself.*0\.25 USDC.*Only you can/)
  assert.match(String(r.ownerOnlyLine('PayeeNotAllowed', AMOUNT, live())), /not on the vault's allowlist/)
  assert.equal(r.ownerOnlyLine(null, AMOUNT, live()), null)
})

test('the line about who can pay reads the limits as they are now, so it does not call a payment above a limit it is under', async () => {
  const r = await rules()
  // A 0.5 USDC request, and the owner has raised the 0.25 ceiling to 1 USDC since the check.
  const raised = String(r.ownerOnlyLine('AboveAutoApprove', AMOUNT, live({ autoApproveMax: 1_000_000n })))
  assert.doesNotMatch(raised, /above the/)
  assert.match(raised, /limits have changed since/)
  assert.equal(r.ownerOnlyStands('AboveAutoApprove', AMOUNT, live({ autoApproveMax: 1_000_000n })), false)
  // 0 means no ceiling at all.
  assert.match(String(r.ownerOnlyLine('AboveAutoApprove', AMOUNT, live({ autoApproveMax: 0n }))), /limits have changed since/)
  assert.equal(r.ownerOnlyStands('AboveAutoApprove', AMOUNT, live()), true)
  // The allowlist turned off. A single entry is not read here, so it does not claim one way or the other.
  assert.match(String(r.ownerOnlyLine('PayeeNotAllowed', AMOUNT, live({ allowlistEnabled: false }))), /limits have changed since/)
  assert.match(String(r.ownerOnlyLine('PayeeNotAllowed', AMOUNT, live())), /When your agent checked this.*If that is still so/)
})

test('a request from a key that was revoked or ran out gets no action, and does not read as the agent asking', async () => {
  const r = await rules()
  const f = await flow()
  // Revoke writes an expiry of 1, leaves the operator as it was, and the page reads expired from the chain.
  assert.deepEqual(r.standingOf(f, live({ expired: true })), { kind: 'key_stopped', payer: AGENT })
  assert.equal(r.sendStop(f, live({ expired: true }), WALLET, [])?.code, 'handoff_key_stopped')
  const said = r.keyStoppedLine({ payer: AGENT })
  assert.ok(said.includes(AGENT))
  assert.match(said, /revoked or has run out/)
  assert.doesNotMatch(said, new RegExp(PAYEE), 'it does not put the payee on screen')
  // A stranger's check is named as that first, whatever the key's state.
  assert.equal(r.standingOf(await flow({}, { payer: STRANGER }), live({ expired: true })).kind, 'not_from_agent')
  // A finished flow says so first too.
  assert.equal(r.standingOf(await flow({ outcome: 'executed', detail: 'owner_paid', payment: { txHash: TX, status: 'success', blockNumber: '120', byOwner: true } }), live({ expired: true })).kind, 'settled')
  // Frozen is another act: ownerPay works by design, so it stays open and the line says whose request it is.
  assert.equal(r.standingOf(f, live({ frozen: true })).kind, 'approvable')
  assert.match(r.FROZEN_LINE, /this request came from that key/)
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /This came from a key that has since been stopped/)
})

test('the card asks only while it can be approved, and not once something was sent', async () => {
  const r = await rules()
  const none = { sent: false, held: false, paid: false }
  assert.deepEqual(r.cardHeading({ kind: 'approvable' }, none), { heading: 'Your agent asks you to pay this', asks: true })
  assert.equal(r.cardHeading({ kind: 'no_balance', have: 0n }, none).asks, true)
  assert.deepEqual(r.cardHeading({ kind: 'approvable' }, { sent: true, held: true, paid: false }), { heading: 'What this browser sent for this request', asks: false })
  assert.equal(r.cardHeading({ kind: 'approvable' }, { sent: false, held: false, paid: true }).asks, false)
  assert.equal(r.cardHeading({ kind: 'stale', ageSeconds: 90_000n }, none).asks, false)
  // The budget line, what it would leave and the rest sit behind that.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.ok(page.indexOf('{asks && (') < page.indexOf('{budgetLine(flow.amount, vault)}'))
})

// ── staleness ─────────────────────────────────────────────────────────────────────

test('a check is offered for 24 hours by the chain\'s clock, and not a second past it', async () => {
  const r = await rules()
  assert.equal(r.HANDOFF_MAX_AGE_SECONDS, 86_400n)
  const f = await flow()
  assert.equal(r.standingOf(f, live({ chainTime: CHECKED_SEC + 86_400n })).kind, 'approvable')
  const past = r.standingOf(f, live({ chainTime: CHECKED_SEC + 86_401n }))
  assert.deepEqual(past, { kind: 'stale', ageSeconds: 86_401n })
  assert.equal(r.sendStop(f, live({ chainTime: CHECKED_SEC + 86_401n }), WALLET, [])?.code, 'handoff_stale')
})

test('a check whose time cannot be read, or that is from the future, is not fresh', async () => {
  const r = await rules()
  assert.deepEqual(r.standingOf(await flow({}, { checkedAt: 'soon' }), live()), { kind: 'stale', ageSeconds: null })
  assert.equal(r.standingOf(await flow(), live({ chainTime: CHECKED_SEC - 600n })).kind, 'stale')
  // A few minutes either way is two clocks disagreeing, not a check from the future.
  assert.equal(r.standingOf(await flow(), live({ chainTime: CHECKED_SEC - 60n })).kind, 'approvable')
})

// ── double payment ────────────────────────────────────────────────────────────────

const PAID = (over: Partial<Paid> = {}): Paid => ({ to: PAYEE, amount: AMOUNT, byOwner: true, block: 150n, txHash: TX2, ...over })
/** A read of the vault's payments that came down to the block just above this file's check, which is 100. */
const read = (paid: Paid[], from = 101n) => ({ from, paid })

test('a payment of this amount to this payee after this check is this check\'s, whoever sent it', async () => {
  const r = await rules()
  const f = await flow()
  assert.equal(r.paidAfter(f, [PAID()])?.txHash, TX2)
  assert.equal(r.paidAfter(f, [PAID({ to: PAYEE.toUpperCase().replace('0X', '0x') })])?.txHash, TX2, 'in any case')
  assert.equal(r.paidAfter(f, [PAID({ byOwner: false })])?.byOwner, false, 'the agent paid it itself')
  assert.equal(r.paidAfter(f, [PAID({ byOwner: false, txHash: TX }), PAID()])?.txHash, TX2, "the owner's is the one a receipt can close")
  for (const other of [PAID({ block: 100n }), PAID({ block: 99n }), PAID({ amount: AMOUNT + 1n }), PAID({ to: STRANGER })]) assert.equal(r.paidAfter(f, [other]), null, JSON.stringify({ ...other, amount: String(other.amount), block: String(other.block) }))
  assert.equal(r.paidAfter(await flow({}, { verdictBlock: null }), [PAID()]), null)
})

test('a hash holds the flow until it has a final answer, and each kind of answer is read for what it is', async () => {
  const r = await rules()
  assert.deepEqual(r.holdOf(null), { held: false })
  assert.equal(r.holdOf(send()).why, 'asked', 'the wallet was asked and no hash came back')
  assert.equal(r.holdOf(send({ tx: txRecord('pending') })).why, 'pending')
  assert.equal(r.holdOf(send({ tx: txRecord('settled') })).why, 'landed')
  assert.equal(r.holdOf(send({ tx: txRecord('reverted') })).why, 'landed')
  assert.equal(r.holdOf(send({ tx: txRecord('unexpected') })).why, 'landed')
  // A wallet's speed-up is what 'replaced' usually means, so it is not an answer yet.
  assert.equal(r.holdOf(send({ tx: txRecord('replaced') })).why, 'maybe')
  assert.equal(r.holdOf(send({ tx: txRecord('untracked') })).why, 'maybe', 'it may still land')
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })).why, 'answered')
  assert.equal(r.holdOf(send({ tx: txRecord('replaced'), paidBy: TX2 })).why, 'landed')
  // What frees a flow: the chain shows the replacement paid nothing, or the person checked.
  assert.deepEqual(r.holdOf(send({ tx: txRecord('replaced'), replacedClear: true })), { held: false })
  assert.deepEqual(r.holdOf(send({ tx: txRecord('untracked'), released: true })), { held: false })
  assert.deepEqual(r.holdOf(send({ released: true })), { held: false })
})

test('a second send is refused while the first has no answer, for this flow and for a same-looking one', async () => {
  const r = await rules()
  const f = await flow()
  const other = '0x' + 'cd'.repeat(32)
  assert.equal(r.sendStop(f, live(), WALLET, [send({ tx: txRecord('pending') })])?.code, 'handoff_held')
  // A second check of the same invoice is no reason to pay it while the first may still land.
  assert.equal(r.holdFor(f, [send({ flowId: other, tx: txRecord('pending') })]).held, true)
  assert.equal(r.sendStop(f, live(), WALLET, [send({ flowId: other, tx: txRecord('untracked') })])?.code, 'handoff_held')
  // Another payee or amount is another payment. And a send that got its answer is over: a new check is how a second payment is meant to happen.
  assert.equal(r.holdFor(f, [send({ flowId: other, payee: STRANGER, tx: txRecord('pending') })]).held, false)
  assert.equal(r.holdFor(f, [send({ flowId: other, amount: AMOUNT + 1n, tx: txRecord('pending') })]).held, false)
  assert.equal(r.holdFor(f, [send({ flowId: other, tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId: other, at: CHECKED } })]).held, false)
})

test("a wallet's speed-up: the replaced hash finds its payment on chain, and that hash is what the server is asked about", async () => {
  const r = await rules()
  const f = await flow()
  const replaced = send({ tx: txRecord('replaced') })
  const found = r.afterScan(replaced, f, read([PAID()]), Date.now())
  assert.equal(found.paidBy, TX2)
  assert.equal(r.hashToPost(found), TX2)
  assert.equal(r.holdOf(found).why, 'landed', 'still held until the server answers')
  // The same for a hash the page never saw again, and for a wallet that never gave one back.
  assert.equal(r.afterScan(send({ tx: txRecord('untracked') }), f, read([PAID()]), Date.now()).paidBy, TX2)
  assert.equal(r.afterScan(send(), f, read([PAID()]), Date.now()).paidBy, TX2)
})

test('a cancel: a replaced hash with no payment is freed only by a read well after it, and an untracked one never by itself', async () => {
  const r = await rules()
  const f = await flow()
  const t0 = Date.parse('2026-11-04T12:00:00Z')
  const first = r.afterScan(send({ tx: txRecord('replaced') }), f, read([]), t0)
  assert.equal(r.holdOf(first).held, true, 'a host can lag by 50 seconds, so one read decides nothing')
  assert.equal(r.holdOf(r.afterScan(first, f, read([]), t0 + r.REPLACED_WATCH_MS - 1)).held, true)
  assert.deepEqual(r.holdOf(r.afterScan(first, f, read([]), t0 + r.REPLACED_WATCH_MS)), { held: false })
  const untracked = send({ tx: txRecord('untracked') })
  assert.equal(r.holdOf(r.afterScan(untracked, f, read([]), t0 + 3_600_000)).why, 'maybe', 'it may still land, and only the person can say otherwise')
  assert.equal(r.holdOf(r.afterScan(send(), f, read([]), t0 + 3_600_000)).why, 'asked')
  // The agent's own payment is not this send's.
  assert.equal(r.afterScan(send(), f, read([PAID({ byOwner: false })]), t0).paidBy, undefined)
  // A pending hash has its own watch in tx-rules.ts, and an answered one is over.
  const pendingOne = send({ tx: txRecord('pending') })
  assert.equal(r.afterScan(pendingOne, f, read([PAID()]), t0), pendingOne)
})

test('a read that never reached the check frees nothing, and says nothing about a replaced hash', async () => {
  const r = await rules()
  const f = await flow()
  const t0 = Date.parse('2026-11-04T12:00:00Z')
  const seen = send({ tx: txRecord('replaced'), replacedSeenAt: new Date(t0 - r.REPLACED_WATCH_MS * 10).toISOString() })
  // A short read comes back as a read, with no payment in the part it got, and the watch is long over.
  assert.equal(r.afterScan(seen, f, read([], 102n), t0), seen, 'it stopped above the check')
  assert.equal(r.holdOf(r.afterScan(seen, f, read([], 102n), t0)).why, 'maybe')
  // So it does not start the watch either: only a read that reached the check can.
  const unstamped = send({ tx: txRecord('replaced') })
  assert.equal(r.afterScan(unstamped, f, read([], 102n), t0), unstamped)
  // The block right above the check is all a payment could be in, so a read from there is one that reached it.
  assert.deepEqual(r.holdOf(r.afterScan(seen, f, read([], 101n), t0)), { held: false })
  assert.deepEqual(r.holdOf(r.afterScan(seen, f, read([], 50n), t0)), { held: false })
  // A payment it did reach is still that, however short the read.
  assert.equal(r.afterScan(seen, f, read([PAID()], 102n), t0).paidBy, TX2)
  // A check never pinned to a block cannot be compared with anything, so nothing is claimed about it.
  const unpinned = await flow({}, { verdictBlock: null })
  assert.equal(r.afterScan(seen, unpinned, read([], 0n), t0), seen)
  // The page hands it the read's own range, and not only what the read found.
  assert.match(repo('src/components/app/arc/OwnerApprovals.tsx'), /afterScan\(r, f, got, Date\.now\(\)\)/)
})

test('"nothing was sent" frees a flow and proves nothing: if the payment shows up after that, it is this send', async () => {
  const r = await rules()
  const f = await flow()
  const t0 = Date.parse('2026-11-04T12:00:00Z')
  const released = send({ released: true, releasedAt: new Date(t0).toISOString() })
  assert.deepEqual(r.holdOf(released), { held: false })
  const found = r.afterScan(released, f, read([PAID()]), t0 + 1000)
  assert.equal(found.paidBy, TX2)
  assert.equal(r.holdOf(found).why, 'landed', 'held again, until the server answers')
  assert.equal(r.hashToPost(found), TX2, 'and the receipt goes to the server')
  // The same for a hash this page was told about, and for a replacement read as a cancel.
  assert.equal(r.afterScan(send({ tx: txRecord('untracked'), released: true }), f, read([PAID()]), t0).paidBy, TX2)
  assert.equal(r.afterScan(send({ tx: txRecord('replaced'), replacedClear: true }), f, read([PAID()]), t0).paidBy, TX2)
  // The agent's own payment is not this send's, and no payment leaves it freed.
  assert.equal(r.afterScan(released, f, read([PAID({ byOwner: false })]), t0), released)
  assert.equal(r.afterScan(released, f, read([]), t0), released)
  // The page keeps looking for a while after a release, and not for ever.
  assert.equal(r.stillWatched(released, t0 + r.RELEASE_WATCH_MS - 1), true)
  assert.equal(r.stillWatched(released, t0 + r.RELEASE_WATCH_MS), false)
  assert.equal(r.stillWatched(send({ tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } }), t0), false, 'an answer is over')
  assert.equal(r.stillWatched(send(), t0), true)
  assert.equal(r.stillWatched(null, t0), false)
})

test('a payment in the hours before a check is named beside the button, and it stops nothing', async () => {
  const r = await rules()
  const f = await flow({}, { verdictBlock: '100000' })
  assert.equal(r.paidBefore(f, [PAID({ block: 99_000n })])?.txHash, TX2)
  assert.equal(r.paidBefore(f, [PAID({ block: 100_000n })])?.txHash, TX2, 'in the verdict block itself')
  assert.equal(r.paidBefore(f, [PAID({ block: 100_001n })]), null, 'after the check is paidAfter, which does stop it')
  assert.equal(r.paidBefore(f, [PAID({ block: 100_000n - r.PAID_LOOKBACK_BLOCKS })]), null, 'older than the window')
  assert.equal(r.paidBefore(f, [PAID({ block: 99_000n, amount: AMOUNT + 1n })]), null)
  assert.equal(r.paidBefore(f, [PAID({ block: 99_000n, to: STRANGER })]), null)
  assert.equal(r.paidBefore(f, [PAID({ block: 90_000n, txHash: TX }), PAID({ block: 99_000n })])?.txHash, TX2, 'the newest')
  assert.equal(r.paidBefore(await flow({}, { verdictBlock: null }), [PAID()]), null)
  assert.equal(r.sendStop(f, live(), WALLET, []), null, 'and nothing here stops a send: a new check is how a second payment is meant to happen')
  assert.equal(r.PAID_LOOKBACK_BLOCKS, 43_200n)
})

test('a flow nobody can act on does not reach the read of the vault, and a read that stops short answers for what it reached', async () => {
  const r = await rules()
  const old = '0x' + '0a'.repeat(32)
  const fresh = '0x' + '0b'.repeat(32)
  const head = 5_000_000n
  // Older than the page's 120 windows, 1.2M blocks: nothing reads that far on any open.
  const oldBlock = head - 1_300_000n
  const freshBlock = head - 100n
  const aged = await flow({ flowId: old }, { authNonce: old, verdictBlock: oldBlock.toString() })
  const ok = await flow({ flowId: fresh }, { authNonce: fresh, verdictBlock: freshBlock.toString() })
  const start = freshBlock + 1n - r.PAID_LOOKBACK_BLOCKS
  const rows = (s: Standing) => [{ f: aged, s }, { f: ok, s: { kind: 'approvable' } }]
  for (const s of [{ kind: 'stale', ageSeconds: 800_000n }, { kind: 'not_from_agent' }, { kind: 'not_this_vault', why: 'x' }, { kind: 'key_stopped' }, { kind: 'refused', why: 'x' }, { kind: 'record_differs', what: 'x' }, { kind: 'no_balance', have: 0n }] as Standing[]) {
    assert.equal(r.scanStart(rows(s), [], [], 0), start, s.kind)
  }
  // Said no to: nothing is offered, so nothing is read for it.
  assert.equal(r.scanStart([{ f: ok, s: { kind: 'approvable' } }], [], [fresh], 0), null)
  // What this browser sent is followed, however old, from the check and no further.
  const followed = r.scanStart(rows({ kind: 'stale', ageSeconds: 800_000n }), [send({ flowId: old, tx: txRecord('untracked') })], [], 0)
  assert.equal(followed, oldBlock + 1n)
  // An answered send is not followed.
  assert.equal(r.scanStart(rows({ kind: 'stale', ageSeconds: 800_000n }), [send({ flowId: old, tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId: old, at: CHECKED } })], [], 0), start)
  assert.equal(r.scanStart([], [], [], 0), null)
  // So the read stopping short costs only the flow it did not reach: one card, not the page.
  const short: Scan = { from: head - 1_200_000n, through: head, paid: [], short: 'the read stopped before it reached the block it needed' }
  assert.equal(r.paymentsRead(aged, short, null), 'failed')
  assert.equal(r.paymentsRead(ok, short, null), 'ok')
  // A window no host answered: below it not known, above it known.
  const failedLow: Scan = { from: freshBlock - 50n, through: head, paid: [], short: 'rate limited' }
  assert.equal(r.paymentsRead(ok, failedLow, null), 'no_lookback')
  assert.equal(r.paymentsRead(aged, failedLow, null), 'failed')
  // Still reading.
  assert.equal(r.paymentsRead(ok, null, null), 'reading')
  assert.equal(r.paymentsRead(ok, { ...failedLow, short: null }, null), 'reading', 'it has the check, and the hours before it are on their way')
  assert.equal(r.paymentsRead(ok, null, 'nobody answered'), 'failed')
  assert.equal(r.paymentsRead(await flow({}, { verdictBlock: null }), short, null), 'failed')
})

test('two reads join only when nothing lies between them, and a payment read twice is one payment', async () => {
  const r = await rules()
  const one = PAID({ block: 150n })
  const held: Scan = { from: 100n, through: 200n, paid: [one], short: null }
  const on: Scan = { from: 201n, through: 300n, paid: [PAID({ block: 250n, txHash: TX })], short: null }
  const joined = r.joinScans(held, on)
  assert.deepEqual([joined?.from, joined?.through, joined?.paid.length], [100n, 300n, 2])
  assert.equal(r.joinScans(held, { ...on, from: 202n }), null, 'nothing may be claimed about block 201')
  const overlap = r.joinScans(held, { from: 50n, through: 180n, paid: [one], short: 'x' })
  assert.deepEqual([overlap?.from, overlap?.through, overlap?.paid.length, overlap?.short], [50n, 200n, 1, 'x'])
})

test('a hash goes to the server once the chain has an answer, and not before', async () => {
  const r = await rules()
  assert.equal(r.hashToPost(send()), null)
  assert.equal(r.hashToPost(send({ tx: txRecord('pending') })), null)
  assert.equal(r.hashToPost(send({ tx: txRecord('settled') })), TX)
  assert.equal(r.hashToPost(send({ tx: txRecord('reverted') })), TX, 'the server records a revert too')
  assert.equal(r.hashToPost(send({ tx: txRecord('unexpected') })), TX, 'the server is who decides')
  assert.equal(r.hashToPost(send({ tx: txRecord('replaced') })), null)
  assert.equal(r.hashToPost(send({ tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })), null)
})

test('the record survives a reload and a second tab, and of two tabs at one moment only one gets to open a wallet', async () => {
  const p = await pending()
  const r = await rules()
  const vault = '0x' + '11'.repeat(20)
  const claim = (token: string) => send({ vault, flowId: FLOW, token })
  const refused = (f: Flow) => (rs: Send[]) => r.holdFor(f, rs).held
  const f = await flow({ vault })
  // A lock as the browser's would: one at a time.
  let queue = Promise.resolve() as Promise<unknown>
  const locks = {
    request: <T,>(_name: string, fn: () => T) => {
      const run = queue.then(fn)
      queue = run.catch(() => undefined)
      return run as Promise<T>
    },
  }
  const [a, b] = await Promise.all([p.claimHandoff(claim('tab-a'), refused(f), locks), p.claimHandoff(claim('tab-b'), refused(f), locks)])
  assert.deepEqual([a, b], [true, false])
  const held = p.loadHandoffs(NETWORK, vault)
  assert.equal(held.length, 1)
  assert.equal(held[0].token, 'tab-a')
  assert.equal(held[0].amount, AMOUNT, 'BigInts come back as BigInts')
  assert.equal(r.holdOf(held[0]).why, 'asked')
  // The hash goes in, and a page that starts over reads it.
  p.saveHandoff({ ...held[0], tx: txRecord('pending') })
  assert.equal(r.holdFor(f, p.loadHandoffs(NETWORK, vault)).why, 'pending')
  assert.equal(await p.claimHandoff(claim('tab-c'), refused(f), null), false, 'with no Web Locks too')
  // Declined in the wallet: nothing was sent, so nothing is kept, and the flow can be sent again.
  p.clearHandoff(NETWORK, vault, FLOW)
  assert.deepEqual(p.loadHandoffs(NETWORK, vault), [])
  assert.equal(await p.claimHandoff(claim('tab-d'), refused(f), null), true)
  p.clearHandoff(NETWORK, vault, FLOW)
})

test('the server is who says settled: anything else is a retry or a refusal, and is never read as paid', async () => {
  const r = await rules()
  const paid = { verified: true, outcome: 'executed', detail: 'owner_paid', payment: { status: 'success' } }
  assert.equal(r.receiptStep(200, paid).step, 'settled')
  assert.equal(r.receiptStep(200, { ...paid, payment: undefined }).step, 'retry', 'executed with no payment proves nothing')
  assert.equal(r.receiptStep(200, { verified: false, outcome: 'executed' }).step, 'retry')
  assert.equal(r.receiptStep(200, { verified: true, outcome: 'failed', detail: 'reverted_not_policy', reason: 'out of gas' }).step, 'ended')
  assert.equal(r.receiptStep(200, { verified: true, outcome: 'blocked', detail: 'reverted_onchain' }).step, 'ended')
  assert.equal(r.receiptStep(202, { retry: true, code: 'RECEIPT_PENDING' }).step, 'retry')
  assert.equal(r.receiptStep(503, { code: 'RPC_UNREACHABLE', retry: true }).step, 'retry')
  assert.equal(r.receiptStep(0, null).step, 'retry', 'no answer')
  const limited = r.receiptStep(429, { code: 'RATE_LIMITED', retry: true })
  assert.equal(limited.step, 'retry')
  assert.ok((limited.waitMs ?? 0) >= 60_000, 'past the window')
  const moved = r.receiptStep(409, { code: 'TX_ANSWERS_LATER_CHECK', answersFlow: FLOW.toUpperCase().replace('0X', '0x'), reason: 'a later check' })
  assert.deepEqual([moved.step, moved.flowId], ['moved', FLOW])
  assert.equal(r.receiptStep(409, { code: 'TX_ANSWERS_LATER_CHECK', answersFlow: 'somewhere' }).step, 'refused', 'a flow id that is not one is not followed')
  for (const code of ['NO_MATCHING_PAID', 'TX_BEFORE_CHECK', 'AGENT_PAID_ON_HANDOFF', 'TX_LINKED_ELSEWHERE', 'FLOW_ENDED']) {
    const s = r.receiptStep(code === 'NO_MATCHING_PAID' || code === 'TX_BEFORE_CHECK' || code === 'AGENT_PAID_ON_HANDOFF' ? 422 : 409, { code, reason: 'because' })
    assert.deepEqual([s.step, s.code, s.reason], ['refused', code, 'because'])
  }
})

// ── what the person reads ─────────────────────────────────────────────────────────

test('the budget line says it counts toward today and can stop the agent until 00:00 UTC, whatever the numbers', async () => {
  const r = await rules()
  for (const v of [
    { spentToday: 0n, dailyCap: 1_000_000n, decimals: 6 },
    { spentToday: 900_000n, dailyCap: 1_000_000n, decimals: 6 },
    { spentToday: 0n, dailyCap: 0n, decimals: 6 },
  ]) {
    const line = r.budgetLine(AMOUNT, v)
    assert.match(line, /counts toward today's budget/)
    assert.match(line, /00:00 UTC/)
  }
  assert.match(r.budgetLine(AMOUNT, { spentToday: 0n, dailyCap: 1_000_000n, decimals: 6 }), /leaves 0\.5 USDC of the 1 USDC budget/)
  assert.match(r.budgetLine(AMOUNT, { spentToday: 900_000n, dailyCap: 1_000_000n, decimals: 6 }), /will be refused until 00:00 UTC/)
  assert.match(r.budgetLine(AMOUNT, { spentToday: 0n, dailyCap: 0n, decimals: 6 }), /no daily cap/)
})

test('ownerPay adds to the day with no cap check, so an approval can pass the cap and stop the agent', async () => {
  const r = await rules()
  assert.deepEqual(r.budgetEffect(AMOUNT, { spentToday: 800_000n, dailyCap: 1_000_000n }), { after: 1_300_000n, stopsAgent: true, overBy: 300_000n, leftForAgent: 0n })
  assert.equal(r.budgetEffect(AMOUNT, { spentToday: 500_000n, dailyCap: 1_000_000n }).stopsAgent, true, 'exactly the cap leaves nothing the agent can pay')
  assert.equal(r.budgetEffect(AMOUNT, { spentToday: 499_999n, dailyCap: 1_000_000n }).stopsAgent, false)
  // Read off the contract, so this sentence cannot outlive a change there.
  const sol = repo('mcp/contracts/AgentSpendPolicy.sol')
  const body = sol.slice(sol.indexOf('function ownerPay'), sol.indexOf('// ── owner policy controls'))
  assert.match(body, /spentOnDay\[d\] \+= amount/)
  assert.doesNotMatch(body, /dailyCap/)
  assert.doesNotMatch(body, /frozen/, 'and it works while frozen, which the owner is told')
})

test('the owner is told a frozen vault still pays them, and what each verdict means', async () => {
  const r = await rules()
  assert.match(r.FROZEN_LINE, /frozen/)
  assert.match(r.FROZEN_LINE, /You still can/)
  assert.match(r.verdictMeaning('ALLOW'), /^ALLOW/)
  assert.equal(r.agePhrase(30n), 'under a minute')
  assert.equal(r.agePhrase(3600n), '1 hour')
  assert.equal(r.agePhrase(7200n), '2 hours')
  assert.equal(r.agePhrase(172_800n), '2 days')
})

test("what the page says a WARN means follows the scorer's own reasons, so it does not call a payee unknown above evidence against it", async () => {
  const r = await rules()
  const { assessRisk } = (await import('./asp/risk.js')) as typeof import('./asp/risk.js')
  const verdict = (signals: Parameters<typeof assessRisk>[0]) => {
    const out = assessRisk(signals, { amountUsd: 1, payee: PAYEE })
    assert.equal(out.decision, 'WARN', JSON.stringify(out.reasons))
    return r.verdictMeaning('WARN', out.reasons)
  }
  const unknown = verdict({ onchainVerified: false, kyaVerified: false, reputationScore: 0, tenureDays: 0, revoked: false, onPlatform: false })
  assert.match(unknown, /does not mean it is bad, and it does not mean it is clean/)
  const adverse = verdict({ onchainVerified: true, kyaVerified: true, reputationScore: 400, tenureDays: 90, revoked: false, onPlatform: true, adverseRecord: true })
  assert.match(adverse, /holds evidence against this payee/)
  assert.doesNotMatch(adverse, /does not mean it is bad/)
  const sybil = verdict({ onchainVerified: true, kyaVerified: true, reputationScore: 800, tenureDays: 90, revoked: false, sybil: 'medium', onPlatform: true, adverseRecord: false })
  assert.doesNotMatch(sybil, /does not mean it is bad/)
  // A record with nothing against it and a score too low to vouch for: neither unknown nor evidence.
  const thin = verdict({ onchainVerified: true, kyaVerified: true, reputationScore: 100, tenureDays: 90, revoked: false, onPlatform: true, adverseRecord: false })
  assert.match(thin, /we do not vouch for this payment/)
  assert.equal(r.verdictMeaning('DENY'), 'This check did not answer ALLOW or WARN.')
  // Evidence above the lines can sit on an ALLOW too, and the scorer says so in its reasons.
  const above = assessRisk({ onchainVerified: true, kyaVerified: true, reputationScore: 800, tenureDays: 90, revoked: false, onPlatform: true, adverseRecord: true }, { amountUsd: 1, payee: PAYEE })
  assert.equal(above.decision, 'ALLOW')
  assert.match(r.verdictMeaning('ALLOW', above.reasons), /also holds evidence against it/)
  assert.doesNotMatch(r.verdictMeaning('ALLOW', ['Verified on-chain identity, attested KYA, and strong reputation']), /evidence/)
})

test('every stop tells what happened and what to do next, through the same module, and says nothing was sent', async () => {
  const { explainFailure } = (await import(repoUrl('src/lib/arc/failure-explain.ts').href)) as { explainFailure: (f: Failure) => { title: string; next: string; body?: string; tone: string } }
  for (const code of ['handoff_not_from_agent', 'handoff_key_stopped', 'handoff_changed', 'handoff_stale', 'handoff_ended', 'handoff_no_balance', 'handoff_held', 'handoff_already_paid', 'handoff_unreadable']) {
    const told = explainFailure({ code, message: 'because' })
    assert.equal(told.body, 'because', code)
    assert.notEqual(told.title, 'Your wallet stopped the request.', `${code} has its own words`)
    assert.ok(told.next.length > 20, code)
  }
  assert.match(explainFailure({ code: 'handoff_not_from_agent', message: '' }).next, /Do not send money/)
  assert.match(explainFailure({ code: 'handoff_stale', message: '' }).next, /0\.005 USDC/)
  // The amount on a hand-off is fixed, and taking money out does not make a vault hold more.
  const empty = explainFailure({ code: 'handoff_no_balance', message: '' }).next
  assert.doesNotMatch(empty, /take less out/)
  assert.match(empty, /Add USDC to the vault below, then try again\. The amount cannot be changed here/)
})

test('a record the page did not expect is not a flow, and its text stays bounded text', async () => {
  const r = await rules()
  for (const bad of [null, 'x', [], {}, record({ flowId: 'not a hash' }), record({ vault: 'x' }), record({ owner: 7 }), record({ payee: '0x12' }), record({ amount: '0.5' }), record({ amount: -1 }), record({ check: null }), record({}, { payer: 'nobody' })]) {
    assert.equal(r.parseFlow(bad), null, JSON.stringify(bad))
  }
  const hostile = '<img src=x onerror=alert(1)> [click](javascript:alert(1))'
  const f = r.parseFlow(record({ verdict: { decision: 'WARN', effective: 'WARN', reasons: [hostile, 42, 'x'.repeat(5000), ...Array(30).fill('more')] } }))
  const v = f?.verdict as { reasons: string[] }
  assert.equal(v.reasons[0], hostile, 'kept as the text it is')
  assert.equal(v.reasons[1].length, 600)
  assert.ok(v.reasons.length <= 12)
  // A hash in a record has to be a hash before any link is made from it.
  assert.equal(r.parseFlow(record({ payment: { txHash: 'javascript:alert(1)', status: 'success' } }))?.payment, null)
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/)
  assert.doesNotMatch(page, /innerHTML/)
  // Every link on the card comes from the registry's explorer and a checked value, never from a record's field.
  assert.deepEqual([...page.matchAll(/href=\{([^}]+)\}/g)].map((m) => m[1]).sort(), ['href', 'payeeUrl'])
  assert.doesNotMatch(page, /explorerUrl/)
})

test('the page says what it knows about where the money can come from, and nothing more', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.doesNotMatch(page, /It leaves the vault only if you approve it/, 'a WARN within limits is one the operator key could still send')
  assert.match(page, /This page sends nothing without your own wallet/)
  assert.match(page, /one within its limits is one its key could still send by itself/)
  assert.match(page, /\{oursKey \? '' : ' A-Identity holds no key and signs nothing\.'\}/, 'and it does not say so on a vault that is ours')
  assert.match(repo('src/routes/app/ArcVault.tsx'), /oursKey=\{ours \|\| ownerIsOurKey\}/)
  // The review promises what Confirm rechecks, and the fee is not on that list.
  assert.doesNotMatch(page, /if any of it has changed, nothing is sent/)
  assert.match(page, /The network fee can move a little in that time, and your wallet shows the one it will charge/)
})

test('what Confirm sends is held to what Review showed, not to whatever the row reads by now', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  const confirm = page.slice(page.indexOf('const confirm = () =>'), page.indexOf('const working ='))
  assert.match(confirm, /const shown = \{ payee: reviewed\.payee, amount: reviewed\.amount, data: reviewed\.data \}/)
  assert.doesNotMatch(confirm, /shown: \{ payee: flow\.payee/)
  // And what the wallet gets is compared with the call that was reviewed.
  const send = repo('src/lib/arc/handoff-send.ts')
  assert.match(send, /prepared\.data\.toLowerCase\(\) !== o\.shown\.data\.toLowerCase\(\)/)
  // A review of what the record no longer says is gone as soon as the card reads it.
  assert.match(page, /reviewed\.amount === flow\.amount && flow\.prepared\?\.data\.toLowerCase\(\) === reviewed\.data/)
  assert.match(page, /\{reviewed && reviewStands && ready \? \(/)
})

test('a wallet prompt that is open reads as that, and the page does not tell the person not to sign what they have not signed', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /Confirm this in your wallet now/)
  assert.match(page, /!asking && !record\.tx && !record\.paidBy && !record\.released/, 'what the tracker says about no answer waits until nothing in this tab is asking')
  assert.doesNotMatch(page, /Do not sign it again\./)
})

test('a hidden request is hidden from the link too, and a declined network switch is told on the card', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /const fromLink = linked && !hiddenHere\(linked\) \? linked : undefined/)
  assert.ok(page.indexOf('Your wallet is on another network.') < page.indexOf('{wallet.error}'))
})

test('the server having not read a landed payment is said as that, and does not hold the owner\'s own controls', async () => {
  const r = await rules()
  const receipt = repo('src/components/app/arc/TxReceipt.tsx')
  assert.doesNotMatch(receipt, /Our server is reading it/)
  assert.match(receipt, /Our server has not read it yet/)
  assert.equal(r.receiptStep(0, null).reason, 'our server could not be reached')
  assert.equal(r.holdsPage(send()), true, 'the wallet was asked: it may still send')
  assert.equal(r.holdsPage(send({ tx: txRecord('pending') })), true)
  assert.equal(r.holdsPage(send({ tx: txRecord('untracked') })), true, 'it may still land')
  assert.equal(r.holdsPage(send({ tx: txRecord('settled') })), false, 'final on chain, and only our record is outstanding')
  assert.equal(r.holdsPage(send({ tx: txRecord('reverted') })), false)
  assert.equal(r.holdsPage(send({ tx: txRecord('replaced'), paidBy: TX2 })), false)
  // A second send of the same payment still waits for the server's word.
  assert.equal(r.holdFor(await flow(), [send({ tx: txRecord('settled') })]).held, true)
})

test('an answer in this browser has a line of its own, and an old one does not stay as an empty card', async () => {
  const r = await rules()
  const now = Date.parse('2026-11-04T12:00:00Z')
  const answered = (at: number, flowId: string) => send({ flowId, tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId, at: new Date(at).toISOString() } })
  const old = answered(now - r.ANSWER_SHOWN_MS - 1, '0x' + '01'.repeat(32))
  const recent = answered(now - 1000, '0x' + '02'.repeat(32))
  const open = send({ flowId: '0x' + '03'.repeat(32), tx: txRecord('pending') })
  const hasFlow = send({ flowId: '0x' + '04'.repeat(32), tx: txRecord('pending') })
  assert.deepEqual(r.unreadRecords([old, recent, open, hasFlow], [hasFlow.flowId], now).map((x) => x.flowId), [recent.flowId, open.flowId])
  // Freed and unread: nothing to follow.
  assert.deepEqual(r.unreadRecords([send({ released: true })], [], now), [])
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /server\?\.state === 'settled'/)
  assert.match(page, /server\?\.state === 'ended'/)
})

test("a tab left open reads the vault again when it comes back, and after every recheck, and the card's figures come from the newest read", () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /window\.addEventListener\('focus', again\)/)
  assert.match(page, /document\.addEventListener\('visibilitychange', again\)/)
  assert.match(page, /const vault = readHere && readHere\.block > pageVault\.block \? readHere : pageVault/, 'never an older read over a newer one')
  assert.equal([...page.matchAll(/onVaultRead\(r\.live\)/g)].length, 2, 'Review and Confirm both feed what they read back to the card')
})

test('the card uses the semantic tokens, and it has one way to send, behind the rules', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.doesNotMatch(page, /\b(?:bg|text|border)-(?:red|green|yellow|amber|emerald|slate|gray|zinc)-\d/)
  assert.equal([...page.matchAll(/sendPrepared\(/g)].length, 1)
  // Confirm goes through the same check as review, and claims the send before the wallet is asked.
  const confirm = page.slice(page.indexOf('const confirm = () =>'), page.indexOf('const working ='))
  assert.ok(confirm.indexOf('recheckHandoff') < confirm.indexOf('claimHandoff'))
  assert.ok(confirm.indexOf('claimHandoff') < confirm.indexOf('sendPrepared'))
  // The fee rule is the page's own: the record's fee field is not read, and the simulation is prepareOwnerCall's.
  const send = repo('src/lib/arc/handoff-send.ts')
  assert.match(send, /prepareOwnerCall\(chain, v, \{ fn: 'ownerPay'/)
  assert.doesNotMatch(send + page, /fees\.maxFeePerGas|prepared\.fees|\.fees\./)
})

test('ownerPay keeps the page\'s margin, and never less than the first spend of a UTC day needs', async () => {
  const v = (await import(repoUrl('src/lib/arc/vault-rules.ts').href)) as { ownerPayGas: (e: bigint) => bigint; gasWithMargin: (e: bigint) => bigint; OWNER_PAY_DAY_ROLLOVER_GAS: bigint }
  assert.equal(v.ownerPayGas(74_000n), 99_000n, 'the 20% alone would be 88,800, and the rollover writes about 17,200 more')
  assert.equal(v.ownerPayGas(200_000n), v.gasWithMargin(200_000n))
  assert.ok(v.OWNER_PAY_DAY_ROLLOVER_GAS >= 17_200n)
})

test('declining is kept in this browser only, and the card says nothing records it', async () => {
  const p = await pending()
  const vault = '0x' + '22'.repeat(20)
  p.saveDeclined(NETWORK, vault, FLOW, true)
  assert.deepEqual(p.loadDeclined(NETWORK, vault), [FLOW])
  p.saveDeclined(NETWORK, vault, FLOW, false)
  assert.deepEqual(p.loadDeclined(NETWORK, vault), [])
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /nothing records your answer/)
  assert.match(page, /your agent is not told/)
  assert.match(page, /does not stop your agent/)
  // And there is no such state to write: a flow's outcomes are what they are.
  const storage = repo('mcp/src/storage.ts')
  const outcomes = storage.slice(storage.indexOf('export type VtpFlowOutcome'), storage.indexOf('/** Why it stands there. */'))
  assert.doesNotMatch(outcomes, /declin/i)
})

// ── the read of the vault's payments ──────────────────────────────────────────────

type History = {
  emptyHistory: (vault: string, head: bigint | null) => Record<string, unknown> & { windows: { from: bigint; to: bigint }[]; failed: unknown; events: unknown[] }
  readDownTo: (h: unknown, downTo: bigint, x: { readers: unknown[] }) => Promise<{ windows: { from: bigint; to: bigint }[]; failed: unknown; events: { kind: string }[] }>
  covered: (h: unknown) => { from: bigint; to: bigint } | null
  LOG_WINDOW_BLOCKS: bigint
  WINDOWS_PER_READ: number
}
const history = async () => (await import(repoUrl('src/lib/arc/event-history.ts').href)) as History

test('the read goes down to the block it needs and no further, however many windows that is', async () => {
  const h = await history()
  let asked = 0
  const reader = {
    host: 'a',
    logs: async (from: bigint, to: bigint) => {
      asked += 1
      assert.ok(to - from < h.LOG_WINDOW_BLOCKS)
      return []
    },
  }
  const near = await h.readDownTo(h.emptyHistory(VAULT, 1_000_000n), 995_000n, { readers: [reader] })
  assert.equal(asked, 1, 'a check from a minute ago takes one window')
  assert.ok((h.covered(near)?.from ?? 1_000_000n) <= 995_000n)
  asked = 0
  // A day of blocks at two a second is more windows than one read asks for.
  const windows = h.WINDOWS_PER_READ + 3
  const far = await h.readDownTo(h.emptyHistory(VAULT, 1_000_000n), 1_000_000n - h.LOG_WINDOW_BLOCKS * BigInt(windows) + 1n, { readers: [reader] })
  assert.equal(asked, windows)
  assert.equal(far.failed, null)
})

test('a window no host answers is said to be that, and nothing below it is claimed', async () => {
  const h = await history()
  const reader = {
    host: 'a',
    logs: async (from: bigint) => {
      if (from < 985_000n) throw new Error('rate limited')
      return []
    },
  }
  const out = await h.readDownTo(h.emptyHistory(VAULT, 1_000_000n), 900_000n, { readers: [reader] })
  assert.notEqual(out.failed, null)
  assert.ok((h.covered(out)?.from ?? 0n) > 900_000n, 'so the caller cannot read this as no payment')
})

test('a read that stopped short says where it stopped, and the send refuses anything below that, never reading it as no payment', () => {
  const src = repo('src/lib/arc/vault-events.ts')
  const fn = src.slice(src.indexOf('export async function readPaidSince'), src.indexOf('Read a vault\'s events: from the newest'))
  assert.match(fn, /return \{ ok: true, paid: paidOf\(h\), from: range\.from, through: range\.to, short \}/, 'the range it really covers')
  assert.match(fn, /if \(!range\) return \{ ok: false/)
  const send = repo('src/lib/arc/handoff-send.ts')
  const recheck = send.slice(send.indexOf('export async function recheckHandoff'), send.indexOf('export async function postHandoffReceipt'))
  assert.match(recheck, /scan\.from > need/)
  assert.match(recheck, /throw stop\('handoff_unreadable'/)
})

test('the read of new blocks does not claim anything across a gap, and a timer does not restart a long read', () => {
  const send = repo('src/lib/arc/handoff-send.ts')
  const scan = send.slice(send.indexOf('export async function scanPaid'), send.indexOf('export type Recheck'))
  assert.match(scan, /if \(r\.short\) return \{ failed: r\.short \}/)
  assert.match(scan, /held\.from <= from \|\| o\.topUpOnly/)
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /setInterval\(\(\) => void readPayments\(true\), SCAN_AGAIN_MS\)/)
})
