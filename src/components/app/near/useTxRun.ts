/**
 * One owner transaction, from the wallet prompt to a FINAL outcome read from the chain.
 *
 * The wallet's own answer is never the verdict. Once it hands back a hash, the page asks the
 * registry's RPC hosts where that transaction stands, without waiting on any host's deadline,
 * until a host reports it FINAL; only then is it shown as executed, with what every receipt did.
 * A wallet that answers without a hash is said to have done so: the call may still land, and
 * the page cannot follow it. Polling stops after three minutes and says so, with a way to look
 * again, so a transaction that will never land cannot hold the card forever.
 *
 * Every hash is remembered for this vault in this browser (txlog.ts), so the Activity card can
 * read its events back after a reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '../../../lib/analytics'
import { txVerdict, type TxVerdict } from '../../../lib/near/abi'
import type { PreparedTx } from '../../../lib/near/calls'
import { NEAR_RPC_URLS } from '../../../lib/near/chain'
import { NearUnreachable, txStatus } from '../../../lib/near/rpc'
import { rememberTx } from '../../../lib/near/txlog'
import { hashOfWalletAnswer, walletErrorText } from '../../../lib/near/wallet'

const POLL_MS = 2_500
const GIVE_UP_MS = 180_000

export type TxRun =
  | { phase: 'idle' }
  | { phase: 'signing'; tx: PreparedTx }
  /** The wallet refused or was closed: nothing was sent. */
  | { phase: 'cancelled'; tx: PreparedTx; text: string }
  /** The wallet answered with no hash: it may have sent, and the page cannot follow it. */
  | { phase: 'no-hash'; tx: PreparedTx }
  | { phase: 'pending'; tx: PreparedTx; hash: string; signerId: string; seen: 'not-yet' | 'in-progress' | 'unreachable' }
  | { phase: 'final'; tx: PreparedTx; hash: string; signerId: string; outcome: unknown; verdict: TxVerdict }
  /** Not final after GIVE_UP_MS. It may still land. */
  | { phase: 'slow'; tx: PreparedTx; hash: string; signerId: string }

const methodOf = (tx: PreparedTx) => tx.actions[tx.actions.length - 1]?.params.methodName ?? 'unknown'

export function useTxRun({
  vaultId,
  signerId,
  send,
  onFinal,
}: {
  vaultId: string
  signerId: string | null
  send: (tx: PreparedTx) => Promise<unknown>
  /** Called once when a transaction from this run is final, so the page can read the vault again. */
  onFinal?: (outcome: unknown) => void
}) {
  const [run, setRun] = useState<TxRun>({ phase: 'idle' })
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal

  const start = useCallback(
    async (tx: PreparedTx) => {
      if (!signerId) return
      setRun({ phase: 'signing', tx })
      let answer: unknown
      try {
        answer = await send(tx)
      } catch (e) {
        const { text } = walletErrorText(e)
        track('near_vault_owner_action', { action: methodOf(tx), outcome: 'not_sent' })
        setRun({ phase: 'cancelled', tx, text })
        return
      }
      const hash = hashOfWalletAnswer(answer)
      if (!hash) {
        track('near_vault_owner_action', { action: methodOf(tx), outcome: 'no_hash' })
        setRun({ phase: 'no-hash', tx })
        return
      }
      rememberTx(vaultId, { hash, signerId, what: tx.what, at: new Date().toISOString() })
      track('near_vault_owner_action', { action: methodOf(tx), outcome: 'submitted' })
      setRun({ phase: 'pending', tx, hash, signerId, seen: 'not-yet' })
    },
    [send, signerId, vaultId],
  )

  const pendingHash = run.phase === 'pending' ? run.hash : null
  useEffect(() => {
    if (run.phase !== 'pending') return
    const { tx, hash, signerId: signer } = run
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const began = Date.now()
    const tick = async () => {
      if (!alive) return
      let seen: 'not-yet' | 'in-progress' | 'unreachable' = 'not-yet'
      try {
        const s = await txStatus(NEAR_RPC_URLS, hash, signer)
        if (!alive) return
        if (s.state === 'final') {
          const verdict = txVerdict(s.outcome)
          track('near_vault_owner_action', { action: methodOf(tx), outcome: verdict.ok ? 'final_ok' : 'final_failed' })
          setRun({ phase: 'final', tx, hash, signerId: signer, outcome: s.outcome, verdict })
          onFinalRef.current?.(s.outcome)
          return
        }
        seen = s.state === 'pending' ? 'in-progress' : 'not-yet'
      } catch (e) {
        // No host answered (or one answered nonsense): not a verdict about the transaction.
        seen = e instanceof NearUnreachable ? 'unreachable' : 'not-yet'
      }
      if (!alive) return
      if (Date.now() - began > GIVE_UP_MS) {
        setRun({ phase: 'slow', tx, hash, signerId: signer })
        return
      }
      setRun((r) => (r.phase === 'pending' && r.hash === hash && r.seen !== seen ? { ...r, seen } : r))
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    timer = setTimeout(() => void tick(), 1_000)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
    // Keyed by the hash: a change of `seen` within the same transaction must not restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHash])

  const reset = useCallback(() => setRun({ phase: 'idle' }), [])
  const lookAgain = useCallback(() => setRun((r) => (r.phase === 'slow' ? { ...r, phase: 'pending', seen: 'not-yet' } : r)), [])

  return { run, start, reset, lookAgain }
}
