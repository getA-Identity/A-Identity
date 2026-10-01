#!/usr/bin/env node
/**
 * Deploy one AgentSpendPolicy vault on Stellar, from a recorded salt, and write its release
 * receipt.
 *
 * Why this exists: SOW 2 needs two new testnet vaults (D2, owned by a browser-wallet key, and
 * D3, owned by a smart account behind a device passkey), and every vault so far was deployed
 * by hand with the stellar CLI and then described in a receipt written from memory. This
 * script does the deploy through the same adapter the server uses (so the constructor
 * arguments, the OwnerIsOperator refusal and the archived-code check are the tested ones),
 * and writes the receipt from what the network answered rather than from what was intended.
 *
 * What it does, in order:
 *  1. With --wasm, hashes the file and uploads it as a code entry, unless a live code entry
 *     with that hash already exists (then the upload is skipped and the receipt says so).
 *     With --wasm-hash, instantiates against an existing code entry and uploads nothing.
 *  2. Instantiates the vault with createCustomContract from the deployer account and a
 *     32-byte salt. The salt is taken from --salt or generated and printed, so the contract
 *     id is known before the deploy and can be re-derived by anyone after it.
 *  3. Writes soroban/releases/<chainId>-<version>-<yyyy-mm-dd>.json in the spirit of
 *     testnet-v0.1.0.json, with every transaction's hash, ledger and the fee it was charged.
 *
 * Prepared-or-executed, like every write here. --dry-run simulates the upload or the deploy
 * and prints what the receipt would say, signs nothing and writes no file. Without
 * --source-key-env (or with that variable unset) nothing is signed either: a dry run then
 * needs --deployer <G...> to simulate from, and a real run stops with the exact call it would
 * make. The chain's own signer variable is never read implicitly: the deployer key is the one
 * named on the command line, so a deploy cannot borrow the server's operator key by accident.
 *
 * The owner is permanent (the contract has no set_owner and no upgrade), so it is never
 * defaulted: --owner is required, and owner == operator is refused here and again by the
 * adapter and again by the contract.
 *
 * Usage:
 *   cd mcp && npm run build
 *   node --env-file=.env scripts/stellar-deploy-vault.mjs --chain stellar-testnet \
 *     --wasm-hash 155eb31c... --owner G... --operator G... \
 *     --daily-cap 100000000 --auto-approve 20000000 --source-key-env STELLAR_DEPLOYER_SECRET
 *   node scripts/stellar-deploy-vault.mjs --chain stellar-testnet --wasm ../soroban/target/.../agent_spend_policy.wasm \
 *     --owner G... --operator G... --daily-cap 100000000 --auto-approve 20000000 --deployer G... --dry-run
 *
 * Optional: --version v0.1.1 (required when the hash is not in contracts.knownVaultWasmHashes),
 * --notes "free text recorded in the receipt", --out <path> to write the receipt elsewhere.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RELEASES = resolve(HERE, '../../soroban/releases')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const fail = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

let getChainById, createStellarAdapter, sorobanServer, networkPassphrase, isAccountId, isContractId, xdr, Keypair
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ createStellarAdapter } = await import('../dist/chains/stellar/adapter.js'))
  ;({ sorobanServer, networkPassphrase } = await import('../dist/chains/stellar/client.js'))
  ;({ isAccountId, isContractId } = await import('../dist/chains/stellar/strkey.js'))
  ;({ xdr, Keypair } = await import('@stellar/stellar-sdk'))
} catch (e) {
  fail(`mcp/dist not built or a dependency is missing (${e instanceof Error ? e.message : String(e)}). Run: cd mcp && npm run build`)
}

// ── arguments, all checked before anything touches the network ──────────────────

const chainId = arg('chain')
if (chainId !== 'stellar-testnet' && chainId !== 'stellar') fail('--chain must be stellar-testnet or stellar')
const chain = getChainById(chainId)
if (!chain || chain.ecosystem !== 'stellar') fail(`${chainId} is not a Stellar chain in the registry`)

const DRY = flag('dry-run')
const wasmPath = arg('wasm')
const wasmHashArg = arg('wasm-hash').toLowerCase()
if (wasmPath && wasmHashArg) fail('pass --wasm or --wasm-hash, not both: the hash of a file is computed, never typed beside it')
if (!wasmPath && !wasmHashArg) fail('pass --wasm <path to .wasm> to upload a build, or --wasm-hash <hex> to use a code entry already on chain')
if (wasmHashArg && !/^[0-9a-f]{64}$/.test(wasmHashArg)) fail('--wasm-hash must be 32 bytes of hex')

const owner = arg('owner')
const operator = arg('operator')
if (!isAccountId(owner) && !isContractId(owner)) fail('--owner must be a Stellar account (G...) or a smart account (C...); it is permanent, so it is never defaulted')
if (!isAccountId(operator)) fail('--operator must be a Stellar account (G...): it is the key that signs pay')
if (owner === operator) {
  fail('--owner and --operator are the same account. The contract refuses this with OwnerIsOperator: one key that can both spend and lift the policy is no policy.')
}

const intArg = (name) => {
  const v = arg(name)
  if (!/^\d+$/.test(v)) fail(`--${name} must be a whole number of token base units (7 decimals on Stellar), 0 or more`)
  return v
}
const dailyCap = intArg('daily-cap')
const autoApprove = intArg('auto-approve')

let salt
const saltArg = arg('salt').toLowerCase()
if (saltArg) {
  if (!/^[0-9a-f]{64}$/.test(saltArg)) fail('--salt must be 32 bytes of hex (64 characters)')
  salt = Buffer.from(saltArg, 'hex')
} else {
  salt = randomBytes(32)
  console.log(`salt (generated, record it): ${salt.toString('hex')}`)
}

const token = chain.settlementTokens?.[0]
if (!token) fail(`${chain.name} declares no settlement token, so there is nothing for a vault to hold`)

// The deployer key is read from the variable the operator NAMED, and placed under the chain's
// signer variable only inside the env this script hands the adapter. The chain's own signer
// variable is removed first, so an unset --source-key-env can never fall through to it.
const keyEnv = arg('source-key-env')
if (keyEnv && !/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) fail('--source-key-env must be the NAME of an environment variable, never a secret')
const env = { ...process.env }
if (chain.signerEnvVar) delete env[chain.signerEnvVar]
const secret = keyEnv ? process.env[keyEnv]?.trim() : undefined
if (keyEnv && !secret) console.log(`note: ${keyEnv} is not set, so nothing will be signed.`)
if (secret && chain.signerEnvVar) env[chain.signerEnvVar] = secret

let deployer = arg('deployer')
if (secret) {
  try {
    deployer = Keypair.fromSecret(secret).publicKey()
  } catch {
    fail(`${keyEnv} does not hold a Stellar secret seed (S...). Its value is not printed.`)
  }
}
if (deployer && !isAccountId(deployer)) fail('--deployer must be a Stellar account (G...)')
if (!secret && DRY && !deployer) fail('a dry run with no key needs --deployer <G...> to simulate from')

let wasm = null
let wasmHash = wasmHashArg
if (wasmPath) {
  if (!existsSync(wasmPath)) fail(`${wasmPath} does not exist`)
  wasm = readFileSync(wasmPath)
  wasmHash = createHash('sha256').update(wasm).digest('hex')
}

const known = (chain.contracts.knownVaultWasmHashes ?? []).find((k) => k.hash.toLowerCase() === wasmHash)
const version = arg('version') || known?.version || ''
if (!version) fail(`wasm ${wasmHash} is not in contracts.knownVaultWasmHashes for ${chain.id}, so pass --version (for example v0.1.1)`)
if (known && arg('version') && arg('version') !== known.version) {
  fail(`--version ${arg('version')} disagrees with the registry, which records ${wasmHash} as ${known.version}`)
}
if (!chain.testnet && !DRY) console.log('PUBNET: this deploy spends real XLM from the deployer account.')

console.log(`chain:     ${chain.name} (${chain.caip2})`)
console.log(`wasm:      ${wasmHash}${wasm ? ` (${wasm.length} bytes from ${wasmPath})` : ''} ${known ? `known as ${known.version}` : `recorded as ${version}`}`)
console.log(`owner:     ${owner}`)
console.log(`operator:  ${operator}`)
console.log(`token:     ${token.symbol} ${token.address}`)
console.log(`policy:    daily cap ${dailyCap}, auto-approve ${autoApprove} (base units)`)
console.log(`deployer:  ${deployer || '(none: unsigned)'}`)
console.log(`mode:      ${DRY ? 'dry run, nothing is signed or written' : secret ? 'EXECUTE' : 'prepared only, no key'}`)

const adapter = createStellarAdapter(chain)
const server = sorobanServer(chain, env)

// ── 1. the code entry ─────────────────────────────────────────────────────────────

async function codeEntryLive(hash) {
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, 'hex') }))
  const res = await server.getLedgerEntries(key)
  const entry = res.entries[0]
  return Boolean(entry && typeof entry.liveUntilLedgerSeq === 'number' && entry.liveUntilLedgerSeq > res.latestLedger)
}

let upload = null
const liveBefore = await codeEntryLive(wasmHash).catch((e) => fail(`the code entry could not be read: ${e instanceof Error ? e.message : String(e)}`))
if (wasm && !liveBefore) {
  upload = await adapter.uploadVaultWasm(wasm, { dryRun: DRY, deployer }, env)
  console.log(`upload:    ${upload.outcome}${upload.txHash ? ` ${upload.txHash}` : ''}`)
  if (upload.outcome !== 'settled' && !(DRY && upload.outcome === 'prepared')) {
    console.log(JSON.stringify(upload, null, 2))
    fail(upload.outcome === 'prepared' ? 'no key, so the upload was not submitted and the deploy cannot follow it' : 'the upload did not settle, so nothing was deployed')
  }
} else if (wasm) {
  console.log('upload:    skipped, a live code entry with this hash already exists')
} else if (!liveBefore) {
  fail(`no live code entry for ${wasmHash} on ${chain.name}. Pass --wasm with the module to upload it first.`)
}

// ── 2. the instance ───────────────────────────────────────────────────────────────

let deploy = null
if (DRY && upload && upload.outcome === 'prepared') {
  // The code entry does not exist yet, so the constructor cannot be simulated against it.
  console.log('deploy:    not simulated: it needs the code entry the upload above would create')
} else {
  deploy = await adapter.deployVault(
    { owner, operator, token: token.address, dailyCapRaw: dailyCap, autoApproveMaxRaw: autoApprove, wasmHash, salt, dryRun: DRY, deployer },
    env,
  )
  console.log(`deploy:    ${deploy.outcome}${deploy.vault ? ` ${deploy.vault}` : ''}${deploy.txHash ? ` tx ${deploy.txHash}` : ''}`)
  if (deploy.outcome !== 'settled' && !(DRY && deploy.outcome === 'prepared')) {
    console.log(JSON.stringify(deploy, null, 2))
    fail(deploy.outcome === 'prepared' ? 'no key, so nothing was submitted. Above is the exact call it would make.' : 'the deploy did not settle')
  }
}

// ── 3. the receipt ────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10)
const txOf = (o) =>
  o && o.outcome === 'settled'
    ? { txHash: o.txHash, ledger: o.ledger ?? null, feeChargedStroops: o.feeChargedStroops ?? null }
    : o && o.simulation
      ? { simulated: true, feeStroops: o.simulation.feeStroops, latestLedger: o.simulation.latestLedger }
      : null

const receipt = {
  note: DRY
    ? 'A DRY RUN of a vault deploy: simulated only, nothing was signed or submitted, and the contract id is the one the salt would derive.'
    : 'The deploy receipt for one AgentSpendPolicy vault, written by mcp/scripts/stellar-deploy-vault.mjs from what the ' +
      'network answered. The contract id is derived from the deployer and the salt, so anyone can re-derive it.',
  ...(DRY ? { dryRun: true } : {}),
  version,
  network: chain.caip2,
  chainId: chain.id,
  passphrase: networkPassphrase(chain),
  wasm: { sha256: wasmHash, ...(wasm ? { bytes: wasm.length } : {}) },
  uploadTx: upload ? txOf(upload) : null,
  createTx: txOf(deploy),
  contractId: deploy?.vault ?? null,
  ledger: deploy?.outcome === 'settled' ? (deploy.ledger ?? null) : null,
  salt: salt.toString('hex'),
  deployer: deployer || null,
  owner,
  ownerKind: isContractId(owner) ? 'smart-account' : 'account',
  operator,
  token: token.address,
  tokenSymbol: token.symbol,
  dailyCap,
  autoApproveMax: autoApprove,
  feeChargedStroops: {
    upload: upload?.outcome === 'settled' ? (upload.feeChargedStroops ?? null) : null,
    create: deploy?.outcome === 'settled' ? (deploy.feeChargedStroops ?? null) : null,
  },
  notes: [
    ...(arg('notes') ? [arg('notes')] : []),
    ...(wasm && liveBefore ? ['The code entry was already live, so no upload was made.'] : []),
    ...(chain.testnet ? ['Testnet. Nothing here is money, and testnet resets periodically, so this is a rehearsal and never a record.'] : []),
    'Amounts are token base units at 7 decimals.',
  ],
}

console.log(JSON.stringify(receipt, null, 2))
if (DRY) {
  console.log('dry run: no receipt file was written.')
  process.exit(0)
}
const out = arg('out') || resolve(RELEASES, `${chain.id}-${version}-${today}.json`)
if (existsSync(out)) fail(`${out} already exists; pass --out to write this receipt elsewhere rather than overwrite a record`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n')
console.log(`receipt written: ${out}`)
