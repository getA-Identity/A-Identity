import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS, CHAIN_IDS, identityChains } from './registry.js'

/**
 * Registry versus code: the drift guard for anything that enumerates chains.
 *
 * Three copies of "the set of chains" had already gone stale before this existed. The
 * resolve_agent tool offered a chain that is not in the registry and REJECTED six that
 * are, so filtering to a real chain was a schema error for every MCP client. The
 * ChainName union had the same bug, and the identity provider's documented chain list
 * disagreed with the code right below it. Each of those is a claim about data, so each
 * is asserted against the data rather than reviewed by eye.
 */

/** Compiled to dist/chains/, so mcp/src is two levels up. */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

test('CHAIN_IDS is the registry, in registry order', () => {
  assert.deepEqual([...CHAIN_IDS], CHAINS.map((c) => c.id))
})

test('the ChainName union names exactly the registry chains', () => {
  // data.ts keeps a literal tuple because descriptor ids are typed `string`, so deriving
  // the union from CHAIN_IDS would collapse it to `string` and lose the type safety
  // entirely. That makes this assertion the thing keeping the two honest.
  const text = src('data.ts')
  const block = text.match(/CHAIN_NAMES\s*=\s*\[([^\]]*)\]/)
  assert.ok(block, 'data.ts no longer declares a CHAIN_NAMES tuple')
  const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...names].sort(),
    CHAINS.map((c) => c.id).sort(),
    'data.ts CHAIN_NAMES disagrees with the registry. Every id here must be a chain, and every chain must be here.',
  )
})

test('no module re-hardcodes the chain enum instead of importing CHAIN_IDS', () => {
  // The exact shape that shipped the bug: z.enum with quoted chain slugs.
  const text = src('server.ts')
  const enums = [...text.matchAll(/z\.enum\(\[([^\]]*)\]\)/g)].map((m) => m[1])
  for (const e of enums) {
    const literals = [...e.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const namesAChain = literals.some((l) => CHAIN_IDS.includes(l) || l === 'ethereum')
    assert.ok(
      !namesAChain,
      `server.ts hardcodes a chain enum (${e.trim()}). Use z.enum(CHAIN_IDS) so it cannot go stale.`,
    )
  }
})

test('every live or beta chain carries an identity registry, or is a listed exception', () => {
  // A wired chain with no registry is either a mistake or a decision. Listing the
  // decisions here means the mistakes stand out, which is the same discipline
  // no-hardcoded-chains.test.ts uses for its allowlist.
  const NO_REGISTRY_YET: Record<string, string> = {
    // base left this list on 2026-08-28: the canonical identity + reputation registries
    // were verified live there (EIP-1967 implementation slots read on Base and Arbitrum
    // One, implementations byte-identical), so the descriptor now carries them.
    stellar:
      'live on the strength of the PAYMENT side: the on-ledger spend policy holds real USDC on ' +
      'pubnet, and since 2026-08-28 the Soroban x402 rail sells there too (first sale tx ' +
      'f213371c, settled by our own broadcaster). Identity is not wired and is not claimed, ' +
      'which is the whole reason for this exception: ERC-8004 is EVM-only, no Soroban identity ' +
      'registry we trust exists to point at, and a Stellar agent\'s passport is bridged from an ' +
      'EVM chain rather than anchored here. Delete this entry the day a Soroban registry lands, ' +
      'or demote the chain.',
    'stellar-testnet':
      'beta on the strength of the PAYMENT path only: a Soroban spend policy, our own x402 facilitator, and settlements we confirm by reading the transfer ourselves. Identity is not wired and is not claimed. ERC-8004 is EVM-only, no Soroban identity registry exists to point at, and the passport a Stellar agent carries is bridged from an EVM chain rather than anchored here. Delete this entry the day a Soroban registry lands, or demote the chain.',
    algorand:
      'beta on the strength of the PAYMENT path only: the x402 v2 rail through the GoPlausible facilitator, credential-gated until a payTo and its USDC opt-in exist. Identity is not wired and is not claimed: no ERC-8004 registry or agent-identity ARC was found on Algorand as of 2026-08-30, and the passport is bridged from an EVM chain. Delete this entry the day a registry we can verify lands, or demote the chain.',
    'algorand-testnet':
      'beta for the same reason as its mainnet twin and with the same identity caveat: the payment rehearsal path only. No agent registry exists here to point at, so nothing identity-shaped is claimed.',
  }
  for (const c of CHAINS) {
    if (c.status !== 'live' && c.status !== 'beta') continue
    if (NO_REGISTRY_YET[c.id]) continue
    assert.ok(
      c.contracts.identityRegistry,
      `${c.id} is ${c.status} but carries no identityRegistry. Either it is not wired, or it belongs in NO_REGISTRY_YET with a reason.`,
    )
  }
  for (const id of Object.keys(NO_REGISTRY_YET)) {
    const c = CHAINS.find((x) => x.id === id)
    assert.ok(c, `NO_REGISTRY_YET names ${id}, which is not in the registry`)
    assert.ok(
      !c.contracts.identityRegistry,
      `the exception for ${id} is stale: it now carries a registry. Delete the entry.`,
    )
  }
})

test('identityChains covers every chain that actually carries a registry', () => {
  const covered = identityChains().map((c) => c.id).sort()
  const expected = CHAINS.filter((c) => c.ecosystem === 'evm' && c.evmChainId !== null && c.contracts.identityRegistry)
    .map((c) => c.id)
    .sort()
  assert.deepEqual(covered, expected)
  assert.ok(covered.length >= 6, 'identity reads should cover every registry chain, not a subset')
})
