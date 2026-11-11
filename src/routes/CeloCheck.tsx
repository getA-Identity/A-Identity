import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, Info, Loader2, Search, XCircle } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import CopyBlock from '../components/app/CopyBlock'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DisplayHeading } from '../components/ui/display'
import Owl, { type Mood } from '../components/check/Owl'
import { payStepLabel, useEvmPayer } from '../components/app/wallet/PayWallet'
import { apiFetch, readJson } from '../lib/api'
import {
  CHECK_TOOL,
  STATUS_PATH,
  addressUrl,
  formatUsd,
  moneyMayBeOut,
  normalizeAgentId,
  purchase,
  readStatus,
  stopText,
  toolPath,
  txUrl,
  type PaidAnswer,
  type RailStatus,
  type Step,
  type Stop,
  type Verdict,
} from '../lib/celo/x402pay'
import { CHAIN_BY_ID } from '../lib/chains'
import { ChainStop } from '../lib/evm-chain'
import { ago, short } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { cn } from '../lib/utils'

/**
 * /check/celo: buy one ALLOW / WARN / DENY check on Celo mainnet from your own EVM wallet.
 * Built for someone we send a link to (a team trying the product from outside), not for a
 * developer: connect, approve one signature for the published price, read the verdict and
 * open the receipt.
 *
 * What the wallet signs and what the page refuses live in lib/celo/x402pay.ts, which the
 * backend suite drives with a fake wallet. This file is the screen: the steps, the honest
 * sentence for each ending, and the receipt. Nothing here holds a key, and nothing is sent
 * before the person approves it in the wallet.
 */

const CELO = CHAIN_BY_ID.celo
const TOOL = CHECK_TOOL
const EXPLORER = CELO.explorer ?? 'https://celoscan.io'
const STATUS_API = `https://a-identity.xyz${STATUS_PATH}`
const TOOL_API = `https://a-identity.xyz${toolPath(TOOL)}`

/** One-click examples under the input. */
const EXAMPLES: { label: string; q: string }[] = [
  { label: 'Our Celo agent #9759', q: '#9759' },
  { label: 'The first agent, #1', q: '#1' },
]

type View =
  | { s: 'idle' }
  | { s: 'wallet' }
  | { s: Step; from: string; wallet: string }
  | { s: 'paid'; agentId: string; answer: PaidAnswer; from: string }
  | { s: 'stopped'; stop: Stop }

const VERDICT: Record<Verdict, { mood: Mood; title: string; text: string; band: string; Icon: typeof Info }> = {
  ALLOW: { mood: 'happy', title: 'Looks safe to pay', text: 'text-ok', band: 'border-ok/30 bg-ok/[0.07]', Icon: CheckCircle2 },
  WARN: { mood: 'cautious', title: 'Be careful', text: 'text-warn', band: 'border-warn/30 bg-warn/[0.07]', Icon: AlertTriangle },
  DENY: { mood: 'alarmed', title: "Don't pay", text: 'text-danger', band: 'border-danger/30 bg-danger/[0.07]', Icon: XCircle },
}

// ---- receipts kept for this tab, so a reload does not lose what was paid for ----

type Receipt = { agentId: string; decision: Verdict | null; tx: string | null; at: string; amountUsd: number | null }
const RECEIPTS_KEY = 'a-identity:check-celo'

function isReceipt(x: unknown): x is Receipt {
  const r = x as Partial<Receipt> | null
  return !!r && typeof r.agentId === 'string' && typeof r.at === 'string' && (r.tx === null || typeof r.tx === 'string')
}

