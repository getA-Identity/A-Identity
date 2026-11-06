import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  __resetPlatformStateForTests,
  agentManifest,
  checkAgentAction,
  createAgent,
  deliverTask,
  getAgentActionPolicy,
  getTask,
  hireAgent,
  listAgentAudits,
  listPlatformAgents,
  marketplaceCatalog,
  recordAuditOutcome,
  registerAgentFromManifest,
  releaseTask,
  updateAgentActionPolicy,
} from './platform.js'
import { MAX_AGENTS_PER_OWNER, agentQuotaComplaint, type Task } from './marketplace.js'
import { agentCreateVolume, chargeAgentCreate } from './rate-budget.js'
import { buildServer, type ServerData } from './server.js'
import { handleGuardrailRoutes } from './http/guardrail-routes.js'
import { publicAgents, type RouteCtx } from './http/shared.js'

/**
 * The manifest door, and every other MCP tool that writes or reads an owner's records.
 *
 * register_agent over MCP, POST /api/agents/register and POST /api/agents/register-url all
 * end in registerAgentFromManifest. Over MCP it used to take no session at all: a call with
 * no token created an agent record with no owner, a walletAddress was stored as typed (the
 * literal '0x<KENDI_ADRESIN>' was), and neither the per-account agent limit nor the
 * per-minute row count applied, though every other registration door enforces both. The
 * tool's own description said "Requires a verified session" the whole time.
 *
 * These pin the refusals where they now live, in the function every one of those doors
 * calls, and then audit the rest of the MCP surface the same way: every tool is either open
 * by design, with the reason written down, or refuses a caller with no session and changes
 * nothing.
 */

// Persistence off for this whole file: every agent below is written to memory only.
__resetPlatformStateForTests()

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const count = () => listPlatformAgents().length
let seq = 0
/** A fresh account per use, so the row budget one test spends is never another test's. */
const account = (label: string) => `${label}-${++seq}@register-door.test`

// ── registerAgentFromManifest ────────────────────────────────────────────────────

test('with no verified caller registration is Forbidden, before the manifest is read, and writes nothing', () => {
  const before = count()
  for (const caller of [undefined, '', '   ']) {
    const r = registerAgentFromManifest({ name: 'Ownerless' }, caller)
    assert.ok('error' in r, `caller ${JSON.stringify(caller)} must be refused`)
    assert.match(r.error, /^Forbidden: /, 'the refusal has to map to 403, like every other gate')
    assert.match(r.error, /verified session/)
    assert.match(r.error, /nothing was registered/)
  }
  // The caller is checked first: a stranger is not told what is wrong with their manifest.
  const nameless = registerAgentFromManifest({} as never, undefined)
  assert.ok('error' in nameless && nameless.error.startsWith('Forbidden: '), 'no caller outranks a missing name')
  assert.equal(count(), before, 'a refused registration must leave no row behind')
})

test('a walletAddress that is not 0x and 40 hex is refused and writes nothing; a real one is kept, none is null', () => {
  const owner = account('wallet')
  const before = count()
  for (const bad of ['0x<KENDI_ADRESIN>', '0x123', 'not-an-address', `0x${'g'.repeat(40)}`, ` 0x${'a'.repeat(40)}`, `0x${'a'.repeat(41)}`, 42, { address: '0x' }]) {
    const r = registerAgentFromManifest({ name: 'Bad wallet', walletAddress: bad }, owner)
    assert.ok('error' in r, `${JSON.stringify(bad)} must be refused`)
    assert.match(r.error, /walletAddress must be a 0x address/)
    assert.match(r.error, /nothing was registered/)
    assert.ok(!r.error.startsWith('Forbidden'), 'a malformed field is a 400, not a 403')
  }
  assert.equal(count(), before)

  const good = `0x${'aB'.repeat(20)}`
  const kept = registerAgentFromManifest({ name: 'Good wallet', walletAddress: good }, owner)
  assert.ok(!('error' in kept), JSON.stringify(kept))
  assert.equal(listPlatformAgents().find((a) => a.id === kept.agentId)?.walletAddress, good)
  // Absent, null and empty all mean no wallet, as on the other doors.
  for (const none of [undefined, null, '']) {
    const r = registerAgentFromManifest({ name: 'No wallet', walletAddress: none }, owner)
    assert.ok(!('error' in r), JSON.stringify(r))
    assert.equal(listPlatformAgents().find((a) => a.id === r.agentId)?.walletAddress, null)
  }
})

