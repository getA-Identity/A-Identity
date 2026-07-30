/**
 * Every question the site answers, in one place.
 *
 * The reference set below is the 2026-07-30 rewrite (authored by the team): short, lean,
 * plain sentences, grouped by what a reader is actually worried about. Answers that are
 * really lists carry a `bullets` array so /faq can render them as lists instead of prose
 * pretending to be one. The landing's six objection questions live in LandingFaq (they
 * carry links and markup) and /faq appends them as a closing category.
 *
 * This file is the single source. The landing renders a cut of it, /faq renders all of it,
 * and neither can drift from the other.
 */

type Item = {
  q: string
  /** The opening sentence(s). */
  a: string
  /** Optional list the answer enumerates. */
  bullets?: string[]
  /** Optional closing sentence after the list. */
  after?: string
  /** Optional one-line accent takeaway. */
  tag?: string
}
type Group = { category: string; items: Item[] }

const GROUPS: Group[] = [
  {
    category: 'The Basics',
    items: [
      {
        q: `What is A-Identity?`,
        a: `A-Identity is an identity and payment layer for AI agents. It gives every agent:`,
        bullets: [`A verified identity`, `Clear permissions`, `A payment wallet`, `A record of its actions`],
      },
      {
        q: `Why do agents need identity?`,
        a: `AI agents can already use apps, APIs, and digital services. But many cannot prove who they are or who controls them. Without identity, trust is weak. Without trust, agent payments cannot grow safely.`,
      },
      {
        q: `What does KYA mean?`,
        a: `KYA means Know Your Agent. It checks:`,
        bullets: [`Who the agent is`, `Who operates it`, `What it can do`, `Which limits it must follow`],
      },
      {
        q: `Is KYA the same as KYC?`,
        a: `No. KYC verifies a person or company. KYA verifies an AI agent, its owner, and its permissions.`,
      },
      {
        q: `What is ERC-8004?`,
        a: `ERC-8004 is a standard for agent identity, reputation, and validation. It helps systems recognize an agent and review its past activity. It provides proof, but it does not guarantee that every action is safe.`,
      },
    ],
  },
  {
    category: 'Trust and Permissions',
    items: [
      {
        q: `Does verification mean an agent is safe?`,
        a: `Not always. Identity proves who the agent is. Permissions decide what it may do. Policy checks decide whether one action should be allowed.`,
      },
      {
        q: `Who sets the limits?`,
        a: `The agent's owner or organization. Limits may control:`,
        bullets: [`Spending amount`, `Approved recipients`, `Allowed tools`, `Daily activity`, `Human approval`, `Blocked actions`],
      },
      {
        q: `Can an agent change these rules?`,
        a: `No. The rules are checked outside the AI model. The agent cannot change them through conversation or prompts.`,
      },
      {
        q: `What decisions can the system return?`,
        a: `There are three possible results:`,
        bullets: [
          `Allow: the action is within the rules.`,
          `Ask: a person must approve it.`,
          `Block: the action is not allowed.`,
        ],
      },
      {
        q: `When is human approval needed?`,
        a: `Human approval may be required when:`,
        bullets: [
          `The amount is high`,
          `The recipient is new`,
          `The action is unusual`,
          `Money leaves an approved account`,
          `A setting is changed`,
          `The action is hard to reverse`,
        ],
        after: `The agent can work quickly, but people keep control of important decisions.`,
      },
    ],
  },
  {
    category: 'Payments',
    items: [
      {
        q: `How do agents pay each other?`,
        a: `A-Identity uses x402 for agent payments. The agent receives a payment request, proves its identity, passes the policy check, and completes the payment.`,
      },
      {
        q: `What does x402 do?`,
        a: `x402 handles the payment request and response. A-Identity adds the trust around it. It checks:`,
        bullets: [`Who is paying`, `Who is receiving`, `Whether the amount is allowed`, `Whether approval is needed`],
      },
      {
        q: `What does "Web2 trust, Web3 rails" mean?`,
        a: `The product should feel simple and familiar. Behind the interface, blockchain systems handle payments and settlement. Users see clear rules. The infrastructure works in the background.`,
      },
      {
        q: `Which asset is used?`,
        a: `USDC is the main settlement asset. Other stablecoins may be added when the selected network and payment system support them.`,
      },
      {
        q: `What role does Arc play?`,
        a: `Arc provides the blockchain infrastructure. It supports USDC based fees and fast transaction finality. A-Identity uses Arc to connect agent identity, payment, and settlement in one flow.`,
      },
      {
        q: `Is Arc live on mainnet?`,
        a: `Arc is currently available as a public testnet. Any Arc activity should be described as testnet activity until mainnet is available.`,
      },
    ],
  },
  {
    category: 'Wallets and Keys',
    items: [
      {
        q: `Is A-Identity only a wallet?`,
        a: `No. A wallet moves money. A-Identity also checks identity, permissions, risk, and approval.`,
      },
      {
        q: `Does A-Identity hold my money?`,
        a: `No. Funds remain in the user's or company's own account or wallet.`,
      },
      {
        q: `Does A-Identity store private keys?`,
        a: `No. Private keys stay with the selected wallet or account provider.`,
      },
      {
        q: `Does A-Identity need my account password?`,
        a: `No. It does not need brokerage passwords, wallet recovery phrases, or full account credentials.`,
      },
      {
        q: `Does A-Identity place transactions?`,
        a: `A-Identity checks whether an action is allowed. The connected wallet, broker, or payment provider completes the action.`,
      },
    ],
  },
  {
    category: 'Privacy',
    items: [
      {
        q: `Does verification expose private data?`,
        a: `Only the required information should be shared. The goal is to prove a fact without revealing the full record behind it.`,
      },
      {
        q: `Does A-Identity use zero knowledge proofs?`,
        a: `Zero knowledge verification is part of the roadmap. It may allow an agent to prove that it is approved or trusted without sharing all private data.`,
      },
      {
        q: `Does A-Identity store my portfolio?`,
        a: `The system may read the information needed for one policy check. The full portfolio should not be stored. A cryptographic hash can be kept to show which data was used for the decision.`,
      },
      {
        q: `What is stored in the decision log?`,
        a: `A record may include:`,
        bullets: [`Agent identity`, `Requested action`, `Decision`, `Time`, `Policy version`, `Reason for the result`],
        after: `Private keys and full account credentials are never included.`,
      },
    ],
  },
  {
    category: 'Safety',
    items: [
      {
        q: `What happens if the system is unavailable?`,
        a: `The action stops. If the system cannot return a clear decision, the agent should not continue. It fails in the safer direction.`,
      },
      {
        q: `Can an agent bypass a blocked action?`,
        a: `No. A blocked action cannot be changed by the agent. Attempts to avoid the rule can also be recorded.`,
      },
      {
        q: `Are indirect actions checked?`,
        a: `Yes. The system can also check:`,
        bullets: [
          `Scheduled payments`,
          `Recurring purchases`,
          `New recipients`,
          `Account changes`,
          `Transfers`,
          `Cancelled safety orders`,
        ],
        after: `The same rules apply even when the agent tries a different path.`,
      },
    ],
  },
  {
    category: 'For Builders',
    items: [
      {
        q: `Who is A-Identity for?`,
        a: `A-Identity is built for:`,
        bullets: [
          `AI agent developers`,
          `Fintech products`,
          `Agent marketplaces`,
          `Automation platforms`,
          `Enterprise systems`,
          `AI commerce products`,
        ],
        after: `It is useful wherever agents need to prove, act, and pay.`,
      },
      {
        q: `How can developers connect it?`,
        a: `Developers can use:`,
        bullets: [`An SDK`, `An MCP server`, `A provider adapter`],
      },
      {
        q: `What is MCP?`,
        a: `MCP helps AI applications connect to tools and services. It provides the connection. A-Identity provides identity, permission, and payment control around that connection.`,
      },
      {
        q: `Is the MCP server read only?`,
        a: `The first version is read only. Agents can check information and rules without receiving permission to move money.`,
      },
      {
        q: `Can new payment providers be added?`,
        a: `Yes. A new wallet, broker, or payment service can be connected through an adapter. The core policy system does not need to be rebuilt each time.`,
      },
    ],
  },
  {
    category: 'Current Status',
    items: [
      {
        q: `Is A-Identity live?`,
        a: `The policy engine and available prototype integrations are active. Arc based activity is currently on testnet. The site separates clearly between:`,
        bullets: [`Live features`, `Testnet features`, `Demo features`, `Planned features`],
      },
      {
        q: `Why are public counters at zero?`,
        a: `Because no public production decision has been recorded yet. A real zero is better than a number that cannot be verified.`,
      },
      {
        q: `What does the system cover today?`,
        a: `The current policy scope includes:`,
        bullets: [`Brokerage trading`, `Card spending checks`],
        after: `More services can be added through adapters.`,
      },
      {
        q: `Are prediction markets supported?`,
        a: `Not yet. They require separate rules, integrations, and regulatory review.`,
      },
    ],
  },
]

/** The closing block on /faq: the six questions that must have answers before an agent acts. */
export const PRINCIPLE = {
  title: `The A-Identity Principle`,
  intro: `Before an agent acts, six questions should have clear answers:`,
  questions: [
    `Who is the agent?`,
    `Who controls it?`,
    `What may it do?`,
    `What limits apply?`,
    `Who approves the action?`,
    `Can the decision be reviewed later?`,
  ],
  tag: `Verified identity. Clear authority. Controlled value.`,
}

/** Flat list in reading order, for counts and for the FAQPage schema. */
export const FAQ_ITEMS = GROUPS.flatMap((g) => g.items)

/** The answer as one plain string, for structured data. */
export function plainAnswer(item: Item): string {
  return [item.a, item.bullets?.join('; '), item.after, item.tag].filter(Boolean).join(' ')
}

export type { Item, Group }
export { GROUPS }
