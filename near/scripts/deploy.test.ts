// Tests for scripts/deploy.ts against an in-memory chain that executes the planned actions, so
// the plan, the idempotent skips, the lockout guard and the record are all exercised on the same
// code the real run uses. No network, no signing library except where a real key file is made.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import { AGENT_METHODS, ORACLE_METHODS } from '../sdk/src/chain/abi.ts';
import type { NearEvent, TxOutcome } from '../sdk/src/chain/outcome.ts';
import { NETWORKS } from '../sdk/src/collect/networks.ts';
import {
  applyFacts,
  base58,
  checkHashes,
  classifyTx,
  cliCommand,
  decideStatus,
  DRY_RUN_LABEL,
  fileKeyStore,
  lockoutGate,
  MAINNET_LABEL,
  NEAR_ROOT,
  nearSender,
  parseConfig,
  readWasm,
  registryFunding,
  run,
  UsageError,
  vaultFunding,
  ZERO_CODE_HASH,
} from './deploy.ts';
import type { ChainPort, Deps, KeyStore, Names, Permission, SendPort, SendResult, TxId, TxPlan, TxRecordView, Wasm } from './deploy.ts';

const ONE_NEAR = 10n ** 24n;
const NOW = new Date('2026-11-13T00:00:00Z');
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const randomPk = (): string => `ed25519:${base58(randomBytes(32))}`;

// -- the record: the committed schema with every deploy fact reset to null ---------------------

function pristineRecord(): Record<string, any> {
  const r = JSON.parse(readFileSync(join(NEAR_ROOT, 'deployments/testnet.json'), 'utf8'));
  r.status = 'pending';
  r.updated_at = null;
  for (const n of ['registry', 'vault']) {
    const c = r.contracts[n];
    Object.assign(c, { status: 'pending', version: null, wasm_bytes: null, wasm_sha256_hex: null, wasm_sha256_base58: null, code_hash: null, deploy_tx: { hash: null, signer_id: null, block_height: null } });
    c.build = { ...c.build, reproducible: false, reproducible_command: null, rustc: null, cargo_near: null, git_commit: null };
    delete c.setup;
    r.accounts[n].status = 'planned';
    r.keys[n].lock = { how: null, tx_hash: null };
  }
  r.contracts.vault.init.args.daily_cap = null;
  r.contracts.vault.init.args.auto_approve_max = null;
  r.policy.daily_cap = null;
  r.policy.auto_approve_max = null;
  r.keys.oracle.lock = { how: null, tx_hash: null };
  Object.assign(r.keys.oracle.function_call, { public_key: null, allowance_yocto: null, add_tx_hash: null });
  Object.assign(r.keys.vault.agent, { public_key: null, allowance_yocto: null, add_tx_hash: null });
  return r;
}

// -- the fake chain ----------------------------------------------------------------------------

type Acct = { amount: bigint; codeHash: string; storage: number; keys: Map<string, Permission> };

function viewActions(tx: TxPlan): unknown[] {
  return tx.actions.map((a) => {
    switch (a.type) {
      case 'CreateAccount':
        return 'CreateAccount';
      case 'Transfer':
        return { Transfer: { deposit: a.deposit.toString() } };
      case 'DeployContract':
        return { DeployContract: { code: Buffer.from(a.wasm.hex, 'hex').toString('base64') } };
      case 'FunctionCall':
        return { FunctionCall: { method_name: a.methodName, args: Buffer.from(JSON.stringify(a.args)).toString('base64'), gas: a.gasTgas * 1e12, deposit: a.deposit.toString() } };
      case 'AddKey':
        return { AddKey: { public_key: a.publicKey, access_key: { nonce: 0, permission: { FunctionCall: { allowance: a.allowance.toString(), receiver_id: a.receiverId, method_names: [...a.methodNames] } } } } };
      case 'DeleteKey':
        return { DeleteKey: { public_key: a.publicKey } };
    }
  });
}

class FakeChain implements ChainPort {
  readonly endpoints = 'fake chain';
  accounts = new Map<string, Acct>();
  registries = new Map<string, { owner: string; oracles: string[] }>();
  vaults = new Map<string, { config: Record<string, unknown>; agents: Map<string, { label: string; expires_at_s: string; revoked: boolean }> }>();
  balances = new Map<string, bigint>();
  registered = new Set<string>();
  txs = new Map<string, TxRecordView>();
  height = 277_000_000;
  counter = 0;
  registerOnInit = true;
  tamperAddKey: ((p: Permission) => Permission) | null = null;
  reads = 0;
  readonly log: string[];
  readonly token: string;
  readonly wasm: { registry: Wasm; vault: Wasm };
  constructor(log: string[], token: string, wasm: { registry: Wasm; vault: Wasm }) {
    this.log = log;
    this.token = token;
    this.wasm = wasm;
  }

  addAccount(id: string, near: bigint, fullKeys: string[]): void {
    this.accounts.set(id, { amount: near, codeHash: ZERO_CODE_HASH, storage: 182, keys: new Map(fullKeys.map((k) => [k, { kind: 'FullAccess' } as Permission])) });
  }

  async account(id: string) {
    this.reads++;
    const a = this.accounts.get(id);
    return a ? { amount: a.amount, locked: 0n, codeHash: a.codeHash, storageUsage: a.storage } : null;
  }
  async keys(id: string) {
    this.reads++;
    const a = this.accounts.get(id);
    return a ? [...a.keys].map(([publicKey, permission]) => ({ publicKey, permission })) : [];
  }
  async key(id: string, publicKey: string) {
    this.log.push(`key:${id}:${publicKey}`);
    const p = this.accounts.get(id)?.keys.get(publicKey);
    return p ? { publicKey, permission: p } : null;
  }
  async view(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.reads++;
    if (contractId === this.token) {
      if (method === 'storage_balance_bounds') return { min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() };
      if (method === 'storage_balance_of') return this.registered.has(String(args.account_id)) ? { total: STORAGE_MIN.toString(), available: '0' } : null;
      if (method === 'ft_balance_of') return (this.balances.get(String(args.account_id)) ?? 0n).toString();
    }
    const meta = { version: '0.2.0', link: 'https://github.com/getA-Identity/A-Identity', standards: [], build_info: null };
    const reg = this.registries.get(contractId);
    if (reg) {
      if (method === 'owner') return reg.owner;
      if (method === 'oracles') return [...reg.oracles];
      if (method === 'contract_source_metadata') return meta;
    }
    const v = this.vaults.get(contractId);
    if (v) {
      if (method === 'get_config') return { ...v.config };
      if (method === 'get_agent') {
        const a = v.agents.get(String(args.public_key));
        return a ? { public_key: args.public_key, ...a, added_at_s: '1794500000' } : null;
      }
      if (method === 'contract_source_metadata') return meta;
    }
    throw new Error(`fake chain: no view ${contractId}.${method}`);
  }
  async gasPrice() {
    return 100_000_000n;
  }
  async tx(hash: string, senderId: string) {
    const t = this.txs.get(hash);
    return t && (t.raw.transaction as Record<string, unknown>).signer_id === senderId ? t : null;
  }

