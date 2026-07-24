/**
 * The chain registry — the single source of truth for every chain this backend
 * knows about. Adding a chain = adding one descriptor here (plus, for a new VM,
 * an adapter under ./<ecosystem>/). Nothing else hardcodes a chain id, RPC, or
 * address. See ../../../MULTICHAIN-STRATEGY.md.
 *
 * Status is honest: only `live` chains are wired end to end. `planned` chains carry
 * their public metadata (CAIP-2, chain id, canonical USDC, CCTP domain) so onboarding
 * is a data edit, but they are NOT integrated until their contracts are deployed and
 * the status is flipped to `beta`/`live`.
 */
import type { ChainDescriptor } from './types.js'
import { evmChainIdFromCaip2, isValidCaip2 } from './caip.js'

export const CHAINS: ChainDescriptor[] = [
  // ── LIVE ────────────────────────────────────────────────────────────────────
  {
    caip2: 'eip155:5042002',
    id: 'arc',
    name: 'Arc Testnet',
    ecosystem: 'evm',
    testnet: true,
    status: 'live',
    evmChainId: 5042002,
    cctpDomain: 26,
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    usdcDecimals: 6, // native USDC is 18 decimals; the ERC-20 interface is 6 (same balance)
    rpcUrls: [
      'https://rpc.testnet.arc.network',
      'https://rpc.blockdaemon.testnet.arc.network',
      'https://rpc.drpc.testnet.arc.network',
      'https://rpc.quicknode.testnet.arc.network',
    ],
    wsUrl: 'wss://rpc.testnet.arc.network',
    explorer: 'https://testnet.arcscan.app',
    faucet: 'https://faucet.circle.com',
    contracts: {
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
      agenticCommerce: '0x0747EEf0706327138c69792bF28Cd525089e4583',
      usdc: '0x3600000000000000000000000000000000000000',
      memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505', // Arc predeployed Memo precompile (transaction memos)
      multicall3From: '0x522fAf9A91c41c443c66765030741e4AaCe147D0', // Arc predeployed Multicall3From (batched transactions)
    },
    confirmations: 1, // deterministic sub-second finality
    stablecoins: ['USDC', 'EURC', 'USYC'],
    signerEnvVar: 'ARC_SIGNER_KEY',
    rpcEnvVar: 'ARC_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true },
    payment: { x402: true, note: 'Gas in USDC, App Kit (Gateway) unified balance, nanopayments.' },
  },

  // ── PLANNED: EVM (one adapter covers all of these) ────────────────────────────
  {
    caip2: 'eip155:8453',
    id: 'base',
    name: 'Base',
    ecosystem: 'evm',
    testnet: false,
    status: 'planned',
    evmChainId: 8453,
    cctpDomain: 6,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    contracts: {
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // native Circle USDC on Base
    },
    confirmations: 3,
    stablecoins: ['USDC', 'USDT', 'PYUSD'],
    signerEnvVar: 'BASE_SIGNER_KEY',
    rpcEnvVar: 'BASE_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true, note: 'ERC-8004 registry to be deployed.' },
    payment: { x402: true, note: 'x402 reference rail (Coinbase).' },
  },
  {
    caip2: 'eip155:42161',
    id: 'arbitrum',
    name: 'Arbitrum One',
    ecosystem: 'evm',
    testnet: false,
    status: 'planned',
    evmChainId: 42161,
    cctpDomain: 3,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    contracts: {
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // native Circle USDC on Arbitrum One
    },
    confirmations: 3,
    stablecoins: ['USDC', 'USDT'],
    signerEnvVar: 'ARB_SIGNER_KEY',
    rpcEnvVar: 'ARB_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true, note: 'ERC-8004 registry to be deployed.' },
    payment: { x402: true, note: 'x402 over USDC on Arbitrum One.' },
  },
  {
    caip2: 'eip155:43114',
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    ecosystem: 'evm',
    testnet: false,
    status: 'planned',
    evmChainId: 43114,
    cctpDomain: 1,
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
    explorer: 'https://snowtrace.io',
    contracts: {
      usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // native Circle USDC on Avalanche C-Chain
    },
    confirmations: 1, // Avalanche has fast finality
    stablecoins: ['USDC', 'USDT'],
    signerEnvVar: 'AVAX_SIGNER_KEY',
    rpcEnvVar: 'AVAX_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true, note: 'ERC-8004 registry to be deployed.' },
    payment: { x402: true, note: 'x402 over USDC on Avalanche.' },
  },
  {
    caip2: 'eip155:196',
    id: 'xlayer',
    name: 'OKX X Layer',
    ecosystem: 'evm',
    testnet: false,
    status: 'planned',
    evmChainId: 196,
    cctpDomain: null, // verify CCTP support before integrating
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://rpc.xlayer.tech'],
    explorer: 'https://www.oklink.com/xlayer',
    contracts: {
      // OKX.AI's live ERC-8004 IdentityRegistry (verified: our ASP identities #6271/#8913
      // resolve via ownerOf; tokenURI serves the OKX CDN agent card). Payments still
      // pending: verify the canonical USDC address on X Layer before wiring them.
      identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    },
    confirmations: 5,
    stablecoins: ['USDC', 'USDT'],
    signerEnvVar: 'XLAYER_SIGNER_KEY',
    rpcEnvVar: 'XLAYER_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true, note: 'OKX.AI identity registry LIVE (read-side wired); payment rails still planned.' },
    payment: { x402: true, note: 'x402 over USDC once the USDC address is confirmed.' },
  },

  // ── PLANNED: non-EVM (each needs its own adapter + a native contract) ──────────
  {
    caip2: 'stellar:testnet',
    id: 'stellar',
    name: 'Stellar Testnet',
    ecosystem: 'stellar',
    testnet: true,
    status: 'planned',
    evmChainId: null,
    cctpDomain: 27,
    nativeCurrency: { name: 'Lumen', symbol: 'XLM', decimals: 7 },
    usdcDecimals: 7, // Stellar assets use 7 decimals
    rpcUrls: ['https://soroban-testnet.stellar.org'],
    explorer: 'https://stellar.expert/explorer/testnet',
    faucet: 'https://friendbot.stellar.org',
    contracts: {
      // Soroban AgentSpendPolicy (Rust) + a Soroban identity registry, to be deployed.
      // USDC is a SEP-41 SAC contract (C...) — fill in once integrated.
    },
    confirmations: 1, // Stellar has fast, deterministic finality
    stablecoins: ['USDC', 'EURC'],
    signerEnvVar: 'STELLAR_SIGNER_SECRET',
    rpcEnvVar: 'STELLAR_RPC_URL',
    identity: {
      standard: 'Soroban registry + SEP-10',
      erc8004Native: false,
      note: 'No native ERC-8004 (EVM-only). Identity via Soroban registry / SEP-10; ERC-8004 passport bridged.',
    },
    payment: { x402: true, note: 'x402 settlement in USDC via SEP-41 SAC; fee sponsorship for gasless.' },
  },
  {
    // NOTE: this is the Solana MAINNET CAIP-2 reference (a truncated genesis hash).
    // Devnet's reference differs; swap it in when integrating devnet first.
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    id: 'solana',
    name: 'Solana',
    ecosystem: 'solana',
    testnet: false,
    status: 'planned',
    evmChainId: null,
    cctpDomain: 5,
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    usdcDecimals: 6, // SPL USDC is 6 decimals
    rpcUrls: ['https://api.mainnet-beta.solana.com'],
    explorer: 'https://explorer.solana.com',
    contracts: {
      usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // SPL USDC mint
    },
    confirmations: 1, // "finalized" commitment
    stablecoins: ['USDC', 'USDT'],
    signerEnvVar: 'SOLANA_SIGNER_SECRET',
    rpcEnvVar: 'SOLANA_RPC_URL',
    identity: {
      standard: 'Anchor registry program',
      erc8004Native: false,
      note: 'No native ERC-8004 (EVM-only). Identity via an Anchor registry program; ERC-8004 passport bridged.',
    },
    payment: { x402: true, note: 'x402 settlement in SPL USDC.' },
  },
]

