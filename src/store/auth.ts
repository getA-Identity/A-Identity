/**
 * Auth store: guest preview, Sign-In with Ethereum, and email magic-link sessions.
 *
 * Credential posture: the real session credential is an HttpOnly cookie set by the
 * backend; a Bearer token copy lives in memory for this tab only and is NEVER written
 * to localStorage (persist() stores just the non-secret user + verified flag).
 *
 * Network posture: every call goes through apiFetch (lib/api.ts, credentials always
 * included), so sign-in survives the free-tier backend's ~50s cold start. Mutations
 * (login, nonce, verify, magic link) wait for the backend to wake and then send
 * EXACTLY once, so no sign-in step can double-submit. restore() is a retried read
 * whose failure is NEVER a sign-out: only a definitive 401 or a 200 with
 * {authenticated:false} clears the session; an unreachable or still-waking backend
 * keeps the persisted state.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { evmSigner, setConnectedProvider, type Eip1193 } from '../lib/wallets'
import type { Ecosystem, WalletSigner } from '../lib/wallet/types'
import { useWallets } from './wallets'

import { apiFetch } from '../lib/api'

export type User = {
  name: string
  email: string
}

/** A wallet linked to the account by signature, as the backend lists it. */
/** Set when an agent's owner attested a Circle spending policy for this address: the wallet
 *  is a Circle agent wallet (a smart contract account), shown as such, no new family. */
export type CircleAgentWalletMark = { agentId: string; agentName: string; attestedAt: string; method: 'wallet-signature' | 'erc1271-signature' }
export type LinkedWalletRow = { ecosystem: Ecosystem; address: string; wallet?: string; linkedAt: string; circleAgentWallet?: CircleAgentWalletMark | null }

