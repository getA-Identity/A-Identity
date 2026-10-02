/**
 * Passkey-owned smart accounts on Stellar, on the network the visitor chose.
 *
 * The signer is a WebAuthn passkey behind an OpenZeppelin smart account (a C... contract),
 * created and driven through smart-account-kit. That account is the OWNER of a spend
 * vault, so the owner-only entry points (set_policy, set_allowed, set_frozen, withdraw) are
 * signed by the passkey and submitted from this module. Nothing here goes through the
 * wallet-signing path in ./vault.ts, and the server never sees the passkey's private key.
 *
 * NETWORK. Pubnet by default, testnet when the page URL says ?network=testnet (or
 * ?network=stellar:testnet). It is a runtime choice, not a constant, and everything that
 * differs per network is kept apart per network: one kit instance each, one IndexedDB
 * database each, one session marker each and one local device record each, so a pubnet
 * credential or wallet never appears on testnet and the reverse. The OpenZeppelin contract
 * ids are READ from GET /api/stellar/passkey/status?network=... rather than written here,
 * because a copy in the browser is a copy that can go stale: a testnet verifier left behind
 * on a pubnet page would fail at __check_auth after the visitor had already touched their
 * sensor.
 *
 * Fees: the kit posts { func, auth } to our relayer endpoint, whose URL carries the network
 * in its query string because the kit's own body does not. When that endpoint has no key it
 * answers "prepared" and submits nothing; this module says exactly that instead of dressing
 * it up as a generic failure.
 *
 * Loaded lazily and only in a browser. The kit is heavy and touches WebAuthn, so neither
 * the landing bundle nor the prerender snapshot ever imports it.
 *
 * Two Stellar SDKs live in node_modules on purpose, and package.json has the overrides
 * that keep them apart. smart-account-kit 0.8.0 needs @stellar/stellar-sdk 16.3 (17
 * changed the authorization API), while the wallets kit needs 17. The trap is that
 * smart-account-kit-bindings declares a loose ">=16" peer, so npm hoisted 17 into the
 * bindings while the kit itself loaded 16.3, and that splits the xdr classes across the
 * one boundary where it matters: the kit passes ScVals into the bindings' Spec, which
 * checks them with instanceof, so a value from the other copy is rejected as the wrong
 * type. The override pins the bindings to the kit's exact version; a second override
 * holds the wallets kit at the 17.0.1 it already had, so nothing else moved.
 *
 * Nothing in src/ imports either SDK. Every xdr value handed to the kit is built by the
 * kit's own exports, so it belongs to the copy the kit's Spec checks against (see scvals).
 */
import type { SmartAccountKit, StorageAdapter, StoredCredential, TransactionResult } from 'smart-account-kit'
import { apiFetch, ensureAwake } from '../api'
import { CHAIN_BY_ID } from '../chains'
import { MCP_BASE } from '../mcpBase'
import { stellarPassphraseFor } from './kit'
import { describeRegistration, type DeviceMeta } from './passkey-device'

export { describeRegistration, deviceClassLabel, providerLabel, type DeviceMeta } from './passkey-device'

type Sak = typeof import('smart-account-kit')

// ── which network ────────────────────────────────────────────────────────────────

export type PasskeyNetwork = 'stellar:pubnet' | 'stellar:testnet'

/** The user's decision (2026-10-01): pubnet unless the URL asks for testnet. */
export const DEFAULT_PASSKEY_NETWORK: PasskeyNetwork = 'stellar:pubnet'

/**
 * The network a ?network= value names. Testnet only when it says testnet in one of the two
 * spellings; anything else, including nothing, is the default. A typo therefore lands on
 * the default rather than on a guess, and the page says which network it is on in words.
 */
export function passkeyNetworkFrom(param: string | null | undefined): PasskeyNetwork {
  const v = (param ?? '').trim().toLowerCase()
  return v === 'testnet' || v === 'stellar:testnet' || v === 'stellar-testnet' ? 'stellar:testnet' : DEFAULT_PASSKEY_NETWORK
}

/** The ?network= value that selects a network, or null for the default (no parameter). */
export function passkeyNetworkParam(net: PasskeyNetwork): string | null {
  return net === DEFAULT_PASSKEY_NETWORK ? null : 'testnet'
}

export type PasskeyNetworkInfo = {
  caip2: PasskeyNetwork
  /** "Stellar mainnet" or "Stellar testnet": what the passkey and the page call it. */
  label: string
  short: 'mainnet' | 'testnet'
  realMoney: boolean
  rpcUrl: string
  explorer: string
}

