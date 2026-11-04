/**
 * Asks the server to count an owner's vault, with no wallet involved and nothing the page depends on:
 * whatever happens here, the vault and every step of the page work the same. The deploy flow and the
 * vault's own page both go through this, and each says when there is a question (stage: see
 * setupStage and vaultPageStage).
 *
 * If a question is still out when the next stage comes up, that one goes out when the first comes back
 * (shouldAsk). A refusal or a failure that time may fix, such as a host that has not caught up, is
 * asked about once more by itself (askAgainByItself). The server treats a repeat of a counted deploy as
 * a no-op, so a reload costs nothing. With no hash to ask about, what the page says comes from the list
 * it already read, and a list that did not load is said to have failed, never read as a no.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../../../lib/api'
import { askAgainByItself, shouldAsk, shownCount, vaultCountFromAnswer, type Listing, type VaultCount } from '../../../lib/arc/vault-count'

const AUTO_RETRY_MS = 15_000

const COUNTED: VaultCount = { state: 'counted' }

export function useVaultCount({
  hash,
  stage,
  listing,
  onReadListAgain,
}: {
  /** The deploy transaction, when this browser holds it. */
  hash: string | null
  /** The question to put now, or null while there is none. */
  stage: string | null
  listing: Listing
  onReadListAgain: () => void
}): { count: VaultCount; retry: () => void } {
  const [result, setResult] = useState<{ hash: string; count: VaultCount } | null>(null)
  const sent = useRef(new Set<string>())
  const autoRetried = useRef(new Set<string>())
  const sending = useRef(false)
  const asked = result && result.hash === hash ? result.count : null
  // A vault the list already holds is not asked about: the answer is known.
  const answer = listing === 'listed' ? COUNTED : asked

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

  // answer is a dependency so a stage reached while a question was out is asked when that one comes back.
  useEffect(() => {
    if (!hash || !stage || !shouldAsk(stage, answer, sent.current, sending.current)) return
    sent.current.add(stage)
    void send(hash)
  }, [hash, stage, answer, send])

  // Used up only when the timer fires: a question sent for another reason in the meantime clears it.
  const askAgain = askAgainByItself(answer)
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
    else onReadListAgain()
  }, [hash, send, onReadListAgain])

  return { count: shownCount(hash, stage, answer, listing), retry }
}
