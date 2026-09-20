import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, ArrowRightLeft, Loader2, Scale, XCircle } from 'lucide-react'

import { ago, short } from '../../../lib/format'
import { cn } from '../../../lib/utils'
import {
  ONE_UNIT,
  contractUrl,
  formatBaseUnits,
  quoteDirection,
  quoteRate,
  soroswapChain,
  toBaseUnits,
  type SoroswapDirection,
  type SoroswapIntegration,
  type SoroswapPair,
  type SoroswapQuote,
} from '../../../lib/stellar/soroswap'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { DataRow } from '../../ui/data-row'
import { Panel } from '../../ui/panel'

/**
 * Soroswap: what converting would cost, and nothing else.
 *
 * WHY THE PANEL EXISTS. An agent's spend vault holds USDC. If it is holding XLM instead it
 * cannot pay a USDC invoice, and the honest first move is to say what converting would
 * cost rather than to convert. Hits GET /api/stellar/soroswap/quote, which simulates
 * Soroswap's router live.
 *
 * WHY IT IS NOT A SWAP WIDGET. A-Identity does not swap. The vault has no swap entrypoint
 * and no upgrade path, so growing one would mean a new wasm and a new vault. The backend
 * returns that as `integration.executes: false` with a `whyNot`, and this panel renders it
 * as a statement in its own box above the controls, before anyone touches the input. There
 * is deliberately no disabled "Swap" button here: a greyed-out action reads as a feature
 * that is temporarily broken, and this one is not built and is not planned.
 *
 * TWO LABELS, NOT ONE. The read is LIVE (the router answered now) and the answer is a
 * QUOTE (no route is held, nothing is bound to the price). Both badges come off the
 * payload's own `status` and `kind` rather than being asserted here, so the screen cannot
 * claim a freshness the backend did not.
 *
 * EVERY CAVEAT, VERBATIM. The API returns four on testnet and the list is rendered whole,
 * in the API's order, in a warn box the eye lands on. The one that matters most is that a
 * testnet pool holds faucet money, so the rate is not a market rate; a client that is free
 * to trim that list is a client that will eventually trim exactly that line.
 *
 * `DataRow` carries the contract rows because each is a completed live read with a link to
 * check it, which is what that component means. The RATE deliberately does not use it: a
 * receipt tick next to a price would read as a settlement, and nothing here settles.
 */

const DIRECTIONS: { id: SoroswapDirection; label: (native: string, settlement: string) => string }[] = [
  { id: 'native-to-settlement', label: (n, s) => `${n} to ${s}` },
  { id: 'settlement-to-native', label: (n, s) => `${s} to ${n}` },
]

