/**
 * Asks the server to count a vault deployed from this page, with no wallet involved and nothing the
 * setup depends on: whatever happens here, the vault and every step of the page work the same.
 *
 * It asks once the agent key has its end date (readyToCount), and asks again when the setup reaches
 * its last screen, if the vault is not counted by then. A refusal that time may fix, such as a host
 * that has not caught up, is asked about once more by itself. The server treats a repeat of a counted
 * deploy as a no-op, so a reload costs nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../../../lib/api'
import { countableDeploy, readyToCount, vaultCountFromAnswer, type VaultCount } from '../../../lib/arc/vault-count'
import type { SetupState } from '../../../lib/arc/pending'

const AUTO_RETRY_MS = 15_000

export function useVaultCount(testnet: boolean, setup: SetupState | null, step: string): { count: VaultCount | null; countable: boolean; retry: () => void } {
  const hash = countableDeploy(testnet, setup)
  const [result, setResult] = useState<{ hash: string; count: VaultCount } | null>(null)
  const sent = useRef(new Set<string>())
  const autoRetried = useRef(new Set<string>())
  const sending = useRef(false)
  const count = result && result.hash === hash ? result.count : null

  const send = useCallback(async (deployTx: string) => {
    if (sending.current) return
    sending.current = true
    setResult({ hash: deployTx, count: { state: 'checking' } })
    let next: VaultCount
    try {
      const res = await apiFetch('/api/arc/vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deployTx }),
      })
      next = vaultCountFromAnswer(res.status, await readJson(res).catch(() => null))
    } catch {
      next = { state: 'failed', why: 'Our server could not be reached.' }
    }
    sending.current = false
    setResult({ hash: deployTx, count: next })
  }, [])

  const stage = hash && readyToCount(step) ? `${hash}:${step === 'done' ? 'done' : 'before-done'}` : null
  const counted = count?.state === 'counted'
  useEffect(() => {
    if (!hash || !stage || counted || sent.current.has(stage)) return
    sent.current.add(stage)
    void send(hash)
  }, [hash, stage, counted, send])

  const retryable = count?.state === 'not-counted' && count.retryable
  useEffect(() => {
    if (!hash || !retryable || autoRetried.current.has(hash)) return
    autoRetried.current.add(hash)
    const t = setTimeout(() => void send(hash), AUTO_RETRY_MS)
    return () => clearTimeout(t)
  }, [hash, retryable, send])

  const retry = useCallback(() => {
    if (hash) void send(hash)
  }, [hash, send])

  return { count, countable: hash !== null, retry }
}
