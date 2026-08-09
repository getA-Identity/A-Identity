import { CARD_STYLES, CATEGORIES } from '../register-constants'

/**
 * Wizard step 1, identity: name, description, category, the optional logo
 * (already resized in the browser by RegisterForm's picker) and the card-style
 * accent. Pure props pane: every hook stays in RegisterForm so the wizard's
 * hook order never changes.
 */
export default function IdentityStep({
  name,
  setName,
  desc,
  setDesc,
  category,
  setCategory,
  logoUrl,
  setLogoUrl,
  logoErr,
  onLogoPick,
  cardStyle,
  setCardStyle,
  input,
  label,
}: {
  name: string
  setName: (v: string) => void
  desc: string
  setDesc: (v: string) => void
  category: string
  setCategory: (v: string) => void
  logoUrl: string | null
  setLogoUrl: (v: string | null) => void
  logoErr: string | null
  onLogoPick: (file: File | undefined) => void
  cardStyle: number | undefined
  setCardStyle: (v: number | undefined) => void
  input: string
  label: string
}) {
  return (
    <div>
      <div className={label}>Identity</div>
      <div className="mt-2 flex flex-col gap-3">
        <input className={input} placeholder="Agent name (e.g. My Trading Agent)" value={name} onChange={(e) => setName(e.target.value)} required />
        <div>
          <input className={input} placeholder="What does this agent do? (shown in Agent House)" value={desc} onChange={(e) => setDesc(e.target.value)} required minLength={20} />
          <p className="mt-1 text-[11px] text-foreground/45">
            At least 20 characters. Verified agents with a description appear in the Agent House showcase.
          </p>
        </div>
        <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>

        {/* Logo: optional, resized in the browser, shown everywhere the agent is. */}
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-background/60">
            {logoUrl ? (
              <img src={logoUrl} alt="Agent logo preview" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[10px] font-semibold text-foreground/35">Logo</span>
            )}
          </div>
          <div className="min-w-0">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04]">
              {logoUrl ? 'Change logo' : 'Upload logo'}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => onLogoPick(e.target.files?.[0])}
              />
            </label>
            {logoUrl && (
              <button
                type="button"
                onClick={() => setLogoUrl(null)}
                className="ml-2 text-xs font-semibold text-foreground/45 hover:text-danger"
              >
                Remove
              </button>
            )}
            <p className="mt-1 text-[11px] text-foreground/50">
              Optional. Square works best; resized to 96px in your browser.
            </p>
            {logoErr && <p className="mt-0.5 text-[11px] text-danger">{logoErr}</p>}
          </div>
        </div>

        {/* Card style: optional accent preset for the public profile hero.
            Swatches are the console's own --cat-1..--cat-6 tokens. */}
        <div>
          <div className="text-[11px] text-foreground/45">Card style</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCardStyle(undefined)}
              aria-pressed={cardStyle === undefined}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                cardStyle === undefined
                  ? 'bg-accent text-white'
                  : 'border border-foreground/15 text-foreground/60 hover:bg-foreground/5'
              }`}
            >
              None
            </button>
            {CARD_STYLES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCardStyle(n)}
                aria-pressed={cardStyle === n}
                aria-label={`Card style ${n}`}
                className={`grid h-8 w-8 place-items-center rounded-full border-2 transition-colors ${
                  cardStyle === n ? 'border-accent' : 'border-transparent hover:border-foreground/25'
                }`}
              >
                <span
                  className="h-5 w-5 rounded-full"
                  style={{ background: `var(--cat-${n})` }}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-foreground/45">
            Optional. Themes your agent's public profile hero in Agent House.
          </p>
        </div>
      </div>
    </div>
  )
}
