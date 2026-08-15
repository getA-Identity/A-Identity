import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RAIL_BASE_PRICES_USD,
  ozFacilitatorUrl,
  ozKeyVar,
  stellarAmountRaw,
  stellarBroadcaster,
  stellarRailChallenge,
  stellarRailNetworks,
  stellarRailPaywallGate,
  stellarRailPriceUsd,
  stellarRailStatus,
  stellarRailToken,
} from './rail.js'
import { RAIL_BASE_PRICES_USD as EIP3009_PRICES } from '../x402-3009/rail.js'
import { getChainById } from '../chains/registry.js'

const PAYTO = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
const SEED = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST'.padEnd(56, 'A')
const READY = {
  X402_STELLAR_NETWORKS: 'stellar:testnet',
  X402_STELLAR_PAYTO: PAYTO,
  STELLAR_TESTNET_SIGNER_SECRET: SEED,
}

test('the base prices are the SAME OBJECT the EIP-3009 rail sells at', () => {
  // Imported, not restated. Three rails already sell these four tools; a fourth copy
  // would be a fourth thing that has to agree, and drift here is a pricing bug that no
  // test would otherwise catch.
  assert.equal(RAIL_BASE_PRICES_USD, EIP3009_PRICES)
  assert.deepEqual(Object.keys(RAIL_BASE_PRICES_USD).sort(), [
    'agent_passport',
    'reputation_score',
    'risk_check',
    'verify_agent',
  ])
})

test('nothing is added to the base price on this chain', () => {
  // The EIP-3009 rails add a disclosed settlement fee because gas is material there. A
  // settlement here measured 0.0023 XLM, several orders of magnitude under the cheapest
  // tool, so a line item to cover it would be a markup with an explanation attached.
  for (const tool of Object.keys(RAIL_BASE_PRICES_USD) as (keyof typeof RAIL_BASE_PRICES_USD)[]) {
    const p = stellarRailPriceUsd(tool)
    assert.equal(p.totalUsd, p.baseUsd, `${tool} must cost its base price and no more`)
  }
})

test('the amount is in the token’s own base units, at 7 decimals not 6', () => {
  const token = stellarRailToken(getChainById('stellar-testnet')!, {})!
  assert.equal(token.decimals, 7)
  // 0.005 USDC. At six decimals this would be 5000 and the buyer would be charged a tenth
  // of what they owe, which is the exact class of mistake the decimals check exists for.
  assert.equal(stellarAmountRaw('risk_check', token), 50_000n)
  assert.equal(stellarAmountRaw('agent_passport', token), 100_000n)
})

test('unconfigured is 501 with a reason, never a free serve', () => {
  const s = stellarRailStatus({})
  assert.equal(s.configured, false)
  const gate = stellarRailPaywallGate(s)
  assert.equal(gate.ok, false)
  if (!gate.ok) {
    assert.equal(gate.httpStatus, 501)
    assert.match(gate.body.reason ?? '', /X402_STELLAR_NETWORKS/)
  }
})

test('each missing piece names itself rather than saying "not configured"', () => {
  const noPayTo = stellarRailStatus({ X402_STELLAR_NETWORKS: 'stellar:testnet' })
  assert.match(noPayTo.reason ?? '', /X402_STELLAR_PAYTO/)
  // And it says the thing that will otherwise be discovered by a failed settlement.
  assert.match(noPayTo.reason ?? '', /trustline/)

  const noBroadcaster = stellarRailStatus({
    X402_STELLAR_NETWORKS: 'stellar:testnet',
    X402_STELLAR_PAYTO: PAYTO,
  })
  assert.equal(noBroadcaster.configured, false)
  assert.match(noBroadcaster.reason ?? '', /nothing can broadcast/)
})

test('a payTo that is not a classic account is refused', () => {
  // A C... contract id where a G... account belongs would be signed against happily and
  // then fail at settlement, which is the worst place to find out.
  const s = stellarRailStatus({
    ...READY,
    X402_STELLAR_PAYTO: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  })
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_STELLAR_PAYTO/)
})

test('an EVM chain is refused and pointed at the rail that serves it', () => {
  const s = stellarRailStatus({ X402_STELLAR_NETWORKS: 'eip155:42161' }, 'eip155:42161')
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /EIP-3009 rail serves those/)
})

test('a network this rail does not sell on is refused rather than redirected', () => {
  const s = stellarRailStatus(READY, 'stellar:pubnet')
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /does not sell on/)
})

