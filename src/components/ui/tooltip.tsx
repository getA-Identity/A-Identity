import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

/**
 * shadcn-style Tooltip over Radix, themed with the console tokens.
 *
 * Content is deliberately NOT portaled: the console's dark mode is a `.dark`
 * class scoped to the shell, and a portal to document.body would drop the
 * theme tokens (same reasoning as dropdown-menu.tsx).
 */
const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      'cn-pop-in z-50 max-w-[280px] rounded-xl border border-border bg-card px-3.5 py-2.5 text-xs leading-relaxed text-foreground/80 shadow-lg',
      className,
    )}
    {...props}
  />
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
