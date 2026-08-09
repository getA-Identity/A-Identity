/**
 * Generic A-Identity marketplace worker: registers as a verified worker for one SERVICE, then
 * polls for funded tasks, does the real work with Claude, BUYS a helper service over x402 while
 * working (autonomous spending), and delivers.
 *
 * Four presets ship: translation, data-analysis, code-review, grant-coach. Pick one with
 * WORKER_SERVICE. Real work + real x402 purchase with ANTHROPIC_API_KEY / a funded backend
 * signer; honest stubs without, so the loop runs keyless.
 *
 * Run:  WORKER_SERVICE=data-analysis BASE=http://localhost:3399 node agents/worker.mjs
 * Env:  BASE, WORKER_SERVICE (translation|data-analysis|code-review|grant-coach), WORKER_KEY,
 *       ANTHROPIC_API_KEY, WORKER_POLL_MS, WORKER_MAX_CYCLES, WORKER_ENDPOINT.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { MarketplaceClient } from '../sdk/dist/index.js'

const MODEL = 'claude-opus-4-8'

/** Crude visible-text extraction for a fetched program page: drop scripts/styles/tags. */
export function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * grant-coach pre-step: fetch the program URL named in the task (plain fetch, 8s cap) and
 * inline the page's visible text so the drafted answers are grounded in the REAL program
 * page. An unreachable page becomes an honest inline note - the coach still drafts from
 * the applicant profile alone instead of failing the task.
 */
export async function prepareGrantCoachTask(instruction, fetchImpl = fetch) {
  const url = String(instruction).match(/https?:\/\/[^\s"'<>)\]]+/)?.[0]
  if (!url) return `${instruction}\n\n[no program URL found in the task - coaching from the applicant profile alone]`
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return `${instruction}\n\n[program page unreachable: HTTP ${res.status} - coaching from the applicant profile alone]`
    const pageText = stripHtml(await res.text()).slice(0, 6000)
    return `${instruction}\n\n[program page text from ${url}]\n${pageText || '(the page had no readable text)'}`
  } catch (e) {
    return `${instruction}\n\n[program page unreachable: ${e?.message ?? e} - coaching from the applicant profile alone]`
  }
}

/** Service presets: what the agent sells and how it does the work. */
export const PRESETS = {
  translation: {
    name: 'Lingua (translation worker)',
    service: 'translation',
    priceUsd: 2,
    unit: 'per doc',
    capabilities: ['translation'],
    system: 'You are a professional translator. Do exactly what the request asks. Output ONLY the translation, no preamble.',
  },
  'data-analysis': {
    name: 'DataMind (data-analysis worker)',
    service: 'data-analysis',
    priceUsd: 3,
    unit: 'per report',
    capabilities: ['data-analysis'],
    system: 'You are a data analyst. Given a request, produce a crisp, structured analysis or summary with concrete numbers where possible. Output only the analysis.',
  },
  'code-review': {
    name: 'CodeReviewer (code-review worker)',
    service: 'code-review',
    priceUsd: 5,
    unit: 'per PR',
    capabilities: ['code-review'],
    system: 'You are a senior code reviewer. Given a diff or snippet, list concrete issues (bugs, edge cases, security) with a short fix each. If none, say so. Output only the review.',
  },
  'grant-coach': {
    name: 'GrantCoach (grant & fellowship coach)',
    service: 'grant-coach',
    priceUsd: 4,
    unit: 'per application',
    capabilities: ['grant-coach'],
    system:
      'You are a grant and fellowship application coach. Given the text of a program page and an optional applicant profile, produce: (a) a short program summary, (b) the likely application questions, (c) drafted answers grounded ONLY in the applicant profile - mark any gap the applicant must fill instead of inventing facts. Output only the coaching document.',
    prepare: prepareGrantCoachTask,
  },
}

/** Do the work for a preset. Claude with ANTHROPIC_API_KEY, else a labeled stub. A preset
 *  may declare a `prepare` step (grant-coach fetches the program page) that runs in BOTH
 *  paths, so the stub is grounded in the same input the real work would be. */
export async function doWork(preset, instruction, env = process.env) {
  const text = String(instruction ?? '').slice(0, 6000)
  const input = preset.prepare ? await preset.prepare(text) : text
  if (!env.ANTHROPIC_API_KEY) return `[stub ${preset.service} - set ANTHROPIC_API_KEY for real work] ${input}`
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic()
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: preset.system,
    messages: [{ role: 'user', content: input }],
  })
  return msg.content.find((b) => b.type === 'text')?.text?.trim() || `[no output] ${input}`
}

