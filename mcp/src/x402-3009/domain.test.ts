import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  eip712DomainSeparator,
  proveDomain,
  domainCandidates,
  discoverDomain,
  provenDomainCached,
  clearDomainCache,
  type TokenReader,
} from './domain.js'
import { getChainById } from '../chains/index.js'

/**
 * The domain prover is the gate between a buyer's signature and real money moving, so
 * these tests care about two things above all: that our hashing agrees with a LIVE
 * contract (otherwise every signature we solicit is worthless), and that an unprovable
 * domain fails closed rather than falling back to a guess.
 *
 * The two separator values below were read from the chains on 2026-08-12. They are the
 * only external facts here; everything else is deterministic.
 */
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const
const USDG_SEPARATOR = '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036'
const BRIDGED = '0x71c6e1c209A4e3d4bd9911B2d53c98023A56C32F' as const
const BRIDGED_SEPARATOR = '0x192d8b03ad93f320f0da829eee0e1caf8b61842c2a226fe9977c0f209e09f712'

test('our domain hashing reproduces the live USDG separator', () => {
  // If this ever fails, every authorization we ask a buyer to sign on Robinhood Chain
  // mainnet is unsettleable. It is the single most load-bearing assertion in the rail.
  const computed = eip712DomainSeparator({
    name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: USDG,
  })
  assert.equal(computed.toLowerCase(), USDG_SEPARATOR)
})

test('our domain hashing reproduces the live bridged-USDC separator on the testnet', () => {
  const computed = eip712DomainSeparator({
    name: 'USDC', version: '2', chainId: 46630, verifyingContract: BRIDGED,
  })
  assert.equal(computed.toLowerCase(), BRIDGED_SEPARATOR)
})

test('a wrong version produces a different separator, so the proof can tell them apart', () => {
  const wrong = eip712DomainSeparator({
    name: 'Global Dollar', version: '2', chainId: 4663, verifyingContract: USDG,
  })
  assert.notEqual(wrong.toLowerCase(), USDG_SEPARATOR)
})

test('proveDomain picks the matching candidate and rejects a set with none', () => {
  const candidates = domainCandidates(
    { name: 'Global Dollar', version: null, chainId: 4663, verifyingContract: USDG },
    ['1'],
  )
  assert.equal(proveDomain(candidates, USDG_SEPARATOR)?.version, '1')
  assert.equal(proveDomain(candidates, BRIDGED_SEPARATOR), null)
})

test('candidates are ordered on-chain first, then declared, then the universal fallbacks', () => {
  const c = domainCandidates(
    { name: 'USDC', version: '3', chainId: 1, verifyingContract: USDG },
    ['7', '3'],
  )
  assert.deepEqual(c.map((x) => x.version), ['3', '7', '1', '2'])
})

/** A reader over a fixed set of answers; anything not listed reverts, exactly like an
 *  unknown selector on a real contract. */
function reader(answers: Partial<Record<string, unknown>>): TokenReader {
  return async (fn, args) => {
    if (!(fn in answers)) throw new Error(`${fn} reverted`)
    const v = answers[fn]
    return typeof v === 'function' ? (v as (a?: readonly unknown[]) => unknown)(args) : v
  }
}

const rhMain = getChainById('rhchain')!
const rhTest = getChainById('rhchain-testnet')!
const usdgToken = rhMain.settlementTokens![0]
const bridgedToken = rhTest.settlementTokens![0]

test('a token with no version() is proven from a candidate, and says so', async () => {
  // This is the real USDG shape: DOMAIN_SEPARATOR answers, version() does not.
  const r = await discoverDomain(rhMain, usdgToken, {
    reader: reader({
      DOMAIN_SEPARATOR: USDG_SEPARATOR, name: 'Global Dollar', symbol: 'USDG', decimals: 6, authorizationState: false,
    }),
  })
  assert.ok(r.ok)
  assert.equal(r.proven.domain.version, '1')
  assert.equal(r.proven.versionSource, 'proven-candidate')
  assert.equal(r.proven.domainSeparator.toLowerCase(), USDG_SEPARATOR)
})

test('a token that reports version() is proven from the chain, and says so', async () => {
  const r = await discoverDomain(rhTest, bridgedToken, {
    reader: reader({
      DOMAIN_SEPARATOR: BRIDGED_SEPARATOR, name: 'USDC', version: '2', symbol: 'USDC.e', decimals: 6, authorizationState: false,
    }),
  })
  assert.ok(r.ok)
  assert.equal(r.proven.versionSource, 'onchain')
  // The symbol comes from symbol(), the domain name from name(). They differ here, which
  // is exactly why the domain must never be built from the symbol.
  assert.equal(r.proven.symbol, 'USDC.e')
  assert.equal(r.proven.domain.name, 'USDC')
})

test('an unrelated DOMAIN_SEPARATOR fails closed and names both hashes', async () => {
  const bogus = '0x' + '11'.repeat(32)
  const r = await discoverDomain(rhMain, usdgToken, {
    reader: reader({ DOMAIN_SEPARATOR: bogus, name: 'Global Dollar', symbol: 'USDG', decimals: 6, authorizationState: false }),
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'no_matching_candidate')
  assert.match(r.reason, /Tried name "Global Dollar"/)
  assert.match(r.reason, new RegExp(bogus))
})

test('a missing DOMAIN_SEPARATOR fails closed', async () => {
  const r = await discoverDomain(rhMain, usdgToken, { reader: reader({ name: 'Global Dollar', decimals: 6 }) })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'no_domain_separator')
})

test('an unreadable name fails closed', async () => {
  const r = await discoverDomain(rhMain, usdgToken, { reader: reader({ DOMAIN_SEPARATOR: USDG_SEPARATOR, decimals: 6 }) })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'name_unreadable')
})

test('decimals that disagree with the registry fail closed', async () => {
  // A descriptor typo here is a 1000x mispricing, which is why it refuses rather than
  // trusting either side.
  const r = await discoverDomain(rhMain, usdgToken, {
    reader: reader({ DOMAIN_SEPARATOR: USDG_SEPARATOR, name: 'Global Dollar', decimals: 18, authorizationState: false }),
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'decimals_mismatch')
    assert.match(r.reason, /18 decimals/)
  }
})

test('a token without authorizationState is refused as not EIP-3009', async () => {
  const r = await discoverDomain(rhMain, usdgToken, {
    reader: reader({ DOMAIN_SEPARATOR: USDG_SEPARATOR, name: 'Global Dollar', decimals: 6 }),
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'not_eip3009')
})

test('a failed discovery is never cached, so a transient RPC error cannot pin the rail closed', async () => {
  clearDomainCache()
  let calls = 0
  const flaky: TokenReader = async (fn) => {
    if (fn === 'DOMAIN_SEPARATOR') {
      calls += 1
      if (calls === 1) throw new Error('rpc down')
      return USDG_SEPARATOR
    }
    if (fn === 'name') return 'Global Dollar'
    if (fn === 'symbol') return 'USDG'
    if (fn === 'decimals') return 6
    if (fn === 'authorizationState') return false
    throw new Error(`${fn} reverted`)
  }
  const first = await provenDomainCached(rhMain, usdgToken, { reader: flaky })
  assert.equal(first.ok, false)
  const second = await provenDomainCached(rhMain, usdgToken, { reader: flaky })
  assert.equal(second.ok, true)
  clearDomainCache()
})
