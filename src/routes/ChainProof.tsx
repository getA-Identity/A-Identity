import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, ChevronDown, RefreshCw } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StellarVaultsLive from '../components/proof/StellarVaultsLive'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { apiFetch } from '../lib/api'
import { ago } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'
import { sumPaidChecks, type ByNetwork } from '../lib/paidChecks'

/**
 * /proof/:rail: what we actually did on a chain, with the transaction that proves it.
 *
 * The page leads with three numbers anyone can read (payments settled, the dollars behind
 * them, the latest one with its link) and keeps the full ledger one click down: the agent,
 * the contracts, every transaction, and how to check it yourself. Nothing was removed from
 * the ledger; it is folded, and it is still in the prerendered HTML.
 *
 * Settlements come from the rail that actually carries them. Algorand and Stellar keep
 * their own logs; the EIP-3009 chains share the facilitator's, filtered to this rail's
 * networks, and Circle Gateway nanopayments are added wherever that log has rows on them
 * (Arc Mainnet). Reading the facilitator for Algorand used to report "no settlements here"
 * on a rail that had them, and reading its default network's asset used to label Arc's USDC
 * as Robinhood Chain's USDG.
 *
 * The live badge on the agent card re-reads ownerOf and tokenURI from the chain on every
 * load, so this page can say "this no longer matches" out loud.
 */

type Artifact = {
  kind: string
  label: string
  txHash: string
  onChain?: string
  /** Set instead of onChain when the transaction landed on a chain the registry does not
   *  model. Such an artifact carries no explorer link, on purpose. */
  externalChain?: string
  blockNumber?: number
  note?: string
  explorerUrl: string | null
}

type ContractRow = { name: string; address: string; note?: string; explorerUrl: string | null }

type LiveCheck =
  | {
      reachable: true
      checkedAt: string
      blockNumber: string
      owner?: string
      tokenUri?: string
      matchesLedger?: boolean
      contracts: { name: string; address: string; deployed: boolean; archived?: boolean }[]
    }
  | { reachable: false; checkedAt: string; reason: string }

type Network = {
  chain: string
  name: string
  caip2: string
  status: string
  summary: string
  explorer: string | null
  agent?: { tokenId: string; caip: string; owner: string; tokenUri: string }
  contractsLinked: ContractRow[]
  artifactsLinked: Artifact[]
  caveats: string[]
  live: LiveCheck
}

type RailProof = {
  slug: string
  title: string
  lede: string
  networks: Network[]
  howToVerify: string[]
}

type FacilitatorSettlement = {
  outcome: string
  tool: string
  network?: string
  assetSymbol: string
  value: string
  assetDecimals: number
  payer: string
  tx?: string
  authNonce?: string
  explorerUrl?: string
  ts?: string
}

type FacilitatorProof = {
  configured: boolean
  network: string
  /** The asset of the facilitator's DEFAULT network, not of the rail in the URL. A rail
   *  page reads its symbol from byNetwork instead. */
  assetSymbol: string | null
  totalSettlements: number
  totalUsd: number
  internalSettlements: number
  externalSettlements: number
  reverted: number
  ambiguous: number
  internalPayers: string[]
  /** Per-chain breakdown. This page is per-rail, so it MUST read this rather than
   *  present the facilitator-wide totals as if they belonged to the rail in the URL. */
  byNetwork?: ByNetwork
  recent: FacilitatorSettlement[]
}

/** One Circle Gateway nanopayment, as GET /api/x402/gateway/proof publishes it. */
type GatewaySettlement = {
  /** credited: Gateway holds it for us, batch not on-chain yet. completed: the batch landed. */
  outcome: string
  tool: string
  network: string
  assetSymbol: string
  value: string
  assetDecimals: number
  payer: string
  tx?: string
  authNonce?: string
  transferId?: string
  explorerUrl?: string
  ts?: string
}

type GatewayProof = {
  configured: boolean
  internalSettlements: number
  externalSettlements: number
  failed: number
  unconfirmed: number
  internalPayers: string[]
  /** Counts credited and completed rows, the same way the backend's own totals do. */
  byNetwork?: ByNetwork
  recent: GatewaySettlement[]
}

