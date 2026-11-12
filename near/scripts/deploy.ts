// Keyless deploy of A-Identity's NEAR contracts: testnet executed step by step, mainnet printed
// as commands the owner runs with their own signer.
//
// The steps, in order (each one is a --step):
//
//   registry        ONE batch transaction signed by the registry's parent: CreateAccount, Transfer
//                   (storage stake of the wasm + state + a margin), DeployContract, FunctionCall new.
//                   No AddKey, so the registry account ends with zero access keys.
//   oracle-key      the oracle's function-call key on the registry (set_verdict, set_verdicts,
//                   clear_verdict, clear_reports, a finite allowance). Its secret is generated here
//                   and saved 0600 in the near-cli legacy keychain BEFORE the key is added. The
//                   oracle's full-access key is deleted, signed by itself, only after the new key is
//                   confirmed on chain with exactly that permission AND the stored secret re-derives
//                   that public key (lockoutGate). Without both, nothing is deleted.
//   vault           ONE batch signed by the vault's parent (its owner): CreateAccount, Transfer
//                   (stake + state + a NEAR float for the agent's gas), DeployContract,
//                   FunctionCall new with the policy and the token's storage deposit read live.
//                   No AddKey.
//   vault-register  register_with_token, only when the token does not know the vault yet (new
//                   registers it itself when the vault can pay for it).
//   vault-policy    the policy as recorded (or as initialized) must be the one on chain. Without
//                   --daily-cap / --auto-approve-max nothing is sent and a difference stops the
//                   step; set_policy (and set_hold_unknown true) only for those explicit flags.
//   vault-fund      ONE ft_transfer_call of --fund from the owner to a vault that holds 0 USDC;
//                   the vault's ft_on_transfer keeps its own token and emits deposited. A vault
//                   that holds USDC with no funding transaction recorded is a RECORD GAP, never a
//                   second funding. --top-up is the only way to send more (recorded apart).
//   agent-key       add_agent_key with a key generated here and saved 0600 first.
//   verify          the end state read back: key lists, code hashes, get_config, oracles.
//
// Every step reads the chain first and skips what is already done; anything it cannot explain
// (a wrong code hash, a key nobody asked for, a record that disagrees with the chain) stops it.
// A transaction hash is recorded only for a transaction this script sent and saw final, or one
// named with --adopt-tx and checked on archival RPC. Facts read from the chain (code hash, key
// counts, policy) are recorded from view calls at finality final. A step the chain shows as
// done whose transaction the record does not hold (a deploy made by another run) is a RECORD
// GAP until that transaction is adopted.
//
// Modes: --dry-run (the default) reads the chain and prints every transaction it would send,
// signing nothing; --execute signs and sends (testnet only); --record-only sends nothing and
// writes the record from the chain and adopted transactions. --network mainnet never signs and
// never opens ~/.near-credentials/mainnet: it prints near-cli-rs 0.31.1 commands, each labeled
// "prepared, not executed (mainnet: the owner signs)".
//
// Key hygiene: no secret key or seed phrase is ever printed, logged, returned or written into
// the repository (a key folder inside the git work tree is refused). Existing key files are
// inspected for their public_key field only; a stored secret is read only to derive its public
// key in memory or to sign.
//
// Usage (from near/):
//   node --experimental-strip-types scripts/deploy.ts [--dry-run | --execute | --record-only] [options]
// Exit status: 0 success, 1 a step failed, a check mismatched or --execute would be refused,
// 2 a usage or setup error.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { JsonRpcProvider } from 'near-api-js';
import { EXPOSED_PUBLIC_KEYS } from '../demo/lib/keys.ts';
import { displayPath } from '../demo/lib/paths.ts';
import { AGENT_METHODS, MAX_GUARD_PAYEES, MAX_PENDING_HELD, MAX_REFUSAL_PAYEES, ORACLE_METHODS, VAULT_GAS_TGAS } from '../sdk/src/chain/abi.ts';
import type { LoadedKey } from '../sdk/src/chain/keys.ts';
import { parseOutcome, waitFinal } from '../sdk/src/chain/outcome.ts';
import type { TxOutcome } from '../sdk/src/chain/outcome.ts';
import { NETWORKS } from '../sdk/src/collect/networks.ts';
import { createReader, RpcAnswerError } from '../sdk/src/collect/rpc.ts';
import type { RpcReader } from '../sdk/src/collect/rpc.ts';
import { isValidAccountId } from '../sdk/src/engine/account.ts';

// -- constants -------------------------------------------------------------------------------

/** near/: this file is near/scripts/deploy.ts. */
export const NEAR_ROOT = fileURLToPath(new URL('../', import.meta.url));

export const ONE_NEAR = 10n ** 24n;
/** NEAR's storage price, storage_amount_per_byte: 1 NEAR per 100 kB. */
export const YOCTO_PER_BYTE = 10n ** 19n;
const CENTI_NEAR = 10n ** 22n;
export const ZERO_CODE_HASH = '11111111111111111111111111111111';

/** Bytes set aside for a contract's own state on top of its code (init writes a few hundred). */
export const STATE_ALLOWANCE_BYTES = 10_000;
/** The registry pays for the verdicts it stores: 901 bytes for one with every field at its limit (registry lib.rs). */
export const MAX_VERDICT_BYTES = 901;
/** Prepaid gas for each init call (new). Unused gas is refunded. */
export const INIT_GAS_TGAS = 100;
/** ft_transfer_call: the token, the vault's ft_on_transfer and the token's ft_resolve_transfer. */
export const FUND_GAS_TGAS = 100;
/** Kept free on a signer for a transaction's gas: 300 Tgas at the 0.001 NEAR per Tgas purchase price. */
export const GAS_RESERVE = (3n * ONE_NEAR) / 10n;
/** Prepaid gas is bought at max(gas price, this) since protocol 85: 0.001 NEAR per Tgas. */
const GAS_PURCHASE_YOCTO_PER_TGAS = ONE_NEAR / 1000n;
/** The vault's STORAGE_HEADROOM (lib.rs): 0.01 NEAR kept free above its stake. */
const STORAGE_HEADROOM = ONE_NEAR / 100n;
/** A held payment costs at most about 0.005 NEAR of stake (lib.rs, "Storage is bounded"). */
const HELD_ENTRY_YOCTO = ONE_NEAR / 200n;
/** A refusal counter of a 64-byte payee id: 113 bytes (lib.rs). */
const COUNTER_BYTES = 113n;
/** Measured in the hardening run: an ALLOW payment burns about 14 Tgas; the agent prepays 73. */
export const ALLOW_PAYMENT_BURN_TGAS = 14n;
export const AGENT_LABEL = 'a-identity demo agent';

export const STEPS = ['registry', 'oracle-key', 'vault', 'vault-register', 'vault-policy', 'vault-fund', 'agent-key', 'verify'] as const;
export type StepName = (typeof STEPS)[number];
export type Network = 'testnet' | 'mainnet';
export type Mode = 'dry-run' | 'execute' | 'record-only';
export type Env = Record<string, string | undefined>;

export const WASM_FILES = { registry: 'a_identity_registry.wasm', vault: 'agent_spend_policy.wasm' } as const;
export const CRATES = { registry: 'a-identity-registry', vault: 'agent-spend-policy' } as const;
export const MAINNET_LABEL = 'prepared, not executed (mainnet: the owner signs)';
export const DRY_RUN_LABEL = 'prepared, not executed (dry run)';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// -- small helpers -----------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errName(e: unknown): string {
  if (e instanceof Error) return e.constructor.name !== 'Error' ? e.constructor.name : e.name;
  return 'Error';
}

export function argsBase64(args: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(args)).toString('base64');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** "0.25" in a unit with `decimals` decimals, exactly. Refuses more decimals than the unit has. */
export function parseDecimal(text: string, decimals: number, what: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new UsageError(`${what}: not a plain decimal amount: ${JSON.stringify(text)}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new UsageError(`${what}: ${text} has more than ${decimals} decimals`);
  return BigInt(m[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatDecimal(units: bigint, decimals: number, minFrac = 0): string {
  const base = 10n ** BigInt(decimals);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  let frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

export const nearText = (yocto: bigint): string => `${formatDecimal(yocto, 24)} NEAR`;
export const usdcText = (units: bigint): string => `${formatDecimal(units, 6, 2)} USDC`;

function ceilTo(x: bigint, step: bigint): bigint {
  return ((x + step - 1n) / step) * step;
}

/** The parent of a named sub-account ("registry.a-identity.testnet" gives "a-identity.testnet"), or
 * null for a top-level account, which only a registrar can create. */
export function parentOf(id: string): string | null {
  const i = id.indexOf('.');
  if (i <= 0) return null;
  const parent = id.slice(i + 1);
  return parent.includes('.') ? parent : null;
}

function getIn(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const p of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setIn(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] ?? ''] = value;
}

/** Leaf paths whose value differs between two JSON values (for printing what a write changes). */
export function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

// -- wasm and the hash gate -----------------------------------------------------------------

export type Wasm = { name: string; path: string; bytes: Uint8Array; size: number; hex: string; b58: string };

export function readWasm(path: string): Wasm {
  const bytes = readFileSync(path);
  const digest = createHash('sha256').update(bytes).digest();
  return { name: basename(path), path, bytes: new Uint8Array(bytes), size: bytes.length, hex: digest.toString('hex'), b58: base58(digest) };
}

export type HashGate = { verified: boolean; detail: string };

/** hashes.json is the CI reproducible job's output: [{file, bytes, sha256_hex, sha256_base58}]. */
export function checkHashes(dir: string, wasms: readonly Wasm[]): HashGate {
  const file = join(dir, 'hashes.json');
  if (!existsSync(file)) return { verified: false, detail: `${displayPath(file)} is missing (it is the near.yml reproducible job's output)` };
  let rows: unknown;
  try {
    rows = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { verified: false, detail: `${displayPath(file)} is not valid JSON` };
  }
  if (!Array.isArray(rows)) return { verified: false, detail: `${displayPath(file)} is not a list of {file, bytes, sha256_hex, sha256_base58}` };
  const problems: string[] = [];
  for (const w of wasms) {
    const row = rows.find((r: unknown) => isObj(r) && r.file === w.name);
    if (!isObj(row)) {
      problems.push(`no entry for ${w.name}`);
      continue;
    }
    if (row.bytes !== w.size) problems.push(`${w.name}: hashes.json says ${String(row.bytes)} bytes, the file has ${w.size}`);
    if (row.sha256_hex !== w.hex) problems.push(`${w.name}: hashes.json says sha256 ${String(row.sha256_hex)}, the file hashes to ${w.hex}`);
    if (row.sha256_base58 !== w.b58) problems.push(`${w.name}: hashes.json says base58 ${String(row.sha256_base58)}, the file gives ${w.b58}`);
  }
  if (problems.length) return { verified: false, detail: `${displayPath(file)} does not match: ${problems.join('; ')}` };
  return { verified: true, detail: `${displayPath(file)} matches both files (bytes, sha256 hex and base58)` };
}

// -- arithmetic --------------------------------------------------------------------------------

export type Funding = { total: bigint; lines: string[]; minimumFloat?: bigint };

export function registryFunding(wasmBytes: number, margin: bigint): Funding {
  const code = BigInt(wasmBytes) * YOCTO_PER_BYTE;
  const state = BigInt(STATE_ALLOWANCE_BYTES) * YOCTO_PER_BYTE;
  const exact = code + state + margin;
  const total = ceilTo(exact, CENTI_NEAR);
  const perVerdict = BigInt(MAX_VERDICT_BYTES) * YOCTO_PER_BYTE;
  return {
    total,
    lines: [
      `code    ${wasmBytes} bytes x 1 NEAR per 100000 bytes = ${nearText(code)}`,
      `state   ${STATE_ALLOWANCE_BYTES} bytes for the contract's own state (owner, oracle set) = ${nearText(state)}`,
      `margin  ${nearText(margin)} for the verdicts the registry stores and pays for: ${MAX_VERDICT_BYTES} bytes (${nearText(perVerdict)}) for one at its size limit, so about ${margin / perVerdict} of them`,
      `total   ${nearText(exact)}, rounded up to ${nearText(total)} = ${total} yoctoNEAR`,
    ],
  };
}

export function vaultFunding(wasmBytes: number, float: bigint, agentAllowance: bigint, tokenStorage: bigint, gasPricePerGas: bigint | null): Funding {
  const code = BigInt(wasmBytes) * YOCTO_PER_BYTE;
  const state = BigInt(STATE_ALLOWANCE_BYTES) * YOCTO_PER_BYTE;
  const exact = code + state + float;
  const total = ceilTo(exact, CENTI_NEAR);
  const held = BigInt(MAX_PENDING_HELD) * HELD_ENTRY_YOCTO;
  const counters = BigInt(MAX_GUARD_PAYEES + MAX_REFUSAL_PAYEES) * COUNTER_BYTES * YOCTO_PER_BYTE;
  const minimumFloat = agentAllowance + held + counters + STORAGE_HEADROOM + tokenStorage;
  const inFlight = BigInt(VAULT_GAS_TGAS.pay) * GAS_PURCHASE_YOCTO_PER_TGAS;
  const price = gasPricePerGas ?? 100_000_000n;
  const burnt = ALLOW_PAYMENT_BURN_TGAS * 10n ** 12n * price;
  const payments = agentAllowance > inFlight && burnt > 0n ? (agentAllowance - inFlight) / burnt : 0n;
  const lines = [
    `code    ${wasmBytes} bytes x 1 NEAR per 100000 bytes = ${nearText(code)}`,
    `state   ${STATE_ALLOWANCE_BYTES} bytes for the vault's own state (config, agent record) = ${nearText(state)}`,
    `float   ${nearText(float)} of liquid NEAR for the agent's gas and the vault's bounded storage; it must cover at least:`,
    `          agent key allowance (the most the key can burn)   ${nearText(agentAllowance)}`,
    `          held payments, ${MAX_PENDING_HELD} x ${nearText(HELD_ENTRY_YOCTO)}                     ${nearText(held)}`,
    `          refusal counters, ${MAX_GUARD_PAYEES + MAX_REFUSAL_PAYEES} x ${COUNTER_BYTES} bytes               ${nearText(counters)}`,
    `          STORAGE_HEADROOM                                   ${nearText(STORAGE_HEADROOM)}`,
    `          the vault's own token registration                 ${nearText(tokenStorage)}`,
    `          minimum ${nearText(minimumFloat)}; ${float >= minimumFloat ? `${nearText(float - minimumFloat)} left for payees' token registrations (${nearText(tokenStorage)} each)` : 'the float is BELOW it'}`,
    `          per payment: ${VAULT_GAS_TGAS.pay} Tgas prepaid holds ${nearText(inFlight)} of the allowance while in flight; an ALLOW payment burns about ${ALLOW_PAYMENT_BURN_TGAS} Tgas = ${nearText(burnt)} at ${gasPricePerGas === null ? 'the minimum gas price' : 'the current gas price'} (${price} yocto per gas), so the allowance runs about ${payments} payments`,
    `total   ${nearText(exact)}, rounded up to ${nearText(total)} = ${total} yoctoNEAR`,
  ];
  return { total, lines, minimumFloat };
}

// -- chain -------------------------------------------------------------------------------------

export type Permission =
  | { kind: 'FullAccess' }
  | { kind: 'FunctionCall'; receiverId: string; methodNames: string[]; allowance: bigint | null }
  | { kind: 'Other'; raw: unknown };
export type KeyView = { publicKey: string; permission: Permission };
export type AccountView = { amount: bigint; locked: bigint; codeHash: string; storageUsage: number };
/** A transaction read back by hash: the raw RPC answer, its parsed outcome, the inclusion block. */
export type TxRecordView = { raw: Record<string, unknown>; outcome: TxOutcome; final: boolean; blockHeight: number | null };

export type ChainPort = {
  account(id: string): Promise<AccountView | null>;
  keys(id: string): Promise<KeyView[]>;
  key(id: string, publicKey: string): Promise<KeyView | null>;
  view(contractId: string, method: string, args?: Record<string, unknown>): Promise<unknown>;
  /** yoctoNEAR per gas unit, or null when it cannot be read. */
  gasPrice(): Promise<bigint | null>;
  /** EXPERIMENTAL_tx_status of a transaction (archival), null when the chain does not know it. */
  tx(hash: string, senderId: string): Promise<TxRecordView | null>;
  readonly endpoints: string;
};

export function normalizePermission(p: unknown): Permission {
  if (p === 'FullAccess') return { kind: 'FullAccess' };
  if (isObj(p) && isObj(p.FunctionCall)) {
    const fc = p.FunctionCall;
    const names = Array.isArray(fc.method_names) ? fc.method_names.filter((m): m is string => typeof m === 'string') : [];
    return {
      kind: 'FunctionCall',
      receiverId: String(fc.receiver_id),
      methodNames: names,
      allowance: fc.allowance === null || fc.allowance === undefined ? null : BigInt(String(fc.allowance)),
    };
  }
  return { kind: 'Other', raw: p };
}

export function rpcChain(network: Network, reader?: RpcReader): ChainPort {
  const cfg = NETWORKS[network];
  const r = reader ?? createReader({ rpc: cfg.rpc, archival: cfg.archival });
  const query = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { result } = await r.call('query', { finality: 'final', ...params });
    return isObj(result) ? result : {};
  };
  const decided = (e: unknown, ...names: string[]) => e instanceof RpcAnswerError && names.includes(e.causeName);
  return {
    endpoints: `${cfg.rpc.join(', ')} (archival ${cfg.archival[0] ?? 'none'})`,
    async account(id) {
      try {
        const v = await query({ request_type: 'view_account', account_id: id });
        return { amount: BigInt(String(v.amount)), locked: BigInt(String(v.locked ?? '0')), codeHash: String(v.code_hash), storageUsage: Number(v.storage_usage) };
      } catch (e) {
        if (decided(e, 'UNKNOWN_ACCOUNT')) return null;
        throw e;
      }
    },
    async keys(id) {
      try {
        const v = await query({ request_type: 'view_access_key_list', account_id: id });
        const list = Array.isArray(v.keys) ? v.keys : [];
        return list.filter(isObj).map((k) => ({ publicKey: String(k.public_key), permission: normalizePermission(isObj(k.access_key) ? k.access_key.permission : undefined) }));
      } catch (e) {
        if (decided(e, 'UNKNOWN_ACCOUNT')) return [];
        throw e;
      }
    },
    async key(id, publicKey) {
      try {
        const v = await query({ request_type: 'view_access_key', account_id: id, public_key: publicKey });
        return { publicKey, permission: normalizePermission(v.permission) };
      } catch (e) {
        if (decided(e, 'UNKNOWN_ACCESS_KEY', 'UNKNOWN_ACCOUNT')) return null;
        throw e;
      }
    },
    async view(contractId, method, args = {}) {
      const v = await query({ request_type: 'call_function', account_id: contractId, method_name: method, args_base64: argsBase64(args) });
      const bytes = Array.isArray(v.result) ? (v.result as number[]) : [];
      if (bytes.length === 0) return undefined;
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    },
    async gasPrice() {
      try {
        const { result } = await r.call('gas_price', { block_id: null });
        return isObj(result) && result.gas_price !== undefined ? BigInt(String(result.gas_price)) : null;
      } catch {
        return null;
      }
    },
    async tx(hash, senderId) {
      let raw: unknown;
      try {
        ({ result: raw } = await r.call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: senderId, wait_until: 'NONE' }, { archival: true }));
      } catch (e) {
        if (decided(e, 'UNKNOWN_TRANSACTION', 'UNKNOWN_ACCOUNT', 'INVALID_ACCOUNT', 'PARSE_ERROR')) return null;
        throw e;
      }
      if (!isObj(raw) || !isObj(raw.transaction)) return null;
      const final = raw.final_execution_status === 'FINAL';
      let blockHeight: number | null = null;
      const blockHash = isObj(raw.transaction_outcome) ? raw.transaction_outcome.block_hash : undefined;
      if (typeof blockHash === 'string') {
        try {
          const { result: block } = await r.call('block', { block_id: blockHash }, { archival: true });
          const h = isObj(block) && isObj(block.header) ? block.header.height : undefined;
          blockHeight = typeof h === 'number' ? h : null;
        } catch {
          blockHeight = null;
        }
      }
      return { raw, outcome: parseOutcome(raw), final, blockHeight };
    },
  };
}

// -- local keys --------------------------------------------------------------------------------

export type KeyFile = { path: string; publicKey: string; mode: number };
export type SignerHandle = { accountId: string; publicKey: string; origin: string; loaded: LoadedKey | null };

export type KeyStore = {
  readonly dir: string;
  /** Key files for the account (<dir>/<account>.json and <dir>/<account>/*.json): public_key only. */
  list(accountId: string): KeyFile[];
  /** A new ed25519 key, written 0600 to <dir>/<account>/ed25519_<pk>.json. The secret never leaves. */
  create(accountId: string): Promise<{ publicKey: string; path: string }>;
  /** The public key the stored secret derives, computed in memory. Throws on a missing, loose or malformed file. */
  derive(path: string): Promise<string>;
  /** A signer for a key a local file holds; a reason when there is none. */
  signer(accountId: string, publicKey: string): Promise<SignerHandle | { missing: string }>;
};

/** Public keys this script never signs with: the demo's exposed keys plus AID_REVOKED_KEYS. */
export function refusedKeys(env: Env): Map<string, string> {
  const out = new Map(Object.entries(EXPOSED_PUBLIC_KEYS));
  for (const k of (env.AID_REVOKED_KEYS ?? '').split(',')) {
    const pk = k.trim();
    if (pk !== '' && !out.has(pk)) out.set(pk, 'listed in AID_REVOKED_KEYS');
  }
  return out;
}