  private call(tx: TxPlan, a: Extract<TxPlan['actions'][number], { type: 'FunctionCall' }>, events: NearEvent[]): unknown {
    const r = tx.receiverId;
    const ev = (standard: string, event: string, executor: string, data: unknown) => events.push({ standard, version: '1.0.0', event, data, receipt_id: `r${events.length}`, executor_id: executor });
    if (a.methodName === 'new') {
      const code = this.accounts.get(r)?.codeHash;
      if (code === this.wasm.registry.b58) {
        this.registries.set(r, { owner: String(a.args.owner_id), oracles: (a.args.oracles as string[]).map(String) });
        return undefined;
      }
      if (code === this.wasm.vault.b58) {
        this.vaults.set(r, {
          config: {
            owner_id: a.args.owner_id,
            token_id: a.args.token_id,
            registry_id: a.args.registry_id,
            frozen: false,
            daily_cap: a.args.daily_cap,
            auto_approve_max: a.args.auto_approve_max,
            allowlist_enabled: false,
            token_storage_deposit: a.args.token_storage_deposit,
            version: 'agent-spend-policy 0.2.0',
            hold_unknown: true,
          },
          agents: new Map(),
        });
        if (this.registerOnInit) this.registered.add(r);
        return undefined;
      }
    }
    if (r === this.token && a.methodName === 'ft_transfer_call') {
      const to = String(a.args.receiver_id);
      const amount = BigInt(String(a.args.amount));
      if (!this.registered.has(to)) throw new Error(`${to} is not registered`);
      this.balances.set(tx.signerId, (this.balances.get(tx.signerId) ?? 0n) - amount);
      this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
      ev('nep141', 'ft_transfer', this.token, [{ old_owner_id: tx.signerId, new_owner_id: to, amount: amount.toString() }]);
      ev('a_identity_vault', 'deposited', to, { sender_id: tx.signerId, amount: amount.toString() });
      return amount.toString();
    }
    const v = this.vaults.get(r);
    if (v) {
      if (a.methodName === 'register_with_token') {
        this.registered.add(r);
        return { total: STORAGE_MIN.toString(), available: '0' };
      }
      if (a.methodName === 'set_policy') {
        Object.assign(v.config, { daily_cap: a.args.daily_cap, auto_approve_max: a.args.auto_approve_max, allowlist_enabled: a.args.allowlist_enabled });
        return undefined;
      }
      if (a.methodName === 'set_hold_unknown') {
        v.config.hold_unknown = a.args.hold_unknown;
        return undefined;
      }
      if (a.methodName === 'add_agent_key') {
        const pk = String(a.args.public_key);
        this.accounts.get(r)?.keys.set(pk, { kind: 'FunctionCall', receiverId: r, methodNames: [...AGENT_METHODS], allowance: BigInt(String(a.args.allowance)) });
        v.agents.set(pk, { label: String(a.args.label), expires_at_s: String(a.args.expires_at_s), revoked: false });
        ev('a_identity_vault', 'agent_key_added', r, { public_key: pk });
        return true;
      }
    }
    throw new Error(`fake chain: no method ${a.methodName} on ${r}`);
  }

  apply(tx: TxPlan, signerKey: string): SendResult {
    const signer = this.accounts.get(tx.signerId);
    if (!signer || signer.keys.get(signerKey)?.kind !== 'FullAccess') return { status: 'rejected', error: 'InvalidAccessKeyError', message: `${signerKey} is not a full-access key of ${tx.signerId}` };
    const events: NearEvent[] = [];
    let ret: unknown;
    let failure: unknown = null;
    try {
      for (const a of tx.actions) {
        const recv = () => {
          const x = this.accounts.get(tx.receiverId);
          if (!x) throw new Error(`${tx.receiverId} does not exist`);
          return x;
        };
        if (a.type === 'CreateAccount') {
          if (this.accounts.has(tx.receiverId)) throw new Error('AccountAlreadyExists');
          this.accounts.set(tx.receiverId, { amount: 0n, codeHash: ZERO_CODE_HASH, storage: 100, keys: new Map() });
        } else if (a.type === 'Transfer') {
          signer.amount -= a.deposit;
          recv().amount += a.deposit;
        } else if (a.type === 'DeployContract') {
          recv().codeHash = a.wasm.b58;
          recv().storage += a.wasm.size;
        } else if (a.type === 'AddKey') {
          let p: Permission = { kind: 'FunctionCall', receiverId: a.receiverId, methodNames: [...a.methodNames], allowance: a.allowance };
          if (this.tamperAddKey) p = this.tamperAddKey(p);
          recv().keys.set(String(a.publicKey), p);
        } else if (a.type === 'DeleteKey') recv().keys.delete(a.publicKey);
        else ret = this.call(tx, a, events);
      }
    } catch (e) {
      failure = { ActionError: { kind: (e as Error).message } };
    }
    const hash = base58(createHash('sha256').update(`${++this.counter}:${tx.id}`).digest());
    const height = ++this.height;
    const outcome: TxOutcome = {
      tx_hash: hash,
      signer_id: tx.signerId,
      receiver_id: tx.receiverId,
      final_execution_status: 'FINAL',
      succeeded: failure === null,
      failure,
      return_value: ret,
      receipts: [],
      events,
      gas_burnt_tgas: 1,
    };
    const raw = {
      final_execution_status: 'FINAL',
      status: failure === null ? { SuccessValue: ret === undefined ? '' : Buffer.from(JSON.stringify(ret)).toString('base64') } : { Failure: failure },
      transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, public_key: signerKey, actions: viewActions(tx) },
      transaction_outcome: { block_hash: `block-${height}` },
      receipts_outcome: [],
    };
    this.txs.set(hash, { raw, outcome, final: true, blockHeight: height });
    return { status: 'executed', txHash: hash, outcome, blockHeight: height };
  }
}

class FakeKeys implements KeyStore {
  readonly dir = '/fake/near-credentials/testnet';
  files = new Map<string, { account: string; publicKey: string; mode: number }>();
  derives = new Map<string, number>();
  failCreate = false;
  /** Make the Nth derive of a created key file return another public key. */
  corruptCreatedOn: number | null = null;
  created: string[] = [];
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  hold(account: string, publicKey: string): string {
    const path = `${this.dir}/${account}/${publicKey.replace(':', '_')}.json`;
    this.files.set(path, { account, publicKey, mode: 0o600 });
    return path;
  }
  list(account: string) {
    return [...this.files].filter(([, f]) => f.account === account).map(([path, f]) => ({ path, publicKey: f.publicKey, mode: f.mode }));
  }
  async create(account: string) {
    if (this.failCreate) throw new Error('disk full');
    const publicKey = randomPk();
    const path = this.hold(account, publicKey);
    this.created.push(path);
    this.log.push(`create:${account}`);
    return { publicKey, path };
  }
  async derive(path: string) {
    this.log.push(`derive:${path}`);
    const f = this.files.get(path);
    if (!f) throw new Error(`no key file ${path}`);
    const n = (this.derives.get(path) ?? 0) + 1;
    this.derives.set(path, n);
    if (this.created.includes(path) && this.corruptCreatedOn === n) return randomPk();
    return f.publicKey;
  }
  async signer(account: string, publicKey: string) {
    return this.list(account).some((f) => f.publicKey === publicKey) ? { accountId: account, publicKey, origin: 'fake', loaded: null } : { missing: `no key file holds ${publicKey} for ${account}` };
  }
}

function fakeSender(chain: FakeChain, reject: Set<TxId> = new Set()): SendPort {
  return {
    async send(tx, signer) {
      chain.log.push(`send:${tx.id}`);
      if (reject.has(tx.id)) return { status: 'rejected', error: 'InvalidTxError', message: 'refused by the fake node' };
      return chain.apply(tx, signer.publicKey);
    },
  };
}

// -- a world: wasm, hashes.json, a record and a funded chain -----------------------------------

function writeHashes(dir: string, wasms: Wasm[], tweak?: (rows: Array<Record<string, unknown>>) => void): void {
  const rows = wasms.map((w) => ({ file: w.name, bytes: w.size, sha256_hex: w.hex, sha256_base58: w.b58 }));
  tweak?.(rows);
  writeFileSync(join(dir, 'hashes.json'), `${JSON.stringify(rows, null, 2)}\n`);
}

