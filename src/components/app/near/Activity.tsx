/**
 * What the vault did lately, read from the receipts of the transactions this page knows.
 *
 * NEAR's RPC has no event search by contract, and this page uses no indexer, so it cannot list
 * every transaction the vault ever saw. It reads the ones it knows: those sent from this browser
 * (txlog.ts) and any a person looks up by hash, such as the demo's own transactions. Every line
 * is the vault's own NEP-297 event from that transaction's receipts, read live, and the card says
 * exactly what it covers instead of calling an empty list "no activity".
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { History, Loader2, RefreshCw, Search } from 'lucide-react'
import { tokenTransfersOf, txIdentity, txVerdict, vaultEventsOf } from '../../../lib/near/abi'
import { NEAR_RPC_URLS, nearAccountUrl, nearTxUrl } from '../../../lib/near/chain'
import { describeEvent, type EventLine } from '../../../lib/near/events'
import { isNearAccountId, isNearTxHash, shortId } from '../../../lib/near/ids'
import { localDateTime } from '../../../lib/local-time'
import { NearUnreachable, txStatus } from '../../../lib/near/rpc'
import { loadKnownTxs, type KnownTx } from '../../../lib/near/txlog'
import { formatGrouped } from '../../../lib/near/units'
import { cn } from '../../../lib/utils'
import { BUTTON_QUIET, INPUT } from './styles'
import { Card, CopyButton, ExtLink, Pill } from './ui'

/** How many known transactions are read at once: the newest ones. */
const SHOWN = 8

type Entry = { hash: string; signers: string[]; what: string; at: string | null; source: 'sent' | 'looked-up' }
type Read =
  | { state: 'reading' }
  | { state: 'unknown' }
  | { state: 'pending' }
  | { state: 'unreachable' }
  | { state: 'final'; ok: boolean; reason: string | null; lines: EventLine[]; moved: { from: string; to: string; amount: bigint }[]; signer: string }

async function readEntry(e: Entry, vaultId: string, tokenId: string, decimals: number | null, symbol: string): Promise<Read> {
  let sawPending = false
  let reached = false
  for (const signer of e.signers) {
    try {
      const s = await txStatus(NEAR_RPC_URLS, e.hash, signer)
      reached = true
      if (s.state === 'final') {
        const v = txVerdict(s.outcome)
        return {
          state: 'final',
          ok: v.ok,
          reason: v.ok ? null : v.reason,
          lines: vaultEventsOf(s.outcome, vaultId).map((ev) => describeEvent(ev, decimals, symbol)),
          moved: tokenTransfersOf(s.outcome, tokenId),
          signer: txIdentity(s.outcome)?.signerId ?? signer,
        }
      }
      if (s.state === 'pending') sawPending = true
    } catch (err) {
      if (!(err instanceof NearUnreachable)) throw err
    }
  }
  return sawPending ? { state: 'pending' } : reached ? { state: 'unknown' } : { state: 'unreachable' }
}

const DOT: Record<EventLine['tone'], string> = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', accent: 'bg-accent', muted: 'bg-foreground/45' }

