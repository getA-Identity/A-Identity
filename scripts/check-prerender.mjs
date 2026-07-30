/**
 * Fail the build when the committed prerender snapshot is older than the source.
 *
 * This is the price of keeping the snapshot in the repo instead of generating it
 * at deploy time. Without this check the failure mode is silent and looks like
 * success: every page is there, full of text, and the text is out of date.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceHash } from './prerender-hash.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'prerendered/.sources.json')

if (!existsSync(MANIFEST)) {
  console.error('no prerender snapshot found. Run: npm run prerender')
  process.exit(1)
}

const recorded = JSON.parse(readFileSync(MANIFEST, 'utf8')).hash
const actual = sourceHash(ROOT)

if (recorded !== actual) {
  console.error(
    'the prerendered HTML is stale: source files have changed since it was taken.\n' +
      'Run: npm run prerender\n' +
      `  snapshot: ${recorded.slice(0, 23)}...\n` +
      `  sources:  ${actual.slice(0, 23)}...`,
  )
  process.exit(1)
}
console.log('prerender snapshot matches the current sources')
