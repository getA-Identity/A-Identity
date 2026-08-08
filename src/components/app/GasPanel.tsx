import { useEffect, useState } from 'react'
import { Fuel, ShieldQuestion } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { Panel } from '../ui/panel'

type GasStory = {
  chain: string
  evmChainId: number
  gasPaidIn: string
  paymasterRelevant: boolean
  paymasterDeployed: boolean | null
  address: string
  note: string
}

/**
 * Who pays the agent's gas.
 *
 * This panel exists because the honest answer on Arc is more interesting than the
 * expected one. Circle Paymaster lets a smart account pay gas in USDC on chains where
 * gas is ETH; on Arc gas already IS USDC, so the paymaster has nothing to add. Rather
 * than claim an integration for the sake of a logo, the backend probes the published
 * paymaster address with eth_getCode and reports what it finds. Hits GET /api/arc/gas.
 */
export default function GasPanel() {
  const [gas, setGas] = useState<GasStory | null>(null)

  useEffect(() => {
    let alive = true
    apiFetch('/api/arc/gas')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setGas(d as GasStory))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return (
    <Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <Fuel size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Who pays the agent's gas</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            An agent that has to hold a second token just to pay fees is not really autonomous.
            This is checked against the chain, not copied from a doc.
          </p>
        </div>
      </div>

      {gas ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-500/25 dark:bg-emerald-500/10">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/45">
              {gas.chain} · gas paid in
            </p>
            <p className="mt-1 text-lg font-bold tracking-tight text-foreground">{gas.gasPaidIn}</p>
            <p className="mt-2 text-sm leading-relaxed text-foreground/60">{gas.note}</p>
          </div>

          <div className="rounded-xl border border-border bg-background/40 p-4">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/45">
              <ShieldQuestion size={12} /> Circle Paymaster
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {gas.paymasterRelevant
                ? gas.paymasterDeployed
                  ? 'Deployed and useful here'
                  : 'Published, but no contract at the address'
                : 'Not needed on this chain'}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-foreground/55">
              The paymaster's job is letting an account pay gas in USDC where the native token is
              something else. We probed the published address with{' '}
              <span className="font-mono text-xs">eth_getCode</span> and report what came back,
              so this line can never drift from the chain.
            </p>
            <p className="mt-2 truncate font-mono text-[11px] text-foreground/35">{gas.address}</p>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-4 text-sm text-foreground/45">
          Probing the chain…
        </div>
      )}
    </Panel>
  )
}
