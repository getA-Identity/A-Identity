/**
 * Multichain type foundation. One typed descriptor per chain (see registry.ts),
 * plus the shared write-result shapes every chain adapter returns.
 *
 * Config is DATA (a ChainDescriptor), logic is chain-agnostic. Adding a chain is a
 * new descriptor, not a new code path. See ./README.md.
 */

/** Which virtual machine family a chain belongs to. Selects the adapter. */
export type Ecosystem = 'evm' | 'stellar'

/** Lifecycle status. Only `live` chains are fully wired end to end. */
export type ChainStatus = 'live' | 'beta' | 'planned' | 'deprecated'

/** Per-chain contract addresses. All optional: a `planned` chain has none yet. */
export interface ChainContracts {
  identityRegistry?: string
  reputationRegistry?: string
  validationRegistry?: string
  agenticCommerce?: string
  usdc?: string
  /** The AgentSpendPolicy vault is deployed per-agent at runtime, so this is
   *  usually absent (there is no single shared address). Present only if a chain
   *  uses a factory/template address. */
  spendVault?: string
  /** Arc's predeployed `Memo` precompile: wraps a contract call, preserves the EOA
   *  as `msg.sender` via `CallFrom`, and emits an on-chain audit-trail event. Present
   *  only on chains that ship it (Arc). Absent → settlements fall back to a bare
   *  USDC transfer with no memo. */
  memo?: string
  /** Arc's predeployed `Multicall3From` precompile: batches many contract calls into
   *  one tx, EOA preserved via `CallFrom`. Present only on chains that ship it (Arc). */
  multicall3From?: string
  /**
   * Deterministic CREATE2 factory, the thing that makes one contract ADDRESS possible on
   * every EVM chain (see the chains README (one address, many chains)). Only set where its presence was actually
   * verified with an eth_getCode call, never assumed from the fact that it is "usually
   * there": deploying against an absent factory fails in a confusing way.
   */
  create2Factory?: string
  /**
   * ONE per-agent AgentSpendPolicy vault we deployed on this chain, kept for
   * verification. Deliberately NOT `spendVault`: that field means a factory or template
   * a caller may read, and pointing it at a single instance would invite exactly that
   * misuse. This is evidence, not infrastructure.
   */
  spendVaultExample?: string
}

/**
 * A token this chain can SETTLE x402 payments in, and what was actually PROVEN about it.
 *
 * Deliberately NOT `contracts.usdc`. That slot is what every generic USDC path reads
 * (payUsdc, the ERC-8183 escrow approve, the AgentSpendPolicy vault constructor at
 * evm/adapter.ts:51), so only a canonical Circle USDC belongs there. A chain can have a
 * real settlement token and still have no USDC, which is exactly Robinhood Chain: Paxos
 * USDG is live on 4663 and no canonical USDC is documented. Putting USDG in `usdc` would
 * silently repoint escrow and vault deployments at a token they were never tested with.
 */
export interface SettlementToken {
  /** `symbol()` as the contract reports it. NOT the EIP-712 domain name: the bridged
   *  testnet token reports symbol "USDC.e" while its domain name is "USDC". */
  symbol: string
  address: string
  /** `decimals()` as read from the contract. Cross-checked live before any challenge,
   *  because a typo here is a 1000x mispricing. */
  decimals: number
  /**
   * The signed-transfer standard OBSERVED on this contract, never assumed.
   *
   *  'eip3009'      transferWithAuthorization: the payer signs typed data, someone else
   *                 broadcasts. Per-token, because the token contract must implement it.
   *  'soroban-auth' The payer signs a Soroban authorization ENTRY for `transfer` on a
   *                 SEP-41 contract, and whoever assembles the transaction pays the fee.
   *                 Not per-token: the host provides it for any `require_auth` call, and
   *                 replay protection is the host's rather than the token's. Which is why
   *                 a Soroban token carries no `domainVersionCandidates` and never will:
   *                 there is no per-token EIP-712 domain to prove, because the
   *                 authorization preimage is fixed by the protocol.
   */
  authorization: 'eip3009' | 'eip2612' | 'soroban-auth' | 'none'
  /**
   * EIP-712 `version` candidates. Some tokens expose no `version()` at all (USDG reverts
   * for it), so the signing domain cannot simply be read: it is PROVEN at runtime by
   * rebuilding each candidate and matching the live DOMAIN_SEPARATOR. Nothing here is
   * trusted. A candidate that does not reproduce the on-chain separator is discarded,
   * and a token with no matching candidate is refused rather than guessed at.
   */
  domainVersionCandidates?: string[]
  /** How and when the facts above were established. Prose, for the audit trail. */
  verified: string
  /**
   * The disclosed settlement fee for a rail that broadcasts on the buyer's behalf, in USD,
   * derived from a MEASUREMENT of what a settlement costs on this chain. It lives here
   * rather than in the rail because gas is a property of the chain, and one global fee
   * across chains whose gas differs by an order of magnitude would be a markup wearing the
   * words "covers what it costs us". `feeBasis` records the measurement so the number is
   * traceable rather than asserted.
   */
  settlementFeeUsd?: number
  feeBasis?: string
}

