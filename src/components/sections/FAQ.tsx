import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../ui/accordion'
import { Button } from '../ui/button'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

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

// Flatten for a single open-at-a-time accordion across all groups.
const FLAT = GROUPS.flatMap((g) => g.items)

// FAQPage structured data — makes every Q&A machine-readable (search engines +
// agents) even while the visible accordion keeps answers collapsed. A cleaner,
// richer signal than the old "keep every answer mounted in the DOM" trick.
const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FLAT.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: {
      '@type': 'Answer',
      text: item.tag ? `${item.a} ${item.tag}` : item.a,
    },
  })),
}

export default function FAQ() {
  let runningIndex = -1

  return (
    <section id="faq" className="w-full bg-background px-5 py-20 sm:px-8 sm:py-28">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="mx-auto max-w-[820px]">
        <motion.span {...reveal} className="text-base font-semibold tracking-wide text-accent">
          FAQ
        </motion.span>
        <motion.h2
          {...reveal}
          className="mt-4 text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Questions humans (still) ask.
        </motion.h2>

        {/* One shadcn Accordion across all groups → single open-at-a-time; first
            item open by default. Category headers interleave between the items. */}
        <Accordion
          type="single"
          collapsible
          defaultValue="faq-0"
          className="mt-10 flex flex-col gap-10"
        >
          {GROUPS.map((group) => (
            <div key={group.category}>
              <motion.h3
                {...reveal}
                className="mb-3 text-xs font-bold tracking-widest text-foreground/40"
              >
                {group.category}
              </motion.h3>
              <div className="flex flex-col gap-3">
                {group.items.map((item) => {
                  runningIndex += 1
                  const i = runningIndex
                  return (
                    <motion.div {...reveal} key={item.q}>
                      <AccordionItem
                        value={`faq-${i}`}
                        className="overflow-hidden rounded-2xl border border-foreground/10 bg-card"
                      >
                        <AccordionTrigger className="justify-between gap-4 px-6 py-5 text-left font-semibold text-foreground">
                          <span>{item.q}</span>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="px-6 pb-6">
                            <p className="text-sm leading-relaxed text-foreground/65">{item.a}</p>
                            {item.tag && (
                              <p className="mt-3 text-sm font-bold text-accent">{item.tag}</p>
                            )}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </motion.div>
                  )
                })}
              </div>
            </div>
          ))}
        </Accordion>

        {/* Closing CTA */}
        <motion.div
          {...reveal}
          className="mt-12 rounded-3xl border border-accent/20 bg-accent/[0.05] p-8 text-center sm:p-10"
        >
          <h3 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            Building agent-native products?
          </h3>
          <p className="mx-auto mt-3 max-w-xl text-foreground/65">
            A-Identity gives your agents verified identity, wallets, and payment infrastructure
            built for the next economy.
          </p>
          <p className="mt-4 font-bold text-accent">Verify first. Pay at machine speed.</p>
          <Button asChild size="lg" className="mt-6">
            <Link to="/signup">
              Get Your Agent ID <ArrowUpRight size={16} />
            </Link>
          </Button>
        </motion.div>
      </div>
    </section>
  )
}

// Exposed for any future count badge or sitemap use.
export const FAQ_COUNT = FLAT.length
