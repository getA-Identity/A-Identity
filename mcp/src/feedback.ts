/**
 * Site feedback: the widget in the corner of every page, emailed to the team inbox.
 *
 * Anonymous by design (the public pages have no sign-in), bounded by the site-feedback rate
 * bucket, and it does exactly one thing with what it receives: it emails it through Resend,
 * the same provider magic.ts already uses for sign-in links. Nothing is persisted here, and
 * nothing is logged beyond the kind and whether the email went out.
 *
 * Honest status, like every other send in this codebase: the client is told `delivered:
 * true` only when the provider accepted the message. No key means a labeled no-op, never a
 * crash and never a fake success, and the widget falls back to a mailto link so nothing a
 * person typed is lost.
 */
import { createHash, randomBytes } from 'node:crypto'

export const FEEDBACK_KINDS = ['bug', 'idea', 'question', 'other'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_MESSAGE_MIN = 10
export const FEEDBACK_MESSAGE_MAX = 2000
const EMAIL_MAX = 254
const PAGE_MAX = 500
const USER_AGENT_MAX = 300

export const DEFAULT_FEEDBACK_TO = 'hello@a-identity.xyz'
const DEFAULT_FROM = 'A-Identity <onboarding@resend.dev>'
const RESEND_URL = 'https://api.resend.com/emails'
export const NOT_CONFIGURED_REASON = 'Feedback email is not configured on the server.'

export type Feedback = {
  kind: FeedbackKind
  message: string
  email?: string
  page?: string
  userAgent?: string
}

/** What the route knows about the request that the person did not type. */
export type FeedbackMeta = {
  receivedAt: string
  /** The session subject when the request carried one; most will not. */
  caller?: string
  /** A coarse, salted marker derived from the client address (see visitorMarker). */
  visitor?: string
}

export type ValidatedFeedback = { ok: true; value: Feedback } | { ok: false; error: string }

export type SendResult =
  | { delivered: true; id: string | null }
  | { delivered: false; configured: boolean; reason: string }

/** The JSON body the route answers with, in every outcome. */
export type FeedbackResponse = {
  ok: boolean
  delivered: boolean
  configured?: boolean
  reason?: string
  id?: string | null
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/**
 * Check the posted body. Pure: no env, no network, no clock.
 *
 * Bounds are hard limits on what we will forward, not style preferences: the message is
 * what a person wants read, so it is rejected rather than cut when it is out of range, and
 * the two browser-supplied fields (page, user agent) are truncated because a long query
 * string is not the person's fault and should not cost them their message.
 */
export function validateFeedback(body: unknown): ValidatedFeedback {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'A JSON object is required.' }
  const b = body as Record<string, unknown>

  const kind = typeof b.kind === 'string' ? b.kind.trim().toLowerCase() : ''
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of ${FEEDBACK_KINDS.join(', ')}.` }
  }

  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (message.length < FEEDBACK_MESSAGE_MIN) {
    return { ok: false, error: `Say a little more: at least ${FEEDBACK_MESSAGE_MIN} characters.` }
  }
  if (message.length > FEEDBACK_MESSAGE_MAX) {
    return { ok: false, error: `Keep it under ${FEEDBACK_MESSAGE_MAX} characters.` }
  }

  const email = optionalString(b.email)
  if (email !== undefined && (email.length > EMAIL_MAX || !EMAIL_RE.test(email))) {
    return { ok: false, error: 'That email address does not look valid. Leave it empty if you do not want a reply.' }
  }

  let page = optionalString(b.page)
  if (page !== undefined) {
    let parsed: URL | null = null
    try {
      parsed = new URL(page)
    } catch {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return { ok: false, error: 'page must be an http or https URL.' }
    }
    page = page.slice(0, PAGE_MAX)
  }

  const userAgent = optionalString(b.userAgent)?.slice(0, USER_AGENT_MAX)

  const value: Feedback = { kind: kind as FeedbackKind, message }
  if (email !== undefined) value.email = email.toLowerCase()
  if (page !== undefined) value.page = page
  if (userAgent !== undefined) value.userAgent = userAgent
  return { ok: true, value }
}

/** True when the hidden "website" field was filled in: a person never sees it, a form filler does. */
export function isHoneypotTripped(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const website = (body as Record<string, unknown>).website
  return typeof website === 'string' && website.trim().length > 0
}

/**
 * A coarse marker for the client address, so a burst of notes can be seen to come from one
 * visitor without the address itself travelling in an email. Salted with a per-process
 * secret rather than hashed bare: the IPv4 space is small enough that an unsalted hash is
 * the address with extra steps. Stable for the life of the process, which is all a marker
 * in an inbox needs to be.
 */
const VISITOR_SALT = randomBytes(16)
export function visitorMarker(ip: string | undefined): string | undefined {
  if (!ip || ip === 'unknown') return undefined
  return createHash('sha256').update(VISITOR_SALT).update(ip).digest('hex').slice(0, 8)
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function kindLabel(kind: FeedbackKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** "[A-Identity feedback] bug: the first sixty characters of the message" */
export function feedbackSubject(value: Feedback): string {
  const oneLine = value.message.replace(/\s+/g, ' ').trim()
  const head = oneLine.length > 60 ? `${oneLine.slice(0, 60).trimEnd()}...` : oneLine
  return `[A-Identity feedback] ${value.kind}: ${head}`
}

/**
 * The email, in the same email-client-safe shape as the magic link (inline styles, brand
 * ink #192837, accent #7342e2, cream #f2f2ee). Every field a person or a browser supplied
 * is HTML-escaped; the page link is only ever an http(s) URL because validation refused
 * anything else.
 */
export function feedbackEmail(value: Feedback, meta: FeedbackMeta): { subject: string; html: string; text: string } {
  const subject = feedbackSubject(value)
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
  const label = 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#8a93a0;padding:14px 0 4px'
  const cell = 'font-size:14px;line-height:1.55;color:#192837;word-break:break-word'

  const rows: Array<[string, string]> = []
  if (value.email) {
    rows.push(['Reply to', `<a href="mailto:${escapeHtml(value.email)}" style="color:#7342e2;text-decoration:none;font-weight:600">${escapeHtml(value.email)}</a> (reply to this email and it reaches them)`])
  } else {
    rows.push(['Reply to', 'No address left, so this one cannot be answered.'])
  }
  if (value.page) rows.push(['Page', `<a href="${escapeHtml(value.page)}" style="color:#7342e2;text-decoration:none">${escapeHtml(value.page)}</a>`])
  if (value.userAgent) rows.push(['Browser', escapeHtml(value.userAgent)])
  rows.push(['Received', escapeHtml(meta.receivedAt)])
  if (meta.caller) rows.push(['Session', escapeHtml(meta.caller)])
  if (meta.visitor) rows.push(['Visitor marker', `${escapeHtml(meta.visitor)} (salted hash, not an address)`])

  const html = `<!doctype html><html><body style="margin:0;background:#f2f2ee">
  <div style="background:#f2f2ee;padding:40px 16px;${font}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
      <tr><td align="center" style="padding-bottom:20px">
        <div style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#192837">A&#8209;Identity</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px auto 0"><tr>
          <td style="width:22px;height:4px;background:#7342E2;border-radius:2px"></td>
          <td style="width:6px"></td>
          <td style="width:22px;height:4px;background:#2775CA;border-radius:2px"></td>
          <td style="width:6px"></td>
          <td style="width:22px;height:4px;background:#1AAB7A;border-radius:2px"></td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:20px;padding:32px;box-shadow:0 12px 40px rgba(25,40,55,0.08)">
        <div style="display:inline-block;padding:4px 12px;border-radius:999px;background:#7342e2;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase">${escapeHtml(kindLabel(value.kind))}</div>
        <h1 style="margin:14px 0 6px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#192837">Site feedback</h1>
        <p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:#5b6673">Sent from the feedback widget on the site. The message is quoted exactly as typed.</p>
        <div style="padding:16px 18px;border-radius:14px;background:#f2f2ee;${cell};white-space:pre-wrap">${escapeHtml(value.message)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">
          ${rows.map(([k, v]) => `<tr><td style="${label}">${escapeHtml(k)}</td></tr><tr><td style="${cell}">${v}</td></tr>`).join('\n          ')}
        </table>
      </td></tr>
      <tr><td align="center" style="padding-top:22px">
        <p style="margin:0;font-size:12px;color:#a0a8b3">The passport and wallet for the agentic economy.</p>
      </td></tr>
    </table>
  </div></body></html>`

  const textRows = [
    `Kind: ${kindLabel(value.kind)}`,
    value.email ? `Reply to: ${value.email} (reply to this email and it reaches them)` : 'Reply to: no address left, so this one cannot be answered.',
    value.page ? `Page: ${value.page}` : null,
    value.userAgent ? `Browser: ${value.userAgent}` : null,
    `Received: ${meta.receivedAt}`,
    meta.caller ? `Session: ${meta.caller}` : null,
    meta.visitor ? `Visitor marker: ${meta.visitor} (salted hash, not an address)` : null,
  ].filter((r): r is string => r !== null)
  const text = `A-Identity site feedback\n\n${value.message}\n\n${textRows.join('\n')}\n`

  return { subject, html, text }
}

/**
 * Post the email to Resend. Returns what happened, never throws: a missing key is the
 * labeled no-op, a provider refusal carries the provider's own message (as magic.ts does),
 * and a network failure reads as a provider error with the exception text.
 */
export async function sendFeedback(
  value: Feedback,
  meta: FeedbackMeta,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY
  if (!apiKey) return { delivered: false, configured: false, reason: NOT_CONFIGURED_REASON }
  const from = env.MAGIC_FROM_EMAIL || DEFAULT_FROM
  const to = [env.FEEDBACK_TO_EMAIL || DEFAULT_FEEDBACK_TO]
  const { subject, html, text } = feedbackEmail(value, meta)
  const payload: Record<string, unknown> = { from, to, subject, html, text }
  if (value.email) payload.reply_to = value.email
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string }
      return { delivered: false, configured: true, reason: body.message || body.name || `Email provider error (HTTP ${res.status}).` }
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string }
    return { delivered: true, id: typeof body.id === 'string' ? body.id : null }
  } catch (e) {
    return { delivered: false, configured: true, reason: e instanceof Error ? e.message : 'Failed to send the email.' }
  }
}

/**
 * The whole request, from a parsed body to an HTTP status and a JSON reply, so the route
 * stays a few lines and this path can be tested end to end without a socket.
 *
 * Order matters: the honeypot is checked BEFORE validation, so a form filler that also
 * writes a bad email gets the same bland 200 as one that writes a good one. Either way it
 * learns nothing about what a real submission looks like.
 */
export async function handleFeedback(
  body: unknown,
  meta: FeedbackMeta,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: FeedbackResponse; kind: string }> {
  if (isHoneypotTripped(body)) {
    return { status: 200, body: { ok: true, delivered: false, reason: 'ignored' }, kind: 'honeypot' }
  }
  const checked = validateFeedback(body)
  if (!checked.ok) return { status: 400, body: { ok: false, delivered: false, reason: checked.error }, kind: 'invalid' }
  const sent = await sendFeedback(checked.value, meta, env, fetchImpl)
  if (sent.delivered) {
    return { status: 200, body: { ok: true, delivered: true, id: sent.id }, kind: checked.value.kind }
  }
  return {
    status: sent.configured ? 502 : 503,
    body: { ok: false, delivered: false, configured: sent.configured, reason: sent.reason },
    kind: checked.value.kind,
  }
}
