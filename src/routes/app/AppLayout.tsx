import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeftRight,
  Coins,
  CreditCard,
  Fingerprint,
  LayoutDashboard,
  Lock,
  LogOut,
  Search,
  SlidersHorizontal,
  Store,
} from 'lucide-react'
import CommandBar from '../../components/app/CommandBar'
import Logo from '../../components/Logo'
import ThemeToggle from '../../components/ThemeToggle'
import { useTheme } from '../../components/ThemeProvider'
import { useAuth } from '../../store/auth'
import { APP_NAME } from '../../lib/brand'
import { useMcpHealth } from '../../hooks/useMcp'
import { wakeBackend } from '../../lib/api'

/**
 * The sidebar, grouped.
 *
 * Seven items in one flat list gave the eye nothing to hold on to, so finding a screen
 * meant reading all seven every time. Grouped by what the screen is ABOUT, each group
 * answers a different question: who the agent is and what it may do, where its money is,
 * and who else is out there. Overview sits above the groups because it is not a category,
 * it is the way back.
 */
const NAV = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
] as const

const NAV_GROUPS = [
  {
    label: 'Agent',
    items: [
      { to: '/app/agent-id', label: 'Agent ID', icon: Fingerprint },
      { to: '/app/permissions', label: 'Permissions', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/app/wallet', label: 'Wallet', icon: CreditCard },
      { to: '/app/settlements', label: 'Settlements', icon: ArrowLeftRight },
      { to: '/app/earnings', label: 'Earnings', icon: Coins },
    ],
  },
  {
    label: 'Network',
    items: [{ to: '/app/marketplace', label: 'Marketplace', icon: Store }],
  },
] as const

/** Flat list of every destination, for the breadcrumb and the mobile bar. */
const ALL_NAV = [...NAV, ...NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, end: false as const })))]

/**
 * One row, in both the grouped desktop rail and the mobile bar.
 *
 * The active row used to be a solid accent block with white text, which is the loudest
 * thing a console can do with its most permanent element: it competed with the page for
 * attention on every screen. A soft fill plus an accent icon says the same thing quietly.
 */
