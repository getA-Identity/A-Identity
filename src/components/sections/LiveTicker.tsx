import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { apiFetch, readJson } from '../../lib/api'

/**
 * The hero's proof column: live counters over a feed of the paid tools.
 *
 * Two kinds of number share this card and they are deliberately labelled apart. The
 * counters come from /api/traction and are whatever the engine has actually counted,
 * including zero, which this product shows rather than hides. The cycling rows are the six
 * paid tools from the OKX listing at their real prices, settled 120 times on-chain, and the
 * card links straight to the proof rather than asking to be believed.
 *
 * The cycle is presentation, not data: rows rotate so the card feels inhabited, but nothing
 * in the rotation claims to be a live transaction. That line matters here more than
 * anywhere, because this card's whole job is to be the thing that is NOT faked.
 */

type Traction = {
  checks: number
  allow: number
  warn: number
  deny: number
  registeredAgents: number
  protectedNotionalUsd: number
}

/** The OKX listing, verbatim: real tools, real prices, 120 settlements on OKLink. */
const TOOLS = [
  { name: 'verify_agent', price: '$0.001' },
  { name: 'reputation_score', price: '$0.002' },
  { name: 'risk_check', price: '$0.005' },
  { name: 'guardrail_check', price: '$0.005' },
  { name: 'counterparty_check', price: '$0.008' },
  { name: 'agent_passport', price: '$0.010' },
]

const VERDICT = [
  { key: 'allow', color: '#059669' },
  { key: 'warn', color: '#d97706' },
  { key: 'deny', color: '#dc2626' },
] as const

export default function LiveTicker() {
  const [t, setT] = useState<Traction | null>(null)
  const [head, setHead] = useState(0)

  useEffect(() => {
    let alive = true
    apiFetch('/api/traction')
      .then((r) => readJson<Traction>(r))
      .then((d) => {
        if (alive && d && typeof d.checks === 'number') setT(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setHead((h) => (h + 1) % TOOLS.length), 2600)
    return () => clearInterval(id)
  }, [])

  const rows = Array.from({ length: 4 }, (_, i) => TOOLS[(head + i) % TOOLS.length])

  return (
    <div className="w-full select-none rounded-3xl border border-border bg-card/85 p-5 shadow-[0_24px_70px_-28px_rgba(16,24,40,0.45)] backdrop-blur-md sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-foreground/45">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Live · trust oracle
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/30">
          X Layer + Arc
        </span>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-mono text-5xl font-bold tabular-nums tracking-tight text-foreground">
          {(t?.checks ?? 0).toLocaleString('en-US')}
        </span>
        <span className="text-xs font-medium text-foreground/45">policy checks</span>
      </div>

      <div className="mt-3 flex items-center gap-4">
        {VERDICT.map(({ key, color }) => (
          <span key={key} className="flex items-center gap-1.5 font-mono text-xs tabular-nums text-foreground/60">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {(t?.[key] ?? 0).toLocaleString('en-US')} {key}
          </span>
        ))}
      </div>

      <div className="mt-5 flex flex-col gap-1.5 border-t border-border pt-4">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((tool) => (
            <motion.div
              key={tool.name}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.35 }}
              className="flex items-center justify-between rounded-lg bg-background/50 px-3 py-2"
            >
              <span className="font-mono text-xs text-foreground/70">{tool.name}</span>
              <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                {tool.price} <span className="font-normal text-foreground/35">USDT</span>
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3.5 text-[11px]">
        <span className="text-foreground/45">120 settlements on OKX.AI · priced as listed</span>
        <a
          href="https://a-identity-asp.onrender.com/proof"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 font-semibold text-accent hover:underline"
        >
          Verify on-chain <ArrowUpRight size={11} />
        </a>
      </div>
    </div>
  )
}