type AuthState = {
  user: User | null
  /** Session token issued by the backend; kept in memory only (never persisted) as a
   *  Bearer fallback. The real credential is the HttpOnly cookie. */
  token: string | null
  /** True for a verified (wallet / magic-link) session; false for a browse-only guest.
   *  Drives "can act" in the UI, decoupled from the in-memory token, which is null after
   *  a cookie-restored reload. */
  verified: boolean
  /** True once restore() has settled (with any outcome). Never persisted. ProtectedRoute
   *  waits for this before treating an empty `user` as "signed out": a hard reload of
   *  /app with a valid HttpOnly cookie but empty localStorage would otherwise bounce to
   *  /login before the cookie check resolves. */
  restored: boolean
  /** For a wallet session, which chain family the signed-in wallet lives on; null otherwise. */
  ecosystem: Ecosystem | null
  /** Guest preview: an email-only local session (no token -> browse-only). */
  login: (email: string, name?: string) => Promise<void>
  /** Real auth: Sign-In with Ethereum. Prove wallet ownership by signing a nonce.
   *  Pass the chosen EIP-1193 provider (an injected wallet or WalletConnect). */
  loginWallet: (provider: Eip1193) => Promise<void>
  /** Real auth with any wallet family: the signer proves control of its address by signing
   *  a nonce on its own ecosystem's primitive (EVM personal_sign, Stellar SEP-43, an
   *  Algorand zero-value self-payment). Same session shape as loginWallet. */
  loginWithSigner: (signer: WalletSigner) => Promise<void>
  /** Prove control of one more wallet and attach it to the signed-in account. */
  linkWallet: (signer: WalletSigner) => Promise<{ wallets: LinkedWalletRow[]; note: string }>
  /** Real email auth: send a one-time magic sign-in link (via Resend). */
  requestMagicLink: (email: string) => Promise<void>
  /** Finish magic-link sign-in with the token carried by the emailed link. */
  loginWithMagicToken: (token: string) => Promise<void>
  /** Restore the session from the HttpOnly cookie on load (no token persisted). */
  restore: () => Promise<void>
  logout: () => void
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      verified: false,
      restored: false,
      ecosystem: null,
      login: async (email, name) => {
        try {
          const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, name }),
          })
          if (res.ok) {
            const data = (await res.json()) as { token: string; user: User }
            set({ user: data.user, token: data.token, verified: false }) // guest: browse-only
            return
          }
        } catch {
          // Backend unreachable even after apiFetch's wake wait, fall through to a
          // local-only session (no token).
        }
        set({ user: { email, name: name?.trim() || email.split('@')[0] }, token: null, verified: false })
      },
      loginWallet: async (provider) => {
        // Remember the wallet the user chose, so later payments (x402) use this exact
        // provider instead of whichever extension won window.ethereum.
        setConnectedProvider(provider)
        await get().loginWithSigner(await evmSigner(provider))
      },
      loginWithSigner: async (signer) => {
        // apiFetch wakes a cold backend BEFORE posting and then posts exactly once, so
        // a free-tier spin-up cannot fail sign-in and the nonce is never issued twice.
        const nres = await apiFetch('/api/auth/nonce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: signer.address }),
        }).catch(() => null)
        if (!nres || !nres.ok) {
          const e = nres ? ((await nres.json().catch(() => ({}))) as { error?: string }) : {}
          throw new Error(e.error ?? 'Could not reach the server (it may be waking up). Try again in a moment.')
        }
        const { message, address } = (await nres.json()) as { message: string; address: string }
        const signature = await signer.signMessage(message)
        const vres = await apiFetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, message, signature }),
        })
        if (!vres.ok) {
          const e = (await vres.json().catch(() => ({}))) as { error?: string }
          throw new Error(e.error ?? 'Wallet sign-in failed.')
        }
        const data = (await vres.json()) as { token: string; user: User; ecosystem?: Ecosystem }
        useWallets.getState().remember(signer)
        set({ user: data.user, token: data.token, verified: true, ecosystem: data.ecosystem ?? signer.ecosystem })
      },
      linkWallet: async (signer) => {
        if (!get().verified) throw new Error('Sign in with a wallet or an email link before linking a wallet.')
        // The wallet the session IS is already on the account, and the backend refuses to
        // link it a second time. Say so BEFORE asking the extension for a signature: a
        // person with one Freighter account otherwise approves a signature for nothing and
        // then reads a refusal, which looks like the link silently failing.
        const subject = get().user?.email ?? ''
        if (subject && subject.toLowerCase() === signer.address.toLowerCase()) {
          throw new Error(
            // Worded around the modal's error mapper on purpose: "switch", "network" and
            // "chain" would make it read this as the extension asking for a change.
            `${signer.walletName ?? 'This wallet'} is showing the account you signed in with, so it is already on your account. To link a different wallet, pick another account inside the extension first, then try again.`,
          )
        }
        const nres = await apiFetch('/api/auth/nonce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: signer.address, purpose: 'link' }),
        }).catch(() => null)
        if (!nres || !nres.ok) {
          const e = nres ? ((await nres.json().catch(() => ({}))) as { error?: string }) : {}
          throw new Error(e.error ?? 'Could not reach the server (it may be waking up). Try again in a moment.')
        }
        const { message, address } = (await nres.json()) as { message: string; address: string }
        const signature = await signer.signMessage(message)
        const res = await apiFetch('/api/user/wallets/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ address, message, signature, wallet: signer.walletName }),
        })
        const data = (await res.json().catch(() => ({}))) as { wallets?: LinkedWalletRow[]; note?: string; error?: string }
        if (!res.ok) throw new Error(data.error ?? 'Could not link the wallet.')
        useWallets.getState().remember(signer)
        return { wallets: data.wallets ?? [], note: data.note ?? 'Wallet linked.' }
      },
      requestMagicLink: async (email) => {
        // Exactly-once matters most here: a retried POST would email two sign-in
        // links. apiFetch wakes the backend first, then sends a single request.
        const res = await apiFetch('/api/auth/magic/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        }).catch(() => null)
        const data = (res ? await res.json().catch(() => ({})) : {}) as { sent?: boolean; error?: string }
        if (!res || !res.ok || !data.sent) throw new Error(data.error ?? 'Could not send the sign-in link.')
      },
      loginWithMagicToken: async (token) => {
        // The link token is single-use, so the exactly-once mutation posture also
        // means a cold-start retry can never burn it before the real attempt.
        const res = await apiFetch('/api/auth/magic/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(e.error ?? 'This sign-in link is invalid or expired.')
        }
        const data = (await res.json()) as { token: string; user: User }
        set({ user: data.user, token: data.token, verified: true })
      },
      restore: async () => {
        // On load, ask the backend who we are from the HttpOnly cookie. Only a definitive
        // 401 (or 200 {authenticated:false}) clears the session, a cold/unreachable
        // backend must NOT log the user out. apiFetch retries this read through a cold
        // start with wake pings; if it still fails it either throws (caught below) or
        // bottoms out on a 5xx response, which is neither ok nor 401 and so falls
        // through, keeping the persisted session either way.
        try {
          // Prefer the cookie; also send an in-memory token if one is still around (e.g. a
          // pre-cookie session rehydrated from old localStorage), so upgrading users aren't
          // force-logged-out on first load after this change.
          const t = get().token
          const res = await apiFetch('/api/auth/me', {
            headers: t ? { Authorization: `Bearer ${t}` } : {},
          })
          // A 401 is still treated as definitive, so this keeps working against a
          // backend that has not been redeployed yet.
          if (res.status === 401) {
            set({ user: null, token: null, verified: false })
            return
          }
          if (res.ok) {
            const data = (await res.json()) as { user?: User; verified?: boolean; authenticated?: boolean; ecosystem?: Ecosystem | null }
            // The backend now answers "signed out" with 200 { authenticated: false }
            // rather than a 401, because a 401 made every anonymous page load emit a
            // console error. This is the same definitive signal, just not shouted.
            if (data.authenticated === false) {
              set({ user: null, token: null, verified: false })
              return
            }
            if (data.user) set({ user: data.user, verified: Boolean(data.verified), ecosystem: data.ecosystem ?? null })
          }
        } catch {
          /* still waking / unreachable after retries, keep the persisted session */
        } finally {
          // Whatever happened, the check has now settled: ProtectedRoute may decide.
          set({ restored: true })
        }
      },
      logout: () => {
        // Clear the server cookie too, best effort in the background (apiFetch wakes a
        // cold backend and sends once), while the local session drops immediately.
        void apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {
          /* ignore: the local logout below already happened */
        })
        set({ user: null, token: null, verified: false, ecosystem: null })
      },
    }),
    // Persist ONLY the (non-secret) user + verified flag; the session TOKEN is never
    // written to localStorage, it lives in the HttpOnly cookie (and in memory for this
    // tab). `restore()` reconciles `verified` against the cookie on load.
    { name: 'a-identity-auth', partialize: (s) => ({ user: s.user, verified: s.verified, ecosystem: s.ecosystem }) },
  ),
)

/** Authorization header for authenticated (mutating) requests. */
export function authHeaders(): Record<string, string> {
  const t = useAuth.getState().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}

