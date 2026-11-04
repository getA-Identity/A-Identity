import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { TrustGuard, guard, TrustDenyError, PaymentRequiredError, UnusableVerdictError, type Decision } from './index.js'

/** Build a fake fetch that returns `status` + `body`, recording the last request. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

test('riskCheck posts to /tools/risk_check with the agent + txContext', async () => {
  const { fn, calls } = fakeFetch(200, { tool: 'risk_check', agentId: '849980', decision: 'ALLOW', risk: 'low', reasons: [] })
  const g = new TrustGuard({ fetch: fn, baseUrl: 'https://oracle.test/' })
  await g.riskCheck('849980', { amountUsd: 500, kind: 'payment' })
  assert.equal(calls[0].url, 'https://oracle.test/tools/risk_check')
  assert.deepEqual(JSON.parse(String(calls[0].init!.body)), { agentId: '849980', txContext: { amountUsd: 500, kind: 'payment' } })
})

test('guard() throws TrustDenyError on a DENY verdict', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'bad', decision: 'DENY', risk: 'high', reasons: ['KYA revoked'] })
  const g = new TrustGuard({ fetch: fn })
  await assert.rejects(() => g.guard('bad'), (e: unknown) => {
    assert.ok(e instanceof TrustDenyError)
    assert.equal(e.verdict.decision, 'DENY')
    assert.deepEqual(e.verdict.reasons, ['KYA revoked'])
    return true
  })
})

test('guard() returns the verdict on ALLOW (no throw)', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'ok', decision: 'ALLOW', risk: 'low', reasons: [] })
  const g = new TrustGuard({ fetch: fn })
  const v = await g.guard('ok')
  assert.equal(v.decision, 'ALLOW')
})

test('guard() stops on WARN by default, says what happened, and names the option', async () => {
  for (const rail of ['xlayer', 'algorand'] as const) {
    const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'meh', decision: 'WARN', risk: 'medium', reasons: ['we hold no record of it'] })
    const g = new TrustGuard({ rail, fetch: fn })
    await assert.rejects(() => g.guard('meh'), (e: unknown) => {
      assert.ok(e instanceof TrustDenyError)
      assert.equal(e.verdict.decision, 'WARN')
      assert.match(e.message, /the verdict is WARN/)
      assert.match(e.message, /we hold no record of it/)
      assert.match(e.message, /WARN does not pay by itself/)
      assert.match(e.message, /read the reasons/)
      // It can name evidence on the record, so the message must not say it is no finding.
      assert.doesNotMatch(e.message, /not that it is bad|not a finding/)
      assert.match(e.message, /pass denyOn: \['DENY'\]/)
      return true
    })
    await assert.rejects(() => guard('meh', { rail, fetch: fn }), TrustDenyError)
    // The caller says it in code, and gets the WARN back.
    assert.equal((await g.guard('meh', { denyOn: ['DENY'] })).decision, 'WARN')
    assert.equal((await guard('meh', { rail, fetch: fn, denyOn: ['DENY'] })).decision, 'WARN')
  }
})

test('DENY always throws, whatever denyOn says, and its message is not the WARN one', async () => {
  for (const rail of ['xlayer', 'algorand'] as const) {
    const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'bad', decision: 'DENY', risk: 'high', reasons: ['KYA revoked'] })
    const g = new TrustGuard({ rail, fetch: fn })
    for (const denyOn of [[], ['WARN'], ['DENY']] as const) {
      await assert.rejects(() => g.guard('bad', { denyOn: [...denyOn] }), (e: unknown) => {
        assert.ok(e instanceof TrustDenyError)
        assert.doesNotMatch(e.message, /denyOn/)
        return true
      })
    }
  }
})

test('guard({ denyOn: [DENY, WARN] }) also blocks a WARN', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'meh', decision: 'WARN', risk: 'medium', reasons: ['thin tenure'] })
  const g = new TrustGuard({ fetch: fn })
  await assert.rejects(() => g.guard('meh', { denyOn: ['DENY', 'WARN'] }), TrustDenyError)
  // ...but the default (DENY only) lets a WARN through.
  assert.equal((await g.guard('meh', { denyOn: ['DENY'] })).decision, 'WARN')
})

test('a 402 with no payer handler throws PaymentRequiredError', async () => {
  const { fn } = fakeFetch(402, { x402Version: 2, error: 'Payment required' })
  const g = new TrustGuard({ fetch: fn })
  await assert.rejects(() => g.riskCheck('849980'), PaymentRequiredError)
})

test('a 402 is retried with headers from onPaymentRequired, then succeeds', async () => {
  let hit = 0
  const fn = async (_url: string, init?: RequestInit) => {
    hit++
    if (hit === 1) return new Response(JSON.stringify({ error: 'Payment required' }), { status: 402 })
    // second call must carry the payment header the payer returned
    const paid = (init?.headers as Record<string, string>)?.['X-PAYMENT']
    assert.equal(paid, 'signed-voucher')
    return new Response(JSON.stringify({ tool: 'risk_check', agentId: 'x', decision: 'ALLOW', risk: 'low', reasons: [] }), { status: 200 })
  }
  const g = new TrustGuard({ fetch: fn, onPaymentRequired: async () => ({ 'X-PAYMENT': 'signed-voucher' }) })
  const v = await g.riskCheck('x')
  assert.equal(v.decision, 'ALLOW')
  assert.equal(hit, 2)
})

test('the algorand rail calls the site origin and its tool path', async () => {
  const { fn, calls } = fakeFetch(200, { tool: 'risk_check', agentId: '#1', decision: 'WARN', risk: 'medium', reasons: [] })
  const g = new TrustGuard({ rail: 'algorand', fetch: fn })
  await g.riskCheck('#1')
  assert.equal(calls[0].url, 'https://a-identity.xyz/api/x402/algorand/tools/risk_check')
})

test('batchAudit posts the shortlist on Algorand and refuses on the X Layer rail', async () => {
  const { fn, calls } = fakeFetch(200, { tool: 'agent_batch_audit', count: 2, summary: { ALLOW: 1, WARN: 0, DENY: 1 }, results: [] })
  const g = new TrustGuard({ rail: 'algorand', fetch: fn })
  const audit = await g.batchAudit(['#1', '#2'], { amountUsd: 10 })
  assert.equal(audit.summary.DENY, 1)
  assert.equal(calls[0].url, 'https://a-identity.xyz/api/x402/algorand/tools/agent_batch_audit')
  assert.deepEqual(JSON.parse(String(calls[0].init!.body)), { agentIds: ['#1', '#2'], txContext: { amountUsd: 10 } })
  await assert.rejects(() => new TrustGuard({ fetch: fn }).batchAudit(['#1']), /Algorand rail only/)
})

test('payCheck posts the address on Algorand and refuses on the X Layer rail', async () => {
  const { fn, calls } = fakeFetch(200, { verdict: 'careful', headline: 'Be careful', reasons: [] })
  const g = new TrustGuard({ rail: 'algorand', fetch: fn })
  const report = await g.payCheck('WHZ74ZGNGZGAVEQZTHESENVP5RTHMEQ4BOUKF7UHWOADQMKXDKAK3FESJE')
  assert.equal(report.verdict, 'careful')
  assert.equal(calls[0].url, 'https://a-identity.xyz/api/x402/algorand/tools/pay_check')
  assert.deepEqual(JSON.parse(String(calls[0].init!.body)), { address: 'WHZ74ZGNGZGAVEQZTHESENVP5RTHMEQ4BOUKF7UHWOADQMKXDKAK3FESJE' })
  await assert.rejects(() => new TrustGuard({ fetch: fn }).payCheck('X'), /Algorand rail only/)
})

test('a v2 challenge carried only in the PAYMENT-REQUIRED header reaches the payer', async () => {
  const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', amount: '1000' }] }
  let seen: unknown = null
  const fn = async () =>
    new Response('', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') } })
  const g = new TrustGuard({ fetch: fn, onPaymentRequired: async (c) => { seen = c; return null } })
  await assert.rejects(() => g.riskCheck('x'), PaymentRequiredError)
  assert.deepEqual(seen, challenge)
})

for (const rail of ['xlayer', 'algorand'] as const) {
  test(`guard() on the ${rail} rail returns only on a recognized decision, because the next line pays`, async () => {
    const answers: Array<[string, string]> = [
      ['an HTML page', '<!doctype html><title>Sign in</title>'],
      ['an empty body', ''],
      ['a body with no decision', '{"tool":"risk_check"}'],
      ['a lower-case decision', '{"decision":"deny"}'],
      ['an unknown decision', '{"decision":"MAYBE"}'],
    ]
    for (const [what, body] of answers) {
      const fn = async () => new Response(body, { status: 200 })
      for (const denyOn of [undefined, ['DENY'] as Decision[]]) {
        await assert.rejects(() => new TrustGuard({ rail, fetch: fn }).guard('x', { denyOn }), (e: unknown) => {
          assert.ok(e instanceof UnusableVerdictError, what)
          assert.equal(e.code, 'DECISION_UNKNOWN')
          return true
        })
      }
    }
    // What it does recognize it still returns, and it does not read further than the decision.
    const { fn } = fakeFetch(200, { decision: 'ALLOW', signals: { reputationScore: null } })
    assert.equal((await new TrustGuard({ rail, fetch: fn }).guard('x')).decision, 'ALLOW')
  })
}

test('only the arc rail restricts baseUrl: the other two keep what they took', () => {
  const { fn } = fakeFetch(200, {})
  assert.equal(new TrustGuard({ fetch: fn, baseUrl: 'http://oracle.test/' }).baseUrl, 'http://oracle.test')
  assert.equal(new TrustGuard({ rail: 'algorand', fetch: fn, baseUrl: 'http://oracle.test' }).baseUrl, 'http://oracle.test')
  assert.throws(() => new TrustGuard({ rail: 'arc', fetch: fn, baseUrl: 'http://oracle.test' }), TypeError)
})

test('the one-shot guard() helper works against a default client', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'z', decision: 'DENY', risk: 'high', reasons: ['sybil'] })
  await assert.rejects(() => guard('z', { fetch: fn }), TrustDenyError)
})

// ── the samples we publish compile against the package ───────────────────────────

/** The fenced ts blocks of a published page that use guard(), each compiled against this package's source. */
function compileGuardSamples(relativePath: string, declarations: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = resolve(here, '..', '..')
  const page = readFileSync(resolve(repo, relativePath), 'utf8')
  const blocks = [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /from ["']@a-identity\/trust-guard["']/.test(b) && /\bguard\(/.test(b))
  assert.ok(blocks.length > 0, `${relativePath} carries no guard() sample`)
  const errors: string[] = []
  blocks.forEach((block) => {
    const imports = block.split('\n').filter((l) => /^import /.test(l)).join('\n')
    const body = block.split('\n').filter((l) => !/^import /.test(l)).join('\n')
    const source = `${imports}\n${declarations}\nexport async function sample() {\n${body}\n}\n`
    const file = resolve(repo, 'trust-guard', 'src', '__sample.ts')
    const options: ts.CompilerOptions = {
      noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      baseUrl: resolve(repo, 'trust-guard'), paths: { '@a-identity/trust-guard': ['src/index.ts'] }, types: ['node'],
    }
    const host = ts.createCompilerHost(options)
    const read = host.readFile.bind(host)
    const exists = host.fileExists.bind(host)
    const getSource = host.getSourceFile.bind(host)
    host.readFile = (f) => (f === file ? source : read(f))
    host.fileExists = (f) => f === file || exists(f)
    host.getSourceFile = (f, v) => (f === file ? ts.createSourceFile(f, source, v, true) : getSource(f, v))
    const program = ts.createProgram([file], options, host)
    for (const d of ts.getPreEmitDiagnostics(program)) {
      errors.push(`${relativePath}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}\n${block}`)
    }
  })
  return errors
}

test('the guard() samples we publish compile, and the error fields they read exist', () => {
  const declared = 'declare const counterpartyAgentId: string\ndeclare const id: string\ndeclare function payTheAgent(): Promise<void>\ndeclare function payAgent(id: string, usd: number): Promise<void>\ndeclare function askAPerson(r: string[]): void\ndeclare const counterpartyId: string\ndeclare const payeeAddress: string\ndeclare const address: string\ndeclare const tx: { amountUsd: number }\ndeclare const opts: { denyOn: Array<"DENY" | "WARN"> }\ndeclare const wallet: any\n'
  assert.deepEqual(compileGuardSamples('docs/developers/sdk.mdx', declared), [])
  assert.deepEqual(compileGuardSamples('trust-guard/README.md', declared), [])
})
