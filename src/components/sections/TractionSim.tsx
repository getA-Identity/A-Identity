import { useEffect, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { apiFetch, readJson } from '../../lib/api'
import { ASP_BASE } from '../../lib/mcpBase'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'
import { Stat } from '../ui/stat'
import OwlMark from '../OwlMark'

/**
 * The oracle as a network: requests flow in from the ring, verdicts come back.
 *
 * The ryvo pattern, with this product's one non-negotiable applied: the NUMBERS are live
 * from three counters the backend already publishes and shown as counted, zeros included,
 * while the MOTION is openly synthetic and captioned as such. A packet animation that
 * implied each dot was a real transaction would be exactly the kind of fake this product
 * exists to refuse.
 *
 * The choreography still carries the real semantics: most packets reach the centre and
 * settle green, one arrives amber, and one is stopped at the boundary ring and never gets
 * in. That boundary is the product.
 *
 * This section used to carry two rows, one per engine, never mixed. The policy-engine row
 * (/api/traction) was removed on 2026-08-25: its counters are genuinely at zero and the
 * maintainer decided a row of zeros does not belong on a landing page. The endpoint and the
 * FAQ entry that names the zeros are both unchanged, so nothing here contradicts anything
 * there; the figure is simply no longer rendered. Restore it when the engine has decided
 * something.
 *
 * What remains is the x402 settlement engines on X Layer and Celo, which are not at zero.
 * Each row says which endpoint it came from and links to it, so every figure on the page
 * can be re-read by the person reading it.
 */

/** GET https://a-identity-asp.onrender.com/proof.json: the X Layer ASP's settlement ledger. */
type XLayerProof = {
  realOnchainRevenue?: { totalSettlements?: number; totalUsd?: number }
}

/** GET /api/celo/proof: the Celo facilitator's ledger, with our own traffic labeled. */
type CeloProof = {
  totalSettlements: number
  totalUsd: number
  /** An older backend that predates the split simply omits these. */
  internalSettlements?: number
  externalSettlements?: number
}

/** One feed: read, still reading, or asked and did not answer. Never silently zero. */
type Feed<T> = { value: T | null; failed: boolean }
const READING = { value: null, failed: false }

const XLAYER_PROOF_JSON = 'https://a-identity-asp.onrender.com/proof.json'
const XLAYER_PROOF_PAGE = 'https://a-identity-asp.onrender.com/proof'
const CELO_PROOF_API = 'https://a-identity-backend.onrender.com/api/celo/proof'

const SIZE = 420
const C = SIZE / 2
const NODE_R = 168
const STOP_R = 62
const NODES = 8
/** Which orbit slots misbehave: one warn, one deny. The rest settle clean. */
const TONE: Record<number, string> = { 3: '#d97706', 6: '#dc2626' }

const pt = (i: number, r: number) => {
  const a = (Math.PI * 2 * i) / NODES - Math.PI / 2
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) }
}

const count = (n: number) => n.toLocaleString('en-US')
/**
 * A settlement is a fraction of a cent, so it needs three decimals to exist at all, while
 * the protected notional is whole dollars. Rounding a real $0.528 to $1 would be a made-up
 * number, and rounding it to $0 would be a worse one.
 */
