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
export type ChainId = 'arc' | 'stellar' | 'xlayer' | 'base' | 'arbitrum' | 'rhchain' | 'celo' | 'stellar-testnet' | 'rhchain-testnet' | 'celo-sepolia' | 'avalanche'

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
  /** Canonical ERC-8004 addresses this chain carries. An absent key is an absent
   *  deployment: the UI must never infer one. */
  registries: { identity?: string; reputation?: string; validation?: string }
  /** True when a live identity read works on this chain today. */
  identityLive: boolean
  /** Symbol our x402 rail settles in here, or null when we run no rail on this chain. */
  settlementSymbol: string | null
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
    "x402": true,
    "registries": {
      "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      "validation": "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"
    },
    "identityLive": true,
    "settlementSymbol": null
  },
  {
    "id": "stellar",
    "name": "Stellar",
    "shortName": "Stellar",
    "color": "#7D00FF",
    "chainId": null,
    "caip2": "stellar:pubnet",
    "evmCompatible": false,
    "testnet": false,
    "stablecoins": [
      "USDC",
      "EURC"
    ],
    "rpcUrl": "https://mainnet.sorobanrpc.com",
    "explorer": "https://stellar.expert/explorer/public",
    "role": "Fast, low-cost settlement: native Circle USDC, Soroban contracts, and an x402 rail where the buyer signs and pays no transaction fee.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 in USDC over the SEP-41 SAC. The buyer signs a Soroban authorization entry rather than a whole transaction, so whoever assembles it pays the network fee. Note the exact claim: the buyer pays no FEE. It still needs XLM to exist at all, 1 for the account reserve and 0.5 more per trustline, which is a Stellar property no rail can remove. An operator who funds an agent with USDC alone will find the account was never created."
      },
      "identity": {
        "standard": "Soroban registry + SEP-10",
        "erc8004Native": false,
        "note": "No native ERC-8004: that standard is EVM-only and nothing bridges it here. A Soroban agent registry DOES exist on pubnet, TrionLabs Stellar-8004 (MIT), Identity CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35, read live 2026-08-26: name \"Agent Registry\", symbol AGENT, version 0.1.0, total_agents 68. It is NOT a bridge and we do not resolve against it. Its exported interface contains no function binding an agent to a foreign-chain identity, no CAIP-10 and no chain id; the only places a cross-chain reference could live are the free-form agent_uri and set_metadata, which are assertions by whoever holds the key and are checked by nothing. It mints its own ids in its own space starting at 0 (owner_of(0) resolves), so an id there and an ERC-8004 token id are different identities that happen to be integers. Two further differences worth knowing before wiring anything: it is UPGRADEABLE behind a 51,840-ledger timelock, which ours deliberately is not, and stellar.expert reports its source as unverified."
      }
    },
    "identity": "Soroban registry + SEP-10",
    "erc8004Native": false,
    "x402": true,
    "registries": {},
    "identityLive": false,
    "settlementSymbol": "USDC"
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
    "x402": true,
    "registries": {
      "identity": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"
    },
    "identityLive": true,
    "settlementSymbol": null
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
    "role": "Coinbase-ecosystem EVM rail: canonical ERC-8004 registries live, our agent #73232, and x402 settling in native Circle USDC through our own EIP-3009 facilitator.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 settling in native Circle USDC through our own first-party EIP-3009 facilitator: the buyer signs, we broadcast and pay the gas. The signing domain is proven against the live DOMAIN_SEPARATOR, and the first settlement landed 2026-08-28 (tx 0xb59ae67c) with the receipt carrying the matching Transfer log."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "Canonical ERC-8004 identity + reputation registries are live here, deployed by their authors; agent #73232 is ours (minted 2026-08-28, tx 0xb428bf8e, and ownerOf/tokenURI read back live). TRAP BEFORE PASTING ADDRESSES: Arc's three registry addresses all have code on Base mainnet, 130 bytes each, which is minimal-proxy sized and delegates to a NON-canonical implementation. Same address, different contract. An eth_getCode check therefore answers yes here and means nothing; the canonical pair above was verified by reading each proxy's EIP-1967 implementation slot and matching the implementation code byte for byte against Arbitrum One (2026-08-28), not by observing that something is deployed."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true,
    "registries": {
      "identity": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
      "reputation": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
    },
    "identityLive": true,
    "settlementSymbol": "USDC"
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
    "role": "DeFi gateway: large protocol ecosystem, our ERC-8004 agent #1259, and x402 settling in native Circle USDC through our own EIP-3009 facilitator.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 settling in native Circle USDC through our own first-party EIP-3009 facilitator: the buyer signs, we broadcast and pay the gas. The fee is lower here than on Robinhood Chain because the gas measurably is."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "Canonical ERC-8004 identity + reputation registries are live here (deployed by their authors, not by us); agent #1259 is ours. No ValidationRegistry in this family, so KYA cannot be anchored here."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true,
    "registries": {
      "identity": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
      "reputation": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
    },
    "identityLive": true,
    "settlementSymbol": "USDC"
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
    "stablecoins": [
      "USDG"
    ],
    "rpcUrl": "https://rpc.mainnet.chain.robinhood.com",
    "explorer": "https://robinhoodchain.blockscout.com",
    "role": "Robinhood's own L2 for tokenized real-world assets: canonical ERC-8004 identity + reputation live, agent #0 minted, and paid trust calls settling in USDG through our own first-party x402 facilitator.",
    "status": "live",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "x402 settling in USDG (Paxos Global Dollar) through our own first-party EIP-3009 facilitator: the buyer signs, we broadcast and pay the gas. We run it because no published facilitator serves this chain, not because nobody else relays here."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "Identity + Reputation registries LIVE (same canonical addresses as X Layer/Celo); agent #0, the registry's first mint, is ours (2026-08-12). No ValidationRegistry in the mainnet family yet."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true,
    "registries": {
      "identity": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
      "reputation": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
    },
    "identityLive": true,
    "settlementSymbol": "USDG"
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
    "x402": true,
    "registries": {
      "identity": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      "reputation": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
    },
    "identityLive": true,
    "settlementSymbol": null
  },
  {
    "id": "stellar-testnet",
    "name": "Stellar Testnet",
    "shortName": "Stellar test",
    "color": "#7D00FF",
    "chainId": null,
    "caip2": "stellar:testnet",
    "evmCompatible": false,
    "testnet": true,
    "stablecoins": [
      "USDC"
    ],
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "explorer": "https://stellar.expert/explorer/testnet",
    "role": "Stellar rehearsal rail: the same Soroban vault and the same x402 code path as pubnet, in test money.",
    "status": "beta",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "Where every x402 change is rehearsed before pubnet sees it. Testnet resets periodically, so a contract here is a rehearsal, never a record."
      },
      "identity": {
        "standard": "Soroban registry + SEP-10",
        "erc8004Native": false,
        "note": "Same as pubnet: no ERC-8004 here, so KYA cannot be anchored and the passport is bridged rather than native. Stellar-8004 has its own testnet deployment, a different contract by a different deployer, Identity CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH. Same caveat as pubnet: we do not resolve against it and it binds no foreign identity."
      }
    },
    "identity": "Soroban registry + SEP-10",
    "erc8004Native": false,
    "x402": true,
    "registries": {},
    "identityLive": false,
    "settlementSymbol": "USDC"
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
    "stablecoins": [
      "USDC.e"
    ],
    "rpcUrl": "https://rpc.testnet.chain.robinhood.com",
    "explorer": "https://explorer.testnet.chain.robinhood.com",
    "role": "Robinhood Chain rehearsal rail: the canonical ERC-8004 registry set is live here; mainnet waits on a human-funded signer.",
    "status": "beta",
    "protocols": {
      "payment": {
        "x402": true,
        "note": "Rehearsal of the mainnet USDG rail on the same EIP-3009 code path, settling in bridged USDC.e. No canonical USDC exists here, so contracts.usdc stays empty."
      },
      "identity": {
        "standard": "ERC-8004",
        "erc8004Native": true,
        "note": "Identity + Reputation + Validation registries LIVE at the canonical cross-chain addresses."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true,
    "registries": {
      "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      "validation": "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"
    },
    "identityLive": true,
    "settlementSymbol": "USDC.e"
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
    "x402": true,
    "registries": {
      "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713"
    },
    "identityLive": true,
    "settlementSymbol": null
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
        "note": "Canonical ERC-8004 identity + reputation registries are live here; we hold no agent on them yet and no rail of ours is wired."
      }
    },
    "identity": "ERC-8004",
    "erc8004Native": true,
    "x402": true,
    "registries": {},
    "identityLive": false,
    "settlementSymbol": null
  },
] as const

export const CHAIN_BY_ID = Object.fromEntries(CHAINS.map((c) => [c.id, c])) as Record<
  ChainId,
  Chain
>
