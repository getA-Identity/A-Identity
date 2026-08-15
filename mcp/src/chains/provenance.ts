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
// Ecosystem-aware on purpose. Importing these from evm/client.js rendered
// `<explorer>/address/<addr>` for every chain, which is a dead route on Stellar Expert
// (their API answers 404 for it). See ./explorer.ts for the verification.
import { txUrl, addressUrl } from './explorer.js'

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
      'The settlements recorded here are self-funded tests. The buyer wallet and the receiving address are both ours, and the receiving address is the same account that broadcasts. Labeled internal, always: evidence the rail works, not evidence of demand.',
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
  {
    chain: 'arbitrum',
    summary:
      'Agent #1259 on Arbitrum One is ours, and paid trust calls settle here in native Circle USDC through the same first-party EIP-3009 facilitator we run on Robinhood Chain. The canonical ERC-8004 registries were already deployed by their authors, so registering was permissionless and cost about a cent.',
    agent: { tokenId: '1259', caip: 'eip155:42161:8004/1259', owner: OWNER, tokenUri: AGENT_CARD },
    contracts: [
      {
        name: 'IdentityRegistry',
        address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
        note: 'The same canonical address X Layer, Celo and Robinhood Chain carry. Deployed by the ERC-8004 authors, not by us.',
      },
      { name: 'ReputationRegistry', address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' },
      {
        name: 'USDC (native Circle)',
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        note: 'The settlement token. Unlike Robinhood Chain this IS canonical Circle USDC, so it is also the descriptor\'s contracts.usdc. EIP-3009 confirmed, and its EIP-712 domain proven against the live DOMAIN_SEPARATOR before any challenge is served.',
      },
    ],
    artifacts: [
      {
        kind: 'mint',
        label: 'Agent #1259 minted through the production adapter',
        txHash: '0x23275840eb9a8b85a752769c113109a753f39b592236c85093cf94f6a517b2f3',
        onChain: 'arbitrum',
        blockNumber: 494146529,
        note: '178365 gas, about 0.0000036 ETH. Verified after the fact: ownerOf(1259) and tokenURI(1259) read back to the values recorded here.',
      },
      {
        kind: 'funding',
        label: 'Buyer wallet funded with USDC through a Relay same-chain swap',
        txHash: '0xc0a5bc5f9980b75f0ae176d7ba75865fd5338cd3b92d7e443b7f5c4a090735f9',
        onChain: 'arbitrum',
        note: 'Permissionless: no exchange, no KYC step. The buyer holds USDC and zero native ETH, so it cannot broadcast anything itself.',
      },
      {
        kind: 'settlement',
        label: 'First x402 settlement in USDC (risk_check, 0.015 USDC)',
        txHash: '0x69abb8a9aacf57fa0c3d2d4cd711d4f631e3f90c97222441f9f3ecee06834744',
        onChain: 'arbitrum',
        blockNumber: 494160024,
        note: '103569 gas, 0.00000207 ETH. The buyer signed and paid no gas; we broadcast, and the receipt carries the matching USDC Transfer. It was priced at a launch fee of 0.01, which this measurement then cut to 0.005; the transaction is left as it happened rather than re-run for cosmetics.',
      },
    ],
    caveats: [
      'We deployed nothing here. The registries were already live, and registering on them is permissionless; what is ours is agent #1259 and the rail.',
      'This chain is ALREADY served by other x402 facilitators, Coinbase\'s among them. We run ours anyway so that one code path and one receipt standard cover every chain we sell on, including the ones nobody else serves. Arbitrum One is where you can check our rail against a well-served baseline, which is more useful to you than being first would have been.',
      'Gasless EIP-3009 relaying on this USDC contract predates us by years and runs constantly. We did not bring gasless USDC to Arbitrum and do not claim to; on-chain an x402 settlement is indistinguishable from any other relayed authorization.',
      'The settlements recorded here are self-funded tests. The buyer wallet and the receiving address are both ours, and the receiving address is the same account that broadcasts. They are labeled internal and always will be: this is evidence the rail works, not evidence of demand.',
      'There is no ValidationRegistry in this family, so a KYA result cannot be anchored on Arbitrum One. It is still verified off-chain and recorded.',
      'Robinhood Chain is an Arbitrum L2, and being live there is a different statement from being live on Arbitrum One. Both are true today; neither substitutes for the other.',
      'This is an L2 that settles to Ethereum, so "settled" has layers and we name them: we wait the descriptor\'s confirmations, which is the sequencer\'s ordering commitment, and we record the block. That is not Ethereum finality, and these USDC cannot leave for Ethereum until the fraud-proof window passes.',
    ],
  },
  {
    chain: 'stellar-testnet',
    summary:
      'The first non-EVM rail here, and the only one where the spending limit is enforced by a contract before the payment exists. A Soroban spend policy holds the money, the agent asks it to pay, and the policy answers with a typed error or a transfer. Paid calls settle in SEP-41 USDC through the Soroban x402 facilitator we run ourselves, and every settlement is confirmed by reading the transfer event, whoever broadcast it.',
    contracts: [
      {
        name: 'AgentSpendPolicy (Soroban)',
        address: 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI',
        note: 'Ours, written in Rust for this chain rather than translated from the Solidity original: Soroban has no msg.sender, so the whole authorization surface collapses onto one require_auth line, and the test suite proves it would notice if that line went missing. Immutable by design, with no upgrade entrypoint.',
      },
      {
        name: 'USDC (Stellar Asset Contract)',
        address: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        note: 'Circle\'s testnet USDC as a SEP-41 contract. Derived with `stellar contract id asset` and matched against the literal rather than pasted, and read back live: the contract reports USDC with 7 decimals, which is what the registry declares. Seven, not the six every EVM USDC uses.',
      },
    ],
    artifacts: [
      {
        kind: 'deploy',
        label: 'The spend policy, deployed',
        txHash: '718f050b962b6e645d8cca5cc053d9f1c11a7264d3ddc266f7e36661bd82c68c',
        onChain: 'stellar-testnet',
        blockNumber: 4147602,
        note: 'Upload and instantiate in one transaction. The wasm sha256 is 155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239, recorded in soroban/releases/testnet-v0.1.0.json and confirmed by Stellar Expert as the code this contract carries. The binary itself is deliberately not committed: Rust wasm is not bit-reproducible across machines by default, so shipping one would invite a reproducibility claim we cannot honour. Pull it with `stellar contract fetch` and compare.',
      },
      {
        kind: 'settlement',
        label: 'An under-limit payment the policy allowed',
        txHash: '3da7463422c7d122202b009bb27442199ffc3b6da87da12a7112963bf4bcc999',
        onChain: 'stellar-testnet',
        blockNumber: 4147945,
        note: 'The first half of the pair the SoW measures. The operator paid 1 USDC inside a 2 USDC per-payment ceiling and a 10 USDC daily cap; the payee went to 1.0000000, the vault from 15 to 14, and spent_today to 1 USDC.',
      },
      {
        kind: 'settlement',
        label: 'An over-limit payment the policy refused, with a typed error',
        txHash: '12df418f21d329f606f412b1aee498714f1178d68fd0db0a97c64f0de6f209d3',
        onChain: 'stellar-testnet',
        blockNumber: 4147972,
        note: 'The other half, and the one that took work to produce. On Soroban a refused call normally leaves NO transaction at all, because the contract says no during simulation and nothing is ever submitted. To get a hash a reviewer can open, the policy was tightened while this payment was in flight, so it failed at apply time and the ledger recorded error #5, DailyCapExceeded.',
      },
      {
        kind: 'funding',
        label: '15 USDC into the vault, through the SAC',
        txHash: 'bec1b68be5861fdf7cc71b50ce7c8a5b5cb311326a240ca8e1f6a6af99e2a400',
        onChain: 'stellar-testnet',
        blockNumber: 4147942,
        note: 'The vault holds the token in contract storage rather than through a trustline, so it needs none. Both classic accounts do, and that is easy to learn the hard way: paying an account with no USDC trustline fails with op_no_trust, which a buyer reads as our bug.',
      },
      {
        kind: 'settlement',
        label: 'A gasless x402 purchase: the buyer signed, we paid the fee',
        txHash: '6d87799242b9fb36a26ac6f2d2fb11c5e7fb8bdd52bc6cf0471dcc8a8caba09c',
        onChain: 'stellar-testnet',
        blockNumber: 4149194,
        note: 'A buyer agent answered a 402 with a signed Soroban authorization entry and got the tool back. Horizon records the fee as charged to our operator account, not to the buyer, which is the gasless claim as a number somebody else can look up.',
      },
      {
        kind: 'settlement',
        label: 'The same purchase through the on-chain policy',
        txHash: 'fab5c864939da4165c21384afb24d690662c58ec17d46e36f7bc35ddf60b321f',
        onChain: 'stellar-testnet',
        blockNumber: 4149294,
        note: 'The agent paid from the vault instead of from a wallet, so the allowlist, the ceiling and the daily cap all ran on chain before the transaction existed. The same call to an unlisted payee was refused by the contract with error #3, PayeeNotAllowed, and produced no transaction at all, which is why that refusal has no hash here.',
      },
    ],
    caveats: [
      'Test money. This is the rehearsal rail, and the pubnet descriptor is still planned: nothing of value has moved on Stellar mainnet.',
      'No identity. ERC-8004 is EVM-only and no Soroban identity registry exists to point at, so a Stellar agent\'s passport is bridged from an EVM chain rather than anchored here. KYA cannot be verified on this chain.',
      'Not audited. The contract has been reviewed with the free tooling we could actually run, named, with output committed, plus an adversarial review that found and fixed real defects. That is not an audit and we will not call it one.',
      'The owner key is a single key, not a multisig. Losing it makes the vault balance unrecoverable, which is a deliberate trade against a capped balance and is written up in soroban/README.md rather than discovered.',
      'On the `settled` scheme, where an agent pays from the vault and hands us the hash, the binding is the transaction rather than an authorization nonce. We can prove the payment happened and was not redeemed here before; we cannot prove it was made for that particular purchase rather than another of the same price.',
      'A refused payment usually has no transaction to link. That is Soroban, not evasion: the contract answers during simulation and nothing is submitted, so most of our proofs of refusal are typed error codes rather than hashes.',
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
  {
    slug: 'stellar',
    title: 'Stellar',
    lede:
      'A Soroban spend policy that refuses an over-limit payment with a typed error, an x402 facilitator we wrote for this chain because our settlement should not depend on somebody else\'s service, and paid calls that settle in SEP-41 USDC. OpenZeppelin Channels got to a Stellar facilitator first and is kept here as a fallback; what is ours is that no payment counts until we have read the transfer ourselves.',
    chains: ['stellar-testnet'],
  },
  {
    slug: 'arbitrum',
    title: 'Arbitrum One',
    lede:
      'Agent #1259 on the canonical ERC-8004 registry, and paid calls settling in native Circle USDC through the facilitator we run ourselves. Other facilitators already serve this chain, which is the point: Arbitrum One is where you can check our rail against a well-served baseline.',
    chains: ['arbitrum'],
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
