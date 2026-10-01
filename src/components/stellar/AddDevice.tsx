import { useState } from 'react'
import { Loader2, Smartphone } from 'lucide-react'
import { PASSKEY_STEP_LABEL, addDevice, passkeyErrorMessage, type AddDeviceOutcome, type PasskeyNetwork, type PasskeyStep } from '../../lib/stellar/passkey'
import { BTN_QUIET, INPUT, LABEL } from './bits'
import DeviceSummary from './DeviceSummary'
import TxResult from './TxResult'

/**
 * "Add another device" (D3.8): a second passkey, on its own context rule, so either device
 * can sign alone.
 *
 * The rule is the point. The new key is NEVER added beside the first one on rule 0: a rule
 * with two signers and no policy needs both of them, which would make losing either device
 * fatal instead of survivable. The existing passkey authorizes the change, the relay pays
 * the fee, and the recovery badge re-reads the account afterwards.
 */
export default function AddDevice({ net, disabled, onAdded }: { net: PasskeyNetwork; disabled?: boolean; onAdded: () => void }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<PasskeyStep | null>(null)
  const [result, setResult] = useState<AddDeviceOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await addDevice(net, { label: label.trim() || null, onStep: setStep })
      setResult(r)
      if (r.ok) onAdded()
    } catch (e) {
      setError(passkeyErrorMessage(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-background/40 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Smartphone size={15} /> Add another device
      </div>
      <p className="text-[13px] leading-relaxed text-foreground/65">
        Creates a second passkey (on a phone, a security key or another password manager) and adds it to your smart account as
        its own rule, so either device can sign alone. Your current passkey approves the change. Two passkeys in the same
        synced password manager are one point of failure, not two, so pick a different one.
      </p>
      <div className="sm:max-w-[18rem]">
        <label className={LABEL} htmlFor="stellar-device-label">
          Name for the new device (optional)
        </label>
        <input
          id="stellar-device-label"
          type="text"
          maxLength={20}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="work laptop"
          className={INPUT}
          disabled={busy || disabled}
        />
      </div>
      <div>
        <button type="button" onClick={run} disabled={busy || disabled} className={BTN_QUIET}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? `${step ? PASSKEY_STEP_LABEL[step] : 'Working'}...` : 'Add another device'}
        </button>
      </div>
      {result && (
        <div className="grid gap-3">
          {result.ok && <p className="text-xs text-ok">Added as rule {result.ruleId}. Either device can now sign for this account on its own.</p>}
          {result.device && <DeviceSummary device={result.device} label={label.trim() || null} />}
          <TxResult net={net} write={result.write} what="The new rule" />
          {!result.ok && result.credentialId && (
            <p className="text-xs text-warn">
              The new passkey exists on that device, but it is not a signer of this account. You can delete it from the device's
              passkey settings, or try again.
            </p>
          )}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
