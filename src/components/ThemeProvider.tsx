import { createContext, useCallback, useContext, useMemo, useState } from 'react'

type Theme = 'light' | 'dark'

type ThemeContextValue = {
  theme: Theme
  setTheme: (t: Theme) => void
  toggleTheme: () => void
}

const STORAGE_KEY = 'a-identity-theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    /* localStorage can throw in private mode, fall through to default */
  }
  return 'light'
}

/**
 * Landing-scoped light/dark theme. Holds the preference (persisted to
 * localStorage) and hands it to consumers. It does NOT force a class onto
 * <html>; the Landing wrapper reads `theme` and applies `.dark` to its own
 * subtree, so dark mode stays scoped to the landing page.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme)

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try {
      window.localStorage.setItem(STORAGE_KEY, t)
    } catch {
      /* ignore persistence failures */
    }
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  // Native controls / scrollbars follow `color-scheme`, which we scope to the
  // `.dark` subtree in CSS (see index.css) so it stays landing/app-local rather
  // than forcing the whole document dark.

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
