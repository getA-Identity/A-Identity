import { Suspense, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeftRight,
  Compass,
  HelpCircle,
  Coins,
  CreditCard,
  Fingerprint,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Search,
  SlidersHorizontal,
  Store,
  X,
} from 'lucide-react'
import CommandBar from '../../components/app/CommandBar'
import ConsoleTour from '../../components/app/ConsoleTour'
import { TOURS } from '../../components/app/tours'
import DotField from '../../components/app/DotField'
import Logo from '../../components/Logo'
import ThemeToggle from '../../components/ThemeToggle'
import { useTheme } from '../../components/ThemeProvider'
import { ConsoleAmbientContext } from '../../components/app/consoleAmbient'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { useAuth } from '../../store/auth'
import { APP_NAME } from '../../lib/brand'
import { useMcpHealth } from '../../hooks/useMcp'
import { useScreenTransition } from '../../hooks/useScreenTransition'
import { wakeBackend } from '../../lib/api'
import '../../console.css'

/**
 * The sidebar, grouped.
 *
 * Grouped by what the screen is ABOUT: who the agent is and what it may do, where its
 * money is, and who else is out there. Overview sits above the groups because it is not
 * a category, it is the way back.
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

/** Flat list of every destination, for the breadcrumb. */
const ALL_NAV = [...NAV, ...NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, end: false as const })))]

/**
 * One row, in both the desktop rail and the mobile drawer. Hover is purely tonal
 * (wash + text lift), the active row is a soft fill with an accent icon: the rail
 * is the console's most permanent element, so it stays quiet.
 */
