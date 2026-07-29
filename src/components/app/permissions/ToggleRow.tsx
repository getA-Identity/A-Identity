/**
 * A labelled switch and the switch itself.
 *
 * `danger` is not decoration: it marks the toggles that widen what the agent may do
 * without asking, so turning one on should feel different from turning one off.
 */
export function Row({
  label,
  desc,
  on,
  danger,
  onChange,
}: {
  label: string
  desc: string
  on: boolean
  danger?: boolean
  onChange: () => void
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <div className={`text-sm font-medium ${danger ? 'text-red-600' : 'text-foreground'}`}>{label}</div>
        <div className="mt-0.5 text-xs text-foreground/50">{desc}</div>
      </div>
      <Toggle on={on} danger={danger} onChange={onChange} />
    </li>
  )
}

export function Toggle({ on, danger, onChange }: { on: boolean; danger?: boolean; onChange: () => void }) {
  const activeColor = danger ? 'bg-red-500' : 'bg-accent'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? activeColor : 'bg-foreground/20'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}
