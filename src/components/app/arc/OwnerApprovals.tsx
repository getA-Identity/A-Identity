/**
 * The payments waiting for a vault's owner, and the owner's approval of them: who gets paid, how much,
 * what the check said and when, what approving does to today's budget, and one way to send it. It is
 * a person signing a transfer of real money, often from a link someone sent them, so
 * lib/arc/handoff-rules.ts decides what may be offered and every line of it is said there: read that first.
 *
 * What this component adds is the order things happen in:
 *
 *   - Nothing is offered until the vault's own Paid events were read, so a payment made from another
 *     browser or wallet is not made twice. That read answers for each card by itself, and only what could
 *     be offered or is still being followed reaches it: see scanStart.
 *   - Review reads and simulates everything, and shows what would be sent. Confirm does it all over again
 *     against what was reviewed, then writes down that the wallet was asked, then asks it. The hash goes
 *     into that record the moment it comes back, and the record is shared by every tab and survives a reload.
 *   - Saying no records nothing, because a flow has no such state, and the card says so. It hides the
 *     payment in this browser and that is all it does.
 *   - Nothing reads as paid until our server read the receipt from the chain itself. TxReceipt reads as
 *     landed until then, and a receipt the server did not accept is said to be that.
 *
 * The transaction is kept here and not in the page's own receipt slot, whose receipt calls a good receipt
 * settled by itself. Everything a record says reaches the screen as text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, ShieldAlert } from 'lucide-react'
import { track } from '../../../lib/analytics'
import type { Chain } from '../../../lib/chains'
import {
  FROZEN_LINE,
  PAID_LOOKBACK_WORDS,
  afterScan,
  agePhrase,
  budgetLine,
  cardHeading,
  hashToPost,
  holdFor,
  holdOf,
  holdsPage,
  keyStoppedLine,
  notFromAgentLine,
  ownerOnlyLine,
  ownerOnlyStands,
  paidAfter,
  paidBefore,
  paymentsRead,
  scanStart,
  standingOf,
  stillWatched,
  unreadRecords,
  verdictMeaning,
  walletBlock,
  type HandoffFlow,
  type HandoffStanding,
  type ReceiptStep,
} from '../../../lib/arc/handoff-rules'
import { postHandoffReceipt, readFlow, readWaitingFlows, recheckHandoff, scanPaid, type PaidScan, type WaitingRead } from '../../../lib/arc/handoff-send'
import { claimHandoff, clearHandoff, holdsFlow, loadDeclined, loadHandoffs, saveDeclined, saveHandoff, type HandoffSend, type TxRecord } from '../../../lib/arc/pending'
import { addressUrl, localTime, networkName, networkWord, readVault, txUrl, type VaultSnapshot } from '../../../lib/arc/vault-read'
import { aboveSoftWarn, formatUnitsExact, sameAddress } from '../../../lib/arc/vault-rules'
import { STEP_LABEL, failureOf, sendPrepared, TxStop, type PreparedTx } from '../../../lib/arc/vault-write'
import { Button } from '../../ui/button'
import { Chip, CopyButton, Mono } from '../stellar/bits'
import FailureNotice from './FailureNotice'
import PreparedView from './PreparedView'
import TxReceipt from './TxReceipt'
import { recordOf, useArcTx } from './useArcTx'
import type { ArcWalletState } from './useArcWallet'

/** How often a send with no answer looks at the vault's Paid events. */
const SCAN_AGAIN_MS = 15_000
/** How many of this browser's own sends have their flow read back when the page opens. */
const LOCAL_FLOWS_READ = 5
/** How long this tab says "confirm this in your wallet" before it says it has not heard back, since a phone wallet's prompt can simply never answer. */
const WALLET_ANSWER_MS = 120_000
/** A tab coming back reads the vault and the flows again, and a wallet's popup closing should not make it read twice. */
const FOCUS_READ_EVERY_MS = 15_000

type Props = {
  chain: Chain
  vault: VaultSnapshot
  wallet: ArcWalletState
  /** False on a vault this page builds no calls for. Then it reads and offers nothing, whoever is connected. */
  canAct: boolean
  /** Why not, when it cannot. */
  whyNot?: string
  /** The vault or its owner is a key of ours, so the page does not say we hold none. */
  oursKey: boolean
  /** The flow a link named. */
  flowParam: string | null
  /** Something else from this page is on its way, so nothing new is signed. */
  held: boolean
  /** Our own send is on its way: the rest of the page waits for it too. */
  onHoldChange: (held: boolean) => void
  /** Something landed: the vault's values are out of date. */
  onLanded: () => void
}

const FLOW_ID = /^0x[0-9a-fA-F]{64}$/

