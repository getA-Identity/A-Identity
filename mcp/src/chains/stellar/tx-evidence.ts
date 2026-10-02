/**
 * Transaction evidence: fetch one Stellar transaction by hash and decode what it proves.
 *
 * A hash on a proof page is a claim that something happened. This module turns the hash back
 * into the facts a reviewer would otherwise dig out of XDR by hand: who paid the fee, which
 * contract and function were called with which arguments, whether it succeeded and, when it
 * did not, which typed contract error refused it, and for every Soroban authorization entry,
 * who authorized it and how. For an OpenZeppelin smart account that last part means the
 * signer map: which verifier, which public key, and for a WebAuthn passkey the
 * authenticator flags, the origin and the challenge the authenticator was shown.
 *
 * ## Where a transaction is read from, and why there are three places
 *
 * Soroban RPC is the primary source because it is the only one that still serves result
 * meta, and meta is where a failed call's contract error lives. But RPC keeps only about a
 * week of transactions, and every claim we publish is older than that within days. Horizon
 * keeps history back to the network's last reset, so it is the fallback for the envelope
 * and the result; it no longer serves meta at all. For meta past RPC's window the only
 * remaining source is an indexer, and the one used here is Stellar Expert's public API,
 * which is THIRD PARTY: its meta is accepted only when the envelope and result it serves
 * beside it are byte for byte the ones RPC or Horizon served, and it is labeled as indexer
 * data wherever it is used. Meta is not covered by the transaction hash, so that cross-check
 * is the most that can be said for it.
 *
 * Every host comes from the chain descriptor: `stellarRpcUrls` (env override first, then
 * the registry's list), `horizonUrls`, and the explorer, whose API answers on the `api.`
 * subdomain under the same path. Nothing here types a host.
 *
 * ## What the decode cannot tell you
 *
 * The ledger verifies a WebAuthn signature against a P-256 public key, and that is all it
 * can verify. A device authenticator and a software P-256 key in a script produce the same
 * bytes; the authenticator flags and the origin inside clientDataJSON are what whatever
 * produced the signature chose to report. The decode says so in `caveats` every time a
 * WebAuthn signer appears, because the 2026-09-19 rehearsal was exactly that case.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { Address, FeeBumpTransaction, StrKey, TransactionBuilder, scValToNative, xdr } from '@stellar/stellar-sdk'
import type { Transaction } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../types.js'
import { OWNER_METHODS, errorNameFor } from './adapter.js'
import { networkPassphrase, stellarRpcUrls } from './client.js'
import { isStellarTxHash } from './strkey.js'

// ── decoded shapes ───────────────────────────────────────────────────────────────

export type SignerKind = 'webauthn-secp256r1' | 'ed25519' | 'delegated' | 'account-ed25519' | 'unknown'

/** The WebAuthn assertion a passkey signer carried, decoded from the bytes the verifier read. */
export type WebAuthnEvidence = {
  authenticatorData: {
    hex: string
    rpIdHashHex: string
    /** True when rpIdHash is sha256 of the hostname in clientDataJSON's origin. */
    rpIdMatchesOrigin: boolean | null
    flagsByte: string
    flags: { UP: boolean; UV: boolean; BE: boolean; BS: boolean; AT: boolean; ED: boolean }
    signCount: number
  }
  clientDataJSON: { type: string | null; origin: string | null; challenge: string | null; crossOrigin: boolean | null; raw: string }
  signatureLength: number
  /**
   * Whether clientDataJSON's challenge is this entry's auth digest, recomputed here from the
   * entry itself. 'auth-digest' is OpenZeppelin's Protocol 27 construction,
   * sha256(signature_payload ++ scvVec(context_rule_ids).toXDR()); 'signature-payload' is the
   * bare Soroban payload. Either one binds the passkey's signature to exactly this call.
   */
  challengeBinding: 'auth-digest' | 'signature-payload' | 'no-match' | 'not-checked'
  /** A local re-verification of the P-256 signature over authenticatorData ++ sha256(clientDataJSON). */
  signatureVerifies: boolean | null
}

export type SignerEvidence = {
  kind: SignerKind
  /** The verifier contract, for an External signer. */
  verifier: string | null
  /** The public key the account stores for this signer, hex. For WebAuthn the 65-byte
   *  uncompressed P-256 point; the credential id that follows it is split out below. */
  publicKeyHex: string | null
  credentialIdHex: string | null
  /** A G... or C... address, for a Delegated signer or a classic account signature. */
  address: string | null
  signatureLength: number | null
  webauthn: WebAuthnEvidence | null
  note?: string
}

export type AuthEvidence = {
  credential: 'source_account' | 'address'
  /** The address that authorized. For a source-account credential, the transaction source. */
  address: string
  nonce: string | null
  signatureExpirationLedger: number | null
  rootInvocation: { contract: string | null; function: string; subInvocations: number }
  /** For an OpenZeppelin smart account, the context rule ids the signature was bound to. */
  contextRuleIds: number[] | null
  signers: SignerEvidence[]
  /** The digest the signers were checked against, hex, when it could be computed. */
  authDigestHex: string | null
}

export type OperationEvidence = {
  type: string
  /** The operation's own source, when it differs from the transaction's. */
  source: string | null
  contract: string | null
  function: string | null
  args: unknown[] | null
}

