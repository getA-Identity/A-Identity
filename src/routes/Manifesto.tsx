import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Compass } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import { DOCS_URL } from '../lib/brand'
import { usePageMeta } from '../lib/head'
import ThemeScope from '../components/ThemeScope'
import { Button } from '../components/ui/button'
import { DisplayHeading, Eyebrow } from '../components/ui/display'
import { reveal } from '../components/ui/section'
import { ManifestoSection } from '../components/manifesto/ManifestoSection'
import { PillarsDiagram } from '../components/manifesto/PillarsDiagram'
import { Principles } from '../components/manifesto/Principles'
import { MechanismMap } from '../components/manifesto/MechanismMap'
import { Landscape } from '../components/manifesto/Landscape'
import { Refusals } from '../components/manifesto/Refusals'
import { REVISED } from '../components/manifesto/content'

/**
 * /manifesto: the public reference for investors, grant programs, partners and researchers
 * as much as for developers. The argument runs in one direction: the question (how should
 * an agent earn the right to act), the four pillars an action passes through, the ten laws
 * with the mechanism that keeps each one, the 2026 landscape read against dated sources,
 * what we refuse, and the closing statement. Copy lives in components/manifesto/content.ts.
 */

export default function Manifesto() {
  usePageMeta({
    title: 'Manifesto | A-Identity',
    description:
      'How should autonomous agents earn the right to act? Four pillars, ten principles and the mechanism behind each: identity, authority, boundaries and accountability, placed in the 2026 landscape of agent trust and payments.',
    canonical: 'https://a-identity.xyz/manifesto',
  })

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="w-full">
        {/* Opening: the question, the core statement, the dateline, then two short paragraphs. */}
        <section className="mx-auto w-full max-w-[1040px] px-5 pb-14 pt-16 sm:px-8 sm:pb-20 sm:pt-24">
          <motion.div {...reveal}>
            <Eyebrow icon={Compass}>Manifesto</Eyebrow>
          </motion.div>
          <motion.div {...reveal} className="mt-6 max-w-[920px]">
            <DisplayHeading size="display">How should autonomous agents earn the right to act?</DisplayHeading>
          </motion.div>
          <motion.p
            {...reveal}
            className="mt-7 max-w-[760px] text-lg font-medium leading-relaxed text-foreground/70 sm:text-xl"
          >
            Identity enables autonomy. Authority defines its limits. Accountability makes it
            trustworthy.
          </motion.p>
          <motion.div
            {...reveal}
            className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45"
          >
            <span>Revised {REVISED}</span>
            <span className="hidden h-px w-5 bg-foreground/20 sm:block" aria-hidden="true" />
            <span>One trust layer. Many ecosystems.</span>
          </motion.div>

          <div className="mt-12 max-w-[760px] space-y-5 text-base leading-relaxed text-foreground/70 sm:text-[17px]">
            <motion.p {...reveal}>
              Software now buys data, calls tools and pays for work on its own. The question is no
              longer whether agents will act. It is what gives an action standing: who did it, for
              whom, within what limits, and what remains once it is done.
            </motion.p>
            <motion.p {...reveal}>
              This page is our answer, written for investors, grant programs, partners and
              researchers as much as for developers. The laws are short on purpose. The mechanism
              under each one is how we keep it, and the landscape section places us among the
              other answers being built in 2026.
            </motion.p>
          </div>
        </section>

        <ManifestoSection
          id="pillars"
          index="01"
          label="The four pillars"
          heading="An action passes through four questions."
          lede="Identity, authority, boundaries and accountability. The gate in the middle answers ALLOW, WARN or DENY, and the receipt outlives the action that produced it."
        >
          <PillarsDiagram />
        </ManifestoSection>

        <ManifestoSection
          id="principles"
          index="02"
          label="Ten principles"
          heading="Ten laws, each with the part of the product that keeps it."
          lede="Written to last the way simple laws do, and tied to a mechanism so that none of them stays a slogan."
        >
          <Principles />
        </ManifestoSection>

        <ManifestoSection
          id="mechanisms"
          index="03"
          label="From principle to mechanism"
          heading="Five words of the manifesto, five parts of the product."
          lede="Identity, authority, decision, evidence and network trust each name one thing you can call, read or verify today."
        >
          <MechanismMap />
        </ManifestoSection>

        <ManifestoSection
          id="landscape"
          index="04"
          label="The landscape, 2026"
          heading="Different answers to the same question."
          lede="Card networks, platforms, open rails and registries are each deciding how an agent proves who it is and how far it may go. Read this as a map, not a scoreboard: every row states what we could verify, with the date we read it."
        >
          <Landscape />
        </ManifestoSection>

        <ManifestoSection
          id="refusals"
          index="05"
          label="What we refuse"
          heading="Four things we will not do."
          lede="Each one is a line the code enforces, not a promise in a document."
          width="prose"
        >
          <Refusals />
        </ManifestoSection>

        {/* Closing: the long-form statement and the three doors out. */}
        <section className="mx-auto w-full max-w-[760px] border-t border-border px-5 pb-20 pt-14 sm:px-8 sm:pb-28 sm:pt-20">
          <motion.blockquote {...reveal} className="border-l-2 border-accent pl-6 sm:pl-8">
            <p
              className="text-2xl font-bold leading-snug tracking-tight text-foreground sm:text-[2rem]"
              style={{ fontFamily: 'var(--font-heading)', textWrap: 'balance' }}
            >
              Autonomous systems should be free to act, but never free from identity, authority or
              accountability.
            </p>
          </motion.blockquote>
          <motion.div {...reveal} className="mt-10 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link to="/architecture">
                Read the architecture <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/explorer">Open the explorer</Link>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
                Read the docs <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </Button>
          </motion.div>
          <motion.p
            {...reveal}
            className="mt-10 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45"
          >
            Chain changes. A-Identity remains.
          </motion.p>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
