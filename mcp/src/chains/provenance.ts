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
  kind: 'mint' | 'deploy' | 'session-key' | 'bridge' | 'settlement' | 'funding' | 'attestation'
  label: string
  txHash: string
  /** Registry id of the chain this transaction lives on. Usually the entry's own chain;
   *  a funding hop names another, which is exactly why the link derives from THIS.
   *
   *  Absent only when the transaction landed on a chain the registry does not model, in
   *  which case `externalChain` names it and the artifact carries no explorer link. */
  onChain?: string
  /**
   * A chain we transacted on but do not wire, in plain words rather than a registry id.
   *
   * The Sepolia funding hop below used to set `onChain: 'arbitrum'` and explain in a note
   * that it was really Sepolia. The note was honest and the field was not, and it is the
   * field that renders: the proof page printed "on arbitrum" and derived an Arbitrum One
   * explorer link for a hash that Arbitrum One has never seen, so the one thing a reader
   * could click to check us was guaranteed to come back empty.
   *
   * The alternative was adding Ethereum Sepolia to the registry, which would claim it as a
   * chain we support and move every chain count on the site. We do not support it; we sent
   * one funding transaction through it. So it is named here, and it gets no link, because
   * the registry is the only thing allowed to produce one.
   */
  externalChain?: string
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
      {
        kind: 'deploy',
        label: 'An AgentSpendPolicy vault, live on mainnet with USDG under dust caps',
        txHash: '0xe48d38b9188038afeb4fc1873fa05357408b976d76b7e6c1f468bcf58d2753d8',
        onChain: 'rhchain',
        note: 'The same contract that runs on Arc and (in Rust) on Stellar, holding the chain\'s real settlement token: dailyCap 1 USDG, autoApproveMax 0.25, a 7-day session key (tx 0xda4a3d7c). Deployed 2026-08-28 at 0x05a6aad7124c2f1c7b82b03e0bbe3867bc500073, funded with 0.03 USDG (tx 0x2bbb6077). Dust on purpose: the caps are the product, not the balance.',
      },
      {
        kind: 'settlement',
        label: 'An in-policy vault payment, and a typed refusal beside it',
        txHash: '0x0306446b13f7bdf3ca69824e41a311913e618bf95d5a0a647c8e2655234d6386',
        onChain: 'rhchain',
        blockNumber: 47888765,
        note: '0.01 USDG paid through pay() inside the policy. A 0.50 USDG attempt simulates to the contract\'s own typed AboveAutoApprove error and is refused before anything broadcasts, which is why the refusal has no hash: a payment the contract refuses fails in simulation, exactly as on the Soroban vault.',
      },
      {
        kind: 'attestation',
        label: 'Agent #0\'s reputation anchored on the canonical ReputationRegistry',
        txHash: '0xe11d5d0f46a9b08b8fe6c623ad0f35e898a3c2db67937377083253fe6b260979',
        onChain: 'rhchain',
        note: 'giveFeedback from our oracle validator (0xee602A16..., the same identity that attests on Arc; ERC-8004 forbids the owner attesting itself and the script refuses it). Score 60 of 1000, and the tag says WHY it is 60: an onchain-identity-basis score, the +60 identity credit with no platform settlement history bound to this agent. The raw score and basis are committed in the feedback hash.',
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
        externalChain: 'Ethereum Sepolia',
        note: 'Sent on Ethereum Sepolia, this chain\'s parent, which the registry does not model. No link, because a derived one would point at a chain that has never seen this hash. Paste it into sepolia.etherscan.io.',
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
      {
        kind: 'deploy',
        label: 'An AgentSpendPolicy vault, live on mainnet with native USDC under dust caps',
        txHash: '0x7ab3cba29361ad7fa2c1cd686eb057ed586cbcced75f2204b012e322eeb24d52',
        onChain: 'arbitrum',
        blockNumber: 499096816,
        note: 'The same contract that runs on Arc, Robinhood Chain and (in Rust) on Stellar: dailyCap 1 USDC, autoApproveMax 0.25, a 7-day session key (tx 0x1b516ce5). Deployed 2026-08-28 at 0xac6c5c9af62bc482ffeef882a6ac4678513be6db, 940641 gas, funded with 0.02 USDC (tx 0xc4f4e3bf). Dust on purpose: the caps are the product, not the balance.',
      },
      {
        kind: 'settlement',
        label: 'An in-policy vault payment, and a typed refusal beside it',
        txHash: '0x2f8008792c7f635c87f4a17f42c9181eb3051395efa26b41121fa1a54a318f45',
        onChain: 'arbitrum',
        blockNumber: 499096841,
        note: '0.01 USDC paid through pay() inside the policy. A 0.50 USDC attempt simulates to the contract\'s own typed AboveAutoApprove error and is refused before anything broadcasts, which is why the refusal has no hash.',
      },
      {
        kind: 'attestation',
        label: 'Agent #1259\'s reputation anchored on the canonical ReputationRegistry',
        txHash: '0x435a5c62bda28db23505812b9deb93dfce7aff3831e8449a5274fd0e7ecc376a',
        onChain: 'arbitrum',
        note: 'giveFeedback from our oracle validator (0xee602A16..., the same identity that attests on Arc). Score 60 of 1000, tagged onchain-identity-basis: the +60 identity credit with no platform settlement history bound to this agent, committed with the raw score in the feedback hash. The mainnet registry family\'s giveFeedback selector was located in its implementation bytecode before the first write, never assumed from Arc\'s.',
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
    chain: 'base',
    summary:
      'Agent #73232 on Base is ours, and paid trust calls settle here in native Circle USDC through the same first-party EIP-3009 facilitator that serves Robinhood Chain and Arbitrum One. The canonical ERC-8004 registries were already deployed by their authors; registering was permissionless and cost well under a cent. The operating wallets were funded from Stellar pubnet USDC through a NEAR Intents market-maker swap, recorded below, because a chain claim without its funding trail is a claim with a hole in it.',
    agent: { tokenId: '73232', caip: 'eip155:8453:8004/73232', owner: OWNER, tokenUri: AGENT_CARD },
    contracts: [
      {
        name: 'IdentityRegistry',
        address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
        note: 'The same canonical address X Layer, Celo, Robinhood Chain and Arbitrum One carry. Deployed by the ERC-8004 authors as an EIP-1967 proxy; verified 2026-08-28 by reading the implementation slot on Base and on Arbitrum One and matching the implementation code byte for byte, because eth_getCode alone is not proof on this chain (Arc\'s testnet-era addresses hold NON-canonical minimal proxies here at the same addresses).',
      },
      { name: 'ReputationRegistry', address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' },
      {
        name: 'USDC (native Circle)',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        note: 'The settlement token, canonical Circle USDC, so it is also the descriptor\'s contracts.usdc. EIP-3009 confirmed by a read-only authorizationState call, and its EIP-712 domain (version "2", read from version() itself) reproduces the live DOMAIN_SEPARATOR exactly.',
      },
    ],
    artifacts: [
      {
        kind: 'funding',
        label: 'Gas wallet funded from Stellar pubnet USDC via a NEAR Intents swap',
        txHash: 'a945bc92b62adf0c01d900ccffd2d7d024abd3c6551672260a67424239d2e198',
        onChain: 'stellar',
        note: '1.4 USDC left a pubnet burner into the market-maker deposit with a routing memo, and 0.000555 ETH arrived on Base for the operator wallet about 30 seconds later. The market maker\'s Base-side delivery transaction is theirs, not ours, so it is not claimed here.',
      },
      {
        kind: 'funding',
        label: 'Buyer wallet funded with USDC through the same NEAR Intents hop',
        txHash: '90a52cacf353f416c3a35c81a1c9a77d34d1206004d2dfd1a61b1bf471b692c7',
        onChain: 'stellar',
        note: '1.1 Stellar USDC became 1.096 native Base USDC at the buyer address. The buyer holds zero native ETH on purpose, so it cannot broadcast anything itself.',
      },
      {
        kind: 'mint',
        label: 'Agent #73232 minted through the production adapter',
        txHash: '0xb428bf8e79df3c44157c134df1858eb75fe3758b74868445c1dcd07948705bf0',
        onChain: 'base',
        blockNumber: 50540749,
        note: '177816 gas at an effective 0.006 gwei, about 0.0000016 ETH including the L1 data fee. Verified after the fact: ownerOf(73232) and tokenURI(73232) read back to the values recorded here.',
      },
      {
        kind: 'settlement',
        label: 'First x402 settlement in USDC (verify_agent, 0.006 USDC)',
        txHash: '0xb59ae67ced56426bdc1d85a71adadb35b0db59bcffeb3ff637eba23fe49a1450',
        onChain: 'base',
        blockNumber: 50540810,
        note: '102828 gas at an effective 0.006 gwei, about 0.00000062 ETH including the L1 fee. The buyer signed and paid no gas; we broadcast, and the receipt carries the matching 6000-unit USDC Transfer from the buyer to the receiving address plus the token\'s own AuthorizationUsed event binding it to the signed authorization. This measurement set the disclosed fee\'s basis.',
      },
      {
        kind: 'attestation',
        label: 'Agent #73232\'s reputation anchored on the canonical ReputationRegistry',
        txHash: '0x4f0295d12dcdc356cc7ac12b8317f1ff07289e4584725895f9b482a2223b2aa6',
        onChain: 'base',
        blockNumber: 50544732,
        note: 'giveFeedback from our oracle validator (0xee602A16..., the same identity that attests on Arc and, since today, on Robinhood Chain and Arbitrum One). Score 60 of 1000, tagged onchain-identity-basis: the +60 identity credit with no platform settlement history bound to this agent, committed with the raw score in the feedback hash.',
      },
    ],
    caveats: [
      'We deployed nothing here. The registries were already live and registering on them is permissionless; what is ours is agent #73232 and the rail.',
      'The settlement recorded here is a self-funded test: the buyer wallet and the receiving address are both ours, and the receiving address is the same account that broadcasts. It is labeled internal and always will be; this is evidence the rail works, not evidence of demand.',
      'This chain is ALREADY served by other x402 facilitators, Coinbase\'s among them. We run ours anyway so that one code path and one receipt standard cover every chain we sell on.',
      'The operating wallets were funded through a NEAR Intents market-maker swap from Stellar pubnet USDC: a custodial hop that took under a minute. The Stellar-side transactions are recorded above; the market maker\'s Base-side delivery transactions are not ours to claim.',
      'There is no ValidationRegistry in this family, so a KYA result cannot be anchored on Base. It is still verified off-chain and recorded.',
      'This is an L2 that settles to Ethereum, so "settled" has layers and we name them: we wait the descriptor\'s confirmations, which is the sequencer\'s ordering commitment, and we record the block. That is not Ethereum finality.',
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
        label: 'The owner freezes the vault, and the agent stops',
        txHash: 'fd0fb958923c5e5e70bedae6451cc9a492b250d3cec3750313814b7e4ccdf117',
        onChain: 'stellar-testnet',
        note: 'The kill switch, exercised rather than described. With the vault frozen the operator\'s next payment was refused with error #1, Frozen. That refusal has no hash of its own, for the reason every Soroban refusal here has none: the contract answers during simulation and nothing is submitted.',
      },
      {
        kind: 'settlement',
        label: 'The owner overrides: a payment past the freeze AND past the allowlist',
        txHash: 'f05c2f5be029d7403c6241c85f894160fe83f5866f1993de6ba1c3be7911b3eb',
        onChain: 'stellar-testnet',
        note: 'owner_pay to an account that is NOT on the allowlist while the vault is frozen. It settles, because the human path is meant to work exactly when the agent path does not. It was still CHARGED to the daily cap, which is the Solidity original\'s behaviour ported deliberately. Note the exact claim, because an earlier version of this note overstated it: owner_pay increments the day accumulator, but it is not LIMITED by the cap. `check_owner_pay` in policy.rs runs the amount, arithmetic and balance guards and no cap comparison, so the override bypasses the budget as well as the gates. What it does not bypass is the accounting: the outflow is recorded.',
      },
      {
        kind: 'settlement',
        label: 'The owner unfreezes, and the agent spends again',
        txHash: 'e92fcd5ff1c02b812419891da8a8c915d1d67e5f6d97d1d4da12f516bb227115',
        onChain: 'stellar-testnet',
        note: 'The other half of a kill switch is that it turns back off. A freeze you cannot lift is a loss, not a control.',
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
      'Test money. This is the rehearsal rail: every number on this network is test USDC and none of it is worth anything. It used to add that nothing of value had moved on Stellar mainnet, which stopped being true on 2026-08-24 when the same vault was deployed to pubnet and a real USDC budget was spent through it. That network has its own section on this page, with its own caveats.',
      'No identity. ERC-8004 is EVM-only and no Soroban identity registry exists to point at, so a Stellar agent\'s passport is bridged from an EVM chain rather than anchored here. KYA cannot be verified on this chain.',
      'Not audited. The contract has been reviewed with the free tooling we could actually run, named, with output committed, plus an adversarial review that found and fixed real defects. That is not an audit and we will not call it one.',
      'The owner key is a single key, not a multisig. Losing it makes the vault balance unrecoverable, which is a deliberate trade against a capped balance and is written up in soroban/README.md rather than discovered.',
      'On the `settled` scheme, where an agent pays from the vault and hands us the hash, the binding is the transaction rather than an authorization nonce. We can prove the payment happened and was not redeemed here before. We cannot prove it was made for that particular purchase rather than another of the same price, and we cannot prove the party presenting the hash is the party that made the payment: a landed transaction is public, so whoever presents it first is served. The scheme is restricted to contract payers for this reason, since an account can sign an authorization entry and get the stronger binding for free.',
      'One payment is one sale, and that took a fix. The two schemes keyed their replay guards in disjoint namespaces, so a purchase we had already broadcast, served and been paid for could be re-presented as a hash and sell the tool a second time. Found by an adversarial review, reproduced live against e1b0097a, and closed by burning both keys on every settlement plus refusing account payers on the hash path.',
      'A refused payment usually has no transaction to link. That is Soroban, not evasion: the contract answers during simulation and nothing is submitted, so most of our proofs of refusal are typed error codes rather than hashes.',
    ],
  },
  {
    chain: 'stellar',
    summary:
      'The same Soroban spend policy as the testnet rail, deployed to Stellar mainnet and funded with real USDC. An agent spent exactly its daily budget and not one unit more: four payments settled inside the policy, the fifth was refused with the contract\'s own DailyCapExceeded, and the human override paid through a freeze that had already stopped the agent. Small money on purpose, and the cap is the reason. Since 2026-08-28 the Soroban x402 rail also SELLS here: the first mainnet sale settled through our own facilitator, the buyer signing an authorization entry and paying no fee, and the sale counted only once we read the SEP-41 transfer event bound to its nonce.',
    contracts: [
      {
        name: 'AgentSpendPolicy (Soroban, pubnet)',
        address: 'CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP',
        note: 'Ours. The wasm hash is 155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239, byte for byte the hash the testnet vault carries, so mainnet runs the code that has been under test since 2026-08-15 rather than a rebuild of it. No upgrade entrypoint and no initialize: the constructor ran atomically at deploy and its arguments are permanent. Policy: 1 USDC per UTC day, 0.25 USDC per payment.',
      },
      {
        name: 'USDC (Stellar Asset Contract, pubnet)',
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        note: 'Circle\'s mainnet USDC as a SEP-41 contract. The issuer was checked before the derivation, which is the step that matters here: Horizon lists dozens of assets called USDC because anyone may issue one, and this issuer\'s home_domain is circle.com. The SAC id was then derived from that asset plus the pubnet passphrase rather than pasted, and read back live for symbol, decimals and name.',
      },
    ],
    artifacts: [
      {
        kind: 'funding',
        label: 'The payee opens a USDC trustline',
        txHash: 'f10c27d98a07c386c975bfeb3168947acab5e13e63536bc14093eb700a97c662',
        onChain: 'stellar',
        blockNumber: 64103407,
        note: 'A Stellar prerequisite with no EVM analogue, and one that is easy to learn the hard way: paying an account that holds no USDC trustline fails with op_no_trust, which a buyer reads as our bug rather than as their missing setup. The vault itself needs none, because it holds the token in contract storage rather than through a trustline.',
      },
      {
        kind: 'deploy',
        label: 'The spend policy, uploaded to mainnet',
        txHash: '4230a328bf063cc005e8fea00c45a9d38af57968b8ee166cbb5a11fb92b51fba',
        onChain: 'stellar',
        blockNumber: 64103416,
        note: 'The code entry alone cost 12.2319214 XLM, which is almost the whole bill for this deploy: a Soroban wasm entry pays rent for its size and this one is 11,625 bytes. The binary is deliberately not committed, because Rust wasm is not bit-reproducible across machines by default. Pull it with `stellar contract fetch` and sha256 it against the hash above.',
      },
      {
        kind: 'deploy',
        label: 'Instantiated with a policy that can never be changed',
        txHash: '847dc7e99e73f6c0062e5aed29599f41226998053fe7b6c35e48e9cf64a6ee2d',
        onChain: 'stellar',
        blockNumber: 64103418,
        note: 'Instantiating on top of the uploaded hash cost 0.0992122 XLM. The constructor read decimals() off the token itself, which is how the deploy proves the address really implements SEP-41; it read 7, not the 6 every EVM USDC uses.',
      },
      {
        kind: 'funding',
        label: '1 USDC bought on Stellar\'s own order book',
        txHash: 'b3ad997d83f578edf7583ef8c59dc5ec5db4091955b603e77aca1b939f5e9b41',
        onChain: 'stellar',
        blockNumber: 64103437,
        note: 'A strict-receive path payment, XLM in and exactly 1.0000000 USDC out at 0.1949500 USDC per XLM. No bridge and no exchange. It is also where the USD figures in this repo come from: a price read off the same ledger the rail settles on, rather than from an API we cannot show you.',
      },
      {
        kind: 'funding',
        label: '1 USDC moved into the vault',
        txHash: 'e558baf97bb8dde87cc585245df430e72667e21bd2cb78fee62418cd04692344',
        onChain: 'stellar',
        blockNumber: 64103469,
        note: 'Submitted twice, and the reason is worth recording rather than hiding. The first attempt returned a submission timeout, which is not a failure: a Stellar transaction stays valid for its whole timeout window. Horizon was checked first and showed the hash absent with no fee charged, so the retry was a resubmission of the same envelope and not a second payment. It landed under the same hash.',
      },
      {
        kind: 'settlement',
        label: 'An under-limit agent payment, in real USDC',
        txHash: 'c4a884c306ee0cd76b7fb4fa245176618897687ad7fee724e2d43b72d20f3733',
        onChain: 'stellar',
        blockNumber: 64103478,
        note: 'The operator paid 0.20 USDC, inside both the 0.25 ceiling and the 1 USDC cap. Two events fired: the SAC transfer out of the vault, and the vault\'s own Paid event carrying by_owner:false, which is what marks this as the agent path rather than the human one.',
      },
      {
        kind: 'settlement',
        label: 'Three payments at exactly the ceiling, walking the cap to its edge',
        txHash: 'd2386d419a2d546627b4b7247bb152e70b314e5f84a9d76a60f752cc81f95c80',
        onChain: 'stellar',
        blockNumber: 64103495,
        note: '0.25 USDC, the largest single payment the policy auto-approves. Two more followed at ledgers 64103499 (f514ac178bd4aba60d53cc3980f5517bb1bd93d53d7f69d227a798632251aefb) and 64103501 (ebf3cb627c18ec226be9e2790054c4de43d0da2b524f27fb499ab0af6a477d80), taking spent_today to 0.95 of a 1 USDC cap. The cap is cumulative across payments, which is what made the next one refusable.',
      },
      {
        kind: 'deploy',
        label: 'The kill switch, thrown on mainnet',
        txHash: 'c003e3fed6d39d820da51ea281b6d17fc910961bee88163ef8fb6fa084e059cf',
        onChain: 'stellar',
        blockNumber: 64103526,
        note: 'set_frozen(true), event FrozenSet. With the vault frozen the operator\'s next payment was refused with error 1, Frozen, and that refusal has no hash of its own for the reason every Soroban refusal here has none. Lifted again at ledger 64103532 by 8bccb734a624cb6165cdd74da5c2d196c3b67dd8a0ed92e3435df1ffd2ae9f9a, because the other half of a kill switch is that it turns back off: a freeze you cannot lift is a loss rather than a control.',
      },
      {
        kind: 'settlement',
        label: 'The owner overrides a freeze and pays anyway',
        txHash: '58c118ee659b65875efe5e916f7bb332bc896b62537fa8dd030e2c225defa1cf',
        onChain: 'stellar',
        blockNumber: 64103531,
        note: 'owner_pay while the vault was frozen. It settles, because the human path is meant to work exactly when the agent path does not, and its Paid event carries by_owner:true. It was still CHARGED to the daily cap, but note what that does and does not mean: owner_pay increments the day accumulator and is NOT limited by it. `check_owner_pay` in policy.rs has no cap comparison. The override bypasses the budget as well as the gates; what it does not bypass is the accounting. An earlier version of this note said the budget still bound it, which was wrong. The freeze went on at ledger 64103526 (c003e3fed6d39d820da51ea281b6d17fc910961bee88163ef8fb6fa084e059cf) and came off at 64103532 (8bccb734a624cb6165cdd74da5c2d196c3b67dd8a0ed92e3435df1ffd2ae9f9a), because a freeze you cannot lift is a loss rather than a control.',
      },
      {
        kind: 'funding',
        label: 'A buyer wallet funded with 0.05 USDC for the first x402 sale',
        txHash: '2f47f4fe2f003e8cf65f13d9c8ce62eb2c56319bda2812d93564f5c083d3a12e',
        onChain: 'stellar',
        note: 'The owner account (now 2-of-3 multisig, so the payment carries two signatures) moved 0.05 USDC to a burner that already held a USDC trustline. The buyer needs USDC and a trustline and nothing else: it signs authorization entries and never pays a network fee.',
      },
      {
        kind: 'settlement',
        label: 'First x402 sale on Stellar mainnet (verify_agent, 0.001 USDC)',
        txHash: 'f213371c1241968ee78170923d8c5a3bd9b32950e73bb9c563d800ab2c70ec9e',
        onChain: 'stellar',
        blockNumber: 64155370,
        note: 'The buyer signed a Soroban authorization entry for transfer on the USDC SAC and paid nothing; we assembled, paid 34035 stroops and submitted, and the sale counted only once the SEP-41 transfer event bound to the authorization\'s nonce was read back. Recorded honestly: the first two attempts never landed, because the transaction bid the 100-stroop minimum inclusion fee that testnet always accepts while pubnet\'s auction was clearing at 200 across every percentile. The fix bids the fee market\'s own p90 with headroom, and this settlement is the measurement.',
      },
    ],
    caveats: [
      'Real money, but small money. The cap is 1 USDC per UTC day and the vault was funded with 1 USDC. Nothing here shows behaviour at a size anyone would mind losing, and that is the deliberate trade for an unaudited contract holding value.',
      'The two refusals have no transaction to link, and that is Soroban rather than evasion. A payment the contract refuses fails in SIMULATION, so nothing is submitted and no hash exists. The 0.50 USDC attempt returned AboveAutoApprove (error 4) and the over-cap attempt returned DailyCapExceeded (error 5). Anyone can reproduce both against the live contract in seconds, and it costs nothing precisely because they are refused.',
      'The over-cap refusal is worth reading closely. The vault held only 0.05 USDC at that moment, so an InsufficientBalance refusal was also available, and the contract returned DailyCapExceeded instead because the cap gate fires before the balance gate. The ORDER is the product: the agent is told its budget is spent, not that the account is short, and those call for different human responses.',
      'Not audited. Free tooling we can re-run, an adversarial review that found and fixed real defects, and a negative-control runner that deletes each guard in turn and requires the suite to go red. That is not an audit and we will not call it one.',
      'The operator is a single burner key in a local CLI keystore, not an HSM. The owner account has since been raised to 2-of-3 multisig (thresholds 2/2/2, read live 2026-08-28), which an earlier version of this caveat predated; losing two of its three keys still makes the balance unrecoverable, which is the trade a capped vault is meant to make survivable.',
      'Payer and payee are both ours: the owner account funded the vault and received every payment, including the first x402 sale. Evidence the rail works, not evidence of demand.',
      'The x402 sale recorded here is one sale, settled from an operator machine. The production deployment sells on pubnet only once its environment names the network, a pubnet payTo and a funded fee payer; until then production serves testnet and says so.',
      'No identity. ERC-8004 is EVM-only and no Soroban identity registry exists to point at, so a Stellar agent\'s passport is bridged from an EVM chain rather than anchored here. KYA cannot be verified on this chain.',
    ],
  },
  {
    chain: 'arc',
    summary:
      'The phase-1 chain and the only one where all three registries of the ERC-8004 testnet family run together. Agent #849980 (Meridian) is ours: registered 2026-07-10, KYA-attested through the ValidationRegistry, and carrying the first reputation anchor our oracle validator ever wrote. This entry was added 2026-08-30, when an inventory found the flagship agent absent from the ledger that exists to record such things.',
    agent: {
      tokenId: '849980',
      caip: 'eip155:5042002:8004/849980',
      owner: OWNER,
      tokenUri:
        'data:application/json,%7B%22name%22%3A%22Meridian%22%2C%22category%22%3A%22Research%20%2F%20Data%22%2C%22standard%22%3A%22ERC-8004%22%2C%22app%22%3A%22A-Identity%22%7D',
    },
    contracts: [
      {
        name: 'IdentityRegistry',
        address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        note: 'The Arc testnet family address, not the canonical mainnet one that Arbitrum, Base, Celo and Robinhood Chain share.',
      },
      { name: 'ReputationRegistry', address: '0x8004B663056A597Dffe9eCcC1965A193B7388713' },
      {
        name: 'ValidationRegistry',
        address: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
        note: 'The registry KYA attests through. Only the Arc and Robinhood testnet families carry one; on every mainnet we sell on, KYA stays off-chain.',
      },
    ],
    artifacts: [
      {
        kind: 'mint',
        label: 'Agent #849980 registered, the mint the public copy long mislabeled an anchor',
        txHash: '0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54',
        onChain: 'arc',
        blockNumber: 51174931,
        note: 'register(uri) on 2026-07-10, minting straight to the owner wallet. Re-verified 2026-08-30: ownerOf(849980) reads back the owner recorded here and tokenURI carries the inline Meridian metadata.',
      },
      {
        kind: 'attestation',
        label: 'KYA attested on-chain through the ValidationRegistry',
        txHash: '0x758ddbfad38daeb772a37deb07e65339f13aeb393899fc7e1d2689c95adf0dad',
        onChain: 'arc',
        note: 'Wallet-control proof committed on-chain. It shows the agent controls its wallet and nothing more; it is not an audit and the KYA docs say so.',
      },
      {
        kind: 'attestation',
        label: 'The first reputation anchor our oracle validator wrote anywhere',
        txHash: '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c',
        onChain: 'arc',
        note: 'giveFeedback from the oracle validator (0xee602A16..., never the owner: ERC-8004 forbids self-attestation). Score 542 of 1000 on 2026-07-22, computed from real platform settlement history rather than the flat identity credit the mainnet wave carries.',
      },
    ],
    caveats: [
      'Testnet. Nothing on Arc moves real money, and the settlement history behind the 542 score is testnet activity on our own platform.',
      'The KYA attestation proves wallet control at attestation time, not code quality, custody practice, or anything else the word verified might be hoped to stretch to.',
      'The mint transaction was cited in public copy as an anchor tx for weeks. Same hash, wrong noun: it is the registration itself, and the copy now says so.',
    ],
  },
  {
    chain: 'celo',
    summary:
      'Agent #9759 on the canonical ERC-8004 IdentityRegistry, registered 2026-08-09 by the same wallet that receives Celo x402 payments. Payments here settle through the first-party facilitator Celo runs rather than a rail of ours, and this entry was added 2026-08-30, when an inventory found the registration recorded nowhere in the repo.',
    agent: {
      tokenId: '9759',
      caip: 'eip155:42220:8004/9759',
      owner: '0xF43F43D8aee114a71B164e1f6214BC7625a5742D',
      tokenUri: AGENT_CARD,
    },
    contracts: [
      {
        name: 'IdentityRegistry',
        address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        note: 'The canonical mainnet address Arbitrum, Base, X Layer and Robinhood Chain share. Deployed by the ERC-8004 authors, not by us.',
      },
      { name: 'ReputationRegistry', address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' },
    ],
    artifacts: [
      {
        kind: 'mint',
        label: 'Agent #9759 registered on the canonical registry',
        txHash: '0x0a821026621e5b35ff5602f81348b276b0d0f1b61a3892365658295fc5bcb22e',
        onChain: 'celo',
        blockNumber: 74379462,
        note: 'register on 2026-08-09 from the Celo payTo wallet. The hash was recovered from the explorer on 2026-08-30, because nothing in the repo had recorded it; ownerOf(9759) and tokenURI(9759) were re-read live the same day and match this entry.',
      },
    ],
    caveats: [
      'The owner is the Celo payTo wallet, not the wallet that owns every other EVM agent of ours. Deliberate at registration time, but it means this identity and the payment recipient are the same key.',
      'No reputation anchor exists for #9759 yet; the oracle validator has never written on this chain.',
      'The x402 rail here is Celo\'s own first-party facilitator, not our EIP-3009 rail, so settlement receipts follow their format rather than ours.',
    ],
  },
  {
    chain: 'algorand',
    summary:
      'The second non-EVM rail, and the fastest promotion in this ledger: the descriptor entered at beta and flipped to live the same day, 2026-08-30, on a real mainnet sale. The operating accounts were funded from a Stellar XLM treasury through an instant exchange, both accounts opted in to the USDC ASA (the trustline of this chain), and the first x402 sale settled through the GoPlausible facilitator with the buyer paying no network fee. No payment counted until our own indexer read of the transfer.',
    contracts: [],
    artifacts: [
      {
        kind: 'bridge',
        label: 'The first funding leg leaves the Stellar treasury',
        txHash: '2c9357153d2b3e3dccb0258f648b2ca037e458d8bab934c6e638f3c5c1d7d2b9',
        onChain: 'stellar',
        note: '17.5 XLM to an instant-exchange deposit address, memo-tagged. NEAR Intents, the route Base used, lists no Algorand assets, so this crossing runs through SideShift; the trade-off is named rather than hidden: a custodial hop of a few dollars, refundable to the treasury, chosen over standing up a DEX integration for one funding event.',
      },
      {
        kind: 'bridge',
        label: 'ALGO arrives in the payTo account',
        txHash: 'TCIUMHTFNTSYEVFWSFXM3J54PUPGINNBNYS2OEVYZYXFLV3IFERA',
        onChain: 'algorand',
        note: 'About 34.7 ALGO, far more than the half-ALGO the go-live needs, because the exchange minimum per crossing (16.7 XLM) decides the size, not us. The surplus is future minimum-balance steps and years of fees.',
      },
      {
        kind: 'funding',
        label: 'The payTo account opts in to the USDC ASA',
        txHash: '4SNAUL6MQRMFA5HX3BU3ZZOELRGI33NRBOXRQHZFJ4NL34Z3WOAQ',
        onChain: 'algorand',
        note: 'The Algorand prerequisite with no EVM analogue and a Stellar twin (the trustline): an account that has not opted in cannot receive the asset at all, at a 0.1 ALGO minimum-balance step. The rail\'s status route checks this live because forgetting it produces failures that read as our bug.',
      },
      {
        kind: 'funding',
        label: 'The buyer account is funded with 0.4 ALGO for its own reserve',
        txHash: '2FD4KUYKLRGYLKKJDAC536WWLDMJT3APK4MSUPL2HUKVSGLD5XTQ',
        onChain: 'algorand',
        note: 'Reserve and opt-in only. The buyer needs no ALGO to PAY: its transfer is signed with fee zero and the facilitator\'s fee payer covers the pooled group fee.',
      },
      {
        kind: 'funding',
        label: 'The buyer opts in to the USDC ASA',
        txHash: 'SYPITYXNJIDPYKBE2AFRDFBQL2NYHM73SFOULYYKABQBBSDVFKPA',
        onChain: 'algorand',
        note: 'Sequenced before the USDC crossing on purpose: an exchange cannot settle an ASA into an account that has not opted in, and learning that after sending would have meant a refund round-trip.',
      },
      {
        kind: 'bridge',
        label: 'The second funding leg leaves the Stellar treasury',
        txHash: 'eab46931587b7fadbaffa71fd96233954315bfd4a900dd7ba906de219d1912cf',
        onChain: 'stellar',
        note: 'Another 17.5 XLM, this one crossing into USDC on the algorand network for the buyer.',
      },
      {
        kind: 'bridge',
        label: 'About 3.09 USDC arrives in the buyer account',
        txHash: 'E7YTOLPN6TZZDPXLPK3HPRKBXWFABXHPZ2OUK6JMY7Y2UX7ZZY6Q',
        onChain: 'algorand',
        note: 'The war chest for real paid calls: at 0.001 USDC per verify_agent this is three thousand of them.',
      },
      {
        kind: 'settlement',
        label: 'First x402 sale on Algorand mainnet (verify_agent, 0.001 USDC)',
        txHash: 'YNNA54CXZGWBGL5ILYBV4K5RI26KTALIGWGXX6MJOORDAEEUPCWQ',
        onChain: 'algorand',
        blockNumber: 64547231,
        note: 'The buyer signed a fee-zero ASA transfer inside a pooled-fee atomic group; the GoPlausible facilitator signed the fee payer and broadcast; and the sale counted only once our own indexer read returned the transfer with a confirmed round, matching asset, recipient, amount and sender. The x402 v2 exact scheme, exactly as the challenge advertised it.',
      },
    ],
    caveats: [
      'Payer and payee are both ours: the buyer account and the payTo account were funded from the same treasury, and the first sale is evidence the rail works, not evidence of demand.',
      'Settlement runs through an external facilitator (GoPlausible, the rail this ecosystem standardized on), not a broadcaster of ours. What stays ours is that the payment group is verified locally before the facilitator sees it and that nothing counts as settled until we read the transfer back from an indexer ourselves.',
      'The funding crossed chains through a custodial instant exchange, because no non-custodial route we use elsewhere lists Algorand. A few dollars rode that trust for a few minutes, and the transaction pair on each side is linked above so the crossing is checkable.',
      'No identity. No ERC-8004 registry or agent-identity ARC was found on Algorand as of 2026-08-30, so KYA cannot be anchored and an agent\'s passport is bridged from an EVM chain rather than anchored here.',
      'The production deployment sells here only once its environment names the network and the payTo credentials; until then production refuses with a labeled 501, and the first sale above was settled from an operator machine against the same code path production runs.',
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
      'A Soroban spend policy that refuses an over-limit payment with a typed error, deployed on MAINNET as well as testnet and holding real USDC: an agent spent exactly its 1 USDC daily budget there and the next payment was refused by the contract. The x402 facilitator we wrote for this chain now sells on BOTH networks: the first mainnet sale settled 2026-08-28 through our own broadcaster, at the fee market\'s own rate. OpenZeppelin Channels got to a Stellar facilitator first and is kept as a fallback; what is ours is that no payment counts until we have read the transfer ourselves.',
    chains: ['stellar', 'stellar-testnet'],
  },
  {
    slug: 'arbitrum',
    title: 'Arbitrum One',
    lede:
      'Agent #1259 on the canonical ERC-8004 registry, and paid calls settling in native Circle USDC through the facilitator we run ourselves. Other facilitators already serve this chain, which is the point: Arbitrum One is where you can check our rail against a well-served baseline.',
    chains: ['arbitrum'],
  },
  {
    slug: 'base',
    title: 'Base',
    lede:
      'Agent #73232 on the canonical ERC-8004 registry, and paid calls settling in native Circle USDC through the facilitator we run ourselves. The operating wallets were funded from Stellar pubnet USDC through a NEAR Intents swap, and that funding trail is part of the record.',
    chains: ['base'],
  },
  {
    slug: 'algorand',
    title: 'Algorand',
    lede:
      'The second non-EVM rail, live the same day it shipped: x402 v2 in native Circle USDC, the buyer signing a fee-zero transfer inside a pooled-fee atomic group, the GoPlausible facilitator broadcasting, and no sale counted until our own indexer read of the transfer. First mainnet sale 2026-08-30, funded end to end from a Stellar XLM treasury, and every hop of that funding is linked here.',
    chains: ['algorand'],
  },
]

export function provenanceFor(chainId: string): ChainProvenance | undefined {
  return PROVENANCE.find((p) => p.chain === chainId)
}

export function railBySlug(slug: string): ProofRail | undefined {
  return PROOF_RAILS.find((r) => r.slug === slug)
}

/**
 * Explorer link for an artifact, derived from the chain it actually landed on.
 *
 * Null for an artifact on a chain the registry does not model. No link beats a link that
 * resolves to nothing: a reader who clicks and gets an empty page learns that we are wrong
 * about our own transaction, which is worse than being told there is nowhere to click.
 */
export function artifactUrl(a: ChainArtifact): string | null {
  if (!a.onChain) return null
  const chain = getChainById(a.onChain)
  return chain ? txUrl(chain, a.txHash) : null
}

/** Explorer link for a contract on a provenance entry's own chain. */
export function contractUrl(chainId: string, address: string): string | null {
  const chain = getChainById(chainId)
  return chain ? addressUrl(chain, address) : null
}
