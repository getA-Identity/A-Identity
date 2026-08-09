/**
 * Wizard step 5, review: a read-only recap of everything the human is about
 * to register, rendered purely from the value snapshot it is handed. The one
 * real submit stays on RegisterForm's nav row, so this pane can never
 * register anything by itself.
 */
export default function ReviewStep({
  value,
  label,
}: {
  value: {
    name: string
    desc: string
    category: string
    caps: string[]
    logoUrl: string | null
    cardStyle: number | undefined
    dailyCap: string
    autoApprove: string
    a2a: boolean
    a2h: boolean
    wallet: { address: string } | null
  }
  label: string
}) {
  const { name, desc, category, caps, logoUrl, cardStyle, dailyCap, autoApprove, a2a, a2h, wallet } = value
  return (
    <div>
      <div className={label}>Review, then register</div>
      <div className="mt-2 rounded-xl border border-border bg-background/40 p-4">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-background/60">
            {logoUrl ? (
              <img src={logoUrl} alt="Agent logo preview" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[10px] font-semibold text-foreground/35">Logo</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-foreground">{name.trim() || '-'}</div>
            <div className="text-xs text-foreground/55">{category}</div>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-foreground/70">{desc.trim()}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {caps.map((c) => (
            <span key={c} className="rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
              {c}
            </span>
          ))}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-4">
          {(
            [
              ['Daily cap', `$${Number(dailyCap) || 50}`],
              ['Auto-approve under', `$${Number(autoApprove) || 1}`],
              ['Agent-to-agent', a2a ? 'Allowed' : 'Off'],
              ['Agent-to-human', a2h ? 'Allowed' : 'Off'],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-[11px] font-bold text-foreground/50">{k}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 border-t border-border pt-3">
          <div className="text-[11px] font-bold text-foreground/50">Card style</div>
          {cardStyle ? (
            <div className="mt-1 flex items-center gap-2">
              <span
                className="h-4 w-4 shrink-0 rounded-full"
                style={{ background: `var(--cat-${cardStyle})` }}
                aria-hidden="true"
              />
              <span className="text-sm font-semibold text-foreground">Style {cardStyle}</span>
              <span className="text-xs text-foreground/55">accents the profile hero</span>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-foreground/55">None. The profile hero keeps the default look.</p>
          )}
        </div>
        <div className="mt-3 border-t border-border pt-3">
          <div className="text-[11px] font-bold text-foreground/50">Wallet</div>
          {wallet ? (
            <div className="mt-0.5 break-all font-mono text-xs text-foreground">{wallet.address}</div>
          ) : (
            <p className="mt-0.5 text-xs text-foreground/55">
              None assigned. Go back to the Wallet step to create one, or attach one later.
            </p>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-foreground/45">
        Registration writes to the A-Identity registry now; the on-chain anchor is queued and
        broadcast only after a human approves it.
      </p>
    </div>
  )
}
