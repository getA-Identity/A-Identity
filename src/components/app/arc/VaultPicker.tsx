/**
 * Which Arc vault to read: the ones we can list (ours from the provenance ledger, and the
 * owner-held vaults Milestone 1 counts), and a box that reads ANY AgentSpendPolicy vault by its
 * address on the network picked next to it.
 *
 * No address is typed into the frontend: the rows come from the generated src/lib/arc-ledger.ts,
 * GET /api/proof/arc and GET /api/arc/season. Our own vault always carries its label, "deployed with our server key,
 * not user-owned", so it is never taken for the kind of vault this page exists to deploy.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { isAddress } from 'viem'
import { OURS_DETAIL, OURS_LABEL, type KnownVaults } from '../../../lib/arc/known-vaults'
import { ARC_CHAINS, arcChainFor, networkName, shortAddress } from '../../../lib/arc/vault-read'
import { Button } from '../../ui/button'
import { Chip } from '../stellar/bits'

export default function VaultPicker({
  known,
  network,
  contract,
  onPick,
  onDeploy,
  onTyping,
}: {
  /** What the build knows at first, then what the backend added. */
  known: KnownVaults | null
  network: string | null
  contract: string | null
  onPick: (network: string, contract: string) => void
  onDeploy: (network: string) => void
  /** The person has started on an address of their own, so nothing should move the page for them. */
  onTyping?: () => void
}) {
  const [address, setAddress] = useState(contract ?? '')
  const [net, setNet] = useState(network ?? ARC_CHAINS[0].caip2)
  const [invalid, setInvalid] = useState<string | null>(null)
  // What someone is typing is theirs: a list arriving late must not overwrite it.
  const [dirty, setDirty] = useState(false)
  const typed = () => {
    setDirty(true)
    onTyping?.()
  }

  // Keep the box in step with a deep link or a row click.
  useEffect(() => {
    if (dirty) return
    if (contract) setAddress(contract)
    const c = arcChainFor(network)
    if (c) setNet(c.caip2)
  }, [contract, network, dirty])

  const read = (e: FormEvent) => {
    e.preventDefault()
    const a = address.trim()
    if (!isAddress(a, { strict: false })) {
      setInvalid('A vault address is 0x followed by 40 hexadecimal characters.')
      return
    }
    setInvalid(null)
    setDirty(false)
    onPick(net, a)
  }

  const groups = ARC_CHAINS.map((c) => ({ chain: c, rows: (known?.vaults ?? []).filter((v) => v.network === c.caip2) })).filter(
    (g) => g.rows.length > 0,
  )

  return (
    <section aria-label="Pick a vault" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Vaults</h2>
        <Button size="sm" onClick={() => onDeploy(net)}>
          <Plus size={14} aria-hidden="true" /> Deploy a vault you own
        </Button>
      </div>

      {known?.loading && (
        <p className="mt-2 flex items-center gap-2 text-xs text-foreground/65">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading the vaults the backend lists (the free tier can take up to a minute to wake)...
        </p>
      )}
      {known?.partial && (
        <p className="mt-2 text-xs text-foreground/65">
          Not every list loaded: {known.partial}. Paste a vault address below to read one directly; reads go straight to the chain.
        </p>
      )}
      {known && !known.loading && !known.partial && known.vaults.every((v) => v.kind !== 'owner-held') && (
        <p className="mt-2 text-xs text-foreground/65">No owner-held vault is listed yet. The first ones are deployed from this page.</p>
      )}

      {groups.map((g) => (
        <div key={g.chain.caip2} className="mt-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-foreground/55">
            {networkName(g.chain)}
            {g.chain.testnet ? <Chip tone="muted">Test USDC</Chip> : <Chip tone="warn">Real USDC</Chip>}
          </div>
          <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
            {g.rows.map((r) => {
              const active = contract?.toLowerCase() === r.address.toLowerCase() && network === r.network
              return (
                <li key={`${r.network}:${r.address}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setDirty(false)
                      onPick(r.network, r.address)
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full rounded-xl border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active ? 'border-accent bg-accent/[0.06]' : 'border-border hover:bg-foreground/[0.04]'
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground">
                        {r.kind === 'ours' ? 'Launch-day vault (ours)' : r.ownerKind === 'team' ? 'Team-owned vault' : 'Owner-held vault'}
                      </span>
                      {r.kind === 'ours' ? (
                        <Chip tone="warn">Server key</Chip>
                      ) : r.ownerKind === 'team' ? (
                        <Chip tone="muted">Our team member's wallet</Chip>
                      ) : (
                        <Chip tone="ok">Owner-held</Chip>
                      )}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-foreground/60">{shortAddress(r.address)}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-foreground/65">
                      {r.kind === 'ours'
                        ? `${OURS_LABEL} ${OURS_DETAIL}`
                        : `Deployed ${r.deployedAt ?? ''} by ${r.ownerKind === 'team' ? "a team member's own wallet" : "the owner's own wallet"}.`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <form onSubmit={read} className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <div className="min-w-0">
          <label htmlFor="arc-vault-address" className="text-[11px] font-semibold text-foreground/65">
            Or read any AgentSpendPolicy vault by its address
          </label>
          <input
            id="arc-vault-address"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(e) => {
              typed()
              setAddress(e.target.value)
            }}
            placeholder="0x..."
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="arc-vault-network" className="text-[11px] font-semibold text-foreground/65">
            Network
          </label>
          <select
            id="arc-vault-network"
            value={net}
            onChange={(e) => {
              typed()
              setNet(e.target.value)
            }}
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ARC_CHAINS.map((c) => (
              <option key={c.caip2} value={c.caip2}>
                {c.testnet ? 'Arc testnet (test USDC, rehearsal)' : 'Arc Mainnet (real USDC)'}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" className="py-2.5">
          Read live
        </Button>
      </form>
      {invalid && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
    </section>
  )
}
