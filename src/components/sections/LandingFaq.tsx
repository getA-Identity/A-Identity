import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'

/**
 * The four questions somebody actually hesitates over before letting an agent near their
 * money. Not "what is ERC-8004", that is documentation. These are the objections, and
 * three of them are ones we would rather not be asked.
 *
 * It used to be six. Two pairs were really one question each: "do you hold my keys" and
 * "do you see my portfolio" are both the reader asking what we have access to, and "is this
 * live" and "what does it cover" are both the reader asking what is real today. Merging
 * them cost no facts and removed two clicks from a section people read standing up.
 *
 * Deliberately separate from lib/faq.ts, which is the long reference set. This is the
 * landing cut. (Also note the filename: FAQ.tsx and Faq.tsx are the same file on macOS and
 * two different files on Linux CI, so this one is unambiguously named.)
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

const linkClass = 'font-medium text-accent underline underline-offset-2 hover:no-underline'

type Item = {
  q: string
  a: ReactNode
  /**
   * The same answer as plain text, word for word with the markup removed and any linked
   * URL spelled out in brackets.
   *
   * Needed because the homepage and /faq both emit FAQPage structured data and a schema
   * field cannot carry JSX. If one of these is edited, edit index.html in the same commit:
   * scripts/check-structured-data.mjs compares the two and fails the build when they
   * disagree, because a rich result that contradicts the page is worse than no rich result.
   *
   * Keep these as single-quoted one-line strings with no apostrophes in them. The checker
   * reads them out of this source with a regex rather than importing TSX.
   */
  plain: string
}

/** Exported so /faq can carry these too. The landing shows them; /faq keeps the full set. */
export const LANDING_FAQ: Item[] = [
  {
    q: 'Do you hold my keys, move my money, or see my portfolio?',
    plain:
      'No to all three. There is no endpoint that accepts your brokerage credentials: we never hold a key, never move a dollar, and never place the order. Your agent asks whether an action is inside the limits you set, we answer allow, ask a human or no, and the account stays exactly where it was. Account state arrives with the question and is never stored. The decision log keeps a hash of it instead, so a refusal stays auditable and your positions stay yours.',
    a: (
      <>
        No to all three. There is no endpoint that accepts your brokerage credentials: we never
        hold a key, never move a dollar, and never place the order. Your agent asks whether an
        action is inside the limits <em>you</em> set, we answer <strong>allow</strong>,{' '}
        <strong>ask a human</strong> or <strong>no</strong>, and the account stays exactly where
        it was. Account state arrives with the question and is never stored. The decision log
        keeps a <strong>hash</strong> of it instead, so a refusal stays auditable and your
        positions stay yours.
      </>
    ),
  },
  {
    q: 'Can the agent talk its way past the limits?',
    plain:
      'No, because the limits are not a prompt: they are checked outside the model, on every path that moves money rather than only on orders. A recurring buy, an account setting, money wired out, a cancelled protective position: that last one is where naive guardrails leak, because an agent blocked from buying can simply schedule the buy instead. A refusal cannot be overwritten, and attempts to overwrite one are counted rather than quietly rejected.',
    a: (
      <>
        No, because the limits are not a prompt: they are checked outside the model, on{' '}
        <em>every</em> path that moves money rather than only on orders. A recurring buy, an
        account setting, money wired out, a cancelled protective position: that last one is where
        naive guardrails leak, because an agent blocked from buying can simply schedule the buy
        instead. A refusal cannot be overwritten, and attempts to overwrite one are counted rather
        than quietly rejected.
      </>
    ),
  },
  {
    q: 'What happens if you go down while my agent is running?',
    plain:
      'Nothing of ours can break a trade, because we are not in the execution path. When our own package cannot get a verdict it refuses to act rather than guessing, which is the safe direction to fail in. You do not have to take our word for whether the engine is up: this endpoint (https://a-identity-backend.onrender.com/api/guardrail-status) runs the real engine on request and answers 503 if it is not enforcing, and a monitor checks it every hour.',
    a: (
      <>
        Nothing of ours can break a trade, because we are not in the execution path. When our own
        package cannot get a verdict it refuses to act rather than guessing, which is the safe
        direction to fail in. You do not have to take our word for whether the engine is up:{' '}
        <a
          href="https://a-identity-backend.onrender.com/api/guardrail-status"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          this endpoint
        </a>{' '}
        runs the real engine on request and answers 503 if it is not enforcing, and a monitor
        checks it every hour.
      </>
    ),
  },
  {
    q: 'Is this live, and what does it cover today?',
    plain:
      'Live, on brokerage trading and card spending. Here is the part most products would hide: the public counters read zero, because the engine is enforcing but no live agent has produced a decision yet, and we would rather show a zero you can verify on the public endpoint (https://a-identity-backend.onrender.com/api/traction) than a number you cannot reproduce. Two honest limits: on a card we can refuse a charge before it happens but we cannot stop an agent that already holds the card number, and prediction markets are designed and deliberately not built.',
    a: (
      <>
        Live, on brokerage trading and card spending. Here is the part most products would hide:
        the public counters read <strong>zero</strong>, because the engine is enforcing but no
        live agent has produced a decision yet, and we would rather show a zero you can verify on{' '}
        <a
          href="https://a-identity-backend.onrender.com/api/traction"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          the public endpoint
        </a>{' '}
        than a number you cannot reproduce. Two honest limits: on a card we can refuse a charge
        before it happens but we cannot stop an agent that already holds the card number, and
        prediction markets are <em>designed and deliberately not built</em>.
      </>
    ),
  },
]

