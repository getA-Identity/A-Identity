// A small NEAR JSON-RPC client on the global fetch, with no dependencies.
//
// Reads fail over across endpoints only when the endpoint itself failed: a transport error, an
// HTTP 5xx or 429, a JSON-RPC -429, or an INTERNAL_ERROR. A decided answer (UNKNOWN_ACCOUNT, a
// contract panic, an invalid transaction) is final and is thrown as RpcAnswerError, so a "no"
// from one node is never retried until some node says "yes". Nothing is logged here.
//
// Writes (send_tx) go to one endpoint, once. Resubmitting a signed transaction to another node
// after a timeout can land it twice in the log of attempts; the sender polls by hash instead.
//
// Method names: the EXPERIMENTAL_ forms (EXPERIMENTAL_tx_status) work on every tested provider,
// while dRPC rejects the newer tx_status name.

import { Buffer } from 'node:buffer';

export type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

export type JsonRpcErrorBody = {
  name?: string;
  code?: number;
  message?: string;
  data?: unknown;
  cause?: { name?: string; info?: unknown };
};

/** nearcore's cause name plus the one detail that says what was wrong (which account, which
 * contract, which VM error), instead of the generic "Server error". */
export function describeRpcError(e: JsonRpcErrorBody): string {
  const cause = e.cause?.name ?? e.name ?? 'error';
  const info = (e.cause?.info ?? {}) as Record<string, unknown>;
  const account = info.requested_account_id ?? info.contract_account_id ?? info.account_id;
  const vm = info.vm_error ?? info.error;
  const detail =
    cause === 'UNKNOWN_ACCOUNT' && typeof account === 'string'
      ? `: ${account} does not exist on this network`
      : cause === 'NO_CONTRACT_CODE' && typeof account === 'string'
        ? `: ${account} has no contract deployed`
        : vm !== undefined
          ? `: ${String(typeof vm === 'string' ? vm : JSON.stringify(vm)).slice(0, 300)}`
          : typeof e.data === 'string'
            ? `: ${e.data.slice(0, 300)}`
            : '';
  return `${cause}${detail}`;
}

export class RpcAnswerError extends Error {
  readonly method: string;
  readonly endpoint: string;
  readonly rpcError: JsonRpcErrorBody;
  constructor(method: string, endpoint: string, rpcError: JsonRpcErrorBody) {
    super(`${method} on ${endpoint}: ${describeRpcError(rpcError)}`);
    this.name = 'RpcAnswerError';
    this.method = method;
    this.endpoint = endpoint;
    this.rpcError = rpcError;
  }
  get causeName(): string {
    return this.rpcError.cause?.name ?? this.rpcError.name ?? '';
  }
}

export class RpcTransportError extends Error {
  readonly method: string;
  readonly attempts: string[];
  constructor(method: string, attempts: string[]) {
    super(`${method}: no endpoint answered (${attempts.join('; ')})`);
    this.name = 'RpcTransportError';
    this.method = method;
    this.attempts = attempts;
  }
}

export type Route = 'read' | 'send' | 'archival';

export type RpcClient = {
  call<T>(method: string, params: unknown, route?: Route): Promise<T>;
  readonly endpoints: { read: string[]; send: string; archival: string };
};

export type RpcOptions = {
  readUrls: string[];
  sendUrl: string;
  archivalUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Extra rounds over the read endpoints after all of them failed, with this wait between. */
  rounds?: number;
  roundWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An error that says the endpoint failed, not that the chain answered "no". */
export function isEndpointFailure(err: JsonRpcErrorBody): boolean {
  if (err.code === -429) return true;
  const names = [err.name, err.cause?.name];
  return names.includes('INTERNAL_ERROR') || names.includes('TOO_MANY_REQUESTS');
}

export function createRpc(opts: RpcOptions): RpcClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const rounds = opts.rounds ?? 2;
  const roundWaitMs = opts.roundWaitMs ?? 1_500;
  const sleep = opts.sleep ?? defaultSleep;
  let nextId = 1;

  async function once<T>(url: string, method: string, params: unknown): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: `aid-${nextId++}`, method, params });
    let res: FetchResponse;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, why: `${url}: ${(e as Error).message}` };
    }
    if (res.status === 429 || res.status >= 500) return { ok: false, why: `${url}: HTTP ${res.status}` };
    let parsed: { result?: T; error?: JsonRpcErrorBody };
    try {
      parsed = JSON.parse(await res.text()) as { result?: T; error?: JsonRpcErrorBody };
    } catch {
      return { ok: false, why: `${url}: HTTP ${res.status}, body is not JSON` };
    }
    if (parsed.error) {
      if (isEndpointFailure(parsed.error)) return { ok: false, why: `${url}: ${parsed.error.cause?.name ?? parsed.error.name ?? parsed.error.code}` };
      throw new RpcAnswerError(method, url, parsed.error);
    }
    if (!res.ok) return { ok: false, why: `${url}: HTTP ${res.status}` };
    return { ok: true, value: parsed.result as T };
  }

  async function call<T>(method: string, params: unknown, route: Route = 'read'): Promise<T> {
    const attempts: string[] = [];
    if (route === 'send') {
      const r = await once<T>(opts.sendUrl, method, params);
      if (r.ok) return r.value;
      throw new RpcTransportError(method, [r.why]);
    }
    const urls = route === 'archival' ? [opts.archivalUrl] : opts.readUrls;
    for (let round = 0; round <= rounds; round++) {
      if (round > 0) await sleep(roundWaitMs * round);
      for (const url of urls) {
        const r = await once<T>(url, method, params);
        if (r.ok) return r.value;
        attempts.push(r.why);
      }
    }
    throw new RpcTransportError(method, attempts);
  }

  return { call, endpoints: { read: [...opts.readUrls], send: opts.sendUrl, archival: opts.archivalUrl } };
}