const usd = (n: number, maxFrac = 0) =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })}`

/**
 * A number that has actually been read, or an honest placeholder.
 *
 * A feed that has not answered yet must never render as 0. This section's entire claim is
 * that its zeros are counted zeros, so an unread value painted as 0 would be the one lie
 * it exists to refuse: pending shows a pulse, a failed read says it did not answer.
 */
function Value<T>({ feed, of }: { feed: Feed<T>; of: (v: T) => string }) {
  if (feed.value) return <>{of(feed.value)}</>
  if (feed.failed) return <span className="text-sm font-medium text-foreground/60">no answer</span>
  return (
    <span
      className="inline-block h-4 w-12 animate-pulse rounded bg-foreground/10 align-middle"
      aria-label="reading"
    />
  )
}

/** The caption above a row of numbers, naming the engine that counted them. */
function RowLabel({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/60">
      {children}
    </p>
  )
}

function Source({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-accent hover:underline"
    >
      {children}
    </a>
  )
}

function Packet({ i, reduced }: { i: number; reduced: boolean }) {
  const from = pt(i, NODE_R)
  const color = TONE[i] ?? '#059669'
  const denied = TONE[i] === '#dc2626'
  // A denied packet is stopped at the boundary ring; everything else reaches the centre.
  const to = denied ? pt(i, STOP_R) : { x: C, y: C }

  if (reduced) return <circle cx={to.x} cy={to.y} r={4} fill={color} opacity={0.7} />
  return (
    <motion.circle
      r={4.5}
      fill={color}
      initial={{ cx: from.x, cy: from.y, opacity: 0 }}
      animate={{
        cx: [from.x, to.x, to.x],
        cy: [from.y, to.y, to.y],
        opacity: [0, 1, 0],
        scale: denied ? [1, 1, 1.6] : [1, 1, 0.6],
      }}
      transition={{ duration: 3.6, times: [0, 0.55, 1], repeat: Infinity, delay: i * 0.45, ease: 'easeInOut' }}
    />
  )
}

export default function TractionSim() {
  const reduced = useReducedMotion() ?? false
  const [xlayer, setXlayer] = useState<Feed<{ settlements: number; usd: number }>>(READING)
  const [celo, setCelo] = useState<Feed<CeloProof>>(READING)

  useEffect(() => {
    let alive = true

    const load = () => {
      if (!alive) return

      // The /api/traction fetch that stood here went with the policy-engine row. Leaving it
      // would have meant a request on every landing-page load for a figure nobody renders.

      // Fetched through ASP_BASE: the same-origin /asp proxy in prod (ad blockers that
      // list *.onrender.com would otherwise fake an outage), the live ASP directly in
      // dev. The provenance link below still names the real origin.
      fetch(`${ASP_BASE}/proof.json`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: XLayerProof) => {
          if (!alive) return
          const rev = d?.realOnchainRevenue
          if (rev && typeof rev.totalSettlements === 'number')
            setXlayer({
              value: { settlements: rev.totalSettlements, usd: Number(rev.totalUsd ?? 0) },
              failed: false,
            })
          else setXlayer({ value: null, failed: true })
        })
        .catch(() => alive && setXlayer({ value: null, failed: true }))

      apiFetch('/api/celo/proof')
        .then((r) => (r.ok ? readJson<CeloProof>(r) : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          if (!alive) return
          if (d && typeof d.totalSettlements === 'number') setCelo({ value: d, failed: false })
          else setCelo({ value: null, failed: true })
        })
        .catch(() => alive && setCelo({ value: null, failed: true }))
    }

    // Three reads from a section that is well below the fold, against a backend that may
    // be cold: deferred to idle so they are not competing with the hero for a phone's
    // bandwidth. The counters are proof, not the first thing anyone reads.
    const idle = window.requestIdleCallback?.(load, { timeout: 3000 })
    const timer = idle === undefined ? window.setTimeout(load, 1200) : undefined

    return () => {
      alive = false
      if (idle !== undefined) window.cancelIdleCallback?.(idle)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const celoSplit = celo.value
  const hasSplit = celoSplit && typeof celoSplit.internalSettlements === 'number'

  return (
    <SectionShell id="traction" size="lg" surface="card" backdrop="traction" backdropPosition="left">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_460px]">
        <div>
          <SectionIntro
            eyebrow={
              <Eyebrow>
                <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                Traction, live
              </Eyebrow>
            }
            heading={
              <DisplayHeading size="section" className="max-w-[14ch]">
                Every check flows through here.
              </DisplayHeading>
            }
            lede={
              <Lede>
                Agents ask, the oracle answers, and the counters below are exactly what the
                settlement engines have counted so far. Every figure links to the endpoint it
                came from, because a number you cannot reproduce is worth less than one you
                can.
              </Lede>
            }
          />

          {/* The policy-engine row rendered here: checks, allowed, denied, protected, read
              live from /api/traction. Removed from this page on the maintainer's
              instruction, 2026-08-25, because every one of those counters is still zero and
              a row of zeros is not what a landing page is for.

              Nothing about it was inaccurate and the endpoint is unchanged: /api/traction
              still serves the same figures, and the FAQ entry on the policy engine still
              says the counters read zero and links to it. Restore this block the day the
              engine has produced a decision. */}
          <motion.div {...reveal} className="mt-10">
            <RowLabel>x402 settlements, two mainnets</RowLabel>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="X Layer settled" value={<Value feed={xlayer} of={(d) => count(d.settlements)} />} />
              <Stat label="X Layer taken" value={<Value feed={xlayer} of={(d) => usd(d.usd, 3)} />} />
              <Stat label="Celo settled" value={<Value feed={celo} of={(d) => count(d.totalSettlements)} />} />
              <Stat label="Celo taken" value={<Value feed={celo} of={(d) => usd(d.totalUsd, 3)} />} />
            </div>
            <p className="mt-3 text-xs text-foreground/60">
              Live from <Source href={XLAYER_PROOF_JSON}>/proof.json</Source> on X Layer mainnet and{' '}
              <Source href={CELO_PROOF_API}>/api/celo/proof</Source> on Celo mainnet. Every row behind
              these two counters is a real stablecoin transfer, listed one by one on the{' '}
              <Source href={XLAYER_PROOF_PAGE}>proof page</Source>.
              {hasSplit
                ? ` Celo labels whose traffic it is: ${count(celoSplit.internalSettlements ?? 0)} of ${count(celoSplit.totalSettlements)} came from our own payer rather than an outside one.`
                : ''}
            </p>
          </motion.div>

          <motion.p {...reveal} className="mt-4 text-xs text-foreground/60">
            The motion is illustrative; the boundary is not.
          </motion.p>
        </div>

        <motion.div {...reveal} className="relative mx-auto w-full max-w-[460px]">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full text-foreground" aria-hidden="true">
            <defs>
              {/* The oracle's halo: a quiet accent bloom the packets settle into. */}
              <radialGradient id="oracle-halo">
                <stop offset="0%" stopColor="#7342e2" stopOpacity="0.22" />
                <stop offset="60%" stopColor="#7342e2" stopOpacity="0.07" />
                <stop offset="100%" stopColor="#7342e2" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx={C} cy={C} r={120} fill="url(#oracle-halo)" />

            {/* Orbit and boundary rings. The inner ring is the policy boundary a denied
                packet never crosses. */}
            <circle cx={C} cy={C} r={NODE_R} fill="none" stroke="currentColor" strokeOpacity={0.12} />
            <circle cx={C} cy={C} r={STOP_R} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeDasharray="3 5" />
            {Array.from({ length: NODES }, (_, i) => {
              const p = pt(i, NODE_R)
              return (
                <g key={i}>
                  <line x1={p.x} y1={p.y} x2={C} y2={C} stroke="currentColor" strokeOpacity={0.07} />
                  {/* Satellite agents: small tiles instead of specks, so the ring reads
                      as counterparties rather than decoration. */}
                  <rect x={p.x - 11} y={p.y - 11} width={22} height={22} rx={7} fill="var(--card)" stroke="currentColor" strokeOpacity={0.25} />
                  <circle cx={p.x} cy={p.y} r={3.5} fill={TONE[i] ?? 'currentColor'} fillOpacity={TONE[i] ? 0.9 : 0.45} />
                </g>
              )
            })}
            {Array.from({ length: NODES }, (_, i) => (
              <Packet key={i} i={i} reduced={reduced} />
            ))}
          </svg>

          {/* The oracle at the centre, overlaid so the mark stays crisp DOM rather than
              SVG, sized to be unmistakably the subject of the picture. */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2">
              <div className="grid h-24 w-24 place-items-center rounded-[26px] border border-border bg-card shadow-[0_16px_50px_-16px_rgba(115,66,226,0.4),0_10px_40px_-12px_rgba(16,24,40,0.35)]">
                <OwlMark size={60} />
              </div>
              <span className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-foreground/70 shadow-sm">
                Trust oracle
              </span>
            </div>
          </div>
        </motion.div>
      </div>
    </SectionShell>
  )
}