export default function OwnerApprovals({ chain, vault: pageVault, wallet, canAct, whyNot, oursKey, flowParam, held, onHoldChange, onLanded }: Props) {
  const network = chain.caip2
  // The newest read of the vault there is, the page's or one from here. A tab left open reads old otherwise.
  const [readHere, setReadHere] = useState<VaultSnapshot | null>(null)
  const vault = readHere && readHere.block > pageVault.block ? readHere : pageVault
  const address = pageVault.address
  const direct = flowParam && FLOW_ID.test(flowParam) ? flowParam.toLowerCase() : null
  const [list, setList] = useState<WaitingRead | null>(null)
  const [named, setNamed] = useState<{ flow: HandoffFlow | null; failed: string | null } | null>(null)
  const [own, setOwn] = useState<Record<string, HandoffFlow>>({})
  const [reading, setReading] = useState(false)
  const [records, setRecords] = useState<HandoffSend[]>(() => loadHandoffs(network, address))
  const [declined, setDeclined] = useState<string[]>(() => loadDeclined(network, address))
  const [scan, setScan] = useState<PaidScan | null>(null)
  const [scanFailed, setScanFailed] = useState<string | null>(null)
  const scanRef = useRef<PaidScan | null>(null)
  scanRef.current = scan

  const refreshRecords = useCallback(() => setRecords(loadHandoffs(network, address)), [network, address])

  // A send in another tab is this tab's business: it must stop offering the action at once.
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (!e.key || e.key.startsWith('aid-arc-handoff')) refreshRecords()
    }
    window.addEventListener('storage', on)
    return () => window.removeEventListener('storage', on)
  }, [refreshRecords])

  const load = useCallback(async () => {
    setReading(true)
    const sent = loadHandoffs(network, address)
    setRecords(sent)
    // A send with no answer first: it is the one that must keep being followed.
    const openFirst = [...sent.filter((r) => !r.server), ...sent.filter((r) => r.server)]
    const [waiting, one, mine] = await Promise.all([
      readWaitingFlows(address),
      direct ? readFlow(direct) : Promise.resolve(null),
      Promise.all(openFirst.slice(0, LOCAL_FLOWS_READ).map((r) => readFlow(r.flowId))),
    ])
    setList(waiting)
    setNamed(direct ? { flow: one?.ok ? one.flow : null, failed: one && !one.ok ? one.reason : null } : null)
    setOwn(Object.fromEntries(mine.flatMap((r) => (r.ok ? [[r.flow.flowId, r.flow] as const] : []))))
    setReading(false)
  }, [network, address, direct])

  useEffect(() => {
    void load()
  }, [load])

  // Every flow this page knows about, each once: the one the link named, what waits, what this browser sent.
  const flows = useMemo(() => {
    const byId = new Map<string, HandoffFlow>()
    if (named?.flow) byId.set(named.flow.flowId, named.flow)
    if (list?.ok) for (const f of list.flows) if (!byId.has(f.flowId)) byId.set(f.flowId, f)
    for (const f of Object.values(own)) byId.set(f.flowId, f)
    return [...byId.values()]
  }, [list, named, own])

  // The earliest block anything here needs the vault's payments from: only what can be offered or is still followed.
  const scanFrom = useMemo(() => scanStart(flows.map((f) => ({ f, s: standingOf(f, vault) })), records, declined, Date.now()), [flows, vault, records, declined])

  const unresolved = records.some((r) => {
    if (!stillWatched(r, Date.now())) return false
    const h = holdOf(r)
    return !h.held || h.why === 'asked' || h.why === 'maybe'
  })

  // One read at a time: a read a timer started must not pile up behind one that has a long way to go.
  const scanBusy = useRef(false)
  const scanQueued = useRef(false)
  const readPayments = useCallback(
    async (topUpOnly = false) => {
      if (scanFrom === null) return
      if (scanBusy.current) {
        if (!topUpOnly) scanQueued.current = true
        return
      }
      scanBusy.current = true
      if (!topUpOnly) setScanFailed(null)
      try {
        const got = await scanPaid(chain, address, scanFrom, scanRef.current, { topUpOnly, onProgress: setScan })
        if ('failed' in got) {
          setScanFailed(got.failed)
          return
        }
        setScanFailed(null)
        setScan(got)
        // What the read says about anything this browser sent and has no answer for.
        for (const r of loadHandoffs(network, address)) {
          const f = flows.find((x) => holdsFlow(r, x.flowId))
          if (!f) continue
          const next = afterScan(r, f, got, Date.now())
          if (next !== r) saveHandoff(next)
        }
        refreshRecords()
      } finally {
        scanBusy.current = false
        if (scanQueued.current) {
          scanQueued.current = false
          void readLatest.current()
        }
      }
    },
    [chain, address, network, scanFrom, flows, refreshRecords],
  )
  const readLatest = useRef(readPayments)
  readLatest.current = readPayments

  useEffect(() => {
    void readPayments()
  }, [readPayments])

  useEffect(() => {
    if (!unresolved) return
    const t = setInterval(() => void readPayments(true), SCAN_AGAIN_MS)
    return () => clearInterval(t)
  }, [unresolved, readPayments])

  // A tab somebody comes back to: the balance, the budget, the check's age and the flows, read again.
  const lastFocusRead = useRef(0)
  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastFocusRead.current < FOCUS_READ_EVERY_MS) return
      lastFocusRead.current = Date.now()
      void readVault(chain, address).then((r) => {
        if (r.ok) setReadHere(r.data)
      })
      void load()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [chain, address, load])

  const pendingHere = records.some(holdsPage)
  useEffect(() => {
    onHoldChange(pendingHere)
    return () => onHoldChange(false)
  }, [pendingHere, onHoldChange])

  const landed = useCallback(() => {
    onLanded()
    void load()
    void readPayments()
  }, [onLanded, load, readPayments])

  // Sorted out by what the chain says now, so a key that changed since the record moves a row at once.
  const standing = flows.map((f) => ({ f, s: standingOf(f, vault) }))
  const linked = direct ? standing.find((x) => x.f.flowId === direct) : undefined
  const rest = standing.filter((x) => x.f.flowId !== direct)
  // Something this browser sent is followed to its answer, whatever has happened to the flow since.
  const following = (f: HandoffFlow) => holdOf(records.find((r) => holdsFlow(r, f.flowId))).held
  // A request from the agent, whether or not it can be approved right now.
  const isRequest = ({ s, f }: { s: HandoffStanding; f: HandoffFlow }) =>
    s.kind === 'approvable' || s.kind === 'no_balance' || s.kind === 'record_differs' || s.kind === 'pays_agent' || s.kind === 'no_human' || ((s.kind === 'stale' || s.kind === 'not_from_agent' || s.kind === 'key_stopped') && following(f))
  // Hidden from the link too, or Hide does nothing on the path most owners come by. Something on its way stays.
  const hiddenHere = (x: { s: HandoffStanding; f: HandoffFlow }) => isRequest(x) && declined.includes(x.f.flowId) && !following(x.f)
  const fromLink = linked && !hiddenHere(linked) ? linked : undefined
  const requests = rest.filter(isRequest)
  const aged = rest.filter((x) => x.s.kind === 'stale' && !following(x.f))
  const stopped = rest.filter((x) => x.s.kind === 'key_stopped' && !following(x.f))
  const notAgents = rest.filter((x) => x.s.kind === 'not_from_agent' && !following(x.f))
  const done = rest.filter(({ s, f }) => (s.kind === 'settled' || s.kind === 'reverted') && records.some((r) => holdsFlow(r, f.flowId)))
  const shownRequests = requests.filter((x) => !hiddenHere(x))
  const saidNo = [...(linked && hiddenHere(linked) ? [linked] : []), ...requests.filter(hiddenHere)]
  const others = (list?.ok ? list.others.count : 0) + notAgents.length
  const capped = list?.ok ? list.others.capped : false
  const isOwner = sameAddress(wallet.account, vault.owner)

  const card = (f: HandoffFlow, s: HandoffStanding) => (
    <FlowCard
      key={f.flowId}
      chain={chain}
      vault={vault}
      wallet={wallet}
      flow={f}
      standing={s}
      canAct={canAct}
      held={held}
      records={records}
      scan={scan}
      scanFailed={scanFailed}
      onRecords={refreshRecords}
      onLanded={landed}
      onVaultRead={setReadHere}
      onReadAgain={load}
      onDecline={() => {
        saveDeclined(network, address, f.flowId, true)
        setDeclined(loadDeclined(network, address))
      }}
    />
  )

  // A send whose flow could not be read has nothing to hang off, and it still has to be followed.
  const unread = unreadRecords(records, flows.map((f) => f.flowId), Date.now())
  const nothing = list?.ok && !fromLink && !named?.failed && shownRequests.length === 0 && saidNo.length === 0 && aged.length === 0 && stopped.length === 0 && done.length === 0 && others === 0 && unread.length === 0

  return (
    <section aria-label="Payments waiting" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{isOwner ? 'Payments waiting for you' : "Payments waiting for this vault's owner"}</h3>
        <button type="button" onClick={() => void load()} disabled={reading} className="text-xs font-semibold text-accent underline underline-offset-2 disabled:opacity-50">
          {reading ? 'Reading...' : 'Check again'}
        </button>
      </div>
      <p className="mt-1 text-xs text-foreground/65">
        When your agent's check does not clear a payment for it to make itself, the payment waits here for you to decide. This page sends nothing without your own wallet. One marked as
        only you can pay is one your agent's key cannot send, and one within its limits is one its key could still send by itself.{oursKey ? '' : ' A-Identity holds no key and signs nothing.'}
      </p>
      {!canAct && whyNot && <p className="mt-2 text-xs text-foreground/75">{whyNot}</p>}

      <div className="mt-3 space-y-3">
        {list && !list.ok && (
          <FailureNotice
            failure={{ code: 'handoff_unreadable', message: list.reason }}
            next={list.rateLimited ? 'This says nothing about your vault. Wait a minute, then press Check again.' : 'This says nothing about your vault, and nothing was sent. Press Check again in a moment.'}
          />
        )}
        {direct === null && flowParam && (
          <p role="alert" className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2 text-sm text-foreground">
            The link names a payment, and what it names is not a payment id. Nothing here comes from it.
          </p>
        )}
        {direct && named?.failed && (
          <p role="alert" className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-foreground">
            The payment this link names could not be read: {named.failed} Nothing is offered from it.
          </p>
        )}
        {fromLink && card(fromLink.f, fromLink.s)}
        {shownRequests.map(({ f, s }) => card(f, s))}
        {done.map(({ f, s }) => card(f, s))}
        {unread.map((r) => (
          <div key={r.flowId} className="rounded-xl border border-border bg-background/60 p-4">
            <h4 className="text-sm font-semibold text-foreground">What this browser sent, for a payment whose record could not be read just now</h4>
            <SendTracker record={r} chain={chain} onRecords={refreshRecords} onLanded={landed} />
          </div>
        ))}
        {nothing && <p className="text-sm text-foreground/70">Nothing is waiting for this vault's owner right now.</p>}
        {list?.ok && list.unreadable > 0 && <p className="text-xs text-foreground/70">{list.unreadable} more could not be read, so nothing is offered for them.</p>}
        {list?.ok && list.truncated && <p className="text-xs text-foreground/70">Only the newest are listed here. If your agent has more waiting, deal with these first.</p>}
        {stopped.length > 0 && (
          <p className="text-xs text-foreground/70">
            {stopped.length} {stopped.length === 1 ? 'request came' : 'requests came'} from an agent key that has since been revoked or run out, so {stopped.length === 1 ? 'it is' : 'they are'} not offered. If one still needs paying, give your agent a working key and ask it for a new check.
          </p>
        )}
        {aged.length > 0 && (
          <p className="text-xs text-foreground/70">
            {aged.length} older {aged.length === 1 ? 'one was' : 'ones were'} checked more than 24 hours ago, so {aged.length === 1 ? 'it is' : 'they are'} not offered. If one still needs paying, ask your agent to check the payee
            again.
          </p>
        )}
        {saidNo.length > 0 && (
          <p className="text-xs text-foreground/70">
            You said no to {saidNo.length} in this browser. That is only hidden here: nothing was recorded, your agent was not told, and the public record still reads as waiting.{' '}
            <button
              type="button"
              className="font-semibold text-accent underline underline-offset-2"
              onClick={() => {
                for (const { f } of saidNo) saveDeclined(network, address, f.flowId, false)
                setDeclined(loadDeclined(network, address))
              }}
            >
              Show {saidNo.length === 1 ? 'it' : 'them'} again
            </button>
          </p>
        )}
        {others > 0 && (
          <p className="rounded-xl border border-border bg-background/60 px-3 py-2 text-xs text-foreground/75">
            {capped ? 'Many' : others} other {others === 1 ? 'check names' : 'checks name'} this vault, paid for by a key that is not your agent's key now. Anyone can buy a check that names any vault, so this page cannot show {others === 1 ? 'it' : 'they'} came from your agent, and nothing about{' '}
            {others === 1 ? 'it' : 'them'} is listed. If someone you do not know sends you a link to one, do not act on it.
          </p>
        )}
      </div>
    </section>
  )
}