const rowClass = (isActive: boolean) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive ? 'bg-foreground/[0.06] font-semibold text-foreground' : 'font-medium text-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground/85'
  }`

/**
 * The console canvas. One width, declared once, shared by the topbar, the banners and
 * every page, so nothing shifts horizontally as you move between screens. Pages choose
 * how wide their content runs INSIDE this (see AppPage), never how wide the frame is.
 */
const CANVAS = 'mx-auto w-full max-w-7xl'

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuth((s) => s.user)
  const verified = useAuth((s) => s.verified)
  const logout = useAuth((s) => s.logout)
  const mcp = useMcpHealth()
  // An unverified (guest) session is browse-only: reads work, but the backend rejects
  // its writes. Derived from `verified` (not the in-memory token, which is null after a
  // cookie-restored reload). Surface it up front so an action never fails silently.
  const isGuest = Boolean(user) && !verified

  // Pre-warm the free-tier backend the moment the console opens, so it is already awake
  // by the time the user clicks Anchor / Execute / Provision, heading off the cold-start
  // 502 instead of hitting it on the first action.
  useEffect(() => {
    wakeBackend()
  }, [])

  // Command surface. Cmd+K on a Mac, Ctrl+K elsewhere, and "/" when the caret is not
  // already in a field, which is the shortcut people try first without being told.
  const [cmdOpen, setCmdOpen] = useState(false)
  const cmdKeyLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setCmdOpen((v) => !v)
        return
      }
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setCmdOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Longest match wins: /app matches every console path, so it has to be considered last.
  const current = [...ALL_NAV].sort((a, b) => b.to.length - a.to.length).find((n) => location.pathname.startsWith(n.to))
  const title = current?.label ?? 'Overview'

  const onLogout = () => {
    logout()
    navigate('/')
  }

  const { theme } = useTheme()

  return (
    <div className={`flex min-h-screen w-full bg-background text-foreground ${theme === 'dark' ? 'dark' : ''}`}>
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-card px-4 py-6 md:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <Logo size={28} />
          <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto" aria-label="Console">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => rowClass(isActive)}>
              {({ isActive }) => (
                <>
                  <Icon size={17} className={isActive ? 'text-accent' : ''} />
                  {label}
                </>
              )}
            </NavLink>
          ))}

          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mt-5 border-t border-border pt-4 first:border-0">
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/35">
                {group.label}
              </div>
              <div className="flex flex-col gap-1">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <NavLink key={to} to={to} className={({ isActive }) => rowClass(isActive)}>
                    {({ isActive }) => (
                      <>
                        <Icon size={17} className={isActive ? 'text-accent' : ''} />
                        {label}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Backend status, one line. It used to be a card with a heading and a sentence
            restating the dot, which is a lot of the rail's height for a single bit. */}
        <div className="mt-4 flex items-center gap-2 px-3 py-2 text-[11px] text-foreground/45">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              mcp === 'checking'
                ? 'animate-pulse bg-foreground/25'
                : mcp === 'waking'
                  ? 'animate-pulse bg-amber-400'
                  : mcp === 'online'
                    ? 'bg-emerald-400'
                    : 'bg-red-400'
            }`}
          />
          <span className="truncate">
            {mcp === 'online'
              ? 'Live on-chain data'
              : mcp === 'waking'
                ? 'Backend waking up, ~30s'
                : mcp === 'checking'
                  ? 'Connecting...'
                  : 'Reconnecting...'}
          </span>
        </div>

        {/* Who is signed in. The console knew this and only showed it as an initial in the
            top-right corner, so the rail ended on a marketing sentence instead of on you. */}
        <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-border bg-foreground/[0.02] p-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-bold text-white">
            {user ? initials(user.name) : 'AI'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-foreground">{user?.name ?? 'Signed in'}</div>
            <div className="truncate text-[11px] text-foreground/45">{user?.email ?? ''}</div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            aria-label="Log out"
            title="Log out"
            className="shrink-0 rounded-lg p-1.5 text-foreground/40 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
          >
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar. Its contents ride the same canvas as the page below, so the
            breadcrumb sits directly above the page heading instead of drifting to the
            far edge on a wide display. */}
        <header className="sticky top-0 z-10 border-b border-border bg-background/80 px-5 py-4 backdrop-blur-md sm:px-8">
          <div className={`${CANVAS} flex items-center justify-between gap-4`}>
            <div className="flex items-center gap-2 md:hidden">
              <Logo size={24} />
            </div>
            {/* Breadcrumb (desktop): context without duplicating the page heading. */}
            <div className="hidden items-center gap-1.5 text-sm md:flex">
              <span className="text-foreground/40">Agent Console</span>
              <span className="text-foreground/25">/</span>
              <span className="font-medium text-foreground/70">{title}</span>
            </div>

            <div className="flex flex-1 items-center justify-end gap-3">
              {/* The command surface has to be visible to be discovered: a keyboard
                  shortcut nobody is told about is a feature only its author uses. */}
              <button
                type="button"
                onClick={() => setCmdOpen(true)}
                className="hidden items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70 sm:flex"
              >
                <Search size={13} />
                <span>Command</span>
                <kbd className="rounded border border-border px-1 py-px font-mono text-[10px]">{cmdKeyLabel}</kbd>
              </button>
              <button
                type="button"
                onClick={() => setCmdOpen(true)}
                aria-label="Open commands"
                className="rounded-lg p-1.5 text-foreground/50 hover:bg-foreground/[0.04] sm:hidden"
              >
                <Search size={16} />
              </button>

              {/* MCP status dot (mobile) */}
              <div className="flex items-center gap-1.5 md:hidden">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    mcp === 'online'
                      ? 'bg-emerald-400'
                      : mcp === 'waking'
                        ? 'animate-pulse bg-amber-400'
                        : 'bg-foreground/20'
                  }`}
                />
                <span className="text-xs text-foreground/40">MCP</span>
              </div>
              <ThemeToggle />
              <div className="grid h-9 w-9 place-items-center rounded-full bg-accent text-xs font-bold text-white">
                {user ? initials(user.name) : 'AI'}
              </div>
            </div>
          </div>
        </header>

        {/* Guest banner: browse-only session. Writes won't persist until they sign in. */}
        {isGuest && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-medium text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 sm:px-8">
            <div className={`${CANVAS} flex flex-wrap items-center gap-2`}>
              <Lock size={13} className="shrink-0" />
              You're browsing read-only as a guest. Registering, approving, and paying won't save.
              <Link to="/login" className="font-semibold underline underline-offset-2 hover:text-amber-950">
                Sign in with your wallet to act
              </Link>
            </div>
          </div>
        )}

        {/* Cold-start banner: the backend (free tier) may nap and take ~30s to wake. */}
        {mcp === 'waking' && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 sm:px-8">
            <div className={`${CANVAS} flex items-center gap-2`}>
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
              Waking up the demo backend (free tier), usually under 30s. Live data will appear shortly.
            </div>
          </div>
        )}

        {/* Mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-border bg-card px-4 py-2 md:hidden" aria-label="Console sections">
          {ALL_NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-foreground/[0.07] font-semibold text-foreground' : 'font-medium text-foreground/60'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={16} className={isActive ? 'text-accent' : ''} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <main className="flex-1 px-5 py-6 sm:px-8 sm:py-8">
          <div className={CANVAS}>
            <Outlet />
          </div>
        </main>
      </div>

      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  )
}
