/**
 * What only the vault's owner can do, each as the exact call first and the wallet second.
 *
 * Shown to everyone, collapsed for anyone who is not the owner: a reader can see precisely what
 * the owner would sign, and nobody but the owner gets a working button (the contract would refuse
 * anyone else with NotOwner). Freeze needs no deposit, so it is one wallet tap; everything that
 * loosens a limit or moves money attaches the 1 yoctoNEAR that only a full-access key can sign.
 *
 * Money moves only two ways here, both signed by the owner: into the vault through the token's
 * ft_transfer_call, and out of it with withdraw, which can only pay the owner.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, ListChecks, Settings2, ShieldQuestion, Snowflake, Sun } from 'lucide-react'
import {
  prepareFreeze,
  prepareFund,
  prepareSetAllowed,
  prepareSetHoldUnknown,
  prepareSetPolicy,
  prepareUnfreeze,
  prepareWithdraw,
  type PreparedTx,
} from '../../../lib/near/calls'
import { NEAR_RPC_URLS } from '../../../lib/near/chain'
import { isNearAccountId } from '../../../lib/near/ids'
import { MAX_ALLOWLIST, type VaultSnapshot } from '../../../lib/near/read'
import { viewCall } from '../../../lib/near/rpc'
import { formatGrouped, formatNear, formatUnits, parseUnits, u128 } from '../../../lib/near/units'
import { ActionFlow, type ActionContext } from './ActionFlow'
import { INPUT } from './styles'
import { Card, Pill } from './ui'

type OwnerFacts = { balance: bigint | null; registered: boolean | null; registrationMin: bigint | null }

/** The owner's own token balance and registration, and the token's registration minimum, read live. */
function useOwnerFacts(s: VaultSnapshot): OwnerFacts | null {
  const [facts, setFacts] = useState<{ key: string; f: OwnerFacts } | null>(null)
  const key = `${s.vaultId}|${s.readAt}`
  useEffect(() => {
    let alive = true
    const token = s.config.tokenId
    const owner = s.config.ownerId
    void Promise.all([
      viewCall(NEAR_RPC_URLS, token, 'ft_balance_of', { account_id: owner }).catch(() => null),
      viewCall(NEAR_RPC_URLS, token, 'storage_balance_of', { account_id: owner }).catch(() => null),
      viewCall(NEAR_RPC_URLS, token, 'storage_balance_bounds', {}).catch(() => null),
    ]).then(([bal, reg, bounds]) => {
      if (!alive) return
      const min = bounds?.ok && typeof bounds.value === 'object' && bounds.value !== null ? u128((bounds.value as { min?: unknown }).min) : null
      setFacts({ key, f: { balance: bal?.ok ? u128(bal.value) : null, registered: reg?.ok ? reg.value !== null : null, registrationMin: min } })
    })
    return () => {
      alive = false
    }
    // `key` names the vault and the read; the token and owner come from that same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return facts && facts.key === key ? facts.f : null
}

export default function OwnerControls({ s, ctx }: { s: VaultSnapshot; ctx: ActionContext }) {
  const isOwner = ctx.wallet.accountId === s.config.ownerId
  const facts = useOwnerFacts(s)
  return (
    <section aria-label="Owner controls" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-foreground/[0.05] text-foreground/80" aria-hidden="true">
            <Settings2 size={14} />
          </span>
          Owner controls
        </h3>
        {isOwner ? <Pill tone="ok">You are the owner</Pill> : <Pill tone="muted">Owner: {s.config.ownerId}</Pill>}
      </div>
      <p className="mt-2 text-xs text-foreground/85">
        {isOwner
          ? 'Each control shows the exact call before your wallet opens. Your wallet signs it; A-Identity signs nothing and holds no key.'
          : `Only ${s.config.ownerId} can sign these, and the contract refuses anyone else. Open them to see the exact calls the owner would sign.`}
      </p>
      <details open={isOwner} className="group mt-3">
        <summary className="cursor-pointer select-none text-xs font-semibold text-foreground underline decoration-accent/60 decoration-2 underline-offset-2 group-open:mb-3">
          {isOwner ? 'Hide the controls' : 'Show the owner controls'}
        </summary>
        <div className="grid gap-3">
          <FreezeControl s={s} ctx={ctx} />
          <HoldUnknownControl s={s} ctx={ctx} />
          <PolicyControl s={s} ctx={ctx} />
          <AllowlistControl s={s} ctx={ctx} />
          <FundControl s={s} ctx={ctx} facts={facts} />
          <WithdrawControl s={s} ctx={ctx} facts={facts} />
        </div>
      </details>
    </section>
  )
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} icon={icon} className="bg-background/60 p-4 sm:p-4">
      {children}
    </Card>
  )
}

