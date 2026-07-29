import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Mail, User, Wallet } from 'lucide-react'
import { motion } from 'framer-motion'
import Logo from './Logo'
import WalletModal from './WalletModal'
import { useAuth } from '../store/auth'
import { APP_NAME, EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from './ThemeScope'

type AuthScreenProps = {
  mode: 'login' | 'signup'
}

const COPY = {
  login: {
    title: 'Welcome back',
    subtitle: 'Sign in to manage your agents, identities, and settlements.',
    switchText: 'New here?',
    switchCta: 'Claim an Agent ID',
    switchTo: '/signup',
  },
  signup: {
    title: 'Claim your Agent ID',
    subtitle: 'Spin up an agent-ready identity and wallet in seconds.',
    switchText: 'Already onboarded?',
    switchCta: 'Sign in',
    switchTo: '/login',
  },
} as const

/**
 * Sign-in / sign-up. Three real paths: a wallet (SIWE, via a proper EIP-6963 +
 * WalletConnect picker), an emailed magic link (real email auth), and a
 * browse-only guest preview. No fake password.
 */
export default function AuthScreen({ mode }: AuthScreenProps) {
  const copy = COPY[mode]
  const navigate = useNavigate()
  const login = useAuth((s) => s.login)
  const requestMagicLink = useAuth((s) => s.requestMagicLink)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [walletOpen, setWalletOpen] = useState(false)
  const [magicBusy, setMagicBusy] = useState(false)
  const [magicSent, setMagicSent] = useState(false)
  const [magicError, setMagicError] = useState<string | null>(null)

  const onMagic = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) {
      setMagicError('Enter your email.')
      return
    }
    setMagicBusy(true)
    setMagicError(null)
    try {
      await requestMagicLink(email.trim())
      setMagicSent(true)
    } catch (err) {
      setMagicError(err instanceof Error ? err.message : 'Could not send the link.')
    } finally {
      setMagicBusy(false)
    }
  }

  const onGuest = async () => {
    await login(email.trim() || 'guest@a-identity.xyz', mode === 'signup' ? name : undefined)
    navigate('/app')
  }

  return (
    <ThemeScope as="main" className="grid min-h-screen w-full place-items-center px-5 py-10">
      <WalletModal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        onConnected={() => {
          setWalletOpen(false)
          navigate('/app')
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
        className="w-full max-w-[420px] rounded-3xl bg-card p-8 shadow-[0_24px_64px_rgba(25,40,55,0.10)]"
      >
        <Link to="/" className="mb-8 inline-flex items-center gap-2">
          <Logo size={28} />
          <span className="text-lg font-bold tracking-tight text-foreground">{APP_NAME}</span>
        </Link>

        <h1 className="mb-1.5 text-2xl font-bold tracking-tight text-foreground">{copy.title}</h1>
        <p className="mb-7 text-sm text-foreground/60">{copy.subtitle}</p>

        <button
          type="button"
          onClick={() => setWalletOpen(true)}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 py-3.5 text-sm font-semibold text-background transition-transform duration-200 hover:scale-[1.02]"
        >
          <Wallet size={18} />
          Sign in with your wallet
        </button>
        <p className="mt-2 text-center text-[11px] text-foreground/45">
          The real sign-in: proves you own your wallet. No password.
        </p>

        <div className="my-5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-foreground/35">
          <span className="h-px flex-1 bg-foreground/10" /> or with email <span className="h-px flex-1 bg-foreground/10" />
        </div>

        {magicSent ? (
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-center text-sm text-emerald-800 dark:text-emerald-300">
            <div className="font-semibold">Check your inbox ✉️</div>
            <p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-400/80">
              We sent a one-time sign-in link to {email}. Open it to finish.
            </p>
            <button
              type="button"
              onClick={() => setMagicSent(false)}
              className="mt-2 text-xs font-semibold text-emerald-800 underline"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onMagic} className="flex flex-col gap-3.5">
            {mode === 'signup' && (
              <Field
                icon={<User size={18} />}
                type="text"
                placeholder="Full name"
                value={name}
                onChange={setName}
                autoComplete="name"
              />
            )}
            <Field
              icon={<Mail size={18} />}
              type="email"
              placeholder="Email address"
              value={email}
              onChange={setEmail}
              autoComplete="email"
            />
            <button
              type="submit"
              disabled={magicBusy}
              className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-3.5 text-sm font-semibold text-white transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
            >
              {magicBusy ? 'Sending' : 'Email me a sign-in link'}
              {!magicBusy && <ArrowRight size={18} />}
            </button>
            {magicError && <p className="text-center text-xs text-red-600">{magicError}</p>}
          </form>
        )}

        <p className="mt-4 text-center text-[11px] text-foreground/45">
          No wallet or email?{' '}
          <button type="button" onClick={onGuest} className="font-semibold text-accent hover:underline">
            Continue as guest
          </button>{' '}
          (browse-only)
        </p>

        <p className="mt-6 text-center text-sm text-foreground/60">
          {copy.switchText}{' '}
          <Link to={copy.switchTo} className="font-semibold text-accent hover:underline">
            {copy.switchCta}
          </Link>
        </p>
      </motion.div>
    </ThemeScope>
  )
}

type FieldProps = {
  icon: ReactNode
  type: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  autoComplete?: string
}

function Field({ icon, type, placeholder, value, onChange, autoComplete }: FieldProps) {
  return (
    <label className="flex items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 transition-colors focus-within:border-accent">
      <span className="text-foreground/40">{icon}</span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
      />
    </label>
  )
}
