/**
 * Verify a Soroban authorization, broadcast it, and prove the money moved.
 *
 * The sibling of `x402-3009/engine.ts`, deliberately not a fork of it. The SHAPE is the
 * same on purpose, because "settled means we read the transfer ourselves" has to mean the
 * same thing on every chain we sell on: verify, guard, broadcast, confirm, record. What
 * differs is everything underneath, and the differences are the reason this is a separate
 * file instead of a branch inside that one.
 *
 * ## What Soroban changes, and what each change costs
 *
 * **There is no domain to prove.** EIP-3009 signs a typed-data struct whose domain
 * separator each token chooses, so `x402-3009/domain.ts` exists to prove ours against the
 * token's live DOMAIN_SEPARATOR before we will serve a challenge. Soroban fixes the
 * preimage in the protocol: `HashIDPreimage.envelopeTypeSorobanAuthorization` over
 * {networkId, nonce, signatureExpirationLedger, invocation}. There is nothing per-token to
 * get wrong and therefore nothing to prove. Its absence here is a fact about the VM, not a
 * check we skipped.
 *
 * **The signature is checkable locally, and we check it.** The digest above is sha256 of
 * that preimage, and the credentials carry {public_key, signature}. So a forged or
 * misaddressed signature is refused before any RPC call, exactly as the EVM rail refuses
 * one before broadcasting. Verified against real signed bytes rather than assumed: the
 * envelope of our own testnet settlement 3da74634 recovers to
 * GBRKRUDYKYOSGH4QIYAFONPWXFCFC7K5AYHIVJDNYJAZ33BE5YSMTS6R over Networks.TESTNET.
 *
 * **Expiry is a LEDGER, not a timestamp.** `signatureExpirationLedger` counts ledgers, so
 * the headroom guard is in ledgers and the conversion to seconds is a comment, never a
 * calculation we act on. Stellar closes a ledger about every five seconds, but "about" is
 * not a number to divide by when deciding whether a payment is still live.
 *
 * **The replay guard is the network's, and ours.** Soroban consumes the nonce on-chain for
 * the life of the signature, so a replay fails in simulation at zero cost. We keep our own
 * durable spent set anyway, for the same reason the EVM rail does: the on-chain guard
 * expires with the signature, ours does not, and the two disagreeing is a thing we want to
 * see rather than a thing we want to be surprised by.
 *
 * **Fees are stroops.** No gas price, no estimate, no oracle. A Soroban fee is quoted by
 * the simulation itself, which means the ceiling check reads a real number rather than a
 * projection.
 *
 * ## The broadcaster is pluggable and the record says which one ran
 *
 * `X402_STELLAR_FACILITATOR=self|oz`. Self is the product claim and the default whenever a
 * fee payer exists. OZ Channels is a fallback, built LAZILY inside the call and never at
 * module scope, because repo law is that a missing credential is a clean labeled no-op and
 * a missing OZ key must not be able to crash a server that was never going to use it.
 *
 * Both paths converge on `confirmStellarTransfer`. That is the whole point: whoever moved
 * the money, the sentence "this settled" is backed by our own read of the transfer event
 * carrying our own authorization nonce. A facilitator reporting success is an input to that
 * check and never a substitute for it.
 */
import { Address, Keypair, Operation, TransactionBuilder, hash, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor, SettlementToken } from '../chains/types.js'
import { networkPassphrase, sorobanServer, stellarFeePayer, feePayerEnvVar } from '../chains/stellar/client.js'
import { txUrl } from '../chains/explorer.js'
import { loadSpentPayments, persistSpentPayment, persistStellarSettlement } from '../storage.js'
import type { StellarSettlementRecord } from '../storage.js'
import { confirmStellarTransfer } from './confirm.js'
import type { ConfirmDeps } from './confirm.js'
import { ozApiKey, ozFacilitatorUrl, ozKeyVar, stellarBroadcaster } from './rail.js'
import type { Broadcaster } from './rail.js'

