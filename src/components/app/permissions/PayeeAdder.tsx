import { useState } from 'react'

/**
 * Adds a payee to the allowlist. Kept apart from the toggles because it is the one
 * control on this screen that takes free text, so it owns its own validation.
 */
export default function PayeeAdder({ onAdd }: { onAdd: (v: string) => void }) {
  const [v, setV] = useState('')
  const add = () => {
    const t = v.trim()
    if (t) {
      onAdd(t)
      setV('')
    }
  }
  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        placeholder="Add a 0x address or agent://<id>"
        className="min-w-0 flex-1 rounded-xl border border-border bg-background/40 px-3 py-2 font-mono text-xs outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={add}
        className="shrink-0 rounded-full border border-foreground/15 px-4 py-2 text-xs font-semibold text-foreground/70 transition hover:border-accent"
      >
        Add
      </button>
    </div>
  )
}
