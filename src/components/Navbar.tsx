import { useEffect, useState, type ComponentType } from 'react'
import {
  ArrowUpRight,
  Activity,
  BookOpen,
  FileJson,
  Fingerprint,
  Gauge,
  HelpCircle,
  Mail,
  Menu,
  Newspaper,
  Package,
  Palette,
  Plug,
  Rocket,
  ScrollText,
  Terminal,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Lockup } from './Logo'
import { Button } from './ui/button'
import MobileMenu from './MobileMenu'
import ThemeToggle from './ThemeToggle'
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuPanel,
  NavigationMenuTrigger,
} from './ui/navigation-menu'
import { APP_NAME, NAV_MENU } from '../lib/brand'

/** Leading icon per dropdown item (base.org's icon-tile rows). Keyed by label so
    the data in brand.ts stays plain and framework-free. */
const ITEM_ICONS: Record<string, ComponentType<{ size?: number | string }>> = {
  'ERC-8004 Identity': Fingerprint,
  'x402 Payments': Zap,
  MCP: Plug,
  Reputation: Gauge,
  Quickstart: Rocket,
  SDK: Package,
  CLI: Terminal,
  'Agent Manifest': FileJson,
  Docs: BookOpen,
  'Live Proof': Activity,
  Manifesto: ScrollText,
  Blog: Newspaper,
  FAQ: HelpCircle,
  Brand: Palette,
  Contact: Mail,
}

/**
 * Top navigation bar. Two scroll states, morphed by a single 400ms ease-out
 * transition: at the very top of the page the bar floats transparent a few px
 * inside the viewport (no chrome, content shows through); after the first
 * scroll the outer inset collapses and the bar spreads edge-to-edge as a
 * frosted-glass sheet (translucent background token + heavy blur + hairline
 * border + soft shadow), so it stays legible over any section it covers.
 * Semantic tokens only, both states work in the light and the scoped-dark
 * subtrees (Landing wraps this in its own `.dark`). Holds the mobile-menu
 * open state and renders the slide-in sheet.
 */
export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-50 flex justify-center transition-all duration-[400ms] ease-out ${
          scrolled ? 'p-0' : 'px-2 pt-2 md:pt-4'
        }`}
      >
        <div
          className={`w-full px-4 py-2.5 transition-all duration-[400ms] ease-out sm:px-6 ${
            scrolled
              ? 'border-b border-border/60 bg-background/50 shadow-[0_2px_16px_rgba(0,0,0,0.06)] backdrop-blur-2xl'
              : 'border-b border-transparent bg-transparent shadow-none'
          }`}
        >
          <nav className="relative mx-auto flex w-full max-w-[1280px] items-center justify-between">
            {/* Left: the brand lockup. The wordmark used to be live text, which meant it
                was set in the UI face rather than the brand one; the lockup is the real
                artwork and it follows the theme (ink on light, cream on dark). The link
                carries the accessible name, so the image itself is decorative. */}
            <Link to="/" aria-label={`${APP_NAME} home`} className="flex items-center">
              <Lockup height={40} eager alt="" />
            </Link>

            {/* Center: truly centered (absolute, so uneven logo/auth widths cannot
                pull it sideways). One direct link, three dropdown groups promoted
                from the footer, and the Architecture hover-swap. Dropdowns share
                one animated viewport that morphs between panel sizes. */}
            <NavigationMenu className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 md:block">
              <NavigationMenuList>
                <NavigationMenuItem>
                  <NavigationMenuLink
                    href="/explorer"
                    className="inline-block rounded-lg px-3.5 py-2 text-sm font-medium text-foreground/70 transition-colors duration-200 hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    Explorer
                  </NavigationMenuLink>
                </NavigationMenuItem>

                {NAV_MENU.map((group) => (
                  <NavigationMenuItem key={group.label}>
                    <NavigationMenuTrigger>{group.label}</NavigationMenuTrigger>
                    <NavigationMenuContent>
                      <NavigationMenuPanel>
                        <ul
                          className={
                            group.items.length > 4
                              ? 'grid w-[540px] grid-cols-2 gap-0.5'
                              : 'grid w-[320px] gap-0.5'
                          }
                        >
                          {group.items.map((item) => {
                            const Icon = ITEM_ICONS[item.label]
                            return (
                              <li key={item.label}>
                                <NavigationMenuLink
                                  href={item.href}
                                  {...(item.external
                                    ? { target: '_blank', rel: 'noopener noreferrer' }
                                    : {})}
                                  className="group/link flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05]"
                                >
                                  {Icon && (
                                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border/70 bg-background/50 text-foreground/70 transition-colors duration-150 group-hover/link:border-accent/40 group-hover/link:text-accent">
                                      <Icon size={17} />
                                    </span>
                                  )}
                                  <span className="min-w-0">
                                    <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                                      {item.label}
                                      {item.external && (
                                        <ArrowUpRight
                                          size={12}
                                          className="text-foreground/40 transition-transform duration-150 group-hover/link:-translate-y-px group-hover/link:translate-x-px"
                                        />
                                      )}
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-relaxed text-foreground/50">
                                      {item.desc}
                                    </span>
                                  </span>
                                </NavigationMenuLink>
                              </li>
                            )
                          })}
                        </ul>
                      </NavigationMenuPanel>
                    </NavigationMenuContent>
                  </NavigationMenuItem>
                ))}

                {/* Architecture: label swaps to "For developers" on hover. Both texts are
                    stacked in one grid cell so the width never shifts as they cross-fade. */}
                <NavigationMenuItem>
                  <Link
                    to="/architecture"
                    className="group grid rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-200 hover:bg-foreground/[0.06]"
                  >
                    <span className="col-start-1 row-start-1 text-foreground/70 transition-opacity duration-200 group-hover:opacity-0">
                      Architecture
                    </span>
                    <span className="col-start-1 row-start-1 whitespace-nowrap text-accent opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      For developers
                    </span>
                  </Link>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>

            {/* Right: theme toggle + the two doors (desktop only). Returning users had
                to guess that "Start For Free" also signs them in, so the quiet cream
                pill now says so out loud, with the primary CTA still last on the row.
                Same pair, same variants, as the mobile sheet renders via AuthButtons. */}
            <div className="hidden items-center gap-2 md:flex">
              <ThemeToggle />
              <Button asChild variant="secondary">
                <Link to="/login">Sign in</Link>
              </Button>
              <Button asChild>
                <Link to="/signup">Start For Free</Link>
              </Button>
            </div>

            {/* Mobile: theme toggle + hamburger */}
            <div className="flex items-center gap-1 md:hidden">
              <ThemeToggle />
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-label="Open menu"
                className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-foreground/5"
              >
                <Menu size={26} />
              </button>
            </div>
          </nav>
        </div>
      </header>

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  )
}