export type StellarRequirements = {
  /** CAIP-2. Not the chain id: a payload naming a network we did not quote is refused. */
  network: string
  /** The SEP-41 contract, a C... StrKey. */
  asset: string
  /** Our receiving G... account. */
  payTo: string
  /** Exact base units, as a decimal string. `exact` means exact. */
  maxAmountRequired: string
  resource: string
}

export type StellarLimits = {
  /** Floor in base units, so a dust payment cannot cost us a whole network fee. */
  minValue: bigint
  /** Ceiling in base units. A payment larger than we sell anything for is a mistake. */
  maxValue: bigint
  /**
   * How many ledgers of validity a signature must still have.
   *
   * In ledgers because that is the unit the field is in. Converting to seconds to compare
   * against a clock would introduce an assumption about ledger close time into a decision
   * that does not need one.
   */
  expiryHeadroomLedgers: number
  /** Hard ceiling on one settlement's network fee, in stroops. Read from simulation. */
  maxFeeStroops: bigint
  /** Daily stroop budget across all settlements, summed from the durable log. */
  dailyFeeStroops: bigint
}

export type StellarVerifyCode =
  | 'malformed_payload'
  | 'unsupported_network'
  | 'unsupported_asset'
  | 'wrong_invocation'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'below_minimum'
  | 'above_maximum'
  | 'source_account_credentials'
  | 'expired'
  | 'expiring_too_soon'
  | 'bad_signature'
  | 'already_redeemed'
  | 'rpc_error'

export type StellarSettleCode =
  | StellarVerifyCode
  | 'no_broadcaster'
  | 'in_flight'
  | 'simulation_failed'
  | 'fee_ceiling'
  | 'fee_budget_exhausted'
  | 'broadcast_failed'
  /** Landed, and the ledger says it failed. Decided against. */
  | 'settlement_failed'
  /** Broadcast, but our own read could not confirm it. Never a sale, never a refusal. */
  | 'unconfirmed'

/** What the buyer signed, decoded. Every field is read from the entry, none is supplied. */
export type DecodedAuth = {
  payer: string
  nonce: string
  expirationLedger: number
  contract: string
  fn: string
  from: string
  to: string
  amount: bigint
  entry: xdr.SorobanAuthorizationEntry
}

export type StellarVerifyResult =
  | { isValid: true; auth: DecodedAuth; key: string }
  | { isValid: false; code: StellarVerifyCode; invalidReason: string }

export type StellarSettleSuccess = {
  success: true
  transaction: string
  ledger: number
  payer: string
  network: string
  asset: string
  assetSymbol: string
  value: string
  feeStroops: string
  broadcaster: Broadcaster
  explorerUrl: string
  settledAt: string
}

export type StellarSettleResult =
  | StellarSettleSuccess
  | {
      success: false
      code: StellarSettleCode
      errorReason: string
      transaction?: string
      /** True when money may have moved and we cannot say. Never counted either way. */
      ambiguous?: boolean
    }

/**
 * The durable replay key.
 *
 * Namespaced with `soroban-auth` so it can never collide with the EIP-3009 rail's keys or
 * the Arc rail's bare tx hashes in the shared spent_payments table, which is the same
 * decision `x402-3009/engine.ts` documents for its own.
 *
 * LOWERCASED, and that is not cosmetic. `persistSpentPayment` normalises what it stores
 * with .toLowerCase(), because it was written for EVM hashes and 0x addresses where that is
 * free. A StrKey is case-significant uppercase base32, so the first version of this function
 * wrote a lowercased key and then compared against an uppercase one: our own replay guard
 * never fired on Stellar, silently, in every code path. It was found by replaying a real
 * payment against the live rail, where the NETWORK caught it instead
 * (Error(Auth, ExistingValue), testnet ledger 4149204). That is a genuine defence and it is
 * not this one: Soroban forgets a nonce when the signature expires, and ours must not.
 *
 * Lowercasing here is safe because base32's A-Z2-7 maps one-to-one onto lowercase, so the
 * key stays unique. It is a storage identity, never displayed and never parsed back into an
 * address. paymentKeyIsStorageStable() below is the test that keeps this true.
 */