/** The real path of `p`, symlinks resolved through its nearest existing ancestor (`p` itself may not exist yet). */
export function realPathOf(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/** The git work tree that holds `from` (its nearest ancestor with a .git entry), or null. */
export function gitTopLevel(from: string = NEAR_ROOT): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return realPathOf(dir);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function isInside(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** The near-cli legacy keychain for TESTNET. There is no mainnet variant, on purpose. */
export function fileKeyStore(network: Network, env: Env = {}, dir?: string): KeyStore {
  if (network !== 'testnet') {
    throw new Error('key files are read for testnet only: on mainnet the owner signs with their own signer, and this script never opens ~/.near-credentials/mainnet');
  }
  const base = dir ?? (env.NEAR_CREDENTIALS_DIR?.trim() || join(homedir(), '.near-credentials', 'testnet'));
  if (basename(base) === 'mainnet') throw new Error(`${displayPath(base)} is a mainnet keychain; this script never reads it`);
  const tree = gitTopLevel(NEAR_ROOT);
  if (tree !== null && isInside(tree, realPathOf(base))) {
    throw new Error(`${displayPath(base)} is inside the git work tree ${displayPath(tree)}: new secrets written there could be committed. Keep key files outside the repository (the default is ~/.near-credentials/testnet)`);
  }
  const refused = refusedKeys(env);

  function candidates(accountId: string): string[] {
    const out: string[] = [];
    const single = join(base, `${accountId}.json`);
    if (existsSync(single)) out.push(single);
    try {
      for (const name of readdirSync(join(base, accountId)).sort()) if (name.endsWith('.json')) out.push(join(base, accountId, name));
    } catch {
      // no per-account folder
    }
    return out;
  }

  function list(accountId: string): KeyFile[] {
    const files: KeyFile[] = [];
    for (const path of candidates(accountId)) {
      let publicKey: unknown;
      let owner: unknown;
      try {
        // Only public_key and account_id are taken from the file; nothing else is kept.
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        publicKey = isObj(parsed) ? parsed.public_key : undefined;
        owner = isObj(parsed) ? parsed.account_id : undefined;
      } catch {
        continue;
      }
      if (typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:')) continue;
      if (typeof owner === 'string' && owner !== accountId) continue;
      if (files.some((f) => f.publicKey === publicKey)) continue;
      files.push({ path, publicKey, mode: statSync(path).mode & 0o777 });
    }
    return files;
  }

  return {
    dir: base,
    list,
    async create(accountId) {
      const { KeyPair } = await import('near-api-js');
      const pair = KeyPair.fromRandom('ed25519');
      const publicKey = pair.getPublicKey().toString();
      const folder = join(base, accountId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, `${publicKey.replace(':', '_')}.json`);
      if (existsSync(file)) throw new Error(`${displayPath(file)} already exists`);
      const tmp = `${file}.tmp-${process.pid}`;
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ account_id: accountId, public_key: publicKey, private_key: pair.toString() })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      return { publicKey, path: file };
    },
    async derive(path) {
      const { loadKey } = await import('../sdk/src/chain/keys.ts');
      const key = await loadKey({ file: path });
      if (!key) throw new Error(`${displayPath(path)} holds no key`);
      return key.publicKey;
    },
    async signer(accountId, publicKey) {
      const why = refused.get(publicKey);
      if (why !== undefined) return { missing: `${publicKey} is a key this script never signs with: ${why}` };
      const file = list(accountId).find((f) => f.publicKey === publicKey);
      if (!file) return { missing: `no key file in ${displayPath(base)} holds ${publicKey} for ${accountId}` };
      const { loadKey } = await import('../sdk/src/chain/keys.ts');
      try {
        const loaded = await loadKey({ file: file.path, expectPublicKey: publicKey });
        if (!loaded) return { missing: `${displayPath(file.path)} holds no key` };
        return { accountId, publicKey, origin: displayPath(file.path), loaded };
      } catch (e) {
        return { missing: errText(e) };
      }
    },
  };
}

// -- sending -----------------------------------------------------------------------------------

export type Action =
  | { type: 'CreateAccount' }
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'DeployContract'; wasm: Wasm }
  | { type: 'FunctionCall'; methodName: string; args: Record<string, unknown>; gasTgas: number; deposit: bigint }
  | { type: 'AddKey'; publicKey: string | null; receiverId: string; methodNames: readonly string[]; allowance: bigint }
  | { type: 'DeleteKey'; publicKey: string };

export type TxId =
  | 'registry-deploy'
  | 'oracle-add-key'
  | 'oracle-delete-keys'
  | 'vault-deploy'
  | 'vault-register'
  | 'vault-set-policy'
  | 'vault-set-hold-unknown'
  | 'vault-fund'
  | 'vault-top-up'
  | 'agent-key-add';

export type TxPlan = { id: TxId; step: StepName; signerId: string; signerKey: string | null; receiverId: string; actions: Action[]; why: string };

export type SendResult =
  | { status: 'executed'; txHash: string; outcome: TxOutcome; blockHeight: number | null }
  | { status: 'pending'; txHash: string; note: string }
  | { status: 'rejected'; error: string; message: string };

export type SendPort = { send(tx: TxPlan, signer: SignerHandle): Promise<SendResult> };

/** near-api-js, as the dynamic import gives it (the type is erased; nothing is loaded for it). */
export type NearApi = typeof import('near-api-js');
export type NearAction = ReturnType<NearApi['actions']['createAccount']>;

/** One planned action as the near-api-js 7.5.3 Action that is signed. Exported for its offline test. */
export function buildAction(near: NearApi, a: Action): NearAction {
  switch (a.type) {
    case 'CreateAccount':
      return near.actions.createAccount();
    case 'Transfer':
      return near.actions.transfer(a.deposit);
    case 'DeployContract':
      return near.actions.deployContract(a.wasm.bytes);
    case 'FunctionCall':
      return near.actions.functionCall(a.methodName, a.args, BigInt(a.gasTgas) * 10n ** 12n, a.deposit);
    case 'AddKey':
      if (!a.publicKey) throw new Error('AddKey without a public key');
      return near.actions.addFunctionCallAccessKey(near.PublicKey.fromString(a.publicKey), a.receiverId, [...a.methodNames], a.allowance);
    case 'DeleteKey':
      return near.actions.deleteKey(near.PublicKey.fromString(a.publicKey));
  }
}

/** The transaction hash nearcore computes: base58(sha256(borsh(Transaction))). */
export function txHashOf(near: NearApi, transaction: Parameters<NearApi['encodeTransaction']>[0]): string {
  return near.baseEncode(createHash('sha256').update(near.encodeTransaction(transaction)).digest());
}

