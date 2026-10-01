/**
 * What a WebAuthn registration says about the authenticator that made it, in plain terms.
 *
 * The page names the device a passkey lives on (D3.3) from three things the browser hands
 * back at registration and nothing else: the authenticator attachment ("platform" or
 * "cross-platform"), the transports, and the authenticator data, whose flags carry the
 * backup bits (BE: this credential CAN be synced, BS: it IS synced right now) and whose
 * attested credential data carries the AAGUID, the authenticator model's id.
 *
 * All of it is self-reported by the authenticator and unattested here (the kit asks for no
 * attestation), so the page presents it as "what your device reported", never as proof.
 * The chain cannot tell any of it apart either: a WebAuthn signature verifies the same
 * whether the key sits in a secure element, a synced password manager or software.
 *
 * Pure and dependency-free, so it is safe in any bundle.
 */

export type AuthenticatorFlags = { UP: boolean; UV: boolean; BE: boolean; BS: boolean; AT: boolean; ED: boolean }

export type DeviceMeta = {
  /** 'platform' (built into this device), 'cross-platform' (a phone or key), or null when not reported. */
  attachment: 'platform' | 'cross-platform' | null
  transports: string[]
  /** Lowercase dashed AAGUID, or null when the authenticator data carried none. */
  aaguid: string | null
  /** The provider's name from the embedded list, or null when the AAGUID is zero or unlisted. */
  provider: string | null
  flags: AuthenticatorFlags | null
}

/**
 * Well-known passkey providers by AAGUID, each checked against the community list at
 * https://github.com/passkeydeveloper/passkey-authenticator-aaguids (aaguid.json, commit
 * abc4b5d2d7ff42604a47b6788e6323eb1133c7c2 of 2026-09-28). Only entries verified there are
 * included; anything else is shown as its raw AAGUID rather than a guessed name.
 */
export const KNOWN_AAGUIDS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple Passwords',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain (Managed)',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
}

export const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000'

function fromB64url(s: string): Uint8Array | null {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(norm + '==='.slice((norm.length + 3) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * The authData byte string out of a CBOR attestation object, for browsers whose response
 * lacks getAuthenticatorData(). Not a CBOR decoder: it finds the text key "authData" and
 * reads the byte-string header after it (major type 2 with a 1-, 2- or 4-byte length),
 * which is all an attestation object's shape requires.
 */
export function authDataFromAttestation(att: Uint8Array): Uint8Array | null {
  const key = [0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61] // text(8) "authData"
  outer: for (let i = 0; i + key.length < att.length; i += 1) {
    for (let j = 0; j < key.length; j += 1) if (att[i + j] !== key[j]) continue outer
    let p = i + key.length
    const head = att[p]
    let len: number
    if (head >= 0x40 && head <= 0x57) {
      len = head - 0x40
      p += 1
    } else if (head === 0x58) {
      len = att[p + 1]
      p += 2
    } else if (head === 0x59) {
      len = (att[p + 1] << 8) | att[p + 2]
      p += 3
    } else if (head === 0x5a) {
      len = ((att[p + 1] << 24) >>> 0) + (att[p + 2] << 16) + (att[p + 3] << 8) + att[p + 4]
      p += 5
    } else {
      return null
    }
    return p + len <= att.length ? att.slice(p, p + len) : null
  }
  return null
}

/** Flags byte and, when AT is set, the AAGUID, out of raw authenticator data. */
export function readAuthenticatorData(data: Uint8Array): { flags: AuthenticatorFlags; aaguid: string | null } | null {
  if (data.length < 37) return null
  const f = data[32]
  const flags: AuthenticatorFlags = {
    UP: Boolean(f & 0x01),
    UV: Boolean(f & 0x04),
    BE: Boolean(f & 0x08),
    BS: Boolean(f & 0x10),
    AT: Boolean(f & 0x40),
    ED: Boolean(f & 0x80),
  }
  let aaguid: string | null = null
  if (flags.AT && data.length >= 53) {
    const hex = Array.from(data.slice(37, 53), (b) => b.toString(16).padStart(2, '0')).join('')
    aaguid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return { flags, aaguid }
}

/** Read a registration response (RegistrationResponseJSON) into what the page shows. Never throws. */
export function describeRegistration(raw: unknown): DeviceMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { authenticatorAttachment?: unknown; response?: { transports?: unknown; authenticatorData?: unknown; attestationObject?: unknown } }
  const attachment = r.authenticatorAttachment === 'platform' || r.authenticatorAttachment === 'cross-platform' ? r.authenticatorAttachment : null
  const transports = Array.isArray(r.response?.transports) ? r.response!.transports.filter((t): t is string => typeof t === 'string') : []
  let data: Uint8Array | null = null
  if (typeof r.response?.authenticatorData === 'string') data = fromB64url(r.response.authenticatorData)
  if (!data && typeof r.response?.attestationObject === 'string') {
    const att = fromB64url(r.response.attestationObject)
    data = att ? authDataFromAttestation(att) : null
  }
  const parsed = data ? readAuthenticatorData(data) : null
  const aaguid = parsed?.aaguid ?? null
  return {
    attachment,
    transports,
    aaguid,
    provider: aaguid && aaguid !== ZERO_AAGUID ? (KNOWN_AAGUIDS[aaguid] ?? null) : null,
    flags: parsed?.flags ?? null,
  }
}

/**
 * The device in one phrase, from what it reported. A credential that is backed up and
 * synced (BE and BS) lives in a password manager and on every device that syncs it, which
 * matters more to recovery than where it was first made, so that is said first.
 */
export function deviceClassLabel(meta: DeviceMeta | null): string {
  if (!meta) return 'a passkey this browser did not record the details of'
  const t = new Set(meta.transports)
  if (meta.flags?.BE && meta.flags?.BS) {
    return `a synced passkey${meta.provider ? ` in ${meta.provider}` : ' (iCloud Keychain, Google Password Manager or a similar password manager)'}`
  }
  if (meta.attachment === 'platform' || (t.has('internal') && !t.has('hybrid'))) return 'this device (platform authenticator)'
  if (meta.attachment === 'cross-platform' || t.has('hybrid') || t.has('usb') || t.has('nfc') || t.has('ble')) {
    return t.has('hybrid') ? 'a phone (cross-device)' : 'a phone or security key (cross-device)'
  }
  return 'an authenticator that did not say where it is'
}

/** The provider line: a known name, the raw AAGUID, or that none was reported. */
export function providerLabel(meta: DeviceMeta | null): string {
  if (!meta || !meta.aaguid || meta.aaguid === ZERO_AAGUID) return 'provider not reported'
  return meta.provider ?? `unlisted provider (AAGUID ${meta.aaguid})`
}