export function stellarPaymentKey(caip2: string, asset: string, from: string, nonce: string): string {
  return `${caip2}/sep41:${asset}/soroban-auth/${from}/${nonce}`.toLowerCase()
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Decode X-PAYMENT into an authorization entry.
 *
 * Accepts the parsed body a route hands us, not a header string, so the header decoding
 * lives in exactly one place upstream and this stays testable without base64.
 */
export function parseStellarPayload(
  payload: unknown,
): { ok: true; entry: xdr.SorobanAuthorizationEntry } | { ok: false; reason: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload is not an object' }
  const p = payload as Record<string, unknown>
  const xdrB64 = typeof p.authEntryXdr === 'string' ? p.authEntryXdr.trim() : ''
  if (!xdrB64) return { ok: false, reason: 'payload.authEntryXdr is missing' }
  try {
    return { ok: true, entry: xdr.SorobanAuthorizationEntry.fromXDR(xdrB64, 'base64') }
  } catch (e) {
    return { ok: false, reason: `payload.authEntryXdr did not decode as a SorobanAuthorizationEntry: ${msg(e)}` }
  }
}

/**
 * Read the invocation the buyer signed.
 *
 * Returns a reason rather than throwing for every shape we will not settle, because each
 * one is something a buyer can fix and none of them is exceptional.
 */
export function decodeAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
): { ok: true; auth: DecodedAuth } | { ok: false; code: StellarVerifyCode; reason: string } {
  const creds = entry.credentials()
  if (creds.switch().name !== 'sorobanCredentialsAddress') {
    return {
      ok: false,
      code: 'source_account_credentials',
      reason:
        'this entry uses source-account credentials, which authorize whoever submits the ' +
        'transaction. On this rail we submit, so that would make us the payer. Sign an ' +
        'address credential for your own account instead.',
    }
  }
  const ca = creds.address()
  let payer: string
  try {
    payer = Address.fromScAddress(ca.address()).toString()
  } catch (e) {
    return { ok: false, code: 'malformed_payload', reason: `could not read the payer address: ${msg(e)}` }
  }

  const fnBody = entry.rootInvocation().function()
  if (fnBody.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    return {
      ok: false,
      code: 'wrong_invocation',
      reason: 'the entry authorizes a contract creation rather than a contract call',
    }
  }
  const call = fnBody.contractFn()
  let contract: string
  try {
    contract = Address.fromScAddress(call.contractAddress()).toString()
  } catch (e) {
    return { ok: false, code: 'malformed_payload', reason: `could not read the contract address: ${msg(e)}` }
  }
  const fn = call.functionName().toString()
  const args = call.args()
  if (fn !== 'transfer' || args.length !== 3) {
    return {
      ok: false,
      code: 'wrong_invocation',
      reason: `this rail settles a SEP-41 transfer(from, to, amount); this entry authorizes ${fn}(${args.length} args)`,
    }
  }

  let from: string
  let to: string
  let amount: bigint
  try {
    from = Address.fromScVal(args[0]).toString()
    to = Address.fromScVal(args[1]).toString()
    const native = scValToNative(args[2])
    if (typeof native !== 'bigint') {
      return { ok: false, code: 'malformed_payload', reason: 'the amount argument is not an i128' }
    }
    amount = native
  } catch (e) {
    return { ok: false, code: 'malformed_payload', reason: `could not read the transfer arguments: ${msg(e)}` }
  }

  // The transfer's own `from` must be the account that signed. Soroban would enforce this
  // itself, but catching it here turns a host trap deep in a simulation into a sentence.
  if (from !== payer) {
    return {
      ok: false,
      code: 'wrong_invocation',
      reason: `the entry is signed by ${payer} but authorizes a transfer from ${from}`,
    }
  }

  return {
    ok: true,
    auth: {
      payer,
      nonce: ca.nonce().toString(),
      expirationLedger: ca.signatureExpirationLedger(),
      contract,
      fn,
      from,
      to,
      amount,
      entry,
    },
  }
}

/**
 * Does the signature actually recover to the payer, over THIS network?
 *
 * The network id is in the preimage, which is what makes a testnet signature useless on
 * pubnet and vice versa. That property is load-bearing for a rail that sells on both, so
 * it is checked rather than trusted.
 */
