/**
 * The top of a live NEAR vault: the one-sentence answer to "what can my agent do right now?",
 * the four numbers behind it, and how the vault decides a payment, drawn with this vault's own
 * live settings. Every value comes from the same read, stamped with the final block it came from.
 */
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleHelp, KeyRound, ShieldAlert, ShieldCheck, ShieldX, SlidersHorizontal, Snowflake, Hourglass, CircleCheck } from 'lucide-react'
import ChainLogo from '../ChainLogo'
import TokenLogo from '../marketplace/TokenLogo'
import { nearAccountUrl } from '../../../lib/near/chain'
import { isNearAccountId } from '../../../lib/near/ids'
import { dayResetsAtS, relativeTime, utcText, vaultHeadline } from '../../../lib/near/model'
import type { VaultSnapshot } from '../../../lib/near/read'
import { formatGrouped } from '../../../lib/near/units'
import { localTime } from '../../../lib/local-time'
import { cn } from '../../../lib/utils'
import { TONE_FRAME, TONE_ICON } from './styles'
import { CopyButton, ExtLink, IdText, Label, Meter, Mono, Pill } from './ui'

/** The read stamp under live values: which final blocks answered, from which host, and when. */
export function ReadStamp({ s, refreshing }: { s: VaultSnapshot; refreshing?: boolean }) {
  const blocks = s.blocks.min === s.blocks.max ? `block ${s.blocks.max.toLocaleString('en-US')}` : `final blocks ${s.blocks.min.toLocaleString('en-US')} to ${s.blocks.max.toLocaleString('en-US')}`
  return (
    <p className="text-[11px] tabular-nums text-foreground/75">
      Read live at {blocks} from {s.hosts.join(', ')}, {localTime(s.readAt)} (your time){refreshing ? ', refreshing...' : ''}
    </p>
  )
}

function Tile({ label, value, sub, children }: { label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card px-3.5 py-3">
      <Label>{label}</Label>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-base font-semibold tabular-nums text-foreground sm:text-lg">{value}</div>
      {children}
      {sub && <div className="mt-1 text-[11px] text-foreground/75">{sub}</div>}
    </div>
  )
}

export default function VaultOverview({ s, payingKeys, refreshing }: { s: VaultSnapshot; payingKeys: number; refreshing?: boolean }) {
  const decimals = s.token.decimals ?? 0
  const symbol = s.token.symbol ?? 'units'
  const amt = (x: bigint) => (s.token.decimals === null ? `${x.toString()} units` : `${formatGrouped(x, decimals)} ${symbol}`)
  const h = vaultHeadline({
    frozen: s.config.frozen,
    payingKeys,
    remaining: s.remainingToday,
    autoApproveMax: s.config.autoApproveMax,
    decimals,
    symbol,
    registryId: s.config.registryId,
    registryLive: s.registryLive,
    holdUnknown: s.config.holdUnknown,
  })
  const resets = dayResetsAtS(s.today)
  return (
    <section aria-label="What the agent can do now" className="space-y-3">
      <div className={cn('rounded-2xl border p-4 sm:p-5', TONE_FRAME[h.tone])}>
        <div className="flex flex-wrap items-center gap-2">
          <ChainLogo id="near-testnet" size={26} />
          <Mono className="text-sm font-semibold">{s.vaultId}</Mono>
          <CopyButton text={s.vaultId} label="Copy" />
          <ExtLink href={nearAccountUrl(s.vaultId)} className="text-xs">
            NearBlocks
          </ExtLink>
          <Pill tone="accent">NEAR testnet: test USDC, no real money</Pill>
          {s.config.frozen && (
            <Pill tone="danger" icon={<Snowflake size={11} className="text-danger" aria-hidden="true" />}>
              Frozen
            </Pill>
          )}
        </div>
        <div className="mt-3 flex items-start gap-3">
          <span className={cn('mt-0.5 shrink-0', TONE_ICON[h.tone])} aria-hidden="true">
            {h.tone === 'ok' ? <ShieldCheck size={22} /> : h.tone === 'danger' ? <ShieldX size={22} /> : <ShieldAlert size={22} />}
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold leading-snug text-foreground sm:text-lg">{h.title}</p>
            <p className="mt-1 text-sm text-foreground/80">{h.detail}</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Tile
            label="Spent today"
            value={amt(s.spentToday)}
            sub={s.config.dailyCap === 0n ? 'No daily cap' : `of a ${amt(s.config.dailyCap)} daily cap`}
          >
            <Meter value={s.spentToday} max={s.config.dailyCap} label="Spent today against the daily cap" />
          </Tile>
          <Tile
            label="Left today"
            value={s.remainingToday === null ? 'No cap' : amt(s.remainingToday)}
            sub={`Resets ${relativeTime(resets, s.chainNowS)} (${utcText(resets) ?? 'midnight UTC'})`}
          />
          <Tile
            label="Per payment"
            value={s.config.autoApproveMax === 0n ? 'No ceiling' : amt(s.config.autoApproveMax)}
            sub={s.config.autoApproveMax === 0n ? 'Only the daily cap bounds one payment' : 'Above it, the agent must ask you'}
          />
          <Tile
            label="Vault balance"
            value={
              <>
                {s.token.documented && <TokenLogo symbol="USDC" size={18} />}
                <span className="min-w-0 break-words">{s.balance === null ? 'Unreadable' : amt(s.balance)}</span>
              </>
            }
            sub={s.token.documented ? "Circle's testnet USDC, as the registry documents it" : 'Not the USDC the registry documents'}
          />
        </div>
        <div className="mt-3">
          <ReadStamp s={s} refreshing={refreshing} />
        </div>
      </div>
      <GuardFlow
        keyLine={payingKeys === 0 ? 'No key can pay now' : `${payingKeys} key${payingKeys === 1 ? '' : 's'} can pay`}
        policyLine={`${s.config.dailyCap === 0n ? 'No daily cap' : `${amt(s.config.dailyCap)} a day`}, ${s.config.autoApproveMax === 0n ? 'no ceiling' : `${amt(s.config.autoApproveMax)} a payment`}`}
        policySub={`${s.config.allowlistEnabled ? 'Allowlist on' : 'Allowlist off'}${s.config.frozen ? ', frozen' : ''}`}
        registryLine={s.config.registryId ?? 'No registry set'}
        registrySub={s.config.registryId ? (s.registryLive === false ? 'Not a live contract: every payment fails closed' : 'DENY refused on chain, WARN held') : 'No on-chain verdict check'}
        unknownLine={s.config.holdUnknown === null ? 'Not reported by this build' : s.config.holdUnknown ? 'Held for the owner' : 'Paid within the limits'}
        unknownSub={
          s.config.holdUnknown === null
            ? 'This build predates the switch'
            : s.config.holdUnknown
              ? 'Paid only if you listed it or the vault paid it before'
              : 'The hold switch (hold_unknown) is off'
        }
      />
    </section>
  )
}

