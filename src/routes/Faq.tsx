import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import ThemeScope from '../components/ThemeScope'
import SiteFooter from '../components/sections/SiteFooter'
import ScrollTopButton from '../components/ScrollTopButton'
import { Button } from '../components/ui/button'
import { GROUPS, FAQ_ITEMS, PRINCIPLE, plainAnswer } from '../lib/faq'
import { usePageMeta } from '../lib/head'
import { LANDING_FAQ } from '../components/sections/LandingFaq'

/**
 * Every question the site answers, all of them, all open.
 *
 * Deliberately not an accordion. On the landing, collapsing is right: the reader is scanning
 * and space is the constraint. On a reference page the constraint is the opposite, and a
 * question whose answer is behind a click is a question an answer engine has to guess at.
 * Everything here is in the markup, visible, in reading order, under real headings.
 *
 * That is the whole SEO/GEO/AEO argument in one line: search engines get FAQPage structured
 * data, answer engines get the answers as plain rendered text, and neither has to simulate a
 * click to find them.
 *
 * The content is not authored here. The reference categories come from lib/faq, the
 * closing set comes from the landing component, and both render from the same source the
 * landing uses so the two can never disagree.
 */

const CANONICAL = 'https://a-identity.xyz/faq'

/** The landing's four objections, presented as a closing category rather than dropped. */
const OBJECTIONS = {
  category: 'Before You Connect an Agent',
  blurb: 'The questions worth asking before anything moves money on your behalf.',
}

export default function Faq() {
  const total = FAQ_ITEMS.length + LANDING_FAQ.length

  usePageMeta({
    title: 'FAQ · A-Identity',
    description: `${total} questions on agent identity, KYA verification, ERC-8004, x402 payments and the limits an agent runs inside. Answers in full, nothing behind a click.`,
    canonical: CANONICAL,
    // FAQPage covering every question on the page, reference set and objections alike. The
    // site lost this entirely when the FAQ was unmounted from the landing on 25 July.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      '@id': `${CANONICAL}#faq`,
      url: CANONICAL,
      mainEntity: [
        ...FAQ_ITEMS.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: plainAnswer(item) },
        })),
        ...LANDING_FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.plain },
        })),
      ],
    },
  })

  const sections = [...GROUPS.map((g) => g.category), OBJECTIONS.category]

  return (
    <ThemeScope as="main" className="min-h-screen">
      <PageHeader />

      <div className="mx-auto w-full max-w-[820px] px-5 py-16 sm:px-8 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground/45">
          {total} questions
        </p>
        <h1 className="mt-3 text-4xl font-bold leading-[1.08] tracking-tight text-foreground sm:text-5xl">
          Everything you need to know.
        </h1>
        <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-foreground/55">
          A-Identity helps AI agents prove who they are, follow clear rules, and make safe
          payments. Identity comes first. Payment comes after trust.
        </p>

        {/* Jump nav. Long enough a set that a reader should not have to scroll to find out
            what is here. Built from the category list, so it cannot fall behind it. */}
        <nav aria-label="Categories" className="mt-9 flex flex-wrap gap-2">
          {sections.map((c) => (
            <a
              key={c}
              href={`#${slug(c)}`}
              className="rounded-full border border-border px-3.5 py-1.5 text-sm font-medium text-foreground/65 transition-colors hover:border-accent/50 hover:text-foreground"
            >
              {c}
            </a>
          ))}
        </nav>

        {GROUPS.map((group) => (
          <section key={group.category} id={slug(group.category)} className="mt-16 scroll-mt-24">
            <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-foreground/40">
              {group.category}
            </h2>
            <div className="mt-6 divide-y divide-border border-y border-border">
              {group.items.map((item) => (
                <article key={item.q} className="py-7">
                  <h3 className="text-lg font-semibold leading-snug tracking-tight text-foreground">
                    {item.q}
                  </h3>
                  <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-foreground/60">
                    {item.a}
                  </p>
                  {item.bullets && (
                    <ul className="mt-3 max-w-[68ch] space-y-1.5 text-[15px] leading-relaxed text-foreground/60">
                      {item.bullets.map((b) => (
                        <li key={b} className="flex gap-2.5">
                          <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.after && (
                    <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-foreground/60">
                      {item.after}
                    </p>
                  )}
                  {item.tag && (
                    <p className="mt-3 text-sm font-bold text-accent">{item.tag}</p>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}

        <section id={slug(OBJECTIONS.category)} className="mt-16 scroll-mt-24">
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-foreground/40">
            {OBJECTIONS.category}
          </h2>
          <p className="mt-2 text-sm text-foreground/45">{OBJECTIONS.blurb}</p>
          <div className="mt-6 divide-y divide-border border-y border-border">
            {LANDING_FAQ.map((item) => (
              <article key={item.q} className="py-7">
                <h3 className="text-lg font-semibold leading-snug tracking-tight text-foreground">
                  {item.q}
                </h3>
                <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-foreground/60">
                  {item.a}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* The closing principle: six questions that must have answers before an agent acts. */}
        <section className="mt-16 rounded-3xl border border-border bg-card p-8 sm:p-10">
          <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            {PRINCIPLE.title}
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-foreground/60">{PRINCIPLE.intro}</p>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2">
            {PRINCIPLE.questions.map((q, i) => (
              <li key={q} className="flex items-baseline gap-3 text-[15px] text-foreground/75">
                <span className="font-mono text-xs font-bold text-accent">{i + 1}</span>
                {q}
              </li>
            ))}
          </ol>
          <p className="mt-5 text-sm font-bold text-accent">{PRINCIPLE.tag}</p>
        </section>

        <div className="mt-8 rounded-3xl border border-accent/20 bg-accent/[0.05] p-8 text-center sm:p-10">
          <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            Building agent-native products?
          </h2>
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
        </div>
      </div>

      <ScrollTopButton />
      <SiteFooter />
    </ThemeScope>
  )
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
