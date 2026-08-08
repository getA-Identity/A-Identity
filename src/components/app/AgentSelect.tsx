import { Bot, ChevronDown } from 'lucide-react'
import { useSelectedAgent } from '../../store/agent'
import { cn } from '../../lib/utils'

/**
 * The console's one agent picker, bound to the shared selection.
 *
 * Renders nothing for a single-agent account: a dropdown with one option is
 * noise. Visually it is a proper control now (icon, label, roomy hit target,
 * custom chevron) rather than a bare native select; the native element stays
 * underneath for keyboard and screen-reader behaviour.
 */
export default function AgentSelect({
  agents,
  className,
  inline,
}: {
  agents: { id: string; name: string }[]
  className?: string
  inline?: boolean
}) {
  const agentId = useSelectedAgent((s) => s.agentId)
  const setAgentId = useSelectedAgent((s) => s.setAgentId)

  if (agents.length < 2) return null

  const options = agents.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name}
    </option>
  ))

  return (
    <div className={cn(inline ? 'inline-flex items-center gap-2.5' : 'mt-5 flex items-center gap-2.5', className)}>
      <span className="flex items-center gap-1.5 text-sm font-bold text-foreground/70">
        <Bot size={16} className="text-accent" /> Agent
      </span>
      <div className="group relative min-w-0">
        <select
          id="agent-select"
          aria-label="Selected agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full min-w-[220px] cursor-pointer appearance-none rounded-xl border border-border bg-card py-2.5 pl-3.5 pr-10 text-sm font-semibold text-foreground shadow-sm outline-none transition-colors duration-[120ms] hover:border-foreground/25 focus:border-accent [background-image:none]"
        >
          {options}
        </select>
        <ChevronDown
          size={15}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-foreground/45 transition-transform duration-[240ms] group-focus-within:rotate-180"
        />
      </div>
    </div>
  )
}
