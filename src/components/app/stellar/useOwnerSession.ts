/**
 * Whether the signed-in A-Identity session may ask our backend to prepare calls for one
 * Stellar account, and the one-signature way to make it so.
 *
 * The prepare and submit endpoints sit behind the verified-session gate, and the backend
 * only prepares a call whose source is the session's own wallet or a Stellar wallet linked
 * to that account. So before any control is enabled the page needs to know whether the
 * connected owner account is one of those. Signing in is a SEP-43 message signature over a
 * server nonce: no transaction and no fee, and it reuses the exact signer already connected,
 * so the session is for the same address the page just matched against the owner.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch, readJson } from '../../../lib/api'
import type { WalletSigner } from '../../../lib/wallet/types'
import { authHeaders, useAuth } from '../../../store/auth'
import { walletErrorMessage } from '../../../lib/stellar/vault'

export type SessionCover = 'checking' | 'covered' | 'signed-out' | 'other-account'

type WalletListing = {
  session?: { ecosystem: string; address: string } | null
  wallets?: { ecosystem: string; address: string }[]
}

export function useOwnerSession(address: string | null, signer: WalletSigner | null) {
  const verified = useAuth((s) => s.verified)
  const user = useAuth((s) => s.user)
  const [cover, setCover] = useState<SessionCover>('checking')
  const [sessionAddress, setSessionAddress] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!address) return
    if (!user || !verified) {
      setCover('signed-out')
      return
    }
    let alive = true
    setCover('checking')
    apiFetch('/api/user/wallets', { headers: authHeaders() })
      .then(async (res) => (res.ok ? readJson<WalletListing>(res) : null))
      .then((listing) => {
        if (!alive) return
        const session = listing?.session?.ecosystem === 'stellar' ? listing.session.address : null
        const linked = (listing?.wallets ?? []).filter((w) => w.ecosystem === 'stellar').map((w) => w.address)
        setSessionAddress(session ?? user.email ?? null)
        if (session === address || linked.includes(address)) setCover('covered')
        else if (!listing && user.email === address) setCover('covered')
        else setCover('other-account')
      })
      .catch(() => {
        if (!alive) return
        // The listing did not come back. The session's own subject is still known locally,
        // and for a wallet session it is the wallet address.
        setCover(user.email === address ? 'covered' : 'other-account')
      })
    return () => {
      alive = false
    }
  }, [address, user, verified, round])

  const signIn = useCallback(async () => {
    if (!signer) return
    setSigningIn(true)
    setError(null)
    try {
      await useAuth.getState().loginWithSigner(signer)
      setRound((n) => n + 1)
    } catch (e) {
      setError(walletErrorMessage(e) || 'Sign-in did not complete.')
    } finally {
      setSigningIn(false)
    }
  }, [signer])

  return { cover: address ? cover : 'signed-out', sessionAddress, signIn, signingIn, error, recheck: () => setRound((n) => n + 1) }
}
