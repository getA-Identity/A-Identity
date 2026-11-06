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
type Standing = { kind: string; what?: string; why?: string | null; ageSeconds?: bigint | null; have?: bigint }
type Failure = { code: string; message: string }
type Send = Record<string, unknown> & { flowId: string; payee: string; amount: bigint; tx?: Record<string, unknown>; alsoSent?: Record<string, unknown>[] }
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
  followedHere: (r: Send | null, s: Standing) => boolean
  flowIsOver: (s: Standing) => boolean
  otherSends: (s: Send) => Record<string, unknown>[]
  cardHeading: (s: Standing, o: { sent: boolean; held: boolean; paid: boolean; canAct: boolean }) => { heading: string; asks: boolean }
  notHereLine: (s: Standing, o: { sent: boolean; held: boolean; paid: boolean; canAct: boolean }) => string | null
  moreThanOneSend: (s: Send) => boolean
  replacedSendLine: (s: Send) => string | null
  readOrder: (records: Send[]) => Send[]
  promptMayBeOpen: (r: Send) => boolean
  promptLine: (r: Send | null, o: { paid: boolean; standing?: Standing }) => string | null
  noAnswerLine: (promptEnded: boolean) => string
  replacedWithNoPayment: (r: Send) => boolean
  refusedLead: (r: Send, s?: Standing) => string
  endedWords: (others: number) => { lead: string; next: string }
}
const rules = async () => (await import(repoUrl('src/lib/arc/handoff-rules.ts').href)) as Rules

type Pending = {
  loadHandoffs: (network: string, vault: string) => Send[]
  saveHandoff: (r: Send) => void
  clearHandoff: (network: string, vault: string, flowId: string) => void
  loadDeclined: (network: string, vault: string) => string[]
  saveDeclined: (network: string, vault: string, flowId: string, declined: boolean) => void
  claimHandoff: (r: Send, refused: (rs: Send[]) => boolean, locks?: { request: <T>(name: string, fn: () => T) => Promise<T> } | null) => Promise<boolean>
  dropClaim: (claim: Send) => void
  noPromptOpen: (r: Send) => void
  saveSentHash: (claim: Send, tx: Record<string, unknown>) => void
  withTx: (r: Send, tx: Record<string, unknown>) => Send
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
  const none = { sent: false, held: false, paid: false, canAct: true }
  assert.deepEqual(r.cardHeading({ kind: 'approvable' }, none), { heading: 'Your agent asks you to pay this', asks: true })
  assert.equal(r.cardHeading({ kind: 'no_balance', have: 0n }, none).asks, true)
  assert.deepEqual(r.cardHeading({ kind: 'approvable' }, { sent: true, held: true, paid: false, canAct: true }), { heading: 'What this browser sent for this request', asks: false })
  assert.equal(r.cardHeading({ kind: 'approvable' }, { sent: false, held: false, paid: true, canAct: true }).asks, false)
  assert.equal(r.cardHeading({ kind: 'stale', ageSeconds: 90_000n }, none).asks, false)
  // The budget line, what it would leave and the rest sit behind that.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.ok(page.indexOf('{asks && (') < page.indexOf('{budgetLine(flow.amount, vault)}'))
})

