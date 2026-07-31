import { create } from 'zustand'

/**
 * The agent the console is currently pointed at, shared by every screen.
 *
 * Each screen used to hold its own `agentId`, so choosing an agent in Wallet and then
 * opening Permissions silently snapped back to the primary agent: you could read one
 * agent's balance and edit another agent's limits without anything saying so. One
 * selection, one answer, everywhere.
 *
 * Deliberately in memory only. A reload re-derives the selection from the roster that
 * just loaded, so a persisted id can never point at an agent that no longer exists.
 */
type SelectedAgentState = {
  agentId: string
  /** An explicit choice: the user picking from the dropdown, or a jump to a just-created agent. */
  setAgentId: (id: string) => void
  /**
   * Reconcile the selection with a roster that just loaded. Keeps the current selection
   * when it is still in the list, otherwise falls back to `fallback` (the caller's
   * primary pick) and finally to the first agent.
   */
  syncRoster: (ids: string[], fallback?: string) => void
}

export const useSelectedAgent = create<SelectedAgentState>()((set) => ({
  agentId: '',
  setAgentId: (agentId) => set({ agentId }),
  syncRoster: (ids, fallback) =>
    set((s) => (s.agentId && ids.includes(s.agentId) ? s : { agentId: fallback ?? ids[0] ?? '' })),
}))