/** Landing four plus the reference set, so the link never advertises a stale number. */
const TOTAL_FAQ_COUNT = FAQ_ITEMS.length + LANDING_FAQ.length

export default function LandingFaq() {
  /**
   * Controlled rather than uncontrolled, for one reason: `forceMount` leaves the collapsed
   * answers in the DOM, un-hidden, clipped to zero height. That is what we want for crawlers
   * and agents, and wrong for a keyboard, which would otherwise tab into links nobody can
   * see. Knowing which item is open lets the other three be marked `inert`, which takes them
   * out of the tab order and out of the accessibility tree while leaving the text in the
   * markup. Radix cannot do that for us because it never tells the caller the item state.
   */
  const [open, setOpen] = useState('')

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
            value={open}
            className="divide-y divide-border border-y border-border"
            onValueChange={(v) => {
              setOpen(v)
              // Closing the open item reports v as '', and Number('') is 0, which used to
              // log a phantom open of the first question every time somebody closed one.
              if (!v) return
              const idx = Number(v.replace('q', ''))
              if (Number.isInteger(idx) && LANDING_FAQ[idx]) track('faq_opened', { question: LANDING_FAQ[idx].q })
            }}
          >
            {LANDING_FAQ.map((item, i) => (
              <motion.div
                key={item.q}
                {...reveal}
                transition={{ ...reveal.transition, delay: 0.05 * i }}
              >
                <AccordionItem value={`q${i}`}>
                  <AccordionTrigger className="w-full cursor-pointer justify-between gap-6 rounded-lg py-6 text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background data-[state=open]:text-accent">
                    <span className="text-base font-semibold leading-snug sm:text-lg">
                      {item.q}
                    </span>
                  </AccordionTrigger>
                  {/* forceMount keeps the answer in the DOM for agents/SEO even while
                      collapsed, so the open/close motion is a grid-rows tween (0fr -> 1fr)
                      rather than Radix's unmount animation, which forceMount defeats. */}
                  <AccordionContent
                    forceMount
                    plain
                    /* `.faq-answer` carries the transition (see index.css): Radix rewrites
                       this node's inline transition-duration, so the declaration has to
                       win with !important from a stylesheet. */
                    className="faq-answer grid data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr]"
                  >
                    <div className="overflow-hidden" inert={open !== `q${i}`}>
                      <p className="max-w-[62ch] pb-7 pr-8 text-[15px] leading-[1.75] text-foreground/70">
                        {item.a}
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </motion.div>
            ))}
          </Accordion>
        </div>

        {/* Four is the landing cut. The full reference set, categories and all, lives on /faq. */}
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