type World = {
  root: string;
  wasmDir: string;
  recordPath: string;
  chain: FakeChain;
  keys: FakeKeys;
  log: string[];
  lines: string[];
  names: Names;
  fa: { parent: string; oracle: string; owner: string };
  senders: number;
  deps: (o?: { reject?: Set<TxId>; keys?: KeyStore }) => Deps;
  args: (...extra: string[]) => string[];
  record: () => Record<string, any>;
};

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'aid-deploy-'));
  temps.push(root);
  // The world is its own near/: the judge's claims and the helpers its rule needs, the record and
  // the wasm. Its evidence/ is empty unless a test writes it, so the judge's rule gives partial.
  mkdirSync(join(root, 'judge', 'lib'), { recursive: true });
  cpSync(join(NEAR_ROOT, 'judge', 'claims.json'), join(root, 'judge', 'claims.json'));
  for (const f of ['deployments.mjs', 'json.mjs', 'base58.mjs']) cpSync(join(NEAR_ROOT, 'judge', 'lib', f), join(root, 'judge', 'lib', f));
  const wasmDir = join(root, 'deployments', 'wasm');
  mkdirSync(wasmDir, { recursive: true });
  writeFileSync(join(wasmDir, 'a_identity_registry.wasm'), Buffer.alloc(178_793, 7));
  writeFileSync(join(wasmDir, 'agent_spend_policy.wasm'), Buffer.alloc(285_642, 9));
  const wasm = { registry: readWasm(join(wasmDir, 'a_identity_registry.wasm')), vault: readWasm(join(wasmDir, 'agent_spend_policy.wasm')) };
  writeHashes(wasmDir, [wasm.registry, wasm.vault]);
  const recordPath = join(root, 'deployments', 'testnet.json');
  const rec = pristineRecord();
  writeFileSync(recordPath, `${JSON.stringify(rec, null, 2)}\n`);
  const names: Names = {
    registry: rec.contracts.registry.account_id,
    registryParent: 'a-identity.testnet',
    registryOwner: rec.contracts.registry.init.args.owner_id,
    oracles: rec.contracts.registry.init.args.oracles,
    oracle: rec.accounts.oracle.account_id,
    vault: rec.contracts.vault.account_id,
    vaultParent: 'aid-demo-owner.testnet',
    vaultOwner: rec.contracts.vault.init.args.owner_id,
    token: rec.token.account_id,
  };
  const log: string[] = [];
  const chain = new FakeChain(log, names.token, wasm);
  const keys = new FakeKeys(log);
  const fa = { parent: randomPk(), oracle: randomPk(), owner: randomPk() };
  chain.addAccount(names.registryParent, 10n * ONE_NEAR, [fa.parent]);
  chain.addAccount(names.oracle, 2n * ONE_NEAR, [fa.oracle]);
  chain.addAccount(names.vaultOwner, 10n * ONE_NEAR, [fa.owner]);
  chain.balances.set(names.vaultOwner, 20_000_000n);
  keys.hold(names.registryParent, fa.parent);
  keys.hold(names.oracle, fa.oracle);
  keys.hold(names.vaultOwner, fa.owner);
  const lines: string[] = [];
  const w: World = {
    root,
    wasmDir,
    recordPath,
    chain,
    keys,
    log,
    lines,
    names,
    fa,
    senders: 0,
    deps: (o = {}) => ({
      out: (s) => lines.push(s),
      now: () => NOW,
      nearRoot: root,
      chain: () => chain,
      keyStore: () => o.keys ?? keys,
      sender: async () => {
        w.senders++;
        return fakeSender(chain, o.reject);
      },
    }),
    args: (...extra) => ['--record', recordPath, '--wasm-dir', wasmDir, ...extra],
    record: () => JSON.parse(readFileSync(recordPath, 'utf8')),
  };
  return w;
}

async function judgeDeployments(): Promise<{ validateDeployments: (d: unknown, n: string) => string[]; resolveTemplates: (v: unknown, d: unknown) => { value: unknown; missing: string[] } }> {
  const spec = pathToFileURL(join(NEAR_ROOT, 'judge/lib/deployments.mjs')).href;
  return (await import(spec)) as never;
}

function claimsOf(): Array<{ id: string; params?: unknown; requires?: string[]; evidence?: string | null }> {
  return JSON.parse(readFileSync(join(NEAR_ROOT, 'judge/claims.json'), 'utf8')).claims;
}

const sends = (log: string[]) => log.filter((l) => l.startsWith('send:')).map((l) => l.slice(5));

// -- the plan ----------------------------------------------------------------------------------

