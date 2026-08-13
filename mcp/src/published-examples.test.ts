import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toolInputSchema, MCP_TOOL_NAMES } from './mcp-tool-schemas.js'

/**
 * Every JSON example we publish must be a call that would actually work.
 *
 * This test exists because for a long time none of them were. `pre_action_check` was
 * published as `{"kind":"payment","amountUsd":25,"payee":"0x..."}` in two places, which
 * has no field in common with the schema the server registers; `policy_get` was shown with
 * `{}`, `record_audit_outcome` without the agent or the audit id, and `hire_agent` with
 * `amountUsd` where the tool takes `priceUsd`. Every one of those is a reader following our
 * instructions and getting a protocol error, and nothing caught any of it, because the
 * documentation and the schema had no shared definition to disagree with.
 *
 * They share one now (mcp-tool-schemas.ts), so this walks the public surface, parses every
 * ```json fence, and validates any `tools/call` block against the real schema for its tool.
 *
 * Note the asymmetry, which is deliberate: this uses the STRICT object, while the wire
 * stays permissive. An unknown argument in a published example tells a reader to send
 * something that does nothing, and that is worth failing a build over. The same argument on
 * a live call is only noise. The wire schema must NOT be tightened to match: a malformed
 * intent has to reach the engine and come back as a recorded DENY, and a zod rejection
 * would write no audit row at all.
 */

/** Compiled to mcp/dist/, so the repo root is two levels up. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PUBLIC = ROOT + 'public/'
const SKILLS = PUBLIC + '.well-known/agent-skills/'

type Fence = { file: string; line: number; body: string }

/** Every ```json fence in a file, with the line its opening fence sits on. */
function jsonFences(relPath: string): Fence[] {
  const lines = readFileSync(ROOT + relPath, 'utf8').split('\n')
  const out: Fence[] = []
  let start = -1
  let buf: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (start === -1) {
      if (l === '```json') { start = i + 1; buf = [] }
    } else if (l === '```') {
      out.push({ file: relPath, line: start, body: buf.join('\n') })
      start = -1
    } else {
      buf.push(lines[i])
    }
  }
  // An unterminated fence is a broken document, and silently ignoring it would let a
  // truncated example escape validation entirely.
  assert.equal(start, -1, `${relPath}:${start} opens a \`\`\`json fence that is never closed`)
  return out
}

function skillDirs(): string[] {
  return readdirSync(SKILLS)
    .filter((d) => statSync(SKILLS + d).isDirectory())
    .sort()
}

/** Every published document that can carry a tool-call example. */
function publishedFiles(): string[] {
  return [
    ...skillDirs().map((d) => `public/.well-known/agent-skills/${d}/SKILL.md`),
    'public/llms.txt',
    'public/llms-full.txt',
  ]
}

test('every published JSON fence parses', () => {
  for (const file of publishedFiles()) {
    for (const fence of jsonFences(file)) {
      try {
        JSON.parse(fence.body)
      } catch (e) {
        assert.fail(`${fence.file}:${fence.line} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
})

test('every published tools/call example validates against the real schema', () => {
  let checked = 0
  for (const file of publishedFiles()) {
    for (const fence of jsonFences(file)) {
      const doc = JSON.parse(fence.body) as { method?: string; params?: { name?: string; arguments?: unknown } }
      if (doc?.method !== 'tools/call') continue
      const name = doc.params?.name
      assert.ok(
        typeof name === 'string' && name,
        `${fence.file}:${fence.line} is a tools/call block with no params.name`,
      )
      const schema = toolInputSchema(name as string)
      assert.ok(
        schema,
        `${fence.file}:${fence.line} calls "${name}", which is not a registered MCP tool. Known tools: ${MCP_TOOL_NAMES.join(', ')}`,
      )
      const parsed = schema!.safeParse(doc.params?.arguments ?? {})
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `arguments.${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')
        assert.fail(`${fence.file}:${fence.line} "${name}" example is invalid: ${issues}`)
      }
      checked++
    }
  }
  // A test that silently checks nothing is worse than no test: it reads as coverage.
  assert.ok(checked >= 7, `expected the published surface to carry tool-call examples, found ${checked}`)
})

test('every published skill directory is registered in the index generator', () => {
  // The generator throws on an unregistered skill, so a missing entry is caught at
  // generation time. It is asserted here too because the failure mode is the same class as
  // everything else in this file: a published artifact nobody described.
  const gen = readFileSync(ROOT + 'scripts/gen-agent-skills-index.mjs', 'utf8')
  for (const dir of skillDirs()) {
    assert.ok(
      gen.includes(`'${dir}':`),
      `public/.well-known/agent-skills/${dir}/ has no DESCRIPTIONS entry in scripts/gen-agent-skills-index.mjs`,
    )
  }
})

test('the published skills index lists exactly the skills on disk', () => {
  const index = JSON.parse(
    readFileSync(SKILLS + 'index.json', 'utf8'),
  ) as { skills: { name: string }[] }
  assert.deepEqual(
    index.skills.map((s) => s.name).sort(),
    skillDirs(),
    'index.json is stale. Run: node scripts/gen-agent-skills-index.mjs',
  )
})
