import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Search } from 'lucide-react'
import AppPage from '../../components/app/AppPage'
import CopyBlock from '../../components/app/CopyBlock'
import { Input } from '../../components/ui/input'
import { Skeleton } from '../../components/ui/skeleton'
import { apiFetch } from '../../lib/api'
import { ago } from '../../lib/format'
import { authHeaders } from '../../store/auth'

/**
 * Checks: every agent check an Algorand account paid for, each with its on-chain receipt.
 *
 * The addresses come from the signed-in person's own linked wallets. Payers are public on
 * the ledger, so any address can also be pasted and read; nothing here needs a key.
 */

type Receipt = { ts: string; tool: string; amountUsd: number; tx?: string; explorerUrl?: string }
type Receipts = { payer: string; count: number; totalUsd: number; receipts: Receipt[] }
type WalletListing = { session?: { ecosystem: string; address: string } | null; wallets?: { ecosystem: string; address: string }[] }

const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/

const ASKED: Record<string, string> = {
  risk_check: 'Should I pay this agent?',
  verify_agent: 'Is it who it says it is?',
  reputation_score: 'How has it behaved?',
  agent_passport: 'Everything, in one answer',
  agent_batch_audit: 'A whole shortlist',
}

const MCP_COMMAND = 'claude mcp add a-identity-trust \\\n  -e A_IDENTITY_ALGORAND_MNEMONIC="your 25 words" \\\n  -- npx -y @a-identity/trust-mcp'

const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

export default function Checks() {
  const [addresses, setAddresses] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [data, setData] = useState<Receipts | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [walletsRead, setWalletsRead] = useState(false)

  // The signed-in person's Algorand addresses: the one they signed in with, then any linked.
  useEffect(() => {
    let alive = true
    apiFetch('/api/user/wallets', { headers: authHeaders() })
      .then((res) => (res.ok ? (res.json() as Promise<WalletListing>) : null))
      .then((listing) => {
        if (!alive) return
        const found = [
          ...(listing?.session?.ecosystem === 'algorand' ? [listing.session.address] : []),
          ...(listing?.wallets ?? []).filter((w) => w.ecosystem === 'algorand').map((w) => w.address),
        ]
        const unique = [...new Set(found)]
        setAddresses(unique)
        setSelected((cur) => cur ?? unique[0] ?? null)
      })
      .catch(() => {
        /* a guest or a cold backend simply has no linked address; pasting still works */
      })
      .finally(() => {
        if (alive) setWalletsRead(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const load = useCallback(async (payer: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/x402/algorand/receipts?payer=${encodeURIComponent(payer)}`)
      if (!res.ok) throw new Error(res.status === 400 ? 'That is not an Algorand address.' : `The receipts could not be read (HTTP ${res.status}).`)
      setData((await res.json()) as Receipts)
    } catch (e) {
      setData(null)
      setError(e instanceof Error ? e.message : 'The receipts could not be read.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selected) void load(selected)
  }, [selected, load])

  const onLookup = (e: FormEvent) => {
    e.preventDefault()
    const addr = input.trim().toUpperCase()
    if (!ALGORAND_ADDRESS.test(addr)) {
      setError('Paste a 58-character Algorand address.')
      return
    }
    setSelected(addr)
  }

  const last = data?.receipts[0]

  return (
    <AppPage title="Checks" description="Every agent check your account paid for on Algorand, with its receipt.">
      <div className="mt-6 flex flex-col gap-4">
        {/* Whose checks: the linked addresses as one-click chips, plus any address pasted in. */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            {!walletsRead && <Skeleton className="h-7 w-40" />}
            {addresses.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setSelected(a)}
                className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                  selected === a ? 'border-accent bg-accent/10 text-foreground' : 'border-border text-foreground/65 hover:text-foreground'
                }`}
              >
                {shortAddr(a)}
              </button>
            ))}
            {walletsRead && addresses.length === 0 && (
              <span className="text-sm text-foreground/60">
                No Algorand wallet linked.{' '}
                <Link to="/app/profile" className="font-semibold text-accent hover:underline">
                  Link one
                </Link>{' '}
                or paste an address.
              </span>
            )}
          </div>
          <form onSubmit={onLookup} className="mt-3 flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40" />
              <Input
                id="checks-address"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Algorand address"
                placeholder="Any Algorand address"
                className="h-10 rounded-lg pl-9 font-mono text-xs"
              />
            </div>
            <button type="submit" className="h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90">
              Show
            </button>
          </form>
        </div>

        {error && <div className="rounded-xl border border-warn/25 bg-warn/10 p-4 text-sm text-foreground/75">{error}</div>}

        {/* The numbers, then the receipts. */}
        {selected && !error && (
          <>
            <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
              <div className="bg-card p-5">
                {loading ? <Skeleton className="h-8 w-12" /> : <div className="text-2xl font-bold tabular-nums text-foreground">{data?.count ?? 0}</div>}
                <div className="mt-1 text-[12px] text-foreground/55">checks paid</div>
              </div>
              <div className="bg-card p-5">
                {loading ? <Skeleton className="h-8 w-16" /> : <div className="text-2xl font-bold tabular-nums text-foreground">${data?.totalUsd ?? 0}</div>}
                <div className="mt-1 text-[12px] text-foreground/55">USDC spent on checks</div>
              </div>
              <div className="bg-card p-5">
                {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-2xl font-bold text-foreground">{last ? ago(last.ts) : '-'}</div>}
                <div className="mt-1 text-[12px] text-foreground/55">last check</div>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {loading ? (
                <div className="flex flex-col gap-3 p-5">
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-full" />
                </div>
              ) : data && data.receipts.length > 0 ? (
                data.receipts.map((r) => (
                  <div key={r.tx ?? r.ts} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5 last:border-0">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{ASKED[r.tool] ?? r.tool}</div>
                      <div className="text-[11px] text-foreground/45">
                        <span className="font-mono">{r.tool}</span> · {ago(r.ts)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-bold tabular-nums text-foreground">${r.amountUsd}</span>
                      {r.explorerUrl && (
                        <a href={r.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                          receipt <ArrowUpRight size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="p-5 text-sm text-foreground/60">No paid checks from this account yet. Connect your agent below and its first check shows up here.</p>
              )}
            </div>
          </>
        )}

        <CopyBlock title="Connect your agent" subtitle="It pays from its own account, and never above its limit" text={MCP_COMMAND} />
        <Link to="/algorand" className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-accent hover:underline">
          Prices and a free try <ArrowUpRight size={14} />
        </Link>
      </div>
    </AppPage>
  )
}