export type ContractErrorEvidence = {
  code: number
  /** The contract whose frame raised it, from the diagnostic events. */
  contract: string | null
  /** Named only from the AgentSpendPolicy table, and only under the condition `nameBasis` states. */
  name: string | null
  nameBasis: string
}

export type TxEvidence = {
  hash: string
  /** For a fee bump, the hash of the inner transaction; otherwise null. */
  innerHash: string | null
  status: 'success' | 'failed'
  resultCode: {
    tx: string
    /** For a fee bump, the inner transaction's result code. */
    inner: string | null
    operations: string[]
    contractError: ContractErrorEvidence | null
  }
  sourceAccount: string
  /** Who paid the fee: the fee-bump outer source when there is one, else the source. */
  feeAccount: string
  feeBump: boolean
  feeChargedStroops: string
  operations: OperationEvidence[]
  auth: AuthEvidence[]
  /** One paragraph for a reader who does not read XDR. */
  summary: string
  caveats: string[]
}

// ── small helpers ────────────────────────────────────────────────────────────────

/** scValToNative made JSON-safe: bigints as strings, bytes as hex. */
function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex')
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(x)
    return out
  }
  return v
}

function nativeArg(v: xdr.ScVal): unknown {
  try {
    return jsonSafe(scValToNative(v))
  } catch {
    return { scv: v.switch().name }
  }
}

function scAddressString(a: xdr.ScAddress): string {
  return Address.fromScAddress(a).toString()
}

function contractIdString(hash: Buffer | null | undefined): string | null {
  return hash ? StrKey.encodeContract(Buffer.from(hash)) : null
}

/** The head and tail of an address, so a sentence can end on one without a run of dots. */
function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a
}

function sha256(b: Buffer | Uint8Array | string): Buffer {
  return createHash('sha256').update(b).digest()
}

const VAULT_ENTRYPOINTS = new Set<string>(['pay', ...OWNER_METHODS])

// ── WebAuthn and signer decoding ─────────────────────────────────────────────────

/** authenticatorData: rpIdHash(32) | flags(1) | signCount(4, big-endian) | optional extras. */
function decodeAuthenticatorData(b: Buffer, origin: string | null): WebAuthnEvidence['authenticatorData'] | null {
  if (b.length < 37) return null
  const flags = b[32] as number
  let rpIdMatchesOrigin: boolean | null = null
  if (origin) {
    try {
      rpIdMatchesOrigin = sha256(new URL(origin).hostname).equals(b.subarray(0, 32))
    } catch {
      rpIdMatchesOrigin = null
    }
  }
  return {
    hex: b.toString('hex'),
    rpIdHashHex: b.subarray(0, 32).toString('hex'),
    rpIdMatchesOrigin,
    flagsByte: `0x${flags.toString(16).padStart(2, '0')}`,
    flags: {
      UP: Boolean(flags & 0x01),
      UV: Boolean(flags & 0x04),
      BE: Boolean(flags & 0x08),
      BS: Boolean(flags & 0x10),
      AT: Boolean(flags & 0x40),
      ED: Boolean(flags & 0x80),
    },
    signCount: b.readUInt32BE(33),
  }
}

/** A P-256 public key from its 65-byte uncompressed point, or null. */
function p256Key(point: Buffer) {
  if (point.length !== 65 || point[0] !== 0x04) return null
  try {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
      format: 'jwk',
    })
  } catch {
    return null
  }
}

/** An Ed25519 public key from its 32 raw bytes, through the fixed SPKI prefix. */
function ed25519Key(raw: Buffer) {
  if (raw.length !== 32) return null
  try {
    return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
  } catch {
    return null
  }
}

function mapField(m: xdr.ScVal, name: string): xdr.ScVal | undefined {
  if (m.switch().name !== 'scvMap') return undefined
  for (const e of m.map() ?? []) {
    const k = e.key()
    if (k.switch().name === 'scvSymbol' && k.sym().toString() === name) return e.val()
  }
  return undefined
}

function decodeWebAuthn(sigBytes: Buffer, pubPoint: Buffer, digests: { authDigest: Buffer | null; payload: Buffer | null }): WebAuthnEvidence | null {
  let inner: xdr.ScVal
  try {
    inner = xdr.ScVal.fromXDR(sigBytes)
  } catch {
    return null
  }
  const authData = mapField(inner, 'authenticator_data')
  const clientData = mapField(inner, 'client_data')
  const signature = mapField(inner, 'signature')
  if (!authData || !clientData || !signature) return null
  const ad = Buffer.from(authData.bytes())
  const cdRaw = Buffer.from(clientData.bytes())
  const sig = Buffer.from(signature.bytes())
  const cdText = cdRaw.toString('utf8')
  let cd: Record<string, unknown> = {}
  try {
    cd = JSON.parse(cdText) as Record<string, unknown>
  } catch {
    cd = {}
  }
  const str = (k: string) => (typeof cd[k] === 'string' ? (cd[k] as string) : null)
  const origin = str('origin')
  const challenge = str('challenge')
  const authenticatorData = decodeAuthenticatorData(ad, origin)
  if (!authenticatorData) return null

  let challengeBinding: WebAuthnEvidence['challengeBinding'] = 'not-checked'
  if (challenge && (digests.authDigest || digests.payload)) {
    if (digests.authDigest && challenge === digests.authDigest.toString('base64url')) challengeBinding = 'auth-digest'
    else if (digests.payload && challenge === digests.payload.toString('base64url')) challengeBinding = 'signature-payload'
    else challengeBinding = 'no-match'
  }

  let signatureVerifies: boolean | null = null
  const key = p256Key(pubPoint)
  if (key && sig.length === 64) {
    try {
      signatureVerifies = cryptoVerify('sha256', Buffer.concat([ad, sha256(cdRaw)]), { key, dsaEncoding: 'ieee-p1363' }, sig)
    } catch {
      signatureVerifies = null
    }
  }

  return {
    authenticatorData,
    clientDataJSON: {
      type: str('type'),
      origin,
      challenge,
      crossOrigin: typeof cd.crossOrigin === 'boolean' ? cd.crossOrigin : null,
      raw: cdText,
    },
    signatureLength: sig.length,
    challengeBinding,
    signatureVerifies,
  }
}

