/**
 * Passkey-owned smart accounts on Stellar testnet.
 *
 * The signer is a WebAuthn passkey behind an OpenZeppelin smart account (a C... contract),
 * created and driven through smart-account-kit. That account is the OWNER of a spend
 * vault, so the owner-only entry points (set_policy, set_allowed) are signed by the
 * passkey and submitted from this module. Nothing here goes through the wallet-signing
 * path in ./vault.ts, and the server never sees a key.
 *
 * Fees: the kit posts { func, auth } to our relayer endpoint, which sources the
 * transaction and pays for it, so the visitor never holds XLM. When that endpoint has no
 * key it answers "prepared" and submits nothing; this module says exactly that instead of
 * dressing it up as a generic failure.
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
import type { SmartAccountKit, StoredCredential, TransactionResult } from 'smart-account-kit'
import { ensureAwake } from '../api'
import { CHAIN_BY_ID } from '../chains'
import { MCP_BASE } from '../mcpBase'
import { STELLAR_TESTNET_PASSPHRASE } from './kit'

type Sak = typeof import('smart-account-kit')

const TESTNET = CHAIN_BY_ID['stellar-testnet']

/** CAIP-2 id of the only network this flow runs on. Testnet, on purpose, everywhere. */
export const PASSKEY_NETWORK = 'stellar:testnet'
export const PASSKEY_RPC_URL = TESTNET.rpcUrl ?? 'https://soroban-testnet.stellar.org'
const EXPLORER = TESTNET.explorer ?? 'https://stellar.expert/explorer/testnet'

/** smart-account-kit's Protocol 27 testnet deployment (docs/deployments-protocol-27-2026-07-09.md). */
export const SMART_ACCOUNT_WASM_HASH = '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a'
export const WEBAUTHN_VERIFIER = 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F'
export const ED25519_VERIFIER = 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4'
/** Pinned in package.json; recorded here so the page can say it without the lockfile. */
export const SMART_ACCOUNT_KIT_VERSION = '0.8.0'
/**
 * The WebAuthn relying party this deployment claims, pinned rather than left to default.
 *
 * A passkey is bound to the rpId it was created under, and the browser will not offer a
 * credential whose rpId is not a registrable suffix of the current origin. Left unset the
 * kit takes the exact hostname, which silently splits one person's credentials across
 * a-identity.xyz and www.a-identity.xyz and makes a passkey created on a Vercel preview
 * URL unfindable in production. Pinning the apex collapses those into one credential.
 *
 * Anywhere else (localhost, a preview host, a fork on another domain) returns undefined
 * on purpose: the apex is not a suffix of those origins, so claiming it would make
 * navigator.credentials refuse outright, and the browser default is the only value that
 * can work there.
 */
const WEBAUTHN_APEX = 'a-identity.xyz'
function relyingPartyId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const host = window.location.hostname
  return host === WEBAUTHN_APEX || host.endsWith(`.${WEBAUTHN_APEX}`) ? WEBAUTHN_APEX : undefined
}

/** The backend endpoint the kit's RelayerClient posts { func, auth } to. */
export const RELAYER_PATH = '/api/stellar/passkey/relay'

/** USDC on Stellar is a classic asset behind a SAC: seven decimals, like every stroop. */
const USDC_DECIMALS = 7

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const contractUrl = (id: string) => `${EXPLORER}/contract/${id}`
export const accountUrl = (id: string) => `${EXPLORER}/account/${id}`
/** The right explorer page for a G (account) or C (contract) address. */
export const addressUrl = (id: string) => (id.startsWith('C') ? contractUrl(id) : accountUrl(id))

export type PasskeyAccount = {
  /** The smart account, a C... contract. This is what owns the vault. */
  contractId: string
  credentialId: string
  /** The transaction that deployed it, when the kit still has it. */
  creation?: { txHash: string; ledger?: number }
}

/**
 * What one owner-signed write came to. `settled` is the only state with a hash that made
 * a ledger; `refused` is the contract saying no (named when the code is our vault's);
 * `prepared` means the fee sponsor is not configured and nothing was submitted.
 */
