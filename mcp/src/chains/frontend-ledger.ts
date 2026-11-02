/**
 * What /app/vault/arc must know about our own Arc keys and vaults without asking the backend.
 *
 * The page labels our launch-day vault as ours. When that label came only from GET /api/proof/arc,
 * a cold backend left our own vault looking like anyone's. So the two facts the label needs are
 * rendered from the provenance ledger into a GENERATED module, the same arrangement as
 * public-view.ts and src/lib/chains.ts: `npm run gen:chains` writes it and frontend-sync.test.ts
 * fails the build if it drifts.
 *
 * Kept apart from chains.ts on purpose: the ledger is chain history, not configuration (see
 * provenance.ts), and only these two lists cross over, so a new transaction in the ledger, or a
 * note that changes neither fact read from it below, forces no regeneration.
 */
import { getChainById } from './registry.js'
import { PROVENANCE, type ChainProvenance } from './provenance.js'

/** Where the generated module lives, from the repository root. */
export const FRONTEND_ARC_LEDGER_MODULE = 'src/lib/arc-ledger.ts'

/** The chains /app/vault/arc reads: its mainnet and its testnet. */
export const ARC_PAGE_CHAINS = ['arc-mainnet', 'arc'] as const

export type ArcLedgerFacts = {
  /**
   * The AgentSpendPolicy vaults the ledger lists as ours, per chain, in ledger order. Two facts
   * come from the entry's own note, so the page says them only of the vault the ledger says them
   * of: the commit it was built from when that is not the current source, and that its source is
   * verified on Sourcify.
   */
  vaults: { network: string; address: string; name: string; builtFromCommit?: string; sourcifyVerified?: boolean }[]
  /** Per CAIP-2, the keys that are ours, lowercased: the same committed list admission refuses an
   *  owner from, so the page and the script cannot disagree about whose key a vault names. */
  keys: Record<string, string[]>
}

/**
 * `ourKeys` is every committed address admission calls ours, whatever chain the ledger names it
 * on (arc-owner-vault.ts committedOurKeys): an EVM key is the same key on both networks. It is
 * passed in because those lists live above this layer, in the rails.
 */
export function arcLedgerFacts(ourKeys: readonly string[], ledger: readonly ChainProvenance[] = PROVENANCE): ArcLedgerFacts {
  const vaults: ArcLedgerFacts['vaults'] = []
  const keys: ArcLedgerFacts['keys'] = {}
  for (const id of ARC_PAGE_CHAINS) {
    const entry = ledger.find((p) => p.chain === id)
    const caip2 = getChainById(id)?.caip2
    if (!entry || !caip2) continue
    for (const c of entry.contracts) {
      if (!c.name.startsWith('AgentSpendPolicy')) continue
      const builtFrom = c.note?.match(/Built from the contract source at commit ([0-9a-f]{7,40})/)?.[1]
      vaults.push({
        network: caip2,
        address: c.address,
        name: c.name,
        ...(builtFrom ? { builtFromCommit: builtFrom } : {}),
        ...(c.note && /verified on Sourcify/.test(c.note) ? { sourcifyVerified: true } : {}),
      })
    }
    const ours = [entry.agent?.owner, ...(entry.accounts ?? []).filter((a) => a.custody.startsWith('ours')).map((a) => a.address)]
    keys[caip2] = [...new Set([...ours.filter((a): a is string => Boolean(a)), ...ourKeys].map((a) => a.toLowerCase()))]
  }
  return { vaults, keys }
}

const GENERATED_HEADER = `/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/src/chains/provenance.ts
 * Regenerate:     cd mcp && npm run gen:chains
 *
 * Editing this file directly will fail \`cd mcp && npm test\`
 * (see mcp/src/chains/frontend-sync.test.ts). Our own vaults and keys on Arc, from the provenance
 * ledger, so /app/vault/arc can label them with the backend asleep.
 */
`

/** Render the frontend's `src/lib/arc-ledger.ts` module text. */
export function renderFrontendArcLedger(ourKeys: readonly string[]): string {
  const { vaults, keys } = arcLedgerFacts(ourKeys)
  return `${GENERATED_HEADER}
/** The AgentSpendPolicy vaults the ledger lists as ours on Arc. */
export const ARC_LEDGER_VAULTS: readonly { network: string; address: string; name: string; builtFromCommit?: string; sourcifyVerified?: boolean }[] = ${JSON.stringify(vaults, null, 2)}

/** Per CAIP-2, the keys that are ours on Arc, lowercased: the committed list admission uses. */
export const ARC_LEDGER_KEYS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(keys, null, 2)}
`
}