/**
 * The OpenZeppelin smart-account signature: a map of `context_rule_ids` and `signers`, where
 * each signer key is `External(verifier, key_data)` or `Delegated(address)` and each value is
 * the bytes that signer contributed.
 */
function decodeOzSigners(
  sig: xdr.ScVal,
  chain: ChainDescriptor | undefined,
  digests: { authDigest: Buffer | null; payload: Buffer | null },
): SignerEvidence[] {
  const signers = mapField(sig, 'signers')
  if (!signers || signers.switch().name !== 'scvMap') return []
  const sa = chain?.contracts.smartAccount
  const out: SignerEvidence[] = []
  for (const e of signers.map() ?? []) {
    const key = e.key()
    const val = e.val()
    const vec = key.switch().name === 'scvVec' ? (key.vec() ?? []) : []
    const tag = vec[0] && vec[0].switch().name === 'scvSymbol' ? vec[0].sym().toString() : null
    const valBytes = val.switch().name === 'scvBytes' ? Buffer.from(val.bytes()) : null

    if (tag === 'Delegated' && vec[1] && vec[1].switch().name === 'scvAddress') {
      out.push({
        kind: 'delegated',
        verifier: null,
        publicKeyHex: null,
        credentialIdHex: null,
        address: scAddressString(vec[1].address()),
        signatureLength: valBytes ? valBytes.length : null,
        webauthn: null,
        note: 'A Delegated signer contributes no bytes here; its authorization is a nested require_auth on the delegated address.',
      })
      continue
    }
    if (tag === 'External' && vec[1] && vec[1].switch().name === 'scvAddress' && vec[2] && vec[2].switch().name === 'scvBytes') {
      const verifier = scAddressString(vec[1].address())
      const keyData = Buffer.from(vec[2].bytes())
      if (sa && (verifier === sa.webauthnVerifier || (sa.formerWebauthnVerifiers ?? []).includes(verifier))) {
        const point = keyData.subarray(0, 65)
        out.push({
          kind: 'webauthn-secp256r1',
          verifier,
          publicKeyHex: point.toString('hex'),
          credentialIdHex: keyData.length > 65 ? keyData.subarray(65).toString('hex') : null,
          address: null,
          signatureLength: valBytes ? valBytes.length : null,
          webauthn: valBytes ? decodeWebAuthn(valBytes, point, digests) : null,
        })
        continue
      }
      if (sa && (verifier === sa.ed25519Verifier || (sa.formerEd25519Verifiers ?? []).includes(verifier))) {
        let ok: boolean | null = null
        const k = ed25519Key(keyData)
        if (k && valBytes && valBytes.length === 64 && digests.authDigest) {
          try {
            ok = cryptoVerify(null, digests.authDigest, k, valBytes)
          } catch {
            ok = null
          }
        }
        out.push({
          kind: 'ed25519',
          verifier,
          publicKeyHex: keyData.toString('hex'),
          credentialIdHex: null,
          address: keyData.length === 32 ? StrKey.encodeEd25519PublicKey(keyData) : null,
          signatureLength: valBytes ? valBytes.length : null,
          webauthn: null,
          ...(ok === null ? {} : { note: ok ? 'The Ed25519 signature verifies over the auth digest.' : 'The Ed25519 signature does NOT verify over the recomputed auth digest.' }),
        })
        continue
      }
      out.push({
        kind: 'unknown',
        verifier,
        publicKeyHex: keyData.toString('hex'),
        credentialIdHex: null,
        address: null,
        signatureLength: valBytes ? valBytes.length : null,
        webauthn: null,
        note: sa
          ? 'An External signer whose verifier is neither of the OpenZeppelin verifiers the registry records for this network.'
          : 'No OpenZeppelin smart-account constants are recorded for this network, so the verifier cannot be named.',
      })
      continue
    }
    out.push({
      kind: 'unknown',
      verifier: null,
      publicKeyHex: null,
      credentialIdHex: null,
      address: null,
      signatureLength: valBytes ? valBytes.length : null,
      webauthn: null,
      note: `Signer key of shape ${key.switch().name}${tag ? ` (${tag})` : ''} is not one this decoder knows.`,
    })
  }
  return out
}

