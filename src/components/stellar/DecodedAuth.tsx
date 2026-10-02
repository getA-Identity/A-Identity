import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { readTxEvidence, type DecodedSigner, type TxEvidence } from '../../lib/stellar/passkey-api'
import type { PasskeyNetwork } from '../../lib/stellar/passkey'
import { AddressLink, Chip } from './bits'

/**
 * What the transaction's authorization actually contains, decoded by the backend from the
 * ledger copy (D3.5, D3.6 display): which address authorized, for which call, and for each
 * signature its kind, verifier, the authenticator flags and the origin inside clientDataJSON.
 *
 * Shown with the caveat that bounds it. A WebAuthn signature proves a P-256 key signed a
 * challenge for a given origin with given flags; it does not prove the key lived in a
 * device, and the chain cannot tell a device passkey from a software key. The decoder route
 * belongs to another part of this product; when a deployment does not serve it yet, the
 * panel says so instead of failing, and when the route looked and the ledger copy is not
 * there yet, it retries and then says that instead.
 */
const DEFAULT_CAVEAT =
  'The chain verifies a P-256 signature over the authorization. It cannot tell a passkey in a device from a key in software; the flags and origin are what the authenticator reported, signed but unattested.'

const flagText = (f: NonNullable<DecodedSigner['authenticatorFlags']>) =>
  (['UP', 'UV', 'BE', 'BS', 'AT', 'ED'] as const).map((k) => `${k} ${f[k] ? '1' : '0'}`).join(', ')

const kindLabel: Record<DecodedSigner['kind'], string> = {
  'webauthn-secp256r1': 'WebAuthn passkey (secp256r1)',
  ed25519: 'Ed25519 key',
  delegated: 'delegated Stellar account',
  'account-ed25519': 'Stellar account signature (Ed25519)',
  unknown: 'unrecognized signer',
}

export default function DecodedAuth({ net, hash }: { net: PasskeyNetwork; hash: string }) {
  const [ev, setEv] = useState<TxEvidence | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      // A hash can reach us a moment before the decoder's ledger copy does, which the route
      // answers as not found yet; two short retries cover that, and a failed read alike.
      // Not found keeps the spinner until the last try, so it is only said once it held.
      const waits = [0, 3000, 5000]
      for (const [i, wait] of waits.entries()) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        if (!alive) return
        const r = await readTxEvidence(net, hash)
        if (!alive) return
        const last = i === waits.length - 1
        if (r.state === 'not-yet' && !last) continue
        setEv(r)
        if (r.state !== 'unavailable' && r.state !== 'not-yet') return
      }
    })()
    return () => {
      alive = false
    }
  }, [net, hash])

  if (!ev) {
    return (
      <p className="inline-flex items-center gap-2 text-xs text-foreground/55">
        <Loader2 size={12} className="animate-spin" /> Decoding the authorization from the ledger...
      </p>
    )
  }
  if (ev.state === 'absent') {
    return <p className="text-xs text-foreground/55">The transaction decoder is not available on this deployment yet. The explorer link above shows the raw authorization.</p>
  }
  if (ev.state === 'not-yet') {
    return (
      <p className="text-xs text-foreground/55">
        Not decoded: the decoder looked three times and did not find it yet. {ev.reason} The explorer link above shows the
        transaction once a ledger has it.
      </p>
    )
  }
  if (ev.state === 'unavailable') {
    return <p className="text-xs text-foreground/55">The authorization could not be decoded right now: {ev.reason}</p>
  }
  const status = ev.status?.toLowerCase() ?? null
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-background/40 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">What was signed</span>
        <Chip tone="muted">decoded from the ledger</Chip>
        {status && <Chip tone={status === 'success' ? 'ok' : status === 'failed' ? 'warn' : 'muted'}>{status}</Chip>}
      </div>
      {ev.summary && <p className="text-foreground/65">{ev.summary}</p>}
      {ev.auth.length === 0 && <p className="text-foreground/55">This transaction carries no address authorization.</p>}
      {ev.auth.map((a, i) => (
        <div key={i} className="grid gap-2 border-t border-border/60 pt-2 first:border-0 first:pt-0">
          {a.address && <AddressLink net={net} value={a.address} label="Authorized by" note={a.address.startsWith('C') ? '(smart account)' : undefined} />}
          <p className="text-foreground/60">
            For {a.rootInvocation.function ?? 'a call'} on <span className="break-all font-mono">{a.rootInvocation.contract ?? 'unknown contract'}</span>
            {a.signatureExpirationLedger !== null ? `, valid until ledger ${a.signatureExpirationLedger}` : ''}.
          </p>
          {a.signers.map((s, j) => (
            <div key={j} className="grid gap-0.5 text-foreground/65">
              <p>
                <span className="font-semibold text-foreground">Signature type:</span> {kindLabel[s.kind]}
              </p>
              {s.verifier && (
                <p>
                  Verifier: <span className="break-all font-mono">{s.verifier}</span>
                </p>
              )}
              {s.authenticatorFlags && <p>Authenticator flags: {flagText(s.authenticatorFlags)}</p>}
              {s.origin && <p>Origin: {s.origin}</p>}
              {s.clientDataType && <p>clientDataJSON type: {s.clientDataType}</p>}
              {s.signCount !== null && <p>Signature counter: {s.signCount}</p>}
            </div>
          ))}
        </div>
      ))}
      <p className="text-foreground/50">{ev.caveat ?? DEFAULT_CAVEAT}</p>
    </div>
  )
}
