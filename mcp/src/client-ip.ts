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

import { createHash } from 'node:crypto'

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

/**
 * What this process computed as the caller's key, in a form that is safe to serve.
 *
 * Both rate limiters are keyed on the client address and NEITHER fires in production, on
 * two different derivation algorithms, while both fire locally. That means the key varies
 * per request, and the only thing that can tell us why is the server: the X-Forwarded-For
 * a request actually carries at the app is not visible from outside.
 *
 * So this reports the SHAPE rather than the contents: how many entries the header had,
 * which index the rule picked, and a short fingerprint of the value. A fingerprint that
 * changes between two requests from the same client IS the bug, and a stable one rules the
 * key out and points at something else. Nothing here reveals an address: the caller's own
 * is already theirs, and the proxy hops stay behind a one-way hash.
 */
export function clientIpDiagnostic(
  xff: string | string[] | undefined,
  socketAddress: string | undefined,
): { entries: number; chosenIndex: number; source: 'xff' | 'socket' | 'none'; fingerprint: string; trustedProxyCount: number } {
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  const parts = typeof raw === 'string' && raw.length > 0
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const chosenIndex = parts.length ? Math.max(0, parts.length - TRUSTED_PROXY_COUNT) : -1
  const value = clientIpFromXff(xff, socketAddress)
  return {
    entries: parts.length,
    chosenIndex,
    source: parts.length ? 'xff' : socketAddress ? 'socket' : 'none',
    fingerprint: createHash('sha256').update(value).digest('hex').slice(0, 12),
    trustedProxyCount: TRUSTED_PROXY_COUNT,
  }
}