export default function Activity({
  vaultId,
  ownerId,
  tokenId,
  decimals,
  symbol,
  refreshKey,
}: {
  vaultId: string
  ownerId: string
  tokenId: string
  decimals: number | null
  symbol: string
  /** Bumped when a transaction from this page lands, so the list is read again. */
  refreshKey: number
}) {
  const [lookups, setLookups] = useState<Entry[]>([])
  const [known, setKnown] = useState<KnownTx[]>(() => loadKnownTxs(vaultId))
  const [reads, setReads] = useState<Record<string, Read>>({})
  const [round, setRound] = useState(0)

  useEffect(() => setKnown(loadKnownTxs(vaultId)), [vaultId, refreshKey])

  const entries: Entry[] = useMemo(() => {
    const sent = known.slice(0, SHOWN).map((t): Entry => ({ hash: t.hash, signers: [t.signerId], what: t.what, at: t.at, source: 'sent' }))
    return [...lookups, ...sent.filter((s) => !lookups.some((l) => l.hash === s.hash))]
  }, [known, lookups])

  const entriesKey = entries.map((e) => e.hash).join(',')
  useEffect(() => {
    let alive = true
    for (const e of entries) {
      setReads((r) => ({ ...r, [e.hash]: { state: 'reading' } }))
      void readEntry(e, vaultId, tokenId, decimals, symbol).then(
        (res) => alive && setReads((r) => ({ ...r, [e.hash]: res })),
        () => alive && setReads((r) => ({ ...r, [e.hash]: { state: 'unreachable' } })),
      )
    }
    return () => {
      alive = false
    }
    // The hashes, the round and the landing counter decide when to read; the rest come with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey, round, refreshKey, vaultId])

  const [hash, setHash] = useState('')
  const [signer, setSigner] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const lookUp = useCallback(
    (ev: FormEvent) => {
      ev.preventDefault()
      const h = hash.trim()
      const sg = signer.trim()
      if (!isNearTxHash(h)) {
        setProblem('A NEAR transaction hash is 43 or 44 base58 characters, as NearBlocks shows it.')
        return
      }
      if (sg && !isNearAccountId(sg)) {
        setProblem('The signer must be a NEAR account id, or empty to try the vault (agent) and the owner.')
        return
      }
      setProblem(null)
      setHash('')
      // The RPC finds a transaction by its signer: an agent signs AS the vault, the owner as itself.
      const signers = [...new Set([sg, vaultId, ownerId].filter(Boolean))]
      setLookups((l) => [{ hash: h, signers, what: 'Looked up by hash', at: null, source: 'looked-up' as const }, ...l.filter((x) => x.hash !== h)].slice(0, SHOWN))
    },
    [hash, signer, vaultId, ownerId],
  )

  return (
    <Card
      title="Recent activity"
      icon={<History size={14} />}
      aside={
        entries.length > 0 && (
          <button type="button" className={BUTTON_QUIET} onClick={() => setRound((n) => n + 1)}>
            <RefreshCw size={12} aria-hidden="true" />
            Read again
          </button>
        )
      }
    >
      <p className="text-xs text-foreground/80">
        NEAR's RPC cannot search a contract's events, and this page uses no indexer, so it shows the transactions it knows: the ones sent from this
        browser, and any you look up. Every line is the vault's own event, read live from that transaction's receipts.
      </p>
      {entries.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-border px-3 py-4 text-sm text-foreground/85">
          This browser has sent nothing to this vault yet. Look up a transaction below, such as one from the demo, to read what the vault did in it.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {entries.map((e) => {
            const r = reads[e.hash] ?? { state: 'reading' }
            return (
              <li key={e.hash} className="rounded-xl border border-border bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{e.what}</span>
                  {r.state === 'final' ? (
                    r.ok ? <Pill tone="ok">Final</Pill> : <Pill tone="danger">Final, failed: {r.reason}</Pill>
                  ) : r.state === 'reading' ? (
                    <Pill tone="muted" icon={<Loader2 size={11} className="animate-spin" aria-hidden="true" />}>
                      Reading
                    </Pill>
                  ) : r.state === 'pending' ? (
                    <Pill tone="warn">Not final yet</Pill>
                  ) : r.state === 'unknown' ? (
                    <Pill tone="warn">No host knows this hash with these signers</Pill>
                  ) : (
                    <Pill tone="warn">No NEAR host answered</Pill>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-foreground/80">
                  <span className="font-mono">{shortId(e.hash, 12)}</span>
                  <CopyButton text={e.hash} label="Copy hash" />
                  <ExtLink href={nearTxUrl(e.hash)}>NearBlocks</ExtLink>
                  {e.at && <span>sent from this browser {localDateTime(e.at)}</span>}
                  {r.state === 'final' && <span>signed by {r.signer === vaultId ? 'an agent key (as the vault)' : r.signer}</span>}
                </div>
                {r.state === 'final' &&
                  (r.lines.length === 0 && r.moved.length === 0 ? (
                    <p className="mt-2 text-xs text-foreground/80">The vault logged no event in this transaction.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {r.lines.map((l, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-foreground">
                          <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT[l.tone])} aria-hidden="true" />
                          <span className="min-w-0 break-words">
                            {l.title}
                            {l.account && (
                              <>
                                {' '}
                                <ExtLink href={nearAccountUrl(l.account)} className="text-[11px]">
                                  NearBlocks
                                </ExtLink>
                              </>
                            )}
                            {l.detail && <span className="block text-foreground/80">{l.detail}</span>}
                          </span>
                        </li>
                      ))}
                      {r.moved.map((m, i) => (
                        <li key={`m${i}`} className="flex items-start gap-2 text-xs text-foreground">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-usdc" aria-hidden="true" />
                          <span className="min-w-0 break-words">
                            {`The token moved ${decimals === null ? `${m.amount.toString()} units` : `${formatGrouped(m.amount, decimals)} ${symbol}`} from ${shortId(m.from)} to ${shortId(m.to)}, by its own nep141 event.`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ))}
              </li>
            )
          })}
        </ol>
      )}
      <form onSubmit={lookUp} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="block min-w-0 text-[11px] font-semibold text-foreground/80">
          Transaction hash
          <input className={`${INPUT} font-mono text-xs`} placeholder="9qRji3Nt..." spellCheck={false} autoComplete="off" value={hash} onChange={(e) => setHash(e.target.value)} />
        </label>
        <label className="block min-w-0 text-[11px] font-semibold text-foreground/80">
          Signed by (optional)
          <input className={`${INPUT} font-mono text-xs`} placeholder={ownerId} spellCheck={false} autoComplete="off" autoCapitalize="off" value={signer} onChange={(e) => setSigner(e.target.value)} />
        </label>
        <button type="submit" className={cn(BUTTON_QUIET, 'h-[38px]')}>
          <Search size={12} aria-hidden="true" />
          Look up
        </button>
        {problem && (
          <p role="alert" className="text-xs text-foreground sm:col-span-3">
            {problem}
          </p>
        )}
      </form>
    </Card>
  )
}
