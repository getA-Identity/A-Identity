import * as React from 'react'
import * as NavigationMenuPrimitive from '@radix-ui/react-navigation-menu'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * shadcn-style NavigationMenu (Radix), now with dropdown support. Links-only
 * items keep working as before; items with a Trigger + Content open into ONE
 * shared Viewport rendered under the bar, which morphs its width and height
 * between panels (the `--radix-navigation-menu-viewport-*` variables) and
 * slides panels sideways when the pointer moves between triggers
 * (`data-motion`). Enter/exit/slide keyframes live in index.css as
 * `--animate-nav-*` tokens. Everything is semantic tokens, so the menu holds
 * in both themes.
 */
const NavigationMenu = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <NavigationMenuPrimitive.Root ref={ref} className={cn('relative', className)} {...props}>
    {children}
    <NavigationMenuViewport />
  </NavigationMenuPrimitive.Root>
))
NavigationMenu.displayName = 'NavigationMenu'

const NavigationMenuList = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.List>
>(({ className, ...props }, ref) => (
  <NavigationMenuPrimitive.List
    ref={ref}
    className={cn('flex items-center gap-1', className)}
    {...props}
  />
))
NavigationMenuList.displayName = 'NavigationMenuList'

const NavigationMenuItem = NavigationMenuPrimitive.Item
const NavigationMenuLink = NavigationMenuPrimitive.Link

/** The dropdown opener: styled like a nav link, chevron flips while open. */
const NavigationMenuTrigger = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <NavigationMenuPrimitive.Trigger
    ref={ref}
    className={cn(
      'group inline-flex items-center gap-1 rounded-xl px-4 py-2 text-sm font-medium text-foreground/70 transition-colors duration-200 hover:text-accent data-[state=open]:text-accent',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronDown
      aria-hidden="true"
      className="h-3.5 w-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180"
    />
  </NavigationMenuPrimitive.Trigger>
))
NavigationMenuTrigger.displayName = 'NavigationMenuTrigger'

/** One dropdown panel. Slides left/right when hopping between open triggers. */
const NavigationMenuContent = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <NavigationMenuPrimitive.Content
    ref={ref}
    className={cn(
      'left-0 top-0 w-full p-2 md:absolute md:w-auto',
      'data-[motion=from-start]:animate-nav-from-left data-[motion=from-end]:animate-nav-from-right',
      'data-[motion=to-start]:animate-nav-to-left data-[motion=to-end]:animate-nav-to-right',
      className,
    )}
    {...props}
  />
))
NavigationMenuContent.displayName = 'NavigationMenuContent'

/** The single shared panel surface every dropdown renders into. */
const NavigationMenuViewport = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <div className="absolute left-1/2 top-full flex -translate-x-1/2 justify-center pt-2.5">
    <NavigationMenuPrimitive.Viewport
      ref={ref}
      className={cn(
        'relative h-[var(--radix-navigation-menu-viewport-height)] w-full origin-top overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-[0_24px_60px_-24px_rgba(16,24,40,0.4)] backdrop-blur-2xl transition-[width,height] duration-300 ease-out md:w-[var(--radix-navigation-menu-viewport-width)]',
        'data-[state=open]:animate-nav-in data-[state=closed]:animate-nav-out',
        className,
      )}
      {...props}
    />
  </div>
))
NavigationMenuViewport.displayName = 'NavigationMenuViewport'

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuViewport,
}