const NETWORKS: Record<PasskeyNetwork, PasskeyNetworkInfo> = {
  'stellar:pubnet': {
    caip2: 'stellar:pubnet',
    label: 'Stellar mainnet',
    short: 'mainnet',
    realMoney: true,
    rpcUrl: CHAIN_BY_ID['stellar'].rpcUrl ?? 'https://mainnet.sorobanrpc.com',
    explorer: CHAIN_BY_ID['stellar'].explorer ?? 'https://stellar.expert/explorer/public',
  },
  'stellar:testnet': {
    caip2: 'stellar:testnet',
    label: 'Stellar testnet',
    short: 'testnet',
    realMoney: false,
    rpcUrl: CHAIN_BY_ID['stellar-testnet'].rpcUrl ?? 'https://soroban-testnet.stellar.org',
    explorer: CHAIN_BY_ID['stellar-testnet'].explorer ?? 'https://stellar.expert/explorer/testnet',
  },
}

export function passkeyNetworkInfo(net: PasskeyNetwork): PasskeyNetworkInfo {
  return NETWORKS[net]
}

/** Pinned in package.json; recorded here so the page can say it without the lockfile. */
export const SMART_ACCOUNT_KIT_VERSION = '0.8.0'

// ── the relying party (D3.2) ─────────────────────────────────────────────────────

/**
 * The WebAuthn relying party this deployment claims, pinned rather than left to default.
 *
 * A passkey is bound to the rpId it was created under, and the browser will not offer a
 * credential whose rpId is not a registrable suffix of the current origin. Left unset the
 * kit takes the exact hostname, which silently splits one person's credentials across
 * a-identity.xyz and www.a-identity.xyz and makes a passkey created on a Vercel preview
 * URL unfindable in production. So the apex is pinned on the production hosts, the
 * hostname is used on localhost for local development, and EVERY other host is refused:
 * a passkey created under a preview host's rpId would control a real smart account that
 * the production page could never sign for again.
 */
const WEBAUTHN_APEX = 'a-identity.xyz'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

export function relyingPartyId(): string | null {
  if (typeof window === 'undefined') return null
  const host = window.location.hostname
  if (host === WEBAUTHN_APEX || host.endsWith(`.${WEBAUTHN_APEX}`)) return WEBAUTHN_APEX
  if (LOCAL_HOSTS.has(host)) return host
  return null
}

/** Why this host cannot create a passkey, or null when it can. */
export function relyingPartyRefusal(): string | null {
  if (typeof window === 'undefined') return null
  if (relyingPartyId()) return null
  return `Passkeys on this page are bound to ${WEBAUTHN_APEX}. This host (${window.location.hostname}) is not, so a passkey made here could never sign on the production page. Open https://${WEBAUTHN_APEX}/stellar instead.`
}

// ── links ────────────────────────────────────────────────────────────────────────

export const txUrl = (net: PasskeyNetwork, hash: string) => `${NETWORKS[net].explorer}/tx/${hash}`
export const contractUrl = (net: PasskeyNetwork, id: string) => `${NETWORKS[net].explorer}/contract/${id}`
export const accountUrl = (net: PasskeyNetwork, id: string) => `${NETWORKS[net].explorer}/account/${id}`
/** The right explorer page for a G (account) or C (contract) address. */
export const addressUrl = (net: PasskeyNetwork, id: string) => (id.startsWith('C') ? contractUrl(net, id) : accountUrl(net, id))

/** The backend endpoint the kit's RelayerClient posts { func, auth } to, network in the query. */
export const RELAYER_PATH = '/api/stellar/passkey/relay'
export const relayerUrl = (net: PasskeyNetwork) => `${MCP_BASE}${RELAYER_PATH}?network=${encodeURIComponent(net)}`

/** USDC on Stellar is a classic asset behind a SAC: seven decimals, like every stroop. */
const USDC_DECIMALS = 7

// ── what a flow returns ──────────────────────────────────────────────────────────

export type PasskeyAccount = {
  /** The smart account, a C... contract. This is what owns the vault. */
  contractId: string
  credentialId: string
  /** The passkey's 65-byte P-256 point, hex. The deploy endpoint checks it against the account's live signer. */
  publicKeyHex: string | null
  /** The transaction that deployed it, when the kit still has it. */
  creation?: { txHash: string; ledger?: number }
  /** What this browser recorded about the authenticator when the passkey was made here. */
  device: DeviceMeta | null
  /** The name the owner gave this device when it was enrolled here, or null. */
  label: string | null
}

/**
 * What one owner-signed write came to. `settled` is the only state with a hash that made
 * a ledger; `refused` is the contract saying no (named when the code is our vault's);
 * `prepared` means the fee sponsor is not configured and nothing was submitted; `pending`
 * means it WAS submitted, under the hash it carries, and was not in a ledger yet when the
 * kit stopped waiting, so it may still land and is neither settled nor failed.
 */
export type ChainWrite =
  | { outcome: 'settled'; txHash: string; ledger?: number; explorerUrl: string }
  | { outcome: 'refused'; contractErrorCode: number; contractErrorName: string; reason: string; txHash?: string }
  | { outcome: 'prepared'; reason: string }
  | { outcome: 'pending'; reason: string; txHash: string }
  | { outcome: 'failed'; reason: string; txHash?: string }

