import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { apiFetch } from '../lib/api'
import { CHAINS } from '../lib/chains'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'

/**
 * /proof: every chain in one place, and the one link the footer points at.
 *
 * The footer used to carry two live-proof links, one per surface, which meant the
 * evidence for eight chains was reachable only if you already knew which two to click.
 * This page is the index those links should have had: a card per published rail, the
 * facilitator's own settlement totals above them, and an explicit row for the chains
 * whose evidence lives somewhere else. Deep links to /proof/:rail still work and are
 * where the live re-read happens.
 *
 * Two honesty rules shape it. The rail cards come from GET /api/proof/rails, which is
 * local ledger data only, so this page never claims a live read it did not perform: the
 * per-rail pages do that and this one links to them. And the coverage row is computed
 * against the generated chain registry rather than a hand-written list, so a live chain
 * with no published rail shows up here saying exactly that instead of quietly missing.
 */

type RailNetwork = {
  chain: string
  name: string
  status: string
  testnet: boolean
  color: string
  agentTokenId: string | null
  contracts: number
  artifacts: number
  caveats: number
}

type Rail = {
  slug: string
  title: string
  lede: string
  chains: string[]
  networks: RailNetwork[]
  totals: { contracts: number; artifacts: number; caveats: number }
  mainnet: boolean
}

type FacilitatorProof = {
  totalSettlements: number
  totalUsd: number
  reverted: number
  byNetwork?: Record<string, { count: number; usd: number; assetSymbol: string }>
}

const REFRESH_MS = 60_000

/** The OKX submission's settlement proof, served by the ASP deployment rather than here. */
const ASP_PROOF_URL = 'https://a-identity-asp.onrender.com/proof'

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return (await res.json()) as T
}

/**
 * Tolerate the older, thinner rail index.
 *
 * The site and the backend deploy from the same push but not at the same speed, so for a
 * few minutes this page can be talking to a backend that still returns the pre-index
 * shape: slug, title and chains, with no networks or totals. Rather than crash on a
 * missing array, fill the gaps from the chain registry we already ship in the bundle and
 * show no counts at all. A card with fewer facts is honest; a blank page is not.
 */
function normalize(raw: Partial<Rail>[]): Rail[] {
  return raw.map((r) => {
    const chains = r.chains ?? []
    const networks =
      r.networks ??
      chains.flatMap((id) => {
        const c = CHAINS.find((x) => x.id === id)
        return c
          ? [
              {
                chain: c.id,
                name: c.name,
                status: c.status,
                testnet: c.testnet,
                color: c.color,
                agentTokenId: null,
                contracts: 0,
                artifacts: 0,
                caveats: 0,
              },
            ]
          : []
      })
    return {
      slug: r.slug ?? '',
      title: r.title ?? r.slug ?? '',
      lede: r.lede ?? '',
      chains,
      networks,
      totals: r.totals ?? { contracts: 0, artifacts: 0, caveats: 0 },
      mainnet: r.mainnet ?? networks.some((n) => !n.testnet),
    }
  })
}

const Bar = () => <span className="inline-block h-5 w-16 animate-pulse rounded bg-foreground/10 align-middle" />

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-border bg-card px-5 py-4">
      <span className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</span>
      <span className="font-mono text-2xl font-bold tracking-tight text-foreground">{value}</span>
      <span className="text-xs leading-relaxed text-foreground/55">{sub}</span>
    </div>
  )
}

/**
 * A chain chip: brand color in the dot and the tint, never in the label.
 *
 * The registry asks every chain color to stay readable as chip text in both themes, and
 * Celo's #FCFF52 does not: yellow text on a yellow wash disappears on a light background.
 * Rather than dim one chain's brand to fit a rule the rule cannot enforce, the label uses
 * the foreground token and the color says its piece through the dot and the border. That
 * holds for any hue a future chain arrives with, including the next one that breaks it.
 */
function ChainChip({ name, color, testnet }: { name: string; color: string; testnet: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-foreground/75"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color, opacity: testnet ? 0.5 : 1 }}
      />
      {name}
    </span>
  )
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono text-sm font-bold text-foreground">{n}</span>
      <span className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</span>
    </span>
  )
}