function FreezeControl({ s, ctx }: { s: VaultSnapshot; ctx: ActionContext }) {
  const frozen = s.config.frozen
  return (
    <Panel title={frozen ? 'Unfreeze' : 'Freeze'} icon={frozen ? <Sun size={14} /> : <Snowflake size={14} />}>
      <p className="mb-3 text-xs text-foreground/85">
        {frozen
          ? 'The vault is frozen: every agent payment is refused. Unfreezing lets the policy decide again, so it needs the 1 yoctoNEAR only a full-access key can attach.'
          : 'Freezing refuses every agent payment on chain at once. It attaches no deposit, so it is one tap in your wallet. You can still approve held payments and withdraw while frozen.'}
      </p>
      <ActionFlow ctx={ctx} tx={frozen ? prepareUnfreeze(s.vaultId) : prepareFreeze(s.vaultId)} label={frozen ? 'Sign: unfreeze' : 'Sign: freeze now'} tone={frozen ? 'default' : 'danger'} />
    </Panel>
  )
}

function HoldUnknownControl({ s, ctx }: { s: VaultSnapshot; ctx: ActionContext }) {
  const on = s.config.holdUnknown
  return (
    <Panel title="Payees nobody has judged" icon={<ShieldQuestion size={14} />}>
      {on === null ? (
        <p className="text-xs text-foreground/85">This build does not report the switch (it predates it), so there is nothing to set here.</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-foreground/85">
            {on
              ? 'Now: a first payment to a payee the registry is silent on waits for you, unless you listed the payee or the vault paid it before. A payee created minutes ago is exactly that payee.'
              : 'Now: a payee the registry is silent on is paid within the limits. Turning this on makes a first payment to such a payee wait for you.'}
          </p>
          <ActionFlow ctx={ctx} tx={prepareSetHoldUnknown(s.vaultId, !on)} label={on ? 'Sign: stop holding them' : 'Sign: hold them for me'} />
        </>
      )}
    </Panel>
  )
}

/** A token amount field's value as units, with the reason when it is not one. */
function useAmount(text: string, decimals: number | null): { units: bigint | null; problem: string | null } {
  return useMemo(() => {
    if (decimals === null) return { units: null, problem: "The token's decimals did not answer, so no amount can be built safely." }
    const r = parseUnits(text, decimals)
    return r.ok ? { units: r.units, problem: null } : { units: null, problem: r.reason }
  }, [text, decimals])
}