export type CreateOutcome =
  | { ok: true; account: PasskeyAccount; write: Extract<ChainWrite, { outcome: 'settled' }> }
  /** The passkey exists on the device; the deployment did not land. Retry with deployPendingPasskey. */
  | { ok: false; credentialId: string; contractId: string; device: DeviceMeta | null; write: ChainWrite }

/** Where a passkey flow is, so a button can say it instead of only spinning. */
export type PasskeyStep = 'waking' | 'passkey' | 'submitting'

export const PASSKEY_STEP_LABEL: Record<PasskeyStep, string> = {
  waking: 'Waking the backend',
  passkey: 'Waiting for your passkey',
  submitting: 'Submitting',
}

type OnStep = (step: PasskeyStep) => void

/** True when this browser can run a WebAuthn ceremony at all. Never true during prerender. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  )
}

// ── per-network local state ──────────────────────────────────────────────────────

const sessionMarker = (net: PasskeyNetwork) => `aid.stellar.passkey.session:${net}`
const deviceRecordKey = (net: PasskeyNetwork) => `aid.stellar.passkey.devices:${net}`
const storageName = (net: PasskeyNetwork) => `smart-account-kit:${net}`

/**
 * Whether a returning visitor has a session worth restoring on this network. A localStorage
 * flag rather than opening the kit's IndexedDB: the kit is only loaded when there is
 * something to restore or the visitor asks, so a first visit costs no extra bytes and no
 * RPC calls.
 */
export function hasPasskeySession(net: PasskeyNetwork): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(sessionMarker(net)) === '1'
  } catch {
    return false
  }
}

function markSession(net: PasskeyNetwork, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(sessionMarker(net), '1')
    else window.localStorage.removeItem(sessionMarker(net))
  } catch {
    /* storage may be unavailable; the kit's own session still works for this tab */
  }
}

/** One device this browser enrolled, as it recorded it. Nothing here is secret. */
export type DeviceRecord = { credentialId: string; contractId: string; ruleId: number | null; label: string | null; createdAt: number; meta: DeviceMeta }

export function readDeviceRecords(net: PasskeyNetwork): DeviceRecord[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(deviceRecordKey(net)) : null
    const v = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(v) ? (v as DeviceRecord[]) : []
  } catch {
    return []
  }
}

function saveDeviceRecord(net: PasskeyNetwork, rec: DeviceRecord): void {
  try {
    const all = readDeviceRecords(net).filter((r) => r.credentialId !== rec.credentialId)
    window.localStorage.setItem(deviceRecordKey(net), JSON.stringify([...all, rec]))
  } catch {
    /* a device record is a convenience for this page; the chain is the record that matters */
  }
}

function deviceFor(net: PasskeyNetwork, credentialId: string): DeviceMeta | null {
  return readDeviceRecords(net).find((r) => r.credentialId === credentialId)?.meta ?? null
}

function labelFor(net: PasskeyNetwork, credentialId: string): string | null {
  return readDeviceRecords(net).find((r) => r.credentialId === credentialId)?.label ?? null
}

// ── the kit, one per network ─────────────────────────────────────────────────────

type SmartAccountConfig = { wasmHash: string; webauthnVerifier: string; ed25519Verifier: string }

type Loaded = {
  net: PasskeyNetwork
  sak: Sak
  kit: SmartAccountKit
  storage: StorageAdapter
  config: SmartAccountConfig
  /** Set by the WebAuthn wrapper on every registration, read right after it. */
  lastRegistration: { raw: unknown; meta: DeviceMeta | null } | null
  /** The label the next registration's user name carries, set just before the ceremony. */
  nextLabel: string | null
  /** The wrapped browser WebAuthn API handed to the kit, kept so addDevice uses the same one. */
  webauthn: WebAuthnBrowser
}

const loaded = new Map<PasskeyNetwork, Promise<Loaded>>()

/**
 * OpenZeppelin's contract ids for THIS network, from the deployment that serves them.
 *
 * Refuses rather than guesses. A kit built with a missing verifier would not fail until a
 * signature was already made, and the person would read that as their passkey being wrong
 * rather than as our configuration being absent.
 */
async function readSmartAccountConfig(net: PasskeyNetwork): Promise<SmartAccountConfig> {
  const res = await apiFetch(`/api/stellar/passkey/status?network=${encodeURIComponent(net)}`, { retries: 1 })
  const body = (await res.json().catch(() => null)) as { smartAccount?: Partial<SmartAccountConfig>; reason?: string } | null
  if (!res.ok) throw new Error(body?.reason ?? `The deployment did not answer for ${net}.`)
  const sa = body?.smartAccount
  if (!sa?.wasmHash || !sa.webauthnVerifier || !sa.ed25519Verifier) {
    throw new Error(`This deployment records no smart-account contracts for ${net}, so no passkey wallet can be created on it.`)
  }
  return { wasmHash: sa.wasmHash, webauthnVerifier: sa.webauthnVerifier, ed25519Verifier: sa.ed25519Verifier }
}

