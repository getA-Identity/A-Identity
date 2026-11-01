/**
 * Generate the frontend's chain module from the backend chain registry.
 *
 *   cd mcp && npm run gen:chains
 *
 * The frontend is a separate package with a separate deploy, so it cannot import from
 * `mcp/src`. Rather than keep a second hand-maintained chain list (which is exactly the
 * drift this repo just paid for), we generate `src/lib/chains.ts` from
 * `mcp/src/chains/registry.ts` and let `frontend-sync.test.ts` fail the build if the
 * two ever disagree. See ../../MULTICHAIN-STRATEGY.md. It also writes `src/lib/arc-ledger.ts`, the
 * two lists /app/vault/arc needs from the provenance ledger (chains/frontend-ledger.ts).
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FRONTEND_ARC_LEDGER_MODULE, renderFrontendArcLedger } from '../dist/chains/frontend-ledger.js'
import { committedOurKeys } from '../dist/arc-owner-vault.js'
import { renderFrontendChains } from '../dist/chains/public-view.js'

const target = fileURLToPath(new URL('../../src/lib/chains.ts', import.meta.url))
const next = renderFrontendChains()

writeFileSync(target, next)
console.log(`Generated ${target} from mcp/src/chains/registry.ts`)

const ledgerTarget = fileURLToPath(new URL(`../../${FRONTEND_ARC_LEDGER_MODULE}`, import.meta.url))
writeFileSync(ledgerTarget, renderFrontendArcLedger(committedOurKeys()))
console.log(`Generated ${ledgerTarget} from mcp/src/chains/provenance.ts`)
