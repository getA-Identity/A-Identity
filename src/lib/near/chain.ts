/**
 * NEAR testnet as the registry describes it, for the NEAR vault console.
 *
 * Everything here comes from src/lib/chains.ts, which is GENERATED from
 * mcp/src/chains/registry.ts: the RPC hosts, the explorer, the vault the registry records and
 * the USDC Circle documents. No host and no token is typed in this file. Explorer links are
 * derived from the registry's explorer the way mcp/src/chains/explorer.ts derives them:
 * NearBlocks routes a transaction at /txns/<hash> and every account at /address/<account>.
 *
 * Testnet only, on purpose: the registry carries no NEAR mainnet entry, and this console signs
 * nothing anywhere else.
 */
import { CHAIN_BY_ID, CHAIN_NEAR, CHAIN_RPC_URLS, type NearDocumentedToken } from '../chains.ts'

export const NEAR_CHAIN = CHAIN_BY_ID['near-testnet']

/** Every registry RPC for NEAR testnet, primary first, archival last. */
export const NEAR_RPC_URLS: readonly string[] = CHAIN_RPC_URLS['near-testnet']

/** The vault the registry records as deployed (contracts.spendVaultExample). Null until a deploy receipt fills it. */
export const REGISTRY_VAULT: string | null = CHAIN_NEAR['near-testnet']?.vault ?? null

/** Circle's testnet USDC as the registry documents it, if it does. */
export const REGISTRY_USDC: NearDocumentedToken | null = CHAIN_NEAR['near-testnet']?.tokens.find((t) => t.symbol === 'USDC') ?? null

/** The network id the wallets and the RPC hosts call it. */
export const NEAR_NETWORK = 'testnet' as const

export function nearTxUrl(hash: string): string | null {
  return NEAR_CHAIN.explorer ? `${NEAR_CHAIN.explorer}/txns/${encodeURIComponent(hash)}` : null
}

export function nearAccountUrl(accountId: string): string | null {
  return NEAR_CHAIN.explorer ? `${NEAR_CHAIN.explorer}/address/${encodeURIComponent(accountId)}` : null
}

/**
 * The demo accounts the NEAR deployment record (near/deployments/testnet.json) reserves, and
 * nothing more: PLANNED, not deployed. The page offers to read them live, and a live read is
 * what says whether they exist; these strings never stand in for a deployment.
 */
export const PLANNED = {
  vault: 'vault.aid-demo-owner.testnet',
  owner: 'aid-demo-owner.testnet',
  registry: 'registry.a-identity.testnet',
} as const