type RegistrationOptions = { optionsJSON: Record<string, unknown> & { user: { id: string; name: string; displayName: string } }; useAutoRegister?: boolean }
type WebAuthnBrowser = {
  startRegistration: (o: RegistrationOptions) => Promise<unknown>
  startAuthentication: (o: { optionsJSON: Record<string, unknown> }) => Promise<unknown>
}

/**
 * The WebAuthn calls the kit makes, wrapped for three reasons and no others.
 *
 * 1. The name the OS passkey manager shows. The kit composes "<userName> - <local time>"
 *    with a typographic dash; the wrapper replaces it with "A-Identity Stellar mainnet" or
 *    "A-Identity Stellar testnet", plus the visitor's own label when they gave one, so a
 *    pubnet credential never reads "testnet" and the reverse.
 * 2. Which authenticator is preferred. `hints: ['client-device', 'hybrid']` (WebAuthn L3)
 *    asks the browser to offer this device first and a phone second. It is a preference,
 *    not a filter: authenticatorAttachment is deliberately NOT set, because 'platform'
 *    would refuse a security key or a phone outright and a browser that ignores hints
 *    should still offer everything. residentKey is required so "I already have one" can
 *    find the credential without us remembering its id.
 * 3. What the authenticator said about itself (attachment, transports, AAGUID, the
 *    backup flags), captured from the registration response so the page can name the
 *    device. Nothing here changes what is signed.
 */
function wrapWebAuthn(inner: WebAuthnBrowser, state: Loaded): WebAuthnBrowser {
  return {
    async startRegistration(o) {
      const label = state.nextLabel?.trim()
      const name = `A-Identity ${NETWORKS[state.net].label}${label ? ` (${label})` : ''}`
      const prev = (o.optionsJSON.authenticatorSelection ?? {}) as Record<string, unknown>
      const raw = await inner.startRegistration({
        ...o,
        optionsJSON: {
          ...o.optionsJSON,
          user: { ...o.optionsJSON.user, name, displayName: name },
          authenticatorSelection: { ...prev, residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          hints: ['client-device', 'hybrid'],
        },
      })
      state.lastRegistration = { raw, meta: describeRegistration(raw) }
      return raw
    },
    startAuthentication: (o) => inner.startAuthentication(o),
  }
}

function load(net: PasskeyNetwork): Promise<Loaded> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Passkeys need a browser.'))
  const refusal = relyingPartyRefusal()
  if (refusal) return Promise.reject(new Error(refusal))
  let p = loaded.get(net)
  if (!p) {
    p = (async () => {
      // The kit derives its shared deployer key at import time with Buffer, which browsers
      // do not have. It is put in place before the kit's module graph evaluates.
      const g = globalThis as { Buffer?: unknown }
      if (!g.Buffer) {
        const { Buffer } = await import('buffer')
        g.Buffer = Buffer
      }
      const config = await readSmartAccountConfig(net)
      const passphrase = stellarPassphraseFor(net)
      if (!passphrase) throw new Error(`No Stellar passphrase for ${net}.`)
      const [sak, webauthn] = await Promise.all([import('smart-account-kit'), import('@simplewebauthn/browser')])
      const storage: StorageAdapter = 'indexedDB' in window ? new sak.IndexedDBStorage(storageName(net)) : new sak.LocalStorageAdapter(storageName(net))
      const state = { net, sak, storage, config, lastRegistration: null, nextLabel: null } as unknown as Loaded
      state.webauthn = wrapWebAuthn(webauthn as unknown as WebAuthnBrowser, state)
      const kit = new sak.SmartAccountKit({
        rpcUrl: NETWORKS[net].rpcUrl,
        networkPassphrase: passphrase,
        accountWasmHash: config.wasmHash,
        webauthnVerifierAddress: config.webauthnVerifier,
        ed25519VerifierAddress: config.ed25519Verifier,
        rpName: 'A-Identity',
        rpId: relyingPartyId() ?? undefined,
        // With a relayer configured the kit keeps the shared sign-only deployer and posts
        // { func, auth }; the visitor never pays a fee and the deployer never holds value.
        // The network rides in the URL because the kit's body has no field for it.
        relayerUrl: relayerUrl(net),
        storage,
        webAuthn: state.webauthn as never,
      })
      state.kit = kit
      return state
    })().catch((e) => {
      loaded.delete(net)
      throw e
    })
    loaded.set(net, p)
  }
  return p
}

