/**
 * The chain registry - the single source of truth for every chain this backend
 * knows about. Adding a chain = adding one descriptor here (plus, for a new VM,
 * an adapter under ./<ecosystem>/). Nothing else hardcodes a chain id, RPC, or
 * address. See ./README.md.
 *
 * Status is honest: only `live` chains are wired end to end. `planned` chains carry
 * their public metadata (CAIP-2, chain id, canonical USDC, CCTP domain) so onboarding
 * is a data edit, but they are NOT integrated until their contracts are deployed and
 * the status is flipped to `beta`/`live`.
 */
import type { ChainDescriptor } from './types.js'
import { evmChainIdFromCaip2, isValidCaip2 } from './caip.js'

/**
 * The Arachnid deterministic CREATE2 factory. Verified present with a live eth_getCode call
 * on EVERY EVM chain in this registry on 2026-07-29 (arc, base, arbitrum, avalanche, xlayer,
 * rhchain, rhchain-testnet), which is what makes the chains README's same-address promise
 * actually achievable rather than merely intended.
 *
 * CreateX (0xba5Ed099...) is NOT present on Robinhood Chain, either network, so CREATE3
 * (address independent of constructor args) would need CreateX deployed there first.
 *
 * The canonical ERC-8004 registries were deployed by their authors through a DIFFERENT
 * deterministic deployer, the Safe Singleton Factory (0x914d7Fec6aaC8cd542e72Bca78B3
 * 0650d45643d7), which is ALSO present on both Robinhood chains (eth_getCode verified
 * 2026-08-11). That is what makes the 0x8004... registry addresses reproducible there:
 * scripts/rh-testnet-deploy-8004.mjs replays the canonical creation calldata through it.
 */
const CREATE2_FACTORY = '0x4e59b44847B379578588920cA78FbF26c0B4956C'

