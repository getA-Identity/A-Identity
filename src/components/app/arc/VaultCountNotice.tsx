/**
 * The line that says whether an owner's vault now counts on /proof/arc, or why not: on "Your vault is
 * set up" and on the vault's own page. The vault works the same either way, and when the question
 * failed the line says that too.
 */
import { useEffect, useState } from 'react'
import { readSweepSays } from '../../../lib/arc/known-vaults'
import { noHashWords, type EndDate, type SweepSays, type VaultCount } from '../../../lib/arc/vault-count'

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
  endDate,
}: {
  testnet: boolean
  networkName: string
  count: VaultCount
  onRetry: () => void
  /** What the vault's agent key end date reads as. No default: "has one" is a claim to the owner, and only a read can make it. */
  endDate: EndDate
}) {
  // Asked only when it will be said: no other state of this line depends on the server's search. Look
  // again takes the line away while the list reads, so its coming back asks again, and a read that
  // failed recovers the same way. What an earlier read said is not said while this one is out.
  const needsSweep = !testnet && count.state === 'no-hash'
  const [sweep, setSweep] = useState<SweepSays>('reading')
  useEffect(() => {
    if (!needsSweep) return
    let current = true
    setSweep('reading')
    void readSweepSays().then((says) => {
      if (current) setSweep(says)
    })
    return () => {
      current = false
    }
  }, [needsSweep])
  const retry = (
    <button type="button" onClick={onRetry} className="font-semibold text-accent underline underline-offset-2">
      Try again
    </button>
  )
  // With no hash the list is all this line has. Refresh on the page reads only the chain, so a vault the server has since counted says so through this.
  const lookAgain = (
    <button type="button" onClick={onRetry} className="font-semibold text-accent underline underline-offset-2">
      Look again
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
    return (
      <div className={box}>
        This vault is not counted on {PROOF_LINK} yet{noHashWords(endDate, sweep)} {lookAgain}
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
