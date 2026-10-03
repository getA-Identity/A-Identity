#!/usr/bin/env node
/**
 * Rehearse, on Stellar testnet, everything a passkey OWNER does on the /stellar page, so the
 * first time that path runs is never a person's recorded session.
 *
 * READ THIS FIRST. This script is a REHEARSAL. Its "passkey" is a SOFTWARE P-256 key that
 * Node generates in memory, not a credential on any device, so nothing it produces is device
 * evidence and none of its runs may be presented as one. That includes the 2026-09-19
 * testnet artifacts it made (the registry's `passkeyVault` CBGTXWFB..., its owner
 * CC5RNXNH..., and the set_policy, set_allowed and refused pay() transactions under them)
 * and every run since, each recorded with deliverable 'rehearsal'. Device evidence is
 * produced by a person on https://a-identity.xyz/stellar?network=testnet with a real
 * platform or roaming authenticator, and recorded as such.
 *
 * The claim this script exists to check, because it is the one nobody should take on our
 * word: an OpenZeppelin smart account whose only signer is a WebAuthn credential can be the
 * OWNER of our AgentSpendPolicy vault. The vault's owner entrypoints call
 * `owner.require_auth()`, the owner here is a CONTRACT rather than a key, and the
 * authorization is satisfied because the smart account is the direct invoker of the vault
 * through its own `execute`. That is the whole mechanism, and it is either true on the
 * ledger or it is not.
 *
 * What it runs, in the order the page offers it:
 *   1. a smart account with one WebAuthn signer; its code and its rules read back
 *   2. a vault whose OWNER is that account; its code and owner() read back
 *   3. set_policy (allowlist on) and set_allowed(payee), signed by the passkey
 *   4. the agent pays the allowed payee, and is refused PayeeNotAllowed for an unlisted one
 *   5. set_frozen(true), the agent refused with Frozen, then set_frozen(false)
 *   6. withdraw to a G... account, whose USDC trustline is checked first
 *   7. a SECOND passkey, added as its own context rule (never rule 0) and approved by the
 *      first, the way src/lib/stellar/passkey.ts addDevice does it
 *   8. signed in with the second passkey alone, withdraw the rest: either device can act
 * Every owner-side transaction is then read back off the ledger and decoded, and has to show
 * a webauthn-secp256r1 signer under the registry's verifier, bound to the rule it signed for.
 *
 * Two routes:
 *   default          direct: the kit submits over RPC with our key as source and fee payer,
 *                    and this script deploys, seeds and pays itself. The contract path.
 *   --backend <url>  the PAGE's route. The kit is configured the way src/lib/stellar/passkey.ts
 *                    configures it (the kit's shared sign-only deployer, relayerUrl
 *                    <url>/api/stellar/passkey/relay?network=...), the vault comes from
 *                    POST <url>/api/stellar/passkey/vault/deploy and the agent pays through
 *                    POST <url>/api/stellar/passkey/agent-pay. No key of ours is read here:
 *                    the backend holds its own. Point it at a local backend booted with the
 *                    testnet keys, or at the hosted one once they are set there.
 *
 * What stands in for the platform authenticator is a SOFTWARE P-256 authenticator, shaped
 * like @simplewebauthn/browser (the public key comes back as SPKI, as getPublicKey() returns
 * it) and driving the same verifier contract with the same signature format. It proves the
 * contract path and, with --backend, the relay and deploy route, not the hardware path: a
 * real passkey adds a secure element and a user gesture, neither of which a contract can tell
 * apart from this.
 *
 * Run it:
 *
 *   cd mcp && npm run build
 *   node --env-file=.env scripts/stellar-passkey-proof.mjs
 *   node scripts/stellar-passkey-proof.mjs --key-name asp-operator --payee G...
 *   node scripts/stellar-passkey-proof.mjs --backend http://localhost:3399 \
 *     --receipt ../soroban/releases/testnet-passkey-rehearsal-v072-<UTC date>.json
 *
 * Prepared-or-executed, like every other write in this repo: with no key (direct) or no
 * configured backend (--backend) it prints what it would do and submits nothing. Testnet
 * only, by a check below (`chain.testnet`): a software key rehearsing on real money proves
 * nothing a testnet run does not.
 *
 * Nothing here prints, stores or commits credential material. The WebAuthn credential ids
 * and their assertions stay in memory for the run and are never written anywhere; what this
 * script reports is contract ids and transaction hashes, which is what a reader can check.
 * The receipt names the second rule's id, never a credential id.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Keypair } from '@stellar/stellar-sdk'
import * as sak from 'smart-account-kit'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const fail = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

// ── the constants all come from the registry, never from this file ───────────────
let getChainById, createStellarAdapter, stellarRpcUrl, networkPassphrase, errorName, createSmartAccountReader, fetchTxEvidence
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ createStellarAdapter, errorName } = await import('../dist/chains/stellar/adapter.js'))
  ;({ stellarRpcUrl, networkPassphrase } = await import('../dist/chains/stellar/client.js'))
  ;({ createSmartAccountReader } = await import('../dist/chains/stellar/smart-account.js'))
  ;({ fetchTxEvidence } = await import('../dist/chains/stellar/tx-evidence.js'))
} catch {
  fail('mcp/dist is not built. Run: cd mcp && npm run build')
}

const chain = getChainById(arg('chain', 'stellar-testnet'))
if (!chain || chain.ecosystem !== 'stellar') fail('--chain must name a Stellar chain in the registry')
if (!chain.testnet) {
  fail(
    'this proof is TESTNET ONLY. It signs with a software P-256 key, which proves nothing on real ' +
      'money that a testnet run does not, and a passkey account holding real money is not something to create from a script.',
  )
}
const sa = chain.contracts.smartAccount
if (!sa) fail(`${chain.id} declares no contracts.smartAccount, so no passkey account can be deployed on it`)
if (!chain.contracts.spendVaultWasmHash) fail(`${chain.id} declares no contracts.spendVaultWasmHash to instantiate a vault against`)
const token = (chain.settlementTokens ?? [])[0]
if (!token) fail(`${chain.id} declares no settlement token, so there is nothing a vault could hold`)

const RPC = stellarRpcUrl(chain, process.env)
const PASSPHRASE = networkPassphrase(chain)
const explorerTx = (h) => `${chain.explorer}/tx/${h}`
const explorerContract = (c) => `${chain.explorer}/contract/${c}`
const reader = createSmartAccountReader(chain)
const adapter = createStellarAdapter(chain)

const backend = arg('backend', '').replace(/\/+$/, '')
const via = backend ? 'backend' : 'rpc'
const receiptPath = arg('receipt', '')
if (receiptPath && existsSync(resolve(receiptPath))) fail(`${receiptPath} exists; a receipt is never overwritten. Pass another --receipt path.`)
if (backend && !/^https?:\/\/[^\s/]+/.test(backend)) fail('--backend must be a base URL, for example http://localhost:3399')

const human = (raw) => Number(raw) / 10 ** token.decimals
const units = (usd) => BigInt(Math.round(usd * 10 ** token.decimals))

console.log(`Chain:   ${chain.name} (${chain.caip2})`)
console.log(`RPC:     ${RPC}`)
console.log(`Route:   ${backend ? `the page's route, through ${backend}` : 'direct RPC, with our key as source and fee payer'}`)
console.log(`Account: OpenZeppelin smart account wasm ${sa.wasmHash}`)
console.log(`         WebAuthn verifier ${sa.webauthnVerifier}`)
console.log(`Vault:   AgentSpendPolicy wasm ${chain.contracts.spendVaultWasmHash}`)
console.log(`Token:   ${token.symbol} ${token.address}`)

// ── who signs what ───────────────────────────────────────────────────────────────
//
// Direct: our key is the vault operator, the seeder and the fee payer, from the env first and
// then the local CLI keystore. Backend: the backend's own operator, read from its status;
// this process holds no key at all.
const keyEnv = arg('key-env', chain.signerEnvVar)
const keyName = arg('key-name', '')
function seedFromKeystore(name) {
  try {
    return execFileSync('stellar', ['keys', 'show', name], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^S[A-Z2-7]{55}$/.test(l))
  } catch {
    return undefined
  }
}

async function getJson(path) {
  const res = await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(90_000) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
async function postJson(path, payload) {
  const res = await fetch(`${backend}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

let secret
let env = {}
let operatorAddress
let amounts
if (backend) {
  // The page reads the same endpoint before it loads the kit (readSmartAccountConfig), and
  // refuses rather than guesses when it does not name the contracts. So does this.
  const { status, body } = await getJson(`/api/stellar/passkey/status?network=${encodeURIComponent(chain.caip2)}`).catch((e) =>
    fail(`${backend} could not be reached (${e.cause?.message ?? e.message}); nothing was submitted. Is it running?`),
  )
  if (status !== 200 || !body) fail(`${backend} answered ${status} for the passkey status; is it running?`)
  const served = body.smartAccount ?? {}
  if (served.wasmHash !== sa.wasmHash || served.webauthnVerifier !== sa.webauthnVerifier || served.ed25519Verifier !== sa.ed25519Verifier) {
    fail(
      `${backend} serves smart account ${served.wasmHash ?? '(none)'} / verifier ${served.webauthnVerifier ?? '(none)'}, and this ` +
        `build's registry records ${sa.wasmHash} / ${sa.webauthnVerifier}. Rehearse against the deployment you mean to test.`,
    )
  }
  const ready = body.readiness ?? {}
  if (!ready.relay || !ready.operator) {
    console.log(
      `\n${backend} is not ready, so nothing was submitted: ${ready.note ?? 'readiness unknown'}\n` +
        'With both keys set there, this would run the page\'s whole owner flow through its relay and deploy route.',
    )
    process.exit(0)
  }
  operatorAddress = body.operator?.account ?? body.operator?.address
  if (!/^G[A-Z2-7]{55}$/.test(operatorAddress ?? '')) fail(`${backend} reports no operator account`)
  // The page's own defaults (defaultsFor in src/lib/stellar/passkey-api.ts), derived from the
  // caps the backend publishes rather than written down here.
  const c = body.caps ?? {}
  const seedUsd = Math.min(c.seedUsdDefault, c.seedUsdMax)
  const payUsd = Math.floor(Math.min(c.agentPayMaxUsd, c.perPaymentMaxUsd, seedUsd / 2) * 1e7) / 1e7
  if (![c.dailyCapMaxUsd, c.perPaymentMaxUsd, seedUsd, payUsd].every((n) => Number.isFinite(n) && n > 0)) fail(`${backend} published caps this script cannot read`)
  amounts = { dailyCapUsd: c.dailyCapMaxUsd, autoApproveUsd: c.perPaymentMaxUsd, seedUsd, payUsd, withdrawUsd: Math.floor((seedUsd - payUsd) / 2 * 1e7) / 1e7 }
} else {
  secret = (keyEnv ? process.env[keyEnv]?.trim() : undefined) || (keyName ? seedFromKeystore(keyName) : undefined)
  // Dust on purpose, in the token's own units: this is a proof, not a demo of how much money we can move.
  amounts = { dailyCapUsd: 0.5, autoApproveUsd: 0.1, seedUsd: 0.05, payUsd: 0.01, withdrawUsd: 0.02 }
  if (!secret) {
    console.log(
      '\nNo signing key, so nothing was submitted. This is exactly what it would do:\n' +
        '  1. deploy an OpenZeppelin smart account whose only signer is a WebAuthn credential\n' +
        `  2. deploy AgentSpendPolicy with owner = that account, operator = the account ${keyEnv} decodes to,\n` +
        `     token ${token.symbol}, daily cap ${amounts.dailyCapUsd}, ceiling ${amounts.autoApproveUsd}\n` +
        '  3. set_policy and set_allowed on that vault, SIGNED BY THE PASSKEY through the account\n' +
        `  4. seed the vault with ${amounts.seedUsd} ${token.symbol}, pay the allowed payee, be refused for an unlisted one\n` +
        '  5. set_frozen(true), be refused with Frozen, set_frozen(false)\n' +
        `  6. withdraw ${amounts.withdrawUsd} ${token.symbol} to a G account whose trustline is checked first\n` +
        '  7. add a second passkey as its own context rule, approved by the first\n' +
        '  8. sign in with the second passkey alone and withdraw the rest\n\n' +
        `Set ${keyEnv}, pass --key-name with a funded testnet key from the stellar CLI keystore, or pass --backend <url>.`,
    )
    process.exit(0)
  }
  if (!/^S[A-Z2-7]{55}$/.test(secret)) fail(`${keyEnv || keyName} is not a Stellar secret seed (S followed by 55 base32 characters)`)
  operatorAddress = Keypair.fromSecret(secret).publicKey()
  // The env the adapter reads its signer from. Scoped to this process and to this one
  // variable, so nothing else in the environment can decide who signs.
  env = { [chain.signerEnvVar]: secret }
}

/** A payee the vault is allowed to pay. Default: the operator, which already holds the
 *  token's trustline, so the proof needs no second funded account and the seed comes home. */