export type ChainWrite =
  | { outcome: 'settled'; txHash: string; ledger?: number; explorerUrl: string }
  | { outcome: 'refused'; contractErrorCode: number; contractErrorName: string; reason: string; txHash?: string }
  | { outcome: 'prepared'; reason: string }
  | { outcome: 'failed'; reason: string; txHash?: string }

export type CreateOutcome =
  | { ok: true; account: PasskeyAccount; write: Extract<ChainWrite, { outcome: 'settled' }> }
  /** The passkey exists on the device; the deployment did not land. Retry with deployPendingPasskey. */
  | { ok: false; credentialId: string; contractId: string; write: ChainWrite }

/** Where a passkey flow is, so a button can say it instead of only spinning. */
export type PasskeyStep = 'waking' | 'passkey' | 'submitting'

export const PASSKEY_STEP_LABEL: Record<PasskeyStep, string> = {
  waking: 'Waking the backend',
  passkey: 'Waiting for your passkey',
  submitting: 'Submitting',
}

type OnStep = (step: PasskeyStep) => void

let loaded: Promise<{ sak: Sak; kit: SmartAccountKit }> | null = null

/** True when this browser can run a WebAuthn ceremony at all. Never true during prerender. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  )
}

const SESSION_MARKER = 'aid.stellar.passkey.session'

/**
 * Whether a returning visitor has a session worth restoring. A localStorage flag rather
 * than opening the kit's IndexedDB: the kit is only loaded when there is something to
 * restore or the visitor asks, so a first visit costs no extra bytes and no RPC calls.
 */
export function hasPasskeySession(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(SESSION_MARKER) === '1'
  } catch {
    return false
  }
}

function markSession(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SESSION_MARKER, '1')
    else window.localStorage.removeItem(SESSION_MARKER)
  } catch {
    /* storage may be unavailable; the kit's own session still works for this tab */
  }
}

async function load(): Promise<{ sak: Sak; kit: SmartAccountKit }> {
  if (typeof window === 'undefined') throw new Error('Passkeys need a browser.')
  if (!loaded) {
    loaded = (async () => {
      // The kit derives its shared deployer key at import time with Buffer, which browsers
      // do not have. It is put in place before the kit's module graph evaluates.
      const g = globalThis as { Buffer?: unknown }
      if (!g.Buffer) {
        const { Buffer } = await import('buffer')
        g.Buffer = Buffer
      }
      const sak = await import('smart-account-kit')
      const storage = 'indexedDB' in window ? new sak.IndexedDBStorage() : new sak.LocalStorageAdapter()
      const kit = new sak.SmartAccountKit({
        rpcUrl: PASSKEY_RPC_URL,
        networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
        accountWasmHash: SMART_ACCOUNT_WASM_HASH,
        webauthnVerifierAddress: WEBAUTHN_VERIFIER,
        ed25519VerifierAddress: ED25519_VERIFIER,
        rpName: 'A-Identity',
        rpId: relyingPartyId(),
        // With a relayer configured the kit keeps the shared sign-only deployer and posts
        // { func, auth }; the visitor never pays a fee and the deployer never holds value.
        relayerUrl: `${MCP_BASE}${RELAYER_PATH}`,
        storage,
      })
      return { sak, kit }
    })().catch((e) => {
      loaded = null
      throw e
    })
  }
  return loaded
}

function accountOf(r: { contractId: string; credentialId: string; credential?: StoredCredential }): PasskeyAccount {
  const c = r.credential
  return {
    contractId: r.contractId,
    credentialId: r.credentialId,
    creation: c?.creationTransactionHash ? { txHash: c.creationTransactionHash, ledger: c.creationLedger } : undefined,
  }
}

/** Silent restore of the last session. Null when there is none; never prompts. */
export async function restorePasskeyAccount(): Promise<PasskeyAccount | null> {
  const { kit } = await load()
  const r = await kit.connectWallet()
  if (!r) {
    markSession(false)
    return null
  }
  markSession(true)
  return accountOf(r)
}