/** The shape the Algorand and Stellar rails publish at their own /proof. */
type OwnRailSettlement = {
  ts: string
  outcome: string
  tool: string
  amountUsd: number
  assetSymbol?: string
  tx?: string
  explorerUrl?: string
  /** True when we paid ourselves. Absent on an older backend, which reads as not internal. */
  internal?: boolean
}
type OwnRailProof = {
  configured: boolean
  assetSymbol: string | null
  totalSettlements: number
  totalUsd: number
  ambiguous: number
  /** Only rails that tell our own wallets apart publish this. */
  externalSettlements?: number
  recent: OwnRailSettlement[]
}

/** One settled payment, in the form the page renders whichever log it came from. */
type Sale = {
  key: string
  tool: string
  amountLabel: string
  tx?: string
  explorerUrl?: string
  ts?: string
  internal: boolean
  /** The rail, named only when it is not the chain's default one. */
  via?: string
  /** Credited by Circle Gateway, with its on-chain batch still to land. */
  pending?: boolean
}

type Sales = {
  source: string
  /** What a row had to pass to be counted, in the words of the logs that were read. */
  basis: string
  configured: boolean
  assetSymbol: string | null
  count: number | null
  usd: number | null
  sales: Sale[]
  /** Counters the logs publish rail-wide, labeled with their scope. */
  counters: { label: string; value: string }[]
  /** True only when every log read says no payment came from outside our own wallets. */
  allInternal: boolean
}

/** Rails whose settlements live in their own log rather than the shared facilitator's. */
const OWN_RAIL_PROOF: Record<string, string> = {
  algorand: '/api/x402/algorand/proof',
  stellar: '/api/x402/stellar/proof',
}

/** Gateway rows the backend counts as paid: the money is Circle-held or already batched. */
const GATEWAY_PAID = new Set(['credited', 'completed'])

const REFRESH_MS = 60_000

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return (await res.json()) as T
}

const Skeleton = () => (
  <span className="inline-block h-5 w-14 animate-pulse rounded bg-foreground/10 align-middle" />
)

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-ok/10 text-ok'
      : tone === 'warn'
        ? 'bg-warn/10 text-warn'
        : tone === 'danger'
          ? 'bg-danger/10 text-danger'
          : 'bg-foreground/[0.06] text-foreground/60'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      {children}
    </span>
  )
}

function ExplorerLink({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  if (!href) return <span className="font-mono text-xs text-foreground/70">{children}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-accent underline-offset-2 hover:underline"
    >
      <span className="break-all">{children}</span>
      <ArrowUpRight size={12} className="shrink-0" />
    </a>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/60 py-2.5 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</span>
      <span className="font-mono text-xs text-foreground/80">{children}</span>
    </div>
  )
}

const OWN_CHAIN_BASIS = 'A payment only counts once we have read the transfer back from the chain ourselves.'

const tsOf = (s: Sale) => (s.ts ? Date.parse(s.ts) || 0 : 0)

/** Newest first. The logs do not agree on an order (some append, some reverse), so the
 *  page sorts by timestamp rather than trusting either, and "latest" means latest. */
const newestFirst = (sales: Sale[]) => [...sales].sort((a, b) => tsOf(b) - tsOf(a))

const units = (value: string, decimals: number) => Number(value) / 10 ** decimals

function fromOwnRail(p: OwnRailProof, source: string): Sales {
  const sales = p.recent
    .filter((s) => s.outcome === 'settled')
    .map((s) => ({
      key: s.tx ?? s.ts,
      tool: s.tool,
      amountLabel: `${s.amountUsd} ${s.assetSymbol ?? p.assetSymbol ?? 'USDC'}`,
      tx: s.tx,
      explorerUrl: s.explorerUrl,
      ts: s.ts,
      internal: s.internal ?? false,
    }))
  return {
    source,
    basis: OWN_CHAIN_BASIS,
    configured: p.configured,
    assetSymbol: p.assetSymbol,
    count: p.totalSettlements,
    usd: p.totalUsd,
    sales: newestFirst(sales),
    counters: [],
    allInternal: p.externalSettlements === 0,
  }
}

/**
 * The EVM rails: our EIP-3009 facilitator on every one of them, plus Circle Gateway
 * nanopayments wherever the Gateway log has rows on this rail's networks (Arc Mainnet
 * today). Counts, dollars and the asset symbol all come from each log's byNetwork, summed
 * by the same helper /arc uses, so the two pages report the same payments.
 */
