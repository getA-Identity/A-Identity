import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind class strings with correct precedence (clsx for conditionals,
 * tailwind-merge to dedupe conflicting utilities). The standard shadcn/ui helper.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Middle-truncated address, 8 leading and 4 trailing characters.
 *
 * Note the explorer and the spotlight keep their own 8-and-6 variant on purpose: they render
 * in wider columns. Unifying them would change what is on screen, which is not this
 * function's job.
 */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-4)}` : a
}
