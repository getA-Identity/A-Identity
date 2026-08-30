import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Loader2, Lock, ShieldCheck } from 'lucide-react'
import AppPage from '../../components/app/AppPage'
import { apiFetch, explainError, readJson } from '../../lib/api'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { authHeaders, useAuth } from '../../store/auth'
import { LOGO_PX, logoErrorText, resizeLogoToDataUrl } from '../../components/app/agent/logo-image'
import { publishUserAvatarChanged } from './AppLayout'

/**
 * Your own account, as opposed to the agents you own.
 *
 * The console could always change an AGENT's picture and never the person's: the shell
 * drew a disc of your initials and there was no screen behind it. This is that screen, and
 * it is deliberately small - a photo and an honest statement of what your session can do.
 * Anything else about the account belongs to the screen that owns it.
 *
 * The picture takes the same road an agent logo takes: the same browser-side resize (so
 * the original file never leaves this machine), the same server-side sanitizer, and the
 * same size bound. What is shown here is only ever what the server confirmed it stored.
 */

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...authHeaders() })

/**
 * explainError's 403 copy is written about AGENT ownership ("register your own agent
 * first"), which would be the wrong sentence on this screen. The only 403 the platform
 * itself writes here is about your own account, so its own words are the honest ones.
 */
function refusalText(status: number, bodyError?: string): string {
  if (status === 403 && bodyError?.startsWith('Forbidden:')) {
    const msg = bodyError.slice('Forbidden:'.length).trim()
    if (msg) return `${msg[0].toUpperCase()}${msg.slice(1)}${msg.endsWith('.') ? '' : '.'}`
  }
  return explainError(status, bodyError)
}

export default function Profile() {
  const user = useAuth((s) => s.user)
  const verified = useAuth((s) => s.verified)
  const isGuest = Boolean(user) && !verified

  const [avatar, setAvatar] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // What the server currently holds for this account. A cold or unreachable backend is
  // reported, not thrown: the screen still renders with the initials disc.
  useEffect(() => {
    let alive = true
    apiFetch('/api/user/profile')
      .then(async (res) => {
        const data = await readJson<{ profile?: { avatarUrl?: string } | null }>(res)
        if (!alive) return
        if (!res.ok) {
          setError(explainError(res.status))
          return
        }
        setAvatar(data.profile?.avatarUrl ?? null)
      })
      .catch(() => {
        if (alive) setError(BACKEND_UNREACHABLE)
      })
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  /** One write for both directions: a data URL sets the photo, null removes it. */
  const send = async (next: string | null) => {
    setBusy(next === null ? 'remove' : 'save')
    setError(null)
    setNote(null)
    try {
      const res = await apiFetch('/api/user/avatar', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ avatarUrl: next }),
        onWaking: () => setNote('Waking up the backend (free tier)...'),
      })
      const data = await readJson<{
        user?: { avatarUrl?: string }
        avatar?: string
        note?: string
        error?: string
      }>(res)
      if (!res.ok) {
        setNote(null)
        setError(refusalText(res.status, data.error))
        return
      }
      // The stored value comes back from the server, so the preview and the shell's disc
      // both move only once the write is real.
      const stored = data.user?.avatarUrl ?? null
      setAvatar(stored)
      publishUserAvatarChanged(stored)
      setNote(data.note ?? 'Saved.')
    } catch {
      setNote(null)
      setError(BACKEND_UNREACHABLE)
    } finally {
      setBusy(null)
    }
  }

  const onPick = (file: File | undefined) => {
    setError(null)
    setNote(null)
    if (!file) return
    resizeLogoToDataUrl(file)
      .then(send)
      .catch((err) => setError(logoErrorText(err)))
  }

  const name = user?.name ?? 'Signed in'
  const account = user?.email ?? ''
  const disabled = busy !== null || isGuest

  return (
    <AppPage
      ambient
      width="form"
      title="Profile"
      description="Your account in this console: who you are signed in as, and the photo shown on your avatar."
    >
      {/* Who you are, and what this session is actually allowed to do. */}
      <div className="mt-6 rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-4">
          <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full bg-accent text-lg font-bold text-white">
            {avatar ? (
              <img src={avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              name
                .split(' ')
                .map((p) => p[0])
                .slice(0, 2)
                .join('')
                .toUpperCase() || 'AI'
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-base font-bold text-foreground">{name}</div>
            <div className="truncate text-sm text-foreground/55">{account}</div>
            <div className="mt-1.5">
              {verified ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ok">
                  <ShieldCheck size={13} /> Verified session, so changes here save
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warn">
                  <Lock size={13} /> Guest session, read-only
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The photo. */}
      <div className="mt-4 rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-bold text-foreground/80">Profile photo</h3>
        <p className="mt-0.5 text-xs text-foreground/55">
          Shown on your avatar in this console. It belongs to your account, not to any agent
          you own, and it is not published anywhere your agents appear.
        </p>

        {isGuest && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn/10 p-3 text-xs font-medium text-foreground/80">
            <Lock size={13} className="shrink-0 text-warn" />
            A guest session cannot save a photo.
            <Link to="/login" className="font-semibold underline underline-offset-2 hover:text-foreground">
              Sign in with your wallet or an email link
            </Link>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="grid h-[88px] w-[88px] shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-background/40">
            {avatar ? (
              <img src={avatar} alt="Your profile photo" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs text-foreground/40">{loaded ? 'No photo' : 'Loading'}</span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-foreground/20 bg-background/40 p-4 transition-colors duration-[120ms] hover:border-accent/50 hover:bg-foreground/[0.03] ${
                disabled ? 'pointer-events-none opacity-60' : ''
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (!disabled) onPick(e.dataTransfer.files?.[0])
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground/85">
                  {busy === 'save' && <Loader2 size={14} className="animate-spin text-accent" />}
                  {busy === 'save' ? 'Uploading...' : avatar ? 'Replace photo' : 'Upload a photo'}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-foreground/55">
                  Click anywhere here or drop a file. Square works best; it is resized to {LOGO_PX}px in
                  your browser, so the original never leaves this machine.
                </p>
              </div>
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={disabled}
                onChange={(e) => onPick(e.target.files?.[0])}
              />
            </label>

            <div className="mt-2 flex flex-wrap items-center gap-3">
              {avatar ? (
                <button
                  type="button"
                  onClick={() => send(null)}
                  disabled={disabled}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground/45 transition-colors hover:text-danger disabled:opacity-50"
                >
                  {busy === 'remove' && <Loader2 size={12} className="animate-spin" />}
                  {busy === 'remove' ? 'Removing...' : 'Remove photo'}
                </button>
              ) : (
                <span className="text-xs text-foreground/45">
                  No photo yet. Your initials are shown instead.
                </span>
              )}
            </div>

            {error && <p className="mt-2 text-xs font-semibold text-danger">{error}</p>}
            {!error && note && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-ok">
                <CheckCircle2 size={13} /> {note}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppPage>
  )
}
