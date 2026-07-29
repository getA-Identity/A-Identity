import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import BlogCover from '../components/BlogCover'
import { POSTS } from '../lib/blog'
import { EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/** Filter list: All plus each distinct topic, in first-seen order. */
const TYPES = ['All', ...Array.from(new Set(POSTS.map((p) => p.chain)))]

export default function Blog() {
  const [filter, setFilter] = useState('All')

  const shown = useMemo(
    () => (filter === 'All' ? POSTS : POSTS.filter((p) => p.chain === filter)),
    [filter],
  )

  return (
    <ThemeScope surface="card" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[1160px] px-5 py-14 sm:px-8 sm:py-20">
        {/* Big, quiet hero in the reference style */}
        <motion.h1
          {...reveal}
          className="max-w-3xl font-bold tracking-tight text-foreground"
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 'clamp(2.6rem, 6vw, 4.2rem)',
            lineHeight: 1.05,
          }}
        >
          Blog
        </motion.h1>
        <motion.p {...reveal} className="mt-5 max-w-2xl text-lg leading-relaxed text-foreground/60">
          Notes from the agentic economy. Where we are building, why these chains, and what
          we are still figuring out.
        </motion.p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[200px_1fr]">
          {/* Browse by type (left rail, sticky on desktop) */}
          <aside>
            <div className="lg:sticky lg:top-24">
              <div className="text-[11px] font-bold uppercase tracking-widest text-foreground/45">
                Browse by type
              </div>
              {/* Horizontal chips on mobile, vertical list on desktop */}
              <div className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0">
                {TYPES.map((t) => {
                  const active = filter === t
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setFilter(t)}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-left text-sm transition-colors lg:rounded-none lg:px-0 lg:py-2 ${
                        active
                          ? 'bg-accent/10 font-bold text-accent lg:bg-transparent lg:underline lg:decoration-2 lg:underline-offset-8'
                          : 'font-medium text-foreground/60 hover:text-foreground lg:hover:translate-x-0'
                      }`}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
            </div>
          </aside>

          {/* Post grid with a crossfade when the filter changes */}
          <div className="min-w-0">
            <AnimatePresence mode="wait">
              <motion.div
                key={filter}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: 'easeInOut' }}
                className="grid gap-x-8 gap-y-12 sm:grid-cols-2"
              >
                {shown.map((post) => (
                  <Link key={post.slug} to={`/blog/${post.slug}`} className="group block">
                    <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl">
                      <BlogCover
                        accent={post.accent}
                        seed={post.seed}
                        className="h-full w-full transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                    </div>
                    <div
                      className="mt-4 text-[11px] font-bold uppercase tracking-widest"
                      style={{ color: post.accent }}
                    >
                      {post.chain}
                    </div>
                    <h3 className="mt-2 text-xl font-bold leading-snug tracking-tight text-foreground transition-colors group-hover:text-accent">
                      {post.title}
                    </h3>
                    <div className="mt-2 text-sm text-foreground/45">{post.date}</div>
                  </Link>
                ))}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}

export function ChainChip({ chain, accent }: { chain: string; accent: string }) {
  return (
    <span
      className="inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider"
      style={{ background: `${accent}14`, color: accent }}
    >
      {chain}
    </span>
  )
}
