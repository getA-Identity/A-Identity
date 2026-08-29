import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  algorandCaip2Of,
  algorandRailChallenge,
  algorandRailPaywallGate,
  algorandRailPriceUsd,
  algorandRailStatus,
  facilitatorNetworkFor,
  DEFAULT_FACILITATOR,
  RAIL_BASE_PRICES_USD,
} from './rail.js'

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'
const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe'
const PAY_TO = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA'

test('with no env the rail is unconfigured and says why', () => {
  const s = algorandRailStatus({})
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_ALGORAND_NETWORKS/)
  assert.equal(s.facilitator, DEFAULT_FACILITATOR)
  const gate = algorandRailPaywallGate(s)
  assert.equal(gate.ok, false)
  if (!gate.ok) assert.equal(gate.httpStatus, 501)
})

test('a malformed payTo is treated as unset, never received into', () => {
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: 'not-an-address' })
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /payTo/)
})

test('a configured testnet status carries the registry token and both network spellings', () => {
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO })
  assert.equal(s.configured, true)
  assert.equal(s.network, TESTNET)
  assert.equal(s.chain, 'algorand-testnet')
  assert.equal(s.token?.address, '10458941')
  assert.equal(s.token?.decimals, 6)
  assert.equal(s.payTo, PAY_TO)
  assert.equal(s.facilitatorNetwork, 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=')
})

test('a network the rail is not configured to sell on is refused, not redirected', () => {
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO }, MAINNET)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /not configured to sell/)
})

test('the CAIP-2 map round-trips both spellings and registry slugs', () => {
  assert.equal(facilitatorNetworkFor(MAINNET), 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=')
  assert.equal(algorandCaip2Of('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='), MAINNET)
  assert.equal(algorandCaip2Of(MAINNET), MAINNET)
  assert.equal(algorandCaip2Of('algorand-testnet'), TESTNET)
  assert.equal(algorandCaip2Of('stellar:pubnet'), null)
})

test('the challenge is a 402 with an x402 v2 accepts entry priced in base units', () => {
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO })
  const c = algorandRailChallenge('verify_agent', s)
  assert.equal(c.httpStatus, 402)
  assert.equal(c.body.x402Version, 2)
  const accepts = (c.body.accepts as Record<string, unknown>[])[0]
  assert.equal(accepts.scheme, 'exact')
  assert.equal(accepts.network, 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=')
  assert.equal(accepts.asset, '10458941')
  assert.equal(accepts.payTo, PAY_TO)
  const expected = String(Math.round(RAIL_BASE_PRICES_USD.verify_agent * 1e6))
  assert.equal(accepts.amount, expected)
  assert.equal(accepts.maxAmountRequired, expected)
})

test('the optional tag rides the accepts extra and is absent when unset', () => {
  const withTag = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO, X402_ALGORAND_TAG: 'x402-global-challenge' })
  const c = algorandRailChallenge('risk_check', withTag)
  const extra = ((c.body.accepts as Record<string, unknown>[])[0].extra ?? {}) as Record<string, unknown>
  assert.equal(extra.tag, 'x402-global-challenge')
  const without = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO })
  const c2 = algorandRailChallenge('risk_check', without)
  const extra2 = ((c2.body.accepts as Record<string, unknown>[])[0].extra ?? {}) as Record<string, unknown>
  assert.equal(extra2.tag, undefined)
})

test('an unconfigured challenge is a 501, never a free 402 menu', () => {
  const c = algorandRailChallenge('verify_agent', algorandRailStatus({}))
  assert.equal(c.httpStatus, 501)
})

test('the price is the base price: no settlement fee is invented on this rail', () => {
  for (const tool of ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport'] as const) {
    const p = algorandRailPriceUsd(tool)
    assert.equal(p.totalUsd, p.baseUsd)
    assert.equal(p.baseUsd, RAIL_BASE_PRICES_USD[tool])
  }
})
