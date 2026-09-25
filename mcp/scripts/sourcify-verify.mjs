#!/usr/bin/env node
/**
 * Publish the source of one deployed AgentSpendPolicy vault to Sourcify, so anyone can read
 * the exact Solidity behind its bytecode on Sourcify and on any Blockscout explorer that
 * reads from it (explorer.arc.io does).
 *
 * It proves before it publishes: the contract is recompiled here with the same settings
 * scripts/compile-contracts.mjs uses, and the runtime bytecode is compared with the code
 * the chain returns for the address. Only an exact match (metadata hash included; the
 * immutable usdc address is the one range allowed to differ) is sent. If the bytes differ,
 * it says so and sends nothing.
 *
 * No key is involved: verification is a public read of the chain plus an upload of source
 * that is already public in this repo under MIT.
 *
 * Usage: cd mcp && npm run build && node scripts/sourcify-verify.mjs \
 *          --chain arc-mainnet --address 0x... [--tx 0x<creation tx>] [--dry]
 */
import solc from 'solc'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, isAddress } from 'viem'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', '')
const ADDRESS = arg('address', '')
const TX = arg('tx', '')
const DRY = process.argv.includes('--dry')
const SOURCIFY = 'https://sourcify.dev/server'
const FILE = 'AgentSpendPolicy.sol'
const CONTRACT = 'AgentSpendPolicy'

if (!isAddress(ADDRESS)) { console.error('error: --address 0x... is required'); process.exit(1) }

let getChainById, resolveRpcUrls
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const chain = getChainById(CHAIN_ID)
if (!chain || chain.ecosystem !== 'evm') { console.error(`error: '${CHAIN_ID}' is not an EVM chain in the registry`); process.exit(1) }

// Same settings as scripts/compile-contracts.mjs. Only this source goes in: the vault imports
// nothing, so its metadata names this one file and the hash does not depend on the others.
const here = dirname(fileURLToPath(import.meta.url))
const stdJsonInput = {
  language: 'Solidity',
  sources: { [FILE]: { content: readFileSync(join(here, '..', 'contracts', FILE), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } },
  },
}
const out = JSON.parse(solc.compile(JSON.stringify(stdJsonInput)))
const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1) }
const compiled = out.contracts[FILE][CONTRACT]
const local = '0x' + compiled.evm.deployedBytecode.object
// Immutables (the vault's usdc address) are zeros in the compiled runtime and written at
// deploy time, so those byte ranges are the only ones allowed to differ.
const immutableRanges = Object.values(compiled.evm.deployedBytecode.immutableReferences ?? {}).flat()
const maskImmutables = (hex) => {
  let h = hex.slice(2).toLowerCase()
  for (const { start, length } of immutableRanges) h = h.slice(0, start * 2) + '00'.repeat(length) + h.slice((start + length) * 2)
  return h
}
const compilerVersion = solc.version().replace(/\.Emscripten\.clang$/, '')

const rpc = resolveRpcUrls(chain, process.env)[0]
const pub = createPublicClient({ transport: http(rpc, { timeout: 20000, retryCount: 2 }) })
const onchain = (await pub.getCode({ address: ADDRESS })) ?? '0x'

console.log(`Target:   ${chain.name} (${chain.caip2}), ${chain.explorer}/address/${ADDRESS}`)
console.log(`Compiler: ${compilerVersion}, optimizer 200 runs`)
console.log(`Runtime:  local ${(local.length - 2) / 2} bytes, on chain ${(onchain.length - 2) / 2} bytes`)
if (onchain === '0x') { console.error('error: no code at that address on this chain'); process.exit(1) }
if (maskImmutables(onchain) !== maskImmutables(local)) {
  console.error('error: the recompiled runtime bytecode does NOT match the chain. Nothing was sent.')
  process.exit(1)
}
console.log(`Match:    exact outside ${immutableRanges.length} immutable slot(s), metadata hash included`)

// Already verified is an answer, not an error.
const existing = await fetch(`${SOURCIFY}/v2/contract/${chain.evmChainId}/${ADDRESS}`).then((r) => r.json()).catch(() => null)
if (existing?.match) {
  console.log(`Sourcify: already verified (${existing.match}), https://repo.sourcify.dev/${chain.evmChainId}/${ADDRESS}`)
  process.exit(0)
}
if (DRY) { console.log('Dry run:  nothing was sent'); process.exit(0) }

const body = { stdJsonInput, compilerVersion, contractIdentifier: `${FILE}:${CONTRACT}` }
if (TX) body.creationTransactionHash = TX
const res = await fetch(`${SOURCIFY}/v2/verify/${chain.evmChainId}/${ADDRESS}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const job = await res.json().catch(() => ({}))
if (!res.ok || !job.verificationId) { console.error(`error: Sourcify refused the job (HTTP ${res.status}): ${JSON.stringify(job)}`); process.exit(1) }
console.log(`Job:      ${job.verificationId}`)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const s = await fetch(`${SOURCIFY}/v2/verify/${job.verificationId}`).then((r) => r.json()).catch(() => null)
  if (!s?.isJobCompleted) continue
  if (s.error) { console.error(`error: ${JSON.stringify(s.error)}`); process.exit(1) }
  console.log(`Verified: runtime ${s.contract?.runtimeMatch ?? '?'}, creation ${s.contract?.creationMatch ?? '?'}`)
  console.log(`Source:   https://repo.sourcify.dev/${chain.evmChainId}/${ADDRESS}`)
  process.exit(0)
}
console.error('error: Sourcify did not finish within two minutes; check the job id above')
process.exit(1)
