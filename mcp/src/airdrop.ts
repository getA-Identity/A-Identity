/**
 * Merkle USDC airdrop / claim on Arc - the backend for contracts/MerkleAirdrop.sol.
 *
 * The infrastructure the "Treasury & Airdrop" milestone asks for: build a Merkle tree
 * over a recipient list, deploy the claim contract committing to its root, and let each
 * recipient claim exactly their allocation once with a proof. The shared 2/2 Gnosis Safe
 * treasury (see treasury-safe.ts) is the funder - it deposits USDC into the deployed
 * contract, and can sweep the unclaimed remainder afterwards.
 *
 * Honesty, same as every write path in this repo: reads and tree/proof construction are
 * REAL and need no key; the actual deploy + claim broadcasts are env-gated behind
 * ARC_SIGNER_KEY (no key -> the exact prepared call is returned, nothing is sent). The
 * tree is keccak256 sorted-pair (OpenZeppelin / Uniswap convention), so the root the
 * backend computes is byte-identical to the one the contract verifies against.
 */
import {
  keccak256,
  encodePacked,
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_CHAIN } from './chains/index.js'
import { CONTRACTS, ARC_RPC, ARC_EXPLORER } from './arc-contracts.js'
import { MerkleAirdropAbi, MerkleAirdropBytecode } from './contracts/MerkleAirdrop.js'

const USDC_DECIMALS = 6

