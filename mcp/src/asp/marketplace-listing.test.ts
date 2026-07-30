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
) as { url?: string; tools?: { name: string; price?: string }[]; payment?: { networks?: unknown[] } }

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

test('the free tool is documented and carries no price', () => {
  const free = spec.paths['/tools/trust_preview']?.post
  assert.ok(free, 'trust_preview should be discoverable even though it is free')
  assert.equal(free?.['x-price'], undefined)
})

test('the spec and the marketplace manifest agree on the service URL', () => {
  assert.equal(spec.servers[0].url, manifest.url)
})

test('the manifest declares at least one live payment network', () => {
  assert.ok(Array.isArray(manifest.payment?.networks) && manifest.payment.networks.length > 0)
})