export function verifyAuthSignature(
  chain: ChainDescriptor,
  auth: DecodedAuth,
): { ok: true } | { ok: false; reason: string } {
  const ca = auth.entry.credentials().address()
  let digest: Buffer
  try {
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(networkPassphrase(chain))),
        nonce: ca.nonce(),
        signatureExpirationLedger: ca.signatureExpirationLedger(),
        invocation: auth.entry.rootInvocation(),
      }),
    )
    digest = hash(preimage.toXDR())
  } catch (e) {
    return { ok: false, reason: `could not build the authorization preimage: ${msg(e)}` }
  }

  let sigs: unknown[]
  try {
    const native = scValToNative(ca.signature())
    sigs = Array.isArray(native) ? native : [native]
  } catch (e) {
    return { ok: false, reason: `could not read the signature: ${msg(e)}` }
  }
  if (!sigs.length) return { ok: false, reason: 'the entry carries no signature' }

  for (const s of sigs) {
    const rec = s as { public_key?: unknown; signature?: unknown }
    if (!rec || !(rec.public_key instanceof Uint8Array) || !(rec.signature instanceof Uint8Array)) {
      return { ok: false, reason: 'the signature is not the ed25519 {public_key, signature} shape' }
    }
    let signerAddr: string
    try {
      signerAddr = Address.account(Buffer.from(rec.public_key)).toString()
    } catch (e) {
      return { ok: false, reason: `the signature carries an unreadable public key: ${msg(e)}` }
    }
    if (signerAddr !== auth.payer) {
      return {
        ok: false,
        reason: `the entry is credentialed to ${auth.payer} but signed by ${signerAddr}`,
      }
    }
    let good = false
    try {
      good = Keypair.fromPublicKey(auth.payer).verify(digest, Buffer.from(rec.signature))
    } catch (e) {
      return { ok: false, reason: `signature check threw: ${msg(e)}` }
    }
    if (!good) {
      return {
        ok: false,
        reason:
          `the signature does not verify for ${auth.payer} over ${chain.caip2}. If you signed ` +
          `against a different network passphrase, that is what this looks like.`,
      }
    }
  }
  return { ok: true }
}

export type StellarSettleDeps = {
  env?: NodeJS.ProcessEnv
  server?: Pick<rpc.Server, 'getLatestLedger' | 'getAccount' | 'simulateTransaction' | 'sendTransaction'>
  /** Injected so a settlement can be tested without a network. */
  confirm?: typeof confirmStellarTransfer
  confirmDeps?: ConfirmDeps
  loadSpent?: () => Promise<string[]>
  persistSpent?: (key: string) => Promise<void>
  persist?: (rec: StellarSettlementRecord) => Promise<void>
  feeSpentTodayStroops?: () => Promise<bigint>
  /** Overrides the resolved broadcaster. Tests only; production reads the env. */
  broadcaster?: Broadcaster
  /** The OZ path, injected so the fallback is testable without a live third party. */
  ozSubmit?: (input: OzSubmitInput) => Promise<{ ok: true; txHash: string } | { ok: false; reason: string }>
  now?: () => Date
  meta?: { tool: string; baseUsd: number; facilitatedFor?: string }
}

export type OzSubmitInput = {
  url: string
  apiKey: string
  network: string
  authEntryXdr: string
  asset: string
  payTo: string
  amount: string
}

/**
 * Verify everything that can be decided before we spend anything.
 *
 * Ordered cheapest-first for a reason that is not tidiness: a malformed payload, a wrong
 * recipient and a bad signature all cost zero RPC calls here, so an attacker cannot make
 * us do work by sending garbage.
 */