/** Injected for the offline test of the real sender; a real run takes the defaults. */
export type SenderOptions = {
  provider?: Pick<JsonRpcProvider, 'viewAccessKey' | 'viewBlock' | 'sendTransactionUntil'>;
  reader?: RpcReader;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** The near-api-js 7.5.3 sender, built only for --execute. Dry runs and --record-only never
 * sign; they load near-api-js only to re-derive public keys from stored secrets in memory, and
 * mainnet loads nothing that signs. Hash computed locally, sent once to one endpoint, then polled
 * to FINAL by hash (sdk/src/chain/send.ts does the same for single calls). */
export async function nearSender(network: Network, chain: ChainPort, env: Env = {}, opts: SenderOptions = {}): Promise<SendPort> {
  if (network !== 'testnet') throw new Error('this script signs on testnet only');
  const near = await import('near-api-js');
  const { InvalidNonceError } = await import('near-api-js/rpc-errors');
  const { refusedAtValidation } = await import('../sdk/src/chain/send.ts');
  const cfg = NETWORKS[network];
  const url = env.AID_SEND_RPC_URL?.trim() || cfg.rpc[0] || '';
  const provider = (opts.provider ?? new near.JsonRpcProvider({ url }, { retries: 2, wait: 500, backoff: 1.5 })) as JsonRpcProvider;
  const reader = opts.reader ?? createReader({ rpc: cfg.rpc, archival: cfg.archival });
  return {
    async send(tx, signer) {
      if (tx.signerId !== signer.accountId) throw new Error(`${tx.id} is signed by ${tx.signerId}, the key belongs to ${signer.accountId}`);
      if (!signer.loaded) throw new Error(`no signing key loaded for ${signer.accountId}`);
      const built = tx.actions.map((a) => buildAction(near, a));
      let hash = '';
      let sendError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const account = new near.Account(tx.signerId, provider, signer.loaded.signer);
        let signed;
        try {
          signed = await account.createSignedTransaction({ receiverId: tx.receiverId, actions: built });
        } catch (e) {
          return { status: 'rejected', error: errName(e), message: `could not build the transaction: ${errText(e)}` };
        }
        hash = txHashOf(near, signed.transaction);
        try {
          await provider.sendTransactionUntil(signed, 'INCLUDED_FINAL');
          sendError = null;
          break;
        } catch (e) {
          if (e instanceof InvalidNonceError && attempt === 0) continue;
          if (refusedAtValidation(e)) return { status: 'rejected', error: errName(e), message: errText(e) };
          sendError = e;
          break;
        }
      }
      try {
        const outcome = await waitFinal(reader, { txHash: hash, senderId: tx.signerId, timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
        const seen = await chain.tx(hash, tx.signerId).catch(() => null);
        return { status: 'executed', txHash: hash, outcome, blockHeight: seen?.blockHeight ?? null };
      } catch (e) {
        const why = sendError === null ? errText(e) : `the send ended with ${errName(sendError)} (${errText(sendError)}); ${errText(e)}`;
        return { status: 'pending', txHash: hash, note: `${why}; check this hash before running again` };
      }
    },
  };
}

// -- plans -------------------------------------------------------------------------------------

export type Names = {
  registry: string;
  registryParent: string;
  registryOwner: string;
  oracles: string[];
  oracle: string;
  vault: string;
  vaultParent: string;
  vaultOwner: string;
  token: string;
};

export type VaultInit = { owner_id: string; token_id: string; registry_id: string; token_storage_deposit: string; daily_cap: string; auto_approve_max: string };

export function registryDeployTx(n: Names, wasm: Wasm, transfer: bigint): TxPlan {
  return {
    id: 'registry-deploy',
    step: 'registry',
    signerId: n.registryParent,
    signerKey: null,
    receiverId: n.registry,
    actions: [
      { type: 'CreateAccount' },
      { type: 'Transfer', deposit: transfer },
      { type: 'DeployContract', wasm },
      { type: 'FunctionCall', methodName: 'new', args: { owner_id: n.registryOwner, oracles: n.oracles }, gasTgas: INIT_GAS_TGAS, deposit: 0n },
    ],
    why: 'one batch, so the contract never exists uninitialized; no AddKey, so the registry account ends with zero access keys',
  };
}

export function oracleAddKeyTx(n: Names, publicKey: string | null, allowance: bigint, signerKey: string | null): TxPlan {
  return {
    id: 'oracle-add-key',
    step: 'oracle-key',
    signerId: n.oracle,
    signerKey,
    receiverId: n.oracle,
    actions: [{ type: 'AddKey', publicKey, receiverId: n.registry, methodNames: ORACLE_METHODS, allowance }],
    why: "the oracle's key: it can call only these four registry methods, attach no deposit and burn at most its allowance",
  };
}

/** DeleteKey of every full-access key, signed by the full-access key itself (its own delete last). */
export function oracleDeleteKeysTx(n: Names, fullAccess: readonly string[], signerKey: string | null): TxPlan {
  const ordered = [...fullAccess.filter((k) => k !== signerKey), ...fullAccess.filter((k) => k === signerKey)];
  return {
    id: 'oracle-delete-keys',
    step: 'oracle-key',
    signerId: n.oracle,
    signerKey,
    receiverId: n.oracle,
    actions: ordered.map((publicKey) => ({ type: 'DeleteKey' as const, publicKey })),
    why: 'the oracle keeps only its function-call key; sent only after lockoutGate passes',
  };
}

export function vaultDeployTx(n: Names, wasm: Wasm, transfer: bigint, init: VaultInit): TxPlan {
  return {
    id: 'vault-deploy',
    step: 'vault',
    signerId: n.vaultParent,
    signerKey: null,
    receiverId: n.vault,
    actions: [
      { type: 'CreateAccount' },
      { type: 'Transfer', deposit: transfer },
      { type: 'DeployContract', wasm },
      { type: 'FunctionCall', methodName: 'new', args: { ...init }, gasTgas: INIT_GAS_TGAS, deposit: 0n },
    ],
    why: 'one batch, so the vault never exists uninitialized; new admits only its parent as caller; no AddKey, so the vault holds no full-access key',
  };
}

const ownerCall = (id: TxId, step: StepName, n: Names, methodName: string, args: Record<string, unknown>, deposit: bigint, gasTgas: number, why: string): TxPlan => ({
  id,
  step,
  signerId: n.vaultOwner,
  signerKey: null,
  receiverId: n.vault,
  actions: [{ type: 'FunctionCall', methodName, args, gasTgas, deposit }],
  why,
});

export const registerTx = (n: Names): TxPlan =>
  ownerCall('vault-register', 'vault-register', n, 'register_with_token', {}, 0n, VAULT_GAS_TGAS.register_with_token, 'not payable: the vault pays its own registration from its NEAR');

/** set_policy sets all three fields at once, so allowlistEnabled carries the vault's current value through. */
export const setPolicyTx = (n: Names, dailyCap: bigint, autoApproveMax: bigint, allowlistEnabled = false): TxPlan =>
  ownerCall(
    'vault-set-policy',
    'vault-policy',
    n,
    'set_policy',
    { daily_cap: dailyCap.toString(), auto_approve_max: autoApproveMax.toString(), allowlist_enabled: allowlistEnabled },
    1n,
    VAULT_GAS_TGAS.owner_default,
    'an owner call: exactly 1 yoctoNEAR',
  );

export const setHoldUnknownTx = (n: Names): TxPlan =>
  ownerCall('vault-set-hold-unknown', 'vault-policy', n, 'set_hold_unknown', { hold_unknown: true }, 1n, VAULT_GAS_TGAS.owner_default, 'an owner call: exactly 1 yoctoNEAR');

export const addAgentKeyTx = (n: Names, publicKey: string, allowance: bigint, expiresAtS: string): TxPlan =>
  ownerCall(
    'agent-key-add',
    'agent-key',
    n,
    'add_agent_key',
    { public_key: publicKey, label: AGENT_LABEL, expires_at_s: expiresAtS, allowance: allowance.toString() },
    1n,
    VAULT_GAS_TGAS.add_agent_key,
    'the vault adds the key to its own account: receiver the vault, methods pay, request_payment, record_refusal, this allowance',
  );

export function fundTx(n: Names, amount: bigint, id: 'vault-fund' | 'vault-top-up' = 'vault-fund'): TxPlan {
  return {
    id,
    step: 'vault-fund',
    signerId: n.vaultOwner,
    signerKey: null,
    receiverId: n.token,
    actions: [{ type: 'FunctionCall', methodName: 'ft_transfer_call', args: { receiver_id: n.vault, amount: amount.toString(), msg: '' }, gasTgas: FUND_GAS_TGAS, deposit: 1n }],
    why:
      id === 'vault-fund'
        ? "the vault's one funding, sent only while it holds 0 USDC; its ft_on_transfer keeps its own token and emits deposited; NEP-141 needs exactly 1 yoctoNEAR"
        : 'a top-up asked for with --top-up, recorded apart from the funding; NEP-141 needs exactly 1 yoctoNEAR',
  };
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'CreateAccount':
      return 'CreateAccount';
    case 'Transfer':
      return `Transfer ${nearText(a.deposit)} (${a.deposit} yoctoNEAR)`;
    case 'DeployContract':
      return `DeployContract ${a.wasm.name}, ${a.wasm.size} bytes, sha256 ${a.wasm.hex}, code_hash (base58) ${a.wasm.b58}`;
    case 'FunctionCall':
      return `FunctionCall ${a.methodName} args ${JSON.stringify(a.args)} (base64 ${argsBase64(a.args)}), gas ${a.gasTgas} Tgas, deposit ${a.deposit} yoctoNEAR`;
    case 'AddKey':
      return `AddKey ${a.publicKey ?? '<a new ed25519 key, generated before this is sent>'}: FunctionCall permission, receiver ${a.receiverId}, methods [${a.methodNames.join(', ')}], allowance ${nearText(a.allowance)} (${a.allowance} yoctoNEAR)`;
    case 'DeleteKey':
      return `DeleteKey ${a.publicKey}`;
  }
}

// -- the record --------------------------------------------------------------------------------

export type TxRef = { hash: string; signer_id: string; block_height: number | null };
export type BuildFacts = { reproducible: boolean; command: string | null; reproducibleCommand: string | null; gitCommit: string | null };
export type ContractFacts = { codeHash: string; wasm: Wasm; version: string | null; deployTx: TxRef | null; build: BuildFacts };
export type SetupKey = 'register_with_token' | 'set_policy' | 'set_hold_unknown' | 'fund';
export type SetupRef = TxRef & { amount?: string };
export type Facts = {
  registry?: ContractFacts;
  vault?: ContractFacts & { initArgs: { daily_cap: string; auto_approve_max: string; token_storage_deposit: string } | null };
  tokenStorage?: string;
  oracleKey?: { publicKey: string; receiverId: string; allowance: string | null; addTx: string | null };
  oracleLock?: { txHash: string };
  policy?: { daily_cap: string; auto_approve_max: string; allowlist_enabled: boolean; hold_unknown: boolean };
  agentKey?: { publicKey: string; receiverId: string; allowance: string | null; addTx: string | null };
  setup?: Partial<Record<SetupKey, SetupRef>>;
  /** --top-up transfers, kept apart from setup.fund and appended, never replacing one. */
  topUps?: SetupRef[];
};

export function buildFacts(which: 'registry' | 'vault', reproducible: boolean, gitCommit: string | null): BuildFacts {
  const command = `cargo near build reproducible-wasm --manifest-path contracts/${CRATES[which]}/Cargo.toml`;
  return reproducible ? { reproducible: true, command, reproducibleCommand: command, gitCommit } : { reproducible: false, command: null, reproducibleCommand: null, gitCommit };
}

/**
 * The record with these facts written in, as a new object. A null fact never erases a value, and
 * a reproducible build is never downgraded: an unverified run (--allow-unverified-wasm) whose wasm
 * matches the recorded hashes (checked before any fact is gathered) leaves build.reproducible and
 * build.reproducible_command as recorded, and writes reproducible false only where none is.
 */
export function applyFacts(record: Record<string, unknown>, f: Facts): Record<string, unknown> {
  const out = structuredClone(record);
  const put = (path: string, value: unknown) => {
    if (value !== null && value !== undefined) setIn(out, path, value);
  };
  const contract = (name: 'registry' | 'vault', c: ContractFacts) => {
    const at = `contracts.${name}`;
    put(`${at}.status`, 'deployed');
    put(`${at}.version`, c.version);
    put(`${at}.wasm_bytes`, c.wasm.size);
    put(`${at}.wasm_sha256_hex`, c.wasm.hex);
    put(`${at}.wasm_sha256_base58`, c.wasm.b58);
    put(`${at}.code_hash`, c.codeHash);
    if (c.build.reproducible) {
      setIn(out, `${at}.build.reproducible`, true);
      setIn(out, `${at}.build.reproducible_command`, c.build.reproducibleCommand);
    } else if (getIn(out, `${at}.build.reproducible`) == null) {
      setIn(out, `${at}.build.reproducible`, false);
      if (getIn(out, `${at}.build.reproducible_command`) === undefined) setIn(out, `${at}.build.reproducible_command`, null);
    }
    put(`${at}.build.command`, c.build.command);
    put(`${at}.build.git_commit`, c.build.gitCommit);
    put(`accounts.${name}.status`, 'created');
    put(`keys.${name}.full_access_keys`, 0);
    if (c.deployTx) {
      put(`${at}.deploy_tx`, { ...c.deployTx });
      if (typeof getIn(out, `keys.${name}.lock.tx_hash`) !== 'string') put(`keys.${name}.lock`, { how: 'never-added', tx_hash: c.deployTx.hash });
    }
  };
  if (f.registry) contract('registry', f.registry);
  if (f.vault) {
    contract('vault', f.vault);
    if (f.vault.initArgs) {
      put('contracts.vault.init.args.daily_cap', f.vault.initArgs.daily_cap);
      put('contracts.vault.init.args.auto_approve_max', f.vault.initArgs.auto_approve_max);
      put('contracts.vault.init.args.token_storage_deposit', f.vault.initArgs.token_storage_deposit);
    }
  }
  if (f.tokenStorage) put('token.storage_deposit_yocto', f.tokenStorage);
  if (f.oracleKey) {
    put('keys.oracle.function_call.public_key', f.oracleKey.publicKey);
    put('keys.oracle.function_call.receiver_id', f.oracleKey.receiverId);
    put('keys.oracle.function_call.method_names', [...ORACLE_METHODS]);
    put('keys.oracle.function_call.allowance_yocto', f.oracleKey.allowance);
    put('keys.oracle.function_call.add_tx_hash', f.oracleKey.addTx);
  }
  if (f.oracleLock) {
    put('keys.oracle.full_access_keys', 0);
    if (typeof getIn(out, 'keys.oracle.lock.tx_hash') !== 'string') put('keys.oracle.lock', { how: 'delete-key', tx_hash: f.oracleLock.txHash });
  }
  if (f.policy) {
    put('policy.daily_cap', f.policy.daily_cap);
    put('policy.auto_approve_max', f.policy.auto_approve_max);
    put('policy.allowlist_enabled', f.policy.allowlist_enabled);
    put('policy.hold_unknown', f.policy.hold_unknown);
  }
  if (f.agentKey) {
    put('keys.vault.agent.public_key', f.agentKey.publicKey);
    put('keys.vault.agent.receiver_id', f.agentKey.receiverId);
    put('keys.vault.agent.method_names', [...AGENT_METHODS]);
    put('keys.vault.agent.allowance_yocto', f.agentKey.allowance);
    put('keys.vault.agent.add_tx_hash', f.agentKey.addTx);
  }
  for (const [k, v] of Object.entries(f.setup ?? {})) put(`contracts.vault.setup.${k}`, v);
  if (f.topUps?.length) {
    const was = getIn(out, 'contracts.vault.setup.top_up');
    const kept = Array.isArray(was) ? [...was] : [];
    for (const t of f.topUps) if (!kept.some((k) => isObj(k) && k.hash === t.hash)) kept.push({ ...t });
    setIn(out, 'contracts.vault.setup.top_up', kept);
  }
  return out;
}

export type ClaimLite = { id: string; params?: unknown; requires?: string[]; evidence?: string | null };
export type ResolveTemplates = (value: unknown, data: unknown) => { value: unknown; missing: string[] };
export type StatusDecision = { status: 'pending' | 'partial' | 'deployed'; pending: string[]; noEvidence: string[] };

/**
 * The judge's rule (deployments/README.md): "deployed" only when every claim is filled in (no
 * template of it resolves to null, the same test judge/lib/engine.mjs runs) AND its evidence
 * file is captured. Otherwise "partial" once a contract is recorded, else "pending".
 */
export function decideStatus(record: unknown, claims: readonly ClaimLite[], resolve: ResolveTemplates, evidenceExists: (rel: string) => boolean): StatusDecision {
  const pending: string[] = [];
  for (const c of claims) {
    const missing = [...resolve({ params: c.params ?? {}, requires: c.requires ?? [] }, record).missing];
    for (const p of c.requires ?? []) missing.push(...resolve(`\${${p}}`, record).missing);
    if (missing.length) pending.push(c.id);
  }
  const noEvidence = claims.filter((c) => typeof c.evidence === 'string' && !evidenceExists(c.evidence)).map((c) => c.id);
  const recorded = ['registry', 'vault'].some((n) => getIn(record, `contracts.${n}.code_hash`) != null);
  const status = pending.length === 0 && noEvidence.length === 0 ? 'deployed' : recorded ? 'partial' : 'pending';
  return { status, pending, noEvidence };
}

export type JudgeRules = { claims: ClaimLite[]; resolve: ResolveTemplates };

export async function loadJudgeRules(nearRoot: string): Promise<JudgeRules | { error: string }> {
  try {
    const claims = JSON.parse(readFileSync(join(nearRoot, 'judge/claims.json'), 'utf8')) as { claims?: ClaimLite[] };
    const mod = (await import(pathToFileURL(join(nearRoot, 'judge/lib/deployments.mjs')).href)) as { resolveTemplates?: ResolveTemplates };
    if (!Array.isArray(claims.claims) || typeof mod.resolveTemplates !== 'function') return { error: 'judge/claims.json or judge/lib/deployments.mjs has an unexpected shape' };
    return { claims: claims.claims, resolve: mod.resolveTemplates };
  } catch (e) {
    return { error: errText(e) };
  }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

/** Names from deployments/<network>.json; inconsistencies are setup errors (exit 2). */
export function namesFromRecord(rec: Record<string, unknown>): Names {
  const str = (path: string): string => {
    const v = getIn(rec, path);
    if (typeof v !== 'string' || !isValidAccountId(v)) throw new UsageError(`the record's ${path} is not an account id`);
    return v;
  };
  const registry = str('contracts.registry.account_id');
  const vault = str('contracts.vault.account_id');
  const oracle = str('accounts.oracle.account_id');
  const token = str('token.account_id');
  const registryOwner = str('contracts.registry.init.args.owner_id');
  const vaultOwner = str('contracts.vault.init.args.owner_id');
  const oraclesRaw = getIn(rec, 'contracts.registry.init.args.oracles');
  const oracles = Array.isArray(oraclesRaw) ? oraclesRaw.filter((o): o is string => typeof o === 'string' && isValidAccountId(o)) : [];
  const problems: string[] = [];
  if (str('accounts.registry.account_id') !== registry) problems.push('accounts.registry.account_id differs from contracts.registry.account_id');
  if (str('accounts.vault.account_id') !== vault) problems.push('accounts.vault.account_id differs from contracts.vault.account_id');
  if (str('accounts.vault_owner.account_id') !== vaultOwner) problems.push('contracts.vault.init.args.owner_id differs from accounts.vault_owner.account_id');
  if (str('accounts.registry_owner.account_id') !== registryOwner) problems.push('contracts.registry.init.args.owner_id differs from accounts.registry_owner.account_id');
  if (!oracles.includes(oracle)) problems.push(`contracts.registry.init.args.oracles does not list ${oracle}`);
  const regInit = getIn(rec, 'contracts.vault.init.args.registry_id');
  if (regInit !== registry) problems.push('contracts.vault.init.args.registry_id differs from contracts.registry.account_id');
  const tokenInit = getIn(rec, 'contracts.vault.init.args.token_id');
  if (!(isObj(tokenInit) && tokenInit.$ref === 'token.account_id') && tokenInit !== token) problems.push('contracts.vault.init.args.token_id is neither {"$ref": "token.account_id"} nor the token');
  const registryParent = parentOf(registry);
  const vaultParent = parentOf(vault);
  if (!registryParent) problems.push(`${registry} has no parent account that could create it`);
  if (!vaultParent) problems.push(`${vault} has no parent account that could create it`);
  if (problems.length) throw new UsageError(`deployments record is inconsistent: ${problems.join('; ')}`);
  return { registry, registryParent: registryParent ?? '', registryOwner, oracles, oracle, vault, vaultParent: vaultParent ?? '', vaultOwner, token };
}

// -- configuration -----------------------------------------------------------------------------

export type MainnetNames = { registry: string; registryParent: string; oracle: string; vault: string; vaultOwner: string };

export type Config = {
  help: boolean;
  network: Network;
  mode: Mode;
  step: StepName | null;
  wasmDir: string;
  allowUnverifiedWasm: boolean;
  recordPath: string;
  dailyCap: bigint;
  autoApproveMax: bigint;
  /** True when --daily-cap / --auto-approve-max was given: only then may vault-policy send set_policy. */
  dailyCapGiven: boolean;
  autoApproveMaxGiven: boolean;
  fund: bigint;
  /** --top-up: the only way to send USDC to a vault that is already funded. */
  topUp: boolean;
  agentAllowance: bigint;
  agentExpiresDays: number;
  oracleAllowance: bigint;
  registryMargin: bigint;
  vaultFloat: bigint;
  adopt: string[];
  mainnet: (MainnetNames & { agentPublicKey: string | null; oraclePublicKey: string | null; signer: 'keychain' | 'ledger'; tokenStorageDeposit: bigint | null }) | null;
};

export const HELP = `A-Identity NEAR deploy (keyless: no account ends with a key it should not hold)

Usage, from near/:
  node --experimental-strip-types scripts/deploy.ts [mode] [--step <name>] [options]

Modes:
  --dry-run                 (default) read the chain, sign and send nothing, print every transaction
  --execute                 sign and send, testnet only, with keys from ~/.near-credentials/testnet
  --record-only             send nothing; write the record from the chain and --adopt-tx transactions

Steps (--step runs one): ${STEPS.join(', ')}

Options:
  --network testnet|mainnet   default testnet; mainnet prints near-cli-rs 0.31.1 commands and never signs
  --wasm-dir <dir>            default deployments/wasm (with hashes.json from the CI reproducible job)
  --allow-unverified-wasm     deploy or record a wasm hashes.json does not vouch for (recorded reproducible false)
  --record <path>             default deployments/testnet.json
  --daily-cap <usdc>          the vault's policy at init (default 5 = 5000000 units). On a deployed
  --auto-approve-max <usdc>   vault (default 2 = 2000000 units) set_policy is sent only when one of
                              these is GIVEN; otherwise the recorded policy must match the chain
  --fund <usdc>               default 3: the vault's one funding, sent only while it holds 0 USDC
  --top-up                    send the owner's USDC to bring a funded vault back up to --fund
                              (recorded as contracts.vault.setup.top_up, never as the funding)
  --agent-allowance <near>    default 0.25
  --agent-expires-days <n>    default 30; 0 means the agent key does not expire
  --oracle-allowance <near>   default 1
  --registry-margin <near>    default 1 (verdict storage the registry pays for)
  --vault-float <near>        default 1 (the agent's gas and the vault's bounded storage)
  --adopt-tx <hash>           repeatable: record a transaction an earlier run sent, after checking it on chain
Mainnet only:
  --registry <id> --registry-parent <id> --oracle <id> --vault <id> --vault-owner <id>
  --signer keychain|ledger    how the printed commands sign (default keychain)
  --agent-public-key <pk>     the agent key the owner generated (otherwise a placeholder)
  --oracle-public-key <pk>    use this key for the oracle instead of letting near-cli generate one
  --token-storage-deposit <yocto>  when the USDC contract cannot be read
  -h, --help

Exit status: 0 success; 1 a step failed, a check mismatched or --execute would be refused; 2 a usage error.`;

export function parseConfig(argv: string[], nearRoot: string = NEAR_ROOT): Config {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        'dry-run': { type: 'boolean' },
        execute: { type: 'boolean' },
        'record-only': { type: 'boolean' },
        network: { type: 'string' },
        step: { type: 'string' },
        'wasm-dir': { type: 'string' },
        'allow-unverified-wasm': { type: 'boolean' },
        record: { type: 'string' },
        'daily-cap': { type: 'string' },
        'auto-approve-max': { type: 'string' },
        fund: { type: 'string' },
        'top-up': { type: 'boolean' },
        'agent-allowance': { type: 'string' },
        'agent-expires-days': { type: 'string' },
        'oracle-allowance': { type: 'string' },
        'registry-margin': { type: 'string' },
        'vault-float': { type: 'string' },
        'adopt-tx': { type: 'string', multiple: true },
        registry: { type: 'string' },
        'registry-parent': { type: 'string' },
        oracle: { type: 'string' },
        vault: { type: 'string' },
        'vault-owner': { type: 'string' },
        signer: { type: 'string' },
        'agent-public-key': { type: 'string' },
        'oracle-public-key': { type: 'string' },
        'token-storage-deposit': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (e) {
    throw new UsageError(errText(e));
  }
  const s = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const b = (k: string): boolean => values[k] === true;
  const modes = (['dry-run', 'execute', 'record-only'] as const).filter((m) => b(m));
  if (modes.length > 1) throw new UsageError(`choose one of --dry-run, --execute, --record-only (got ${modes.map((m) => `--${m}`).join(' and ')})`);
  const mode: Mode = modes[0] ?? 'dry-run';
  const network = (s('network') ?? 'testnet') as Network;
  if (network !== 'testnet' && network !== 'mainnet') throw new UsageError(`--network must be testnet or mainnet, got ${JSON.stringify(network)}`);
  const stepText = s('step');
  if (stepText !== undefined && !(STEPS as readonly string[]).includes(stepText)) throw new UsageError(`unknown --step ${JSON.stringify(stepText)}; steps: ${STEPS.join(', ')}`);
  const days = s('agent-expires-days') ?? '30';
  if (!/^\d+$/.test(days)) throw new UsageError('--agent-expires-days must be a whole number of days');
  const positive = (v: bigint, what: string) => {
    if (v <= 0n) throw new UsageError(`${what} must be more than 0`);
    return v;
  };
  const cfg: Config = {
    help: b('help'),
    network,
    mode,
    step: (stepText as StepName | undefined) ?? null,
    wasmDir: resolve(s('wasm-dir') ?? join(nearRoot, 'deployments', 'wasm')),
    allowUnverifiedWasm: b('allow-unverified-wasm'),
    recordPath: resolve(s('record') ?? join(nearRoot, 'deployments', `${network}.json`)),
    dailyCap: parseDecimal(s('daily-cap') ?? '5', 6, '--daily-cap'),
    autoApproveMax: parseDecimal(s('auto-approve-max') ?? '2', 6, '--auto-approve-max'),
    dailyCapGiven: s('daily-cap') !== undefined,
    autoApproveMaxGiven: s('auto-approve-max') !== undefined,
    fund: parseDecimal(s('fund') ?? '3', 6, '--fund'),
    topUp: b('top-up'),
    agentAllowance: positive(parseDecimal(s('agent-allowance') ?? '0.25', 24, '--agent-allowance'), '--agent-allowance'),
    agentExpiresDays: Number(days),
    oracleAllowance: positive(parseDecimal(s('oracle-allowance') ?? '1', 24, '--oracle-allowance'), '--oracle-allowance'),
    registryMargin: parseDecimal(s('registry-margin') ?? '1', 24, '--registry-margin'),
    vaultFloat: parseDecimal(s('vault-float') ?? '1', 24, '--vault-float'),
    adopt: Array.isArray(values['adopt-tx']) ? (values['adopt-tx'] as string[]) : [],
    mainnet: null,
  };
  if (cfg.dailyCap !== 0n && cfg.autoApproveMax > cfg.dailyCap) throw new UsageError('--auto-approve-max is above --daily-cap: no payment could ever use it');
  for (const h of cfg.adopt) if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)) throw new UsageError(`--adopt-tx ${JSON.stringify(h)} is not a base58 transaction hash`);
  const mainnetOnly = ['registry', 'registry-parent', 'oracle', 'vault', 'vault-owner', 'signer', 'agent-public-key', 'oracle-public-key', 'token-storage-deposit'];
  if (network === 'testnet') {
    const given = mainnetOnly.filter((k) => s(k) !== undefined);
    if (given.length) throw new UsageError(`${given.map((k) => `--${k}`).join(', ')} apply to --network mainnet only; testnet names come from the record`);
    return cfg;
  }
  if (mode !== 'dry-run') throw new UsageError(`--network mainnet never signs or records: it prints the commands the owner runs (drop --${mode})`);
  if (cfg.adopt.length) throw new UsageError('--adopt-tx is for testnet records');
  if (cfg.topUp) throw new UsageError('--top-up is for testnet runs: the mainnet plan funds a new vault once');
  const need = (k: string): string => {
    const v = s(k);
    if (v === undefined) throw new UsageError(`--network mainnet needs --${k}`);
    if (!isValidAccountId(v)) throw new UsageError(`--${k} ${JSON.stringify(v)} is not a NEAR account id`);
    return v;
  };
  const registry = need('registry');
  const oracle = need('oracle');
  const vault = need('vault');
  const registryParent = s('registry-parent') ?? parentOf(registry) ?? '';
  const vaultOwner = s('vault-owner') ?? parentOf(vault) ?? '';
  if (parentOf(registry) !== registryParent) throw new UsageError(`the registry must be a direct sub-account of its parent (${registry} under ${registryParent}): the parent creates and initializes it in one batch`);
  if (parentOf(vault) !== vaultOwner) throw new UsageError(`the vault must be a direct sub-account of its owner (${vault} under ${vaultOwner}): the owner creates and initializes it in one batch`);
  const signer = s('signer') ?? 'keychain';
  if (signer !== 'keychain' && signer !== 'ledger') throw new UsageError('--signer must be keychain or ledger');
  const pk = (k: string): string | null => {
    const v = s(k);
    if (v === undefined) return null;
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(v)) throw new UsageError(`--${k} must be an ed25519 public key (ed25519:<base58>)`);
    return v;
  };
  const deposit = s('token-storage-deposit');
  if (deposit !== undefined && !/^\d+$/.test(deposit)) throw new UsageError('--token-storage-deposit is yoctoNEAR, a whole number');
  cfg.mainnet = {
    registry,
    registryParent,
    oracle,
    vault,
    vaultOwner,
    signer,
    agentPublicKey: pk('agent-public-key'),
    oraclePublicKey: pk('oracle-public-key'),
    tokenStorageDeposit: deposit === undefined ? null : BigInt(deposit),
  };
  return cfg;
}

// -- the run -----------------------------------------------------------------------------------

export type StepStatus = 'done' | 'planned' | 'executed' | 'blocked' | 'mismatch' | 'failed';
export type Adopted = { id: TxId; ref: TxRef; view: TxRecordView; args: Record<string, unknown> | null; publicKey: string | null; deleted: string[] };

type Ctx = {
  cfg: Config;
  env: Env;
  /** near/ (the judge's root): evidence/*.json and the record's wasm_path are relative to it. */
  nearRoot: string;
  names: Names;
  wasm: { registry: Wasm; vault: Wasm };
  gate: HashGate;
  chain: ChainPort;
  keys: KeyStore;
  sender: SendPort | null;
  out: (line: string) => void;
  now: () => Date;
  record: Record<string, unknown>;
  rules: JudgeRules | null;
  facts: Facts;
  adopted: Map<TxId, Adopted>;
  /** Every adopted ft_transfer_call to the vault: the earliest is the funding, later ones top-ups. */
  fundAdoptions: Adopted[];
  /** Dry run only: the signer key found (or not) per account, so a missing one is reported once. */
  signerCache: Map<string, { publicKey: string; path: string } | null>;
  planned: Set<StepName>;
  problems: string[];
  txs: Array<{ tx: TxPlan; label: string; hash?: string }>;
  gasPrice: bigint | null;
  tokenStorage: bigint | null;
  wrote: string[];
};

export type RunReport = { exit: number; steps: Array<{ step: StepName; status: StepStatus }>; txs: Array<{ tx: TxPlan; label: string; hash?: string }>; problems: string[]; record: Record<string, unknown> | null };

export type Deps = {
  out?: (line: string) => void;
  now?: () => Date;
  chain?: (network: Network) => ChainPort;
  /** Called for testnet only: mainnet never gets a key store. */
  keyStore?: (network: Network) => KeyStore;
  /** Called for --execute only. */
  sender?: (network: Network, chain: ChainPort) => Promise<SendPort>;
  nearRoot?: string;
};

const say = (ctx: Ctx, step: StepName, text: string) => ctx.out(`[${step}] ${text}`);

function problem(ctx: Ctx, step: StepName, kind: string, text: string): void {
  ctx.problems.push(`[${step}] ${kind}: ${text}`);
  say(ctx, step, `${kind}: ${text}`);
}

function printTx(ctx: Ctx, tx: TxPlan, label: string): void {
  say(ctx, tx.step, `tx ${tx.id}: ${label}`);
  say(ctx, tx.step, `  signer ${tx.signerId}${tx.signerKey ? ` (full-access key ${tx.signerKey})` : ''}, receiver ${tx.receiverId}`);
  tx.actions.forEach((a, i) => say(ctx, tx.step, `  ${i + 1}. ${describeAction(a)}`));
  say(ctx, tx.step, `  why: ${tx.why}`);
}

function available(a: AccountView): bigint {
  const stake = BigInt(a.storageUsage) * YOCTO_PER_BYTE;
  return a.amount > stake ? a.amount - stake : 0n;
}

function describeKeys(keys: readonly KeyView[]): string {
  if (!keys.length) return 'no access keys';
  return keys
    .map((k) => {
      const p = k.permission;
      if (p.kind === 'FullAccess') return `${k.publicKey} FullAccess`;
      if (p.kind === 'FunctionCall') return `${k.publicKey} FunctionCall ${p.receiverId} [${p.methodNames.join(', ') || 'ANY METHOD'}] allowance ${p.allowance === null ? 'unlimited' : nearText(p.allowance)}`;
      return `${k.publicKey} ${JSON.stringify(p.raw)}`;
    })
    .join('; ');
}

const isFull = (k: KeyView) => k.permission.kind === 'FullAccess';

export function isScopedKey(k: KeyView, receiverId: string, methods: readonly string[]): boolean {
  const p = k.permission;
  return p.kind === 'FunctionCall' && p.receiverId === receiverId && p.methodNames.length > 0 && sameSet(p.methodNames, methods) && p.allowance !== null;
}

function recordedTx(ctx: Ctx, path: string): TxRef | null {
  const v = getIn(ctx.record, path);
  if (!isObj(v) || typeof v.hash !== 'string') return null;
  return { hash: v.hash, signer_id: String(v.signer_id ?? ''), block_height: typeof v.block_height === 'number' ? v.block_height : null };
}

/** The transaction hash the record holds at `path`, or the adopted one; both present and different is a mismatch. */
function pickTx(ctx: Ctx, step: StepName, path: string, adopted: string | null | undefined): { hash: string | null; ok: boolean } {
  const recorded = recordedString(ctx, path);
  if (recorded && adopted && recorded !== adopted) {
    problem(ctx, step, 'MISMATCH', `the record's ${path} is ${recorded}, --adopt-tx names ${adopted}`);
    return { hash: null, ok: false };
  }
  return { hash: recorded ?? adopted ?? null, ok: true };
}

function recordedString(ctx: Ctx, path: string): string | null {
  const v = getIn(ctx.record, path);
  return typeof v === 'string' ? v : null;
}

/** A recorded value that disagrees with the chain is a mismatch, never overwritten silently. */
function checkRecorded(ctx: Ctx, step: StepName, path: string, actual: string | null): boolean {
  const recorded = getIn(ctx.record, path);
  if (recorded === null || recorded === undefined || actual === null) return true;
  if (recorded === actual) return true;
  problem(ctx, step, 'MISMATCH', `the record's ${path} is ${JSON.stringify(recorded)} but the chain says ${JSON.stringify(actual)}`);
  return false;
}

/** The record's code hash and wasm hashes, where filled in, are the chain's and the wasm's. */
function recordedWasmAgrees(ctx: Ctx, step: StepName, which: 'registry' | 'vault', codeHash: string): boolean {
  const w = ctx.wasm[which];
  const at = `contracts.${which}`;
  const ok = [
    checkRecorded(ctx, step, `${at}.code_hash`, codeHash),
    checkRecorded(ctx, step, `${at}.wasm_sha256_hex`, w.hex),
    checkRecorded(ctx, step, `${at}.wasm_sha256_base58`, w.b58),
  ].every(Boolean);
  const bytes = getIn(ctx.record, `${at}.wasm_bytes`);
  if (typeof bytes === 'number' && bytes !== w.size) {
    problem(ctx, step, 'MISMATCH', `the record's ${at}.wasm_bytes is ${bytes}, ${w.name} has ${w.size}`);
    return false;
  }
  return ok;
}

