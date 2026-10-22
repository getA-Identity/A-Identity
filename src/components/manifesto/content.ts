/**
 * The manifesto's copy, kept apart from the components that lay it out so the same words
 * reach the diagram, the phone list and the table without drifting between them.
 *
 * Two rules shaped the landscape rows. Every cell states only what was read from the
 * source it cites, on the date given in SOURCES; a cell that says "not stated" means the
 * source we read does not say, which is different from the approach having no answer. And
 * the section is a map of approaches, not a scoreboard: no row carries a number about
 * anyone's revenue or share, including ours.
 */

export const REVISED = '2026-10-22'

export type Pillar = {
  n: string
  title: string
  question: string
  /** The product noun the pillar becomes. */
  mechanism: string
  /** One sentence for the stacked list on phones. */
  line: string
}

export const PILLARS: readonly Pillar[] = [
  {
    n: '01',
    title: 'Identity',
    question: 'Who is the agent?',
    mechanism: 'Passport',
    line: 'A verifiable passport, read live from a registry, not a name typed into a form.',
  },
  {
    n: '02',
    title: 'Authority',
    question: 'On whose behalf?',
    mechanism: 'Mandate',
    line: 'A human sets the mandate. The agent inherits it and cannot widen it.',
  },
  {
    n: '03',
    title: 'Boundaries',
    question: 'What may it do?',
    mechanism: 'Policy',
    line: 'Caps, an allowlist and a freeze switch, enforced where the money sits.',
  },
  {
    n: '04',
    title: 'Accountability',
    question: 'What survives?',
    mechanism: 'Receipt',
    line: 'A receipt and a provenance record, so responsibility outlives the moment.',
  },
]

export const GATE = {
  label: 'The gate',
  allow: 'ALLOW continues to settlement.',
  warn: 'WARN waits for a human to approve.',
  deny: 'DENY signs nothing, and says why.',
  loop: 'Receipts feed the trust graph. The next check reads them.',
} as const

export type Principle = { n: string; law: string; why: string; product: string }

export const PRINCIPLES: readonly Principle[] = [
  {
    n: '01',
    law: 'Identity must be verifiable.',
    why: 'A claim of identity that nobody can check is a costume, and software wears costumes well.',
    product:
      'An ERC-8004 passport read live from the registry, plus KYA, which proves the agent controls the wallet it pays from.',
  },
  {
    n: '02',
    law: 'Authority must be explicit.',
    why: 'Acting for someone is a mandate, not an assumption. A mandate can be read, and read back.',
    product:
      'The vault separates an owner role from an operator role. The owner sets and signs the policy; the operator key may only pay inside it, and a payment past the caps reverts on-chain. Only the owner can pay past them, and the receipt says so.',
  },
  {
    n: '03',
    law: 'Permission must have boundaries.',
    why: 'Open-ended permission is a key left in the door. A boundary is what makes delegation safe to give.',
    product:
      'Daily caps, an auto-approve line, payee allowlists and freeze, enforced in the server pre-check, the on-chain vault and the Circle wallet screening.',
  },
  {
    n: '04',
    law: 'Humans must retain meaningful control.',
    why: 'Autonomy is delegated. What is delegated can be paused, narrowed or taken back, by a person, at any time.',
    product:
      'The owner freezes, overrides, withdraws and resets limits. On Stellar pubnet the console prepares those calls for the owner to sign from their own wallet, so the server never holds that key; the EVM mainnet vaults are still owned by our operating wallet, and the proof pages say so.',
  },
  {
    n: '05',
    law: 'Actions must be attributable.',
    why: 'Every action should answer three questions afterwards: who did it, for whom, and under which mandate.',
    product:
      'Each settlement is a transaction hash with a payer and a payee. The provenance ledger labels our own payers internal, so a demo never reads as demand.',
  },
  {
    n: '06',
    law: 'Trust must be contextual.',
    why: 'The same agent deserves a different answer for a cent than for a thousand dollars, and for a stranger than for a known payee.',
    product:
      'The pre-action check answers ALLOW, WARN or DENY against the amount, the payee and the policy, with the reasons attached.',
  },
  {
    n: '07',
    law: 'Autonomy must not remove accountability.',
    why: 'Speed is not an excuse. The record has to be as fast as the act, or the act should wait.',
    product:
      'Nothing is marked settled without a receipt carrying a matching transfer log. A payment we cannot prove is reported unproven.',
  },
  {
    n: '08',
    law: 'Trust should be portable.',
    why: 'A reputation locked inside one platform is a hostage, not an asset. It should travel with the agent.',
    product:
      'A deterministic 0 to 1000 score computed from on-chain settlements, validation and tenure. Same inputs, same number, for anyone who recomputes it.',
  },
  {
    n: '09',
    law: 'Infrastructure should remain interoperable.',
    why: 'No single vendor should own the right to act. Standards outlive products, and so should the standing of an agent.',
    product:
      'ERC-8004 for identity, x402 for payment, MCP for connection. A chain joins by declaring one registry entry, not by a rewrite.',
  },
  {
    n: '10',
    law: 'Complexity should remain invisible.',
    why: 'The safeguards should cost the user one decision, not a course. Safety that is hard to use gets switched off.',
    product: 'One rule for a buyer: verify first, then pay. One pre-check call returns the verdict and the reasons.',
  },
]