export async function verifyStellarPayment(input: {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: StellarRequirements
  payload: unknown
  limits: StellarLimits
  deps?: StellarSettleDeps
}): Promise<StellarVerifyResult> {
  const { chain, token, requirements, limits } = input
  const deps = input.deps ?? {}
  const env = deps.env ?? process.env

  if (requirements.network !== chain.caip2) {
    return {
      isValid: false,
      code: 'unsupported_network',
      invalidReason: `these requirements name ${requirements.network}, this rail is ${chain.caip2}`,
    }
  }

  const parsed = parseStellarPayload(input.payload)
  if (!parsed.ok) return { isValid: false, code: 'malformed_payload', invalidReason: parsed.reason }

  const decoded = decodeAuthEntry(parsed.entry)
  if (!decoded.ok) return { isValid: false, code: decoded.code, invalidReason: decoded.reason }
  const auth = decoded.auth

  if (auth.contract !== token.address) {
    return {
      isValid: false,
      code: 'unsupported_asset',
      invalidReason: `the entry authorizes ${auth.contract}; this rail settles ${token.symbol} at ${token.address}`,
    }
  }
  if (auth.to !== requirements.payTo) {
    return {
      isValid: false,
      code: 'wrong_recipient',
      invalidReason: `the entry pays ${auth.to}, this resource is paid to ${requirements.payTo}`,
    }
  }

  let required: bigint
  try {
    required = BigInt(requirements.maxAmountRequired)
  } catch {
    return { isValid: false, code: 'malformed_payload', invalidReason: 'maxAmountRequired is not an integer' }
  }
  // `exact` means exact, the same rule the EIP-3009 rail states: accepting more would let a
  // buyer overpay silently and would make the recorded amount disagree with the quote.
  if (auth.amount !== required) {
    return {
      isValid: false,
      code: 'wrong_amount',
      invalidReason: `the entry is for ${auth.amount}, the resource costs exactly ${required}`,
    }
  }
  if (auth.amount < limits.minValue) {
    return { isValid: false, code: 'below_minimum', invalidReason: `below this rail's minimum of ${limits.minValue} base units` }
  }
  if (auth.amount > limits.maxValue) {
    return { isValid: false, code: 'above_maximum', invalidReason: `above this rail's maximum of ${limits.maxValue} base units` }
  }

  const sig = verifyAuthSignature(chain, auth)
  if (!sig.ok) return { isValid: false, code: 'bad_signature', invalidReason: sig.reason }

  // Only now do we touch the network, and only for the one thing that needs it: how far
  // the ledger has advanced against a signature that expires by ledger number.
  let latest: number
  try {
    const server = deps.server ?? sorobanServer(chain, env)
    latest = (await server.getLatestLedger()).sequence
  } catch (e) {
    return { isValid: false, code: 'rpc_error', invalidReason: `could not read the latest ledger: ${msg(e)}` }
  }
  if (auth.expirationLedger <= latest) {
    return {
      isValid: false,
      code: 'expired',
      invalidReason: `the signature expired at ledger ${auth.expirationLedger}; the network is at ${latest}`,
    }
  }
  if (auth.expirationLedger - latest < limits.expiryHeadroomLedgers) {
    return {
      isValid: false,
      code: 'expiring_too_soon',
      invalidReason:
        `the signature expires in ${auth.expirationLedger - latest} ledgers, inside the ` +
        `${limits.expiryHeadroomLedgers} we need to get it included. Nothing was broadcast: ` +
        `a signature that expires while we are submitting costs us the fee and shows the buyer ` +
        `a failure they cannot tell from a bad signature.`,
    }
  }

  const key = stellarPaymentKey(chain.caip2, token.address, auth.payer, auth.nonce)
  let spent: string[]
  try {
    spent = await (deps.loadSpent ?? loadSpentPayments)()
  } catch (e) {
    // Fail CLOSED. An unreadable replay guard is a refusal, never a pass: the alternative
    // is redeeming the same authorization twice.
    return {
      isValid: false,
      code: 'rpc_error',
      invalidReason: `could not read the replay guard, refusing rather than risking a replay: ${msg(e)}`,
    }
  }
  if (spent.includes(key)) {
    return { isValid: false, code: 'already_redeemed', invalidReason: 'this authorization has already been redeemed here' }
  }

  return { isValid: true, auth, key }
}

/** Keys this process is currently settling. Guards the verify-to-spent-write window. */
const inFlight = new Set<string>()

