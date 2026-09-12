import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  algorandCaip2Of,
  algorandRailChallenge,
  algorandRailPaywallGate,
  algorandRailPriceUsd,
  algorandRailResource,
  algorandRailStatus,
  algorandResourceOrigin,
  facilitatorNetworkFor,
  DEFAULT_FACILITATOR,
  DEFAULT_RESOURCE_ORIGIN,
  RAIL_BASE_PRICES_USD,
  RAIL_TOOLS,
  type RailToolName,
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

test('every 402 declares a Bazaar discovery extension that passes the validation the facilitator runs', async () => {
  // The facilitator compiles `schema` with Ajv's 2020 draft (strict off) and drops the
  // declaration silently when `info` fails it, so this runs that exact check instead of
  // eyeballing the shape. The negative case proves the validator is not vacuous.
  const mod = (await import('ajv/dist/2020.js' as string)) as { default?: unknown }
  const AjvCtor = ((mod.default as { default?: unknown })?.default ?? mod.default ?? mod) as new (opts: object) => {
    compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown }
  }
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO })
  for (const tool of RAIL_TOOLS) {
    const c = algorandRailChallenge(tool, s)
    const bazaar = (c.body.extensions as { bazaar?: { info: { input: Record<string, unknown> }; schema: unknown } })?.bazaar
    assert.ok(bazaar?.info && bazaar.schema, `${tool} declares no bazaar extension`)
    const validate = new AjvCtor({ strict: false, allErrors: true }).compile(bazaar.schema)
    assert.ok(validate(bazaar.info), `${tool}: ${JSON.stringify(validate.errors)}`)
    assert.equal(bazaar.info.input.method, 'POST')
    assert.equal(bazaar.info.input.bodyType, 'json')
    const withoutAgent = { ...bazaar.info, input: { ...bazaar.info.input, body: {} } }
    assert.equal(validate(withoutAgent), false, `${tool}: a body without agentId must not validate`)
  }
})

test('resources are named under the site origin by default, and a malformed override is ignored', () => {
  assert.equal(algorandRailResource('verify_agent', {}), 'https://a-identity.xyz/api/x402/algorand/tools/verify_agent')
  assert.equal(
    algorandRailResource('risk_check', { X402_ALGORAND_RESOURCE_ORIGIN: 'https://api.example.com/' }),
    'https://api.example.com/api/x402/algorand/tools/risk_check',
  )
  for (const bad of ['http://a-identity.xyz', 'not a url', 'https://a-identity.xyz/sub', 'https://a-identity.xyz/?q=1']) {
    assert.equal(algorandResourceOrigin({ X402_ALGORAND_RESOURCE_ORIGIN: bad }), DEFAULT_RESOURCE_ORIGIN, bad)
  }
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO })
  const c = algorandRailChallenge('agent_passport', s, {})
  assert.equal((c.body.resource as { url: string }).url, 'https://a-identity.xyz/api/x402/algorand/tools/agent_passport')
})

test('each catalog description names what the caller gets back, not just the topic', () => {
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO })
  const names: Record<RailToolName, RegExp> = {
    verify_agent: /KYA/,
    reputation_score: /0-1000/,
    risk_check: /ALLOW \/ WARN \/ DENY/,
    agent_passport: /passport/,
  }
  for (const tool of RAIL_TOOLS) {
    const description = (algorandRailChallenge(tool, s).body.resource as { description: string }).description
    assert.ok(description.length >= 80, `${tool}: "${description}" is too thin for a catalog listing`)
    assert.match(description, names[tool])
    assert.match(description, /agentId/, `${tool}: the listing must say what to send`)
  }
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
