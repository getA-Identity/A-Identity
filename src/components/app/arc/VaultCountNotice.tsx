/**
 * The line that says whether an owner's vault now counts on /proof/arc, or why not: on "Your vault is
 * set up" and on the vault's own page. The vault works the same either way, and when the question
 * failed the line says that too.
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
  count,
  onRetry,
  hasEndDate = true,
}: {
  testnet: boolean
  networkName: string
  count: VaultCount
  onRetry: () => void
  /** Whether the vault read back an end date, which is what the server's own search on the chain looks for. */
  hasEndDate?: boolean
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
  if (count.state === 'needs-end-date') {
    return <div className={box}>This vault can count on {PROOF_LINK} once its agent key has an end date. When this page reads one it asks by itself, and you do not have to send anything to anyone.</div>
  }
  if (count.state === 'no-hash') {
    return hasEndDate ? (
      <div className={box}>
        This vault is not counted on {PROOF_LINK} yet. You do not have to send anything to anyone: our server looks for vaults on the chain by itself, and this one has the agent key end date it looks for. Look again here in a little while. If it still says this tomorrow, tell the A-Identity team, because the check may have refused it.
      </div>
    ) : (
      <div className={box}>
        This vault is not counted on {PROOF_LINK} yet, because its agent key has no end date. Set one from this page. You do not have to send anything to anyone: our server looks for vaults on the chain by itself, and it finds this one once it has an end date.
      </div>
    )
  }
  if (count.state === 'checking') {
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