function PolicyControl({ s, ctx }: { s: VaultSnapshot; ctx: ActionContext }) {
  const d = s.token.decimals
  const sym = s.token.symbol ?? 'units'
  const [cap, setCap] = useState(() => (d === null ? '' : formatUnits(s.config.dailyCap, d)))
  const [ceiling, setCeiling] = useState(() => (d === null ? '' : formatUnits(s.config.autoApproveMax, d)))
  const [allowlist, setAllowlist] = useState(s.config.allowlistEnabled)
  const capU = useAmount(cap, d)
  const ceilU = useAmount(ceiling, d)
  let tx: PreparedTx | null = null
  let invalid: string | null = capU.problem ? `Daily cap: ${capU.problem}` : ceilU.problem ? `Per payment: ${ceilU.problem}` : null
  if (!invalid && capU.units !== null && ceilU.units !== null) {
    const same = capU.units === s.config.dailyCap && ceilU.units === s.config.autoApproveMax && allowlist === s.config.allowlistEnabled
    if (same) invalid = 'These are the current values. Change one to build the call.'
    else tx = prepareSetPolicy(s.vaultId, { dailyCap: capU.units, autoApproveMax: ceilU.units, allowlistEnabled: allowlist })
  }
  const notes = [
    capU.units === 0n ? 'A daily cap of 0 means no daily limit at all.' : null,
    ceilU.units === 0n ? 'A ceiling of 0 means no per-payment limit.' : null,
    allowlist && s.allowlist.length === 0 ? 'With the allowlist on and nobody listed, the agent can pay nobody.' : null,
  ].filter((n): n is string => n !== null)
  return (
    <Panel title="Limits" icon={<Settings2 size={14} />}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[11px] font-semibold text-foreground/80">
          Daily cap, {sym} (0 = none)
          <input className={INPUT} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="block text-[11px] font-semibold text-foreground/80">
          Per payment, {sym} (0 = none)
          <input className={INPUT} inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
        </label>
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-foreground">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={allowlist} onChange={(e) => setAllowlist(e.target.checked)} />
        Enforce the allowlist: the agent pays listed payees only
      </label>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {notes.map((n) => (
            <li key={n} className="text-xs text-foreground/85">
              {n}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <ActionFlow ctx={ctx} tx={tx} invalid={invalid} label="Sign: set the limits" />
      </div>
    </Panel>
  )
}

function AllowlistControl({ s, ctx }: { s: VaultSnapshot; ctx: ActionContext }) {
  const [payee, setPayee] = useState('')
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const p = payee.trim()
  const listed = s.allowlist.includes(p)
  let tx: PreparedTx | null = null
  let invalid: string | null = null
  if (p === '') invalid = 'Enter the payee account to build the call.'
  else if (!isNearAccountId(p)) invalid = 'That is not a NEAR account id: lowercase letters, digits, and . - _ between them, such as merchant.testnet.'
  else if (p === s.vaultId || p === s.config.tokenId) invalid = 'The vault and its token can never be paid, so listing them does nothing.'
  else if (mode === 'add' && listed) invalid = 'Already on the allowlist.'
  else if (mode === 'remove' && !listed) invalid = 'Not on the allowlist.'
  else if (mode === 'add' && s.allowlist.length >= MAX_ALLOWLIST) invalid = `The allowlist is full (${MAX_ALLOWLIST}). Remove one first.`
  else tx = prepareSetAllowed(s.vaultId, p, mode === 'add')
  return (
    <Panel title="Allowlist" icon={<ListChecks size={14} />}>
      <p className="mb-3 text-xs text-foreground/85">
        {s.config.allowlistEnabled
          ? 'Enforced: the agent can pay listed payees only.'
          : 'Not enforced today, but a listed payee counts as known, so a payment to it is not held as unknown.'}{' '}
        Listing a payee never overrides a registry DENY.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1 text-[11px] font-semibold text-foreground/80">
          Payee account
          <input
            className={`${INPUT} font-mono text-xs`}
            placeholder="merchant.testnet"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
          />
        </label>
        <div role="radiogroup" aria-label="Add or remove" className="flex rounded-full border border-border p-0.5 text-xs font-semibold">
          {(['add', 'remove'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-full px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === m ? 'bg-foreground text-background' : 'text-foreground'}`}
            >
              {m === 'add' ? 'Add' : 'Remove'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <ActionFlow ctx={ctx} tx={tx} invalid={invalid} label={mode === 'add' ? 'Sign: add to the list' : 'Sign: remove from the list'} />
      </div>
    </Panel>
  )
}

function FundControl({ s, ctx, facts }: { s: VaultSnapshot; ctx: ActionContext; facts: OwnerFacts | null }) {
  const d = s.token.decimals
  const sym = s.token.symbol ?? 'units'
  const [text, setText] = useState('')
  const amt = useAmount(text, d)
  const registration = s.registeredOnToken === true ? null : (facts?.registrationMin ?? s.config.tokenStorageDeposit)
  const held = facts?.balance ?? null
  let tx: PreparedTx | null = null
  let invalid: string | null = null
  if (!s.token.documented) invalid = 'This vault holds a token the registry does not document as USDC, so this page builds no funding call for it.'
  else if (text.trim() === '') invalid = `Enter how much ${sym} to send.`
  else if (amt.problem || amt.units === null || d === null) invalid = amt.problem ?? 'No amount yet.'
  else if (amt.units === 0n) invalid = 'Send more than 0.'
  else if (held !== null && amt.units > held) invalid = `The owner holds ${formatGrouped(held, d)} ${sym}, less than that.`
  else tx = prepareFund(s.config.tokenId, s.vaultId, amt.units, `${formatGrouped(amt.units, d)} ${sym}`, registration)
  return (
    <Panel title="Fund the vault" icon={<ArrowDownToLine size={14} />}>
      <p className="mb-3 text-xs text-foreground/85">
        One transaction to the token: {registration === null ? '' : `registering the vault on it first (${formatNear(registration, 5)} NEAR, refunded if it is already registered), then `}
        ft_transfer_call into the vault, whose ft_on_transfer keeps only its own token.{' '}
        {held !== null && d !== null ? `The owner holds ${formatGrouped(held, d)} ${sym}.` : ''}
      </p>
      <label className="block text-[11px] font-semibold text-foreground/80">
        Amount ({sym})
        <input className={INPUT} inputMode="decimal" placeholder="1.00" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="mt-3">
        <ActionFlow ctx={ctx} tx={tx} invalid={invalid} label="Sign: send into the vault" />
      </div>
    </Panel>
  )
}

function WithdrawControl({ s, ctx, facts }: { s: VaultSnapshot; ctx: ActionContext; facts: OwnerFacts | null }) {
  const d = s.token.decimals
  const sym = s.token.symbol ?? 'units'
  const [text, setText] = useState('')
  const amt = useAmount(text, d)
  let tx: PreparedTx | null = null
  let invalid: string | null = null
  if (text.trim() === '') invalid = `Enter how much ${sym} to take back.`
  else if (amt.problem || amt.units === null || d === null) invalid = amt.problem ?? 'No amount yet.'
  else if (amt.units === 0n) invalid = 'Withdraw more than 0.'
  else if (s.balance !== null && amt.units > s.balance) invalid = 'The vault holds less than that; the token transfer would fail.'
  else tx = prepareWithdraw(s.vaultId, amt.units, `${formatGrouped(amt.units, d)} ${sym}`)
  return (
    <Panel title="Withdraw to the owner" icon={<ArrowUpFromLine size={14} />}>
      <p className="mb-3 text-xs text-foreground/85">
        The contract pays only its owner: there is no destination to choose, so even a tricked signature cannot send the money elsewhere.
        {facts?.registered === false ? ' The owner is not registered on the token yet, so the transfer would fail: fund once from this account, or register it on the token first.' : ''}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1 text-[11px] font-semibold text-foreground/80">
          Amount ({sym})
          <input className={INPUT} inputMode="decimal" placeholder="1.00" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {s.balance !== null && s.balance > 0n && d !== null && (
          <button
            type="button"
            onClick={() => setText(formatUnits(s.balance ?? 0n, d))}
            className="mb-0.5 rounded-full border border-border px-3 py-2 text-xs font-semibold text-foreground hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All of it
          </button>
        )}
      </div>
      <div className="mt-3">
        <ActionFlow ctx={ctx} tx={tx} invalid={invalid} label="Sign: withdraw" />
      </div>
    </Panel>
  )
}
