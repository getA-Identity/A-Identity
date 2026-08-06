import { useSelectedAgent } from '../../store/agent'
import { cn } from '../../lib/utils'

/**
 * The console's one agent picker, bound to the shared selection.
 *
 * Renders nothing for a single-agent account: a dropdown with one option is noise.
 * `inline` is the compact pill form used where the picker sits in a toolbar row rather
 * than above a form.
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

  if (inline) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <label htmlFor="agent-select" className="text-xs font-semibold text-foreground/45">
          Agent
        </label>
        <select
          id="agent-select"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent"
        >
          {options}
        </select>
      </div>
    )
  }

  return (
    <div className={cn('mt-5', className)}>
      <label htmlFor="agent-select" className="text-xs font-semibold text-foreground/50">
        Agent
      </label>
      <select
        id="agent-select"
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm outline-none focus:border-accent"
      >
        {options}
      </select>
    </div>
  )
}