function gap(ctx: Ctx, step: StepName, field: string, account: string): void {
  const url = `${NETWORKS[ctx.cfg.network].fastnearTx}/v0/account`;
  problem(
    ctx,
    step,
    'RECORD GAP',
    `done on chain, but ${field} is not in ${displayPath(ctx.cfg.recordPath)} and no --adopt-tx names it; nothing is recorded without its transaction. Find it (curl -s ${url} -H 'content-type: application/json' -d '{"account_id":"${account}","limit":20,"desc":false}') and pass --adopt-tx <hash>`,
  );
}

function txRefOf(r: { txHash: string; blockHeight: number | null }, signerId: string): TxRef {
  return { hash: r.txHash, signer_id: signerId, block_height: r.blockHeight };
}

/** Executed and succeeded, or a labeled failure. Never treats a pending or rejected send as done. */
function sent(ctx: Ctx, tx: TxPlan, r: SendResult): r is Extract<SendResult, { status: 'executed' }> {
  if (r.status === 'rejected') {
    problem(ctx, tx.step, 'FAILED', `${tx.id} was refused before execution (${r.error}: ${r.message}); nothing was included on chain`);
    return false;
  }
  if (r.status === 'pending') {
    ctx.txs.push({ tx, label: 'sent, not final', hash: r.txHash });
    problem(ctx, tx.step, 'PENDING', `${tx.id} sent as ${r.txHash} but not seen final: ${r.note}. When it is final, run again with --adopt-tx ${r.txHash}`);
    return false;
  }
  ctx.txs.push({ tx, label: 'executed', hash: r.txHash });
  const failed = r.outcome.receipts.filter((x) => !x.succeeded && x.failure !== null);
  if (!r.outcome.succeeded) {
    problem(ctx, tx.step, 'FAILED', `${tx.id} ${r.txHash} executed and failed: ${JSON.stringify(r.outcome.failure).slice(0, 300)}`);
    return false;
  }
  say(ctx, tx.step, `executed: ${tx.id} ${r.txHash} final at block ${r.blockHeight ?? 'unknown'}${failed.length ? `; ${failed.length} later receipt(s) failed (checked below)` : ''}`);
  say(ctx, tx.step, `  ${NETWORKS[ctx.cfg.network].explorer}/txns/${r.txHash}`);
  return true;
}

async function signerFor(ctx: Ctx, step: StepName, accountId: string): Promise<{ publicKey: string; path: string } | null> {
  if (ctx.cfg.mode === 'dry-run' && ctx.signerCache.has(accountId)) {
    const known = ctx.signerCache.get(accountId) ?? null;
    say(ctx, step, known ? `signer key: ${accountId} ${known.publicKey} (as above)` : `BLOCKED for --execute, no credential for ${accountId} (as above)`);
    return known;
  }
  const found = await findSigner(ctx, step, accountId);
  if (ctx.cfg.mode === 'dry-run') ctx.signerCache.set(accountId, found);
  return found;
}

async function findSigner(ctx: Ctx, step: StepName, accountId: string): Promise<{ publicKey: string; path: string } | null> {
  const keys = await ctx.chain.keys(accountId);
  const full = keys.filter(isFull).map((k) => k.publicKey);
  const refused = refusedKeys(ctx.env);
  const files = ctx.keys.list(accountId).filter((f) => full.includes(f.publicKey) && !refused.has(f.publicKey));
  const file = files[0];
  if (!file) {
    const why = full.length ? `no key file in ${displayPath(ctx.keys.dir)} holds a full-access key of ${accountId} (on chain: ${full.join(', ')})` : `${accountId} has no full-access key on chain`;
    problem(ctx, step, ctx.cfg.mode === 'execute' ? 'STOPPED, no credential' : 'BLOCKED for --execute, no credential', why);
    return null;
  }
  if ((file.mode & 0o077) !== 0) {
    problem(ctx, step, 'BLOCKED', `${displayPath(file.path)} is readable by group or others (mode ${file.mode.toString(8)}); run chmod 600 on it`);
    return null;
  }
  say(ctx, step, `signer key: ${accountId} ${file.publicKey} (full access on chain; file ${displayPath(file.path)}, mode 600)`);
  return { publicKey: file.publicKey, path: file.path };
}

async function loadSigner(ctx: Ctx, step: StepName, accountId: string, publicKey: string): Promise<SignerHandle | null> {
  const s = await ctx.keys.signer(accountId, publicKey);
  if ('missing' in s) {
    problem(ctx, step, 'STOPPED, no credential', s.missing);
    return null;
  }
  return s;
}

/** Derive the public key of a stored secret in memory; a reason instead of throwing. */
async function deriveOk(ctx: Ctx, path: string): Promise<{ publicKey: string } | { error: string }> {
  try {
    return { publicKey: await ctx.keys.derive(path) };
  } catch (e) {
    return { error: errText(e) };
  }
}

/**
 * The lockout guard. A full-access key may be deleted only when the replacement key is on chain
 * at the final block with exactly the wanted permission (receiver, the exact method set, a finite
 * allowance: for a key just added exactly the allowance asked for, for a key found on chain at
 * least `minAllowance`, since an allowance cannot be raised in place) AND the secret stored for
 * it re-derives that public key. Anything else keeps the full-access key.
 */
export async function lockoutGate(
  chain: ChainPort,
  keys: Pick<KeyStore, 'derive'>,
  want: { accountId: string; publicKey: string; path: string; receiverId: string; methodNames: readonly string[]; allowance: bigint | null; minAllowance?: bigint | null },
): Promise<{ ok: boolean; why: string }> {
  let onChain: KeyView | null;
  try {
    onChain = await chain.key(want.accountId, want.publicKey);
  } catch (e) {
    return { ok: false, why: `the key could not be read back (${errText(e)})` };
  }
  if (!onChain) return { ok: false, why: `${want.publicKey} is not on ${want.accountId} at the final block` };
  const p = onChain.permission;
  if (p.kind !== 'FunctionCall') return { ok: false, why: `${want.publicKey} is ${p.kind === 'FullAccess' ? 'a full-access key' : 'a key of an unknown kind'}, not the function-call key asked for` };
  if (p.receiverId !== want.receiverId) return { ok: false, why: `${want.publicKey} may call ${p.receiverId}, not ${want.receiverId}` };
  if (p.methodNames.length === 0 || !sameSet(p.methodNames, want.methodNames)) return { ok: false, why: `${want.publicKey} allows [${p.methodNames.join(', ') || 'ANY METHOD'}], not exactly [${want.methodNames.join(', ')}]` };
  if (p.allowance === null) return { ok: false, why: `${want.publicKey} has an unlimited allowance` };
  if (want.allowance !== null && p.allowance !== want.allowance) return { ok: false, why: `${want.publicKey} has allowance ${p.allowance}, not the ${want.allowance} added` };
  if (want.minAllowance != null && p.allowance < want.minAllowance) {
    return {
      ok: false,
      why: `${want.publicKey} has ${nearText(p.allowance)} of allowance left, below the floor of ${nearText(want.minAllowance)}: an allowance cannot be raised in place, so once it is spent the account could never sign again. Delete that function-call key with the full-access key and run this step again to add a fresh one`,
    };
  }
  let derived: string;
  try {
    derived = await keys.derive(want.path);
  } catch (e) {
    return { ok: false, why: `the stored secret ${displayPath(want.path)} cannot be read back (${errText(e)})` };
  }
  if (derived !== want.publicKey) return { ok: false, why: `the stored secret ${displayPath(want.path)} derives ${derived}, not ${want.publicKey}` };
  return {
    ok: true,
    why: `${want.publicKey} is on ${want.accountId} as a function-call key (receiver ${p.receiverId}, methods [${p.methodNames.join(', ')}], allowance ${nearText(p.allowance)}) and ${displayPath(want.path)} re-derives it`,
  };
}

async function sourceVersion(ctx: Ctx, contractId: string): Promise<{ version: string | null; gitCommit: string | null }> {
  try {
    const m = await ctx.chain.view(contractId, 'contract_source_metadata');
    if (!isObj(m)) return { version: null, gitCommit: null };
    const snapshot = isObj(m.build_info) ? m.build_info.source_code_snapshot : undefined;
    const rev = typeof snapshot === 'string' ? (/[?&]rev=([0-9a-f]{7,40})/.exec(snapshot)?.[1] ?? null) : null;
    return { version: typeof m.version === 'string' ? m.version : null, gitCommit: rev };
  } catch {
    return { version: null, gitCommit: null };
  }
}

/**
 * Dry run: print and mark planned; the signer key of each transaction is looked up now (public
 * keys only), so a missing credential shows in the plan as BLOCKED for --execute, not first at
 * --execute. Record-only: report. Execute: the caller sends.
 */
async function notExecuting(ctx: Ctx, step: StepName, txs: TxPlan[], opts: { signersResolved?: boolean } = {}): Promise<StepStatus | null> {
  if (ctx.cfg.mode === 'dry-run') {
    let blocked = false;
    for (const tx of txs) {
      if (!opts.signersResolved && tx.signerKey === null) {
        const s = await signerFor(ctx, step, tx.signerId);
        if (s) tx.signerKey = s.publicKey;
        else blocked = true;
      }
      printTx(ctx, tx, DRY_RUN_LABEL);
      ctx.txs.push({ tx, label: DRY_RUN_LABEL });
    }
    ctx.planned.add(step);
    return blocked ? 'blocked' : 'planned';
  }
  if (ctx.cfg.mode === 'record-only') {
    for (const tx of txs) printTx(ctx, tx, 'not sent (--record-only sends nothing)');
    problem(ctx, step, 'NOT DONE', `--record-only sends nothing, and the chain shows this step is not done`);
    return 'failed';
  }
  return null;
}

/** Send plain (non-key) transactions in order with the signer's full-access key. */
async function sendAll(ctx: Ctx, step: StepName, txs: TxPlan[]): Promise<Array<{ tx: TxPlan; r: Extract<SendResult, { status: 'executed' }> }> | null> {
  const done: Array<{ tx: TxPlan; r: Extract<SendResult, { status: 'executed' }> }> = [];
  for (const tx of txs) {
    const key = tx.signerKey ?? (await signerFor(ctx, step, tx.signerId))?.publicKey ?? null;
    if (!key) return null;
    const signer = await loadSigner(ctx, step, tx.signerId, key);
    if (!signer || !ctx.sender) return null;
    printTx(ctx, { ...tx, signerKey: key }, 'sending');
    const r = await ctx.sender.send(tx, signer);
    if (!sent(ctx, tx, r)) return null;
    done.push({ tx, r });
  }
  return done;
}