describe('the plan', () => {
  test('the dry run plans every transaction in order with the exact actions, and signs nothing', async () => {
    const w = world();
    const r = await run(w.args(), {}, w.deps());
    assert.equal(r.exit, 0, r.problems.join('\n'));
    assert.equal(w.senders, 0, 'a dry run never builds a sender');
    assert.equal(w.keys.created.length, 0, 'a dry run never makes a key');
    assert.equal(w.chain.txs.size, 0);
    assert.deepEqual(
      r.txs.map((t) => t.tx.id),
      ['registry-deploy', 'oracle-add-key', 'oracle-delete-keys', 'vault-deploy', 'vault-fund', 'agent-key-add'],
    );
    for (const t of r.txs) assert.equal(t.label, DRY_RUN_LABEL);

    const [reg, add, del, vault, fund, agent] = r.txs.map((t) => t.tx) as [TxPlan, TxPlan, TxPlan, TxPlan, TxPlan, TxPlan];
    assert.equal(reg.signerId, 'a-identity.testnet');
    assert.equal(reg.signerKey, w.fa.parent);
    assert.equal(reg.receiverId, w.names.registry);
    assert.deepEqual(reg.actions.map((a) => a.type), ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']);
    assert.deepEqual(reg.actions[1], { type: 'Transfer', deposit: 2_890_000_000_000_000_000_000_000n });
    const regDeploy = reg.actions[2];
    assert.ok(regDeploy?.type === 'DeployContract' && regDeploy.wasm.name === 'a_identity_registry.wasm');
    assert.deepEqual(reg.actions[3], { type: 'FunctionCall', methodName: 'new', args: { owner_id: 'a-identity.testnet', oracles: ['oracle.a-identity.testnet'] }, gasTgas: 100, deposit: 0n });

    assert.equal(add.signerId, w.names.oracle);
    assert.deepEqual(add.actions, [{ type: 'AddKey', publicKey: null, receiverId: w.names.registry, methodNames: ORACLE_METHODS, allowance: ONE_NEAR }]);
    assert.equal(del.signerKey, w.fa.oracle, 'the full-access key deletes itself');
    assert.deepEqual(del.actions, [{ type: 'DeleteKey', publicKey: w.fa.oracle }]);

    assert.equal(vault.signerId, 'aid-demo-owner.testnet');
    assert.deepEqual(vault.actions.map((a) => a.type), ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']);
    assert.deepEqual(vault.actions[1], { type: 'Transfer', deposit: 3_960_000_000_000_000_000_000_000n });
    assert.deepEqual(vault.actions[3], {
      type: 'FunctionCall',
      methodName: 'new',
      args: { owner_id: 'aid-demo-owner.testnet', token_id: w.names.token, registry_id: w.names.registry, token_storage_deposit: '1250000000000000000000', daily_cap: '5000000', auto_approve_max: '2000000' },
      gasTgas: 100,
      deposit: 0n,
    });
    for (const t of [reg, vault]) assert.ok(!t.actions.some((a) => a.type === 'AddKey'), `${t.id} adds no key`);

    assert.equal(fund.receiverId, w.names.token);
    assert.deepEqual(fund.actions, [{ type: 'FunctionCall', methodName: 'ft_transfer_call', args: { receiver_id: w.names.vault, amount: '3000000', msg: '' }, gasTgas: 100, deposit: 1n }]);
    const call = agent.actions[0];
    assert.ok(call?.type === 'FunctionCall');
    assert.equal(call.methodName, 'add_agent_key');
    assert.equal(call.deposit, 1n);
    assert.deepEqual({ ...call.args, public_key: 'x' }, { public_key: 'x', label: 'a-identity demo agent', expires_at_s: String(NOW.getTime() / 1000 + 30 * 86_400), allowance: (ONE_NEAR / 4n).toString() });

    const text = w.lines.join('\n');
    assert.match(text, /code {4}178793 bytes x 1 NEAR per 100000 bytes = 1\.78793 NEAR/);
    assert.match(text, /total {3}2\.88793 NEAR, rounded up to 2\.89 NEAR/);
    assert.match(text, /gate before oracle-delete-keys/);
  });

  test('the arithmetic: stake at 1 NEAR per 100 kB, rounded up to 0.01 NEAR; the vault float has a floor', () => {
    assert.equal(registryFunding(100_000, ONE_NEAR).total, 2_100_000_000_000_000_000_000_000n);
    const v = vaultFunding(285_642, ONE_NEAR, ONE_NEAR / 4n, STORAGE_MIN, 100_000_000n);
    assert.equal(v.total, 3_960_000_000_000_000_000_000_000n);
    assert.equal(v.minimumFloat, 587_250_000_000_000_000_000_000n);
    assert.ok(v.lines.some((l) => l.includes('the allowance runs about 126 payments')));
  });

  test('a float below what the agent key and the storage bounds need blocks the vault', async () => {
    const w = world();
    const r = await run(w.args('--vault-float', '0.5'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.ok(r.problems.some((p) => p.includes('--vault-float 0.5 NEAR is below the 0.58725 NEAR')));
  });

  test('usage errors exit 2', async () => {
    for (const argv of [
      ['--dry-run', '--execute'],
      ['--step', 'nope'],
      ['--network', 'mainnet', '--execute'],
      ['--registry', 'x.testnet'],
      ['--fund', '1.0000001'],
      ['--auto-approve-max', '6'],
      ['--adopt-tx', 'not-a-hash'],
    ]) {
      const w = world();
      const r = await run(w.args(...argv), {}, w.deps());
      assert.equal(r.exit, 2, argv.join(' '));
    }
    assert.throws(() => parseConfig(['--network', 'mainnet', '--registry', 'registry.a-identity.near', '--oracle', 'oracle.a-identity.near', '--vault', 'vault.other.near', '--vault-owner', 'owner.near']), UsageError);
  });
});

// -- execute, resume, idempotence --------------------------------------------------------------

describe('execute', () => {
  test('deploys keyless end to end, verifies, records, and a second run sends nothing', async () => {
    const w = world();
    const r = await run(w.args('--execute'), {}, w.deps());
    assert.equal(r.exit, 0, r.problems.join('\n'));
    assert.deepEqual(sends(w.log), ['registry-deploy', 'oracle-add-key', 'oracle-delete-keys', 'vault-deploy', 'vault-fund', 'agent-key-add']);
    const c = w.chain;
    assert.equal(c.accounts.get(w.names.registry)?.keys.size, 0, 'the registry holds no key');
    const oracleKeys = [...(c.accounts.get(w.names.oracle)?.keys.values() ?? [])];
    assert.equal(oracleKeys.length, 1);
    assert.deepEqual(oracleKeys[0], { kind: 'FunctionCall', receiverId: w.names.registry, methodNames: [...ORACLE_METHODS], allowance: ONE_NEAR });
    const vaultKeys = [...(c.accounts.get(w.names.vault)?.keys.values() ?? [])];
    assert.deepEqual(vaultKeys, [{ kind: 'FunctionCall', receiverId: w.names.vault, methodNames: [...AGENT_METHODS], allowance: ONE_NEAR / 4n }]);
    assert.equal(c.balances.get(w.names.vault), 3_000_000n);

    const rec = w.record();
    assert.equal(rec.status, 'partial', 'the demo is not recorded, so the judge rule gives partial');
    assert.equal(rec.contracts.registry.status, 'deployed');
    assert.equal(rec.contracts.registry.code_hash, readWasm(join(w.wasmDir, 'a_identity_registry.wasm')).b58);
    assert.equal(rec.contracts.registry.build.reproducible, true);
    assert.equal(rec.contracts.registry.build.reproducible_command, 'cargo near build reproducible-wasm --manifest-path contracts/a-identity-registry/Cargo.toml');
    assert.equal(rec.contracts.registry.deploy_tx.signer_id, 'a-identity.testnet');
    assert.equal(rec.keys.registry.lock.how, 'never-added');
    assert.equal(rec.keys.registry.lock.tx_hash, rec.contracts.registry.deploy_tx.hash);
    assert.equal(rec.keys.vault.lock.how, 'never-added');
    assert.equal(rec.keys.oracle.lock.how, 'delete-key');
    assert.equal(rec.keys.oracle.function_call.allowance_yocto, ONE_NEAR.toString());
    assert.equal(rec.keys.vault.agent.allowance_yocto, (ONE_NEAR / 4n).toString());
    assert.equal(rec.contracts.vault.init.args.daily_cap, '5000000');
    assert.deepEqual(rec.contracts.vault.init.args.token_id, { $ref: 'token.account_id' }, 'the 64-hex token id stays a $ref (gitleaks)');
    assert.deepEqual(rec.policy, { daily_cap: '5000000', auto_approve_max: '2000000', allowlist_enabled: false, hold_unknown: true });
    assert.equal(rec.contracts.vault.setup.fund.amount, '3000000');
    assert.equal(rec.accounts.registry.status, 'created');
    assert.match(rec.updated_at, /^2026-11-13T00:00:00Z$/);

    const judge = await judgeDeployments();
    assert.deepEqual(judge.validateDeployments(rec, 'testnet'), []);
    const claims = claimsOf();
    for (const id of ['registry-code', 'vault-code', 'vault-keys', 'oracle-keys', 'registry-keys', 'vault-config', 'registry-oracles', 'registry-owner']) {
      const claim = claims.find((x) => x.id === id);
      assert.ok(claim, id);
      const res = judge.resolveTemplates({ params: claim.params ?? {}, requires: claim.requires ?? [] }, rec);
      const missing = [...res.missing, ...(claim.requires ?? []).flatMap((p) => judge.resolveTemplates(`\${${p}}`, rec).missing)];
      assert.deepEqual(missing, [], `${id} is no longer pending`);
    }

    w.log.length = 0;
    w.lines.length = 0;
    const again = await run(w.args('--execute'), {}, w.deps());
    assert.equal(again.exit, 0, again.problems.join('\n'));
    assert.deepEqual(sends(w.log), [], 'nothing is sent twice');
    assert.ok(again.steps.every((s) => s.status === 'done'), JSON.stringify(again.steps));
    assert.deepEqual(w.record().contracts, rec.contracts, 'the record is unchanged');
  });

  test('resumes: a done step is skipped and the rest runs', async () => {
    const w = world();
    const first = await run(w.args('--execute', '--step', 'registry'), {}, w.deps());
    assert.equal(first.exit, 0, first.problems.join('\n'));
    assert.deepEqual(sends(w.log), ['registry-deploy']);
    w.log.length = 0;
    const rest = await run(w.args('--execute'), {}, w.deps());
    assert.equal(rest.exit, 0, rest.problems.join('\n'));
    assert.equal(rest.steps[0]?.status, 'done');
    assert.deepEqual(sends(w.log), ['oracle-add-key', 'oracle-delete-keys', 'vault-deploy', 'vault-fund', 'agent-key-add']);
  });

  test('a step whose upstream is not deployed is blocked, not guessed', async () => {
    const w = world();
    const r = await run(w.args('--execute', '--step', 'vault'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), []);
    assert.ok(r.problems.some((p) => p.includes('run the registry step first')));
  });

  test('register_with_token and set_policy are sent only when the chain needs them', async () => {
    const w = world();
    w.chain.registerOnInit = false;
    const r = await run(w.args('--execute', '--daily-cap', '4'), {}, w.deps());
    assert.equal(r.exit, 0, r.problems.join('\n'));
    assert.deepEqual(sends(w.log), ['registry-deploy', 'oracle-add-key', 'oracle-delete-keys', 'vault-deploy', 'vault-register', 'vault-fund', 'agent-key-add']);
    w.log.length = 0;
    const policy = await run(w.args('--execute', '--daily-cap', '6'), {}, w.deps());
    assert.equal(policy.exit, 0, policy.problems.join('\n'));
    assert.deepEqual(sends(w.log), ['vault-set-policy']);
    const sent = policy.txs.find((t) => t.tx.id === 'vault-set-policy')?.tx.actions[0];
    assert.deepEqual(sent, { type: 'FunctionCall', methodName: 'set_policy', args: { daily_cap: '6000000', auto_approve_max: '2000000', allowlist_enabled: false }, gasTgas: 30, deposit: 1n });
    assert.equal(w.record().policy.daily_cap, '6000000');
  });

  test('a missing credential is a labeled stop, never a crash', async () => {
    const w = world();
    w.keys.files.clear();
    const r = await run(w.args('--execute'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), []);
    assert.ok(r.problems.some((p) => p.includes('STOPPED, no credential')), r.problems.join('\n'));
  });

  test('a record that disagrees with the chain stops the step and is not overwritten', async () => {
    const w = world();
    await run(w.args('--execute', '--step', 'registry'), {}, w.deps());
    const rec = w.record();
    rec.contracts.registry.code_hash = '7JBaTHGEmZpDHcyWacXBaRSkmwUUiYwg9oFRqfcsPogX';
    writeFileSync(w.recordPath, JSON.stringify(rec, null, 2));
    const r = await run(w.args('--execute', '--step', 'registry'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.ok(r.problems.some((p) => p.includes("MISMATCH: the record's contracts.registry.code_hash")));
    assert.equal(w.record().contracts.registry.code_hash, '7JBaTHGEmZpDHcyWacXBaRSkmwUUiYwg9oFRqfcsPogX');
  });

  test('a contract that runs other code is never redeployed', async () => {
    const w = world();
    w.chain.addAccount(w.names.registry, ONE_NEAR, []);
    const acct = w.chain.accounts.get(w.names.registry);
    if (acct) acct.codeHash = '958q4mAu7JbKkxTwRBtXw4Cmx4fCuzqSjZoZynY3BxoL';
    const r = await run(w.args('--execute', '--step', 'registry'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), []);
    assert.ok(r.problems.some((p) => p.includes('this script never redeploys')));
  });
});

// -- the lockout guard -------------------------------------------------------------------------

describe('the lockout guard', () => {
  async function upToOracle(w: World): Promise<void> {
    const r = await run(w.args('--execute', '--step', 'registry'), {}, w.deps());
    assert.equal(r.exit, 0, r.problems.join('\n'));
    w.log.length = 0;
  }
  const oracleHasFullKey = (w: World) => w.chain.accounts.get(w.names.oracle)?.keys.get(w.fa.oracle)?.kind === 'FullAccess';

  test('deletes the full-access key only after the new key is on chain and its stored secret re-derives it', async () => {
    const w = world();
    await upToOracle(w);
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps());
    assert.equal(r.exit, 0, r.problems.join('\n'));
    const order = w.log.filter((l) => /^(create|send|key|derive):/.test(l)).map((l) => l.split(':')[0]);
    assert.deepEqual(order, ['create', 'derive', 'send', 'key', 'derive', 'send']);
    assert.ok(w.log.indexOf('send:oracle-add-key') < w.log.indexOf('send:oracle-delete-keys'));
    assert.equal(oracleHasFullKey(w), false);
  });

  test('a replacement whose on-chain permission differs keeps the full-access key', async () => {
    const w = world();
    await upToOracle(w);
    w.chain.tamperAddKey = (p) => (p.kind === 'FunctionCall' ? { ...p, methodNames: [...p.methodNames, 'add_oracle'] } : p);
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), ['oracle-add-key']);
    assert.ok(oracleHasFullKey(w));
    assert.ok(r.problems.some((p) => p.includes('LOCKOUT GUARD') && p.includes('not exactly')));
  });

  test('an allowance other than the one asked for keeps the full-access key', async () => {
    const w = world();
    await upToOracle(w);
    w.chain.tamperAddKey = (p) => (p.kind === 'FunctionCall' ? { ...p, allowance: null } : p);
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.ok(oracleHasFullKey(w));
    assert.ok(r.problems.some((p) => p.includes('unlimited allowance')));
  });

  test('a stored secret that no longer re-derives the key keeps the full-access key', async () => {
    const w = world();
    await upToOracle(w);
    w.keys.corruptCreatedOn = 2;
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), ['oracle-add-key']);
    assert.ok(oracleHasFullKey(w));
    assert.ok(r.problems.some((p) => p.includes('LOCKOUT GUARD') && p.includes('derives')));
  });

  test('a key file that cannot be written sends nothing at all', async () => {
    const w = world();
    await upToOracle(w);
    w.keys.failCreate = true;
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), []);
    assert.ok(oracleHasFullKey(w));
  });

  test('a refused AddKey is never followed by a DeleteKey', async () => {
    const w = world();
    await upToOracle(w);
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps({ reject: new Set<TxId>(['oracle-add-key']) }));
    assert.equal(r.exit, 1);
    assert.deepEqual(sends(w.log), ['oracle-add-key']);
    assert.ok(oracleHasFullKey(w));
  });

  test('a function-call key on chain whose secret is not held here blocks the delete', async () => {
    const w = world();
    await upToOracle(w);
    w.chain.accounts.get(w.names.oracle)?.keys.set(randomPk(), { kind: 'FunctionCall', receiverId: w.names.registry, methodNames: [...ORACLE_METHODS], allowance: ONE_NEAR });
    for (const mode of ['--dry-run', '--execute']) {
      const r = await run(w.args(mode, '--step', 'oracle-key'), {}, w.deps());
      assert.equal(r.exit, 1, mode);
      assert.ok(r.problems.some((p) => p.includes('LOCKOUT GUARD') && p.includes('Nothing is deleted')), mode);
    }
    assert.deepEqual(sends(w.log), []);
    assert.ok(oracleHasFullKey(w));
  });

  test('resumes a half-done oracle step: the key added earlier is re-checked, then the full-access key goes', async () => {
    const w = world();
    await upToOracle(w);
    await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps({ reject: new Set<TxId>(['oracle-delete-keys']) }));
    assert.ok(oracleHasFullKey(w));
    assert.equal(w.record().keys.oracle.lock.tx_hash, null);
    w.log.length = 0;
    const r = await run(w.args('--execute', '--step', 'oracle-key'), {}, w.deps());
    assert.equal(r.exit, 0, r.problems.join('\n'));
    assert.deepEqual(sends(w.log), ['oracle-delete-keys']);
    assert.equal(oracleHasFullKey(w), false);
    assert.equal(w.record().keys.oracle.lock.how, 'delete-key');
  });

  test('lockoutGate itself', async () => {
    const log: string[] = [];
    const keys = new FakeKeys(log);
    const pk = randomPk();
    const path = keys.hold('oracle.a-identity.testnet', pk);
    const chain = new FakeChain(log, 'token', { registry: readWasmLike('r'), vault: readWasmLike('v') });
    chain.addAccount('oracle.a-identity.testnet', ONE_NEAR, []);
    const want = { accountId: 'oracle.a-identity.testnet', publicKey: pk, path, receiverId: 'registry.a-identity.testnet', methodNames: ORACLE_METHODS, allowance: ONE_NEAR };
    assert.equal((await lockoutGate(chain, keys, want)).ok, false, 'not on chain');
    const set = (p: Permission) => chain.accounts.get('oracle.a-identity.testnet')?.keys.set(pk, p);
    set({ kind: 'FullAccess' });
    assert.match((await lockoutGate(chain, keys, want)).why, /full-access key/);
    set({ kind: 'FunctionCall', receiverId: 'other.testnet', methodNames: [...ORACLE_METHODS], allowance: ONE_NEAR });
    assert.match((await lockoutGate(chain, keys, want)).why, /may call other\.testnet/);
    set({ kind: 'FunctionCall', receiverId: 'registry.a-identity.testnet', methodNames: [], allowance: ONE_NEAR });
    assert.match((await lockoutGate(chain, keys, want)).why, /ANY METHOD/);
    set({ kind: 'FunctionCall', receiverId: 'registry.a-identity.testnet', methodNames: [...ORACLE_METHODS], allowance: ONE_NEAR / 2n });
    assert.match((await lockoutGate(chain, keys, want)).why, /not the 1000000000000000000000000 added/);
    set({ kind: 'FunctionCall', receiverId: 'registry.a-identity.testnet', methodNames: [...ORACLE_METHODS], allowance: ONE_NEAR });
    assert.equal((await lockoutGate(chain, keys, want)).ok, true);
    assert.equal((await lockoutGate(chain, keys, { ...want, path: '/nowhere.json' })).ok, false, 'no stored secret');
  });
});