test('on a vault this page builds no calls for, the card does not ask or talk of approving, and it gives the next step', async () => {
  const r = await rules()
  const off = { sent: false, held: false, paid: false, canAct: false }
  assert.deepEqual(r.cardHeading({ kind: 'approvable' }, off), { heading: 'A payment your agent asked for', asks: false })
  assert.equal(r.cardHeading({ kind: 'no_balance', have: 0n }, off).asks, false)
  assert.match(String(r.notHereLine({ kind: 'approvable' }, off)), /send ownerPay from the owner key: the guide has a sample/)
  assert.match(String(r.notHereLine({ kind: 'no_balance', have: 0n }, off)), /send ownerPay from the owner key/)
  assert.doesNotMatch(String(r.notHereLine({ kind: 'approvable' }, off)), /approv/i)
  // Where this page can act the button is the next step, and what was sent or already paid has its own lines.
  assert.equal(r.notHereLine({ kind: 'approvable' }, { ...off, canAct: true }), null)
  assert.equal(r.notHereLine({ kind: 'approvable' }, { ...off, held: true }), null)
  assert.equal(r.notHereLine({ kind: 'approvable' }, { ...off, paid: true }), null)
  assert.equal(r.notHereLine({ kind: 'stale', ageSeconds: 90_000n }, off), null)
  // The page hands it canAct, and both lines about approving and the budget line sit behind what that returns.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /const cardState = \{ sent: record !== null && sentHere, held: hold\.held, paid: paid !== null, canAct \}/)
  assert.match(page, /const \{ heading, asks \} = cardHeading\(standing, cardState\)/)
  assert.match(page, /\{asks && <span className="text-xs text-foreground\/65">It can be approved for 24 hours after the check\.<\/span>\}/)
  assert.ok(page.indexOf('{asks && (') < page.indexOf('{FROZEN_LINE}'))
  // The sample it names is one click away, at the guide's own heading, and so is the way for a check from a separate key.
  assert.match(page, /\{offHere\} <GuideLink>See the sample<\/GuideLink>/)
  assert.match(page, /const OWNER_PAY_GUIDE = `\$\{DOCS_URL\}\/chains\/arc-integration#when-a-payment-waits-for-its-owner`/)
  assert.match(repo('docs/chains/arc-integration.mdx'), /^### When a payment waits for its owner$/m)
  assert.match(repo('docs/chains/arc-integration.mdx'), /\*\*A key held by a script, or a browser wallet with no page\.\*\*/)
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
  // A flow the person freed is still watched and it is on offer again, and the offer needs the hours before the
  // check: paymentsRead says 'reading' until a read holds them, and nothing else would ever start that read.
  const t0 = Date.parse('2026-11-04T12:00:00Z')
  const offered = [{ f: ok, s: { kind: 'approvable' } as Standing }]
  const freed = send({ flowId: fresh, released: true, releasedAt: new Date(t0).toISOString() })
  assert.equal(r.stillWatched(freed, t0), true)
  assert.equal(r.scanStart(offered, [freed], [], t0), start)
  assert.equal(r.paymentsRead(ok, { from: start, through: head, paid: [], short: null }, null), 'ok')
  // Held, it is not on offer, and its question is its own payment. Freed and said no to, the same.
  assert.equal(r.scanStart(offered, [send({ flowId: fresh })], [], t0), freshBlock + 1n)
  assert.equal(r.scanStart(offered, [freed], [fresh], t0), freshBlock + 1n)
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

// ── a wallet prompt answered after a later one was opened ─────────────────────────

/** One flow on its own vault, two runs of the page on it, and the record as storage holds it. */
const twoRuns = async () => {
  const p = await pending()
  const r = await rules()
  const vault = '0x' + Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0').repeat(5)
  const first = send({ vault, token: 'run-1' })
  const second = send({ vault, token: 'run-2' })
  // The page stopped waiting on the first prompt, the person said nothing was sent, and Confirm ran again.
  const reclaimed = async () => {
    p.saveHandoff({ ...first, released: true, releasedAt: CHECKED })
    assert.equal(await p.claimHandoff(second, (rs) => r.holdFor(second as unknown as Flow, rs).held, null), true)
  }
  return { p, r, vault, first, second, reclaimed, stored: () => p.loadHandoffs(NETWORK, vault)[0] as Send | undefined }
}

test('a late no from a prompt the page stopped waiting on leaves the later send alone', async () => {
  const { p, r, first, second, reclaimed, stored } = await twoRuns()
  await reclaimed()
  // The later prompt is still open, with no hash yet: the record is what holds the page and every other tab.
  p.dropClaim(first)
  assert.equal(stored()?.token, 'run-2')
  assert.equal(r.holdOf(stored()).why, 'asked')
  // The later prompt was signed, and its hash is the only thing that says so.
  p.saveSentHash(second, txRecord('pending', { hash: TX2 }))
  p.dropClaim(first)
  assert.equal(stored()?.tx?.hash, TX2, 'the hash stays')
  assert.equal(r.holdOf(stored()).why, 'pending')
  assert.equal(r.holdsPage(stored() as Send), true)
  assert.equal(r.followedHere(stored() as Send, { kind: 'approvable' }), true)
  // A run's own no clears only a record with no send on it.
  p.dropClaim(second)
  assert.equal(stored()?.tx?.hash, TX2, 'it was sent, whichever run hears a no afterwards')
})

test('a no with nothing else on the record clears it, as it always did, and a payment found on chain is not lost to one', async () => {
  const { p, first, stored } = await twoRuns()
  p.saveHandoff(first)
  p.dropClaim(first)
  assert.equal(stored(), undefined, 'declined in the wallet: nothing was sent, so nothing is kept')
  p.saveHandoff({ ...first, released: true, releasedAt: CHECKED })
  p.dropClaim(first)
  assert.equal(stored(), undefined, 'the same after a release, with no later claim')
  p.saveHandoff({ ...first, paidBy: TX })
  p.dropClaim(first)
  assert.equal(stored()?.paidBy, TX, 'the chain showed a payment for it')
  p.clearHandoff(NETWORK, first.vault as string, FLOW)
})

test('a late hash after the later send has its own goes beside it: both are followed, and neither is lost', async () => {
  const { p, r, first, second, reclaimed, stored } = await twoRuns()
  await reclaimed()
  p.saveSentHash(second, txRecord('pending', { hash: TX2 }))
  p.saveSentHash(first, txRecord('pending', { hash: TX }))
  const both = stored() as Send
  assert.equal(both.token, 'run-2', 'the newer record is the one kept')
  assert.equal(both.tx?.hash, TX2)
  assert.deepEqual(r.otherSends(both).map((t) => t.hash), [TX])
  assert.equal(r.holdOf(both).why, 'pending')
  // The same answer twice is one send.
  p.saveSentHash(first, txRecord('pending', { hash: TX }))
  p.saveSentHash(second, txRecord('pending', { hash: TX2.toUpperCase().replace('0X', '0x') }))
  assert.deepEqual([stored()?.tx?.hash, r.otherSends(stored() as Send).map((t) => t.hash)], [TX2, [TX]])
})

test('a late hash that comes first is not erased by the later run, whichever way that run ends', async () => {
  const { p, r, first, second, reclaimed, stored } = await twoRuns()
  await reclaimed()
  p.saveSentHash(first, txRecord('pending', { hash: TX }))
  assert.equal(stored()?.tx?.hash, TX, 'the first hash is the one the record follows')
  assert.equal(stored()?.released, undefined)
  // The later prompt is signed too: its save starts from the record as it stands, not from its own claim.
  p.saveSentHash(second, txRecord('pending', { hash: TX2 }))
  assert.deepEqual([stored()?.tx?.hash, r.otherSends(stored() as Send).map((t) => t.hash)], [TX, [TX2]])
  // Or it is declined, which says nothing about the hash already there.
  const again = await twoRuns()
  await again.reclaimed()
  again.p.saveSentHash(again.first, txRecord('pending', { hash: TX }))
  again.p.dropClaim(again.second)
  assert.equal(again.stored()?.tx?.hash, TX)
})

test("a run's own late hash ends what was said about nothing being sent, and keeps what the chain already showed", async () => {
  const { p, r, first, stored } = await twoRuns()
  p.saveHandoff({ ...first, released: true, releasedAt: CHECKED })
  p.saveSentHash(first, txRecord('untracked'))
  assert.equal(stored()?.released, undefined)
  assert.equal(r.holdOf(stored()).why, 'maybe', 'held again, because it may land')
  // No record left at all, because a later prompt was declined: the hash brings it back.
  p.clearHandoff(NETWORK, first.vault as string, FLOW)
  p.saveSentHash(first, txRecord('pending', { hash: TX2 }))
  assert.equal(stored()?.tx?.hash, TX2)
  // What a scan found stays, and a hash that comes back after it goes beside it: it may have paid as well.
  p.clearHandoff(NETWORK, first.vault as string, FLOW)
  p.saveHandoff({ ...first, paidBy: TX })
  p.saveSentHash(first, txRecord('settled', { hash: TX2 }))
  assert.deepEqual([stored()?.paidBy, stored()?.tx, stored()?.alsoSent?.map((t) => t.hash)], [TX, undefined, [TX2]])
  // The same hash the scan found is that one send.
  p.clearHandoff(NETWORK, first.vault as string, FLOW)
  p.saveHandoff({ ...first, paidBy: TX })
  p.saveSentHash(first, txRecord('settled', { hash: TX.toUpperCase().replace('0X', '0x') }))
  assert.deepEqual([stored()?.alsoSent, r.otherSends(stored() as Send)], [undefined, []])
})

test('a hash back after the read found a payment is followed and named, whichever way the answer went', async () => {
  const { p, r, first, stored } = await twoRuns()
  p.saveHandoff({ ...first, paidBy: TX })
  p.saveSentHash(first, txRecord('pending', { hash: TX2 }))
  const now = () => stored() as Send
  // On its way, it holds the flow and the page, and the payment that was found is what goes to the server.
  assert.equal(r.holdOf(now()).why, 'pending')
  assert.equal(r.holdsPage(now()), true)
  assert.equal(r.hashToPost(now()), TX)
  assert.deepEqual(r.otherSends(now()).map((t) => t.hash), [TX2])
  assert.equal(r.promptMayBeOpen(now()), false, 'the wallet answered, though tx is empty')
  // Landed, that is two payments, and the card keeps naming the second once the flow reads closed.
  p.saveHandoff(p.withTx(now(), txRecord('settled', { hash: TX2 })))
  assert.equal(r.moreThanOneSend(now()), true)
  p.saveHandoff({ ...now(), server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })
  assert.deepEqual(r.otherSends(now()).map((t) => t.hash), [TX2])
  assert.equal(r.moreThanOneSend(now()), true)
  assert.equal(r.followedHere(now(), { kind: 'settled' }), true)
  assert.equal(r.holdsPage(now()), false)
  // The same on an older check whose payment was recorded on a newer one, which stays open here.
  assert.equal(r.followedHere({ ...now(), server: { state: 'moved', txHash: TX, flowId: FLOW, at: CHECKED } }, { kind: 'approvable' }), true)
  // An answer that was there before the hash came back changes none of that.
  const again = await twoRuns()
  again.p.saveHandoff({ ...again.first, paidBy: TX, server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })
  again.p.saveSentHash(again.first, txRecord('settled', { hash: TX2 }))
  assert.deepEqual(r.otherSends(again.stored() as Send).map((t) => t.hash), [TX2])
  assert.equal(r.followedHere(again.stored() as Send, { kind: 'settled' }), true)
})

test("one prompt whose speed-up the read found first does not read as two payments", async () => {
  const { p, r, first, stored } = await twoRuns()
  p.saveHandoff({ ...first, paidBy: TX2 })
  // The wallet hands back the first hash, which a speed-up replaced. Nothing yet says which it is.
  p.saveSentHash(first, txRecord('pending', { hash: TX }))
  const now = () => stored() as Send
  assert.equal(r.moreThanOneSend(now()), false, 'followed, and not counted')
  assert.equal(r.holdOf(now()).why, 'pending')
  // It reads replaced: it can no longer land, the hold goes with it, and nothing is left to let go of.
  p.saveHandoff(p.withTx(now(), txRecord('replaced')))
  assert.equal(r.moreThanOneSend(now()), false)
  assert.deepEqual(r.otherSends(now()), [])
  assert.equal(r.holdOf(now()).why, 'landed')
  assert.equal(r.holdsPage(now()), false)
  assert.equal(r.replacedSendLine(now()), null, 'the found payment is what replaced it')
  // A hash no host ever saw reads most likely replaced, which beside a found payment is the same thing.
  assert.equal(r.moreThanOneSend(p.withTx(now(), txRecord('untracked', { likelyReplaced: true }))), false)
  // The read can find a carried send's own payment, under its own hash. That is one payment, with nothing left to follow.
  const found = send({ paidBy: TX, alsoSent: [txRecord('untracked')] })
  assert.deepEqual(r.otherSends(found), [])
  assert.equal(r.moreThanOneSend(found), false)
  assert.equal(r.holdOf(found).why, 'landed')
  // A hash marked untracked beside the speed-up the read found is a record of one send, as it was.
  assert.equal(r.moreThanOneSend(send({ tx: txRecord('untracked'), paidBy: TX2 })), false)
  // A first hash that was replaced, with a second that landed, is the second's nonce: one payment.
  assert.equal(r.moreThanOneSend(send({ tx: txRecord('replaced'), alsoSent: [txRecord('settled', { hash: TX2 })] })), false)
  // Anywhere else that a second hash is on its way, the alert does not wait for it.
  assert.equal(r.moreThanOneSend(send({ tx: txRecord('pending'), alsoSent: [txRecord('pending', { hash: TX2 })] })), true)
})

test('a new claim keeps a send the person let go of, follows it again, and says nothing of two until there are two', async () => {
  const { p, r, first, second, stored } = await twoRuns()
  const f = second as unknown as Flow
  const refused = (rs: Send[]) => r.holdFor(f, rs).held
  p.saveHandoff({ ...first, tx: txRecord('untracked', { likelyReplaced: true, note: 'x', unseen: true, nonceUsedAt: CHECKED }), released: true, releasedAt: CHECKED })
  assert.equal(await p.claimHandoff(second, refused, null), true, 'the person said so, and the hold check is as it was')
  const now = () => stored() as Send
  const { retracked } = (await import(repoUrl('src/lib/arc/tx-rules.ts').href)) as { retracked: (t: Record<string, unknown>) => Record<string, unknown> }
  assert.equal(now().token, 'run-2')
  assert.equal(now().tx, undefined)
  assert.equal(now().released, undefined)
  assert.deepEqual(now().alsoSent, [JSON.parse(JSON.stringify(retracked(txRecord('untracked', { likelyReplaced: true, note: 'x', unseen: true, nonceUsedAt: CHECKED }))))], "the same as the receipt's own Track it again")
  assert.equal(r.holdOf(now()).why, 'pending')
  assert.equal(r.holdsPage(now()), true)
  assert.equal(r.moreThanOneSend(now()), false, 'nothing was signed yet: one hash, however many claims')
  assert.equal(r.promptMayBeOpen(now()), true, 'and the prompt this claim opened is still unanswered')
  // The second prompt is signed, and that is two.
  p.saveSentHash(second, txRecord('pending', { hash: TX2 }))
  assert.equal(now().tx?.hash, TX2)
  assert.deepEqual(r.otherSends(now()).map((t) => t.hash), [TX])
  assert.equal(r.moreThanOneSend(now()), true)
  // Both land: of two that paid, one goes to the server, and the other is still named after the answer.
  p.saveHandoff(p.withTx(p.withTx(now(), txRecord('settled')), txRecord('settled', { hash: TX2 })))
  assert.equal(r.hashToPost(now()), TX2)
  p.saveHandoff({ ...now(), server: { state: 'settled', txHash: TX2, flowId: FLOW, at: CHECKED } })
  assert.deepEqual(r.otherSends(now()).map((t) => t.hash), [TX])
  assert.equal(r.followedHere(now(), { kind: 'settled' }), true)
  // A wallet can sign the same transaction again, which hands back the same hash: one send, and the prompt has its answer.
  const same = await twoRuns()
  same.p.saveHandoff({ ...same.first, tx: txRecord('untracked'), released: true, releasedAt: CHECKED })
  assert.equal(await same.p.claimHandoff(same.second, (rs) => r.holdFor(f, rs).held, null), true)
  same.p.saveSentHash(same.second, txRecord('pending'))
  assert.deepEqual((same.stored() as Send).alsoSent?.map((t) => t.hash), [TX])
  assert.equal(same.stored()?.tx, undefined)
  assert.equal(r.promptMayBeOpen(same.stored() as Send), false)
  assert.equal(r.moreThanOneSend(same.stored() as Send), false)
  // One that was replaced can no longer land, so a new claim does not carry it.
  const gone = await twoRuns()
  gone.p.saveHandoff({ ...gone.first, tx: txRecord('replaced'), released: true, releasedAt: CHECKED })
  assert.equal(await gone.p.claimHandoff(gone.second, (rs) => r.holdFor(f, rs).held, null), true)
  assert.equal(gone.stored()?.alsoSent, undefined)
})

test("a send that ended replaced leaves the alert and the hold, and the card says what that leaves open", async () => {
  const { p, r, first, second, stored } = await twoRuns()
  p.saveHandoff({ ...first, tx: txRecord('untracked'), released: true, releasedAt: CHECKED })
  assert.equal(await p.claimHandoff(second, (rs) => r.holdFor(second as unknown as Flow, rs).held, null), true)
  p.saveSentHash(second, txRecord('settled', { hash: TX2 }))
  const now = () => stored() as Send
  // The second took the first one's nonce: the wallet really had dropped it.
  p.saveHandoff(p.withTx(now(), txRecord('replaced')))
  assert.deepEqual(r.otherSends(now()), [])
  assert.equal(r.moreThanOneSend(now()), false)
  assert.equal(r.holdOf(now()).why, 'landed')
  p.saveHandoff({ ...now(), server: { state: 'settled', txHash: TX2, flowId: FLOW, at: CHECKED } })
  assert.equal(r.holdOf(now()).why, 'answered', 'not "maybe" after the answer, which only a person could end')
  assert.equal(r.holdsPage(now()), false)
  assert.equal(r.followedHere(now(), { kind: 'settled' }), false)
  // A wallet's speed-up reads replaced too, and what replaced it can pay, so that much stays said.
  assert.match(String(r.replacedSendLine(now())), /what replaced it can pay this amount as well, and may already have/)
  assert.doesNotMatch(String(r.replacedSendLine(now())), /can still pay/, 'a speed-up that paid has paid')
  assert.equal(r.replacedSendLine(send({ tx: txRecord('settled') })), null)
  // On the tracker, and on both cards a closed flow falls back to.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /\{replacedLine && <p /)
  assert.equal([...page.matchAll(/\{replaced && <p /g)].length, 2)
})

test('a no to a prompt leaves what the claim carried on the record, and frees what the person had freed', async () => {
  const { p, r, first, second, stored } = await twoRuns()
  p.saveHandoff({ ...first, tx: txRecord('untracked'), released: true, releasedAt: CHECKED })
  assert.equal(await p.claimHandoff(second, (rs) => r.holdFor(second as unknown as Flow, rs).held, null), true)
  p.dropClaim(second)
  const now = () => stored() as Send
  assert.equal(now()?.alsoSent?.[0].hash, TX, 'it may still land')
  assert.equal(now().released, true, 'and nothing is asked any more')
  assert.equal(r.holdOf(now()).why, 'pending')
  // It is followed to where it was, and the person's word stands for it again.
  p.saveHandoff(p.withTx(now(), txRecord('untracked')))
  assert.deepEqual(r.holdOf(now()), { held: false })
  // With only a replaced one left, there is nothing to keep.
  const gone = await twoRuns()
  gone.p.saveHandoff({ ...gone.second, alsoSent: [txRecord('replaced')] })
  gone.p.dropClaim(gone.second)
  assert.equal(gone.stored(), undefined)
})

test("a replaced hash's watch starts over with a second hash, so that one does not skip the wait", async () => {
  const { p, r, first, stored } = await twoRuns()
  const f = await flow()
  const t0 = Date.parse('2026-11-04T12:00:00Z')
  p.saveHandoff({ ...first, tx: txRecord('replaced'), replacedSeenAt: new Date(t0 - 10 * 60_000).toISOString() })
  p.saveSentHash(first, txRecord('pending', { hash: TX2 }))
  assert.equal(stored()?.replacedSeenAt, undefined)
  const both = p.withTx(stored() as Send, txRecord('replaced', { hash: TX2 }))
  const after = r.afterScan(both, f, read([]), t0)
  assert.equal(after.replacedClear, undefined, 'a host can lag by 50 seconds, and the second one was replaced just now')
  assert.equal(r.holdOf(after).why, 'maybe')
  assert.equal(after.replacedSeenAt, new Date(t0).toISOString())
  assert.deepEqual(r.holdOf(r.afterScan(after, f, read([]), t0 + r.REPLACED_WATCH_MS)), { held: false })
})

test('the card stops asking for a prompt once the money left or the request ended, and the two minutes run on either way', async () => {
  const r = await rules()
  const open: Standing = { kind: 'approvable' }
  const landed = txRecord('settled')
  const answer = { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED }
  // A prompt with a reason left: nothing to say beyond asking for it.
  assert.equal(r.promptLine(send(), { paid: false, standing: open }), null)
  assert.equal(r.promptLine(send({ alsoSent: [txRecord('pending')] }), { paid: false, standing: open }), null)
  assert.equal(r.promptLine(null, { paid: true }), null)
  // The money left: from another device, from the agent's key, or under a send this claim carried.
  for (const [what, s, paid, standing] of [
    ['the read found it', send(), true, open],
    ['the agent paid it', send({ released: true }), true, open],
    ['the record found it', send({ paidBy: TX }), false, open],
    ['the server answered about it', send({ paidBy: TX, server: answer }), false, open],
    ['it moved to a newer check', send({ paidBy: TX, server: { ...answer, state: 'moved' } }), false, open],
    ['the flow reads paid', send(), false, { kind: 'settled' }],
    ['a carried send landed', send({ alsoSent: [landed] }), false, open],
  ] as [string, Send, boolean, Standing][]) {
    const line = String(r.promptLine(s, { paid, standing }))
    assert.match(line, /may still be open in your wallet/, what)
    assert.match(line, /already left the vault/, what)
    assert.match(line, /decline it: signing it pays this amount again/, what)
  }
  // Closed by a revert nothing moved, and a signature would still pay.
  assert.match(String(r.promptLine(send(), { paid: false, standing: { kind: 'reverted', why: null } })), /This request is over, so decline it: signing it still sends this amount/)
  // An answer from the wallet ends the question, in either slot it went to.
  assert.equal(r.promptLine(send({ tx: txRecord('pending') }), { paid: true, standing: open }), null)
  assert.equal(r.promptLine(send({ paidBy: TX, hashBack: true, alsoSent: [txRecord('pending', { hash: TX2 })] }), { paid: true, standing: open }), null)
  assert.equal(r.promptMayBeOpen(send()), true)
  // The tracker's line about a prompt does not invite one then, and its way out stays.
  assert.match(r.noAnswerLine(false), /you can answer it there/)
  assert.doesNotMatch(r.noAnswerLine(true), /answer it there/)
  // The page: the line, the timer and the notice, and the card that replaces this one when the flow settles.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /const promptOpen = asking && record !== null && promptMayBeOpen\(record\)/)
  assert.match(page, /const decline = promptLine\(record, \{ paid: paid !== null, standing \}\)/)
  assert.match(page, /const waitingOnWallet = promptOpen && decline === null/)
  assert.match(page, /if \(!promptOpen\) return\s+const t = setTimeout\(\(\) => release\('confirm'\), WALLET_ANSWER_MS\)/, 'or its cleanup would cancel it, and busy would stick')
  assert.match(page, /\{paid && \(!sentHere \|\| !record\?\.tx\) && \(/, 'the notice shows on a record that only says the wallet was asked')
  assert.match(page, /<SettledCard chain=\{chain\} vault=\{vault\} flow=\{flow\} decline=\{promptLine\(record, \{ paid: false, standing \}\)\} onNoPrompt=\{noPrompt\} replaced=\{replaced\} \/>/)
  assert.match(page, /\{decline && <PromptLine line=\{decline\} onNone=\{asking \|\| askedBox \? undefined : noPrompt\} \/>\}/, 'the tracker is on every card with a record, and on one whose flow was not read')
  assert.match(page, /decline=\{decline\}/)
  assert.match(page, /decline=\{promptLine\(r, \{ paid: false \}\)\}/)
  assert.match(page, /\{noAnswerLine\(decline !== null\)\}/)
  assert.match(page, /I checked: my wallet shows nothing was sent/)
  assert.match(page, /\{record\.tx \? "This payment landed under another transaction, most likely your wallet's speed-up\."/, 'a hash that never came back is no speed-up of it')
})

test("a hash from an earlier prompt answers nothing about the one the record's claim opened, which stays open", async () => {
  const r = await rules()
  const open: Standing = { kind: 'approvable' }
  const TX3 = '0x' + '79'.repeat(32)
  // The read found the payment while the second prompt is open, and the first prompt's own hash comes back to its run late.
  {
    const { p, first, second, reclaimed, stored } = await twoRuns()
    await reclaimed()
    p.saveHandoff({ ...(stored() as Send), paidBy: TX2 })
    p.saveSentHash(first, txRecord('pending', { hash: TX }))
    const now = stored() as Send
    assert.deepEqual(now.alsoSent?.map((t) => t.hash), [TX], 'it is a send, and followed')
    assert.equal(r.promptMayBeOpen(now), true, 'and no answer to the second prompt')
    assert.match(String(r.promptLine(now, { paid: true, standing: open })), /decline it: signing it pays this amount again/)
    p.saveSentHash(second, txRecord('pending', { hash: TX3 }))
    assert.equal(r.promptMayBeOpen(stored() as Send), false, "the second prompt's own hash is its answer")
  }
  // Nothing found yet, and the first prompt's hash comes back the ordinary way, into tx.
  {
    const { p, first, second, reclaimed, stored } = await twoRuns()
    await reclaimed()
    p.saveSentHash(first, txRecord('pending', { hash: TX }))
    const now = () => stored() as Send
    assert.equal(now().tx?.hash, TX, 'the first hash is the one the record follows')
    assert.equal(r.promptMayBeOpen(now()), true, 'and the second prompt is still open')
    assert.match(String(r.promptLine(now(), { paid: false, standing: open })), /Another transaction your wallet sent for this request is on its way, so decline it: if both land, the vault pays this amount twice/)
    // It lands and the request reads paid: the card that replaces this one says it too, and so does the record alone.
    p.saveHandoff(p.withTx(now(), txRecord('settled', { hash: TX })))
    assert.match(String(r.promptLine(now(), { paid: false, standing: { kind: 'settled' } })), /already left the vault, so decline it/)
    assert.match(String(r.promptLine(now(), { paid: false, standing: open })), /already left the vault, so decline it/)
    // The second prompt declined: its run says so, and the line goes.
    p.dropClaim(second)
    assert.equal(now().tx?.hash, TX, 'the send stays')
    assert.equal(r.promptLine(now(), { paid: true, standing: { kind: 'settled' } }), null)
  }
  // The person said the first will not land, and it never showed: then the prompt has a reason again.
  assert.equal(r.promptLine(send({ answered: false, tx: txRecord('untracked'), released: true }), { paid: false, standing: open }), null)
  // A hash a claim carried, handed back late by that claim's own run, is that claim's send and no answer to this one.
  {
    const { p, first, second, stored } = await twoRuns()
    p.saveHandoff({ ...first, tx: txRecord('untracked'), released: true, releasedAt: CHECKED })
    assert.equal(await p.claimHandoff(second, (rs) => r.holdFor(second as unknown as Flow, rs).held, null), true)
    p.saveSentHash(first, txRecord('pending'))
    assert.equal(r.promptMayBeOpen(stored() as Send), true)
    p.saveSentHash(second, txRecord('pending'))
    assert.equal(r.promptMayBeOpen(stored() as Send), false, 'the same hash back to this claim is its answer')
  }
  // A record from before the answer was kept reads as it did.
  assert.equal(r.promptMayBeOpen(send({ tx: txRecord('pending') })), false)
  assert.equal(r.promptMayBeOpen(send({ paidBy: TX, hashBack: true })), false)
  assert.equal(r.promptMayBeOpen(send()), true)
})

test('a send the person said is dropped, which no receipt ever showed, stops counting toward two', async () => {
  const r = await rules()
  const landed = { tx: txRecord('settled', { hash: TX2 }), alsoSent: [txRecord('untracked', { likelyReplaced: true })], server: { state: 'settled', txHash: TX2, flowId: FLOW, at: CHECKED } }
  assert.equal(r.moreThanOneSend(send(landed)), true, 'until the person says so, it can still land')
  assert.equal(r.moreThanOneSend(send({ ...landed, released: true, releasedAt: CHECKED })), false, 'then it holds nothing, and counts for nothing')
  assert.equal(r.holdsPage(send({ ...landed, released: true, releasedAt: CHECKED })), false)
  // A hash that did land counts, whatever was said about the other.
  assert.equal(r.moreThanOneSend(send({ ...landed, alsoSent: [txRecord('settled')], released: true })), true)
})

test('a prompt the wallet declined, or that the person says is closed, stops being one on a paid card', async () => {
  const { p, r, first, stored } = await twoRuns()
  const settled: Standing = { kind: 'settled' }
  const answer = { state: 'settled', txHash: TX2, flowId: FLOW, at: CHECKED }
  // The same payment from another device, and the server's answer, with the prompt still open.
  assert.equal(await p.claimHandoff(first, (rs) => r.holdFor(first as unknown as Flow, rs).held, null), true)
  p.saveHandoff({ ...(stored() as Send), paidBy: TX2, server: answer })
  assert.match(String(r.promptLine(stored() as Send, { paid: false, standing: settled })), /may still be open in your wallet/)
  // The owner declines it, and the run that asked hears that.
  p.dropClaim(first)
  assert.equal(stored()?.paidBy, TX2, 'the payment stays')
  assert.equal(r.promptLine(stored() as Send, { paid: false, standing: settled }), null)
  // A phone: the run was lost to a reload, so only the person can say the one prompt was the payment.
  const phone = await twoRuns()
  assert.equal(await phone.p.claimHandoff(phone.first, (rs) => r.holdFor(phone.first as unknown as Flow, rs).held, null), true)
  phone.p.saveHandoff({ ...(phone.stored() as Send), paidBy: TX2, server: answer })
  phone.p.noPromptOpen({ ...phone.first, token: 'another-claim' })
  assert.match(String(r.promptLine(phone.stored() as Send, { paid: false, standing: settled })), /may still be open/, 'said of another claim, it is not this one')
  phone.p.noPromptOpen(phone.stored() as Send)
  assert.equal(r.promptLine(phone.stored() as Send, { paid: false, standing: settled }), null)
  // A record from before the answer was kept ends the same way.
  phone.p.saveHandoff(send({ vault: phone.vault, paidBy: TX2, server: answer }))
  assert.equal(r.promptMayBeOpen(phone.stored() as Send), true)
  phone.p.noPromptOpen(send({ vault: phone.vault }))
  assert.equal(r.promptMayBeOpen(phone.stored() as Send), false)
  // The page: the paid card and the tracker offer that way out, and not while this tab waits on the prompt.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /I checked: no prompt for this is open in my wallet/)
  assert.match(page, /<PromptLine line=\{decline\} onNone=\{onNoPrompt\} \/>/)
  assert.match(page, /onNone=\{asking \|\| askedBox \? undefined : noPrompt\}/)
})

test('a refusal on a flow another hash closed keeps its tracker, and its first line says what this hash did', async () => {
  const r = await rules()
  const refused = { state: 'refused', txHash: TX, flowId: FLOW, code: 'FLOW_ENDED', reason: 'this flow is executed', at: CHECKED }
  const paidHere = send({ tx: txRecord('settled'), server: refused })
  const revertedHere = send({ tx: txRecord('reverted'), server: refused })
  const closed: Standing[] = [{ kind: 'settled' }, { kind: 'reverted', why: null }]
  for (const s of closed) {
    assert.equal(r.followedHere(paidHere, s), true, s.kind)
    assert.equal(r.followedHere(revertedHere, s), true, s.kind)
    assert.doesNotMatch(r.refusedLead(paidHere, s), /nothing is marked as settled/, `${s.kind}: this flow is marked, under another hash`)
    assert.match(r.refusedLead(revertedHere, s), /This one reverted, so nothing moved from it/, s.kind)
    assert.doesNotMatch(r.refusedLead(revertedHere, s), /This one paid/, `${s.kind}: this hash paid nothing`)
    assert.match(r.refusedLead(send({ tx: txRecord('unexpected'), server: refused }), s), /Look at this one/, s.kind)
    // A payment the read found under another hash is a payment too, and so is one beside the first.
    assert.match(r.refusedLead(send({ paidBy: TX, server: refused }), s), /This one paid/, s.kind)
    assert.match(r.refusedLead(send({ tx: txRecord('reverted', { hash: TX2 }), alsoSent: [txRecord('settled')], server: refused }), s), /This one paid/, s.kind)
  }
  // What the other hash did is in the line: paid twice over, or paid with a card that would say nothing moved.
  assert.match(r.refusedLead(paidHere, { kind: 'settled' }), /This one paid as well: the vault paid this amount twice/)
  assert.match(r.refusedLead(paidHere, { kind: 'reverted', why: null }), /reverted and closed this request.*This one paid: the vault moved this amount/)
  // A flow still open, or one this page could not read, keeps the words it had.
  for (const said of [r.refusedLead(paidHere, { kind: 'approvable' }), r.refusedLead(paidHere)]) assert.match(said, /^Our server does not take this transaction as proof/)
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /\{refusedLead\(record, standing\)\}/)
  assert.match(page, /closedBy=\{flow\.payment\?\.txHash \?\? null\}/, 'and it names the hash on the record, which the flow card would have')
  assert.match(page, /\{flowOver \? 'This request is over, so nothing more is offered for it\.' : 'It is not offered again\./)
})

test('the line that no payment came of a replaced hash has a read behind it', async () => {
  const r = await rules()
  // The person pressing that they checked frees the flow and reads nothing, and a speed-up can have paid.
  assert.equal(r.replacedWithNoPayment(send({ tx: txRecord('replaced'), released: true, releasedAt: CHECKED })), false)
  assert.equal(r.replacedWithNoPayment(send({ tx: txRecord('replaced'), replacedClear: true })), true)
  assert.equal(r.replacedWithNoPayment(send({ tx: txRecord('replaced') })), false, 'still held')
  assert.equal(r.replacedWithNoPayment(send({ tx: txRecord('replaced'), replacedClear: true, paidBy: TX2 })), false, 'a payment turned up')
  assert.equal(r.replacedWithNoPayment(send({ tx: txRecord('untracked'), released: true })), false)
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /\{replacedWithNoPayment\(record\) && \(/)
  assert.doesNotMatch(page, /!h\.held && record\.tx\?\.outcome === 'replaced'/)
})

test("the tracker's lines say what is so on a record with an answer or another send", async () => {
  const r = await rules()
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  // With an answer the page has stopped looking, as stillWatched says, so the line waits for there being none.
  const answered = send({ tx: txRecord('settled'), alsoSent: [txRecord('untracked', { hash: TX2 })], server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })
  assert.equal(r.holdOf(answered).why, 'maybe')
  assert.equal(r.stillWatched(answered, Date.parse(CHECKED)), false)
  assert.match(page, /\{server \? '' : "This page keeps looking for the payment in the vault's activity\. "\}/)
  // A revert beside another send speaks for itself and no further.
  assert.match(r.endedWords(1).lead, /^This one reverted: it moved nothing/)
  assert.doesNotMatch(r.endedWords(1).lead, /Nothing moved/)
  assert.doesNotMatch(r.endedWords(1).next, /If you still mean to pay/)
  assert.match(r.endedWords(0).lead, /Nothing moved/)
  assert.match(r.endedWords(0).next, /If you still mean to pay/)
  assert.match(page, /endedWords\(others\.length\)\.lead/)
  // A line the alert cannot make: a carried send alone is one send, and it is said what it is.
  assert.match(page, /\{!several && others\.length > 0 && !record\.tx && !record\.paidBy && \(/)
  assert.match(page, /oneOfSeveral=\{several \|\| Boolean\(server\)\}/)
})

test("the tracker's writes keep every send, and each one goes to the transaction it is about", async () => {
  const p = await pending()
  const both = send({ tx: txRecord('pending'), alsoSent: [txRecord('pending', { hash: TX2 })] })
  const second = p.withTx(both, txRecord('settled', { hash: TX2 }))
  assert.deepEqual([(second.tx as { outcome: string }).outcome, (second.alsoSent as { outcome: string }[])[0].outcome], ['pending', 'settled'])
  const first = p.withTx(both, txRecord('reverted'))
  assert.deepEqual([(first.tx as { outcome: string }).outcome, (first.alsoSent as { outcome: string }[])[0].outcome], ['reverted', 'pending'])
  assert.equal(p.withTx(send(), txRecord('pending')).tx?.hash, TX, 'and a record of one send is as it was')
  assert.equal(p.withTx(send(), txRecord('pending')).alsoSent, undefined)
})

test('a second send holds the flow and the page until it has an answer, and each answer is read for what it is', async () => {
  const r = await rules()
  const f = await flow()
  const also = (outcome: string) => ({ alsoSent: [txRecord(outcome, { hash: TX2 })] })
  const answered = { server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } }
  // Still on its way, whatever else the record says.
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), ...also('pending') })).why, 'pending')
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), ...answered, ...also('pending') })).why, 'pending', 'the answer is about the other hash')
  assert.equal(r.holdsPage(send({ tx: txRecord('settled'), ...answered, ...also('pending') })), true)
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), ...answered, ...also('untracked') })).why, 'maybe')
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), ...answered, ...also('replaced') })).why, 'answered', 'it can no longer land')
  // What holds the same payee and amount is the same as what holds the flow.
  const other = '0x' + 'cd'.repeat(32)
  assert.equal(r.holdFor(f, [send({ flowId: other, tx: txRecord('settled'), server: { ...answered.server, flowId: other }, ...also('pending') })]).held, true)
  // Landed, with the server's answer given: the answer stands, and it holds nothing else.
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), ...answered, ...also('settled') })).why, 'answered')
  assert.equal(r.holdsPage(send({ tx: txRecord('settled'), ...answered, ...also('settled') })), false)
  assert.equal(r.holdFor(f, [send({ flowId: other, tx: txRecord('settled'), server: { ...answered.server, flowId: other }, ...also('settled') })]).held, false)
  // The person said it will not land.
  assert.equal(r.holdOf(send({ tx: txRecord('settled'), ...answered, ...also('untracked'), released: true })).why, 'answered')
  // A released first send does not free a second that landed: that is a payment, and it needs posting.
  const freed = send({ tx: txRecord('replaced'), replacedClear: true, ...also('settled') })
  assert.equal(r.holdOf(freed).why, 'landed')
  assert.equal(r.hashToPost(freed), TX2)
  assert.deepEqual(r.holdOf(send({ tx: txRecord('untracked'), released: true, ...also('untracked') })), { held: false })
  // And the answer's own hash can be either one: the other is what is left to follow.
  const onSecond = send({ tx: txRecord('pending'), ...also('settled'), server: { ...answered.server, txHash: TX2 } })
  assert.deepEqual(r.otherSends(onSecond).map((t) => t.hash), [TX])
  assert.equal(r.holdOf(onSecond).why, 'pending')
  // A record of one send is as it was: a hash replaced by the one the server answered about is no other send.
  assert.deepEqual(r.otherSends(send({ tx: txRecord('replaced'), paidBy: TX2, server: { ...answered.server, txHash: TX2 } })), [])
  assert.equal(r.holdOf(send({ tx: txRecord('replaced'), paidBy: TX2, server: { ...answered.server, txHash: TX2 } })).why, 'answered')
})

