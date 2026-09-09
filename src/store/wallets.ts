/**
 * The wallets connected in this browser, one per ecosystem, remembered between screens.
 *
 * This is memory, not authority: it holds addresses and connector ids so the console can
 * show "Freighter, GBMF...ZZ3, connected" and reuse the same wallet for a later signature,
 * never a key and never a session. Whether a wallet is linked to the ACCOUNT is the
 * backend's record (GET /api/user/wallets), which the profile screen reads separately.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ConnectedWallet, Ecosystem, WalletSigner } from '../lib/wallet/types'

const signers: Partial<Record<Ecosystem, WalletSigner>> = {}

/** The live signer for an ecosystem, if one was connected in this tab. Not persisted. */
export function getSigner(ecosystem: Ecosystem): WalletSigner | null {
  return signers[ecosystem] ?? null
}

type WalletsState = {
  connected: Partial<Record<Ecosystem, ConnectedWallet>>
  /** Remember a signer as the connected wallet of its ecosystem. */
  remember: (signer: WalletSigner) => void
  /** Forget an ecosystem's wallet, asking the connector to drop its session when it can. */
  forget: (ecosystem: Ecosystem) => Promise<void>
}

export const useWallets = create<WalletsState>()(
  persist(
    (set, get) => ({
      connected: {},
      remember: (signer) => {
        signers[signer.ecosystem] = signer
        set({
          connected: {
            ...get().connected,
            [signer.ecosystem]: {
              ecosystem: signer.ecosystem,
              address: signer.address,
              walletId: signer.walletId,
              walletName: signer.walletName,
              icon: signer.icon,
              network: signer.network ?? null,
              connectedAt: new Date().toISOString(),
            },
          },
        })
      },
      forget: async (ecosystem) => {
        const s = signers[ecosystem]
        delete signers[ecosystem]
        const next = { ...get().connected }
        delete next[ecosystem]
        set({ connected: next })
        if (s?.disconnect) await s.disconnect().catch(() => undefined)
      },
    }),
    { name: 'a-identity-wallets', partialize: (s) => ({ connected: s.connected }) },
  ),
)
