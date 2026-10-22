import { Fragment, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { reveal } from '../ui/section'
import { cn } from '../../lib/utils'
import { CHAINS } from '../../lib/chains'
import { LANDSCAPE, ourRow, REVISED, SOURCES, type LandscapeGroup, type LandscapeRow } from './content'

const COLUMNS = ['Approach', 'Who runs it', 'Identity model', 'Where limits live', 'Open or permissioned', 'Status, dated'] as const
const FIELDS: readonly (keyof Pick<LandscapeRow, 'who' | 'identity' | 'limits' | 'access' | 'status'>)[] = [
  'who',
  'identity',
  'limits',
  'access',
  'status',
]

function sourceId(n: number) {
  return `manifesto-source-${n}`
}

/** Footnote marks after a cell, each one a jump to the numbered source. */
function Refs({ refs }: { refs: readonly number[] }) {
  if (refs.length === 0) return null
  return (
    <sup className="ml-1 whitespace-nowrap font-mono text-[10px] text-accent">
      {refs.map((n, i) => (
        <Fragment key={n}>
          {i > 0 && ', '}
          <a href={`#${sourceId(n)}`} className="hover:underline">
            {n}
          </a>
        </Fragment>
      ))}
    </sup>
  )
}

function Cell({ children, ours }: { children: ReactNode; ours?: boolean }) {
  return (
    <td
      className={cn(
        'border-t border-border px-4 py-3.5 align-top text-[13px] leading-relaxed [overflow-wrap:anywhere]',
        ours ? 'text-foreground/85' : 'text-foreground/70',
      )}
    >
      {children}
    </td>
  )
}

function Table({ groups }: { groups: readonly LandscapeGroup[] }) {
  return (
    <div className="hidden overflow-hidden rounded-2xl border border-border bg-card lg:block">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[17%]" />
          <col className="w-[15%]" />
          <col className="w-[24%]" />
          <col className="w-[16%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c}
                scope="col"
                className="px-4 py-3 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-foreground/45"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.label}>
              <tr>
                <th
                  colSpan={COLUMNS.length}
                  scope="colgroup"
                  className="border-t border-border bg-foreground/[0.03] px-4 py-2 text-left font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-accent"
                >
                  {g.label}
                </th>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.name} className={r.ours ? 'bg-accent/[0.05]' : undefined}>
                  <th
                    scope="row"
                    className="border-t border-border px-4 py-3.5 text-left align-top text-[13px] font-semibold leading-relaxed text-foreground [overflow-wrap:anywhere]"
                  >
                    {r.name}
                  </th>
                  <Cell ours={r.ours}>{r.who}</Cell>
                  <Cell ours={r.ours}>{r.identity}</Cell>
                  <Cell ours={r.ours}>{r.limits}</Cell>
                  <Cell ours={r.ours}>{r.access}</Cell>
                  <Cell ours={r.ours}>
                    {r.status}
                    <Refs refs={r.refs} />
                  </Cell>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const FIELD_LABEL: Record<(typeof FIELDS)[number], string> = {
  who: 'Who runs it',
  identity: 'Identity model',
  limits: 'Where limits live',
  access: 'Open or permissioned',
  status: 'Status, dated',
}

function Cards({ groups }: { groups: readonly LandscapeGroup[] }) {
  return (
    <div className="flex flex-col gap-8 lg:hidden">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-accent">{g.label}</div>
          <ul className="mt-3 flex flex-col gap-3">
            {g.rows.map((r) => (
              <li
                key={r.name}
                className={cn(
                  'rounded-2xl border p-4 sm:p-5',
                  r.ours ? 'border-accent/40 bg-accent/[0.05]' : 'border-border bg-card',
                )}
              >
                <div className="text-base font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
                  {r.name}
                </div>
                <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-3 gap-y-2 text-[13px] leading-relaxed sm:grid-cols-[120px_1fr]">
                  {FIELDS.map((f) => (
                    <Fragment key={f}>
                      <dt className="pt-0.5 font-mono text-[10px] uppercase leading-snug tracking-[0.12em] text-foreground/45">
                        {FIELD_LABEL[f]}
                      </dt>
                      <dd className="text-foreground/75 [overflow-wrap:anywhere]">
                        {r[f]}
                        {f === 'status' && <Refs refs={r.refs} />}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function Sources() {
  return (
    <div className="mt-10">
      <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-foreground/45">Sources</div>
      <p className="mt-2 max-w-[760px] text-[13px] leading-relaxed text-foreground/55">
        Each row cites what we read, by number. Every page below was read on {REVISED}; the date after a
        title is the date the source itself carries.
      </p>
      <ol className="mt-4 grid gap-x-8 gap-y-2 text-[12.5px] leading-relaxed text-foreground/60 md:grid-cols-2">
        {SOURCES.map((s, i) => (
          <li key={s.href} id={sourceId(i + 1)} className="flex gap-2 scroll-mt-24 [overflow-wrap:anywhere]">
            <span className="shrink-0 font-mono text-accent">{String(i + 1).padStart(2, '0')}</span>
            <span>
              {s.org},{' '}
              <a
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground/80 underline decoration-foreground/20 underline-offset-4 transition-colors hover:text-foreground"
              >
                {s.title}
              </a>
              {s.date ? `, ${s.date}` : ''}.
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The landscape as of REVISED: every approach we could verify against a dated source,
 * grouped by the kind of answer it gives, with our own row last and stated in the same
 * terms. The chain counts in that row come from the generated registry mirror, so they
 * move when the registry does rather than when someone remembers to edit this file.
 */
export function Landscape() {
  const counts = {
    live: CHAINS.filter((c) => c.status === 'live').length,
    beta: CHAINS.filter((c) => c.status === 'beta').length,
    planned: CHAINS.filter((c) => c.status === 'planned').length,
  }
  const groups: readonly LandscapeGroup[] = [...LANDSCAPE, { label: 'This project', rows: [ourRow(counts)] }]
  return (
    <motion.div {...reveal} className="mt-10">
      <Table groups={groups} />
      <Cards groups={groups} />
      <Sources />
    </motion.div>
  )
}
