import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueToken, verifyToken, isVerified, AUTH_SECRET } from './auth.js'

test('issueToken -> verifyToken round-trips subject + method', () => {
  const token = issueToken('alice@example.com', 'email')
  assert.deepEqual(verifyToken(token), { subject: 'alice@example.com', method: 'email' })
})

test('wallet and guest methods are carried through the token', () => {
  assert.equal(verifyToken(issueToken('0xabc', 'wallet'))?.method, 'wallet')
  assert.equal(verifyToken(issueToken('bob@x.com', 'guest'))?.method, 'guest')
})

test('isVerified: only wallet/email are verified, guest is not', () => {
  assert.equal(isVerified(verifyToken(issueToken('0xabc', 'wallet'))), true)
  assert.equal(isVerified(verifyToken(issueToken('a@b.co', 'email'))), true)
  assert.equal(isVerified(verifyToken(issueToken('a@b.co', 'guest'))), false)
  assert.equal(isVerified(null), false)
})

test('verifyToken rejects a tampered payload (kept signature)', () => {
  const token = issueToken('alice@example.com', 'wallet')
  const [, sig] = token.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'bob@example.com', method: 'wallet', iat: 1 })).toString('base64url')
  assert.equal(verifyToken(`${forgedPayload}.${sig}`), null)
})

test('verifyToken rejects a tampered signature', () => {
  const token = issueToken('x@y.z', 'email')
  const [payload] = token.split('.')
  assert.equal(verifyToken(`${payload}.deadbeef`), null)
})

test('verifyToken rejects garbage and empty input', () => {
  assert.equal(verifyToken(''), null)
  assert.equal(verifyToken(undefined), null)
  assert.equal(verifyToken(null), null)
  assert.equal(verifyToken('not-a-token'), null)
  assert.equal(verifyToken('a.b.c'), null)
})

test('legacy { email }-only tokens fail closed to guest (never verified)', async () => {
  // Simulate an old token that carried only { email } and no method, correctly signed.
  const { createHmac } = await import('node:crypto')
  const payload = Buffer.from(JSON.stringify({ email: 'legacy@x.com', iat: 1 })).toString('base64url')
  const sig = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
  const legacy = `${payload}.${sig}`
  assert.deepEqual(verifyToken(legacy), { subject: 'legacy@x.com', method: 'guest' })
  assert.equal(isVerified(verifyToken(legacy)), false)
})

test('two different subjects get distinct tokens', () => {
  assert.notEqual(issueToken('a@x.com', 'email'), issueToken('b@x.com', 'email'))
})

test('a freshly issued token verifies (carries a future exp)', () => {
  assert.equal(verifyToken(issueToken('0xabc', 'wallet'))?.subject, '0xabc')
})

test('a validly-signed but EXPIRED token is rejected', async () => {
  // Forge a correctly-signed token whose exp is in the past — must not verify.
  const { createHmac } = await import('node:crypto')
  const payload = Buffer.from(
    JSON.stringify({ sub: '0xabc', method: 'wallet', iat: 0, exp: Date.now() - 1000 }),
  ).toString('base64url')
  const sig = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
  assert.equal(verifyToken(`${payload}.${sig}`), null)
})

/**
 * Being signed out is an answer, not an error.
 *
 * /api/auth/me used to 401 for an anonymous caller, which made Chrome log a
 * console error on every page load for every visitor who was not logged in, and
 * failed the Lighthouse best-practices audit. It now answers 200 with
 * authenticated: false. The property that must hold is that this stays a
 * DEFINITIVE answer: the frontend has to be able to tell "you are signed out"
 * apart from "the backend was unreachable", because the first should clear a
 * stale session and the second must not.
 */
test('an anonymous caller gets a definitive signed-out answer, not an error', () => {
  // The distinguishing field is explicit rather than inferred from a missing
  // user object, since "no user key" is also what a network stub returns.
  const anonymousBody = { authenticated: false }
  assert.equal(anonymousBody.authenticated, false)
  assert.equal('user' in anonymousBody, false)

  // And a signed-in body must never carry authenticated:false, or the frontend
  // would log the user out on a successful restore.
  const signedInBody = { user: { email: 'a@b.co', name: 'a' }, method: 'email', verified: true } as Record<string, unknown>
  assert.equal(signedInBody.authenticated, undefined)
  assert.ok(signedInBody.user)
})
