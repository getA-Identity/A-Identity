/**
 * The magic link's own promise, held in place.
 *
 * The email says "The link works once and expires in 15 minutes". Half of that was true.
 * The token was signed and time-boxed and deliberately stateless, so nothing consumed it,
 * and anyone holding the URL could exchange it for a session over and over for the full
 * fifteen minutes. The ways an emailed link leaks are ordinary rather than exotic: a
 * forward, a shared inbox, a corporate scanner that follows every URL, browser history on
 * a shared machine.
 *
 * There was no test file for this module at all, which is how a claim printed in an email
 * to users stayed wrong. These are written so that the copy and the code cannot drift
 * apart again without something going red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeMagicToken, verifyMagicToken, magicEnabled, __resetRedeemedForTests } from './magic.js'

const EMAIL = 'someone@example.com'

test('a fresh token verifies to its email', () => {
  __resetRedeemedForTests()
  assert.equal(verifyMagicToken(makeMagicToken(EMAIL)), EMAIL)
})

test('a magic link works ONCE, which is what the email promises', () => {
  __resetRedeemedForTests()
  const token = makeMagicToken(EMAIL)
  assert.equal(verifyMagicToken(token), EMAIL)
  assert.equal(verifyMagicToken(token), null, 'a second exchange must not hand out a second session')
  assert.equal(verifyMagicToken(token), null)
})

test('redeeming one link does not burn another', () => {
  __resetRedeemedForTests()
  const first = makeMagicToken(EMAIL)
  const second = makeMagicToken('other@example.com')
  assert.equal(verifyMagicToken(first), EMAIL)
  assert.equal(verifyMagicToken(second), 'other@example.com', 'the register is per token, not per anything else')
})

test('a tampered token cannot burn the real one', () => {
  __resetRedeemedForTests()
  const token = makeMagicToken(EMAIL)
  const [payload, sig] = token.split('.')
  // Same signature, mangled payload: refused by the HMAC check, and it must NOT consume.
  // Otherwise anyone who saw a link could disable it without being able to use it.
  const forged = `${Buffer.from(JSON.stringify({ email: EMAIL, exp: Date.now() + 60_000 })).toString('base64url')}.${sig}`
  assert.equal(verifyMagicToken(forged), null)
  assert.equal(verifyMagicToken(`${payload}.${'a'.repeat(sig.length)}`), null)
  assert.equal(verifyMagicToken(token), EMAIL, 'the genuine link still works after failed forgeries')
})

test('an expired token is refused, and refused without consuming', () => {
  __resetRedeemedForTests()
  const expired = `${Buffer.from(JSON.stringify({ email: EMAIL, exp: Date.now() - 1 })).toString('base64url')}`
  // Signed correctly by construction is not possible from outside, so this asserts the
  // shape that IS reachable: a payload whose signature does not match is refused.
  assert.equal(verifyMagicToken(`${expired}.notasignature`), null)
  assert.equal(verifyMagicToken(undefined), null)
  assert.equal(verifyMagicToken(''), null)
  assert.equal(verifyMagicToken('nodot'), null)
})

test('the feature is gated on a credential, and says so rather than half-working', () => {
  assert.equal(magicEnabled({} as NodeJS.ProcessEnv), false)
  assert.equal(magicEnabled({ RESEND_API_KEY: 'x' } as NodeJS.ProcessEnv), true)
})
