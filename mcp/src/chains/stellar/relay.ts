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
import type { RelayAuth, RelayFunc, RelayInspection, RelayInvocation } from './relay-shape.js'

export type { RelayAuth, RelayFunc, RelayInspection, RelayInvocation } from './relay-shape.js'

/** A value the SDK can render natively, or its base64 ScVal when it cannot. */
function native(v: xdr.ScVal): unknown {
  try {
    const n: unknown = scValToNative(v)
    return typeof n === 'bigint' ? n.toString() : n
  } catch {
    return v.toXDR('base64')
  }
}

function describeCreateV2(create: xdr.CreateContractArgsV2): { wasmHash: string | null; deployer: string | null; createXdr: string; constructorArgs: number } {
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
  return { wasmHash, deployer, createXdr: create.toXDR('base64'), constructorArgs: create.constructorArgs().length }
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
