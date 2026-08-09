#!/usr/bin/env node
/**
 * Celo ERC-8004 registry sweep — runs the live Celo agent registry through our own paid
 * trust oracle and writes a report.
 *
 * This is ORCHESTRATION ONLY. It never signs anything: every paid call is a subprocess
 * of scripts/celo-x402-buyer.mjs, the one money path in this repo, so the signing and
 * settlement behaviour here is byte-for-byte what a third-party buyer would get.
 *
 * What it does:
 *   1. Reads the real minted agent ids from Celo's IdentityRegistry (via Blockscout's
 *      token-instances index, so no eth_getLogs range limits).
 *   2. Runs a funnel: the cheap check on many agents, the expensive passport on few —
 *      which is how a trust oracle actually behaves and what the prices are shaped for.
 *   3. Writes a JSON report: per-agent verdicts, settlement tx hashes, and honest
 *      failures. Nothing is retried silently and nothing is invented.
 *
 * Every settlement it produces is real USDC moved by the Celo facilitator, is recorded
 * in /api/celo/proof, and is INTERNAL traffic: the buyer wallet is ours and the proof
 * page labels it as such. It is a demo of the rail, not third-party demand.
 *
 * Usage:
 *   node --env-file=.env scripts/celo-registry-sweep.mjs \
 *     --host https://a-identity-backend.onrender.com \
 *     --verify 120 --reputation 60 --risk 40 --passport 20 \
 *     --concurrency 4 --out ../_internal/celo-registry-sweep.json
 *
 *   --dry-run  resolves the agent list and prints the plan + cost, and pays nothing.
 *
 * Env: CELO_BUYER_KEY (read by the buyer subprocess, never by this file).
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUYER = resolve(HERE, 'celo-x402-buyer.mjs')

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const flag = (name) => process.argv.includes(`--${name}`)
const num = (name, def) => {
  const v = Number(arg(name, String(def)))
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def
}

const HOST = arg('host', 'https://a-identity-backend.onrender.com').replace(/\/$/, '')
const CONCURRENCY = Math.max(1, Math.min(6, num('concurrency', 4)))
const OUT = arg('out', '')
const SKIP = num('skip', 0)
const DRY = flag('dry-run')

const PRICES = { verify_agent: 0.001, reputation_score: 0.002, risk_check: 0.005, agent_passport: 0.01 }
const PLAN = [
  ['verify_agent', num('verify', 120)],
  ['reputation_score', num('reputation', 60)],
  ['risk_check', num('risk', 40)],
  ['agent_passport', num('passport', 20)],
]

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const INSTANCES = `https://celo.blockscout.com/api/v2/tokens/${IDENTITY_REGISTRY}/instances`

// ── 1. the real agent list, straight off Celo's registry ──────────────────────────
async function loadAgents(want) {
  const agents = []
  let params = ''
  for (let page = 0; page < 12 && agents.length < want; page++) {
    const res = await fetch(INSTANCES + params, {
      headers: { accept: 'application/json', 'user-agent': 'a-identity-registry-sweep' },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`blockscout answered ${res.status}`)
    const body = await res.json()
    for (const item of body.items ?? []) {
      const id = Number(item.id)
      if (!Number.isFinite(id)) continue
      agents.push({ id, name: (item.metadata?.name ?? '').trim() || null })
    }
    const next = body.next_page_params
    if (!next) break
    params = '?' + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString()
    await new Promise((r) => setTimeout(r, 300))
  }
  return agents
}

// ── 2. one paid call = one subprocess of the existing buyer script ────────────────
function buy(tool, agentId) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--env-file=.env', BUYER, '--url', `${HOST}/api/celo/tools/${tool}`, '--agent', `#${agentId}`],
      { cwd: resolve(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      // The buyer pretty-prints the response body between the "HTTP <n>" line and its
      // closing banner. Slice that, never re-derive it.
      const httpAt = out.lastIndexOf('\nHTTP ')
      const open = httpAt >= 0 ? out.indexOf('{', httpAt) : -1
      const close = out.lastIndexOf('}')
      let body = null
      if (open >= 0 && close > open) {
        try { body = JSON.parse(out.slice(open, close + 1)) } catch { /* left null on purpose */ }
      }
      resolvePromise({
        tool,
        agentId: `#${agentId}`,
        ok: code === 0 && body?.paid === true,
        tx: body?.settlement?.tx ?? null,
        priceUsd: body?.priceUsd ?? PRICES[tool],
        celoIdentity: body?.result?.celoIdentity ?? null,
        verdict: summarize(tool, body?.result),
        // Keep the facilitator's own words: "settle failed" alone hides whether it was a
        // nonce clash, a credit limit, or a real refusal.
        error:
          code === 0 && body?.paid === true
            ? null
            : [body?.error, body?.reason].filter(Boolean).join(': ') ||
              err.trim().split('\n').pop() ||
              `exit ${code}`,
      })
    })
  })
}

