/**
 * The one vault setup this browser holds, shared by the vault page and its deploy view, and by
 * every open tab.
 *
 * The slot lives in localStorage, so a reload or a closed tab resumes a setup, and a setup is
 * known by its startedAt. Every change reads the slot again first and applies only while the
 * slot still holds the setup this tab is showing: a tab never overwrites a setup another tab
 * started and never brings back one another tab forgot. Another tab's writes arrive through the
 * storage event, so every tab shows the same setup.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SETUP_KEY, loadSetup, saveSetup, type SetupState } from '../../../lib/arc/pending'

export type ArcSetupStore = {
  setup: SetupState | null
  /** Start a setup. False, with nothing written, while the slot holds a different setup. */
  start: (s: SetupState) => boolean
  /** Change the setup with this startedAt, if the slot still holds it. False when it does not. */
  patch: (startedAt: string, change: (s: SetupState) => SetupState) => boolean
  /** Forget the setup with this startedAt, if the slot still holds it. */
  forget: (startedAt: string) => void
}

export function useArcSetup(): ArcSetupStore {
  const [setup, setSetup] = useState<SetupState | null>(() => loadSetup())

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SETUP_KEY) setSetup(loadSetup())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const start = useCallback((s: SetupState) => {
    const held = loadSetup()
    if (held && held.startedAt !== s.startedAt) {
      setSetup(held)
      return false
    }
    saveSetup(s)
    setSetup(s)
    return true
  }, [])

  const patch = useCallback((startedAt: string, change: (s: SetupState) => SetupState) => {
    const held = loadSetup()
    if (!held || held.startedAt !== startedAt) {
      setSetup(held)
      return false
    }
    const next = change(held)
    saveSetup(next)
    setSetup(next)
    return true
  }, [])

  const forget = useCallback((startedAt: string) => {
    const held = loadSetup()
    if (held && held.startedAt === startedAt) {
      saveSetup(null)
      setSetup(null)
    } else setSetup(held)
  }, [])

  // One object per setup value, so effects that depend on the store do not run on every render.
  return useMemo(() => ({ setup, start, patch, forget }), [setup, start, patch, forget])
}
