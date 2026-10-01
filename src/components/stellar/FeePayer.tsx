import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { readFeePayer, type FeePayerNamed, type FeePayerRead } from '../../lib/stellar/passkey-api'
import type { PasskeyNetwork } from '../../lib/stellar/passkey'
import { AddressLink } from './bits'

/**
 * Who paid the network fee for one transaction, read off the ledger (D3.5).
 *
 * A passkey smart account is a contract and cannot pay a Stellar fee at all, so "you paid
 * nothing" is true by construction; what deserves showing is WHO paid. For a relayed owner
 * call that is the fee-bump's outer source, an account of OpenZeppelin Channels, our
 * relayer; for the vault deploy and the agent's pay() it is our operator account. Both are
 * read from the transaction, never assumed from the path, and the read retries for a few
 * seconds because a hash exists slightly before its ledger does.
 */
const WAITS_MS = [0, 2500, 3500, 5000]

export default function FeePayer({ net, hash, named }: { net: PasskeyNetwork; hash: string; named?: FeePayerNamed | null }) {
  const [read, setRead] = useState<FeePayerRead | null>(null)
  const [gaveUp, setGaveUp] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      for (const wait of WAITS_MS) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        if (!alive) return
        const r = await readFeePayer(net, hash)
        if (!alive) return
        setRead(r)
        if (r.state !== 'not-yet') return
      }
      if (alive) setGaveUp(true)
    })()
    return () => {
      alive = false
    }
  }, [net, hash])

  const who = (w: 'operator' | 'relayer') => (w === 'operator' ? "A-Identity's operator account" : 'OpenZeppelin Channels, the relayer')

  if (read?.state === 'found') {
    const xlm = read.feeChargedStroops ? Number(read.feeChargedStroops) / 1e7 : null
    return (
      <div className="grid gap-1.5 rounded-xl border border-border bg-background/40 p-3">
        <AddressLink net={net} value={read.feeAccount} label="Fee paid by" note={`(${who(read.who)}), read from the ledger`} />
        <p className="text-xs text-foreground/65">
          {xlm !== null ? `It paid ${xlm} XLM. ` : ''}Your smart account paid 0 XLM: a contract account cannot pay a Stellar fee, so someone else always does.
          {read.feeBump ? ' This was a fee-bump: the inner transaction ran under another account, and the outer one paid.' : ''}
        </p>
      </div>
    )
  }
  if (named) {
    return (
      <div className="grid gap-1.5 rounded-xl border border-border bg-background/40 p-3">
        <AddressLink net={net} value={named.account} label="Fee paid by" note={`(${who(named.who)}), as the server reported it`} />
        <p className="text-xs text-foreground/65">
          Your smart account paid 0 XLM.{' '}
          {read?.state === 'not-yet' ? 'The ledger read has not caught up yet.' : read?.state === 'unavailable' ? `The ledger read did not answer: ${read.reason}` : null}
        </p>
      </div>
    )
  }
  if (gaveUp) {
    return <p className="text-xs text-foreground/55">The ledger has not shown this transaction yet, so who paid its fee is not named here. Your smart account paid 0 XLM either way.</p>
  }
  if (!read || read.state === 'not-yet') {
    return (
      <p className="inline-flex items-center gap-2 text-xs text-foreground/55">
        <Loader2 size={12} className="animate-spin" /> Reading who paid the fee from the ledger...
      </p>
    )
  }
  return <p className="text-xs text-foreground/55">Who paid the fee could not be read right now ({read.reason}). Your smart account paid 0 XLM either way.</p>
}