/** USD -> USDC 6-decimal units ($1.00 -> 1_000_000). Rejects negative / non-finite amounts. */
export const toUsdcUnits = (usd: number): bigint => {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid airdrop amount: ${usd}`)
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS))
}

export type AirdropEntry = { account: `0x${string}`; amountUsd: number }
export type Recipient = { index: number; account: `0x${string}`; amount: bigint; proof: Hex[] }
export type BuiltAirdrop = {
  root: Hex
  recipients: Recipient[]
  totalUnits: bigint
  totalUsd: number
}

// ── Merkle tree (keccak256, sorted pair) ──────────────────────────────────────────

/** leaf = keccak256(abi.encodePacked(uint256 index, address account, uint256 amount)). */
function leafOf(index: number, account: `0x${string}`, amount: bigint): Hex {
  return keccak256(encodePacked(['uint256', 'address', 'uint256'], [BigInt(index), account, amount]))
}

/** Hash a sorted pair - matches the contract's `computed <= p ? h(computed,p) : h(p,computed)`.
 *  keccak256 output is lowercase 0x+64hex, so a plain string compare == the uint256 compare. */
function hashPair(a: Hex, b: Hex): Hex {
  return a <= b
    ? keccak256(encodePacked(['bytes32', 'bytes32'], [a, b]))
    : keccak256(encodePacked(['bytes32', 'bytes32'], [b, a]))
}

/** Build every layer of the tree from the leaves (odd node promoted unchanged). */
function buildLayers(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) return [[`0x${'00'.repeat(32)}` as Hex]]
  const layers: Hex[][] = [leaves]
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1]
    const next: Hex[] = []
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i])
    }
    layers.push(next)
  }
  return layers
}

function proofFromLayers(layers: Hex[][], index: number): Hex[] {
  const proof: Hex[] = []
  let idx = index
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l]
    const sibling = idx ^ 1
    if (sibling < layer.length) proof.push(layer[sibling])
    idx = idx >> 1
  }
  return proof
}

/** Verify a proof off-chain exactly the way the contract does (for tests + previews). */
export function verifyProof(index: number, account: `0x${string}`, amount: bigint, proof: Hex[], root: Hex): boolean {
  let computed = leafOf(index, account, amount)
  for (const p of proof) computed = hashPair(computed, p)
  return computed === root
}

/**
 * Build the airdrop: assign indices, compute the root and each recipient's proof.
 * Duplicate accounts are allowed (different indices); order is stable and deterministic,
 * so the same input always yields the same root.
 */
export function buildAirdrop(entries: AirdropEntry[]): BuiltAirdrop {
  const base = entries.map((e, index) => ({ index, account: e.account, amount: toUsdcUnits(e.amountUsd) }))
  const leaves = base.map((r) => leafOf(r.index, r.account, r.amount))
  const layers = buildLayers(leaves)
  const root = layers[layers.length - 1][0]
  const recipients: Recipient[] = base.map((r) => ({ ...r, proof: proofFromLayers(layers, r.index) }))
  const totalUnits = base.reduce((s, r) => s + r.amount, 0n)
  return { root, recipients, totalUnits, totalUsd: Number(totalUnits) / 10 ** USDC_DECIMALS }
}

// ── on-chain (env-gated behind ARC_SIGNER_KEY) ────────────────────────────────────

const NO_KEY = 'No ARC_SIGNER_KEY - prepared only (nothing broadcast). Set the key to deploy/claim.'

const arcChain = defineChain({
  id: ARC_CHAIN.evmChainId as number,
  name: ARC_CHAIN.name,
  nativeCurrency: ARC_CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [ARC_RPC] } },
})

function signerFor(env: NodeJS.ProcessEnv) {
  const key = env.ARC_SIGNER_KEY
  if (!key) return null
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex)
  return { account, client: createWalletClient({ account, chain: arcChain, transport: http(ARC_RPC) }) }
}
const pub = () => createPublicClient({ chain: arcChain, transport: http(ARC_RPC) })
const txUrl = (h: string) => `${ARC_EXPLORER}/tx/${h}`

/**
 * Deploy the airdrop contract committing to the recipient list's Merkle root. `owner` MUST
 * be the shared 2/2 Gnosis Safe treasury - it becomes the on-chain owner (sweep authority),
 * so the funded pool stays under 2/2 control, NOT under the single hot deployer key.
 * Without a signer key, returns the exact prepared deploy (token, root, owner, args); with a
 * key, broadcasts and returns the deployed address.
 */
export async function deployAirdrop(
  entries: AirdropEntry[],
  owner: `0x${string}`,
  claimDeadlineSec?: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    throw new Error('deployAirdrop: owner must be an address - pass the 2/2 Safe treasury, not the deployer key')
  }
  // Sweep is disabled until this time, so recipients get a guaranteed claim window.
  // Default: 30 days out.
  const deadline = BigInt(
    Number.isFinite(claimDeadlineSec) && (claimDeadlineSec as number) > 0
      ? Math.floor(claimDeadlineSec as number)
      : Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  )
  const built = buildAirdrop(entries)
  const prepared = {
    token: CONTRACTS.usdc,
    merkleRoot: built.root,
    owner,
    claimDeadline: deadline.toString(),
    recipients: built.recipients.length,
    totalUsd: built.totalUsd,
    constructorArgs: [CONTRACTS.usdc, built.root, owner, deadline.toString()] as const,
  }
  const signer = signerFor(env)
  if (!signer) return { executed: false as const, reason: NO_KEY, ...prepared }
  const hash = await signer.client.deployContract({
    abi: MerkleAirdropAbi,
    bytecode: MerkleAirdropBytecode as Hex,
    args: [CONTRACTS.usdc as Hex, built.root, owner, deadline],
  })
  const receipt = await pub().waitForTransactionReceipt({ hash })
  return { executed: true as const, airdrop: receipt.contractAddress as string, txHash: hash, explorerUrl: txUrl(hash), ...prepared }
}

/**
 * Claim one recipient's allocation. Recomputes the proof from the same recipient list so
 * the caller only needs the index. Anyone may submit (funds always go to `account`), so a
 * relayer can pay gas. Env-gated: no key -> prepared claim args only.
 */
export async function claimAirdrop(
  airdrop: `0x${string}`,
  entries: AirdropEntry[],
  index: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const built = buildAirdrop(entries)
  const r = built.recipients[index]
  if (!r) return { executed: false as const, error: `No recipient at index ${index}` }
  const claimArgs = { index: r.index, account: r.account, amount: r.amount.toString(), proof: r.proof }
  const signer = signerFor(env)
  if (!signer) return { executed: false as const, reason: NO_KEY, airdrop, claimArgs }
  const hash = await signer.client.writeContract({
    address: airdrop,
    abi: MerkleAirdropAbi,
    functionName: 'claim',
    args: [BigInt(r.index), r.account, r.amount, r.proof],
  })
  const receipt = await pub().waitForTransactionReceipt({ hash })
  return { executed: true as const, airdrop, account: r.account, txHash: hash, explorerUrl: txUrl(hash), status: receipt.status }
}

/** Read the deployed airdrop's live state (root, owner, token, funded USDC, per-index claimed). */
export async function readAirdrop(airdrop: `0x${string}`, indices: number[] = []) {
  const client = pub()
  const [root, owner, token, deadline] = await Promise.all([
    client.readContract({ address: airdrop, abi: MerkleAirdropAbi, functionName: 'merkleRoot' }) as Promise<Hex>,
    client.readContract({ address: airdrop, abi: MerkleAirdropAbi, functionName: 'owner' }) as Promise<Hex>,
    client.readContract({ address: airdrop, abi: MerkleAirdropAbi, functionName: 'token' }) as Promise<Hex>,
    client.readContract({ address: airdrop, abi: MerkleAirdropAbi, functionName: 'claimDeadline' }) as Promise<bigint>,
  ])
  const claimed = await Promise.all(
    indices.map(async (i) => ({
      index: i,
      claimed: (await client.readContract({ address: airdrop, abi: MerkleAirdropAbi, functionName: 'isClaimed', args: [BigInt(i)] })) as boolean,
    })),
  )
  return { airdrop, merkleRoot: root, owner, token, claimDeadline: deadline.toString(), claimed }
}
