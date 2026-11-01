/**
 * What every verify-then-pay entry point shares: the chain it runs on, where flow records
 * live, the seams tests replace, and the public paths a record is reached at.
 *
 * One chain, read from the registry by id and never restated: Arc Mainnet. Its CAIP-2 id,
 * chain id, USDC, IdentityRegistry and RPC hosts all come from the descriptor, because a
 * literal for any of them outside chains/ fails the build.
 */
import { evmPublicClient, getChainById, type ChainDescriptor, type EveryRpcOptions } from '../chains/index.js'
import type { RailDeps } from '../x402-gateway/index.js'
import {
  findVtpFlowByTx,
  loadOpenVtpFlows,
  loadVtpFlow,
  persistVtpFlow,
  updateVtpFlow,
  type VtpFlowByTx,
  type VtpFlowInsert,
  type VtpFlowMatch,
  type VtpFlowOutcome,
  type VtpFlowRead,
  type VtpFlowRecord,
  type VtpFlowsRead,
  type VtpFlowUpdate,
  type VtpStoreIo,
} from '../storage.js'
import type { VtpReadClient } from './reads.js'

export const VTP_CHAIN_ID = 'arc-mainnet'
/** Where the public flow records are linked from. The site proxies /api to the backend. */
export const VTP_PUBLIC_ORIGIN = 'https://a-identity.xyz'
export const VTP_ROUTE = '/api/x402/gateway/verify-then-pay'

export function vtpChain(): ChainDescriptor {
  const chain = getChainById(VTP_CHAIN_ID)
  if (!chain) throw new Error(`the registry no longer has ${VTP_CHAIN_ID}; verify-then-pay reads its network from there`)
  if (!chain.contracts.usdc || !chain.contracts.identityRegistry || chain.evmChainId == null) {
    throw new Error(`${VTP_CHAIN_ID} lost its USDC, its IdentityRegistry or its chain id in the registry`)
  }
  return chain
}

export function flowPath(flowId: string): string {
  return `/api/x402/gateway/flows/${flowId.toLowerCase()}`
}

/** The public record of one flow. A DENY has no transaction, so this URL is its evidence. */
export function flowUrl(flowId: string, origin: string = VTP_PUBLIC_ORIGIN): string {
  return `${origin.replace(/\/$/, '')}${flowPath(flowId)}`
}

export type VtpStore = {
  load(flowId: string): Promise<VtpFlowRead>
  insert(rec: VtpFlowRecord): Promise<VtpFlowInsert>
  update(flowId: string, patch: Partial<Pick<VtpFlowRecord, 'outcome' | 'detail' | 'payment' | 'updatedAt'>>, from: VtpFlowOutcome[]): Promise<VtpFlowUpdate>
  findByTx(txHash: string): Promise<VtpFlowByTx>
  /** The open flows (pending or waiting for the owner) on one vault, payee and amount. */
  openFlows(match: VtpFlowMatch): Promise<VtpFlowsRead>
}

/** The vtp_flows table (or its file fallback) behind the store interface. */
export function storageVtpStore(io: VtpStoreIo = {}): VtpStore {
  return {
    load: (id) => loadVtpFlow(id, io),
    insert: (rec) => persistVtpFlow(rec, io),
    update: (id, patch, from) => updateVtpFlow(id, patch, from, io),
    findByTx: (hash) => findVtpFlowByTx(hash, io),
    openFlows: (match) => loadOpenVtpFlows(match, io),
  }
}

export type VtpDeps = {
  env?: NodeJS.ProcessEnv
  /** Scheme and host the request arrived on: resource URLs and record links use it. */
  origin?: string
  /** The Gateway rail's seams (supported kinds, settle, transfers, tool handlers, its own
   *  settlement log). Production passes none. */
  rail?: Omit<RailDeps, 'env' | 'origin'>
  /** Arc Mainnet reads. Default: a keyless client over the registry's RPCs. */
  client?: VtpReadClient
  store?: VtpStore
  /** Receipt and transaction read-backs, every RPC one by one (chains/evm/receipts.ts). */
  receipts?: EveryRpcOptions
  now?: () => number
  /** The most a prepared call may price gas at, wei. Default prepare.ts DEFAULT_MAX_FEE_CAP_WEI. */
  feeCapWei?: bigint
  /** Life the operator's session key must have left past the latest block. Default 60 s. */
  expiryMarginSec?: number
}

/** The default reader: a keyless public client. Reads may roll from host to host; receipts
 *  never go through it (see chains/evm/receipts.ts). */
export async function vtpReadClient(chain: ChainDescriptor, env: NodeJS.ProcessEnv): Promise<VtpReadClient> {
  return (await evmPublicClient(chain, env)) as unknown as VtpReadClient
}
