/**
 * The Stellar policy vaults, as the ledger has them right now.
 *
 * A public read: GET /api/stellar/vaults re-reads each vault's own state from Soroban on
 * every load, so this block is live rather than a copy of what we once deployed. A network
 * the RPC could not answer says so, with the reason, instead of rendering an empty row.
 *
 * Soroban contract state expires, so each row also carries its TTL: the ledger the vault
 * stays live until, and roughly when it would archive if nobody bumps it.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { Skeleton } from '../ui/skeleton'

type VaultLive = { reachable: boolean; ledger?: number; checkedAt?: string; reason?: string }

type VaultOnChain = {
  owner?: string
  operator?: string
  token?: string
  decimals?: number
  dailyCapUsd?: number
  autoApproveUsd?: number
  spentTodayUsd?: number
  balanceUsd?: number
  frozen?: boolean
  allowlistEnabled?: boolean
  sessionKeyExpiry?: number
}

type VaultTtl = { liveUntilLedger?: number; remainingLedgers?: number; approxDays?: number; archivesAround?: string }

type StellarVaultRow = {
  chain: string
  caip2: string
  network: 'pubnet' | 'testnet'
  status: string
  contract: string
  explorerUrl: string | null
  live: VaultLive
  state?: VaultOnChain
  ttl?: VaultTtl
  /** What kind of key owns it: a passkey smart account (C...) or a plain account (G...).
   *  Absent on an older backend, which is why nothing is inferred from the address. */
  ownerKind?: 'smart-account' | 'account'
}

type StellarVaultsResponse = { checkedAt: string; vaults: StellarVaultRow[] }

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-ok/10 text-ok'
      : tone === 'warn'
        ? 'bg-warn/10 text-warn'
        : tone === 'danger'
          ? 'bg-danger/10 text-danger'
          : 'bg-foreground/[0.06] text-foreground/60'
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{children}</span>
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

const usd = (n: number | undefined, digits = 2): string => (typeof n === 'number' ? `$${n.toFixed(digits)}` : '-')

/** "Nov 4, 2026" from whatever date string the backend sent; the raw string if it is not one. */
function archiveDate(value: string | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id
}

/**
 * One row per Stellar network. `heading` and `caption` are supplied by whoever mounts it,
 * because the same block introduces itself differently on a public proof page and inside
 * the console.
 */
export default function StellarVaultsLive({
  heading,
  caption,
  className = '',
}: {
  heading?: string
  caption?: string
  className?: string
}) {
  const [data, setData] = useState<StellarVaultsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    apiFetch('/api/stellar/vaults')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = (await res.json()) as StellarVaultsResponse
        if (active) setData(j)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [])

  const vaults = data?.vaults ?? []

  return (
    <div className={className}>
      {heading && <h2 className="text-lg font-bold tracking-tight text-foreground">{heading}</h2>}
      {caption && <p className="mt-1 text-sm leading-relaxed text-foreground/55">{caption}</p>}

      {!data && !failed && (
        <div className="mt-3 grid gap-px overflow-hidden rounded-2xl border border-border bg-border">
          {[0, 1].map((i) => (
            <div key={i} className="bg-card p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-3 w-full" />
            </div>
          ))}
        </div>
      )}

      {failed && (
        <p className="mt-3 text-sm text-foreground/55">
          Could not read the Stellar vaults right now. The backend may be waking up (free tier); reload in a moment.
        </p>
      )}

      {data && vaults.length === 0 && (
        <p className="mt-3 text-sm text-foreground/55">No Stellar vault is published yet.</p>
      )}

      {vaults.length > 0 && (
        <div className="mt-3 grid gap-px overflow-hidden rounded-2xl border border-border bg-border">
          {vaults.map((v) => {
            const s = v.state
            const archives = archiveDate(v.ttl?.archivesAround)
            return (
              <div key={v.caip2 + v.contract} className="bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={v.network === 'pubnet' ? 'ok' : 'warn'}>{v.network}</Chip>
                    {v.live.reachable ? (
                      s?.frozen ? (
                        <Chip tone="danger">frozen</Chip>
                      ) : (
                        <Chip tone="muted">not frozen</Chip>
                      )
                    ) : (
                      <Chip tone="warn">unreachable</Chip>
                    )}
                    {v.ownerKind === 'smart-account' && <Chip tone="muted">passkey owner</Chip>}
                  </div>
                  {v.explorerUrl ? (
                    <a
                      href={v.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-accent underline-offset-2 hover:underline"
                    >
                      {shortId(v.contract)} <ArrowUpRight size={12} className="shrink-0" />
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-foreground/60">{shortId(v.contract)}</span>
                  )}
                </div>

                {v.live.reachable && s ? (
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Cell label="Daily cap" value={usd(s.dailyCapUsd)} />
                    <Cell label="Per payment" value={usd(s.autoApproveUsd)} />
                    <Cell label="Spent today" value={usd(s.spentTodayUsd)} />
                    <Cell label="Balance" value={usd(s.balanceUsd)} />
                  </div>
                ) : (
                  <p className="mt-3 text-xs leading-relaxed text-foreground/55">
                    {v.live.reason ?? 'The RPC did not answer, so this row has no live state to show.'}
                  </p>
                )}

                {archives && (
                  <p className="mt-3 text-[11px] text-foreground/45">
                    Archives around {archives}
                    {typeof v.ttl?.approxDays === 'number' ? ` (~${v.ttl.approxDays} days)` : ''}
                    {typeof v.live.ledger === 'number' ? `, read at ledger ${v.live.ledger}` : ''}
                  </p>
                )}

                {/* A vault a passkey owns is one anyone can make for themselves, so the row
                    that shows one links the page where they do it. */}
                {v.ownerKind === 'smart-account' && (
                  <p className="mt-3 text-[11px]">
                    <Link to="/stellar" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
                      Make one of these with your own passkey <ArrowUpRight size={11} className="shrink-0" />
                    </Link>
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
