import { CAPABILITIES } from '../register-constants'

/**
 * Wizard step 2, capabilities: what the agent is allowed to do. Each pick
 * becomes a service the agent can be hired for. Pure props pane: the
 * selection state and its toggle stay in RegisterForm so hook order never
 * changes.
 */
export default function CapabilitiesStep({
  caps,
  toggleCap,
  label,
}: {
  caps: string[]
  toggleCap: (c: string) => void
  label: string
}) {
  return (
    <div>
      <div className={label}>What it is allowed to do</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {CAPABILITIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => toggleCap(c)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              caps.includes(c)
                ? 'bg-accent text-white'
                : 'border border-foreground/15 text-foreground/60 hover:bg-foreground/5'
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-foreground/45">Pick at least one. Capabilities become the services this agent can be hired for.</p>
    </div>
  )
}
