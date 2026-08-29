import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALGORAND_ADDRESS_RE, ALGORAND_TX_ID_RE, isAlgorandAddress, isAlgorandTxId } from './ids.js'

// Real addresses read live off each network on 2026-08-30: the mainnet USDC
// creator (Circle) and the GoPlausible facilitator fee payer. Real values,
// because a checksum test against an invented string proves the happy path of
// the test, not of the checksum.
const CIRCLE_CREATOR = '2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM'
const FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA'

test('real Algorand addresses pass shape and checksum', () => {
  assert.ok(isAlgorandAddress(CIRCLE_CREATOR))
  assert.ok(isAlgorandAddress(FEE_PAYER))
})

test('a single flipped character fails the sha512-256 checksum, not just the regex', () => {
  const flipped = `${CIRCLE_CREATOR.slice(0, 10)}${CIRCLE_CREATOR[10] === 'A' ? 'B' : 'A'}${CIRCLE_CREATOR.slice(11)}`
  assert.match(flipped, ALGORAND_ADDRESS_RE, 'the typo still matches the regex; the checksum is what must catch it')
  assert.equal(isAlgorandAddress(flipped), false)
})

test('the wrong lengths and alphabets are rejected before any decoding', () => {
  assert.equal(isAlgorandAddress(CIRCLE_CREATOR.slice(0, 57)), false)
  assert.equal(isAlgorandAddress(`${CIRCLE_CREATOR}A`), false)
  assert.equal(isAlgorandAddress(CIRCLE_CREATOR.toLowerCase()), false)
  // 0, 1, 8 and 9 are not in the RFC 4648 base32 alphabet.
  assert.equal(isAlgorandAddress(`0${CIRCLE_CREATOR.slice(1)}`), false)
})

test('an EVM address and a Stellar StrKey are both rejected', () => {
  assert.equal(isAlgorandAddress('0xd305607510E0Db2c95807173c7A05BEA53c1ed36'), false)
  assert.equal(isAlgorandAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'), false)
})

test('transaction ids are 52-char base32 and nothing else', () => {
  assert.ok(isAlgorandTxId('UTXPSO7OSSQN6NFFI6QESOSMUGRMUMO7HVBMRTBTL6RLPFMUFWVQ'))
  assert.equal(isAlgorandTxId('UTXPSO7OSSQN6NFFI6QESOSMUGRMUMO7HVBMRTBTL6RLPFMUFWV'), false)
  assert.equal(isAlgorandTxId('0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54'), false)
  assert.match('NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA', ALGORAND_TX_ID_RE)
})
