/**
 * The receipt for one transaction this page handed to a wallet: the hash at once, then what the
 * chain says it became.
 *
 * It sits ABOVE whatever re-reads after a write, so the re-read that shows the vault's new state
 * cannot take the hash with it, and the record behind it is saved in this browser, so a reload
 * keeps polling where it left off. While no RPC has a receipt it is pending and says so; "not
 * found" on one host is never a failure on Arc. Settled needs the receipt AND the expected event.
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, XCircle } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import type { TxRecord } from '../../../lib/arc/pending'
import { FAST_FOR_MS, POLL_FAST_MS, POLL_FOR_MS, POLL_SLOW_MS, advance, feeLine } from '../../../lib/arc/receipt'
import { localTime, rpcUrls, txUrl } from '../../../lib/arc/vault-read'
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
    a.sent?.belowFloor !== b.sent?.belowFloor
  )
}

export default function TxReceipt({
  record,
  chain,
  onUpdate,
  onSettled,
}: {
  record: TxRecord
  chain: Chain
  onUpdate: (r: TxRecord) => void
  /** Called once when a pending record reaches any final outcome, so the page can read the vault again. */
  onSettled?: (r: TxRecord) => void
}) {
  const [gaveUp, setGaveUp] = useState(false)
  const [asked, setAsked] = useState<{ answered: number; total: number; checks: number }>({ answered: 0, total: rpcUrls(chain).length, checks: 0 })
  const [round, setRound] = useState(0)
  const latest = useRef({ record, onUpdate, onSettled })
  latest.current = { record, onUpdate, onSettled }

  useEffect(() => {
    if (record.outcome !== 'pending') return
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

  const href = txUrl(chain, record.hash)
  const fee = feeLine(record.feeWei, chain.nativeCurrency.decimals)
  const tone =
    record.outcome === 'settled'
      ? 'border-ok/30 bg-ok/[0.07]'
      : record.outcome === 'pending'
        ? 'border-warn/30 bg-warn/10'
        : record.outcome === 'replaced'
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
            ? `${record.what}: replaced in your wallet.`
            : `${record.what}: submitted, no receipt yet.`

  return (
    <div className={`rounded-2xl border p-4 text-sm ${tone}`} role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
        {record.outcome === 'settled' ? (
          <CheckCircle2 size={16} className="text-ok" aria-hidden="true" />
        ) : record.outcome === 'pending' ? (
          <Clock size={16} className="text-warn" aria-hidden="true" />
        ) : record.outcome === 'replaced' ? (
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
      {record.note && <div className="mt-1 text-xs text-foreground/80">{record.note}</div>}
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
            ? `Your wallet sent this with a fee of ${gwei(record.sent.maxFeePerGas ?? record.sent.gasPrice ?? 0n)} per gas, under Arc's 20 gwei floor. Arc drops such a transaction without a receipt: speed it up in your wallet above 20 gwei, or cancel it.`
            : `Read back from the chain: your wallet sent it with nonce ${record.sent.nonce} and a max fee of ${gwei(record.sent.maxFeePerGas ?? record.sent.gasPrice ?? 0n)} per gas, at or above Arc's 20 gwei floor.`}
          {!sameAddress(record.sent.from, record.from) && (
            <span className="block font-semibold text-danger">It was sent from {record.sent.from}, not the account this page prepared it for.</span>
          )}
        </div>
      )}

      <div className="mt-2 text-[11px] text-foreground/55">
        Submitted at {localTime(record.submittedAt)} (local).
        {record.outcome === 'pending' &&
          (gaveUp ? (
            <>
              {' '}No receipt after {Math.round(POLL_FOR_MS / 60_000)} minutes on any of the {asked.total} RPCs. That is not a failure: it may still land.
              Do not sign it again.{' '}
              <button
                type="button"
                onClick={() => {
                  setGaveUp(false)
                  setRound((n) => n + 1)
                }}
                className="font-semibold text-accent underline underline-offset-2"
              >
                Check again
              </button>
            </>
          ) : (
            <>
              {' '}Asking all {asked.total} {chain.testnet ? 'Arc testnet' : 'Arc Mainnet'} RPCs every few seconds ({asked.checks} rounds so far
              {asked.checks > 0 ? `, ${asked.answered} answered the last one` : ''}). Do not sign it again.
            </>
          ))}
      </div>
    </div>
  )
}
