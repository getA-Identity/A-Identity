/**
 * The state of one owner action while it runs: which step it is on, and how it stopped.
 *
 * The receipt is NOT kept here. It is handed up the moment the backend answers, to a
 * component that the post-write refetch does not unmount, so the hash survives the reread
 * that shows the vault's new state.
 */
import { useCallback, useState } from 'react'
import { failureOf, type OwnerActionResult, type OwnerActionStep, type VaultFailure } from '../../../lib/stellar/vault'
import type { Receipt } from './TxReceipt'

export function receiptOf(what: string, network: string, r: OwnerActionResult): Receipt {
  return {
    what,
    outcome: r.outcome,
    hash: r.txHash,
    ledger: r.ledger,
    network,
    summary: r.summary,
    submittedAt: new Date().toISOString(),
  }
}

export function useOwnerRun() {
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<OwnerActionStep | null>(null)
  const [failure, setFailure] = useState<VaultFailure | null>(null)

  /** Run `fn` under a key; a thrown error becomes a typed failure, never an uncaught one. */
  const run = useCallback(async <T,>(key: string, fn: (onStep: (s: OwnerActionStep) => void) => Promise<T>): Promise<T | null> => {
    setBusy(key)
    setFailure(null)
    try {
      return await fn(setStep)
    } catch (e) {
      setFailure(failureOf(e))
      return null
    } finally {
      setBusy(null)
      setStep(null)
    }
  }, [])

  return { busy, step, failure, setFailure, run }
}
