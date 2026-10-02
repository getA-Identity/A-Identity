import { txUrl, type ChainWrite, type PasskeyNetwork } from '../../lib/stellar/passkey'
import type { FeePayerNamed } from '../../lib/stellar/passkey-api'
import { FullHash, TxLink } from './bits'
import DecodedAuth from './DecodedAuth'
import FeePayer from './FeePayer'

/**
 * The outcome of one chain write, in the vocabulary the rest of the product uses, and for a
 * settled one everything a reader needs to check it: the whole hash (copyable), its explorer
 * page, who paid the fee, and, for a passkey-signed write, the decoded authorization. A
 * pending one is submitted but unconfirmed, so it reads as pending with its hash, never as
 * a failure.
 */
export default function TxResult({
  net,
  write,
  what,
  feePayer,
  decode = true,
}: {
  net: PasskeyNetwork
  write: ChainWrite
  what: string
  feePayer?: FeePayerNamed | null
  /** Show the decoded authorization. Off for writes our operator signed, which carry none of the passkey's. */
  decode?: boolean
}) {
  if (write.outcome === 'settled') {
    return (
      <div className="grid gap-3">
        <p className="text-xs text-foreground/65">
          {what} settled{write.ledger ? ` in ledger ${write.ledger}` : ''}.
        </p>
        <FullHash hash={write.txHash} url={write.explorerUrl} />
        <FeePayer net={net} hash={write.txHash} named={feePayer} />
        {decode && (
          <details className="group">
            <summary className="cursor-pointer text-xs font-semibold text-accent">What your passkey signed, decoded</summary>
            <div className="mt-2">
              <DecodedAuth net={net} hash={write.txHash} />
            </div>
          </details>
        )}
      </div>
    )
  }
  if (write.outcome === 'prepared') {
    return <p className="text-xs text-warn">The fee sponsor is not configured on this deployment for this network, so nothing was submitted. {write.reason}</p>
  }
  if (write.outcome === 'refused') {
    return <p className="text-xs text-warn">{write.reason}</p>
  }
  if (write.outcome === 'pending') {
    return (
      <p className="text-xs text-warn">
        {what} was submitted and is not confirmed yet: {write.reason} Check the link before trying again.{' '}
        <TxLink hash={write.txHash} url={txUrl(net, write.txHash)} />
      </p>
    )
  }
  return (
    <p className="text-xs text-danger">
      {write.reason}
      {write.txHash ? (
        <>
          {' '}
          <TxLink hash={write.txHash} url={txUrl(net, write.txHash)} />
        </>
      ) : null}
    </p>
  )
}
