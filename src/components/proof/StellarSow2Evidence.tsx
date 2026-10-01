/**
 * The dated SoW 2 section of /proof/stellar, rendered in the open rather than folded.
 *
 * Everything here arrives from GET /api/proof/stellar (the `sow2` block and each network's
 * `accountsLinked`), which the backend builds from mcp/src/chains/provenance.ts. Nothing is
 * duplicated into the frontend on purpose: a second copy of a deliverable's status is a
 * second place for it to go stale, and the ledger is the one a test keeps honest.
 *
 * The cost of that choice is stated rather than hidden. The prerendered snapshot of this page
 * cannot reach the backend (production builds call the API same-origin, and the preview
 * server that renders the snapshot has no proxy), so the snapshot and a cold backend both
 * show the waiting state below instead of an empty section or invented rows.
 *
 * Order follows the question a reviewer of SoW 2 asks: what is delivered and when, which
 * accounts are ours and which are an owner's, who holds which authority, and what all of
 * this does not prove.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Check, Copy, RefreshCw } from 'lucide-react'

export type Sow2Status = 'live' | 'pending' | 'not-delivered'

export type Sow2ArtifactRef = {
  txHash: string
  label: string
  date: string | null
  onChain: string | null
  explorerUrl: string | null
}

export type Sow2Deliverable = {
  id: 'D1' | 'D2' | 'D3'
  title: string
  status: Sow2Status
  date: string | null
  caption: string
  links: { label: string; url: string }[]
  artifacts: string[]
  artifactsLinked?: Sow2ArtifactRef[]
}

export type Sow2Report = {
  sprintStart: string
  deliverables: Sow2Deliverable[]
  trustModel: string
  caveats: string[]
}

export type PublishedAccount = {
  role: string
  address: string
  network: string
  custody: string
  usedFor: string
  publishedAt: string
  explorerUrl: string | null
}

/** The slice of a proof network this section reads. */
export type Sow2Network = { chain: string; name: string; accountsLinked?: PublishedAccount[] }

type LoadState = 'loading' | 'unreachable' | 'ready'

const STATUS_LABEL: Record<Sow2Status, string> = {
  live: 'live',
  pending: 'pending',
  'not-delivered': 'not delivered',
}

function StatusChip({ status }: { status: Sow2Status }) {
  const cls =
    status === 'live' ? 'bg-ok/10 text-ok' : status === 'pending' ? 'bg-warn/10 text-warn' : 'bg-danger/10 text-danger'
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

/**
 * Custody, toned by whose key it is. An owner's key we never hold reads as the good news it
 * is; a key of ours is neutral, because holding it is a fact to publish, not a fault.
 */
function CustodyChip({ custody }: { custody: string }) {
  const cls = custody.startsWith('owner:')
    ? 'bg-ok/10 text-ok'
    : custody.startsWith('third party')
      ? 'bg-foreground/[0.06] text-foreground/70'
      : 'bg-warn/10 text-warn'
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{custody}</span>
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy address"
      title="Copy address"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {
            /* a browser that refuses the clipboard leaves the address selectable */
          })
      }}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-foreground/60 transition-colors hover:bg-foreground/[0.04]"
    >
      {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
    </button>
  )
}

function SiteOrExternalLink({ label, url }: { label: string; url: string }) {
  const cls = 'inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline'
  if (url.startsWith('/')) {
    return (
      <Link to={url} className={cls}>
        {label} <ArrowUpRight size={12} className="shrink-0" />
      </Link>
    )
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cls}>
      {label} <ArrowUpRight size={12} className="shrink-0" />
    </a>
  )
}

