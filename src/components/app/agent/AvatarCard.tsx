import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { apiFetch, explainError, readJson } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { invalidatePlatformAgents } from '../../../lib/platformAgents'
import { BACKEND_UNREACHABLE } from '../../../lib/mcpBase'
import AgentAvatar from '../../AgentAvatar'
import { type OwlVerdict } from '../../OwlMark'
import { LOGO_PX, logoErrorText, resizeLogoToDataUrl } from './logo-image'

/**
 * The agent's profile image, after registration.
 *
 * The wizard could always attach a logo, and then that was the end of it: an agent that
 * skipped the step, or picked the wrong file, had no way back. This is that same picker,
 * on the dashboard, plus the two things it was missing (replace, remove).
 *
 * It uses the same browser-side resize the wizard uses, so the original file never leaves
 * the machine, and it reports only what the server confirmed: the preview does not change
 * until the response says the image is stored.
 *
 * The preview is the real AgentAvatar, with the KYA verdict passed in, so the owl sits on
 * top of the uploaded logo here exactly as it does everywhere else. A picture is not
 * allowed to cover a risk signal, and this is the screen where someone would try.
 */
export default function AvatarCard({
  agentId,
  category,
  logoUrl,
  verdict,
  onChanged,
}: {
  agentId: string
  category?: string
  /** The stored image, or null/undefined when the agent still wears the default. */
  logoUrl?: string | null
  /** The agent's KYA standing, so the preview carries the same owl the console does. */
  verdict?: OwlVerdict
  /** Called after the server confirmed a change, so the page can re-read the agent. */
  onChanged?: () => void
}) {
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const hasLogo = Boolean(logoUrl)

  /** One write for both directions: a data URL sets it, null removes it. */
  const send = async (next: string | null) => {
    setBusy(next === null ? 'remove' : 'save')
    setError(null)
    setNote(null)
    try {
      const res = await apiFetch('/api/agents/logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, logoUrl: next }),
        onWaking: () => setNote('Waking up the backend (free tier)...'),
      })
      const data = await readJson<{ logo?: string; note?: string; error?: string }>(res)
      if (!res.ok) {
        setNote(null)
        setError(explainError(res.status, data.error))
        return
      }
      // The list every screen reads carries logoUrl, so the new picture has to invalidate it.
      invalidatePlatformAgents()
      setNote(data.note ?? 'Saved.')
      onChanged?.()
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

  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-5">
      <h3 className="text-sm font-bold text-foreground/80">Profile image</h3>
      <p className="mt-0.5 text-xs text-foreground/55">
        Shown wherever this agent appears: your console, its public profile and Agent House.
        Its KYA mark always stays on top of it.
      </p>

      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* The preview is the component every other surface renders, at the size the
            profile hero uses, so what you see here is what the picture actually becomes. */}
        <div className="shrink-0 rounded-2xl border border-border bg-background/40 p-2.5">
          <AgentAvatar seed={agentId} category={category} size={72} verdict={verdict} src={logoUrl} />
        </div>

        <div className="min-w-0 flex-1">
          <label
            className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-foreground/20 bg-background/40 p-4 transition-colors duration-[120ms] hover:border-accent/50 hover:bg-foreground/[0.03] ${
              busy ? 'pointer-events-none opacity-60' : ''
            }`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (!busy) onPick(e.dataTransfer.files?.[0])
            }}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground/85">
                {busy === 'save' && <Loader2 size={14} className="animate-spin text-accent" />}
                {busy === 'save' ? 'Uploading...' : hasLogo ? 'Replace image' : 'Upload an image'}
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
              disabled={busy !== null}
              onChange={(e) => onPick(e.target.files?.[0])}
            />
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            {hasLogo ? (
              <button
                type="button"
                onClick={() => send(null)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground/45 transition-colors hover:text-danger disabled:opacity-50"
              >
                {busy === 'remove' && <Loader2 size={12} className="animate-spin" />}
                {busy === 'remove' ? 'Removing...' : 'Remove image'}
              </button>
            ) : (
              <span className="text-xs text-foreground/45">
                No image uploaded. This agent wears the default one.
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
  )
}
