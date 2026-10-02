/**
 * Read a fee-sponsoring relay request, and nothing more.
 *
 * The passkey demo's frontend points the smart-account kit's relayer at our own endpoint,
 * and that endpoint forwards to OpenZeppelin Channels with a key we hold. Whatever we
 * forward, Channels pays for and broadcasts under our account, so the endpoint is an open
 * relay unless something between the request and the key refuses everything it does not
 * positively recognise. This file is the reading half of that something: it decodes the
 * XDR the kit sends (`{ func, auth }`, or a whole signed envelope) into plain strings and
 * refuses what does not decode. The deciding half is `mcp/src/stellar-passkey.ts`, which is
 * pure and unit-tested against hand-built payloads.
 *
 * Signs nothing, sends nothing, keeps nothing. It never touches the key, and it never sees
 * the credential behind an authorization entry as anything but opaque bytes to re-encode.
 */
import { Address, FeeBumpTransaction, Keypair, Networks, TransactionBuilder, scValToNative, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../types.js'
import { networkPassphrase } from './client.js'
import { isAccountId } from './strkey.js'
import type { RelayAccountAdmin, RelayAuth, RelayContextType, RelayFunc, RelayInspection, RelayInvocation, RelaySigner } from './relay-shape.js'

export type { RelayAccountAdmin, RelayAuth, RelayContextType, RelayFunc, RelayInspection, RelayInvocation, RelaySigner } from './relay-shape.js'

/** A value the SDK can render natively, or its base64 ScVal when it cannot. */
function native(v: xdr.ScVal): unknown {
  try {
    const n: unknown = scValToNative(v)
    return typeof n === 'bigint' ? n.toString() : n
  } catch {
    return v.toXDR('base64')
  }
}

/**
 * The OpenZeppelin account constructor's two arguments, `(Vec<Signer>, Map<Address, Val>)`,
 * when the deploy carries exactly those. Null for any other count or type, so a constructor
 * this file cannot read is refused by the decision rather than passed as an empty one.
 */
function describeAccountConstructor(args: xdr.ScVal[]): { signers: RelaySigner[]; policies: number } | null {
  try {
    if (args.length !== 2) return null
    const [signers, policies] = args
    if (signers.switch().name !== 'scvVec' || policies.switch().name !== 'scvMap') return null
    return { signers: (signers.vec() ?? []).map((s) => describeSigner(s)), policies: (policies.map() ?? []).length }
  } catch {
    return null
  }
}

function describeCreateV2(create: xdr.CreateContractArgsV2): {
  wasmHash: string | null
  deployer: string | null
  createXdr: string
  constructorArgs: number
  account: { signers: RelaySigner[]; policies: number } | null
} {
  const executable = create.executable()
  const wasmHash =
    executable.switch().name === 'contractExecutableWasm' ? Buffer.from(executable.wasmHash()).toString('hex') : null
  const preimage = create.contractIdPreimage()
  let deployer: string | null = null
  if (preimage.switch().name === 'contractIdPreimageFromAddress') {
    try {
      deployer = Address.fromScAddress(preimage.fromAddress().address()).toString()
    } catch {
      deployer = null
    }
  }
  const args = create.constructorArgs()
  return { wasmHash, deployer, createXdr: create.toXDR('base64'), constructorArgs: args.length, account: describeAccountConstructor(args) }
}

/** The smart account's `execute(target, target_fn, target_args)`, when the args have that shape. */
function describeExecute(method: string, args: xdr.ScVal[]): { target: string; targetFn: string; targetArgs: unknown[] } | null {
  if (method !== 'execute' || args.length !== 3) return null
  const [target, fn, vec] = args
  if (target.switch().name !== 'scvAddress' || fn.switch().name !== 'scvSymbol' || vec.switch().name !== 'scvVec') return null
  try {
    return {
      target: Address.fromScAddress(target.address()).toString(),
      targetFn: fn.sym().toString(),
      targetArgs: (vec.vec() ?? []).map((a) => native(a)),
    }
  } catch {
    return null
  }
}

/**
 * One OpenZeppelin `Signer` enum value: `Vec[Symbol("External"), Address, Bytes]` or
 * `Vec[Symbol("Delegated"), Address]`. Anything else is `unknown`, which every decision
 * over it refuses, so a new signer kind can never be read as one we know.
 */
function describeSigner(v: xdr.ScVal): RelaySigner {
  try {
    if (v.switch().name !== 'scvVec') return { kind: 'unknown' }
    const parts = v.vec() ?? []
    if (parts.length < 2 || parts[0].switch().name !== 'scvSymbol') return { kind: 'unknown' }
    const tag = parts[0].sym().toString()
    if (tag === 'External' && parts.length === 3 && parts[1].switch().name === 'scvAddress' && parts[2].switch().name === 'scvBytes') {
      return { kind: 'external', verifier: Address.fromScAddress(parts[1].address()).toString(), keyHex: Buffer.from(parts[2].bytes()).toString('hex') }
    }
    if (tag === 'Delegated' && parts.length === 2 && parts[1].switch().name === 'scvAddress') {
      return { kind: 'delegated', address: Address.fromScAddress(parts[1].address()).toString() }
    }
  } catch {
    /* falls through to unknown */
  }
  return { kind: 'unknown' }
}

/** `ContextRuleType`: `Vec[Symbol("Default")]`, `Vec[Symbol("CallContract"), Address]`, `Vec[Symbol("CreateContract"), Bytes]`. */
function describeContextType(v: xdr.ScVal): RelayContextType {
  try {
    if (v.switch().name !== 'scvVec') return 'unknown'
    const parts = v.vec() ?? []
    if (parts.length === 0 || parts[0].switch().name !== 'scvSymbol') return 'unknown'
    const tag = parts[0].sym().toString()
    if (tag === 'Default' && parts.length === 1) return 'default'
    if (tag === 'CallContract' && parts.length === 2) return 'call-contract'
    if (tag === 'CreateContract' && parts.length === 2) return 'create-contract'
  } catch {
    /* falls through to unknown */
  }
  return 'unknown'
}

/**
 * A smart account's `add_context_rule(context_type, name, valid_until, signers, policies)` or
 * `add_signer(context_rule_id, signer)`, when the arguments have the account's own types.
 * Null otherwise, which the decision refuses as an unknown shape rather than guessing at.
 */
function describeAdmin(method: string, args: xdr.ScVal[]): RelayAccountAdmin | null {
  try {
    if (method === 'add_context_rule' && args.length === 5) {
      const [type, name, validUntil, signers, policies] = args
      if (signers.switch().name !== 'scvVec' || policies.switch().name !== 'scvMap') return null
      const vu = validUntil.switch().name === 'scvU32' ? validUntil.u32() : validUntil.switch().name === 'scvVoid' ? null : undefined
      if (vu === undefined) return null
      return {
        method,
        contextType: describeContextType(type),
        name: name.switch().name === 'scvString' ? name.str().toString() : null,
        validUntil: vu,
        signers: (signers.vec() ?? []).map((s) => describeSigner(s)),
        policies: (policies.map() ?? []).length,
      }
    }
    if (method === 'add_signer' && args.length === 2) {
      const [ruleId, signer] = args
      return { method, contextRuleId: ruleId.switch().name === 'scvU32' ? ruleId.u32() : null, signer: describeSigner(signer) }
    }
  } catch {
    return null
  }
  return null
}

function describeFunc(func: xdr.HostFunction): RelayFunc {
  switch (func.switch().name) {
    case 'hostFunctionTypeInvokeContract': {
      const inv = func.invokeContract()
      const method = inv.functionName().toString()
      const args = inv.args()
      return {
        kind: 'invoke',
        contract: Address.fromScAddress(inv.contractAddress()).toString(),
        method,
        args: args.map((a) => native(a)),
        argsXdr: inv.toXDR('base64'),
        execute: describeExecute(method, args),
        admin: describeAdmin(method, args),
      }
    }
    case 'hostFunctionTypeCreateContractV2':
      return { kind: 'create-contract-v2', ...describeCreateV2(func.createContractV2()) }
    case 'hostFunctionTypeCreateContract':
      return { kind: 'other', what: 'a v1 createContract (no constructor), which the smart account kit never sends' }
    case 'hostFunctionTypeUploadContractWasm':
      return { kind: 'other', what: 'a wasm upload, which this relay never pays for' }
    default:
      return { kind: 'other', what: func.switch().name }
  }
}

function describeInvocation(inv: xdr.SorobanAuthorizedInvocation): RelayInvocation {
  const fn = inv.function()
  switch (fn.switch().name) {
    case 'sorobanAuthorizedFunctionTypeContractFn': {
      const c = fn.contractFn()
      return {
        kind: 'contract-fn',
        contract: Address.fromScAddress(c.contractAddress()).toString(),
        method: c.functionName().toString(),
        argsXdr: c.toXDR('base64'),
      }
    }
    case 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn': {
      const d = describeCreateV2(fn.createContractV2HostFn())
      return { kind: 'create-contract-v2', wasmHash: d.wasmHash, createXdr: d.createXdr }
    }
    default:
      return { kind: 'create-contract', createXdr: fn.createContractHostFn().toXDR('base64') }
  }
}

