import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair } from '@stellar/stellar-sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { verifyToken } from '../auth.js'
import { makeMagicToken } from '../magic.js'
import { consumeWalletProof, handleAuthRoutes, issueNonce } from './auth-routes.js'
import { mcpCallerFor, type RouteCtx } from './shared.js'

/**
 * Wallet sign-in nonces, at the two properties a stranger must not be able to break.
 *
 * Offline, with ed25519 keys generated at runtime and real signatures over the exact message
 * the server hands out. A nonce test that faked the signature check would pass against a
 * store that accepts anything, which is not the store being tested.
 */

const sign = (kp: Keypair, message: string) => kp.sign(Buffer.from(message, 'utf8')).toString('base64')

test('a nonce a stranger requests for your address does not cancel the one you are signing', async () => {
  const me = Keypair.random()
  const mine = issueNonce(me.publicKey())
  assert.ok(mine)
  // The address is public, so anyone can ask for a nonce for it. The store used to be keyed
  // by that address, so this second request overwrote the first, and the owner's signature
  // was refused as stale for as long as the stranger kept asking.
  const theirs = issueNonce(me.publicKey())
  assert.ok(theirs)
  assert.notEqual(theirs.message, mine.message)
  const r = await consumeWalletProof({ address: me.publicKey(), message: mine.message, signature: sign(me, mine.message) })
  assert.equal(r.ok, true)
})

test('a nonce is bound to its address and purpose, survives a bad signature, and works exactly once', async () => {
  const me = Keypair.random()
  const other = Keypair.random()
  const n = issueNonce(me.publicKey())
  assert.ok(n)
  const sig = sign(me, n.message)
  // A sign-in nonce is not a linking nonce.
  assert.equal((await consumeWalletProof({ address: me.publicKey(), message: n.message, signature: sig }, 'link')).ok, false)
  // Somebody else's address, with their own valid signature over this message.
  assert.equal(
    (await consumeWalletProof({ address: other.publicKey(), message: n.message, signature: sign(other, n.message) })).ok,
    false,
  )
  // A wrong signature is refused without burning the nonce, so a mistyped prompt can retry.
  assert.equal(
    (await consumeWalletProof({ address: me.publicKey(), message: n.message, signature: sign(other, n.message) })).ok,
    false,
  )
  assert.equal((await consumeWalletProof({ address: me.publicKey(), message: n.message, signature: sig })).ok, true)
  // And once it has worked, it never works again.
  const again = await consumeWalletProof({ address: me.publicKey(), message: n.message, signature: sig })
  assert.equal(again.ok, false)
  if (!again.ok) assert.equal(again.status, 401)
})

// -- the Bearer token the refusals and the curl hints send a reader to auth.md for --

/** POST to the auth route group with no session, the way a client starts a sign-in. */
async function postAuth(path: string, body: unknown) {
  const out: { status?: number; body?: Record<string, unknown> } = {}
  const res = {
    setHeader: () => undefined,
    writeHead(status: number) {
      out.status = status
      return this
    },
    end: (payload?: string) => {
      if (payload) out.body = JSON.parse(payload) as Record<string, unknown>
    },
  } as never
  const req = {
    method: 'POST',
    headers: {},
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return this
    },
  } as never
  const ctx: RouteCtx = { req, res, url: new URL(`http://localhost${path}`), caller: null, callerId: undefined }
  assert.equal(await handleAuthRoutes(ctx), true, `${path} is still an auth route`)
  return out
}

test('auth.md says how to get a Bearer token from a wallet or an email link, and the routes it names answer with one', async () => {
  // public/auth.md is where the register refusal and every register curl hint send a reader.
  const doc = readFileSync(new URL('../../../public/auth.md', import.meta.url), 'utf8')
  const at = doc.indexOf('### A Bearer token from a wallet or an email link')
  assert.ok(at > 0, 'auth.md keeps the section the Bearer hints point at')
  const section = doc.slice(at, doc.indexOf('\n### ', at + 1)).replace(/\s+/g, ' ')
  for (const route of ['/api/auth/nonce', '/api/auth/verify', '/api/auth/magic/request', '/api/auth/magic/verify']) {
    assert.ok(section.includes(`POST https://a-identity.xyz${route}`), `the section gives POST ${route}`)
  }
  assert.ok(section.includes('The answer carries `token`'), 'the wallet route is said to answer with the token')
  assert.ok(section.includes('The answer carries the session `token`'), 'and so is the email link route')
  assert.match(section, /`POST https:\/\/a-identity\.xyz\/api\/auth\/login` with only an email is \*\*not\*\* a sign-in/)
  assert.match(section, /the token it returns is a guest token/)

  // The wallet route, driven the way the section says: nonce, sign, verify.
  const account = privateKeyToAccount(generatePrivateKey())
  const nonce = await postAuth('/api/auth/nonce', { address: account.address })
  assert.equal(nonce.status, 200, JSON.stringify(nonce.body))
  const message = String(nonce.body?.message)
  const signed = await postAuth('/api/auth/verify', { address: account.address, message, signature: await account.signMessage({ message }) })
  assert.equal(signed.status, 200, JSON.stringify(signed.body))
  const walletCaller = verifyToken(String(signed.body?.token))
  assert.equal(walletCaller?.method, 'wallet')
  assert.equal(mcpCallerFor(walletCaller), account.address.toLowerCase(), 'a token that counts as a session on /mcp')

  // The email link route, with the value the emailed link carries.
  const email = 'owner@auth-routes.test'
  const link = await postAuth('/api/auth/magic/verify', { token: makeMagicToken(email) })
  assert.equal(link.status, 200, JSON.stringify(link.body))
  const emailCaller = verifyToken(String(link.body?.token))
  assert.equal(emailCaller?.method, 'email')
  assert.equal(mcpCallerFor(emailCaller), email, 'also a session on /mcp')

  // The plain login answers with a token too, and that one acts as no one.
  const guest = await postAuth('/api/auth/login', { email })
  assert.equal(guest.status, 200, JSON.stringify(guest.body))
  const guestCaller = verifyToken(String(guest.body?.token))
  assert.equal(guestCaller?.method, 'guest', 'the login does not prove the address, so it is a guest')
  assert.equal(mcpCallerFor(guestCaller), undefined, 'and /mcp treats it as no session, whichever address it names')
})
