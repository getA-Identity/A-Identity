/**
 * What a vault has done lately: its Paid, FrozenSet and Withdrawn events, read live with no wallet.
 *
 * Every line under the list names what was actually covered. Arc's RPCs cap a log query at 10,000
 * blocks and some prune, so this reads a bounded recent range and says where it stopped: "no
 * activity" is only ever said of the blocks named next to it (event-history.ts decides the words).
 * Reading further back is a button rather than a loop, so a page left open asks nothing of the RPCs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import {
  EVENTS_SHOWN,
  LOG_WINDOW_BLOCKS,
  MAX_WINDOWS,
  WINDOWS_PER_READ,
  covered,
  historyStatement,
  nextWindowTop,
  type EventHistory,
  type VaultEvent,
} from '../../../lib/arc/event-history'
import { readVaultEvents } from '../../../lib/arc/vault-events'
import { addressUrl, shortAddress, txUrl, utcDateTime } from '../../../lib/arc/vault-read'
import { formatUnitsExact } from '../../../lib/arc/vault-rules'
import { Chip, Group } from '../stellar/bits'

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground/80 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

function Linked({ href, children, title }: { href: string | null; children: React.ReactNode; title?: string }) {
  if (!href) return <span title={title}>{children}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
      {children} <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

/** The event in words. Paid says who sent it: the agent's pay() or the owner's ownerPay(). */
function EventLine({ e, chain, decimals }: { e: VaultEvent; chain: Chain; decimals: number }) {
  const usd = (x: bigint) => `${formatUnitsExact(x, decimals)} USDC`
  const to = (a: string) => (
    <Linked href={addressUrl(chain, a)} title={a}>
      <span className="font-mono">{shortAddress(a)}</span>
    </Linked>
  )
  if (e.kind === 'Paid')
    return (
      <>
        <Chip tone="accent">Paid</Chip> {usd(e.amount)} to {to(e.to)}, {e.byOwner ? 'by the owner' : 'by the agent'}
      </>
    )
  if (e.kind === 'Withdrawn')
    return (
      <>
        <Chip tone="muted">Withdrawn</Chip> {usd(e.amount)} to {to(e.to)}, by the owner
      </>
    )
  return e.frozen ? (
    <>
      <Chip tone="danger">Frozen</Chip> by the owner
    </>
  ) : (
    <>
      <Chip tone="ok">Unfrozen</Chip> by the owner
    </>
  )
}

export default function VaultEvents({
  chain,
  vault,
  decimals,
  refreshKey,
}: {
  chain: Chain
  vault: string
  decimals: number
  /** A change reads again from the newest block: a write of this page settled. */
  refreshKey: number
}) {
  const [history, setHistory] = useState<EventHistory | null>(null)
  const [reading, setReading] = useState(false)
  const run = useRef(0)

  const start = useCallback(
    (older?: EventHistory) => {
      const id = ++run.current
      const stale = () => run.current !== id
      setReading(true)
      void readVaultEvents(chain, vault, { older, aborted: stale, onProgress: (h) => !stale() && setHistory(h) }).then((h) => {
        if (stale()) return
        setHistory(h)
        setReading(false)
      })
    },
    [chain, vault],
  )

  useEffect(() => {
    start()
    return () => {
      run.current += 1
    }
  }, [start, refreshKey])

  const range = history ? covered(history) : null
  const statement = history ? historyStatement(history) : null
  const more = history ? nextWindowTop(history) : null
  const listed = history?.events.slice(0, EVENTS_SHOWN) ?? []
  const when = (block: bigint) => {
    const t = history?.times[block.toString()]
    return t === undefined ? null : utcDateTime(t)
  }
  const fromTime = range ? when(range.from) : null
  const toTime = range ? when(range.to) : null
  const windowsRead = history?.windows.length ?? 0

  return (
    <Group title="Recent activity">
      <div aria-live="polite">
        {statement ? (
          <p className="text-sm font-semibold text-foreground">{statement.claim}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-foreground/70">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Reading this vault's events from the chain...
          </p>
        )}
        {range && fromTime && toTime && (
          <p className="mt-0.5 text-xs text-foreground/65">
            That range runs from {fromTime} to {toTime}, in chain time.
          </p>
        )}
      </div>

      {listed.length > 0 && (
        <ol className="mt-3 divide-y divide-border/60 border-y border-border/60">
          {listed.map((e) => (
            <li key={`${e.txHash}:${e.logIndex}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-xs text-foreground/85">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <EventLine e={e} chain={chain} decimals={decimals} />
              </span>
              <span className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums text-foreground/60">
                <span>
                  block {e.block.toLocaleString('en-US')}
                  {when(e.block) ? `, ${when(e.block)}` : ''}
                </span>
                <Linked href={txUrl(chain, e.txHash)} title={e.txHash}>
                  tx
                </Linked>
              </span>
            </li>
          ))}
        </ol>
      )}
      {history && history.events.length > listed.length && (
        <p className="mt-2 text-xs text-foreground/65">
          The newest {listed.length} of {history.events.length} are listed here. The explorer has the rest.
        </p>
      )}

      {statement && statement.limits.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px] leading-relaxed text-foreground/60">
          {statement.limits.map((l) => (
            <li key={l} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => start()} disabled={reading} className={BUTTON}>
          {reading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
          {reading ? `Reading windows of ${LOG_WINDOW_BLOCKS.toLocaleString('en-US')} blocks (${windowsRead} done)...` : 'Read again from the newest block'}
        </button>
        {history && more !== null && (
          <button type="button" onClick={() => start(history)} disabled={reading} className={BUTTON}>
            Read {(LOG_WINDOW_BLOCKS * BigInt(WINDOWS_PER_READ)).toLocaleString('en-US')} blocks further back
          </button>
        )}
        {history && more === null && windowsRead >= MAX_WINDOWS && (
          <span className="text-xs text-foreground/65">This page reads no further back than this, so it does not overload the public RPCs.</span>
        )}
        <Linked href={addressUrl(chain, vault)}>
          <span className="text-xs">Full history on the explorer</span>
        </Linked>
      </div>
    </Group>
  )
}