test('an account at its agent limit is refused by the shared rule, and nothing is written', () => {
  const owner = account('quota')
  for (let i = 0; i < MAX_AGENTS_PER_OWNER; i++) {
    createAgent({ name: `Seeded ${i}`, description: '', category: 'Other', capabilities: [], permissions: {}, owner })
  }
  const before = count()
  const r = registerAgentFromManifest({ name: 'One too many' }, owner)
  assert.ok('error' in r)
  assert.equal(r.error, agentQuotaComplaint(MAX_AGENTS_PER_OWNER), 'the same rule, word for word, as POST /api/agents')
  assert.equal(r.resetAt, undefined, 'a full account is not a rate limit, so it carries no retry time')
  assert.equal(count(), before)
})

test('past the per-minute row count the registration is refused with when to retry, and nothing is written', () => {
  const owner = account('rate')
  const { max } = agentCreateVolume('default')
  for (let i = 1; i <= max; i++) {
    const r = registerAgentFromManifest({ name: `Row ${i}` }, owner)
    assert.ok(!('error' in r), `row ${i} of ${max} fits`)
  }
  const before = count()
  const over = registerAgentFromManifest({ name: 'Over the budget' }, owner)
  assert.ok('error' in over)
  assert.match(over.error, /^Too many agents registered too quickly: this account may create \d+ per minute\. Nothing was registered/)
  assert.ok(over.resetAt && Date.parse(over.resetAt) > Date.now(), 'the refusal says when the window reopens')
  assert.equal(count(), before)
})

test('the manifest door charges the row ledger the other doors charge, so no door is a way around another', () => {
  const owner = account('ledger')
  const { max } = agentCreateVolume('default')
  // Spend the window the way POST /api/agents and /api/v1/agents/register spend it.
  for (let i = 0; i < max; i++) assert.equal(chargeAgentCreate(owner, 'default').ok, true)
  const r = registerAgentFromManifest({ name: 'After the other doors' }, owner)
  assert.ok('error' in r && r.resetAt, 'the manifest door must see what the other doors spent')
})

// ── the REST manifest door ───────────────────────────────────────────────────────

/** The smallest ServerResponse the guardrail routes use. */
function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown>; headers: Record<string, unknown> } = { headers: {} }
  return {
    out,
    res: {
      setHeader: (k: string, v: unknown) => {
        out.headers[k] = v
      },
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

/** POST to the guardrail route group as a signed-in account, past the session gate in http.ts. */
async function post(path: string, body: unknown, subject: string) {
  const { out, res } = fakeRes()
  const req = {
    method: 'POST',
    headers: {},
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return this
    },
  } as never
  const ctx: RouteCtx = { req, res, url: new URL(`http://localhost${path}`), caller: { subject, method: 'wallet' } as never, callerId: subject }
  const handled = await handleGuardrailRoutes(ctx)
  return { handled, ...out }
}

test('POST /api/agents/register answers 429 with a Retry-After once the row ledger is spent, and 400 for a bad wallet', async () => {
  const owner = account('rest')
  const { max } = agentCreateVolume('default')
  for (let i = 0; i < max; i++) chargeAgentCreate(owner, 'default')
  const before = count()
  const limited = await post('/api/agents/register', { manifest: { name: 'REST over budget' } }, owner)
  assert.equal(limited.status, 429, 'the answer POST /api/agents gives for the same spent ledger')
  assert.ok(Number(limited.headers['Retry-After']) >= 1, 'with a real Retry-After')
  assert.match(String(limited.body?.error), /^Too many agents registered too quickly/)
  assert.equal(typeof limited.body?.resetAt, 'string')

  const badWallet = await post('/api/agents/register', { manifest: { name: 'Bad', walletAddress: '0x<KENDI_ADRESIN>' } }, account('rest-wallet'))
  assert.equal(badWallet.status, 400)
  assert.match(String(badWallet.body?.error), /walletAddress/)
  assert.equal(count(), before, 'neither refusal left a row')

  const fine = await post('/api/agents/register', { manifest: { name: 'REST fine' } }, account('rest-ok'))
  assert.equal(fine.status, 201)
  assert.equal(fine.body?.erc8004Status && (fine.body.erc8004Status as { onchain?: string }).onchain, 'queued')
})

// ── every door, by source ────────────────────────────────────────────────────────

function sourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, `${prefix}${entry}/`))
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(`${prefix}${entry}`)
  }
  return out
}