export default function StellarSow2Evidence({
  sow2,
  networks,
  state,
  onRetry,
}: {
  sow2: Sow2Report | null | undefined
  networks: Sow2Network[]
  state: LoadState
  onRetry?: () => void
}) {
  const accounts = networks.flatMap((n) => (n.accountsLinked ?? []).map((a) => ({ ...a, networkName: n.name })))

  return (
    <section className="rounded-3xl border border-border bg-card p-6 sm:p-8" aria-labelledby="sow2-evidence">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sow2-evidence" className="text-lg font-bold tracking-tight text-foreground">
            SoW 2 evidence
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-foreground/60">
            {sow2
              ? `Sprint started ${sow2.sprintStart}. Each deliverable says whether it is live, with its date, or what will appear here when it is.`
              : 'Each SoW 2 deliverable, dated, with the accounts we publish and what the evidence does not prove.'}
          </p>
        </div>
        <Link
          to="/app/vault/stellar"
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/75 transition-colors hover:bg-foreground/[0.04]"
        >
          Open the live vault panel <ArrowUpRight size={13} className="shrink-0" />
        </Link>
      </div>

      {!sow2 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-background px-5 py-4">
          <p className="text-sm leading-relaxed text-foreground/60">
            {state === 'ready'
              ? 'The backend answered without a SoW 2 section, so it is running an older build. Nothing is shown rather than a copy that could be stale.'
              : 'The evidence loads from the live backend; it may take up to a minute to wake (free tier). Nothing here is cached in the page, so until it answers this section stays empty rather than showing old numbers.'}
          </p>
          {state === 'unreachable' && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
            >
              <RefreshCw size={13} /> Retry now
            </button>
          )}
        </div>
      )}

      {sow2 && (
        <>
          {/* Deliverables: date, status, one line of caption, links, then any artifacts. */}
          <div className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-border bg-border">
            {sow2.deliverables.map((d) => (
              <div key={d.id} className="bg-background p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    <span className="font-mono text-foreground/50">{d.id}</span> {d.title}
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-foreground/50">{d.date ?? 'not yet'}</span>
                    <StatusChip status={d.status} />
                  </div>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-foreground/65">{d.caption}</p>
                {d.links.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {d.links.map((l) => (
                      <SiteOrExternalLink key={l.url} label={l.label} url={l.url} />
                    ))}
                  </div>
                )}
                {(d.artifactsLinked ?? []).length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {(d.artifactsLinked ?? []).map((a) => (
                      <li key={a.txHash} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-xs text-foreground/75">
                          <span className="font-mono text-foreground/50">{a.date ?? '-'}</span> {a.label}
                        </span>
                        {a.explorerUrl ? (
                          <a
                            href={a.explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
                          >
                            <span className="break-all">{a.txHash}</span>
                            <ArrowUpRight size={11} className="shrink-0" />
                          </a>
                        ) : (
                          <span className="break-all font-mono text-[11px] text-foreground/60">{a.txHash}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          {/* Accounts: every key we hold and every owner we do not, side by side. */}
          <h3 className="mt-8 text-sm font-semibold text-foreground">Accounts we publish</h3>
          <p className="mt-1 text-xs leading-relaxed text-foreground/55">
            The backend and owner accounts on both Stellar networks. An owner action is evidence that we did not sign it
            only if every key we do hold is listed here to compare against.
          </p>
          {accounts.length === 0 ? (
            <p className="mt-3 text-xs text-foreground/50">The backend published no accounts with this answer.</p>
          ) : (
            <div className="mt-3 grid gap-px overflow-hidden rounded-2xl border border-border bg-border">
              {accounts.map((a) => (
                <div key={`${a.network}-${a.address}`} className="bg-background p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground/85">{a.role}</span>
                    <span className="text-[11px] text-foreground/50">
                      {a.networkName}, published {a.publishedAt}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <CopyButton value={a.address} />
                    {a.explorerUrl ? (
                      <a
                        href={a.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-accent hover:underline"
                      >
                        <span className="break-all">{a.address}</span>
                        <ArrowUpRight size={11} className="shrink-0" />
                      </a>
                    ) : (
                      <span className="break-all font-mono text-[11px] text-foreground/70">{a.address}</span>
                    )}
                  </div>
                  <div className="mt-2">
                    <CustodyChip custody={a.custody} />
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-foreground/55">{a.usedFor}</p>
                </div>
              ))}
            </div>
          )}

          <h3 className="mt-8 text-sm font-semibold text-foreground">Who holds which authority</h3>
          <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-foreground/70">{sow2.trustModel}</p>

          <h3 className="mt-8 text-sm font-semibold text-foreground">What this evidence does not prove</h3>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-5">
            {sow2.caveats.map((c) => (
              <li key={c} className="text-sm leading-relaxed text-foreground/65">
                {c}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
