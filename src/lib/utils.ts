import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { short } from './format'

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
 * Delegates to lib/format's `short` so exactly one truncation rule exists; kept as a
 * named export because console surfaces import it under this name. Wider columns
 * (the explorer, the spotlight) render an 8-and-6 variant via `short`'s params.
 */
export function shortAddress(a: string): string {
  return short(a)
}
