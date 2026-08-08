import { createContext, useContext, useEffect } from 'react'

/**
 * Lets a page ask the console shell for the ambient dot layer.
 *
 * The layer has to live in the LAYOUT, behind the whole content pane, so it can
 * run edge to edge and stay put while the page scrolls over it. A page cannot
 * render that itself (its column is narrower than the pane), so it flips this
 * switch instead and the shell does the drawing.
 */
export const ConsoleAmbientContext = createContext<(on: boolean) => void>(() => {})

/** Declare whether the current page wants the ambient layer. Cleans up on unmount. */
export function useConsoleAmbient(on: boolean): void {
  const set = useContext(ConsoleAmbientContext)
  useEffect(() => {
    set(on)
    return () => set(false)
  }, [on, set])
}