export type Mechanism = { principle: string; mechanism: string; gloss: string; standard: string }

export const MECHANISMS: readonly Mechanism[] = [
  {
    principle: 'Identity',
    mechanism: 'Passport',
    gloss: 'the ERC-8004 identity plus KYA',
    standard:
      'The ERC-8004 Identity registry, read live on every EVM chain in our registry that carries one, and the Validation registry only where we have wired it, two testnets today; elsewhere a KYA result is verified off-chain and recorded, not anchored. KYA is a revocable wallet-control attestation, not an audit of behavior.',
  },
  {
    principle: 'Authority',
    mechanism: 'Mandate',
    gloss: 'the spend policy a human sets',
    standard:
      'The AgentSpendPolicy vault, Solidity on EVM chains and Soroban on Stellar. Owner and operator are separate roles: an operator payment past the caps reverts on-chain, only the owner can pay past them, and the receipt records which key paid.',
  },
  {
    principle: 'Decision',
    mechanism: 'Gateway',
    gloss: 'the pre-action check',
    standard:
      'pre_action_check over MCP answers ALLOW, WARN or DENY with reasons. The same verdict is sold per call over x402 as a paid trust check.',
  },
  {
    principle: 'Evidence',
    mechanism: 'Receipt',
    gloss: 'settlement records and the provenance ledger',
    standard:
      'A settlement counts only when its receipt carries the matching transfer log. The ledger behind the proof pages lists every artifact per rail, with explorer links derived rather than typed.',
  },
  {
    principle: 'Network trust',
    mechanism: 'Trust graph',
    gloss: 'the deterministic 0 to 1000 reputation',
    standard:
      'A pure function of settlements, validation, tenure, behavior and discipline, with a 90-day half-life on volume. Published in full, so anyone can recompute it.',
  },
]

export type LandscapeRow = {
  name: string
  who: string
  identity: string
  limits: string
  access: string
  status: string
  /** Indices into SOURCES, one-based, shown as footnote marks. */
  refs: readonly number[]
  ours?: boolean
}

export type LandscapeGroup = { label: string; rows: readonly LandscapeRow[] }

