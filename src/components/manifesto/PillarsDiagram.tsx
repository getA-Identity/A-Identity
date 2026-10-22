import { motion } from 'framer-motion'
import { VerdictBadge, type Verdict } from '../ui/badge'
import { reveal } from '../ui/section'
import { GATE, PILLARS } from './content'

/**
 * The four pillars as the path one action takes: identity, authority and boundaries in
 * sequence, the gate that answers ALLOW, WARN or DENY, then the receipt that survives and
 * feeds the next check. Drawn as inline SVG so it scales with its box and paints from the
 * same tokens as the page: currentColor for structure, var(--accent) for the product nouns,
 * var(--ok) / var(--warn) / var(--danger) for the verdicts. No raster, no second palette.
 *
 * Text inside an SVG scales with the viewBox, so below the lg breakpoint the drawing
 * would shrink its labels past legibility (inside the 1040px measure the 1040-unit drawing
 * is about 650px wide at 768px, which puts a 12px label near 8px). There the same words
 * render as a stacked list instead: one diagram, two layouts, identical content.
 */

const ROW_Y = 95
const NODE_H = 110
const MID = ROW_Y + NODE_H / 2
const ACTION = { x: 20, w: 92 }
const NODES = [
  { x: 138, w: 150 },
  { x: 314, w: 150 },
  { x: 490, w: 150 },
] as const
const GATE_BOX = { x: 666, w: 132, y: 56, h: 180 }
const LAST = { x: 824, w: 196 }
const RETURN_Y = 306
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

const VERDICTS: readonly { verdict: Verdict; token: string; cy: number }[] = [
  { verdict: 'ALLOW', token: 'var(--ok)', cy: 107 },
  { verdict: 'WARN', token: 'var(--warn)', cy: 156 },
  { verdict: 'DENY', token: 'var(--danger)', cy: 205 },
]

function PillarNode({
  x,
  w,
  n,
  title,
  question,
  mechanism,
}: {
  x: number
  w: number
  n: string
  title: string
  question: string
  mechanism: string
}) {
  return (
    <g>
      <rect
        x={x}
        y={ROW_Y}
        width={w}
        height={NODE_H}
        rx={16}
        fill="var(--card)"
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeWidth={1}
      />
      <text
        x={x + 16}
        y={ROW_Y + 28}
        fontSize={12}
        fontWeight={700}
        letterSpacing="0.1em"
        fontFamily={MONO}
        fill="var(--accent)"
      >
        {n}
      </text>
      <text
        x={x + 16}
        y={ROW_Y + 56}
        fontSize={19}
        fontWeight={700}
        fill="currentColor"
        style={{ fontFamily: 'var(--font-heading)' }}
      >
        {title}
      </text>
      <text x={x + 16} y={ROW_Y + 78} fontSize={13} fill="currentColor" fillOpacity={0.62}>
        {question}
      </text>
      <text x={x + 16} y={ROW_Y + 97} fontSize={12} fontWeight={600} fill="var(--accent)">
        {mechanism}
      </text>
    </g>
  )
}