export const CHAINS: ChainDescriptor[] = [
  // Order is the console's display order (Overview -> Network). Statuses:
  // live = wired end to end today, beta = testnet active, planned = roadmap.
  //
  // Where the roadmap actually stands: arc + xlayer are live; base, the celo pair
  // (mainnet + Celo Sepolia: identity reads live, x402 facilitator rail wired) and
  // the Robinhood pair (testnet: full ERC-8004 set live since 2026-08-11 with agent #0
  // minted; mainnet: canonical identity + reputation registries verified live
  // 2026-08-12, read-side wired, writes wait on a funded signer) are beta; stellar,
  // avalanche and arbitrum are planned. Among the planned chains, STELLAR is next: its
  // integration is funded work (the Instawards SoW), ahead of avalanche/arbitrum,
  // which is why it sits right after Arc in this display order.
  {
    caip2: 'eip155:5042002',
    id: 'arc',
    name: 'Circle Arc (Testnet)',
    shortName: 'Arc',
    color: '#2775CA',
    role: 'Primary payment rail: gas in USDC, sub-second finality, App Kit unified balance.',
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
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 1, // deterministic sub-second finality
    stablecoins: ['USDC', 'EURC', 'USYC'],
    signerEnvVar: 'ARC_SIGNER_KEY',
    rpcEnvVar: 'ARC_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true },
    payment: { x402: true, note: 'Gas in USDC, App Kit (Gateway) unified balance, nanopayments.' },
  },
  // The Stellar pair, split the same way celo/celo-sepolia and rhchain/rhchain-testnet
  // are: one descriptor per network, because a single entry cannot carry two SAC
  // addresses, two signers and two sets of provenance. Split while both were still
  // `planned`, deliberately: once a settlement row or a provenance artifact points at an
  // id, renaming that id is a migration rather than a data edit.
  //
  // The env var names do NOT follow the bare-name-means-mainnet convention the EVM chains
  // use. `STELLAR_SIGNER_SECRET` already existed and already meant testnet, so handing
  // that name to pubnet would have turned an existing testnet key into a mainnet signing
  // key the next time anyone pulled, with no error and no prompt. Both networks therefore
  // name themselves. "pubnet" and "testnet" are also Stellar's own words for them.
  //
  // Both are protocol 27, verified by direct RPC probe on 2026-08-15 against each
  // network's own getVersionInfo. See soroban/releases/protocol-verification-2026-08-15.json.
  {
    caip2: 'stellar:pubnet',
    id: 'stellar',
    name: 'Stellar',
    shortName: 'Stellar',
    color: '#7D00FF',
    role: 'Fast, low-cost settlement: native Circle USDC, Soroban contracts, and an x402 rail where the buyer signs and pays no transaction fee.',
    ecosystem: 'stellar',
    testnet: false,
    // Listed live by a maintainer's call, 2026-08-27 (commit 050073d), and the caveat
    // that used to temper the label closed on 2026-08-28: the Soroban x402 rail now
    // SELLS on pubnet. First sale tx f213371c... (ledger 64155370), 0.001 USDC through
    // our own facilitator, the buyer signing a Soroban authorization entry and paying
    // no fee, our fee payer bidding the network's own market rate (the 100-stroop
    // minimum that testnet always accepts loses pubnet's inclusion auction, which is
    // why the first two attempts sat invisible until they expired). The vault story
    // stands: deployed on pubnet, real USDC moved under the on-ledger policy
    // (2026-08-24, contract CB5LYXFK..., see soroban/releases/pubnet-v0.1.0.json).
    // 'live' has never meant no caveats; the remaining one is identity, because
    // ERC-8004 is EVM-only and nothing bridges it here.
    status: 'live',
    evmChainId: null,
    cctpDomain: 27,
    nativeCurrency: { name: 'Lumen', symbol: 'XLM', decimals: 7 },
    usdcDecimals: 7, // Stellar assets use 7 decimals, not the 6 every EVM USDC uses
    rpcUrls: ['https://mainnet.sorobanrpc.com'],
    explorer: 'https://stellar.expert/explorer/public',
    contracts: {
      // The AgentSpendPolicy vault, deployed 2026-08-24. wasm sha256
      // 155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239, which is byte
      // for byte the hash the testnet vault carries: same source, same pinned toolchain,
      // same target. Its deploy pair and the payments made under its policy are recorded
      // in soroban/releases/pubnet-v0.1.0.json.
      spendVault: 'CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP',
      //
      // No `usdc` either, and that is not an oversight. On Stellar USDC is a SEP-41
      // Stellar Asset Contract, whose id is DERIVED per network from the classic asset
      // plus the network passphrase. Every consumer of `contracts.usdc` in this codebase
      // is an EVM path that would treat a C... StrKey as a 0x address. When the rail
      // lands, the SAC belongs in `settlementTokens` with the derivation recorded, the
      // same way USDG does on Robinhood Chain.
    },
    confirmations: 1, // deterministic finality once a ledger closes
    stablecoins: ['USDC', 'EURC'],
    settlementTokens: [
      {
        symbol: 'USDC',
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        decimals: 7,
        authorization: 'soroban-auth',
        // No domainVersionCandidates here either, for the reason the testnet entry gives:
        // Soroban fixes the authorization preimage at the protocol level, so a version
        // candidate would assert the existence of something that does not exist.
        verified:
          'Not pasted, and the ISSUER was verified before the derivation, which matters more ' +
          'on pubnet than on testnet: Horizon lists dozens of assets with the code USDC because ' +
          'anyone may issue one. The issuer account GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN ' +
          'was read live and its home_domain is circle.com, which is the SEP-1 binding between ' +
          'an issuer and a company. The SAC id was then DERIVED with `stellar contract id asset ' +
          '--asset USDC:GA5ZSEJ... --network-passphrase \'Public Global Stellar Network ; September 2015\'` ' +
          'rather than pasted, which is why it differs from testnet\'s CBIELTK6... even though the asset ' +
          'code is the same, and the derived contract was read back live: symbol() USDC, ' +
          'decimals() 7, name() the full canonical asset string naming that same issuer. Kept OUT ' +
          'of contracts.usdc because every consumer of that slot is an EVM path that would read a ' +
          'C... StrKey as a 0x address.',
      },
    ],
    signerEnvVar: 'STELLAR_PUBNET_SIGNER_SECRET',
    rpcEnvVar: 'STELLAR_PUBNET_RPC_URL',
    identity: {
      standard: 'Soroban registry + SEP-10',
      erc8004Native: false,
      note:
        'No native ERC-8004: that standard is EVM-only and nothing bridges it here. A Soroban ' +
        'agent registry DOES exist on pubnet, TrionLabs Stellar-8004 (MIT), Identity ' +
        'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35, read live 2026-08-26: ' +
        'name "Agent Registry", symbol AGENT, version 0.1.0, total_agents 68. It is NOT a bridge ' +
        'and we do not resolve against it. Its exported interface contains no function binding an ' +
        'agent to a foreign-chain identity, no CAIP-10 and no chain id; the only places a ' +
        'cross-chain reference could live are the free-form agent_uri and set_metadata, which are ' +
        'assertions by whoever holds the key and are checked by nothing. It mints its own ids in ' +
        'its own space starting at 0 (owner_of(0) resolves), so an id there and an ERC-8004 token ' +
        'id are different identities that happen to be integers. Two further differences worth ' +
        'knowing before wiring anything: it is UPGRADEABLE behind a 51,840-ledger timelock, which ' +
        'ours deliberately is not, and stellar.expert reports its source as unverified.',
    },
    payment: {
      x402: true,
      note:
        'x402 in USDC over the SEP-41 SAC. The buyer signs a Soroban authorization entry rather ' +
        'than a whole transaction, so whoever assembles it pays the network fee. Note the exact ' +
        'claim: the buyer pays no FEE. It still needs XLM to exist at all, 1 for the account ' +
        'reserve and 0.5 more per trustline, which is a Stellar property no rail can remove. ' +
        'An operator who funds an agent with USDC alone will find the account was never created.',
    },
  },
  {
    caip2: 'stellar:testnet',
    id: 'stellar-testnet',
    name: 'Stellar Testnet',
    shortName: 'Stellar test',
    color: '#7D00FF',
    role: 'Stellar rehearsal rail: the same Soroban vault and the same x402 code path as pubnet, in test money.',
    ecosystem: 'stellar',
    testnet: true,
    // beta, not live. In this repo live means wired end to end AND carrying real traffic;
    // this rail settles real transactions in test money, which is the whole point of the
    // word beta. The pubnet entry stays planned until money that matters moves on it.
    status: 'beta',
    evmChainId: null,
    // Circle documents CCTP domain 27 for Stellar. Kept on both entries because the
    // domain identifies the chain, not the network, but note that a Stellar CCTP
    // recipient MUST be routed through Circle's CctpForwarder: the message format has no
    // room for a StrKey type marker, so a direct mint to a G... account is unrecoverable.
    cctpDomain: 27,
    nativeCurrency: { name: 'Lumen', symbol: 'XLM', decimals: 7 },
    usdcDecimals: 7,
    rpcUrls: ['https://soroban-testnet.stellar.org'],
    explorer: 'https://stellar.expert/explorer/testnet',
    faucet: 'https://friendbot.stellar.org',
    contracts: {
      // The AgentSpendPolicy vault, deployed 2026-08-15. wasm sha256
      // 155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239, recorded next to
      // its deploy transaction in soroban/releases/testnet-v0.1.0.json. Under the vault's
      // own policy an under-limit payment settled (3da74634...) and an over-limit one was
      // refused on chain with the contract's typed DailyCapExceeded (12df418f...).
      spendVault: 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI',
    },
    confirmations: 1,
    stablecoins: ['USDC'],
    settlementTokens: [
      {
        symbol: 'USDC',
        address: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        decimals: 7,
        authorization: 'soroban-auth',
        // No domainVersionCandidates, and that absence is asserted by registry.test.ts
        // rather than merely omitted. An EIP-3009 token needs one because its EIP-712
        // domain is per-token and has to be proven against the live separator; Soroban
        // fixes the authorization preimage at the protocol level, so a version candidate
        // here would assert the existence of something that does not exist.
        verified:
          'Not pasted. Derived on 2026-08-15 with `stellar contract id asset --asset ' +
          'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet`, ' +
          'which is how a SAC id is meant to be obtained: it is a deterministic function of ' +
          'the classic asset plus the network passphrase, so the same asset maps to a ' +
          'different contract on pubnet. The derivation matched the constant @x402/stellar ' +
          'exports, and the contract was then read live for decimals() 7 and symbol() USDC. ' +
          'Three independent agreements before a single unit moved through it. Kept OUT of ' +
          'contracts.usdc because every consumer of that slot is an EVM path that would read ' +
          'a C... StrKey as a 0x address.',
      },
    ],
    signerEnvVar: 'STELLAR_TESTNET_SIGNER_SECRET',
    rpcEnvVar: 'STELLAR_TESTNET_RPC_URL',
    identity: {
      standard: 'Soroban registry + SEP-10',
      erc8004Native: false,
      note:
        'Same as pubnet: no ERC-8004 here, so KYA cannot be anchored and the passport is bridged ' +
        'rather than native. Stellar-8004 has its own testnet deployment, a different contract by ' +
        'a different deployer, Identity CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH. ' +
        'Same caveat as pubnet: we do not resolve against it and it binds no foreign identity.',
    },
    payment: {
      x402: true,
      note: 'Where every x402 change is rehearsed before pubnet sees it. Testnet resets periodically, so a contract here is a rehearsal, never a record.',
    },
  },
  // ── Algorand ─────────────────────────────────────────────────────────────────────────
  // The second non-EVM ecosystem. CAIP-2 references are the REGISTERED 32-char truncated
  // base64 genesis-hash prefixes from the chain-agnostic namespace registry, not the full
  // padded base64 the GoPlausible facilitator uses as its network string: '=' and '/' are
  // not legal CAIP-2 reference characters, so the rail maps between the two forms and the
  // registry stays standards-clean.
  {
    caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
    id: 'algorand',
    name: 'Algorand',
    shortName: 'Algorand',
    // The brand mark is monochrome black; a grey chip color is chosen for legibility on
    // both themes, the same call X Layer's black mark already made.
    color: '#8C929C',
    role: 'Agentic-commerce settlement: native Circle USDC, deterministic ~2.8s finality, and an x402 rail where the buyer signs a fee-zero transfer and the group fee is pooled.',
    ecosystem: 'algorand',
    testnet: false,
    // live as of 2026-08-30: the bar this entry was told to meet was "a real mainnet
    // payment recorded", and it was, the same day the rail shipped. First sale tx
    // YNNA54CXZGWBGL5ILYBV4K5RI26KTALIGWGXX6MJOORDAEEUPCWQ (round 64547231): 0.001 USDC
    // for verify_agent, the buyer signing a fee-zero transfer, the GoPlausible
    // facilitator broadcasting the pooled-fee group, and the sale counted only after our
    // own indexer read of the transfer. Both sides of that payment are ours, and the
    // provenance entry says so; live has never meant no caveats.
    status: 'live',
    evmChainId: null,
    // Circle's CCTP supported-domains table has no Algorand entry (checked 2026-08-30):
    // USDC here is Circle-issued natively but moves in and out via Circle Mint and
    // exchanges, not CCTP. Any unified-balance story must exclude this chain.
    cctpDomain: null,
    nativeCurrency: { name: 'Algo', symbol: 'ALGO', decimals: 6 },
    usdcDecimals: 6,
    rpcUrls: ['https://mainnet-api.4160.nodely.dev'],
    explorer: 'https://allo.info',
    contracts: {
      // No `usdc` here on purpose, for the Stellar reason in a new costume: on Algorand
      // USDC is an ASA addressed by a uint64 id, not a contract address, and every
      // consumer of `contracts.usdc` is an EVM path that would read it as 0x hex. The
      // ASA id lives in settlementTokens[].address as a decimal string instead.
      //
      // The AgentSpendPolicy vault, deployed 2026-08-30 as the policy's THIRD
      // implementation (Solidity, Rust/Soroban, now Algorand Python). Application id
      // 3688854723, account PWYYPJP52LI2SC6FGB7NTWBR2STDS5NUVJBSAIEYNC2TRCHAWGGZ4FVXZ4,
      // approval sha256 665c8f7e...; source and TEAL committed under
      // algorand/contracts/agent-spend-policy/, evidence in the provenance entry.
      // Recorded by app ID because that is how the AVM addresses an application.
      spendVault: '3688854723',
    },
    confirmations: 1, // a transaction included in a block is final; no reorgs by design
    stablecoins: ['USDC'],
    settlementTokens: [
      {
        symbol: 'USDC',
        address: '31566704',
        decimals: 6,
        authorization: 'algorand-group',
        // No domainVersionCandidates: like soroban-auth, the authorization is the
        // chain's, not the token's - a fee-zero signed transfer inside a pooled-fee
        // atomic group - so there is no per-token signing domain to prove.
        verified:
          'Read live 2026-08-30 from the public indexer (/v2/assets/31566704): name USDC, ' +
          'unit-name USDC, decimals 6, creator 2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM, ' +
          'and cross-checked against Circle\'s own USDC-on-Algorand page documenting ASA 31566704. ' +
          'Kept OUT of contracts.usdc because an ASA id is a uint64, not an address, and every ' +
          'consumer of that slot expects 0x hex.',
      },
    ],
    signerEnvVar: 'ALGORAND_MAINNET_SIGNER_MNEMONIC',
    rpcEnvVar: 'ALGORAND_MAINNET_RPC_URL',
    identity: {
      standard: 'did:algo',
      erc8004Native: false,
      note:
        'No ERC-8004 registry was found on Algorand as of 2026-08-30, and no ARC defines an ' +
        'agent identity registry; the Foundation maintains the did:algo DID method and the ' +
        'ecosystem identity work (GoPlausible DIDs, NFDomains) targets people and services, ' +
        'not agent registration. An agent\'s passport is therefore bridged from an EVM chain ' +
        'rather than anchored here, KYA included, and this note changes only when a registry ' +
        'we can verify exists.',
    },
    payment: {
      x402: true,
      note:
        'x402 v2 "exact" scheme in USDC. The buyer signs an ASA transfer with fee ZERO and a ' +
        'fee-paying transaction joins it in one atomic group, so the buyer needs no ALGO for ' +
        'fees. The exact claim ends there: receiving USDC at all requires the account to be ' +
        'opted in to the ASA (0.1 ALGO minimum-balance step), which is Algorand\'s trustline ' +
        'equivalent and no rail can remove it. Settlement runs through the GoPlausible ' +
        'facilitator (the Foundation-backed rail this ecosystem standardized on), and no ' +
        'payment counts as settled until we have read the transfer back from the indexer ' +
        'ourselves.',
    },
  },
  {
    caip2: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe',
    id: 'algorand-testnet',
    name: 'Algorand Testnet',
    shortName: 'Algorand test',
    color: '#8C929C',
    role: 'Algorand rehearsal rail: the same x402 code path as mainnet, in test money.',
    ecosystem: 'algorand',
    testnet: true,
    status: 'beta',
    evmChainId: null,
    cctpDomain: null,
    nativeCurrency: { name: 'Algo', symbol: 'ALGO', decimals: 6 },
    usdcDecimals: 6,
    rpcUrls: ['https://testnet-api.4160.nodely.dev'],
    explorer: 'https://lora.algokit.io/testnet',
    faucet: 'https://lora.algokit.io/testnet/fund',
    contracts: {},
    confirmations: 1,
    stablecoins: ['USDC'],
    settlementTokens: [
      {
        symbol: 'USDC',
        address: '10458941',
        decimals: 6,
        authorization: 'algorand-group',
        verified:
          'Read live 2026-08-30 from the public testnet indexer (/v2/assets/10458941): name ' +
          'USDC, unit-name USDC, decimals 6, creator VETIGP3I6RCUVLVYNDW5UA2OJMXB5WP6L6HJ3RWO2R37GP4AVETICXC55I, ' +
          'matching the testnet ASA Circle documents for its faucet. Same rule as mainnet: an ' +
          'ASA id is a uint64, so it stays out of contracts.usdc.',
      },
    ],
    signerEnvVar: 'ALGORAND_TESTNET_SIGNER_MNEMONIC',
    rpcEnvVar: 'ALGORAND_TESTNET_RPC_URL',
    identity: {
      standard: 'did:algo',
      erc8004Native: false,
      note:
        'Same as mainnet: no agent registry found here, no KYA anchoring, passport bridged ' +
        'from an EVM chain. Testnet exists for the payment rail rehearsal, not identity.',
    },
    payment: {
      x402: true,
      note: 'Where the Algorand x402 path is rehearsed before mainnet sees it, against the facilitator\'s own testnet network.',
    },
  },
  {
    caip2: 'eip155:196',
    id: 'xlayer',
    name: 'OKX X Layer',
    shortName: 'X Layer',
    // OKX's brand is black/white, which is unreadable as chip text in one of the two
    // themes, so this is a neutral mid-grey rather than a brand claim.
    color: '#8A8F98',
    role: 'OKX.AI marketplace rail: identity reads live from OKX ERC-8004; x402 trust tools settle here.',
    ecosystem: 'evm',
    testnet: false,
    status: 'live',
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
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 5,
    stablecoins: ['USDC', 'USDT'],
    signerEnvVar: 'XLAYER_SIGNER_KEY',
    rpcEnvVar: 'XLAYER_RPC_URL',
    identity: { standard: 'ERC-8004', erc8004Native: true, note: 'OKX.AI identity registry LIVE (read-side wired); payment rails still planned.' },
    payment: { x402: true, note: 'x402 over USDC once the USDC address is confirmed.' },
  },
  {
    caip2: 'eip155:8453',
    id: 'base',
    name: 'Base',
    shortName: 'Base',
    color: '#0052FF',
    role: 'Coinbase-ecosystem EVM rail: canonical ERC-8004 registries live, our agent #73232, and x402 settling in native Circle USDC through our own EIP-3009 facilitator.',
    ecosystem: 'evm',
    testnet: false,
    status: 'live',
    evmChainId: 8453,
    cctpDomain: 6,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    usdcDecimals: 6,
    // publicnode second: the default host rate-limited a handful of read-only calls
    // during the 2026-08-28 verification pass, and the fallback transport is built
    // over the whole list.
    rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org',
    contracts: {
      // The canonical ERC-8004 pair, deployed by the ERC-8004 authors as EIP-1967
      // proxies. Verified 2026-08-28 the hard way this chain demands (see the identity
      // note's trap): each proxy's implementation SLOT was read on Base and on Arbitrum
      // One, both point at the same implementation addresses (0x7274e874...9c02 for
      // identity, 0x16e0fa7f...da34 for reputation), and the implementation code is
      // byte-identical on both chains (14474 and 10491 bytes, matching hashes).
      // Registration here is permissionless; we deployed none of it.
      identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // native Circle USDC on Base
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 3,
    stablecoins: ['USDC', 'USDT', 'PYUSD'],
    settlementTokens: [
      {
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        authorization: 'eip3009',
        domainVersionCandidates: ['2'],
        settlementFeeUsd: 0.005,
        feeBasis:
          'A real settlement measured 102828 gas at an effective 0.006 gwei on 2026-08-28 (tx 0xb59ae67c, block 50540810), costing 0.000000617 ETH L2 plus a 0.00000000094 ETH L1 data fee, roughly $0.0025. The fee is 2x that, the same headroom logic as Arbitrum One: Base\'s base fee sits near a floor rather than moving, so buying more headroom against it buys nothing. It stops covering cost if ETH roughly doubles AND gas doubles, at which point we re-measure and edit this line.',
        verified:
          'Native Circle USDC on Base mainnet, the same address the descriptor already carried for contracts.usdc. Read live 2026-08-28: name() "USD Coin", symbol() "USDC", version() "2", decimals() 6, DOMAIN_SEPARATOR 0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f, which those four fields reproduce exactly. EIP-3009 confirmed by a read-only authorizationState call. Canonical Circle USDC, so it legitimately shares the contracts.usdc slot.',
      },
    ],
    signerEnvVar: 'BASE_SIGNER_KEY',
    rpcEnvVar: 'BASE_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      note:
        'Canonical ERC-8004 identity + reputation registries are live here, deployed by ' +
        'their authors; agent #73232 is ours (minted 2026-08-28, tx 0xb428bf8e, and ' +
        'ownerOf/tokenURI read back live). TRAP BEFORE PASTING ADDRESSES: Arc\'s three registry ' +
        'addresses all have code on Base mainnet, 130 bytes each, which is minimal-proxy ' +
        'sized and delegates to a NON-canonical implementation. Same address, different ' +
        'contract. An eth_getCode check therefore answers yes here and means nothing; the ' +
        'canonical pair above was verified by reading each proxy\'s EIP-1967 implementation ' +
        'slot and matching the implementation code byte for byte against Arbitrum One ' +
        '(2026-08-28), not by observing that something is deployed.',
    },
    payment: {
      x402: true,
      note:
        'x402 settling in native Circle USDC through our own first-party EIP-3009 ' +
        'facilitator: the buyer signs, we broadcast and pay the gas. The signing domain is ' +
        'proven against the live DOMAIN_SEPARATOR, and the first settlement landed ' +
        '2026-08-28 (tx 0xb59ae67c) with the receipt carrying the matching Transfer log.',
    },
  },
  {
    caip2: 'eip155:43114',
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    shortName: 'Avalanche',
    color: '#E84142',
    role: 'Fast-finality EVM: native Circle USDC, low latency for burst settlement.',
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
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 1, // Avalanche has fast finality
    stablecoins: ['USDC', 'USDT'],
    signerEnvVar: 'AVAX_SIGNER_KEY',
    rpcEnvVar: 'AVAX_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      // Verified 2026-08-13 with eth_getCode on three independent RPCs: the canonical
      // identity and reputation registries ARE already live here, deployed by the ERC-8004
      // authors. What is missing is ours, not theirs, so the note says which.
      note: 'Canonical ERC-8004 identity + reputation registries are live here; we hold no agent on them yet and no rail of ours is wired.',
    },
    payment: { x402: true, note: 'x402 over USDC on Avalanche.' },
  },
  {
    caip2: 'eip155:42161',
    id: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    color: '#28A0F0',
    role: 'DeFi gateway: large protocol ecosystem, our ERC-8004 agent #1259, and x402 settling in native Circle USDC through our own EIP-3009 facilitator.',
    ecosystem: 'evm',
    testnet: false,
    // LIVE since 2026-08-13, and it cleared the same bar as the others rather than a
    // softer one: agent #1259 is minted here AND money moves here (first settlement
    // 0x69abb8a9, block 494160024, a real USDC transfer proven by its receipt). It was
    // beta for a few hours in between, when identity was real and no rail settled yet.
    status: 'live',
    evmChainId: 42161,
    cctpDomain: 3,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    contracts: {
      // The canonical ERC-8004 pair, verified live 2026-08-13 with eth_getCode on three
      // independent RPCs plus a real read (name() "AgentIdentity", symbol() "AGENT",
      // getClients(1) empty). Same addresses as X Layer, Celo and Robinhood Chain: the
      // deterministic deployment is the whole point, so one agent id means one thing.
      // We deployed none of it; registration here is permissionless.
      identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // native Circle USDC on Arbitrum One
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 3,
    stablecoins: ['USDC', 'USDT'],
    settlementTokens: [
      {
        symbol: 'USDC',
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
        authorization: 'eip3009',
        domainVersionCandidates: ['2'],
        settlementFeeUsd: 0.005,
        feeBasis:
          'A real settlement measured 103569 gas at an effective 0.02 gwei on 2026-08-13 (tx 0x69abb8a9), costing 0.00000207 ETH, roughly $0.004. The fee is 1.28x that, and the headroom is deliberately thinner than Robinhood Chain\'s because this chain\'s base fee has sat at its 0.02 gwei floor rather than moving: buying 2x headroom against a pinned floor buys nothing. It stops covering cost if ETH roughly doubles or gas passes about 133000, at which point we re-measure and edit this line.',
        verified:
          'Native Circle USDC on Arbitrum One, the same address the descriptor already carried for contracts.usdc. Read live 2026-08-13: name() "USD Coin", symbol() "USDC", version() "2", decimals() 6, DOMAIN_SEPARATOR 0x08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78, which those four fields reproduce exactly. EIP-3009 confirmed by a read-only authorizationState call. Unlike Robinhood Chain this IS canonical Circle USDC, so it is the one settlement token that legitimately shares the contracts.usdc slot.',
      },
    ],
    signerEnvVar: 'ARB_SIGNER_KEY',
    rpcEnvVar: 'ARB_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      // Verified 2026-08-13 with eth_getCode on three independent RPCs: the canonical
      // identity and reputation registries ARE already live here, deployed by the ERC-8004
      // authors. What is missing is ours, not theirs, so the note says which.
      note: 'Canonical ERC-8004 identity + reputation registries are live here (deployed by their authors, not by us); agent #1259 is ours. No ValidationRegistry in this family, so KYA cannot be anchored here.',
    },
    payment: {
      x402: true,
      note: 'x402 settling in native Circle USDC through our own first-party EIP-3009 facilitator: the buyer signs, we broadcast and pay the gas. The fee is lower here than on Robinhood Chain because the gas measurably is.',
    },
  },
  {
    caip2: 'eip155:46630',
    id: 'rhchain-testnet',
    name: 'Robinhood Chain Testnet',
    shortName: 'RH Chain test',
    // Robinhood's brand green is #00C805, which is too light to read as chip text on its own
    // tint in a light theme. This is a darkened variant of it, not a different brand.
    color: '#0F9D30',
    role: 'Robinhood Chain rehearsal rail: the canonical ERC-8004 registry set is live here; mainnet waits on a human-funded signer.',
    ecosystem: 'evm',
    testnet: true,
    status: 'beta',
    evmChainId: 46630,
    // Not documented for this chain. Verify with Circle before wiring any CCTP path.
    cctpDomain: null,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    faucet: 'https://faucets.chain.link/robinhood-testnet',
    contracts: {
      // The canonical ERC-8004 set, SAME addresses as Arc/Celo Sepolia. Identity and
      // reputation (proxies + impls) were already on this chain; the missing
      // ValidationRegistry implementation was deployed 2026-08-11 by replaying the
      // canonical Safe-Singleton-Factory calldata (mcp/scripts/rh-testnet-deploy-8004.mjs).
      // Verified with eth_getCode plus REAL reads on each proxy: name()/symbol()
      // answered AgentIdentity/AGENT, getClients(1) and getAgentValidations(1)
      // returned clean empties. Still NO usdc on purpose: no canonical stablecoin is
      // documented for Robinhood Chain, and inventing one would poison a payment path.
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 3, // same Orbit stack as Arbitrum, so the same soft-finality assumption
    stablecoins: ['USDC.e'],
    settlementTokens: [
      {
        symbol: 'USDC.e',
        address: '0x71c6e1c209A4e3d4bd9911B2d53c98023A56C32F',
        decimals: 6,
        authorization: 'eip3009',
        domainVersionCandidates: ['2'],
        verified:
          'The canonical-bridge representation of Circle\'s Ethereum Sepolia USDC, derived live from this chain\'s own L2 gateway router (calculateL2TokenAddress) rather than typed in. Read live 2026-08-12: a Circle FiatTokenV2 reporting name() "USDC", symbol() "USDC.e", version() "2", decimals() 6, DOMAIN_SEPARATOR 0x192d8b03ad93f320f0da829eee0e1caf8b61842c2a226fe9977c0f209e09f712, which the four fields reproduce exactly. Kept OUT of contracts.usdc because it is a bridged twin, not canonical Circle USDC, and that slot is what every generic USDC path reads.',
      },
    ],
    signerEnvVar: 'RHCHAIN_TESTNET_SIGNER_KEY',
    rpcEnvVar: 'RHCHAIN_TESTNET_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      note: 'Identity + Reputation + Validation registries LIVE at the canonical cross-chain addresses.',
    },
    payment: {
      x402: true,
      note: 'Rehearsal of the mainnet USDG rail on the same EIP-3009 code path, settling in bridged USDC.e. No canonical USDC exists here, so contracts.usdc stays empty.',
    },
  },
  {
    caip2: 'eip155:4663',
    id: 'rhchain',
    name: 'Robinhood Chain',
    shortName: 'RH Chain',
    color: '#0F9D30',
    role: 'Robinhood\'s own L2 for tokenized real-world assets: canonical ERC-8004 identity + reputation live, agent #0 minted, and paid trust calls settling in USDG through our own first-party x402 facilitator.',
    ecosystem: 'evm',
    // LIVE since 2026-08-13: identity is minted here AND money moves here. Four real
    // settlements, one per sellable tool, each proven by a receipt plus a matching USDG
    // Transfer log (first: 0xbb41c7aa..., block 35439881). The buyer paid no gas; we
    // broadcast. That is the same bar X Layer and Celo had to clear.
    status: 'live',
    testnet: false,
    evmChainId: 4663,
    cctpDomain: null,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    usdcDecimals: 6,
    // The documented public endpoint. Robinhood describes it as rate limited and meant for
    // wallet connectivity and quick tests, so production traffic needs the env override
    // (an Alchemy or QuickNode key).
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    explorer: 'https://robinhoodchain.blockscout.com',
    contracts: {
      // The canonical MAINNET ERC-8004 family, the same addresses as X Layer (identity)
      // and Celo (identity + reputation). Nobody had to deploy these for us: verified
      // live 2026-08-12 with eth_getCode (both are ERC1967 proxies) plus a REAL read on
      // each - name()/symbol() answered AgentIdentity/AGENT, getClients(1) returned a
      // clean empty. No ValidationRegistry exists in this mainnet family (mirroring
      // Celo/X Layer), so none is asserted and KYA cannot be anchored on-chain here.
      // Still NO usdc on purpose: no canonical stablecoin is documented for this chain.
      identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 3,
    stablecoins: ['USDG'],
    settlementTokens: [
      {
        symbol: 'USDG',
        address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        decimals: 6,
        authorization: 'eip3009',
        // USDG exposes neither version() nor eip712Domain() (both revert), so the domain
        // version cannot be read from the chain. '1' is the candidate that reproduces the
        // live DOMAIN_SEPARATOR; it is proven at runtime, never trusted from here.
        domainVersionCandidates: ['1'],
        settlementFeeUsd: 0.02,
        feeBasis:
          'A real settlement measured 102495 gas at an effective 0.044746 gwei on 2026-08-13 (tx 0xbb41c7aa), costing 0.0000046 ETH, roughly $0.009. The fee carries headroom for gas and ETH price moves; we have no price feed we verify and will not invent one.',
        verified:
          'Paxos Global Dollar at the address Paxos documents for chain 4663 (docs.paxos.com/guides/stablecoin/usdg/mainnet); Robinhood is a Global Dollar Network founding member and uses USDG in its Earn product. Read live 2026-08-12: name() "Global Dollar", decimals() 6, supply ~353M, DOMAIN_SEPARATOR 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036. EIP-3009 confirmed by selector probe: transferWithAuthorization (0xe3ee160e) reverts with a signature-validation error while an unknown selector reverts 0x800ab12c. EIP-2612 permit is present too. NOT placed in contracts.usdc: it is not Circle USDC, and that slot is what every generic USDC path reads.',
      },
    ],
    signerEnvVar: 'RHCHAIN_SIGNER_KEY',
    rpcEnvVar: 'RHCHAIN_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      note: 'Identity + Reputation registries LIVE (same canonical addresses as X Layer/Celo); agent #0, the registry\'s first mint, is ours (2026-08-12). No ValidationRegistry in the mainnet family yet.',
    },
    payment: {
      x402: true,
      note: 'x402 settling in USDG (Paxos Global Dollar) through our own first-party EIP-3009 facilitator: the buyer signs, we broadcast and pay the gas. We run it because no published facilitator serves this chain, not because nobody else relays here.',
    },
  },
  {
    caip2: 'eip155:42220',
    id: 'celo',
    name: 'Celo',
    shortName: 'Celo',
    color: '#FCFF52',
    role: 'Stablecoin-native EVM L2: ERC-8004 identity live, x402 USDC settlement via the first-party Celo facilitator, gas payable in stablecoins.',
    ecosystem: 'evm',
    testnet: false,
    status: 'live',
    evmChainId: 42220,
    cctpDomain: null, // Celo is not a CCTP domain; USDC arrives natively (Circle mint below)
    nativeCurrency: { name: 'Celo', symbol: 'CELO', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://forno.celo.org'],
    explorer: 'https://celoscan.io',
    contracts: {
      // ERC-8004 pair verified live 2026-08-09: eth_getCode on both (EIP-1967 proxies
      // sharing one implementation with the Celo Sepolia pair below) plus a REAL read on
      // each - ownerOf(1) resolved an owner on the IdentityRegistry, and
      // getClients(1)/getSummary(1, clients) returned real feedback (count 14, avg 88)
      // from the ReputationRegistry. The IdentityRegistry is the SAME CREATE2 address as
      // X Layer's entry above. There is NO ValidationRegistry on Celo (ERC-8004 spec
      // revision pending), so no address is asserted for it and KYA cannot be anchored
      // on-chain there - the identity note below says so instead of pretending.
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      usdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', // native Circle USDC on Celo (EIP-712 domain name "USDC", version "2" - read live)
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 3,
    // cUSD was rebranded USDm (same contract, 0x765DE816845861e75A25fCA122bb6898B8B1282a).
    stablecoins: ['USDC', 'USDT', 'USDm'],
    signerEnvVar: 'CELO_SIGNER_KEY',
    rpcEnvVar: 'CELO_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      note: 'Identity + Reputation registries LIVE (read-side wired). No ValidationRegistry on Celo yet, so KYA cannot be anchored on-chain there.',
    },
    payment: { x402: true, note: 'x402 over USDC via the first-party Celo facilitator (EIP-3009, buyer pays no gas); CIP-64 fee abstraction lets gas be paid in stablecoins.' },
  },
  {
    caip2: 'eip155:11142220',
    id: 'celo-sepolia',
    name: 'Celo Sepolia (Testnet)',
    shortName: 'Celo Sepolia',
    color: '#FCFF52',
    role: 'Celo testnet rail (Alfajores is deprecated): same ERC-8004 registry pair as Arc, x402 USDC via the Sepolia facilitator.',
    ecosystem: 'evm',
    testnet: true,
    status: 'beta',
    evmChainId: 11142220,
    cctpDomain: null,
    nativeCurrency: { name: 'Celo', symbol: 'CELO', decimals: 18 },
    usdcDecimals: 6,
    rpcUrls: ['https://forno.celo-sepolia.celo-testnet.org'],
    explorer: 'https://celo-sepolia.blockscout.com',
    faucet: 'https://faucet.celo.org/celo-sepolia',
    contracts: {
      // Verified live 2026-08-09 with eth_getCode on every address here: the ERC-8004
      // pair (the same identity/reputation ADDRESSES as the Arc descriptor, resolving to
      // the same EIP-1967 implementations as Celo mainnet's pair), testnet USDC, and the
      // CREATE2 factory. No ValidationRegistry, mirroring mainnet.
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      usdc: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
      create2Factory: CREATE2_FACTORY,
    },
    confirmations: 3,
    stablecoins: ['USDC'],
    signerEnvVar: 'CELO_SEPOLIA_SIGNER_KEY',
    rpcEnvVar: 'CELO_SEPOLIA_RPC_URL',
    identity: {
      standard: 'ERC-8004',
      erc8004Native: true,
      note: 'Identity + Reputation registries LIVE (same addresses as Arc). No ValidationRegistry, mirroring mainnet.',
    },
    payment: { x402: true, note: 'x402 over testnet USDC via the Celo Sepolia facilitator (api.x402.sepolia.celo.org).' },
  },
]

