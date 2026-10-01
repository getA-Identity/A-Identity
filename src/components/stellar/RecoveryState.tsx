import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, KeyRound, Loader2, TriangleAlert } from 'lucide-react'
import { DOCS_URL, SOCIALS } from '../../lib/brand'
import { deviceClassLabel, passkeyErrorMessage, readSigners, type PasskeyNetwork, type SignerSnapshot } from '../../lib/stellar/passkey'
import { Chip } from './bits'

/**
 * The recovery position, said before the vault exists and kept on screen after (D3.3, D3.7).
 *
 * A passkey smart account has no seed phrase and no custodian. Whoever holds a device with
 * one of its passkeys can sign; nobody else can, including us. That is the property and
 * also the risk, so the page says it in its first sentence, gates the vault deploy on an
 * explicit "I understand", and then shows, for as long as the wallet exists, how many
 * devices can still sign.
 */

/** The full document. The docs site renders docs/chains/stellar-passkey-recovery.mdx. */
export const RECOVERY_DOC_URL = `${DOCS_URL}/chains/stellar-passkey-recovery`
export const RECOVERY_DOC_SOURCE = `${SOCIALS.github}/blob/main/docs/chains/stellar-passkey-recovery.mdx`

export const RECOVERY_FIRST_SENTENCE =
  'If you lose every device that holds this passkey, the funds in the vault become unreachable to you, and nobody, including A-Identity, can recover them.'

function DocLinks() {
  return (
    <span className="inline-flex flex-wrap gap-x-4 gap-y-1">
      <a href={RECOVERY_DOC_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
        The full recovery document <ArrowUpRight size={12} />
      </a>
      <a href={RECOVERY_DOC_SOURCE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground/55 underline-offset-2 hover:underline">
        its source in the repository <ArrowUpRight size={12} />
      </a>
    </span>
  )
}

/** Step 2 of enrollment: the plain-language position and the required acknowledgement. */
export function RecoveryNotice({ accepted, onAccept, realMoney, disabled }: { accepted: boolean; onAccept: (v: boolean) => void; realMoney: boolean; disabled?: boolean }) {
  return (
    <div className="rounded-xl border border-warn/35 bg-warn/[0.06] p-4">
      <p className="text-sm font-semibold leading-relaxed text-foreground">{RECOVERY_FIRST_SENTENCE}</p>
      <ul className="mt-3 grid gap-1.5 text-[13px] leading-relaxed text-foreground/70">
        <li>There is no seed phrase to write down. The passkey is the key, and it stays in the authenticator that made it (or in the password manager that syncs it).</li>
        <li>A synced passkey survives losing one phone; a passkey bound to one device or one security key does not. The page tells you which kind you made.</li>
        <li>Add a second device below once the account exists. Each device gets its own rule, so either one can sign alone.</li>
        <li>
          Our server holds the vault's operator key. It can call pay() inside the daily cap and per-payment ceiling, and once
          you turn the allowlist on (signing the limit does) only to payees you allowed. It cannot withdraw, change your limit,
          unfreeze the vault or add a signer.
        </li>
        {realMoney && <li>This is mainnet. The amounts are dust by design, and they are real.</li>}
      </ul>
      <p className="mt-3 text-xs">
        <DocLinks />
      </p>
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-foreground">
        <input
          type="checkbox"
          checked={accepted}
          disabled={disabled}
          onChange={(e) => onAccept(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        />
        <span>I understand. Losing every device with this passkey loses the vault's funds, and A-Identity cannot recover them.</span>
      </label>
    </div>
  )
}

/**
 * The permanent badge: how many passkeys can sign for this account, read live from its
 * context rules, with the single-device warning in the warn colour. `refreshKey` lets the
 * page ask for a re-read after adding a device.
 */
export function RecoveryBadge({ net, contractId, refreshKey }: { net: PasskeyNetwork; contractId: string; refreshKey: number }) {
  const [snap, setSnap] = useState<SignerSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const read = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setSnap(await readSigners(net))
    } catch (e) {
      setError(passkeyErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [net])

  useEffect(() => {
    void read()
  }, [read, contractId, refreshKey])

  const n = snap?.passkeys.length ?? null
  const single = n === 1
  return (
    <div className={`rounded-2xl border p-4 ${single ? 'border-warn/40 bg-warn/[0.05]' : 'border-border bg-card'}`} aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={15} className={single ? 'text-warn' : 'text-foreground/60'} />
        <span className="text-sm font-semibold text-foreground">Recovery</span>
        {loading && <Loader2 size={13} className="animate-spin text-foreground/50" />}
        {n !== null && <Chip tone={single ? 'warn' : 'ok'}>{n === 1 ? '1 device can sign' : `${n} devices can sign`}</Chip>}
        <Chip tone="muted">read live</Chip>
      </div>
      {single && (
        <p className="mt-2 flex items-start gap-2 text-[13px] font-semibold leading-relaxed text-warn">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          Single device: losing it loses access. Add another device below.
        </p>
      )}
      {snap && snap.passkeys.length > 0 && (
        <ul className="mt-2 grid gap-1 text-xs text-foreground/60">
          {snap.passkeys.map((p) => (
            <li key={`${p.ruleId}-${p.credentialId ?? 'x'}`}>
              Rule {p.ruleId} ({p.ruleName}): {p.label ? `"${p.label}", ` : ''}
              {p.thisBrowser ? deviceClassLabel(p.device) : 'a passkey this browser did not make'}
              {p.current ? ' (signed in now)' : ''}
            </li>
          ))}
        </ul>
      )}
      {snap && snap.otherSigners > 0 && (
        <p className="mt-2 text-xs text-warn">
          {snap.otherSigners} signer(s) on this account are not passkeys under this network's WebAuthn verifier. They can also sign.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-danger">The signers could not be read: {error}</p>}
      <p className="mt-2 text-xs">
        <DocLinks />
      </p>
    </div>
  )
}
