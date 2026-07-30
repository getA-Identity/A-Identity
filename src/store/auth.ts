import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setConnectedProvider, type Eip1193 } from '../lib/wallets'

import { MCP_BASE } from '../lib/mcpBase'

export type User = {
  name: string
  email: string
}

type AuthState = {
  user: User | null
  /** Session token issued by the backend; kept in memory only (never persisted) as a
   *  Bearer fallback. The real credential is the HttpOnly cookie. */
  token: string | null
  /** True for a verified (wallet / magic-link) session; false for a browse-only guest.
   *  Drives "can act" in the UI, decoupled from the in-memory token, which is null after
   *  a cookie-restored reload. */
  verified: boolean
  /** Guest preview: an email-only local session (no token → browse-only). */
  login: (email: string, name?: string) => Promise<void>
  /** Real auth: Sign-In with Ethereum. Prove wallet ownership by signing a nonce.
   *  Pass the chosen EIP-1193 provider (an injected wallet or WalletConnect). */
  loginWallet: (provider: Eip1193) => Promise<void>
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
      login: async (email, name) => {
        try {
          const res = await fetch(`${MCP_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, name }),
          })
          if (res.ok) {
            const data = (await res.json()) as { token: string; user: User }
            set({ user: data.user, token: data.token, verified: false }) // guest: browse-only
            return
          }
        } catch {
          // Backend unreachable, fall through to a local-only session (no token).
        }
        set({ user: { email, name: name?.trim() || email.split('@')[0] }, token: null, verified: false })
      },
      loginWallet: async (provider) => {
        // Remember the wallet the user chose, so later payments (x402) use this exact
        // provider instead of whichever extension won window.ethereum.
        setConnectedProvider(provider)
        const eth = provider
        let address: string | undefined
        try {
          const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
          address = accounts?.[0]
        } catch (e) {
          throw new Error(walletError(e, 'connect to your wallet'))
        }
        if (!address) throw new Error('No account selected in your wallet.')
        const nres = await fetch(`${MCP_BASE}/api/auth/nonce`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ address }),
        }).catch(() => null)
        if (!nres || !nres.ok) throw new Error('Could not reach the server (it may be waking up). Try again in a moment.')
        const { message } = (await nres.json()) as { message: string }
        let signature: string
        try {
          signature = (await eth.request({ method: 'personal_sign', params: [message, address] })) as string
        } catch (e) {
          throw new Error(walletError(e, 'sign the message'))
        }
        const vres = await fetch(`${MCP_BASE}/api/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ address, message, signature }),
        })
        if (!vres.ok) {
          const e = (await vres.json().catch(() => ({}))) as { error?: string }
          throw new Error(e.error ?? 'Wallet sign-in failed.')
        }
        const data = (await vres.json()) as { token: string; user: User }
        set({ user: data.user, token: data.token, verified: true })
      },
      requestMagicLink: async (email) => {
        const res = await fetch(`${MCP_BASE}/api/auth/magic/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email }),
        }).catch(() => null)
        const data = (res ? await res.json().catch(() => ({})) : {}) as { sent?: boolean; error?: string }
        if (!res || !res.ok || !data.sent) throw new Error(data.error ?? 'Could not send the sign-in link.')
      },
      loginWithMagicToken: async (token) => {
        const res = await fetch(`${MCP_BASE}/api/auth/magic/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
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
        // 401 clears the session, a cold/unreachable backend must NOT log the user out.
        try {
          // Prefer the cookie; also send an in-memory token if one is still around (e.g. a
          // pre-cookie session rehydrated from old localStorage), so upgrading users aren't
          // force-logged-out on first load after this change.
          const t = get().token
          const res = await fetch(`${MCP_BASE}/api/auth/me`, {
            credentials: 'include',
            headers: t ? { Authorization: `Bearer ${t}` } : {},
          })
          if (res.status === 401) {
            set({ user: null, token: null, verified: false })
            return
          }
          if (res.ok) {
            const data = (await res.json()) as { user: User; verified?: boolean }
            if (data.user) set({ user: data.user, verified: Boolean(data.verified) })
          }
        } catch {
          /* backend waking / unreachable, keep the persisted session */
        }
      },
      logout: () => {
        // Clear the server cookie too (best effort), then drop the local session.
        try {
          void fetch(`${MCP_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' })
        } catch {
          /* ignore */
        }
        set({ user: null, token: null, verified: false })
      },
    }),
    // Persist ONLY the (non-secret) user + verified flag; the session TOKEN is never
    // written to localStorage, it lives in the HttpOnly cookie (and in memory for this
    // tab). `restore()` reconciles `verified` against the cookie on load.
    { name: 'a-identity-auth', partialize: (s) => ({ user: s.user, verified: s.verified }) },
  ),
)

/** Authorization header for authenticated (mutating) requests. */
export function authHeaders(): Record<string, string> {
  const t = useAuth.getState().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/** Turn a raw wallet/provider error into a friendly, human message. */
function walletError(e: unknown, action: string): string {
  const code = (e as { code?: number })?.code
  const msg = (e as { message?: string })?.message ?? ''
  if (code === 4001 || /reject|denied|cancel/i.test(msg)) return 'Request cancelled in your wallet.'
  return `Could not ${action}${msg ? `: ${msg}` : ''}.`
}
