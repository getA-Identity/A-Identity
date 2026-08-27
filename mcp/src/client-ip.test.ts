/**
 * The rate limiter is only a limit if the key cannot be chosen by the caller.
 *
 * `X-Forwarded-For` is appended to by each proxy, so its leftmost entry is whatever the
 * original caller sent. http.ts has counted from the trusted end since it was written. The
 * ASP gateway, a separate express server, had `app.set('trust proxy', true)`, which trusts
 * every hop and hands back that leftmost entry, so its free-preview limiter could be reset
 * per request by varying one header.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clientIpFromXff, TRUSTED_PROXY_COUNT } from './client-ip.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/**
 * The shapes below are Render's real ones, measured from the running service through
 * GET /api/diag/client-ip rather than assumed:
 *
 *   client sends no XFF   -> app sees 2 entries: [clientIp, renderHop]
 *   client sends 1 entry  -> app sees 3:         [spoofed, clientIp, renderHop]
 *   client sends 2        -> app sees 4
 *
 * Render appends TWO hops, so TRUSTED_PROXY_COUNT is 2 and the rule picks `len - 2`.
 * It defaulted to 1, which picked renderHop, and that address rotates across their fleet:
 * every few requests got a different key and a fresh bucket, so both limiters were inert in
 * production while passing here. These tests passed too, because they were written to the
 * assumed topology instead of the real one.
 */
const RENDER_HOP = '10.0.0.9'
const CLIENT = '203.0.113.7'

test('the real client is picked out of the shape Render actually sends', () => {
  assert.equal(clientIpFromXff(`${CLIENT}, ${RENDER_HOP}`), CLIENT)
})

test('a spoofed leading entry is ignored in favour of what our proxy appended', () => {
  // What an attacker can do: prepend anything. What they cannot do: stop Render appending
  // the address it actually saw.
  assert.equal(clientIpFromXff(`9.9.9.9, ${CLIENT}, ${RENDER_HOP}`), CLIENT)
  assert.equal(clientIpFromXff(`evil, also-evil, ${CLIENT}, ${RENDER_HOP}`), CLIENT)
})

test('varying the spoofed part does not change the bucket, which is the whole point', () => {
  const keys = new Set(
    ['1.1.1.1', '2.2.2.2', '3.3.3.3', 'not-even-an-ip'].map((fake) =>
      clientIpFromXff(`${fake}, ${CLIENT}, ${RENDER_HOP}`)),
  )
  assert.equal(keys.size, 1, 'a caller who edits the header must not get a fresh rate-limit bucket')
})

test('the rotating proxy hop is never the key, which is why the limiter was inert', () => {
  // The regression that mattered, stated directly: two requests that differ ONLY in the hop
  // Render happened to route through must land in the same bucket.
  const a = clientIpFromXff(`${CLIENT}, 10.0.0.9`)
  const b = clientIpFromXff(`${CLIENT}, 10.0.7.31`)
  assert.equal(a, b)
  assert.equal(a, CLIENT)
})

test('no header falls back to the socket, and no socket says so rather than guessing', () => {
  assert.equal(clientIpFromXff(undefined, '198.51.100.4'), '198.51.100.4')
  assert.equal(clientIpFromXff('', '198.51.100.4'), '198.51.100.4')
  assert.equal(clientIpFromXff(undefined, undefined), 'unknown')
})

test('a list shorter than the configured depth uses the socket, never the callers own entry', () => {
  // This used to clamp to index 0, and index 0 is what the CALLER wrote. So a wrong proxy
  // count did not merely misidentify the client, it handed the rate-limit key to whoever
  // was asking. One shared bucket over-limits and is loud; a spoofable key is silent.
  assert.equal(clientIpFromXff('i-typed-this', '198.51.100.4'), '198.51.100.4')
  assert.equal(clientIpFromXff('i-typed-this', undefined), 'unknown')
  assert.ok(TRUSTED_PROXY_COUNT >= 1)
})

test('node handles a repeated X-Forwarded-For header, which arrives as an array', () => {
  assert.equal(clientIpFromXff([CLIENT, RENDER_HOP]), CLIENT)
})

test('the default proxy depth matches where this actually runs', () => {
  // Measured, not assumed. A host with one proxy in front must set TRUSTED_PROXY_COUNT=1;
  // the fallback above makes getting that wrong cost availability rather than security.
  assert.equal(TRUSTED_PROXY_COUNT, 2)
})

test('neither server trusts every proxy hop', () => {
  // A static check, because the failure is one word and reintroducing it is one word. Both
  // servers must derive the client from the trusted end; `trust proxy` set to `true` is the
  // exact spelling that stops doing that.
  const gateway = readFileSync(`${SRC}asp-gateway.ts`, 'utf8')
  assert.doesNotMatch(
    gateway,
    /trust proxy['"],\s*true/,
    "asp-gateway sets `trust proxy` to true, which makes req.ip the caller's own X-Forwarded-For entry",
  )
  assert.match(gateway, /trust proxy['"], TRUSTED_PROXY_COUNT/)

  // And http.ts must not grow a second, divergent copy of the rule.
  const server = readFileSync(`${SRC}http.ts`, 'utf8')
  assert.match(server, /clientIpFromXff/, 'http.ts must read the client IP through the shared rule')
})