/**
 * The canonical, VM-neutral description of a chain. This is the single source of
 * truth: RPC, explorer, native token, per-chain contract addresses, feature flags,
 * and lifecycle status all live here so nothing else in the codebase hardcodes a
 * chain id, RPC, or address.
 */
export interface ChainDescriptor {
  /** CAIP-2 id — the PRIMARY KEY. e.g. 'eip155:5042002', 'stellar:testnet'. */
  caip2: string
  /** Short slug for UI / logs. e.g. 'arc', 'base'. */
  id: string
  name: string
  /** Short label for UI chips. e.g. 'Arc', 'Arbitrum'. */
  shortName: string
  /** Brand hex color for UI badges. Must stay readable as chip text on its own tint
   *  in BOTH light and dark themes, so avoid near-black and near-white. */
  color: string
  /** One line on what this chain's job is in the product. Shown in the UI and served
   *  by GET /api/chains, so keep it honest about what is live vs planned. */
  role: string
  ecosystem: Ecosystem
  testnet: boolean
  status: ChainStatus

  /** EIP-155 numeric chain id. null for non-EVM chains. */
  evmChainId: number | null
  /** Circle CCTP domain id (its own id space, not the chain id). null if unknown. */
  cctpDomain: number | null

  nativeCurrency: { name: string; symbol: string; decimals: number }
  /** Decimals of the ERC-20 (or SEP-41 / SPL) USDC interface. Arc's native USDC is
   *  18 decimals but its ERC-20 interface is 6 — this is the 6. */
  usdcDecimals: number

  /** RPC endpoints, primary first. A fallback transport is built over all of them. */
  rpcUrls: string[]
  wsUrl?: string
  explorer: string | null
  faucet?: string

  contracts: ChainContracts
  /** Required confirmations before a payment is treated as settled. */
  confirmations: number
  stablecoins: string[]
  /** Tokens this chain can settle x402 payments in. Absent or empty means no paid rail
   *  is possible here yet. Every symbol listed here must also appear in `stablecoins`
   *  (registry.test.ts enforces both directions). */
  settlementTokens?: SettlementToken[]

  /** Env var holding the signer key for writes on this chain (writes are gated on it). */
  signerEnvVar?: string
  /** Env var that overrides the primary RPC url, if set. */
  rpcEnvVar?: string

  identity: { standard: string; erc8004Native: boolean; note?: string }
  payment: { x402: boolean; note?: string }
}

// ── shared write-result shapes (prepared-or-executed, human-on-the-loop) ──────────
//
// Every write returns EITHER the exact prepared call (when no signer is configured)
// OR the executed result (tx hash + explorer url). This is the golden rule that keeps
// the server honest: nothing broadcasts unless a key is present and execute is asked for.

export type Prepared = {
  executed: false
  contract: string
  function: string
  args: unknown[]
  reason: string
}

export type Executed = {
  executed: true
  txHash: string
  explorerUrl: string
  agentId?: string
  /** Set when the settlement was wrapped through Arc's `Memo` precompile: the
   *  indexed `memoId` (keccak of the instruction ref) and the decoded reason payload
   *  emitted on-chain. Absent on a bare transfer. */
  memoId?: string
  memo?: string
}

export type VaultDeployed = {
  executed: true
  vault: string
  owner: string
  operator: string
  txHash: string
  explorerUrl: string
}
export type VaultTx = { executed: true; txHash: string; explorerUrl: string }
export type VaultReverted = { executed: false; reverted: true; reason: string }
export type VaultNoKey = { executed: false; reverted: false; reason: string }
export type VaultResult = VaultTx | VaultReverted | VaultNoKey

export type ValidationExecuted = {
  executed: true
  txHash: string
  explorerUrl: string
  requestHash: string
}
