import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, Clock, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  createPublicClient,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
} from 'viem'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal } from '../components/ui/section'
import { Stat } from '../components/ui/stat'
import { apiFetch } from '../lib/api'
import { CHAIN_BY_ID, CHAIN_RPC_URLS, CHAIN_USDC } from '../lib/chains'
import { ago, short } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'

/**
 * /celo-payment: Celo payments as they arrive.
 *
 * A monitor for the paid checks on our Celo rail. Every row is GET /api/celo/proof verbatim,
 * re-read every 10 seconds while the tab is visible: the settlement log the backend writes at
 * settle time, with our own wallets labelled. Outside payments come from the response's own
 * recentExternal list, so a run of our own checks can never push them off this page. Nothing is
 * simulated, and a row that has not settled never appears.
 *
 * Each outside payment is then read back from the Celo chain in the browser: the receipt must
 * have succeeded and must carry a USDC Transfer from that payer to the pay-to of that day for
 * exactly the logged amount. The public RPC balances across nodes and some of them answer null
 * for a mined receipt, so a null is asked again a few times, then the transaction itself is read:
 * a mined transaction is never shown as waiting for a block. Anything still open is asked again
 * on its own timer, not only when the log answers.
 *
 * The RPC, the explorer and the USDC address come from the generated chain mirror (lib/chains.ts);
 * the pay-to and the retired addresses come from the log. None of them is typed here.
 */

type Row = {
  ts: string | number
  tx?: string
  tool: string
  payer?: string
  network?: string
  amountUsd: number
  internal?: boolean
}

type Proof = {
  payTo?: string
  previousPayTo?: { address: string; until: string }[]
  retiredPayers?: { address: string }[]
  configured: boolean
  totalSettlements: number
  totalUsd: number
  internalSettlements?: number
  externalSettlements?: number
  externalUsd?: number
  recent: Row[]
  /** Newer backends send the latest outside payments on their own; older ones do not. */
  recentExternal?: Row[]
}

type ChainCheck = 'checking' | 'confirmed' | 'mined' | 'waiting' | 'unreachable' | 'mismatch' | 'unknown'