/** A label and what it labels. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  )
}

type CardProps = {
  chain: Chain
  vault: VaultSnapshot
  wallet: ArcWalletState
  flow: HandoffFlow
  standing: HandoffStanding
  canAct: boolean
  held: boolean
  records: HandoffSend[]
  scan: PaidScan | null
  scanFailed: string | null
  onRecords: () => void
  onLanded: () => void
  /** A read of the vault from here: the card's figures come from the newest there is. */
  onVaultRead: (v: VaultSnapshot) => void
  /** Read the flows again, because the record said something other than what is on screen. */
  onReadAgain: () => void
  onDecline: () => void
}

function FlowCard(props: CardProps) {
  const { chain, vault, flow, standing, records } = props
  const record = records.find((r) => holdsFlow(r, flow.flowId)) ?? null

  // Whatever the flow says now, what this browser sent is followed until it has its answer.
  if (holdOf(record).held && standing.kind !== 'settled' && standing.kind !== 'reverted') return <RequestCard {...props} record={record} />
  if (standing.kind === 'not_from_agent')
    return (
      <div role="alert" data-flow={flow.flowId} className="rounded-xl border border-danger/30 bg-danger/[0.08] p-4 text-sm text-foreground">
        <div className="flex items-start gap-2">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-semibold">This page cannot show this came from your agent.</div>
            <p className="mt-1 break-words text-foreground/85">{notFromAgentLine(standing)}</p>
          </div>
        </div>
      </div>
    )
  if (standing.kind === 'key_stopped')
    return (
      <div role="alert" data-flow={flow.flowId} className="rounded-xl border border-danger/30 bg-danger/[0.08] p-4 text-sm text-foreground">
        <div className="flex items-start gap-2">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-semibold">This came from a key that has since been stopped.</div>
            <p className="mt-1 break-words text-foreground/85">{keyStoppedLine(standing)}</p>
          </div>
        </div>
      </div>
    )
  if (standing.kind === 'not_this_vault' || standing.kind === 'refused' || standing.kind === 'not_the_owners')
    return (
      <div role="status" data-flow={flow.flowId} className="rounded-xl border border-warn/30 bg-warn/10 p-4 text-sm text-foreground">
        <div className="font-semibold">Nothing to approve here.</div>
        <p className="mt-1 break-words text-foreground/85">{standing.why}</p>
      </div>
    )
  if (standing.kind === 'settled') return <SettledCard chain={chain} vault={vault} flow={flow} />
  if (standing.kind === 'reverted')
    return (
      <div role="status" data-flow={flow.flowId} className="rounded-xl border border-danger/25 bg-danger/[0.07] p-4 text-sm text-foreground">
        <div className="font-semibold">This payment was sent and reverted. Nothing moved.</div>
        <p className="mt-1 break-words text-foreground/85">
          {standing.why ? `What made it revert: ${standing.why}. ` : ''}The network fee was still charged, and this request is over. If you still mean to pay, ask your agent to check the payee again.
        </p>
        <TxLink chain={chain} hash={flow.payment?.txHash ?? null} />
      </div>
    )
  return <RequestCard {...props} record={record} />
}