function persist(ctx: Ctx): void {
  if (ctx.cfg.mode === 'dry-run') return;
  let fresh: Record<string, unknown>;
  try {
    fresh = JSON.parse(readFileSync(ctx.cfg.recordPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    problem(ctx, 'verify', 'FAILED', `could not re-read ${displayPath(ctx.cfg.recordPath)} before writing (${errText(e)})`);
    return;
  }
  const next = finalRecord(ctx, fresh);
  const changed = diffPaths(fresh, next).filter((p) => p !== 'updated_at');
  if (!changed.length) return;
  next.updated_at = ctx.now().toISOString().replace(/\.\d+Z$/, 'Z');
  atomicWrite(ctx.cfg.recordPath, `${JSON.stringify(next, null, 2)}\n`);
  ctx.record = next;
  for (const p of changed) if (!ctx.wrote.includes(p)) ctx.wrote.push(p);
}

function finalRecord(ctx: Ctx, base: Record<string, unknown>): Record<string, unknown> {
  const next = applyFacts(base, ctx.facts);
  if (ctx.rules) {
    const d = decideStatus(next, ctx.rules.claims, ctx.rules.resolve, evidenceIn(ctx.nearRoot));
    next.status = d.status;
  }
  return next;
}

/** Claims name their evidence relative to near/ (the judge's root), wherever the record is. */
function evidenceIn(nearRoot: string): (rel: string) => boolean {
  return (rel) => existsSync(resolve(nearRoot, rel));
}

// -- step: registry ----------------------------------------------------------------------------

async function stepRegistry(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'registry';
  const n = ctx.names;
  const wasm = ctx.wasm.registry;
  const acct = await ctx.chain.account(n.registry);
  if (acct) return registryOnChain(ctx, acct);
  say(ctx, S, `${n.registry} does not exist: it is created, funded, deployed and initialized in one batch from ${n.registryParent}`);
  const parent = await ctx.chain.account(n.registryParent);
  if (!parent) {
    problem(ctx, S, 'BLOCKED', `${n.registryParent} does not exist; only it can create ${n.registry}`);
    return 'blocked';
  }
  const f = registryFunding(wasm.size, ctx.cfg.registryMargin);
  say(ctx, S, 'balance of the new account (the Transfer):');
  for (const l of f.lines) say(ctx, S, `  ${l}`);
  const need = f.total + GAS_RESERVE;
  if (available(parent) < need) {
    problem(ctx, S, 'BLOCKED', `${n.registryParent} has ${nearText(available(parent))} spendable, needs ${nearText(need)} (the Transfer plus ${nearText(GAS_RESERVE)} for gas)`);
    return 'blocked';
  }
  say(ctx, S, `${n.registryParent} has ${nearText(available(parent))} spendable, enough for ${nearText(need)}`);
  const signer = ctx.cfg.mode === 'record-only' ? null : await signerFor(ctx, S, n.registryParent);
  const tx = registryDeployTx(n, wasm, f.total);
  tx.signerKey = signer?.publicKey ?? null;
  const shown = await notExecuting(ctx, S, [tx], { signersResolved: true });
  if (shown) return signer || ctx.cfg.mode !== 'dry-run' ? shown : 'blocked';
  if (!signer) return 'blocked';
  const done = await sendAll(ctx, S, [tx]);
  const first = done?.[0];
  if (!first) return 'failed';
  const after = await ctx.chain.account(n.registry);
  if (!after) {
    problem(ctx, S, 'FAILED', `${n.registry} does not exist after ${first.r.txHash}`);
    return 'failed';
  }
  ctx.adopted.set('registry-deploy', { id: 'registry-deploy', ref: txRefOf(first.r, n.registryParent), view: { raw: {}, outcome: first.r.outcome, final: true, blockHeight: first.r.blockHeight }, args: null, publicKey: null, deleted: [] });
  const status = await registryOnChain(ctx, after);
  persist(ctx);
  return status === 'done' ? 'executed' : status;
}

async function registryOnChain(ctx: Ctx, acct: AccountView): Promise<StepStatus> {
  const S: StepName = 'registry';
  const n = ctx.names;
  const wasm = ctx.wasm.registry;
  const problems: string[] = [];
  if (acct.codeHash === ZERO_CODE_HASH) problems.push(`${n.registry} exists but runs no contract: CreateAccount cannot run again, and this script never deploys onto an existing account`);
  else if (acct.codeHash !== wasm.b58) problems.push(`${n.registry} runs code_hash ${acct.codeHash}, not base58(sha256(${wasm.name})) = ${wasm.b58}; this script never redeploys`);
  const keys = await ctx.chain.keys(n.registry);
  if (keys.length) problems.push(`${n.registry} holds ${keys.length} access key(s) (${describeKeys(keys)}); the registry must hold none`);
  let owner: unknown = null;
  let oracles: unknown = null;
  if (acct.codeHash === wasm.b58) {
    owner = await ctx.chain.view(n.registry, 'owner');
    oracles = await ctx.chain.view(n.registry, 'oracles');
    if (owner !== n.registryOwner) problems.push(`owner() is ${JSON.stringify(owner)}, not ${n.registryOwner}`);
    const list = Array.isArray(oracles) ? oracles.map(String) : [];
    if (!sameSet(list, n.oracles)) problems.push(`oracles() is ${JSON.stringify(oracles)}, not ${JSON.stringify(n.oracles)}`);
  }
  if (problems.length) {
    for (const p of problems) problem(ctx, S, 'MISMATCH', p);
    return 'mismatch';
  }
  say(ctx, S, `done on chain: ${n.registry} runs code_hash ${acct.codeHash} = base58(sha256(${wasm.name})), 0 access keys, owner ${String(owner)}, oracles ${JSON.stringify(oracles)}; ${nearText(acct.amount)} balance, ${acct.storageUsage} bytes stored`);
  if (!recordedWasmAgrees(ctx, S, 'registry', acct.codeHash)) return 'mismatch';
  const recorded = recordedTx(ctx, 'contracts.registry.deploy_tx');
  const adopted = ctx.adopted.get('registry-deploy');
  if (recorded && adopted && recorded.hash !== adopted.ref.hash) {
    problem(ctx, S, 'MISMATCH', `the record names deploy tx ${recorded.hash}, --adopt-tx names ${adopted.ref.hash}`);
    return 'mismatch';
  }
  const deployTx = recorded ?? adopted?.ref ?? null;
  const src = await sourceVersion(ctx, n.registry);
  ctx.facts.registry = { codeHash: acct.codeHash, wasm, version: src.version, deployTx, build: buildFacts('registry', ctx.gate.verified, src.gitCommit) };
  if (!deployTx) {
    gap(ctx, S, 'contracts.registry.deploy_tx', n.registry);
    return 'mismatch';
  }
  if (!checkRecorded(ctx, S, 'keys.registry.lock.tx_hash', deployTx.hash)) return 'mismatch';
  say(ctx, S, `deploy tx ${deployTx.hash} (${recorded ? 'recorded' : 'adopted, checked on chain'}), version ${src.version ?? 'unknown'}`);
  return 'done';
}

// -- step: oracle-key --------------------------------------------------------------------------

async function registryDeployed(ctx: Ctx): Promise<boolean> {
  const a = await ctx.chain.account(ctx.names.registry);
  return a !== null && a.codeHash === ctx.wasm.registry.b58;
}

/** The oracle's function-call key may stand in for its full-access key only if this much of its allowance is left. */
export const ORACLE_ALLOWANCE_FLOOR_DIVISOR = 10n;

type OracleAdmission = { deployed: boolean; lists: boolean; detail: string };

/** Whether the registry runs the wasm and its oracles() lists the oracle: otherwise every set_verdict the oracle signs is refused NotOracle. */
async function oracleAdmitted(ctx: Ctx): Promise<OracleAdmission> {
  const n = ctx.names;
  if (!(await registryDeployed(ctx))) return { deployed: false, lists: false, detail: `${n.registry} is not deployed with ${ctx.wasm.registry.name}` };
  const oracles = await ctx.chain.view(n.registry, 'oracles');
  const list = Array.isArray(oracles) ? oracles.map(String) : [];
  if (list.includes(n.oracle)) return { deployed: true, lists: true, detail: `${n.registry}.oracles() is ${JSON.stringify(oracles)}, which includes ${n.oracle}` };
  return {
    deployed: true,
    lists: false,
    detail: `${n.registry}.oracles() is ${JSON.stringify(oracles)}, without ${n.oracle}: with its full-access key deleted, every verdict it signs would be refused NotOracle until ${n.registryOwner} calls add_oracle`,
  };
}

async function stepOracleKey(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'oracle-key';
  const n = ctx.names;
  const acct = await ctx.chain.account(n.oracle);
  if (!acct) {
    problem(ctx, S, 'BLOCKED', `${n.oracle} does not exist`);
    return 'blocked';
  }
  const keys = await ctx.chain.keys(n.oracle);
  say(ctx, S, `on chain: ${n.oracle} holds ${describeKeys(keys)}`);
  const full = keys.filter(isFull);
  const good = keys.filter((k) => isScopedKey(k, n.registry, ORACLE_METHODS));
  const other = keys.filter((k) => !isFull(k) && !isScopedKey(k, n.registry, ORACLE_METHODS));
  if (other.length) {
    problem(ctx, S, 'MISMATCH', `${other.length} key(s) that are neither full-access nor exactly the oracle's function-call key (${describeKeys(other)}); this script cannot explain them`);
    return 'mismatch';
  }
  if (good.length > 1) {
    problem(ctx, S, 'MISMATCH', `${good.length} oracle function-call keys; exactly one is expected`);
    return 'mismatch';
  }
  const files = ctx.keys.list(n.oracle);
  const fc = good[0];
  let held: { publicKey: string; path: string } | null = null;
  if (fc) {
    const file = files.find((f) => f.publicKey === fc.publicKey);
    if (!file) {
      problem(
        ctx,
        S,
        full.length ? 'LOCKOUT GUARD' : 'FAILED',
        full.length
          ? `the function-call key ${fc.publicKey} is on chain but no key file in ${displayPath(ctx.keys.dir)} holds its secret; deleting the full-access key now would leave the oracle unable to sign. Nothing is deleted.`
          : `the oracle's only key ${fc.publicKey} has no key file in ${displayPath(ctx.keys.dir)}: the oracle cannot sign from here, and with no full-access key left nothing can add another key to it`,
      );
      return full.length ? 'blocked' : 'failed';
    }
    const derived = await deriveOk(ctx, file.path);
    if ('error' in derived || derived.publicKey !== fc.publicKey) {
      problem(ctx, S, 'LOCKOUT GUARD', `${displayPath(file.path)} does not re-derive ${fc.publicKey} (${'error' in derived ? derived.error : `it derives ${derived.publicKey}`}); nothing is deleted`);
      return 'blocked';
    }
    say(ctx, S, `function-call key ${fc.publicKey}: its secret is in ${displayPath(file.path)} (mode ${file.mode.toString(8)}) and re-derives the same public key`);
    if (!full.length) return oracleDone(ctx, fc);
    held = { publicKey: fc.publicKey, path: file.path };
  } else if (!full.length) {
    problem(ctx, S, 'MISMATCH', `${n.oracle} holds neither a full-access key nor the oracle key: nothing can add a key to it`);
    return 'mismatch';
  }
  // From here the oracle still holds a full-access key, and this step ends by deleting it: only
  // for an oracle the registry admits, or the account would keep a key the registry refuses.
  const admitted = await oracleAdmitted(ctx);
  if (admitted.deployed && !admitted.lists) {
    problem(ctx, S, 'LOCKOUT GUARD', `${admitted.detail}. The full-access key stays and nothing is sent`);
    return 'blocked';
  }
  const ready = admitted.deployed || ctx.planned.has('registry');
  const signer = ctx.cfg.mode === 'record-only' ? null : await signerFor(ctx, S, n.oracle);
  const del = oracleDeleteKeysTx(n, full.map((k) => k.publicKey), signer?.publicKey ?? full[0]?.publicKey ?? null);
  if (held) {
    if (!ready) {
      problem(ctx, S, 'BLOCKED', `${n.registry} is not deployed with ${ctx.wasm.registry.name}: the oracle keeps its full-access key until the registry it writes to exists`);
      return 'blocked';
    }
    return oracleExecute(ctx, { fc: held, add: null, del, signerKey: signer?.publicKey ?? null });
  }
  const add = oracleAddKeyTx(n, null, ctx.cfg.oracleAllowance, signer?.publicKey ?? null);
  if (!ready && ctx.cfg.mode !== 'dry-run') {
    problem(ctx, S, 'BLOCKED', `run the registry step first: the oracle loses its full-access key only after ${n.registry} is deployed`);
    return 'blocked';
  }
  return oracleExecute(ctx, { fc: null, add, del, signerKey: signer?.publicKey ?? null });
}

/** What the oracle's function-call key must be before its full-access key goes. */
function oracleWant(ctx: Ctx, fc: { publicKey: string; path: string }, justAdded: boolean) {
  return {
    accountId: ctx.names.oracle,
    publicKey: fc.publicKey,
    path: fc.path,
    receiverId: ctx.names.registry,
    methodNames: ORACLE_METHODS,
    allowance: justAdded ? ctx.cfg.oracleAllowance : null,
    minAllowance: justAdded ? null : ctx.cfg.oracleAllowance / ORACLE_ALLOWANCE_FLOOR_DIVISOR,
  };
}

async function oracleExecute(ctx: Ctx, plan: { fc: { publicKey: string; path: string } | null; add: TxPlan | null; del: TxPlan; signerKey: string | null }): Promise<StepStatus> {
  const S: StepName = 'oracle-key';
  const n = ctx.names;
  const floor = ctx.cfg.oracleAllowance / ORACLE_ALLOWANCE_FLOOR_DIVISOR;
  const gateText = `gate before ${plan.del.id}: the ${plan.fc ? 'function-call' : 'new'} key is on chain at the final block with exactly receiver ${n.registry}, methods [${ORACLE_METHODS.join(', ')}] and ${plan.fc ? `at least ${nearText(floor)} of allowance left (a tenth of --oracle-allowance)` : 'exactly the allowance added'}, its stored secret re-derives it (lockoutGate), and ${n.registry}.oracles() still lists ${n.oracle}; otherwise nothing is deleted`;
  if (ctx.cfg.mode !== 'execute') {
    if (ctx.cfg.mode === 'dry-run' && plan.fc) {
      // Resuming: the replacement is already on chain, so the gate can be evaluated now.
      const g = await lockoutGate(ctx.chain, ctx.keys, oracleWant(ctx, plan.fc, false));
      if (!g.ok) {
        problem(ctx, S, 'BLOCKED for --execute, LOCKOUT GUARD', `${g.why}; the full-access key(s) stay`);
        return 'blocked';
      }
      say(ctx, S, `lockout guard, evaluated now: ${g.why}`);
    }
    const shown = await notExecuting(ctx, S, [...(plan.add ? [plan.add] : []), plan.del], { signersResolved: true });
    if (ctx.cfg.mode === 'dry-run') {
      if (plan.add) say(ctx, S, `at --execute the new key is generated first and its secret written 0600 to ${displayPath(join(ctx.keys.dir, n.oracle))}/ed25519_<public key>.json and read back; only then is ${plan.add.id} sent`);
      say(ctx, S, gateText);
    }
    if (!(await registryDeployed(ctx))) say(ctx, S, `${plan.del.id} waits for the registry step${ctx.planned.has('registry') ? ' (planned in this run)' : ': at --execute this step is blocked until the registry is deployed'}`);
    return plan.signerKey || ctx.cfg.mode !== 'dry-run' ? (shown ?? 'planned') : 'blocked';
  }
  if (!plan.signerKey) return 'blocked';
  const signer = await loadSigner(ctx, S, n.oracle, plan.signerKey);
  if (!signer || !ctx.sender) return 'blocked';
  let fc = plan.fc;
  let added: string | null = null;
  if (!fc && plan.add) {
    let created: { publicKey: string; path: string };
    try {
      created = await ctx.keys.create(n.oracle);
    } catch (e) {
      problem(ctx, S, 'FAILED', `could not write the new key file (${errText(e)}); nothing was sent`);
      return 'failed';
    }
    const back = await deriveOk(ctx, created.path);
    if ('error' in back || back.publicKey !== created.publicKey) {
      problem(ctx, S, 'FAILED', `${displayPath(created.path)} does not read back as ${created.publicKey} (${'error' in back ? back.error : back.publicKey}); nothing was sent`);
      return 'failed';
    }
    say(ctx, S, `new key ${created.publicKey}: secret written to ${displayPath(created.path)} (0600) and read back before anything is sent`);
    const add: TxPlan = { ...plan.add, signerKey: plan.signerKey, actions: plan.add.actions.map((a) => (a.type === 'AddKey' ? { ...a, publicKey: created.publicKey } : a)) };
    printTx(ctx, add, 'sending');
    const r = await ctx.sender.send(add, signer);
    if (!sent(ctx, add, r)) {
      say(ctx, S, `the full-access key stays; ${displayPath(created.path)} holds a key that is not on chain and can be removed`);
      return 'failed';
    }
    added = r.txHash;
    ctx.facts.oracleKey = { publicKey: created.publicKey, receiverId: n.registry, allowance: ctx.cfg.oracleAllowance.toString(), addTx: r.txHash };
    persist(ctx);
    fc = created;
  }
  if (!fc) return 'failed';
  const gate = await lockoutGate(ctx.chain, ctx.keys, oracleWant(ctx, fc, added !== null));
  if (!gate.ok) {
    problem(ctx, S, 'LOCKOUT GUARD', `${gate.why}; the full-access key(s) stay`);
    return 'failed';
  }
  // Read again right before the delete: the registry's oracle set is the registry owner's to change.
  const admitted = await oracleAdmitted(ctx);
  if (!admitted.lists) {
    problem(ctx, S, 'LOCKOUT GUARD', `${admitted.detail}; the full-access key(s) stay`);
    return 'failed';
  }
  say(ctx, S, `lockout guard passed: ${gate.why}; ${admitted.detail}`);
  const del = { ...plan.del, signerKey: plan.signerKey };
  printTx(ctx, del, 'sending');
  const r2 = await ctx.sender.send(del, signer);
  if (!sent(ctx, del, r2)) return 'failed';
  const after = await ctx.chain.keys(n.oracle);
  const good = after.filter((k) => isScopedKey(k, n.registry, ORACLE_METHODS));
  if (after.some(isFull) || good.length !== 1 || after.length !== 1) {
    problem(ctx, S, 'FAILED', `after ${r2.txHash} the oracle holds ${describeKeys(after)}; expected exactly the function-call key`);
    return 'failed';
  }
  ctx.adopted.set('oracle-delete-keys', { id: 'oracle-delete-keys', ref: txRefOf(r2, n.oracle), view: { raw: {}, outcome: r2.outcome, final: true, blockHeight: r2.blockHeight }, args: null, publicKey: null, deleted: del.actions.map((a) => (a.type === 'DeleteKey' ? a.publicKey : '')) });
  if (added) ctx.adopted.set('oracle-add-key', { id: 'oracle-add-key', ref: { hash: added, signer_id: n.oracle, block_height: null }, view: { raw: {}, outcome: r2.outcome, final: true, blockHeight: null }, args: null, publicKey: fc.publicKey, deleted: [] });
  const status = await oracleDone(ctx, good[0] as KeyView);
  persist(ctx);
  return status === 'done' ? 'executed' : status;
}

async function oracleDone(ctx: Ctx, fc: KeyView): Promise<StepStatus> {
  const S: StepName = 'oracle-key';
  const n = ctx.names;
  const p = fc.permission;
  say(ctx, S, `done on chain: ${n.oracle} holds exactly one key, the function-call key ${fc.publicKey} (receiver ${n.registry}, methods [${ORACLE_METHODS.join(', ')}], allowance ${p.kind === 'FunctionCall' && p.allowance !== null ? nearText(p.allowance) : '?'}), and no full-access key`);
  if (!checkRecorded(ctx, S, 'keys.oracle.function_call.public_key', fc.publicKey)) return 'mismatch';
  const addAdopted = ctx.adopted.get('oracle-add-key');
  if (addAdopted && addAdopted.publicKey !== fc.publicKey) {
    problem(ctx, S, 'MISMATCH', `--adopt-tx ${addAdopted.ref.hash} added ${String(addAdopted.publicKey)}, not the key on chain ${fc.publicKey}`);
    return 'mismatch';
  }
  const addPick = pickTx(ctx, S, 'keys.oracle.function_call.add_tx_hash', addAdopted?.ref.hash);
  if (!addPick.ok) return 'mismatch';
  const addTx = addPick.hash;
  const allowance =
    recordedString(ctx, 'keys.oracle.function_call.allowance_yocto') ??
    (ctx.facts.oracleKey?.publicKey === fc.publicKey ? ctx.facts.oracleKey.allowance : null) ??
    (addAdopted?.args && typeof addAdopted.args.allowance === 'string' ? addAdopted.args.allowance : null);
  ctx.facts.oracleKey = { publicKey: fc.publicKey, receiverId: n.registry, allowance, addTx };
  const lockPick = pickTx(ctx, S, 'keys.oracle.lock.tx_hash', ctx.adopted.get('oracle-delete-keys')?.ref.hash);
  if (!lockPick.ok) return 'mismatch';
  const lockTx = lockPick.hash;
  if (lockTx) ctx.facts.oracleLock = { txHash: lockTx };
  let ok = true;
  if (!addTx) {
    gap(ctx, S, 'keys.oracle.function_call.add_tx_hash', n.oracle);
    ok = false;
  }
  if (!lockTx) {
    gap(ctx, S, 'keys.oracle.lock.tx_hash (the DeleteKey of the full-access key)', n.oracle);
    ok = false;
  }
  return ok ? 'done' : 'mismatch';
}

// -- step: vault -------------------------------------------------------------------------------

async function readTokenStorage(ctx: Ctx): Promise<bigint | null> {
  if (ctx.tokenStorage !== null) return ctx.tokenStorage;
  try {
    const b = await ctx.chain.view(ctx.names.token, 'storage_balance_bounds');
    if (isObj(b) && typeof b.min === 'string' && /^\d+$/.test(b.min)) ctx.tokenStorage = BigInt(b.min);
  } catch {
    ctx.tokenStorage = null;
  }
  return ctx.tokenStorage;
}

async function stepVault(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'vault';
  const n = ctx.names;
  const wasm = ctx.wasm.vault;
  const acct = await ctx.chain.account(n.vault);
  if (acct) return vaultOnChain(ctx, acct);
  say(ctx, S, `${n.vault} does not exist: it is created, funded, deployed and initialized in one batch from ${n.vaultParent}`);
  if (!(await registryDeployed(ctx)) && !ctx.planned.has('registry')) {
    problem(ctx, S, 'BLOCKED', `run the registry step first: the vault's registry_id names ${n.registry}`);
    return 'blocked';
  }
  const parent = await ctx.chain.account(n.vaultParent);
  if (!parent) {
    problem(ctx, S, 'BLOCKED', `${n.vaultParent} does not exist; only it can create ${n.vault}`);
    return 'blocked';
  }
  const storage = await readTokenStorage(ctx);
  if (storage === null) {
    problem(ctx, S, 'BLOCKED', `${n.token}.storage_balance_bounds() could not be read; the vault's init needs its min`);
    return 'blocked';
  }
  const recordedStorage = recordedString(ctx, 'token.storage_deposit_yocto');
  say(ctx, S, `${n.token}.storage_balance_bounds().min = ${storage} (${nearText(storage)})${recordedStorage === null ? '' : recordedStorage === storage.toString() ? ', as the record expects' : `, NOT the record's ${recordedStorage}: the vault is initialized with the value read now`}`);
  const f = vaultFunding(wasm.size, ctx.cfg.vaultFloat, ctx.cfg.agentAllowance, storage, ctx.gasPrice);
  say(ctx, S, 'balance of the new account (the Transfer):');
  for (const l of f.lines) say(ctx, S, `  ${l}`);
  if (f.minimumFloat !== undefined && ctx.cfg.vaultFloat < f.minimumFloat) {
    problem(ctx, S, 'BLOCKED', `--vault-float ${nearText(ctx.cfg.vaultFloat)} is below the ${nearText(f.minimumFloat)} the agent's allowance and the vault's storage bounds need`);
    return 'blocked';
  }
  const need = f.total + GAS_RESERVE;
  if (available(parent) < need) {
    problem(ctx, S, 'BLOCKED', `${n.vaultParent} has ${nearText(available(parent))} spendable, needs ${nearText(need)}`);
    return 'blocked';
  }
  say(ctx, S, `${n.vaultParent} has ${nearText(available(parent))} spendable, enough for ${nearText(need)}`);
  const init: VaultInit = {
    owner_id: n.vaultOwner,
    token_id: n.token,
    registry_id: n.registry,
    token_storage_deposit: storage.toString(),
    daily_cap: ctx.cfg.dailyCap.toString(),
    auto_approve_max: ctx.cfg.autoApproveMax.toString(),
  };
  say(ctx, S, `policy at init: daily_cap ${init.daily_cap} (${usdcText(ctx.cfg.dailyCap)}), auto_approve_max ${init.auto_approve_max} (${usdcText(ctx.cfg.autoApproveMax)}); new sets allowlist_enabled false and hold_unknown true`);
  const signer = ctx.cfg.mode === 'record-only' ? null : await signerFor(ctx, S, n.vaultParent);
  const tx = vaultDeployTx(n, wasm, f.total, init);
  tx.signerKey = signer?.publicKey ?? null;
  const shown = await notExecuting(ctx, S, [tx], { signersResolved: true });
  if (shown) return signer || ctx.cfg.mode !== 'dry-run' ? shown : 'blocked';
  if (!signer) return 'blocked';
  const done = await sendAll(ctx, S, [tx]);
  const first = done?.[0];
  if (!first) return 'failed';
  const after = await ctx.chain.account(n.vault);
  if (!after) {
    problem(ctx, S, 'FAILED', `${n.vault} does not exist after ${first.r.txHash}`);
    return 'failed';
  }
  ctx.adopted.set('vault-deploy', { id: 'vault-deploy', ref: txRefOf(first.r, n.vaultParent), view: { raw: {}, outcome: first.r.outcome, final: true, blockHeight: first.r.blockHeight }, args: { ...init }, publicKey: null, deleted: [] });
  const status = await vaultOnChain(ctx, after);
  persist(ctx);
  return status === 'done' ? 'executed' : status;
}

async function vaultOnChain(ctx: Ctx, acct: AccountView): Promise<StepStatus> {
  const S: StepName = 'vault';
  const n = ctx.names;
  const wasm = ctx.wasm.vault;
  const problems: string[] = [];
  if (acct.codeHash === ZERO_CODE_HASH) problems.push(`${n.vault} exists but runs no contract; this script never deploys onto an existing account`);
  else if (acct.codeHash !== wasm.b58) problems.push(`${n.vault} runs code_hash ${acct.codeHash}, not base58(sha256(${wasm.name})) = ${wasm.b58}; this script never redeploys`);
  const keys = await ctx.chain.keys(n.vault);
  if (keys.some(isFull)) problems.push(`${n.vault} holds a full-access key (${describeKeys(keys.filter(isFull))}); the vault must hold none`);
  let config: Record<string, unknown> | null = null;
  if (acct.codeHash === wasm.b58) {
    const c = await ctx.chain.view(n.vault, 'get_config');
    config = isObj(c) ? c : null;
    if (!config) problems.push('get_config() returned nothing');
    else {
      if (config.owner_id !== n.vaultOwner) problems.push(`get_config().owner_id is ${JSON.stringify(config.owner_id)}, not ${n.vaultOwner}`);
      if (config.token_id !== n.token) problems.push(`get_config().token_id is ${JSON.stringify(config.token_id)}, not the token ${n.token}`);
      if (config.registry_id !== n.registry) problems.push(`get_config().registry_id is ${JSON.stringify(config.registry_id)}, not ${n.registry}`);
      if (config.frozen !== false) problems.push('the vault is frozen');
    }
  }
  if (problems.length) {
    for (const p of problems) problem(ctx, S, 'MISMATCH', p);
    return 'mismatch';
  }
  say(ctx, S, `done on chain: ${n.vault} runs code_hash ${acct.codeHash} = base58(sha256(${wasm.name})), no full-access key, owner ${n.vaultOwner}, token ${n.token}, registry ${n.registry}, ${String(config?.version ?? '')}; ${nearText(acct.amount)} balance, ${acct.storageUsage} bytes stored (${nearText(available(acct))} liquid)`);
  if (!recordedWasmAgrees(ctx, S, 'vault', acct.codeHash)) return 'mismatch';
  const recorded = recordedTx(ctx, 'contracts.vault.deploy_tx');
  const adopted = ctx.adopted.get('vault-deploy');
  if (recorded && adopted && recorded.hash !== adopted.ref.hash) {
    problem(ctx, S, 'MISMATCH', `the record names deploy tx ${recorded.hash}, --adopt-tx names ${adopted.ref.hash}`);
    return 'mismatch';
  }
  const deployTx = recorded ?? adopted?.ref ?? null;
  const a = adopted?.args;
  const initArgs =
    a && typeof a.daily_cap === 'string' && typeof a.auto_approve_max === 'string' && typeof a.token_storage_deposit === 'string'
      ? { daily_cap: a.daily_cap, auto_approve_max: a.auto_approve_max, token_storage_deposit: a.token_storage_deposit }
      : null;
  const src = await sourceVersion(ctx, n.vault);
  ctx.facts.vault = { codeHash: acct.codeHash, wasm, version: src.version, deployTx, build: buildFacts('vault', ctx.gate.verified, src.gitCommit), initArgs };
  if (config && typeof config.token_storage_deposit === 'string') ctx.facts.tokenStorage = config.token_storage_deposit;
  if (!deployTx) {
    gap(ctx, S, 'contracts.vault.deploy_tx', n.vault);
    return 'mismatch';
  }
  if (!checkRecorded(ctx, S, 'keys.vault.lock.tx_hash', deployTx.hash)) return 'mismatch';
  if (!initArgs && getIn(ctx.record, 'contracts.vault.init.args.daily_cap') == null) {
    problem(ctx, S, 'RECORD GAP', 'contracts.vault.init.args (daily_cap, auto_approve_max) are not recorded and the deploy transaction was not read back; pass the deploy transaction with --adopt-tx');
    return 'mismatch';
  }
  say(ctx, S, `deploy tx ${deployTx.hash} (${recorded ? 'recorded' : 'adopted, checked on chain'}), version ${src.version ?? 'unknown'}`);
  return 'done';
}

// -- steps: vault-register, vault-policy, vault-fund -------------------------------------------

async function vaultDeployed(ctx: Ctx): Promise<boolean> {
  const a = await ctx.chain.account(ctx.names.vault);
  return a !== null && a.codeHash === ctx.wasm.vault.b58;
}

function setupFact(ctx: Ctx, key: SetupKey, ref: TxRef & { amount?: string }): void {
  ctx.facts.setup = { ...(ctx.facts.setup ?? {}), [key]: ref };
}

function adoptedOrRecordedSetup(ctx: Ctx, key: SetupKey, id: TxId): (TxRef & { amount?: string }) | null {
  const v = getIn(ctx.record, `contracts.vault.setup.${key}`);
  if (isObj(v) && typeof v.hash === 'string') return { hash: v.hash, signer_id: String(v.signer_id ?? ''), block_height: typeof v.block_height === 'number' ? v.block_height : null, ...(typeof v.amount === 'string' ? { amount: v.amount } : {}) };
  const a = ctx.adopted.get(id);
  if (!a) return null;
  const amount = a.args && typeof a.args.amount === 'string' ? a.args.amount : undefined;
  return { ...a.ref, ...(amount ? { amount } : {}) };
}

async function stepVaultRegister(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'vault-register';
  const n = ctx.names;
  if (!(await vaultDeployed(ctx))) {
    if (ctx.planned.has('vault')) {
      say(ctx, S, `after the vault step: new registers ${n.vault} on ${n.token} itself (its own NEAR pays the storage deposit). This step then reads storage_balance_of and sends register_with_token only if it is still null; nothing is planned now`);
      return 'planned';
    }
    problem(ctx, S, 'BLOCKED', `run the vault step first: ${n.vault} is not deployed`);
    return 'blocked';
  }
  const bal = await ctx.chain.view(n.token, 'storage_balance_of', { account_id: n.vault });
  const known = adoptedOrRecordedSetup(ctx, 'register_with_token', 'vault-register');
  if (known) setupFact(ctx, 'register_with_token', known);
  if (isObj(bal)) {
    say(ctx, S, `done on chain: ${n.token} has ${n.vault} registered (storage total ${String(bal.total)})${known ? `; register_with_token ${known.hash}` : '; no register_with_token is recorded (new registers the vault itself when its NEAR covers the deposit)'}`);
    return 'done';
  }
  say(ctx, S, `${n.token}.storage_balance_of(${n.vault}) is null: the vault is not registered on the token, so no deposit can reach it`);
  const tx = registerTx(n);
  const shown = await notExecuting(ctx, S, [tx]);
  if (shown) return shown;
  const done = await sendAll(ctx, S, [tx]);
  const first = done?.[0];
  if (!first) return 'failed';
  const again = await ctx.chain.view(n.token, 'storage_balance_of', { account_id: n.vault });
  if (!isObj(again)) {
    problem(ctx, S, 'FAILED', `still not registered after ${first.r.txHash}; the vault may lack the NEAR for the deposit`);
    return 'failed';
  }
  setupFact(ctx, 'register_with_token', txRefOf(first.r, n.vaultOwner));
  persist(ctx);
  return 'executed';
}

const POLICY_FIELDS = ['daily_cap', 'auto_approve_max', 'allowlist_enabled', 'hold_unknown'] as const;
type PolicyField = (typeof POLICY_FIELDS)[number];
type PolicyWant = { value: string | boolean; from: 'flag' | 'record' | 'init' | 'default' };

/**
 * The policy the vault should have, field by field, and where that comes from: an explicit
 * --daily-cap / --auto-approve-max, else the record's policy.*, else the recorded init args, else
 * this deploy's defaults (what new sets). Only a field that comes from an explicit flag may be
 * changed on chain; every other difference is the owner's (or someone's) change this script
 * cannot explain, so it stops instead of reverting it.
 */
function policyWanted(ctx: Ctx): Record<PolicyField, PolicyWant> {
  const cap = (field: 'daily_cap' | 'auto_approve_max', flag: bigint, given: boolean): PolicyWant => {
    if (given) return { value: flag.toString(), from: 'flag' };
    const recorded = getIn(ctx.record, `policy.${field}`);
    if (typeof recorded === 'string') return { value: recorded, from: 'record' };
    const init = getIn(ctx.record, `contracts.vault.init.args.${field}`);
    if (typeof init === 'string') return { value: init, from: 'init' };
    return { value: flag.toString(), from: 'default' };
  };
  const bool = (field: 'allowlist_enabled' | 'hold_unknown', dflt: boolean): PolicyWant => {
    const recorded = getIn(ctx.record, `policy.${field}`);
    return typeof recorded === 'boolean' ? { value: recorded, from: 'record' } : { value: dflt, from: 'default' };
  };
  return {
    daily_cap: cap('daily_cap', ctx.cfg.dailyCap, ctx.cfg.dailyCapGiven),
    auto_approve_max: cap('auto_approve_max', ctx.cfg.autoApproveMax, ctx.cfg.autoApproveMaxGiven),
    allowlist_enabled: bool('allowlist_enabled', false),
    hold_unknown: bool('hold_unknown', true),
  };
}

function policySource(field: PolicyField, w: PolicyWant): string {
  if (w.from === 'flag') return `--${field.replace(/_/g, '-')}`;
  if (w.from === 'record') return `the record's policy.${field}`;
  if (w.from === 'init') return `the record's contracts.vault.init.args.${field} (no policy.${field} is recorded)`;
  return "this deploy's default (nothing is recorded)";
}

function policySourceShort(w: PolicyWant): string {
  return { flag: 'the flag', record: 'the record', init: 'the init args', default: 'the default' }[w.from];
}

function policyFacts(c: Record<string, unknown>): NonNullable<Facts['policy']> {
  return { daily_cap: String(c.daily_cap), auto_approve_max: String(c.auto_approve_max), allowlist_enabled: c.allowlist_enabled === true, hold_unknown: c.hold_unknown === true };
}

async function stepVaultPolicy(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'vault-policy';
  const n = ctx.names;
  if (!(await vaultDeployed(ctx))) {
    if (ctx.planned.has('vault')) {
      say(ctx, S, `after the vault step: new sets daily_cap ${ctx.cfg.dailyCap}, auto_approve_max ${ctx.cfg.autoApproveMax}, allowlist_enabled false and hold_unknown true, so nothing is planned`);
      return 'planned';
    }
    problem(ctx, S, 'BLOCKED', `run the vault step first: ${n.vault} is not deployed`);
    return 'blocked';
  }
  const c = await ctx.chain.view(n.vault, 'get_config');
  if (!isObj(c)) {
    problem(ctx, S, 'FAILED', 'get_config() returned nothing');
    return 'failed';
  }
  for (const [key, id] of [['set_policy', 'vault-set-policy'], ['set_hold_unknown', 'vault-set-hold-unknown']] as const) {
    const known = adoptedOrRecordedSetup(ctx, key, id);
    if (known) setupFact(ctx, key, known);
  }
  const want = policyWanted(ctx);
  const diffs = POLICY_FIELDS.filter((f) => c[f] !== want[f].value);
  const now = `get_config() has daily_cap ${String(c.daily_cap)}, auto_approve_max ${String(c.auto_approve_max)}, allowlist_enabled ${String(c.allowlist_enabled)}, hold_unknown ${String(c.hold_unknown)}, frozen ${String(c.frozen)}`;
  if (!diffs.length) {
    say(ctx, S, `done on chain: ${now}; it matches the wanted policy (${POLICY_FIELDS.map((f) => `${f} from ${policySourceShort(want[f])}`).join(', ')})`);
    ctx.facts.policy = policyFacts(c);
    return 'done';
  }
  const unexplained = diffs.filter((f) => want[f].from !== 'flag');
  if (unexplained.length) {
    for (const f of unexplained) problem(ctx, S, 'MISMATCH', `get_config().${f} is ${JSON.stringify(c[f])}, but ${policySource(f, want[f])} says ${JSON.stringify(want[f].value)}`);
    const restore = c.hold_unknown === false ? ` To turn hold_unknown back on, the owner runs: ${cliCommand(setHoldUnknownTx(n), 'testnet', 'keychain')}.` : '';
    say(
      ctx,
      S,
      `nothing is sent: this script changes the policy only for --daily-cap / --auto-approve-max given explicitly, and never reverts what the owner changed. If the change is intended, record it (policy.* in ${displayPath(ctx.cfg.recordPath)}, or pass the chain's caps as explicit flags).${restore}`,
    );
    return 'mismatch';
  }
  // Only caps asked for with explicit flags differ; allowlist_enabled and hold_unknown stay as they are.
  const cap = BigInt(String(want.daily_cap.value));
  const max = BigInt(String(want.auto_approve_max.value));
  if (cap !== 0n && max > cap) {
    problem(ctx, S, 'BLOCKED', `auto_approve_max ${max} would be above daily_cap ${cap}: no payment could ever use it`);
    return 'blocked';
  }
  const tx = setPolicyTx(n, cap, max, c.allowlist_enabled === true);
  say(ctx, S, `${now}; set_policy, asked for explicitly: daily_cap from ${String(c.daily_cap)} to ${cap} (${usdcText(cap)}), auto_approve_max from ${String(c.auto_approve_max)} to ${max} (${usdcText(max)}); allowlist_enabled stays ${String(c.allowlist_enabled)}, hold_unknown stays ${String(c.hold_unknown)}`);
  const shown = await notExecuting(ctx, S, [tx]);
  if (shown) return shown;
  const done = await sendAll(ctx, S, [tx]);
  const first = done?.[0];
  if (!first) return 'failed';
  const after = await ctx.chain.view(n.vault, 'get_config');
  if (!isObj(after) || after.daily_cap !== cap.toString() || after.auto_approve_max !== max.toString() || after.allowlist_enabled !== c.allowlist_enabled || after.hold_unknown !== c.hold_unknown) {
    problem(ctx, S, 'FAILED', `get_config() after set_policy: ${JSON.stringify(after)}`);
    return 'failed';
  }
  setupFact(ctx, 'set_policy', txRefOf(first.r, n.vaultOwner));
  ctx.facts.policy = policyFacts(after);
  persist(ctx);
  return 'executed';
}

async function ftBalance(ctx: Ctx, account: string): Promise<bigint | null> {
  const v = await ctx.chain.view(ctx.names.token, 'ft_balance_of', { account_id: account });
  return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;
}

function setupRefOf(v: unknown): SetupRef | null {
  if (!isObj(v) || typeof v.hash !== 'string') return null;
  return { hash: v.hash, signer_id: String(v.signer_id ?? ''), block_height: typeof v.block_height === 'number' ? v.block_height : null, ...(typeof v.amount === 'string' ? { amount: v.amount } : {}) };
}

/**
 * The vault's funding and top-ups: the record's, plus every adopted ft_transfer_call to the vault.
 * The earliest is the funding; each later one is a top-up. An adopted transfer older than the
 * recorded funding cannot be explained and stops the step.
 */
function fundingHistory(ctx: Ctx, step: StepName): { fund: SetupRef | null; topUps: SetupRef[] } | null {
  let fund = setupRefOf(getIn(ctx.record, 'contracts.vault.setup.fund'));
  const recordedTops = getIn(ctx.record, 'contracts.vault.setup.top_up');
  const topUps = Array.isArray(recordedTops) ? recordedTops.map(setupRefOf).filter((r): r is SetupRef => r !== null) : [];
  const height = (a: Adopted) => a.ref.block_height ?? Number.MAX_SAFE_INTEGER;
  for (const a of [...ctx.fundAdoptions].sort((x, y) => height(x) - height(y))) {
    const amount = a.args && typeof a.args.amount === 'string' ? a.args.amount : undefined;
    const ref: SetupRef = { ...a.ref, ...(amount ? { amount } : {}) };
    if (fund?.hash === ref.hash || topUps.some((t) => t.hash === ref.hash)) continue;
    if (!fund) {
      fund = ref;
      continue;
    }
    if (fund.block_height !== null && ref.block_height !== null && ref.block_height <= fund.block_height) {
      problem(ctx, step, 'MISMATCH', `--adopt-tx ${ref.hash} (block ${ref.block_height}) is an ft_transfer_call to the vault before the recorded funding ${fund.hash} (block ${fund.block_height})`);
      return null;
    }
    topUps.push(ref);
  }
  return { fund, topUps };
}

async function stepVaultFund(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'vault-fund';
  const n = ctx.names;
  const target = ctx.cfg.fund;
  const deployed = await vaultDeployed(ctx);
  if (!deployed && !ctx.planned.has('vault')) {
    problem(ctx, S, 'BLOCKED', `run the vault step first: ${n.vault} is not deployed`);
    return 'blocked';
  }
  const history = fundingHistory(ctx, S);
  if (!history) return 'mismatch';
  if (history.fund) setupFact(ctx, 'fund', history.fund);
  if (history.topUps.length) ctx.facts.topUps = history.topUps;
  const balance = deployed ? ((await ftBalance(ctx, n.vault)) ?? 0n) : 0n;
  if (!history.fund) {
    if (balance > 0n) {
      say(ctx, S, `${n.vault} holds ${usdcText(balance)}: it was funded before, and no funding transaction is recorded or adopted. Nothing is sent: a second funding would move the owner's USDC again (--top-up does that only once the funding is recorded)`);
      gap(ctx, S, "contracts.vault.setup.fund (the owner's first ft_transfer_call to the vault)", n.vault);
      return 'mismatch';
    }
    if (target === 0n) {
      say(ctx, S, `--fund 0: the vault is not funded; it holds ${usdcText(balance)}`);
      return 'done';
    }
    return sendFunding(ctx, fundTx(n, target), target, balance, deployed);
  }
  const funded = `funded by ${history.fund.hash}${history.fund.amount ? ` (${usdcText(BigInt(history.fund.amount))})` : ''}${history.topUps.length ? ` and ${history.topUps.length} recorded top-up(s)` : ''}`;
  if (!ctx.cfg.topUp) {
    say(ctx, S, `done: ${funded}; ${n.vault} holds ${usdcText(balance)} now${balance < target ? `, below --fund ${usdcText(target)} (--top-up sends the difference)` : ''}`);
    return 'done';
  }
  if (balance >= target) {
    say(ctx, S, `done: ${funded}; ${n.vault} holds ${usdcText(balance)}, at least --fund ${usdcText(target)}, so --top-up has nothing to send`);
    return 'done';
  }
  return sendFunding(ctx, fundTx(n, target - balance, 'vault-top-up'), target - balance, balance, deployed);
}

/** The funding or a top-up: ft_transfer_call from the owner, checked by its return value, the vault's deposited event and the balance after. */
async function sendFunding(ctx: Ctx, tx: TxPlan, amount: bigint, balance: bigint, deployed: boolean): Promise<StepStatus> {
  const S: StepName = 'vault-fund';
  const n = ctx.names;
  const ownerBalance = (await ftBalance(ctx, n.vaultOwner)) ?? 0n;
  const what = tx.id === 'vault-fund' ? `its one funding is ${usdcText(amount)}` : `--top-up sends ${usdcText(amount)} to bring it back to --fund ${usdcText(ctx.cfg.fund)}`;
  say(ctx, S, `${n.vault} holds ${usdcText(balance)}${deployed ? '' : ' (not deployed yet)'}; ${what} = ${amount} units from ${n.vaultOwner}, which holds ${usdcText(ownerBalance)}`);
  if (ownerBalance < amount) {
    problem(ctx, S, 'BLOCKED', `${n.vaultOwner} holds ${usdcText(ownerBalance)}, less than ${usdcText(amount)}`);
    return 'blocked';
  }
  const shown = await notExecuting(ctx, S, [tx]);
  if (shown) return shown;
  const reg = await ctx.chain.view(n.token, 'storage_balance_of', { account_id: n.vault });
  if (!isObj(reg)) {
    problem(ctx, S, 'BLOCKED', `run vault-register first: ${n.token} does not know ${n.vault}, so ft_transfer_call would fail`);
    return 'blocked';
  }
  const done = await sendAll(ctx, S, [tx]);
  const first = done?.[0];
  if (!first) return 'failed';
  const used = first.r.outcome.return_value;
  const deposited = first.r.outcome.events.some((e) => e.standard === 'a_identity_vault' && e.event === 'deposited' && e.executor_id === n.vault && isObj(e.data) && e.data.amount === amount.toString());
  const after = (await ftBalance(ctx, n.vault)) ?? 0n;
  if (used !== amount.toString() || !deposited || after < balance + amount) {
    problem(ctx, S, 'FAILED', `${first.r.txHash}: ft_transfer_call returned ${JSON.stringify(used)} (wanted "${amount}"), deposited event ${deposited ? 'present' : 'missing'}, vault holds ${usdcText(after)}`);
    return 'failed';
  }
  say(ctx, S, `the vault kept ${usdcText(amount)} (ft_transfer_call returned "${amount}", deposited emitted by ${n.vault}); it holds ${usdcText(after)}`);
  const ref: SetupRef = { ...txRefOf(first.r, n.vaultOwner), amount: amount.toString() };
  if (tx.id === 'vault-fund') setupFact(ctx, 'fund', ref);
  else ctx.facts.topUps = [...(ctx.facts.topUps ?? []), ref];
  persist(ctx);
  return 'executed';
}

// -- step: agent-key ---------------------------------------------------------------------------

function expiresAt(ctx: Ctx): string {
  if (ctx.cfg.agentExpiresDays === 0) return '0';
  return String(Math.floor(ctx.now().getTime() / 1000) + ctx.cfg.agentExpiresDays * 86_400);
}

async function stepAgentKey(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'agent-key';
  const n = ctx.names;
  const deployed = await vaultDeployed(ctx);
  if (!deployed && !ctx.planned.has('vault')) {
    problem(ctx, S, 'BLOCKED', `run the vault step first: ${n.vault} is not deployed`);
    return 'blocked';
  }
  const keys = deployed ? await ctx.chain.keys(n.vault) : [];
  if (deployed) say(ctx, S, `on chain: ${n.vault} holds ${describeKeys(keys)}`);
  const good = keys.filter((k) => isScopedKey(k, n.vault, AGENT_METHODS));
  const other = keys.filter((k) => !isScopedKey(k, n.vault, AGENT_METHODS));
  if (other.length) {
    problem(ctx, S, 'MISMATCH', `${other.length} key(s) on the vault that are not exactly the agent key (${describeKeys(other)})`);
    return 'mismatch';
  }
  if (good.length > 1) {
    problem(ctx, S, 'MISMATCH', `${good.length} agent keys on the vault; exactly one is expected`);
    return 'mismatch';
  }
  const agent = good[0];
  if (agent) return agentOnChain(ctx, agent);
  const expires = expiresAt(ctx);
  say(
    ctx,
    S,
    `no agent key yet: add_agent_key with allowance ${nearText(ctx.cfg.agentAllowance)}, expires_at_s ${expires}${expires === '0' ? ' (no expiry)' : ` (${new Date(Number(expires) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')})`}, label ${JSON.stringify(AGENT_LABEL)}`,
  );
  const tx = addAgentKeyTx(n, '<generated at --execute>', ctx.cfg.agentAllowance, expires);
  const shown = await notExecuting(ctx, S, [tx]);
  if (shown) {
    if (ctx.cfg.mode === 'dry-run') say(ctx, S, `at --execute the key is generated first and its secret written 0600 to ${displayPath(join(ctx.keys.dir, n.vault))}/ed25519_<public key>.json and read back; only then is add_agent_key sent`);
    return shown;
  }
  let created: { publicKey: string; path: string };
  try {
    created = await ctx.keys.create(n.vault);
  } catch (e) {
    problem(ctx, S, 'FAILED', `could not write the agent key file (${errText(e)}); nothing was sent`);
    return 'failed';
  }
  const back = await deriveOk(ctx, created.path);
  if ('error' in back || back.publicKey !== created.publicKey) {
    problem(ctx, S, 'FAILED', `${displayPath(created.path)} does not read back as ${created.publicKey}; nothing was sent`);
    return 'failed';
  }
  say(ctx, S, `new agent key ${created.publicKey}: secret written to ${displayPath(created.path)} (0600) and read back`);
  const real = addAgentKeyTx(n, created.publicKey, ctx.cfg.agentAllowance, expires);
  const done = await sendAll(ctx, S, [real]);
  const first = done?.[0];
  if (!first) {
    say(ctx, S, `${displayPath(created.path)} holds a key that is not on chain and can be removed`);
    return 'failed';
  }
  const added = first.r.outcome.return_value === true && first.r.outcome.events.some((e) => e.event === 'agent_key_added' && e.executor_id === n.vault);
  const failedAdd = first.r.outcome.events.some((e) => e.event === 'agent_key_add_failed');
  if (!added || failedAdd) {
    problem(ctx, S, 'FAILED', `${first.r.txHash}: add_agent_key returned ${JSON.stringify(first.r.outcome.return_value)}${failedAdd ? ' and agent_key_add_failed' : ''}`);
    return 'failed';
  }
  const gate = await lockoutGate(ctx.chain, ctx.keys, { accountId: n.vault, publicKey: created.publicKey, path: created.path, receiverId: n.vault, methodNames: AGENT_METHODS, allowance: ctx.cfg.agentAllowance });
  if (!gate.ok) {
    problem(ctx, S, 'FAILED', `after ${first.r.txHash}: ${gate.why}`);
    return 'failed';
  }
  ctx.facts.agentKey = { publicKey: created.publicKey, receiverId: n.vault, allowance: ctx.cfg.agentAllowance.toString(), addTx: first.r.txHash };
  ctx.adopted.set('agent-key-add', { id: 'agent-key-add', ref: txRefOf(first.r, n.vaultOwner), view: { raw: {}, outcome: first.r.outcome, final: true, blockHeight: first.r.blockHeight }, args: real.actions[0]?.type === 'FunctionCall' ? real.actions[0].args : null, publicKey: created.publicKey, deleted: [] });
  const status = await agentOnChain(ctx, { publicKey: created.publicKey, permission: { kind: 'FunctionCall', receiverId: n.vault, methodNames: [...AGENT_METHODS], allowance: ctx.cfg.agentAllowance } });
  persist(ctx);
  return status === 'done' ? 'executed' : status;
}

async function agentOnChain(ctx: Ctx, agent: KeyView): Promise<StepStatus> {
  const S: StepName = 'agent-key';
  const n = ctx.names;
  const p = agent.permission;
  const files = ctx.keys.list(n.vault);
  const file = files.find((f) => f.publicKey === agent.publicKey);
  if (!file) {
    problem(ctx, S, 'FAILED', `the agent key ${agent.publicKey} is on chain but no key file in ${displayPath(ctx.keys.dir)} holds its secret; the owner can revoke_agent_key, forget_agent_key and run this step again`);
    return 'failed';
  }
  const derived = await deriveOk(ctx, file.path);
  if ('error' in derived || derived.publicKey !== agent.publicKey) {
    problem(ctx, S, 'MISMATCH', `${displayPath(file.path)} does not re-derive ${agent.publicKey}`);
    return 'mismatch';
  }
  const record = await ctx.chain.view(n.vault, 'get_agent', { public_key: agent.publicKey });
  if (!isObj(record) || record.revoked !== false) {
    problem(ctx, S, 'MISMATCH', `get_agent(${agent.publicKey}) is ${JSON.stringify(record)}: the vault does not hold a live record for it, so its payments would be refused NotAgent`);
    return 'mismatch';
  }
  const allowanceNow = p.kind === 'FunctionCall' && p.allowance !== null ? p.allowance : null;
  say(
    ctx,
    S,
    `done on chain: one agent key ${agent.publicKey} (receiver ${n.vault}, methods [${AGENT_METHODS.join(', ')}], allowance ${allowanceNow === null ? '?' : nearText(allowanceNow)} left), get_agent label ${JSON.stringify(record.label)}, expires_at_s ${String(record.expires_at_s)}, not revoked; secret in ${displayPath(file.path)} (mode ${file.mode.toString(8)}), re-derives the key`,
  );
  if (allowanceNow !== null && allowanceNow !== ctx.cfg.agentAllowance) say(ctx, S, `note: --agent-allowance is ${nearText(ctx.cfg.agentAllowance)}; an allowance cannot be changed in place (revoke, forget, add)`);
  if (!checkRecorded(ctx, S, 'keys.vault.agent.public_key', agent.publicKey)) return 'mismatch';
  const adopted = ctx.adopted.get('agent-key-add');
  if (adopted && adopted.publicKey !== agent.publicKey) {
    problem(ctx, S, 'MISMATCH', `--adopt-tx ${adopted.ref.hash} added ${String(adopted.publicKey)}, not the key on chain ${agent.publicKey}`);
    return 'mismatch';
  }
  const addPick = pickTx(ctx, S, 'keys.vault.agent.add_tx_hash', adopted?.ref.hash);
  if (!addPick.ok) return 'mismatch';
  const addTx = addPick.hash;
  const allowance = recordedString(ctx, 'keys.vault.agent.allowance_yocto') ?? (adopted?.args && typeof adopted.args.allowance === 'string' ? adopted.args.allowance : null);
  ctx.facts.agentKey = { publicKey: agent.publicKey, receiverId: n.vault, allowance, addTx };
  if (!addTx) {
    gap(ctx, S, 'keys.vault.agent.add_tx_hash', n.vault);
    return 'mismatch';
  }
  return 'done';
}

// -- step: verify ------------------------------------------------------------------------------

async function stepVerify(ctx: Ctx): Promise<StepStatus> {
  const S: StepName = 'verify';
  const n = ctx.names;
  let fails = 0;
  let skips = 0;
  const check = (ok: boolean | null, text: string) => {
    if (ok === null) {
      skips++;
      say(ctx, S, `SKIP ${text}`);
    } else if (ok) say(ctx, S, `PASS ${text}`);
    else {
      fails++;
      problem(ctx, S, 'FAIL', text);
    }
  };
  const want = (path: string, planned: string): string => recordedString(ctx, path) ?? planned;
  const registry = await ctx.chain.account(n.registry);
  if (!registry) check(null, `${n.registry} does not exist yet (planned)`);
  else {
    check(registry.codeHash === ctx.wasm.registry.b58, `${n.registry} code_hash ${registry.codeHash} = base58(sha256(${ctx.wasm.registry.name})) ${ctx.wasm.registry.b58}`);
    const keys = await ctx.chain.keys(n.registry);
    check(keys.length === 0, `${n.registry} view_access_key_list: ${keys.length} keys (${describeKeys(keys)})`);
    if (registry.codeHash === ctx.wasm.registry.b58) {
      const owner = await ctx.chain.view(n.registry, 'owner');
      const oracles = await ctx.chain.view(n.registry, 'oracles');
      check(owner === n.registryOwner, `${n.registry}.owner() = ${JSON.stringify(owner)}, the record says ${n.registryOwner}`);
      check(Array.isArray(oracles) && sameSet(oracles.map(String), n.oracles), `${n.registry}.oracles() = ${JSON.stringify(oracles)}, the record says ${JSON.stringify(n.oracles)}`);
    }
  }
  const oracleKeys = (await ctx.chain.account(n.oracle)) ? await ctx.chain.keys(n.oracle) : null;
  if (!oracleKeys) check(false, `${n.oracle} does not exist`);
  else {
    const good = oracleKeys.filter((k) => isScopedKey(k, n.registry, ORACLE_METHODS));
    const full = oracleKeys.filter(isFull).length;
    if (full && ctx.planned.has('oracle-key')) check(null, `${n.oracle} still holds ${full} full-access key(s); the oracle-key step is planned`);
    else check(full === 0 && good.length === 1 && oracleKeys.length === 1, `${n.oracle} view_access_key_list: ${full} full-access, ${good.length} oracle function-call key(s), ${oracleKeys.length} in all (${describeKeys(oracleKeys)})`);
    const fc = good[0];
    if (fc) {
      const recorded = recordedString(ctx, 'keys.oracle.function_call.public_key');
      if (recorded) check(recorded === fc.publicKey, `the record's oracle key ${recorded} is the key on chain`);
      const file = ctx.keys.list(n.oracle).find((f) => f.publicKey === fc.publicKey);
      const d = file ? await deriveOk(ctx, file.path) : null;
      check(d !== null && !('error' in d) && d.publicKey === fc.publicKey, `the oracle key's secret is held locally and re-derives ${fc.publicKey}${file ? ` (${displayPath(file.path)})` : ''}`);
    }
  }
  const vault = await ctx.chain.account(n.vault);
  if (!vault) check(null, `${n.vault} does not exist yet (planned)`);
  else {
    check(vault.codeHash === ctx.wasm.vault.b58, `${n.vault} code_hash ${vault.codeHash} = base58(sha256(${ctx.wasm.vault.name})) ${ctx.wasm.vault.b58}`);
    const keys = await ctx.chain.keys(n.vault);
    const good = keys.filter((k) => isScopedKey(k, n.vault, AGENT_METHODS));
    if (!keys.length && ctx.planned.has('agent-key')) check(null, `${n.vault} has no agent key yet; the agent-key step is planned`);
    else check(keys.length === 1 && good.length === 1, `${n.vault} view_access_key_list: exactly one function-call key, receiver ${n.vault}, methods exactly [${AGENT_METHODS.join(', ')}], finite allowance (${describeKeys(keys)})`);
    const agent = good[0];
    if (agent) {
      const recordedAllowance = recordedString(ctx, 'keys.vault.agent.allowance_yocto');
      const p = agent.permission;
      if (recordedAllowance && p.kind === 'FunctionCall' && p.allowance !== null) check(p.allowance <= BigInt(recordedAllowance), `agent allowance ${p.allowance} left is at most the ${recordedAllowance} recorded at add_agent_key`);
      const file = ctx.keys.list(n.vault).find((f) => f.publicKey === agent.publicKey);
      const d = file ? await deriveOk(ctx, file.path) : null;
      check(d !== null && !('error' in d) && d.publicKey === agent.publicKey, `the agent key's secret is held locally and re-derives ${agent.publicKey}`);
    }
    if (vault.codeHash === ctx.wasm.vault.b58) {
      const c = await ctx.chain.view(n.vault, 'get_config');
      const exp = {
        owner_id: n.vaultOwner,
        token_id: n.token,
        registry_id: n.registry,
        frozen: false,
        hold_unknown: true,
        allowlist_enabled: false,
        daily_cap: want('policy.daily_cap', ctx.cfg.dailyCap.toString()),
        auto_approve_max: want('policy.auto_approve_max', ctx.cfg.autoApproveMax.toString()),
      };
      const diffs = isObj(c) ? Object.entries(exp).filter(([k, v]) => c[k] !== v).map(([k, v]) => `${k} is ${JSON.stringify(c[k])}, expected ${JSON.stringify(v)}`) : ['get_config() returned nothing'];
      check(diffs.length === 0, `${n.vault}.get_config() matches the record (owner, token, registry, not frozen, hold_unknown, no allowlist, daily_cap ${exp.daily_cap}, auto_approve_max ${exp.auto_approve_max})${diffs.length ? `: ${diffs.join('; ')}` : ''}`);
      const reg = await ctx.chain.view(n.token, 'storage_balance_of', { account_id: n.vault });
      check(isObj(reg), `${n.token} has ${n.vault} registered (storage_balance_of is not null)`);
      const bal = await ftBalance(ctx, n.vault);
      say(ctx, S, `info: ${n.vault} holds ${bal === null ? 'no USDC' : usdcText(bal)} and ${nearText(available(vault))} liquid above the stake of its ${vault.storageUsage} stored bytes`);
    }
  }
  say(ctx, S, `${fails} failed, ${skips} skipped`);
  return fails ? 'failed' : 'done';
}

// -- adopting transactions an earlier run sent -------------------------------------------------

function actionList(raw: Record<string, unknown>): unknown[] {
  const tx = isObj(raw.transaction) ? raw.transaction : {};
  return Array.isArray(tx.actions) ? tx.actions : [];
}

function fnCallOf(a: unknown): { method: string; args: Record<string, unknown> | null; deposit: string } | null {
  if (!isObj(a) || !isObj(a.FunctionCall)) return null;
  const fc = a.FunctionCall;
  let args: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(String(fc.args ?? ''), 'base64').toString('utf8'));
    args = isObj(parsed) ? parsed : null;
  } catch {
    args = null;
  }
  return { method: String(fc.method_name), args, deposit: String(fc.deposit ?? '0') };
}

function deployHashOf(a: unknown): string | null {
  if (!isObj(a) || !isObj(a.DeployContract)) return null;
  const code = a.DeployContract.code;
  if (typeof code !== 'string') return null;
  const bytes = Buffer.from(code, 'base64');
  return bytes.length === 32 ? bytes.toString('hex') : null;
}

/** Which planned transaction an on-chain transaction is, checked field by field; an error otherwise. */
export function classifyTx(view: TxRecordView, n: Names, wasm: { registry: Wasm; vault: Wasm }): Omit<Adopted, 'ref' | 'view'> | { error: string } {
  const raw = view.raw;
  const tx = isObj(raw.transaction) ? raw.transaction : {};
  const signer = String(tx.signer_id ?? '');
  const receiver = String(tx.receiver_id ?? '');
  const signerKey = String(tx.public_key ?? '');
  const actions = actionList(raw);
  if (!view.final) return { error: 'not final yet' };
  if (!view.outcome.succeeded) return { error: `its final status is not a success (${JSON.stringify(view.outcome.failure).slice(0, 160)})` };
  const kinds = actions.map((a) => (typeof a === 'string' ? a : isObj(a) ? (Object.keys(a)[0] ?? '?') : '?'));
  const deploy = (target: string, parent: string, w: Wasm): { args: Record<string, unknown> } | { error: string } => {
    if (signer !== parent || receiver !== target) return { error: `signed by ${signer} for ${receiver}, not by ${parent} for ${target}` };
    if (kinds.join(',') !== 'CreateAccount,Transfer,DeployContract,FunctionCall') return { error: `actions are [${kinds.join(', ')}], not exactly CreateAccount, Transfer, DeployContract, FunctionCall` };
    const code = deployHashOf(actions[2]);
    if (code !== w.hex) return { error: `it deployed sha256 ${String(code)}, not ${w.name} (${w.hex})` };
    const init = fnCallOf(actions[3]);
    if (!init || init.method !== 'new' || !init.args) return { error: 'its FunctionCall is not new with JSON args' };
    return { args: init.args };
  };
  if (receiver === n.registry) {
    const d = deploy(n.registry, n.registryParent, wasm.registry);
    if ('error' in d) return d;
    if (d.args.owner_id !== n.registryOwner || !Array.isArray(d.args.oracles) || !sameSet(d.args.oracles.map(String), n.oracles)) return { error: `new args ${JSON.stringify(d.args)} are not the record's` };
    return { id: 'registry-deploy', args: d.args, publicKey: null, deleted: [] };
  }
  if (receiver === n.vault && kinds[0] === 'CreateAccount') {
    const d = deploy(n.vault, n.vaultParent, wasm.vault);
    if ('error' in d) return d;
    if (d.args.owner_id !== n.vaultOwner || d.args.token_id !== n.token || d.args.registry_id !== n.registry) return { error: `new args ${JSON.stringify(d.args)} are not the record's owner, token and registry` };
    return { id: 'vault-deploy', args: d.args, publicKey: null, deleted: [] };
  }
  if (signer === n.oracle && receiver === n.oracle) {
    if (kinds.length && kinds.every((k) => k === 'AddKey')) {
      const a = actions[0];
      const add = isObj(a) && isObj(a.AddKey) ? a.AddKey : null;
      const perm = add && isObj(add.access_key) ? normalizePermission(add.access_key.permission) : null;
      if (kinds.length !== 1 || !add || !perm || !isScopedKey({ publicKey: '', permission: perm }, n.registry, ORACLE_METHODS)) return { error: 'its AddKey is not exactly the oracle function-call key' };
      return { id: 'oracle-add-key', args: { allowance: perm.kind === 'FunctionCall' && perm.allowance !== null ? perm.allowance.toString() : null }, publicKey: String(add.public_key), deleted: [] };
    }
    if (kinds.length && kinds.every((k) => k === 'DeleteKey')) {
      const deleted = actions.map((a) => (isObj(a) && isObj(a.DeleteKey) ? String(a.DeleteKey.public_key) : ''));
      // Only a full-access key can sign a DeleteKey, so a transaction signed by a key it deletes
      // is that full-access key deleting itself.
      if (!deleted.includes(signerKey)) return { error: `signed by ${signerKey}, which it does not delete` };
      return { id: 'oracle-delete-keys', args: null, publicKey: null, deleted };
    }
  }
  if (signer === n.vaultOwner && kinds.length === 1 && kinds[0] === 'FunctionCall') {
    const call = fnCallOf(actions[0]);
    if (!call || !call.args) return { error: 'its FunctionCall has no JSON args' };
    if (receiver === n.vault) {
      if (call.method === 'register_with_token') return { id: 'vault-register', args: call.args, publicKey: null, deleted: [] };
      if (call.method === 'set_policy') return { id: 'vault-set-policy', args: call.args, publicKey: null, deleted: [] };
      if (call.method === 'set_hold_unknown') return { id: 'vault-set-hold-unknown', args: call.args, publicKey: null, deleted: [] };
      if (call.method === 'add_agent_key') {
        if (view.outcome.return_value !== true) return { error: `add_agent_key returned ${JSON.stringify(view.outcome.return_value)}, not true` };
        return { id: 'agent-key-add', args: call.args, publicKey: String(call.args.public_key), deleted: [] };
      }
    }
    if (receiver === n.token && call.method === 'ft_transfer_call' && call.args.receiver_id === n.vault) {
      if (view.outcome.return_value !== call.args.amount) return { error: `ft_transfer_call returned ${JSON.stringify(view.outcome.return_value)}, the vault did not keep all of ${String(call.args.amount)}` };
      return { id: 'vault-fund', args: call.args, publicKey: null, deleted: [] };
    }
  }
  return { error: `signed by ${signer} for ${receiver} with [${kinds.join(', ')}]: not a transaction of this deploy` };
}

async function adoptAll(ctx: Ctx): Promise<boolean> {
  const n = ctx.names;
  const senders = [...new Set([n.registryParent, n.oracle, n.vaultParent, n.vaultOwner])];
  let ok = true;
  for (const hash of ctx.cfg.adopt) {
    let view: TxRecordView | null = null;
    let sender = '';
    for (const s of senders) {
      view = await ctx.chain.tx(hash, s);
      if (view) {
        sender = s;
        break;
      }
    }
    if (!view) {
      ctx.problems.push(`[adopt] ${hash}: not found on archival RPC for any of ${senders.join(', ')}`);
      ctx.out(`[adopt] FAILED: ${hash} not found on archival RPC for any of ${senders.join(', ')}`);
      ok = false;
      continue;
    }
    const c = classifyTx(view, n, ctx.wasm);
    if ('error' in c) {
      ctx.problems.push(`[adopt] ${hash}: ${c.error}`);
      ctx.out(`[adopt] FAILED: ${hash} ${c.error}`);
      ok = false;
      continue;
    }
    const signerId = isObj(view.raw.transaction) ? String(view.raw.transaction.signer_id) : sender;
    const adopted: Adopted = { ...c, ref: { hash, signer_id: signerId, block_height: view.blockHeight }, view };
    if (c.id === 'vault-fund') {
      // The vault may have been funded and then topped up: the earliest transfer is the funding.
      if (!ctx.fundAdoptions.some((a) => a.ref.hash === hash)) ctx.fundAdoptions.push(adopted);
      ctx.out(`[adopt] ${hash}: an ft_transfer_call of ${String(c.args?.amount)} to the vault, signed by ${signerId}, final at block ${view.blockHeight ?? 'unknown'}, success; the earliest such transfer is the funding, later ones top-ups`);
      continue;
    }
    if (ctx.adopted.has(c.id)) {
      ctx.problems.push(`[adopt] ${hash}: a second ${c.id} transaction`);
      ctx.out(`[adopt] FAILED: ${hash} is a second ${c.id} transaction`);
      ok = false;
      continue;
    }
    ctx.adopted.set(c.id, adopted);
    ctx.out(`[adopt] ${hash}: ${c.id}, signed by ${signerId}, final at block ${view.blockHeight ?? 'unknown'}, success; checked against the record and the wasm`);
  }
  return ok;
}

// -- mainnet: near-cli-rs commands -------------------------------------------------------------

function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** A local path as a printed command uses it: relative to near/ when inside it (the commands run
 * from near/, and no machine's absolute path ends up in a pasted plan), ~/... under the home
 * folder (the ~ left unquoted so the shell expands it), otherwise as it is. */
export function cliPath(p: string): string {
  const d = displayPath(p);
  return d.startsWith('~/') ? `~/${shellWord(d.slice(2))}` : shellWord(d);
}

function depositText(yocto: bigint): string {
  if (yocto === 0n) return '0 NEAR';
  if (yocto % 10n ** 18n === 0n) return nearText(yocto);
  return `${yocto} yoctoNEAR`;
}

/** One transaction as one near-cli-rs 0.31.1 command (syntax checked against the binary's --help). */
export function cliCommand(tx: TxPlan, network: Network, signer: 'keychain' | 'ledger'): string {
  const sign = signer === 'ledger' ? 'sign-with-ledger usb send' : 'sign-with-keychain send';
  const net = `network-config ${network}`;
  const a = tx.actions;
  const only = a.length === 1 ? a[0] : undefined;
  if (only?.type === 'FunctionCall') {
    return `near contract call-function as-transaction ${tx.receiverId} ${only.methodName} base64-args ${argsBase64(only.args)} prepaid-gas '${only.gasTgas} Tgas' attached-deposit '${depositText(only.deposit)}' sign-as ${tx.signerId} ${net} ${sign}`;
  }
  if (only?.type === 'AddKey') {
    const key = only.publicKey ? `use-manually-provided-public-key ${only.publicKey}` : 'autogenerate-new-keypair save-to-legacy-keychain';
    return `near account add-key ${tx.signerId} grant-function-call-access --allowance '${nearText(only.allowance)}' --contract-account-id ${only.receiverId} --function-names '${only.methodNames.join(', ')}' ${key} ${net} ${sign}`;
  }
  if (a.length && a.every((x) => x.type === 'DeleteKey')) {
    return `near account delete-keys ${tx.signerId} public-keys ${a.map((x) => (x.type === 'DeleteKey' ? x.publicKey : '')).join(',')} ${net} ${sign}`;
  }
  const parts = [`near transaction construct-transaction ${tx.signerId} receiver-id ${tx.receiverId}`];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (!x) continue;
    if (x.type === 'CreateAccount') parts.push('add-action create-account');
    else if (x.type === 'Transfer') parts.push(`add-action transfer '${nearText(x.deposit)}'`);
    else if (x.type === 'DeployContract') {
      const next = a[i + 1];
      if (next?.type === 'FunctionCall') {
        parts.push(`add-action deploy-contract use-file ${cliPath(x.wasm.path)} with-init-call ${next.methodName} base64-args ${argsBase64(next.args)} prepaid-gas '${next.gasTgas} Tgas' attached-deposit '${depositText(next.deposit)}'`);
        i++;
      } else parts.push(`add-action deploy-contract use-file ${cliPath(x.wasm.path)} without-init-call`);
    } else if (x.type === 'FunctionCall') {
      parts.push(`add-action function-call ${x.methodName} base64-args ${argsBase64(x.args)} prepaid-gas '${x.gasTgas} Tgas' attached-deposit '${depositText(x.deposit)}'`);
    } else throw new Error(`${x.type} inside a batch has no near-cli-rs form here`);
  }
  parts.push(`skip ${net} ${sign}`);
  return parts.join(' ');
}

type MainnetState = { note: string; account: AccountView | null; read: boolean };

async function runMainnet(cfg: Config, wasm: { registry: Wasm; vault: Wasm }, gate: HashGate, chain: ChainPort | null, out: (s: string) => void, now: () => Date): Promise<RunReport> {
  const m = cfg.mainnet;
  if (!m) throw new Error('mainnet names missing');
  const usdc = NETWORKS.mainnet.usdc;
  const n: Names = {
    registry: m.registry,
    registryParent: m.registryParent,
    registryOwner: m.registryParent,
    oracles: [m.oracle],
    oracle: m.oracle,
    vault: m.vault,
    vaultParent: m.vaultOwner,
    vaultOwner: m.vaultOwner,
    token: usdc,
  };
  // blocking: the plan cannot run as printed (exit 1); notes: placeholders and unchecked reads.
  const blocking: string[] = [];
  const notes: string[] = [];
  const txs: Array<{ tx: TxPlan; label: string }> = [];
  const L = MAINNET_LABEL;
  const withhold = !gate.verified && !cfg.allowUnverifiedWasm;
  const line = (s: string) => out(s === '' ? '' : `# ${s}`);
  out(`# A-Identity NEAR deploy plan for MAINNET: ${L}.`);
  line('This script never signs on mainnet and never opens ~/.near-credentials/mainnet. Each command below');
  line(`is for near-cli-rs 0.31.1 and signs with ${m.signer === 'ledger' ? 'a Ledger (sign-with-ledger usb)' : "the owner's keychain (sign-with-keychain)"}. Run them in order, one at a time.`);
  const wasmShown = displayPath(cfg.wasmDir);
  if (!isAbsolute(wasmShown) && !wasmShown.startsWith('~')) line(`Run them from near/: the wasm paths in them (${wasmShown}/) are relative to it.`);
  line(`USDC (Circle, mainnet): ${usdc}`);
  line(`wasm: ${wasm.registry.name} ${wasm.registry.size} bytes sha256 ${wasm.registry.hex} (code_hash ${wasm.registry.b58}); ${wasm.vault.name} ${wasm.vault.size} bytes sha256 ${wasm.vault.hex} (code_hash ${wasm.vault.b58})`);
  line(`wasm gate: ${gate.verified ? 'VERIFIED' : 'UNVERIFIED'}: ${gate.detail}`);
  if (!gate.verified) {
    if (cfg.allowUnverifiedWasm) line('--allow-unverified-wasm: the deploy commands are printed anyway; deploy to mainnet only the CI reproducible artifact');
    else {
      line('the two deploy commands are WITHHELD until the wasm gate passes; the other commands are printed');
      blocking.push(`wasm gate: ${gate.detail}; the registry and vault deploy commands are withheld`);
    }
  }
  const state = new Map<string, MainnetState>();
  let storage = m.tokenStorageDeposit;
  let gasPrice: bigint | null = null;
  let oracleFull: string[] = [];
  let ownerUsdc: bigint | null = null;
  if (chain) {
    for (const id of [n.registryParent, n.registry, n.oracle, n.vaultOwner, n.vault]) {
      try {
        const a = await chain.account(id);
        state.set(id, { note: a ? `exists (${nearText(available(a))} spendable, code_hash ${a.codeHash})` : 'does not exist', account: a, read: true });
      } catch (e) {
        state.set(id, { note: `could not be read (${errText(e)})`, account: null, read: false });
      }
    }
    try {
      oracleFull = (await chain.keys(n.oracle)).filter(isFull).map((k) => k.publicKey);
    } catch {
      oracleFull = [];
    }
    if (storage === null) {
      try {
        const b = await chain.view(usdc, 'storage_balance_bounds');
        if (isObj(b) && typeof b.min === 'string') storage = BigInt(b.min);
      } catch {
        storage = null;
      }
    }
    try {
      const v = await chain.view(usdc, 'ft_balance_of', { account_id: n.vaultOwner });
      ownerUsdc = typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;
    } catch {
      ownerUsdc = null;
    }
    gasPrice = await chain.gasPrice().catch(() => null);
  } else notes.push('mainnet RPC could not be set up: no account, balance or key was checked');
  for (const [id, s] of state) line(`chain (read-only): ${id} ${s.note}`);
  if (storage === null) notes.push('the USDC storage_balance_bounds().min could not be read; pass --token-storage-deposit (the vault init has a placeholder)');
  const oracleState = state.get(n.oracle);
  if (oracleState?.read && !oracleState.account) blocking.push(`${n.oracle} does not exist: create it first and keep one full-access key on it until the oracle-key step's delete (only it can add the oracle's function-call key)`);
  out('');

  /** The signer must hold the Transfer plus a transaction's gas. */
  const afford = (who: string, what: string, need: bigint) => {
    const s = state.get(who);
    if (!s?.read) {
      notes.push(`${who}'s balance was not checked (${s?.note ?? 'no RPC'}); ${what} needs ${nearText(need)}`);
      return;
    }
    if (!s.account) blocking.push(`${who} does not exist; ${what} needs it with ${nearText(need)} spendable`);
    else if (available(s.account) < need) blocking.push(`${who} has ${nearText(available(s.account))} spendable; ${what} needs ${nearText(need)} (the Transfer plus ${nearText(GAS_RESERVE)} for gas)`);
  };

  const emit = (step: string, tx: TxPlan, extra: string[] = [], deploys = false) => {
    const held = deploys && withhold;
    txs.push({ tx, label: held ? 'withheld: the wasm gate failed' : L });
    line(`[${step}] ${tx.id}: signer ${tx.signerId}, receiver ${tx.receiverId}; ${held ? 'WITHHELD' : L}`);
    for (const a of tx.actions) line(`  ${describeAction(a)}`);
    for (const a of tx.actions) if (a.type === 'FunctionCall') line(`  args ${a.methodName} (base64): ${argsBase64(a.args)}`);
    for (const e of extra) line(`  ${e}`);
    if (held) line(`  WITHHELD: no command is printed for a deploy the wasm gate does not vouch for (${gate.detail}). Put the CI artifact near-reproducible-wasm (both wasm files and hashes.json) in ${displayPath(cfg.wasmDir)} and print the plan again`);
    else out(`${cliCommand(tx, 'mainnet', m.signer)}  # ${L}`);
    out('');
  };

  const show = (step: StepName) => cfg.step === null || cfg.step === step;
  const existsNow = (id: string) => state.get(id)?.account != null;
  if (show('registry')) {
    const rf = registryFunding(wasm.registry.size, cfg.registryMargin);
    line('[registry] balance of the new account:');
    for (const l of rf.lines) line(`  ${l}`);
    if (!existsNow(n.registry)) afford(n.registryParent, 'the registry batch', rf.total + GAS_RESERVE);
    emit(
      'registry',
      registryDeployTx(n, wasm.registry, rf.total),
      [
        ...(existsNow(n.registry) ? [`ALREADY EXISTS on chain: do not run this command (CreateAccount would fail); check its code hash instead`] : []),
        `check: near account list-keys ${n.registry} network-config mainnet now  (must list no key)`,
      ],
      true,
    );
  }
  if (show('oracle-key')) {
    const add = oracleAddKeyTx(n, m.oraclePublicKey, cfg.oracleAllowance, null);
    emit('oracle-key', add, [
      m.oraclePublicKey ? `the key ${m.oraclePublicKey} is yours: keep its secret where the oracle runs` : 'near-cli generates the key and saves it to ~/.near-credentials/mainnet/ on YOUR machine; this script never reads it',
    ]);
    line(
      `[oracle-key] gate: run the next command only after near account list-keys ${n.oracle} network-config mainnet now shows the new key as a function-call key for ${n.registry} with exactly [${ORACLE_METHODS.join(', ')}] and a finite allowance, near contract call-function as-read-only ${n.registry} oracles json-args {} network-config mainnet now lists ${n.oracle}, and the oracle has signed one set_verdict with it`,
    );
    const fullKeys = oracleFull.length ? oracleFull : ['<ORACLE_FULL_ACCESS_PUBLIC_KEY>'];
    if (!oracleFull.length) notes.push(`${n.oracle} shows no full-access key to delete (it does not exist yet or could not be read); the delete command has a placeholder`);
    emit('oracle-key', oracleDeleteKeysTx(n, fullKeys, fullKeys[0] ?? null), ['signed by the full-access key itself; afterwards the oracle holds only its function-call key']);
  }
  if (show('vault')) {
    const vf = vaultFunding(wasm.vault.size, cfg.vaultFloat, cfg.agentAllowance, storage ?? 0n, gasPrice);
    line('[vault] balance of the new account:');
    for (const l of vf.lines) line(`  ${l}`);
    if (vf.minimumFloat !== undefined && cfg.vaultFloat < vf.minimumFloat) blocking.push(`--vault-float ${nearText(cfg.vaultFloat)} is below the ${nearText(vf.minimumFloat)} the agent's allowance and the vault's storage bounds need`);
    if (!existsNow(n.vault)) afford(n.vaultOwner, 'the vault batch', vf.total + GAS_RESERVE);
    const init: VaultInit = {
      owner_id: n.vaultOwner,
      token_id: usdc,
      registry_id: n.registry,
      token_storage_deposit: storage === null ? '<TOKEN_STORAGE_DEPOSIT>' : storage.toString(),
      daily_cap: cfg.dailyCap.toString(),
      auto_approve_max: cfg.autoApproveMax.toString(),
    };
    emit(
      'vault',
      vaultDeployTx(n, wasm.vault, vf.total, init),
      [
        ...(existsNow(n.vault) ? [`ALREADY EXISTS on chain: do not run this command (CreateAccount would fail); check its code hash and get_config instead`] : []),
        `policy at init: daily_cap ${init.daily_cap} (${usdcText(cfg.dailyCap)}), auto_approve_max ${init.auto_approve_max} (${usdcText(cfg.autoApproveMax)}); new sets hold_unknown true and registers the vault on USDC`,
        `check: near contract call-function as-read-only ${usdc} storage_balance_of json-args '{"account_id":"${n.vault}"}' network-config mainnet now  (not null)`,
      ],
      true,
    );
  }
  if (show('vault-register')) {
    line(`[vault-register] only if that check printed null: ${L}`);
    out(`${cliCommand(registerTx(n), 'mainnet', m.signer)}  # ${L}`);
    out('');
  }
  if (show('vault-policy')) {
    line('[vault-policy] new already set the policy above; set_policy is needed only to change it');
    out('');
  }
  if (show('vault-fund')) {
    if (ownerUsdc === null) notes.push(`${n.vaultOwner}'s USDC balance was not read; the funding needs ${usdcText(cfg.fund)}`);
    else if (ownerUsdc < cfg.fund) blocking.push(`${n.vaultOwner} holds ${usdcText(ownerUsdc)}, less than the ${usdcText(cfg.fund)} of the funding`);
    emit('vault-fund', fundTx(n, cfg.fund), [`run once, while the new vault holds 0 USDC: it is the funding, not a top-up (check: near contract call-function as-read-only ${usdc} ft_balance_of json-args '{"account_id":"${n.vault}"}' network-config mainnet now)`]);
  }
  if (show('agent-key')) {
    if (!m.agentPublicKey) {
      line(`[agent-key] first create the agent key on the machine the agent runs on, for example: near account create-account fund-later use-auto-generation save-to-folder <folder>`);
      line('then pass its public key with --agent-public-key to print the exact command; until then it has a placeholder');
      notes.push('--agent-public-key not given: the add_agent_key command has a placeholder');
    }
    const expires = cfg.agentExpiresDays === 0 ? '0' : String(Math.floor(now().getTime() / 1000) + cfg.agentExpiresDays * 86_400);
    const until = expires === '0' ? 'no expiry' : new Date(Number(expires) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    emit('agent-key', addAgentKeyTx(n, m.agentPublicKey ?? '<AGENT_PUBLIC_KEY>', cfg.agentAllowance, expires), [`expires_at_s ${expires} (${until}, --agent-expires-days ${cfg.agentExpiresDays} from when this plan was printed)`]);
  }
  if (show('verify')) {
    line('[verify] read back (all read-only):');
    for (const c of [
      `near account list-keys ${n.registry} network-config mainnet now`,
      `near account list-keys ${n.oracle} network-config mainnet now`,
      `near account list-keys ${n.vault} network-config mainnet now`,
      `near contract call-function as-read-only ${n.vault} get_config json-args {} network-config mainnet now`,
      `near contract call-function as-read-only ${n.registry} oracles json-args {} network-config mainnet now`,
      `near account view-account-summary ${n.registry} network-config mainnet now`,
      `near account view-account-summary ${n.vault} network-config mainnet now`,
    ])
      out(`${c}  # read-only`);
    out('');
  }
  const problems = [...blocking, ...notes];
  for (const p of problems) line(`INCOMPLETE: ${p}`);
  const withheld = txs.filter((t) => t.label !== L).length;
  line(`${txs.length - withheld} transactions printed${withheld ? `, ${withheld} withheld (wasm gate)` : ''}, plus register_with_token only if the vault is not registered: ${L}.`);
  return { exit: blocking.length ? 1 : 0, steps: [], txs, problems, record: null };
}

// -- main --------------------------------------------------------------------------------------

export async function run(argv: string[], env: Env, deps: Deps = {}): Promise<RunReport> {
  const out = deps.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const now = deps.now ?? (() => new Date());
  const root = deps.nearRoot ?? NEAR_ROOT;
  const empty = (exit: number, problems: string[] = []): RunReport => ({ exit, steps: [], txs: [], problems, record: null });
  let cfg: Config;
  try {
    cfg = parseConfig(argv, root);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out(`usage error: ${e.message}`);
    out('run with --help for the options');
    return empty(2, [e.message]);
  }
  if (cfg.help) {
    out(HELP);
    return empty(0);
  }

  const wasm: Partial<{ registry: Wasm; vault: Wasm }> = {};
  const missing: string[] = [];
  for (const which of ['registry', 'vault'] as const) {
    const path = join(cfg.wasmDir, WASM_FILES[which]);
    if (!existsSync(path)) missing.push(displayPath(path));
    else wasm[which] = readWasm(path);
  }
  if (!wasm.registry || !wasm.vault) {
    out(`stopped: ${missing.join(' and ')} not found. Put the CI artifact near-reproducible-wasm (both wasm files and hashes.json) in ${displayPath(cfg.wasmDir)}, or point --wasm-dir at a local build (cargo near build non-reproducible-wasm, then --allow-unverified-wasm). Nothing was read from the chain or signed.`);
    return empty(1, [`wasm missing: ${missing.join(', ')}`]);
  }
  const wasms = { registry: wasm.registry, vault: wasm.vault };
  const gate = checkHashes(cfg.wasmDir, [wasms.registry, wasms.vault]);

  if (cfg.network === 'mainnet') {
    let chain: ChainPort | null = null;
    try {
      chain = deps.chain ? deps.chain('mainnet') : rpcChain('mainnet');
    } catch {
      chain = null;
    }
    return runMainnet(cfg, wasms, gate, chain, out, now);
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(cfg.recordPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    out(`setup error: cannot read ${displayPath(cfg.recordPath)} (${errText(e)})`);
    return empty(2, ['record unreadable']);
  }
  if (record.network !== 'testnet') {
    out(`setup error: ${displayPath(cfg.recordPath)} is for ${JSON.stringify(record.network)}, not testnet`);
    return empty(2, ['record network']);
  }
  let names: Names;
  try {
    names = namesFromRecord(record);
  } catch (e) {
    out(`setup error: ${errText(e)}`);
    return empty(2, [errText(e)]);
  }

  const modeText = { 'dry-run': 'dry run: reads the chain, signs nothing, sends nothing', execute: 'EXECUTE: signs and sends on testnet', 'record-only': 'record only: sends nothing, writes the record' }[cfg.mode];
  out(`A-Identity NEAR deploy (testnet; ${modeText})`);
  out(`record  ${displayPath(cfg.recordPath)} (status ${String(record.status)})`);
  out(`wasm    ${displayPath(cfg.wasmDir)}: ${wasms.registry.name} ${wasms.registry.size} bytes sha256 ${wasms.registry.hex} (code_hash ${wasms.registry.b58}); ${wasms.vault.name} ${wasms.vault.size} bytes sha256 ${wasms.vault.hex} (code_hash ${wasms.vault.b58})`);
  out(`gate    ${gate.verified ? 'VERIFIED' : 'UNVERIFIED'}: ${gate.detail}`);
  const problems: string[] = [];
  if (!gate.verified) {
    if (cfg.allowUnverifiedWasm) out('gate    --allow-unverified-wasm: going on; the record says build.reproducible false');
    else if (cfg.mode === 'dry-run') problems.push(`[wasm] BLOCKED for --execute: ${gate.detail}; pass --allow-unverified-wasm to deploy it anyway (recorded reproducible false)`);
    else {
      out(`stopped: --${cfg.mode} refuses an unverified wasm (${gate.detail}); pass --allow-unverified-wasm to go on and record reproducible false. Nothing was sent.`);
      return empty(1, [`wasm gate: ${gate.detail}`]);
    }
  }
  if (cfg.mode !== 'dry-run') {
    // wasm_path is relative to near/ (the judge's root), wherever the record file is.
    for (const which of ['registry', 'vault'] as const) {
      const rel = getIn(record, `contracts.${which}.wasm_path`);
      const committed = typeof rel === 'string' ? (isAbsolute(rel) ? rel : resolve(root, rel)) : null;
      const same = committed !== null && existsSync(committed) && readWasm(committed).hex === wasms[which].hex;
      if (!same) {
        out(`stopped: the record cites ${String(rel)} for the ${which}, and ${committed && existsSync(committed) ? 'that file differs from' : 'that file does not exist, unlike'} ${displayPath(join(cfg.wasmDir, WASM_FILES[which]))}. Commit the exact wasm you deploy there first. Nothing was sent.`);
        return empty(1, [`committed wasm: ${String(rel)}`]);
      }
    }
  }

  const chain = deps.chain ? deps.chain('testnet') : rpcChain('testnet');
  let keys: KeyStore;
  try {
    keys = deps.keyStore ? deps.keyStore('testnet') : fileKeyStore('testnet', env);
  } catch (e) {
    out(`setup error: ${errText(e)}`);
    return empty(2, [errText(e)]);
  }
  const rules = await loadJudgeRules(root);
  if ('error' in rules) out(`note    the judge's rules could not be loaded (${rules.error}); the record's status is left as it is`);
  let sender: SendPort | null = null;
  if (cfg.mode === 'execute') {
    try {
      sender = deps.sender ? await deps.sender('testnet', chain) : await nearSender('testnet', chain, env);
    } catch (e) {
      out(`stopped: the signing library could not be loaded (${errText(e)}); run npm ci in near/. Nothing was sent.`);
      return empty(1, [errText(e)]);
    }
  }
  const ctx: Ctx = {
    cfg,
    env,
    nearRoot: root,
    names,
    wasm: wasms,
    gate,
    chain,
    keys,
    sender,
    out,
    now,
    record,
    rules: 'error' in rules ? null : rules,
    facts: {},
    adopted: new Map(),
    fundAdoptions: [],
    signerCache: new Map(),
    planned: new Set(),
    problems,
    txs: [],
    gasPrice: null,
    tokenStorage: null,
    wrote: [],
  };
  for (const p of problems) out(p);
  out(`chain   testnet via ${chain.endpoints}`);
  out(`keys    ${displayPath(keys.dir)} (public_key fields only, except to derive or sign)`);
  try {
    ctx.gasPrice = await chain.gasPrice();
    const storage = await readTokenStorage(ctx);
    out(`chain   gas price ${ctx.gasPrice === null ? 'unknown' : `${ctx.gasPrice} yocto per gas (${nearText(ctx.gasPrice * 10n ** 12n)} per Tgas)`}; ${names.token}.storage_balance_bounds().min ${storage === null ? 'unknown' : `${storage} (${nearText(storage)})`}`);
  } catch (e) {
    out(`chain   could not be read (${errText(e)})`);
  }
  out('');

  const steps: Array<{ step: StepName; status: StepStatus }> = [];
  // Set when the run stops before any step: then the record is not touched at all (not even its
  // status or updated_at), as the message says.
  let aborted = false;
  try {
    if (cfg.adopt.length && !(await adoptAll(ctx))) {
      aborted = true;
      out('stopped: an --adopt-tx transaction is not what this deploy would have sent; nothing was recorded.');
      return { exit: 1, steps, txs: ctx.txs, problems: ctx.problems, record: null };
    }
    const handlers: Record<StepName, (c: Ctx) => Promise<StepStatus>> = {
      registry: stepRegistry,
      'oracle-key': stepOracleKey,
      vault: stepVault,
      'vault-register': stepVaultRegister,
      'vault-policy': stepVaultPolicy,
      'vault-fund': stepVaultFund,
      'agent-key': stepAgentKey,
      verify: stepVerify,
    };
    const selected: StepName[] = cfg.step ? [cfg.step] : [...STEPS];
    for (const step of selected) {
      let status: StepStatus;
      try {
        status = await handlers[step](ctx);
      } catch (e) {
        problem(ctx, step, 'FAILED', `could not complete: ${errText(e)}`);
        status = 'failed';
      }
      steps.push({ step, status });
      out('');
      if (cfg.mode === 'execute' && (status === 'blocked' || status === 'failed' || status === 'mismatch')) {
        out(`stopped after ${step} (${status}); every later step waits for it. Run again when it is fixed: done steps are skipped.`);
        break;
      }
    }
  } finally {
    if (cfg.mode !== 'dry-run' && !aborted && Object.keys(ctx.facts).length > 0) persist(ctx);
  }

  const preview = finalRecord(ctx, ctx.record);
  const changes = diffPaths(ctx.record, preview).filter((p) => p !== 'updated_at');
  if (cfg.mode === 'dry-run') {
    if (changes.length) {
      out(`record: an --execute or --record-only run would write ${changes.length} field(s) of ${displayPath(cfg.recordPath)} from what is shown above:`);
      for (const p of changes) out(`  ${p} = ${JSON.stringify(getIn(preview, p))}`);
    } else out(`record: nothing to write from the chain yet; each executed step fills its fields (deployments/README.md)`);
  } else if (ctx.wrote.length) {
    out(`record: wrote ${ctx.wrote.length} field(s) of ${displayPath(cfg.recordPath)}, status ${String(ctx.record.status)}:`);
    for (const p of ctx.wrote) out(`  ${p} = ${JSON.stringify(getIn(ctx.record, p))}`);
  } else out(`record: ${displayPath(cfg.recordPath)} unchanged`);
  if (ctx.rules) {
    const d = decideStatus(preview, ctx.rules.claims, ctx.rules.resolve, evidenceIn(root));
    const some = (ids: string[]) => (ids.length > 4 ? `${ids.slice(0, 4).join(', ')} and ${ids.length - 4} more` : ids.join(', '));
    const why = [d.pending.length ? `${d.pending.length} pending: ${some(d.pending)}` : '', d.noEvidence.length ? `${d.noEvidence.length} without captured evidence: ${some(d.noEvidence)}` : ''].filter(Boolean).join('; ');
    out(`status: the judge's rule gives ${d.status}${why ? ` (${why})` : ' (every claim filled in, all evidence captured)'}; "deployed" needs no pending claim and all evidence captured`);
    if (record.status !== d.status) out(`status: the record says ${JSON.stringify(record.status)}; ${cfg.mode === 'dry-run' ? 'a write would change it to' : 'it is now'} ${JSON.stringify(cfg.mode === 'dry-run' ? d.status : ctx.record.status)}`);
  }
  const oracleFiles = keys.list(names.oracle);
  if (oracleFiles.length > 1) out(`note: ${oracleFiles.length} key files for ${names.oracle}; the demo and the oracle script need AID_ORACLE_KEY_FILE set to the function-call key's file`);
  const summary = steps.map((s) => `${s.step} ${s.status}`).join(', ');
  out(`summary: ${summary}${ctx.problems.length ? `; ${ctx.problems.length} problem(s):` : '; no problems'}`);
  for (const p of ctx.problems) out(`  ${p}`);
  const exit = ctx.problems.length ? 1 : 0;
  return { exit, steps, txs: ctx.txs, problems: ctx.problems, record: cfg.mode === 'dry-run' ? preview : ctx.record };
}

export async function main(argv: string[], env: Env): Promise<number> {
  return (await run(argv, env)).exit;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`deploy: unexpected error: ${errText(e)}\n`);
      process.exit(1);
    },
  );
}