const POLL_MS = 10_000
const RECHECK_MS = 8_000
const RECHECK_PER_TICK = 3
const EXPLORER = CHAIN_BY_ID.celo.explorer
const RPC = CHAIN_RPC_URLS.celo[0]
const USDC = CHAIN_USDC.celo
/** keccak256("Transfer(address,address,uint256)"), the ERC-20 event every USDC payment emits. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const OPEN_STATES: ReadonlySet<ChainCheck> = new Set(['mined', 'waiting', 'unreachable'])

/** A backend timestamp (ISO string, epoch seconds or ms) as a Date, or null when it does not parse. */
function parseTs(ts: string | number): Date | null {
  const d = new Date(typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : ts)
  return Number.isNaN(d.getTime()) ? null : d
}
const agoOf = (ts: string | number) => {
  const d = parseTs(ts)
  return d ? ago(d.toISOString()) : '-'
}
const utcOf = (ts: string | number) => {
  const d = parseTs(ts)
  return d ? `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'time not recorded'
}
const rowKey = (r: Row) => (r.tx ? r.tx.toLowerCase() : `${String(r.ts)}:${r.payer ?? ''}:${r.tool}`)
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
const addrTopic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
const fromTopic = (t: string) => `0x${t.slice(26)}`.toLowerCase()
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** The address a row was paid to: the pay-to that was current when it settled. */
function recipientOf(row: Row, proof: Proof): string | null {
  const when = parseTs(row.ts)?.getTime()
  if (when !== undefined) {
    const older = [...(proof.previousPayTo ?? [])].sort((a, b) => Date.parse(a.until) - Date.parse(b.until))
    for (const p of older) {
      if (when < Date.parse(p.until)) return p.address.toLowerCase()
    }
  }
  return proof.payTo ? proof.payTo.toLowerCase() : null
}

/** Reads one settlement back from the chain. The log is never taken on trust here. */
async function checkOnChain(
  client: ReturnType<typeof createPublicClient>,
  row: Row,
  recipient: string | null,
): Promise<ChainCheck> {
  if (!USDC || !row.tx) return 'unreachable'
  if (!recipient) return 'unknown'
  const hash = row.tx as Hex
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const receipt = await client.getTransactionReceipt({ hash })
        if (receipt.status !== 'success') return 'mismatch'
        const want = BigInt(Math.round(row.amountUsd * 10 ** USDC.decimals))
        const payer = row.payer ? addrTopic(row.payer) : null
        const matched = receipt.logs.some(
          (log) =>
            log.address.toLowerCase() === USDC.address.toLowerCase() &&
            log.topics[0] === TRANSFER_TOPIC &&
            (payer === null || log.topics[1]?.toLowerCase() === payer) &&
            log.topics[2] !== undefined &&
            fromTopic(log.topics[2]) === recipient &&
            BigInt(log.data) === want,
        )
        return matched ? 'confirmed' : 'mismatch'
      } catch (e) {
        // One node answering null proves nothing: the next request may reach another one.
        if (!(e instanceof TransactionReceiptNotFoundError)) throw e
        await sleep(500)
      }
    }
    // Still no receipt. Ask for the transaction itself before saying anything about blocks.
    try {
      const tx = await client.getTransaction({ hash })
      return tx.blockNumber !== null ? 'mined' : 'waiting'
    } catch (e) {
      return e instanceof TransactionNotFoundError ? 'waiting' : 'unreachable'
    }
  } catch {
    return 'unreachable'
  }
}

const Skeleton = () => <span className="inline-block h-5 w-14 animate-pulse rounded bg-foreground/10 align-middle" />

function ExplorerLink({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <a
      href={`${EXPLORER}/${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-term-prompt underline-offset-2 hover:underline"
    >
      {children}
      <ArrowUpRight size={12} className="shrink-0" />
    </a>
  )
}

function WhoBadge({ internal, retired }: { internal?: boolean; retired: boolean }) {
  if (retired) {
    return (
      <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
        retired
      </span>
    )
  }
  return internal ? (
    <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
      ours
    </span>
  ) : (
    <span className="rounded-md bg-ok/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-term-ok ring-1 ring-ok/25">
      outside
    </span>
  )
}

function ChainMark({ state }: { state: ChainCheck | undefined }) {
  if (!state || state === 'checking') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-foreground/65">
        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> checking the chain
      </span>
    )
  }
  if (state === 'confirmed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-term-ok">
        <ShieldCheck size={13} /> on chain
      </span>
    )
  }
  if (state === 'mined') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-foreground/65">
        <Clock size={12} /> mined, reading the receipt again
      </span>
    )
  }
  if (state === 'waiting') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-term-warn">
        <Clock size={12} /> waiting for the block
      </span>
    )
  }
  if (state === 'unreachable') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-foreground/65">
        <Clock size={12} /> chain not reached, asking again
      </span>
    )
  }
  if (state === 'unknown') {
    return <span className="text-xs text-foreground/65">pay-to not known, cannot check</span>
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-term-bad">
      <ShieldAlert size={13} /> does not match the chain
    </span>
  )
}