export default function SoroswapPanel() {
  const [direction, setDirection] = useState<SoroswapDirection>('native-to-settlement')
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(true)
  const [quote, setQuote] = useState<SoroswapQuote | null>(null)
  const [pair, setPair] = useState<SoroswapPair | null>(null)
  const [error, setError] = useState<string | null>(null)
  /* Held apart from the quote, and never cleared once the API has stated it. The backend
     returns it on BOTH branches because it is a fact about us, not about the pool, so the
     "we do not execute this" box must not blink out of existence while a request is in
     flight or when a pair comes back unavailable. */
  const [integration, setIntegration] = useState<SoroswapIntegration | null>(null)

  /* A quote is a free, public, read-only GET, so the panel answers its own question on
     open rather than making you press a button to see anything. It is code-split behind
     the Rails tab, so this fires only once that tab is opened. */
  useEffect(() => {
    let alive = true
    quoteDirection({ direction: 'native-to-settlement', sellAmount: ONE_UNIT })
      .then((out) => {
        if (!alive) return
        setQuote(out.quote)
        setPair(out.pair)
        if (out.quote.integration) setIntegration(out.quote.integration)
      })
      .catch(() => {
        if (alive) setError('Could not read the Soroswap router (the backend may be waking up, try again).')
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const run = async (dir: SoroswapDirection, whole: string) => {
    const sellAmount = toBaseUnits(whole)
    if (!sellAmount) {
      setQuote(null)
      setError('Enter an amount above zero, to at most 7 decimal places (the Stellar scale).')
      return
    }
    setBusy(true)
    setError(null)
    setQuote(null)
    try {
      const out = await quoteDirection({ direction: dir, sellAmount, pair })
      setQuote(out.quote)
      setPair(out.pair)
      if (out.quote.integration) setIntegration(out.quote.integration)
    } catch {
      setError('Could not read the Soroswap router (the backend may be waking up, try again).')
    } finally {
      setBusy(false)
    }
  }

  const chain = soroswapChain(quote?.available ? quote.network : null)
  const native = chain.nativeCurrency.symbol
  const settlement = chain.settlementSymbol ?? chain.stablecoins[0] ?? 'USDC'
  const forward = direction === 'native-to-settlement'
  /* What the input is about to ask for. */
  const sellSymbol = forward ? native : settlement
  /* What the answer on screen actually priced, read off the assets the server echoed back
     rather than off the toggle. The two cannot drift today, because changing the toggle
     re-quotes, but a rate labelled with the wrong symbol would be a lie rather than a
     glitch, so the label follows the payload. */
  const quoteSellsNative = quote?.available && pair ? quote.sell.asset === pair.native : forward
  const quoteSellSymbol = quoteSellsNative ? native : settlement
  const quoteBuySymbol = quoteSellsNative ? settlement : native

  return (
    <Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <Scale size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Soroswap price check ({chain.shortName})</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            An agent whose vault holds {native} cannot pay a {settlement} invoice. This asks Soroswap's
            router, live, what converting would cost, so the answer is a <b>price, not a route</b>.
          </p>
        </div>
      </div>

      {/* Live AND a quote. Both words come off the payload, so this strip cannot claim a
          freshness or a finality the backend did not put in the answer. */}
      {quote?.available && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="success">
            <Activity size={11} /> {quote.status} read
          </Badge>
          <Badge variant="warning">
            <AlertTriangle size={11} /> {quote.kind} only, nothing reserved
          </Badge>
          <span className="text-[11px] text-foreground/45">read {ago(quote.readAt)}</span>
        </div>
      )}

      {/* The refusal, stated before the controls rather than under the result. */}
      {integration && (
        <div
          className={cn(
            'mt-4 rounded-xl border p-3',
            integration.executes ? 'border-ok/30 bg-ok/[0.08]' : 'border-warn/40 bg-warn/[0.1]',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-1.5 text-sm font-bold',
              integration.executes ? 'text-ok' : 'text-warn',
            )}
          >
            {integration.executes ? <ArrowRightLeft size={14} /> : <XCircle size={14} />}
            {integration.executes
              ? `${integration.partner}: this swap is executed here.`
              : `${integration.partner} quote only. A-Identity does not execute this swap.`}
          </div>
          {integration.whyNot && (
            <p className="mt-1 text-xs leading-relaxed text-foreground/70">{integration.whyNot}</p>
          )}
          {integration.howRead && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/55">
              How it is read: {integration.howRead}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          Sell
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
            <input
              type="number"
              min="0"
              step="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-24 bg-transparent text-sm outline-none"
            />
            <span className={cn('text-xs font-semibold', forward ? 'text-foreground/60' : 'text-usdc')}>
              {sellSymbol}
            </span>
          </div>
        </label>

        <div className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          <span id="soroswap-direction">Direction</span>
          <div role="group" aria-labelledby="soroswap-direction" className="flex flex-wrap items-center gap-1.5">
            {DIRECTIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  setDirection(d.id)
                  void run(d.id, amount)
                }}
                aria-pressed={direction === d.id}
                disabled={busy}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-[120ms] disabled:opacity-50',
                  direction === d.id
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border bg-card text-foreground/70 hover:bg-foreground/[0.04]',
                )}
              >
                <ArrowRightLeft size={12} />
                {d.label(native, settlement)}
              </button>
            ))}
          </div>
        </div>

        <Button type="button" size="sm" className="text-sm" onClick={() => void run(direction, amount)} disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Scale size={15} />}
          {busy ? 'Reading the router...' : 'Get a quote'}
        </Button>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-warn/35 bg-warn/[0.08] p-3 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {/* Unavailable is an answer about the pool, not a failure of ours, so it is stated
          plainly in the neutral box the other panels use for a prepared-not-executed result. */}
      {quote && !quote.available && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          No quote right now: {quote.reason}
        </div>
      )}

      {quote?.available && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="rounded-lg border border-foreground/8 bg-background/40 px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/45">
              Simulated against the router, not a reservation
            </p>
            <p className="mt-1 text-lg font-bold tracking-tight text-foreground">
              {formatBaseUnits(quote.sell.amount)} {quoteSellSymbol} buys{' '}
              {formatBaseUnits(quote.buy.amount)} {quoteBuySymbol}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              1 {quoteSellSymbol} is {quoteRate(quote.sell.amount, quote.buy.amount)} {quoteBuySymbol} in
              this pool right now. Ask again in a minute and it can differ: no route is held and nothing
              is bound to this price.
            </p>
          </div>

          <DataRow
            label="Soroswap router"
            value={short(quote.router)}
            link={contractUrl(quote.network, quote.router) ?? undefined}
            linkText="explorer"
          />
          {quote.pair && (
            <DataRow
              label="Pool for this pair"
              value={short(quote.pair)}
              link={contractUrl(quote.network, quote.pair) ?? undefined}
              linkText="explorer"
            />
          )}
          {quote.factory && (
            <DataRow
              label="Factory (read out of the router)"
              value={short(quote.factory)}
              link={contractUrl(quote.network, quote.factory) ?? undefined}
              linkText="explorer"
            />
          )}

          {quote.caveats.length > 0 && (
            <div className="rounded-xl border border-warn/40 bg-warn/[0.1] p-3">
              <div className="flex items-center gap-1.5 text-sm font-bold text-warn">
                <AlertTriangle size={14} /> What this number is not ({quote.caveats.length})
              </div>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground/70">
                {quote.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
