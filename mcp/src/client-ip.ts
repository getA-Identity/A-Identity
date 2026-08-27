/**
 * Who the client is, when someone else's proxy is speaking for them.
 *
 * `X-Forwarded-For` is a list that each proxy APPENDS to, so the leftmost entry is whatever
 * the original caller sent, which is to say whatever they made up. Anything keyed on that
 * value is not a limit: a caller who varies one header gets a fresh bucket per request and
 * the limiter stops existing.
 *
 * The real client address is the entry our own trusted layer appended, counted from the
 * RIGHT. http.ts has worked this way and said so in a comment since it was written. The ASP
 * gateway, a separate express server, had `app.set('trust proxy', true)`, which tells
 * express to trust every hop and hand back the leftmost entry. Measured, with
 * `X-Forwarded-For: 9.9.9.9, 203.0.113.7`:
 *
 *   trust proxy = true -> req.ip 9.9.9.9      (the caller's own invention)
 *   trust proxy = 1    -> req.ip 203.0.113.7  (what our proxy saw)
 *
 * `req.protocol` reads 'https' from X-Forwarded-Proto under both, which matters because
 * that is the reason `trust proxy` is set on that server at all: the OKX x402 middleware
 * builds the 402 challenge's resource URL from it and OKX requires a public https one.
 *
 * This module exists so the two servers cannot answer this question differently again.
 */

/** Trusted reverse proxies in front of us. Render and Vercel each terminate as one hop. */
export const TRUSTED_PROXY_COUNT = Math.max(1, Number(process.env.TRUSTED_PROXY_COUNT ?? 1))

/** The client address from an XFF list, counted from the trusted end. */
export function clientIpFromXff(xff: string | string[] | undefined, socketAddress?: string): string {
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  if (typeof raw === 'string' && raw.length > 0) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
    // Clamp, so a list SHORTER than the expected proxy depth falls back to its first entry
    // rather than reading past the start. That case means fewer hops than configured, which
    // is a misconfiguration rather than an attack, and it must not throw.
    const idx = Math.max(0, parts.length - TRUSTED_PROXY_COUNT)
    if (parts[idx]) return parts[idx]
  }
  return socketAddress || 'unknown'
}
