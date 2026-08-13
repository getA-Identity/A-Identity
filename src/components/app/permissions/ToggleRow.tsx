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
        <div className={`text-sm font-medium ${danger ? 'text-danger' : 'text-foreground'}`}>{label}</div>
        <div className="mt-0.5 text-xs text-foreground/50">{desc}</div>
      </div>
      <Toggle on={on} danger={danger} onChange={onChange} label={label} />
    </li>
  )
}

/** `label` is the switch's accessible name: the control is icon-only, so without it a
 *  screen reader announces "switch, checked" and never says what was switched. */
export function Toggle({
  on,
  danger,
  onChange,
  label,
}: {
  on: boolean
  danger?: boolean
  onChange: () => void
  label: string
}) {
  const activeColor = danger ? 'bg-danger' : 'bg-accent'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? activeColor : 'bg-foreground/20'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}
