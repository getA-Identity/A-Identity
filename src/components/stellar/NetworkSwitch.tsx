import { passkeyNetworkInfo, type PasskeyNetwork } from '../../lib/stellar/passkey'

/**
 * Mainnet or testnet, chosen in the open. The choice lives in the URL (?network=testnet),
 * so a link to the testnet page stays on testnet, and each side says in words what it
 * costs: real money in dust amounts, or none at all.
 */
const SIDES: { net: PasskeyNetwork; title: string; note: string }[] = [
  { net: 'stellar:pubnet', title: 'Mainnet', note: 'Real money (dust caps)' },
  { net: 'stellar:testnet', title: 'Testnet', note: 'Test network, no real money' },
]

export default function NetworkSwitch({ value, onChange, disabled }: { value: PasskeyNetwork; onChange: (net: PasskeyNetwork) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Stellar network" className="inline-flex flex-wrap gap-1 rounded-2xl border border-border bg-card p-1">
      {SIDES.map((s) => {
        const on = s.net === value
        return (
          <button
            key={s.net}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => !on && onChange(s.net)}
            title={passkeyNetworkInfo(s.net).label}
            className={`flex min-w-[9.5rem] flex-col items-start rounded-xl px-4 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              on ? (s.net === 'stellar:pubnet' ? 'bg-warn/10 text-foreground' : 'bg-accent/10 text-foreground') : 'text-foreground/60 hover:bg-foreground/[0.04]'
            }`}
          >
            <span className="text-sm font-bold">{s.title}</span>
            <span className={`text-[11px] ${on ? (s.net === 'stellar:pubnet' ? 'text-warn' : 'text-accent') : 'text-foreground/45'}`}>{s.note}</span>
          </button>
        )
      })}
    </div>
  )
}
