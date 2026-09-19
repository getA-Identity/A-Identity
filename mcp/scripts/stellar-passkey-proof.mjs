#!/usr/bin/env node
/**
 * Prove that a PASSKEY can own an on-chain spend policy, end to end, on Stellar testnet.
 *
 * The claim this script exists to check, because it is the one nobody should take on our
 * word: an OpenZeppelin smart account whose only signer is a WebAuthn credential can be the
 * OWNER of our AgentSpendPolicy vault. The vault's owner entrypoints call
 * `owner.require_auth()`, the owner here is a CONTRACT rather than a key, and the
 * authorization is satisfied because the smart account is the direct invoker of the vault
 * through its own `execute`. That is the whole mechanism, and it is either true on the
 * ledger or it is not.
 *
 * What stands in for the platform authenticator is a SOFTWARE P-256 authenticator, shaped
 * like @simplewebauthn/browser and driving the same verifier contract with the same
 * signature format. It proves the contract path, not the hardware path: a real passkey adds
 * a secure element and a user gesture, neither of which a contract can tell apart from
 * this. Everything else here is the real thing, on the real network.
 *
 * Run it:
 *
 *   cd mcp && npm run build
 *   node --env-file=.env scripts/stellar-passkey-proof.mjs
 *   node scripts/stellar-passkey-proof.mjs --key-env STELLAR_TESTNET_SIGNER_SECRET
 *   node scripts/stellar-passkey-proof.mjs --key-name asp-operator --payee G...
 *
 * Prepared-or-executed, like every other write in this repo: with no key it prints what it
 * would do and submits nothing. Testnet only, by a check rather than by convention: the
 * pubnet smart-account constants are deliberately not in the registry.
 *
 * Nothing here prints, stores or commits credential material. The WebAuthn credential id and
 * its assertions stay in memory for the run and are never written anywhere; what this script
 * reports is contract ids and transaction hashes, which is what a reader can check.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk'
import { MemoryStorage, SmartAccountKit } from 'smart-account-kit'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const fail = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

// ── the constants all come from the registry, never from this file ───────────────
let getChainById, createStellarAdapter, stellarRpcUrl, networkPassphrase, errorName
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ createStellarAdapter, errorName } = await import('../dist/chains/stellar/adapter.js'))
  ;({ stellarRpcUrl, networkPassphrase } = await import('../dist/chains/stellar/client.js'))
} catch {
  fail('mcp/dist is not built. Run: cd mcp && npm run build')
}

const chain = getChainById(arg('chain', 'stellar-testnet'))
if (!chain || chain.ecosystem !== 'stellar') fail('--chain must name a Stellar chain in the registry')
if (!chain.testnet) {
  fail(
    'this proof is TESTNET ONLY. The pubnet smart-account constants are deliberately absent from the ' +
      'registry, and a passkey account holding real money is not something to create from a script.',
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

// Amounts, in the token's own base units. Dust on purpose: this is a proof, not a demo of
// how much money we can move.
const unit = (usd) => BigInt(Math.round(usd * 10 ** token.decimals))
const DAILY_CAP = unit(0.5)
const CEILING = unit(0.1)
const SEED = unit(0.05)
const PAYMENT = unit(0.01)

// ── the signing key: the env first, then the local CLI keystore ──────────────────
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
const secret = (keyEnv ? process.env[keyEnv]?.trim() : undefined) || (keyName ? seedFromKeystore(keyName) : undefined)

console.log(`Chain:   ${chain.name} (${chain.caip2})`)
console.log(`RPC:     ${RPC}`)
console.log(`Account: OpenZeppelin smart account wasm ${sa.wasmHash}`)
console.log(`         WebAuthn verifier ${sa.webauthnVerifier}`)
console.log(`Vault:   AgentSpendPolicy wasm ${chain.contracts.spendVaultWasmHash}`)
console.log(`Token:   ${token.symbol} ${token.address}`)

if (!secret) {
  console.log(
    '\nNo signing key, so nothing was submitted. This is exactly what it would do:\n' +
      '  1. deploy an OpenZeppelin smart account whose only signer is a WebAuthn credential\n' +
      `  2. deploy AgentSpendPolicy with owner = that account, operator = the account ${keyEnv} decodes to,\n` +
      `     token ${token.symbol}, daily cap ${Number(DAILY_CAP) / 10 ** token.decimals}, ceiling ${Number(CEILING) / 10 ** token.decimals}\n` +
      '  3. set_policy and set_allowed on that vault, SIGNED BY THE PASSKEY through the account\n' +
      `  4. seed the vault with ${Number(SEED) / 10 ** token.decimals} ${token.symbol} and pay the allowed payee\n` +
      '  5. pay an unlisted payee, and show the contract refuse it with PayeeNotAllowed\n\n' +
      `Set ${keyEnv}, or pass --key-name with a funded testnet key from the stellar CLI keystore.`,
  )
  process.exit(0)
}
if (!/^S[A-Z2-7]{55}$/.test(secret)) fail(`${keyEnv || keyName} is not a Stellar secret seed (S followed by 55 base32 characters)`)

const operator = Keypair.fromSecret(secret)
// The env the adapter reads its signer from. Scoped to this process and to this one
// variable, so nothing else in the environment can decide who signs.
const env = { [chain.signerEnvVar]: secret }
const adapter = createStellarAdapter(chain)

/** A payee the vault is allowed to pay. Default: the operator, which already holds the
 *  token's trustline, so the proof needs no second funded account. */