// ── lookups (derive everything from the registry) ────────────────────────────────

const BY_CAIP2 = new Map(CHAINS.map((c) => [c.caip2, c]))
const BY_ID = new Map(CHAINS.map((c) => [c.id, c]))

/** Look up a chain by CAIP-2 id. Returns undefined if unknown. */
export function getChain(caip2: string): ChainDescriptor | undefined {
  return BY_CAIP2.get(caip2)
}

/** Look up a chain by CAIP-2 id, throwing if unknown (use for chains you KNOW exist,
 *  e.g. the live Arc chain the app is built on). */
export function requireChain(caip2: string): ChainDescriptor {
  const chain = BY_CAIP2.get(caip2)
  if (!chain) throw new Error(`Unknown chain: ${caip2}`)
  return chain
}

/** Look up a chain by its short slug (e.g. 'arc'). */
export function getChainById(id: string): ChainDescriptor | undefined {
  return BY_ID.get(id)
}

/** Look up an EVM chain by its numeric EIP-155 chain id. */
export function getChainByEvmId(evmChainId: number): ChainDescriptor | undefined {
  return CHAINS.find((c) => c.evmChainId === evmChainId)
}

/** All EVM chains. */
export function evmChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'evm')
}

/** All chains that are wired end to end (status live or beta). */
export function liveChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.status === 'live' || c.status === 'beta')
}

/** The canonical live Arc chain the app is currently built on. */
export const ARC_CHAIN = requireChain('eip155:5042002')

// Fail fast at import time if a descriptor is malformed — cheaper to catch here than
// at request time. (Pure validation, no I/O.)
for (const c of CHAINS) {
  if (!isValidCaip2(c.caip2)) throw new Error(`Invalid CAIP-2 in registry: ${c.caip2}`)
  if (c.ecosystem === 'evm' && evmChainIdFromCaip2(c.caip2) !== c.evmChainId) {
    throw new Error(`CAIP-2 / evmChainId mismatch for ${c.id}: ${c.caip2} vs ${c.evmChainId}`)
  }
}
