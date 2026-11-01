/**
 * Send a contract call with its hash known first.
 *
 * writeContract knows a hash only once a host has answered. A host that accepts the transaction
 * and loses the connection throws instead, the fallback transport resends it to the next host,
 * which answers "already known" or "nonce too low", and that error reads as a failure while the
 * transaction lands. So this signs locally, tells the caller the hash, and only then sends.
 *
 * It prepares the way writeContract does for a local account, because it is the same action:
 * viem's prepareTransactionRequest fills the chain id, the transaction type, the fees (the
 * chain's own fee hooks if it declares any, else the block's base fee and the node's tip), the
 * gas estimate and the pending nonce. A node's refusal at estimation throws before anything is
 * signed. Everything up to the send moves nothing, so a throw from here means nothing was sent.
 *
 * The nonce. One signer sends for every settlement on a chain, and two that prepare together
 * read the same pending nonce, so prepare, sign, note and send run one at a time per signer and
 * chain. The next one reads the nonce after the last one was sent, and a host's pending count
 * can lag a transaction another host just took (some hosts answer "pending" from the latest
 * block), so the nonce after an accepted send is kept as a floor for a short while. A send that
 * threw leaves no floor: if no node took it, a floor would leave a gap that stalls everything
 * behind it. Worst case, the next send reuses that nonce, and then the loser can never land,
 * which canNeverLand (./receipts.ts) proves later. This lock is process-local, like the other
 * in-flight guards in this codebase, and only sends that come through here take it.
 */
import { encodeFunctionData, keccak256, type Hex } from 'viem'
import type { ChainDescriptor } from '../types.js'
import { hashOnEveryRpc, type EveryRpcOptions } from './receipts.js'

/** The slice of a viem wallet client a signed send uses. */
export type SigningClient = {
  prepareTransactionRequest: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
  signTransaction: (req: Record<string, unknown>) => Promise<Hex>
  sendRawTransaction: (req: { serializedTransaction: Hex }) => Promise<Hex>
}

export type SignedCall = { address: Hex; abi: unknown; functionName: string; args: readonly unknown[] }

/** What identifies a signed transaction before any node has seen it. */
export type SignedTx = {
  hash: Hex
  /** The nonce it was signed with, so a later read can tell it can never land. */
  nonce?: number
  from?: string
}

export type SignedSend = SignedTx &
  (
    /** A node accepted it. */
    | { status: 'sent' }
    /** A node turned it away and every RPC was asked and has no such transaction. */
    | { status: 'refused'; reason: string; error: unknown }
    /** The send did not answer cleanly, so whether a node took it is unknown. */
    | { status: 'unknown'; reason: string }
    /** The caller could not note the hash, so it was not sent. */
    | { status: 'not_noted'; reason: string }
  )

export type SendOptions = {
  /** Runs after signing and before the send. If it throws, nothing is sent. */
  beforeSend?: (tx: SignedTx) => void | Promise<void>
  env?: NodeJS.ProcessEnv
  /** Options for the read that checks a refusal. Injected by tests. */
  rpc?: EveryRpcOptions
  /** How long to wait for the signer's turn. */
  queueWaitMs?: number
}

/**
 * A node's answer that means it did not take this transaction, if no other host has it either.
 * Deliberately short: "already known" and "nonce too low" are NOT here, because they are what a
 * resend hears when the first host accepted it.
 */
const NODE_TURNED_IT_AWAY = /insufficient funds|intrinsic gas|fee cap|underpriced|max fee per gas less than|exceeds (block )?gas limit/i

const QUEUE_WAIT_MS = 10_000
const SEND_DEADLINE_MS = 12_000
const FLOOR_TTL_MS = 60_000
const REFUSAL_LOOK = { perCallTimeoutMs: 3_000, hardTimeoutMs: 8_000 }

/** Nothing was sent: the signer stayed busy for longer than this request can wait. */
export class SignerBusyError extends Error {}

const queues = new Map<string, Promise<void>>()
const floors = new Map<string, { next: number; at: number }>()

/** TEST-ONLY: forget every kept nonce floor. Production code never calls this. */
export function __resetSendStateForTests(): void {
  floors.clear()
}

