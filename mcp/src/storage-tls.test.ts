/**
 * The database connection checks who it is talking to.
 *
 * storage.ts connected with `{ rejectUnauthorized: false }`, unconditionally, for months.
 * That does not turn TLS off; it turns off the half that tells you WHO answered. The
 * connection stays encrypted, encrypted to whoever picked up, and what crosses it is the
 * entire platform state blob: agents, wallets, instructions, spend policy.
 *
 * The default is now to verify. These pin the default and pin the escape hatch, because the
 * failure mode of the old setting was that it was silent: nothing logged it, nothing tested
 * it, and it read as a normal line of connection config.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sslOptions } from './storage.js'

const noEnv = {} as NodeJS.ProcessEnv

test('by default the certificate is verified', () => {
  assert.deepEqual(sslOptions(noEnv), { rejectUnauthorized: true })
})

test('verification is not switched off by a truthy-looking value', () => {
  // Exactly the string 'true'. A stray '1', 'yes' or 'TRUE' in a dashboard must not
  // silently disable a security check.
  for (const v of ['1', 'yes', 'TRUE', 'True', 'on', '']) {
    assert.deepEqual(
      sslOptions({ PGSSL_ALLOW_UNVERIFIED: v } as NodeJS.ProcessEnv), { rejectUnauthorized: true },
      `PGSSL_ALLOW_UNVERIFIED=${JSON.stringify(v)} must not disable verification`,
    )
  }
})

test('the escape hatch works, and only when set exactly', () => {
  const warned: unknown[] = []
  const real = console.warn
  console.warn = (...a: unknown[]) => { warned.push(a) }
  try {
    assert.deepEqual(
      sslOptions({ PGSSL_ALLOW_UNVERIFIED: 'true' } as NodeJS.ProcessEnv), { rejectUnauthorized: false },
    )
  } finally {
    console.warn = real
  }
  assert.equal(warned.length, 1, 'turning the check off must say so, every boot')
})

test('a private CA verifies rather than skipping the check', () => {
  // The honest answer for a self-hosted database: name the CA, keep the verification. This
  // must take priority over the escape hatch, so a leftover PGSSL_ALLOW_UNVERIFIED cannot
  // quietly downgrade a correctly configured host.
  const opts = sslOptions({
    PGSSLROOTCERT: new URL('../package.json', import.meta.url).pathname,
    PGSSL_ALLOW_UNVERIFIED: 'true',
  } as NodeJS.ProcessEnv)
  assert.equal(opts.rejectUnauthorized, true)
  assert.equal(typeof opts.ca, 'string')
})
