import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A citation to a file nobody can open is worse than no citation.
 *
 * Thirteen comments across nine tracked source files pointed at `docs/robinhood-*.md`,
 * and all three of those documents are gitignored. Anyone who cloned this repository and
 * wanted to know WHY a rule exists was sent to a path that does not exist for them, which
 * is the exact reader those comments were written for. They now point at
 * `mcp/src/policy/README.md`, which is tracked.
 *
 * This test keeps it that way. It is not a style rule: a comment may name any file it
 * likes, as long as a reader of this repository can actually open it.
 */

/** Compiled to mcp/dist/, so the repo root is two levels up. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SRC = ROOT + 'mcp/src/'

/**
 * A markdown PATH cited in prose. The slash is required on purpose: a bare `auth.md` in a
 * comment is a published URL slug, not a file a reader is being sent to on disk, and
 * treating it as one would fail this test for a document that is exactly where it belongs.
 */
// `.mdx` counts too, and the trailing lookahead is what makes that safe: without it a
// citation of a .mdx file (the docs site's format) matched as a .md file that does not
// exist, and the failure read like a broken link when the link was fine.
const CITATION = /(?:^|[\s(`"'])((?:\.{1,2}\/)*[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.mdx?)(?![A-Za-z0-9])/g

/**
 * This file quotes example citation paths in its own comments and regex, so scanning it
 * would report its own examples. It is the one file whose citations are not claims.
 */
const SELF = 'docs-citations.test.ts'

/**
 * Known dangling citations, each recorded with the reason it is on the books rather than
 * fixed. Same pattern as `chains/no-hardcoded-chains.test.ts`: an entry here is a decision
 * on the record, which is the point of listing them instead of loosening the check.
 *
 * Keyed by the basename of the cited document.
 */
const KNOWN_DANGLING: Record<string, string> = {
  // Empty on purpose. MULTICHAIN-STRATEGY.md used to live here: ten tracked sources cited
  // it while it was gitignored, which CI caught the moment this test existed, because a
  // fresh clone genuinely does not have the file. The fix was the same one the policy
  // module got: a tracked README next to the code, carrying what the code actually cites.
}

function tsFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...tsFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`))
    } else if (entry.name.endsWith('.ts') && entry.name !== SELF) {
      out.push(`${prefix}${entry.name}`)
    }
  }
  return out
}

type Citation = { file: string; line: number; cited: string; resolved: string | null }

/**
 * Where a reader would actually find the cited document, or null.
 *
 * Three candidates, in order, because what is being guarded is REACHABILITY rather than
 * path arithmetic. A citation whose `../` depth is off by one still names a document that
 * exists and that a reader can open; a citation to a gitignored or deleted file does not,
 * and that is the failure worth a build.
 */
function resolveCitation(fileDir: string, cited: string): string | null {
  const candidates = [
    join(fileDir, cited),
    join(ROOT, cited),
    // Leading `../` stripped, resolved from the repo root: covers a root-level document
    // cited from a file one directory deeper than the author counted.
    join(ROOT, cited.replace(/^(?:\.{1,2}\/)+/, '')),
  ].map(normalize)
  return candidates.find((c) => existsSync(c)) ?? null
}

function citations(): Citation[] {
  const out: Citation[] = []
  for (const rel of tsFiles(SRC)) {
    const lines = readFileSync(SRC + rel, 'utf8').split('\n')
    const fileDir = dirname(SRC + rel)
    lines.forEach((text, i) => {
      for (const m of text.matchAll(CITATION)) {
        out.push({ file: `mcp/src/${rel}`, line: i + 1, cited: m[1], resolved: resolveCitation(fileDir, m[1]) })
      }
    })
  }
  return out
}

/** Paths git considers ignored. Returns null when git cannot be consulted at all. */
function ignoredPaths(paths: string[]): Set<string> | null {
  if (!paths.length) return new Set()
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT,
      input: paths.join('\n'),
      encoding: 'utf8',
      // check-ignore exits 1 when nothing matched, which is the common case here.
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return new Set(out.split('\n').filter(Boolean).map((p) => normalize(join(ROOT, p))))
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 1) return new Set()
    // No git, or not a work tree. The existence half of this test still runs.
    return null
  }
}

test('every markdown path cited in a source file exists', () => {
  const all = citations()
  assert.ok(all.length >= 10, `expected the sources to carry citations, found ${all.length}`)
  const missing = all
    .filter((c) => c.resolved === null)
    .map((c) => `${c.file}:${c.line} cites "${c.cited}", which does not exist anywhere a reader could open it`)
  assert.deepEqual(missing, [], missing.join('\n'))
})

test('no source file cites a gitignored document', () => {
  const all = citations().filter((c): c is Citation & { resolved: string } => c.resolved !== null)
  const ignored = ignoredPaths(all.map((c) => relative(ROOT, c.resolved)))
  if (ignored === null) {
    // Reported rather than silently passed: a green test that checked nothing is the
    // failure mode this whole file exists to prevent.
    console.log('[docs-citations] git is unavailable here; the gitignore half was skipped')
    return
  }
  const dangling = all
    .filter((c) => ignored.has(c.resolved) && !KNOWN_DANGLING[basename(c.resolved)])
    .map(
      (c) =>
        `${c.file}:${c.line} cites "${c.cited}", which is gitignored. Anyone who clones this repo cannot open it: move the reasoning into a tracked file (see mcp/src/policy/README.md) and cite that.`,
    )
  assert.deepEqual(dangling, [], dangling.join('\n'))
})

test('every recorded exception is still a real problem', () => {
  // An exception that outlives its cause is how a guard quietly stops guarding. If the
  // document becomes tracked, this fails and the entry has to go.
  const all = citations().filter((c): c is Citation & { resolved: string } => c.resolved !== null)
  const ignored = ignoredPaths(all.map((c) => relative(ROOT, c.resolved)))
  if (ignored === null) return
  for (const name of Object.keys(KNOWN_DANGLING)) {
    const stillDangling = all.some((c) => basename(c.resolved) === name && ignored.has(c.resolved))
    assert.ok(stillDangling, `KNOWN_DANGLING lists "${name}", which is no longer cited or no longer gitignored. Delete the entry.`)
  }
})

test('the policy README carries the sections the code cites', () => {
  // The citations are by section title, so a rename in the README silently breaks them the
  // same way a gitignored path did. These are the anchors currently referenced.
  const readme = readFileSync(SRC + 'policy/README.md', 'utf8')
  for (const heading of [
    'The five things we do not do',
    'Why the owner surface is free',
    'Why a verdict is a comparison, not advice',
    'Snapshot minimization',
    'Red lines',
    'Splitting one large action into many small ones',
    'An agent that writes its own snapshot',
    'The rule that keeps this module a core',
  ]) {
    assert.ok(readme.includes(`## ${heading}`) || readme.includes(`### ${heading}`), `policy/README.md has no section "${heading}"`)
  }
})

test('the policy README is tracked, not gitignored', () => {
  const ignored = ignoredPaths(['mcp/src/policy/README.md'])
  if (ignored === null) return
  assert.equal(ignored.size, 0, 'mcp/src/policy/README.md is gitignored, which defeats the point of writing it')
})