function flattenSubs(inv: xdr.SorobanAuthorizedInvocation, out: RelayInvocation[] = []): RelayInvocation[] {
  for (const sub of inv.subInvocations()) {
    out.push(describeInvocation(sub))
    flattenSubs(sub, out)
  }
  return out
}

function describeAuth(entry: xdr.SorobanAuthorizationEntry): RelayAuth {
  const creds = entry.credentials()
  let credentials: RelayAuth['credentials'] = 'other'
  let address: string | null = null
  switch (creds.switch().name) {
    case 'sorobanCredentialsSourceAccount':
      credentials = 'source-account'
      break
    case 'sorobanCredentialsAddress':
      credentials = 'address'
      address = Address.fromScAddress(creds.address().address()).toString()
      break
    default:
      // Newer credential kinds (delegates, V2) are not something the kit sends for a passkey
      // account today; reported as `other` so the decision refuses them by name.
      credentials = 'other'
  }
  const root = entry.rootInvocation()
  return { credentials, address, root: describeInvocation(root), sub: flattenSubs(root) }
}

/**
 * Decode `{ func, auth }` or `{ xdr }` for this chain, or say why it does not decode.
 *
 * On the envelope carrier the source signature is checked under this network's passphrase
 * and under the other one, exactly as the vault relay does: a key that signed for the other
 * network is refused outright rather than forwarded to fail at the relayer's expense.
 */
