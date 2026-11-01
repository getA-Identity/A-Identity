/**
 * The last step of every write on the Arc vault page: handing a prepared transaction to the
 * owner's own wallet, and turning whatever comes back into a typed result.
 *
 * Its runtime imports are only modules with none of their own, named with their .ts extension,
 * on purpose: mcp/src/frontend-arc-vault.test.ts loads this file straight from src/ through
 * Node's type stripping and drives sendPrepared with a fake EIP-1193 wallet that records every
 * request, so "a wrong chain, a wrong account or a fee under the floor sends nothing" is a thing
 * the suite watches happen, not a line it searches for.
 */
import type { Hex } from 'viem'
import { ensureEvmChain, isWalletRejection, type Eip1193 } from '../evm-chain.ts'
import type { PreparedTx } from './vault-write'
import { FEE_FLOOR_WEI, sameAddress } from './vault-rules.ts'

export type TxStep = 'checking' | 'simulating' | 'switching' | 'wallet' | 'submitted'

export const STEP_LABEL: Record<TxStep, string> = {
  checking: 'Reading the chain',
  simulating: 'Simulating as the owner',
  switching: 'Checking your wallet network',
  wallet: 'Waiting for your wallet',
  submitted: 'Submitted',
}

export type TxFailureCode =
  | 'refused'
  | 'reverted_in_simulation'
  | 'not_this_build'
  | 'insufficient_gas'
  | 'rpc_unreachable'
  | 'no_wallet'
  | 'rejected'
  | 'wrong_chain'
  | 'account_mismatch'
  | 'wallet_pending'
  | 'fee_too_low'
  | 'nonce'
  | 'wallet_error'

export type TxFailure = { code: TxFailureCode; message: string; errorName?: string }

/** A stop with a typed reason. Thrown by the page's own modules and turned into a TxFailure by the page. */
export class TxStop extends Error {
  readonly failure: TxFailure
  constructor(failure: TxFailure) {
    super(failure.message)
    this.name = 'TxStop'
    this.failure = failure
  }
}

export const txStop = (code: TxFailureCode, message: string, errorName?: string) => new TxStop({ code, message, ...(errorName ? { errorName } : {}) })

/** An error's own short message, whoever threw it (viem's errors carry a shortMessage). */
export function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { shortMessage?: unknown }).shortMessage === 'string') return (e as { shortMessage: string }).shortMessage
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return typeof e === 'string' ? e : ''
}

function codeOf(e: unknown): number | undefined {
  let x: unknown = e
  for (let i = 0; i < 8 && x && typeof x === 'object'; i++) {
    const o = x as { code?: unknown; data?: { originalError?: { code?: unknown } }; cause?: unknown }
    if (typeof o.code === 'number') return o.code
    if (typeof o.data?.originalError?.code === 'number') return o.data.originalError.code
    x = o.cause
  }
  return undefined
}

/** Any thrown value as a typed failure, never an uncaught one. */
export function failureOf(e: unknown): TxFailure {
  if (e instanceof TxStop) return e.failure
  // vault-read.ts's RpcUnreachableError, known by its name so this file needs no network module.
  if (e instanceof Error && e.name === 'RpcUnreachableError') return { code: 'rpc_unreachable', message: e.message }
  if (isWalletRejection(e) || codeOf(e) === 4001) return { code: 'rejected', message: 'You declined in your wallet. Nothing was sent.' }
  const msg = messageOf(e)
  const code = codeOf(e)
  if (code === -32002 || /already pending|already processing/i.test(msg))
    return { code: 'wallet_pending', message: 'Your wallet already has a request open. Finish or dismiss it there, then try again.' }
  if (code === 4100) return { code: 'account_mismatch', message: 'Your wallet has not authorized this account for this site. Connect it again.' }
  if (/insufficient funds/i.test(msg)) return { code: 'insufficient_gas', message: msg }
  if (/fee cap|max fee per gas|underpriced|base fee/i.test(msg)) return { code: 'fee_too_low', message: msg }
  if (/nonce/i.test(msg)) return { code: 'nonce', message: msg }
  if (/chain ?id|wrong chain|chain mismatch/i.test(msg)) return { code: 'wrong_chain', message: msg }
  return { code: 'wallet_error', message: msg || 'The wallet stopped the request without saying why.' }
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`

/**
 * Hand a prepared write to the owner's wallet. The chain is checked twice: ensureEvmChain
 * switches (or adds) it, and then eth_chainId is read again immediately before sending, so a
 * network change in between can never send this to another chain. The account is checked the
 * same way. `onStep('wallet')` is the last thing before eth_sendTransaction, so a caller that
 * must leave a trace of a request the wallet may send (the deploy) can save it there. Returns
 * the hash the moment the wallet gives it.
 */
export async function sendPrepared(provider: Eip1193, p: PreparedTx, onStep: (s: TxStep) => void): Promise<Hex> {
  if (p.maxFeePerGas < FEE_FLOOR_WEI) throw txStop('fee_too_low', 'The prepared fee is under the 20 gwei floor Arc enforces. Nothing was sent.')
  if (p.action === 'deploy' && p.to !== null) throw txStop('refused', 'A deploy has no recipient. Nothing was sent.')
  if (typeof p.chain.chainId !== 'number') throw txStop('wrong_chain', `${p.chain.name} has no EVM chain id. Nothing was sent.`)
  onStep('switching')
  try {
    await ensureEvmChain(provider, p.chain)
  } catch (e) {
    throw txStop(isWalletRejection(e) ? 'rejected' : 'wrong_chain', messageOf(e) || `Your wallet could not switch to ${p.chain.name}.`)
  }
  let walletChain: number
  let account: string | undefined
  try {
    const id = await provider.request({ method: 'eth_chainId' })
    walletChain = typeof id === 'string' ? parseInt(id, 16) : Number(id)
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[] | undefined
    account = accounts?.[0]
  } catch (e) {
    throw txStop('wallet_error', `Your wallet did not say which chain and account it is on: ${messageOf(e)}`)
  }
  if (walletChain !== p.chain.chainId)
    throw txStop('wrong_chain', `Your wallet is on chain ${walletChain}; this transaction is for ${p.chain.name} (chain ${p.chain.chainId}). Nothing was sent.`)
  if (!sameAddress(account, p.from))
    throw txStop(
      'account_mismatch',
      `Your wallet's active account is ${account ?? 'none'}, but this transaction is from ${p.from}. Pick that account in your wallet. Nothing was sent.`,
    )
  onStep('wallet')
  const tx = {
    from: p.from,
    ...(p.to ? { to: p.to } : {}),
    data: p.data,
    value: '0x0',
    gas: hex(p.gas),
    maxFeePerGas: hex(p.maxFeePerGas),
    maxPriorityFeePerGas: hex(p.maxPriorityFeePerGas),
    chainId: hex(p.chain.chainId),
  }
  let hash: unknown
  try {
    hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] })
  } catch (e) {
    throw new TxStop(failureOf(e))
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw txStop('wallet_error', "The wallet returned no transaction hash, so nothing can be tracked. Check your wallet's activity list before trying again.")
  onStep('submitted')
  return hash as Hex
}
