/**
 * Blog content. Plain data so the index and post pages stay simple and the copy
 * follows the same rules as the rest of the site (no AI-tell punctuation, Title
 * Case headings, sentence-case body, real stablecoins). Covers are generated
 * from each post's accent color (see BlogCover).
 */

export type BlogSection = { heading: string; body: string[] }

export type BlogAuthor = { name: string; role: string }

export type BlogPost = {
  slug: string
  title: string
  excerpt: string
  /** Topic label shown as a chip. */
  chain: string
  /** Cover and chip accent color, chosen for contrast and brand harmony. */
  accent: string
  date: string
  readingTime: string
  seed: number
  author: BlogAuthor
  sections: BlogSection[]
}

/** Team bylines; posts rotate between the two tracks. */
export const AUTHORS = {
  protocol: { name: 'A-Identity Team', role: 'Protocol Engineering' },
  devrel: { name: 'A-Identity Team', role: 'Developer Relations' },
} as const

export const POSTS: BlogPost[] = [
  {
    slug: 'agentic-economy-when-agents-get-wallets',
    title: 'The Agentic Economy: when agents get wallets',
    excerpt:
      'Jeremy Allaire and Circle describe an internet where AI agents hold wallets and transact in stablecoins. Before that economy can run, agents need a way to trust each other. That is the part we build.',
    chain: 'Agentic Economy',
    accent: '#7342E2',
    date: 'Jul 17, 2026',
    readingTime: '4 min read',
    seed: 8,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'When assistants get wallets',
        body: [
          'Circle CEO Jeremy Allaire has laid out the same future many of us now see coming: AI assistants stop being tools you type into and become economic actors. They hold their own stablecoin wallets, hire other agents, buy data and compute, and settle on-chain without a human clicking through every step.',
          'That is the agentic economy. It is not a metaphor once an agent can pay for a thing on its own, and stablecoins on fast chains are what make those payments real.',
        ],
      },
      {
        heading: 'The missing primitive is trust',
        body: [
          'Give an agent a wallet and it can pay. It still cannot answer the one question that has to come first: is the counterparty on the other side of this transaction who it claims to be, and is it safe to pay?',
          'Humans answer that with reputation, brands, and years of context. An agent transacting at machine speed has none of that. Without a trust layer, the agentic economy is a market of strangers moving money to strangers.',
        ],
      },
      {
        heading: 'A passport before a wallet',
        body: [
          'A-Identity is that trust layer. Before an agent-to-agent transaction, an agent calls us to verify the counterparty: an on-chain ERC-8004 identity, a deterministic reputation score from real settled activity, and a pre-transaction risk check that returns allow, warn, or deny.',
          'Identity and reputation are the picks and shovels of this economy. They are boring in the way plumbing is boring, and just as load-bearing.',
        ],
      },
      {
        heading: 'Live, not a whitepaper',
        body: [
          'This is running today. A-Identity is listed on OKX.AI as an agent service other agents call and pay per use, with x402 settling each call in stablecoins on X Layer, and real on-chain settlements you can verify.',
          'The agentic economy will be built on money that moves at machine speed. It will only be worth building if trust moves that fast too.',
        ],
      },
    ],
  },
  {
    slug: 'gas-in-usdc-why-arc',
    title: 'Gas in USDC: why agents settle on Arc',
    excerpt:
      'On most chains an agent needs a second, volatile token just to pay fees. Arc removes that. Here is why it matters for machine payments.',
    chain: 'Arc',
    accent: '#2775CA',
    date: 'Jun 16, 2026',
    readingTime: '4 min read',
    seed: 0,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The hidden tax of gas tokens',
        body: [
          'To send a dollar on a normal chain, an agent also needs a little of a second token for gas. It has to hold that token, price it, and refill it before it runs out.',
          'That is one more moving part that can break, at exactly the moment a payment needs to go through.',
        ],
      },
      {
        heading: 'Arc pays fees in USDC',
        body: [
          'Arc is an EVM chain where gas is paid in USDC, the same dollar the agent is already moving. No second token, no surprise volatility, no refill dance.',
          'For software that just wants to pay for a thing, this is the difference between simple and fragile.',
        ],
      },
      {
        heading: 'Sub-second and deterministic',
        body: [
          'Blocks settle in well under a second, with deterministic finality. The payment either happened or it did not, and the agent knows right away.',
          'For an agent making thousands of small calls, that certainty is the difference between fluid and stuck.',
        ],
      },
      {
        heading: 'What we use it for',
        body: [
          'Arc is our primary rail. It carries the unified balance through Circle App Kit and nanopayments down to a millionth of a dollar.',
          'Anything large still pauses for a human. Speed never means losing the tower.',
        ],
      },
    ],
  },
  {
    slug: 'unified-balance-one-usdc-every-chain',
    title: 'Unified balance: one USDC, every chain',
    excerpt:
      'Your agent\'s money should not be trapped on the chain it happened to land on. Circle App Kit gives it one spendable balance.',
    chain: 'Arc',
    accent: '#2775CA',
    date: 'Jun 12, 2026',
    readingTime: '4 min read',
    seed: 1,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'The fragmentation problem',
        body: [
          'Funds scatter. A hundred USDC sits on Base, thirty-five on Arbitrum, and none on the chain where the agent needs to pay right now.',
          'Bridging across is slow, easy to get wrong, and a bad place for an autonomous process to improvise.',
        ],
      },
      {
        heading: 'One balance, many chains',
        body: [
          'Circle Gateway pools USDC from several chains into a single balance. The agent sees one number and can spend it on any supported chain, in one step.',
          'No manual bridge, no waiting for a wrapped token to arrive.',
        ],
      },
      {
        heading: 'How it works in A-Identity',
        body: [
          'Deposit from any chain into the unified balance, then spend on Arc or Base instantly. We show the breakdown, so you always see where the money came from.',
          'It reads like a bank account that happens to span five networks.',
        ],
      },
      {
        heading: 'The human stays in the tower',
        body: [
          'Deposits and spends above your limit pause for approval. Convenience never means handing over the keys.',
          'The agent gets reach. You keep the final say.',
        ],
      },
    ],
  },
  {
    slug: 'base-where-agents-meet-money',
    title: 'Base: where agents meet money',
    excerpt:
      "Coinbase's L2 quietly became the default home for on-chain dollars. That makes it the natural meeting point for paying agents.",
    chain: 'Base',
    accent: '#0052FF',
    date: 'Jun 9, 2026',
    readingTime: '4 min read',
    seed: 2,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'Dollars live here',
        body: [
          'Base has deep USDC liquidity and a large builder community. Where the money and the developers gather, agents follow.',
          'You do not start a market. You go to where one already is.',
        ],
      },
      {
        heading: 'Cheap enough for micro-payments',
        body: [
          'Fees on Base are low enough that a fraction-of-a-cent payment makes sense. That is the unit agents trade in: small, frequent, automatic.',
          'A rail that makes tiny payments uneconomic is no rail for agents at all.',
        ],
      },
      {
        heading: "x402's reference rail",
        body: [
          'The x402 payment standard grew up on Base. Paying per request, in USDC, with no account and no API key, works here today, not in theory.',
          'That maturity is why we treat Base as the proving ground for the pay side.',
        ],
      },
      {
        heading: 'ERC-8004 native',
        body: [
          'Agent identity is an Ethereum standard, and Base speaks Ethereum. The same passport works with no translation layer.',
          'Identity on one EVM chain is identity on all of them.',
        ],
      },
    ],
  },
  {
    slug: 'x402-on-base-pay-per-request',
    title: 'x402 on Base: paying per request, for real',
    excerpt:
      "HTTP has carried a '402 Payment Required' status code, unused, for thirty years. On Base it finally means something.",
    chain: 'Base',
    accent: '#0052FF',
    date: 'Jun 5, 2026',
    readingTime: '3 min read',
    seed: 3,
    author: AUTHORS.devrel,
    sections: [
      {
        heading: 'A status code waiting for a use',
        body: [
          'The number 402 was reserved in the HTTP spec and left empty. Nobody had a fast, cheap way to actually charge per request.',
          'Stablecoins on a low-fee chain changed the math, and the empty slot finally has a job.',
        ],
      },
      {
        heading: 'Payment rides with the request',
        body: [
          'The agent calls your API and gets a 402 back with a price. It pays in USDC, and the call goes through. No signup, no key, no invoice later.',
          'The payment is part of the request, not a separate errand.',
        ],
      },
      {
        heading: 'Why it fits agents',
        body: [
          'Agents do not fill in checkout forms. They make calls. Pricing the call itself is the natural shape of machine commerce.',
          'Human commerce is a cart and a checkout. Agent commerce is a request and a receipt.',
        ],
      },
      {
        heading: 'Try it',
        body: [
          'Our SDK wraps any MCP tool as a paid tool in a few lines. The same flow runs on Arc when you want gas paid in USDC too.',
          'Write the handler once, charge for it everywhere.',
        ],
      },
    ],
  },
  {
    slug: 'bridging-agent-identity-to-stellar',
    title: 'Bridging agent identity to Stellar',
    excerpt:
      'Stellar moves dollars cheaply and fast, but it is not EVM. Here is how an agent passport reaches it anyway.',
    chain: 'Stellar',
    accent: '#E0B23C',
    date: 'May 30, 2026',
    readingTime: '3 min read',
    seed: 4,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'Why Stellar at all',
        body: [
          'USDC and EURC are native on Stellar, issued by Circle. Fees are tiny and settlement is quick.',
          'For agents paying across currencies, that combination is hard to beat.',
        ],
      },
      {
        heading: 'Identity is the catch',
        body: [
          'ERC-8004 is an Ethereum standard, so it does not exist natively on Stellar. The agent still needs to prove who it is before anyone trusts it.',
          'A fast payment rail with no identity is half a system.',
        ],
      },
      {
        heading: 'Bridged, not faked',
        body: [
          'The agent carries one ERC-8004 passport on an EVM chain. On Stellar we anchor it through a Soroban registry and SEP-10 auth, so the same identity holds.',
          'It is the real passport, recognized in a new country, not a fresh fake one.',
        ],
      },
      {
        heading: 'One agent, many homes',
        body: [
          'The goal is a single reputation that travels, whether the agent settles on Arc, Base, or Stellar.',
          'Your track record should follow you, not reset at every border.',
        ],
      },
    ],
  },
  {
    slug: 'watching-monad-parallel-evm',
    title: 'Watching Monad: parallel EVM for agent throughput',
    excerpt:
      'If a million agents transact at once, the chain underneath has to keep up. Monad is one bet on how.',
    chain: 'Monad',
    accent: '#836EF9',
    date: 'May 18, 2026',
    readingTime: '3 min read',
    seed: 6,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The throughput wall',
        body: [
          "Today's EVM chains run transactions one after another. Pack in enough agents and they queue. Fees spike and latency grows.",
          'A busy agent economy can hit that wall fast.',
        ],
      },
      {
        heading: 'Run them in parallel',
        body: [
          'Monad is an EVM-compatible L1 that executes independent transactions in parallel, aiming for much higher throughput while keeping the familiar tooling.',
          'Same language, more lanes on the road.',
        ],
      },
      {
        heading: 'Same code, more room',
        body: [
          'Because it is EVM-compatible, ERC-8004 identity and x402 payments port over with little change. That is what makes it worth a close look.',
          'We would rather extend the stack than rebuild it.',
        ],
      },
      {
        heading: 'On our radar',
        body: [
          'Monad is early. We are watching it as a future high-throughput rail, not shipping on it yet.',
          'Honesty over hype: we name what is live, and what is still a bet.',
        ],
      },
    ],
  },
  {
    slug: 'know-your-agent-identity-before-money',
    title: 'Know Your Agent: identity before money',
    excerpt:
      "KYC asks 'is this person real?' KYA asks 'is this agent real?' Get the order right and payment becomes the easy part.",
    chain: 'Identity',
    accent: '#7342E2',
    date: 'May 12, 2026',
    readingTime: '4 min read',
    seed: 7,
    author: AUTHORS.protocol,
    sections: [
      {
        heading: 'The order matters',
        body: [
          'You would not wire money to a name you cannot verify. Agents should not either. Identity comes first, payment second.',
          'Most agent payment projects start with the wallet. We start with the passport.',
        ],
      },
      {
        heading: 'A passport, not an account',
        body: [
          'ERC-8004 gives each agent a portable on-chain identity plus a reputation it earns over time. No marketplace owns it, and anyone can check it.',
          'An account can be closed by whoever runs it. A passport belongs to the holder.',
        ],
      },
      {
        heading: 'Reputation you can carry',
        body: [
          'The same score travels across chains, so an agent\'s history is not stuck on the chain it started on.',
          'Trust earned in one place should count everywhere.',
        ],
      },
      {
        heading: 'Then the money is easy',
        body: [
          'Once two agents can verify each other, settling in stablecoins is the simple part. Trust was always the hard part.',
          'Solve identity, and payment stops being scary.',
        ],
      },
    ],
  },
]

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug)
}
