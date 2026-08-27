/**
 * Passwordless email sign-in ("magic link"), credential-gated behind RESEND_API_KEY.
 *
 * A stateless, HMAC-signed token (email + expiry) is emailed as a one-time link via
 * Resend; clicking it hits /auth/callback, which posts the token back to verify and
 * receive a real session token. No email provider configured -> the whole feature
 * cleanly reports "not configured" and the UI falls back to wallet / guest.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { AUTH_SECRET } from './auth.js'

// Shares the single resolved signing secret (see auth.ts): AUTH_SECRET when set,
// else a random per-process secret on prod-like hosts, else the dev default.
const SECRET = AUTH_SECRET
const TTL_MS = 15 * 60 * 1000 // links expire in 15 minutes

/** True when an email provider is configured. The single gate for this feature. */
export function magicEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY)
}

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url')
}

/** Stateless magic token: base64url(JSON{email, exp}) + '.' + hmac. */
export function makeMagicToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

/** Verify a magic token; returns the email or null if tampered/expired. */
export function verifyMagicToken(token: string | undefined): string | null {
  const [payload, sig] = (token ?? '').split('.')
  if (!payload || !sig) return null
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      email?: string
      exp?: number
    }
    if (!email || !exp || Date.now() > exp) return null
    return email
  } catch {
    return null
  }
}

/** Email a magic sign-in link via Resend. Returns null on success, or an error string. */
export async function sendMagicLink(email: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const apiKey = env.RESEND_API_KEY
  if (!apiKey) return 'Email sign-in is not configured on the server. Use a wallet or continue as guest.'
  const from = env.MAGIC_FROM_EMAIL || 'A-Identity <onboarding@resend.dev>'
  const appUrl = (env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
  const link = `${appUrl}/auth/callback?token=${encodeURIComponent(makeMagicToken(email))}`
  const html = magicEmailHtml(link, appUrl)
  const text = `Sign in to A-Identity\n\nTap the sign-in button in this email. The link works once and expires in 15 minutes.\n\nButton not working? Open ${appUrl} and request a fresh sign-in link.\n\nIf you didn't request this, ignore this email.`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [email], subject: 'Your A-Identity sign-in link', html, text }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string }
      return body.message || body.name || `Email provider error (HTTP ${res.status}).`
    }
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Failed to send the email.'
  }
}

/** On-brand, email-client-safe HTML (inline styles + a table button). Brand: ink
 *  #192837, accent #7342e2, cream #f2f2ee; protocol accents 7342E2/2775CA/1AAB7A. */
function magicEmailHtml(link: string, appUrl: string): string {
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
  return `<!doctype html><html><body style="margin:0;background:#f2f2ee">
  <div style="background:#f2f2ee;padding:40px 16px;${font}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto">
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
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#192837">Sign in to A&#8209;Identity</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#5b6673">Tap the button to sign in. This link works once, from this email, and expires in 15 minutes.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
          <td style="border-radius:999px;background:#7342e2">
            <a href="${link}" style="display:inline-block;padding:14px 34px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px">Sign in &rarr;</a>
          </td>
        </tr></table>
        <p style="margin:26px 0 0;font-size:12px;line-height:1.5;color:#8a93a0">Button not working? Open <a href="${appUrl}" style="color:#7342e2;text-decoration:none;font-weight:600">A&#8209;Identity</a> and request a fresh sign-in link.</p>
      </td></tr>
      <tr><td align="center" style="padding-top:22px">
        <p style="margin:0;font-size:12px;color:#a0a8b3">The passport and wallet for the agentic economy.</p>
        <p style="margin:6px 0 0;font-size:11px;color:#b8bec7">Didn't request this? You can safely ignore it.</p>
      </td></tr>
    </table>
  </div></body></html>`
}