function TxLink({ chain, hash }: { chain: Chain; hash: string | null }) {
  if (!hash) return null
  const href = txUrl(chain, hash)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <Mono>{hash}</Mono>
      <CopyButton text={hash} label="Copy hash" />
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
          View on the explorer <ExternalLink size={11} aria-hidden="true" />
        </a>
      )}
    </div>
  )
}

function SettledCard({ chain, vault, flow }: { chain: Chain; vault: VaultSnapshot; flow: HandoffFlow }) {
  return (
    <div role="status" data-flow={flow.flowId} className="rounded-xl border border-ok/30 bg-ok/[0.07] p-4 text-sm text-foreground">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
        <div className="min-w-0">
          <div className="font-semibold">Paid. Our server read this payment from the chain itself.</div>
          <p className="mt-1 break-all text-foreground/85">
            The vault paid {formatUnitsExact(flow.amount, vault.decimals)} USDC to {flow.payee} in block {flow.payment?.blockNumber}.
          </p>
          <TxLink chain={chain} hash={flow.payment?.txHash ?? null} />
        </div>
      </div>
    </div>
  )
}

/** What Review showed the person, with the call it came to: what Confirm is held to. */
type Reviewed = { tx: PreparedTx; payee: string; amount: bigint; data: string }

function RequestCard({ chain, vault, wallet, flow, standing, canAct, held, records, scan, scanFailed, onRecords, onLanded, onVaultRead, onReadAgain, onDecline, record }: CardProps & { record: HandoffSend | null }) {
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [saying, setSaying] = useState(false)
  const { busy, step, failure, setFailure, run, release } = useArcTx()
  const scanNow = useRef<PaidScan | null>(null)
  scanNow.current = scan
  // A review of something the record no longer says is gone at once: the row above it now reads otherwise.
  const reviewStands = reviewed !== null && sameAddress(reviewed.payee, flow.payee) && reviewed.amount === flow.amount && flow.prepared?.data.toLowerCase() === reviewed.data
  useEffect(() => {
    if (reviewed === null || reviewStands) return
    setReviewed(null)
    setFailure({ code: 'handoff_changed', message: 'The record of this payment changed after you reviewed it, so that review is gone. Look over what it says now.' })
  }, [reviewed, reviewStands, setFailure])

  const age = flow.checkedAtSec !== null && vault.chainTime > flow.checkedAtSec ? vault.chainTime - flow.checkedAtSec : 0n
  const payeeUrl = addressUrl(chain, flow.payee)
  const hold = holdFor(flow, records)
  const sentHere = holdOf(record).held
  const paid = scan && flow.verdictBlock !== null ? paidAfter(flow, scan.paid) : null
  const blocked = walletBlock(wallet, vault, chain.chainId)
  const read = paymentsRead(flow, scan, scanFailed)
  const checked = read === 'ok' || read === 'no_lookback'
  const offer = canAct && standing.kind === 'approvable' && !hold.held && !paid
  const ready = offer && blocked === null && checked && !held
  const earlier = scan && checked ? paidBefore(flow, scan.paid) : null
  const big = aboveSoftWarn(flow.amount, vault.decimals)
  const onlyLine = ownerOnlyLine(flow.ownerOnly, flow.amount, vault)
  const account = { account: wallet.account, chainId: wallet.chainId }
  const { heading, asks } = cardHeading(standing, { sent: record !== null && sentHere, held: hold.held, paid: paid !== null })
  // This tab is the one waiting on the wallet right now: its prompt may be open, unsigned.
  const asking = busy === 'confirm'
  const waitingOnWallet = asking && record !== null && !record.tx

  useEffect(() => {
    if (!waitingOnWallet) return
    const t = setTimeout(() => release('confirm'), WALLET_ANSWER_MS)
    return () => clearTimeout(t)
  }, [waitingOnWallet, release])

  // A payment went out after this check, and it was the owner's: the receipt can close the flow. The route
  // only records what the chain proves, so posting it costs nothing and needs no person.
  const closedBy = useRef<string | null>(null)
  useEffect(() => {
    if (sentHere || !paid?.byOwner || closedBy.current === paid.txHash) return
    closedBy.current = paid.txHash
    void postHandoffReceipt(flow.flowId, paid.txHash).then((s) => {
      if (s.step === 'settled') onLanded()
    })
  }, [sentHere, paid, flow.flowId, onLanded])

  const review = () => {
    setFailure(null)
    void run('review', async (onStep) => {
      onStep('simulating')
      const r = await recheckHandoff(chain, vault.address, flow.flowId, account, { shown: { payee: flow.payee, amount: flow.amount }, scan: scanNow.current }).catch((e: unknown) => {
        if (failureOf(e).code === 'handoff_changed') onReadAgain()
        throw e
      })
      onVaultRead(r.live)
      setReviewed({ tx: r.prepared, payee: r.flow.payee, amount: r.flow.amount, data: r.prepared.data.toLowerCase() })
      return r
    })
  }

  const confirm = () => {
    if (!wallet.wallet || !reviewed) return
    const provider = wallet.wallet.provider
    const shown = { payee: reviewed.payee, amount: reviewed.amount, data: reviewed.data }
    void run('confirm', async (onStep) => {
      onStep('simulating')
      // Everything again: the review may be minutes old, and it is what the person read that must still hold.
      const r = await recheckHandoff(chain, vault.address, flow.flowId, account, { shown, scan: scanNow.current }).catch((e: unknown) => {
        if (failureOf(e).code === 'handoff_changed') {
          setReviewed(null)
          onReadAgain()
        }
        throw e
      })
      onVaultRead(r.live)
      const claim: HandoffSend = {
        v: 1,
        network: chain.caip2,
        vault: vault.address,
        flowId: flow.flowId,
        payee: shown.payee,
        amount: shown.amount,
        from: r.prepared.from,
        askedAt: new Date().toISOString(),
        token: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }
      if (!(await claimHandoff(claim, (rs) => holdFor(flow, rs).held))) throw new TxStop({ code: 'handoff_held', message: 'Another tab of this browser has just sent this.' })
      onRecords()
      let asked = false
      let hash: `0x${string}`
      try {
        hash = await sendPrepared(provider, r.prepared, (s) => {
          if (s === 'wallet') asked = true
          onStep(s)
        })
      } catch (e) {
        // Declined, or never asked: nothing was sent. Any other stop may have left the wallet sending it.
        if (!asked || failureOf(e).code === 'rejected') {
          clearHandoff(claim.network, claim.vault, claim.flowId)
          onRecords()
        }
        throw e
      }
      const tx = recordOf(r.prepared, hash, vault.address)
      saveHandoff({ ...claim, tx })
      onRecords()
      setReviewed(null)
      track('arc_vault_owner_action', { network: networkWord(chain), action: 'ownerPay', outcome: 'submitted' })
      return hash
    })
  }

  const working = busy ? `${step ? STEP_LABEL[step] : 'Working'}...` : null

  return (
    <article aria-label="A payment waiting for approval" data-flow={flow.flowId} className="rounded-xl border border-border bg-background/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">{heading}</h4>
        <Chip tone={flow.verdict?.effective === 'ALLOW' ? 'ok' : 'warn'}>{flow.verdict?.effective ?? 'No verdict'}</Chip>
        {!chain.testnet && <Chip tone="warn">{networkName(chain)}: real USDC</Chip>}
      </div>

      <dl className="mt-3 grid gap-3">
        <Row label="Who gets paid">
          <span className="break-all font-mono text-xs">{flow.payee}</span>{' '}
          <CopyButton text={flow.payee} label="Copy address" />{' '}
          {payeeUrl && (
            <a href={payeeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
              See this address on the explorer <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </Row>
        <Row label="How much">
          <span className="font-semibold">{formatUnitsExact(flow.amount, vault.decimals)} USDC</span>
          <span className="text-xs text-foreground/65">, from the vault, not from your wallet. The vault holds {formatUnitsExact(vault.balance, vault.decimals)} USDC. Your wallet pays the network fee.</span>
        </Row>
        <Row label="What the check said">
          <p className="text-sm">{verdictMeaning(flow.verdict?.effective ?? null, flow.verdict?.reasons ?? [])}</p>
          {flow.verdict && flow.verdict.reasons.length > 0 && (
            <>
              <p className="mt-1 text-xs text-foreground/65">Its reasons, as our server gave them:</p>
              <ul className="mt-1 list-disc space-y-0.5 break-words pl-4 text-xs text-foreground/85">
                {flow.verdict.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </Row>
        <Row label="When it was checked">
          {flow.checkedAtSec !== null ? `${agePhrase(age)} ago, at ${localTime(flow.checkedAt)} your time. ` : 'The record gives no time we can read. '}
          {asks && <span className="text-xs text-foreground/65">It can be approved for 24 hours after the check.</span>}
        </Row>
        <Row label="Who asked">
          <span className="text-xs text-foreground/85">
            {sameAddress(flow.payer, vault.operator) ? (
              <>
                Your agent's key <span className="break-all font-mono">{flow.payer}</span> paid for this check
                {vault.expired ? ", and that key has since been revoked or has run out." : ", and it is this vault's agent key now. If that key has been stolen, whoever holds it could ask you for anything, so check this is a payment you expect."}
              </>
            ) : (
              <>
                The key <span className="break-all font-mono">{flow.payer}</span> paid for this check, and it is not this vault's agent key now.
              </>
            )}
          </span>
        </Row>
      </dl>

      {asks && (
        <div className="mt-3 space-y-2 text-xs text-foreground/85">
          {onlyLine && <p className="rounded-lg border border-border bg-card px-3 py-2">{onlyLine}</p>}
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2">{budgetLine(flow.amount, vault)}</p>
          {vault.frozen && <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2">{FROZEN_LINE}</p>}
          {big && <p className="font-semibold text-warn">This is more than 10 USDC. Check the address character by character.</p>}
        </div>
      )}

      {standing.kind === 'stale' && (
        <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          This check is {standing.ageSeconds === null ? 'of an unknown age' : `${agePhrase(standing.ageSeconds)} old`}, and it is offered for 24 hours. An answer that old may no longer be right, so it cannot be approved. If this still needs paying, ask your agent to check the payee again,
          which costs it 0.005 USDC.
        </p>
      )}
      {standing.kind === 'no_balance' && (
        <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          The vault holds {formatUnitsExact(standing.have, vault.decimals)} USDC, less than this pays. It cannot be approved until the vault holds enough.
        </p>
      )}
      {standing.kind === 'record_differs' && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          This cannot be approved, because what this record says does not match: {standing.what}.
        </p>
      )}
      {standing.kind === 'no_human' && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          This cannot be approved here: this vault's owner and agent are one key, so there is no person behind an approval to tell apart from the agent.
        </p>
      )}
      {standing.kind === 'pays_agent' && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          This cannot be approved: it pays your agent's own key. If your agent needs USDC for network fees, use Withdraw below and check the address yourself.
        </p>
      )}

      {waitingOnWallet && (
        <p role="status" className="mt-3 inline-flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs font-semibold text-foreground">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          {step === 'wallet' ? 'Confirm this in your wallet now. If your wallet is an app on your phone, open it there: the request is waiting for you.' : `${step ? STEP_LABEL[step] : 'Working'}...`}
        </p>
      )}
      {record && <SendTracker record={record} chain={chain} asking={asking} onRecords={onRecords} onLanded={onLanded} />}
      {hold.held && !record && (
        <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          This browser has already sent a payment of this amount to this payee, for another request, and has no final answer for it yet. This is not offered until it has one: two sends pay twice.
        </p>
      )}

      {paid && !sentHere && (
        <div role="status" className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">A payment of this amount to this payee already left this vault after this check.</div>
          <p className="mt-1">{paid.byOwner ? 'It came from the owner key.' : "It came from your agent's key."} It is not offered again. If you really mean to pay it twice, ask your agent for a new check.</p>
          <TxLink chain={chain} hash={paid.txHash} />
        </div>
      )}

      {canAct && offer && read === 'reading' && (
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-foreground/70">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Reading the vault's recent payments, so this cannot be paid twice...
        </p>
      )}
      {canAct && offer && read === 'failed' && (
        <div className="mt-3">
          <FailureNotice failure={{ code: 'handoff_unreadable', message: `This page reads the vault's recent payments before it offers this, and that read did not finish: ${scanFailed ?? scan?.short ?? 'it stopped short'}.` }} />
        </div>
      )}
      {offer && earlier && (
        <div role="status" className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">This vault paid this same amount to this payee in the {PAID_LOOKBACK_WORDS} before this check.</div>
          <p className="mt-1">{earlier.byOwner ? 'It came from the owner key.' : "It came from your agent's key."} If this is the same invoice, approving pays it a second time.</p>
          <TxLink chain={chain} hash={earlier.txHash} />
        </div>
      )}
      {offer && read === 'no_lookback' && (
        <p className="mt-3 text-xs text-foreground/70">This page could not read the {PAID_LOOKBACK_WORDS} before this check, so it cannot say whether the vault already paid this then.</p>
      )}
      {offer && blocked === 'connect' && <p className="mt-3 text-xs text-foreground/70">Connect the wallet that owns this vault, at the top of this page, to approve this.</p>}
      {offer && blocked === 'not_owner' && (
        <p className="mt-3 text-xs text-foreground/70">
          Your connected account is not this vault's owner, so this cannot be approved from it. The owner is <span className="break-all font-mono">{vault.owner}</span>.
        </p>
      )}
      {offer && blocked === 'wrong_chain' && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-foreground/80">
          Your wallet is on another network.
          <Button size="sm" onClick={() => void wallet.switchTo(chain)} disabled={wallet.busy}>
            Switch to {networkName(chain)}
          </Button>
          {wallet.error && (
            <p role="alert" className="w-full font-semibold text-danger">
              {wallet.error}
            </p>
          )}
        </div>
      )}
      {offer && held && <p className="mt-3 text-xs text-foreground/70">Another transaction from this page is still pending. This comes back once that one lands, so nothing is signed twice.</p>}

      {reviewed && reviewStands && ready ? (
        <div className="mt-3 space-y-3">
          <PreparedView p={reviewed.tx} decimals={vault.decimals} title="Review: what your wallet will be asked to send" />
          <p className="text-xs text-foreground/70">
            When you press Confirm, this page reads the payee, the amount, the vault's owner, agent key and balance again, looks for a payment made since the check, and tries the call again. If any of that no longer holds, nothing is sent. The network fee can move a little in that time, and your wallet shows the one it will charge.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={confirm} disabled={busy !== null}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {working ?? 'Confirm in wallet'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setReviewed(null)} disabled={busy !== null}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        ready && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={review} disabled={busy !== null}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {working ?? 'Review this payment'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSaying(true)} disabled={busy !== null}>
              Say no
            </Button>
          </div>
        )
      )}

      {saying && (
        <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground/85">
          <p>
            Nothing is sent, and nothing records your answer: this page has nowhere to write a no. The request stays open on its public record, your agent is not told, and it can ask you again. This only hides it in this browser. It stops being offered on its own 24 hours after the check.
          </p>
          <p className="mt-1">
            Saying no does not stop your agent. If you do not trust it, use Revoke below, which also stops this page offering what that key already asked. Freeze stops the agent paying, and what it already asked stays here.
            {ownerOnlyStands(flow.ownerOnly, flow.amount, vault) ? '' : ' A payment within its limits is one its key could send by itself.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onDecline}>
              Hide it in this browser
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSaying(false)}>
              Keep it here
            </Button>
          </div>
        </div>
      )}

      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} />
        </div>
      )}
    </article>
  )
}