test('of two hashes the one that paid goes to the server, and a revert does not end the flow while the other can still pay it', async () => {
  const r = await rules()
  const also = (outcome: string) => ({ alsoSent: [txRecord(outcome, { hash: TX2 })] })
  assert.equal(r.hashToPost(send({ tx: txRecord('reverted'), ...also('settled') })), TX2)
  assert.equal(r.hashToPost(send({ tx: txRecord('settled'), ...also('reverted') })), TX)
  assert.equal(r.hashToPost(send({ tx: txRecord('pending'), ...also('settled') })), TX2, 'the flow has had its payment')
  assert.equal(r.hashToPost(send({ tx: txRecord('reverted'), ...also('pending') })), null)
  assert.equal(r.hashToPost(send({ tx: txRecord('pending'), ...also('reverted') })), null)
  assert.equal(r.hashToPost(send({ tx: txRecord('reverted'), ...also('untracked') })), TX, 'only something still on its way waits')
  assert.equal(r.hashToPost(send({ tx: txRecord('settled'), ...also('settled'), server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })), null)
})

test('a record of more than one send keeps its tracker on a closed flow, because the closed card names one transaction', async () => {
  const r = await rules()
  const answer = { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED }
  for (const s of [{ kind: 'settled' }, { kind: 'reverted' }] as Standing[]) {
    assert.equal(r.followedHere(send({ tx: txRecord('settled'), server: answer, alsoSent: [txRecord('settled', { hash: TX2 })] }), s), true, s.kind)
    assert.equal(r.followedHere(send({ tx: txRecord('settled'), server: answer, alsoSent: [txRecord('pending', { hash: TX2 })] }), s), true, s.kind)
    assert.equal(r.followedHere(send({ tx: txRecord('settled'), server: answer }), s), false, s.kind)
  }
})