/** A classic account's address credential: a vec of { public_key, signature } maps. */
function decodeAccountSigners(sig: xdr.ScVal): SignerEvidence[] {
  if (sig.switch().name !== 'scvVec') return []
  const out: SignerEvidence[] = []
  for (const m of sig.vec() ?? []) {
    const pk = mapField(m, 'public_key')
    const s = mapField(m, 'signature')
    if (!pk || pk.switch().name !== 'scvBytes') continue
    const raw = Buffer.from(pk.bytes())
    out.push({
      kind: 'account-ed25519',
      verifier: null,
      publicKeyHex: raw.toString('hex'),
      credentialIdHex: null,
      address: raw.length === 32 ? StrKey.encodeEd25519PublicKey(raw) : null,
      signatureLength: s && s.switch().name === 'scvBytes' ? s.bytes().length : null,
      webauthn: null,
    })
  }
  return out
}

function invocationLabel(inv: xdr.SorobanAuthorizedInvocation): { contract: string | null; function: string } {
  const f = inv.function()
  const kind = f.switch().name
  if (kind === 'sorobanAuthorizedFunctionTypeContractFn') {
    const c = f.contractFn()
    return { contract: scAddressString(c.contractAddress()), function: c.functionName().toString() }
  }
  return { contract: null, function: kind.includes('CreateContract') ? '(create contract)' : kind }
}

function decodeAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  txSource: string,
  passphrase: string,
  chain: ChainDescriptor | undefined,
): AuthEvidence {
  const root = entry.rootInvocation()
  const rootInvocation = { ...invocationLabel(root), subInvocations: root.subInvocations().length }
  const creds = entry.credentials()
  if (creds.switch().name !== 'sorobanCredentialsAddress') {
    return {
      credential: 'source_account',
      address: txSource,
      nonce: null,
      signatureExpirationLedger: null,
      rootInvocation,
      contextRuleIds: null,
      signers: [],
      authDigestHex: null,
    }
  }
  const a = creds.address()
  const address = scAddressString(a.address())
  const sig = a.signature()

  // The Soroban signature payload, recomputed from the entry itself, and OpenZeppelin's auth
  // digest over it. Recomputing rather than trusting is the point: a challenge that matches
  // means the passkey signed exactly this invocation at exactly this nonce.
  let payload: Buffer | null = null
  try {
    const pre = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: sha256(passphrase),
        nonce: a.nonce(),
        signatureExpirationLedger: a.signatureExpirationLedger(),
        invocation: root,
      }),
    )
    payload = sha256(pre.toXDR())
  } catch {
    payload = null
  }
  const ruleIds = mapField(sig, 'context_rule_ids')
  const contextRuleIds =
    ruleIds && ruleIds.switch().name === 'scvVec' ? (ruleIds.vec() ?? []).map((v) => Number(nativeArg(v))) : null
  const authDigest = payload && ruleIds ? sha256(Buffer.concat([payload, ruleIds.toXDR()])) : null

  const signers = mapField(sig, 'signers') ? decodeOzSigners(sig, chain, { authDigest, payload }) : decodeAccountSigners(sig)
  return {
    credential: 'address',
    address,
    nonce: a.nonce().toString(),
    signatureExpirationLedger: a.signatureExpirationLedger(),
    rootInvocation,
    contextRuleIds,
    signers,
    authDigestHex: (authDigest ?? payload)?.toString('hex') ?? null,
  }
}

// ── result and meta decoding ─────────────────────────────────────────────────────

function opResultCodes(results: xdr.OperationResult[] | undefined): string[] {
  return (results ?? []).map((r) => {
    if (r.switch().name !== 'opInner') return r.switch().name
    try {
      return (r.tr().value() as { switch(): { name: string } }).switch().name
    } catch {
      return r.tr().switch().name
    }
  })
}

/** Every diagnostic event a meta (v3 or v4) carries, plus any RPC served separately. */
function diagnosticEvents(metaXdr: string | null | undefined, extra: string[] = []): xdr.DiagnosticEvent[] {
  const out: xdr.DiagnosticEvent[] = []
  if (metaXdr) {
    try {
      const meta = xdr.TransactionMeta.fromXDR(metaXdr, 'base64')
      const v = meta.switch() as unknown as number
      if (v === 4) out.push(...(meta.v4().diagnosticEvents() ?? []))
      else if (v === 3) out.push(...(meta.v3().sorobanMeta()?.diagnosticEvents() ?? []))
    } catch {
      // A meta this SDK cannot parse leaves the error unnamed rather than guessed.
    }
  }
  for (const e of extra) {
    try {
      out.push(xdr.DiagnosticEvent.fromXDR(e, 'base64'))
    } catch {
      // Same: skip what will not parse.
    }
  }
  return out
}

/**
 * The contract error a failed call raised, from its diagnostic events.
 *
 * The result XDR cannot carry it: a trapped host function reports only that it trapped. The
 * `error` events can, and the one that names the code with a contract id is the raiser.
 * Diagnostic events are in emission order, oldest first: the frame that raises a code emits
 * its `error` event first, and every caller re-emits the same code under its own contract id
 * as it unwinds. So the FIRST contract-scoped `error` event is the origin, the same rule
 * adapter.ts failureErrorIn applies. A token refusing inside a vault call is reported as the
 * token, never as the vault.
 */
