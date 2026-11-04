/**
 * One place that shows a stopped write: what happened and what to do next. The words are in
 * lib/arc/failure-explain.ts.
 */
import { AlertTriangle } from 'lucide-react'
import { explainFailure } from '../../../lib/arc/failure-explain'
import type { TxFailure } from '../../../lib/arc/vault-write'

/** `next` replaces the usual next step when what comes after is not simply trying again. */
export default function FailureNotice({ failure, next: instead }: { failure: TxFailure; next?: string }) {
  const { title, body, next: usual, tone } = explainFailure(failure)
  const next = instead ?? usual
  return (
    <div role="alert" className={`rounded-2xl border p-4 text-sm ${tone === 'warn' ? 'border-warn/30 bg-warn/10' : 'border-danger/25 bg-danger/[0.07]'}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${tone === 'warn' ? 'text-warn' : 'text-danger'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">{title}</div>
          {body && <div className="mt-1 break-words text-foreground/80">{body}</div>}
          <div className="mt-2 text-foreground/80">
            <span className="font-semibold text-foreground">Next step: </span>
            {next}
          </div>
        </div>
      </div>
    </div>
  )
}
