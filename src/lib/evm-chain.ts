/**
 * Putting an EIP-1193 wallet on a chain before anything is signed against it, and telling a
 * person's "no" in the wallet from the wallet failing.
 *
 * No runtime imports, on purpose: mcp/src/frontend-arc-vault.test.ts loads the Arc vault's send
 * path (src/lib/arc/send.ts) straight from src/ through Node's type stripping and drives it with
 * a fake wallet, and that path switches chains through this. src/lib/wallets.ts re-exports all of
 * it, so every other caller is unchanged.
 */
import type { Chain } from './chains'

export type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>
  isMetaMask?: boolean
  /** EIP-1193 events (accountsChanged, chainChanged). Optional: not every provider exposes them. */
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

/** The hex chain id wallets speak, from the registry's decimal one. */
export const evmChainHex = (chain: Chain): string => '0x' + (chain.chainId as number).toString(16)

/**
 * The name a wallet is asked to add a chain under, where it differs from ours. MetaMask compares it
 * with its public chain list (chainid.network) and warns when they differ, on the first screen an
 * owner sees after pressing Deploy. That list and Arc's own docs call Arc Mainnet "Arc". Ours stays
 * "Arc Mainnet" everywhere else, so the page itself is never read as talking about the testnet.
 */
const WALLET_CHAIN_NAME: Readonly<Record<string, string>> = { 'arc-mainnet': 'Arc' }

export const walletChainName = (chain: Chain): string => WALLET_CHAIN_NAME[chain.id] ?? chain.name

const WALLET_BUSY = 'Your wallet already has a request open. Open it, finish or dismiss it, then try again.'

function walletBusy(e: unknown): boolean {
  return walletCode(e) === -32002 || /already pending|already processing/i.test(walletMessage(e))
}

/**
 * Make sure the wallet is on `chain` before anything is signed against it. Otherwise a
 * transfer meant for Arc would be broadcast to the Arc USDC address on whatever chain is
 * active, which on Ethereum mainnet is a real, confusing and possibly fund-losing
 * transaction. Switches, and adds the chain from the registry's own facts when the wallet
 * has never seen it. This used to exist for Arc alone; every registry chain now gets it.
 */
export async function ensureEvmChain(eth: Eip1193, chain: Chain): Promise<void> {
  if (chain.chainId == null || !chain.evmCompatible) throw new Error(`${chain.name} is not an EVM chain; a browser wallet cannot switch to it.`)
  const hex = evmChainHex(chain)
  if ((await readChainHex(eth)) === hex) return
  const switchTo = () => eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  try {
    await switchTo()
  } catch (err) {
    if (isWalletRejection(err)) throw new Error(`You declined to switch your wallet to ${chain.name}.`)
    if (walletBusy(err)) throw new Error(WALLET_BUSY)
    // "I do not know this chain" arrives in several shapes: 4902, a -32603 wrapping 4902 in
    // data.originalError (MetaMask mobile, some Rabby builds), or text only. Matching one
    // shape is what used to leave people with "switch your wallet" and nothing to press.
    // Whatever the shape, adding the chain from the registry and switching again is the fix.
    try {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex,
          chainName: walletChainName(chain),
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrl ? [chain.rpcUrl] : [],
          blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        }],
      })
    } catch (addErr) {
      if (isWalletRejection(addErr)) throw new Error(`You declined to add ${chain.name} to your wallet.`)
      if (walletBusy(addErr)) throw new Error(WALLET_BUSY)
      // A phone wallet connected without this chain lands here, with a library's own error text
      // that means nothing to the person reading it, so that text is not shown.
      throw new Error(
        `Your wallet could not add ${chain.name}. The simplest way is a computer browser with the MetaMask or Rabby extension. ` +
          `With a phone wallet, add it in the wallet first (chain id ${chain.chainId}, RPC ${chain.rpcUrl ?? 'not published'}), then forget the wallet on this page and connect it again.`,
      )
    }
    // Most wallets switch as part of adding; the ones that do not get asked once more.
    try {
      await switchTo()
    } catch (again) {
      if (isWalletRejection(again)) throw new Error(`You declined to switch your wallet to ${chain.name}.`)
    }
  }
  // The wallet's own answer decides, not the absence of an error: a switch that "succeeded"
  // without moving would send the payment to the wrong chain.
  for (let i = 0; i < 4; i++) {
    if ((await readChainHex(eth)) === hex) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Your wallet is still on another network. Switch it to ${chain.name}, then try again.`)
}

/**
 * Ask the wallet which accounts this site may see. Pressing Connect again cannot do this: a wallet
 * like MetaMask answers eth_requestAccounts with the accounts it already allows, with no screen,
 * and switching to an account it does not allow here changes nothing the page can see.
 */
export async function askForAnotherAccount(eth: Eip1193): Promise<void> {
  try {
    await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
  } catch (e) {
    if (isWalletRejection(e)) throw new Error('You kept the account that was connected. Nothing changed.')
    if (walletBusy(e)) throw new Error(WALLET_BUSY)
    throw new Error("Your wallet would not change account from this page. Open the wallet's list of connected sites, remove this site, then connect again with the account you want active.")
  }
}

async function readChainHex(eth: Eip1193): Promise<string> {
  const c = await eth.request({ method: 'eth_chainId' })
  if (typeof c === 'string') return c.toLowerCase()
  if (typeof c === 'number') return '0x' + c.toString(16)
  return ''
}

function walletCode(e: unknown): number | undefined {
  const o = e as { code?: unknown; data?: { originalError?: { code?: unknown } }; cause?: { code?: unknown } } | null
  const c = o?.code ?? o?.data?.originalError?.code ?? o?.cause?.code
  return typeof c === 'number' ? c : undefined
}

function walletMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return typeof e === 'string' ? e : ''
}

/** True when the person said no in the wallet, as opposed to the wallet failing. */
export function isWalletRejection(e: unknown): boolean {
  return walletCode(e) === 4001 || /user rejected|rejected by user|user denied|denied by user|cancel/i.test(walletMessage(e))
}
