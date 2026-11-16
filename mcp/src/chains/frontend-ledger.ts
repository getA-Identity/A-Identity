/**
 * What /app/vault/arc must know about our own Arc keys and vaults without asking the backend.
 *
 * The page labels the launch-day vault A-Identity deployed, and says when it was retired. When that label came only from GET /api/proof/arc,
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
import { isRetired, retiredPublic } from './retired.js'

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
  vaults: { network: string; address: string; name: string; builtFromCommit?: string; sourcifyVerified?: boolean; retiredOn?: string }[]
  /** Per CAIP-2, the keys that are ours, lowercased: the same committed list admission refuses an
   *  owner from, so the page and the script cannot disagree about whose key a vault names. A
   *  retired address is never among them, whichever list names it. */
  keys: Record<string, string[]>
  /**
   * The addresses A-Identity retired as compromised (chains/retired.ts), lowercased: not ours, and
   * someone else holds their keys. The page says so of a vault one of them owns, and offers no way
   * to fund it.
   */
  retired: { address: string; label: string; retiredOn: string }[]
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
      // A vault A-Identity deployed and retired says so at the head of its note (provenance.ts).
      const retiredOn = c.note?.match(/^Deployed by A-Identity, retired (\d{4}-\d{2}-\d{2})/)?.[1]
      vaults.push({
        network: caip2,
        address: c.address,
        name: c.name,
        ...(builtFrom ? { builtFromCommit: builtFrom } : {}),
        ...(c.note && /verified on Sourcify/.test(c.note) ? { sourcifyVerified: true } : {}),
        ...(retiredOn ? { retiredOn } : {}),
      })
    }
    // An entry's own agent owner and accounts, never its former agent's holder, and never a retired address.
    const ours = [entry.agent?.owner, ...(entry.accounts ?? []).filter((a) => a.custody.startsWith('ours')).map((a) => a.address)]
    keys[caip2] = [...new Set([...ours.filter((a): a is string => Boolean(a)), ...ourKeys].map((a) => a.toLowerCase()))].filter((a) => !isRetired(a))
  }
  return { vaults, keys, retired: retiredPublic() }
}

const GENERATED_HEADER = `/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/src/chains/provenance.ts and mcp/src/chains/retired.ts
 * Regenerate:     cd mcp && npm run gen:chains
 *
 * Editing this file directly will fail \`cd mcp && npm test\`
 * (see mcp/src/chains/frontend-sync.test.ts). The vaults A-Identity deployed on Arc, our own keys
 * there, and the addresses A-Identity retired, from the provenance ledger, so /app/vault/arc can
 * label them with the backend asleep.
 */
`

/** Render the frontend's `src/lib/arc-ledger.ts` module text. */
export function renderFrontendArcLedger(ourKeys: readonly string[]): string {
  const { vaults, keys, retired } = arcLedgerFacts(ourKeys)
  return `${GENERATED_HEADER}
/** The AgentSpendPolicy vaults the ledger lists as deployed by A-Identity on Arc. One with retiredOn is retired: its owner is a retired address, so it is not ours any more. */
export const ARC_LEDGER_VAULTS: readonly { network: string; address: string; name: string; builtFromCommit?: string; sourcifyVerified?: boolean; retiredOn?: string }[] = ${JSON.stringify(vaults, null, 2)}

/** Per CAIP-2, the keys that are ours on Arc, lowercased: the committed list admission uses. No retired address is among them. */
export const ARC_LEDGER_KEYS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(keys, null, 2)}

/**
 * The addresses A-Identity retired as compromised (mcp/src/chains/retired.ts), lowercased. They are not
 * ours: someone else holds their keys, so a vault one of them owns is never ours and is never to be funded.
 */
export const ARC_LEDGER_RETIRED: readonly { address: string; label: string; retiredOn: string }[] = ${JSON.stringify(retired, null, 2)}
`
}