test('what keeps the records bounded does not drop a record of more than one send, however old', async () => {
  const p = await pending()
  const vault = '0x' + '44'.repeat(20)
  const answer = (flowId: string) => ({ state: 'settled', txHash: TX, flowId, at: CHECKED })
  const oldest = '2026-01-01T00:00:00.000Z'
  const flowOf = (n: number) => '0x' + n.toString(16).padStart(64, '0')
  const both = flowOf(1000)
  const one = flowOf(1001)
  p.saveHandoff(send({ vault, flowId: both, askedAt: oldest, tx: txRecord('settled'), server: answer(both), alsoSent: [txRecord('settled', { hash: TX2 })] }))
  p.saveHandoff(send({ vault, flowId: one, askedAt: oldest, tx: txRecord('settled'), server: answer(one) }))
  for (let n = 0; n < 60; n++) p.saveHandoff(send({ vault, flowId: flowOf(n), askedAt: new Date(Date.parse('2026-06-01T00:00:00Z') + n).toISOString(), tx: txRecord('settled'), server: answer(flowOf(n)) }))
  const kept = p.loadHandoffs(NETWORK, vault).map((r) => r.flowId)
  assert.ok(kept.includes(both))
  assert.ok(!kept.includes(one), 'an old record of one send goes, as it always did')
  assert.equal(kept.length, 51)
  for (const id of kept) p.clearHandoff(NETWORK, vault, id)
})

