/**
 * Shared 2/2 Gnosis Safe treasury - the funder for the Merkle airdrop (airdrop.ts).
 *
 * Honesty first: a Gnosis Safe is created and operated with Safe's OWN audited contracts
 * via the official Safe app / Protocol Kit. We do NOT reimplement a multisig - that would
 * be both wrong and unsafe. This module (a) defines the canonical 2/2 config, (b) reads a
 * live Safe's real on-chain state (owners, threshold, USDC balance), and (c) documents the
 * fund -> airdrop -> sweep flow that connects the treasury to the claim contract.
 *
 * Reads need no key. The Safe's own transactions (fund the airdrop, sweep the remainder)
 * are signed by its 2 owners in the Safe app - human-on-the-loop, by design.
 */
import { createPublicClient, http, defineChain, type Hex } from 'viem'
import { ARC_CHAIN } from './chains/index.js'
import { CONTRACTS, ARC_RPC, ARC_EXPLORER } from './arc-contracts.js'

const SAFE_ABI = [
  { name: 'getOwners', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { name: 'getThreshold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'VERSION', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const arcChain = defineChain({
  id: ARC_CHAIN.evmChainId as number,
  name: ARC_CHAIN.name,
  nativeCurrency: ARC_CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [ARC_RPC] } },
})

export type SafeOwners = readonly [Hex, Hex]

/**
 * The canonical 2/2 treasury plan + the exact steps that wire it to the airdrop. This is
 * documentation the team follows in the Safe app; no keys, no side effects.
 */
export function safeTreasuryPlan(owners: SafeOwners) {
  return {
    type: 'Gnosis Safe (Safe{Wallet}) multisig',
    threshold: 2,
    owners,
    signaturesRequired: '2 of 2',
    chain: ARC_CHAIN.name,
    fundsAsset: { symbol: 'USDC', address: CONTRACTS.usdc },
    setup: [
      'Create the Safe with these 2 owners and threshold 2 via the official Safe app or the Safe Protocol Kit SDK (@safe-global/protocol-kit). Safe\'s audited contracts are the standard - we do not reimplement a multisig.',
      'Fund the Safe with USDC (the shared treasury balance).',
      'Deploy the airdrop with airdrop.ts deployAirdrop(recipients) - it commits to the Merkle root of the allocation list.',
      'From the Safe (2/2 approval), transfer USDC into the deployed MerkleAirdrop contract so recipients can claim their allocation once each.',
      'After the campaign, the Safe (as the airdrop owner) calls sweep(safe) to reclaim the unclaimed remainder back to the treasury.',
    ],
    note: 'A Safe on Arc requires Safe\'s factory to be present on Arc; otherwise create the treasury on a Safe-supported chain and bridge USDC via CCTP.',
  }
}

/** Read a live 2/2 Safe treasury's real on-chain state (owners, threshold, USDC balance). */
export async function readSafeTreasury(safe: Hex) {
  const client = createPublicClient({ chain: arcChain, transport: http(ARC_RPC) })
  try {
    const [owners, threshold, usdcBal] = await Promise.all([
      client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }) as Promise<Hex[]>,
      client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getThreshold' }) as Promise<bigint>,
      client.readContract({ address: CONTRACTS.usdc as Hex, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe] }) as Promise<bigint>,
    ])
    const t = Number(threshold)
    return {
      safe,
      owners,
      threshold: t,
      is2of2: owners.length === 2 && t === 2,
      usdcBalance: Number(usdcBal) / 1_000_000,
      explorer: `${ARC_EXPLORER}/address/${safe}`,
    }
  } catch (e) {
    return { safe, error: `Not a readable Safe on ${ARC_CHAIN.name}: ${e instanceof Error ? e.message : String(e)}` }
  }
}