function hexOf(bytes: Uint8Array | undefined | null): string | null {
  if (!bytes || bytes.length !== 65) return null
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function accountOf(net: PasskeyNetwork, r: { contractId: string; credentialId: string; credential?: StoredCredential }): PasskeyAccount {
  const c = r.credential
  return {
    contractId: r.contractId,
    credentialId: r.credentialId,
    publicKeyHex: hexOf(c?.publicKey),
    creation: c?.creationTransactionHash ? { txHash: c.creationTransactionHash, ledger: c.creationLedger } : undefined,
    device: deviceFor(net, r.credentialId),
    label: labelFor(net, r.credentialId),
  }
}

/** Silent restore of the last session on this network. Null when there is none; never prompts. */
export async function restorePasskeyAccount(net: PasskeyNetwork): Promise<PasskeyAccount | null> {
  const { kit } = await load(net)
  const r = await kit.connectWallet()
  if (!r) {
    markSession(net, false)
    return null
  }
  markSession(net, true)
  return accountOf(net, r)
}

/** Prompt for a passkey and connect to the smart account it controls on this network. */
export async function signInWithPasskey(net: PasskeyNetwork): Promise<PasskeyAccount> {
  const { kit } = await load(net)
  const r = await kit.connectWallet({ prompt: true })
  if (!r) throw new Error('No passkey was chosen, so nothing is connected.')
  markSession(net, true)
  return accountOf(net, r)
}

export async function disconnectPasskey(net: PasskeyNetwork): Promise<void> {
  markSession(net, false)
  const p = loaded.get(net)
  if (!p) return
  const { kit } = await p
  await kit.disconnect()
}

/** Called the moment the passkey exists, before the deploy: the address is known, not live. */
export type OnCreated = (pending: { contractId: string; credentialId: string; device: DeviceMeta | null }) => void

/**
 * Create a passkey and deploy the smart account it controls, fee-sponsored. The ceremony
 * runs first (that is the user gesture), then the kit posts the signed deploy to the
 * relayer and waits for the ledger. `onCreated` fires between the two, with the address the
 * account WILL have, so the page can show it labelled as not deployed yet.
 */
export async function createPasskeyAccount(
  net: PasskeyNetwork,
  opts: { label?: string | null; onStep?: OnStep; onCreated?: OnCreated } = {},
): Promise<CreateOutcome> {
  const state = await load(net)
  const { kit } = state
  await ensureAwake(() => opts.onStep?.('waking'))
  opts.onStep?.('passkey')
  state.nextLabel = opts.label ?? null
  state.lastRegistration = null
  const off = kit.events.on('credentialCreated', ({ credential }) => {
    const meta = state.lastRegistration?.meta ?? null
    if (meta) saveDeviceRecord(net, { credentialId: credential.credentialId, contractId: credential.contractId, ruleId: 0, label: opts.label ?? null, createdAt: Date.now(), meta })
    opts.onStep?.('submitting')
    opts.onCreated?.({ contractId: credential.contractId, credentialId: credential.credentialId, device: meta })
  })
  try {
    const r = await kit.createWallet('A-Identity', `A-Identity ${NETWORKS[net].label}`, { autoSubmit: true })
    const submit = (r as { submitResult?: TransactionResult }).submitResult
    return createOutcome(net, r.contractId, r.credentialId, hexOf(r.publicKey), submit, opts.label ?? null)
  } finally {
    off()
    state.nextLabel = null
  }
}

/** Retry the deployment of a passkey whose first submission did not land. No new passkey. */
export async function deployPendingPasskey(net: PasskeyNetwork, credentialId: string, onStep?: OnStep): Promise<CreateOutcome> {
  const { kit, storage } = await load(net)
  await ensureAwake(() => onStep?.('waking'))
  onStep?.('submitting')
  const r = await kit.credentials.deploy(credentialId, { autoSubmit: true })
  const stored = await storage.get(credentialId)
  return createOutcome(net, r.contractId, credentialId, hexOf(stored?.publicKey), r.submitResult)
}

function createOutcome(
  net: PasskeyNetwork,
  contractId: string,
  credentialId: string,
  publicKeyHex: string | null,
  submit: TransactionResult | undefined,
  label?: string | null,
): CreateOutcome {
  const write: ChainWrite = submit ? toWrite(net, submit) : { outcome: 'failed', reason: 'The kit returned no submission result.' }
  const device = deviceFor(net, credentialId)
  if (write.outcome === 'settled') {
    markSession(net, true)
    const account = { contractId, credentialId, publicKeyHex, creation: { txHash: write.txHash, ledger: write.ledger }, device, label: label ?? labelFor(net, credentialId) }
    return { ok: true, account, write }
  }
  return { ok: false, credentialId, contractId, device, write }
}

/**
 * xdr values built by the kit's own SDK. kit.execute() hands these to the account's Spec,
 * which checks `instanceof xdr.ScVal` against the SDK the kit loaded, so anything from
 * another copy fails that check. buildI128ScVal is a public export. An address ScVal is
 * lifted out of a signer ScVal (element 1 of Delegated(G) or External(C, ...)), which also
 * runs the kit's own strkey validation. The bool comes from the ScVal class those
 * instances belong to.
 */
type ScValLike = { vec(): ScValLike[] }
type ScValClass = { scvBool(b: boolean): unknown }

function scvals(sak: Sak) {
  const i128 = (units: bigint) => sak.buildI128ScVal(units)
  const ScVal = (i128(0n) as unknown as Record<'constructor', ScValClass>).constructor
  const address = (a: string) => {
    const signer = a.startsWith('C') ? sak.createExternalSigner(a, new Uint8Array(1)) : sak.createDelegatedSigner(a)
    return (sak.signerToScVal(signer) as unknown as ScValLike).vec()[1]
  }
  return { i128, address, bool: (b: boolean) => ScVal.scvBool(b) }
}

function usdcUnits(usd: number, what: string): bigint {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`Enter ${what} above zero.`)
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS))
}

