/**
 * The receipt for one owner transaction: full hash, ledger, explorer link, status.
 *
 * It lives ABOVE whatever refetches after a write, so the refetch that shows the vault's
 * new state cannot take the hash with it. A pending receipt keeps asking the network's RPC
 * whether the transaction made a ledger; "not found" is reported as still pending, because
 * a submitted transaction stays valid for its time bound and may yet land. Only a ledger
 * saying FAILED is a failure.
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, ExternalLink, XCircle } from 'lucide-react'
import { localTime, pollTransaction, txExplorerUrl } from '../../../lib/stellar/vault-read'
import { CopyButton, Mono } from './bits'

export type Receipt = {
  /** What was done, in words: "Freeze", "Withdrawal of 5 USDC". */
  what: string
  outcome: 'settled' | 'pending' | 'failed'
  hash?: string
  ledger?: number
  /** CAIP-2. */
  network: string
  summary?: string
  submittedAt: string
}

/** How often, and for how long, a pending transaction is checked. */
const POLL_MS = 4000
const POLL_FOR_MS = 3 * 60_000

export default function TxReceipt({
  receipt,
  onUpdate,
  onSettled,
}: {
  receipt: Receipt
  onUpdate: (r: Receipt) => void
  /** Called once when a pending receipt turns settled, so the page can read the vault again. */
  onSettled?: () => void
}) {
  const [gaveUp, setGaveUp] = useState(false)
  const [checks, setChecks] = useState(0)
  /** Bumped by "Check again", which starts a fresh polling window. */
  const [round, setRound] = useState(0)
  const latest = useRef({ receipt, onUpdate, onSettled })
  latest.current = { receipt, onUpdate, onSettled }

  useEffect(() => {
    if (receipt.outcome !== 'pending' || !receipt.hash) return
    let alive = true
    const started = Date.now()
    const hash = receipt.hash
    const network = receipt.network
    const tick = async () => {
      if (!alive) return
      const r = await pollTransaction(network, hash)
      if (!alive) return
      setChecks((n) => n + 1)
      const cur = latest.current
      if (r.status === 'settled') {
        cur.onUpdate({ ...cur.receipt, outcome: 'settled', ledger: r.ledger })
        cur.onSettled?.()
        return
      }
      if (r.status === 'failed') {
        cur.onUpdate({ ...cur.receipt, outcome: 'failed', ledger: r.ledger })
        cur.onSettled?.()
        return
      }
      if (Date.now() - started > POLL_FOR_MS) {
        setGaveUp(true)
        return
      }
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    let timer = setTimeout(() => void tick(), POLL_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [receipt.outcome, receipt.hash, receipt.network, round])

  const href = receipt.hash ? txExplorerUrl(receipt.network, receipt.hash) : null
  const tone =
    receipt.outcome === 'settled' ? 'border-ok/30 bg-ok/[0.07]' : receipt.outcome === 'failed' ? 'border-danger/25 bg-danger/[0.07]' : 'border-warn/30 bg-warn/10'

  return (
    <div className={`rounded-2xl border p-4 text-sm ${tone}`} role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
        {receipt.outcome === 'settled' ? (
          <CheckCircle2 size={16} className="text-ok" aria-hidden="true" />
        ) : receipt.outcome === 'failed' ? (
          <XCircle size={16} className="text-danger" aria-hidden="true" />
        ) : (
          <Clock size={16} className="text-warn" aria-hidden="true" />
        )}
        {receipt.outcome === 'settled'
          ? `${receipt.what}: settled in ledger ${receipt.ledger?.toLocaleString('en-US') ?? '(not reported)'}.`
          : receipt.outcome === 'failed'
            ? `${receipt.what}: landed in ledger ${receipt.ledger?.toLocaleString('en-US') ?? '(not reported)'} and FAILED. Nothing in the vault changed; the network fee was still charged.`
            : `${receipt.what}: submitted, not in a ledger yet.`}
      </div>
      {receipt.summary && (
        <div className="mt-1 text-xs text-foreground/70">
          {/* The backend's words about the call it prepared, before the wallet signed it, so a
              "NOT signed" here describes that preparation, not the settled transaction. */}
          <span className="font-semibold text-foreground/55">The call as prepared, before your signature: </span>
          {receipt.summary}
        </div>
      )}
      {receipt.hash ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Transaction</span>
          <Mono>{receipt.hash}</Mono>
          <CopyButton text={receipt.hash} label="Copy hash" />
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
            >
              View on the explorer <ExternalLink size={11} />
            </a>
          )}
        </div>
      ) : (
        <div className="mt-2 text-xs text-foreground/70">The backend returned no transaction hash.</div>
      )}
      <div className="mt-2 text-[11px] text-foreground/55">
        Submitted at {localTime(receipt.submittedAt)} (local).
        {receipt.outcome === 'pending' &&
          (gaveUp ? (
            <>
              {' '}Still not seen in a ledger after {Math.round(POLL_FOR_MS / 60_000)} minutes. That is not a failure: it may still land
              until its time bound passes. Do not sign it again.{' '}
              <button
                type="button"
                onClick={() => {
                  setGaveUp(false)
                  setRound((n) => n + 1)
                }}
                className="font-semibold text-accent underline underline-offset-2">
                Check again
              </button>
            </>
          ) : (
            <> Checking the network every few seconds ({checks} checks so far). Do not sign it again.</>
          ))}
      </div>
    </div>
  )
}