/**
 * Verify, broadcast, and prove.
 *
 * Returns success only when our own read of the ledger found a transfer carrying this
 * authorization's nonce. Every other outcome names itself, and the two that mean "we do
 * not know" say so instead of picking a side.
 */
export async function settleStellarPayment(input: {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: StellarRequirements
  payload: unknown
  limits: StellarLimits
  deps?: StellarSettleDeps
}): Promise<StellarSettleResult> {
  const { chain, token, requirements, limits } = input
  const deps = input.deps ?? {}
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const persist = deps.persist ?? persistStellarSettlement
  const confirm = deps.confirm ?? confirmStellarTransfer

  const verified = await verifyStellarPayment(input)
  if (!verified.isValid) return { success: false, code: verified.code, errorReason: verified.invalidReason }
  const { auth, key } = verified

  if (inFlight.has(key)) {
    return { success: false, code: 'in_flight', errorReason: 'this authorization is already being settled' }
  }
  inFlight.add(key)
  try {
    const chosen = deps.broadcaster ?? resolveBroadcaster(chain, env)
    if (chosen === null) {
      return {
        success: false,
        code: 'no_broadcaster',
        errorReason:
          `Nothing can broadcast on ${chain.id}: no usable fee payer in ${feePayerEnvVar(chain)} or ` +
          `${chain.signerEnvVar ?? 'the chain signer'}, and no ${ozKeyVar(chain)}. Nothing was ` +
          `submitted and nothing was charged.`,
      }
    }

    const broadcast =
      chosen === 'oz'
        ? await broadcastViaOz(chain, auth, requirements, deps)
        : await broadcastOurselves(chain, auth, limits, deps)
    if (!broadcast.ok) {
      return { success: false, code: broadcast.code, errorReason: broadcast.reason }
    }

    const confirmed = await confirm(
      chain,
      broadcast.txHash,
      { sac: token.address, to: requirements.payTo, from: auth.payer, amountRaw: auth.amount, authNonce: auth.nonce },
      { env, ...(deps.confirmDeps ?? {}) },
    )

    const base: Omit<StellarSettlementRecord, 'outcome'> = {
      ts: now().toISOString(),
      tool: deps.meta?.tool ?? 'unknown',
      resource: requirements.resource,
      network: chain.caip2,
      asset: token.address,
      assetSymbol: token.symbol,
      assetDecimals: token.decimals,
      value: auth.amount.toString(),
      amountUsd: deps.meta?.baseUsd ?? 0,
      baseUsd: deps.meta?.baseUsd ?? 0,
      payer: auth.payer,
      payTo: requirements.payTo,
      tx: broadcast.txHash,
      explorerUrl: txUrl(chain, broadcast.txHash) ?? undefined,
      broadcaster: chosen,
      confirmedBy: 'soroban-rpc',
      ...(broadcast.feeStroops !== undefined ? { feeStroops: broadcast.feeStroops.toString() } : {}),
      ...(deps.meta?.facilitatedFor ? { facilitatedFor: deps.meta.facilitatedFor } : {}),
    }

    if (!confirmed.confirmed) {
      // Two very different situations share this branch, and the CODE is what separates
      // them. tx_failed is a verdict: it landed and the ledger rejected it. Everything else
      // is our own inability to see, which must not be recorded as a refusal. Both are
      // written down, because a broadcast we cannot account for is exactly the thing an
      // operator needs to find later.
      const decided = confirmed.code === 'tx_failed'
      await safePersist(persist, { ...base, outcome: decided ? 'reverted' : 'ambiguous' })
      return {
        success: false,
        code: decided ? 'settlement_failed' : 'unconfirmed',
        transaction: broadcast.txHash,
        ...(decided ? {} : { ambiguous: true }),
        errorReason: confirmed.reason,
      }
    }

    // Only here. The money moved, we read it, and it carried our nonce.
    await safePersist(persist, { ...base, outcome: 'settled', ledger: confirmed.ledger })
    try {
      await (deps.persistSpent ?? persistSpentPayment)(key)
    } catch (e) {
      // The sale already happened and is recorded. A failed replay-guard write is loud
      // rather than fatal: turning a completed settlement into an error would be worse.
      console.error('[x402-stellar] could not persist the replay key, a replay would not be caught:', msg(e))
    }

    return {
      success: true,
      transaction: broadcast.txHash,
      ledger: confirmed.ledger,
      payer: auth.payer,
      network: chain.caip2,
      asset: token.address,
      assetSymbol: token.symbol,
      value: auth.amount.toString(),
      feeStroops: broadcast.feeStroops?.toString() ?? '0',
      broadcaster: chosen,
      explorerUrl: txUrl(chain, broadcast.txHash) ?? '',
      settledAt: now().toISOString(),
    }
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Which broadcaster will actually run, or null when neither can.
 *
 * Delegates to rail.ts rather than repeating the resolution. Two functions answering
 * "who broadcasts" is how the status endpoint ends up advertising a rail that the settle
 * path then refuses, which is the exact failure this repo already hit once when readiness
 * and signing read different variables.
 */
function resolveBroadcaster(chain: ChainDescriptor, env: NodeJS.ProcessEnv): Broadcaster | null {
  const r = stellarBroadcaster(chain, env)
  return r.ready ? r.broadcaster : null
}

type BroadcastResult =
  | { ok: true; txHash: string; feeStroops?: bigint }
  | { ok: false; code: StellarSettleCode; reason: string }

/**
 * The self path: we assemble, we pay the fee, the buyer pays nothing.
 *
 * The one line that cost a real transaction to learn is `Operation.invokeHostFunction({
 * func, auth })`. `assembleTransaction` silently DISCARDS signed auth entries unless they
 * are already on the operation before assembly, so building the op with the entry attached
 * is not a style choice: the alternative broadcasts a transaction that looks right,
 * simulates fine, and fails on-chain because the authorization is gone (c51c4778 on
 * testnet, the proof of it).
 */
async function broadcastOurselves(
  chain: ChainDescriptor,
  auth: DecodedAuth,
  limits: StellarLimits,
  deps: StellarSettleDeps,
): Promise<BroadcastResult> {
  const env = deps.env ?? process.env
  const kp = stellarFeePayer(chain, env)
  if (!kp) {
    return {
      ok: false,
      code: 'no_broadcaster',
      reason: `no usable fee payer for ${chain.id}. Set ${feePayerEnvVar(chain)} to a Stellar S... secret seed.`,
    }
  }

  let server: Pick<rpc.Server, 'getLatestLedger' | 'getAccount' | 'simulateTransaction' | 'sendTransaction'>
  try {
    server = deps.server ?? sorobanServer(chain, env)
  } catch (e) {
    return { ok: false, code: 'rpc_error', reason: `could not build an RPC client: ${msg(e)}` }
  }

  const call = auth.entry.rootInvocation().function().contractFn()
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: call.contractAddress(),
      functionName: call.functionName(),
      args: call.args(),
    }),
  )

  let tx
  try {
    const account = await server.getAccount(kp.publicKey())
    tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: networkPassphrase(chain) })
      .addOperation(Operation.invokeHostFunction({ func, auth: [auth.entry] }))
      .setTimeout(180)
      .build()
  } catch (e) {
    return { ok: false, code: 'rpc_error', reason: `could not build the settlement transaction: ${msg(e)}` }
  }

  let prepared
  let feeStroops = 0n
  try {
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // A replay lands here, and so does an insufficient balance. Both cost us nothing,
      // which is the reason simulation runs before the ceiling checks rather than after.
      return { ok: false, code: 'simulation_failed', reason: `the settlement would fail: ${sim.error}` }
    }
    prepared = rpc.assembleTransaction(tx, sim).build()
    feeStroops = BigInt(prepared.fee)
  } catch (e) {
    return { ok: false, code: 'simulation_failed', reason: `could not simulate the settlement: ${msg(e)}` }
  }

  if (feeStroops > limits.maxFeeStroops) {
    return {
      ok: false,
      code: 'fee_ceiling',
      reason: `this settlement would cost ${feeStroops} stroops, above this rail's ceiling of ${limits.maxFeeStroops}. Nothing was broadcast.`,
    }
  }
  const spentToday = await (deps.feeSpentTodayStroops ?? (async () => 0n))()
  if (spentToday + feeStroops > limits.dailyFeeStroops) {
    return {
      ok: false,
      code: 'fee_budget_exhausted',
      reason: `today's settlement fee budget is spent (${spentToday} of ${limits.dailyFeeStroops} stroops). Nothing was broadcast and nothing was charged.`,
    }
  }

  try {
    prepared.sign(kp)
    const sent = await server.sendTransaction(prepared)
    if (sent.status === 'ERROR') {
      return { ok: false, code: 'broadcast_failed', reason: `the network rejected the settlement: ${JSON.stringify(sent.errorResult ?? sent.status)}` }
    }
    return { ok: true, txHash: sent.hash, feeStroops }
  } catch (e) {
    return { ok: false, code: 'broadcast_failed', reason: `could not broadcast the settlement: ${msg(e)}` }
  }
}