const payee = arg('payee', operatorAddress)
if (!/^[GC][A-Z2-7]{55}$/.test(payee)) fail('--payee must be a Stellar account (G...) or contract (C...)')
/** Where both withdrawals go. Default: the operator again, for the same two reasons. */
const withdrawTo = arg('withdraw-to', operatorAddress)
if (!/^G[A-Z2-7]{55}$/.test(withdrawTo)) fail('--withdraw-to must be a Stellar account (G...): this step rehearses a withdraw to a G account')
/** A payee nobody allowed. Generated per run: the allowlist is checked before the transfer,
 *  so this account needs no trustline and no funding to prove the refusal. */
const unlisted = Keypair.random().publicKey()

console.log(`Operator: ${operatorAddress} (${backend ? 'the backend\'s own key' : `from ${keyEnv || `keystore ${keyName}`}`})`)
console.log(`Payee:    ${payee}`)
console.log(`Withdraw: to ${withdrawTo}`)

// ── a software P-256 authenticator, shaped like @simplewebauthn/browser ──────────
//
// Only the shape matters to the verifier contract: an authenticatorData blob, the client
// data JSON the browser would build, and a low-S DER signature over their concatenation.
// None of it is persisted and none of it is printed.
const RP_ID = arg('rp-id', 'a-identity.xyz')
const ORIGIN = arg('origin', `https://${RP_ID}`)
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const sha256 = (b) => createHash('sha256').update(b).digest()
const CURVE_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')