/**
 * What was sent for a flow, until the server gave its final word on it: the receipt while the chain has
 * no answer, then the post, retried for as long as the server does not decide anything.
 */
function SendTracker({ record, chain, asking = false, onRecords, onLanded }: { record: HandoffSend; chain: Chain; asking?: boolean; onRecords: () => void; onLanded: () => void }) {
  const [waitingOn, setWaitingOn] = useState<string | null>(null)
  const hash = hashToPost(record)
  const latest = useRef(record)
  latest.current = record
  const told = useRef({ onRecords, onLanded })
  told.current = { onRecords, onLanded }

  useEffect(() => {
    if (!hash) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const answer = (server: NonNullable<HandoffSend['server']>) => {
      saveHandoff({ ...latest.current, server })
      told.current.onRecords()
      told.current.onLanded()
    }
    const at = () => new Date().toISOString()
    const decide = (s: ReceiptStep, flowId: string): boolean => {
      if (s.step === 'settled') answer({ state: flowId === latest.current.flowId ? 'settled' : 'moved', txHash: hash, flowId, at: at() })
      else if (s.step === 'ended') answer({ state: 'ended', txHash: hash, flowId, ...(s.reason ? { reason: s.reason } : {}), at: at() })
      else if (s.step === 'refused') answer({ state: 'refused', txHash: hash, flowId, code: s.code, reason: s.reason, at: at() })
      else return false
      return true
    }
    const post = async () => {
      let flowId = latest.current.flowId
      let s = await postHandoffReceipt(flowId, hash)
      // The server says which check a payment answers. That is its call, and it is asked once more there.
      if (s.step === 'moved') {
        flowId = s.flowId
        s = await postHandoffReceipt(flowId, hash)
      }
      if (!alive) return
      if (decide(s, flowId)) return
      setWaitingOn(s.step === 'retry' ? s.reason : 'The server named another check, and that one has not answered yet.')
      timer = setTimeout(() => void post(), s.step === 'retry' ? s.waitMs : 5000)
    }
    void post()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [hash])

  const update = (tx: TxRecord) => {
    saveHandoff({ ...latest.current, tx })
    onRecords()
  }
  const h = holdOf(record)
  const server = record.server
  const release = () => {
    saveHandoff({ ...latest.current, released: true, releasedAt: new Date().toISOString() })
    onRecords()
  }

  return (
    <div className="mt-3 space-y-2">
      {record.tx && !server && <TxReceipt record={record.tx} onUpdate={update} onSettled={() => onLanded()} serverJudges />}
      {!asking && !record.tx && !record.paidBy && !record.released && !server && (
        <div role="status" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">Your wallet was asked to send this, and this page has not heard back.</div>
          <p className="mt-1">If a prompt is still open in your wallet, you can answer it there. If your wallet sent it, this page sees the payment land and carries on. Do not start another one from here.</p>
          <button type="button" onClick={release} className="mt-1 font-semibold text-accent underline underline-offset-2">
            I checked: my wallet shows nothing was sent
          </button>
        </div>
      )}
      {record.paidBy && !server && (
        <div role="status" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">This payment landed under another transaction, most likely your wallet's speed-up. It is not settled until our server reads it.</div>
          <TxLink chain={chain} hash={record.paidBy} />
        </div>
      )}
      {h.held && h.why === 'maybe' && !record.paidBy && (
        <div role="status" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">This may still land, so it is not offered again.</div>
          <p className="mt-1">This page keeps looking for the payment in the vault's activity. Look in your wallet's activity list. If it is still waiting there, or your wallet sent a replacement, it can still pay, and a second send would pay twice.</p>
          <button type="button" onClick={release} className="mt-1 font-semibold text-accent underline underline-offset-2">
            I checked: it is dropped or cancelled in my wallet, and it will not land
          </button>
        </div>
      )}
      {!h.held && record.tx?.outcome === 'replaced' && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
          Your wallet replaced what this page sent, and no payment came of it: the vault's activity shows none. It can be approved again.
        </p>
      )}
      {hash && waitingOn && !server && (
        <p role="status" className="inline-flex items-center gap-2 text-xs text-foreground/75">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> This has landed, and it is not settled until our server reads it. It has not answered yet ({waitingOn}). This page keeps asking, and you do not need to sign anything.
        </p>
      )}
      {server?.state === 'settled' && (
        <div role="status" className="rounded-lg border border-ok/30 bg-ok/[0.07] px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">Paid. Our server read this payment from the chain itself.</div>
          <TxLink chain={chain} hash={server.txHash} />
        </div>
      )}
      {server?.state === 'ended' && (
        <div role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">This payment was sent and reverted. Nothing moved, and the network fee was still charged.</div>
          <p className="mt-1 break-words">
            {server.reason ? `${server.reason}. ` : ''}This request is over. If you still mean to pay, ask your agent to check the payee again.
          </p>
          <TxLink chain={chain} hash={server.txHash} />
        </div>
      )}
      {server?.state === 'moved' && (
        <div role="status" className="rounded-lg border border-ok/30 bg-ok/[0.07] px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">Paid, and recorded on a newer check of the same payee and amount.</div>
          <p className="mt-1 break-all">A vault payment does not name its check, so the server links it to the latest one before it. That is {server.flowId}, which our server read from the chain. This request stays open on its public record, and it is not offered again.</p>
          <TxLink chain={chain} hash={server.txHash} />
        </div>
      )}
      {server?.state === 'refused' && (
        <div role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          <div className="font-semibold">Our server read this transaction, and it does not prove this payment, so nothing is marked as settled.</div>
          <p className="mt-1 break-words">{server.reason}</p>
          <p className="mt-1">It is not offered again. Look at the transaction before you do anything else: if it paid someone, a second send would pay twice.</p>
          <TxLink chain={chain} hash={server.txHash} />
        </div>
      )}
      {!h.held && record.released && (
        <p className="inline-flex items-center gap-2 text-xs text-foreground/75">
          <AlertTriangle size={12} className="text-warn" aria-hidden="true" /> You said nothing is on its way from your last try. If that was wrong, a second send pays twice.
        </p>
      )}
    </div>
  )
}
