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
  // The projection is DISPLAY-ordered (live > beta > planned, stable), so match by id
  // rather than registry index; every descriptor must appear exactly once.
  const pub = publicChains()
  assert.equal(pub.length, CHAINS.length)
  for (const c of CHAINS) {
    const p = pub.find((x) => x.id === c.id)
    assert.ok(p, `projection missing ${c.id}`)
    assert.equal(p.caip2, c.caip2)
    assert.equal(p.chainId, c.evmChainId)
    assert.equal(p.status, c.status)
    assert.equal(p.evmCompatible, c.ecosystem === 'evm')
    assert.equal(p.rpcUrl, c.rpcUrls[0])
    assert.equal(p.identity, c.identity.standard)
    assert.equal(p.x402, c.payment.x402)
  }
})

// ── the public agent manifest: the fifth surface that used to drift ───────────────

/** Compiled to dist/chains/, so the repo root is three levels up. */
const manifestPath = fileURLToPath(new URL('../../../public/.well-known/ai-agent-manifest.json', import.meta.url))

type ManifestChain = { id: string; status: string }

function manifest(): {
  capabilities: { identity: { chains: ManifestChain[] }; payments: { rails: ManifestChain[] } }
  interaction: { agent_to_agent: { chains_supported: string[] } }
} {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

// This file is hand-maintained on purpose (a human owns its prose), so instead of
// generating it we make drift impossible to ship. It previously advertised Ethereum as a
// supported identity chain while OMITTING Arc, the only chain where identity actually
// works, and marked the live Arc rail as "preview".
test('the agent manifest identity chains match the registry exactly', () => {
  const expected = CHAINS.map((c) => ({ id: c.id, status: c.status }))
  assert.deepEqual(
    manifest().capabilities.identity.chains.map((c) => ({ id: c.id, status: c.status })),
    expected,
    'public/.well-known/ai-agent-manifest.json identity.chains disagrees with chains/registry.ts',
  )
})

test('the agent manifest payment rails match the registry exactly', () => {
  const expected = CHAINS.map((c) => ({ id: c.id, status: c.status }))
  assert.deepEqual(
    manifest().capabilities.payments.rails.map((c) => ({ id: c.id, status: c.status })),
    expected,
    'public/.well-known/ai-agent-manifest.json payments.rails disagrees with chains/registry.ts',
  )
})

test('the agent manifest chains_supported matches the registry', () => {
  assert.deepEqual(
    manifest().interaction.agent_to_agent.chains_supported,
    CHAINS.map((c) => c.id),
  )
})

test('the public surface reports exactly the wired chains as live/beta', () => {
  // 2026-08-09 evening: Celo mainnet is LIVE (agent #9759 minted, x402 rail settling
  // real USDC). Display order puts live chains first; Base and Celo Sepolia stay beta.
  // 2026-08-11: rhchain-testnet joins the beta set (canonical ERC-8004 registries live).
  // 2026-08-12: rhchain joins as beta (mainnet canonical registries verified).
  // 2026-08-13: rhchain goes LIVE - four real USDG settlements through our own facilitator,
  // and arbitrum joins beta with agent #1259, then goes LIVE hours later once the same
  // rail settled real USDC there.
  // 2026-08-15: stellar-testnet joins as beta, the first non-EVM chain on this surface.
  // Its display position is decided by the same ordering rule as every other chain, not
  // by an exception, which is the thing worth checking here.
  // 2026-08-24: stellar (pubnet) joins as beta, with the vault deployed on mainnet and a
  // real USDC budget spent under it. It sorts AHEAD of its own testnet, which is the
  // ordering rule doing its job rather than a hand-placed exception: mainnet before
  // testnet within the same status.
  // 2026-08-27: stellar (pubnet) and base are called live, a maintainer's call on how the
  // product describes its own reach. Note what this list still proves after the change:
  // the three TESTNET mirrors stay beta, so nothing here says test money is live money,
  // and the ordering is still derived rather than hand-placed.
  const live = publicChains().filter((c) => c.status === 'live' || c.status === 'beta')
  assert.deepEqual(
    live.map((c) => ({ id: c.id, status: c.status })),
    [
      { id: 'arc', status: 'live' },
      { id: 'stellar', status: 'live' },
      { id: 'xlayer', status: 'live' },
      { id: 'base', status: 'live' },
      { id: 'arbitrum', status: 'live' },
      { id: 'rhchain', status: 'live' },
      { id: 'celo', status: 'live' },
      { id: 'stellar-testnet', status: 'beta' },
      { id: 'rhchain-testnet', status: 'beta' },
      { id: 'celo-sepolia', status: 'beta' },
    ],
  )
})
