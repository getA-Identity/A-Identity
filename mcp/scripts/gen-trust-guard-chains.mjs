/**
 * Generate trust-guard's Arc Mainnet constants from the backend chain registry.
 *
 *   cd mcp && npm run gen:chains
 *
 * @a-identity/trust-guard is a separate published package, so it cannot import from mcp/src.
 * It gets a generated file instead, and chains/trust-guard-sync.test.ts fails the build if
 * the file ever differs from what the registry says.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderTrustGuardArc } from '../dist/chains/trust-guard-view.js'

const target = fileURLToPath(new URL('../../trust-guard/src/arc-mainnet.generated.ts', import.meta.url))
writeFileSync(target, renderTrustGuardArc())
console.log(`Generated ${target} from mcp/src/chains/registry.ts`)
