import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCaip2,
  isValidCaip2,
  isEvmCaip2,
  evmChainIdFromCaip2,
  evmCaip2,
  buildCaip10,
  parseCaip10,
  buildCaip19,
} from './caip.js'

test('parseCaip2 splits a valid EVM chain id', () => {
  assert.deepEqual(parseCaip2('eip155:5042002'), { namespace: 'eip155', reference: '5042002' })
})

// The parser is namespace-agnostic on purpose, so it is exercised with a namespace we
// do NOT ship a descriptor for. bip122 is a real CAIP-2 namespace and stands in for any
// future non-EVM chain: the parser must not need to know a chain to read its id.
test('parseCaip2 handles non-EVM references (Stellar label, unknown namespace)', () => {
  assert.deepEqual(parseCaip2('stellar:testnet'), { namespace: 'stellar', reference: 'testnet' })
  assert.deepEqual(parseCaip2('bip122:000000000019d6689c085ae165831e93'), {
    namespace: 'bip122',
    reference: '000000000019d6689c085ae165831e93',
  })
})

test('parseCaip2 rejects malformed ids', () => {
  assert.equal(parseCaip2('nocolon'), null)
  assert.equal(parseCaip2(':5042002'), null)
  assert.equal(parseCaip2('ab:1'), null) // namespace too short (min 3)
  assert.equal(parseCaip2('toolongns:1'), null) // namespace too long (max 8)
})

test('isValidCaip2 matches parseCaip2', () => {
  assert.equal(isValidCaip2('eip155:1'), true)
  assert.equal(isValidCaip2('bad'), false)
})

test('isEvmCaip2 only true for eip155', () => {
  assert.equal(isEvmCaip2('eip155:8453'), true)
  assert.equal(isEvmCaip2('stellar:testnet'), false)
  assert.equal(isEvmCaip2('bip122:000000000019d6689c085ae165831e93'), false)
})

test('evmChainIdFromCaip2 extracts the numeric id, null for non-EVM', () => {
  assert.equal(evmChainIdFromCaip2('eip155:5042002'), 5042002)
  assert.equal(evmChainIdFromCaip2('stellar:testnet'), null)
  assert.equal(evmChainIdFromCaip2('eip155:notanumber'), null)
})

test('evmCaip2 builds an eip155 id', () => {
  assert.equal(evmCaip2(8453), 'eip155:8453')
})

test('CAIP-10 round-trips for EVM and Stellar addresses', () => {
  const evm = buildCaip10('eip155:5042002', '0xAbC0000000000000000000000000000000000001')
  assert.equal(evm, 'eip155:5042002:0xAbC0000000000000000000000000000000000001')
  assert.deepEqual(parseCaip10(evm), {
    chainId: 'eip155:5042002',
    address: '0xAbC0000000000000000000000000000000000001',
  })

  const stellar = buildCaip10('stellar:testnet', 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA')
  assert.deepEqual(parseCaip10(stellar), {
    chainId: 'stellar:testnet',
    address: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA',
  })
})

test('parseCaip10 rejects a bad chain-id half', () => {
  assert.equal(parseCaip10('bad:0xabc'), null)
  assert.equal(parseCaip10('eip155:5042002'), null) // no address half
})

test('buildCaip19 formats an asset id', () => {
  assert.equal(
    buildCaip19('eip155:5042002', 'erc20', '0x3600000000000000000000000000000000000000'),
    'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
  )
})