export default function ProofIndex() {
  const [rails, setRails] = useState<Rail[] | null>(null)
  const [settlements, setSettlements] = useState<FacilitatorProof | null>(null)
  const [failure, setFailure] = useState(false)
  const loadSeq = useRef(0)

  usePageMeta({
    title: 'Live proof: every chain, every claim, one page | A-Identity',
    description:
      'One index of every on-chain claim A-Identity makes: the agents registered, the contracts deployed, the x402 settlements, and the transaction behind each one, per chain.',
    canonical: 'https://a-identity.xyz/proof',
  })

  const load = useCallback(() => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    getJson<{ rails: Partial<Rail>[] }>('/api/proof/rails')
      .then((data) => {
        if (seq !== loadSeq.current) return
        setRails(normalize(data.rails ?? []))
        setFailure(false)
      })
      .catch(() => {
        if (seq !== loadSeq.current) return
        setFailure(true)
      })
    getJson<FacilitatorProof>('/api/facilitator/proof')
      .then((data) => {
        if (seq !== loadSeq.current) return
        setSettlements(data)
      })
      .catch(() => {
        /* the totals strip simply stays a skeleton; the rail cards are the page */
      })
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => {
      loadSeq.current += 1
      window.clearInterval(id)
    }
  }, [load])

  /**
   * Live chains the published rails do not cover. Computed rather than listed, so the
   * day a chain goes live without a rail this row says so on its own.
   */
  const uncovered = useMemo(() => {
    if (!rails) return []
    const covered = new Set(rails.flatMap((r) => r.chains))
    return CHAINS.filter((c) => c.status === 'live' && !covered.has(c.id))
  }, [rails])

  const settledNetworks = settlements?.byNetwork ? Object.keys(settlements.byNetwork).length : null

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main>
        <SectionShell size="lg">
          <SectionIntro
            eyebrow={<Eyebrow>Live proof</Eyebrow>}
            heading={
              <DisplayHeading size="display" className="max-w-[15ch]">
                Every chain. Every claim. One page.
              </DisplayHeading>
            }
            lede={
              <Lede>
                We run on more than one chain, so the evidence should not be scattered across
                more than one page. This is the index: what we registered, what we deployed and
                what we settled, per chain, each with the transaction behind it. Open a rail to
                have its facts re-read from the chain while you watch.
              </Lede>
            }
          />

          {/* The facilitator's own numbers, above the rails, because a settlement total is
              the one claim that spans every chain at once. */}
          <motion.div {...reveal} className="mt-12 grid gap-4 sm:grid-cols-3">
            <Stat
              label="Settlements"
              value={settlements ? settlements.totalSettlements.toLocaleString('en-US') : <Bar />}
              sub="Paid calls settled through the x402 facilitator we run ourselves. None counted without a receipt carrying a matching transfer log."
            />
            <Stat
              label="Value settled"
              value={
                settlements ? (
                  `$${settlements.totalUsd.toFixed(settlements.totalUsd < 10 ? 4 : 2)}`
                ) : (
                  <Bar />
                )
              }
              sub="Real stablecoin, mostly in sub-cent increments. Agent payments are small on purpose."
            />
            <Stat
              label="Networks settling"
              value={settledNetworks === null ? <Bar /> : settledNetworks}
              sub="Chains where a payment has actually cleared, which is a smaller number than the chains we support, and it should be."
            />
          </motion.div>

          {failure && !rails && (
            <motion.div
              {...reveal}
              className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <p className="text-sm text-foreground/60">{BACKEND_UNREACHABLE}</p>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
              >
                <RefreshCw size={13} /> Retry now
              </button>
            </motion.div>
          )}

          <div className="mt-14">
            <h2 className="text-lg font-bold tracking-tight text-foreground">Published rails</h2>
            <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-foreground/55">
              One card per rail. The counts come from our own ledger; the live re-read of every
              address and token id happens on the rail page itself.
            </p>

            <div className="mt-6 grid gap-5 md:grid-cols-2">
              {!rails &&
                !failure &&
                [0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-56 animate-pulse rounded-3xl border border-border bg-card" />
                ))}

              {rails?.map((rail, i) => (
                <motion.article
                  key={rail.slug}
                  {...revealAt(i)}
                  className="flex flex-col rounded-3xl border border-border bg-card p-6 transition-colors duration-[160ms] hover:border-accent/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-base font-bold tracking-tight text-foreground">{rail.title}</h3>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        rail.mainnet ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'
                      }`}
                    >
                      {rail.mainnet ? 'mainnet' : 'testnet only'}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {rail.networks.map((n) => (
                      <ChainChip key={n.chain} name={n.name} color={n.color} testnet={n.testnet} />
                    ))}
                  </div>

                  {rail.lede && (
                    <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-foreground/60">{rail.lede}</p>
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/60 pt-4">
                    {rail.totals.artifacts + rail.totals.contracts + rail.totals.caveats > 0 ? (
                      <>
                        <Count n={rail.totals.artifacts} label="transactions" />
                        <Count n={rail.totals.contracts} label="contracts" />
                        <Count n={rail.totals.caveats} label="caveats" />
                      </>
                    ) : (
                      <span className="text-xs text-foreground/45">Counts load with the ledger.</span>
                    )}
                    {rail.networks.some((n) => n.agentTokenId) && (
                      <span className="font-mono text-[11px] text-foreground/45">
                        {rail.networks
                          .filter((n) => n.agentTokenId)
                          .map((n) => `#${n.agentTokenId}`)
                          .join(' ')}
                      </span>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-4">
                    <Link
                      to={`/proof/${rail.slug}`}
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent underline-offset-4 hover:underline"
                    >
                      Open the ledger <ArrowRight size={14} />
                    </Link>
                    {rail.slug === 'celo' && (
                      <Link
                        to="/celo-proof"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground/55 underline-offset-4 hover:text-foreground hover:underline"
                      >
                        Live settlement log
                      </Link>
                    )}
                  </div>
                </motion.article>
              ))}
            </div>
          </div>

          {/* Chains that are live but carry no rail of their own. Today that is X Layer,
              whose evidence sits on the ASP deployment the OKX listing points at. */}
          {uncovered.length > 0 && (
            <motion.section
              {...reveal}
              className="mt-14 rounded-3xl border border-border bg-card p-6 sm:p-8"
            >
              <h2 className="text-lg font-bold tracking-tight text-foreground">Live, with its evidence elsewhere</h2>
              <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-foreground/55">
                These chains are live in the registry but have no provenance rail published on
                this site yet. Listing them empty-handed beats leaving them off the page.
              </p>
              <div className="mt-5 flex flex-col gap-3">
                {uncovered.map((c) => (
                  <div
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-4"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <ChainChip name={c.name} color={c.color} testnet={c.testnet} />
                      <span className="font-mono text-[11px] text-foreground/45">{c.caip2}</span>
                    </div>
                    {c.id === 'xlayer' ? (
                      <a
                        href={ASP_PROOF_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent underline-offset-4 hover:underline"
                      >
                        Settlement proof on the ASP <ArrowUpRight size={14} />
                      </a>
                    ) : (
                      <span className="text-xs text-foreground/50">No published proof surface yet.</span>
                    )}
                  </div>
                ))}
              </div>
            </motion.section>
          )}

          <motion.section {...reveal} className="mt-8 rounded-3xl border border-border bg-card p-6 sm:p-8">
            <h2 className="text-lg font-bold tracking-tight text-foreground">What a caveat count means</h2>
            <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-foreground/60">
              Every rail carries a caveat list, and a test fails our build if one is empty. The
              number on each card is how many things we say are NOT true on that chain: what is
              testnet, what has no identity registry to anchor to, which payments were between
              wallets we both own. A proof page that only lists wins is a brochure, so those
              counts are printed next to the transaction counts rather than under them.
            </p>
            <div className="mt-5 flex flex-wrap gap-4">
              <Link
                to="/explorer"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent underline-offset-4 hover:underline"
              >
                Resolve any agent yourself <ArrowRight size={14} />
              </Link>
              <Link
                to="/architecture"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground/55 underline-offset-4 hover:text-foreground hover:underline"
              >
                How the rails are built
              </Link>
            </div>
          </motion.section>
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
