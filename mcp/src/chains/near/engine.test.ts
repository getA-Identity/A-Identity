import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getChainById, CHAINS } from '../registry.js'
import { resolveRpcUrls } from '../evm/client.js'
import { nearEngineNetwork, nearEngineEnv, SDK_NETWORKS, ENGINE_VERSION, SDK_VERSION } from './engine.js'

/**
 * One engine, two places. near/sdk/src is the NEAR verdict engine's canonical copy; the backend
 * runs a generated copy of it (./sdk.generated/, cd mcp && npm run gen:near), so the SDK CLI and
 * GET /api/near/check decide with the same code. These tests are what keeps that true: the copy
 * must be a fresh render of the source, and the backend may change the hosts it reads (they
 * come from the chain registry) but nothing that enters a snapshot.
 */

/** Compiled to dist/chains/near/, so mcp/ is three levels up and the repository four. */
const MCP = fileURLToPath(new URL('../../../', import.meta.url))
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

type Generator = {
  renderNearEngine: () => Map<string, string>
  driftOf: (rendered: Map<string, string>) => { changed: string[]; stale: string[] }
  rewriteSource: (rel: string, text: string) => { specifiers: string[]; text: string }
  headerFor: (rel: string) => string
}
// The generator is plain ESM under scripts/, run before any build; a non-literal specifier keeps
// tsc from resolving it, and the test reads it exactly as `npm run gen:near` does.
const generator = (): Promise<Generator> => import(pathToFileURL(`${MCP}scripts/gen-near-engine.mjs`).href)

const near = () => {
  const chain = getChainById('near-testnet')
  assert.ok(chain, 'the registry declares near-testnet')
  return chain
}

