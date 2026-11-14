/**
 * The NEAR x402 rail's relayer: the one part of this backend that signs and sends on NEAR.
 *
 * x402 `exact` on NEAR
 * (https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_near.md) has the
 * buyer sign a NEP-366 SignedDelegate holding one ft_transfer. Someone else has to put it on
 * chain: an outer transaction, signed by a relayer, whose only action is that Delegate. The
 * relayer pays the gas and the 1 yoctoNEAR the ft_transfer carries. This file is that relayer,
 * and the rules it keeps are the x402-3009 engine's, applied to NEAR:
 *
 * - The relayer is env-gated. NEAR_X402_RELAYER_ACCOUNT and NEAR_X402_RELAYER_KEY name it; with
 *   either missing or unusable the rail is off, and nothing here ever sees a key. The secret
 *   lives in one closure (`sign`), never on an object that could be logged or serialized, and no
 *   message about it repeats any part of it (a parser error can quote a character, so none is
 *   passed on).
 * - The transaction hash is computed before the send. The outer transaction is encoded here,
 *   byte for byte, around the buyer's own SignedDelegate bytes (relayed unchanged, never
 *   re-encoded), hashed, signed, and handed to `beforeSend` with its hash. If that throws,
 *   nothing is sent.
 * - A submission goes to ONE host and never fails over (chains/near/client.ts says why: a
 *   second host after a timeout is how a payment goes out twice). Only a decided refusal of the
 *   transaction (INVALID_TRANSACTION, or a request the node could not parse) means it was never
 *   included. Anything else (a timeout, HTTP 408 or 5xx, a dropped connection) says nothing
 *   either way, so the hash is looked up instead, as a READ, which may ask every host.
 * - One relayer key signs one transaction at a time (a per-key queue), with a nonce one past
 *   both the chain's final nonce and the last one this process used, so two settlements never
 *   collide on a nonce. A refused nonce is retried once with the nonce the node named.
 *
 * Whether the payment happened is NOT decided here: relaySignedDelegate returns the FINAL
 * outcome as the node gave it, and proof.ts decides from that outcome whether the token moved
 * the money. A transaction that is final is not yet a payment.
 */
import { createHash } from 'node:crypto'
import { KeyPair, PublicKey, type KeyPairString } from '@near-js/crypto'
import { baseDecode, baseEncode } from '@near-js/utils'
import type { FacilitatorNearSigner } from '@x402/near'
import type { ChainDescriptor } from '../chains/types.js'
import {
  nearFinalBlock,
  nearRpc,
  nearRpcUrls,
  nearViewAccessKey,
  nearViewAccount,
  nearViewFunction,
  type NearReadDeps,
} from '../chains/near/client.js'
import { nearAccountKind } from '../chains/near/ids.js'

export const NEAR_X402_RELAYER_ACCOUNT_ENV = 'NEAR_X402_RELAYER_ACCOUNT'
export const NEAR_X402_RELAYER_KEY_ENV = 'NEAR_X402_RELAYER_KEY'

/** The relayer, as the rest of the rail sees it. `sign` signs a 32-byte transaction hash; the
 *  secret is inside it and nowhere else. */
export type NearRelayer = {
  readonly accountId: string
  readonly publicKey: string
  readonly sign: (hash: Uint8Array) => Uint8Array
}

export type RelayerConfig = { ok: true; relayer: NearRelayer } | { ok: false; reason: string }

/** A testnet account: a named account under .testnet, or an implicit (key-derived) id, which
 *  exists on testnet as on any network. A mainnet name is refused: this rail is near:testnet only. */
function isTestnetAccount(id: string): boolean {
  const kind = nearAccountKind(id)
  if (!kind) return false
  return kind === 'named' ? id.endsWith('.testnet') : true
}

/**
 * The relayer the env names, or why there is none. Never throws, and never puts any part of
 * NEAR_X402_RELAYER_KEY in a reason.
 */