function loadReceipts(): Receipt[] {
  try {
    const raw = window.sessionStorage.getItem(RECEIPTS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter(isReceipt) : []
  } catch {
    return []
  }
}

function saveReceipt(r: Receipt): Receipt[] {
  const list = [r, ...loadReceipts().filter((x) => !(r.tx && x.tx === r.tx))].slice(0, 20)
  try {
    window.sessionStorage.setItem(RECEIPTS_KEY, JSON.stringify(list))
  } catch {
    /* storage can be off; the receipt is still on screen */
  }
  return list
}

// ---- small pieces ----

function TxLink({ tx }: { tx: string }) {
  return (
    <a
      href={txUrl(EXPLORER, tx)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 break-all font-mono font-semibold text-accent hover:underline"
    >
      {short(tx, 6)}
      <ArrowUpRight size={13} className="shrink-0" />
    </a>
  )
}

function AddrLink({ address }: { address: string }) {
  return (
    <a
      href={addressUrl(EXPLORER, address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="font-mono text-foreground underline decoration-foreground/25 underline-offset-2 hover:text-accent hover:decoration-accent/50"
    >
      {short(address, 4)}
    </a>
  )
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border last:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-semibold text-foreground sm:px-6 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={18} className="shrink-0 text-foreground/50 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="px-5 pb-5 sm:px-6">{children}</div>
    </details>
  )
}

/** Where a payment is, once a wallet is known. */
function Progress({ view, price, walletStep, chainName, walletName, onCancel }: { view: View; price: string; walletStep: string; chainName: string; walletName?: string; onCancel: () => void }) {
  let line = ''
  let sub: ReactNode = null
  if (view.s === 'wallet') {
    line = payStepLabel(walletStep as 'idle' | 'choosing' | 'connecting' | 'switching' | 'ready', chainName, walletName)
    sub = 'Your wallet asks you to connect this site and to switch to Celo. Nothing is signed yet.'
  } else if (view.s === 'quoting') {
    line = 'Reading the price from the rail...'
    sub = 'The 402 terms are checked against the registry before your wallet is asked anything.'
  } else if (view.s === 'checking') {
    line = 'Checking the USDC in your wallet...'
  } else if (view.s === 'signing') {
    line = `Approve the ${price} payment in your wallet`
    sub = 'One signature, no gas. The Celo facilitator broadcasts it and pays the fee.'
  } else if (view.s === 'confirming') {
    line = 'Settling on Celo...'
    sub = 'This can take up to half a minute. Keep this page open.'
  }
  const from = view.s === 'quoting' || view.s === 'checking' || view.s === 'signing' || view.s === 'confirming' ? view.from : null
  return (
    <div className="rounded-2xl border border-border bg-background/60 px-4 py-3" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
        <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
        {line}
      </p>
      {(from || sub) && (
        <p className="mt-1 text-xs text-foreground/55">
          {from && (
            <>
              Paying from <span className="font-mono">{short(from, 4)}</span>
              {walletName ? ` in ${walletName}` : ''}.{' '}
            </>
          )}
          {sub}
        </p>
      )}
      {view.s === 'signing' && (
        <button type="button" onClick={onCancel} className="mt-2 text-xs font-semibold text-foreground/70 underline underline-offset-2 hover:text-foreground">
          Cancel
        </button>
      )}
    </div>
  )
}

function StopBox({ stop }: { stop: Stop }) {
  const out = moneyMayBeOut(stop)
  return (
    <div
      role="alert"
      className={cn(
        'break-words rounded-2xl border px-4 py-3 text-sm leading-relaxed [overflow-wrap:anywhere]',
        out ? 'border-warn/35 bg-warn/[0.08] text-foreground' : 'border-border bg-background/60 text-foreground/80',
      )}
    >
      {stopText(stop)}
      {stop.kind === 'paid_unreadable' && stop.tx && (
        <>
          {' '}
          <TxLink tx={stop.tx} />
        </>
      )}
      {stop.kind === 'ambiguous' && (
        <>
          {' '}
          <a href={addressUrl(EXPLORER, stop.payTo)} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">
            Open the payee on Celoscan
          </a>
          .
        </>
      )}
    </div>
  )
}

function Answer({ agentId, answer, from }: { agentId: string; answer: PaidAnswer; from: string }) {
  const v = answer.decision ? VERDICT[answer.decision] : null
  const Icon = v?.Icon ?? Info
  return (
    <section className={cn('rounded-3xl border px-5 py-5 sm:px-7', v ? v.band : 'border-border bg-card')} aria-live="polite">
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground/50">
        Agent {agentId} on Celo, {answer.settledAt ? ago(answer.settledAt) : 'just now'}
      </p>
      <h2 className={cn('mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight', v ? v.text : 'text-foreground')} style={{ fontFamily: 'var(--font-heading)' }}>
        <Icon size={24} className="shrink-0" aria-hidden="true" />
        {v ? v.title : 'No verdict in the answer'}
        {answer.decision && <span className="ml-1 rounded-full border border-current/30 px-2 py-0.5 font-mono text-xs font-semibold">{answer.decision}</span>}
      </h2>
      {answer.reasons.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[15px] leading-snug text-foreground/80">
          {answer.reasons.map((r) => (
            <li key={r} className="flex gap-2">
              <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50" aria-hidden="true" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm leading-relaxed text-foreground/65">
        {answer.celo && 'owner' in answer.celo ? (
          <>
            On Celo's ERC-8004 registry, agent {answer.celo.agentId || agentId} is owned by <AddrLink address={answer.celo.owner} />, read live.
          </>
        ) : answer.celo ? (
          <>Celo's ERC-8004 registry was not read for this id: {answer.celo.reason}.</>
        ) : (
          <>The answer carried no Celo registry read.</>
        )}{' '}
        The identity and reputation behind the verdict are resolved on our home registry; the risk level is{' '}
        <span className="font-semibold text-foreground">{answer.risk ?? 'not stated'}</span>.
      </p>
      <div className="mt-4 rounded-2xl border border-border bg-background/60 px-4 py-3 text-sm text-foreground/75">
        <p className="font-semibold text-foreground">Receipt</p>
        <p className="mt-1">
          Paid {answer.amountUsd != null ? formatUsd(answer.amountUsd) : 'the published price'} in USDC from <AddrLink address={answer.payer ?? from} /> and
          settled by the Celo x402 facilitator.{' '}
          {answer.tx ? (
            <>
              Transaction: <TxLink tx={answer.tx} />.
            </>
          ) : (
            'The facilitator returned no transaction hash for this settlement; the payment is still recorded.'
          )}{' '}
          It is listed on{' '}
          <Link to="/proof/celo" className="font-semibold text-accent hover:underline">
            /proof/celo
          </Link>
          .
        </p>
      </div>
      <details className="mt-3 text-xs text-foreground/55">
        <summary className="cursor-pointer font-semibold hover:text-foreground">Show raw answer</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-xl border border-border bg-background/60 p-3 font-mono text-[11px] leading-snug text-foreground/80">
          {JSON.stringify(answer.raw, null, 2)}
        </pre>
      </details>
    </section>
  )
}

// ---- the page ----

export default function CeloCheck() {
  usePageMeta({
    title: 'Pay a check on Celo: ALLOW, WARN or DENY from your own wallet | A-Identity',
    description:
      'Connect an EVM wallet on Celo mainnet, type an ERC-8004 agent id and buy one risk check in native USDC through x402. One signature, no gas, a verdict with its reasons and a receipt you can open on Celoscan.',
    canonical: 'https://a-identity.xyz/check/celo',
  })

  const [params] = useSearchParams()
  const [input, setInput] = useState(() => (params.get('q') ?? '').trim())
  const [view, setView] = useState<View>({ s: 'idle' })
  const [status, setStatus] = useState<RailStatus | 'down' | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>(() => loadReceipts())
  const payer = useEvmPayer()
  /** Which attempt is current: a wallet that answers after a cancel, or after the visitor left, is ignored. */
  const attempt = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    apiFetch(STATUS_PATH, { retries: 2, timeoutMs: 15_000 })
      .then((res) => readJson(res))
      .then((body) => {
        if (live) setStatus(readStatus(body) ?? 'down')
      })
      .catch(() => {
        if (live) setStatus('down')
      })
    return () => {
      live = false
    }
  }, [])

  const inFlight = view.s === 'wallet' || view.s === 'quoting' || view.s === 'checking' || view.s === 'signing' || view.s === 'confirming'
  // Leaving while the payment is out makes its answer unreadable; the browser asks first.
  useEffect(() => {
    if (view.s !== 'confirming') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [view.s])
  // Unmounting before the payment is sent drops any signature that arrives later.
  useEffect(() => () => void (attempt.current += 1), [])

  const rail = status && status !== 'down' ? status : null
  const priceUsd = rail?.prices[TOOL]
  const price = priceUsd != null ? formatUsd(priceUsd) : '$0.005'

  const start = async (raw: string) => {
    const agentId = normalizeAgentId(raw)
    if (!agentId) {
      inputRef.current?.focus()
      return
    }
    if (inFlight) return
    const mine = ++attempt.current
    const alive = () => mine === attempt.current
    setInput(agentId)
    inputRef.current?.blur()
    setView({ s: 'wallet' })

    let w: Awaited<ReturnType<typeof payer.prepare>>
    try {
      w = await payer.prepare(CELO)
    } catch (e) {
      if (!alive()) return
      const text = e instanceof Error ? e.message : String(e)
      const cancelled = (e instanceof ChainStop && e.kind === 'declined') || /^No wallet chosen/i.test(text) || /declined/i.test(text)
      setView({ s: 'stopped', stop: cancelled ? { kind: 'cancelled' } : { kind: 'wallet', wallet: payer.wallet?.name ?? 'Your wallet', text } })
      return
    }
    if (!alive()) return

    // The rail's status is read again for this payment: its payTo, USDC and price are what the quote is held against.
    let fresh: RailStatus | null = null
    try {
      fresh = readStatus(await readJson(await apiFetch(STATUS_PATH, { retries: 2, timeoutMs: 15_000 })))
    } catch {
      fresh = null
    }
    if (!alive()) return
    if (!fresh) {
      setStatus('down')
      setView({ s: 'stopped', stop: { kind: 'unavailable', reason: 'the Celo rail did not answer' } })
      return
    }
    setStatus(fresh)

    const end = await purchase({
      tool: TOOL,
      agentId,
      status: fresh,
      expectedNetwork: CELO.caip2,
      wallet: { name: w.wallet.name, from: w.from, request: (method, p) => w.provider.request({ method, params: p }) },
      quote: async () => {
        const res = await apiFetch(toolPath(TOOL), { retries: 2, timeoutMs: 15_000 })
        return { status: res.status, body: await readJson(res) }
      },
      post: async (header, body) => {
        const res = await apiFetch(toolPath(TOOL), { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, body, timeoutMs: 90_000 })
        return { status: res.status, body: await readJson(res) }
      },
      randomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
      now: () => Math.floor(Date.now() / 1000),
      step: (s) => {
        if (alive()) setView({ s, from: w.from, wallet: w.wallet.name })
      },
      alive,
    })
    if (end === null || !alive()) return
    if (end.kind === 'stopped') {
      setView({ s: 'stopped', stop: end.stop })
      return
    }
    setView({ s: 'paid', agentId, answer: end.answer, from: w.from })
    setReceipts(
      saveReceipt({
        agentId,
        decision: end.answer.decision,
        tx: end.answer.tx,
        at: end.answer.settledAt ?? new Date().toISOString(),
        amountUsd: end.answer.amountUsd ?? priceUsd ?? null,
      }),
    )
  }

  /** Stop waiting for the wallet. A signature that still arrives is dropped, never sent. */
  const cancel = () => {
    attempt.current += 1
    setView({ s: 'stopped', stop: { kind: 'cancelled' } })
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void start(input)
  }

  const mood: Mood =
    view.s === 'paid' ? (view.answer.decision ? VERDICT[view.answer.decision].mood : 'curious') : view.s === 'stopped' ? (moneyMayBeOut(view.stop) ? 'error' : 'curious') : inFlight ? 'thinking' : 'idle'
  const canPay = !inFlight && status !== 'down' && !rail?.pause

  return (
    <ThemeScope surface="background" className="flex min-h-screen w-full flex-col" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main className="w-full flex-1 px-4 pb-16 pt-6 sm:px-8 sm:pb-24 sm:pt-10">
        <div className="mx-auto w-full max-w-[640px]">
          <nav aria-label="Chain" className="flex justify-center gap-2 text-sm">
            {[
              { to: '/check/robinhood', name: 'Robinhood Chain' },
              { to: '/check/arbitrum', name: 'Arbitrum One' },
              { to: '/check/celo', name: 'Celo' },
            ].map((c) => (
              <Link
                key={c.to}
                to={c.to}
                aria-current={c.to === '/check/celo' ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-3 py-1 font-semibold transition-colors',
                  c.to === '/check/celo' ? 'border-accent/50 bg-accent/10 text-foreground' : 'border-border text-foreground/60 hover:text-foreground',
                )}
              >
                {c.name}
              </Link>
            ))}
          </nav>

          <div className="mt-5 text-center sm:mt-6">
            <DisplayHeading size="section" as="h1">
              Check an agent before you pay on Celo
            </DisplayHeading>
            <p className="mx-auto mt-3 max-w-[48ch] text-[17px] leading-relaxed text-foreground/70 sm:text-lg" style={{ textWrap: 'balance' }}>
              Type an agent id, pay {price} in USDC from your own wallet, and get ALLOW, WARN or DENY with the reasons.
            </p>
            <p className="mx-auto mt-3 max-w-[56ch] text-sm leading-relaxed text-foreground/55">
              Live on Celo mainnet. Your wallet signs one authorization, not a transaction: the Celo x402 facilitator broadcasts it and
              pays the gas. Nothing moves until you approve it in the wallet, and every payment lands on a public receipt page.
            </p>
          </div>

          <div className="mt-6">
            <Owl mood={mood} />
          </div>

          <form onSubmit={onSubmit} className="mt-6 flex gap-2" role="search">
            <div className="relative min-w-0 flex-1">
              <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Agent id"
                placeholder="#9759 or eip155:...:8004/9759"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={200}
                disabled={inFlight}
                className="h-12 rounded-xl pl-10 text-base"
              />
            </div>
            <Button type="submit" shape="rounded" className="h-12 px-5 text-[15px]" disabled={!canPay}>
              Pay {price} and check
            </Button>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
            Try
            {EXAMPLES.map((ex) => (
              <button
                key={ex.q}
                type="button"
                onClick={() => setInput(ex.q)}
                disabled={inFlight}
                className="rounded-full border border-border px-3 py-1 font-semibold text-foreground/70 transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
              >
                {ex.label}
              </button>
            ))}
          </div>

          <p className="mt-3 text-center text-xs text-foreground/50">
            {rail?.pause ? (
              <span className="font-semibold text-warn">
                Settlement is paused on our side: the facilitator refused our last settlement ({rail.pause.reason}). Nothing can be bought until our
                balance there is topped up, and nothing is charged. The rail tries again after{' '}
                {rail.pause.until ? new Date(rail.pause.until).toLocaleTimeString() : 'a while'}.
              </span>
            ) : rail ? (
              <>
                Pays <AddrLink address={rail.payTo} /> through {rail.facilitator.replace(/^https?:\/\//, '')}. Price and payee read live from the rail; the quote is
                refused if either differs.
              </>
            ) : status === 'down' ? (
              'The Celo rail is not answering right now, so nothing can be bought. Nothing was charged.'
            ) : (
              'Reading the rail...'
            )}
          </p>

          <div className="mt-8 space-y-4">
            {inFlight && <Progress view={view} price={price} walletStep={payer.step} chainName={CELO.name} walletName={payer.wallet?.name} onCancel={cancel} />}
            {view.s === 'stopped' && <StopBox stop={view.stop} />}
            {view.s === 'paid' && <Answer agentId={view.agentId} answer={view.answer} from={view.from} />}
          </div>

          {receipts.length > 0 && (
            <section className="mt-8 rounded-2xl border border-border bg-card px-5 py-4 sm:px-6">
              <h2 className="text-sm font-semibold text-foreground">Your receipts in this tab</h2>
              <ul className="mt-2 divide-y divide-border text-sm">
                {receipts.map((r, i) => (
                  <li key={`${r.tx ?? 'no-tx'}-${i}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                    <span className="text-foreground/80">
                      <span className="font-mono">{r.agentId}</span>
                      {r.decision && (
                        <span className={cn('ml-2 font-mono text-xs font-semibold', VERDICT[r.decision].text)}>{r.decision}</span>
                      )}
                    </span>
                    <span className="text-xs text-foreground/55">
                      {r.amountUsd != null ? `${formatUsd(r.amountUsd)}, ` : ''}
                      {ago(r.at)}
                      {r.tx && (
                        <>
                          , <TxLink tx={r.tx} />
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-10 overflow-hidden rounded-2xl border border-border bg-card">
            <Fold title="What happens when you press the button">
              <ol className="list-decimal space-y-2 pl-5 text-[15px] leading-snug text-foreground/80">
                <li>Your browser wallet (Rabby or MetaMask) asks you to connect this site and to switch to Celo. It adds Celo first if it has never seen it.</li>
                <li>The page reads the price and the payee from the rail, and refuses the quote if it names another network, another token, another payee or another price.</li>
                <li>Your wallet asks you to sign one USDC authorization for exactly {price}. No gas: the Celo facilitator broadcasts it and pays the fee.</li>
                <li>You get the verdict with its reasons, the settlement hash on Celoscan, and a line on /proof/celo.</li>
              </ol>
              <p className="mt-4 text-sm leading-relaxed text-foreground/60">
                You need a little USDC on Celo and nothing else. A phone wallet works through WalletConnect when it is configured on this
                deployment; a computer browser with the extension is the simplest way.
              </p>
            </Fold>
            <Fold title="What the wallet signs">
              <p className="text-[15px] leading-relaxed text-foreground/75">
                An EIP-3009 TransferWithAuthorization on Celo's native USDC: from your address, to the rail's payTo, for the quoted amount,
                valid for ten minutes, with a random nonce. The signing domain (name, version, chain id, token address) comes from the 402
                and is checked against our chain registry. A signature is not a transaction: it moves nothing until the facilitator
                broadcasts it, and it cannot be reused.
              </p>
            </Fold>
            <Fold title="For agents">
              <p className="text-[15px] leading-relaxed text-foreground/75">
                The same check is an x402 call. A GET returns the 402 with the terms; a POST with an X-PAYMENT header (base64 of the x402 v2
                exact payload) and a JSON body naming the agentId returns the verdict once the facilitator settles.
              </p>
              <div className="mt-4 space-y-3">
                <CopyBlock title="The terms" subtitle="GET, no key, a 402 in JSON" text={`curl -s ${TOOL_API}`} />
                <CopyBlock title="The rail" subtitle="Where it pays, what it charges" text={`curl -s ${STATUS_API}`} />
                <CopyBlock
                  title="A buyer in one file"
                  subtitle="The script this page is a port of"
                  text={`cd mcp && node --env-file=.env scripts/celo-x402-buyer.mjs --url ${TOOL_API} --agent '#9759'`}
                />
              </div>
            </Fold>
          </div>

          <p className="mt-6 text-center text-sm text-foreground/55">
            Every settlement on this rail, ours labeled as ours, is on{' '}
            <Link to="/proof/celo" className="font-semibold text-accent hover:underline">
              /proof/celo
            </Link>
            . Free checks without a wallet run on{' '}
            <Link to="/check/robinhood" className="font-semibold text-accent hover:underline">
              Robinhood Chain
            </Link>{' '}
            and{' '}
            <Link to="/check/arbitrum" className="font-semibold text-accent hover:underline">
              Arbitrum One
            </Link>
            .
          </p>
        </div>
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}