async function ownerCall(net: PasskeyNetwork, vault: string, fn: string, args: unknown[], onStep?: OnStep): Promise<ChainWrite> {
  const { kit } = await load(net)
  if (!kit.isConnected) throw new Error('Sign in with your passkey first.')
  await ensureAwake(() => onStep?.('waking'))
  onStep?.('passkey')
  const off = kit.events.on('transactionSigned', () => onStep?.('submitting'))
  try {
    return toWrite(net, await kit.executeAndSubmit(vault, fn, args), vault)
  } finally {
    off()
  }
}

/** set_policy(daily cap, per-payment ceiling, allowlist on or off), signed by the passkey owner. */
export async function ownerSetPolicy(
  net: PasskeyNetwork,
  vault: string,
  policy: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean },
  onStep?: OnStep,
): Promise<ChainWrite> {
  const { sak } = await load(net)
  const v = scvals(sak)
  return ownerCall(
    net,
    vault,
    'set_policy',
    [
      v.i128(usdcUnits(policy.dailyCapUsd, 'a daily cap')),
      v.i128(usdcUnits(policy.autoApproveUsd, 'a per-payment ceiling')),
      v.bool(policy.allowlistEnabled),
    ],
    onStep,
  )
}

/** set_allowed(payee, allowed): one binary allowlist entry, signed by the passkey owner. */
export async function ownerSetAllowed(net: PasskeyNetwork, vault: string, payee: string, allowed: boolean, onStep?: OnStep): Promise<ChainWrite> {
  const { sak } = await load(net)
  const v = scvals(sak)
  return ownerCall(net, vault, 'set_allowed', [v.address(payee), v.bool(allowed)], onStep)
}

/** set_frozen(frozen): the owner's stop switch. While frozen, pay() refuses with Frozen (#1). */
export async function ownerSetFrozen(net: PasskeyNetwork, vault: string, frozen: boolean, onStep?: OnStep): Promise<ChainWrite> {
  const { sak } = await load(net)
  return ownerCall(net, vault, 'set_frozen', [scvals(sak).bool(frozen)], onStep)
}

/** withdraw(to, amount): the owner takes USDC out of the vault, outside the agent's policy. */
export async function ownerWithdraw(net: PasskeyNetwork, vault: string, to: string, amountUsd: number, onStep?: OnStep): Promise<ChainWrite> {
  const { sak } = await load(net)
  const v = scvals(sak)
  return ownerCall(net, vault, 'withdraw', [v.address(to), v.i128(usdcUnits(amountUsd, 'an amount'))], onStep)
}

// ── devices: who can sign for this account (D3.7, D3.8) ──────────────────────────

/** One WebAuthn signer on the account, as the account itself reports it. */
export type PasskeySigner = {
  ruleId: number
  ruleName: string
  /** The credential id the signer carries after the 65-byte key, base64url. */
  credentialId: string | null
  /** This browser holds a record of making it. */
  thisBrowser: boolean
  /** The credential currently signed in. */
  current: boolean
  device: DeviceMeta | null
  label: string | null
}