const payee = arg('payee', operator.publicKey())
if (!/^[GC][A-Z2-7]{55}$/.test(payee)) fail('--payee must be a Stellar account (G...) or contract (C...)')
/** A payee nobody allowed. Generated per run: the allowlist is checked before the transfer,
 *  so this account needs no trustline and no funding to prove the refusal. */
const unlisted = Keypair.random().publicKey()

console.log(`Operator: ${operator.publicKey()} (from ${keyEnv || `keystore ${keyName}`})`)
console.log(`Payee:    ${payee}`)

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
  async startRegistration({ optionsJSON }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
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
        publicKey: b64u(raw),
        publicKeyAlgorithm: -7,
        transports: ['internal'],
      },
    }
  }
  async startAuthentication({ optionsJSON }) {
    const allowed = optionsJSON.allowCredentials?.map((c) => c.id) ?? [...this.#keys.keys()]
    const id = allowed.find((i) => this.#keys.has(i))
    if (!id) throw new Error('no such credential on this authenticator')
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

// ── the run ──────────────────────────────────────────────────────────────────────
const steps = []
const record = (step, detail) => {
  steps.push({ step, ...detail })
  const line = detail.hash ? `${detail.hash}  ${explorerTx(detail.hash)}` : detail.note ?? ''
  console.log(`  ${step}: ${line}`)
}
const stop = (why) => {
  console.error(`\nSTOPPED: ${why}`)
  process.exit(2)
}

console.log('\n1. deploying an OpenZeppelin smart account with a P-256 passkey signer')
const kit = new SmartAccountKit({
  rpcUrl: RPC,
  networkPassphrase: PASSPHRASE,
  accountWasmHash: sa.wasmHash,
  webauthnVerifierAddress: sa.webauthnVerifier,
  ed25519VerifierAddress: sa.ed25519Verifier,
  storage: new MemoryStorage(),
  deployerSecret: secret,
  rpId: RP_ID,
  allowedOrigins: [ORIGIN],
  indexerUrl: false,
  webAuthn: new SoftwareAuthenticator(),
})
const created = await kit.createWallet('A-Identity', `passkey-proof-${Date.now()}`, { autoSubmit: true, forceMethod: 'rpc' })
if (!created.submitResult?.success) stop(`the smart account did not deploy: ${created.submitResult?.error ?? 'no result'}`)
const smartAccount = created.contractId
record('smart account', { hash: created.submitResult.hash, contract: smartAccount })
console.log(`         ${smartAccount}  ${explorerContract(smartAccount)}`)

console.log('\n2. deploying AgentSpendPolicy with owner = that smart account, operator = us')
const deployed = await adapter.deployVault(
  {
    owner: smartAccount,
    operator: operator.publicKey(),
    token: token.address,
    dailyCapRaw: DAILY_CAP,
    autoApproveMaxRaw: CEILING,
  },
  env,
)
if (deployed.outcome !== 'settled') stop(`the vault did not deploy (${deployed.outcome}): ${deployed.reason ?? ''}`)
const vault = deployed.vault
record('vault deploy', { hash: deployed.txHash, contract: vault })
console.log(`         ${vault}  ${explorerContract(vault)}`)
const before = await adapter.readVault(vault, env)
console.log(`         owner() ${before.owner}`)
if (before.owner !== smartAccount) stop('the vault does not report the smart account as its owner')

console.log('\n3. set_policy, SIGNED BY THE PASSKEY through the smart account')
const i128 = (v) => nativeToScVal(v, { type: 'i128' })
const addr = (a) => new Address(a).toScVal()
let r = await kit.executeAndSubmit(vault, 'set_policy', [i128(DAILY_CAP), i128(CEILING), nativeToScVal(true)], { forceMethod: 'rpc' })
if (!r.success) stop(`set_policy through the passkey failed: ${r.error ?? ''}. This is the claim the whole script exists to check.`)
record('set_policy by passkey', { hash: r.hash })
const armed = await adapter.readVault(vault, env)
console.log(`         allowlist_enabled() ${armed.allowlistEnabled}`)

console.log('\n4. set_allowed(payee, true), signed by the passkey')
r = await kit.executeAndSubmit(vault, 'set_allowed', [addr(payee), nativeToScVal(true)], { forceMethod: 'rpc' })
if (!r.success) stop(`set_allowed through the passkey failed: ${r.error ?? ''}`)
record('set_allowed by passkey', { hash: r.hash })

console.log(`\n5. seeding the vault with ${Number(SEED) / 10 ** token.decimals} ${token.symbol}, then paying the allowed payee`)
const seeded = await adapter.sacTransferFromSigner(token.address, vault, SEED, env)
if (seeded.outcome !== 'settled') stop(`the seed transfer ended ${seeded.outcome}: ${seeded.reason ?? ''}. The operator needs ${token.symbol} and a trustline for it.`)
record('seed', { hash: seeded.txHash })
const paid = await adapter.policyPay(vault, payee, PAYMENT, env)
if (paid.outcome !== 'settled') stop(`the allowed payment ended ${paid.outcome}: ${paid.reason ?? ''}`)
record('pay allowed payee', { hash: paid.txHash })

console.log('\n6. paying a payee nobody allowed, which the contract refuses')
const refused = await adapter.policyPay(vault, unlisted, PAYMENT, env)
if (refused.outcome !== 'refused') stop(`an unlisted payee was NOT refused; the outcome was ${refused.outcome}. The allowlist is not doing its job.`)
const named = refused.contractErrorIsOurs ? errorName(refused.contractErrorCode) : undefined
if (named !== 'PayeeNotAllowed') stop(`refused, but with ${named ?? refused.contractErrorCode} rather than PayeeNotAllowed`)
record('pay unlisted payee', { note: `refused with ${named} (contract error #${refused.contractErrorCode}), in simulation, so no transaction exists` })

const after = await adapter.readVault(vault, env)
console.log('\nProved, on chain:')
console.log(`  a WebAuthn credential owns ${vault} through the smart account ${smartAccount}`)
console.log(`  it set the policy itself: cap ${Number(after.dailyCapRaw) / 10 ** token.decimals}, ceiling ${Number(after.autoApproveMaxRaw) / 10 ** token.decimals}, allowlist ${after.allowlistEnabled}`)
console.log(`  the agent spent ${Number(after.spentTodayRaw) / 10 ** token.decimals} ${token.symbol} today under it, and was refused on the payee it never allowed`)
console.log('\nHashes:')
for (const s of steps) console.log(`  ${s.step.padEnd(24)} ${s.hash ?? s.note}`)
console.log('\nTestnet: a reset takes all of this with it, so these ids are a rehearsal, never a record.')
