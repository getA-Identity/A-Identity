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
import { Keypair } from '@stellar/stellar-sdk'

const PAYTO = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
// A REAL seed. The previous placeholder was a padded string that passed an
// alphabet-and-length check and would now fail the checksum, which is exactly the class of
// value the checksum was added to reject.
const SEED = Keypair.random().secret()
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
  // The EIP-3009 rails add a disclosed settlement fee because gas is material there. Here
  // we absorb it instead. Note the honest framing, which an adversarial review had to
  // correct twice: 0.0022973 XLM is NOT negligible against a $0.001 tool. Priced off the
  // Stellar DEX order book, the feed on the very ledger we settle on, it is $0.000365, or
  // 36 percent of the cheapest sale, with break-even at XLM $0.4353. Charging nothing is a
  // decision to revisit, not a fact about the chain.
  for (const tool of Object.keys(RAIL_BASE_PRICES_USD) as (keyof typeof RAIL_BASE_PRICES_USD)[]) {
    const p = stellarRailPriceUsd(tool)
    assert.equal(p.totalUsd, p.baseUsd, `${tool} must cost its base price and no more`)
  }
})

test('the amount is in base units of the token itself, at 7 decimals not 6', () => {
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

test('a present but malformed key is not "ready", because readiness and signing agree now', () => {
  const chain = getChainById('stellar-testnet')!
  const errors: string[] = []
  const original = console.error
  console.error = (m: unknown) => void errors.push(String(m))
  try {
    // The realistic mistake: an EVM hex key in the Stellar variable. This used to report
    // ready: true, so the rail sold and then failed to settle every sale.
    const r = stellarBroadcaster(chain, { STELLAR_TESTNET_SIGNER_SECRET: '0x' + 'a'.repeat(64) })
    assert.equal(r.ready, false)
    assert.match(r.reason ?? '', /nothing can broadcast/)
    // A one-character typo in a real seed is the other one, and the checksum catches it.
    const good = Keypair.random().secret()
    const typo = good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21)
    assert.equal(stellarBroadcaster(chain, { STELLAR_TESTNET_SIGNER_SECRET: typo }).ready, false)
  } finally {
    console.error = original
  }
})

test('the dedicated fee payer is network-scoped and wins over the chain signer', () => {
  const testnet = getChainById('stellar-testnet')!
  const pubnet = getChainById('stellar')!
  const fee = Keypair.random().secret()
  assert.equal(stellarBroadcaster(testnet, { X402_STELLAR_TESTNET_FEE_PAYER: fee }).ready, true)
  // The testnet fee payer must not make pubnet look ready. One variable plus a network
  // flag is the shape that signs a pubnet transaction with a testnet key.
  assert.equal(stellarBroadcaster(pubnet, { X402_STELLAR_TESTNET_FEE_PAYER: fee }).ready, false)
  assert.equal(stellarBroadcaster(pubnet, { X402_STELLAR_PUBNET_FEE_PAYER: fee }).ready, true)
})

test('the retired variable does not make anything look ready', () => {
  // X402_STELLAR_SIGNER_SECRET was read by the readiness check and by nothing that signs.
  const chain = getChainById('stellar-testnet')!
  assert.equal(stellarBroadcaster(chain, { X402_STELLAR_SIGNER_SECRET: Keypair.random().secret() }).ready, false)
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
  assert.match(body.tool.priceNote, /pays no network fee/)
  assert.match(body.tool.priceNote, /stroops/, 'the measurement belongs in the note')
  // The buyer must be told we are absorbing a real cost, not that there is none, and the
  // note must NOT claim we cannot price it: the order book is on the chain we settle on.
  assert.match(body.tool.priceNote, /absorbing a real cost/)
  assert.doesNotMatch(body.tool.priceNote, /no price feed we verify/)
  assert.match(body.tool.priceNote, /order book/)
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
