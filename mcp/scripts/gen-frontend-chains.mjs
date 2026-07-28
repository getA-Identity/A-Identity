/**
 * Generate the frontend's chain module from the backend chain registry.
 *
 *   cd mcp && npm run gen:chains
 *
 * The frontend is a separate package with a separate deploy, so it cannot import from
 * `mcp/src`. Rather than keep a second hand-maintained chain list (which is exactly the
 * drift this repo just paid for), we generate `src/lib/chains.ts` from
 * `mcp/src/chains/registry.ts` and let `frontend-sync.test.ts` fail the build if the
 * two ever disagree. See ../../MULTICHAIN-STRATEGY.md.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderFrontendChains } from '../dist/chains/public-view.js'

const target = fileURLToPath(new URL('../../src/lib/chains.ts', import.meta.url))
const next = renderFrontendChains()

writeFileSync(target, next)
console.log(`Generated ${target} from mcp/src/chains/registry.ts`)
