import { useId, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  EVIDENCE_LABEL,
  EVIDENCE_SENTENCE,
  coverageSentence,
  payersSentence,
  type LogResult,
  type LogSpec,
} from '../../lib/settlement-logs'
import { int } from './format'

/**
 * One settlement log as a tile, shared by /stats and /proof so the two pages print the
 * same label, the same evidence sentence and the same network names for the same log.
 *
 * Its count is the log's own and is never added to another's inside the tile. The copy
 * is built from the shared spec and the normalized read only, so a wording change lands
 * on both pages at once and neither can quietly describe a log the other way.
 */

const Bar = () => (
  <span className="inline-block h-5 w-16 animate-pulse rounded bg-foreground/10 align-middle motion-reduce:animate-none" />
)

/**
 * The evidence kind as a chip. Its sentence sits in the hover title for a mouse and reaches
 * everyone else as well: a tile passes `describedBy`, the id of a visible line that prints
 * the sentence, and a chip on its own carries the sentence as screen-reader text, so a
 * keyboard or a touch screen is never left with the label alone.
 */
export function EvidenceChip({
  kind,
  className = '',
  describedBy,
}: {
  kind: LogSpec['evidence']
  className?: string
  /** The id of a visible element that prints EVIDENCE_SENTENCE[kind]. */
  describedBy?: string
}) {
  const sentence = EVIDENCE_SENTENCE[kind]
  return (
    <span
      title={sentence}
      aria-describedby={describedBy}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-foreground/55 ${className}`}
    >
      <span className="truncate">{EVIDENCE_LABEL[kind]}</span>
      {!describedBy && <span className="sr-only">{`: ${sentence}`}</span>}
    </span>
  )
}

export function LogTile({
  spec,
  result,
  footer,
}: {
  spec: LogSpec
  result: LogResult | undefined
  /** An extra line the page wants under this log, e.g. the Arc season note. */
  footer?: ReactNode
}) {
  const ok = result?.status === 'ok' ? result.read : null
  const failed = result?.status === 'failed'
  const evidenceId = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[11px] uppercase tracking-wide text-foreground/45">{spec.label}</span>
        <EvidenceChip kind={spec.evidence} describedBy={evidenceId} />
      </div>
      <span className="font-mono text-2xl font-bold tracking-tight text-foreground tabular-nums">
        {failed ? '-' : ok ? int(ok.count) : <Bar />}
      </span>
      <span className="text-xs leading-relaxed text-foreground/55">
        {failed
          ? 'This log did not answer just now.'
          : ok
            ? `${coverageSentence(result)} ${payersSentence(spec, result)}`
            : spec.basis}
      </span>
      {ok && <span className="text-xs leading-relaxed text-foreground/45">{spec.basis}</span>}
      {/* The chip's sentence in plain sight, not only in its hover title: a keyboard or a touch
          screen never sees a title, and what counted a row is the point of the tile. */}
      <span id={evidenceId} className="text-[11px] leading-relaxed text-foreground/45">
        {`${EVIDENCE_LABEL[spec.evidence]}: ${EVIDENCE_SENTENCE[spec.evidence]}`}
      </span>
      {ok && ok.usd != null && (
        <span className="text-xs leading-relaxed text-foreground/45">
          {`$${ok.usd.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} across the log, in stablecoin.`}
        </span>
      )}
      {footer}
      <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        <a
          href={spec.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent underline-offset-4 hover:underline"
        >
          Open the raw log <ArrowUpRight size={12} />
        </a>
        {spec.pageHref &&
          (spec.pageHref.startsWith('/') ? (
            <Link
              to={spec.pageHref}
              className="inline-flex items-center gap-1 text-xs font-semibold text-foreground/55 underline-offset-4 hover:text-foreground hover:underline"
            >
              Its proof page
            </Link>
          ) : (
            <a
              href={spec.pageHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-foreground/55 underline-offset-4 hover:text-foreground hover:underline"
            >
              Its proof page <ArrowUpRight size={12} />
            </a>
          ))}
      </span>
    </div>
  )
}

/**
 * The line that lets a reader see /stats and /proof agree: the same logs, the last time
 * they were read here, and the link to the other page.
 */
export function LogsAgreementLine({
  readAt,
  answered,
  total,
  other,
}: {
  readAt: number | null
  answered: number
  total: number
  other: { to: string; label: string }
}) {
  return (
    <p className="text-xs leading-relaxed text-foreground/45">
      {readAt
        ? `Settlement logs last read at ${new Date(readAt).toLocaleTimeString('en-US')}, ${int(answered)} of ${int(total)} answering. `
        : 'Settlement logs not read yet. '}
      The same {int(total)} logs, read through one shared spec, feed{' '}
      <Link to={other.to} className="font-semibold text-accent underline-offset-4 hover:underline">
        {other.label}
      </Link>
      , so the two pages cannot drift apart.
    </p>
  )
}
