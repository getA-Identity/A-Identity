/**
 * The stamp under every group of live values: which ledger answered, and when.
 *
 * The time is the backend's `readAt` in the viewer's own clock, not the moment the browser
 * drew the page, so a value that sat in a cache for a few seconds says so.
 */
import { localTime } from '../../../lib/stellar/vault-read'

export default function ReadStamp({ ledger, readAt, refreshing }: { ledger: number; readAt: string; refreshing?: boolean }) {
  return (
    <span className="text-[11px] tabular-nums text-foreground/55">
      Read live at ledger {ledger.toLocaleString('en-US')}, {localTime(readAt)} (local)
      {refreshing ? ', refreshing...' : ''}
    </span>
  )
}