/**
 * How a payment is decided, left to right, with the outcomes it can end in. Used for a live vault
 * (its own values) and for the not-deployed state (the planned demo's values, labelled planned).
 */
export function GuardFlow({
  keyLine,
  policyLine,
  policySub,
  registryLine,
  registrySub,
  unknownLine,
  unknownSub,
  planned,
}: {
  keyLine: string
  policyLine: string
  policySub: string
  registryLine: string
  registrySub: string
  unknownLine: string
  unknownSub: string
  planned?: boolean
}) {
  const steps = [
    { icon: KeyRound, title: 'Agent key', line: keyLine, sub: 'Function-call key on the vault: pay, request_payment, record_refusal only' },
    { icon: SlidersHorizontal, title: 'Vault policy', line: policyLine, sub: policySub },
    { icon: ShieldCheck, title: 'Registry verdict', line: registryLine, sub: registrySub },
    { icon: CircleHelp, title: 'Payee nobody judged', line: unknownLine, sub: unknownSub },
  ]
  return (
    <section aria-label="How this vault decides a payment" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">How this vault decides an agent payment</h3>
        {planned ? <Pill tone="muted">Planned values</Pill> : <Pill tone="ok">Live settings</Pill>}
      </div>
      <ol className="mt-3 flex flex-col gap-1.5 lg:flex-row lg:gap-1">
        {steps.map((st, i) => (
          <li key={st.title} className="flex min-w-0 flex-col gap-1.5 lg:flex-1 lg:flex-row lg:gap-1">
            <div className="min-w-0 flex-1 rounded-xl border border-border bg-background/60 p-3">
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-foreground" aria-hidden="true">
                  <st.icon size={14} />
                </span>
                <span className="text-xs font-semibold text-foreground">
                  {i + 1}. {st.title}
                </span>
              </div>
              <p className={cn('mt-2 text-sm font-semibold text-foreground', isNearAccountId(st.line) ? 'font-mono text-xs [overflow-wrap:anywhere]' : 'break-words')}>
                {isNearAccountId(st.line) ? <IdText id={st.line} /> : st.line}
              </p>
              <p className="mt-0.5 text-[11px] text-foreground/75">{st.sub}</p>
            </div>
            {i < steps.length - 1 && (
              <span className="flex shrink-0 items-center justify-center text-foreground/55 lg:w-4" aria-hidden="true">
                <ChevronRight size={16} className="hidden lg:block" />
                <ChevronDown size={16} className="lg:hidden" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">Ends in</span>
        <Pill tone="ok" icon={<CircleCheck size={11} className="text-ok" aria-hidden="true" />}>
          Paid
        </Pill>
        <Pill tone="warn" icon={<Hourglass size={11} className="text-warn" aria-hidden="true" />}>
          Held for the owner
        </Pill>
        <Pill tone="danger" icon={<ShieldX size={11} className="text-danger" aria-hidden="true" />}>
          Refused on chain, with a receipt
        </Pill>
      </div>
    </section>
  )
}