function derToRS(der) {
  let o = 2
  if (der[o++] !== 2) throw new Error('malformed DER signature')
  const rl = der[o++]
  const r = der.subarray(o, o + rl)
  o += rl
  if (der[o++] !== 2) throw new Error('malformed DER signature')
  const sl = der[o++]
  return { r: BigInt(`0x${Buffer.from(r).toString('hex')}`), s: BigInt(`0x${Buffer.from(der.subarray(o, o + sl)).toString('hex')}`) }
}
function derInt(x) {
  let hex = x.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  let b = Buffer.from(hex, 'hex')
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return Buffer.concat([Buffer.from([2, b.length]), b])
}
/** WebAuthn verifiers reject a high-S signature, so it is normalized the way a real
 *  authenticator does rather than left for the contract to refuse. */
function lowS(der) {
  const { r, s } = derToRS(der)
  const body = Buffer.concat([derInt(r), derInt(s > CURVE_ORDER / 2n ? CURVE_ORDER - s : s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

class SoftwareAuthenticator {
  #keys = new Map()
  #counter = 0
  #chosen = null
  /** The credential the OS picker would hand back when the page asks without naming one. */
  choose(id) {
    this.#chosen = id
  }
  /** Every registration is a fresh key, as a second DEVICE would make: excludeCredentials
   *  only stops an authenticator that already holds one of the listed credentials. */
  async startRegistration({ optionsJSON }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const id = b64u(randomBytes(32))
    this.#keys.set(id, privateKey)
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: optionsJSON.challenge, origin: ORIGIN, crossOrigin: false })
    return {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(Buffer.alloc(0)),
        // SPKI DER, which is what @simplewebauthn/browser's getPublicKey() hands back and
        // what the page's addDevice parses, so this exercises the same path a browser does.
        publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
        publicKeyAlgorithm: -7,
        transports: ['internal'],
      },
    }
  }
  async startAuthentication({ optionsJSON }) {
    const named = optionsJSON.allowCredentials?.map((c) => c.id) ?? []
    const id = named.length ? named.find((i) => this.#keys.has(i)) : (this.#chosen ?? [...this.#keys.keys()][0])
    if (!id || !this.#keys.has(id)) throw new Error('no such credential on this authenticator')
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: optionsJSON.challenge, origin: ORIGIN, crossOrigin: false }))
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(++this.#counter)
    const authData = Buffer.concat([sha256(Buffer.from(optionsJSON.rpId ?? RP_ID)), Buffer.from([0x05]), counter])
    const der = nodeSign('sha256', Buffer.concat([authData, sha256(clientData)]), { key: this.#keys.get(id), dsaEncoding: 'der' })
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientData), signature: b64u(lowS(der)), userHandle: null },
    }
  }
}

