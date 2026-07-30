import { useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeftRight,
  Bot,
  Coins,
  CreditCard,
  Fingerprint,
  LayoutDashboard,
  Lock,
  LogOut,
  SlidersHorizontal,
  Store,
} from 'lucide-react'
import Logo from '../../components/Logo'
import ThemeToggle from '../../components/ThemeToggle'
import { useTheme } from '../../components/ThemeProvider'
import { useAuth } from '../../store/auth'
import { APP_NAME } from '../../lib/brand'
import { useMcpHealth } from '../../hooks/useMcp'
import { wakeBackend } from '../../lib/api'

const NAV = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/agent-id', label: 'Agent ID', icon: Fingerprint, end: false },
  { to: '/app/wallet', label: 'Wallet', icon: CreditCard, end: false },
  { to: '/app/settlements', label: 'Settlements', icon: ArrowLeftRight, end: false },
  { to: '/app/marketplace', label: 'Marketplace', icon: Store, end: false },
  { to: '/app/earnings', label: 'Earnings', icon: Coins, end: false },
  { to: '/app/permissions', label: 'Permissions', icon: SlidersHorizontal, end: false },
] as const

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

  const current = [...NAV].reverse().find((n) => location.pathname.startsWith(n.to))
  const title = current?.label ?? 'Overview'

  const onLogout = () => {
    logout()
    navigate('/')
  }

  const { theme } = useTheme()

  return (
    <div className={`flex min-h-screen w-full bg-background text-foreground ${theme === 'dark' ? 'dark' : ''}`}>
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-foreground/10 bg-card px-4 py-6 md:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <Logo size={28} />
          <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
        </div>

        <div className="mb-3 px-3">
          <span className="text-[10px] font-semibold tracking-widest text-foreground/35">
            Agent Console
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? 'bg-accent text-white' : 'text-foreground/70 hover:bg-foreground/5'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* MCP server status */}
        <div className="mb-2 mt-2 rounded-xl border border-foreground/8 bg-foreground/[0.03] px-3 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Bot size={13} className="text-accent" />
              <span className="text-xs font-semibold text-foreground/70">MCP server</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${
                  mcp === 'checking'
                    ? 'animate-pulse bg-foreground/25'
                    : mcp === 'waking'
                      ? 'animate-pulse bg-amber-400'
                      : mcp === 'online'
                        ? 'bg-emerald-400'
                        : 'bg-red-400'
                }`}
              />
              <span className="text-[11px] text-foreground/40">
                {mcp === 'checking' ? 'checking' : mcp === 'waking' ? 'waking up' : mcp === 'online' ? 'online' : 'reconnecting'}
              </span>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-foreground/40">
            {mcp === 'online'
              ? 'Live on-chain data'
              : mcp === 'waking'
                ? 'Backend is cold-starting (~30s)...'
                : mcp === 'checking'
                  ? 'Connecting...'
                  : 'Reconnecting to the backend...'}
          </p>
        </div>

        <div className="mb-3 rounded-xl border border-foreground/8 bg-foreground/[0.03] px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-foreground/40">Human-on-the-loop</span>
          </div>
          <p className="text-[11px] leading-relaxed text-foreground/40">
            Keys, contracts, real value require your approval.
          </p>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/70 transition-colors hover:bg-foreground/5"
        >
          <LogOut size={18} />
          Log out
        </button>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-foreground/10 bg-background/80 px-5 py-4 backdrop-blur-md sm:px-8">
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
        </header>

        {/* Guest banner: browse-only session. Writes won't persist until they sign in. */}
        {isGuest && (
          <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-medium text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 sm:px-8">
            <Lock size={13} className="shrink-0" />
            You're browsing read-only as a guest. Registering, approving, and paying won't save.
            <Link to="/login" className="font-semibold underline underline-offset-2 hover:text-amber-950">
              Sign in with your wallet to act
            </Link>
          </div>
        )}

        {/* Cold-start banner: the backend (free tier) may nap and take ~30s to wake. */}
        {mcp === 'waking' && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 sm:px-8">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
            Waking up the demo backend (free tier), usually under 30s. Live data will appear shortly.
          </div>
        )}

        {/* Mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-foreground/10 bg-card px-4 py-2 md:hidden">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-accent text-white' : 'text-foreground/70'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>

        <main className="flex-1 px-5 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
