/**
 * Asks the server to count a vault deployed from this page, with no wallet involved and nothing the
 * setup depends on: whatever happens here, the vault and every step of the page work the same.
 *
 * It asks once the agent key has its end date (readyToCount), and asks again when the setup reaches
 * its last screen, if the vault is not counted by then. If the first question is still out when the
 * last screen comes up, the second goes out when the first comes back (shouldAsk). A refusal or a
 * failure that time may fix, such as a host that has not caught up, is asked about once more by
 * itself (askAgainByItself). The server treats a repeat of a counted deploy as a no-op, so a reload
 * costs nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../../../lib/api'
import { askAgainByItself, countableDeploy, readyToCount, shouldAsk, vaultCountFromAnswer, type VaultCount } from '../../../lib/arc/vault-count'
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
  // count is a dependency so a stage reached while a question was out is asked when that one comes back.
  useEffect(() => {
    if (!hash || !stage || !shouldAsk(stage, count, sent.current, sending.current)) return
    sent.current.add(stage)
    void send(hash)
  }, [hash, stage, count, send])

  // Used up only when the timer fires: a question sent for another reason in the meantime clears it.
  const askAgain = askAgainByItself(count)
  useEffect(() => {
    if (!hash || !askAgain || autoRetried.current.has(hash)) return
    const t = setTimeout(() => {
      autoRetried.current.add(hash)
      void send(hash)
    }, AUTO_RETRY_MS)
    return () => clearTimeout(t)
  }, [hash, askAgain, send])

  const retry = useCallback(() => {
    if (hash) void send(hash)
  }, [hash, send])

  return { count, countable: hash !== null, retry }
}