/**
 * xdr values built by the kit's own SDK, exactly as src/lib/stellar/passkey.ts builds them
 * (scvals there): an i128 from buildI128ScVal, an address lifted out of a signer ScVal, and
 * a bool from the ScVal class those instances belong to.
 */
function scvals() {
  const i128 = (raw) => sak.buildI128ScVal(raw)
  const ScVal = i128(0n).constructor
  const address = (a) => {
    const signer = a.startsWith('C') ? sak.createExternalSigner(a, new Uint8Array(1)) : sak.createDelegatedSigner(a)
    return sak.signerToScVal(signer).vec()[1]
  }
  return { i128, address, bool: (b) => ScVal.scvBool(b) }
}
const v = scvals()

/** The 65-byte uncompressed point from a registration's SPKI public key, via WebCrypto, as the page's rawP256Key reads it. */
async function rawP256Key(spkiB64url) {
  if (!spkiB64url || !globalThis.crypto?.subtle) return null
  try {
    const key = await crypto.subtle.importKey('spki', Buffer.from(spkiB64url, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', key))
    return point.length === 65 && point[0] === 4 ? point : null
  } catch {
    return null
  }
}
const hex = (bytes) => Buffer.from(bytes).toString('hex')

// ── the run ──────────────────────────────────────────────────────────────────────
const steps = []
const refusals = []
const record = (step, detail) => {
  steps.push({ step, ...detail })
  const line = detail.hash ? `${detail.hash}  ${explorerTx(detail.hash)}` : (detail.note ?? '')
  console.log(`  ${step}: ${line}`)
}
const stop = (why) => {
  console.error(`\nSTOPPED: ${why}`)
  if (steps.length) {
    console.error('\nWhat had landed before the stop:')
    for (const s of steps) console.error(`  ${s.step.padEnd(28)} ${s.hash ?? s.note ?? ''}`)
  }
  process.exit(2)
}

const auth = new SoftwareAuthenticator()
const storage = new sak.MemoryStorage()
const kit = new sak.SmartAccountKit({
  rpcUrl: RPC,
  networkPassphrase: PASSPHRASE,
  accountWasmHash: sa.wasmHash,
  webauthnVerifierAddress: sa.webauthnVerifier,
  ed25519VerifierAddress: sa.ed25519Verifier,
  rpName: 'A-Identity',
  rpId: RP_ID,
  allowedOrigins: [ORIGIN],
  storage,
  webAuthn: auth,
  // The page's configuration: the kit's shared sign-only deployer, the relay with the network
  // in its query string, and the kit's default indexer. Direct: our key pays over RPC.
  ...(backend
    ? { relayerUrl: `${backend}/api/stellar/passkey/relay?network=${encodeURIComponent(chain.caip2)}` }
    : { deployerSecret: secret, indexerUrl: false }),
})
const submitOpts = backend ? undefined : { forceMethod: 'rpc' }

/** One owner call, signed by whichever passkey is signed in, as the page's ownerCall makes it. */
async function ownerCall(step, vault, fn, args, expectRule) {
  const r = await kit.executeAndSubmit(vault, fn, args, submitOpts)
  if (!r.success) stop(`${fn} through the passkey did not land: ${r.error?.message ?? r.error ?? 'no result'}${r.hash ? ` (hash ${r.hash})` : ''}`)
  record(step, { hash: r.hash, ledger: r.ledger, ownerSide: true, expectRule })
  return r
}

/** Agent pay(), on the route this run uses. Returns the settled hash, or the refusal's name. */
async function agentPay(vault, to, usd) {
  if (backend) {
    const { status, body } = await postJson('/api/stellar/passkey/agent-pay', { network: chain.caip2, contract: vault, to, amountUsd: usd })
    if (body?.outcome === 'settled' && body.txHash) return { settled: true, hash: body.txHash, ledger: body.ledger }
    if (body?.outcome === 'refused') return { settled: false, name: body.contractErrorName ?? `#${body.contractErrorCode}`, code: body.contractErrorCode }
    return { settled: false, other: `${status} ${body?.outcome ?? ''} ${body?.code ?? ''}: ${body?.reason ?? body?.note ?? JSON.stringify(body)}` }
  }
  const paid = await adapter.policyPay(vault, to, units(usd), env)
  if (paid.outcome === 'settled') return { settled: true, hash: paid.txHash, ledger: paid.ledger }
  if (paid.outcome === 'refused') return { settled: false, name: paid.contractErrorIsOurs ? errorName(paid.contractErrorCode) : `#${paid.contractErrorCode}`, code: paid.contractErrorCode }
  return { settled: false, other: `${paid.outcome}: ${paid.reason ?? ''}` }
}

const startedAt = new Date().toISOString()

console.log('\n1. a passkey, and the OpenZeppelin smart account it controls')
const created = await kit.createWallet('A-Identity', `A-Identity ${chain.name}`, backend ? { autoSubmit: true } : { autoSubmit: true, forceMethod: 'rpc' })
if (!created.submitResult?.success) stop(`the smart account did not deploy: ${created.submitResult?.error?.message ?? created.submitResult?.error ?? 'no result'}`)
const smartAccount = created.contractId
const firstCredential = created.credentialId
const firstPublicKeyHex = hex(created.publicKey)
record('smart account deploy', { hash: created.submitResult.hash, ledger: created.submitResult.ledger, contract: smartAccount })
console.log(`         ${smartAccount}  ${explorerContract(smartAccount)}`)
const accountCode = await reader.readCode(smartAccount)
if (accountCode.wasmHash !== sa.wasmHash.toLowerCase()) stop(`the account runs ${accountCode.wasmHash ?? accountCode.executable}, not the registry's ${sa.wasmHash}`)
const rulesAtBirth = await reader.readRules(smartAccount)
const only = rulesAtBirth.rules.length === 1 && rulesAtBirth.rules[0].signers.length === 1 ? rulesAtBirth.rules[0].signers[0] : null
if (!only || only.kind !== 'external' || only.verifier !== sa.webauthnVerifier || !only.keyHex.startsWith(firstPublicKeyHex)) {
  stop(`the new account does not hold exactly one WebAuthn signer under ${sa.webauthnVerifier}: ${JSON.stringify(rulesAtBirth.rules)}`)
}
console.log(`         code ${accountCode.wasmHash} (read at ledger ${accountCode.ledger}); one rule, one WebAuthn signer under ${only.verifier}`)

console.log('\n2. the vault, OWNER = that smart account')
let vault
let deployHash
let seedHash
if (backend) {
  const { status, body } = await postJson('/api/stellar/passkey/vault/deploy', {
    network: chain.caip2,
    owner: smartAccount,
    ownerPublicKey: firstPublicKeyHex,
    dailyCapUsd: amounts.dailyCapUsd,
    autoApproveUsd: amounts.autoApproveUsd,
    seedUsd: amounts.seedUsd,
  })
  if (status !== 200 || body?.outcome !== 'settled') stop(`the deploy route answered ${status} ${body?.outcome ?? ''} ${body?.code ?? ''}: ${body?.reason ?? JSON.stringify(body)}`)
  vault = body.vault
  deployHash = body.deploy?.txHash
  record('vault deploy', { hash: deployHash, ledger: body.deploy?.ledger, contract: vault })
  if (body.seed?.outcome !== 'settled' || !body.seed.txHash) stop(`the vault deployed but its seed did not move: ${body.seed?.outcome} ${body.seed?.reason ?? ''}`)
  seedHash = body.seed.txHash
  record('seed (by the deploy route)', { hash: seedHash, ledger: body.seed.ledger })
  if (body.ownerReadBack?.matches !== true) stop(`the deploy route read owner() back as ${body.ownerReadBack?.owner ?? '(unread)'}`)
} else {
  const deployed = await adapter.deployVault(
    { owner: smartAccount, operator: operatorAddress, token: token.address, dailyCapRaw: units(amounts.dailyCapUsd), autoApproveMaxRaw: units(amounts.autoApproveUsd) },
    env,
  )
  if (deployed.outcome !== 'settled') stop(`the vault did not deploy (${deployed.outcome}): ${deployed.reason ?? ''}`)
  vault = deployed.vault
  deployHash = deployed.txHash
  record('vault deploy', { hash: deployHash, ledger: deployed.ledger, contract: vault })
}
console.log(`         ${vault}  ${explorerContract(vault)}`)
const vaultCode = await reader.readCode(vault)
if (vaultCode.wasmHash !== chain.contracts.spendVaultWasmHash.toLowerCase()) stop(`the vault runs ${vaultCode.wasmHash}, not the registry's ${chain.contracts.spendVaultWasmHash}`)
const before = await adapter.readVault(vault, env)
if (before.owner !== smartAccount) stop('the vault does not report the smart account as its owner')
console.log(`         code ${vaultCode.wasmHash}; owner() ${before.owner}; operator() ${before.operator}`)

console.log('\n3. set_policy and set_allowed, SIGNED BY THE PASSKEY through the smart account')
await ownerCall('set_policy by passkey', vault, 'set_policy', [v.i128(units(amounts.dailyCapUsd)), v.i128(units(amounts.autoApproveUsd)), v.bool(true)], 0)
await ownerCall('set_allowed by passkey', vault, 'set_allowed', [v.address(payee), v.bool(true)], 0)
const armed = await adapter.readVault(vault, env)
if (!armed.allowlistEnabled) stop('allowlist_enabled() did not read true after set_policy')

console.log('\n4. the agent pays the allowed payee, and is refused for an unlisted one')
if (!backend) {
  const seeded = await adapter.sacTransferFromSigner(token.address, vault, units(amounts.seedUsd), env)
  if (seeded.outcome !== 'settled') stop(`the seed transfer ended ${seeded.outcome}: ${seeded.reason ?? ''}. The operator needs ${token.symbol} and a trustline for it.`)
  seedHash = seeded.txHash
  record('seed', { hash: seedHash, ledger: seeded.ledger })
}
const paid = await agentPay(vault, payee, amounts.payUsd)
if (!paid.settled) stop(`the allowed payment did not settle: ${paid.name ?? paid.other}`)
record('agent pays the allowed payee', { hash: paid.hash, ledger: paid.ledger })
const refusedPayee = await agentPay(vault, unlisted, amounts.payUsd)
if (refusedPayee.settled || refusedPayee.name !== 'PayeeNotAllowed') stop(`an unlisted payee was not refused with PayeeNotAllowed: ${refusedPayee.hash ?? refusedPayee.name ?? refusedPayee.other}`)
refusals.push({ step: 'agent pays an unlisted payee', refusedWith: 'PayeeNotAllowed', code: refusedPayee.code ?? 3, note: 'refused in simulation, so no transaction exists' })
console.log(`  agent pays an unlisted payee: refused with PayeeNotAllowed in simulation, so no transaction exists`)

console.log('\n5. freeze, the agent stops, unfreeze')
await ownerCall('set_frozen(true) by passkey', vault, 'set_frozen', [v.bool(true)], 0)
if (!(await adapter.readVault(vault, env)).frozen) stop('frozen() did not read true after set_frozen(true)')
const refusedFrozen = await agentPay(vault, payee, amounts.payUsd)
if (refusedFrozen.settled || refusedFrozen.name !== 'Frozen') stop(`a payment from the frozen vault was not refused with Frozen: ${refusedFrozen.hash ?? refusedFrozen.name ?? refusedFrozen.other}`)
refusals.push({ step: 'agent pays while frozen', refusedWith: 'Frozen', code: refusedFrozen.code ?? 1, note: 'refused in simulation, so no transaction exists' })
console.log(`  agent pays while frozen: refused with Frozen in simulation, so no transaction exists`)
await ownerCall('set_frozen(false) by passkey', vault, 'set_frozen', [v.bool(false)], 0)
if ((await adapter.readVault(vault, env)).frozen) stop('frozen() did not read false after set_frozen(false)')

console.log(`\n6. withdraw ${amounts.withdrawUsd} ${token.symbol} to ${withdrawTo}, its trustline checked first`)
const trustline = await (async () => {
  const [code, issuer] = (token.classicAsset ?? ':').split(':')
  const horizon = chain.horizonUrls?.[0]
  if (!horizon || !code || !issuer) return 'unchecked: the registry names no classic asset or Horizon for this token'
  const res = await fetch(`${horizon}/accounts/${withdrawTo}`, { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) stop(`${withdrawTo} does not exist on ${chain.name}, so it cannot hold ${code}; nothing was signed`)
  const acct = await res.json()
  const line = (acct.balances ?? []).find((b) => b.asset_code === code && b.asset_issuer === issuer)
  if (!line) stop(`${withdrawTo} has no ${code} trustline (issuer ${issuer}), so the withdraw would be refused by the token; nothing was signed`)
  if (line.is_authorized === false) stop(`${withdrawTo}'s ${code} trustline is not authorized; nothing was signed`)
  return `checked on Horizon: ${code}:${issuer} present and authorized`
})()
console.log(`         ${trustline}`)
const balBefore = await adapter.readTokenBalance(token.address, withdrawTo, env)
await ownerCall('withdraw by passkey', vault, 'withdraw', [v.address(withdrawTo), v.i128(units(amounts.withdrawUsd))], 0)
const balAfter = await adapter.readTokenBalance(token.address, withdrawTo, env)
if (balAfter - balBefore !== units(amounts.withdrawUsd)) stop(`${withdrawTo} moved by ${balAfter - balBefore}, not ${units(amounts.withdrawUsd)}`)
console.log(`         ${withdrawTo} went from ${human(balBefore)} to ${human(balAfter)} ${token.symbol}`)

console.log('\n7. a second device, added as its OWN context rule and approved by the first passkey')
// Step for step what src/lib/stellar/passkey.ts addDevice does: the rule id is the count now,
// the new passkey comes from the same WebAuthn wrapper with the first one excluded, the
// signer is built with createWebAuthnSigner, the rule with rules.add (Default context, this
// one signer, no policy), and the first passkey signs it through signAndSubmitAdmin.
const primary = (await storage.getByContract(smartAccount)).find(
  (c) => c.deploymentStatus === 'deployed' && c.birthWasmHash && c.creationTransactionHash && c.creationLedger !== undefined && c.birthConstructorArgsHash,
)
if (!primary) stop('the kit kept no verified record of the account, which addDevice needs')
const ruleId = Number(await kit.rules.count())
if (ruleId === 0) stop('the rule count read 0 on an account that has rule 0')
const second = await auth.startRegistration({
  optionsJSON: {
    challenge: sak.generateChallenge(),
    rp: { id: RP_ID, name: 'A-Identity' },
    user: { id: b64u(randomBytes(16)), name: 'A-Identity', displayName: 'A-Identity' },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: [{ id: primary.credentialId, type: 'public-key' }],
    timeout: 120_000,
  },
})
const secondKey = await rawP256Key(second.response.publicKey)
if (!secondKey) stop('the second registration did not yield a P-256 point the way the page reads it')
const signer = sak.createWebAuthnSigner(sa.webauthnVerifier, secondKey, second.id)
const addTx = await kit.rules.add(sak.createDefaultContext(), 'second device', [signer], new Map())
const added = await kit.signAndSubmitAdmin(addTx, submitOpts)
if (!added.success) stop(`add_context_rule did not land: ${added.error?.message ?? added.error ?? 'no result'}`)
record('add_context_rule (second device)', { hash: added.hash, ledger: added.ledger, ownerSide: true, expectRule: 0 })
await storage.save({
  credentialId: second.id,
  publicKey: secondKey,
  contractId: smartAccount,
  nickname: 'second device',
  createdAt: Date.now(),
  transports: second.response.transports,
  isPrimary: false,
  contextRuleId: ruleId,
  deploymentStatus: 'deployed',
  associationVerified: true,
  birthWasmHash: primary.birthWasmHash,
  creationTransactionHash: primary.creationTransactionHash,
  creationLedger: primary.creationLedger,
  birthConstructorArgsHash: primary.birthConstructorArgsHash,
})
const rulesAfter = await reader.readRules(smartAccount)
const rule0 = rulesAfter.rules.find((r) => r.id === 0)
const ruleN = rulesAfter.rules.find((r) => r.id === ruleId)
const passkeyOf = (r, keyHex) => r && r.signers.length === 1 && r.signers[0].kind === 'external' && r.signers[0].verifier === sa.webauthnVerifier && r.signers[0].keyHex.startsWith(keyHex)
if (!passkeyOf(rule0, firstPublicKeyHex)) stop(`rule 0 no longer holds exactly the first passkey: ${JSON.stringify(rule0)}`)
if (!passkeyOf(ruleN, hex(secondKey))) stop(`rule ${ruleId} does not hold exactly the second passkey: ${JSON.stringify(ruleN)}`)
if (ruleN.contextType !== 'default' || ruleN.policies.length !== 0) stop(`rule ${ruleId} is not a Default rule without a policy: ${JSON.stringify(ruleN)}`)
console.log(`         rule 0: the first passkey alone; rule ${ruleId} (Default, no policy): the second passkey alone`)

console.log('\n8. signed in with the second passkey ALONE, the rest of the balance withdrawn')
// The page's sign-out and sign-in: disconnect, then connectWallet({ prompt: true }) with no
// stored session, which asks the authenticator without naming a credential. The person
// picks the second device in the OS prompt; here the authenticator is told which to hand back.
await kit.disconnect()
auth.choose(second.id)
const reconnected = await kit.connectWallet({ prompt: true })
if (!reconnected || kit.credentialId !== second.id || kit.contractId !== smartAccount) stop('signing in with the second passkey did not connect it to the same account')
const rest = BigInt((await adapter.readVault(vault, env)).balanceRaw)
if (rest <= 0n) stop('the vault is empty before the second device could withdraw; the amounts above are wrong')
const restBefore = await adapter.readTokenBalance(token.address, withdrawTo, env)
await ownerCall('withdraw by the second passkey', vault, 'withdraw', [v.address(withdrawTo), v.i128(rest)], ruleId)
const restAfter = await adapter.readTokenBalance(token.address, withdrawTo, env)
if (restAfter - restBefore !== rest) stop(`${withdrawTo} moved by ${restAfter - restBefore}, not ${rest}`)
const after = await adapter.readVault(vault, env)
console.log(`         the vault holds ${human(after.balanceRaw)} ${token.symbol}; ${withdrawTo} received ${human(rest)}`)
if (kit.credentialId === firstCredential) stop('the kit signed with the first passkey after all')

console.log('\n9. every transaction read back off the ledger')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (const s of steps.filter((x) => x.hash)) {
  let fee = null
  for (let i = 0; i < 6 && !fee?.found; i += 1) {
    fee = await reader.readFeePayer(s.hash).catch(() => null)
    if (!fee?.found) await wait(2_500)
  }
  if (!fee?.found) stop(`${s.step} ${s.hash} could not be read back`)
  if (fee.status !== 'SUCCESS') stop(`${s.step} ${s.hash} reads ${fee.status} on the ledger`)
  Object.assign(s, { status: fee.status, ledger: fee.ledger ?? s.ledger, sourceAccount: fee.sourceAccount, feeAccount: fee.feeAccount, feeBump: fee.feeBump, feeChargedStroops: fee.feeChargedStroops })
  if (s.ownerSide) {
    const ev = await fetchTxEvidence(chain, s.hash)
    if (!ev.ok) stop(`${s.step} ${s.hash} could not be decoded: ${ev.reason}`)
    const mine = ev.evidence.auth.filter((a) => a.address === smartAccount)
    const pk = mine.flatMap((a) => a.signers).filter((x) => x.kind === 'webauthn-secp256r1')
    const bound = mine.flatMap((a) => a.contextRuleIds ?? [])
    if (!pk.length || pk.some((x) => x.verifier !== sa.webauthnVerifier)) stop(`${s.step} is not authorized by a webauthn-secp256r1 signer under ${sa.webauthnVerifier}`)
    if (!bound.length || bound.some((id) => id !== s.expectRule)) stop(`${s.step} was bound to rule(s) ${bound.join(', ') || '(none)'}, not rule ${s.expectRule}`)
    if (pk.some((x) => x.webauthn?.challengeBinding !== 'auth-digest' || x.webauthn?.signatureVerifies !== true)) stop(`${s.step}: a passkey signature does not bind to the auth digest or does not re-verify`)
    s.authorization = {
      credential: mine[0].credential,
      address: smartAccount,
      signerKind: 'webauthn-secp256r1',
      verifier: sa.webauthnVerifier,
      contextRuleIds: bound,
      flags: pk[0].webauthn?.authenticatorData?.flags ?? null,
      origin: pk[0].webauthn?.clientDataJSON?.origin ?? null,
      challengeBinding: pk[0].webauthn?.challengeBinding ?? null,
      signatureVerifies: pk[0].webauthn?.signatureVerifies ?? null,
    }
  }
  console.log(`  ${s.step.padEnd(34)} ${s.status} ledger ${s.ledger} fee ${s.feeAccount}${s.feeBump ? ' (fee bump)' : ''}${s.authorization ? `  rule ${s.authorization.contextRuleIds.join(',')}` : ''}`)
}

console.log('\nProved, on chain (a rehearsal: the passkeys were software keys in this process):')
console.log(`  a WebAuthn credential owns ${vault} through the smart account ${smartAccount}`)
console.log(`  it set the policy and the allowlist, froze and unfroze the vault, and withdrew to ${withdrawTo}`)
console.log(`  the agent paid the allowed payee and was refused PayeeNotAllowed and Frozen`)
console.log(`  a second passkey on its own rule ${ruleId}, added by the first, withdrew the rest on its own`)

if (receiptPath) {
  const date = new Date().toISOString().slice(0, 10)
  const receipt = {
    note:
      'A REHEARSAL of the SoW 2 D3 owner path on our own OpenZeppelin v0.7.2 build, with SOFTWARE P-256 keys generated in mcp/scripts/stellar-passkey-proof.mjs standing in for device passkeys. ' +
      'Nothing here is D3 evidence: the chain verifies a P-256 signature and cannot tell a device authenticator from a key in our process. It exists so the recorded device session is not the first time this path runs.',
    record: receiptPath.replace(/^.*\//, '').replace(/\.json$/, ''),
    deliverable: 'rehearsal',
    network: chain.caip2,
    networkPassphrase: PASSPHRASE,
    ranAt: { start: startedAt, end: new Date().toISOString(), date },
    route: backend
      ? {
          kind: 'backend',
          base: backend,
          note: 'The page\'s route: smart-account-kit configured as src/lib/stellar/passkey.ts configures it (the kit\'s shared sign-only deployer, relayerUrl <base>/api/stellar/passkey/relay?network=...), the vault deployed and seeded by POST <base>/api/stellar/passkey/vault/deploy, and the agent paying through POST <base>/api/stellar/passkey/agent-pay.',
        }
      : { kind: 'direct-rpc', note: 'The kit submitted over RPC with our operator key as source and fee payer; this script deployed, seeded and paid itself.' },
    kit: { package: 'smart-account-kit', version: '0.8.0', thirdParty: true },
    smartAccount: {
      contractId: smartAccount,
      deployTx: created.submitResult.hash,
      wasmHash: accountCode.wasmHash,
      wasmHashReadAtLedger: accountCode.ledger,
      webauthnVerifier: sa.webauthnVerifier,
      rulesAfterRun: rulesAfter.rules.map((r) => ({ id: r.id, contextType: r.contextType, policies: r.policies.length, signers: r.signers.map((x) => ({ kind: x.kind, verifier: x.verifier ?? null })) })),
      note: 'Rule 0 holds the first passkey alone; the second rule holds the second passkey alone, Default context, no policy, so either can authorize on its own. Public keys and credential ids are deliberately not recorded.',
    },
    vault: {
      contractId: vault,
      deployTx: deployHash,
      wasmHash: vaultCode.wasmHash,
      owner: smartAccount,
      operator: before.operator,
      token: token.address,
      dailyCapUsd: amounts.dailyCapUsd,
      autoApproveUsd: amounts.autoApproveUsd,
      seedUsd: amounts.seedUsd,
    },
    payee,
    withdrawTo,
    withdrawTrustline: trustline,
    secondDeviceRuleId: ruleId,
    artifacts: steps.map((s) => ({
      step: s.step,
      txHash: s.hash,
      ledger: s.ledger,
      status: s.status,
      sourceAccount: s.sourceAccount,
      feeAccount: s.feeAccount,
      feeBump: s.feeBump,
      feeChargedStroops: s.feeChargedStroops,
      ...(s.authorization ? { authorization: s.authorization } : {}),
    })),
    refusals,
    finalState: { balance: human(after.balanceRaw), frozen: after.frozen, allowlistEnabled: after.allowlistEnabled, readAtLedger: after.ledger },
    caveats: [
      'Software keys, not devices. The flags 0x05 (UP, UV) and the origin https://a-identity.xyz in every assertion were produced by this script; a device authenticator reports its own.',
      'Testnet. A reset (next scheduled 2026-12-16) deletes every id above; the archived envelopes in soroban/releases/tx-archive/stellar-testnet/ are what survive it.',
    ],
  }
  writeFileSync(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`\nReceipt: ${receiptPath}`)
}
console.log('\nTestnet: a reset takes all of this with it, so these ids are a rehearsal, never a record.')
