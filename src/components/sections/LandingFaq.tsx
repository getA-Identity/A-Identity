import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'

/**
 * The six questions somebody actually hesitates over before letting an agent near their
 * money. Not "what is ERC-8004" — that is documentation. These are the objections, and
 * three of them are ones we would rather not be asked.
 *
 * Deliberately separate from FAQ.tsx, which is a twenty-question reference set. This is the
 * landing cut: short enough to read standing up. (Also note the filename: FAQ.tsx and
 * Faq.tsx are the same file on macOS and two different files on Linux CI, so this one is
 * unambiguously named.)
 *
 * The rule for every answer: it must be checkable. Where a claim can be verified by opening
 * a URL, the URL is in the answer. Where the honest answer is unflattering — the public
 * counters read zero, the card surface has a limit we cannot close — it says so, because a
 * FAQ containing only good news reads as marketing and gets believed less than one that
 * admits something.
 *
 * `forceMount` keeps every answer in the DOM while collapsed. The footer advertises this
 * page as LLM-parsable, so an agent reading the markup should get the answers without having
 * to simulate clicks.
 */
const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const linkClass = 'font-medium text-accent underline-offset-2 hover:underline'

type Item = { q: string; a: ReactNode }

const ITEMS: Item[] = [
  {
    q: 'Does A-Identity touch my money or hold my keys?',
    a: (
      <>
        No. We never hold a key, never move a dollar, and never place the order. Your agent asks
        whether an action is inside the limits <em>you</em> set, we answer <strong>allow</strong>,{' '}
        <strong>ask a human</strong> or <strong>no</strong>, and the account stays exactly where it
        was. That is not a promise we are asking you to trust, it is the shape of the product: there
        is no endpoint that accepts your brokerage credentials, because we never want to be the
        reason someone loses them.
      </>
    ),
  },
  {
    q: 'Can the agent talk its way past the limits?',
    a: (
      <>
        The limits are not a prompt, so there is nothing to argue with. They are checked outside the
        model, and on <em>every</em> path that moves money rather than only on orders: a recurring
        buy, an account setting, money wired out, a cancelled protective position. That last part is
        where naive guardrails leak, because an agent blocked from buying can simply schedule the buy
        instead. A refusal cannot be overwritten, and attempts to overwrite one are counted rather
        than quietly rejected. Trading on borrowed money is not a setting we offer at all.
      </>
    ),
  },
  {
    q: 'What happens if you go down while my agent is running?',
    a: (
      <>
        Nothing of ours can break a trade, because we are not in the execution path. When our own
        package cannot get a verdict it refuses to act rather than guessing, which is the safe
        direction to fail in. And you do not have to take our word for whether the engine is up:{' '}
        <a
          href="https://a-identity-backend.onrender.com/api/guardrail-status"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          this endpoint
        </a>{' '}
        runs the real engine on request and answers 503 if it is not enforcing. A monitor checks it
        every hour.
      </>
    ),
  },
  {
    q: 'Do you see my portfolio?',
    a: (
      <>
        Only for the length of one question. The account state arrives with each check and is never
        stored. The decision log keeps a <strong>hash</strong> of it instead, which proves which
        state a verdict was computed against without keeping the contents, so a refusal stays
        auditable and your positions stay yours. The public numbers are aggregate only: nothing in
        them identifies an agent, an owner, a holding or a single amount.
      </>
    ),
  },
  {
    q: 'Is this live, or a demo?',
    a: (
      <>
        Live, and here is the part most products would hide: the public counters currently read{' '}
        <strong>zero</strong>. The engine is real and enforcing, but no live agent has produced a
        decision yet, so there is nothing honest to count. We would rather show a zero you can verify
        than a number you cannot reproduce. When that changes it changes on{' '}
        <a
          href="https://a-identity-backend.onrender.com/api/traction"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          the same public endpoint
        </a>
        , measured rather than projected.
      </>
    ),
  },
  {
    q: 'What does it actually cover today?',
    a: (
      <>
        Brokerage trading and card spending, both live. The engine does not know which venue is
        asking, so a new one is an adapter rather than a rewrite. Two honest limits: on a card we can
        refuse a charge before it happens but we cannot physically stop an agent that already holds
        the card number, and prediction markets are{' '}
        <em>designed and deliberately not built</em> — a separately regulated venue with no agent
        surface yet, and we will not write rules against a payload nobody has published.
      </>
    ),
  },
]

export default function LandingFaq() {
  return (
    <section id="faq" className="w-full bg-background px-5 py-24 text-foreground sm:px-8 sm:py-32">
      <div className="mx-auto max-w-[820px]">
        <motion.h2
          {...reveal}
          className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          The questions worth asking first.
        </motion.h2>
        <motion.p {...reveal} className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/55">
          Before you let anything move money on your behalf.
        </motion.p>

        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.08 }} className="mt-12">
          <Accordion type="single" collapsible className="divide-y divide-border border-y border-border">
            {ITEMS.map((item, i) => (
              <AccordionItem key={item.q} value={`q${i}`} className="group">
                <AccordionTrigger className="justify-between gap-6 py-6 text-left">
                  <span className="text-base font-semibold leading-snug transition-colors group-hover:text-accent sm:text-lg">
                    {item.q}
                  </span>
                </AccordionTrigger>
                <AccordionContent forceMount className="data-[state=closed]:hidden">
                  <p className="max-w-[68ch] pb-7 pr-8 text-[15px] leading-relaxed text-foreground/60">
                    {item.a}
                  </p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </div>
    </section>
  )
}
