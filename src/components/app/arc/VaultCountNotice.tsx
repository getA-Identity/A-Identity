/**
 * The line on "Your vault is set up" that says whether this vault now counts on /proof/arc, or why
 * not. The vault works the same either way, and when the question failed the line says that too.
 */
import type { VaultCount } from '../../../lib/arc/vault-count'

const PROOF_LINK = (
  <a href="/proof/arc" className="font-semibold text-accent underline underline-offset-2">
    a-identity.xyz/proof/arc
  </a>
)

export default function VaultCountNotice({
  testnet,
  networkName,
  countable,
  count,
  onRetry,
}: {
  testnet: boolean
  networkName: string
  countable: boolean
  count: VaultCount | null
  onRetry: () => void
}) {
  const retry = (
    <button type="button" onClick={onRetry} className="font-semibold text-accent underline underline-offset-2">
      Try again
    </button>
  )
  const box = 'mt-2 rounded-xl border border-border bg-background/60 px-3 py-2 text-xs text-foreground/80'

  if (testnet) {
    return <div className={box}>This vault is on {networkName}, so it is not counted on {PROOF_LINK}. Only vaults on Arc Mainnet are.</div>
  }
  if (!countable) {
    return (
      <div className={box}>
        This vault is not counted on {PROOF_LINK} yet: this page did not see the transaction that created it, so it could not ask. Find that transaction in your wallet's activity and send its hash to the A-Identity team.
      </div>
    )
  }
  if (count === null || count.state === 'checking') {
    return <div className={box}>Checking whether this vault counts on {PROOF_LINK}...</div>
  }
  if (count.state === 'counted') {
    return <div className={box}>This vault is now counted on {PROOF_LINK}. You do not have to send its address to anyone.</div>
  }
  if (count.state === 'not-counted') {
    return (
      <div className={box}>
        This vault is not counted on {PROOF_LINK}, for {count.reasons.length === 1 ? 'this reason' : 'these reasons'}:
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {count.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="mt-1">It still works as a vault. {count.retryable && retry}</div>
      </div>
    )
  }
  return (
    <div className={box}>
      We could not find out whether this vault counts on {PROOF_LINK}: {count.why} Your vault is not affected. {retry}
    </div>
  )
}
