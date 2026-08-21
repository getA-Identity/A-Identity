/**
 * The hand-rolled StrKey checks, against the SDK's.
 *
 * This file exists because strkey.ts said it did. Its module docstring justified
 * reimplementing base32 decode, the version byte and CRC16-XModem by hand with the sentence
 * "strkey.test.ts checks our answer against the SDK's on real and corrupted values, so the
 * two cannot disagree", and no such file was ever written. A reimplementation of a checksum
 * defended by a test that does not exist is worse than no checksum: it reads as verified.
 *
 * So this is the test that sentence promised. Every case runs both implementations and
 * requires them to agree, which is the only property that makes the reimplementation safe.
 * The point is not that our answer looks right; it is that it is the SDK's answer, computed
 * without importing the SDK, so the drift tests that consume these predicates stay offline
 * and instant.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Keypair, StrKey } from '@stellar/stellar-sdk'

import { isAccountId, isContractId, isSecretSeed, isStellarTxHash } from './strkey.js'

/** Real values from this project's own testnet work, not invented ones. */
const ACCOUNTS = [
  'GBRKRUDYKYOSGH4QIYAFONPWXFCFC7K5AYHIVJDNYJAZ33BE5YSMTS6R',
  'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI',
  'GBLHNAL57WLA5GKTIGPBHCJTQDNEZFX2CVH53EDUOGWIERNKECRENHQ5',
  'GDZXSO4AOKPSHMQZMBNEEBQNYOIF7TWDPD7K2U5VAPKFN3QIAIELTAN6',
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
]
const CONTRACTS = [
  'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI',
  'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
]

test('our account check agrees with the SDK on real accounts', () => {
  for (const a of ACCOUNTS) {
    assert.equal(isAccountId(a), StrKey.isValidEd25519PublicKey(a), a)
    assert.equal(isAccountId(a), true, a)
  }
})

test('our contract check agrees with the SDK on real contract ids', () => {
  for (const c of CONTRACTS) {
    assert.equal(isContractId(c), StrKey.isValidContract(c), c)
    assert.equal(isContractId(c), true, c)
  }
})

test('our seed check agrees with the SDK on freshly generated keypairs', () => {
  // Generated rather than pasted, so this covers arbitrary payload bytes rather than the
  // handful of values that happen to be in this repo.
  for (let i = 0; i < 40; i += 1) {
    const kp = Keypair.random()
    const secret = kp.secret()
    const pub = kp.publicKey()
    assert.equal(isSecretSeed(secret), StrKey.isValidEd25519SecretSeed(secret))
    assert.equal(isSecretSeed(secret), true)
    assert.equal(isAccountId(pub), StrKey.isValidEd25519PublicKey(pub))
    assert.equal(isAccountId(pub), true)
  }
})

/**
 * The case the checksum was added for: X402_STELLAR_PAYTO is typed by a human, and a single
 * wrong character produces a string that passes an alphabet-and-length test, makes the rail
 * report itself configured, and sells to an account nobody can pay.
 */
test('a one-character corruption is rejected, exactly as the SDK rejects it', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let checked = 0
  for (const good of [...ACCOUNTS, ...CONTRACTS]) {
    const isC = good.startsWith('C')
    // Every position, and a replacement that is a LEGAL base32 character, so the alphabet
    // check cannot be what catches it. Only the checksum can.
    for (let i = 1; i < good.length; i += 1) {
      const replacement = ALPHABET[(ALPHABET.indexOf(good[i]) + 1) % ALPHABET.length]
      const bad = good.slice(0, i) + replacement + good.slice(i + 1)
      if (bad === good) continue
      const ours = isC ? isContractId(bad) : isAccountId(bad)
      const theirs = isC ? StrKey.isValidContract(bad) : StrKey.isValidEd25519PublicKey(bad)
      assert.equal(ours, theirs, `disagreed on ${bad}`)
      assert.equal(ours, false, `${bad} differs from ${good} by one character and must not pass`)
      checked += 1
    }
  }
  // A loop that silently checked nothing would pass. Say how much it covered.
  assert.ok(checked > 300, `expected hundreds of corruptions, checked ${checked}`)
})

/**
 * The type letter is load-bearing here rather than cosmetic: on Stellar a contract and an
 * account live at different explorer routes and behave differently, so a check that accepts
 * either is not a check. This is the confusion that puts a transfer on an issuer instead of
 * a token.
 */
test('a valid key of the wrong TYPE is refused, and the SDK agrees', () => {
  for (const a of ACCOUNTS) {
    assert.equal(isContractId(a), StrKey.isValidContract(a))
    assert.equal(isContractId(a), false, `${a} is an account, not a contract`)
  }
  for (const c of CONTRACTS) {
    assert.equal(isAccountId(c), StrKey.isValidEd25519PublicKey(c))
    assert.equal(isAccountId(c), false, `${c} is a contract, not an account`)
  }
  const secret = Keypair.random().secret()
  assert.equal(isAccountId(secret), false)
  assert.equal(isContractId(secret), false)
})

test('garbage of every shape is refused without throwing', () => {
  const junk = [
    '',
    ' ',
    'G',
    'GBRKRUDY',
    `${ACCOUNTS[0]}A`,
    ACCOUNTS[0].slice(0, -1),
    ACCOUNTS[0].toLowerCase(),
    // 0, 1, 8 and 9 are not in the base32 alphabet, so these fail earlier than the checksum.
    ACCOUNTS[0].replace('K', '0'),
    ACCOUNTS[0].replace('K', '1'),
    '0x' + '0'.repeat(40),
    '0x' + 'a'.repeat(64),
    'not a key at all',
  ]
  for (const j of junk) {
    assert.equal(isAccountId(j), false, `isAccountId(${JSON.stringify(j)})`)
    assert.equal(isContractId(j), false, `isContractId(${JSON.stringify(j)})`)
    assert.equal(isSecretSeed(j), false, `isSecretSeed(${JSON.stringify(j)})`)
  }
})

/**
 * A Stellar transaction hash is the same 32 bytes an EVM hash carries, rendered WITHOUT the
 * 0x prefix. Prepending one would break every explorer link derived from it, so neither
 * rendering may be accepted for the other.
 */
test('a transaction hash is 64 lowercase hex with no 0x, and nothing else', () => {
  const real = '6d87799242b9fb36a26ac6f2d2fb11c5e7fb8bdd52bc6cf0471dcc8a8caba09c'
  assert.equal(isStellarTxHash(real), true)
  assert.equal(isStellarTxHash(`0x${real}`), false, 'the 0x rendering belongs to EVM')
  assert.equal(isStellarTxHash(real.toUpperCase()), false)
  assert.equal(isStellarTxHash(real.slice(0, 63)), false)
  assert.equal(isStellarTxHash(`${real}0`), false)
  assert.equal(isStellarTxHash(''), false)
})
