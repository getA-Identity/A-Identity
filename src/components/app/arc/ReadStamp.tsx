/**
 * The stamp under every group of live values: the block they were read at and when this browser
 * finished the read. The full form, under the headline, also names the host that answered and
 * the chain's own time at that block.
 *
 * Chain time comes from the block, not from this browser's clock, because that is the clock the
 * contract enforces the day and the session key against.
 */
import { localTime, utcDateTime, type VaultSnapshot } from '../../../lib/arc/vault-read'

export default function ReadStamp({ v, refreshing, compact }: { v: VaultSnapshot; refreshing?: boolean; compact?: boolean }) {
  return (
    <span className="text-[11px] tabular-nums text-foreground/55">
      Read live at block {v.block.toLocaleString('en-US')}
      {compact ? '' : ` from ${v.host}, chain time ${utcDateTime(v.chainTime)}`}, {localTime(v.readAt)} (local)
      {refreshing ? ', refreshing...' : ''}
    </span>
  )
}
