import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeftRight, Coins, CornerDownLeft, CreditCard, Fingerprint,
  LayoutDashboard, Search, Send, SlidersHorizontal, Snowflake, Store,
} from 'lucide-react'

/**
 * The console's command surface.
 *
 * Everything in this console is a form, which means the only way to do anything is to know
 * which of seven pages hides it. This is the one place you can type what you want. It is
 * deliberately NOT a chat box: it does not interpret language, it does not call a model, it
 * routes. A surface that looks like it understands you and then does not is worse than no
 * surface, so this one only claims what it does.
 *
 * Two kinds of entry:
 *   - commands, which go somewhere or start something
 *   - a lookup, when what you typed looks like an agent id or a wallet address, which opens
 *     the public explorer for it
 */
type Cmd = {
  id: string
  label: string
  hint: string
  icon: typeof Search
  to: string
  keywords: string
}

const COMMANDS: Cmd[] = [
  { id: 'pay', label: 'New payment', hint: 'Settlements', icon: Send, to: '/app/settlements', keywords: 'pay send transfer usdc payment new' },
  { id: 'approve', label: 'Review what is waiting', hint: 'Settlements', icon: ArrowLeftRight, to: '/app/settlements', keywords: 'approve pending queue waiting review' },
  { id: 'limits', label: 'Change limits', hint: 'Permissions', icon: SlidersHorizontal, to: '/app/permissions', keywords: 'limit cap permission policy allow spend daily' },
  { id: 'freeze', label: 'Freeze all activity', hint: 'Permissions', icon: Snowflake, to: '/app/permissions', keywords: 'freeze stop pause halt emergency panic' },
  { id: 'overview', label: 'Overview', hint: 'Console', icon: LayoutDashboard, to: '/app', keywords: 'home dashboard overview status' },
  { id: 'identity', label: 'Agent ID', hint: 'Console', icon: Fingerprint, to: '/app/agent-id', keywords: 'identity passport erc-8004 kya register verify reputation' },
  { id: 'wallet', label: 'Wallet', hint: 'Console', icon: CreditCard, to: '/app/wallet', keywords: 'wallet balance usdc fund faucet treasury' },
  { id: 'market', label: 'Marketplace', hint: 'Console', icon: Store, to: '/app/marketplace', keywords: 'marketplace hire agent house worker' },
  { id: 'earnings', label: 'Earnings', hint: 'Console', icon: Coins, to: '/app/earnings', keywords: 'earnings revenue paid jobs gateway' },
]

/** An agent id (#849980, eip155:...), or a 0x wallet address. */
function looksLikeAgent(q: string): boolean {
  const s = q.trim()
  return /^#?\d{3,}$/.test(s) || /^0x[0-9a-fA-F]{6,}$/.test(s) || /^eip155:/.test(s)
}

export default function CommandBar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    const lookup: Cmd[] = looksLikeAgent(q)
      ? [{
          id: 'lookup',
          label: `Look up ${q.trim()}`,
          hint: 'Explorer · identity, reputation and risk',
          icon: Search,
          to: `/explorer?q=${encodeURIComponent(q.trim().replace(/^#/, ''))}`,
          keywords: '',
        }]
      : []
    if (!s) return [...lookup, ...COMMANDS]
    return [...lookup, ...COMMANDS.filter((c) => `${c.label} ${c.hint} ${c.keywords}`.toLowerCase().includes(s))]
  }, [q])

  useEffect(() => setActive(0), [q])

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    const t = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(t)
  }, [open])

  const run = useCallback(
    (c: Cmd | undefined) => {
      if (!c) return
      onClose()
      navigate(c.to)
    },
    [navigate, onClose],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); run(results[active]) }
  }

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/25 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Console commands"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search size={16} className="shrink-0 text-foreground/35" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command, or paste an agent id"
            aria-label="Type a command, or paste an agent id"
            className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-foreground/35"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-foreground/40">esc</kbd>
        </div>

        <ul ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-foreground/45">
              Nothing matches that. Try "pay", "limits" or an agent id.
            </li>
          )}
          {results.map((c, i) => {
            const Icon = c.icon
            return (
              <li key={c.id} data-i={i}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    i === active ? 'bg-accent/[0.08]' : ''
                  }`}
                >
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${i === active ? 'bg-accent text-white' : 'bg-foreground/[0.06] text-foreground/55'}`}>
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{c.label}</span>
                    <span className="block truncate text-[11px] text-foreground/45">{c.hint}</span>
                  </span>
                  {i === active && <CornerDownLeft size={13} className="shrink-0 text-foreground/30" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
