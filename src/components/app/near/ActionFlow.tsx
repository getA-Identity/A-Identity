/**
 * Every owner action on the NEAR vault, the same way: the exact call on screen first (prepared),
 * then the wallet, then the transaction as the chain finalized it (executed), with every event
 * the vault logged and every token transfer the token logged. A-Identity signs nothing.
 *
 * The sign button is drawn for everyone and works only for the vault's owner: anyone else sees
 * the call the owner would sign, and why it is not theirs to sign. The contract would refuse it
 * anyway (NotOwner); the page says so before a wallet is ever asked.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, PenLine, XCircle } from 'lucide-react'
import { payOutcomeOf, tokenTransfersOf, vaultEventsOf } from '../../../lib/near/abi'
import { totalDeposit, totalTgas, type PreparedTx } from '../../../lib/near/calls'
import { nearAccountUrl, nearTxUrl } from '../../../lib/near/chain'
import { vaultErrorText } from '../../../lib/near/errors'
import { describeEvent } from '../../../lib/near/events'
import { shortId } from '../../../lib/near/ids'
import { formatGrouped, formatNear } from '../../../lib/near/units'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { TONE_FRAME, TONE_ICON } from './styles'
import { CopyButton, ExtLink, Label, Mono, Pill } from './ui'
import type { NearWalletState } from './useNearWallet'
import { useTxRun, type TxRun } from './useTxRun'

const depositText = (yocto: string) => (yocto === '0' ? 'None' : yocto === '1' ? '1 yoctoNEAR' : `${formatNear(yocto, 5)} NEAR (${yocto} yoctoNEAR)`)

/** The prepared transaction, exactly as the wallet will be handed it. */
export function CallReview({ tx, signerId }: { tx: PreparedTx; signerId: string }) {
  const oneYocto = tx.actions.some((a) => a.params.deposit === '1')
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-foreground">The exact call</span>
        <Pill tone="muted">Prepared, not signed</Pill>
        <Pill tone="accent">NEAR testnet</Pill>
      </div>
      <p className="mt-2 text-sm text-foreground">{tx.what}</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-sm">
        <dt>
          <Label>Sent to</Label>
        </dt>
        <dd className="min-w-0">
          <Mono>{tx.receiverId}</Mono>
        </dd>
        <dt>
          <Label>Signed by</Label>
        </dt>
        <dd className="min-w-0">
          <Mono>{signerId}</Mono>
        </dd>
      </dl>
      <ol className="mt-3 space-y-2">
        {tx.actions.map((a, i) => (
          <li key={i} className="min-w-0 rounded-lg bg-term p-3 text-term-fg">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
              <span className="font-semibold">
                {tx.actions.length > 1 ? `${i + 1}. ` : ''}
                {a.params.methodName}
              </span>
              <span className="text-term-dim">
                gas {totalTgas({ ...tx, actions: [a] })} Tgas, deposit {depositText(a.params.deposit)}
              </span>
            </div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-term-dim">{JSON.stringify(a.params.args, null, 2)}</pre>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-foreground/75">
        {oneYocto ? 'The 1 yoctoNEAR deposit is the contract\'s proof that a full-access key signed: a key a website was given cannot attach one. ' : ''}
        Gas is prepaid ({totalTgas(tx)} Tgas in all) and what is not used is refunded. Total attached: {depositText(totalDeposit(tx).toString())}. Your wallet shows this
        same call before you approve it.
      </p>
    </div>
  )
}

/** Where a sent transaction stands, and what it did once final. */
export function TxProgress({
  run,
  vaultId,
  tokenId,
  decimals,
  symbol,
  onReset,
  onLookAgain,
}: {
  run: TxRun
  vaultId: string
  tokenId: string
  decimals: number | null
  symbol: string
  onReset: () => void
  onLookAgain: () => void
}) {
  if (run.phase === 'idle') return null
  if (run.phase === 'signing')
    return (
      <Callout tone="muted" icon={<Loader2 size={15} className="animate-spin" aria-hidden="true" />}>
        Waiting for your wallet. Approve the call there, or close it to cancel. Nothing is sent until you approve.
      </Callout>
    )
  if (run.phase === 'cancelled')
    return (
      <Callout tone="muted" icon={<XCircle size={15} aria-hidden="true" />} onDismiss={onReset}>
        Nothing was sent. The wallet said: {run.text}
      </Callout>
    )
  if (run.phase === 'no-hash')
    return (
      <Callout tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} onDismiss={onReset}>
        The wallet answered without a transaction hash, so this page cannot follow the call. It may still land: check your wallet's activity before you
        sign it again.
      </Callout>
    )
  const hashLine = (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <Mono>{shortId(run.hash, 12)}</Mono>
      <CopyButton text={run.hash} label="Copy hash" />
      <ExtLink href={nearTxUrl(run.hash)} className="text-xs">
        NearBlocks
      </ExtLink>
    </span>
  )
  if (run.phase === 'pending')
    return (
      <Callout tone="muted" icon={<Clock size={15} aria-hidden="true" />}>
        <span className="font-semibold">Sent. Waiting for the final block.</span>{' '}
        {run.seen === 'unreachable'
          ? 'No NEAR host answered the last check; the page keeps asking.'
          : run.seen === 'in-progress'
            ? 'The network has it and is still executing it.'
            : 'No host reports it yet; that is normal for the first few seconds.'}
        {hashLine}
      </Callout>
    )
  if (run.phase === 'slow')
    return (
      <Callout tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} onDismiss={onReset}>
        <span className="font-semibold">Not final after three minutes.</span> It may still land; this page stopped asking so it does not hold this card.{' '}
        <button type="button" onClick={onLookAgain} className="font-semibold text-foreground underline decoration-accent/60 decoration-2 underline-offset-2">
          Look again
        </button>
        {hashLine}
      </Callout>
    )
  // Final: what the chain says it did. An owner_pay the vault declines (a payee the registry now
  // says DENY, an expired hold) is a successful transaction with a refusal inside it, so its
  // PayOutcome decides the headline, not the transaction status alone.
  const events = vaultEventsOf(run.outcome, vaultId).map((e) => describeEvent(e, decimals, symbol))
  const moved = tokenTransfersOf(run.outcome, tokenId)
  const pay = payOutcomeOf(run.outcome)
  const declined = pay !== null && pay.status !== 'sent'
  // A vault error name in words: the panic that failed the call, or the reason the vault declined.
  const meaning = !run.verdict.ok ? vaultErrorText(run.verdict.reason) : declined ? vaultErrorText(pay.reason) : null
  return (
    <Callout
      tone={!run.verdict.ok ? 'danger' : declined ? 'warn' : 'ok'}
      icon={run.verdict.ok && !declined ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}
      onDismiss={onReset}
    >
      <span className="font-semibold">
        {!run.verdict.ok
          ? `Executed and final, but it failed: ${run.verdict.reason}.`
          : declined && pay
            ? `Executed and final: the vault answered ${pay.status}${pay.reason ? ` (${pay.reason})` : ''}, so nothing was paid.`
            : 'Executed and final.'}
      </span>{' '}
      {!run.verdict.ok
        ? run.verdict.where === 'transaction'
          ? 'The contract refused the call, so nothing it would have changed was changed.'
          : 'A receipt after the call failed; the events below say what did happen.'
        : 'Read back from the chain, not from the wallet.'}
      {meaning && <span className="mt-1 block">{meaning}</span>}
      {hashLine}
      {(events.length > 0 || moved.length > 0) && (
        <ul className="mt-2 space-y-1">
          {events.map((e, i) => (
            <li key={`e${i}`} className="text-xs text-foreground">
              <span className="font-semibold">Vault event:</span> {e.title}
              {e.detail ? <span className="text-foreground/80"> ({e.detail})</span> : null}
            </li>
          ))}
          {moved.map((m, i) => (
            <li key={`m${i}`} className="text-xs text-foreground">
              <span className="font-semibold">Token transfer:</span> {decimals === null ? `${m.amount.toString()} units` : `${formatGrouped(m.amount, decimals)} ${symbol}`} from{' '}
              <ExtLink href={nearAccountUrl(m.from)}>{shortId(m.from)}</ExtLink> to <ExtLink href={nearAccountUrl(m.to)}>{shortId(m.to)}</ExtLink>
            </li>
          ))}
        </ul>
      )}
    </Callout>
  )
}

