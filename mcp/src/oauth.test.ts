/**
 * The tests that matter here are the rejections. A token verifier that accepts
 * good tokens but also accepts forged ones passes a naive happy-path suite and
 * hands an attacker the write side of the platform, so most of this file is
 * about tokens that must NOT verify.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Configure before importing: the module reads env once at load.
process.env.OAUTH_ISSUER = 'https://test-issuer.example'
process.env.OAUTH_RESOURCE = 'https://a-identity.xyz/mcp'

const { verifyAccessToken, protectedResourceMetadata, wwwAuthenticate, oauthEnabled, __resetJwksCache } = await import(
  './oauth.js'
)

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'test-key-1'
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string }

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Mint a token signed by our test key, with whatever claims a case needs. */
function mint(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header }))
  const p = b64url(JSON.stringify({ iss: 'https://test-issuer.example', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 600, ...claims }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${h}.${p}`)
  return `${h}.${p}.${b64url(signer.sign(privateKey))}`
}

/** Stand in for the authorization server: metadata document, then the JWKS. */
function stubAs(overrides: { issuer?: string; keys?: unknown[] } = {}) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(
        JSON.stringify({
          issuer: overrides.issuer ?? 'https://test-issuer.example',
          jwks_uri: 'https://test-issuer.example/oauth2/jwks',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/oauth2/jwks')) {
      return new Response(
        JSON.stringify({ keys: overrides.keys ?? [{ kid: KID, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

test('a token signed by the authorization server verifies', async () => {
  __resetJwksCache()
  const restore = stubAs()
  const claims = await verifyAccessToken(mint({ email: 'meric@example.com' }))
  restore()
  assert.ok(claims, 'a well-formed token from the configured issuer should verify')
  assert.equal(claims!.sub, 'user_1')
  assert.equal(claims!.email, 'meric@example.com')
})

test('a token signed by the WRONG key is rejected', async () => {
  __resetJwksCache()
  const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))
  const p = b64url(JSON.stringify({ iss: 'https://test-issuer.example', sub: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${h}.${p}`)
  const forged = `${h}.${p}.${b64url(signer.sign(attacker.privateKey))}`

  const restore = stubAs()
  const claims = await verifyAccessToken(forged)
  restore()
  assert.equal(claims, null)
})

test('alg: none is rejected outright', async () => {
  __resetJwksCache()
  const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }))
  const p = b64url(JSON.stringify({ iss: 'https://test-issuer.example', sub: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }))
  const restore = stubAs()
  const claims = await verifyAccessToken(`${h}.${p}.`)
  restore()
  assert.equal(claims, null)
})

test('an HMAC-signed token claiming HS256 is rejected (alg confusion)', async () => {
  __resetJwksCache()
  // The classic attack: sign with HMAC using the RSA public key as the secret and
  // hope the verifier picks its algorithm from the token instead of pinning one.
  const { createHmac } = await import('node:crypto')
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID }))
  const p = b64url(JSON.stringify({ iss: 'https://test-issuer.example', sub: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }))
  const sig = b64url(createHmac('sha256', pub).update(`${h}.${p}`).digest())
  const restore = stubAs()
  const claims = await verifyAccessToken(`${h}.${p}.${sig}`)
  restore()
  assert.equal(claims, null)
})

test('an expired token is rejected', async () => {
  __resetJwksCache()
  const restore = stubAs()
  const claims = await verifyAccessToken(mint({ exp: Math.floor(Date.now() / 1000) - 3600 }))
  restore()
  assert.equal(claims, null)
})

test('a token from a different issuer is rejected', async () => {
  __resetJwksCache()
  const restore = stubAs()
  const claims = await verifyAccessToken(mint({ iss: 'https://evil-issuer.example' }))
  restore()
  assert.equal(claims, null)
})

test('metadata whose issuer disagrees with where it was fetched is refused', async () => {
  __resetJwksCache()
  const restore = stubAs({ issuer: 'https://somewhere-else.example' })
  const claims = await verifyAccessToken(mint({}))
  restore()
  assert.equal(claims, null, 'an AS metadata mix-up must not yield a verified token')
})

test('malformed input is rejected without throwing', async () => {
  __resetJwksCache()
  const restore = stubAs()
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', `${b64url('{')}.x.y`, randomBytes(24).toString('hex')]) {
    assert.equal(await verifyAccessToken(bad), null, `should reject: ${bad.slice(0, 12)}`)
  }
  restore()
})

test('the protected resource metadata names the issuer and the resource', () => {
  assert.ok(oauthEnabled())
  const prm = protectedResourceMetadata()
  assert.equal(prm.resource, 'https://a-identity.xyz/mcp')
  assert.deepEqual(prm.authorization_servers, ['https://test-issuer.example'])
  assert.deepEqual(prm.bearer_methods_supported, ['header'])
})

test('the 401 challenge points a client at the metadata document', () => {
  const h = wwwAuthenticate()
  assert.match(h, /^Bearer /)
  assert.match(h, /resource_metadata="https:\/\/a-identity\.xyz\/\.well-known\/oauth-protected-resource"/)
})

test('no phantom agent_key credential survives on any published auth surface', () => {
  // An "agent_key" / A_IDENTITY_AGENT_KEY credential was once advertised across the
  // OAuth metadata, auth.md, the server card, a skill and llms-full, but the code
  // implements no such thing: the real gate for value-moving tools is a verified
  // SIWE/OAuth session. This pins the fiction as removed so it cannot creep back.
  const surfaces = [
    new URL('../src/oauth.ts', import.meta.url),
    new URL('../../scripts/gen-oauth-mirror.mjs', import.meta.url),
    new URL('../../public/auth.md', import.meta.url),
    new URL('../../public/.well-known/oauth-protected-resource', import.meta.url),
    new URL('../../public/.well-known/oauth-authorization-server', import.meta.url),
    new URL('../../public/.well-known/mcp/server-card.json', import.meta.url),
    new URL('../../public/.well-known/agent-skills/hire-a-verified-agent/SKILL.md', import.meta.url),
    new URL('../../public/llms-full.txt', import.meta.url),
  ]
  for (const url of surfaces) {
    const text = readFileSync(url, 'utf8')
    assert.doesNotMatch(
      text,
      /agent_key|A_IDENTITY_AGENT_KEY/,
      `${url.pathname.split('/').pop()} still advertises a phantom agent_key credential; the code implements no such thing.`,
    )
  }
})
