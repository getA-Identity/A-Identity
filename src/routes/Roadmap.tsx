import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Github, Milestone } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { usePageMeta } from '../lib/head'
import { Button } from '../components/ui/button'
import { DisplayHeading, Eyebrow } from '../components/ui/display'
import { reveal } from '../components/ui/section'
import {
  ROADMAP_INFLUENCE,
  ROADMAP_ITEMS,
  ROADMAP_PRINCIPLES,
  ROADMAP_REPO,
  ROADMAP_STATUSES,
  ROADMAP_TRACKS,
  ROADMAP_UPDATED,
  countByStatus,
  resolveEvidence,
  shippedByMonth,
  trackMeta,
  type RoadmapItem,
  type RoadmapStatus,
  type RoadmapTrackId,
} from '../lib/roadmap'
import { RoadmapFilters, type StatusFilter, type TrackFilter } from '../components/roadmap/RoadmapFilters'
import { RoadmapItemCard } from '../components/roadmap/RoadmapItemCard'
import { RoadmapSection } from '../components/roadmap/RoadmapSection'
import { RoadmapSummary } from '../components/roadmap/RoadmapSummary'
import { RoadmapTimeline } from '../components/roadmap/RoadmapTimeline'
import { StatusBadge } from '../components/roadmap/StatusBadge'

/**
 * /roadmap: what shipped, with the day and the evidence; what is underway; the program
 * milestones we signed, with their due dates; and what comes next, undated on purpose.
 * The data is lib/roadmap.ts, which also generates the ROADMAP.md on GitHub, so the two
 * cannot drift. Counts and chain statuses are derived at render time, never typed.
 */

const ROADMAP_MD = `${ROADMAP_REPO}/blob/main/ROADMAP.md`

/** The five status sections in page order, with the editorial copy each one opens on. */
const SECTIONS: {
  status: RoadmapStatus
  index: string
  label: string
  heading: string
  lede: string
}[] = [
  {
    status: 'shipped',
    index: '01',
    label: 'Shipped',
    heading: 'Landed, dated, and checkable.',
    lede: 'Newest first. Every item names the day it landed and a place to check it: a proof page, a live API answer, a docs page or a file in the repository.',
  },
  {
    status: 'in-progress',
    index: '02',
    label: 'Now',
    heading: 'Underway today.',
    lede: 'Work in flight, with what is already done inside it stated as done. No completion dates, on purpose.',
  },
  {
    status: 'committed',
    index: '03',
    label: 'Committed',
    heading: 'The dates we owe.',
    lede: 'Program milestones with the due dates in the agreement. These are the only future dates on this page, and the progress against them is read from the settlement logs and published on the Arc proof page rather than promised here.',
  },
  {
    status: 'next',
    index: '04',
    label: 'Next',
    heading: 'What follows, in order.',
    lede: 'Ordered and undated. The sequence is the commitment; a date would be a guess dressed as one.',
  },
  {
    status: 'later',
    index: '05',
    label: 'Later',
    heading: 'Direction, not schedule.',
    lede: 'Known and wanted, not dated. An item moves up this page when the work ahead of it lands, not when a calendar says so.',
  },
]

