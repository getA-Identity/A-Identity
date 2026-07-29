import * as React from 'react'
import * as NavigationMenuPrimitive from '@radix-ui/react-navigation-menu'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * shadcn-style NavigationMenu (Radix), dropdowns after the base.org pattern:
 * there is NO shared viewport, so each item's Content renders in place and the
 * panel opens centered UNDER ITS OWN TRIGGER (Radix renders Content inside the
 * Item when no Viewport is mounted). Triggers read as quiet pills, panels are
 * compact cards of icon-tile rows. Enter/exit and the sideways hop between
 * open triggers use the `--animate-nav-*` keyframes from index.css. Everything
 * is semantic tokens, so the menu holds in both themes.
 */
const NavigationMenu = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <NavigationMenuPrimitive.Root ref={ref} className={cn('relative', className)} {...props}>
    {children}
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

/** Items must be `relative`: each one anchors its own dropdown panel. */
const NavigationMenuItem = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <NavigationMenuPrimitive.Item ref={ref} className={cn('relative', className)} {...props} />
))
NavigationMenuItem.displayName = 'NavigationMenuItem'

const NavigationMenuLink = NavigationMenuPrimitive.Link

/** The dropdown opener: a quiet pill that fills on hover/open, chevron flips. */
const NavigationMenuTrigger = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <NavigationMenuPrimitive.Trigger
    ref={ref}
    className={cn(
      'group inline-flex items-center gap-1 rounded-lg px-3.5 py-2 text-sm font-medium text-foreground/70 transition-colors duration-200 hover:bg-foreground/[0.06] hover:text-foreground data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronDown
      aria-hidden="true"
      className="h-3.5 w-3.5 opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180"
    />
  </NavigationMenuPrimitive.Trigger>
))
NavigationMenuTrigger.displayName = 'NavigationMenuTrigger'

/** One dropdown panel, centered under its trigger (base.org stance). */
const NavigationMenuContent = React.forwardRef<
  React.ElementRef<typeof NavigationMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <NavigationMenuPrimitive.Content
    ref={ref}
    className={cn(
      'absolute left-1/2 top-full w-max -translate-x-1/2 pt-2.5',
      'data-[state=open]:animate-nav-in data-[state=closed]:animate-nav-out',
      'data-[motion=from-start]:animate-nav-from-left data-[motion=from-end]:animate-nav-from-right',
      'data-[motion=to-start]:animate-nav-to-left data-[motion=to-end]:animate-nav-to-right',
      className,
    )}
    {...props}
  />
))
NavigationMenuContent.displayName = 'NavigationMenuContent'

/** The panel chrome itself, separated so Content keeps its transparent anchor gap. */
function NavigationMenuPanel({
  className = '',
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border/70 bg-card/95 p-2 shadow-[0_24px_60px_-24px_rgba(16,24,40,0.45)] backdrop-blur-2xl',
        className,
      )}
    >
      {children}
    </div>
  )
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuPanel,
}