test('every door that writes an agent row runs the agent limit and charges the row ledger before the write', () => {
  const files = sourceFiles(SRC)
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  // Inside platform/, a function that creates an agent is either the manifest door, which
  // enforces everything itself, or registerExternalAgent, whose doors enforce it. A third
  // one has to be a decision, so it fails here until someone makes it.
  const platformWriters = files.filter((f) => f.startsWith('platform/') && f !== 'platform/agents.ts' && read(f).includes('createAgent('))
  assert.deepEqual(platformWriters.sort(), ['platform/guardrail.ts', 'platform/manifest.ts'])

  // Outside platform/, a file that writes the row directly runs the same two checks.
  const doors = files.filter((f) => !f.startsWith('platform/') && f !== 'platform.ts' && /\b(createAgent|registerExternalAgent)\(/.test(read(f)))
  assert.ok(doors.includes('http/agent-routes.ts') && doors.includes('http/marketplace-routes.ts'), `the scan found the known doors: ${doors.join(', ')}`)
  for (const door of doors) {
    const source = read(door)
    assert.ok(source.includes('agentQuotaComplaint('), `${door} writes an agent row and must run the per-account limit`)
    assert.ok(source.includes('chargeAgentCreate('), `${door} writes an agent row and must charge the row ledger`)
  }

  // And the manifest door does all of it before createAgent, or it is decoration.
  const guardrail = read('platform/guardrail.ts')
  const from = guardrail.indexOf('export function registerAgentFromManifest')
  const body = guardrail.slice(from, guardrail.indexOf('function buildRegistrationResult', from))
  const write = body.indexOf('createAgent(')
  for (const check of ['REGISTER_NEEDS_SESSION', 'WALLET_ADDRESS.test(', 'agentQuotaComplaint(', 'chargeAgentCreate(']) {
    const at = body.indexOf(check)
    assert.ok(at >= 0 && at < write, `registerAgentFromManifest must run ${check} before it writes the row`)
  }
})

// ── the MCP surface, tool by tool ────────────────────────────────────────────────

/** Tools any caller may use without a session, each with the reason that is safe. */
const OPEN_TOOLS: Record<string, string> = {
  resolve_agent: 'a live chain read',
  get_reputation: 'a read',
  list_agents: 'the public list',
  get_chain_status: 'the chain registry',
  evm_pay_check: 'chain reads; writes nothing',
  get_arc_status: 'a chain read',
  get_circle_status: 'a status read',
  list_capabilities: 'static',
  merchant_check: 'reads; creates no state',
  find_agent: 'the public catalog',
  get_agent_manifest: 'a public manifest',
  verify_then_pay: 'payment-gated like its REST route: a flow is written only once a Gateway payment is presented',
  verify_then_pay_receipt: 'records only what the receipt it reads from the chain proves, like its REST route',
}

/** Tools that write, or read an owner's records, with a call that would act if it were let through. */
function sessionCalls(agentId: string, taskId: string): Record<string, Record<string, unknown>> {
  return {
    hire_agent: { agentId, service: 'Payments', priceUsd: 2 },
    deliver_task: { taskId, deliverable: 'done' },
    check_task_status: { taskId },
    release_escrow: { taskId, rating: 5 },
    register_agent: { name: 'Anonymous agent', walletAddress: `0x${'1'.repeat(40)}` },
    policy_get: { agentId },
    policy_set: { agentId, policy: { perActionCapUsd: 1 } },
    pre_action_check: { agentId, surface: 'trade', intent: { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 5 }, snapshot: { todayNotionalUsd: 0, positions: [] } },
    audit_log: { agentId },
    record_audit_outcome: { agentId, auditId: 'aud_any', outcome: 'executed' },
  }
}

/** The hooks http.ts builds for a request with no verified session (mcpCaller undefined). */
function noSessionHooks(): ServerData {
  const mcpCaller: string | undefined = undefined
  return {
    listAgents: publicAgents,
    marketplace: {
      catalog: () => marketplaceCatalog(),
      manifest: (agentId) => agentManifest(agentId),
      hire: (input) => hireAgent({ ...input, client: mcpCaller }),
      deliver: (taskId, deliverable) => deliverTask(taskId, deliverable, mcpCaller),
      checkTask: (taskId) => getTask(taskId, mcpCaller),
      release: (taskId, opts) => releaseTask(taskId, opts, mcpCaller),
    },
    policy: {
      getPolicy: (agentId) => getAgentActionPolicy(agentId, mcpCaller),
      setPolicy: (agentId, policy) => updateAgentActionPolicy(agentId, policy, mcpCaller),
      check: (agentId, input) => checkAgentAction(agentId, input as never, mcpCaller),
      auditLog: (agentId, opts) => listAgentAudits(agentId, opts, mcpCaller),
      recordOutcome: (agentId, auditId, outcome, evidenceRef) => recordAuditOutcome(agentId, auditId, outcome as never, mcpCaller, evidenceRef),
      register: (manifest) => registerAgentFromManifest(manifest as never, mcpCaller),
    },
    // Registered so the classification below sees them; never called here (they read Arc Mainnet).
    verifyThenPay: {
      run: async () => assert.fail('verify_then_pay must not run in this test'),
      receipt: async () => assert.fail('verify_then_pay_receipt must not run in this test'),
    },
  }
}

const textOf = (r: unknown) => ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n')

test('over MCP every tool is open by design or refuses a caller with no session, and the refusals change nothing', async () => {
  const state = __resetPlatformStateForTests()
  const worker = createAgent({ name: 'Worker', description: 'A verified worker seeded for this test.', category: 'Research', capabilities: ['Payments'], permissions: {}, owner: account('owner') })
  worker.kya = 'verified'
  const now = new Date().toISOString()
  const task: Task = { id: 'task_gate', client: account('client'), agentId: worker.id, service: 'Payments', priceUsd: 2, description: '', status: 'delivered', createdAt: now, updatedAt: now }
  state.tasks.push(task)
  const before = JSON.stringify(state)

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildServer(noSessionHooks()).connect(serverSide)
  const client = new Client({ name: 'register-door-test', version: '0.0.0' })
  await client.connect(clientSide)
  const registered = (await client.listTools()).tools.map((t) => t.name)
  const calls = sessionCalls(worker.id, task.id)
  for (const name of registered) {
    assert.ok((name in OPEN_TOOLS) !== (name in calls), `${name} must be classified once: open with a reason, or session-only with a refusal case`)
  }
  for (const [name, args] of Object.entries(calls)) {
    assert.ok(registered.includes(name), `${name} is still registered`)
    const text = textOf(await client.callTool({ name, arguments: args }))
    assert.match(text, /Forbidden/, `${name} with no session must answer Forbidden, got: ${text.slice(0, 200)}`)
  }
  await client.close()
  assert.equal(JSON.stringify(state), before, 'no call without a session may change anything')
})

test('http.ts hands every MCP hook that needs a session the verified caller, never the raw one', () => {
  const src = readFileSync(join(SRC, 'http.ts'), 'utf8')
  const from = src.indexOf('const mcp = buildServer({')
  const to = src.indexOf('verifyThenPay: verifyThenPayMcpHooks(', from)
  assert.ok(from > 0 && to > from, 'the MCP hooks are still built in http.ts')
  const region = src.slice(from, to)
  assert.ok(!/\bcallerId\b/.test(region), 'a hook handed callerId would let a guest token act')
  const hooks = ['hire', 'deliver', 'checkTask', 'release', 'getPolicy', 'setPolicy', 'check', 'auditLog', 'recordOutcome', 'register']
  const starts = hooks.map((h) => ({ h, at: region.search(new RegExp(`\\b${h}: \\(`)) }))
  for (const { h, at } of starts) {
    assert.ok(at >= 0, `the ${h} hook is still wired`)
    const next = Math.min(...starts.map((s) => s.at).filter((x) => x > at), region.length)
    assert.ok(region.slice(at, next).includes('mcpCaller'), `the ${h} hook must be handed mcpCaller`)
  }
})

test('a task row with no client is still closed to a caller with no session', async () => {
  const state = __resetPlatformStateForTests()
  const worker = createAgent({ name: 'Worker', description: '', category: 'Other', capabilities: [], permissions: {}, owner: account('owner') })
  const now = new Date().toISOString()
  // No path writes such a row today; a hand-edited or migrated one must not open the gate.
  const legacy: Task = { id: 'task_legacy', client: undefined as unknown as string, agentId: worker.id, service: 's', priceUsd: 1, description: '', status: 'delivered', createdAt: now, updatedAt: now }
  state.tasks.push(legacy)
  const released = await releaseTask(legacy.id, {}, undefined)
  assert.ok('error' in released && released.error.startsWith('Forbidden'), JSON.stringify(released).slice(0, 200))
  assert.equal(legacy.status, 'delivered', 'nothing was released')
  const read = getTask(legacy.id, undefined)
  assert.ok('error' in read && read.error.startsWith('Forbidden'), 'and nothing is read')
})