test('the generated NEAR engine is a fresh render of near/sdk/src, file for file', async () => {
  const gen = await generator()
  const rendered = gen.renderNearEngine()
  // The two entry points and everything they reach, the version file included; nothing from
  // chain/ or cli/, which need near-api-js and are not the engine.
  for (const rel of ['engine/index.ts', 'collect/index.ts', 'engine/rules.ts', 'collect/snapshot.ts', 'version.ts']) {
    assert.ok(rendered.has(rel), `the copy is missing ${rel}`)
  }
  assert.ok(![...rendered.keys()].some((rel) => rel.startsWith('chain/') || rel.startsWith('cli/')), 'the copy reaches only the engine and its collectors')
  const { changed, stale } = gen.driftOf(rendered)
  assert.deepEqual(
    { changed, stale },
    { changed: [], stale: [] },
    'mcp/src/chains/near/sdk.generated/ is not a fresh render of near/sdk/src. Run: cd mcp && npm run gen:near',
  )
  // Each file is its source, byte for byte, behind the header, with only the specifiers rewritten.
  for (const [rel, text] of rendered) {
    const source = readFileSync(`${REPO}near/sdk/src/${rel}`, 'utf8')
    assert.ok(text.startsWith(gen.headerFor(rel)), `${rel} lacks its GENERATED header`)
    const body = text.slice(gen.headerFor(rel).length)
    assert.equal(body.replace(/(["'])(\.{1,2}\/[^"'\n]+)\.js\1/g, '$1$2.ts$1'), source, `${rel} differs from its source beyond the import specifiers`)
    assert.doesNotMatch(body, /from\s*["'][^"']*\.ts["']/, `${rel} still imports a .ts specifier`)
  }
})

test('the generator refuses what it could not copy faithfully: a package import, or a specifier it cannot rewrite', async () => {
  const gen = await generator()
  // The SDK's own shapes, each rewritten: a one-line import, a type import, a re-export, and the
  // closing line of an export list that spans lines.
  const ok = gen.rewriteSource(
    'x.ts',
    ['import { a } from "./a.ts";', 'import type { B } from "../b/b.ts";', 'export * from "./c.ts";', 'export {', '  d,', '} from "./d.ts";', 'const s = "./not-an-import.ts";'].join('\n'),
  )
  assert.deepEqual(ok.specifiers, ['./a.ts', '../b/b.ts', './c.ts', './d.ts'])
  assert.match(ok.text, /from "\.\/a\.js";\nimport type \{ B \} from "\.\.\/b\/b\.js";\nexport \* from "\.\/c\.js";\nexport \{\n {2}d,\n\} from "\.\/d\.js";/)
  assert.match(ok.text, /"\.\/not-an-import\.ts"/, 'a string that is not an import is left alone')
  assert.throws(() => gen.rewriteSource('x.ts', 'import { Account } from "near-api-js";'), /dependency-free/)
  assert.throws(() => gen.rewriteSource('x.ts', 'import { a } from "./a";'), /without a \.ts extension/)
  assert.throws(() => gen.rewriteSource('x.ts', 'const m = await import("./lazy.ts");'), /could not rewrite/)
})

test('the collectors read the near-testnet descriptor\'s hosts, never the copy\'s', () => {
  const chain = near()
  const cfg = nearEngineNetwork(chain, {})
  const archival = chain.archivalRpcUrls ?? []
  assert.deepEqual(cfg.rpc, chain.rpcUrls.filter((u) => !archival.includes(u)), 'regular hosts in registry order, the archival one left to the archival list')
  assert.deepEqual(cfg.archival, archival)
  assert.equal(cfg.fastnearTx, chain.indexerUrls?.fastnearTx)
  assert.equal(cfg.nearblocks, chain.indexerUrls?.nearblocks)
  assert.equal(cfg.explorer, chain.explorer)
  assert.equal(cfg.usdc, chain.documentedTokens?.find((t) => t.symbol === 'USDC')?.address)
  // The operator's override replaces the primary, exactly as it does for chains/near/client.ts.
  const override = 'https://near-testnet-rpc.example'
  const withOverride = nearEngineNetwork(chain, { NEAR_TESTNET_RPC_URL: override })
  assert.equal(withOverride.rpc[0], override)
  assert.deepEqual(withOverride.rpc, resolveRpcUrls(chain, { NEAR_TESTNET_RPC_URL: override }).filter((u) => !archival.includes(u)))
  // Every host the collectors can dial is one the registry declares (or the operator's override).
  const declared = new Set([...chain.rpcUrls, ...archival, chain.indexerUrls?.fastnearTx, chain.indexerUrls?.nearblocks, override])
  for (const u of [...withOverride.rpc, ...withOverride.archival, withOverride.fastnearTx, withOverride.nearblocks]) {
    assert.ok(declared.has(u), `${u} is not a host the registry declares`)
  }
  // Only the two optional indexer keys leave the process environment, and only to the collectors.
  assert.deepEqual(Object.keys(nearEngineEnv({ FASTNEAR_API_KEY: 'k', DATABASE_URL: 'secret' })).sort(), ['FASTNEAR_API_KEY', 'NEARBLOCKS_API_KEY'])
})

test('every value that enters a snapshot is the SDK\'s own, so the backend and the CLI record the same evidence', () => {
  // A host or an id that differs here would make the backend's snapshot of a block differ from
  // the CLI's: another USDC account read, another registry asked, another indexer URL recorded.
  // The RPC hosts are free to differ: no answer records which host gave it.
  const cfg = nearEngineNetwork(near(), {})
  const sdk = SDK_NETWORKS.testnet
  assert.equal(cfg.network, sdk.network)
  assert.equal(cfg.usdc, sdk.usdc)
  assert.equal(cfg.fastnearTx, sdk.fastnearTx)
  assert.equal(cfg.nearblocks, sdk.nearblocks)
  assert.equal(cfg.registry, sdk.registry)
  assert.deepEqual(cfg.erc8004, sdk.erc8004)
  assert.deepEqual(cfg.thirdParty, sdk.thirdParty)
  // The archival hosts the SDK falls back to are the registry's, in the same order.
  assert.deepEqual(cfg.archival, [...sdk.archival])
  // And the engine is the source's: the version a verdict prints is the one near/sdk/src declares.
  const types = readFileSync(`${REPO}near/sdk/src/engine/types.ts`, 'utf8')
  assert.equal(ENGINE_VERSION, /ENGINE_VERSION = "([^"]+)"/.exec(types)?.[1])
  assert.equal(SDK_VERSION, /SDK_VERSION = "([^"]+)"/.exec(readFileSync(`${REPO}near/sdk/src/version.ts`, 'utf8'))?.[1])
})

test('only a NEAR testnet descriptor that declares every host the engine reads gets a config', () => {
  const chain = near()
  assert.throws(() => nearEngineNetwork(CHAINS.find((c) => c.ecosystem === 'evm')!, {}), /not a NEAR chain/)
  assert.throws(() => nearEngineNetwork({ ...chain, testnet: false }, {}), /testnet only/)
  assert.throws(() => nearEngineNetwork({ ...chain, archivalRpcUrls: undefined }, {}), /archivalRpcUrls/)
  assert.throws(() => nearEngineNetwork({ ...chain, indexerUrls: undefined }, {}), /indexerUrls/)
  assert.throws(() => nearEngineNetwork({ ...chain, documentedTokens: [] }, {}), /USDC/)
})
