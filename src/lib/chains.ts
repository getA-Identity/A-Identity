/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/src/chains/registry.ts
 * Regenerate:     cd mcp && npm run gen:chains
 *
 * Editing this file directly will fail `cd mcp && npm test`
 * (see mcp/src/chains/frontend-sync.test.ts). Add or change a chain in the registry
 * and regenerate, so the backend, the REST surface and the UI can never disagree.
 */

/** Short slug of a chain in the registry. */
export type ChainId = 'arc' | 'xlayer' | 'celo' | 'base' | 'celo-sepolia' | 'stellar' | 'solana' | 'avalanche' | 'arbitrum' | 'rhchain-testnet' | 'rhchain'

export type ChainProtocols = {
  /** x402 HTTP-402 payment support. Settlement is in a stablecoin. */
  payment: { x402: boolean; note?: string }
  /** Identity standard. ERC-8004 is EVM-only; non-EVM chains map to a native equivalent. */
  identity: { standard: string; erc8004Native: boolean; note?: string }
}

/** Lifecycle status. Only `live` (and `beta`) chains are wired end to end. */
export type ChainStatus = 'live' | 'beta' | 'planned' | 'deprecated'

export type Chain = {
  id: ChainId
  name: string
  shortName: string
  /** Hex color for UI badges and chips. Readable as colored tag text in both themes. */
  color: string
  /** EIP-155 chain id. Null for non-EVM chains. */
  chainId: number | null
  /** CAIP-2 chain identifier. */
  caip2: string
  evmCompatible: boolean
  testnet: boolean
  /** Stablecoins available on this chain. First is the default settlement coin. */
  stablecoins: string[]
  rpcUrl: string | null
  explorer: string | null
  role: string
  status: ChainStatus
  protocols: ChainProtocols
  /** Flat aliases of `protocols`, mirroring the GET /api/chains payload. */
  identity: string
  erc8004Native: boolean
  x402: boolean
}

