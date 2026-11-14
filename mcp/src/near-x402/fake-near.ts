/**
 * A fake NEAR testnet for the x402 rail's tests, behind a stubbed fetch.
 *
 * It answers the JSON-RPC calls the rail makes (status, block, view_account, view_access_key,
 * call_function for ft_metadata, ft_balance_of and storage_balance_of, send_tx and tx) from a
 * small state, and it EXECUTES a relayed transaction the way nearcore does for the cases the
 * tests need: it checks the relayer's signature over sha256 of the transaction bytes and its
 * nonce (refusing a stale one with INVALID_TRANSACTION InvalidNonce, before inclusion), then runs
 * the Delegate (its window and its nonce), then the token's ft_transfer (balance and the
 * receiver's storage registration), and answers with a FINAL outcome in the shape the real hosts
 * give, logs included. Every send is recorded with the hash the fake computed itself, so a test
 * can hold the rail's own hash to it.
 *
 * The hosts are the registry descriptor's, so nothing here names a chain constant.
 */
import { createHash } from 'node:crypto'
import { PublicKey } from '@near-js/crypto'
import { decodeSignedTransaction } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { getChainById } from '../chains/registry.js'
import { NEAR_EMPTY_CODE_HASH } from '../chains/near/client.js'

export type FakeKey = { nonce: bigint; permission: 'FullAccess' | 'FunctionCall' }
export type FakeAccount = { amount?: string; code?: boolean; keys?: Record<string, FakeKey> }

export type FakeNearOptions = {
  height?: number
  accounts: Record<string, FakeAccount>
  /** The NEP-141 token account (the registry's Circle USDC). */
  token: string
  balances?: Record<string, bigint>
  /** Accounts with a NEP-145 storage registration on the token. */
  registered?: string[]
  /** How the token's ft_transfer ends when everything else is in order. */
  transfer?: 'ok' | 'panic' | 'no_event' | 'fake_event_elsewhere'
  /** How send_tx answers: FINAL (default), or a 408 timeout after which the transaction did or did not land. */
  send?: 'final' | 'timeout_landed' | 'timeout_lost'
  /** Refuse the next N sends with InvalidNonce (the ak_nonce the fake really holds), before inclusion. */
  refuseNonce?: number
  metadata?: { spec: string; symbol: string; decimals: number }
  chainId?: string
}

