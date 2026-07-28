import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS } from './registry.js'
import { publicChains, renderFrontendChains } from './public-view.js'

// The frontend's chain module is GENERATED from the registry (npm run gen:chains).
// These guard the thing that actually went wrong before unification: a second chain
// list drifting away from the registry without anyone noticing.

/** Compiled to dist/chains/, so the repo root is three levels up. */
const frontendChainsPath = fileURLToPath(new URL('../../../src/lib/chains.ts', import.meta.url))

test('the generated frontend chain module is in sync with the registry', () => {
  const onDisk = readFileSync(frontendChainsPath, 'utf8')
  assert.equal(
    onDisk,
    renderFrontendChains(),
    'src/lib/chains.ts is stale or was hand-edited. Run: cd mcp && npm run gen:chains',
  )
})

test('the frontend module exposes every registry chain, and nothing else', () => {
  const onDisk = readFileSync(frontendChainsPath, 'utf8')
  for (const c of CHAINS) {
    assert.ok(onDisk.includes(`"id": "${c.id}"`), `${c.id} missing from the frontend module`)
  }
  const idCount = (onDisk.match(/"id": "/g) ?? []).length
  assert.equal(idCount, CHAINS.length, 'the frontend module has a chain the registry does not')
})

test('the public projection keeps the legacy /api/chains keys', () => {
  // These flat keys predate unification; dropping one would silently break any
  // existing consumer of GET /api/chains.
  for (const c of publicChains()) {
    assert.equal(typeof c.identity, 'string')
    assert.equal(typeof c.erc8004Native, 'boolean')
    assert.equal(typeof c.x402, 'boolean')
    assert.equal(typeof c.role, 'string')
    assert.equal(typeof c.shortName, 'string')
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(c.color), `${c.id} color is not a 6-digit hex: ${c.color}`)
  }
})

test('the projection agrees with each descriptor it came from', () => {
  const pub = publicChains()
  assert.equal(pub.length, CHAINS.length)
  for (const [i, c] of CHAINS.entries()) {
    assert.equal(pub[i].id, c.id)
    assert.equal(pub[i].caip2, c.caip2)
    assert.equal(pub[i].chainId, c.evmChainId)
    assert.equal(pub[i].status, c.status)
    assert.equal(pub[i].evmCompatible, c.ecosystem === 'evm')
    assert.equal(pub[i].rpcUrl, c.rpcUrls[0])
    assert.equal(pub[i].identity, c.identity.standard)
    assert.equal(pub[i].x402, c.payment.x402)
  }
})

test('Arc is the only chain the public surface reports as live', () => {
  const live = publicChains().filter((c) => c.status === 'live' || c.status === 'beta')
  assert.deepEqual(
    live.map((c) => c.id),
    ['arc'],
  )
})