function Callout({ tone, icon, children, onDismiss }: { tone: 'ok' | 'warn' | 'danger' | 'muted'; icon: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role={tone === 'danger' || tone === 'warn' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-xs text-foreground', TONE_FRAME[tone])}>
      <span className={cn('mt-0.5 shrink-0', TONE_ICON[tone])}>{icon}</span>
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md px-1.5 text-[11px] font-semibold text-foreground/80 hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

export type ActionContext = {
  wallet: NearWalletState
  ownerId: string
  vaultId: string
  tokenId: string
  decimals: number | null
  symbol: string
  /** A transaction from this page is final: read the vault and its activity again. */
  onLanded: () => void
}

/**
 * The exact call (when the inputs make one), the sign button, and the run's progress. `invalid`
 * explains why there is no call yet; it never disables silently.
 */
export function ActionFlow({
  ctx,
  tx,
  invalid,
  label,
  showCall = true,
  tone = 'default',
}: {
  ctx: ActionContext
  tx: PreparedTx | null
  invalid?: string | null
  label: string
  showCall?: boolean
  tone?: 'default' | 'danger'
}) {
  const { wallet, ownerId } = ctx
  const { run, start, reset, lookAgain } = useTxRun({ vaultId: ctx.vaultId, signerId: wallet.accountId, send: wallet.send, onFinal: ctx.onLanded })
  const isOwner = wallet.accountId === ownerId
  const busy = run.phase === 'signing' || run.phase === 'pending'
  const whyNot = !wallet.accountId
    ? `Connect the owner's wallet (${ownerId}) to sign this.`
    : !isOwner
      ? `${wallet.accountId} is not this vault's owner, so the contract would refuse it (NotOwner). The owner is ${ownerId}.`
      : null
  return (
    <div className="space-y-3">
      {invalid ? <p className="text-xs text-foreground/80">{invalid}</p> : tx && showCall ? <CallReview tx={tx} signerId={wallet.accountId ?? ownerId} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant={tone === 'danger' ? 'inverse' : 'default'}
          onClick={() => tx && void start(tx)}
          disabled={!tx || Boolean(invalid) || !isOwner || busy}
        >
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <PenLine size={13} aria-hidden="true" />}
          {run.phase === 'signing' ? 'Waiting for the wallet...' : run.phase === 'pending' ? 'Sent, waiting...' : label}
        </Button>
        {whyNot && <span className="text-xs text-foreground/80">{whyNot}</span>}
      </div>
      <TxProgress run={run} vaultId={ctx.vaultId} tokenId={ctx.tokenId} decimals={ctx.decimals} symbol={ctx.symbol} onReset={reset} onLookAgain={lookAgain} />
    </div>
  )
}