/** Keep only the load-bearing fields; the full body stays in /api/celo/proof + on-chain. */
function summarize(tool, result) {
  if (!result) return null
  if (tool === 'verify_agent') return { verified: result.verified, kya: result.kya_status, revoked: result.revoked }
  if (tool === 'reputation_score') {
    return { score: result.score, celoFeedbackCount: result.celoReputation?.feedbackCount ?? null, celoAverage: result.celoReputation?.averageScore ?? null }
  }
  if (tool === 'risk_check') return { verdict: result.verdict ?? result.decision ?? null, reasons: result.reasons?.slice?.(0, 3) ?? null }
  if (tool === 'agent_passport') return { verified: result.verified ?? null, score: result.reputation?.score ?? result.score ?? null }
  return null
}

// ── 3. run the funnel ─────────────────────────────────────────────────────────────
const totalCalls = PLAN.reduce((n, [, c]) => n + c, 0)
const totalUsd = PLAN.reduce((n, [t, c]) => n + c * PRICES[t], 0)
const maxNeeded = Math.max(...PLAN.map(([, c]) => c))

console.log(`Host:        ${HOST}`)
console.log(`Plan:        ${PLAN.map(([t, c]) => `${t} x${c}`).join(', ')}`)
console.log(`Calls:       ${totalCalls}   Cost: $${totalUsd.toFixed(3)} USDC   Concurrency: ${CONCURRENCY}`)

const agents = await loadAgents(SKIP + maxNeeded)
console.log(`Agents:      ${agents.length} minted ids read from ${IDENTITY_REGISTRY} (${agents.filter((a) => a.name).length} named)`)
if (agents.length < SKIP + maxNeeded) {
  console.log(`Note:        only ${agents.length} agents available; each tool is capped at what is left after --skip.`)
}

// Newest first is what Blockscout returns; a tool's slice starts at the top so the
// cheap check covers the widest span and the expensive one covers the most recent.
// --skip N continues a sweep where an earlier run stopped, so the second pass covers new
// agents instead of paying twice for the same verdict.
const queue = []
for (const [tool, count] of PLAN) {
  for (const agent of agents.slice(SKIP, SKIP + Math.min(count, agents.length))) queue.push({ tool, agent })
}
if (SKIP) console.log(`Skip:        first ${SKIP} agents (already covered by an earlier pass)`)

if (DRY) {
  console.log(`\nDRY RUN: ${queue.length} calls prepared, nothing paid.`)
  console.log(queue.slice(0, 6).map((q) => `  ${q.tool} -> #${q.agent.id} ${q.agent.name ?? ''}`).join('\n'))
  process.exit(0)
}

const started = new Date().toISOString()
const results = []
let done = 0
let cursor = 0
async function worker() {
  while (cursor < queue.length) {
    const item = queue[cursor++]
    const r = await buy(item.tool, item.agent.id)
    results.push({ ...r, agentName: item.agent.name })
    done++
    const mark = r.ok ? 'ok ' : 'FAIL'
    console.log(`[${String(done).padStart(3)}/${queue.length}] ${mark} ${item.tool.padEnd(16)} #${String(item.agent.id).padEnd(5)} ${r.tx ?? r.error ?? ''}`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const settled = results.filter((r) => r.ok)
const spent = settled.reduce((n, r) => n + r.priceUsd, 0)
const report = {
  what: 'A-Identity Trust Oracle swept the live Celo ERC-8004 identity registry through its own paid x402 tools.',
  honesty:
    'INTERNAL traffic: the buyer wallet is ours. These are real settlements of real USDC through the first-party Celo facilitator, run to exercise and demonstrate the rail, not third-party demand. Every settlement also appears in /api/celo/proof.',
  registry: IDENTITY_REGISTRY,
  network: 'eip155:42220',
  host: HOST,
  startedAt: started,
  finishedAt: new Date().toISOString(),
  agentsConsidered: agents.length,
  callsAttempted: results.length,
  callsSettled: settled.length,
  callsFailed: results.length - settled.length,
  usdSettled: Number(spent.toFixed(4)),
  byTool: Object.fromEntries(
    PLAN.map(([tool]) => [
      tool,
      {
        settled: settled.filter((r) => r.tool === tool).length,
        failed: results.filter((r) => r.tool === tool && !r.ok).length,
      },
    ]),
  ),
  results,
}

console.log(`\nSettled ${settled.length}/${results.length} calls for $${spent.toFixed(3)} USDC.`)
if (results.length !== settled.length) {
  console.log(`Failures kept in the report (not retried, not hidden): ${results.length - settled.length}`)
}
if (OUT) {
  const path = resolve(process.cwd(), OUT)
  await writeFile(path, JSON.stringify(report, null, 2))
  console.log(`Report: ${path}`)
}
