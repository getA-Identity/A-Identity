/**
 * The registry's verdict and the vault's own counters for every payee the page shows: the held
 * payments' payees (all of them), the allowlist (the first few), and any payee a person checks by
 * hand. Read after the vault itself, a few payees at a time, and again whenever the vault is read
 * again. Which payees: read.ts, payeesInView.
 */
import { useEffect, useMemo, useState } from 'react'
import { NEAR_RPC_URLS } from '../../../lib/near/chain'
import { payeesInView, readPayees, type PayeeFacts, type VaultSnapshot } from '../../../lib/near/read'

export function usePayeeFacts(s: VaultSnapshot | null, extra: readonly string[]) {
  const [facts, setFacts] = useState<{ key: string; byPayee: Map<string, PayeeFacts> } | null>(null)
  const payees = useMemo(() => (s ? payeesInView(s, extra) : []), [s, extra])
  // A new read of the vault (readAt) or a new payee list asks again.
  const key = s ? `${s.vaultId}|${s.readAt}|${payees.join(',')}` : ''

  useEffect(() => {
    if (!s || payees.length === 0) return
    let alive = true
    void readPayees(NEAR_RPC_URLS, s.vaultId, s.config.registryId, payees).then(
      (list) => {
        if (alive) setFacts({ key, byPayee: new Map(list.map((f) => [f.payee, f])) })
      },
      () => {
        if (alive) setFacts({ key, byPayee: new Map() })
      },
    )
    return () => {
      alive = false
    }
    // `key` covers the snapshot and the payee list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Answers belong to one read: while a newer one is on its way the page says "reading" rather
  // than showing verdicts from before it as if they were current.
  const current = facts && facts.key === key ? facts.byPayee : null
  return { byPayee: current ?? new Map<string, PayeeFacts>(), loading: payees.length > 0 && current === null, payees }
}