function fromEvmRails(fac: FacilitatorProof, gw: GatewayProof | null, railNets: Set<string>): Sales {
  const totals = sumPaidChecks([fac, gw], railNets)
  const direct = fac.recent.filter((s) => s.outcome === 'settled' && s.network != null && railNets.has(s.network))
  const viaGateway = (gw?.recent ?? []).filter((s) => GATEWAY_PAID.has(s.outcome) && railNets.has(s.network))
  const gatewayHere =
    gw != null && (viaGateway.length > 0 || Object.keys(gw.byNetwork ?? {}).some((caip) => railNets.has(caip)))
  const facMine = new Set(fac.internalPayers.map((a) => a.toLowerCase()))
  const gwMine = new Set((gw?.internalPayers ?? []).map((a) => a.toLowerCase()))

  const sales: Sale[] = [
    ...direct.map((s) => ({
      key: `3009-${s.tx ?? s.authNonce ?? s.ts ?? s.value}`,
      tool: s.tool,
      amountLabel: `${units(s.value, s.assetDecimals)} ${s.assetSymbol}`,
      tx: s.tx,
      explorerUrl: s.explorerUrl,
      ts: s.ts,
      internal: facMine.has(s.payer.toLowerCase()),
    })),
    // Several Gateway payments can share one batch hash, so the key is the authorization.
    ...(gatewayHere ? viaGateway : []).map((s) => ({
      key: `gateway-${s.authNonce ?? s.transferId ?? s.ts ?? s.value}`,
      tool: s.tool,
      amountLabel: `${units(s.value, s.assetDecimals)} ${s.assetSymbol}`,
      tx: s.outcome === 'completed' ? s.tx : undefined,
      explorerUrl: s.outcome === 'completed' ? s.explorerUrl : undefined,
      ts: s.ts,
      internal: gwMine.has(s.payer.toLowerCase()),
      via: 'Circle Gateway',
      pending: s.outcome !== 'completed',
    })),
  ]

  const counters = [
    { label: 'EIP-3009 internal / external (all chains)', value: `${fac.internalSettlements} / ${fac.externalSettlements}` },
    { label: 'EIP-3009 reverted / ambiguous (all chains)', value: `${fac.reverted} / ${fac.ambiguous}` },
  ]
  if (gw && gatewayHere) {
    counters.push(
      { label: 'Circle Gateway internal / external (all networks)', value: `${gw.internalSettlements} / ${gw.externalSettlements}` },
      { label: 'Circle Gateway failed / unconfirmed (all networks)', value: `${gw.failed} / ${gw.unconfirmed}` },
    )
  }

  return {
    source: gatewayHere
      ? 'GET /api/facilitator/proof and GET /api/x402/gateway/proof, filtered to this rail'
      : 'GET /api/facilitator/proof, filtered to this rail',
    basis: gatewayHere
      ? "An EIP-3009 payment only counts once we have read the transfer back from the chain ourselves. A Circle Gateway payment counts once Circle's transfers API confirms it, and links its batch transaction once that lands on-chain."
      : OWN_CHAIN_BASIS,
    configured: fac.configured || Boolean(gatewayHere && gw?.configured),
    assetSymbol: totals && totals.assetSymbols.length > 0 ? totals.assetSymbols.join(' and ') : null,
    count: totals?.count ?? null,
    usd: totals?.usd ?? null,
    sales: newestFirst(sales),
    counters,
    allInternal: fac.externalSettlements === 0 && (!gatewayHere || gw?.externalSettlements === 0),
  }
}

