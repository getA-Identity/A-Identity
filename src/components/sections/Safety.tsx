import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, KeyRound, Layers, Radio, UserCheck } from 'lucide-react'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The safety section, in the Robinhood manner: the containment IS the feature, said in one
 * place rather than scattered through the FAQ.
 *
 * Every claim here is one a reader can check. The three enforcement layers are the three
 * that exist in the code (server pre-check, the on-chain vault that reverts, Circle's wallet
 * screening); the guardrail endpoint is live and answers 503 when the engine is not
 * enforcing, so the button below runs it rather than describing it; and the testnet line is
 * on the page because a product that hides which network it is on has already told you
 * something.
 */

const GUARDRAIL_URL = 'https://a-identity-backend.onrender.com/api/guardrail-status'

const CARDS = [
  {
    Icon: KeyRound,
    title: 'We never hold your keys',
    body:
      'There is no endpoint that accepts a private key, a recovery phrase or brokerage credentials, because we never want to be the reason someone loses them. Funds stay in your own wallet or account.',
  },
  {
    Icon: Layers,
    title: 'One limit, enforced three times',
    body:
      'A cap you set is checked by the server before anything moves, again by your on-chain vault (an over-limit payment reverts on Arc, whoever signs it), and again by Circle at the wallet layer. Any one of them can refuse.',
  },
  {
    Icon: UserCheck,
    title: 'A human stays in the tower',
    body:
      'Anything above the auto-approve line waits for a person. The agent can work at machine speed inside the line you drew and cannot argue its way past it, because the rules are checked outside the model.',
  },
]

type Probe = { code: number | null; ms: number; ok: boolean } | null

export default function Safety() {
  const [checking, setChecking] = useState(false)
  const [probe, setProbe] = useState<Probe>(null)

  const runProbe = async () => {
    setChecking(true)
    setProbe(null)
    const t0 = performance.now()
    try {
      const r = await fetch(GUARDRAIL_URL, { cache: 'no-store' })
      setProbe({ code: r.status, ms: Math.round(performance.now() - t0), ok: r.ok })
    } catch {
      setProbe({ code: null, ms: Math.round(performance.now() - t0), ok: false })
    }
    setChecking(false)
  }

  return (
    <SectionShell id="safety" size="lg" backdrop="console" backdropPosition="right">
      <SectionIntro
        eyebrow={<Eyebrow>Designed for safety</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            The limits are the product.
          </DisplayHeading>
        }
        lede={
          <Lede>
            An agent that can move money is only as safe as what stops it. Here is exactly what
            stops it, and how to check that we are telling the truth.
          </Lede>
        }
      />

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {CARDS.map(({ Icon, title, body }, i) => (
          <motion.div
            key={title}
            {...revealAt(i)}
            className="rounded-2xl border border-border bg-card p-6"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-background/60 text-accent">
              <Icon size={18} />
            </span>
            <h3 className="mt-4 text-lg font-bold tracking-tight text-foreground">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-foreground/55">{body}</p>
          </motion.div>
        ))}
      </div>

      {/* The honesty row: the network we are actually on, and a button that proves the engine
          is enforcing rather than a badge that claims it. */}
      <motion.div
        {...reveal}
        transition={{ ...reveal.transition, delay: 0.12 }}
        className="mt-5 grid gap-5 rounded-2xl border border-border bg-card p-6 md:grid-cols-2"
      >
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground">
            <Radio size={17} className="text-accent" />
            Check the engine yourself
          </h3>
          <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-foreground/55">
            This endpoint runs the real policy engine on request and answers 503 if it is not
            enforcing. You do not have to take our word for whether the guardrails are up.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button
              type="button"
              onClick={runProbe}
              disabled={checking}
              className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-5 py-2.5 text-sm font-semibold text-accent transition hover:bg-accent/15 disabled:opacity-60"
            >
              <Radio size={15} className={checking ? 'animate-pulse' : ''} />
              {checking ? 'Running the engine…' : 'Run the guardrail check'}
            </button>
            {probe && (
              <motion.span
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                className="font-mono text-xs text-foreground/60"
              >
                <span
                  className={
                    probe.ok
                      ? 'font-bold text-emerald-600 dark:text-emerald-400'
                      : 'font-bold text-amber-600 dark:text-amber-500'
                  }
                >
                  {probe.code === null ? 'no response' : `HTTP ${probe.code}`}
                </span>{' '}
                · {probe.ms}ms · {probe.ok ? 'enforcing' : 'not enforcing right now'}
              </motion.span>
            )}
            <a
              href={GUARDRAIL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              Open the endpoint <ArrowUpRight size={14} />
            </a>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-background/50 p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/40">
            What we are careful to say
          </p>
          <ul className="mt-3 flex flex-col gap-2.5 text-sm leading-relaxed text-foreground/60">
            <li>
              <span className="font-semibold text-foreground">Arc is a testnet.</span> Real
              contracts, real transactions, test money. We label it rather than blur it.
            </li>
            <li>
              <span className="font-semibold text-foreground">KYA is a wallet proof</span>, recorded
              on-chain. It shows an agent controls its wallet. It is not a third-party audit of
              the agent's behaviour.
            </li>
            <li>
              <span className="font-semibold text-foreground">Circle screens, we cap.</span> The
              wallet layer screens transfers for sanctions and blocks; the spend limit is enforced
              by our server and your vault.
            </li>
          </ul>
        </div>
      </motion.div>
    </SectionShell>
  )
}
