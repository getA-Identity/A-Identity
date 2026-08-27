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

test('a spoofed leading entry is ignored in favour of what our proxy appended', () => {
  // What an attacker can do: prepend anything. What they cannot do: stop our own proxy
  // appending the address it actually saw.
  assert.equal(clientIpFromXff('9.9.9.9, 203.0.113.7'), '203.0.113.7')
  assert.equal(clientIpFromXff('evil, also-evil, 203.0.113.7'), '203.0.113.7')
})

test('varying the spoofed part does not change the bucket, which is the whole point', () => {
  const keys = new Set(
    ['1.1.1.1', '2.2.2.2', '3.3.3.3', 'not-even-an-ip'].map((fake) => clientIpFromXff(`${fake}, 203.0.113.7`)),
  )
  assert.equal(keys.size, 1, 'a caller who edits the header must not get a fresh rate-limit bucket')
})

test('no header falls back to the socket, and no socket says so rather than guessing', () => {
  assert.equal(clientIpFromXff(undefined, '198.51.100.4'), '198.51.100.4')
  assert.equal(clientIpFromXff('', '198.51.100.4'), '198.51.100.4')
  assert.equal(clientIpFromXff(undefined, undefined), 'unknown')
})

test('a list shorter than the configured proxy depth clamps instead of reading past the start', () => {
  // Fewer hops than configured is a misconfiguration, not an attack, and it must not throw
  // or return undefined into a Map key.
  assert.equal(clientIpFromXff('203.0.113.7'), '203.0.113.7')
  assert.ok(TRUSTED_PROXY_COUNT >= 1)
})

test('node handles a repeated X-Forwarded-For header, which arrives as an array', () => {
  assert.equal(clientIpFromXff(['9.9.9.9', '203.0.113.7']), '203.0.113.7')
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
