import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The platform/ split is only a structure if the layering rule survives contact with a
 * hurried commit. The rule lives in each module's docstring ("a module imports only lower
 * layers"), but a docstring cannot fail a build. This test can: it encodes the layer graph
 * and fails when a module reaches sideways or up, when the graph goes stale against the
 * directory, or when anything outside platform/ bypasses the barrel to import an internal
 * module directly. Same pattern as chains/no-hardcoded-chains.test.ts: the invariant that
 * produced the refactor is cheaper to keep than to rediscover.
 */

/** Compiled to dist/platform/, so mcp/src is two levels up. */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const PLATFORM = SRC + 'platform/'

/**
 * The layer of each platform module. A module may import a platform sibling only when the
 * sibling's layer is strictly lower. core is the floor: state, persistence, shared helpers.
 */
const LAYERS: Record<string, number> = {
  'core.ts': 1,
  'kya.ts': 2,
  'vault.ts': 2,
  'reputation.ts': 2,
  'instructions.ts': 2,
  'permissions.ts': 3,
  'agents.ts': 4,
  'guardrail.ts': 5,
  'feed.ts': 6,
  'tasks.ts': 7,
  'manifest.ts': 8,
}

/** Strip block comments and line comments so only real code is inspected. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

/** Every import specifier in a file: static `from '...'` plus dynamic `import('...')`. */
function importSpecifiers(file: string): string[] {
  const code = codeOnly(readFileSync(file, 'utf8'))
  const out: string[] = []
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) out.push(m[1])
  for (const m of code.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push(m[1])
  return out
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = dir + entry
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full + '/'))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

test('platform modules import only strictly lower layers, never http or the barrel', () => {
  for (const [name, layer] of Object.entries(LAYERS)) {
    const specs = importSpecifiers(PLATFORM + name)
    for (const spec of specs) {
      assert.ok(
        !spec.includes('../http'),
        `platform/${name} imports ${spec}: the write side must not depend on the HTTP surface`,
      )
      assert.ok(
        spec !== '../platform.js',
        `platform/${name} imports the barrel: that is a cycle by construction`,
      )
      const sibling = spec.match(/^\.\/([a-z-]+)\.js$/)
      if (!sibling) continue
      const target = sibling[1] + '.ts'
      const targetLayer = LAYERS[target]
      assert.ok(
        targetLayer !== undefined,
        `platform/${name} imports ./${sibling[1]}.js which is not in the layer map; add it with a layer`,
      )
      assert.ok(
        targetLayer < layer,
        `platform/${name} (L${layer}) imports ./${sibling[1]}.js (L${targetLayer}); a module may import only strictly lower layers`,
      )
    }
  }
})

test('the layer map matches the directory both ways', () => {
  const present = new Set(
    readdirSync(PLATFORM).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
  )
  for (const name of Object.keys(LAYERS)) {
    assert.ok(present.has(name), `layer map names ${name}, which no longer exists in src/platform/`)
  }
  for (const name of present) {
    assert.ok(
      LAYERS[name] !== undefined,
      `src/platform/${name} is not in the layer map; place it in a layer so the graph stays enforced`,
    )
  }
})

test('nothing outside platform/ imports an internal platform module past the barrel', () => {
  for (const file of tsFiles(SRC)) {
    if (file.startsWith(PLATFORM)) continue
    const name = file.slice(SRC.length)
    if (name === 'platform.ts') continue
    for (const spec of importSpecifiers(file)) {
      assert.ok(
        !/(^|\/)platform\/[a-z-]+\.js$/.test(spec),
        `${name} imports ${spec}: outside code goes through the barrel (./platform.js) so internal symbols stay internal`,
      )
    }
  }
})
