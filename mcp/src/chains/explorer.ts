/**
 * Explorer links, derived per ecosystem.
 *
 * This module exists because a link is a claim. `/proof/:rail` invites a reviewer to
 * check our work, and a dead link there is worse than no link: it reads as evidence and
 * resolves to nothing.
 *
 * ## The bug this replaces
 *
 * `provenance.ts` used to import `txUrl`/`addressUrl` straight from `evm/client.ts`, which
 * renders `<explorer>/address/<addr>` for everything. On Stellar Expert that route does
 * not exist. Verified against their API on 2026-08-15, which unlike the web app returns
 * real status codes rather than a single-page shell:
 *
 *   GET api.stellar.expert/explorer/public/account/G...   -> 200, real account JSON
 *   GET api.stellar.expert/explorer/public/address/G...   -> 404
 *   GET api.stellar.expert/explorer/public/contract/C...  -> 200, real contract JSON
 *
 * So every Stellar link would have been dead, and `provenance.test.ts` would have passed
 * it: that test only asserts the URL CONTAINS the address, which a wrong route does.
 *
 * ## Why a contract and an account are not both "an address"
 *
 * On EVM they are the same 20 bytes and the same explorer route, so collapsing them costs
 * nothing. On Stellar they are different StrKey types at different routes, and the
 * collapse is exactly the EVM assumption that produced the dead link. `addressUrl`
 * therefore dispatches on the StrKey prefix rather than asking the caller to know.
 */
import type { ChainDescriptor } from './types.js'
import { isAccountId, isContractId } from './stellar/strkey.js'

/**
 * The descriptor's explorer, or a loud failure.
 *
 * `ChainDescriptor.explorer` is `string | null`, because a `planned` chain may legitimately
 * have none. Every chain in the registry does have one today, and `registry.test.ts` pins
 * that. So a null reaching a link builder is a registry bug rather than a runtime
 * condition, and throwing beats the alternative: template interpolation would have
 * rendered the literal string `null/tx/<hash>`, which looks like evidence, resolves to
 * nothing, and passes `provenance.test.ts` because that test only asks whether the URL
 * contains the hash.
 */
function explorerBase(chain: ChainDescriptor): string {
  if (!chain.explorer) {
    throw new Error(
      `${chain.id} declares no explorer, so no link can be derived for it. Add one to the ` +
        `descriptor rather than letting a link render as "null/...".`,
    )
  }
  return chain.explorer
}

/** Explorer link for a transaction hash. `/tx/<hash>` on every explorer we use. */
export function txUrl(chain: ChainDescriptor, hash: string): string {
  return `${explorerBase(chain)}/tx/${hash}`
}

/**
 * Explorer link for an address, whatever kind of address the chain has.
 *
 * An unrecognised Stellar StrKey falls back to `/account/`, because the alternative is
 * returning null and having a caller render an empty href. A wrong-but-shaped link is
 * visibly wrong when clicked; a missing one is invisible.
 */
export function addressUrl(chain: ChainDescriptor, address: string): string {
  const base = explorerBase(chain)
  if (chain.ecosystem === 'stellar') {
    if (isContractId(address)) return `${base}/contract/${address}`
    if (isAccountId(address)) return `${base}/account/${address}`
    return `${base}/account/${address}`
  }
  if (chain.ecosystem === 'algorand') {
    // A settlement "address" on Algorand may be a uint64 ASA id rather than an
    // account; explorers route the two differently and /address/ exists on neither.
    if (/^[0-9]+$/.test(address)) return `${base}/asset/${address}`
    return `${base}/account/${address}`
  }
  return `${base}/address/${address}`
}
