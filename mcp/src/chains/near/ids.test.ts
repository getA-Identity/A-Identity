import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NEAR_ACCOUNT_ID_RE,
  NEAR_TX_HASH_RE,
  isNearAccountId,
  isNearTxHash,
  nearAccountKind,
  nearTargetOf,
} from './ids.js'
import { OWNER_ADDRESS_RE, SETTLEMENT_ADDRESS_RE, TX_HASH_RE } from '../stellar/strkey.js'
import { CHAINS, getChain, getChainById } from '../registry.js'

// Real values, read live on testnet on 2026-11-12, so a shape test cannot pass on a string
// that only looks plausible: Circle's testnet USDC (an implicit account), an account that
// exists with no contract, and a transaction NearBlocks' API returned.
const CIRCLE_TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'
const NAMED = 'a-identity.testnet'
const TX = '5WxNCK9TqGdVCUA1JBz57hdU5rEkM2wDCFrmzTsG1Syw'
// From the near-account-id crate's own test data (src/account_id_ref.rs).
const ETH_IMPLICIT = '0xb794f5ea0ba39494ce839613fffba74279579268'
/** The same 20 bytes the way an EVM wallet prints them, mixed case. */
const ETH_MIXED_CASE = '0xB794F5eA0ba39494cE839613fffBA74279579268'

test('each account kind the crate names is recognised, in the crate order', () => {
  assert.equal(nearAccountKind(NAMED), 'named')
  assert.equal(nearAccountKind('nansen-validator-01.testnet'), 'named')
  assert.equal(nearAccountKind(CIRCLE_TESTNET_USDC), 'near-implicit')
  assert.equal(nearAccountKind(ETH_IMPLICIT), 'eth-implicit')
  assert.equal(nearAccountKind(`0s${'0123456789abcdef'.repeat(2)}01234567`), 'deterministic')
  // A universal id is canonical only when its last symbol carries zero padding bits: 0 or g.
  assert.equal(nearAccountKind(`0u${'a'.repeat(51)}g`), 'universal')
  assert.equal(nearAccountKind(`0u${'a'.repeat(51)}h`), 'named', 'a non-canonical ending is just a name')
  // One character short of a kind falls back to named, as in the crate, rather than to null.
  assert.equal(nearAccountKind(ETH_IMPLICIT.slice(0, 41)), 'named')
  assert.equal(nearAccountKind('not an id'), null)
})

test('the format rules: 2 to 64 chars, lowercase, no separator at an end or twice in a row', () => {
  for (const ok of ['ab', 'a-b', 'a_b', 'a.b', 'a1.b-2_c.testnet', 'x'.repeat(64)]) {
    assert.ok(isNearAccountId(ok), ok)
  }
  for (const bad of ['a', 'x'.repeat(65), 'Alice.testnet', '-a', 'a-', '.a', 'a.', 'a..b', 'a-_b', 'a b', 'a@b', '']) {
    assert.ok(!isNearAccountId(bad), bad)
  }
  // A mixed-case EVM address is not a NEAR id at all; only its lowercase form is (eth-implicit).
  assert.ok(!isNearAccountId(ETH_MIXED_CASE))
  assert.ok(isNearAccountId(ETH_MIXED_CASE.toLowerCase()))
  // A Stellar StrKey and an Algorand address are uppercase, so neither is one.
  assert.ok(!isNearAccountId('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'))
  assert.ok(!isNearAccountId('2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM'))
  assert.equal(NEAR_ACCOUNT_ID_RE.test(NAMED), isNearAccountId(NAMED))
})

test('a transaction hash is base58 that decodes to exactly 32 bytes', () => {
  assert.ok(isNearTxHash(TX))
  // 32 zero bytes render as 32 ones, which is also the code_hash of an account with no contract.
  assert.ok(isNearTxHash('1'.repeat(32)))
  // 44 characters that encode more than 256 bits pass the regex and fail the decode.
  assert.match('z'.repeat(44), NEAR_TX_HASH_RE)
  assert.ok(!isNearTxHash('z'.repeat(44)))
  // 0, O, I and l are not base58; the other chains' renderings are the wrong length.
  assert.ok(!isNearTxHash(`0${TX.slice(1)}`))
  assert.ok(!isNearTxHash(TX.slice(0, 31)))
  assert.ok(!isNearTxHash('0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54'))
  assert.ok(!isNearTxHash('a'.repeat(64)))
  assert.ok(!isNearTxHash('UTXPSO7OSSQN6NFFI6QESOSMUGRMUMO7HVBMRTBTL6RLPFMUFWVQ'))
})

