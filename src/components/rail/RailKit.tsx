import { useEffect, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Search } from 'lucide-react'
import VerifyStepper from '../landing/VerifyStepper'
import { Input } from '../ui/input'
import { CHECK_EXAMPLES } from '../../lib/rail'
import { getReputation, resolveAgent, type AgentIdentity, type Reputation } from '../../lib/mcp-client'

/**
 * The live check every per-chain landing page (/arc, /algorand) opens with: it runs by
 * itself when the page loads, so the first thing a visitor sees is the product working.
 * Lifted out of /algorand the day /arc arrived, so the two pages cannot drift into two
 * different versions of the same demo. Its non-component helpers live in lib/rail.ts.
 */

export function TryIt({
  inputId,
  examples = CHECK_EXAMPLES,
  footnote = 'Free preview. Your agent gets the signed verdict for $0.05.',
}: {
  inputId: string
  examples?: { label: string; q: string }[]
  footnote?: string
}) {
  const [query, setQuery] = useState(examples[0].q)
  const [loading, setLoading] = useState(false)
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [reputation, setReputation] = useState<Reputation | null>(null)
  const [shown, setShown] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)
  const firstQuery = useRef(examples[0].q)

  async function check(raw: string) {
    const q = raw.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    const [idRes, repRes] = await Promise.all([resolveAgent(q), getReputation(q)])
    const id = idRes.ok && idRes.data.found ? (idRes.data.agent ?? null) : null
    const rep = repRes.ok && repRes.data.found ? (repRes.data.reputation ?? null) : null
    setIdentity(id)
    setReputation(rep)
    setShown(q)
    // "Not found" and "could not ask" are different answers, so they get different words.
    if (!idRes.ok && !repRes.ok) setError('The oracle could not be reached just now. Try again in a few seconds.')
    else if (!id && !rep) setError(`No agent found for "${q}". Try a token id or an owner address.`)
    setLoading(false)
  }

  // The check runs by itself once, so the first thing a visitor sees is the product working.
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void check(firstQuery.current)
  }, [])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void check(query)
  }

  return (
    <div className="rounded-3xl border border-border bg-card p-5 sm:p-7">
      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
          <Input
            id={inputId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Agent to check"
            placeholder="Agent id or owner address"
            className="h-11 rounded-lg pl-10 font-mono text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          Check
        </button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
        Try
        {examples.map((ex) => (
          <button
            key={ex.q}
            type="button"
            onClick={() => {
              setQuery(ex.q)
              void check(ex.q)
            }}
            className="rounded-full border border-border px-3 py-1 font-semibold text-foreground/70 transition-colors hover:border-accent/50 hover:text-foreground"
          >
            {ex.label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {error && <p className="rounded-xl border border-border bg-background p-4 text-sm text-foreground/60">{error}</p>}
        {!error && (identity || reputation) && (
          <motion.div key={shown} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
            <VerifyStepper identity={identity} reputation={reputation} query={shown} />
          </motion.div>
        )}
        {!error && loading && !identity && !reputation && <div className="h-40 animate-pulse rounded-2xl bg-foreground/[0.05]" />}
      </div>
      <p className="mt-4 text-xs text-foreground/50">{footnote}</p>
    </div>
  )
}