export type FakeSend = { hash: string; signerId: string; receiverId: string; nonce: bigint; relayerSignatureValid: boolean; outcome: 'final' | 'refused' | 'timeout' }

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'a-identity', result }), { status: 200, headers: { 'content-type': 'application/json' } })
const handlerError = (cause: string, info: unknown = {}, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 'a-identity', error: { name: 'HANDLER_ERROR', cause: { name: cause, info }, code: -32000, message: 'Server error', data: cause } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const pkString = (pk: { ed25519Key?: { data: ArrayLike<number> } }) => new PublicKey({ keyType: 0, data: Uint8Array.from(pk.ed25519Key?.data ?? []) }).toString()
const bytesJson = (v: unknown) => Array.from(Buffer.from(JSON.stringify(v)))
const blockHash = (height: number) => baseEncode(createHash('sha256').update(`block ${height}`).digest())
const receiptId = (tx: string, n: number) => baseEncode(createHash('sha256').update(`${tx} receipt ${n}`).digest())

export function fakeNear(o: FakeNearOptions) {
  const chain = getChainById('near-testnet')
  if (!chain) throw new Error('the registry carries no near-testnet')
  const hosts = new Set([...chain.rpcUrls, ...(chain.archivalRpcUrls ?? [])].map((u) => new URL(u).host))
  let height = o.height ?? 277_430_000
  const balances = new Map(Object.entries(o.balances ?? {}))
  const registered = new Set(o.registered ?? [])
  const txs = new Map<string, Record<string, unknown>>()
  /** Transactions that executed and that no host will admit to yet (send: 'timeout_lost'). */
  const hidden = new Map<string, Record<string, unknown>>()
  const sends: FakeSend[] = []
  const calls: { host: string; method: string; params: any }[] = []
  let refuseNonce = o.refuseNonce ?? 0

  function view(account: string, method: string, args: Record<string, unknown>): Response {
    if (account !== o.token) return ok({ error: `wasm execution failed: no method ${method}`, logs: [], block_height: height })
    if (method === 'ft_metadata') return ok({ result: bytesJson(o.metadata ?? { spec: 'ft-1.0.0', name: 'USDC', symbol: 'USDC', decimals: 6 }), logs: [], block_height: height })
    if (method === 'ft_balance_of') return ok({ result: bytesJson((balances.get(String(args.account_id)) ?? 0n).toString()), logs: [], block_height: height })
    if (method === 'storage_balance_of') {
      const r = registered.has(String(args.account_id)) ? { total: '1250000000000000000000', available: '0' } : null
      return ok({ result: bytesJson(r), logs: [], block_height: height })
    }
    return ok({ error: `MethodResolveError(MethodNotFound)`, logs: [], block_height: height })
  }

  /** Run one relayed transaction like nearcore: returns the FINAL view, or a refusal before inclusion. */
  function execute(signedB64: string): { refused?: Response; hash?: string } {
    const bytes = Buffer.from(signedB64, 'base64')
    const unsigned = bytes.subarray(0, bytes.length - 65)
    const digest = createHash('sha256').update(unsigned).digest()
    const hash = baseEncode(digest)
    const { transaction: t } = decodeSignedTransaction(bytes)
    const relayerPk = pkString(t.publicKey as never)
    const signer = o.accounts[t.signerId]
    const key = signer?.keys?.[relayerPk]
    const relayerSignatureValid = PublicKey.fromString(relayerPk).verify(new Uint8Array(digest), new Uint8Array(bytes.subarray(bytes.length - 64)))
    const record = (outcome: FakeSend['outcome']) => sends.push({ hash, signerId: t.signerId, receiverId: t.receiverId, nonce: t.nonce, relayerSignatureValid, outcome })
    if (!key || !relayerSignatureValid) {
      record('refused')
      return { refused: handlerError('INVALID_TRANSACTION', { error: { InvalidTxError: 'InvalidSignature' } }) }
    }
    if (refuseNonce > 0 || t.nonce <= key.nonce) {
      refuseNonce = Math.max(0, refuseNonce - 1)
      record('refused')
      return { refused: handlerError('INVALID_TRANSACTION', { error: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(t.nonce), ak_nonce: Number(key.nonce) } } } }) }
    }
    key.nonce = t.nonce
    const sd = (t.actions[0] as { signedDelegate?: any }).signedDelegate
    const da = sd.delegateAction
    const fc = da.actions[0]?.functionCall
    const args = JSON.parse(Buffer.from(fc.args).toString('utf8')) as { receiver_id: string; amount: string }
    const delegatePk = pkString(da.publicKey)
    const sender = o.accounts[da.senderId]
    const senderKey = sender?.keys?.[delegatePk]
    let delegateStatus: Record<string, unknown> = { SuccessReceiptId: receiptId(hash, 2) }
    let tokenOutcome: Record<string, unknown> | null = null
    if (!senderKey || senderKey.permission !== 'FullAccess' || BigInt(da.maxBlockHeight) < BigInt(height) || BigInt(da.nonce) <= senderKey.nonce) {
      delegateStatus = { Failure: { ActionError: { index: 0, kind: { DelegateActionInvalidNonce: { delegate_nonce: Number(da.nonce), ak_nonce: Number(senderKey?.nonce ?? 0n) } } } } }
    } else {
      senderKey.nonce = BigInt(da.nonce)
      const amount = BigInt(args.amount)
      const event = (to: string, value: string) =>
        `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: da.senderId, new_owner_id: to, amount: value }] })}`
      const can = (balances.get(da.senderId) ?? 0n) >= amount && registered.has(args.receiver_id) && o.transfer !== 'panic'
      if (!can) {
        // nearcore keeps a failed call's logs, so a failed receipt can still carry an event line.
        tokenOutcome = { executor_id: o.token, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account doesn\'t have enough balance' } } } } }, logs: [event(args.receiver_id, args.amount)] }
      } else {
        balances.set(da.senderId, (balances.get(da.senderId) ?? 0n) - amount)
        balances.set(args.receiver_id, (balances.get(args.receiver_id) ?? 0n) + amount)
        const logs = o.transfer === 'no_event' || o.transfer === 'fake_event_elsewhere' ? [] : [event(args.receiver_id, args.amount)]
        tokenOutcome = { executor_id: o.token, status: { SuccessValue: '' }, logs }
      }
    }
    height += 3
    const receipts: Record<string, unknown>[] = [
      { id: receiptId(hash, 1), block_hash: blockHash(height - 2), outcome: { executor_id: da.senderId, status: delegateStatus, logs: [] } },
      ...(tokenOutcome ? [{ id: receiptId(hash, 2), block_hash: blockHash(height - 1), outcome: tokenOutcome }] : []),
      ...(o.transfer === 'fake_event_elsewhere' && tokenOutcome
        ? [{ id: receiptId(hash, 4), block_hash: blockHash(height - 1), outcome: { executor_id: 'mimic-token.testnet', status: { SuccessValue: '' }, logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: da.senderId, new_owner_id: args.receiver_id, amount: args.amount }] })}`] } }]
        : []),
      { id: receiptId(hash, 3), block_hash: blockHash(height), outcome: { executor_id: t.signerId, status: { SuccessValue: '' }, logs: [] } },
    ]
    const result = {
      final_execution_status: 'FINAL',
      status: 'Failure' in delegateStatus ? delegateStatus : { SuccessValue: '' },
      transaction: {
        hash,
        signer_id: t.signerId,
        receiver_id: t.receiverId,
        public_key: relayerPk,
        nonce: Number(t.nonce),
        priority_fee: 0,
        signature: 'ed25519-signature-not-kept-by-this-fake',
        actions: [
          {
            Delegate: {
              delegate_action: {
                sender_id: da.senderId,
                receiver_id: da.receiverId,
                actions: [{ FunctionCall: { method_name: fc.methodName, args: Buffer.from(fc.args).toString('base64'), gas: Number(fc.gas), deposit: String(fc.deposit) } }],
                nonce: Number(da.nonce),
                max_block_height: Number(da.maxBlockHeight),
                public_key: delegatePk,
              },
              signature: 'ed25519-signature-not-kept-by-this-fake',
            },
          },
        ],
      },
      transaction_outcome: { id: hash, block_hash: blockHash(height - 3), outcome: { executor_id: t.signerId, status: { SuccessReceiptId: receiptId(hash, 1) }, logs: [] } },
      receipts_outcome: receipts,
    }
    txs.set(hash, result)
    record(o.send === 'timeout_landed' || o.send === 'timeout_lost' ? 'timeout' : 'final')
    return { hash }
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input)).host
    if (!hosts.has(host)) throw new Error(`the fake has no host ${host}`)
    const body = JSON.parse(String(init?.body)) as { method: string; params: any }
    calls.push({ host, method: body.method, params: body.params })
    const p = body.params
    switch (body.method) {
      case 'status':
        return ok({ chain_id: o.chainId ?? 'testnet', protocol_version: 88, sync_info: { latest_block_height: height + 2, syncing: false } })
      case 'block':
        return ok({ header: { height, hash: blockHash(height) } })
      case 'query': {
        const acct = o.accounts[p.account_id]
        if (p.request_type === 'view_account') {
          if (!acct && p.account_id !== o.token) return handlerError('UNKNOWN_ACCOUNT')
          const code = p.account_id === o.token || acct?.code
          return ok({ amount: acct?.amount ?? '1000000000000000000000000', code_hash: code ? 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z' : NEAR_EMPTY_CODE_HASH, storage_usage: 182, block_height: height })
        }
        if (p.request_type === 'view_access_key') {
          if (!acct) return handlerError('UNKNOWN_ACCOUNT')
          const k = acct.keys?.[p.public_key]
          if (!k) return ok({ error: `access key ${p.public_key} does not exist while viewing`, logs: [], block_height: height })
          return ok({ nonce: Number(k.nonce), permission: k.permission === 'FullAccess' ? 'FullAccess' : { FunctionCall: { allowance: '1', receiver_id: 'x.testnet', method_names: [] } }, block_height: height })
        }
        if (p.request_type === 'call_function') {
          return view(p.account_id, p.method_name, JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8')) as Record<string, unknown>)
        }
        return handlerError('PARSE_ERROR')
      }
      case 'send_tx': {
        const r = execute(p.signed_tx_base64)
        if (r.refused) return r.refused
        if (o.send === 'timeout_landed' || o.send === 'timeout_lost') {
          if (o.send === 'timeout_lost') {
            hidden.set(r.hash!, txs.get(r.hash!)!)
            txs.delete(r.hash!)
          }
          return handlerError('TIMEOUT_ERROR', {}, 408)
        }
        return ok(txs.get(r.hash!))
      }
      case 'tx': {
        const found = txs.get(p.tx_hash)
        return found ? ok(found) : handlerError('UNKNOWN_TRANSACTION')
      }
      default:
        return handlerError('METHOD_NOT_FOUND')
    }
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    sends,
    calls,
    balances,
    /** Let a hidden transaction appear, as one that landed after its send timed out does. */
    reveal(hash: string) {
      const r = hidden.get(hash)
      if (r) txs.set(hash, r)
    },
    tx: (hash: string) => txs.get(hash),
    get height() {
      return height
    },
  }
}