// -- views ---------------------------------------------------------------------------------

export type BlockRef = { finality: 'final' | 'optimistic' } | { block_id: number | string };

type CallFunctionResult = { result?: number[]; logs?: string[]; block_height?: number; block_hash?: string; error?: string };

/** A contract view. Returns the decoded JSON, `null` for a JSON null (Option::None) and
 * `undefined` for an empty result. */
export async function viewFunction<T>(
  rpc: RpcClient,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  ref: BlockRef = { finality: 'final' },
): Promise<T | null | undefined> {
  const r = await rpc.call<CallFunctionResult>('query', {
    request_type: 'call_function',
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    ...ref,
  });
  if (typeof r.error === 'string') {
    // Older nodes report a contract panic inside the result instead of as an RPC error.
    throw new RpcAnswerError('query', 'call_function', { name: 'HANDLER_ERROR', cause: { name: 'CONTRACT_EXECUTION_ERROR', info: { error: r.error } } });
  }
  const bytes = r.result ?? [];
  if (bytes.length === 0) return undefined;
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as T | null;
}

export type AccessKeyPermission =
  | 'FullAccess'
  | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };

export type AccessKeyInfo = { nonce: bigint; permission: AccessKeyPermission; blockHash: string; blockHeight: number };

export async function viewAccessKey(
  rpc: RpcClient,
  accountId: string,
  publicKey: string,
  finality: 'final' | 'optimistic' = 'optimistic',
): Promise<AccessKeyInfo> {
  const r = await rpc.call<{ nonce: number | string; permission: AccessKeyPermission; block_hash: string; block_height: number }>('query', {
    request_type: 'view_access_key',
    finality,
    account_id: accountId,
    public_key: publicKey,
  });
  return { nonce: BigInt(r.nonce), permission: r.permission, blockHash: r.block_hash, blockHeight: r.block_height };
}

export type AccountView = { amount: string; locked: string; code_hash: string; storage_usage: number; block_height: number };

/** view_account at the latest final block; null when the account does not exist (UNKNOWN_ACCOUNT). */
export async function viewAccount(rpc: RpcClient, accountId: string): Promise<AccountView | null> {
  try {
    return await rpc.call<AccountView>('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  } catch (e) {
    if (e instanceof RpcAnswerError && e.causeName === 'UNKNOWN_ACCOUNT') return null;
    throw e;
  }
}

export async function viewAccessKeyList(
  rpc: RpcClient,
  accountId: string,
): Promise<Array<{ publicKey: string; permission: AccessKeyPermission }>> {
  const r = await rpc.call<{ keys: Array<{ public_key: string; access_key: { permission: AccessKeyPermission } }> }>('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: accountId,
  });
  return r.keys.map((k) => ({ publicKey: k.public_key, permission: k.access_key.permission }));
}

export async function finalBlock(rpc: RpcClient): Promise<{ hash: string; height: number; timestampNs: string }> {
  const r = await rpc.call<{ header: { hash: string; height: number; timestamp_nanosec?: string; timestamp?: number } }>('block', {
    finality: 'final',
  });
  return { hash: r.header.hash, height: r.header.height, timestampNs: String(r.header.timestamp_nanosec ?? r.header.timestamp ?? '0') };
}

export async function txStatus(
  rpc: RpcClient,
  txHash: string,
  senderId: string,
  waitUntil: 'NONE' | 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'EXECUTED' | 'FINAL' = 'FINAL',
  route: Route = 'read',
): Promise<unknown> {
  return rpc.call<unknown>('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil }, route);
}

/** The token balance of an account, or null when the account is not registered on the token. */
export async function ftBalance(rpc: RpcClient, tokenId: string, accountId: string): Promise<bigint | null> {
  const v = await viewFunction<string>(rpc, tokenId, 'ft_balance_of', { account_id: accountId });
  return v == null ? null : BigInt(v);
}
