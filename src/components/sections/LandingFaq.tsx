import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'

/**
 * The six questions somebody actually hesitates over before letting an agent near their
 * money. Not "what is ERC-8004", that is documentation. These are the objections, and
 * three of them are ones we would rather not be asked.
 *
 * Deliberately separate from FAQ.tsx, which is a twenty-question reference set. This is the
 * landing cut: short enough to read standing up. (Also note the filename: FAQ.tsx and
 * Faq.tsx are the same file on macOS and two different files on Linux CI, so this one is
 * unambiguously named.)
 *
 * The rule for every answer: it must be checkable. Where a claim can be verified by opening
 * a URL, the URL is in the answer. Where the honest answer is unflattering, the public
 * counters read zero, the card surface has a limit we cannot close, it says so, because a
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

import { FAQ_ITEMS } from '../../lib/faq'
import { track } from '../../lib/analytics'
import { SectionBackdrop } from '../ui/section-backdrop'

const linkClass = 'font-medium text-accent underline-offset-2 hover:underline'

type Item = {
  q: string
  a: ReactNode
  /**
   * The same answer as plain text, word for word with the markup removed.
   *
   * Needed because /faq emits FAQPage structured data and a schema field cannot carry JSX.
   * If one of these is edited, edit the other in the same commit: a rich result that
   * disagrees with the page is worse than no rich result.
   */
  plain: string
}

/** Exported so /faq can carry these too. The landing shows them; /faq keeps the full set. */
export const LANDING_FAQ: Item[] = [
  {
    q: 'Does A-Identity touch my money or hold my keys?',
    plain:
      'No. We never hold a key, never move a dollar, and never place the order. Your agent asks whether an action is inside the limits you set, we answer allow, ask a human or no, and the account stays exactly where it was. That is not a promise we are asking you to trust, it is the shape of the product: there is no endpoint that accepts your brokerage credentials, because we never want to be the reason someone loses them.',
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
    plain:
      'The limits are not a prompt, so there is nothing to argue with. They are checked outside the model, and on every path that moves money rather than only on orders: a recurring buy, an account setting, money wired out, a cancelled protective position. That last part is where naive guardrails leak, because an agent blocked from buying can simply schedule the buy instead. A refusal cannot be overwritten, and attempts to overwrite one are counted rather than quietly rejected. Trading on borrowed money is not a setting we offer at all.',
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
    plain:
      'Nothing of ours can break a trade, because we are not in the execution path. When our own package cannot get a verdict it refuses to act rather than guessing, which is the safe direction to fail in. And you do not have to take our word for whether the engine is up: this endpoint (https://a-identity-backend.onrender.com/api/guardrail-status) runs the real engine on request and answers 503 if it is not enforcing. A monitor checks it every hour.',
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
    plain:
      'Only for the length of one question. The account state arrives with each check and is never stored. The decision log keeps a hash of it instead, which proves which state a verdict was computed against without keeping the contents, so a refusal stays auditable and your positions stay yours. The public numbers are aggregate only: nothing in them identifies an agent, an owner, a holding or a single amount.',
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
    plain:
      'Live, and here is the part most products would hide: the public counters currently read zero. The engine is real and enforcing, but no live agent has produced a decision yet, so there is nothing honest to count. We would rather show a zero you can verify than a number you cannot reproduce. When that changes it changes on the same public endpoint (https://a-identity-backend.onrender.com/api/traction), measured rather than projected.',
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
    plain:
      'Brokerage trading and card spending, both live. The engine does not know which venue is asking, so a new one is an adapter rather than a rewrite. Two honest limits: on a card we can refuse a charge before it happens but we cannot physically stop an agent that already holds the card number, and prediction markets are designed and deliberately not built, a separately regulated venue with no agent surface yet, and we will not write rules against a payload nobody has published.',
    a: (
      <>
        Brokerage trading and card spending, both live. The engine does not know which venue is
        asking, so a new one is an adapter rather than a rewrite. Two honest limits: on a card we can
        refuse a charge before it happens but we cannot physically stop an agent that already holds
        the card number, and prediction markets are{' '}
        <em>designed and deliberately not built</em>, a separately regulated venue with no agent
        surface yet, and we will not write rules against a payload nobody has published.
      </>
    ),
  },
]

/** Landing six plus the reference set, so the link never advertises a stale number. */
const TOTAL_FAQ_COUNT = FAQ_ITEMS.length + LANDING_FAQ.length

export default function LandingFaq() {
  return (
    <section id="faq" className="relative w-full overflow-hidden bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <SectionBackdrop name="faq" position="right" />
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

        <div className="mt-12">
          {/* Which question someone opens is the most useful thing this page can
              tell us: it names the objection that is actually stopping them.
              The question text is fixed copy, so there is nothing personal in it. */}
          <Accordion
            type="single"
            collapsible
            className="divide-y divide-border border-y border-border"
            onValueChange={(v) => {
              const idx = Number(v?.replace('q', ''))
              if (Number.isInteger(idx) && LANDING_FAQ[idx]) track('faq_opened', { question: LANDING_FAQ[idx].q })
            }}
          >
            {LANDING_FAQ.map((item, i) => (
              <motion.div
                key={item.q}
                {...reveal}
                transition={{ ...reveal.transition, delay: 0.05 * i }}
              >
                <AccordionItem value={`q${i}`} className="group">
                  <AccordionTrigger className="justify-between gap-6 py-6 text-left">
                    <span className="text-base font-semibold leading-snug transition-all duration-200 group-hover:pl-1 group-hover:text-accent group-data-[state=open]:text-accent sm:text-lg">
                      {item.q}
                    </span>
                  </AccordionTrigger>
                  {/* forceMount keeps the answer in the DOM for agents/SEO even while
                      collapsed, so the open/close motion is a grid-rows tween (0fr → 1fr)
                      rather than Radix's unmount animation, which forceMount defeats. */}
                  <AccordionContent
                    forceMount
                    plain
                    /* `.faq-answer` carries the transition (see index.css): Radix rewrites
                       this node's inline transition-duration, so the declaration has to
                       win with !important from a stylesheet. */
                    className="faq-answer grid data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr]"
                  >
                    <div className="overflow-hidden">
                      <p className="max-w-[68ch] pb-7 pr-8 text-[15px] leading-relaxed text-foreground/60">
                        {item.a}
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </motion.div>
            ))}
          </Accordion>
        </div>

        {/* Six is the landing cut. The full reference set, categories and all, lives on /faq. */}
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.12 }} className="mt-8">
          <Link
            to="/faq"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-opacity hover:opacity-80"
          >
            Read all {TOTAL_FAQ_COUNT} questions <ArrowRight size={15} />
          </Link>
        </motion.div>
      </div>
    </section>
  )
}