export function inspectRelayPayload(
  chain: ChainDescriptor,
  input: { func?: unknown; auth?: unknown; xdr?: unknown },
): RelayInspection {
  const bad = (reason: string): RelayInspection => ({ ok: false, code: 'bad_request', reason })

  if (typeof input.xdr === 'string' && input.xdr.trim()) {
    if (input.func !== undefined || input.auth !== undefined) {
      return bad('send either { func, auth } or { xdr }, not both')
    }
    const net = networkPassphrase(chain)
    const otherNet = net === Networks.PUBLIC ? Networks.TESTNET : Networks.PUBLIC
    const signed = input.xdr.trim()
    let tx: ReturnType<typeof TransactionBuilder.fromXDR>
    try {
      tx = TransactionBuilder.fromXDR(signed, net)
    } catch (e) {
      return bad(`xdr is not a transaction envelope: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (tx instanceof FeeBumpTransaction) return bad('a fee-bump envelope is not accepted: the relayer adds its own fee bump')
    if (tx.operations.length !== 1) return bad(`the envelope carries ${tx.operations.length} operations; exactly one contract invocation is accepted`)
    const op = tx.operations[0]
    if (op.type !== 'invokeHostFunction') return bad(`operation type ${op.type} is not accepted; only a contract invocation is`)
    if (tx.signatures.length === 0) return bad('the envelope carries no signature; the relayer fee-bumps a SIGNED transaction and this one is not')

    const verifies = (passphrase: string): boolean => {
      try {
        const rebuilt = TransactionBuilder.fromXDR(signed, passphrase)
        if (rebuilt instanceof FeeBumpTransaction || !isAccountId(rebuilt.source)) return false
        const key = Keypair.fromPublicKey(rebuilt.source)
        const digest = rebuilt.hash()
        return rebuilt.signatures.some((s) => key.verify(digest, s.signature()))
      } catch {
        return false
      }
    }
    const sourceSigned = verifies(net)
    if (!sourceSigned && verifies(otherNet)) {
      return {
        ok: false,
        code: 'wrong_network',
        reason: `this envelope was signed for the other Stellar network, not ${chain.caip2}; nothing was forwarded`,
      }
    }
    return {
      ok: true,
      carrier: 'xdr',
      func: describeFunc(op.func),
      auth: (op.auth ?? []).map((a) => describeAuth(a)),
      envelope: { source: tx.source, signatures: tx.signatures.length, sourceSigned },
    }
  }

  if (typeof input.func !== 'string' || !input.func.trim()) return bad('func must be the base64 HostFunction XDR (or send xdr, a signed envelope)')
  if (!Array.isArray(input.auth) || input.auth.some((a) => typeof a !== 'string' || !a.trim())) {
    return bad('auth must be an array of base64 SorobanAuthorizationEntry XDR strings (empty is allowed only in form, never in substance)')
  }
  let func: xdr.HostFunction
  try {
    func = xdr.HostFunction.fromXDR(input.func.trim(), 'base64')
  } catch (e) {
    return bad(`func is not a HostFunction: ${e instanceof Error ? e.message : String(e)}`)
  }
  const auth: RelayAuth[] = []
  for (const [i, raw] of (input.auth as string[]).entries()) {
    try {
      auth.push(describeAuth(xdr.SorobanAuthorizationEntry.fromXDR(raw.trim(), 'base64')))
    } catch (e) {
      return bad(`auth[${i}] is not a SorobanAuthorizationEntry: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ok: true, carrier: 'func-auth', func: describeFunc(func), auth, envelope: null }
}
