/**
 * The "payment account changed" demo, both halves.
 *
 * A company's AI agent pays a supplier. A poisoned invoice then says the supplier's payment
 * account has changed. This script shows what happens to that payment:
 *
 *   Part 1, Web2: the company never touches a blockchain. It talks to A-Identity over plain
 *   HTTP with a normal session, sets which payees its agent may pay, and the agent asks before
 *   each payment. A changed payee is stopped before any money moves and waits for a human.
 *
 *   Part 2, Web3: the same attack against the NEAR spend vault, where the contract itself holds
 *   or refuses the payment. Checked with the zero-key judge against committed RPC answers
 *   (or live RPC with --online).
 *
 *   cd mcp && npm run build && node scripts/demo-payee-swap.mjs
 *   node scripts/demo-payee-swap.mjs --online         # Part 2 asks NEAR RPC live
 *   BASE=http://localhost:3399 node scripts/demo-payee-swap.mjs   # use a server you started
 *
 * Without BASE it boots its own backend from dist/ on a spare port with an EMPTY environment:
 * no DATABASE_URL, no signer key, no Circle key. So no payment in Part 1 can settle for real,
 * and the one that is allowed through is labeled simulated, because it is. Against a remote
 * BASE it needs CONFIRM=yes, because it writes an agent and its instructions there.
 *
 * Every step is also an assertion: the script exits 1 if anything behaves differently from
 * what it narrates, so the demo cannot drift from the product without someone noticing.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

const here = dirname(fileURLToPath(import.meta.url))
const MCP = join(here, '..')
const ROOT = join(MCP, '..')
const online = process.argv.includes('--online')

// ── output ───────────────────────────────────────────────────────────────────────────
let pass = 0
const failures = []
const say = (s = '') => console.log(s)
const scene = (title) => {
  say('')
  say(`== ${title} ${'='.repeat(Math.max(0, 70 - title.length))}`)
}
function check(label, cond, detail) {
  if (cond) {
    pass += 1
    say(`   PASS  ${label}`)
  } else {
    failures.push(`${label}${detail ? ` :: ${detail}` : ''}`)
    say(`   FAIL  ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

// ── backend ──────────────────────────────────────────────────────────────────────────
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

let child = null
let BASE = process.env.BASE
if (BASE) {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)
  if (!isLocal && process.env.CONFIRM !== 'yes') {
    console.error(`Refusing to run against ${BASE} without CONFIRM=yes. This writes an agent and its instructions.`)
    process.exit(1)
  }
} else {
  const port = await freePort()
  BASE = `http://127.0.0.1:${port}`
  // An empty environment on purpose: only what Node needs to start. Nothing here can sign,
  // reach a database, or move money.
  child = spawn(process.execPath, [join(MCP, 'dist', 'http.js')], {
    cwd: MCP,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500))
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (child.exitCode !== null) break
  }
  if (!up) {
    console.error(`The backend did not come up on ${BASE}. Did you run npm run build in mcp/?\n${stderr.slice(-2000)}`)
    child.kill()
    process.exit(1)
  }
}
const stop = () => { if (child && child.exitCode === null) child.kill() }
process.on('exit', stop)

let token = null
async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text }
}
const get = (p) => req('GET', p)
const post = (p, b) => req('POST', p, b)

// ── the cast ─────────────────────────────────────────────────────────────────────────
// Payee ids carry a per-run suffix, so no other record on a shared server can share a name
// with them and turn a simulated settlement into a real one.
const run = randomBytes(3).toString('hex')
const SUPPLIER = `vendor:northwind-supplies-${run}`
const LOOKALIKE = `vendor:northwind-supp1ies-${run}` // "l" swapped for "1", as on the NEAR side
const ATTACKER = `vendor:northwind-billing-update-${run}`
const INVOICE_USD = 120

say('A-Identity: "our payment account changed" demo')
{
  // Say which server answered and which commit it runs, so a recording shows what it was run against.
  const h = await fetch(`${BASE}/health`).then((r) => r.json(), () => null)
  const commit = h?.commitShort ? `, commit ${h.commitShort}` : ''
  say(`server ${BASE}${child ? ` (a local copy booted by this script with no keys and no database${commit})` : ` (${commit.slice(2) || 'commit unknown'})`}`)
}
say('')
say(`The company's real supplier:     ${SUPPLIER}`)
say(`Poisoned invoice, lookalike:     ${LOOKALIKE}`)
say(`Poisoned invoice, new account:   ${ATTACKER}`)

try {
  // ══ PART 1: WEB2 ═════════════════════════════════════════════════════════════════
  scene('Part 1 (Web2). Setup: the company signs in and sets its agent\'s authority')
  {
    const account = privateKeyToAccount(generatePrivateKey())
    const n = await post('/api/auth/nonce', { address: account.address })
    if (n.status !== 200 || !n.json?.message) throw new Error(`sign-in failed at nonce: ${n.status} ${n.text.slice(0, 200)}`)
    const signature = await account.signMessage({ message: n.json.message })
    const v = await post('/api/auth/verify', { address: account.address, message: n.json.message, signature })
    if (v.status !== 200 || !v.json?.token) throw new Error(`sign-in failed at verify: ${v.status} ${v.text.slice(0, 200)}`)
    token = v.json.token
    say('   The company signs in once and gets an ordinary bearer session. Everything below is plain HTTP + JSON.')
  }

  const reg = await post('/api/agents/register', {
    manifest: {
      name: `Demo AP Agent ${run}`,
      description: 'Accounts-payable agent created by scripts/demo-payee-swap.mjs.',
      category: 'finance',
      capabilities: ['pay supplier invoices'],
      ci: true,
    },
  })
  const agentId = reg.json?.agentId
  check('the company registers its accounts-payable agent', reg.status === 201 && typeof agentId === 'string', `${reg.status} ${reg.text.slice(0, 200)}`)
  if (!agentId) throw new Error('no agent, nothing to demo')

  const perm = await post('/api/agents/permissions', {
    agentId,
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 500, payeeAllowlist: [SUPPLIER], agentToAgent: true, frozen: false },
  })
  const p = perm.json?.agent?.permissions
  check(
    'the company sets its authority: $1000 a day, up to $500 without a human, and only to its real supplier',
    perm.status === 200 && p?.dailyCapUsd === 1000 && p?.autoApproveUnderUsd === 500 && p?.payeeAllowlist?.length === 1 && p.payeeAllowlist[0] === SUPPLIER,
    `${perm.status} ${JSON.stringify(p)}`,
  )

  const preflight = (payee, amountUsd, count) =>
    post('/api/agents/spend-preflight', { agentId, payee, amountUsd, ...(count ? { count } : {}) })
  const instruct = (payee, amountUsd, memo, count) =>
    post('/api/instructions', { agentId, type: 'pay', payee, amountUsd, memo, ...(count ? { count } : {}) })
  const execute = (id) => post('/api/instructions/execute', { id })

  // ── scene 1: the normal invoice ──
  scene(`Scene 1. A normal invoice: $${INVOICE_USD} to the real supplier`)
  const ok1 = await preflight(SUPPLIER, INVOICE_USD)
  say(`   Agent asks first. A-Identity answers: ${ok1.json?.verdict} (${ok1.json?.policyNote})`)
  check('the check allows it', ok1.json?.verdict === 'ALLOW' && ok1.json?.needsHumanApproval === false, JSON.stringify(ok1.json))
  const ix1 = await instruct(SUPPLIER, INVOICE_USD, 'Invoice NW-1041')
  check('the payment instruction is auto-approved inside the company\'s limits', ix1.status === 201 && ix1.json?.status === 'auto_approved', `${ix1.status} ${ix1.text.slice(0, 200)}`)
  const ex1 = await execute(ix1.json?.id)
  check(
    'and it executes (simulated: the supplier is a vendor id with no on-chain address, so no money moves in this demo)',
    ex1.status === 200 && ex1.json?.status === 'executed_simulated',
    `${ex1.status} ${ex1.text.slice(0, 200)}`,
  )
  const headroomBefore = (await preflight(SUPPLIER, 1)).json?.headroom?.remainingTodayUsd

  // ── scene 2: the poisoned invoice ──
  scene('Scene 2. A poisoned invoice: "our payment account changed", same amount')
  const bad = await preflight(LOOKALIKE, INVOICE_USD)
  say(`   Agent was fooled and asks to pay ${LOOKALIKE}.`)
  say(`   A-Identity answers: ${bad.json?.verdict}, codes ${JSON.stringify(bad.json?.codes)} (${bad.json?.policyNote})`)
  check(
    'the check stops it: the payee is not one the company authorized, and a human must decide',
    bad.json?.verdict !== 'ALLOW' && bad.json?.codes?.[0] === 'payee_not_allowed' && bad.json?.needsHumanApproval === true,
    JSON.stringify(bad.json),
  )
  check('the amount was within every limit, so the payee alone is what stopped it', !bad.json?.codes?.includes('daily_cap_exceeded') && !bad.json?.codes?.includes('above_auto_approve'), JSON.stringify(bad.json?.codes))
  const ix2 = await instruct(LOOKALIKE, INVOICE_USD, 'Invoice NW-1042 (new bank details)')
  check('a fooled agent that submits anyway gets pending_approval, not a payment', ix2.status === 201 && ix2.json?.status === 'pending_approval', `${ix2.status} ${ix2.text.slice(0, 200)}`)
  const ex2 = await execute(ix2.json?.id)
  check('and executing it is refused: nothing can move while it waits for a human', ex2.status >= 400 && /pending_approval/.test(ex2.text), `${ex2.status} ${ex2.text.slice(0, 200)}`)
  const headroomAfter = (await preflight(SUPPLIER, 1)).json?.headroom?.remainingTodayUsd
  check('the held payment did not touch today\'s budget', typeof headroomBefore === 'number' && headroomBefore === headroomAfter, `${headroomBefore} then ${headroomAfter}`)

  // ── scene 3: every way an attacker might phrase the swap ──
  scene('Scene 3. The attacker tries other shapes of the same swap')
  const variants = [
    [`a brand-new account (${ATTACKER})`, ATTACKER, INVOICE_USD],
    ['the real name in capitals', SUPPLIER.toUpperCase(), INVOICE_USD],
    ['the real name with a trailing space', `${SUPPLIER} `, INVOICE_USD],
    ['a tiny amount, $0.50, far under every limit', LOOKALIKE, 0.5],
    ['the invoice split into 10 payments of $12', LOOKALIKE, 12, 10],
  ]
  for (const [label, payee, amount, count] of variants) {
    const r = await instruct(payee, amount, `variant: ${label}`, count)
    check(`${label}: held for a human`, r.status === 201 && r.json?.status === 'pending_approval', `${r.status} ${r.json?.status} ${r.json?.policyNote ?? r.text.slice(0, 160)}`)
  }

  // ── scene 4: the human decides ──
  scene('Scene 4. A person at the company reviews the held payment and rejects it')
  const rej = await post('/api/instructions/reject', { id: ix2.json?.id, reason: 'Supplier confirmed by phone: bank details did not change.' })
  check('the rejection is recorded', rej.status === 200 && rej.json?.status === 'rejected', `${rej.status} ${rej.text.slice(0, 200)}`)
  const ex3 = await execute(ix2.json?.id)
  check('a rejected payment can never be executed afterwards', ex3.status >= 400, `${ex3.status} ${ex3.text.slice(0, 200)}`)

  // ── scene 5: the audit trail ──
  scene('Scene 5. The record: what moved, what did not, and why')
  const list = await get(`/api/instructions?agentId=${encodeURIComponent(agentId)}`)
  const rows = list.json?.instructions ?? []
  for (const r of rows) {
    const amount = r.count > 1 ? `${r.count} x $${r.amountUsd}` : `$${r.amountUsd.toFixed(2)}`
    say(`   ${String(r.status).padEnd(18)} ${amount.padStart(10)}  ${JSON.stringify(r.payee)}`)
  }
  const moved = rows.filter((r) => String(r.status).startsWith('executed'))
  check('exactly one payment executed, and it went to the real supplier', moved.length === 1 && moved[0].payee === SUPPLIER, JSON.stringify(moved.map((r) => r.payee)))
  check('every changed-payee attempt is on the record, none executed', rows.filter((r) => r.payee !== SUPPLIER).length === 6 && rows.every((r) => r.payee === SUPPLIER || !String(r.status).startsWith('executed')))

  // ── scene 6: the honest boundary ──
  scene('Scene 6. Why the company\'s list matters: the same attack with no list set')
  const reg2 = await post('/api/agents/register', { manifest: { name: `Demo Agent No List ${run}`, description: 'Control case for scripts/demo-payee-swap.mjs.', category: 'finance', capabilities: ['pay'], ci: true } })
  const open = reg2.json?.agentId
  if (open) await post('/api/agents/permissions', { agentId: open, permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 500, agentToAgent: true } })
  const openCheck = open ? await post('/api/agents/spend-preflight', { agentId: open, payee: LOOKALIKE, amountUsd: INVOICE_USD }) : null
  say(`   With no payee list, the lookalike payment answers: ${openCheck?.json?.verdict}`)
  check('an agent with an empty payee list would pay the lookalike: the protection is the authority the company sets', openCheck?.json?.verdict === 'ALLOW', JSON.stringify(openCheck?.json))
} catch (e) {
  failures.push(`Part 1 stopped: ${e.message}`)
  say(`   FAIL  Part 1 stopped: ${e.message}`)
} finally {
  stop()
}

// ══ PART 2: WEB3 ════════════════════════════════════════════════════════════════════
scene(`Part 2 (Web3). The same attack on the NEAR spend vault, ${online ? 'live from NEAR RPC' : 'replayed from committed RPC answers'}`)
say('   Here the contract enforces it: the agent\'s key can only call pay, and the vault reads the risk registry before USDC moves.')
const steps = [
  'tx-pay-known',
  'tx-pay-unknown',
  'tx-pay-deny',
  'tx-owner-pay-denied',
  'reject-call-token',
  'reject-owner-method',
  'reject-add-key',
  'mainnet-tx-pay-deny',
  'mainnet-tx-pay-warn-held',
]
const judgeArgs = [join(ROOT, 'near', 'judge', 'judge.mjs'), ...(online ? [] : ['--offline']), '--step', steps.join(',')]
const judged = await new Promise((resolve) => {
  const j = spawn(process.execPath, judgeArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  j.stdout.on('data', (d) => { out += d })
  j.stderr.on('data', () => {})
  j.on('close', (code) => resolve({ code, out }))
})
const lines = judged.out.split('\n').filter((l) => /^(PASS|FAIL|SKIP) /.test(l))
for (const l of lines) {
  const [verdict, id, ...rest] = l.split(' ')
  const claim = rest.join(' ').replace(/\s*\(.*$/, '')
  // Asked live, the judge falls back to the committed answers when RPC stops answering, and
  // says so on the line. Carry that through: a replayed check must not read as a live one.
  const replayed = online && /replayed evidence/.test(l) ? ' [replayed: live RPC did not answer]' : ''
  check(`${id}: ${claim}${replayed}`, verdict === 'PASS', verdict === 'PASS' ? undefined : l)
}
check('the judge checked every claim this demo names', lines.length === steps.length, `${lines.length} of ${steps.length} lines`)

// ── verdict ──────────────────────────────────────────────────────────────────────────
scene('Result')
if (failures.length === 0) {
  say(`   ${pass} checks passed. The changed payee was stopped in both worlds:`)
  say('   Web2: held by the policy before any instruction could execute, until a human decided.')
  say('   Web3: held or refused by the vault contract on chain, with no USDC transfer.')
} else {
  say(`   ${pass} passed, ${failures.length} failed:`)
  for (const f of failures) say(`   - ${f}`)
}
say('')
say('   What this does not show, said plainly:')
say('   - Part 1 settles nothing for real: the payees are vendor ids with no on-chain address, so the allowed payment is simulated.')
say('   - In Part 1 the agent and its owner use the same session. The policy is enforced on the server, but an')
say('     agent holding that session could also change the list or approve itself. In Part 2 it cannot: the')
say('     agent\'s key is limited by the NEAR protocol. A separate, narrower agent credential for Web2 is not built yet.')
say('   - The NEAR contracts are unaudited.')
process.exit(failures.length === 0 ? 0 : 1)
