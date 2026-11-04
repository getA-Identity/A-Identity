/**
 * One field of an owner form, as useState would hold it, except that it follows the chain: it shows
 * the latest read until the owner edits it, and an edit lasts only while the value it was made
 * against holds. Once that value has moved the edit is dropped for good, here during the render that
 * sees the move, so a value that later comes back does not bring an old edit back with it.
 *
 * The rule itself is pure and pinned in vault-rules.ts (editThatHolds, followLive).
 */
import { useCallback, useState } from 'react'
import { editThatHolds, followLive, type FormEdit } from '../../../lib/arc/vault-rules'

export function useLiveField<T>(live: T): [value: T, set: (value: T) => void, clear: () => void] {
  const [edit, setEdit] = useState<FormEdit<T> | null>(null)
  const held = editThatHolds(edit, live)
  if (held !== edit) setEdit(held)
  const set = useCallback((value: T) => setEdit({ value, base: live }), [live])
  const clear = useCallback(() => setEdit(null), [])
  return [followLive(held, live), set, clear]
}
