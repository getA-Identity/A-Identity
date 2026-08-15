import test from 'node:test'
import assert from 'node:assert/strict'

import { txUrl, addressUrl } from './explorer.js'
import { CHAINS, getChainById, requireChain } from './registry.js'
import {
  isAccountId,
  isContractId,
  isSecretSeed,
  isStellarTxHash,
  SETTLEMENT_ADDRESS_RE,
  TX_HASH_RE,
} from './stellar/strkey.js'
import type { ChainDescriptor } from './types.js'

// Real values, so a shape test cannot pass on a string that only looks plausible.
const USDC_SAC_PUBNET = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const USDC_ISSUER_PUBNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const stellarChain = (): ChainDescriptor =>
  CHAINS.find((c) => c.ecosystem === 'stellar') ??
  assert.fail('the registry carries no Stellar chain, so this whole module is unreachable')

test('EVM explorer links are unchanged', () => {
  const arc = requireChain('eip155:5042002')
  assert.equal(txUrl(arc, '0xabc'), 'https://testnet.arcscan.app/tx/0xabc')
  assert.equal(addressUrl(arc, '0xdef'), 'https://testnet.arcscan.app/address/0xdef')
})

/**
 * The bug this module was written to fix. Verified against Stellar Expert's API on
 * 2026-08-15: `/account/G...` and `/contract/C...` answer 200, and `/address/G...`
 * answers 404. The web app is a single-page shell that returns 200 for any path, so the
 * API is the only thing that can tell a real route from a dead one.
 */
test('a Stellar contract links to /contract, never to /address', () => {
  const c = stellarChain()
  const url = addressUrl(c, USDC_SAC_PUBNET)
  assert.ok(url.includes(`/contract/${USDC_SAC_PUBNET}`), url)
  assert.ok(!url.includes('/address/'), `Stellar Expert has no /address route: ${url}`)
})

test('a Stellar account links to /account, never to /address', () => {
  const c = stellarChain()
  const url = addressUrl(c, USDC_ISSUER_PUBNET)
  assert.ok(url.includes(`/account/${USDC_ISSUER_PUBNET}`), url)
  assert.ok(!url.includes('/address/'), `Stellar Expert has no /address route: ${url}`)
})

test('a Stellar tx link carries the hash with no 0x prefix', () => {
  const c = stellarChain()
  const hash = 'a'.repeat(64)
  assert.equal(txUrl(c, hash), `${c.explorer}/tx/${hash}`)
  assert.ok(!txUrl(c, hash).includes('0x'))
})

/**
 * The invariant `explorerBase` relies on. The type allows a null explorer, so without
 * this test a chain could be added with none and the link builders would throw at request
 * time instead of at build time.
 */
test('every chain in the registry declares an explorer', () => {
  for (const c of CHAINS) {
    assert.ok(
      c.explorer,
      `${c.id} has no explorer. Every link on /proof is derived from this field, so a chain ` +
        `without one cannot be cited as evidence.`,
    )
  }
})

test('every chain derives a link from its own explorer, never a hardcoded host', () => {
  for (const c of CHAINS) {
    const base = c.explorer as string
    const sample = c.ecosystem === 'stellar' ? USDC_SAC_PUBNET : '0x' + '1'.repeat(40)
    assert.ok(
      addressUrl(c, sample).startsWith(base),
      `${c.id}: address link does not start with the descriptor's own explorer`,
    )
    assert.ok(txUrl(c, 'deadbeef').startsWith(base), `${c.id}: tx link`)
  }
})

test('a chain with no explorer fails loudly instead of rendering "null/..."', () => {
  const broken = { ...requireChain('eip155:5042002'), explorer: null }
  assert.throws(() => txUrl(broken, 'abc'), /declares no explorer/)
  assert.throws(() => addressUrl(broken, '0xabc'), /declares no explorer/)
})

test('StrKey predicates separate the three types rather than accepting any 56 chars', () => {
  assert.ok(isContractId(USDC_SAC_PUBNET))
  assert.ok(!isAccountId(USDC_SAC_PUBNET), 'a C... is not an account')
  assert.ok(isAccountId(USDC_ISSUER_PUBNET))
  assert.ok(!isContractId(USDC_ISSUER_PUBNET), 'a G... is not a contract')
  assert.ok(!isSecretSeed(USDC_ISSUER_PUBNET))

  // base32 has no 0, 1, 8 or 9. A string that only got the length right must fail.
  assert.ok(!isContractId('C' + '0'.repeat(55)), 'base32 excludes 0')
  assert.ok(!isContractId('C' + '1'.repeat(55)), 'base32 excludes 1')
  assert.ok(!isContractId(USDC_SAC_PUBNET.slice(0, 55)), 'length is 56')
  assert.ok(!isContractId(USDC_SAC_PUBNET.toLowerCase()), 'StrKey is uppercase')
})

test('the shared shape maps refuse each ecosystem the other rendering', () => {
  const evmAddr = '0x' + 'a'.repeat(40)
  const evmHash = '0x' + 'a'.repeat(64)
  const stellarHash = 'a'.repeat(64)

  assert.ok(SETTLEMENT_ADDRESS_RE.evm.test(evmAddr))
  assert.ok(!SETTLEMENT_ADDRESS_RE.stellar.test(evmAddr), 'a 0x address is not a Soroban contract')
  assert.ok(SETTLEMENT_ADDRESS_RE.stellar.test(USDC_SAC_PUBNET))
  assert.ok(!SETTLEMENT_ADDRESS_RE.evm.test(USDC_SAC_PUBNET), 'a C... is not an EVM address')

  assert.ok(TX_HASH_RE.evm.test(evmHash))
  assert.ok(!TX_HASH_RE.stellar.test(evmHash), 'the 0x prefix is an EVM convention')
  assert.ok(TX_HASH_RE.stellar.test(stellarHash))
  assert.ok(!TX_HASH_RE.evm.test(stellarHash), 'an EVM hash must carry 0x')
  assert.ok(isStellarTxHash(stellarHash))
})

test('the Stellar descriptor points at Stellar Expert, whose routes this module encodes', () => {
  for (const c of CHAINS.filter((x) => x.ecosystem === 'stellar')) {
    assert.ok(
      (c.explorer ?? '').includes('stellar.expert'),
      `${c.id}: explorer is ${c.explorer}. addressUrl encodes Stellar Expert's /contract and ` +
        `/account routes specifically, so a different explorer needs its own branch rather than ` +
        `inheriting these paths silently.`,
    )
  }
})

test('getChainById still resolves every registry id after the descriptor work', () => {
  for (const c of CHAINS) assert.equal(getChainById(c.id)?.caip2, c.caip2)
})
