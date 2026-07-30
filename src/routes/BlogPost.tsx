import { useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, Check, Link2, Languages } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import BlogCover from '../components/BlogCover'
import Logo from '../components/Logo'
import { ChainChip } from './Blog'
import { getPost, POSTS, localized, hasTranslation, postPath, alternatesFor, type Lang } from '../lib/blog'
import { t } from '../lib/blog-strings'
import { usePageMeta } from '../lib/head'
import { EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

export default function BlogPost() {
  const { slug } = useParams()
  const { pathname } = useLocation()
  // The URL is the single source of truth for language. No cookie, no browser
  // sniffing: a given article must always be the same article at a given URL,
  // or the version a search engine indexed is not the one a reader is served.
  const lang: Lang = pathname.startsWith('/tr/') ? 'tr' : 'en'
  const post = slug ? getPost(slug) : undefined
  const missingTranslation = post && !hasTranslation(post, lang)

  // Falling back to English copy under a Turkish URL would be worse than a
  // redirect: duplicate content under two languages is the exact thing hreflang
  // exists to prevent, and it costs both pages their standing.
  usePageMeta({
    title: post ? `${localized(post, lang).title} · ${t(lang).metaSuffix}` : t(lang).blogTitle,
    description: post ? localized(post, lang).excerpt : undefined,
    canonical: post ? `https://a-identity.xyz${postPath(post.slug, lang)}` : undefined,
    lang,
    alternates: post ? alternatesFor(post) : undefined,
  })

  if (!post) return <Navigate to={lang === 'tr' ? '/tr/blog' : '/blog'} replace />
  if (missingTranslation) return <Navigate to={`/blog/${post.slug}`} replace />

  const L = t(lang)
  const view = localized(post, lang)
  const other: Lang = lang === 'tr' ? 'en' : 'tr'
  const canSwitch = hasTranslation(post, other)

  const more = POSTS.filter((p) => p.slug !== post.slug && hasTranslation(p, lang) && p.chain === post.chain)
    .concat(POSTS.filter((p) => p.slug !== post.slug && hasTranslation(p, lang) && p.chain !== post.chain))
    .slice(0, 3)

  return (
    <ThemeScope surface="card" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:px-8 sm:py-14">
        {/* Breadcrumb */}
        <motion.nav {...reveal} className="flex flex-wrap items-center gap-1.5 text-sm">
          <Link to="/" className="text-accent hover:underline">
            {L.home}
          </Link>
          <span className="text-foreground/30">/</span>
          <Link to={lang === 'tr' ? '/tr/blog' : '/blog'} className="text-accent hover:underline">
            {L.blog}
          </Link>
          <span className="text-foreground/30">/</span>
          <span className="truncate text-foreground/50">{view.title}</span>
        </motion.nav>

        {/* Language switch, shown only when the other version actually exists. */}
        {canSwitch && (
          <motion.div {...reveal} className="mt-6">
            <Link
              to={postPath(post.slug, other)}
              hrefLang={other}
              className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1.5 text-sm text-foreground/70 transition-colors hover:border-accent/40 hover:text-accent"
            >
              <Languages size={15} />
              {other === 'tr' ? L.readInTurkish : L.readInEnglish}
            </Link>
          </motion.div>
        )}

        {/* Date, huge title, category chip */}
        <motion.div {...reveal} className="mt-10">
          <div className="text-sm text-foreground/50">{post.date}</div>
          <h1
            className="mt-4 max-w-4xl font-bold tracking-tight text-foreground"
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 'clamp(2.2rem, 5.5vw, 3.6rem)',
              lineHeight: 1.08,
            }}
          >
            {view.title}
          </h1>
          <div className="mt-5">
            <ChainChip chain={view.chain} accent={post.accent} />
          </div>
        </motion.div>

        {/* Two-column: article + sidebar */}
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <article className="min-w-0">
            {/* What you'll learn */}
            <motion.div {...reveal} className="rounded-2xl border border-border bg-card p-6">
              <div className="text-[11px] font-bold uppercase tracking-widest text-foreground/50">
                {L.whatYoullLearn}
              </div>
              <p className="mt-2 leading-relaxed text-foreground/70">{view.excerpt}</p>
            </motion.div>

            {/* Cover */}
            <motion.div {...reveal} className="mt-8 aspect-[16/9] w-full overflow-hidden rounded-2xl">
              <BlogCover accent={post.accent} seed={post.seed} className="h-full w-full" />
            </motion.div>

            {/* Body */}
            <div className="mt-10 flex flex-col gap-10">
              {view.sections.map((s) => (
                <section key={s.heading}>
                  <h2
                    className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
                    style={{ fontFamily: 'var(--font-heading)' }}
                  >
                    {s.heading}
                  </h2>
                  <div className="mt-4 flex flex-col gap-4">
                    {s.body.map((p, i) => (
                      <p key={i} className="text-[17px] leading-relaxed text-foreground/70">
                        {p}
                      </p>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </article>

          {/* Sidebar */}
          <aside className="flex flex-col gap-5">
            <div className="lg:sticky lg:top-24 lg:flex lg:flex-col lg:gap-5">
              {/* Author */}
              <div className="rounded-2xl border border-border bg-card p-6">
                <div className="text-[11px] font-bold uppercase tracking-widest text-foreground/50">
                  {L.author}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-full bg-background">
                    <Logo size={22} />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-foreground">{post.author.name}</div>
                    <div className="text-xs text-foreground/50">{post.author.role}</div>
                  </div>
                </div>
                <div className="mt-5 border-t border-border pt-4">
                  <ShareRow title={view.title} lang={lang} />
                </div>
                <div className="mt-4 text-xs text-foreground/40">{view.readingTime}</div>
              </div>

              {/* CTA card (subscribe slot in the reference) */}
              <div
                className="mt-5 rounded-2xl p-6 lg:mt-0"
                style={{ background: 'linear-gradient(135deg, #EEF4FF 0%, #F4F1FB 100%)' }}
              >
                <div className="text-[11px] font-bold uppercase tracking-widest text-foreground/55">
                  {lang === 'tr' ? "A-Identity ile geliştir" : 'Build with A-Identity'}
                </div>
                <p className="mt-3 text-sm leading-relaxed text-foreground/70">
                  {lang === 'tr'
                    ? 'Ajanınıza doğrulanmış bir kimlik ve bir cüzdan verin. Önce doğrulayın, sonra makine hızında ödeyin.'
                    : 'Give your agent a verified identity and a wallet. Verify first, pay at machine speed.'}
                </p>
                <Link
                  to="/signup"
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition-transform hover:scale-[1.03]"
                >
                  {lang === 'tr' ? 'Ajan kimliğini al' : 'Get Your Agent ID'} <ArrowUpRight size={14} />
                </Link>
              </div>
            </div>
          </aside>
        </div>

        {/* Keep reading */}
        <section className="mt-20 border-t border-border pt-12">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-foreground/50">
            {L.keepReading}
          </h2>
          <div className="mt-6 grid gap-x-8 gap-y-10 sm:grid-cols-3">
            {more.map((p) => (
              <Link key={p.slug} to={postPath(p.slug, lang)} className="group block">
                <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl">
                  <BlogCover
                    accent={p.accent}
                    seed={p.seed}
                    className="h-full w-full transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                </div>
                <div
                  className="mt-3 text-[11px] font-bold uppercase tracking-widest"
                  style={{ color: p.accent }}
                >
                  {localized(p, lang).chain}
                </div>
                <h3 className="mt-1.5 text-lg font-bold leading-snug tracking-tight text-foreground transition-colors group-hover:text-accent">
                  {localized(p, lang).title}
                </h3>
                <div className="mt-1.5 text-sm text-foreground/45">{p.date}</div>
              </Link>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}

/** Copy-link plus X and LinkedIn share intents. Uses the live page URL. */
function ShareRow({ title, lang }: { title: string; lang: Lang }) {
  const L = t(lang)
  const [copied, setCopied] = useState(false)
  const url = typeof window !== 'undefined' ? window.location.href : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] font-bold uppercase tracking-widest text-foreground/50">{L.share}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={L.copyLink}
        className="grid h-8 w-8 place-items-center rounded-full bg-foreground/5 text-foreground/60 transition-colors hover:bg-foreground/10"
      >
        {copied ? <Check size={14} className="text-emerald-600" /> : <Link2 size={14} />}
      </button>
      <a
        href={`https://x.com/intent/post?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={L.shareOnX}
        className="grid h-8 w-8 place-items-center rounded-full bg-foreground/5 text-xs font-bold text-foreground/60 transition-colors hover:bg-foreground/10"
      >
        X
      </a>
      <a
        href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={L.shareOnLinkedIn}
        className="grid h-8 w-8 place-items-center rounded-full bg-foreground/5 text-xs font-bold text-foreground/60 transition-colors hover:bg-foreground/10"
      >
        in
      </a>
    </div>
  )
}
