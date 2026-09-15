import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * One handler per method and path, across every file the server dispatches through.
 *
 * http.ts hands a request to each route group in a fixed order and the first group to claim
 * it wins, so a second handler for the same method and path is not an alternative: it is dead
 * code, and nothing fails when it goes dead. That happened. GET /api/agents/circle-policy was
 * the owner-gated Circle CLI plan in guardrail-routes.ts until 2026-09-10, when
 * agent-routes.ts, which is dispatched first, grew an attestation read at the same path. The
 * plan became unreachable and the console's Circle panel was handed a response it could not
 * render, while every test stayed green.
 */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

function routesIn(file: string): { method: string; path: string }[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/req\.method === '([A-Z]+)' && url\.pathname === '([^']+)'/g)].map((m) => ({
    method: m[1],
    path: m[2],
  }))
}

test('no method and path is handled twice, because only the first handler can ever answer', () => {
  const routeDir = join(SRC, 'http')
  const files = [
    join(SRC, 'http.ts'),
    ...readdirSync(routeDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(routeDir, f)),
  ]
  const seen = new Map<string, string>()
  const dupes: string[] = []
  let total = 0
  for (const file of files) {
    for (const r of routesIn(file)) {
      total += 1
      const key = `${r.method} ${r.path}`
      const where = file.slice(SRC.length)
      const first = seen.get(key)
      if (first) dupes.push(`${key}  (${first} and ${where})`)
      else seen.set(key, where)
    }
  }
  assert.ok(total >= 60, `expected the route files to still declare their routes, found ${total}`)
  assert.deepEqual(dupes, [], 'each of these is declared twice, and only the first ever answers:\n  ' + dupes.join('\n  '))
  // The two circle-policy reads, each at a path of its own.
  assert.equal(seen.get('GET /api/agents/circle-policy'), 'http/guardrail-routes.ts')
  assert.equal(seen.get('GET /api/agents/circle-policy/attestation'), 'http/agent-routes.ts')
})
