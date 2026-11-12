// Network constants, gas budgets and amount helpers for the NEAR testnet demo and the oracle.
//
// One file holds every host the demo talks to, so a reviewer can see the whole surface at once.
// Any value can be overridden from the environment; nothing here is a secret. Writes are
// TESTNET only: there is no mainnet entry on purpose.
//
// The gas figures are not restated here: they are the SDK's (sdk/src/chain/abi.ts), which
// sdk/test/chain.test.ts holds to the vault's own AGENT_PREPAID_GAS in its lib.rs. abi.ts has
// no imports, so reading it loads nothing else of the SDK, near-api-js included.

import { REGISTRY_GAS_TGAS, VAULT_GAS_TGAS } from '../../sdk/src/chain/abi.ts';

export type NetworkConfig = {
  networkId: 'testnet';
  /** Reads fail over across these, in order, on transport errors, 5xx and 429 only. */
  readRpcUrls: string[];
  /** Writes go to ONE endpoint. A signed transaction is never resubmitted blindly; on a timeout
   * the sender polls the status by hash instead. */
  sendRpcUrl: string;
  /** Regular nodes forget transactions after a few epochs; every cited tx is checkable here. */
  archivalRpcUrl: string;
  /** Human links only: NearBlocks pages answer non-browser clients with a challenge. */
  explorerTxBase: string;
  explorerAccountBase: string;
  /** Circle's USDC on NEAR testnet (6 decimals). It emits NEP-141 events, which the settlement
   * check needs; usdc.fakes.testnet does not. */
  tokenId: string;
  tokenDecimals: number;
};

/** Circle's NEAR testnet USDC, as listed at developers.circle.com/stablecoins/usdc-contract-addresses.
 * A public contract account id (64 hex), not a credential. */
export const CIRCLE_USDC_TESTNET = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

export const TESTNET_DEFAULTS: NetworkConfig = {
  networkId: 'testnet',
  readRpcUrls: ['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org'],
  sendRpcUrl: 'https://rpc.testnet.fastnear.com',
  archivalRpcUrl: 'https://archival-rpc.testnet.fastnear.com',
  explorerTxBase: 'https://testnet.nearblocks.io/txns/',
  explorerAccountBase: 'https://testnet.nearblocks.io/address/',
  tokenId: CIRCLE_USDC_TESTNET,
  tokenDecimals: 6,
};

export type Env = Record<string, string | undefined>;

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** AID_RPC_URLS (comma list), AID_SEND_RPC_URL, AID_ARCHIVAL_RPC_URL and AID_TOKEN override the defaults. */
export function networkFromEnv(env: Env): NetworkConfig {
  const readRpcUrls = list(env.AID_RPC_URLS) ?? TESTNET_DEFAULTS.readRpcUrls;
  return {
    ...TESTNET_DEFAULTS,
    readRpcUrls,
    sendRpcUrl: env.AID_SEND_RPC_URL?.trim() || readRpcUrls[0] || TESTNET_DEFAULTS.sendRpcUrl,
    archivalRpcUrl: env.AID_ARCHIVAL_RPC_URL?.trim() || TESTNET_DEFAULTS.archivalRpcUrl,
    tokenId: env.AID_TOKEN?.trim() || TESTNET_DEFAULTS.tokenId,
  };
}

// Gas, in gas units. Every function call carries an explicit budget: near-api-js's actions
// builder defaults gas to 0, which makes a transaction that can never run.
export const TGAS = 1_000_000_000_000n;
const tgas = (n: number): bigint => BigInt(n) * TGAS;
export const GAS = {
  /** The vault's AGENT_PREPAID_GAS, 73 Tgas: its longest path (registry check, payee
   * registration, ft_transfer, callbacks) cannot even be scheduled below 51 Tgas, and 73 keeps
   * 30 percent over that floor. The agent key's allowance holds 0.001 NEAR per prepaid Tgas
   * (0.073 NEAR) until the receipts finish, and gets back what did not burn. */
  agentPay: tgas(VAULT_GAS_TGAS.pay),
  /** request_payment attaches the same figure as pay: it runs the same registry check. */
  agentRequest: tgas(VAULT_GAS_TGAS.request_payment),
  /** record_refusal burns about 2.4 Tgas (measured in the sandbox); 10 is the vault's own figure. */
  recordRefusal: tgas(VAULT_GAS_TGAS.record_refusal),
  /** owner_pay runs the same pipeline as pay; the owner's key has no allowance to protect. */
  ownerPay: tgas(VAULT_GAS_TGAS.owner_pay),
  /** Plain owner calls (owner_reject, set_allowed). */
  ownerCall: tgas(VAULT_GAS_TGAS.owner_default),
  /** The oracle's set_verdict on the registry. */
  setVerdict: tgas(REGISTRY_GAS_TGAS.set_verdict),
  /** Calls the protocol is expected to reject before execution. Kept small because nearcore checks
   * the key's allowance against the prepaid gas BEFORE it checks the key's permission: a large
   * figure on a key with little allowance left would hit NotEnoughAllowance instead of the rule
   * the attempt is meant to show. Never spent either way. */
  forbiddenCall: 5n * TGAS,
};
export const ONE_YOCTO = 1n;

/** Exact decimal to integer units. Refuses more fractional digits than the token has, instead of
 * truncating them the way near-api-js's FungibleToken.toUnits does. */
export function toUnits(text: string, decimals: number): bigint {
  const s = text.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a plain decimal amount: ${JSON.stringify(text)}`);
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`amount ${s} has ${frac.length} decimals; the token has ${decimals}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Integer units to a decimal string with at least two decimals ("500000" -> "0.50"). */
export function fromUnits(units: bigint | string, decimals: number): string {
  const v = typeof units === 'bigint' ? units : BigInt(units);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

export function usdc(units: bigint | string, net: NetworkConfig): string {
  return `${fromUnits(units, net.tokenDecimals)} USDC`;
}
