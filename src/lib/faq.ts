/**
 * Every question the site answers, in one place.
 *
 * Two sets, written for different readers and both kept whole. The four reference categories
 * are the educational set: what the thing is, how it works, who it is for. The fifth is the
 * landing's objection set, which is what somebody actually hesitates over before letting an
 * agent near their money, and it lives in LandingFaq because those answers carry links and
 * emphasis that only make sense as markup.
 *
 * This file is the single source. The landing renders a cut of it, /faq renders all of it,
 * and neither can drift from the other.
 */

type Item = { q: string; a: string; tag?: string }
type Group = { category: string; items: Item[] }

// Ordered general to specific: basics, how it works, who and why, for builders.
const GROUPS: Group[] = [
  {
    category: 'The Basics',
    items: [
      {
        q: `What is A-Identity?`,
        a: `A-Identity is the identity and payment layer for AI agents. It gives every agent two core tools: a verified ID, and a wallet to pay from. Built on Arc, it lets an agent prove who it is before any payment happens.`,
      },
      {
        q: `Why do AI agents need identity?`,
        a: `Agents already connect to apps, APIs, and each other. But they still cannot always prove who they are. Without identity there is no trust, and without trust agent-to-agent commerce cannot scale. A-Identity fixes this with a KYA gate and ERC-8004 verification.`,
      },
      {
        q: `What does "KYA" mean?`,
        a: `KYA means Know Your Agent. It is an identity check for AI agents. Before an agent can act, connect, or pay, it has to pass verification.`,
        tag: `No verified agent, no trusted transaction.`,
      },
      {
        q: `What is ERC-8004 used for?`,
        a: `ERC-8004 is the verification layer for agent identity. It gives an agent a verified status that other systems can recognize as trusted, traceable, and approved. In short, ERC-8004 gives the agent proof.`,
      },
      {
        q: `Why do AI agents need wallets?`,
        a: `Agents are moving from chat tools to digital workers. They can search, compare, negotiate, and finish tasks. Once an agent creates real value, it needs a secure way to pay or get paid. A-Identity gives it a wallet built for the agentic economy.`,
      },
    ],
  },
  {
    category: 'How It Works',
    items: [
      {
        q: `How do agent-to-agent payments work?`,
        a: `A-Identity uses x402. The agent proves who it is, receives verified status, then pays another agent through x402, and value settles in stablecoins (USDC, USDT, or PYUSD).`,
      },
      {
        q: `What does "Web2 trust, Web3 rails" mean?`,
        a: `The experience stays familiar, like Web2, so real users and businesses can trust it. The payment and settlement run on Web3 rails. You get clear identity, stablecoin settlement, faster payments, and human approval when value moves.`,
      },
      {
        q: `What role does Arc play?`,
        a: `Arc powers the infrastructure. It connects identity, verification, payments, and settlement into one agent-native flow, with gas paid in USDC and sub-second finality. Arc handles the protocol layer; A-Identity makes it usable for agents, builders, and businesses.`,
      },
      {
        q: `When does a human approve the payment?`,
        a: `A human approves when real value moves. The agent runs at machine speed, but payment approval stays controlled. Fast, without removing human responsibility.`,
      },
      {
        q: `Is A-Identity a crypto wallet?`,
        a: `Not only. The wallet is one part. A-Identity is a trust and payment layer for AI agents, and the verified identity is the foundation. In agent commerce, payment should never come before proof.`,
      },
      {
        q: `Which stablecoins and networks does it support?`,
        a: `Settlement is in stablecoins, mainly USDC, with USDT and PYUSD too. Payments run across Arc, Base, Arbitrum, and Stellar. Identity uses ERC-8004 on the EVM chains, bridged to the rest.`,
      },
      {
        q: `Is my data exposed when an agent gets verified?`,
        a: `The roadmap uses zero-knowledge proofs. An agent can prove a claim, such as "reputation above X" or "authorized for Y", without revealing the underlying data. Verify the fact, not the file.`,
      },
    ],
  },
  {
    category: 'Who It Is For, and Why Now',
    items: [
      {
        q: `Who is A-Identity built for?`,
        a: `AI agent builders, fintech products, agent-native marketplaces, Web2.5 platforms, protocol teams, automation companies, AI commerce products, and enterprise workflows. Any product where agents need to prove, act, and pay.`,
      },
      {
        q: `What problem does A-Identity solve?`,
        a: `Most agentic workflows break at the same point: the agent can talk, but it cannot prove, and it cannot pay safely. A-Identity closes that gap with a passport and wallet for real economic activity.`,
      },
      {
        q: `What makes A-Identity different?`,
        a: `It combines three things in one flow: identity through KYA and ERC-8004, payments through x402, and settlement through USDC, USDT, and PYUSD.`,
        tag: `Verify first. Pay at machine speed.`,
      },
      {
        q: `Why does this matter now?`,
        a: `Agents are multiplying fast. Soon they will not only answer questions; they will complete transactions, coordinate services, and move value. That economy needs infrastructure, so we are building the trust layer before the payment layer.`,
      },
      {
        q: `What is the simplest way to describe A-Identity?`,
        a: `A passport, a wallet, and a proof layer before payment. Built for Web2.5, designed for the agent economy.`,
      },
    ],
  },
  {
    category: 'For Builders',
    items: [
      {
        q: `How can builders use A-Identity?`,
        a: `Add verified agent identity and agent-native payments to your product. Instead of building trust, verification, payment, and settlement from scratch, plug into the A-Identity flow through the SDK or the MCP server.`,
      },
      {
        q: `How do I add A-Identity to my project?`,
        a: `Two ways. Embed the SDK in your agent, or connect the MCP server so any agent can reach you. The MCP server is read-only today and needs no code in the agent. The developer docs cover both.`,
      },
      {
        q: `What is the core principle?`,
        a: `Proof before payment. Every agent verifies first. Every payment moves only after trust is established. That is the foundation of A-Identity.`,
      },
    ],
  },
]
/** Flat list in reading order, for counts and for the FAQPage schema. */
export const FAQ_ITEMS = GROUPS.flatMap((g) => g.items)

export type { Item, Group }
export { GROUPS }
