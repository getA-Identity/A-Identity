/**
 * The feedback widget's API call and types, kept out of the component so the component
 * stays small (it is mounted on every page) and so the outcome mapping is readable in one
 * place.
 *
 * The outcomes are deliberately honest: `sent` only when the backend said `delivered:
 * true`, which it only says after Resend accepted the email. Anything else is either a
 * `fallback` (the server could not send, through no fault of the message: not configured,
 * refused by the provider, or quietly ignored) that hands the person a mailto link so nothing they typed is lost,
 * or an `error` they can retry.
 */
import { apiFetch, explainError, readJson } from './api'
import { CONTACT } from './brand'

export const FEEDBACK_KINDS = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'question', label: 'Question' },
  { id: 'other', label: 'Other' },
] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]['id']

export const FEEDBACK_MESSAGE_MIN = 10
export const FEEDBACK_MESSAGE_MAX = 2000

export type FeedbackDraft = {
  kind: FeedbackKind
  message: string
  email: string
  /** The honeypot. A person never sees the field, so it is always empty for them. */
  website: string
}

type FeedbackResponse = {
  ok?: boolean
  delivered?: boolean
  configured?: boolean
  reason?: string
  id?: string | null
}

export type FeedbackOutcome =
  | { kind: 'sent' }
  | { kind: 'fallback'; reason: string }
  | { kind: 'error'; reason: string }

/** POST the draft to the backend and map the answer to one of the three outcomes. */
export async function submitFeedback(draft: FeedbackDraft): Promise<FeedbackOutcome> {
  const payload = {
    kind: draft.kind,
    message: draft.message.trim(),
    email: draft.email.trim() || undefined,
    page: typeof window !== 'undefined' ? window.location.href : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    website: draft.website,
  }
  let res: Response
  try {
    res = await apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { kind: 'error', reason: 'Could not reach the server. Check your connection and try again.' }
  }
  const data = await readJson<FeedbackResponse>(res)
  if (res.ok && data.delivered === true) return { kind: 'sent' }
  // The server answered but could not send: ignored (200, delivered false), not configured
  // (503, configured false), or the provider refused the message (502 with configured true,
  // for example an unverified sender). None of these is something a retry fixes, so offer
  // the mailto. A bare 502 from a proxy carries no body and stays on the retry path.
  if (
    (res.status === 200 && data.delivered === false) ||
    data.configured === false ||
    (res.status === 502 && data.configured === true)
  ) {
    return {
      kind: 'fallback',
      reason:
        data.reason === 'ignored'
          ? 'The server did not accept this message.'
          : data.reason ?? 'The server could not send this message right now.',
    }
  }
  if (res.status === 429) {
    return { kind: 'error', reason: 'Too many messages in a minute. Wait a moment and try again.' }
  }
  return { kind: 'error', reason: data.reason ?? explainError(res.status) }
}

/** A mailto link to the team inbox with the draft prefilled, for when the server cannot send. */
export function feedbackMailto(draft: FeedbackDraft): string {
  const label = FEEDBACK_KINDS.find((k) => k.id === draft.kind)?.label ?? 'Feedback'
  const page = typeof window !== 'undefined' ? window.location.href : ''
  const body = `${draft.message.trim()}\n\n${page ? `Page: ${page}\n` : ''}`
  const params = new URLSearchParams({ subject: `[A-Identity feedback] ${label}`, body })
  // URLSearchParams encodes spaces as "+", which mail clients render literally.
  return `mailto:${CONTACT.hello}?${params.toString().replace(/\+/g, '%20')}`
}

/**
 * Pages whose bottom-right corner already holds a floating control (the landing's
 * "Verify an agent" FAB), so the feedback button and the back-to-top button stack one
 * slot higher there. Shared by both so the stack is decided in exactly one place.
 */
export function hasCornerFab(pathname: string): boolean {
  return pathname === '/'
}
