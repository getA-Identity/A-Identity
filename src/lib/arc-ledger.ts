/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/src/chains/provenance.ts and mcp/src/chains/retired.ts
 * Regenerate:     cd mcp && npm run gen:chains
 *
 * Editing this file directly will fail `cd mcp && npm test`
 * (see mcp/src/chains/frontend-sync.test.ts). The vaults A-Identity deployed on Arc, our own keys
 * there, and the addresses A-Identity retired, from the provenance ledger, so /app/vault/arc can
 * label them with the backend asleep.
 */

/** The AgentSpendPolicy vaults the ledger lists as deployed by A-Identity on Arc. One with retiredOn is retired: its owner is a retired address, so it is not ours any more. */
export const ARC_LEDGER_VAULTS: readonly { network: string; address: string; name: string; builtFromCommit?: string; sourcifyVerified?: boolean; retiredOn?: string }[] = [
  {
    "network": "eip155:5042",
    "address": "0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146",
    "name": "AgentSpendPolicy vault",
    "builtFromCommit": "c05b1710",
    "sourcifyVerified": true,
    "retiredOn": "2026-11-11"
  }
]

/** Per CAIP-2, the keys that are ours on Arc, lowercased: the committed list admission uses. No retired address is among them. */
export const ARC_LEDGER_KEYS: Readonly<Record<string, readonly string[]>> = {
  "eip155:5042": [
    "0xcb8824ffaf30687e36374c08ec52298b62871bdf",
    "0x03f1fb189e461b88f3e8ba7100b29b594e5f98a9",
    "0x312963475c508eff66951b77989ca459ca41268f",
    "0x432bd8bb5b9e199677e6a3fa72ac9739030953fd",
    "0x4e26ae66840134ac5979c56ba2509f3956b93431",
    "0x760342469785d06dc23f8b491a53ca2ebbeaa849",
    "0x86dc9716eb00164183d43f8e1273888c7eba3cb4",
    "0x8c8d9cd12d8896a40cf2115ee731258bb4983349",
    "0xce398f99dbc1ca6cd4901bff294bd950ced5055c",
    "0xee602a161232aac1436e812676b6626382fc84a9"
  ],
  "eip155:5042002": [
    "0x03f1fb189e461b88f3e8ba7100b29b594e5f98a9",
    "0x312963475c508eff66951b77989ca459ca41268f",
    "0x432bd8bb5b9e199677e6a3fa72ac9739030953fd",
    "0x4e26ae66840134ac5979c56ba2509f3956b93431",
    "0x760342469785d06dc23f8b491a53ca2ebbeaa849",
    "0x86dc9716eb00164183d43f8e1273888c7eba3cb4",
    "0x8c8d9cd12d8896a40cf2115ee731258bb4983349",
    "0xcb8824ffaf30687e36374c08ec52298b62871bdf",
    "0xce398f99dbc1ca6cd4901bff294bd950ced5055c",
    "0xee602a161232aac1436e812676b6626382fc84a9"
  ]
}

/**
 * The addresses A-Identity retired as compromised (mcp/src/chains/retired.ts), lowercased. They are not
 * ours: someone else holds their keys, so a vault one of them owns is never ours and is never to be funded.
 */
export const ARC_LEDGER_RETIRED: readonly { address: string; label: string; retiredOn: string }[] = [
  {
    "address": "0xd305607510e0db2c95807173c7a05bea53c1ed36",
    "label": "the former operating wallet",
    "retiredOn": "2026-11-11"
  },
  {
    "address": "0xf43f43d8aee114a71b164e1f6214bc7625a5742d",
    "label": "the former Celo pay-to",
    "retiredOn": "2026-11-11"
  }
]
