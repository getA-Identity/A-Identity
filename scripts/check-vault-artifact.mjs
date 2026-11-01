/**
 * Fail the build when the browser's copy of the AgentSpendPolicy artifact has drifted from the
 * backend's, or the backend's from its Solidity source.
 *
 * /app/vault/arc hands a wallet the creation code in src/lib/contracts/agent-spend-policy.ts
 * to deploy, and checks deployed vaults against the runtime in it. The root build is what
 * Vercel runs and it never runs the mcp tests, so without this a stale or hand-edited copy
 * would deploy and the page would offer a build nobody reviewed.
 *
 * No solc and no mcp build here, on purpose: the source check compares the sha256 of the .sol
 * with the hash compile-contracts.mjs embedded when it compiled, which catches a source edit
 * that was never recompiled (commit 33c7df69) in milliseconds. A full recompile against the
 * pinned compiler runs in CI (npm run compile --prefix mcp -- --check).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = 'mcp/contracts/AgentSpendPolicy.sol'
const BACKEND = 'mcp/src/contracts/AgentSpendPolicy.ts'
const FRONTEND = 'src/lib/contracts/agent-spend-policy.ts'
const FIX = 'Run: cd mcp && npm run compile && npm run gen:contracts, then commit the result.'

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const backend = read(BACKEND)
const frontend = read(FRONTEND)
const problems = []

/** The value of `export const NAME = <value> as const`, as written. */
function exported(text, file, name) {
  const head = `export const ${name} = `
  const start = text.indexOf(head)
  const end = start < 0 ? -1 : text.indexOf(' as const\n', start)
  if (start < 0 || end < 0) {
    problems.push(`${file} does not export ${name}`)
    return null
  }
  return text.slice(start + head.length, end)
}

/** A quoted string literal, unquoted. */
const str = (v) => (v && /^'[^']*'$/.test(v) ? v.slice(1, -1) : null)
/** A JSON literal, parsed and re-serialized so formatting cannot hide or fake a difference. */
const json = (v) => {
  try {
    return v === null ? null : JSON.stringify(JSON.parse(v))
  } catch {
    return null
  }
}

const sourceSha = createHash('sha256').update(readFileSync(join(ROOT, SOURCE))).digest('hex')
const pairs = [
  ['source hash', str(exported(backend, BACKEND, 'AgentSpendPolicySourceSha256')), str(exported(frontend, FRONTEND, 'AGENT_SPEND_POLICY_SOURCE_SHA256'))],
  ['creation code', str(exported(backend, BACKEND, 'AgentSpendPolicyBytecode')), str(exported(frontend, FRONTEND, 'AGENT_SPEND_POLICY_BYTECODE'))],
  ['runtime code', str(exported(backend, BACKEND, 'AgentSpendPolicyDeployedBytecode')), str(exported(frontend, FRONTEND, 'AGENT_SPEND_POLICY_RUNTIME'))],
  ['immutable ranges', json(exported(backend, BACKEND, 'AgentSpendPolicyImmutableReferences')), json(exported(frontend, FRONTEND, 'AGENT_SPEND_POLICY_IMMUTABLES'))],
  ['ABI', json(exported(backend, BACKEND, 'AgentSpendPolicyAbi')), json(exported(frontend, FRONTEND, 'AGENT_SPEND_POLICY_ABI'))],
]

const [, embeddedSha] = pairs[0]
if (embeddedSha !== null && embeddedSha !== sourceSha) {
  problems.push(`${SOURCE} changed after ${BACKEND} was compiled (sha256 ${sourceSha.slice(0, 12)}... on disk, ${embeddedSha.slice(0, 12)}... compiled)`)
}
for (const [what, b, f] of pairs) {
  // Nothing was compared unless both sides were read, so either one missing is a failure, both too.
  if (b === null || f === null) {
    const unread = [b === null ? BACKEND : null, f === null ? FRONTEND : null].filter(Boolean).join(' and ')
    problems.push(`the ${what} could not be read from ${unread}`)
    continue
  }
  if (b !== f) problems.push(`the ${what} in ${FRONTEND} differs from ${BACKEND}`)
}

if (problems.length) {
  console.error(`The vault artifact is out of step:\n  ${[...new Set(problems)].join('\n  ')}\n${FIX}`)
  process.exit(1)
}
console.log('vault artifact: the browser copy matches the compiled artifact, and the artifact matches its source')