// ── lookups (derive everything from the registry) ────────────────────────────────

/**
 * Every chain id, in registry order. The ONE list a schema, union or enum may enumerate.
 *
 * It exists because three of them had already drifted: `resolve_agent`'s zod enum offered
 * a chain that is not in the registry and rejected six that are, and `data.ts`'s
 * `ChainName` union did the same. Anything that needs "the set of chains" imports this,
 * and `chains/surface-truth.test.ts` fails the build if a copy reappears.
 *
 * Flipping a chain's STATUS is deliberately not automated: it should touch this file and
 * exactly two test expectation lists (registry.test.ts and frontend-sync.test.ts), so a
 * human confirms the promotion. Any THIRD file that needs editing is restating the
 * registry and belongs behind one of the drift tests instead.
 */
export const CHAIN_IDS = CHAINS.map((c) => c.id) as [string, ...string[]]

/**
 * Chains that carry a known ERC-8004 IdentityRegistry, i.e. the ones identity reads
 * actually dial. Extracted from the inline filter that used to live in erc8004.ts so a
 * test can assert the provider covers exactly this set instead of trusting a comment.
 */
export function identityChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'evm' && c.evmChainId !== null && c.contracts.identityRegistry)
}

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

// Fail fast at import time if a descriptor is malformed - cheaper to catch here than
// at request time. (Pure validation, no I/O.)
for (const c of CHAINS) {
  if (!isValidCaip2(c.caip2)) throw new Error(`Invalid CAIP-2 in registry: ${c.caip2}`)
  if (c.ecosystem === 'evm' && evmChainIdFromCaip2(c.caip2) !== c.evmChainId) {
    throw new Error(`CAIP-2 / evmChainId mismatch for ${c.id}: ${c.caip2} vs ${c.evmChainId}`)
  }
}
