/**
 * Generate /.well-known/agent-skills/index.json from the SKILL.md files on disk.
 *
 * The Agent Skills Discovery format requires a SHA-256 digest per skill so a
 * consumer can tell whether the artifact it fetched is the one the index
 * described. A digest maintained by hand is a digest that goes stale on the
 * first edit and then quietly tells every reader the file has been tampered
 * with, so this computes them instead.
 *
 * Run: node scripts/gen-agent-skills-index.mjs
 * Check (CI, no write): node scripts/gen-agent-skills-index.mjs --check
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'public/.well-known/agent-skills')
const INDEX = join(SKILLS_DIR, 'index.json')

/** The one-line description a discovering agent reads to decide relevance. */
const DESCRIPTIONS = {
  'verify-before-paying':
    'Check an AI agent counterparty before sending it money. Returns ALLOW, WARN or DENY sized to the payment you intend to make.',
  'reproduce-a-reputation-score':
    'Read an agent reputation score from 0 to 1000 and recompute it yourself from the published method and public chain data.',
  'pay-with-x402':
    'Pay for an A-Identity call per request in USDC over x402, on X Layer or gaslessly on Circle Arc. No account and no API key.',
  'bound-an-agents-spending':
    'Give an AI agent spending authority without giving it your wallet: caps, an approval line, allowlists and a freeze, enforced where the agent cannot reach.',
  'guard-a-brokerage-agent':
    'Put a policy check in front of an agent that trades: set the rules once, get ALLOW, WARN or DENY per action with reasons, and keep a reconcilable trail of what happened next.',
  'hire-a-verified-agent':
    'Hire a KYA-verified agent with the payment held in an on-chain ERC-8183 escrow until the work is delivered and released.',
}

const dirs = readdirSync(SKILLS_DIR)
  .filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory())
  .sort()

const skills = dirs.map((name) => {
  const file = join(SKILLS_DIR, name, 'SKILL.md')
  const body = readFileSync(file)
  const description = DESCRIPTIONS[name]
  if (!description) {
    // A message, not a bare stack trace: the fix is an edit in THIS file, and the
    // person who just added a skill directory should be told so directly.
    console.error(
      `gen-agent-skills-index: no description registered for skill "${name}".\n` +
        `Add a one-line entry for it to DESCRIPTIONS in scripts/gen-agent-skills-index.mjs, ` +
        `then re-run: node scripts/gen-agent-skills-index.mjs`,
    )
    process.exit(1)
  }
  return {
    name,
    type: 'skill-md',
    description,
    url: `/.well-known/agent-skills/${name}/SKILL.md`,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  }
})

const doc = {
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills,
}
const next = JSON.stringify(doc, null, 2) + '\n'

if (process.argv.includes('--check')) {
  const current = readFileSync(INDEX, 'utf8')
  if (current !== next) {
    console.error('agent-skills/index.json is stale. Run: node scripts/gen-agent-skills-index.mjs')
    process.exit(1)
  }
  console.log(`agent-skills index is current (${skills.length} skills)`)
} else {
  writeFileSync(INDEX, next)
  console.log(`wrote ${INDEX} (${skills.length} skills)`)
  for (const s of skills) console.log(`  ${s.name}  ${s.digest.slice(0, 23)}...`)
}