async function withinSendDeadline<T>(send: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the send did not answer within ${SEND_DEADLINE_MS} ms`)), SEND_DEADLINE_MS)
  })
  try {
    return await Promise.race([send, late])
  } finally {
    if (timer) clearTimeout(timer)
    send.catch(() => {})
  }
}

/** Run `fn` when every earlier sender on this key has finished, or refuse past the wait. */
async function inTurn<T>(key: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = before.then(() => mine)
  queues.set(key, tail)
  // Deliberately not unref'd: a deadline that lets the process exit is not a deadline.
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs)
  })
  try {
    const myTurn = await Promise.race([before.then(() => true as const), gaveUp])
    if (!myTurn) throw new SignerBusyError(`the signer stayed busy for ${waitMs} ms, so this was neither signed nor sent`)
    return await fn()
  } finally {
    if (timer) clearTimeout(timer)
    release()
    if (queues.get(key) === tail) queues.delete(key)
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * What a node said, safe to hand on. A viem error's message carries the request body and the URL
 * it went to, and an RPC URL from an env override can carry a key, so only the node's own words
 * leave here. Exported because the prepare step fails the same way.
 */
export function nodeSaid(e: unknown): string {
  const { details, shortMessage } = (e ?? {}) as { details?: unknown; shortMessage?: unknown }
  if (typeof details === 'string' && details) return details
  if (typeof shortMessage === 'string' && shortMessage) return shortMessage
  return msg(e)
}

/**
 * Prepare, sign, note and send one contract call. Throws only when nothing was sent: a failed
 * prepare or sign, or a busy signer. Every answer from here on names the hash.
 */
export async function sendCallSigned(
  chain: ChainDescriptor,
  signer: { client: unknown; account?: { address: string } },
  call: SignedCall,
  opts: SendOptions = {},
): Promise<SignedSend> {
  const wallet = signer.client as SigningClient
  const from = signer.account?.address ?? (signer.client as { account?: { address?: string } }).account?.address
  const key = `${chain.id}:${(from ?? 'unknown').toLowerCase()}`
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never)

  return inTurn(key, opts.queueWaitMs ?? QUEUE_WAIT_MS, async () => {
    const prepared = await wallet.prepareTransactionRequest({ ...(signer.account ? { account: signer.account } : {}), to: call.address, data })
    let nonce = typeof prepared.nonce === 'number' ? prepared.nonce : undefined
    const floor = floors.get(key)
    if (floor && (Date.now() - floor.at > FLOOR_TTL_MS || (nonce !== undefined && nonce >= floor.next))) floors.delete(key)
    else if (floor && nonce !== undefined) nonce = floor.next
    const serializedTransaction = await wallet.signTransaction(nonce === undefined ? prepared : { ...prepared, nonce })
    const hash = keccak256(serializedTransaction)
    const tx: SignedTx = { hash, ...(nonce !== undefined ? { nonce } : {}), ...(from ? { from } : {}) }

    try {
      await opts.beforeSend?.(tx)
    } catch (err) {
      return { ...tx, status: 'not_noted', reason: msg(err) }
    }

    try {
      // A host that hangs must not hold every settlement behind this one. The send keeps running,
      // and the row already names its hash, so this is the same "may have landed" as a lost answer.
      await withinSendDeadline(wallet.sendRawTransaction({ serializedTransaction }))
    } catch (err) {
      const said = nodeSaid(err)
      if (!NODE_TURNED_IT_AWAY.test(said)) return { ...tx, status: 'unknown', reason: said }
      // A resend hears this too: one host took it and the next, with a higher price floor, says
      // underpriced. It went nowhere only if no host has it.
      const seen = await hashOnEveryRpc(chain, hash, { env: opts.env, ...opts.rpc, ...REFUSAL_LOOK, timeoutMs: 0 })
      if (seen === 'absent') return { ...tx, status: 'refused', reason: said, error: err }
      return { ...tx, status: 'unknown', reason: `${said} (${seen === 'held' ? 'and an RPC host has it' : 'and not every RPC host could be asked for it'})` }
    }
    if (nonce !== undefined) floors.set(key, { next: nonce + 1, at: Date.now() })
    return { ...tx, status: 'sent' }
  })
}
