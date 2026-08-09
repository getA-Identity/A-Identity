import { useEffect, useState } from 'react'
import { Check, Copy, ShieldCheck, Terminal } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { Panel } from '../../ui/panel'

type CliCommand = { purpose: string; command: string; needsOtp: boolean }
type Plan = {
  address: string
  chain: string
  bootstrap: CliCommand[]
  commands: CliCommand[]
  notExpressible: string[]
  error?: string
}

/**
 * The same limits, mirrored to Circle's own wallet-policy engine.
 *
 * Circle Agent Wallets enforce transfer limits and recipient allowlists before a transfer
 * is submitted. This compiles the caps the owner already set into the exact CLI commands
 * that reproduce them there, making Circle's engine a fourth place the one number is
 * enforced. The commands are shown rather than run: an Agent Wallet is user-controlled,
 * so applying a policy needs the owner's own confirmation, and a server that did it
 * silently would be misrepresenting who holds the key.
 */
export default function CirclePolicyPanel({ agentId }: { agentId?: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!agentId) return
    let alive = true
    apiFetch(`/api/agents/circle-policy?agentId=${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setPlan(d as Plan))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [agentId])

  if (!agentId || !plan || plan.error) return null

  const copy = (c: string) => {
    void navigator.clipboard?.writeText(c)
    setCopied(c)
    setTimeout(() => setCopied(null), 1400)
  }

  const Row = ({ c }: { c: CliCommand }) => (
    <div className="group relative rounded-xl border border-white/10 bg-[#10151d] p-3 pr-11">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
        {c.purpose}
        {c.needsOtp && <span className="ml-2 text-amber-400/80">needs your confirmation</span>}
      </p>
      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-white/85">
        {c.command}
      </pre>
      <button
        type="button"
        aria-label={`Copy: ${c.purpose}`}
        onClick={() => copy(c.command)}
        className="absolute right-2 top-2 rounded-lg border border-transparent p-2 text-white/35 transition-colors hover:border-white/15 hover:text-white"
      >
        {copied === c.command ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
      </button>
    </div>
  )

  return (
    <Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-usdc/10 text-usdc">
          <ShieldCheck size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Mirror these limits to Circle (Agent Stack)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            Circle's Agent Wallets enforce spend policy at the wallet layer too. These are the exact
            commands that reproduce the caps you already set, so one number is enforced in four
            places. We generate them; you run them, because the wallet is yours.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/40">
          <Terminal size={11} className="mr-1 inline" /> one-time setup
        </p>
        {(plan.bootstrap ?? []).map((c) => (
          <Row key={c.command} c={c} />
        ))}
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/40">
          your limits, as Circle policies
        </p>
        {(plan.commands ?? []).map((c) => (
          <Row key={c.command} c={c} />
        ))}
      </div>

      {(plan.notExpressible?.length ?? 0) > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/40">
            what Circle's engine cannot express
          </p>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-foreground/60">
            {(plan.notExpressible ?? []).map((n) => (
              <li key={n} className="flex gap-2">
                <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}