export const LANDSCAPE: readonly LandscapeGroup[] = [
  {
    label: 'Card networks',
    rows: [
      {
        name: 'Visa Trusted Agent Protocol',
        who: 'Visa, developed with Cloudflare; part of Visa Intelligent Commerce.',
        identity:
          'Signed HTTP requests: RFC 9421 HTTP Message Signatures, aligned with Web Bot Auth, verified by the merchant against the public key of a Visa-approved agent.',
        limits: 'Not stated in the protocol pages we read.',
        access:
          'Specification and samples public on GitHub; agents are Visa-approved, and the initial specifications apply to the Visa network.',
        status:
          'Announced 2025-10-14. Live transactions with participating European merchants reported 2026-07-02.',
        refs: [1, 2, 3],
      },
      {
        name: 'Mastercard Agent Pay',
        who: 'Mastercard.',
        identity: 'Card credential: Agentic Tokens, built on card tokenization.',
        limits: 'A controls layer inside the Agent Pay Trust Framework, beside identity, intent, execution and intelligence.',
        access: 'Network program with named launch partners; the program requires agents to be registered and verified.',
        status:
          'Announced 2025-04-29. The intelligence layer of the framework followed on 2026-09-30, starting with a probability score that a transaction was agent-initiated, in US testing.',
        refs: [4, 5],
      },
    ],
  },
  {
    label: 'Platform protocols',
    rows: [
      {
        name: 'Agent Payments Protocol (AP2)',
        who: 'Google, donated to the FIDO Alliance.',
        identity:
          'Signed verifiable digital credentials called mandates, chained into an audit trail. Checkout and Payment mandates, each with an open and a closed stage.',
        limits: 'Budget constraints in the open Payment Mandate.',
        access: 'Open, Apache 2.0 on GitHub.',
        status: 'v0.2 released on GitHub and the protocol donated to the FIDO Alliance, both announced 2026-04-28.',
        refs: [6, 7],
      },
      {
        name: 'Agentic Commerce Protocol (ACP)',
        who: 'Stripe and OpenAI.',
        identity:
          'Platform account plus a Shared Payment Token that Stripe issues after the buyer pays; the agent never handles the card credential.',
        limits: 'The scope of the token: one merchant, one cart total.',
        access: 'Open standard, Apache 2.0.',
        status: 'Launched 2025-09-29 with Instant Checkout in ChatGPT for US Etsy sellers.',
        refs: [8, 9],
      },
      {
        name: 'Verifiable Intent',
        who: 'Mastercard and Google.',
        identity: 'A tamper-resistant record of what the user authorized, compatible with AP2.',
        limits: 'Records the authorization; the limit lives in the protocol it rides on.',
        access: 'Being donated to the FIDO Alliance alongside AP2.',
        status:
          'Named in the AP2 donation post of 2026-04-28, and by Mastercard in the Ant International, Mastercard and Visa Know-Your-Agent interoperability release of 2026-09-10.',
        refs: [6, 10],
      },
    ],
  },
  {
    label: 'Open rails',
    rows: [
      {
        name: 'x402',
        who: 'Incubated at Coinbase; now the x402 Foundation under the Linux Foundation, whose premier members include AWS, American Express, Cloudflare, Coinbase, Google, Mastercard, Shopify, the Solana Foundation, Stripe and Visa.',
        identity: 'A wallet signature on a payment authorization that answers an HTTP 402.',
        limits: 'None in the protocol beyond the amount signed for one call.',
        access: 'Open, vendor-neutral governance; forty member organizations at launch.',
        status: 'Foundation launched 2026-04-02.',
        refs: [11],
      },
      {
        name: 'Circle Gateway Nanopayments and Arc',
        who: 'Circle.',
        identity:
          'A wallet signature: the buyer signs an EIP-3009 authorization against a non-custodial Gateway deposit. Works with x402 and plain HTTP 402.',
        limits: 'The deposit of the buyer; payments execute only from user-signed authorizations.',
        access: 'Open to developers.',
        status: 'Nanopayments on mainnet since 2026-04-29 across 11 chains. Arc Mainnet opened 2026-09-16.',
        refs: [12, 13],
      },
      {
        name: 'Cloudflare Web Bot Auth and pay per crawl',
        who: 'Cloudflare.',
        identity:
          'Ed25519 keys published in a well-known directory; each request signed with HTTP Message Signatures and verified after registration with Cloudflare.',
        limits: 'The publisher sets one flat per-request price; Cloudflare is merchant of record.',
        access: 'Built on IETF individual drafts; verification requires Cloudflare registration.',
        status: 'Pay per crawl in private beta since 2025-07-01. Web Bot Auth documentation updated 2026-10-08.',
        refs: [14, 15],
      },
      {
        name: 'Stellar: x402 and MPP',
        who: 'Documented by Stellar; the MPP SDKs are maintained by Stripe and Tempo Labs.',
        identity:
          'The signer of a Soroban authorization entry (x402, through a facilitator) or an MPP credential bound to a challenge.',
        limits: 'A prepaid session deposit in MPP; the signed amount in x402.',
        access: 'Open.',
        status: 'Both documented on developers.stellar.org, read 2026-10-22.',
        refs: [16, 17],
      },
      {
        name: 'Algorand: x402 through the GoPlausible facilitator',
        who: 'GoPlausible. Announced on the Algorand Foundation blog, not operated by the Foundation.',
        identity: 'The signer of an atomic transaction group carrying a USDC transfer.',
        limits: 'None in the protocol; the facilitator sponsors fees.',
        access: 'Public and keyless.',
        status: 'Live on Algorand mainnet, 2026-07-24.',
        refs: [18],
      },
    ],
  },
  {
    label: 'Registries and credentials',
    rows: [
      {
        name: 'ERC-8004 Trustless Agents',
        who: 'An Ethereum ERC by De Rossi, Crapis, Ellis and Reppel; registries deployed per chain as singletons.',
        identity:
          'On-chain registry: an ERC-721 agent id resolving to a registration file, with reputation and validation registries beside it.',
        limits: 'None; it is an identity standard, not a payment one.',
        access: 'Open. The EIP is in Draft status.',
        status:
          'EIP created 2025-08-13, still Draft on 2026-10-22. The community index lists the registries on Ethereum mainnet and fifteen other mainnets; we read the canonical ones live on the EVM chains in our registry.',
        refs: [19, 20],
      },
      {
        name: 'KYA-OS',
        who: 'Donated by Vouched to the Decentralized Identity Foundation.',
        identity: 'Decentralized identifiers and verifiable credentials, with delegation as scoped, tamper-evident credentials.',
        limits: 'Scope inside the delegation credential.',
        access: 'Open, community governance under DIF.',
        status: 'Donated March 2026; task force and prototype stage as of 2026-04-22.',
        refs: [21],
      },
      {
        name: 'KYAPay Token',
        who: 'Skyfire Systems, as an individual IETF Internet-Draft.',
        identity:
          'JWT tokens naming the human principal, the agent platform and the agent, optionally bound to the key of the agent.',
        limits: 'An amount and a request cap carried inside the token.',
        access: 'Individual draft, not endorsed by the IETF.',
        status: 'draft-skyfire-oauth-kyapay-token-02, 2026-10-01.',
        refs: [22],
      },
    ],
  },
]

