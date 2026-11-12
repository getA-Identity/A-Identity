/**
 * The page's NEAR wallet: which account is connected, through which wallet, and a way to hand it
 * a prepared transaction. Optional by design: every read on the page works without it.
 *
 * NEAR Connect is only downloaded when it is needed (see lib/near/wallet.ts). A restore on page
 * load happens only when this browser chose a wallet here before; from the first time the page
 * holds the connector, it follows sign-ins and sign-outs made in the wallet itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NearConnector } from '@hot-labs/near-connect'
import type { PreparedTx } from '../../../lib/near/calls'
import { hadNearSession, nearConnector, signAndSend, walletErrorText, type NearWalletBase } from '../../../lib/near/wallet'

export type NearWalletStatus = 'idle' | 'restoring' | 'connecting' | 'connected'

export type NearWalletState = {
  status: NearWalletStatus
  accountId: string | null
  walletName: string | null
  walletIcon: string | null
  /** The last connect error, in words. A closed picker is not an error and leaves this null. */
  error: string | null
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  /** Hand a prepared transaction to the connected wallet. Throws when none is connected. */
  send: (tx: PreparedTx) => Promise<unknown>
}

export function useNearWallet(): NearWalletState {
  const [status, setStatus] = useState<NearWalletStatus>(() => (hadNearSession() ? 'restoring' : 'idle'))
  const [accountId, setAccountId] = useState<string | null>(null)
  const [walletMeta, setWalletMeta] = useState<{ name: string; icon: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const walletRef = useRef<NearWalletBase | null>(null)
  const unfollow = useRef<(() => void) | null>(null)

  const adopt = useCallback((wallet: NearWalletBase, account: string | null) => {
    walletRef.current = wallet
    setAccountId(account)
    setWalletMeta({ name: wallet.manifest?.name ?? 'Your wallet', icon: wallet.manifest?.icon ?? '' })
    setStatus(account ? 'connected' : 'idle')
  }, [])

  const forget = useCallback(() => {
    walletRef.current = null
    setAccountId(null)
    setWalletMeta(null)
    setStatus('idle')
  }, [])

  const follow = useCallback(
    (connector: NearConnector) => {
      if (unfollow.current) return
      const onIn = (e: { wallet: NearWalletBase; accounts: { accountId: string }[] }) => adopt(e.wallet, e.accounts[0]?.accountId ?? null)
      const onOut = () => forget()
      connector.on('wallet:signIn', onIn)
      connector.on('wallet:signOut', onOut)
      unfollow.current = () => {
        connector.off('wallet:signIn', onIn)
        connector.off('wallet:signOut', onOut)
      }
    },
    [adopt, forget],
  )

  useEffect(
    () => () => {
      unfollow.current?.()
      unfollow.current = null
    },
    [],
  )

  // Restore a session this browser already has.
  useEffect(() => {
    if (!hadNearSession()) return
    let alive = true
    nearConnector()
      .then(async (connector) => {
        if (!alive) return
        follow(connector)
        const { wallet, accounts } = await connector.getConnectedWallet()
        if (alive) adopt(wallet, accounts[0]?.accountId ?? null)
      })
      .catch(() => {
        if (alive) forget()
      })
    return () => {
      alive = false
    }
  }, [adopt, forget, follow])

  const connect = useCallback(async () => {
    setError(null)
    setStatus('connecting')
    try {
      const connector = await nearConnector()
      follow(connector)
      const wallet = await connector.connect()
      const accounts = await wallet.getAccounts()
      adopt(wallet, accounts[0]?.accountId ?? null)
    } catch (e) {
      const { cancelled, text } = walletErrorText(e)
      if (!cancelled) setError(text)
      setStatus(walletRef.current ? 'connected' : 'idle')
    }
  }, [adopt, follow])

  const disconnect = useCallback(async () => {
    const wallet = walletRef.current
    forget()
    if (!wallet) return
    try {
      const connector = await nearConnector()
      await connector.disconnect(wallet)
    } catch {
      // The page has already stopped using it; the wallet's own session is the wallet's.
    }
  }, [forget])

  const send = useCallback(
    async (tx: PreparedTx) => {
      const wallet = walletRef.current
      if (!wallet || !accountId) throw new Error('No NEAR wallet is connected.')
      return signAndSend(wallet, accountId, tx)
    },
    [accountId],
  )

  return { status, accountId, walletName: walletMeta?.name ?? null, walletIcon: walletMeta?.icon || null, error, connect, disconnect, send }
}