export function relayerFromEnv(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const accountId = env[NEAR_X402_RELAYER_ACCOUNT_ENV]?.trim() ?? ''
  const secret = env[NEAR_X402_RELAYER_KEY_ENV]?.trim() ?? ''
  const missing = [accountId ? null : NEAR_X402_RELAYER_ACCOUNT_ENV, secret ? null : NEAR_X402_RELAYER_KEY_ENV].filter(Boolean)
  if (missing.length) {
    return {
      ok: false,
      reason: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set, so there is no relayer to broadcast a payment with`,
    }
  }
  if (!isTestnetAccount(accountId)) {
    return { ok: false, reason: `${NEAR_X402_RELAYER_ACCOUNT_ENV} must name a NEAR testnet account (a name ending in .testnet, or an implicit id): this rail runs on near:testnet only` }
  }
  const unusable = `${NEAR_X402_RELAYER_KEY_ENV} is set but is not an ed25519 NEAR secret key (ed25519:<base58>), so it was treated as unset`
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) return { ok: false, reason: unusable }
  let pair: KeyPair
  try {
    pair = KeyPair.fromString(secret as KeyPairString)
  } catch {
    // The parser's own message can quote a character of the key, so it is not passed on.
    return { ok: false, reason: unusable }
  }
  const publicKey = pair.getPublicKey().toString()
  const sign = (hash: Uint8Array): Uint8Array => pair.sign(hash).signature
  return { ok: true, relayer: Object.freeze({ accountId, publicKey, sign }) }
}

// -- the outer transaction, in Borsh ----------------------------------------------------------

/** nearcore's Action enum: CreateAccount 0, DeployContract 1, FunctionCall 2, Transfer 3, Stake 4,
 *  AddKey 5, DeleteKey 6, DeleteAccount 7, Delegate 8 (NEP-366). */
const DELEGATE_ACTION_INDEX = 8
/** KeyType::ED25519; the relayer key is ed25519 only (relayerFromEnv). */
const ED25519 = 0

const u8 = (n: number) => Uint8Array.of(n)
function u32(n: number): Uint8Array {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
function u64(n: bigint): Uint8Array {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}
function str(s: string): Uint8Array {
  const bytes = Buffer.from(s, 'utf8')
  return Buffer.concat([u32(bytes.length), bytes])
}

/**
 * The Borsh bytes of the outer transaction (Transaction V0): signer, the signer's public key, its
 * nonce, the receiver (the payer, whose delegate this is), a recent block hash, and one action,
 * Delegate, whose body is the buyer's SignedDelegate bytes exactly as signed. Relaying the bytes
 * rather than a re-encoding means what reaches the chain is what the buyer signed.
 */
export function encodeRelayTransaction(t: {
  signerId: string
  publicKey: string
  nonce: bigint
  receiverId: string
  blockHash: string
  signedDelegate: Uint8Array
}): Uint8Array {
  const pk = PublicKey.fromString(t.publicKey)
  const blockHash = baseDecode(t.blockHash)
  if (blockHash.length !== 32) throw new Error('a block hash is 32 bytes')
  return Buffer.concat([
    str(t.signerId),
    u8(pk.keyType),
    pk.data,
    u64(t.nonce),
    str(t.receiverId),
    blockHash,
    u32(1),
    u8(DELEGATE_ACTION_INDEX),
    t.signedDelegate,
  ])
}

/** The hash nearcore names a transaction by (base58 of sha256 of its Borsh bytes), and the signed
 *  transaction to send (the bytes, then the signature: key type and 64 bytes). */
export function signRelayTransaction(relayer: Pick<NearRelayer, 'sign'>, txBytes: Uint8Array): { txHash: string; signed: Uint8Array } {
  const digest = new Uint8Array(createHash('sha256').update(txBytes).digest())
  const signature = relayer.sign(digest)
  if (signature.length !== 64) throw new Error('an ed25519 signature is 64 bytes')
  return { txHash: baseEncode(digest), signed: Buffer.concat([txBytes, u8(ED25519), signature]) }
}

// -- what the node says about a transaction -----------------------------------------------------

/** The slice of a NEAR transaction outcome (send_tx, tx, EXPERIMENTAL_tx_status) this rail reads. */
export type NearTxResult = {
  final_execution_status?: string
  status?: Record<string, unknown>
  transaction?: {
    hash?: string
    signer_id?: string
    receiver_id?: string
    public_key?: string
    nonce?: number | string
    actions?: unknown[]
  }
  transaction_outcome?: { id?: string; block_hash?: string; outcome?: { executor_id?: string; status?: Record<string, unknown>; logs?: string[] } }
  receipts_outcome?: { id?: string; block_hash?: string; outcome?: { executor_id?: string; status?: Record<string, unknown>; logs?: string[] } }[]
}

export type RelayOutcome =
  /** The node answered FINAL: every receipt, refunds included, has executed. Not yet a payment. */
  | { kind: 'final'; txHash: string; result: NearTxResult; host: string }
  /** A decided refusal: the transaction was never included, so nothing of it can land later. */
  | { kind: 'refused'; txHash: string; reason: string }
  /** Sent, and no FINAL answer arrived inside the wait. It may still land: look it up by txHash. */
  | { kind: 'unknown'; txHash: string; reason: string }

export type RelayDeps = NearReadDeps & {
  env?: NodeJS.ProcessEnv
  /** How long the send waits for FINAL, in ms. FastNEAR holds a send for up to 30 s and then
   *  answers 408; this ends well before that, and before the site's proxy cuts the request. */
  sendTimeoutMs?: number
  /** How long a send that did not answer is looked up by hash afterwards, in ms. */
  lookupMs?: number
  /** Pause between two lookups, in ms. */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const SEND_TIMEOUT_MS = 15_000
const LOOKUP_MS = 8_000
const POLL_MS = 1_000

const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Find nearcore's InvalidNonce detail anywhere in an error's info. */
function invalidNonceIn(x: unknown, depth = 0): { akNonce: bigint } | null {
  if (!x || typeof x !== 'object' || depth > 8) return null
  const o = x as Record<string, unknown>
  const inv = o.InvalidNonce as Record<string, unknown> | undefined
  if (inv && typeof inv === 'object' && /^\d+$/.test(String(inv.ak_nonce ?? ''))) return { akNonce: BigInt(String(inv.ak_nonce)) }
  for (const v of Object.values(o)) {
    const hit = invalidNonceIn(v, depth + 1)
    if (hit) return hit
  }
  return null
}

type SendAnswer =
  | { kind: 'final'; result: NearTxResult; host: string }
  | { kind: 'refused'; reason: string; invalidNonce?: { akNonce: bigint } }
  | { kind: 'unknown'; reason: string }

/** send_tx with wait_until FINAL, to the primary host only. */
async function sendTx(chain: ChainDescriptor, signed: Uint8Array, deps: RelayDeps): Promise<SendAnswer> {
  const url = nearRpcUrls(chain, deps.env ?? process.env)[0]
  const host = new URL(url).host
  const fetchImpl = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'a-identity',
        method: 'send_tx',
        params: { signed_tx_base64: Buffer.from(signed).toString('base64'), wait_until: 'FINAL' },
      }),
      signal: AbortSignal.timeout(deps.sendTimeoutMs ?? SEND_TIMEOUT_MS),
    })
  } catch (e) {
    return { kind: 'unknown', reason: `the send to ${host} did not answer (${msg(e)})` }
  }
  let body: { result?: NearTxResult; error?: { name?: string; cause?: string | { name?: string; info?: unknown }; data?: unknown; message?: string } }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return { kind: 'unknown', reason: `${host} answered HTTP ${res.status} with no JSON-RPC body` }
  }
  if (body?.error) {
    const cause = typeof body.error.cause === 'string' ? body.error.cause : body.error.cause?.name
    const info = typeof body.error.cause === 'object' ? body.error.cause?.info : undefined
    if (cause === 'INVALID_TRANSACTION' || body.error.name === 'REQUEST_VALIDATION_ERROR') {
      const nonce = invalidNonceIn(info ?? body.error.data)
      return {
        kind: 'refused',
        reason: `${host} refused the transaction (${cause ?? body.error.name}): ${short(JSON.stringify(info ?? body.error.data ?? body.error.message ?? ''))}`,
        ...(nonce ? { invalidNonce: nonce } : {}),
      }
    }
    return { kind: 'unknown', reason: `${host} answered ${cause ?? body.error.name ?? 'an error'} (HTTP ${res.status}), which does not say whether the transaction was included` }
  }
  const status = body?.result?.final_execution_status
  if (status === 'FINAL') return { kind: 'final', result: body.result as NearTxResult, host }
  return { kind: 'unknown', reason: `${host} answered ${status ?? 'no status'}, not FINAL` }
}

/**
 * Read a transaction by hash until it is FINAL or `until` passes. A read, so it may ask every
 * host (the archival one last); a host that has not seen the hash says nothing about the chain.
 */
export async function lookupFinal(
  chain: ChainDescriptor,
  txHash: string,
  senderId: string,
  until: number,
  deps: RelayDeps = {},
): Promise<{ kind: 'final'; txHash: string; result: NearTxResult; host: string } | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (;;) {
    try {
      // wait_until NONE answers at once: the whole outcome once the node has it, FINAL included.
      const a = await nearRpc<NearTxResult>(chain, 'tx', { tx_hash: txHash, sender_account_id: senderId, wait_until: 'NONE' }, deps.env ?? process.env, deps)
      if (a.kind === 'ok' && a.result?.final_execution_status === 'FINAL') return { kind: 'final', txHash, result: a.result, host: a.host }
    } catch {
      /* no host has it yet, or none answered: ask again */
    }
    if (now() >= until) return null
    await sleep(deps.pollMs ?? POLL_MS)
  }
}

// -- one relayer key, one transaction at a time -------------------------------------------------

const tails = new Map<string, Promise<void>>()
const lastNonce = new Map<string, bigint>()

async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve()
  let done!: () => void
  const after = new Promise<void>((resolve) => {
    done = resolve
  })
  const tail = before.then(() => after)
  tails.set(key, tail)
  try {
    await before
    return await run()
  } finally {
    done()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/** Forget the nonces this process used. Tests only. */
export function __resetRelayForTests(): void {
  lastNonce.clear()
  tails.clear()
}

/**
 * Put the buyer's SignedDelegate on chain from our relayer and wait for FINAL.
 *
 * `beforeSend` gets each transaction hash after signing and before its send; if it throws,
 * nothing is sent. A refused nonce signs once more with the nonce the node named, which is a new
 * transaction with a new hash (the refused one was never included).
 */
export async function relaySignedDelegate(
  input: {
    chain: ChainDescriptor
    relayer: NearRelayer
    payer: string
    signedDelegate: Uint8Array
    beforeSend: (txHash: string) => void | Promise<void>
  },
  deps: RelayDeps = {},
): Promise<RelayOutcome> {
  const { chain, relayer } = input
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const keyId = `${relayer.accountId}/${relayer.publicKey}`
  return oneAtATime(keyId, async () => {
    const [ak, block] = await Promise.all([nearViewAccessKey(chain, relayer.accountId, relayer.publicKey, env, deps), nearFinalBlock(chain, env, deps)])
    if (!ak.exists) return { kind: 'refused', txHash: '', reason: `the relayer key is not an access key of ${relayer.accountId}, so nothing was signed` }
    if (ak.permission !== 'FullAccess') return { kind: 'refused', txHash: '', reason: `the relayer key on ${relayer.accountId} is not a full-access key, so it cannot sign a Delegate action; nothing was signed` }
    let nonce = ak.nonce + 1n
    const used = lastNonce.get(keyId)
    if (used !== undefined && used >= nonce) nonce = used + 1n
    for (let attempt = 0; ; attempt++) {
      const txBytes = encodeRelayTransaction({
        signerId: relayer.accountId,
        publicKey: relayer.publicKey,
        nonce,
        receiverId: input.payer,
        blockHash: block.hash,
        signedDelegate: input.signedDelegate,
      })
      const { txHash, signed } = signRelayTransaction(relayer, txBytes)
      await input.beforeSend(txHash)
      lastNonce.set(keyId, nonce)
      const sent = await sendTx(chain, signed, deps)
      if (sent.kind === 'final') return { kind: 'final', txHash, result: sent.result, host: sent.host }
      if (sent.kind === 'refused') {
        if (sent.invalidNonce && attempt === 0) {
          nonce = sent.invalidNonce.akNonce >= nonce ? sent.invalidNonce.akNonce + 1n : nonce + 1n
          continue
        }
        return { kind: 'refused', txHash, reason: sent.reason }
      }
      const found = await lookupFinal(chain, txHash, relayer.accountId, now() + (deps.lookupMs ?? LOOKUP_MS), deps)
      return found ?? { kind: 'unknown', txHash, reason: sent.reason }
    }
  })
}

// -- the reads @x402/near's verify runs, from this backend's own NEAR client ------------------

/**
 * @x402/near's facilitator verify (ExactNearScheme.verify) reads the chain through a
 * FacilitatorNearSigner. This one answers from chains/near/client.ts, every read at final
 * finality against the registry descriptor's hosts, so the verification runs in this process
 * with no host of its own. It cannot submit: settle() is never called on it, because the rail
 * relays with relaySignedDelegate above, which records the hash before it sends.
 */
export function nearVerifyReads(chain: ChainDescriptor, relayerId: string, deps: RelayDeps = {}): FacilitatorNearSigner {
  const env = deps.env ?? process.env
  const onNetwork = (network: string) => {
    if (network !== chain.caip2) throw new Error(`this rail reads ${chain.caip2} only, not ${network}`)
  }
  return {
    getRelayerIds: () => [relayerId],
    async getCurrentBlockHeight(network) {
      onNetwork(network)
      return BigInt((await nearFinalBlock(chain, env, deps)).height)
    },
    async viewAccount({ network, accountId }) {
      onNetwork(network)
      const a = await nearViewAccount(chain, accountId, env, deps)
      return a.exists ? { codeHash: a.codeHash } : null
    },
    async viewAccessKey({ network, accountId, publicKey }) {
      onNetwork(network)
      const k = await nearViewAccessKey(chain, accountId, publicKey, env, deps)
      return k.exists ? { nonce: k.nonce, permissionKind: k.permission } : null
    },
    async ftBalanceOf({ network, token, accountId }) {
      onNetwork(network)
      const v = await nearViewFunction(chain, token, 'ft_balance_of', { account_id: accountId }, env, deps)
      if (!v.ok || typeof v.value !== 'string' || !/^\d+$/.test(v.value)) throw new Error(`ft_balance_of on ${token} gave no balance`)
      return BigInt(v.value)
    },
    async storageBalanceOf({ network, token, accountId }) {
      onNetwork(network)
      const v = await nearViewFunction(chain, token, 'storage_balance_of', { account_id: accountId }, env, deps)
      if (v.ok) return { supported: true, registered: v.value != null }
      if (/MethodNotFound|MethodResolveError/.test(v.reason)) return { supported: false }
      throw new Error(`storage_balance_of on ${token} failed: ${v.reason}`)
    },
    async submitSignedDelegateAction() {
      throw new Error('not used: this rail relays with near-x402/relay.ts, which records the transaction hash before it sends')
    },
  }
}