test('the page writes through these, says when there is more than one, and offers a way out of one that will not land', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  const confirm = page.slice(page.indexOf('const confirm = () =>'), page.indexOf('const working ='))
  assert.match(confirm, /dropClaim\(claim\)/)
  assert.match(confirm, /saveSentHash\(claim, recordOf\(r\.prepared, hash, vault\.address\)\)/)
  assert.doesNotMatch(confirm, /clearHandoff|saveHandoff\(\{ \.\.\.claim/, 'neither of which looks at what is on the record now')
  const tracker = page.slice(page.indexOf('function SendTracker('))
  assert.match(tracker, /saveHandoff\(withTx\(latest\.current, tx\)\)/)
  assert.match(tracker, /\{several && \(\s*<div role="alert"/)
  assert.match(tracker, /Your wallet sent more than one transaction for this one request\. Each one that does not revert pays this amount\./)
  assert.doesNotMatch(tracker, /It answered a prompt this page had stopped waiting on/, 'a send let go of, or a payment from another device, is not that')
  assert.match(tracker, /others\.map\(\(t\) => \(\s*<TxReceipt key=\{t\.hash\} record=\{t\} onUpdate=\{update\} onSettled=\{\(\) => onLanded\(\)\} serverJudges oneOfSeveral=\{several \|\| Boolean\(server\)\} \/>/)
  assert.match(tracker, /\{h\.held && h\.why === 'maybe' && \(/, 'a second send that may land can be let go of, with the first one paid')
  assert.match(repo('src/components/app/arc/TxReceipt.tsx'), /as one of several transactions for one request/)
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
  // A payment already on another check is a payment there, and the post that follows gets that record.
  const linked = r.receiptStep(409, { code: 'TX_LINKED_ELSEWHERE', answersFlow: FLOW.toUpperCase().replace('0X', '0x'), reason: 'linked' })
  assert.deepEqual([linked.step, linked.flowId], ['moved', FLOW])
  assert.equal(r.receiptStep(409, { code: 'TX_LINKED_ELSEWHERE', answersFlow: 'somewhere', reason: 'x' }).step, 'refused')
  // The write lost a race, and the post again is what names the flow.
  assert.equal(r.receiptStep(409, { code: 'TX_LINKED_ELSEWHERE', retry: true, reason: 'x' }).step, 'retry')
  // A field on any other code is not read: the route names no flow to follow there.
  assert.equal(r.receiptStep(409, { code: 'FLOW_ENDED', answersFlow: FLOW }).step, 'refused')
  // None of this reads as paid. Those replies say verified false, and only a recorded payment says settled.
  assert.notEqual(linked.step, 'settled')
  // A 4xx with no code of ours is not our route's word on the payment, so it is no final refusal of it.
  for (const [status, body] of [[403, null], [404, null], [408, {}], [418, { code: 7 }], [409, { error: 'Conflict' }]] as [number, unknown][]) {
    assert.equal(r.receiptStep(status, body).step, 'retry', `${status} ${JSON.stringify(body)}`)
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
  // Every link on the card comes from the registry's explorer and a checked value, or is the guide's own address, never from a record's field.
  assert.deepEqual([...page.matchAll(/href=\{([^}]+)\}/g)].map((m) => m[1]).sort(), ['OWNER_PAY_GUIDE', 'href', 'payeeUrl'])
  assert.doesNotMatch(page, /explorerUrl/)
})

test('the page says what it knows about where the money can come from, and nothing more', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.doesNotMatch(page, /It leaves the vault only if you approve it/, 'a WARN within limits is one the operator key could still send')
  assert.match(page, /This page sends nothing without your own wallet/)
  assert.match(page, /one within its limits is one its key could still send by itself/)
  assert.match(page, /\{oursKey \? '' : ' A-Identity holds no key and signs nothing\.'\}/, 'and it does not say so on a vault that is ours')
  assert.match(repo('src/routes/app/ArcVault.tsx'), /oursKey=\{ours \|\| ownerIsOurKey \|\| isOurKey\(v\.network, v\.operator, known\?\.ourKeys\)\}/, 'its agent key can be one of ours too, as the Status panel says')
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
  const page0 = repo('src/components/app/arc/OwnerApprovals.tsx')
  const now = Date.parse('2026-11-04T12:00:00Z')
  const answered = (at: number, flowId: string) => send({ flowId, tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId, at: new Date(at).toISOString() } })
  const old = answered(now - r.ANSWER_SHOWN_MS - 1, '0x' + '01'.repeat(32))
  const recent = answered(now - 1000, '0x' + '02'.repeat(32))
  const open = send({ flowId: '0x' + '03'.repeat(32), tx: txRecord('pending') })
  const hasFlow = send({ flowId: '0x' + '04'.repeat(32), tx: txRecord('pending') })
  assert.deepEqual(r.unreadRecords([old, recent, open, hasFlow], [hasFlow.flowId], now).map((x) => x.flowId), [recent.flowId, open.flowId])
  // Freed and unread: nothing to follow.
  assert.deepEqual(r.unreadRecords([send({ released: true })], [], now), [])
  // A record of more than one send keeps saying so however old its answer, because nothing else names the other.
  const both = send({ flowId: '0x' + '05'.repeat(32), tx: txRecord('settled'), alsoSent: [txRecord('settled', { hash: TX2 })], server: { state: 'settled', txHash: TX, flowId: FLOW, at: new Date(now - r.ANSWER_SHOWN_MS - 1).toISOString() } })
  assert.deepEqual(r.unreadRecords([both], [], now), [both])
  assert.deepEqual(r.unreadRecords([both], [both.flowId], now), [], 'with its flow read, the card says it')
  // And those flows are read ahead of other answers, because only five are read back.
  const newest = (n: number) => send({ flowId: '0x' + n.toString(16).padStart(64, '0'), tx: txRecord('settled'), server: { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED } })
  const order = r.readOrder([newest(11), newest(12), newest(13), newest(14), newest(15), newest(16), both, open])
  assert.deepEqual(order.slice(0, 3).map((x) => x.flowId), [open.flowId, both.flowId, newest(11).flowId], 'no answer, then more than one send, then the rest as they were')
  assert.match(page0, /readOrder\(sent\)\.slice\(0, LOCAL_FLOWS_READ\)/)
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /server\?\.state === 'settled'/)
  assert.match(page, /server\?\.state === 'ended'/)
})

test('a record with no answer keeps its tracker on a flow someone else closed, because nothing else can finish it', async () => {
  const r = await rules()
  const closed: Standing[] = [{ kind: 'settled' }, { kind: 'reverted' }]
  const answer = { state: 'settled', txHash: TX, flowId: FLOW, at: CHECKED }
  for (const s of closed) {
    for (const open of [send(), send({ tx: txRecord('pending') }), send({ tx: txRecord('settled') }), send({ tx: txRecord('untracked') }), send({ tx: txRecord('replaced'), paidBy: TX2 })]) {
      assert.equal(r.followedHere(open, s), true, `${s.kind}: ${JSON.stringify(open.tx?.outcome ?? 'asked')}`)
    }
    // Answered, the flow's own card says the rest, and nothing here holds anything.
    assert.equal(r.followedHere(send({ tx: txRecord('settled'), server: answer }), s), false, s.kind)
    assert.equal(r.followedHere(send({ released: true }), s), false, 'said to be nothing: the flow is what is left to say')
    assert.equal(r.followedHere(null, s), false, 'and with no record there is nothing to follow')
  }
  // On a flow still open, an answer such as a refusal stays on the tracker, as it always did.
  assert.equal(r.followedHere(send({ tx: txRecord('settled'), server: { ...answer, state: 'refused' } }), { kind: 'approvable' }), true)
  assert.equal(r.followedHere(send({ tx: txRecord('pending') }), { kind: 'stale', ageSeconds: 90_000n }), true)
  assert.equal(r.followedHere(null, { kind: 'approvable' }), false)
  // What the finish frees: this is the record that held the page's controls and every later check.
  const f = await flow()
  assert.equal(r.holdsPage(send({ tx: txRecord('pending') })), true)
  assert.equal(r.holdFor(f, [send({ flowId: '0x' + 'cd'.repeat(32), tx: txRecord('settled') })]).held, true)
  assert.equal(r.holdFor(f, [send({ flowId: '0x' + 'cd'.repeat(32), tx: txRecord('settled'), server: answer })]).held, false)
  // The card asks this and nothing else, and the tracker's refusal does not claim a read that branch never made.
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /if \(followedHere\(record, standing\)\) return <RequestCard \{\.\.\.props\} record=\{record\} \/>/)
  assert.doesNotMatch(page, /Our server read this transaction/)
  // An answer on a flow already read as over reads nothing again: the flows' read budget is the next Review's too.
  assert.equal(r.flowIsOver({ kind: 'settled' }), true)
  assert.equal(r.flowIsOver({ kind: 'reverted' }), true)
  assert.equal(r.flowIsOver({ kind: 'approvable' }), false)
  assert.match(page, /const flowOver = standing !== undefined && flowIsOver\(standing\)/)
  assert.match(page, /asking=\{asking\} standing=\{standing\}/)
  assert.match(page, /if \(!told\.current\.flowOver\) told\.current\.onLanded\(\)/)
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

test('the hold the card asks about is everything else from this page, whether or not an approval is on its way too', () => {
  const route = repo('src/routes/app/ArcVault.tsx')
  assert.match(route, /held=\{shownTx\?\.outcome === 'pending' \|\| setupTx !== null \|\| readBehind\}/)
  assert.doesNotMatch(route, /held=\{held && !handoffHeld\}/, 'which dropped the rest exactly when an approval held the page')
})

test('what the list cannot show is said as that, and a read that failed does not contradict the card it did not stop', async () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  const { VAULT_FLOWS_LIMIT } = (await import('./verify-then-pay/core.js')) as typeof import('./verify-then-pay/core.js')
  // The list is newest first with no age bound, and neither age nor a no closes a flow, so it can stay truncated for good.
  assert.match(page.replace(/\s+/g, ' '), new RegExp(`Only the newest ${VAULT_FLOWS_LIMIT} are listed, and saying no does not make room\\. If one you expect is missing, open the approval link your agent sent for it, which works until 24 hours after its check, or ask your agent to check that payee again\\.`))
  assert.doesNotMatch(page, /deal with these first/)
  assert.match(repo('docs/chains/arc-integration.mdx'), /saying no on the page records nothing, so neither age nor a no\s+makes room/)
  // A row past the list is still a flow the page reads by its link, as the card from a link shows.
  const guide = repo('docs/chains/arc-integration.mdx').replace(/\s+/g, ' ')
  assert.doesNotMatch(guide, /out of reach until your agent checks that payee again/)
  assert.match(guide, /a request past the newest 20 is not listed\. The approval link your agent sent for it still opens it on the page until 24 hours after its check/)
  assert.match(page, /direct \? readFlow\(direct\) : Promise\.resolve\(null\)/)
  // The named flow's own read can fail with the list still holding it, and they have separate budgets.
  assert.match(page, /\{direct && named\?\.failed && !linked && \(/)
})

test('a check from a separate key is said to get nothing here, with no way promised, and a refused card gives the check its reasons', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /A check your agent paid for from a separate key reads this way too, and this page offers nothing for it:\{' '\}\s+<GuideLink>the guide shows how to send ownerPay from the owner key<\/GuideLink> for one you know about\./)
  assert.doesNotMatch(page.slice(page.indexOf('other {others === 1'), page.indexOf('function Row(')), /Have it pay/)
  assert.match(page, /\{standing\.kind === 'refused' && <VerdictReasons reasons=\{flow\.verdict\?\.reasons \?\? \[\]\} \/>\}/)
})

test('the words about who can send and what a read is for say what the page does', () => {
  const page = repo('src/components/app/arc/OwnerApprovals.tsx')
  assert.match(page, /so a payment already made is not offered again\.\.\./)
  assert.doesNotMatch(page, /so this cannot be paid twice/, 'a prompt answered after a later send still pays')
  const guide = repo('docs/chains/arc-integration.mdx')
  assert.match(guide, /On this page only your own wallet can send the payment/)
  assert.doesNotMatch(guide, /only ever leaves from your own wallet/, 'it leaves from the vault, as the card says')
  // What the page follows, and the one order it does not reach.
  assert.doesNotMatch(guide, /It keeps and follows both hashes/)
  assert.match(guide, /keeps and follows each hash your wallet hands back/)
  assert.match(guide, /shows only in the vault's activity on the page/)
  // Which prompt it can speak for, and which payments its read keeps.
  const said = guide.replace(/\s+/g, ' ')
  assert.match(said, /It tells you to decline the last prompt it opened once the payment has left, or once a transaction your wallet sent for an earlier prompt is on its way/)
  assert.doesNotMatch(said, /tells you to decline a prompt once the payment has left/)
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