/** Prompt for a passkey and connect to the smart account it controls. */
export async function signInWithPasskey(): Promise<PasskeyAccount> {
  const { kit } = await load()
  const r = await kit.connectWallet({ prompt: true })
  if (!r) throw new Error('No passkey was chosen, so nothing is connected.')
  markSession(true)
  return accountOf(r)
}

export async function disconnectPasskey(): Promise<void> {
  markSession(false)
  if (!loaded) return
  const { kit } = await loaded
  await kit.disconnect()
}

/**
 * Create a passkey and deploy the smart account it controls, fee-sponsored. The ceremony
 * runs first (that is the user gesture), then the kit posts the signed deploy to the
 * relayer and waits for the ledger.
 */
export async function createPasskeyAccount(label: string, onStep?: OnStep): Promise<CreateOutcome> {
  const { kit } = await load()
  await ensureAwake(() => onStep?.('waking'))
  onStep?.('passkey')
  const r = await kit.createWallet('A-Identity', label, { autoSubmit: true })
  const submit = (r as { submitResult?: TransactionResult }).submitResult
  return createOutcome(r.contractId, r.credentialId, submit)
}

/** Retry the deployment of a passkey whose first submission did not land. No new passkey. */
export async function deployPendingPasskey(credentialId: string, onStep?: OnStep): Promise<CreateOutcome> {
  const { kit } = await load()
  await ensureAwake(() => onStep?.('waking'))
  onStep?.('submitting')
  const r = await kit.credentials.deploy(credentialId, { autoSubmit: true })
  return createOutcome(r.contractId, credentialId, r.submitResult)
}

function createOutcome(contractId: string, credentialId: string, submit: TransactionResult | undefined): CreateOutcome {
  const write: ChainWrite = submit ? toWrite(submit) : { outcome: 'failed', reason: 'The kit returned no submission result.' }
  if (write.outcome === 'settled') {
    markSession(true)
    return { ok: true, account: { contractId, credentialId, creation: { txHash: write.txHash, ledger: write.ledger } }, write }
  }
  return { ok: false, credentialId, contractId, write }
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

async function ownerCall(vault: string, fn: string, args: unknown[], onStep?: OnStep): Promise<ChainWrite> {
  const { kit } = await load()
  if (!kit.isConnected) throw new Error('Sign in with your passkey first.')
  await ensureAwake(() => onStep?.('waking'))
  onStep?.('passkey')
  const off = kit.events.on('transactionSigned', () => onStep?.('submitting'))
  try {
    return toWrite(await kit.executeAndSubmit(vault, fn, args), vault)
  } finally {
    off()
  }
}

/** set_policy(daily cap, per-payment ceiling, allowlist on or off), signed by the passkey owner. */
export async function ownerSetPolicy(
  vault: string,
  policy: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean },
  onStep?: OnStep,
): Promise<ChainWrite> {
  const { sak } = await load()
  const v = scvals(sak)
  return ownerCall(
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
export async function ownerSetAllowed(vault: string, payee: string, allowed: boolean, onStep?: OnStep): Promise<ChainWrite> {
  const { sak } = await load()
  const v = scvals(sak)
  return ownerCall(vault, 'set_allowed', [v.address(payee), v.bool(allowed)], onStep)
}

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

function toWrite(r: TransactionResult, vault?: string): ChainWrite {
  if (r.success) return { outcome: 'settled', txHash: r.hash, ledger: r.ledger, explorerUrl: txUrl(r.hash) }
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
  if (/NotAllowedError|not allowed|cancel|abort|timed out|timeout/i.test(text))
    return 'The passkey prompt was dismissed or timed out. Nothing was signed.'
  if (/not supported|PublicKeyCredential|WebAuthn is not/i.test(text))
    return 'This browser cannot use passkeys here. Use a current Chrome, Safari or Edge over https.'
  if (/Failed to fetch|NetworkError|Load failed/i.test(text))
    return 'The network call did not go through. Check the connection and try again.'
  return raw || 'That did not go through.'
}