/** Our own row, built from the live chain counts so the numbers cannot go stale. */
export function ourRow(counts: { live: number; beta: number; planned: number }): LandscapeRow {
  return {
    name: 'A-Identity',
    who: 'A-Identity, open source. Composes ERC-8004, x402 and MCP rather than replacing them.',
    identity:
      'An ERC-8004 passport plus KYA, read live on-chain and scored into a deterministic 0 to 1000 reputation.',
    limits:
      'In an AgentSpendPolicy vault with separate owner and operator roles, which reverts an agent payment past the caps. A server pre-check and the Circle wallet screening sit around it.',
    access: 'Open. No key for reads, no sign-in for the explorer or the proof pages.',
    status: `${counts.live} chains live, ${counts.beta} in beta, ${counts.planned} planned, per the chain registry. Every mainnet payment so far is self-funded and labeled internal; an outside payer is labeled external the moment one arrives. On Stellar pubnet the vault owner signs from their own wallet; the EVM mainnet vaults are still owned by our operating wallet, as the proof pages say.`,
    refs: [],
    ours: true,
  }
}

export type Source = { org: string; title: string; date?: string; href: string }

/** Numbered in the order the rows cite them. Every entry was read on REVISED. */
export const SOURCES: readonly Source[] = [
  {
    org: 'Visa',
    title: 'Visa Introduces Trusted Agent Protocol: An Ecosystem-Led Framework for AI Commerce',
    date: '2025-10-14',
    href: 'https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21716.html',
  },
  {
    org: 'Visa',
    title: 'Visa and Banks Across Europe Reach the Next Phase of Agentic Commerce',
    date: '2026-07-02',
    href: 'https://www.visa.co.uk/about-visa/newsroom/press-releases.3457328.html',
  },
  {
    org: 'Visa Developer',
    title: 'Trusted Agent Protocol overview',
    href: 'https://developer.visa.com/capabilities/trusted-agent-protocol/overview',
  },
  {
    org: 'Mastercard Newsroom',
    title: 'Mastercard unveils Agent Pay, pioneering agentic payments technology to power commerce in the age of AI',
    date: '2025-04-29',
    href: 'https://newsroom.mastercard.com/news/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai',
  },
  {
    org: 'Mastercard Investor Relations',
    title: 'Mastercard Advances Agentic Commerce With New Trust and Intelligence Services',
    date: '2026-09-30',
    href: 'https://investor.mastercard.com/investor-news/investor-news-details/2026/Mastercard-Advances-Agentic-Commerce-With-New-Trust-and-Intelligence-Services/default.aspx',
  },
  {
    org: 'Google',
    title: 'We are donating Agent Payments Protocol to the FIDO Alliance',
    date: '2026-04-28',
    href: 'https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/',
  },
  {
    org: 'AP2 project',
    title: 'Agent Payments Protocol specification site',
    href: 'https://ap2-protocol.org/',
  },
  {
    org: 'Stripe',
    title: 'Stripe powers Instant Checkout in ChatGPT and releases Agentic Commerce Protocol',
    date: '2025-09-29',
    href: 'https://stripe.com/newsroom/news/stripe-openai-instant-checkout',
  },
  {
    org: 'Stripe and OpenAI',
    title: 'Agentic Commerce Protocol specification site',
    href: 'https://www.agenticcommerce.dev/',
  },
  {
    org: 'Ant International, Mastercard and Visa via Business Wire',
    title: 'Ant International, Mastercard and Visa Initiate Collaboration on Know-Your-Agent Interoperability to Scale Agentic Commerce',
    date: '2026-09-10',
    href: 'https://www.businesswirechina.com/en/news/63939.html',
  },
  {
    org: 'Coinbase Developer Platform',
    title: 'The x402 Foundation',
    href: 'https://docs.cdp.coinbase.com/x402/support/x402-foundation',
  },
  {
    org: 'Circle',
    title: 'Nanopayments powered by Circle Gateway Is Now Live on Mainnet',
    date: '2026-04-29',
    href: 'https://www.circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet',
  },
  {
    org: 'Circle',
    title: 'Circle Launches Arc Mainnet',
    date: '2026-09-16',
    href: 'https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet',
  },
  {
    org: 'Cloudflare',
    title: 'Introducing pay per crawl',
    date: '2025-07-01',
    href: 'https://blog.cloudflare.com/introducing-pay-per-crawl/',
  },
  {
    org: 'Cloudflare Docs',
    title: 'Web Bot Auth',
    date: 'updated 2026-10-08',
    href: 'https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/',
  },
  {
    org: 'Stellar Docs',
    title: 'Agentic Payments',
    href: 'https://developers.stellar.org/docs/build/agentic-payments',
  },
  {
    org: 'Machine Payments Protocol',
    title: 'MPP specification site',
    href: 'https://mpp.dev/',
  },
  {
    org: 'Algorand Foundation',
    title: 'Introducing the GoPlausible x402 Facilitator',
    date: '2026-07-24',
    href: 'https://algorand.co/blog/introducing-the-goplausible-x402-facilitator-payments-and-intelligence-for-agentic-commerce-on-algorand',
  },
  {
    org: 'Ethereum Improvement Proposals',
    title: 'ERC-8004: Trustless Agents',
    href: 'https://eips.ethereum.org/EIPS/eip-8004',
  },
  {
    org: 'Community index',
    title: 'awesome-erc8004, deployments list',
    href: 'https://github.com/sudeepb02/awesome-erc8004',
  },
  {
    org: 'Decentralized Identity Foundation',
    title: 'DIF and Vouched Advance Agentic Identity with KYA-OS',
    date: '2026-04-22',
    href: 'https://blog.identity.foundation/kya-os/',
  },
  {
    org: 'IETF Datatracker',
    title: 'KYAPay Token, draft-skyfire-oauth-kyapay-token-02',
    date: '2026-10-01',
    href: 'https://datatracker.ietf.org/doc/draft-skyfire-oauth-kyapay-token/',
  },
]

export type Refusal = { title: string; enforced: string }

export const REFUSALS: readonly Refusal[] = [
  {
    title: 'No autonomous key custody.',
    enforced:
      'Keys are user-held or gated behind a credential the operator sets; a missing credential is a labeled no-op, never a mock that looks real. Where a vault is owner-signed, Stellar pubnet today, the server never sees that key; where it is not, the ledger names the server wallet as owner.',
  },
  {
    title: 'No agent moves value beyond the caps a human set.',
    enforced:
      'The server pre-check refuses first. The vault reverts an agent payment past the caps whatever the server said, and the only key that can pay past them belongs to the owner, on the record. The Circle wallet screening is the third gate.',
  },
  {
    title: 'No claim of settlement without a receipt.',
    enforced:
      'A payment counts only once its receipt carries the matching transfer log. Until then it is reported as unproven, and nothing on the site calls it settled.',
  },
  {
    title: 'No number on the site that cannot be reproduced from a live read.',
    enforced:
      'Counters are read from the settlement logs on every request, our own payers are labeled internal, and a zero is published as a zero rather than dressed up.',
  },
]