/**
 * The OZ Channels fallback.
 *
 * Built here, inside the call, and never imported at module scope. A missing key returns a
 * labeled refusal instead of crashing a server that had no intention of using this path.
 *
 * Note what does NOT change on this path: OZ tells us a hash, and that is all it tells us.
 * Whether the money moved is still decided by our own read, in the caller, against the same
 * nonce. This is the difference from the Celo rail, where "settled" is the facilitator's
 * word and nothing reads the chain, and it is written up in x402-3009/engine.ts as a
 * weakness rather than a feature.
 */
async function broadcastViaOz(
  chain: ChainDescriptor,
  auth: DecodedAuth,
  requirements: StellarRequirements,
  deps: StellarSettleDeps,
): Promise<BroadcastResult> {
  const env = deps.env ?? process.env
  const apiKey = ozApiKey(chain, env)
  if (!apiKey) {
    return { ok: false, code: 'no_broadcaster', reason: `${ozKeyVar(chain)} is not set, so the OZ path cannot run` }
  }
  const submit = deps.ozSubmit ?? defaultOzSubmit
  try {
    const r = await submit({
      url: ozFacilitatorUrl(chain, env),
      apiKey,
      network: chain.caip2,
      authEntryXdr: auth.entry.toXDR('base64'),
      asset: auth.contract,
      payTo: requirements.payTo,
      amount: auth.amount.toString(),
    })
    if (!r.ok) return { ok: false, code: 'broadcast_failed', reason: `OpenZeppelin Channels refused: ${r.reason}` }
    return { ok: true, txHash: r.txHash }
  } catch (e) {
    return { ok: false, code: 'broadcast_failed', reason: `OpenZeppelin Channels call failed: ${msg(e)}` }
  }
}