export default function CeloPayment() {
  usePageMeta({
    title: 'Celo payments, live | A-Identity',
    description:
      'Every paid A-Identity check on Celo as it settles: read from the settlement log every 10 seconds, our own wallets labelled, and each outside payment checked on the Celo chain.',
    canonical: 'https://a-identity.xyz/celo-payment',
    noindex: true,
  })

  const [proof, setProof] = useState<Proof | null>(null)
  const [failure, setFailure] = useState<null | 'unreachable' | 'missing'>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const [onlyOutside, setOnlyOutside] = useState(true)
  const [arrived, setArrived] = useState<Set<string>>(() => new Set())
  const [checks, setChecks] = useState<Record<string, ChainCheck>>({})
  const seq = useRef(0)
  /** The ticket of the request in flight, so a superseded one never blocks a new one. */
  const inFlight = useRef<number | null>(null)
  const seenAtOpen = useRef<Set<string> | null>(null)
  const asked = useRef<Set<string>>(new Set())
  /** Outside rows whose chain check is still open, asked again on their own timer. */
  const open = useRef<Map<string, { row: Row; recipient: string | null }>>(new Map())
  const client = useMemo(() => createPublicClient({ transport: http(RPC) }), [])

  const load = useCallback(async () => {
    if (inFlight.current !== null) return
    const mine = seq.current + 1
    seq.current = mine
    inFlight.current = mine
    try {
      const res = await apiFetch('/api/celo/proof', { retries: 1 })
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
      const data = (await res.json()) as Proof
      if (mine !== seq.current) return
      const outside = Array.isArray(data.recentExternal)
        ? data.recentExternal
        : (Array.isArray(data.recent) ? data.recent : []).filter((r) => !r.internal)
      const keys = [...(Array.isArray(data.recent) ? data.recent : []), ...outside].map(rowKey)
      if (seenAtOpen.current === null) {
        seenAtOpen.current = new Set(keys)
      } else {
        const fresh = keys.filter((k) => !seenAtOpen.current?.has(k))
        if (fresh.length) setArrived((prev) => new Set([...prev, ...fresh]))
      }
      setProof(data)
      setFailure(null)
      setCheckedAt(Date.now())
    } catch (e: unknown) {
      if (mine !== seq.current) return
      const code = (e as { status?: number }).status
      setFailure(code === 404 || code === 501 ? 'missing' : 'unreachable')
    } finally {
      if (inFlight.current === mine) inFlight.current = null
    }
  }, [])

  // Poll while the tab is visible, and catch up at once when it becomes visible again.
  useEffect(() => {
    void load()
    const id = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    const onVisibility = () => {
      setHidden(document.hidden)
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
      seq.current += 1
      inFlight.current = null
    }
  }, [load])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const runCheck = useCallback(
    (key: string, row: Row, recipient: string | null) => {
      void checkOnChain(client, row, recipient).then((state) => {
        setChecks((c) => ({ ...c, [key]: state }))
        if (OPEN_STATES.has(state)) open.current.set(key, { row, recipient })
        else open.current.delete(key)
      })
    },
    [client],
  )

  const outsideRows = useMemo<Row[]>(() => {
    if (!proof) return []
    if (Array.isArray(proof.recentExternal)) return proof.recentExternal
    return (Array.isArray(proof.recent) ? proof.recent : []).filter((r) => !r.internal)
  }, [proof])

  // Every outside payment is read back from the chain once, as soon as it shows up.
  useEffect(() => {
    if (!proof) return
    for (const row of outsideRows) {
      if (!row.tx) continue
      const key = row.tx.toLowerCase()
      if (asked.current.has(key)) continue
      asked.current.add(key)
      setChecks((c) => (c[key] ? c : { ...c, [key]: 'checking' }))
      runCheck(key, row, recipientOf(row, proof))
    }
  }, [proof, outsideRows, runCheck])

  // Checks that are still open are asked again on their own timer, a few at a time.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return
      const batch = [...open.current.entries()].slice(0, RECHECK_PER_TICK)
      for (const [key, { row, recipient }] of batch) {
        open.current.delete(key)
        runCheck(key, row, recipient)
      }
    }, RECHECK_MS)
    return () => window.clearInterval(id)
  }, [runCheck])

  const rows = proof && Array.isArray(proof.recent) ? proof.recent : []
  const shown = onlyOutside ? outsideRows : rows
  const retired = new Set((proof?.retiredPayers ?? []).map((r) => r.address.toLowerCase()))
  const outsideWallets = new Set(outsideRows.map((r) => (r.payer ?? '').toLowerCase()).filter(Boolean)).size
  const outsideCount = proof ? (proof.externalSettlements ?? outsideRows.length) : null
  const lastOutside = outsideRows[0]
  const newOutside = outsideRows.filter((r) => arrived.has(rowKey(r))).length
  const secondsAgo = checkedAt ? Math.max(0, Math.round((now - checkedAt) / 1000)) : null
  const hiddenOutside = (outsideCount ?? 0) > 0 && outsideRows.length === 0

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main>
        <SectionShell size="lg">
          <SectionIntro
            eyebrow={<Eyebrow>Celo payments</Eyebrow>}
            heading={
              <DisplayHeading size="display" className="max-w-[16ch]">
                Payments on Celo, live.
              </DisplayHeading>
            }
            lede={
              <Lede>
                Every paid check our backend logs on Celo shows up here within seconds of settling.
                The page reads the settlement log every 10 seconds, labels our own wallets, and
                checks each outside payment on the Celo chain itself.
              </Lede>
            }
          />

          <div className="mt-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-3">
            <span role="status" className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
              {hidden ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-foreground/30" /> Paused while this tab is in the background
                </>
              ) : !proof ? (
                failure ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-danger" /> Not connected to the log yet
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-foreground/30" /> Connecting
                  </>
                )
              ) : failure ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-warn" /> The last refresh failed, trying again
                </>
              ) : (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:animate-none" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
                  </span>
                  Live
                </>
              )}
            </span>
            <span className="text-xs text-foreground/65">
              {secondsAgo === null ? (failure ? 'the log did not answer' : 'loading the log') : `updated ${secondsAgo}s ago`}
              {newOutside > 0 ? `, ${newOutside} new outside payment${newOutside === 1 ? '' : 's'} since you opened this page` : ''}
            </span>
            <span className="sr-only" role="status" aria-live="polite">
              {newOutside > 0 ? `${newOutside} new outside payment${newOutside === 1 ? '' : 's'} since you opened this page` : ''}
            </span>
          </div>

          {failure && !proof && (
            <motion.div
              {...reveal}
              className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <p className="text-sm text-foreground/65">
                {failure === 'missing' ? 'The backend is up, but its Celo log is not available right now.' : BACKEND_UNREACHABLE}
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
              >
                <RefreshCw size={13} /> Retry now
              </button>
            </motion.div>
          )}

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Outside payments" value={outsideCount === null ? <Skeleton /> : outsideCount.toLocaleString('en-US')} raised />
            <Stat label="Outside wallets, latest 50" value={proof ? outsideWallets.toLocaleString('en-US') : <Skeleton />} raised />
            <Stat
              label="Last outside payment"
              value={
                proof ? (lastOutside ? agoOf(lastOutside.ts) : hiddenOutside ? 'before the latest 50' : 'none yet') : <Skeleton />
              }
              raised
            />
            <Stat label="Payments on the log" value={proof ? proof.totalSettlements.toLocaleString('en-US') : <Skeleton />} raised />
          </div>

          <section className="mt-8 rounded-3xl border border-border bg-card p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-bold tracking-tight text-foreground">
                {onlyOutside ? 'Outside payments' : 'Latest 50 payments'}
              </h2>
              <div className="inline-flex rounded-full border border-border p-0.5 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setOnlyOutside(true)}
                  aria-pressed={onlyOutside}
                  className={`rounded-full px-3 py-1.5 transition-colors ${onlyOutside ? 'bg-foreground text-background' : 'text-foreground/65 hover:text-foreground'}`}
                >
                  Outside only
                </button>
                <button
                  type="button"
                  onClick={() => setOnlyOutside(false)}
                  aria-pressed={!onlyOutside}
                  className={`rounded-full px-3 py-1.5 transition-colors ${!onlyOutside ? 'bg-foreground text-background' : 'text-foreground/65 hover:text-foreground'}`}
                >
                  All, latest 50
                </button>
              </div>
            </div>

            {!proof ? (
              <div className="mt-6 flex flex-col gap-3">
                <Skeleton />
                <Skeleton />
              </div>
            ) : shown.length === 0 ? (
              <p className="mt-6 rounded-2xl border border-dashed border-border px-5 py-6 text-sm leading-relaxed text-foreground/65">
                {onlyOutside ? (
                  hiddenOutside ? (
                    <>
                      {outsideCount} outside payment{outsideCount === 1 ? ' is' : 's are'} on the log, none among the latest it
                      returns. The full log is on the{' '}
                      <Link to="/celo-proof" className="text-term-prompt underline-offset-2 hover:underline">
                        settlement proof page
                      </Link>
                      .
                    </>
                  ) : (
                    'No outside payment yet. Keep this page open: a new payment appears here on its own within seconds of settling.'
                  )
                ) : (
                  'Nothing has settled on Celo yet.'
                )}
              </p>
            ) : (
              <ul className="mt-5 flex flex-col gap-2.5">
                {shown.map((r) => {
                  const key = rowKey(r)
                  const isNew = arrived.has(key)
                  const isRetired = !!r.payer && retired.has(r.payer.toLowerCase())
                  return (
                    <li
                      key={key}
                      className={`grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border px-4 py-3 transition-colors sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6 ${
                        isNew ? 'border-ok/40 bg-ok/[0.06]' : 'border-border bg-background'
                      }`}
                    >
                      <div className="flex flex-col sm:min-w-[9rem]">
                        <span className="text-sm font-semibold text-foreground" title={utcOf(r.ts)}>
                          {agoOf(r.ts)}
                        </span>
                        <span className="font-mono text-[11px] text-foreground/65">{utcOf(r.ts)}</span>
                      </div>
                      <div className="flex flex-col sm:min-w-[8rem]">
                        <span className="text-sm text-foreground">{r.tool}</span>
                        <span className="font-mono text-[11px] text-foreground/65">{usd(r.amountUsd)} USDC</span>
                      </div>
                      <div className="flex flex-col gap-1 sm:min-w-[9rem]">
                        <span className="inline-flex items-center gap-2">
                          <WhoBadge internal={r.internal} retired={isRetired} />
                          {isNew && (
                            <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-term-prompt">
                              new
                            </span>
                          )}
                        </span>
                        {r.payer ? (
                          <span className="text-xs">
                            <ExplorerLink path={`address/${r.payer}`}>{short(r.payer)}</ExplorerLink>
                          </span>
                        ) : (
                          <span className="text-xs text-foreground/65">payer not recorded</span>
                        )}
                      </div>
                      <div className="flex flex-col items-start gap-1 sm:min-w-[10rem] sm:items-end">
                        {r.tx ? (
                          <span className="text-xs">
                            <ExplorerLink path={`tx/${r.tx}`}>{short(r.tx, 6)}</ExplorerLink>
                          </span>
                        ) : (
                          <span className="text-xs text-foreground/65">no transaction hash</span>
                        )}
                        {!r.internal && r.tx ? <ChainMark state={checks[r.tx.toLowerCase()]} /> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <p className="mt-5 text-xs leading-relaxed text-foreground/65">
              Ours means a wallet the log lists as ours. Retired means an address A-Identity retired.
              Neither counts as outside; outside means any other payer. The list shows the latest
              payments the log returns, and the totals cover the log&apos;s whole retained window. On
              chain means the receipt succeeded and carries a USDC transfer from that payer to the
              pay-to of that day for exactly this amount.
            </p>
          </section>

          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <Link
              to="/check/celo"
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 font-semibold text-background transition-opacity hover:opacity-90"
            >
              Make a paid check on Celo
            </Link>
            <Link
              to="/celo-proof"
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 font-semibold text-foreground/75 transition-colors hover:bg-foreground/[0.04]"
            >
              Full settlement log
            </Link>
          </div>
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
