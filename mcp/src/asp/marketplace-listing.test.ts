import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRICES } from './payment.js'

/**
 * Circle's Agent Marketplace reviews a listing against three prerequisites: the service
 * returns 402 when unpaid, it publishes an OpenAPI spec agents can read, and its payout
 * wallet is declared. The first is covered by the payment tests; these cover the second,
 * and they exist because a spec that drifts from the live tool list is worse than no
 * spec: a buyer agent reads it, calls a tool that is not there, and blames us.
 */

const here = dirname(fileURLToPath(import.meta.url)) // dist/asp
const spec = JSON.parse(readFileSync(join(here, '..', '..', 'marketplace', 'openapi.json'), 'utf8')) as {
  openapi: string
  info: { title: string; description: string }
  servers: { url: string }[]
  paths: Record<string, Record<string, { summary?: string; 'x-price'?: string; requestBody?: unknown }>>
}
const manifest = JSON.parse(
  readFileSync(join(here, '..', '..', 'marketplace', 'circle-agent-marketplace.json'), 'utf8'),
) as {
  url?: string
  description?: string
  tools?: { name: string; endpoint?: string; method?: string; price?: string }[]
  payment?: { networks?: unknown[] }
}

test('the OpenAPI spec is a valid 3.1 document with a production server', () => {
  assert.match(spec.openapi, /^3\.1/)
  assert.ok(spec.servers.length > 0)
  assert.match(spec.servers[0].url, /^https:\/\//)
})

test('every paid tool the gateway charges for is documented', () => {
  // PRICES is the gateway's own source of truth for what costs money.
  for (const route of Object.keys(PRICES)) {
    const path = route.replace(/^[A-Z]+\s+/, '')
    assert.ok(spec.paths[path], `openapi.json is missing ${path}, which PRICES charges for`)
  }
})

test('every documented paid tool carries its price', () => {
  for (const route of Object.keys(PRICES)) {
    const path = route.replace(/^[A-Z]+\s+/, '')
    const op = spec.paths[path]?.post
    assert.equal(op?.['x-price'], PRICES[route], `price drift on ${path}`)
  }
})

test('the free tool is documented and can never carry a chargeable price', () => {
  const free = spec.paths['/tools/trust_preview']?.post
  assert.ok(free, 'trust_preview should be discoverable even though it is free')
  // It may say "free" outright, or say nothing. What it must never do is name an
  // amount: a buyer agent reads x-price to decide whether to open a wallet, and the
  // gateway never charges this route, so a dollar figure here would be a lie.
  const price = free?.['x-price']
  assert.ok(price === undefined || price === 'free', `trust_preview must not be priced, got ${price}`)
  assert.equal(PRICES['POST /tools/trust_preview'], undefined, 'the gateway must not charge trust_preview')
})

test('the spec and the marketplace manifest agree on the service URL', () => {
  assert.equal(spec.servers[0].url, manifest.url)
})

test('the manifest declares at least one live payment network', () => {
  assert.ok(Array.isArray(manifest.payment?.networks) && manifest.payment.networks.length > 0)
})

// The manifest is served live at /.well-known/agent.json, which is what Circle's
// `services inspect` and buyer agents read. It once listed four of the six paid tools
// (and said "Four pay-per-call x402 tools") because nothing pinned it to PRICES; these
// two guards close that gap the same way the openapi guards above do.
test('the marketplace manifest lists exactly the paid tools the gateway charges for, at matching prices', () => {
  const paid = Object.keys(PRICES)
  const tools = manifest.tools ?? []
  for (const route of paid) {
    const path = route.replace(/^[A-Z]+\s+/, '')
    const tool = tools.find((t) => t.endpoint === path)
    assert.ok(tool, `circle-agent-marketplace.json is missing ${path}, which PRICES charges for`)
    assert.equal(tool?.price, PRICES[route], `manifest price drift on ${path}`)
  }
  for (const t of tools) {
    const route = `${t.method ?? 'POST'} ${t.endpoint}`
    assert.ok(PRICES[route] !== undefined, `the manifest lists ${t.endpoint}, which the gateway does not charge for`)
  }
  assert.equal(tools.length, paid.length, `the manifest lists ${tools.length} paid tools; PRICES has ${paid.length}`)
})

test('the manifest description states the real paid-tool count', () => {
  const words: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  const m = /(\w+) pay-per-call x402 tools/i.exec(manifest.description ?? '')
  assert.ok(m, 'the manifest description no longer states a "<N> pay-per-call x402 tools" count')
  assert.equal(
    words[m[1].toLowerCase()],
    Object.keys(PRICES).length,
    `the manifest description says "${m[1]} pay-per-call x402 tools"; PRICES has ${Object.keys(PRICES).length}`,
  )
})
