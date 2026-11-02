/**
 * The receipt for one transaction this page handed to a wallet: the hash at once, then what the
 * chain says it became.
 *
 * It sits ABOVE whatever re-reads after a write, so the re-read that shows the vault's new state
 * cannot take the hash with it, and the record behind it is saved in this browser, so a reload
 * keeps polling where it left off. While no RPC has a receipt it is pending and says so; "not
 * found" on one host is never a failure on Arc. Settled needs the receipt AND the expected event.
 *
 * The chain it polls is the one the record names, never one passed in: a record can only ever be
 * asked about on the network its transaction was sent to. After the page stops polling on its
 * own, the person can stop tracking it, so a transaction that will never get a receipt (dropped
 * under the fee floor, or replaced in the wallet) cannot hold anything on the page forever.
 *
 * A wallet can change the fee this page proposed. When no network node has seen a hash after 30
 * seconds the receipt says so out loud and says what to look for in the wallet, because that is
 * the moment the person can still fix it, and stopping tracking is offered from then on.
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, XCircle } from 'lucide-react'
import type { TxRecord } from '../../../lib/arc/pending'
import { FAST_FOR_MS, POLL_FAST_MS, POLL_FOR_MS, POLL_SLOW_MS, advance, feeLine } from '../../../lib/arc/receipt'
import { retracked, untracked, walletRepriced } from '../../../lib/arc/tx-rules'
import { arcChainFor, localTime, networkName, rpcUrls, txUrl } from '../../../lib/arc/vault-read'
import { formatUnitsExact, sameAddress } from '../../../lib/arc/vault-rules'
import { CopyButton, Mono } from '../stellar/bits'

const gwei = (wei: bigint) => `${formatUnitsExact(wei, 9)} gwei`

function changed(a: TxRecord, b: TxRecord): boolean {
  return (
    a.outcome !== b.outcome ||
    a.note !== b.note ||
    a.contractAddress !== b.contractAddress ||
    a.vault !== b.vault ||
    a.block !== b.block ||
    a.sent?.nonce !== b.sent?.nonce ||
    a.sent?.belowFloor !== b.sent?.belowFloor ||
    a.nonceUsedAt !== b.nonceUsedAt ||
    a.unseen !== b.unseen ||
    a.likelyReplaced !== b.likelyReplaced ||
    a.readBackTries !== b.readBackTries
  )
}

const LINK = 'font-semibold text-accent underline underline-offset-2'

export default function TxReceipt({
  record,
  onUpdate,
  onSettled,
}: {
  record: TxRecord
  onUpdate: (r: TxRecord) => void
  /** Called once when a pending record reaches any final outcome, so the page can read the vault again. */
  onSettled?: (r: TxRecord) => void
}) {
  const chain = arcChainFor(record.network)
  const [gaveUp, setGaveUp] = useState(false)
  const [asked, setAsked] = useState<{ answered: number; total: number; checks: number }>({
    answered: 0,
    total: chain ? rpcUrls(chain).length : 0,
    checks: 0,
  })
  const [round, setRound] = useState(0)
  const latest = useRef({ record, onUpdate, onSettled })
  latest.current = { record, onUpdate, onSettled }

  useEffect(() => {
    if (record.outcome !== 'pending' || !chain) return
    let alive = true
    let tick = 0
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      if (!alive) return
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => void run(), POLL_SLOW_MS)
        return
      }
      const cur = latest.current
      let out
      try {
        out = await advance(chain, cur.record, tick)
      } catch {
        out = null
      }
      if (!alive) return
      tick += 1
      if (out) {
        setAsked((a) => ({ answered: out.answered, total: out.total, checks: a.checks + 1 }))
        if (changed(cur.record, out.record)) cur.onUpdate(out.record)
        if (out.record.outcome !== 'pending') {
          cur.onSettled?.(out.record)
          return
        }
      }
      const elapsed = Date.now() - started
      if (elapsed > POLL_FOR_MS) {
        setGaveUp(true)
        return
      }
      timer = setTimeout(() => void run(), elapsed < FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS)
    }
    timer = setTimeout(() => void run(), POLL_FAST_MS)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [record.outcome, record.hash, chain, round])

  if (!chain)
    return (
      <div role="alert" className="rounded-2xl border border-danger/25 bg-danger/[0.07] p-4 text-sm text-foreground">
        <div className="font-semibold">
          {record.what}: this record names the network "{record.network}", which this page does not know, so it is not asked about anywhere.
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Transaction</span>
          <Mono>{record.hash}</Mono>
          <CopyButton text={record.hash} label="Copy hash" />
        </div>
      </div>
    )

  const href = txUrl(chain, record.hash)
  const fee = feeLine(record.feeWei, chain.nativeCurrency.decimals)
  const tone =
    record.outcome === 'settled'
      ? 'border-ok/30 bg-ok/[0.07]'
      : record.outcome === 'pending' || record.outcome === 'replaced' || record.outcome === 'untracked'
        ? 'border-warn/30 bg-warn/10'
        : 'border-danger/25 bg-danger/[0.07]'
  const block = record.block !== undefined ? record.block.toLocaleString('en-US') : '(not reported)'
  const headline =
    record.outcome === 'settled'
      ? `${record.what}: settled in block ${block}.`
      : record.outcome === 'reverted'
        ? `${record.what}: landed in block ${block} and REVERTED. Nothing in the vault changed; the network fee was still charged.`
        : record.outcome === 'unexpected'
          ? `${record.what}: landed in block ${block}, but not as expected. It is not counted as done.`
          : record.outcome === 'replaced'
            ? record.vault && record.action === 'deploy'
              ? `${record.what}: a replacement from your wallet created the vault.`
              : `${record.what}: replaced. Your wallet sent another transaction in its place, so this one can no longer land.`
            : record.outcome === 'untracked'
              ? record.likelyReplaced
                ? `${record.what}: most likely replaced in your wallet, with no receipt seen for this one.`
                : `${record.what}: no longer tracked, with no receipt seen.`
              : `${record.what}: submitted, no receipt yet.`

  return (
    <div className={`rounded-2xl border p-4 text-sm ${tone}`} role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
        {record.outcome === 'settled' ? (
          <CheckCircle2 size={16} className="text-ok" aria-hidden="true" />
        ) : record.outcome === 'pending' ? (
          <Clock size={16} className="text-warn" aria-hidden="true" />
        ) : record.outcome === 'replaced' || record.outcome === 'untracked' ? (
          <AlertTriangle size={16} className="text-warn" aria-hidden="true" />
        ) : (
          <XCircle size={16} className="text-danger" aria-hidden="true" />
        )}
        {headline}
      </div>
      {record.outcome === 'settled' && (
        <div className="mt-1 text-xs text-foreground/75">
          The receipt carries what this write was expected to emit
          {record.action === 'deploy' ? ' (a contract at the address the receipt names, reading back as asked)' : ''}
          {fee ? `. Network fee: ${fee}` : ''}
          {record.host ? `. Receipt from ${record.host}.` : '.'}
        </div>
      )}
      {(record.outcome === 'reverted' || record.outcome === 'unexpected') && fee && (
        <div className="mt-1 text-xs text-foreground/75">Network fee charged: {fee}.</div>
      )}
      {record.note && !record.unseen && <div className="mt-1 text-xs text-foreground/80">{record.note}</div>}
      {record.outcome === 'pending' && record.unseen && (
        <div className="mt-2 rounded-xl border border-warn/40 bg-warn/15 p-3 text-xs text-foreground">
          <div className="font-semibold">{record.note}</div>
          <p className="mt-1">
            Open your wallet and find this transaction.
            {record.proposedMaxFee !== undefined && ` This page asked for a max fee of ${gwei(record.proposedMaxFee)}.`} Gwei is the tiny unit wallets
            use for this fee.
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>If it shows a max fee under 20 gwei: speed it up in your wallet to at least 20 gwei, or cancel it there.</li>
            <li>If it shows 20 gwei or more and is still waiting: give it a little longer.</li>
            <li>If your wallet shows no such transaction, or says it was dropped: stop tracking it below.</li>
          </ul>
        </div>
      )}
      {record.contractAddress && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/75">
          <span className="font-semibold text-foreground/60">Contract:</span>
          <Mono>{record.contractAddress}</Mono>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Transaction</span>
        <Mono>{record.hash}</Mono>
        <CopyButton text={record.hash} label="Copy hash" />
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
            View on the explorer <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
      </div>

      {record.sent && (
        <div className={`mt-2 text-xs ${record.sent.belowFloor ? 'font-semibold text-danger' : 'text-foreground/70'}`}>
          {record.sent.belowFloor
            ? `Your wallet sent this with a max fee of ${gwei(record.sent.maxFeePerGas ?? record.sent.gasPrice ?? 0n)}, under the 20 gwei Arc needs${walletRepriced(record) && record.proposedMaxFee !== undefined ? ` (this page asked for ${gwei(record.proposedMaxFee)}, so your wallet changed it)` : ''}. Arc drops such a transaction without a receipt: speed it up in your wallet to at least 20 gwei, or cancel it. Once the replacement lands, this page sees that and stops waiting on this hash.`
            : `Read back from the network: your wallet sent it with a max fee of ${gwei(record.sent.maxFeePerGas ?? record.sent.gasPrice ?? 0n)}${walletRepriced(record) && record.proposedMaxFee !== undefined ? ` (this page asked for ${gwei(record.proposedMaxFee)}, so your wallet changed it)` : ''}, at or above the 20 gwei Arc needs.`}
          {!sameAddress(record.sent.from, record.from) && (
            <span className="block font-semibold text-danger">It was sent from {record.sent.from}, not the account this page prepared it for.</span>
          )}
        </div>
      )}

      <div className="mt-2 text-[11px] text-foreground/55">
        Submitted at {localTime(record.submittedAt)} (local), on {networkName(chain)}.
        {record.outcome === 'pending' &&
          (gaveUp ? (
            <>
              {' '}No receipt after {Math.round(POLL_FOR_MS / 60_000)} minutes on any of the {asked.total} network nodes. That is not a failure: it may still land.
              Do not sign it again.{' '}
              <button
                type="button"
                onClick={() => {
                  setGaveUp(false)
                  setRound((n) => n + 1)
                }}
                className={LINK}
              >
                Check again
              </button>
              <span className="mt-1 block">
                If your wallet shows it as dropped or cancelled, or the vault's state shows it already landed, you can stop tracking it: the
                controls it holds come back. If it is still in your wallet's queue, it can land later.{' '}
                <button
                  type="button"
                  onClick={() => {
                    const r = untracked(record)
                    onUpdate(r)
                    onSettled?.(r)
                  }}
                  className={LINK}
                >
                  Stop tracking this transaction
                </button>
              </span>
            </>
          ) : (
            <>
              {' '}Asking all {asked.total} {networkName(chain)} network nodes every few seconds ({asked.checks} {asked.checks === 1 ? 'round' : 'rounds'} so far
              {asked.checks > 0 ? `, ${asked.answered} answered the last one` : ''}).{' '}
              {record.unseen ? 'Do not sign a new one until you have looked in your wallet.' : 'Do not sign it again.'}
              {record.unseen && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => {
                      const r = untracked(record)
                      onUpdate(r)
                      onSettled?.(r)
                    }}
                    className={LINK}
                  >
                    Stop tracking this transaction
                  </button>
                </>
              )}
            </>
          ))}
        {record.outcome === 'untracked' && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => {
                setGaveUp(false)
                onUpdate(retracked(record))
              }}
              className={LINK}
            >
              Track it again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
