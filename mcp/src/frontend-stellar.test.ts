import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The Stellar console's pure helpers, run from src/ as they ship.
 *
 * src/ has no test runner of its own, and what a helper RETURNS is not something a source
 * search can pin. So the module is imported straight from the repository through Node's
 * TypeScript type stripping (unflagged since Node 22.18; CI runs 22), which works for a file
 * whose only imports are type imports, like src/lib/stellar/kit.ts. Kept to such files on
 * purpose: a module that needs the bundler's path resolution cannot be loaded this way.
 */

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repo = (rel: string) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8')

type KitModule = {
  stellarWalletPresence: (w: { id: string; isAvailable: boolean }) => 'installed' | 'web' | 'missing'
  WEB_WALLET_IDS: ReadonlySet<string>
}
const loadKit = async () => (await import(repoUrl('src/lib/stellar/kit.ts').href)) as KitModule

test('a Stellar web wallet is never reported as found in this browser', async () => {
  const { stellarWalletPresence, WEB_WALLET_IDS } = await loadKit()
  // The kit reports Albedo and xBull as available in every browser, because each opens its
  // own site. "Available" therefore says nothing about what is installed here.
  for (const id of ['albedo', 'xbull']) {
    assert.ok(WEB_WALLET_IDS.has(id), `${id} is no longer listed as a web wallet`)
    assert.equal(stellarWalletPresence({ id, isAvailable: true }), 'web')
    assert.equal(stellarWalletPresence({ id, isAvailable: false }), 'web')
  }
  assert.equal(stellarWalletPresence({ id: 'freighter', isAvailable: true }), 'installed')
  assert.equal(stellarWalletPresence({ id: 'freighter', isAvailable: false }), 'missing')
  assert.equal(stellarWalletPresence({ id: 'lobstr', isAvailable: false }), 'missing')
})

test('the wallet picker labels a Stellar wallet by its presence, not by isAvailable', () => {
  // What shipped before: `status: w.isAvailable ? 'detected' : 'missing'`, which told a
  // person with no extension at all that Albedo and xBull were "Detected in this browser".
  const modal = repo('src/components/auth/WalletModal.tsx')
  assert.match(modal, /stellarWalletPresence\(w\)/, 'WalletModal no longer derives a Stellar row from stellarWalletPresence')
  assert.doesNotMatch(modal, /isAvailable\s*\?\s*'detected'/, 'WalletModal labels a Stellar wallet detected from isAvailable alone again')
  assert.match(modal, /Web wallet, opens its own site/, 'a web wallet row lost its own label')
})
