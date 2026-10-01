import { deviceClassLabel, providerLabel, type DeviceMeta } from '../../lib/stellar/passkey'

/**
 * Where the passkey lives, in the words the authenticator gave us (D3.3). Everything here
 * is self-reported at registration and unattested, so it is labelled as reported, and the
 * flags are shown raw beside the sentence so a reader can check the sentence.
 */
export default function DeviceSummary({ device, label }: { device: DeviceMeta | null; label?: string | null }) {
  if (!device) {
    return (
      <p className="text-xs leading-relaxed text-foreground/55">
        This browser did not record which authenticator made this passkey (it was made elsewhere, or before the page recorded
        it). The chain does not know either.
      </p>
    )
  }
  const f = device.flags
  return (
    <div className="grid gap-1.5 text-xs leading-relaxed text-foreground/65">
      <p>
        <span className="font-semibold text-foreground">Your passkey lives on {deviceClassLabel(device)}</span>
        {label ? <span className="text-foreground/55">, which you named "{label}"</span> : null}.
      </p>
      <p className="text-foreground/55">
        Provider: {providerLabel(device)}. Attachment: {device.attachment ?? 'not reported'}. Transports:{' '}
        {device.transports.length ? device.transports.join(', ') : 'not reported'}.
        {f ? ` Flags: backup eligible ${f.BE ? 'yes' : 'no'}, backed up ${f.BS ? 'yes' : 'no'}, user verified ${f.UV ? 'yes' : 'no'}.` : ' Flags: not reported.'}
      </p>
      <p className="text-foreground/45">As your device reported it at registration. Nothing here is attested, and the chain cannot see any of it.</p>
    </div>
  )
}
