import { motion } from 'framer-motion'
import { Check, X } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import Logo from '../components/Logo'
import { APP_NAME, EASE_OUT_EXPO } from '../lib/brand'
import { usePageMeta } from '../lib/head'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const CORE_COLORS = [
  { name: 'Ink', hex: '#192837', note: 'Primary text and dark surfaces' },
  { name: 'Accent', hex: '#7342E2', note: 'Brand purple, actions and links' },
  { name: 'Cream', hex: '#F2F2EE', note: 'Light background' },
  { name: 'Sand', hex: '#CFC8C5', note: 'Muted surface' },
]

const PROTOCOL_COLORS = [
  { name: 'ERC-8004', hex: '#7342E2' },
  { name: 'x402 / USDC', hex: '#2775CA' },
  { name: 'MCP', hex: '#1AAB7A' },
  { name: 'USDT', hex: '#26A17B' },
  { name: 'PYUSD', hex: '#0E2A8C' },
]

function Swatch({ name, hex, note }: { name: string; hex: string; note?: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="h-24 w-full" style={{ background: hex }} />
      <div className="p-4">
        <div className="text-sm font-semibold text-foreground">{name}</div>
        <div className="font-mono text-xs text-foreground/45">{hex}</div>
        {note && <div className="mt-1 text-xs text-foreground/50">{note}</div>}
      </div>
    </div>
  )
}

export default function Brand() {
  usePageMeta({
    title: `Brand · ${APP_NAME}`,
    description:
      'Logo, colour and typography rules for A-Identity, with the protocol palette and the things not to do. Everything on this page is free to reuse as specified.',
    canonical: 'https://a-identity.xyz/brand',
  })

  return (
    <ThemeScope className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[980px] px-5 py-16 sm:px-8 sm:py-24">
        <motion.span {...reveal} className="text-sm font-semibold tracking-wide text-accent">
          Brand
        </motion.span>
        <motion.h1
          {...reveal}
          className="mt-4 text-4xl font-bold leading-[1.1] tracking-tight text-foreground sm:text-5xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Brand and press kit.
        </motion.h1>
        <motion.p {...reveal} className="mt-6 max-w-2xl text-lg leading-relaxed text-foreground/65">
          The basics for writing about {APP_NAME} or placing the mark. Keep the name as one word,
          hyphenated, with a capital A and a capital I: A-Identity.
        </motion.p>

        {/* Logo */}
        <motion.section {...reveal} className="mt-14">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Logo</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Both swatches pass an explicit fill. These two panels demonstrate the mark on
                a FIXED light and a FIXED dark background, so unlike every other placement
                they must not inherit the surrounding text color. */}
            <div className="flex items-center justify-center rounded-2xl border border-[#192837]/10 bg-white p-12">
              <div className="flex items-center gap-3">
                <Logo size={40} fill="#192837" />
                <span className="text-2xl font-bold tracking-tight text-foreground">{APP_NAME}</span>
              </div>
            </div>
            <div className="flex items-center justify-center rounded-2xl border border-white/10 p-12" style={{ background: '#192837' }}>
              <div className="flex items-center gap-3">
                <Logo size={40} fill="#ffffff" />
                <span className="text-2xl font-bold tracking-tight text-white">{APP_NAME}</span>
              </div>
            </div>
          </div>
        </motion.section>

        {/* Core colors */}
        <motion.section {...reveal} className="mt-14">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Core palette</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {CORE_COLORS.map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>
        </motion.section>

        {/* Protocol colors */}
        <motion.section {...reveal} className="mt-12">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Protocol and token colors</h2>
          <p className="mt-1 text-sm text-foreground/55">
            Use the official color when naming a protocol or stablecoin.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {PROTOCOL_COLORS.map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>
        </motion.section>

        {/* Typography */}
        <motion.section {...reveal} className="mt-14">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Typography</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-6">
              <div className="text-xs font-semibold text-foreground/45">Headings</div>
              <div className="mt-2 text-3xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
                Helvetica Now Display
              </div>
              <p className="mt-2 text-sm text-foreground/55">Bold, tight tracking, Title Case for labels.</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-6">
              <div className="text-xs font-semibold text-foreground/45">Body</div>
              <div className="mt-2 text-2xl font-semibold text-foreground">Inter</div>
              <p className="mt-2 text-sm text-foreground/55">Sentence case, plain punctuation, short lines.</p>
            </div>
          </div>
        </motion.section>

        {/* Usage */}
        <motion.section {...reveal} className="mt-14">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Usage</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                <Check size={16} /> Do
              </div>
              <ul className="flex flex-col gap-2 text-sm text-foreground/70">
                <li>Write the name as A-Identity, one word, hyphenated.</li>
                <li>Give the mark clear space on cream or ink backgrounds.</li>
                <li>Use the accent purple for primary actions.</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-6">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-600 dark:text-red-400">
                <X size={16} /> Do not
              </div>
              <ul className="flex flex-col gap-2 text-sm text-foreground/70">
                <li>Do not recolor or stretch the logo.</li>
                <li>Do not write it as Aidentity, A Identity, or AIdentity.</li>
                <li>Do not place the mark on a busy photo without a panel.</li>
              </ul>
            </div>
          </div>
        </motion.section>

        <motion.p {...reveal} className="mt-12 text-sm text-foreground/50">
          Need an asset that is not here? Reach us on the{' '}
          <a href="/contact" className="font-semibold text-accent hover:underline">
            contact page
          </a>
          .
        </motion.p>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
