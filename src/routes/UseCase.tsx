import { Link, Navigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import BlogCover from '../components/BlogCover'
import { getUseCase, USE_CASES, type UseCaseProduct } from '../lib/usecases'
import { EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

function ProductLink({ p }: { p: UseCaseProduct }) {
  const cls =
    'flex items-center justify-between gap-2 border-t border-border py-3 text-sm font-semibold text-foreground transition-colors hover:text-accent'
  if (p.external || p.href.startsWith('http')) {
    return (
      <a href={p.href} target="_blank" rel="noopener noreferrer" className={cls}>
        {p.name} <ArrowUpRight size={14} className="shrink-0 text-foreground/40" />
      </a>
    )
  }
  return (
    <Link to={p.href} className={cls}>
      {p.name} <ArrowRight size={14} className="shrink-0 text-foreground/40" />
    </Link>
  )
}

export default function UseCase() {
  const { slug } = useParams()
  const uc = slug ? getUseCase(slug) : undefined

  if (!uc) return <Navigate to="/#use-cases" replace />

  const more = USE_CASES.filter((u) => u.slug !== uc.slug).slice(0, 4)

  return (
    <ThemeScope surface="card" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:px-8 sm:py-14">
        {/* Breadcrumb */}
        <motion.nav {...reveal} className="flex flex-wrap items-center gap-1.5 text-sm">
          <Link to="/" className="text-accent hover:underline">
            Home
          </Link>
          <span className="text-foreground/30">/</span>
          <Link to="/#use-cases" className="text-accent hover:underline">
            Use Cases
          </Link>
          <span className="text-foreground/30">/</span>
          <span className="truncate text-foreground/50">{uc.service}</span>
        </motion.nav>

        {/* Title row: huge outcome h1 left, metric stack right */}
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
          <motion.div {...reveal}>
            <div
              className="text-[11px] font-bold tracking-widest"
              style={{ color: uc.accent }}
            >
              {uc.service}
            </div>
            <h1
              className="mt-4 max-w-3xl font-bold tracking-tight text-foreground"
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 'clamp(2.2rem, 5.5vw, 3.6rem)',
                lineHeight: 1.08,
              }}
            >
              {uc.title}
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-foreground/60">{uc.teaser}</p>
          </motion.div>

          {/* Metric cards, staggered like the reference stack */}
          <div className="flex flex-col gap-4 lg:pt-2">
            {uc.metrics.map((m, i) => (
              <motion.div
                key={m.label}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.15, duration: 0.55, ease: EASE_OUT_EXPO }}
                className="rounded-2xl border border-foreground/8 bg-background/60 p-5 shadow-[0_10px_30px_rgba(25,40,55,0.06)]"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold tracking-tight text-foreground">{m.value}</span>
                  <span className="text-sm font-semibold text-foreground/60">{m.label}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-foreground/50">{m.note}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Body row: products rail left, story right */}
        <div className="mt-14 grid gap-10 lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* Products used (sticky rail) */}
          <aside>
            <div className="lg:sticky lg:top-24">
              <div className="rounded-2xl border border-border bg-card p-6">
                <div className="text-[11px] font-bold tracking-widest text-foreground/50">
                  Products used
                </div>
                <div className="mt-3">
                  {uc.products.map((p) => (
                    <ProductLink key={p.name} p={p} />
                  ))}
                </div>
              </div>
            </div>
          </aside>

          <article className="min-w-0">
            {/* Principle quote, in place of the reference's customer quote */}
            <motion.blockquote
              {...reveal}
              className="border-l-2 pl-6 text-xl font-semibold leading-relaxed text-foreground sm:text-2xl"
              style={{ borderColor: uc.accent }}
            >
              &lsquo;{uc.principle}&rsquo;
              <footer className="mt-3 text-sm font-normal text-foreground/50">
                The A-Identity principle
              </footer>
            </motion.blockquote>

            {/* Cover art */}
            <motion.div
              {...reveal}
              className="mt-10 aspect-[16/7] w-full overflow-hidden rounded-2xl"
            >
              <BlogCover accent={uc.accent} seed={uc.seed} className="h-full w-full" />
            </motion.div>

            {/* Sections */}
            <div className="mt-10 flex flex-col gap-10">
              {uc.sections.map((s) => (
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

            {/* CTA */}
            <div className="mt-12 rounded-2xl border border-accent/20 bg-accent/[0.05] p-7">
              <h3 className="text-lg font-bold tracking-tight text-foreground">
                Run this with your own agent.
              </h3>
              <p className="mt-2 text-sm text-foreground/65">
                Register it, set the permissions, and watch it in Agent House. Arc testnet,
                real rails, you in the tower.
              </p>
              <Link
                to="/signup"
                className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
              >
                Get Your Agent ID <ArrowUpRight size={15} />
              </Link>
            </div>
          </article>
        </div>

        {/* Explore more use cases */}
        <section className="mt-20 border-t border-border pt-12">
          <h2
            className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Explore more use cases
          </h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            {more.map((u) => (
              <Link
                key={u.slug}
                to={`/use-cases/${u.slug}`}
                className="group relative flex h-[300px] flex-col justify-end overflow-hidden rounded-3xl"
              >
                <BlogCover
                  accent={u.accent}
                  seed={u.seed}
                  className="absolute inset-0 h-full w-full transition-transform duration-700 group-hover:scale-[1.05]"
                />
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      'linear-gradient(to top, rgba(10,17,24,0.92) 0%, rgba(10,17,24,0.4) 55%, rgba(10,17,24,0.1) 100%)',
                  }}
                />
                <div className="relative p-6">
                  <div className="text-[11px] font-bold tracking-widest text-white/60">
                    {u.service}
                  </div>
                  <h3 className="mt-1.5 text-xl font-bold leading-snug tracking-tight text-white">
                    {u.title}
                  </h3>
                  <div className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-white/90">
                    Learn more
                    <ArrowRight
                      size={15}
                      className="transition-transform duration-300 group-hover:translate-x-1"
                    />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
