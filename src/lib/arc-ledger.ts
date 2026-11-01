/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/src/chains/provenance.ts
 * Regenerate:     cd mcp && npm run gen:chains
 *
 * Editing this file directly will fail `cd mcp && npm test`
 * (see mcp/src/chains/frontend-sync.test.ts). Our own vaults and keys on Arc, from the provenance
 * ledger, so /app/vault/arc can label them with the backend asleep.
 */

/** The AgentSpendPolicy vaults the ledger lists as ours on Arc. */
export const ARC_LEDGER_VAULTS: readonly { network: string; address: string; name: string }[] = [
  {
    "network": "eip155:5042",
    "address": "0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146",
    "name": "AgentSpendPolicy vault"
  }
]

/** Per CAIP-2, the keys the ledger names as ours on Arc, lowercased. */
export const ARC_LEDGER_KEYS: Readonly<Record<string, readonly string[]>> = {
  "eip155:5042": [
    "0xd305607510e0db2c95807173c7a05bea53c1ed36"
  ],
  "eip155:5042002": [
    "0xd305607510e0db2c95807173c7a05bea53c1ed36"
  ]
}
