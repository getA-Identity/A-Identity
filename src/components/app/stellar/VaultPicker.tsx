/**
 * Which vault to read: the ones the registry declares, grouped by network, and a box that
 * reads ANY AgentSpendPolicy vault by contract id.
 *
 * The default rows come from GET /api/stellar/vaults, so no contract id is typed into the
 * frontend: a vault added to the backend registry shows up here without a frontend change.
 * A row the registry marks as a rehearsal is shown with its own label, which says what it is
 * and is not, and is never presented as anything more.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import {
  CONTRACT_ID,
  READ_FAILURE_TITLE,
  ROLE_NAME,
  listVaults,
  localTime,
  shortId,
  stellarChains,
  type ReadFailure,
  type VaultListRow,
} from '../../../lib/stellar/vault-read'
import { Chip } from './bits'

export default function VaultPicker({
  network,
  contract,
  autoPick,
  onPick,
}: {
  network: string | null
  contract: string | null
  /** False when the link named a vault or a network we refused: the page keeps that
   *  refusal on screen instead of quietly swapping in a default vault. */
  autoPick: boolean
  /** `replace` is true for the automatic first pick, so it does not add a history entry. */
  onPick: (network: string, contract: string, replace?: boolean) => void
}) {
  const [rows, setRows] = useState<VaultListRow[] | null>(null)
  const [failure, setFailure] = useState<ReadFailure | null>(null)
  const [waking, setWaking] = useState(false)
  const [address, setAddress] = useState(contract ?? '')
  const chains = useMemo(() => stellarChains(), [])
  const [net, setNet] = useState(network ?? chains[0]?.caip2 ?? '')
  const [invalid, setInvalid] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void listVaults(() => alive && setWaking(true)).then((r) => {
      if (!alive) return
      setWaking(false)
      if (r.ok) setRows(r.data)
      else setFailure(r.failure)
    })
    return () => {
      alive = false
    }
  }, [])

  // With no vault in the URL, open the first registry vault (on the network the link named,
  // else testnet first), so the page lands on live values instead of an empty form.
  useEffect(() => {
    if (!autoPick || contract || !rows || rows.length === 0) return
    const first =
      (network ? rows.find((r) => r.caip2 === network) : undefined) ??
      chains.map((c) => rows.find((r) => r.caip2 === c.caip2)).find(Boolean)
    if (first) onPick(first.caip2, first.contract, true)
  }, [autoPick, rows, contract, network, chains, onPick])

  // Keep the box in step with a deep link or a row click.
  useEffect(() => {
    if (contract) setAddress(contract)
    if (network) setNet(network)
  }, [contract, network])

  const load = (e: FormEvent) => {
    e.preventDefault()
    const a = address.trim()
    if (!CONTRACT_ID.test(a)) {
      setInvalid('A vault id is a contract id: it starts with C and is 56 characters long.')
      return
    }
    setInvalid(null)
    onPick(net, a)
  }

  const groups = chains
    .map((c) => ({ chain: c, rows: (rows ?? []).filter((r) => r.caip2 === c.caip2) }))
    .filter((g) => g.rows.length > 0)

  return (
    <section aria-label="Pick a vault" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-foreground">Vaults</h2>

      {rows === null && !failure && (
        <p className="mt-2 flex items-center gap-2 text-xs text-foreground/65">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          {waking ? 'Waking up the backend (free tier), usually under a minute...' : 'Loading the registry vaults...'}
        </p>
      )}
      {failure && (
        <p className="mt-2 text-xs text-danger">
          Could not list the registry vaults at {localTime(failure.at)} ({READ_FAILURE_TITLE[failure.kind].toLowerCase()}): {failure.reason}.
          Paste a vault id below to read one directly.
        </p>
      )}

      {groups.map((g) => (
        <div key={g.chain.caip2} className="mt-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-foreground/55">
            Stellar {g.chain.testnet ? 'testnet' : 'pubnet'}
            {!g.chain.testnet && <Chip tone="warn">Real money</Chip>}
          </div>
          <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
            {g.rows.map((r) => {
              const active = r.contract === contract && r.caip2 === network
              const role = r.role ? (ROLE_NAME[r.role] ?? r.role) : null
              return (
                <li key={`${r.caip2}:${r.contract}`}>
                  <button
                    type="button"
                    onClick={() => onPick(r.caip2, r.contract)}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full rounded-xl border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active ? 'border-accent bg-accent/[0.06]' : 'border-border hover:bg-foreground/[0.04]'
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground">{role ?? r.label}</span>
                      {r.role === 'rehearsal' && <Chip tone="warn">Rehearsal</Chip>}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-foreground/60">{shortId(r.contract)}</span>
                    {(r.roleLabel || (!role && r.label)) && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-foreground/60">{r.roleLabel ?? r.label}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <form onSubmit={load} className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <div className="min-w-0">
          <label htmlFor="vault-address" className="text-[11px] font-semibold text-foreground/65">
            Or read any AgentSpendPolicy vault by its contract id
          </label>
          <input
            id="vault-address"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="C..."
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="vault-network" className="text-[11px] font-semibold text-foreground/65">
            Network
          </label>
          <select
            id="vault-network"
            value={net}
            onChange={(e) => setNet(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chains.map((c) => (
              <option key={c.caip2} value={c.caip2}>
                {c.testnet ? 'Testnet' : 'Pubnet (real money)'}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Read live
        </button>
      </form>
      {invalid && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
    </section>
  )
}
