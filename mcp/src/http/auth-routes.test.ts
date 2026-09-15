import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'

import { consumeWalletProof, issueNonce } from './auth-routes.js'

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