function Drawing() {
  const [p1, p2, p3, p4] = PILLARS
  const gateCx = GATE_BOX.x + GATE_BOX.w / 2
  const lastCx = LAST.x + LAST.w / 2
  const firstCx = NODES[0].x + NODES[0].w / 2
  return (
    <svg
      viewBox="0 0 1040 330"
      role="img"
      aria-labelledby="manifesto-pillars-title manifesto-pillars-desc"
      className="h-auto w-full text-foreground"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <title id="manifesto-pillars-title">The four pillars an action passes through</title>
      <desc id="manifesto-pillars-desc">
        An action passes through Identity, Authority and Boundaries, reaches a gate that answers
        ALLOW, WARN or DENY, and ends in Accountability, where a receipt survives and feeds the
        next check.
      </desc>
      <defs>
        <marker
          id="manifesto-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {/* connectors */}
      <g fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.5}>
        <path d={`M${ACTION.x + ACTION.w} ${MID} H${NODES[0].x}`} markerEnd="url(#manifesto-arrow)" />
        <path d={`M${NODES[0].x + NODES[0].w} ${MID} H${NODES[1].x}`} markerEnd="url(#manifesto-arrow)" />
        <path d={`M${NODES[1].x + NODES[1].w} ${MID} H${NODES[2].x}`} markerEnd="url(#manifesto-arrow)" />
        <path d={`M${NODES[2].x + NODES[2].w} ${MID} H${GATE_BOX.x}`} markerEnd="url(#manifesto-arrow)" />
        {/* ALLOW leaves the gate and continues to the receipt */}
        <path
          d={`M${GATE_BOX.x + GATE_BOX.w} ${VERDICTS[0].cy} H811 V${MID} H${LAST.x}`}
          markerEnd="url(#manifesto-arrow)"
        />
        {/* the receipt feeds the next identity read */}
        <path
          d={`M${lastCx} ${ROW_Y + NODE_H} V${RETURN_Y} H${firstCx} V${ROW_Y + NODE_H}`}
          strokeDasharray="5 6"
          markerEnd="url(#manifesto-arrow)"
        />
      </g>

      {/* the action */}
      <g>
        <rect
          x={ACTION.x}
          y={MID - 30}
          width={ACTION.w}
          height={60}
          rx={30}
          fill="currentColor"
          fillOpacity={0.05}
          stroke="currentColor"
          strokeOpacity={0.18}
        />
        <text x={ACTION.x + ACTION.w / 2} y={MID - 4} textAnchor="middle" fontSize={12.5} fontWeight={600} fill="currentColor">
          An action
        </text>
        <text
          x={ACTION.x + ACTION.w / 2}
          y={MID + 14}
          textAnchor="middle"
          fontSize={11.5}
          fill="currentColor"
          fillOpacity={0.6}
        >
          is requested
        </text>
      </g>

      <PillarNode x={NODES[0].x} w={NODES[0].w} n={p1.n} title={p1.title} question={p1.question} mechanism={p1.mechanism} />
      <PillarNode x={NODES[1].x} w={NODES[1].w} n={p2.n} title={p2.title} question={p2.question} mechanism={p2.mechanism} />
      <PillarNode x={NODES[2].x} w={NODES[2].w} n={p3.n} title={p3.title} question={p3.question} mechanism={p3.mechanism} />

      {/* the gate */}
      <g>
        <rect
          x={GATE_BOX.x}
          y={GATE_BOX.y}
          width={GATE_BOX.w}
          height={GATE_BOX.h}
          rx={18}
          fill="var(--accent)"
          fillOpacity={0.05}
          stroke="var(--accent)"
          strokeOpacity={0.35}
          strokeWidth={1.5}
        />
        <text
          x={gateCx}
          y={GATE_BOX.y + 20}
          textAnchor="middle"
          fontSize={10.5}
          fontWeight={700}
          letterSpacing="0.14em"
          fontFamily={MONO}
          fill="var(--accent)"
        >
          {GATE.label.toUpperCase()}
        </text>
        {VERDICTS.map((v) => (
          <g key={v.verdict}>
            <rect
              x={GATE_BOX.x + 12}
              y={v.cy - 17}
              width={GATE_BOX.w - 24}
              height={34}
              rx={17}
              fill={v.token}
              fillOpacity={0.12}
              stroke={v.token}
              strokeOpacity={0.45}
            />
            <text
              x={gateCx}
              y={v.cy + 4.5}
              textAnchor="middle"
              fontSize={12.5}
              fontWeight={800}
              letterSpacing="0.1em"
              fill={v.token}
            >
              {v.verdict}
            </text>
          </g>
        ))}
      </g>

      <PillarNode x={LAST.x} w={LAST.w} n={p4.n} title={p4.title} question={p4.question} mechanism={p4.mechanism} />

      {/* what the other two verdicts do */}
      <g fontSize={12} fill="currentColor" fillOpacity={0.62}>
        <circle cx={592} cy={246} r={3.5} fill="var(--warn)" fillOpacity={1} />
        <text x={602} y={250}>
          {GATE.warn}
        </text>
        <circle cx={592} cy={266} r={3.5} fill="var(--danger)" fillOpacity={1} />
        <text x={602} y={270}>
          {GATE.deny}
        </text>
      </g>

      {/* the loop */}
      <text x={430} y={RETURN_Y - 9} textAnchor="middle" fontSize={12} fill="currentColor" fillOpacity={0.62}>
        {GATE.loop}
      </text>
    </svg>
  )
}

/** The same path, stacked, for widths where the drawing would shrink its labels. */
function StackedList() {
  const steps = PILLARS.slice(0, 3)
  const last = PILLARS[3]
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((p) => (
        <PillarCard key={p.n} n={p.n} title={p.title} question={p.question} mechanism={p.mechanism} line={p.line} />
      ))}
      <li className="rounded-2xl border border-accent/35 bg-accent/[0.05] p-4">
        <div className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-accent">{GATE.label}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {VERDICTS.map((v) => (
            <VerdictBadge key={v.verdict} verdict={v.verdict} size="md" />
          ))}
        </div>
        <ul className="mt-3 flex flex-col gap-1 text-sm leading-relaxed text-foreground/65">
          <li>{GATE.allow}</li>
          <li>{GATE.warn}</li>
          <li>{GATE.deny}</li>
        </ul>
      </li>
      <PillarCard n={last.n} title={last.title} question={last.question} mechanism={last.mechanism} line={last.line} />
      <li className="px-1 text-sm leading-relaxed text-foreground/60">{GATE.loop}</li>
    </ol>
  )
}

function PillarCard({
  n,
  title,
  question,
  mechanism,
  line,
}: {
  n: string
  title: string
  question: string
  mechanism: string
  line: string
}) {
  return (
    <li className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] font-bold tracking-[0.14em] text-accent">{n}</span>
        <span className="text-xs font-semibold text-accent">{mechanism}</span>
      </div>
      <div className="mt-1.5 text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
        {title}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground/70">{question}</div>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground/60">{line}</p>
    </li>
  )
}

export function PillarsDiagram() {
  return (
    <motion.div {...reveal} className="mt-10">
      <div className="hidden rounded-3xl border border-border bg-background p-4 sm:p-6 lg:block">
        <Drawing />
      </div>
      <div className="lg:hidden">
        <StackedList />
      </div>
      {/* The same four sentences under the drawing, so the desktop reader gets the words the
          phone list carries and the boxes stay short enough to draw. */}
      <ul className="mt-6 hidden grid-cols-4 gap-5 lg:grid">
        {PILLARS.map((p) => (
          <li key={p.n} className="text-[13.5px] leading-relaxed text-foreground/60">
            <span className="font-semibold text-foreground/85">{p.title}. </span>
            {p.line}
          </li>
        ))}
      </ul>
    </motion.div>
  )
}