export const CHAINS: readonly Chain[] = [
  {
    "id": "arc",
    "name": "Circle Arc (Testnet)",
    "shortName": "Arc",
    "color": "#2775CA",
    "chainId": 5042002,
    "caip2": "eip155:5042002",
    "evmCompatible": true,
    "testnet": true,
    "stablecoins": [
      "USDC",
      "EURC",
      "USYC"
    ],
    "rpcUrl": "https://rpc.testnet.arc.network",
    "explorer": "https://testnet.arcscan.app",
    "role": "Primary payment rail: gas in USDC, sub-second finality, App Kit unified balance.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "Gas in USDC, App Kit (Gateway) unified balance, nanopayments."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "xlayer",
    "name": "OKX X Layer",
    "shortName": "X Layer",
    "color": "#8A8F98",
    "chainId": 196,
    "caip2": "eip155:196",
    "evmCompatible": true,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "USDT"
    ],
    "rpcUrl": "https://rpc.xlayer.tech",
    "explorer": "https://www.oklink.com/xlayer",
    "role": "OKX.AI marketplace rail: identity reads live from OKX ERC-8004; x402 trust tools settle here.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 over USDC once the USDC address is confirmed."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "OKX.AI identity registry LIVE (read-side wired); payment rails still planned."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "celo",
    "name": "Celo",
    "shortName": "Celo",
    "color": "#FCFF52",
    "chainId": 42220,
    "caip2": "eip155:42220",
    "evmCompatible": true,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "USDT",
      "USDm"
    ],
    "rpcUrl": "https://forno.celo.org",
    "explorer": "https://celoscan.io",
    "role": "Stablecoin-native EVM L2: ERC-8004 identity live, x402 USDC settlement via the first-party Celo facilitator, gas payable in stablecoins.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 over USDC via the first-party Celo facilitator (EIP-3009, buyer pays no gas); CIP-64 fee abstraction lets gas be paid in stablecoins."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "Identity + Reputation registries LIVE (read-side wired). No ValidationRegistry on Celo yet, so KYA cannot be anchored on-chain there."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "base",
    "name": "Base",
    "shortName": "Base",
    "color": "#0052FF",
    "chainId": 8453,
    "caip2": "eip155:8453",
    "evmCompatible": true,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "USDT",
      "PYUSD"
    ],
    "rpcUrl": "https://mainnet.base.org",
    "explorer": "https://basescan.org",
    "role": "EVM fallback: ERC-8004 compatible, Coinbase ecosystem, low fees. Testnet active (Base Sepolia via Gateway demo).",
    "status": "beta",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 reference rail (Coinbase)."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "ERC-8004 registry to be deployed."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "celo-sepolia",
    "name": "Celo Sepolia (Testnet)",
    "shortName": "Celo Sepolia",
    "color": "#FCFF52",
    "chainId": 11142220,
    "caip2": "eip155:11142220",
    "evmCompatible": true,
    "testnet": true,
    "stablecoins": [
      "USDC"
    ],
    "rpcUrl": "https://forno.celo-sepolia.celo-testnet.org",
    "explorer": "https://celo-sepolia.blockscout.com",
    "role": "Celo testnet rail (Alfajores is deprecated): same ERC-8004 registry pair as Arc, x402 USDC via the Sepolia facilitator.",
    "status": "beta",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 over testnet USDC via the Celo Sepolia facilitator (api.x402.sepolia.celo.org)."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "Identity + Reputation registries LIVE (same addresses as Arc). No ValidationRegistry, mirroring mainnet."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "stellar",
    "name": "Stellar Testnet",
    "shortName": "Stellar",
    "color": "#7D00FF",
    "chainId": null,
    "caip2": "stellar:testnet",
    "evmCompatible": false,
    "testnet": true,
    "stablecoins": [
      "USDC",
      "EURC"
    ],
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "explorer": "https://stellar.expert/explorer/testnet",
    "role": "Fast, low-cost settlement: USDC + EURC native (Circle), Soroban contracts.",
    "status": "planned",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 settlement in USDC via SEP-41 SAC; fee sponsorship for gasless."
      },
      "identity": {
        "standard": "Soroban registry + SEP-10",
        "erc8004Native": false,
        "note": "No native ERC-8004 (EVM-only). Identity via Soroban registry / SEP-10; ERC-8004 passport bridged."
      }
    },
    "identity": "Soroban registry + SEP-10",
    "erc8004Native": false,
    "x402": true
  },
  {
    "id": "solana",
    "name": "Solana",
    "shortName": "Solana",
    "color": "#14F195",
    "chainId": null,
    "caip2": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "evmCompatible": false,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "USDT"
    ],
    "rpcUrl": "https://api.mainnet-beta.solana.com",
    "explorer": "https://explorer.solana.com",
    "role": "High-throughput settlement: SPL USDC, sub-second confirmation.",
    "status": "planned",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 settlement in SPL USDC."
      },
      "identity": {
        "standard": "Anchor registry program",
        "erc8004Native": false,
        "note": "No native ERC-8004 (EVM-only). Identity via an Anchor registry program; ERC-8004 passport bridged."
      }
    },
    "identity": "Anchor registry program",
    "erc8004Native": false,
    "x402": true
  },
  {
    "id": "avalanche",
    "name": "Avalanche C-Chain",
    "shortName": "Avalanche",
    "color": "#E84142",
    "chainId": 43114,
    "caip2": "eip155:43114",
    "evmCompatible": true,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "USDT"
    ],
    "rpcUrl": "https://api.avax.network/ext/bc/C/rpc",
    "explorer": "https://snowtrace.io",
    "role": "Fast-finality EVM: native Circle USDC, low latency for burst settlement.",
    "status": "planned",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 over USDC on Avalanche."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "ERC-8004 registry to be deployed."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "arbitrum",
    "name": "Arbitrum One",
    "shortName": "Arbitrum",
    "color": "#28A0F0",
    "chainId": 42161,
    "caip2": "eip155:42161",
    "evmCompatible": true,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "USDT"
    ],
    "rpcUrl": "https://arb1.arbitrum.io/rpc",
    "explorer": "https://arbiscan.io",
    "role": "DeFi gateway: large protocol ecosystem, USDC via Circle, ERC-8004 compatible.",
    "status": "planned",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 over USDC on Arbitrum One."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "ERC-8004 registry to be deployed."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "rhchain-testnet",
    "name": "Robinhood Chain Testnet",
    "shortName": "RH Chain test",
    "color": "#0F9D30",
    "chainId": 46630,
    "caip2": "eip155:46630",
    "evmCompatible": true,
    "testnet": true,
    "stablecoins": [],
    "rpcUrl": "https://rpc.testnet.chain.robinhood.com",
    "explorer": "https://explorer.testnet.chain.robinhood.com",
    "role": "Where a Robinhood Chain deployment would actually happen: the project does not deploy contracts autonomously to any mainnet.",
    "status": "planned",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 needs a settlement token first: no canonical USDC is documented on this chain yet."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "ERC-8004 registry to be deployed."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
  {
    "id": "rhchain",
    "name": "Robinhood Chain",
    "shortName": "RH Chain",
    "color": "#0F9D30",
    "chainId": 4663,
    "caip2": "eip155:4663",
    "evmCompatible": true,
    "testnet": false,
    "stablecoins": [],
    "rpcUrl": "https://rpc.mainnet.chain.robinhood.com",
    "explorer": "https://robinhoodchain.blockscout.com",
    "role": "Robinhood's own L2 for tokenized real-world assets, stock tokens and ETFs. Day-one identity and policy positioning for agents that trade there.",
    "status": "planned",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 needs a settlement token first: no canonical USDC is documented on this chain yet."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "ERC-8004 registry to be deployed."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true
  },
] as const

export const CHAIN_BY_ID = Object.fromEntries(CHAINS.map((c) => [c.id, c])) as Record<
  ChainId,
  Chain
>
