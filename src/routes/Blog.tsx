import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import BlogCover from '../components/BlogCover'
import { postsIn, localized, postPath, type Lang } from '../lib/blog'
import { t } from '../lib/blog-strings'
import { usePageMeta } from '../lib/head'
import { EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/** Filter list: All plus each distinct topic, in first-seen order. */
/** Filter labels come from the posts that exist in the current language, so a
 *  Turkish reader is never offered a category with nothing behind it. */
const typesFor = (lang: Lang) => [
  lang === 'tr' ? 'Tümü' : 'All',
  ...Array.from(new Set(postsIn(lang).map((p) => localized(p, lang).chain))),
]

export default function Blog() {
  const { pathname } = useLocation()
  const lang: Lang = pathname.startsWith('/tr/') ? 'tr' : 'en'
  const L = t(lang)
  const all = lang === 'tr' ? 'Tümü' : 'All'
  const [filter, setFilter] = useState(all)
  const TYPES = useMemo(() => typesFor(lang), [lang])

  usePageMeta({
    title: `${L.blogTitle} · A-Identity`,
    description: L.blogIntro,
    canonical: `https://a-identity.xyz${lang === 'tr' ? '/tr/blog' : '/blog'}`,
    lang,
    alternates: [
      { hreflang: 'en', href: 'https://a-identity.xyz/blog' },
      { hreflang: 'tr', href: 'https://a-identity.xyz/tr/blog' },
      { hreflang: 'x-default', href: 'https://a-identity.xyz/blog' },
    ],
  })

  const shown = useMemo(
    () =>
      postsIn(lang).filter((p) => filter === all || localized(p, lang).chain === filter),
    [filter, lang, all],
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
          {L.blogTitle}
        </motion.h1>
        <motion.p {...reveal} className="mt-5 max-w-2xl text-lg leading-relaxed text-foreground/60">
          {L.blogIntro}
        </motion.p>
        <motion.div {...reveal} className="mt-6">
          <Link
            to={lang === 'tr' ? '/blog' : '/tr/blog'}
            hrefLang={lang === 'tr' ? 'en' : 'tr'}
            className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1.5 text-sm text-foreground/70 transition-colors hover:border-accent/40 hover:text-accent"
          >
            {lang === 'tr' ? L.readInEnglish : L.readInTurkish}
          </Link>
        </motion.div>

        <div className="mt-12 grid gap-10 lg:grid-cols-[200px_1fr]">
          {/* Browse by type (left rail, sticky on desktop) */}
          <aside>
            <div className="lg:sticky lg:top-24">
              <div className="text-[11px] font-bold uppercase tracking-widest text-foreground/45">
                {lang === 'tr' ? 'Konuya göre' : 'Browse by type'}
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
                  <Link key={post.slug} to={postPath(post.slug, lang)} className="group block">
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
                      {localized(post, lang).chain}
                    </div>
                    <h3 className="mt-2 text-xl font-bold leading-snug tracking-tight text-foreground transition-colors group-hover:text-accent">
                      {localized(post, lang).title}
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