function contractErrorFrom(events: xdr.DiagnosticEvent[]): { code: number; contract: string | null } | null {
  let found: { code: number; contract: string | null } | null = null
  for (const d of events) {
    const ev = d.event()
    let topics: xdr.ScVal[] = []
    try {
      topics = ev.body().v0().topics()
    } catch {
      continue
    }
    const first = topics[0]
    if (!first || first.switch().name !== 'scvSymbol') continue
    const label = first.sym().toString()
    if (label !== 'error' && label !== 'host_fn_failed') continue
    const t = topics[1]
    if (!t || t.switch().name !== 'scvError') continue
    const err = t.error()
    if (err.switch().name !== 'sceContract') continue
    const code = Number(err.contractCode())
    const contract = contractIdString(ev.contractId() as Buffer | null)
    if (label === 'error' && contract) return { code, contract }
    if (!found) found = { code, contract }
  }
  return found
}

// ── the decoder ──────────────────────────────────────────────────────────────────

export type DecodeOptions = {
  /** The chain the transaction is on, for the OpenZeppelin verifier constants. */
  chain?: ChainDescriptor
  /** Diagnostic events RPC served beside the meta rather than inside it. */
  diagnosticEventsXdr?: string[]
}

export function decodeTxEvidence(
  envelopeXdr: string,
  resultXdr: string,
  metaXdr: string | null | undefined,
  passphrase: string,
  opts: DecodeOptions = {},
): TxEvidence {
  const parsed = TransactionBuilder.fromXDR(envelopeXdr, passphrase)
  const feeBump = parsed instanceof FeeBumpTransaction
  const inner: Transaction = feeBump ? (parsed as FeeBumpTransaction).innerTransaction : (parsed as Transaction)
  const hash = parsed.hash().toString('hex')
  const innerHash = feeBump ? inner.hash().toString('hex') : null
  const sourceAccount = inner.source
  const feeAccount = feeBump ? (parsed as FeeBumpTransaction).feeSource : inner.source

  const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64')
  const feeChargedStroops = result.feeCharged().toString()
  const r = result.result()
  const txCode = r.switch().name
  let innerCode: string | null = null
  let opResults: xdr.OperationResult[] | undefined
  if (txCode === 'txFeeBumpInnerSuccess' || txCode === 'txFeeBumpInnerFailed') {
    const ir = r.innerResultPair().result().result()
    innerCode = ir.switch().name
    try {
      opResults = ir.results()
    } catch {
      opResults = undefined
    }
  } else {
    try {
      opResults = r.results()
    } catch {
      opResults = undefined
    }
  }
  const success = txCode === 'txSuccess' || txCode === 'txFeeBumpInnerSuccess'

  const operations: OperationEvidence[] = inner.operations.map((op) => {
    const base = { type: op.type as string, source: op.source && op.source !== sourceAccount ? op.source : null }
    if (op.type === 'invokeHostFunction') {
      const func = (op as unknown as { func: xdr.HostFunction }).func
      if (func.switch().name === 'hostFunctionTypeInvokeContract') {
        const ic = func.invokeContract()
        return {
          ...base,
          contract: scAddressString(ic.contractAddress()),
          function: ic.functionName().toString(),
          args: ic.args().map(nativeArg),
        }
      }
      return { ...base, contract: null, function: func.switch().name, args: null }
    }
    return { ...base, contract: null, function: null, args: null }
  })

  const auth: AuthEvidence[] = []
  for (const op of inner.operations) {
    if (op.type !== 'invokeHostFunction') continue
    for (const entry of (op as unknown as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? []) {
      auth.push(decodeAuthEntry(entry, op.source ?? sourceAccount, passphrase, opts.chain))
    }
  }

  // The contract error, named only when that is honest: the raiser is the contract the
  // operation called and the function is an AgentSpendPolicy entrypoint, which is the only
  // error table this repo owns. A code from any other contract is reported as a number.
  let contractError: ContractErrorEvidence | null = null
  if (!success) {
    const found = contractErrorFrom(diagnosticEvents(metaXdr, opts.diagnosticEventsXdr))
    if (found) {
      const target = operations.find((o) => o.contract)
      const vaultCall = Boolean(target && target.function && VAULT_ENTRYPOINTS.has(target.function))
      const sameContract = Boolean(target && found.contract === target.contract)
      // errorNameFor also checks the code is one this entrypoint can raise: a #10 against a
      // pay is not OwnerIsOperator, it is a code our table does not describe for that call.
      const name =
        vaultCall && target?.function ? (errorNameFor(target.function, { code: found.code, ours: sameContract }) ?? null) : null
      contractError = {
        code: found.code,
        contract: found.contract,
        name,
        nameBasis: name
          ? 'Named from the AgentSpendPolicy error table (soroban/contracts/agent-spend-policy/src/error.rs): the called function is a vault entrypoint and the called contract raised the code. The contract\'s wasm was not re-read here.'
          : 'Not named: the raiser is not the called contract, the function is not an AgentSpendPolicy entrypoint, or that entrypoint cannot raise this code, so no error table this repo owns defines it here.',
      }
    }
  }

  const caveats: string[] = []
  const anyWebAuthn = auth.some((a) => a.signers.some((s) => s.kind === 'webauthn-secp256r1'))
  if (anyWebAuthn) {
    caveats.push(
      'The chain verifies a P-256 signature and cannot tell a device authenticator from a software P-256 key. The authenticator flags and the origin are what the authenticator, or whatever produced the signature, reported; a script can set both.',
    )
  }
  if (!success && !contractError && !metaXdr && !(opts.diagnosticEventsXdr ?? []).length) {
    caveats.push('No result meta was available, so a contract error code, if there was one, cannot be recovered from the result XDR alone.')
  }

  const summary = summarize({ hash, success, txCode, operations, auth, feeAccount, sourceAccount, feeBump, feeChargedStroops, contractError })

  return {
    hash,
    innerHash,
    status: success ? 'success' : 'failed',
    resultCode: { tx: txCode, inner: innerCode, operations: opResultCodes(opResults), contractError },
    sourceAccount,
    feeAccount,
    feeBump,
    feeChargedStroops,
    operations,
    auth,
    summary,
    caveats,
  }
}

function stroopsToXlm(s: string): string {
  const n = BigInt(s)
  const whole = n / 10_000_000n
  const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

function summarize(x: {
  hash: string
  success: boolean
  txCode: string
  operations: OperationEvidence[]
  auth: AuthEvidence[]
  feeAccount: string
  sourceAccount: string
  feeBump: boolean
  feeChargedStroops: string
  contractError: ContractErrorEvidence | null
}): string {
  const parts: string[] = []
  const call = x.operations.find((o) => o.contract && o.function)
  if (call) {
    const args = call.args ?? []
    // A smart account's execute(target, fn, args) forwards a call; say what it forwarded.
    if (call.function === 'execute' && typeof args[0] === 'string' && typeof args[1] === 'string') {
      parts.push(`Called ${args[1]} on ${short(args[0])} through execute on ${short(call.contract as string)}.`)
    } else {
      parts.push(`Called ${call.function} on ${short(call.contract as string)}.`)
    }
  } else if (x.operations.length) {
    parts.push(`${x.operations.length === 1 ? 'One' : x.operations.length} ${x.operations.map((o) => o.type).join(', ')} operation${x.operations.length === 1 ? '' : 's'}.`)
  }
  for (const a of x.auth) {
    if (a.credential === 'source_account') {
      parts.push(`Authorized by ${short(a.address)} as the transaction source, so its signature on the whole transaction is the authorization.`)
      continue
    }
    const kinds = a.signers.map((s) => {
      if (s.kind === 'webauthn-secp256r1') {
        const w = s.webauthn
        const flags = w ? Object.entries(w.authenticatorData.flags).filter(([, on]) => on).map(([k]) => k).join(', ') : ''
        return `a WebAuthn (secp256r1) passkey signature${w ? ` (flags ${flags || 'none'}${w.clientDataJSON.origin ? `, origin ${w.clientDataJSON.origin}` : ''})` : ''}`
      }
      if (s.kind === 'ed25519') return 'an Ed25519 key through the OpenZeppelin verifier'
      if (s.kind === 'delegated') return `a delegated signer ${short(s.address ?? '')}`
      if (s.kind === 'account-ed25519') return `the account key ${short(s.address ?? '')}`
      return 'a signer this decoder does not recognize'
    })
    const who = a.address.startsWith('C') && a.signers.some((s) => s.kind !== 'account-ed25519') ? 'smart account' : 'address'
    parts.push(`Authorized by ${who} ${short(a.address)}${kinds.length ? ` with ${kinds.join(' and ')}` : ''}.`)
  }
  parts.push(
    `Fee ${stroopsToXlm(x.feeChargedStroops)} XLM paid by ${short(x.feeAccount)}${x.feeBump ? ` through a fee bump, for a transaction whose source is ${short(x.sourceAccount)}` : ''}.`,
  )
  if (x.success) parts.push('It succeeded.')
  else if (x.contractError) {
    parts.push(
      `It failed: the contract refused it with error ${x.contractError.code}${x.contractError.name ? ` (${x.contractError.name})` : ''}, and the fee was still charged.`,
    )
  } else parts.push(`It failed (${x.txCode}), and the fee was still charged.`)
  return parts.join(' ')
}

// ── fetching ─────────────────────────────────────────────────────────────────────

/** The one network seam. Tests pass a fake; production uses global fetch with a timeout. */
export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

export type SourceAttempt = {
  source: 'rpc' | 'horizon' | 'indexer'
  host: string
  outcome: 'found' | 'not-found' | 'unreachable' | 'mismatch'
  detail?: string
}

export type TxRecord = {
  hash: string
  chainId: string
  network: string
  status: 'SUCCESS' | 'FAILED'
  ledger: number | null
  createdAt: string | null
  envelopeXdr: string
  resultXdr: string
  resultMetaXdr: string | null
  metaFrom: 'rpc' | 'stellar-expert' | null
  metaNote: string | null
  diagnosticEventsXdr: string[]
  fetchedFrom: 'rpc' | 'horizon'
  host: string
  tried: SourceAttempt[]
}

export type FetchTxResult =
  | { ok: true; record: TxRecord; evidence: TxEvidence }
  | { ok: false; code: 'bad_request' | 'not_found' | 'read_failed'; reason: string; tried: SourceAttempt[] }

export type FetchDeps = {
  fetch?: HttpFetch
  env?: NodeJS.ProcessEnv
  /** Ask the third-party indexer for meta when neither RPC nor Horizon has it. Default true. */
  indexerMeta?: boolean
  timeoutMs?: number
  /** Pause before re-asking Horizon after a 404. Tests pass 0. */
  retryDelayMs?: number
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function defaultFetch(timeoutMs: number): HttpFetch {
  return async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, json: () => res.json() as Promise<unknown> }
  }
}

/**
 * The indexer's API base, derived from the registry's explorer: Stellar Expert serves its
 * JSON API on the `api.` subdomain under the same path as the web explorer, which is the
 * route explorer.ts already verified its link shapes against. Null for a non-Stellar chain
 * or one with no explorer, so the derivation is never applied to an explorer it was not
 * checked against.
 */
export function indexerApiBase(chain: ChainDescriptor): string | null {
  if (chain.ecosystem !== 'stellar' || !chain.explorer) return null
  try {
    const u = new URL(chain.explorer)
    return `${u.protocol}//api.${u.host}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return null
  }
}

type RpcTx = {
  status?: string
  ledger?: number
  createdAt?: string | number
  envelopeXdr?: string
  resultXdr?: string
  resultMetaXdr?: string
  diagnosticEventsXdr?: string[]
  events?: { diagnosticEventsXdr?: string[] }
}

type HorizonTx = {
  hash?: string
  ledger?: number
  created_at?: string
  successful?: boolean
  envelope_xdr?: string
  result_xdr?: string
}

const isoFromUnix = (v: unknown): string | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

/**
 * Fetch one transaction and decode it.
 *
 * Order: every RPC host the chain declares, then every Horizon host, then (meta only) the
 * indexer. A host that does not answer is skipped; a host that answers "not found" is
 * recorded and the next source is asked, because RPC's not-found usually means "older than
 * my window", not "never happened". The answer is `not_found` only when some source answered
 * and none had it, and `read_failed` when no source answered at all, because "we could not
 * ask" and "it does not exist" are different claims.
 *
 * The envelope is checked against the hash asked for before anything is decoded: a host that
 * served a different transaction is a mismatch, not evidence.
 */
export async function fetchTxEvidence(chain: ChainDescriptor, hashIn: string, deps: FetchDeps = {}): Promise<FetchTxResult> {
  const hash = String(hashIn ?? '').trim().toLowerCase()
  const tried: SourceAttempt[] = []
  if (chain.ecosystem !== 'stellar') return { ok: false, code: 'bad_request', reason: `${chain.id} is not a Stellar chain`, tried }
  if (!isStellarTxHash(hash)) return { ok: false, code: 'bad_request', reason: 'hash must be 64 lowercase hex characters', tried }
  const passphrase = networkPassphrase(chain)
  const http = deps.fetch ?? defaultFetch(deps.timeoutMs ?? 10_000)

  let found: Omit<TxRecord, 'tried' | 'chainId' | 'network' | 'hash'> | null = null

  /** True when the envelope hashes to what was asked for (the outer or, for a fee bump, the inner hash). */
  const envelopeIs = (env: string): boolean => {
    try {
      const p = TransactionBuilder.fromXDR(env, passphrase)
      if (p.hash().toString('hex') === hash) return true
      return p instanceof FeeBumpTransaction && p.innerTransaction.hash().toString('hex') === hash
    } catch {
      return false
    }
  }

  for (const url of stellarRpcUrls(chain, deps.env)) {
    const host = hostOf(url)
    try {
      const res = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
      })
      if (res.status !== 200) {
        tried.push({ source: 'rpc', host, outcome: 'unreachable', detail: `HTTP ${res.status}` })
        continue
      }
      const body = (await res.json()) as { result?: RpcTx; error?: { message?: string } }
      const r = body.result
      if (!r || body.error) {
        tried.push({ source: 'rpc', host, outcome: 'unreachable', detail: body.error?.message ?? 'no result' })
        continue
      }
      if (r.status === 'NOT_FOUND' || !r.envelopeXdr || !r.resultXdr) {
        tried.push({ source: 'rpc', host, outcome: 'not-found', detail: 'outside this host\'s retention window, or never submitted' })
        continue
      }
      if (!envelopeIs(r.envelopeXdr)) {
        tried.push({ source: 'rpc', host, outcome: 'mismatch', detail: 'served an envelope that does not hash to the requested hash' })
        continue
      }
      tried.push({ source: 'rpc', host, outcome: 'found' })
      found = {
        status: r.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
        ledger: typeof r.ledger === 'number' ? r.ledger : null,
        createdAt: isoFromUnix(r.createdAt),
        envelopeXdr: r.envelopeXdr,
        resultXdr: r.resultXdr,
        resultMetaXdr: r.resultMetaXdr ?? null,
        metaFrom: r.resultMetaXdr ? 'rpc' : null,
        metaNote: r.resultMetaXdr ? null : 'RPC returned the transaction without result meta.',
        diagnosticEventsXdr: r.events?.diagnosticEventsXdr ?? r.diagnosticEventsXdr ?? [],
        fetchedFrom: 'rpc',
        host,
      }
      break
    } catch (e) {
      tried.push({ source: 'rpc', host, outcome: 'unreachable', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  if (!found) {
    for (const base of chain.horizonUrls ?? []) {
      const host = hostOf(base)
      try {
        const url = `${base.replace(/\/$/, '')}/transactions/${hash}`
        let res = await http(url)
        // A public Horizon is a pool of nodes, and on 2026-10-01 five transactions that one
        // archive run was told were 404 all came back 200 a minute later. One retry before
        // "not found" is the difference between a claim we can back and one we drop.
        if (res.status === 404) {
          await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1500))
          res = await http(url)
        }
        if (res.status === 404) {
          tried.push({ source: 'horizon', host, outcome: 'not-found' })
          continue
        }
        if (res.status !== 200) {
          tried.push({ source: 'horizon', host, outcome: 'unreachable', detail: `HTTP ${res.status}` })
          continue
        }
        const h = (await res.json()) as HorizonTx
        if (!h.envelope_xdr || !h.result_xdr || !envelopeIs(h.envelope_xdr)) {
          tried.push({ source: 'horizon', host, outcome: 'mismatch', detail: 'served an envelope that does not hash to the requested hash' })
          continue
        }
        tried.push({ source: 'horizon', host, outcome: 'found' })
        found = {
          status: h.successful ? 'SUCCESS' : 'FAILED',
          ledger: typeof h.ledger === 'number' ? h.ledger : null,
          createdAt: h.created_at ? new Date(h.created_at).toISOString() : null,
          envelopeXdr: h.envelope_xdr,
          resultXdr: h.result_xdr,
          resultMetaXdr: null,
          metaFrom: null,
          metaNote: 'Horizon does not serve result meta, and Soroban RPC no longer holds this transaction (it keeps about a week).',
          diagnosticEventsXdr: [],
          fetchedFrom: 'horizon',
          host,
        }
        break
      } catch (e) {
        tried.push({ source: 'horizon', host, outcome: 'unreachable', detail: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  if (!found) {
    // "Not found" is only a finding when the long-memory source said so. RPC's not-found is
    // usually its retention window talking, so when Horizon could not be asked the honest
    // answer is that nobody who would know was reached.
    const horizonSaidNo = tried.some((t) => t.source === 'horizon' && t.outcome === 'not-found')
    const rpcSaidNo = tried.some((t) => t.source === 'rpc' && t.outcome === 'not-found')
    const noHorizon = (chain.horizonUrls ?? []).length === 0
    return horizonSaidNo || (noHorizon && rpcSaidNo)
      ? { ok: false, code: 'not_found', reason: `No transaction ${hash} on ${chain.caip2}: Horizon, which keeps history back to the last network reset, does not have it.`, tried }
      : {
          ok: false,
          code: 'read_failed',
          reason: rpcSaidNo
            ? `Soroban RPC does not hold ${hash} (it keeps about a week) and Horizon could not be read, so whether it exists on ${chain.caip2} is unknown.`
            : `No source for ${chain.caip2} answered, so whether ${hash} exists is unknown.`,
          tried,
        }
  }

  // Meta past RPC's window, from the indexer, accepted only beside a byte-identical envelope and result.
  if (!found.resultMetaXdr && deps.indexerMeta !== false) {
    const base = indexerApiBase(chain)
    if (base) {
      const host = hostOf(base)
      try {
        const res = await http(`${base}/tx/${hash}`)
        if (res.status === 200) {
          const se = (await res.json()) as { body?: string; result?: string; meta?: string }
          if (se.meta && se.body === found.envelopeXdr && se.result === found.resultXdr) {
            tried.push({ source: 'indexer', host, outcome: 'found' })
            found.resultMetaXdr = se.meta
            found.metaFrom = 'stellar-expert'
            found.metaNote =
              'Result meta from Stellar Expert, a third-party indexer, accepted because the envelope and result it served match ' +
              `${found.fetchedFrom === 'rpc' ? 'RPC' : 'Horizon'} byte for byte. Meta is not covered by the transaction hash.`
          } else {
            tried.push({ source: 'indexer', host, outcome: se.meta ? 'mismatch' : 'not-found' })
          }
        } else {
          tried.push({ source: 'indexer', host, outcome: res.status === 404 ? 'not-found' : 'unreachable', detail: `HTTP ${res.status}` })
        }
      } catch (e) {
        tried.push({ source: 'indexer', host, outcome: 'unreachable', detail: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  let evidence: TxEvidence
  try {
    evidence = decodeTxEvidence(found.envelopeXdr, found.resultXdr, found.resultMetaXdr, passphrase, {
      chain,
      diagnosticEventsXdr: found.diagnosticEventsXdr,
    })
  } catch (e) {
    return { ok: false, code: 'read_failed', reason: `The transaction was found but would not decode: ${e instanceof Error ? e.message : String(e)}`, tried }
  }
  if (found.metaFrom === 'stellar-expert') evidence.caveats.push(found.metaNote as string)

  return {
    ok: true,
    record: { hash, chainId: chain.id, network: chain.caip2, ...found, tried },
    evidence,
  }
}