function readWasmLike(tag: string): Wasm {
  const bytes = new Uint8Array(Buffer.from(tag));
  const digest = createHash('sha256').update(bytes).digest();
  return { name: `${tag}.wasm`, path: `/${tag}.wasm`, bytes, size: bytes.length, hex: digest.toString('hex'), b58: base58(digest) };
}

// -- the wasm hash gate ------------------------------------------------------------------------

describe('the wasm hash gate', () => {
  test('without hashes.json --execute sends nothing unless --allow-unverified-wasm, which records reproducible false', async () => {
    const w = world();
    rmSync(join(w.wasmDir, 'hashes.json'));
    const refused = await run(w.args('--execute'), {}, w.deps());
    assert.equal(refused.exit, 1);
    assert.equal(w.senders, 0);
    assert.deepEqual(sends(w.log), []);
    assert.match(w.lines.join('\n'), /refuses an unverified wasm/);

    const dry = await run(w.args(), {}, w.deps());
    assert.equal(dry.exit, 1, 'the dry run prints the plan and says --execute would refuse');
    assert.equal(dry.txs.length, 6);
    assert.ok(dry.problems.some((p) => p.includes('BLOCKED for --execute') && p.includes('hashes.json')));

    const allowed = await run(w.args('--execute', '--allow-unverified-wasm'), {}, w.deps());
    assert.equal(allowed.exit, 0, allowed.problems.join('\n'));
    const rec = w.record();
    assert.equal(rec.contracts.vault.build.reproducible, false);
    assert.equal(rec.contracts.vault.build.reproducible_command, null);
    assert.equal(rec.contracts.vault.build.command, pristineRecord().contracts.vault.build.command, 'the non-reproducible build command stays');
  });

  test('a hashes.json that does not match the files is refused', async () => {
    for (const tweak of [
      (rows: Array<Record<string, unknown>>) => {
        if (rows[0]) rows[0].sha256_hex = '0'.repeat(64);
      },
      (rows: Array<Record<string, unknown>>) => {
        if (rows[1]) rows[1].bytes = 1;
      },
      (rows: Array<Record<string, unknown>>) => {
        rows.pop();
      },
    ]) {
      const w = world();
      writeHashes(w.wasmDir, [readWasm(join(w.wasmDir, 'a_identity_registry.wasm')), readWasm(join(w.wasmDir, 'agent_spend_policy.wasm'))], tweak);
      const r = await run(w.args('--execute'), {}, w.deps());
      assert.equal(r.exit, 1);
      assert.deepEqual(sends(w.log), []);
    }
    const ok = world();
    assert.equal(checkHashes(ok.wasmDir, [readWasm(join(ok.wasmDir, 'a_identity_registry.wasm'))]).verified, true);
  });

  test('missing wasm files stop cleanly before any chain read', async () => {
    const w = world();
    rmSync(join(w.wasmDir, 'agent_spend_policy.wasm'));
    const r = await run(w.args(), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.equal(w.chain.reads, 0);
    assert.match(w.lines.join('\n'), /stopped: .*agent_spend_policy\.wasm not found/);
  });

  test('--execute deploys only the wasm the record cites', async () => {
    const w = world();
    const other = join(w.root, 'elsewhere');
    mkdirSync(other);
    writeFileSync(join(other, 'a_identity_registry.wasm'), Buffer.alloc(1000, 1));
    writeFileSync(join(other, 'agent_spend_policy.wasm'), Buffer.alloc(1000, 2));
    const r = await run(['--record', w.recordPath, '--wasm-dir', other, '--execute', '--allow-unverified-wasm'], {}, w.deps());
    assert.equal(r.exit, 1);
    assert.equal(w.senders, 0);
    assert.match(w.lines.join('\n'), /the record cites deployments\/wasm\/a_identity_registry\.wasm/);
  });
});

// -- the record --------------------------------------------------------------------------------

describe('the record', () => {
  test('decideStatus: deployed only with no pending claim and every evidence file captured', async () => {
    const { resolveTemplates } = await judgeDeployments();
    const claims = [
      { id: 'a', params: { x: '${contracts.registry.code_hash}' }, evidence: 'evidence/a.json' },
      { id: 'b', params: {}, requires: ['policy.daily_cap'], evidence: null },
    ];
    const rec = { contracts: { registry: { code_hash: null } }, policy: { daily_cap: null } };
    assert.equal(decideStatus(rec, claims, resolveTemplates, () => true).status, 'pending');
    rec.contracts.registry.code_hash = 'x' as never;
    assert.deepEqual(decideStatus(rec, claims, resolveTemplates, () => true), { status: 'partial', pending: ['b'], noEvidence: [] });
    rec.policy.daily_cap = '5000000' as never;
    assert.deepEqual(decideStatus(rec, claims, resolveTemplates, () => false), { status: 'partial', pending: [], noEvidence: ['a'] });
    assert.equal(decideStatus(rec, claims, resolveTemplates, () => true).status, 'deployed');
  });

  test('applyFacts never erases a recorded value and keeps a recorded lock', () => {
    const rec = pristineRecord();
    rec.keys.registry.lock = { how: 'created keyless', tx_hash: 'H1' };
    rec.contracts.registry.build.rustc = 'rustc 1.95.0';
    const wasm = readWasmLike('r');
    const next = applyFacts(rec, {
      registry: { codeHash: wasm.b58, wasm, version: null, deployTx: { hash: 'H1', signer_id: 'a-identity.testnet', block_height: 5 }, build: { reproducible: false, command: null, reproducibleCommand: null, gitCommit: null } },
      oracleKey: { publicKey: 'ed25519:K', receiverId: 'registry.a-identity.testnet', allowance: null, addTx: null },
    }) as Record<string, any>;
    assert.deepEqual(next.keys.registry.lock, { how: 'created keyless', tx_hash: 'H1' });
    assert.equal(next.contracts.registry.build.rustc, 'rustc 1.95.0');
    assert.equal(next.contracts.registry.version, null);
    assert.equal(next.keys.oracle.function_call.public_key, 'ed25519:K');
    assert.equal(next.keys.oracle.function_call.add_tx_hash, null);
    assert.equal(rec.contracts.registry.code_hash, null, 'the input is not modified');
  });

  test('--record-only fills the record from adopted transactions, and refuses to invent the ones not named', async () => {
    const w = world();
    const first = await run(w.args('--execute'), {}, w.deps());
    assert.equal(first.exit, 0, first.problems.join('\n'));
    const written = w.record();
    const hashes = first.txs.filter((t) => t.hash).map((t) => t.hash as string);
    assert.equal(hashes.length, 6);

    writeFileSync(w.recordPath, `${JSON.stringify(pristineRecord(), null, 2)}\n`);
    w.senders = 0;
    const gaps = await run(w.args('--record-only'), {}, w.deps());
    assert.equal(gaps.exit, 1);
    assert.equal(w.senders, 0, '--record-only never builds a sender');
    assert.ok(gaps.problems.filter((p) => p.includes('RECORD GAP')).length >= 4, gaps.problems.join('\n'));
    assert.equal(w.record().contracts.registry.deploy_tx.hash, null, 'no transaction is recorded without its hash');
    assert.equal(w.record().contracts.registry.code_hash, written.contracts.registry.code_hash, 'facts read from the chain are recorded');

    writeFileSync(w.recordPath, `${JSON.stringify(pristineRecord(), null, 2)}\n`);
    const adopted = await run(w.args('--record-only', ...hashes.flatMap((h) => ['--adopt-tx', h])), {}, w.deps());
    assert.equal(adopted.exit, 0, adopted.problems.join('\n'));
    assert.equal(w.senders, 0);
    const rec = w.record();
    assert.deepEqual(rec.contracts.registry.deploy_tx, written.contracts.registry.deploy_tx);
    assert.deepEqual(rec.contracts.vault.deploy_tx, written.contracts.vault.deploy_tx);
    assert.deepEqual(rec.keys, written.keys);
    assert.deepEqual(rec.contracts.vault.init.args, written.contracts.vault.init.args);
    assert.deepEqual(rec.contracts.vault.setup.fund, written.contracts.vault.setup.fund);
  });

  test('an adopted transaction that is not this deploy is refused', async () => {
    const w = world();
    await run(w.args('--execute'), {}, w.deps());
    const plan: TxPlan = { id: 'vault-fund', step: 'vault-fund', signerId: w.names.vaultOwner, signerKey: w.fa.owner, receiverId: w.names.token, actions: [{ type: 'FunctionCall', methodName: 'ft_transfer_call', args: { receiver_id: 'someone-else.testnet', amount: '1', msg: '' }, gasTgas: 100, deposit: 1n }], why: '' };
    w.chain.registered.add('someone-else.testnet');
    const stray = w.chain.apply(plan, w.fa.owner);
    assert.equal(stray.status, 'executed');
    const r = await run(w.args('--record-only', '--adopt-tx', stray.status === 'executed' ? stray.txHash : ''), {}, w.deps());
    assert.equal(r.exit, 1);
    assert.match(w.lines.join('\n'), /not a transaction of this deploy/);
  });

  test('classifyTx checks the deployed code against the wasm', () => {
    const w = world();
    const wasm = { registry: readWasm(join(w.wasmDir, 'a_identity_registry.wasm')), vault: readWasm(join(w.wasmDir, 'agent_spend_policy.wasm')) };
    const forged = { ...wasm.registry, hex: '0'.repeat(64) };
    const tx: TxPlan = { id: 'registry-deploy', step: 'registry', signerId: w.names.registryParent, signerKey: w.fa.parent, receiverId: w.names.registry, actions: [{ type: 'CreateAccount' }, { type: 'Transfer', deposit: ONE_NEAR }, { type: 'DeployContract', wasm: forged }, { type: 'FunctionCall', methodName: 'new', args: { owner_id: 'a-identity.testnet', oracles: ['oracle.a-identity.testnet'] }, gasTgas: 100, deposit: 0n }], why: '' };
    const r = w.chain.apply(tx, w.fa.parent);
    assert.equal(r.status, 'executed');
    const view = r.status === 'executed' ? w.chain.txs.get(r.txHash) : undefined;
    assert.ok(view);
    const c = classifyTx(view, w.names, wasm);
    assert.ok('error' in c && c.error.includes('it deployed sha256 0000'), JSON.stringify(c));
  });
});

// -- mainnet -----------------------------------------------------------------------------------

describe('mainnet', () => {
  function mainnetChain(fullKey: string): ChainPort {
    const exists = new Set(['a-identity.near', 'oracle.a-identity.near', 'aid-owner.near']);
    return {
      endpoints: 'fake mainnet',
      async account(id) {
        return exists.has(id) ? { amount: 20n * ONE_NEAR, locked: 0n, codeHash: ZERO_CODE_HASH, storageUsage: 200 } : null;
      },
      async keys(id) {
        return id === 'oracle.a-identity.near' ? [{ publicKey: fullKey, permission: { kind: 'FullAccess' } }] : [];
      },
      async key() {
        return null;
      },
      async view(contract, method) {
        if (contract === NETWORKS.mainnet.usdc && method === 'storage_balance_bounds') return { min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() };
        throw new Error(`no view ${method}`);
      },
      async gasPrice() {
        return 100_000_000n;
      },
      async tx() {
        return null;
      },
    };
  }

  test('prints near-cli-rs commands, labels every one, and never builds a key store or a sender', async () => {
    assert.equal(NETWORKS.mainnet.usdc, '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
    const w = world();
    const fullKey = randomPk();
    const agentKey = randomPk();
    let touched = 0;
    const deps: Deps = {
      ...w.deps(),
      chain: (network) => {
        assert.equal(network, 'mainnet');
        return mainnetChain(fullKey);
      },
      keyStore: () => {
        touched++;
        throw new Error('mainnet must never open a key store');
      },
      sender: async () => {
        touched++;
        throw new Error('mainnet must never sign');
      },
    };
    const argv = ['--network', 'mainnet', '--registry', 'registry.a-identity.near', '--oracle', 'oracle.a-identity.near', '--vault', 'vault.aid-owner.near', '--wasm-dir', w.wasmDir, '--agent-public-key', agentKey];
    const r = await run(argv, {}, deps);
    assert.equal(r.exit, 0, r.problems.join('\n'));
    assert.equal(touched, 0);
    const commands = w.lines.filter((l) => l.startsWith('near '));
    const writes = commands.filter((l) => !l.endsWith('# read-only'));
    assert.equal(writes.length, 7, writes.join('\n'));
    for (const c of writes) assert.ok(c.endsWith(`# ${MAINNET_LABEL}`), c);
    for (const c of commands) {
      assert.doesNotMatch(c, /legacy-keychain send|plaintext-private-key|seed-phrase|access-key-file/);
      assert.match(c, /network-config mainnet/);
    }
    const reg = writes.find((c) => c.startsWith('near transaction construct-transaction a-identity.near receiver-id registry.a-identity.near'));
    assert.ok(reg);
    assert.match(reg, /add-action create-account add-action transfer '2\.89 NEAR' add-action deploy-contract use-file \S+a_identity_registry\.wasm with-init-call new base64-args (\S+) prepaid-gas '100 Tgas' attached-deposit '0 NEAR' skip network-config mainnet sign-with-keychain send/);
    const b64 = /base64-args (\S+)/.exec(reg)?.[1] ?? '';
    assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString()), { owner_id: 'a-identity.near', oracles: ['oracle.a-identity.near'] });
    assert.ok(writes.some((c) => c.startsWith("near account add-key oracle.a-identity.near grant-function-call-access --allowance '1 NEAR' --contract-account-id registry.a-identity.near --function-names 'set_verdict, set_verdicts, clear_verdict, clear_reports' autogenerate-new-keypair save-to-legacy-keychain network-config mainnet sign-with-keychain send")));
    assert.ok(writes.some((c) => c.startsWith(`near account delete-keys oracle.a-identity.near public-keys ${fullKey} network-config mainnet sign-with-keychain send`)));
    const vault = writes.find((c) => c.includes('receiver-id vault.aid-owner.near')) ?? '';
    const init = JSON.parse(Buffer.from(/base64-args (\S+)/.exec(vault)?.[1] ?? '', 'base64').toString());
    assert.deepEqual(init, { owner_id: 'aid-owner.near', token_id: NETWORKS.mainnet.usdc, registry_id: 'registry.a-identity.near', token_storage_deposit: STORAGE_MIN.toString(), daily_cap: '5000000', auto_approve_max: '2000000' });
    assert.ok(writes.some((c) => c.startsWith(`near contract call-function as-transaction ${NETWORKS.mainnet.usdc} ft_transfer_call base64-args `) && c.includes("attached-deposit '1 yoctoNEAR' sign-as aid-owner.near")));
    const agent = writes.find((c) => c.includes(' add_agent_key ')) ?? '';
    assert.equal(JSON.parse(Buffer.from(/base64-args (\S+)/.exec(agent)?.[1] ?? '', 'base64').toString()).public_key, agentKey);
    assert.ok(w.lines.every((l) => l === '' || l.startsWith('#') || l.startsWith('near ')), 'every line is a comment or a command');

    const ledger = world();
    const viaLedger = await run([...argv.slice(0, -2), '--signer', 'ledger', '--wasm-dir', ledger.wasmDir], {}, { ...ledger.deps(), chain: () => mainnetChain(fullKey), keyStore: deps.keyStore, sender: deps.sender });
    assert.equal(touched, 0);
    const ledgerWrites = ledger.lines.filter((l) => l.startsWith('near ') && !l.endsWith('# read-only'));
    for (const c of ledgerWrites) assert.match(c, /sign-with-ledger usb send {2}# /);
    assert.ok(viaLedger.problems.some((p) => p.includes('--agent-public-key not given')));
  });

  test('--step prints only that step of the mainnet plan', async () => {
    const w = world();
    const r = await run(['--network', 'mainnet', '--registry', 'registry.a-identity.near', '--oracle', 'oracle.a-identity.near', '--vault', 'vault.aid-owner.near', '--wasm-dir', w.wasmDir, '--step', 'oracle-key'], {}, { ...w.deps(), chain: () => mainnetChain(randomPk()) });
    assert.equal(r.exit, 0, r.problems.join('\n'));
    assert.deepEqual(r.txs.map((t) => t.tx.id), ['oracle-add-key', 'oracle-delete-keys']);
    assert.equal(w.lines.filter((l) => l.startsWith('near ')).length, 2);
  });

  test('the key store and the sender refuse mainnet outright', async () => {
    assert.throws(() => fileKeyStore('mainnet'), /testnet only/);
    assert.throws(() => fileKeyStore('testnet', {}, join(tmpdir(), 'mainnet')), /never reads it/);
    await assert.rejects(nearSender('mainnet', {} as ChainPort), /testnet only/);
  });

  test('cliCommand renders a lone owner call and a batch', () => {
    const n: Names = { registry: 'r.x.near', registryParent: 'x.near', registryOwner: 'x.near', oracles: ['o.x.near'], oracle: 'o.x.near', vault: 'v.y.near', vaultParent: 'y.near', vaultOwner: 'y.near', token: 'usdc.near' };
    const tx: TxPlan = { id: 'vault-register', step: 'vault-register', signerId: 'y.near', signerKey: null, receiverId: 'v.y.near', actions: [{ type: 'FunctionCall', methodName: 'register_with_token', args: {}, gasTgas: 30, deposit: 0n }], why: '' };
    assert.equal(cliCommand(tx, 'mainnet', 'keychain'), "near contract call-function as-transaction v.y.near register_with_token base64-args e30= prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as y.near network-config mainnet sign-with-keychain send");
    const wasm = { ...readWasmLike('r'), path: '/tmp/with space/r.wasm' };
    const batch: TxPlan = {
      id: 'registry-deploy',
      step: 'registry',
      signerId: n.registryParent,
      signerKey: null,
      receiverId: n.registry,
      actions: [{ type: 'CreateAccount' }, { type: 'Transfer', deposit: 2_890_000_000_000_000_000_000_000n }, { type: 'DeployContract', wasm }, { type: 'FunctionCall', methodName: 'new', args: {}, gasTgas: 100, deposit: 0n }],
      why: '',
    };
    assert.equal(
      cliCommand(batch, 'mainnet', 'ledger'),
      "near transaction construct-transaction x.near receiver-id r.x.near add-action create-account add-action transfer '2.89 NEAR' add-action deploy-contract use-file '/tmp/with space/r.wasm' with-init-call new base64-args e30= prepaid-gas '100 Tgas' attached-deposit '0 NEAR' skip network-config mainnet sign-with-ledger usb send",
    );
  });
});

// -- real key files ----------------------------------------------------------------------------

describe('key files', () => {
  test('a new key is written 0600 in the legacy keychain layout, and only its public key is ever listed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    temps.push(dir);
    const store = fileKeyStore('testnet', {}, dir);
    const created = await store.create('oracle.a-identity.testnet');
    assert.match(created.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.equal(created.path, join(dir, 'oracle.a-identity.testnet', `${created.publicKey.replace(':', '_')}.json`));
    assert.equal(statSync(created.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'oracle.a-identity.testnet')).mode & 0o777, 0o700);
    const stored = JSON.parse(readFileSync(created.path, 'utf8'));
    assert.deepEqual(Object.keys(stored), ['account_id', 'public_key', 'private_key']);
    assert.equal(stored.public_key, created.publicKey);
    assert.equal(await store.derive(created.path), created.publicKey);
    assert.deepEqual(store.list('oracle.a-identity.testnet'), [{ path: created.path, publicKey: created.publicKey, mode: 0o600 }]);
    assert.ok(!JSON.stringify(store.list('oracle.a-identity.testnet')).includes(stored.private_key));
    const signer = await store.signer('oracle.a-identity.testnet', created.publicKey);
    assert.ok(!('missing' in signer));
    assert.ok(!JSON.stringify(signer).includes(stored.private_key), 'a signer handle never serializes its secret');
    chmodSync(created.path, 0o644);
    assert.ok('missing' in (await store.signer('oracle.a-identity.testnet', created.publicKey)), 'a loose key file is refused');
    await assert.rejects(store.derive(created.path), /readable by group or others/);
    const refused = fileKeyStore('testnet', { AID_REVOKED_KEYS: created.publicKey }, dir);
    chmodSync(created.path, 0o600);
    assert.ok('missing' in (await refused.signer('oracle.a-identity.testnet', created.publicKey)));
  });

  test('a full run with real key files never prints or records a secret', async () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    temps.push(dir);
    const store = fileKeyStore('testnet', {}, dir);
    const parent = await store.create(w.names.registryParent);
    const oracle = await store.create(w.names.oracle);
    const owner = await store.create(w.names.vaultOwner);
    for (const [id, k] of [[w.names.registryParent, parent], [w.names.oracle, oracle], [w.names.vaultOwner, owner]] as const) {
      w.chain.accounts.set(id, { amount: 10n * ONE_NEAR, codeHash: ZERO_CODE_HASH, storage: 182, keys: new Map([[k.publicKey, { kind: 'FullAccess' } as Permission]]) });
    }
    w.chain.balances.set(w.names.vaultOwner, 20_000_000n);
    const r = await run(w.args('--execute'), {}, w.deps({ keys: store }));
    assert.equal(r.exit, 0, r.problems.join('\n'));
    const secrets: string[] = [];
    for (const account of readdirSync(dir)) {
      for (const f of readdirSync(join(dir, account))) secrets.push(JSON.parse(readFileSync(join(dir, account, f), 'utf8')).private_key);
    }
    assert.equal(secrets.length, 5, 'three signers, the oracle key and the agent key');
    const printed = w.lines.join('\n');
    const recorded = readFileSync(w.recordPath, 'utf8');
    for (const s of secrets) {
      assert.ok(!printed.includes(s), 'no secret in the output');
      assert.ok(!recorded.includes(s), 'no secret in the record');
      assert.ok(!printed.includes(s.slice(8, 30)), 'not even a piece of one');
    }
    assert.ok(existsSync(join(dir, w.names.vault)), 'the agent key file is in the vault account folder');
  });
});
