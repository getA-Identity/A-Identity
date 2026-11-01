/**
 * The state of one write while it runs on the Arc vault page: which step it is on, and how it
 * stopped. A thrown error becomes a typed failure here, never an uncaught one.
 *
 * The receipt is NOT kept here. The moment the wallet returns a hash it is handed up, to a
 * component the post-write re-read does not unmount, so the hash stays on screen.
 */
import { useCallback, useState } from 'react'
import type { TxRecord } from '../../../lib/arc/pending'
import { failureOf, type PreparedTx, type TxFailure, type TxStep } from '../../../lib/arc/vault-write'

export function recordOf(p: PreparedTx, hash: `0x${string}`, vault: string | null): TxRecord {
  return {
    hash,
    action: p.action,
    what: p.what,
    network: p.chain.caip2,
    from: p.from,
    vault,
    submittedAt: new Date().toISOString(),
    expect: p.expect,
    ...(p.predicted ? { predicted: p.predicted } : {}),
    ...(p.expiry !== undefined ? { expiry: p.expiry } : {}),
    outcome: 'pending',
  }
}

export function useArcTx() {
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<TxStep | null>(null)
  const [failure, setFailure] = useState<TxFailure | null>(null)

  const run = useCallback(async <T,>(key: string, fn: (onStep: (s: TxStep) => void) => Promise<T>): Promise<T | null> => {
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
