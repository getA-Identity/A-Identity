import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Link } from 'react-router-dom'
import Logo from './Logo'
import AuthButtons from './AuthButtons'
import MobileMenu from './MobileMenu'
import ThemeToggle from './ThemeToggle'
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from './ui/navigation-menu'
import { APP_NAME, NAV_LINKS } from '../lib/brand'

/**
 * Top navigation bar. Holds the mobile-menu open state and renders the
 * slide-in sheet. Constrained to a 1280px centered track, layered above
 * the background video (z-10). Desktop links use a shadcn NavigationMenu.
 */
export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <nav className="mx-auto flex w-full max-w-[1280px] items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
          {/* Left: logo + wordmark */}
          <Link
            to="/"
            aria-label={`${APP_NAME} home`}
            className="flex items-center gap-2 text-foreground"
          >
            <Logo fill="currentColor" />
            <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
          </Link>

          {/* Center: links (desktop only) */}
          <NavigationMenu className="hidden md:block">
            <NavigationMenuList>
              {NAV_LINKS.map((link) => (
                <NavigationMenuItem key={link.label}>
                  <NavigationMenuLink
                    href={link.href}
                    {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    className="text-sm font-medium opacity-70 transition-opacity hover:opacity-100"
                  >
                    {link.label}
                  </NavigationMenuLink>
                </NavigationMenuItem>
              ))}
              {/* Architecture: label swaps to "For developers" on hover. Both texts are
                  stacked in one grid cell so the width never shifts as they cross-fade. */}
              <NavigationMenuItem>
                <Link to="/architecture" className="group grid text-sm font-medium">
                  <span className="col-start-1 row-start-1 opacity-70 transition-opacity duration-200 group-hover:opacity-0">
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

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  )
}