export type SignerSnapshot = {
  /** Every WebAuthn signer under this network's verifier, across the active rules. */
  passkeys: PasskeySigner[]
  /** Signers of any other kind (delegated accounts, Ed25519 keys), counted so none is hidden. */
  otherSigners: number
  rules: number
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The account's signers, read live through the kit (context rules enumerated on chain).
 * This is what the recovery badge counts, so it is read rather than remembered: a device
 * added from another browser counts as much as one added here.
 */
export async function readSigners(net: PasskeyNetwork): Promise<SignerSnapshot> {
  const { kit, config } = await load(net)
  if (!kit.isConnected) throw new Error('Sign in with your passkey first.')
  const rules = await kit.rules.list()
  const records = readDeviceRecords(net)
  const passkeys: PasskeySigner[] = []
  let otherSigners = 0
  for (const rule of rules) {
    for (const s of rule.signers) {
      if (s.tag === 'External' && s.values[0] === config.webauthnVerifier) {
        const key = s.values[1] as Uint8Array
        const credentialId = key.length > 65 ? b64url(key.slice(65)) : null
        const rec = credentialId ? records.find((r) => r.credentialId === credentialId) : undefined
        passkeys.push({
          ruleId: rule.id,
          ruleName: rule.name,
          credentialId,
          thisBrowser: Boolean(rec),
          current: credentialId !== null && credentialId === kit.credentialId,
          device: rec?.meta ?? null,
          label: rec?.label ?? null,
        })
      } else {
        otherSigners += 1
      }
    }
  }
  return { passkeys, otherSigners, rules: rules.length }
}

export type AddDeviceOutcome =
  | { ok: true; write: Extract<ChainWrite, { outcome: 'settled' }>; ruleId: number; credentialId: string; device: DeviceMeta | null }
  | { ok: false; write: ChainWrite; credentialId: string | null; device: DeviceMeta | null }

/**
 * Add a second device as its OWN context rule, authorized by the passkey signed in now.
 *
 * Why a new rule and never rule 0: an OpenZeppelin context rule with two signers and no
 * policy requires BOTH of them (the account's storage requires every signer of a
 * policy-less rule), so adding the new key beside the old one would turn "either device"
 * into "both devices" and make losing one fatal instead of survivable. A Default rule
 * holding only the new key lets either device authorize alone, which is the recovery
 * property the page promises. The relay refuses add_signer on rule 0 for the same reason.
 *
 * The kit's own signers.addPasskey adds to an existing rule, so this composes the pieces it
 * exposes instead: the WebAuthn ceremony through the same wrapped browser API, the signer
 * built with createWebAuthnSigner, the rule with kit.rules.add, and the signature with
 * signAndSubmitAdmin. The new credential is recorded in the kit's storage as a verified
 * secondary of this account at the rule it got, which is what the kit's connect path reads
 * to sign in with it later.
 */
export async function addDevice(net: PasskeyNetwork, opts: { label?: string | null; onStep?: OnStep } = {}): Promise<AddDeviceOutcome> {
  const state = await load(net)
  const { kit, sak, storage, config } = state
  if (!kit.isConnected || !kit.contractId) throw new Error('Sign in with your passkey first.')
  const contractId = kit.contractId
  const primary = (await storage.getByContract(contractId)).find(
    (c) => c.deploymentStatus === 'deployed' && c.birthWasmHash && c.creationTransactionHash && c.creationLedger !== undefined && c.birthConstructorArgsHash,
  )
  if (!primary) throw new Error('This browser has no verified record of the account yet. Sign in with your passkey again, then add the device.')
  await ensureAwake(() => opts.onStep?.('waking'))

  // The id the new rule will get: the account's counter only grows, so it is the count now.
  const ruleId = Number(await kit.rules.count())

  // 1. The new passkey. Same wrapper as enrollment, so it is named for this network.
  opts.onStep?.('passkey')
  state.nextLabel = opts.label ?? 'second device'
  state.lastRegistration = null
  const { generateChallenge } = sak
  let raw: { id: string; response: { publicKey?: string; transports?: string[] } }
  try {
    raw = (await state.webauthn.startRegistration({
      optionsJSON: {
        challenge: generateChallenge(),
        rp: { id: relyingPartyId() ?? undefined, name: 'A-Identity' },
        user: { id: b64url(crypto.getRandomValues(new Uint8Array(16))), name: 'A-Identity', displayName: 'A-Identity' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        // Never offer the passkey that is already a signer: the second device must be a different credential.
        excludeCredentials: [{ id: primary.credentialId, type: 'public-key' }],
        timeout: 120_000,
      },
    })) as typeof raw
  } finally {
    state.nextLabel = null
  }
  // Set by the wrapper during the ceremony above; TypeScript cannot see that, hence the cast.
  const meta = (state.lastRegistration as Loaded['lastRegistration'])?.meta ?? null
  const publicKey = await rawP256Key(raw.response.publicKey)
  if (!publicKey) return { ok: false, credentialId: raw.id, device: meta, write: { outcome: 'failed', reason: 'The authenticator did not return a P-256 public key, so it cannot sign for a Stellar smart account. Nothing was submitted.' } }

  // 2. The rule: Default context, this one signer, no policy, no expiry.
  const signer = sak.createWebAuthnSigner(config.webauthnVerifier, publicKey, raw.id)
  const name = (opts.label?.trim() || 'device').slice(0, 20)
  const tx = await kit.rules.add(sak.createDefaultContext(), name, [signer], new Map())

  // 3. Signed by the passkey signed in now, relayed and fee-sponsored like every owner call.
  opts.onStep?.('passkey')
  const off = kit.events.on('transactionSigned', () => opts.onStep?.('submitting'))
  let write: ChainWrite
  try {
    write = toWrite(net, await kit.signAndSubmitAdmin(tx))
  } finally {
    off()
  }
  if (write.outcome !== 'settled') return { ok: false, credentialId: raw.id, device: meta, write }

  // 4. Recorded where the kit's connect path looks for a secondary, at the rule it got.
  await storage.save({
    credentialId: raw.id,
    publicKey,
    contractId,
    nickname: name,
    createdAt: Date.now(),
    transports: raw.response.transports as StoredCredential['transports'],
    isPrimary: false,
    contextRuleId: ruleId,
    deploymentStatus: 'deployed',
    associationVerified: true,
    birthWasmHash: primary.birthWasmHash,
    creationTransactionHash: primary.creationTransactionHash,
    creationLedger: primary.creationLedger,
    birthConstructorArgsHash: primary.birthConstructorArgsHash,
  })
  if (meta) saveDeviceRecord(net, { credentialId: raw.id, contractId, ruleId, label: opts.label ?? null, createdAt: Date.now(), meta })
  return { ok: true, write, ruleId, credentialId: raw.id, device: meta }
}

/** The 65-byte uncompressed point from a registration's SPKI public key, via WebCrypto. */
async function rawP256Key(spkiB64url: string | undefined): Promise<Uint8Array | null> {
  if (!spkiB64url || !globalThis.crypto?.subtle) return null
  try {
    const bin = atob(spkiB64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((spkiB64url.length + 3) % 4))
    const spki = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', key))
    return point.length === 65 && point[0] === 4 ? point : null
  } catch {
    return null
  }
}

// ── reading the kit's answers ────────────────────────────────────────────────────

/** The vault's typed errors, copied from soroban/contracts/agent-spend-policy/src/error.rs. Frozen ABI. */
const VAULT_ERRORS: Record<number, string> = {
  1: 'Frozen',
  2: 'SessionKeyExpired',
  3: 'PayeeNotAllowed',
  4: 'AboveAutoApprove',
  5: 'DailyCapExceeded',
  6: 'InvalidAmount',
  7: 'InvalidPayee',
  8: 'MathOverflow',
  9: 'InsufficientBalance',
  10: 'OwnerIsOperator',
}

/**
 * What the relay says when it holds no key: it validated the request, returned exactly
 * what it would have posted, and posted nothing.
 *
 * Matched on the message because that is all that survives the trip. The kit's
 * RelayerClient keeps only `error` off the response body, so the backend's
 * `outcome: 'prepared'` never reaches us as a field. The first alternative is the
 * sentence the backend actually emits ("<VAR> is unset; ... and nothing was."); the rest
 * are there so a reword on that side still reads as prepared rather than as a failure.
 */
const PREPARED = /\bis unset\b|and nothing was|\bprepared\b|not configured|no fee sponsor|sponsor (is )?not|relayer (is )?not configured/i

/**
 * What the kit says when it submitted a transaction and stopped polling before the ledger
 * had it ("Transaction confirmation timed out", with the hash). That write may still land,
 * so it is pending, never failed: calling it failed invites a second submission.
 */
const UNCONFIRMED = /timed out/i

function toWrite(net: PasskeyNetwork, r: TransactionResult, vault?: string): ChainWrite {
  if (r.success) return { outcome: 'settled', txHash: r.hash, ledger: r.ledger, explorerUrl: txUrl(net, r.hash) }
  const err = r.error as { message?: string; contractCode?: number; contractErrorName?: string }
  const message = err.message ?? 'That did not go through.'
  const inMessage = /Error\(Contract, #(\d+)\)/.exec(message)
  const code = err.contractCode ?? (inMessage ? Number(inMessage[1]) : undefined)
  if (code != null) {
    // Name the code only when it is our vault's: the kit's own registry covers the smart
    // account (3000 and up), and a code from another contract in the call tree stays a number.
    const ours = vault ? message.includes(vault) : false
    const name = err.contractErrorName ?? (ours ? VAULT_ERRORS[code] : undefined) ?? `contract error ${code}`
    return {
      outcome: 'refused',
      contractErrorCode: code,
      contractErrorName: name,
      reason: `The contract refused it: ${name} (#${code}).`,
      txHash: r.hash,
    }
  }
  if (PREPARED.test(message)) return { outcome: 'prepared', reason: message }
  if (r.hash && UNCONFIRMED.test(message)) {
    return { outcome: 'pending', reason: 'Submitted, and not in a ledger yet when the wait ran out. It may still land.', txHash: r.hash }
  }
  return { outcome: 'failed', reason: message, txHash: r.hash }
}

/**
 * One sentence from whatever the kit or the browser threw. A dismissed passkey prompt is
 * the common case and deserves its own words; the kit's typed messages pass through.
 */
export function passkeyErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const cause = (e as { cause?: unknown } | null)?.cause
  const text = `${raw} ${cause instanceof Error ? cause.message : ''}`
  if (/InvalidStateError|already registered|excludeCredentials/i.test(text))
    return 'That authenticator already holds a passkey for this account. Use a different device or password manager for the second device.'
  if (/NotAllowedError|not allowed|cancel|abort|timed out|timeout/i.test(text))
    return 'The passkey prompt was dismissed or timed out. Nothing was signed.'
  if (/not supported|PublicKeyCredential|WebAuthn is not/i.test(text))
    return 'This browser cannot use passkeys here. Use a current Chrome, Safari or Edge over https.'
  if (/Failed to fetch|NetworkError|Load failed/i.test(text))
    return 'The network call did not go through. Check the connection and try again.'
  return raw || 'That did not go through.'
}
