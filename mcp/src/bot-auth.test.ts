/**
 * The signature has to verify against the PUBLISHED key, not just against
 * itself. A signer that produces well-formed bytes nobody else can check is
 * worse than no signer, because the directory then advertises a capability the
 * requests do not actually have.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify as cryptoVerify, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
process.env.BOT_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const { signRequest, signatureBase, BOT_KEY_ID, botAuthEnabled } = await import('./bot-auth.js')

/** Rebuild the base the way a verifier would: from the headers alone. */
function baseFromHeaders(method: string, url: string, signatureInput: string) {
  const params = signatureInput.replace(/^sig1=/, '')
  const u = new URL(url)
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@authority": ${u.host}`,
    `"@path": ${u.pathname}`,
    `"@signature-params": ${params}`,
  ].join('\n')
}

test('a signed request verifies against the public key', () => {
  assert.ok(botAuthEnabled())
  const h = signRequest('GET', 'https://example.com/api/thing?q=1')
  assert.ok(h)
  const base = baseFromHeaders('GET', 'https://example.com/api/thing?q=1', h!['signature-input'])
  const sig = Buffer.from(h!.signature.replace(/^sig1=:/, '').replace(/:$/, ''), 'base64')
  assert.equal(cryptoVerify(null, Buffer.from(base, 'utf8'), publicKey, sig), true)
})

test('the signature does not verify for a different path', () => {
  const h = signRequest('GET', 'https://example.com/a')!
  // A captured signature replayed against another resource must fail, or it is
  // an authorisation token for the whole origin rather than one request.
  const base = baseFromHeaders('GET', 'https://example.com/b', h['signature-input'])
  const sig = Buffer.from(h.signature.replace(/^sig1=:/, '').replace(/:$/, ''), 'base64')
  assert.equal(cryptoVerify(null, Buffer.from(base, 'utf8'), publicKey, sig), false)
})

test('the signature does not verify for a different method', () => {
  const h = signRequest('GET', 'https://example.com/a')!
  const base = baseFromHeaders('POST', 'https://example.com/a', h['signature-input'])
  const sig = Buffer.from(h.signature.replace(/^sig1=:/, '').replace(/:$/, ''), 'base64')
  assert.equal(cryptoVerify(null, Buffer.from(base, 'utf8'), publicKey, sig), false)
})

test('signature-input carries created, expires, a nonce and the key id', () => {
  const h = signRequest('GET', 'https://example.com/a', { now: 1_700_000_000_000 })!
  const si = h['signature-input']
  assert.match(si, /created=1700000000/)
  assert.match(si, /expires=1700000060/)
  assert.match(si, /nonce="[A-Za-z0-9_-]{16,}"/)
  assert.match(si, /alg="ed25519"/)
  assert.ok(si.includes(`keyid="${BOT_KEY_ID}"`))
})

test('each signature uses a fresh nonce', () => {
  const a = signRequest('GET', 'https://example.com/a')!
  const b = signRequest('GET', 'https://example.com/a')!
  const nonce = (h: string) => h.match(/nonce="([^"]+)"/)![1]
  assert.notEqual(nonce(a['signature-input']), nonce(b['signature-input']))
})

test('the base lists components in the same order it declares them', () => {
  const { base, params } = signatureBase({
    method: 'get',
    url: 'https://example.com/x/y',
    created: 1,
    expires: 2,
    nonce: 'n',
    keyid: 'k',
  })
  const declared = params.slice(1, params.indexOf(')')).split(' ')
  const listed = base.split('\n').slice(0, -1).map((l) => l.slice(0, l.indexOf(':')))
  assert.deepEqual(listed, declared, 'a verifier rebuilds the base from the declared order')
})

test('the published key id matches the directory we serve', () => {
  const dir = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../public/.well-known/http-message-signatures-directory'), 'utf8'),
  ) as { keys: Record<string, string>[] }
  // If these drift, every signature we send names a key nobody can look up.
  assert.ok(dir.keys.some((k) => k.kid === BOT_KEY_ID), 'BOT_KEY_ID must be present in the published JWKS')
  const k = dir.keys.find((k) => k.kid === BOT_KEY_ID)!
  assert.equal(k.kty, 'OKP')
  assert.equal(k.crv, 'Ed25519')
  // And the advertised key must be a real, importable Ed25519 public key.
  assert.doesNotThrow(() => createPublicKey({ key: k as never, format: 'jwk' }))
})

test('with no key configured, signing is a no-op rather than an error', async () => {
  const saved = process.env.BOT_SIGNING_KEY
  delete process.env.BOT_SIGNING_KEY
  // The module reads the env once at load, so re-import under a fresh specifier.
  const fresh = await import(`./bot-auth.js?nokey=${Date.now()}`)
  assert.equal(fresh.botAuthEnabled(), false)
  assert.equal(fresh.signRequest('GET', 'https://example.com/a'), null)
  process.env.BOT_SIGNING_KEY = saved
})
