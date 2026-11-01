#!/usr/bin/env node
/**
 * Compile contracts/*.sol with solc and emit a typed artifact the backend can
 * import (ABI + deploy bytecode). Run: `npm run compile`.
 *
 * Kept deliberately tiny (one contract, standard-JSON in, one .ts artifact out),
 * so there is no Foundry/Hardhat toolchain to maintain alongside the viem stack.
 * Foundry (foundry.toml, test-sol/) only TESTS these sources; this script stays the one
 * compiler path to production, and foundry.toml mirrors its compiler and optimizer
 * settings so the tested code is the deployed code. Change them together.
 *
 * Each artifact also carries, after the ABI and the creation code:
 *   - the runtime code solc emits, with every immutable left as zero bytes, and the byte
 *     ranges the constructor writes each immutable into, grouped by the immutable's name.
 *     Together they let anyone tell whether a deployed contract runs this build WITH given
 *     values: write each value into its own ranges and compare every byte. The grouping is
 *     the point. Zeroing the ranges and comparing the rest vouches for nothing, because a
 *     crafted copy can hold one owner in the range owner() reads and another in the ranges
 *     onlyOwner checks. The /app/vault/arc page writes the owner() and usdc() it reads into
 *     the runtime and compares the whole code before it offers anything.
 *   - the sha256 of the source file it was compiled from, so a build with no solc in it
 *     (the root `npm run build`, scripts/check-vault-artifact.mjs) can still catch a .sol
 *     edit that was never recompiled. Commit 33c7df69 found artifacts built from a source
 *     that no longer existed, and nothing had noticed.
 *   - the compiler version and settings that produced the bytecode.
 * The ABI and creation-code lines are unchanged by these additions: outputSelection does
 * not enter the metadata hash, so asking solc for more output cannot move a byte of what
 * deploys.
 *
 * `--check` compiles in memory, renders the same text and compares it with the committed
 * files. It writes nothing and exits 1 on any difference, which is how CI fails when an
 * artifact no longer matches its source, its settings or its compiler.
 */
import solc from 'solc'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CHECK = process.argv.includes('--check')
const SOURCES = [
  { name: 'AgentSpendPolicy.sol', contract: 'AgentSpendPolicy' },
  { name: 'MerkleAirdrop.sol', contract: 'MerkleAirdrop' },
]
const OPTIMIZER = { enabled: true, runs: 200 }

const sources = {}
const sourceSha256 = {}
for (const s of SOURCES) {
  const bytes = readFileSync(join(root, 'contracts', s.name))
  sources[s.name] = { content: bytes.toString('utf8') }
  sourceSha256[s.name] = createHash('sha256').update(bytes).digest('hex')
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: OPTIMIZER,
    outputSelection: {
      // The source AST names the immutables that immutableReferences keys by AST id.
      '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))

const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage)
  console.error(`\nsolc: ${errors.length} error(s)`)
  process.exit(1)
}
for (const w of output.errors ?? []) console.warn(w.formattedMessage)

/**
 * Every immutable state variable the compiled sources declare, AST id to name. AST ids are
 * unique across one compilation, so an immutable inherited from another file is found too.
 */
function immutableNames(sourcesOut) {
  const names = {}
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') names[String(node.id)] = node.name
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v)
  }
  for (const src of Object.values(sourcesOut ?? {})) walk(src.ast)
  return names
}

const IMMUTABLE_NAMES = immutableNames(output.sources)

/**
 * solc keys immutable references by AST id. A reader needs them by NAME, each name with its
 * own ranges in order: a check that cannot tell the owner's ranges from the token's cannot
 * check that every owner range holds the same owner. Fails the compile rather than emitting
 * a range nobody can attribute.
 */
function immutableRanges(refs, names, file) {
  const out = {}
  for (const [id, ranges] of Object.entries(refs ?? {})) {
    const name = names[id]
    if (!name) {
      console.error(`solc reported immutable references for AST id ${id} in ${file}, and its AST names no immutable with that id`)
      process.exit(1)
    }
    out[name] = ranges.map((r) => ({ start: r.start, length: r.length })).sort((a, b) => a.start - b.start)
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]))
}

const outDir = join(root, 'src', 'contracts')
const stale = []

for (const s of SOURCES) {
  const c = output.contracts[s.name][s.contract]
  const abi = c.abi
  const bytecode = '0x' + c.evm.bytecode.object
  const deployed = '0x' + c.evm.deployedBytecode.object
  const ranges = immutableRanges(c.evm.deployedBytecode.immutableReferences, IMMUTABLE_NAMES, s.name)
  const compiler = { solc: solc.version(), optimizer: OPTIMIZER }
  const ts =
    `// AUTO-GENERATED by scripts/compile-contracts.mjs - do not edit by hand.\n` +
    `// Source: contracts/${s.name}\n` +
    `export const ${s.contract}Abi = ${JSON.stringify(abi, null, 2)} as const\n\n` +
    `export const ${s.contract}Bytecode = '${bytecode}' as const\n\n` +
    `/** The runtime code solc emits for this build, with every immutable left as zero bytes. */\n` +
    `export const ${s.contract}DeployedBytecode = '${deployed}' as const\n\n` +
    `/** Where the constructor writes each immutable into the runtime code, by name: byte offset and length, in order. */\n` +
    `export const ${s.contract}ImmutableReferences = ${JSON.stringify(ranges)} as const\n\n` +
    `/** sha256 of contracts/${s.name} exactly as it was compiled. */\n` +
    `export const ${s.contract}SourceSha256 = '${sourceSha256[s.name]}' as const\n\n` +
    `/** The compiler and settings that produced the bytecode above. */\n` +
    `export const ${s.contract}Compiler = ${JSON.stringify(compiler)} as const\n`
  const file = join(outDir, `${s.contract}.ts`)
  if (CHECK) {
    const committed = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (committed !== ts) stale.push(`src/contracts/${s.contract}.ts`)
    continue
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(file, ts)
  console.log(`✓ ${s.contract}: ${abi.length} ABI entries, ${(bytecode.length - 2) / 2} bytes -> src/contracts/${s.contract}.ts`)
}

if (CHECK) {
  if (stale.length) {
    console.error(
      `These committed artifacts do not match what ${solc.version()} compiles from contracts/ now:\n` +
        stale.map((f) => `  ${f}`).join('\n') +
        `\nRun: cd mcp && npm run compile && npm run gen:contracts, then commit the result.`,
    )
    process.exit(1)
  }
  console.log(`Contract artifacts match their Solidity source (${solc.version()}).`)
}
