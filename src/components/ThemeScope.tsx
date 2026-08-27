import type { ReactNode } from 'react'
import { useTheme } from './ThemeProvider'

/**
 * Applies the `.dark` scope so semantic tokens actually flip.
 *
 * The theme is deliberately NOT a class on `<html>` (see ThemeProvider): it is scoped to a
 * wrapper, which is what let dark mode ship on the landing without touching anything else.
 * The cost of that choice is that a page outside a scoped wrapper is permanently light, no
 * matter how many `text-foreground` classes it uses, the token simply resolves to its
 * `:root` value.
 *
 * That is exactly what happened here: the landing, explorer and app console each wrote the
 * wrapper inline, and every other page was left out. So it lives in one component now, and
 * a new page gets dark mode by wrapping rather than by remembering three lines.
 *
 * `bg-background text-foreground` is included because a scope with no base colors inherits
 * the fixed ink from `body`, which is the same bug one level up.
 */
export default function ThemeScope({
  children,
  className = '',
  surface = 'background',
  as: Tag = 'div',
  style,
}: {
  children: ReactNode
  /** Extra classes for the wrapper, e.g. layout. */
  className?: string
  /**
   * Which base surface this page sits on. `background` is the page tint (cream -> near
   * black); `card` is the raised white sheet the long-form pages use, which stays a step
   * lighter than the page in dark mode too.
   */
  surface?: 'background' | 'card'
  /** Element to render, for pages whose root is a `<main>`. */
  as?: 'div' | 'main'
  style?: React.CSSProperties
}) {
  const { theme } = useTheme()
  const bg = surface === 'card' ? 'bg-card' : 'bg-background'
  return (
    <Tag className={`${theme === 'dark' ? 'dark ' : ''}${bg} text-foreground ${className}`} style={style}>
      {children}
    </Tag>
  )
}