test('the default broadcaster is ourselves, and OZ is the fallback', () => {
  const chain = getChainById('stellar-testnet')!
  // Both available: we run it, because that is the claim on every other chain.
  assert.deepEqual(
    stellarBroadcaster(chain, { STELLAR_TESTNET_SIGNER_SECRET: SEED, X402_STELLAR_TESTNET_OZ_KEY: 'k' }),
    { broadcaster: 'self', ready: true },
  )
  // Only OZ available: use it rather than refusing to sell.
  assert.deepEqual(stellarBroadcaster(chain, { X402_STELLAR_TESTNET_OZ_KEY: 'k' }), {
    broadcaster: 'oz',
    ready: true,
  })
  // Neither: refuse, and say so.
  assert.equal(stellarBroadcaster(chain, {}).ready, false)
})

test('an explicit broadcaster choice is honored, and its missing credential is named', () => {
  const chain = getChainById('stellar-testnet')!
  const forcedOz = stellarBroadcaster(chain, {
    X402_STELLAR_FACILITATOR: 'oz',
    STELLAR_TESTNET_SIGNER_SECRET: SEED,
  })
  // Asked for OZ, so it does NOT quietly fall back to self just because self would work.
  assert.equal(forcedOz.broadcaster, 'oz')
  assert.equal(forcedOz.ready, false)
  assert.match(forcedOz.reason ?? '', /X402_STELLAR_TESTNET_OZ_KEY/)

  const forcedSelf = stellarBroadcaster(chain, {
    X402_STELLAR_FACILITATOR: 'self',
    X402_STELLAR_TESTNET_OZ_KEY: 'k',
  })
  assert.equal(forcedSelf.broadcaster, 'self')
  assert.equal(forcedSelf.ready, false)
})

test('the two networks never share an OZ credential or an endpoint', () => {
  const t = getChainById('stellar-testnet')!
  const p = getChainById('stellar')!
  assert.equal(ozKeyVar(t), 'X402_STELLAR_TESTNET_OZ_KEY')
  assert.equal(ozKeyVar(p), 'X402_STELLAR_PUBNET_OZ_KEY')
  assert.notEqual(ozFacilitatorUrl(t, {}), ozFacilitatorUrl(p, {}))
  assert.match(ozFacilitatorUrl(t, {}), /testnet/)
  assert.doesNotMatch(ozFacilitatorUrl(p, {}), /testnet/)
})

test('the challenge offers a payable Soroban authorization, not an EIP-712 domain', () => {
  const s = stellarRailStatus(READY)
  assert.equal(s.configured, true)
  const ch = stellarRailChallenge('risk_check', s, READY)
  assert.equal(ch.httpStatus, 402)
  const body = ch.body as Record<string, any>
  assert.equal(body.x402Version, 2)
  const offer = body.accepts[0]
  assert.equal(offer.scheme, 'exact')
  assert.equal(offer.network, 'stellar:testnet')
  assert.equal(offer.decimals, 7)
  assert.equal(offer.maxAmountRequired, '50000')
  assert.equal(offer.payTo, PAYTO)
  assert.equal(offer.extra.authorization, 'soroban-auth')
  assert.equal(offer.extra.function, 'transfer')
  assert.match(offer.extra.networkPassphrase, /Test SDF Network/)
  // The absence that matters: nothing here is an EIP-712 domain, because there is no
  // per-token signing domain on Soroban to prove.
  assert.equal(offer.extra.domainSeparator, undefined)
  assert.equal(offer.extra.version, undefined)
})

test('the challenge tells the buyer it pays no fee, and does not invent a USD gas figure', () => {
  const s = stellarRailStatus(READY)
  const body = (stellarRailChallenge('verify_agent', s, READY) as { body: Record<string, any> }).body
  assert.match(body.tool.priceNote, /gasless/)
  assert.match(body.tool.priceNote, /stroops/, 'the measurement belongs in the note')
  assert.match(body.tool.priceNote, /no price feed we verify/)
  assert.equal(body.tool.price.totalUsd, RAIL_BASE_PRICES_USD.verify_agent)
})

test('an unconfigured rail produces 501 from the challenge too, not a 402 nobody can pay', () => {
  const ch = stellarRailChallenge('risk_check', stellarRailStatus({}), {})
  assert.equal(ch.httpStatus, 501)
})

test('networks parse from either spelling and duplicates collapse', () => {
  assert.deepEqual(stellarRailNetworks({ X402_STELLAR_NETWORKS: 'stellar:testnet' }), ['stellar:testnet'])
  assert.deepEqual(stellarRailNetworks({ X402_STELLAR_NETWORK: 'stellar:pubnet' }), ['stellar:pubnet'])
  assert.deepEqual(
    stellarRailNetworks({ X402_STELLAR_NETWORKS: ' stellar:testnet , stellar:testnet ,stellar:pubnet ' }),
    ['stellar:testnet', 'stellar:pubnet'],
  )
  assert.deepEqual(stellarRailNetworks({}), [])
})