/** Register + KYA-verify a worker for a preset (owner and agent wallet are the same key). */
export async function registerWorker(mp, account, preset) {
  return mp.registerAndVerify({
    name: preset.name,
    description: `An autonomous ${preset.service} worker on the A-Identity marketplace.`,
    category: preset.service,
    capabilities: preset.capabilities,
    services: [{ name: preset.service, priceUsd: preset.priceUsd, unit: preset.unit }],
    walletAddress: account.address,
    endpoint: process.env.WORKER_ENDPOINT,
    signMessage: (m) => account.signMessage({ message: m }),
  })
}

/** Process funded tasks: buy a helper service over x402, do the work, deliver. */
export async function processFundedTasks(mp, agentId, preset, env = process.env) {
  const { tasks } = await mp.agentJobs(agentId)
  const funded = (tasks ?? []).filter((t) => t.status === 'funded')
  for (const task of funded) {
    // Autonomous spending: buy a quality-check helper over x402 (gasless nanopayment) mid-task.
    let bought = ''
    try {
      const pay = await mp.nanopay(0.002)
      if (pay?.settle?.success || pay?.executed) bought = ' [bought a quality-check API via x402 nanopayment]'
      else if (pay?.executed === false) bought = ' [x402 helper prepared; no signer]'
    } catch {
      /* helper purchase is best-effort; never blocks delivery */
    }
    const result = await doWork(preset, task.description || `Do a ${preset.service} task`, env)
    await mp.deliver(task.id, result)
    console.error(`[worker:${preset.service}] delivered ${task.id}${bought}`)
  }
  return funded.length
}

async function main() {
  const base = process.env.BASE ?? 'https://a-identity-backend.onrender.com'
  const presetKey = process.env.WORKER_SERVICE ?? 'translation'
  const preset = PRESETS[presetKey]
  if (!preset) {
    console.error(`Unknown WORKER_SERVICE "${presetKey}". Options: ${Object.keys(PRESETS).join(', ')}`)
    process.exit(1)
  }
  const account = privateKeyToAccount(process.env.WORKER_KEY ?? generatePrivateKey())
  const pollMs = Number(process.env.WORKER_POLL_MS ?? 5000)
  const maxCycles = Number(process.env.WORKER_MAX_CYCLES ?? Infinity)

  console.error(`[worker:${preset.service}] wallet ${account.address} · backend ${base}`)
  console.error(`[worker:${preset.service}] work: ${process.env.ANTHROPIC_API_KEY ? `Claude (${MODEL})` : 'stub'}`)

  const mp = await MarketplaceClient.withWallet({ baseUrl: base, address: account.address, signMessage: (m) => account.signMessage({ message: m }) })
  const reg = await registerWorker(mp, account, preset)
  const agentId = reg.agent.id
  console.error(`[worker:${preset.service}] registered + verified as ${agentId}. Waiting for tasks...`)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let cycles = 0
  while (cycles < maxCycles) {
    try {
      await processFundedTasks(mp, agentId, preset)
    } catch (e) {
      console.error(`[worker:${preset.service}] cycle error:`, e?.message ?? e)
    }
    cycles += 1
    if (cycles < maxCycles) await sleep(pollMs)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[worker] fatal:', e)
    process.exit(1)
  })
}