export default function Roadmap() {
  usePageMeta({
    title: 'Roadmap | A-Identity',
    description:
      'What A-Identity shipped, with dates and evidence; what is underway; the program milestones we committed to; and what comes next, undated on purpose. One data file renders this page and the ROADMAP.md on GitHub.',
    canonical: 'https://a-identity.xyz/roadmap',
  })

  const [status, setStatus] = useState<StatusFilter>('all')
  const [track, setTrack] = useState<TrackFilter>('all')

  const statusCounts = useMemo(() => countByStatus(ROADMAP_ITEMS), [])
  const trackCounts = useMemo(() => {
    const counts = Object.fromEntries(ROADMAP_TRACKS.map((t) => [t.id, 0])) as Record<RoadmapTrackId, number>
    for (const item of ROADMAP_ITEMS) counts[item.track] += 1
    return counts
  }, [])

  const inTrack = useMemo(
    () => ROADMAP_ITEMS.filter((i) => track === 'all' || i.track === track),
    [track],
  )
  const visibleItems = useMemo(
    () => inTrack.filter((i) => status === 'all' || i.status === status),
    [inTrack, status],
  )
  const months = useMemo(() => shippedByMonth(inTrack), [inTrack])
  const ofStatus = (s: RoadmapStatus): RoadmapItem[] => inTrack.filter((i) => i.status === s)
  const trackLabel = track === 'all' ? null : trackMeta(track).label

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="w-full">
        {/* Opening: the eyebrow, the claim, the dateline, the legend. */}
        <section className="mx-auto w-full max-w-[1040px] px-5 pb-12 pt-16 sm:px-8 sm:pb-16 sm:pt-24">
          <motion.div {...reveal}>
            <Eyebrow icon={Milestone}>Roadmap</Eyebrow>
          </motion.div>
          <motion.div {...reveal} className="mt-6 max-w-[920px]">
            <DisplayHeading size="display">Shipped with receipts. The rest in order.</DisplayHeading>
          </motion.div>
          <motion.p
            {...reveal}
            className="mt-7 max-w-[760px] text-lg font-medium leading-relaxed text-foreground/70 sm:text-xl"
          >
            Every shipped item carries the day it landed and a place to check it. Work underway is
            labeled underway, the program milestones we signed carry their due dates, and nothing
            further out gets a date it might not keep.
          </motion.p>
          <motion.div
            {...reveal}
            className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45"
          >
            <span>
              Updated <time dateTime={ROADMAP_UPDATED}>{ROADMAP_UPDATED}</time>
            </span>
            <span className="hidden h-px w-5 bg-foreground/20 sm:block" aria-hidden="true" />
            <span>One data file. This page and the GitHub document.</span>
          </motion.div>

          {/* The legend: each status with the rule that earns it. */}
          <motion.ul {...reveal} className="mt-8 grid gap-x-8 gap-y-3 sm:grid-cols-2" aria-label="Status legend">
            {ROADMAP_STATUSES.map((s) => (
              <li key={s.id} className="flex items-start gap-3">
                <StatusBadge status={s.id} className="mt-0.5" />
                <span className="text-[14px] leading-relaxed text-foreground/65">{s.rule}</span>
              </li>
            ))}
          </motion.ul>
        </section>

        {/* The summary strip and the filters sit on the card surface, which is how the
            page separates its instruments from its argument. */}
        <section className="w-full border-y border-border bg-card/40 px-5 py-10 sm:px-8 sm:py-12">
          <div className="mx-auto w-full max-w-[1040px] space-y-8">
            <RoadmapSummary counts={statusCounts} />
            <motion.div {...reveal}>
              <RoadmapFilters
                status={status}
                track={track}
                onStatus={setStatus}
                onTrack={setTrack}
                statusCounts={statusCounts}
                trackCounts={trackCounts}
                total={ROADMAP_ITEMS.length}
                visible={visibleItems.length}
              />
            </motion.div>
          </div>
        </section>

        {SECTIONS.filter((s) => status === 'all' || status === s.status).map((section) => {
          const items = ofStatus(section.status)
          const empty = (
            <p className="mt-8 rounded-2xl border border-dashed border-border px-5 py-6 text-sm text-foreground/55">
              Nothing {trackLabel ? `in ${trackLabel}` : ''} here{section.status === 'shipped' ? ' yet' : ''}.
              {trackLabel ? ' Pick another track, or clear the filter above.' : ''}
            </p>
          )
          return (
            <RoadmapSection
              key={section.status}
              id={section.status === 'in-progress' ? 'now' : section.status}
              index={section.index}
              label={section.label}
              heading={section.heading}
              lede={section.lede}
              aside={
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
                  {items.length} {items.length === 1 ? 'item' : 'items'}
                  {trackLabel ? ` in ${trackLabel}` : ''}
                </span>
              }
            >
              {items.length === 0 ? (
                empty
              ) : section.status === 'shipped' ? (
                <RoadmapTimeline months={months} />
              ) : (
                <>
                  {section.status === 'committed' && (
                    <motion.div {...reveal} className="mt-8 flex flex-wrap items-center gap-3">
                      <Button asChild size="sm" variant="outline">
                        <Link to="/proof/arc">
                          Live progress on the Arc proof page <ArrowRight size={14} aria-hidden="true" />
                        </Link>
                      </Button>
                      <Button asChild size="sm" variant="ghost">
                        <a href="/api/arc/season" target="_blank" rel="noopener noreferrer">
                          The computed report <ArrowUpRight size={14} aria-hidden="true" />
                        </a>
                      </Button>
                    </motion.div>
                  )}
                  <ul className="mt-8 grid gap-4 sm:grid-cols-2 sm:gap-5">
                    {items.map((item, i) => (
                      <RoadmapItemCard key={item.id} item={item} index={i} />
                    ))}
                  </ul>
                </>
              )}
            </RoadmapSection>
          )
        })}

        {/* Closing: how to move an item, the rules this page keeps, and the GitHub copy. */}
        <section
          id="influence"
          className="mx-auto w-full max-w-[1040px] border-t border-border px-5 pb-20 pt-14 sm:px-8 sm:pb-28 sm:pt-20"
        >
          <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
            <div>
              <motion.div {...reveal}>
                <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
                  <span className="text-accent">06</span>
                  <span className="h-px w-4 bg-foreground/20" />
                  How to influence this
                </span>
                <DisplayHeading size="section" className="mt-4">
                  Name the chain, the rail and the evidence you expect.
                </DisplayHeading>
                <p className="mt-5 text-base leading-relaxed text-foreground/65 sm:text-lg">
                  An issue that says what it would take to call something shipped is the fastest way to
                  move it up this page. A chain lands as a registry entry plus at most one adapter, never
                  as scattered special cases; CONTRIBUTING.md carries the rule.
                </p>
              </motion.div>
              <motion.div {...reveal} className="mt-8 flex flex-wrap items-center gap-3">
                {ROADMAP_INFLUENCE.map((link, i) => {
                  const { href, kind } = resolveEvidence(link.href)
                  const variant = i === 0 ? 'default' : i === 1 ? 'outline' : 'ghost'
                  if (kind === 'route') {
                    return (
                      <Button asChild key={link.href} variant={variant} size="lg">
                        <Link to={href}>
                          {link.label} <ArrowRight size={16} aria-hidden="true" />
                        </Link>
                      </Button>
                    )
                  }
                  return (
                    <Button asChild key={link.href} variant={variant} size="lg">
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {link.label} <ArrowUpRight size={16} aria-hidden="true" />
                      </a>
                    </Button>
                  )
                })}
              </motion.div>
            </div>

            <motion.aside {...reveal} className="rounded-2xl border border-border bg-card p-5 sm:p-6">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/45">
                The rules this page keeps
              </span>
              <ol className="mt-3 space-y-3">
                {ROADMAP_PRINCIPLES.map((p, i) => (
                  <li key={p} className="flex gap-3 text-[14px] leading-relaxed text-foreground/70">
                    <span className="mt-px shrink-0 font-mono text-[11px] font-bold tracking-[0.14em] text-accent">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {p}
                  </li>
                ))}
              </ol>
              <div className="mt-5 border-t border-border pt-4">
                <Button asChild variant="ghost" size="sm">
                  <a href={ROADMAP_MD} target="_blank" rel="noopener noreferrer">
                    <Github size={14} aria-hidden="true" /> ROADMAP.md on GitHub
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                </Button>
                <p className="mt-2 text-[12px] leading-relaxed text-foreground/50">
                  Generated from the same data as this page. If the two ever disagree, the build fails.
                </p>
              </div>
            </motion.aside>
          </div>

          <motion.p
            {...reveal}
            className="mt-12 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45"
          >
            Dates only on things that happened.
          </motion.p>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
