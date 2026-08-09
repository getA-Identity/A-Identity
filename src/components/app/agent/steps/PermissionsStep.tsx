/**
 * Wizard step 3, permissions: the KYA spend limits (daily cap, auto-approve
 * threshold) and which payment directions the agent may use. Pure props pane:
 * the permission state stays in RegisterForm so hook order never changes.
 */
export default function PermissionsStep({
  dailyCap,
  setDailyCap,
  autoApprove,
  setAutoApprove,
  a2a,
  setA2a,
  a2h,
  setA2h,
  input,
  label,
}: {
  dailyCap: string
  setDailyCap: (v: string) => void
  autoApprove: string
  setAutoApprove: (v: string) => void
  a2a: boolean
  setA2a: (v: boolean) => void
  a2h: boolean
  setA2h: (v: boolean) => void
  input: string
  label: string
}) {
  return (
    <div>
      <div className={label}>Permissions (set at KYA, like card limits)</div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] text-foreground/45">Daily cap (USD)</div>
          <input className={input} type="number" min="0" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-[11px] text-foreground/45">Auto-approve under (USD)</div>
          <input className={input} type="number" min="0" step="0.1" value={autoApprove} onChange={(e) => setAutoApprove(e.target.value)} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-foreground/70">
          <input type="checkbox" checked={a2a} onChange={(e) => setA2a(e.target.checked)} className="accent-accent" />
          Agent-to-agent payments
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground/70">
          <input type="checkbox" checked={a2h} onChange={(e) => setA2h(e.target.checked)} className="accent-accent" />
          Agent-to-human payments
        </label>
      </div>
    </div>
  )
}
