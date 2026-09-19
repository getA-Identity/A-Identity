/**
 * What a fee-sponsoring relay request CONTAINS, described in plain strings.
 *
 * Deliberately free of `@stellar/stellar-sdk`, even as a type. `relay.ts` is the one place
 * that decodes the XDR into this shape, and `mcp/src/stellar-passkey.ts` decides over it
 * without the SDK in scope, the same split `stellar-vault.ts` keeps with the adapter. Both
 * import from here, so the two cannot drift on what an inspection looks like.
 *
 * Every `*Xdr` field is the base64 of the decoded structure re-encoded, kept so a decision
 * can ask "is this authorization entry FOR this host function" by byte equality rather than
 * by re-deriving semantics that the host defines and we do not.
 */

/** One node of an authorization tree, or the host function itself, as a plain record. */
export type RelayInvocation =
  | { kind: 'contract-fn'; contract: string; method: string; argsXdr: string }
  | { kind: 'create-contract-v2'; wasmHash: string | null; createXdr: string }
  | { kind: 'create-contract'; createXdr: string }

/** One SorobanAuthorizationEntry: who authorizes, and the exact tree they authorize. */
export type RelayAuth = {
  /** `address` is a signed entry for a named address; `source-account` defers to the
   *  envelope's signature, which on a relayer-built envelope is the RELAYER's account. */
  credentials: 'address' | 'source-account' | 'other'
  /** The authorizing address, for address credentials. Null otherwise. */
  address: string | null
  root: RelayInvocation
  /** Every invocation below the root, depth first, flattened. */
  sub: RelayInvocation[]
}

/** The host function the relayer is asked to wrap in a transaction and pay for. */
export type RelayFunc =
  | {
      kind: 'create-contract-v2'
      /** Hex sha256 of the wasm the new contract would run; null when the executable is not wasm. */
      wasmHash: string | null
      /** The address the contract id derives from, when the preimage is address based. */
      deployer: string | null
      createXdr: string
      constructorArgs: number
    }
  | {
      kind: 'invoke'
      contract: string
      method: string
      /** Arguments decoded to plain values where the SDK can; a base64 ScVal where it cannot. */
      args: unknown[]
      argsXdr: string
      /** Present when this is a smart account's `execute(target, target_fn, target_args)`. */
      execute: { target: string; targetFn: string; targetArgs: unknown[] } | null
    }
  | { kind: 'other'; what: string }

export type RelayInspection =
  | { ok: false; code: 'bad_request' | 'wrong_network'; reason: string }
  | {
      ok: true
      /** `func-auth` is the kit's `{ func, auth }`; `xdr` is a whole signed envelope to fee-bump. */
      carrier: 'func-auth' | 'xdr'
      func: RelayFunc
      auth: RelayAuth[]
      /** Only on the `xdr` carrier: the envelope's own facts. */
      envelope: { source: string; signatures: number; sourceSigned: boolean } | null
    }
