import * as React from 'react'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * shadcn-style Accordion (Radix). Kept style-minimal so callers (the FAQ) can
 * reproduce the existing card look exactly. The Content forwards `forceMount`,
 * which the FAQ uses to keep answers in the DOM even when collapsed, the page
 * is deliberately LLM/agent-parsable.
 */
const Accordion = AccordionPrimitive.Root

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={className} {...props} />
))
AccordionItem.displayName = 'AccordionItem'

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & {
    /** Hide the built-in chevron (caller renders its own). */
    hideChevron?: boolean
  }
>(({ className, children, hideChevron = false, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn('group flex flex-1 items-center', className)}
      {...props}
    >
      {children}
      {!hideChevron && (
        <ChevronDown
          size={20}
          className="shrink-0 text-accent transition-transform duration-300 group-data-[state=open]:rotate-180"
        />
      )}
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
))
AccordionTrigger.displayName = 'AccordionTrigger'

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content> & {
    /**
     * Drop the built-in height keyframes so the caller can animate the open/close
     * itself. Radix's keyframes read `--radix-accordion-content-height`, which the
     * primitive only measures for content it is allowed to unmount; pair them with
     * `forceMount` (as the FAQ must, to keep answers in the markup) and the height
     * animation fights whatever the caller is doing. `plain` is the escape hatch.
     */
    plain?: boolean
  }
>(({ className, children, plain = false, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className={cn(
      plain
        ? ''
        : 'overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
      className,
    )}
    {...props}
  >
    {children}
  </AccordionPrimitive.Content>
))
AccordionContent.displayName = 'AccordionContent'

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
