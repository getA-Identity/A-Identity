/**
 * Payments waiting for the owner, with why each one waits, what the registry says about its payee
 * now, and, for the owner, approve or reject.
 *
 * Approving is not a bypass of the registry: owner_pay asks it again (when the vault has one), and
 * a payee flagged DENY since the payment was held is refused even for the owner, because a held
 * payment can wait for a day while its payee is flagged. owner_pay removes the hold first, so an
 * approval the registry refuses drops the hold and pays nothing. A registry that is not a live
 * contract refuses every approval, so the page offers none then. Approving does bypass the freeze,
 * the ceiling and the cap check, and it still counts toward the day's spend. Each of those is said
 * next to the button (model.ts, ownerPayNote).
 */
import { useState } from 'react'
import { Check, Hourglass, Inbox, ShieldX, X } from 'lucide-react'
import { heldReason, type HeldPayment } from '../../../lib/near/abi'
import { prepareOwnerPay, prepareOwnerReject } from '../../../lib/near/calls'
import { nearAccountUrl } from '../../../lib/near/chain'
import { shortKey } from '../../../lib/near/ids'
import { ownerPayNote, relativeTime, utcText } from '../../../lib/near/model'
import type { PayeeFacts, VaultSnapshot } from '../../../lib/near/read'
import { formatGrouped } from '../../../lib/near/units'
import { cn } from '../../../lib/utils'
import { ActionFlow, type ActionContext } from './ActionFlow'
import { VerdictPill } from './Payees'
import { BUTTON_QUIET, TONE_FRAME, TONE_ICON } from './styles'
import { Card, ExtLink, IdText, Pill } from './ui'

function HeldRow({ h, s, facts, payeesLoading, ctx }: { h: HeldPayment; s: VaultSnapshot; facts: PayeeFacts | undefined; payeesLoading: boolean; ctx: ActionContext }) {
  const [open, setOpen] = useState<'approve' | 'reject' | null>(null)
  const reason = heldReason(h.reason)
  const expired = s.chainNowS > h.expiresAtS
  const amount = s.token.decimals === null ? `${h.amount.toString()} units` : `${formatGrouped(h.amount, s.token.decimals)} ${s.token.symbol ?? ''}`.trim()
  const denied = Boolean(facts?.verdict?.ok && facts.verdict.verdict?.verdict === 'DENY')
  const note = ownerPayNote({ registryId: s.config.registryId, registryLive: s.registryLive, payeeDenied: denied })
  return (
    <li className="p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {amount} to{' '}
            <ExtLink href={nearAccountUrl(h.payee)} className="font-mono text-xs [overflow-wrap:anywhere]">
              <IdText id={h.payee} />
            </ExtLink>
          </p>
          <p className="mt-1 text-xs text-foreground/85">{reason.title}.</p>
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          {expired ? <Pill tone="muted">Expired</Pill> : <Pill tone={reason.kind === 'warn' ? 'warn' : 'accent'}>{reason.kind === 'warn' ? 'Registry warned' : reason.kind === 'unknown' ? 'Unknown payee' : 'Agent asked'}</Pill>}
          {/* Once the payee reads have settled, a missing answer says "Not read", never a spinner that never ends. */}
          <VerdictPill read={facts ? facts.verdict : undefined} loading={!facts && payeesLoading} noRegistry={!s.config.registryId} />
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-foreground/80">
        Held #{h.id} (payment #{h.paymentId}) by agent key {shortKey(h.agentPk)}, {relativeTime(h.createdAtS, s.chainNowS)}.{' '}
        {expired ? 'Its 24 hours are up: approving would only remove it.' : `Waits until ${utcText(h.expiresAtS) ?? h.expiresAtS.toString()} (${relativeTime(h.expiresAtS, s.chainNowS)}).`}
        {h.memo ? ` Memo: "${h.memo}".` : ''}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {!expired && (
          <button type="button" className={cn(BUTTON_QUIET, open === 'approve' && 'bg-foreground/[0.06]')} aria-expanded={open === 'approve'} onClick={() => setOpen(open === 'approve' ? null : 'approve')}>
            <Check size={12} className="text-ok" aria-hidden="true" />
            Approve and pay
          </button>
        )}
        <button type="button" className={cn(BUTTON_QUIET, open === 'reject' && 'bg-foreground/[0.06]')} aria-expanded={open === 'reject'} onClick={() => setOpen(open === 'reject' ? null : 'reject')}>
          <X size={12} className="text-danger" aria-hidden="true" />
          {expired ? 'Remove it' : 'Reject'}
        </button>
      </div>
      {open === 'approve' && (
        <div className="mt-3 space-y-2">
          {note.blocked ? (
            // The chain is certain to refuse it and drop the hold, so no signature is offered.
            <div role="alert" className={cn('flex items-start gap-2.5 rounded-xl border px-3 py-2.5', TONE_FRAME.danger)}>
              <ShieldX size={15} className={cn('mt-0.5 shrink-0', TONE_ICON.danger)} aria-hidden="true" />
              <p className="min-w-0 text-xs leading-relaxed text-foreground">{note.blocked}</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-foreground/85">{note.text}</p>
              <ActionFlow ctx={ctx} tx={prepareOwnerPay(s.vaultId, h.id, s.config.registryId)} label="Sign the approval" />
            </>
          )}
        </div>
      )}
      {open === 'reject' && (
        <div className="mt-3">
          <ActionFlow ctx={ctx} tx={prepareOwnerReject(s.vaultId, h.id)} label={expired ? 'Sign the removal' : 'Sign the rejection'} />
        </div>
      )}
    </li>
  )
}

export default function HeldPayments({
  s,
  byPayee,
  payeesLoading,
  ctx,
}: {
  s: VaultSnapshot
  byPayee: Map<string, PayeeFacts>
  payeesLoading: boolean
  ctx: ActionContext
}) {
  const open = s.held.filter((h) => s.chainNowS <= h.expiresAtS).length
  // Why a payment can land here, from this vault's own settings: no registry means no WARN, and
  // hold_unknown off means a payee nobody judged is paid rather than held.
  const why = [
    s.config.registryId ? 'when the registry warns about a payee' : null,
    s.config.holdUnknown === false ? null : 'when nobody has judged the payee yet',
    'when the agent asks you',
  ].filter((w): w is string => w !== null)
  return (
    <Card
      title="Payments waiting for the owner"
      icon={<Hourglass size={14} />}
      aside={s.held.length > 0 ? <Pill tone={open > 0 ? 'warn' : 'muted'}>{open} waiting</Pill> : <Pill tone="muted">list_held, read live</Pill>}
    >
      {s.held.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-4">
          <Inbox size={18} className="shrink-0 text-foreground/70" aria-hidden="true" />
          <p className="text-sm text-foreground/85">
            Nothing is waiting. A payment lands here {why.length > 1 ? `${why.slice(0, -1).join(', ')}, or ${why[why.length - 1]}` : why[0]}.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {s.held.map((h) => (
            <HeldRow key={h.id} h={h} s={s} facts={byPayee.get(h.payee)} payeesLoading={payeesLoading} ctx={ctx} />
          ))}
        </ul>
      )}
    </Card>
  )
}