export default function ChainProof() {
  const { rail = 'robinhood' } = useParams()
  const [proof, setProof] = useState<RailProof | null>(null)
  const [facilitator, setFacilitator] = useState<FacilitatorProof | null>(null)
  const [gateway, setGateway] = useState<GatewayProof | null>(null)
  const [gatewayUnread, setGatewayUnread] = useState(false)
  // Kept with the path it was read from, so a rail's own log never shows on another rail.
  const [ownRail, setOwnRail] = useState<{ path: string; data: OwnRailProof } | null>(null)
  const [failure, setFailure] = useState<null | 'unreachable' | 'missing'>(null)
  const [, setTick] = useState(0)
  const loadSeq = useRef(0)
  const ownRailPath = OWN_RAIL_PROOF[rail]

  usePageMeta({
    title: proof ? `${proof.title}: every claim, with its transaction | A-Identity` : 'On-chain proof | A-Identity',
    description:
      'The provenance ledger for one rail: the agent we minted, the contracts we verified, and every transaction behind them, re-read live from the chain on each load.',
    canonical: `https://a-identity.xyz/proof/${rail}`,
  })

  const load = useCallback(() => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    getJson<RailProof>(`/api/proof/${rail}`)
      .then((data) => {
        if (seq !== loadSeq.current) return
        setProof(data)
        setFailure(null)
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return
        const code = (e as { status?: number }).status
        setFailure(code === 404 || code === 501 ? 'missing' : 'unreachable')
      })
    if (ownRailPath) {
      getJson<OwnRailProof>(ownRailPath)
        .then((data) => {
          if (seq === loadSeq.current) setOwnRail({ path: ownRailPath, data })
        })
        .catch(() => {
          /* the summary shows dashes; the ledger below is the page */
        })
      return
    }
    // Both EVM logs are read together, so the headline never flashes one rail's count
    // before the other's arrives. A failed read keeps whatever the last good one said.
    void Promise.allSettled([
      getJson<FacilitatorProof>('/api/facilitator/proof'),
      getJson<GatewayProof>('/api/x402/gateway/proof'),
    ]).then(([fac, gw]) => {
      if (seq !== loadSeq.current) return
      if (fac.status === 'fulfilled') setFacilitator(fac.value)
      if (gw.status === 'fulfilled') setGateway(gw.value)
      setGatewayUnread(gw.status === 'rejected')
    })
  }, [rail, ownRailPath])

  useEffect(() => {
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => {
      loadSeq.current += 1
      window.clearInterval(id)
    }
  }, [load])

  useEffect(() => {
    // Re-render so the "checked Ns ago" caption keeps counting without new data.
    const id = window.setInterval(() => setTick((t) => t + 1), 5000)
    return () => window.clearInterval(id)
  }, [])

  const railNets = new Set(proof?.networks.map((n) => n.caip2) ?? [])
  const sales: Sales | null = ownRailPath
    ? ownRail && ownRail.path === ownRailPath
      ? fromOwnRail(ownRail.data, `GET ${ownRailPath}`)
      : null
    : facilitator && proof
      ? fromEvmRails(facilitator, gateway, railNets)
      : null
  const latest = sales?.sales[0]
  const liveNet = proof?.networks.find((n) => n.status === 'live') ?? proof?.networks[0]

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main>
        <SectionShell size="lg">
          <SectionIntro
            eyebrow={<Eyebrow>{proof?.title ?? 'On-chain proof'}</Eyebrow>}
            heading={
              <DisplayHeading size="display" className="max-w-[16ch]">
                Every claim, with its transaction.
              </DisplayHeading>
            }
            lede={<Lede>Real payments on {proof?.title ?? 'this chain'}. Click any number to see it on-chain.</Lede>}
          />

          {failure && !proof && (
            <motion.div
              {...reveal}
              className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <p className="text-sm text-foreground/60">
                {failure === 'missing'
                  ? `No published proof for "${rail}" yet. This page reads the backend's own rail index, so it starts working the moment one is published.`
                  : BACKEND_UNREACHABLE}
              </p>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
              >
                <RefreshCw size={13} /> Retry now
              </button>
            </motion.div>
          )}

          {/* The summary: three numbers and a status, readable without knowing anything. */}
          {!failure && (
            <motion.div {...revealAt(3)} className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
              <div className="bg-card p-5">
                <div className="text-3xl font-bold tabular-nums tracking-tight text-foreground">{sales?.count ?? <Skeleton />}</div>
                <div className="mt-1 text-sm text-foreground/60">
                  {sales?.count === 1 ? 'payment' : 'payments'} settled
                  {sales?.allInternal && sales.count ? ', all from our own wallets' : ''}
                </div>
              </div>
              <div className="bg-card p-5">
                <div className="text-3xl font-bold tabular-nums tracking-tight text-foreground">
                  {sales?.usd != null ? `$${sales.usd}` : <Skeleton />}
                </div>
                <div className="mt-1 text-sm text-foreground/60">paid {sales?.assetSymbol ? `in ${sales.assetSymbol}` : 'on-chain'}</div>
              </div>
              <div className="bg-card p-5">
                <div className="text-3xl font-bold tracking-tight text-foreground">{latest?.ts ? ago(latest.ts) : sales ? '-' : <Skeleton />}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-foreground/60">
                  {latest?.explorerUrl ? (
                    <a href={latest.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                      latest payment <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    'latest payment'
                  )}
                  {liveNet && <Chip tone={liveNet.status === 'live' ? 'ok' : 'warn'}>{liveNet.status}</Chip>}
                </div>
              </div>
            </motion.div>
          )}
          {!failure && !ownRailPath && gatewayUnread && !gateway && (
            <p className="mt-3 text-xs text-foreground/50">
              The Circle Gateway log could not be read just now, so any Gateway payments on this chain are missing from
              these numbers until it answers.
            </p>
          )}

          {/* The vaults that enforce the policy on this rail, re-read from the ledger. */}
          {rail === 'stellar' && !failure && (
            <motion.div {...revealAt(4)} className="mt-8">
              <StellarVaultsLive
                heading="Live vault state"
                caption="Read from the ledger on every load, not copied from a deployment record."
              />
              <p className="mt-3 text-sm text-foreground/60">
                These are ours. You can deploy your own on testnet in a minute, owned by a passkey rather than a key we
                hold:{' '}
                <Link to="/stellar" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
                  try the passkey vault on testnet <ArrowUpRight size={13} className="shrink-0" />
                </Link>
              </p>
            </motion.div>
          )}

          {!proof && !failure && (
            <div className="mt-5 rounded-3xl border border-border bg-card p-6 sm:p-8">
              <Skeleton />
            </div>
          )}

          {/* The full ledger, folded. A <details> keeps every word in the prerendered HTML
              for crawlers and for anyone who wants it, while the page itself stays short. */}
          {proof && (
            <details className="group mt-8">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground/75 transition-colors hover:bg-foreground/[0.04] [&::-webkit-details-marker]:hidden">
                Show the full ledger
                <ChevronDown size={15} className="transition-transform group-open:rotate-180" />
              </summary>

              <div className="mt-6 flex flex-col gap-5">
                <p className="max-w-[70ch] text-sm leading-relaxed text-foreground/60">{proof.lede}</p>

                {proof.networks.map((net, i) => (
                  <motion.section
                    key={net.chain}
                    {...revealAt(i)}
                    className="rounded-3xl border border-border bg-card p-6 sm:p-8"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-lg font-bold tracking-tight text-foreground">{net.name}</h2>
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone={net.status === 'live' ? 'ok' : 'warn'}>{net.status}</Chip>
                        <span className="font-mono text-[11px] text-foreground/45">{net.caip2}</span>
                      </div>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-foreground/60">{net.summary}</p>

                    {/* The agent, and whether the chain still agrees with what we recorded. */}
                    {net.agent && (
                      <div className="mt-6 rounded-2xl border border-border bg-background p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <h3 className="text-sm font-semibold text-foreground">Agent #{net.agent.tokenId}</h3>
                          {net.live.reachable ? (
                            net.live.matchesLedger === undefined ? null : net.live.matchesLedger ? (
                              <Chip tone="ok">re-read live: ownerOf matches</Chip>
                            ) : (
                              <Chip tone="danger">re-read live: ownerOf no longer matches</Chip>
                            )
                          ) : (
                            <Chip tone="warn">chain unreachable right now</Chip>
                          )}
                        </div>
                        <div className="mt-3">
                          <Row label="CAIP id">{net.agent.caip}</Row>
                          <Row label="Owner">
                            <ExplorerLink href={net.explorer ? `${net.explorer}/address/${net.agent.owner}` : null}>
                              {net.agent.owner}
                            </ExplorerLink>
                          </Row>
                          <Row label="Token URI">{net.agent.tokenUri}</Row>
                          {net.live.reachable && (
                            <Row label="Checked">
                              block {net.live.blockNumber}, {ago(net.live.checkedAt)}
                            </Row>
                          )}
                          {!net.live.reachable && <Row label="Live read failed">{net.live.reason}</Row>}
                        </div>
                      </div>
                    )}

                    {/* Contracts, each with whether code is actually there right now. */}
                    <div className="mt-6">
                      <h3 className="text-sm font-semibold text-foreground">Contracts</h3>
                      <div className="mt-2">
                        {net.contractsLinked.map((c) => {
                          const live = net.live.reachable
                            ? net.live.contracts.find((x) => x.address.toLowerCase() === c.address.toLowerCase())
                            : undefined
                          return (
                            <div key={c.address} className="border-b border-border/60 py-3 last:border-0">
                              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                <span className="text-xs font-semibold text-foreground/80">{c.name}</span>
                                <span className="flex items-center gap-2">
                                  {live && (
                                    <span className={`text-[10px] uppercase tracking-wide ${live.archived ? 'text-warn' : live.deployed ? 'text-ok' : 'text-danger'}`}>
                                      {live.archived ? 'archived' : live.deployed ? 'code present' : 'no code'}
                                    </span>
                                  )}
                                  <ExplorerLink href={c.explorerUrl}>{c.address}</ExplorerLink>
                                </span>
                              </div>
                              {c.note && <p className="mt-1 text-xs leading-relaxed text-foreground/50">{c.note}</p>}
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* The transactions. */}
                    <div className="mt-6">
                      <h3 className="text-sm font-semibold text-foreground">Transactions</h3>
                      <div className="mt-2">
                        {net.artifactsLinked.map((a) => (
                          <div key={a.txHash} className="border-b border-border/60 py-3 last:border-0">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                              <span className="text-xs text-foreground/75">{a.label}</span>
                              <ExplorerLink href={a.explorerUrl}>{a.txHash}</ExplorerLink>
                            </div>
                            <p className="mt-1 text-[11px] text-foreground/45">
                              {a.kind}
                              {a.blockNumber ? ` - block ${a.blockNumber}` : ''}
                              {a.externalChain
                                ? ` - on ${a.externalChain}, which we do not wire, so there is no link to derive`
                                : a.onChain !== net.chain
                                  ? ` - on ${a.onChain}`
                                  : ''}
                              {a.note ? ` - ${a.note}` : ''}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* The caveats box is intentionally not rendered (maintainer decision,
                        2026-08-25). `net.caveats` still arrives from GET /api/proof/:rail and
                        chains/provenance.test.ts still fails the build on an empty list. */}
                  </motion.section>
                ))}

                {/* Settlements, from the log that actually carries this rail's payments. */}
                <motion.section {...revealAt(2)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-lg font-bold tracking-tight text-foreground">Payments</h2>
                    {sales?.configured ? (
                      <Chip tone="ok">{sales.assetSymbol ?? 'configured'}</Chip>
                    ) : (
                      <Chip tone="muted">not configured</Chip>
                    )}
                  </div>
                  {!sales || !sales.configured ? (
                    <p className="mt-2 text-sm leading-relaxed text-foreground/55">
                      No payment rail is configured for this chain on the backend right now. This section fills
                      itself in the moment one is, and shows real zeros until then.
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 text-sm leading-relaxed text-foreground/55">
                        Read from {sales.source}. {sales.basis} Payments from our own wallets are labeled where the
                        log records them.
                      </p>
                      {sales.counters.length > 0 && (
                        <div className="mt-4">
                          {sales.counters.map((c) => (
                            <Row key={c.label} label={c.label}>
                              {c.value}
                            </Row>
                          ))}
                        </div>
                      )}
                      <div className="mt-4">
                        {sales.sales.length === 0 ? (
                          <p className="text-xs leading-relaxed text-foreground/45">No settled payment on this rail yet.</p>
                        ) : (
                          sales.sales.slice(0, 8).map((s) => (
                            <div
                              key={s.key}
                              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/60 py-2.5 last:border-0"
                            >
                              <span className="text-xs text-foreground/75">
                                {s.tool} <span className="text-foreground/45">{s.amountLabel}</span>
                                {s.via && <span className="ml-2 text-foreground/45">via {s.via}</span>}
                                {s.ts && <span className="ml-2 text-foreground/40">{ago(s.ts)}</span>}
                                {s.pending && (
                                  <span className="ml-2 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/60">
                                    batch pending
                                  </span>
                                )}
                                {s.internal && (
                                  <span className="ml-2 rounded-md bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
                                    internal
                                  </span>
                                )}
                              </span>
                              <ExplorerLink href={s.explorerUrl}>{s.tx ?? ''}</ExplorerLink>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </motion.section>

                <motion.section {...revealAt(3)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
                  <h2 className="text-lg font-bold tracking-tight text-foreground">How to check this yourself</h2>
                  <ul className="mt-3 flex flex-col gap-2">
                    {proof.howToVerify.map((h) => (
                      <li key={h} className="text-sm leading-relaxed text-foreground/65">
                        {h}
                      </li>
                    ))}
                  </ul>
                </motion.section>
              </div>
            </details>
          )}
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