const rowClass = (isActive: boolean) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-[120ms] ${
    isActive ? 'bg-foreground/[0.06] font-semibold text-foreground' : 'font-medium text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground/85'
  }`

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Boot skeleton shown while a page chunk loads: one small breathing disc. */
function BootPulse() {
  return (
    <div className="grid h-full min-h-[50vh] w-full place-items-center">
      <span className="cn-skeleton h-9 w-9 rounded-full bg-foreground/15" />
    </div>
  )
}

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuth((s) => s.user)
  const verified = useAuth((s) => s.verified)
  const logout = useAuth((s) => s.logout)
  const mcp = useMcpHealth()
  // An unverified (guest) session is browse-only: reads work, but the backend rejects
  // its writes. Surface it up front so an action never fails silently.
  const isGuest = Boolean(user) && !verified

  // Pre-warm the free-tier backend the moment the console opens, so it is already awake
  // by the time the user clicks Anchor / Execute / Provision.
  useEffect(() => {
    wakeBackend()
  }, [])

  // Command surface. Cmd+K on a Mac, Ctrl+K elsewhere, and "/" when the caret is not
  // already in a field.
  const [cmdOpen, setCmdOpen] = useState(false)
  const cmdKeyLabel =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'
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

  // Mobile drawer: off-canvas rail + scrim. Closes on navigation and on Escape.
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // Longest match wins: /app matches every console path, so it is considered last.
  const current = [...ALL_NAV].sort((a, b) => b.to.length - a.to.length).find((n) => location.pathname.startsWith(n.to))
  const title = current?.label ?? 'Overview'

  const onLogout = () => {
    logout()
    navigate('/')
  }

  const { theme } = useTheme()

  // Theme flip: arm a class for ~880ms around a theme change so every painted
  // property cross-fades (see console.css). Skipped on first render.
  const [flipping, setFlipping] = useState(false)
  const firstTheme = useRef(true)
  useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false
      return
    }
    setFlipping(true)
    const t = setTimeout(() => setFlipping(false), 880)
    return () => clearTimeout(t)
  }, [theme])

  // Guided tours, one per screen. Each auto-opens on the FIRST visit to its
  // screen (after the enter choreography settles) and can be replayed from the
  // help button or the account menu. Seen-state is per page, per browser.
  const [tourOpen, setTourOpen] = useState(false)
  const pageTour = TOURS[location.pathname]
  useEffect(() => {
    setTourOpen(false)
    if (!pageTour) return
    try {
      if (localStorage.getItem(pageTour.storageKey)) return
    } catch {
      return
    }
    const t = setTimeout(() => setTourOpen(true), 1300)
    return () => clearTimeout(t)
  }, [location.pathname, pageTour])
  const replayTour = () => {
    if (pageTour) setTourOpen(true)
  }

  // Screen transitions: pages render the committed location; the old screen exits
  // for 200ms, then the new one enters with a row stagger.
  const { node, screenKey, phase } = useScreenTransition()

  // Ambient dot layer: a page opts in (AppPage's `ambient` prop) and the shell
  // draws it edge to edge behind the whole content pane, where the page itself
  // could never reach (its column is narrower than the pane).
  const [ambient, setAmbient] = useState(false)

  /** The rail's inner blocks, shared by the desktop aside and the mobile drawer. */
  const railContent = (
    <>
      <div className="mb-8 flex items-center gap-2 px-2">
        <Logo size={28} />
        <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Console">
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

      {/* Backend status, one line. */}
      <div className="mt-4 flex items-center gap-2 px-3 py-2 text-[11px] text-foreground/45">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            mcp === 'checking'
              ? 'animate-pulse bg-foreground/25'
              : mcp === 'waking'
                ? 'animate-pulse bg-warn'
                : mcp === 'online'
                  ? 'bg-ok'
                  : 'bg-danger'
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

      {/* Who is signed in. */}
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
    </>
  )

  return (
    <div
      className={`console-shell ${theme === 'dark' ? 'dark' : ''} ${flipping ? 'cn-theme-flip' : ''} grid h-dvh w-full grid-cols-1 overflow-hidden bg-background text-foreground [grid-template-rows:minmax(0,1fr)] md:grid-cols-[16rem_1fr]`}
    >
      {/* Desktop rail: borderless, on the bare canvas, staggered in on mount. */}
      <aside data-tour="rail" className="cn-rail-anim hidden h-full min-h-0 flex-col px-4 py-6 md:flex">{railContent}</aside>

      {/* Mobile drawer + scrim */}
      {drawerOpen && (
        <>
          <div
            className="cn-scrim fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background px-4 py-6 shadow-xl md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-3 rounded-lg p-1.5 text-foreground/50 hover:bg-foreground/[0.06]"
            >
              <X size={18} />
            </button>
            {railContent}
          </aside>
        </>
      )}

      {/* Main pane: the whole console lives on one floating card. min-h-0 keeps the
          pane pinned to the viewport row so the scroll happens INSIDE the card. */}
      <div className="min-h-0 min-w-0 p-3 md:pl-0">
        <div className="cn-boot-anim relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {/* Topbar: breadcrumb + command + status, one quiet 48px row. */}
          <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open menu"
                className="rounded-lg p-1.5 text-foreground/60 hover:bg-foreground/[0.05] md:hidden"
              >
                <Menu size={17} />
              </button>
              <div className="flex items-center gap-2 md:hidden">
                <Logo size={22} />
              </div>
              {/* Breadcrumb: micro-caps context without duplicating the page heading. */}
              <div className="hidden min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] md:flex">
                <span className="text-foreground/40">Agent Console</span>
                <span className="text-foreground/25">/</span>
                <span className="truncate text-foreground/75">{title}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                data-tour="command"
                onClick={() => setCmdOpen(true)}
                className="hidden items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/50 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground/70 sm:flex"
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

              {/* Page tour: every screen explains itself on demand. */}
              {pageTour && (
                <button
                  type="button"
                  onClick={replayTour}
                  aria-label="Show the page tour"
                  title="Page tour"
                  className="rounded-lg p-1.5 text-foreground/50 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground/75"
                >
                  <HelpCircle size={16} />
                </button>
              )}

              <ThemeToggle />

              {/* Account menu. The avatar is a real control now: who you are, how the
                  backend is doing, and the way out, one press away on every screen. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-tour="account"
                    aria-label="Account menu"
                    className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[11px] font-bold text-white outline-none transition-transform duration-[120ms] hover:scale-105 data-[state=open]:ring-2 data-[state=open]:ring-ring data-[state=open]:ring-offset-2 data-[state=open]:ring-offset-card"
                  >
                    {user ? initials(user.name) : 'AI'}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    <div className="text-sm font-semibold text-foreground">{user?.name ?? 'Signed in'}</div>
                    <div className="mt-0.5 truncate text-xs text-foreground/45">{user?.email ?? ''}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <div className="flex items-center gap-2.5 px-3 py-2 text-xs text-foreground/55">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        mcp === 'online' ? 'bg-ok' : mcp === 'waking' || mcp === 'checking' ? 'animate-pulse bg-warn' : 'bg-danger'
                      }`}
                    />
                    {mcp === 'online'
                      ? 'Live on-chain data'
                      : mcp === 'waking'
                        ? 'Backend waking up, ~30s'
                        : mcp === 'checking'
                          ? 'Connecting...'
                          : 'Backend unreachable'}
                  </div>
                  {isGuest && (
                    <DropdownMenuItem onSelect={() => navigate('/login')}>
                      <Lock size={14} className="text-warn" />
                      Sign in to act (guest is read-only)
                    </DropdownMenuItem>
                  )}
                  {pageTour && (
                    <DropdownMenuItem onSelect={replayTour}>
                      <Compass size={14} />
                      Replay this page's tour
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onLogout} className="text-danger focus:text-danger">
                    <LogOut size={14} />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {/* Guest banner: browse-only session. Writes won't persist until they sign in. */}
          {isGuest && (
            <div className="shrink-0 border-b border-warn/25 bg-warn/10 px-4 py-2 text-xs font-medium text-foreground/80 sm:px-6">
              <div className="flex flex-wrap items-center gap-2">
                <Lock size={13} className="shrink-0 text-warn" />
                You're browsing read-only as a guest. Registering, approving, and paying won't save.
                <Link to="/login" className="font-semibold underline underline-offset-2 hover:text-foreground">
                  Sign in with your wallet to act
                </Link>
              </div>
            </div>
          )}

          {/* Cold-start banner: the backend (free tier) may nap and take ~30s to wake. */}
          {mcp === 'waking' && (
            <div className="shrink-0 border-b border-warn/25 bg-warn/10 px-4 py-2 text-xs font-medium text-foreground/80 sm:px-6">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn" />
                Waking up the demo backend (free tier), usually under 30s. Live data will appear shortly.
              </div>
            </div>
          )}

          {/* Content region. The wrapper owns the canvas colour and hosts the
              ambient dot layer edge to edge; the transparent scroll area slides
              the page OVER the dots, so the field never scrolls away and never
              shows a seam. The clip margin lets card coronas bleed without
              spawning scrollbars. */}
          <div className="cn-dots-host relative min-h-0 flex-1 bg-background">
            {ambient && <DotField className="z-0" />}
            <main className="cn-content-scroll relative z-10 h-full px-5 py-6 sm:px-8 sm:py-8">
              <ConsoleAmbientContext.Provider value={setAmbient}>
                <div
                  key={screenKey}
                  className={`console-screen ${phase !== 'idle' ? `phase-${phase}` : ''}`}
                >
                  <Suspense fallback={<BootPulse />}>{node}</Suspense>
                </div>
              </ConsoleAmbientContext.Provider>
            </main>
          </div>
        </div>
      </div>

      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} />
      {pageTour && (
        <ConsoleTour
          open={tourOpen}
          onClose={() => setTourOpen(false)}
          steps={pageTour.steps}
          storageKey={pageTour.storageKey}
        />
      )}
    </div>
  )
}