/**
 * The collision table, pinned. Every NEAR account id below is valid NEAR, and every one is
 * also something this codebase already reads another way, which came first and keeps it.
 */
test('only near:testnet:<id> and a bare *.testnet name route to NEAR; every colliding form stays with its first reader', () => {
  const colliding: [string, string][] = [
    ['849980', 'an ERC-8004 token id'],
    ['agent_mhx2abc12xyz', 'a platform agent id'],
    ['0x85f1c7e1b03fb4e4bdf1f6d8be8e2c0f4b6af6a4', 'an EVM address (lowercase)'],
    [CIRCLE_TESTNET_USDC, 'a 64-hex string: a Stellar tx hash, and the shape of an unprefixed EVM key'],
    ['alice.tg', 'a web domain in a real country TLD'],
    ['alice.near', 'a NEAR mainnet name, and there is no NEAR mainnet descriptor'],
  ]
  for (const [q, reading] of colliding) {
    assert.ok(isNearAccountId(q), `${q} should be a valid NEAR id, or this row tests nothing`)
    assert.equal(nearTargetOf(q), null, `${q} is ${reading}; a bare form must not route to NEAR`)
  }

  assert.deepEqual(nearTargetOf(NAMED), { network: 'near:testnet', account: NAMED, kind: 'named' })
  assert.deepEqual(nearTargetOf(`  ${NAMED}  `), { network: 'near:testnet', account: NAMED, kind: 'named' })
  // Namespaced, any kind routes, because the namespace says which reading is meant.
  assert.deepEqual(nearTargetOf(`near:testnet:${CIRCLE_TESTNET_USDC}`), {
    network: 'near:testnet',
    account: CIRCLE_TESTNET_USDC,
    kind: 'near-implicit',
  })
  assert.equal(nearTargetOf(`near:testnet:${ETH_IMPLICIT}`)?.kind, 'eth-implicit')
  assert.equal(nearTargetOf('near:testnet:849980')?.kind, 'named')

  for (const q of ['testnet', '.testnet', 'Alice.testnet', 'near:testnet:', 'near:testnet:Alice.testnet', 'near:mainnet:alice.near', 'https://alice.testnet', 'eip155:5042:0xb794f5ea0ba39494ce839613fffba74279579268']) {
    assert.equal(nearTargetOf(q), null, q)
  }
})

test('the routed network is the registry descriptor, and the only NEAR network there', () => {
  const routed = nearTargetOf(NAMED)?.network
  assert.ok(routed)
  const chain = getChain(routed)
  assert.ok(chain, `${routed} is not in the registry, so nothing could read the account it names`)
  assert.equal(chain.ecosystem, 'near')
  assert.equal(getChainById('near-testnet')?.caip2, routed)
  assert.deepEqual(CHAINS.filter((c) => c.ecosystem === 'near').map((c) => c.caip2), [routed])
})

test('the shared shape maps carry NEAR and refuse the other ecosystems their renderings', () => {
  assert.match(CIRCLE_TESTNET_USDC, SETTLEMENT_ADDRESS_RE.near)
  assert.match(NAMED, OWNER_ADDRESS_RE.near)
  assert.match(TX, TX_HASH_RE.near)
  // A NEAR hash is too short for Stellar's 64 hex or Algorand's 52 base32, and has no 0x.
  assert.doesNotMatch(TX, TX_HASH_RE.evm)
  assert.doesNotMatch(TX, TX_HASH_RE.stellar)
  assert.doesNotMatch(TX, TX_HASH_RE.algorand)
  for (const other of ['0x' + 'a'.repeat(64), 'a'.repeat(64), 'UTXPSO7OSSQN6NFFI6QESOSMUGRMUMO7HVBMRTBTL6RLPFMUFWVQ']) {
    assert.doesNotMatch(other, TX_HASH_RE.near, other)
  }
  // A Soroban contract id and a mixed-case EVM address are not NEAR accounts.
  assert.doesNotMatch('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', SETTLEMENT_ADDRESS_RE.near)
  assert.doesNotMatch(ETH_MIXED_CASE, SETTLEMENT_ADDRESS_RE.near)
})
