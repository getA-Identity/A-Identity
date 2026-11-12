#!/usr/bin/env node
/**
 * Copy the NEAR verdict engine and its collectors into the backend.
 *
 *   cd mcp && npm run gen:near                    write mcp/src/chains/near/sdk.generated/
 *   node scripts/gen-near-engine.mjs --check      compare only; exit 1 on any difference
 *
 * One engine, two places. The canonical engine and collectors live in near/sdk/src: pure
 * TypeScript with erasable syntax only, run by Node's type stripping, so their imports are
 * written with .ts extensions. The backend compiles with tsc and imports with .js extensions,
 * so it gets a generated COPY: every file the two entry points (engine/index.ts and
 * collect/index.ts) reach, byte for byte, behind a GENERATED header, with each relative import
 * specifier rewritten from .ts to .js. Nothing else changes. That is the whole point: the
 * backend decides with the very code the SDK CLI runs, so `npm run verdict` and
 * GET /api/near/check give one answer. chains/near/engine.test.ts fails the build when the
 * copy differs from a fresh render of the source.
 *
 * The copy carries the SDK's host list (collect/networks.ts) because it is a copy, and it
 * lives under chains/, the one directory the hardcoded-host guard exempts. The backend never
 * dials that list: chains/near/engine.ts builds the collectors' hosts from the near-testnet
 * descriptor in chains/registry.ts.
 *
 * A bare import (a package) fails the render. The engine and the collectors are
 * dependency-free on purpose, and a copy that needed near-api-js would not build here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MCP_ROOT = join(HERE, '..')
export const REPO_ROOT = join(MCP_ROOT, '..')
/** The canonical source. */
export const SDK_SRC = join(REPO_ROOT, 'near', 'sdk', 'src')
/** The generated copy, relative paths preserved. */
export const OUT_DIR = join(MCP_ROOT, 'src', 'chains', 'near', 'sdk.generated')
/** Where the walk starts: the engine's surface and the collectors' surface. */
export const ENTRIES = ['engine/index.ts', 'collect/index.ts']

/** The header every generated file starts with. ASCII only (ascii-punctuation.test.ts reads it). */
export function headerFor(rel) {
  return [
    '// GENERATED FILE: do not edit.',
    `// Source: near/sdk/src/${rel}, the NEAR verdict engine's canonical copy.`,
    '// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source\'s',
    '// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts',
    '// fails the build when this file differs from a fresh render. Change the source, then rerun.',
    '',
    '',
  ].join('\n')
}

// Where a module specifier can sit in the SDK's style: `import ... from "x";`, `export ... from
// "x";`, the closing `} from "x";` of a statement that spans lines, and a bare `import "x";`.
const FROM_LINE = /^(\s*(?:(?:import|export)\b.*?\bfrom|\}\s*from)\s*)(["'])([^"']+)\2/
const SIDE_EFFECT_LINE = /^(\s*import\s*)(["'])([^"']+)\2/

/**
 * The specifiers a source file imports or re-exports, and its text with every relative `.ts`
 * specifier rewritten to `.js`. Throws on a bare specifier and on anything the line rules
 * cannot place, rather than copying a file that would not build.
 */
export function rewriteSource(rel, text) {
  const specifiers = []
  const lines = text.split('\n').map((line) => {
    const m = FROM_LINE.exec(line) ?? SIDE_EFFECT_LINE.exec(line)
    if (!m) return line
    const spec = m[3]
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      throw new Error(`near/sdk/src/${rel} imports "${spec}": the engine and collectors must stay dependency-free to be copied into the backend`)
    }
    if (!spec.endsWith('.ts')) {
      throw new Error(`near/sdk/src/${rel} imports "${spec}" without a .ts extension, which Node's type stripping would not resolve`)
    }
    specifiers.push(spec)
    return line.slice(0, m.index) + m[1] + m[2] + spec.slice(0, -3) + '.js' + m[2] + line.slice(m.index + m[0].length)
  })
  const out = lines.join('\n')
  // A specifier the line rules missed (a statement shaped in a way they do not know, or a
  // dynamic import) would keep its .ts extension and fail at runtime, so it fails here instead.
  const leftover = /(?:\bfrom\s*|\bimport\s*\(\s*)["'][^"']*\.ts["']/.exec(out)
  if (leftover) throw new Error(`near/sdk/src/${rel}: an import the generator could not rewrite: ${leftover[0]}`)
  return { specifiers, text: out }
}

/**
 * Render the copy: every file reachable from ENTRIES, keyed by its path relative to the SDK's
 * src/ (posix separators), each with its header and rewritten specifiers. Pure apart from
 * reading the source tree.
 */
export function renderNearEngine(sdkSrc = SDK_SRC) {
  if (!existsSync(sdkSrc)) throw new Error(`no NEAR SDK source at ${sdkSrc}`)
  const files = new Map()
  const queue = [...ENTRIES]
  while (queue.length) {
    const rel = queue.shift()
    if (files.has(rel)) continue
    const abs = join(sdkSrc, ...rel.split('/'))
    if (!existsSync(abs)) throw new Error(`near/sdk/src/${rel} is imported but does not exist`)
    const { specifiers, text } = rewriteSource(rel, readFileSync(abs, 'utf8'))
    files.set(rel, headerFor(rel) + text)
    for (const spec of specifiers) {
      const next = posix.normalize(posix.join(posix.dirname(rel), spec))
      if (next.startsWith('../')) throw new Error(`near/sdk/src/${rel} imports ${spec}, outside near/sdk/src`)
      queue.push(next)
    }
  }
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Every .ts file currently in the generated directory, as posix paths relative to it. */
export function listGenerated(outDir = OUT_DIR) {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts')) out.push(relative(outDir, full).split(sep).join('/'))
    }
  }
  walk(outDir)
  return out.sort()
}

/** What differs between a render and the directory: files to write, and files to remove. */
export function driftOf(rendered, outDir = OUT_DIR) {
  const changed = []
  for (const [rel, text] of rendered) {
    const abs = join(outDir, ...rel.split('/'))
    if (!existsSync(abs) || readFileSync(abs, 'utf8') !== text) changed.push(rel)
  }
  const stale = listGenerated(outDir).filter((rel) => !rendered.has(rel))
  return { changed, stale }
}

function main() {
  const check = process.argv.includes('--check')
  const rendered = renderNearEngine()
  const { changed, stale } = driftOf(rendered)
  if (check) {
    if (changed.length || stale.length) {
      console.error('mcp/src/chains/near/sdk.generated/ is not a fresh render of near/sdk/src. Run: cd mcp && npm run gen:near')
      for (const rel of changed) console.error(`  differs: ${rel}`)
      for (const rel of stale) console.error(`  stale:   ${rel}`)
      process.exit(1)
    }
    console.log(`sdk.generated/ matches near/sdk/src (${rendered.size} files)`)
    return
  }
  for (const rel of stale) rmSync(join(OUT_DIR, ...rel.split('/')))
  for (const [rel, text] of rendered) {
    const abs = join(OUT_DIR, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  console.log(`Generated ${relative(REPO_ROOT, OUT_DIR)} from near/sdk/src: ${rendered.size} files (${changed.length} changed, ${stale.length} removed)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
