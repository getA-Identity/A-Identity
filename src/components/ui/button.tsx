import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/**
 * shadcn-style Button, styled to reproduce A-Identity's existing pill buttons
 * exactly (full-radius, brand-accent primary, cream secondary). `asChild` lets
 * it wrap a react-router <Link> or an <a> without changing markup semantics.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-transform duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        // Primary CTA, brand purple pill, white text (was bg-accent text-white).
        default: 'bg-accent text-white hover:scale-[1.03] hover:brightness-110',
        // Secondary, cream/elevated pill (was var(--color-login-bg)).
        secondary: 'bg-secondary text-foreground hover:scale-[1.03]',
        // Inverse, solid neutral that flips with the theme (was bg-ink text-white).
        inverse: 'bg-foreground text-background hover:scale-[1.02]',
        // Outline, bordered, transparent fill.
        outline: 'border border-border bg-transparent text-foreground hover:bg-foreground/[0.04]',
        // Ghost, no chrome until hover.
        ghost: 'text-foreground hover:bg-foreground/[0.06]',
        // Link, inline text action.
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        default: 'px-5 py-2.5 text-sm',
        lg: 'px-6 py-3 text-sm',
        sm: 'px-4 py-2 text-xs',
        icon: 'h-10 w-10',
      },
      shape: {
        pill: 'rounded-full',
        rounded: 'rounded-xl',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      shape: 'pill',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, shape, className }))}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
