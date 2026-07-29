import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { apiFetch, readJson } from '../../lib/api'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'
import { Stat } from '../ui/stat'
import OwlMark from '../OwlMark'

/**
 * The oracle as a network: requests flow in from the ring, verdicts come back.
 *
 * The ryvo pattern, with this product's one non-negotiable applied: the NUMBERS are live
 * from /api/traction and shown as counted, zeros included, while the MOTION is openly
 * synthetic and captioned as such. A packet animation that implied each dot was a real
 * transaction would be exactly the kind of fake this product exists to refuse.
 *
 * The choreography still carries the real semantics: most packets reach the centre and
 * settle green, one arrives amber, and one is stopped at the boundary ring and never gets
 * in. That boundary is the product.
 */

type Traction = {
  checks: number
  allow: number
  warn: number
  deny: number
  registeredAgents: number
  protectedNotionalUsd: number
}

const SIZE = 420
const C = SIZE / 2
const NODE_R = 168
const STOP_R = 52
const NODES = 8
/** Which orbit slots misbehave: one warn, one deny. The rest settle clean. */
const TONE: Record<number, string> = { 3: '#d97706', 6: '#dc2626' }

const pt = (i: number, r: number) => {
  const a = (Math.PI * 2 * i) / NODES - Math.PI / 2
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) }
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

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
  const [t, setT] = useState<Traction | null>(null)

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

  return (
    <SectionShell id="traction" size="lg" surface="card">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_460px]">
        <div>
          <SectionIntro
            eyebrow={<Eyebrow>Traction</Eyebrow>}
            heading={
              <DisplayHeading size="section" className="max-w-[14ch]">
                Every check flows through here.
              </DisplayHeading>
            }
            lede={
              <Lede>
                Agents ask, the oracle answers, and the counters below are exactly what the
                engine has counted so far. Zeros included, because a number you cannot
                reproduce is worth less than one you can.
              </Lede>
            }
          />

          <motion.div {...reveal} className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Policy checks" value={(t?.checks ?? 0).toLocaleString('en-US')} />
            <Stat label="Allowed" value={(t?.allow ?? 0).toLocaleString('en-US')} />
            <Stat label="Denied" value={(t?.deny ?? 0).toLocaleString('en-US')} />
            <Stat label="Protected" value={usd(t?.protectedNotionalUsd ?? 0)} />
          </motion.div>
          <motion.p {...reveal} className="mt-4 text-xs text-foreground/40">
            Counters live from{' '}
            <a
              href="https://a-identity-backend.onrender.com/api/traction"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-accent hover:underline"
            >
              /api/traction
            </a>
            . The motion is illustrative; the boundary is not.
          </motion.p>
        </div>

        <motion.div {...reveal} className="mx-auto w-full max-w-[460px]">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full text-foreground" aria-hidden="true">
            {/* Orbit and boundary rings. The inner ring is the policy boundary a denied
                packet never crosses. */}
            <circle cx={C} cy={C} r={NODE_R} fill="none" stroke="currentColor" strokeOpacity={0.1} />
            <circle cx={C} cy={C} r={STOP_R} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeDasharray="3 5" />
            {Array.from({ length: NODES }, (_, i) => {
              const p = pt(i, NODE_R)
              return (
                <g key={i}>
                  <line x1={p.x} y1={p.y} x2={C} y2={C} stroke="currentColor" strokeOpacity={0.07} />
                  <circle cx={p.x} cy={p.y} r={7} fill="currentColor" fillOpacity={0.1} />
                  <circle cx={p.x} cy={p.y} r={3} fill="currentColor" fillOpacity={0.4} />
                </g>
              )
            })}
            {Array.from({ length: NODES }, (_, i) => (
              <Packet key={i} i={i} reduced={reduced} />
            ))}
          </svg>
          {/* The oracle at the centre, overlaid so the mark stays crisp DOM rather than SVG. */}
          <div className="pointer-events-none relative mx-auto -mt-[56%] mb-[44%] flex h-0 items-center justify-center">
            <div className="grid h-20 w-20 place-items-center rounded-full border border-border bg-background shadow-[0_10px_40px_-12px_rgba(16,24,40,0.35)]">
              <OwlMark size={44} />
            </div>
          </div>
        </motion.div>
      </div>
    </SectionShell>
  )
}
