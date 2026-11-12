// Read-only views of the vault, the registry and the token, as plain async functions so tests
// can replace them. JSON shapes follow the contracts (agent-spend-policy types.rs, registry
// types.rs): every u64/u128 is a decimal string; per-payee counters are numbers.

import { AGENT_METHODS, ORACLE_METHODS, type HoldKind } from '../../sdk/src/chain/abi.ts';
import { ftBalance, RpcAnswerError, viewAccessKey, viewAccessKeyList, viewAccount, viewFunction } from './rpc.ts';
import type { AccessKeyInfo, AccessKeyPermission, AccountView, RpcClient } from './rpc.ts';

// The agent's and the oracle's method lists are the SDK's (sdk/src/chain/abi.ts, held to the
// contract source by sdk/test/abi.test.ts); re-exported for the demo's checks below.
export { AGENT_METHODS, ORACLE_METHODS };

export type VaultConfigView = {
  owner_id: string;
  token_id: string;
  registry_id: string | null;
  frozen: boolean;
  daily_cap: string;
  auto_approve_max: string;
  allowlist_enabled: boolean;
  token_storage_deposit: string;
  /** "agent-spend-policy 0.2.0" for the build the demo is written against (sdk/src/chain/abi.ts VAULT_VERSION). */
  version: string;
  /** v1.1 (amendment A1). Absent on a vault that predates it, which pays unknown payees. */
  hold_unknown?: boolean;
};

export type HeldView = {
  id: string;
  payment_id: string;
  agent_pk: string;
  payee: string;
  amount: string;
  memo: string | null;
  /** The vault's code for a held pay (RegistryWarn, UnknownPayee), or the agent's own words for
   * a request, which can read like either. What a hold means is `kind`, never this. */
  reason: string;
  created_at_s: string;
  expires_at_s: string;
  /** What the vault itself saw when it held the payment (0.2.0 on): registry_warn, unknown_payee
   * or agent_request. Absent on an earlier build. */
  kind?: HoldKind;
};

export type RegistryVerdictView = {
  account_id: string;
  verdict: 'ALLOW' | 'WARN' | 'DENY';
  reasons: string[];
  evidence: string | null;
  score: number | null;
  code_hash: string | null;
  updated_at_ns: string;
  updated_by: string;
  expires_at_ns: string | null;
};

export type Views = {
  getConfig(vault: string): Promise<VaultConfigView>;
  listHeld(vault: string): Promise<HeldView[]>;
  getVerdict(registry: string, account: string): Promise<RegistryVerdictView | null>;
  paidCount(vault: string, payee: string): Promise<number>;
  refusalCount(vault: string, payee: string): Promise<number>;
  /** null when the vault predates the v1.1 view. */
  guardRefusalCount(vault: string, payee: string): Promise<number | null>;
  isAllowed(vault: string, payee: string): Promise<boolean>;
  listAllowlist(vault: string): Promise<string[]>;
  ftBalance(token: string, account: string): Promise<bigint | null>;
  accessKey(account: string, publicKey: string): Promise<AccessKeyInfo | null>;
  accessKeyList(account: string): Promise<Array<{ publicKey: string; permission: AccessKeyPermission }>>;
  /** null when the account does not exist. */
  account(accountId: string): Promise<AccountView | null>;
};

const PAGE = 20;

