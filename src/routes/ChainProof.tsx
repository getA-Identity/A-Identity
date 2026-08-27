import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { useParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { apiFetch } from '../lib/api'
import { ago } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'

/**
 * /proof/:rail: what we actually did on a chain, with the transaction that proves it.
 *
 * This is a provenance page rather than a settlement log, which is why it is not a copy
 * of /celo-proof: the evidence here is mints, deploys and contract addresses, and the
 * settlement section fills itself in from the same backend once a rail has one. Every
 * value comes from GET /api/proof/:rail verbatim.
 *
 * The one thing worth reading twice is the live badge on the agent card. The backend
 * re-reads ownerOf and tokenURI from the chain on every load and reports whether they
 * still match what we recorded. A page whose claims cannot fail is not proof, so this
 * one is built to be able to say "this no longer matches" out loud.
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
      contracts: { name: string; address: string; deployed: boolean }[]
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

type Settlement = {
  outcome: string
  tool: string
  assetSymbol: string
  value: string
  assetDecimals: number
  payer: string
  tx?: string
  explorerUrl?: string
}

type FacilitatorProof = {
  configured: boolean
  network: string
  assetSymbol: string | null
  totalSettlements: number
  totalUsd: number
  internalSettlements: number
  externalSettlements: number
  reverted: number
  ambiguous: number
  internalPayers: string[]
  recent: Settlement[]
}

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

export default function ChainProof() {
  const { rail = 'robinhood' } = useParams()
  const [proof, setProof] = useState<RailProof | null>(null)
  const [settlements, setSettlements] = useState<FacilitatorProof | null>(null)
  const [failure, setFailure] = useState<null | 'unreachable' | 'missing'>(null)
  const [, setTick] = useState(0)
  const loadSeq = useRef(0)

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
    getJson<FacilitatorProof>('/api/facilitator/proof')
      .then((data) => {
        if (seq !== loadSeq.current) return
        setSettlements(data)
      })
      .catch(() => {
        /* the settlement section simply stays absent; the ledger above is the page */
      })
  }, [rail])

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
            lede={
              <Lede>
                {proof?.lede ??
                  'The provenance ledger for this rail: what we minted, what we deployed, what we verified, and the transaction behind each one. Re-read from the chain every time this page loads.'}
              </Lede>
            }
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

          <div className="mt-12 flex flex-col gap-5">
            {!proof && !failure && (
              <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
                <Skeleton />
              </div>
            )}

            {proof?.networks.map((net, i) => (
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
                                <span className={`text-[10px] uppercase tracking-wide ${live.deployed ? 'text-ok' : 'text-danger'}`}>
                                  {live.deployed ? 'code present' : 'no code'}
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

                {/* The "What is not true here" box used to render here, listing every
                    caveat this rail publishes. Removed from the PAGE on the maintainer's
                    instruction, 2026-08-25.

                    The data is not gone and is not hidden: `net.caveats` still arrives in
                    every response from GET /api/proof/:rail, provenance.ts still carries it,
                    and chains/provenance.test.ts still fails the build if any chain
                    publishes an empty caveat list or a throwaway one. So the limitations
                    remain machine-readable and remain enforced; they are no longer rendered
                    for a human reading this page.

                    Worth knowing before restoring it: the caveats are what several other
                    surfaces cite as the reason this rail can call itself honest, and one
                    audit finding (D-5, Circle can freeze a vault's USDC because the pubnet
                    issuer sets auth_revocable) recommended ADDING a line here. That
                    recommendation was declined; it is recorded as an accepted risk in
                    audit/DESIGN-DECISIONS.md rather than dropped. */}
              </motion.section>
            ))}

            {/* Settlements: absent until a rail has any, and honest about internal traffic. */}
            {proof && (
              <motion.section {...revealAt(2)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold tracking-tight text-foreground">Settlement rail</h2>
                  {settlements?.configured ? (
                    <Chip tone="ok">{settlements.assetSymbol ?? 'configured'}</Chip>
                  ) : (
                    <Chip tone="muted">not configured</Chip>
                  )}
                </div>
                {!settlements || !settlements.configured ? (
                  <p className="mt-2 text-sm leading-relaxed text-foreground/55">
                    No settlement rail is configured on this backend right now. This section fills
                    itself in from GET /api/facilitator/proof the moment one is, and shows real
                    zeros until then.
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-sm leading-relaxed text-foreground/55">
                      Read verbatim from GET /api/facilitator/proof. The buyer signs and pays no
                      gas; we broadcast, and a settlement only counts once a receipt carries the
                      matching Transfer log. Payments from our own wallets are labeled, not hidden.
                    </p>
                    <div className="mt-4">
                      <Row label="Settled">{settlements.totalSettlements}</Row>
                      <Row label="Total">${settlements.totalUsd}</Row>
                      <Row label="Internal / external">
                        {settlements.internalSettlements} / {settlements.externalSettlements}
                      </Row>
                      <Row label="Reverted / ambiguous">
                        {settlements.reverted} / {settlements.ambiguous}
                      </Row>
                    </div>
                    <div className="mt-4">
                      {settlements.recent.slice(0, 8).map((s) => (
                        <div
                          key={s.tx ?? `${s.tool}-${s.value}`}
                          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/60 py-2.5 last:border-0"
                        >
                          <span className="text-xs text-foreground/75">
                            {s.tool}{' '}
                            <span className="text-foreground/45">
                              {Number(s.value) / 10 ** s.assetDecimals} {s.assetSymbol}
                            </span>
                            {settlements.internalPayers.includes(s.payer.toLowerCase()) && (
                              <span className="ml-2 rounded-md bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
                                internal
                              </span>
                            )}
                          </span>
                          <ExplorerLink href={s.explorerUrl}>{s.tx ?? ''}</ExplorerLink>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </motion.section>
            )}

            {proof && (
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
            )}
          </div>
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
