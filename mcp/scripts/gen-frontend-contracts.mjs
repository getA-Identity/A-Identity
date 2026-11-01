/**
 * Generate the browser's copy of the AgentSpendPolicy artifact.
 *
 *   cd mcp && npm run compile && npm run gen:contracts
 *
 * The frontend cannot import from mcp/src, and /app/vault/arc needs the ABI, the creation code
 * a wallet deploys and the runtime it checks deployed vaults against. Typing any of them into
 * the frontend would be a second, unguarded copy of the build, so this writes
 * src/lib/contracts/agent-spend-policy.ts from mcp/src/contracts/AgentSpendPolicy.ts, and
 * mcp/src/contracts/frontend-sync.test.ts plus the root scripts/check-vault-artifact.mjs fail
 * when the two disagree.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FRONTEND_VAULT_MODULE, renderFrontendVaultModule } from '../dist/contracts/frontend-view.js'

const target = fileURLToPath(new URL(`../../${FRONTEND_VAULT_MODULE}`, import.meta.url))
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, renderFrontendVaultModule())
console.log(`Generated ${target} from mcp/src/contracts/AgentSpendPolicy.ts`)
