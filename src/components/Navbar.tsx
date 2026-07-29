import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Link } from 'react-router-dom'
import Logo from './Logo'
import AuthButtons from './AuthButtons'
import MobileMenu from './MobileMenu'
import ThemeToggle from './ThemeToggle'
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from './ui/navigation-menu'
import { APP_NAME, NAV_MENU } from '../lib/brand'

/**
 * Top navigation bar. Two scroll states, morphed by a single 400ms ease-out
 * transition: at the very top of the page the bar floats transparent a few px
 * inside the viewport (no chrome, content shows through); after the first
 * scroll the outer inset collapses and the bar spreads edge-to-edge as a
 * frosted-glass sheet (translucent background token + heavy blur + hairline
 * border + soft shadow), so it stays legible over any section it covers.
 * Semantic tokens only — both states work in the light and the scoped-dark
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
            {/* Left: logo + wordmark */}
            <Link
              to="/"
              aria-label={`${APP_NAME} home`}
              className="flex items-center gap-2 text-foreground"
            >
              <Logo fill="currentColor" />
              <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
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
                    className="inline-block rounded-xl px-4 py-2 text-sm font-medium text-foreground/70 transition-colors duration-200 hover:text-accent"
                  >
                    Explorer
                  </NavigationMenuLink>
                </NavigationMenuItem>

                {NAV_MENU.map((group) => (
                  <NavigationMenuItem key={group.label}>
                    <NavigationMenuTrigger>{group.label}</NavigationMenuTrigger>
                    <NavigationMenuContent>
                      <ul
                        className={
                          group.items.length > 4
                            ? 'grid w-[520px] grid-cols-2 gap-1'
                            : 'grid w-[300px] gap-1'
                        }
                      >
                        {group.items.map((item) => (
                          <li key={item.label}>
                            <NavigationMenuLink
                              href={item.href}
                              {...(item.external
                                ? { target: '_blank', rel: 'noopener noreferrer' }
                                : {})}
                              className="block rounded-xl px-4 py-3 transition-colors duration-150 hover:bg-accent/[0.07] focus-visible:bg-accent/[0.07]"
                            >
                              <span className="block text-sm font-semibold text-foreground">
                                {item.label}
                              </span>
                              <span className="mt-0.5 block text-xs leading-relaxed text-foreground/50">
                                {item.desc}
                              </span>
                            </NavigationMenuLink>
                          </li>
                        ))}
                      </ul>
                    </NavigationMenuContent>
                  </NavigationMenuItem>
                ))}

                {/* Architecture: label swaps to "For developers" on hover. Both texts are
                    stacked in one grid cell so the width never shifts as they cross-fade. */}
                <NavigationMenuItem>
                  <Link
                    to="/architecture"
                    className="group grid rounded-xl px-4 py-2 text-sm font-medium"
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

            {/* Right: theme toggle + auth buttons (desktop only) */}
            <div className="hidden items-center gap-2 md:flex">
              <ThemeToggle />
              <AuthButtons />
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
