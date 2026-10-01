/**
 * The allowlist, as a checker rather than a list.
 *
 * The contract exposes a per-address is_allowed view and no view that enumerates payees,
 * so the panel asks the question a reader actually has ("would a payment to THIS address
 * pass?") and answers it live, with its own ledger and time. A list could only be rebuilt
 * from the contract's events, and public RPC nodes keep roughly a week of event history,
 * so a list built that way would silently miss older entries. An indexer that has followed
 * the contract from its deploy can see every entry; this page does not pretend to be one.
 */
import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import {
  ACCOUNT_ID,
  CONTRACT_ID,
  READ_FAILURE_TITLE,
  localTime,
  readIsAllowed,
  type IsAllowedRead,
  type ReadFailure,
} from '../../../lib/stellar/vault-read'
import ReadStamp from './ReadStamp'
import { Chip, Mono } from './bits'

export default function AllowlistChecker({ network, contract }: { network: string; contract: string }) {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<IsAllowedRead | null>(null)
  const [failure, setFailure] = useState<ReadFailure | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)

  const check = async (e: FormEvent) => {
    e.preventDefault()
    const a = address.trim()
    setAnswer(null)
    setFailure(null)
    if (!ACCOUNT_ID.test(a) && !CONTRACT_ID.test(a)) {
      setInvalid('Paste a Stellar account (G..., 56 characters) or a contract (C..., 56 characters).')
      return
    }
    setInvalid(null)
    setBusy(true)
    const r = await readIsAllowed(network, contract, a)
    setBusy(false)
    if (r.ok) setAnswer(r.data)
    else setFailure(r.failure)
  }

  const inputId = `allowlist-check-${contract.slice(0, 8)}`
  return (
    <div className="mt-3 rounded-xl border border-border bg-background/60 p-3">
      <form onSubmit={check} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="text-[11px] font-semibold text-foreground/65">
            Would a payment to this address pass the allowlist?
          </label>
          <input
            id={inputId}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="G... or C..."
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          Check live
        </button>
      </form>

      <div aria-live="polite">
        {invalid && <p className="mt-2 text-xs font-semibold text-danger">{invalid}</p>}
        {answer && (
          <div className="mt-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {answer.effective === 'allowed' ? (
                <Chip tone="ok">Allowed</Chip>
              ) : answer.effective === 'blocked' ? (
                <Chip tone="danger">Not on the allowlist (payments to it are refused)</Chip>
              ) : (
                <Chip tone="muted">Allowlist not enforced: any payee passes this gate</Chip>
              )}
              <Mono>{answer.address}</Mono>
            </div>
            {answer.effective === 'not-enforced' && (
              <p className="text-[11px] text-foreground/60">
                The address is {answer.allowed ? '' : 'not '}on the list, but the list is switched off, so it does not decide anything
                right now. The daily cap and the auto-approve ceiling still apply.
              </p>
            )}
            <ReadStamp ledger={answer.ledger} readAt={answer.readAt} />
          </div>
        )}
        {failure && (
          <p className="mt-2 text-xs text-danger">
            <span className="font-semibold">
              Check failed at {localTime(failure.at)} ({READ_FAILURE_TITLE[failure.kind].toLowerCase()}):
            </span>{' '}
            {failure.reason}. No answer is shown until a check succeeds.
          </p>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-foreground/55">
        Why a checker and not a list: the contract has a view that answers yes or no for one address, and no view that enumerates the
        allowlist. Rebuilding a list from the contract's events would need its full history, and public RPC nodes keep roughly a week
        of events, so a list built here could miss older entries without saying so. An indexer that has followed the contract since
        its deploy can see every entry.
      </p>
    </div>
  )
}
