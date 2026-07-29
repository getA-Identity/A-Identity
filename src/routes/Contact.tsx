import { useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { Bot, Check, Handshake, Mail, Megaphone } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import { CAL_URL, CONTACT, DOCS_URL, EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const CHANNELS = [
  {
    icon: Bot,
    title: 'Developers and agents',
    body: 'Integration questions, SDK or MCP help, agent onboarding.',
    action: { label: 'Read the docs', href: DOCS_URL, external: true },
  },
  {
    icon: Handshake,
    title: 'Partnerships',
    body: 'Wallets, chains, and platforms that want to support Know Your Agent.',
    action: { label: CONTACT.hello, href: `mailto:${CONTACT.hello}` },
  },
  {
    icon: Megaphone,
    title: 'Press',
    body: 'Story requests and brand assets.',
    action: { label: 'Brand kit', href: '/brand' },
  },
]

export default function Contact() {
  const [sent, setSent] = useState(false)
  const [topic, setTopic] = useState('Developers')

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setSent(true)
  }

  const input =
    'w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground outline-none transition-colors focus:border-accent placeholder:text-foreground/40'

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[980px] px-5 py-16 sm:px-8 sm:py-24">
        <motion.span {...reveal} className="text-sm font-semibold tracking-wide text-accent">
          Contact
        </motion.span>
        <motion.h1
          {...reveal}
          className="mt-4 text-4xl font-bold leading-[1.1] tracking-tight text-foreground sm:text-5xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Talk to a human.
        </motion.h1>
        <motion.p {...reveal} className="mt-6 max-w-2xl text-lg leading-relaxed text-foreground/65">
          Agents reach us through the protocol. People can use the form, or email{' '}
          <a href={`mailto:${CONTACT.agents}`} className="font-semibold text-accent hover:underline">
            {CONTACT.agents}
          </a>
          .
        </motion.p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Form */}
          <motion.div {...reveal} className="rounded-3xl border border-border bg-card p-7 sm:p-8">
            {sent ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Check size={24} />
                </div>
                <h2 className="mt-4 text-xl font-bold text-foreground">Message queued.</h2>
                <p className="mt-2 max-w-sm text-sm text-foreground/55">
                  This is a preview form, so nothing was sent. In production it would route to the
                  right inbox. For now, email us directly at {CONTACT.hello}.
                </p>
                <button
                  type="button"
                  onClick={() => setSent(false)}
                  className="mt-5 rounded-full border border-foreground/15 px-5 py-2.5 text-sm font-semibold text-foreground/70 transition-colors hover:bg-foreground/5"
                >
                  Send another
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <input className={input} placeholder="Name" required />
                  <input className={input} type="email" placeholder="Email" required />
                </div>
                <select
                  className={input}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                >
                  <option>Developers</option>
                  <option>Partnerships</option>
                  <option>Press</option>
                  <option>Something else</option>
                </select>
                <textarea
                  className={`${input} min-h-[140px] resize-y`}
                  placeholder="How can we help?"
                  required
                />
                <button
                  type="submit"
                  className="mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.02]"
                >
                  <Mail size={16} />
                  Send message
                </button>
                <p className="text-xs text-foreground/40">
                  Preview form. No data leaves your browser.
                </p>
              </form>
            )}
          </motion.div>

          {/* Channels */}
          <motion.div {...reveal} className="flex flex-col gap-4">
            {CHANNELS.map(({ icon: Icon, title, body, action }) => (
              <div key={title} className="rounded-2xl border border-border bg-card p-5">
                <div className="flex items-center gap-2">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent/10 text-accent">
                    <Icon size={16} />
                  </div>
                  <h3 className="font-semibold text-foreground">{title}</h3>
                </div>
                <p className="mt-2 text-sm text-foreground/60">{body}</p>
                <a
                  href={action.href}
                  {...(action.href.startsWith('http')
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                  className="mt-3 inline-block text-sm font-semibold text-accent hover:underline"
                >
                  {action.label}
                </a>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Booking. An embedded calendar beats a mailto for anything with a clock attached:
            the visitor leaves with a time, not with an intention. The iframe keeps the page
            self-contained; the link below it is the fallback for blockers. */}
        <motion.div {...reveal} className="mt-12">
          <h2 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            Or just book a call.
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/55">
            Fifteen minutes with the founders. Pick a slot that suits you.
          </p>
          <div className="mt-6 overflow-hidden rounded-3xl border border-border bg-card">
            <iframe
              src={`${CAL_URL}?embed=true&theme=auto`}
              title="Book a call with A-Identity"
              loading="lazy"
              className="h-[680px] w-full"
            />
          </div>
          <a
            href={CAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm font-semibold text-accent hover:underline"
          >
            Calendar not loading? Open it directly.
          </a>
        </motion.div>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