/**
 * The live OZ call.
 *
 * Separate and injectable so the fallback has tests that do not depend on a third party
 * being reachable, and so the shape of what we send them is reviewable without running it.
 */
async function defaultOzSubmit(
  input: OzSubmitInput,
): Promise<{ ok: true; txHash: string } | { ok: false; reason: string }> {
  const res = await fetch(`${input.url.replace(/\/+$/, '')}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: { scheme: 'exact', network: input.network, payload: { authEntryXdr: input.authEntryXdr } },
      paymentRequirements: { scheme: 'exact', network: input.network, asset: input.asset, payTo: input.payTo, maxAmountRequired: input.amount },
    }),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 300)}` }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, reason: `unreadable response: ${text.slice(0, 300)}` }
  }
  const txHash = typeof body.transaction === 'string' ? body.transaction : typeof body.txHash === 'string' ? body.txHash : ''
  if (!txHash) return { ok: false, reason: `no transaction hash in the response: ${text.slice(0, 300)}` }
  return { ok: true, txHash }
}

/** A durable-write failure must never turn a decided settlement into a crash. */
async function safePersist(
  persist: (rec: StellarSettlementRecord) => Promise<void>,
  rec: StellarSettlementRecord,
): Promise<void> {
  try {
    await persist(rec)
  } catch (e) {
    console.error('[x402-stellar] settlement record write failed:', msg(e))
  }
}
