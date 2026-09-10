/**
 * Wallet-control signatures from contract accounts as well as keys.
 *
 * KYA asks an agent to sign a challenge with the wallet it claims. For an externally
 * owned account that is `personal_sign` and viem recovers the signer offline. A smart
 * contract account has no key to recover: the chain decides, through ERC-1271
 * `isValidSignature`, and viem's client-side `verifyMessage` asks it (wrapping
 * ERC-6492 for an account whose code is not deployed yet). Circle's agent wallets are
 * such accounts, provisioned by Circle CLI on Ethereum, Base, Arbitrum, Polygon,
 * Optimism, Avalanche and Unichain, so an agent whose wallet is one could never pass
 * KYA while the check was offline-only.
 *
 * Order of checks, and why: the offline recovery runs first because it needs no network
 * and answers for every key-held wallet. Only when it fails does the contract path run,
 * against the chain the caller named or, failing that, every EVM chain in the registry
 * that could host such an account, in parallel and bounded. The first chain that says
 * yes names the method and the chain on the proof; no chain saying yes is a plain no.
 *
 * Nothing here holds or asks for a credential. It reads.
 */
import { CHAINS, getChain, getChainById, type ChainDescriptor } from './chains/index.js'
import { evmPublicClient } from './chains/evm/client.js'

export type SignatureMethod = 'wallet-signature' | 'erc1271-signature'

export type SignatureVerdict =
  | { ok: true; method: 'wallet-signature' }
  | { ok: true; method: 'erc1271-signature'; chain: string }
  | { ok: false }

/** One chain's answer to "does this contract account accept this signature". */
export type ContractSignatureCheck = (chain: ChainDescriptor, input: { address: string; message: string; signature: string }) => Promise<boolean>

export type SignatureDeps = {
  env?: NodeJS.ProcessEnv
  /** Injectable so tests never touch a network. */
  checkContract?: ContractSignatureCheck
  /** Per-chain deadline for the contract path. */
  timeoutMs?: number
}

const CONTRACT_CHECK_TIMEOUT_MS = 10_000

/** The default contract check: viem's client verifyMessage, which is ERC-1271 and ERC-6492 aware. */
export async function checkContractSignature(chain: ChainDescriptor, input: { address: string; message: string; signature: string }, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const client = await evmPublicClient(chain, env)
  return client.verifyMessage({ address: input.address as `0x${string}`, message: input.message, signature: input.signature as `0x${string}` })
}

/** Chains a contract account could live on: every EVM chain in the registry with an RPC,
 *  mainnets first, because that is where Circle provisions agent wallets. */
export function contractSignatureChains(): ChainDescriptor[] {
  const evm = CHAINS.filter((c) => c.ecosystem === 'evm' && c.rpcUrls.length > 0)
  return [...evm.filter((c) => !c.testnet), ...evm.filter((c) => c.testnet)]
}

/**
 * Verify a wallet signature over `message` for `address`, key or contract.
 *
 * `chain` narrows the contract path to one registry chain (id or CAIP-2). Without it
 * every candidate is asked at once; the first yes wins, and a chain that errors or
 * times out simply answers no. The timer is cleared, never unref'd.
 */
export async function verifyWalletSignature(
  input: { address: string; message: string; signature: string; chain?: string },
  deps: SignatureDeps = {},
): Promise<SignatureVerdict> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address) || typeof input.signature !== 'string' || !input.signature.startsWith('0x')) return { ok: false }
  const { verifyMessage } = await import('viem')
  try {
    if (await verifyMessage({ address: input.address as `0x${string}`, message: input.message, signature: input.signature as `0x${string}` })) {
      return { ok: true, method: 'wallet-signature' }
    }
  } catch {
    /* not a recoverable key signature; the contract path decides */
  }

  const candidates: ChainDescriptor[] = input.chain
    ? [getChain(input.chain) ?? getChainById(input.chain)].filter((c): c is ChainDescriptor => Boolean(c && c.ecosystem === 'evm'))
    : contractSignatureChains()
  if (!candidates.length) return { ok: false }

  const check = deps.checkContract ?? ((c, i) => checkContractSignature(c, i, deps.env ?? process.env))
  const timeoutMs = deps.timeoutMs ?? CONTRACT_CHECK_TIMEOUT_MS
  const bounded = (chain: ChainDescriptor): Promise<string | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const ask = check(chain, { address: input.address, message: input.message, signature: input.signature })
      .then((yes) => (yes ? chain.id : null))
      .catch(() => null)
    return Promise.race([ask, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
  const answers = await Promise.all(candidates.map(bounded))
  const hit = answers.find((a): a is string => typeof a === 'string')
  return hit ? { ok: true, method: 'erc1271-signature', chain: hit } : { ok: false }
}
