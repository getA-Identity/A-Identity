/**
 * The provenance ledger: what we actually did on a chain, with the transaction that
 * proves each claim.
 *
 * A mint hash that exists only in a git commit message is not evidence. This module is
 * the machine-readable record behind the public proof pages, and it is deliberately a
 * SIBLING of the registry rather than a field on ChainDescriptor: a descriptor is chain
 * CONFIGURATION, this is chain HISTORY. Putting kilobytes of tx hashes into the
 * descriptor would push them through renderFrontendChains() into the byte-pinned
 * src/lib/chains.ts, so every note would force a regeneration and a stale prerender.
 *
 * Two rules keep it honest, and provenance.test.ts enforces both:
 *   - no explorer URL is written by hand; every link derives from the descriptor of the
 *     chain the transaction actually landed on (which is why an artifact names its own
 *     `onChain`, and why a funding hop can point at a different chain than its entry),
 *   - a `beta` chain's `caveats` may not be empty. A chain with nothing it cannot do is
 *     a chain someone forgot to be honest about.
 */
import { getChainById } from './registry.js'
import { txUrl, addressUrl } from './evm/client.js'

export type ChainArtifact = {
  kind: 'mint' | 'deploy' | 'session-key' | 'bridge' | 'settlement' | 'funding'
  label: string
  txHash: string
  /** Registry id of the chain this transaction lives on. Usually the entry's own chain;
   *  a funding hop names another, which is exactly why the link derives from THIS. */
  onChain: string
  blockNumber?: number
  note?: string
}

export type ChainProvenance = {
  /** Registry id. */
  chain: string
  summary: string
  agent?: { tokenId: string; caip: string; owner: string; tokenUri: string }
  contracts: { name: string; address: string; note?: string }[]
  artifacts: ChainArtifact[]
  /** What is NOT true here. Never empty for a chain that is not fully wired. */
  caveats: string[]
}

const OWNER = '0xd305607510E0Db2c95807173c7A05BEA53c1ed36'
const AGENT_CARD = 'https://a-identity.xyz/.well-known/agent-card.json'