export function chainViews(rpc: RpcClient): Views {
  return {
    async getConfig(vault) {
      const v = await viewFunction<VaultConfigView>(rpc, vault, 'get_config');
      if (!v) throw new Error(`${vault}.get_config returned nothing`);
      return v;
    },
    async listHeld(vault) {
      const out: HeldView[] = [];
      for (let from = 0; from < 1000; from += PAGE) {
        const page = (await viewFunction<HeldView[]>(rpc, vault, 'list_held', { from_index: String(from), limit: String(PAGE) })) ?? [];
        out.push(...page);
        if (page.length < PAGE) break;
      }
      return out;
    },
    async getVerdict(registry, account) {
      return (await viewFunction<RegistryVerdictView>(rpc, registry, 'get_verdict', { account_id: account })) ?? null;
    },
    async paidCount(vault, payee) {
      return (await viewFunction<number>(rpc, vault, 'paid_count', { payee })) ?? 0;
    },
    async refusalCount(vault, payee) {
      return (await viewFunction<number>(rpc, vault, 'refusal_count', { payee })) ?? 0;
    },
    async guardRefusalCount(vault, payee) {
      try {
        return (await viewFunction<number>(rpc, vault, 'guard_refusal_count', { payee })) ?? 0;
      } catch (e) {
        if (e instanceof RpcAnswerError) return null;
        throw e;
      }
    },
    async isAllowed(vault, payee) {
      return (await viewFunction<boolean>(rpc, vault, 'is_allowed', { payee })) === true;
    },
    async listAllowlist(vault) {
      const out: string[] = [];
      for (let from = 0; from < 1000; from += PAGE) {
        const page = (await viewFunction<string[]>(rpc, vault, 'list_allowlist', { from_index: String(from), limit: String(PAGE) })) ?? [];
        out.push(...page);
        if (page.length < PAGE) break;
      }
      return out;
    },
    async ftBalance(token, account) {
      return ftBalance(rpc, token, account);
    },
    async accessKey(account, publicKey) {
      try {
        return await viewAccessKey(rpc, account, publicKey, 'final');
      } catch (e) {
        if (e instanceof RpcAnswerError) return null;
        throw e;
      }
    },
    async accessKeyList(account) {
      return viewAccessKeyList(rpc, account);
    },
    async account(accountId) {
      return viewAccount(rpc, accountId);
    },
  };
}

/** The agent key must be exactly the vault-created function-call key: receiver = the vault and
 * the three agent methods, nothing else. */
export function checkAgentKeyPermission(p: AccessKeyPermission | undefined, vault: string): { ok: boolean; why: string } {
  if (p === undefined) return { ok: false, why: 'the key is not on the vault account' };
  if (p === 'FullAccess') return { ok: false, why: 'the key is a FULL-ACCESS key; the demo only runs with the function-call key the vault created' };
  const fc = p.FunctionCall;
  if (fc.receiver_id !== vault) return { ok: false, why: `the key's receiver is ${fc.receiver_id}, not ${vault}` };
  const methods = [...fc.method_names].sort();
  const expected = [...AGENT_METHODS].sort();
  if (methods.length !== expected.length || methods.some((m, i) => m !== expected[i])) {
    return { ok: false, why: `the key allows [${fc.method_names.join(', ')}], expected exactly [${AGENT_METHODS.join(', ')}]` };
  }
  return { ok: true, why: `function-call key, receiver ${vault}, methods [${fc.method_names.join(', ')}], allowance ${fc.allowance ?? 'unlimited'} yoctoNEAR` };
}

/** Amendment A3: the oracle signs with a function-call key on the registry limited to the oracle
 * methods. A full-access oracle key is refused. */
export function checkOracleKeyPermission(p: AccessKeyPermission | undefined, registry: string): { ok: boolean; why: string } {
  if (p === undefined) return { ok: false, why: 'the key is not on the oracle account' };
  if (p === 'FullAccess') return { ok: false, why: 'the oracle key is FULL-ACCESS; amendment A3 says the oracle signs only with a function-call key on the registry' };
  const fc = p.FunctionCall;
  if (fc.receiver_id !== registry) return { ok: false, why: `the oracle key's receiver is ${fc.receiver_id}, not ${registry}` };
  if (!fc.method_names.includes('set_verdict')) return { ok: false, why: `the oracle key does not allow set_verdict ([${fc.method_names.join(', ')}])` };
  const extra = fc.method_names.filter((m) => !(ORACLE_METHODS as readonly string[]).includes(m));
  if (fc.method_names.length === 0 || extra.length > 0) {
    return { ok: false, why: `the oracle key allows more than the oracle methods: [${fc.method_names.length === 0 ? 'any method' : extra.join(', ')}]` };
  }
  return { ok: true, why: `function-call key, receiver ${registry}, methods [${fc.method_names.join(', ')}]` };
}
