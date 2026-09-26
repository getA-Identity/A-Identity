import { createContext, useContext } from 'react'
import type { PayWallet } from '../../lib/algorand/purchase'
import type { UsdcHolding } from '../../lib/algorand/x402pay'

/** The USDC balance of the connected wallet, read from algod; `address` says whose it is. */
export type Balance = { s: 'loading'; address: string } | { s: 'ok'; address: string; holding: UsdcHolding } | { s: 'error'; address: string }

/** The one Algorand wallet the /check page pays from, connected once at the top of the page. */
export type CheckWallet = {
  wallet: PayWallet | null
  /** A wallet used earlier in this tab is being picked up again, silently. */
  restoring: boolean
  balance: Balance | null
  /** Open the wallet list to connect (the wallet bar). */
  openConnect: () => void
  /** Open the wallet list for one payment: the wallet, 'cancelled' in the wallet, or null when the list was closed. */
  askWallet: (price: string) => Promise<PayWallet | 'cancelled' | null>
  disconnect: () => void
  refreshBalance: () => void
  /** A payment is out somewhere on the page: other Pay buttons and Disconnect wait. */
  paying: boolean
  /** Marks a payment as out; call the returned function when it ends (calling it twice is harmless). */
  holdPayment: () => () => void
}

export const CheckWalletContext = createContext<CheckWallet | null>(null)

export function useCheckWallet(): CheckWallet {
  const c = useContext(CheckWalletContext)
  if (!c) throw new Error('useCheckWallet must be used inside CheckWalletProvider.')
  return c
}