export const PROVENANCE: ChainProvenance[] = [
  {
    chain: 'rhchain',
    summary:
      'Agent #0 on the canonical ERC-8004 IdentityRegistry is ours: the first token that registry ever minted. Paid trust calls settle here in USDG through our own first-party x402 facilitator, which we run because no published facilitator serves this chain.',
    agent: { tokenId: '0', caip: 'eip155:4663:8004/0', owner: OWNER, tokenUri: AGENT_CARD },
    contracts: [
      {
        name: 'IdentityRegistry',
        address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
        note: 'The canonical ERC-8004 registry, at the same address it carries on X Layer and Celo. We did not deploy it; its authors did. What is ours is token #0.',
      },
      {
        name: 'ReputationRegistry',
        address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
        note: 'Same canonical family. Read-side wired.',
      },
      {
        name: 'USDG (Paxos Global Dollar)',
        address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        note: 'The settlement token, at the address Paxos documents for this chain. EIP-3009 confirmed by probe; its EIP-712 domain is proven against the live DOMAIN_SEPARATOR before any challenge is served.',
      },
    ],
    artifacts: [
      {
        kind: 'mint',
        label: 'Agent #0 minted through the production adapter',
        txHash: '0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e',
        onChain: 'rhchain',
        blockNumber: 34617892,
        note: 'ownerOf(0) and tokenURI(0) still read back to the values recorded here; the page re-reads them live.',
      },
      {
        kind: 'settlement',
        label: 'First x402 settlement in USDG (risk_check, 0.025 USDG)',
        txHash: '0xbb41c7aa76d27282acb2128c3cdd0c0697238c3e662203ee33d01ad767325ab4',
        onChain: 'rhchain',
        blockNumber: 35439881,
        note: 'The buyer signed and paid no gas; we broadcast. 102495 gas, and the receipt carries the matching USDG Transfer.',
      },
      {
        kind: 'settlement',
        label: 'x402 settlement in USDG (verify_agent, 0.021 USDG)',
        txHash: '0xec2eaa495b903dee6c9371e0a16f287d8cf9bff7ead00910893ef1ae95bf89e6',
        onChain: 'rhchain',
      },
      {
        kind: 'settlement',
        label: 'x402 settlement in USDG (reputation_score, 0.022 USDG)',
        txHash: '0xbf21a18c82b768981eb28910204c4062a0f02cf897e23561b2392770ee45322b',
        onChain: 'rhchain',
      },
      {
        kind: 'settlement',
        label: 'x402 settlement in USDG (agent_passport, 0.030 USDG)',
        txHash: '0x0441b74deed3abffd00b8bfd297250f776e0e6046c88df62624effce83c1fbb1',
        onChain: 'rhchain',
      },
      {
        kind: 'funding',
        label: 'Funding hop: Arbitrum One deposit, bridged to this chain via Relay',
        txHash: '0xc8daa2954c243e4326b0b3adac3429cd5eca8cdd78d42a082c86289fe95ce941',
        onChain: 'arbitrum',
        note: 'The signer was funded from an exchange withdrawal that landed on Arbitrum One, then bridged. Recorded because the money trail should be followable.',
      },
    ],
    caveats: [
      'We did not deploy the ERC-8004 registries here. They were already live at their canonical cross-chain addresses; the agent is what is ours.',
      'Token #1 on this registry was minted 76 blocks after ours by 0x2B5B35AC5A2d5c1224337BA86bf3816AbEe69da3, carrying OUR agent card URL as its tokenURI. It is not ours. A tokenURI is not a discriminator on this registry, so resolve an agent by ownerOf, never by the card it points at. We report this rather than hide it: it is the clearest possible demonstration of why this product exists.',
      'There is no ValidationRegistry in this mainnet family, so a KYA result cannot be anchored on-chain here. It is still verified off-chain and recorded.',
      'No canonical Circle USDC is documented for this chain, so the registry asserts none. USDG is named as what it is, in its own field.',
      'We run our own x402 facilitator here because no published one serves this chain, not because nobody else relays. Gasless EIP-3009 relaying on USDG predates us by weeks, and on-chain an x402 settlement is indistinguishable from any other relayed authorization.',
      'This is an Arbitrum L2: we wait the descriptor\'s confirmations and record the block, but soft finality is not L1 finality, and the proof page does not claim otherwise.',
    ],
  },
  {
    chain: 'rhchain-testnet',
    summary:
      'The rehearsal network, and the only chain in the registry outside Arc that carries the full canonical ERC-8004 trio. Agent #0 here too, plus a real AgentSpendPolicy vault with a time-bounded session key.',
    agent: { tokenId: '0', caip: 'eip155:46630:8004/0', owner: OWNER, tokenUri: AGENT_CARD },
    contracts: [
      { name: 'IdentityRegistry', address: '0x8004A818BFB912233c491871b3d84c89A494BD9e', note: 'Same address as Arc and Celo Sepolia.' },
      { name: 'ReputationRegistry', address: '0x8004B663056A597Dffe9eCcC1965A193B7388713' },
      {
        name: 'ValidationRegistry',
        address: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
        note: 'Its implementation was the one piece missing here, and we deployed it by replaying the canonical Safe-Singleton-Factory calldata.',
      },
      {
        name: 'AgentSpendPolicy vault',
        address: '0xd369d63868c13ff32928451a4f881621ff2dbc01',
        note: 'One vault we deployed for verification, not a factory. Daily cap 25, auto-approve 5, seven-day session key.',
      },
    ],
    artifacts: [
      {
        kind: 'deploy',
        label: 'ValidationRegistry implementation, deployed by replaying canonical calldata',
        txHash: '0xcf642f0572b7e6cefc60cbf85b7d3b0536f5ea2816774f4da9114b96c1d779c2',
        onChain: 'rhchain-testnet',
      },
      {
        kind: 'mint',
        label: 'Agent #0 minted through the production adapter',
        txHash: '0x20918ec68186bd4aaee7c36d33d0383f1bc6a2bc921e72e3b812d034da5212fd',
        onChain: 'rhchain-testnet',
      },
      {
        kind: 'deploy',
        label: 'AgentSpendPolicy vault deployed',
        txHash: '0xa5263b086b5320964bf2c41aac3e55455bf941c146fed2705ebd4c3b9eea9d7e',
        onChain: 'rhchain-testnet',
      },
      {
        kind: 'session-key',
        label: 'Session key granted, expiring seven days later',
        txHash: '0xc43f99efd5a34fe31e78cecad78ef2029ff7eae5f7ec3c3ac7a39d11d84619bb',
        onChain: 'rhchain-testnet',
      },
      {
        kind: 'bridge',
        label: 'Funding hop: Sepolia deposit through the native bridge inbox',
        txHash: '0x65a5ad3166da6652462dc9f7025c84fcf52e411838886bd30c74859f8ccda96a',
        onChain: 'arbitrum',
        note: 'Sent on Ethereum Sepolia, which is this chain\'s parent. Linked through the Arbitrum descriptor because the registry has no Sepolia entry; the hash is the authority, not the link.',
      },
    ],
    caveats: [
      'The vault here was deployed against the canonical-bridge representation of Sepolia USDC, a labeled test token, not a canonical stablecoin.',
      'The vault owner and operator are the same address, so it demonstrates the deploy path rather than a real separation of duties.',
      'Settlement is proven on mainnet, not here: this network is where the code is rehearsed.',
    ],
  },
]

/** A judge-facing grouping. A rail can span more than one network, because splitting
 *  mainnet and testnet across two URLs would halve the evidence on each. */
export type ProofRail = { slug: string; title: string; lede: string; chains: string[] }

export const PROOF_RAILS: ProofRail[] = [
  {
    slug: 'robinhood',
    title: 'Robinhood Chain',
    lede:
      'Agent #0 on the mainnet registry, paid calls settling in USDG through the x402 facilitator we run ourselves, and the full canonical ERC-8004 set rehearsed on testnet.',
    chains: ['rhchain', 'rhchain-testnet'],
  },
]

export function provenanceFor(chainId: string): ChainProvenance | undefined {
  return PROVENANCE.find((p) => p.chain === chainId)
}

export function railBySlug(slug: string): ProofRail | undefined {
  return PROOF_RAILS.find((r) => r.slug === slug)
}

/** Explorer link for an artifact, derived from the chain it actually landed on. */
export function artifactUrl(a: ChainArtifact): string | null {
  const chain = getChainById(a.onChain)
  return chain ? txUrl(chain, a.txHash) : null
}

/** Explorer link for a contract on a provenance entry's own chain. */
export function contractUrl(chainId: string, address: string): string | null {
  const chain = getChainById(chainId)
  return chain ? addressUrl(chain, address) : null
}
