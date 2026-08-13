/**
 * The proof report: the recorded ledger plus a LIVE re-read of the same facts.
 *
 * A static list of transaction hashes ages badly, because it cannot tell you whether the
 * thing it describes is still true. So every report re-reads the chain right now:
 * ownerOf and tokenURI for the agent, eth_getCode for each contract, and a single
 * `matchesLedger` boolean that says whether what we recorded is what the chain says
 * today. That boolean is the strongest claim on the page precisely because it can fail.
 *
 * When the RPC is unreachable the static ledger is still returned, with `reachable:
 * false` and the reason. Dropping the evidence because a node timed out would be worse
 * than saying so, and inventing a read would be dishonest.
 */
import { getChainById } from './registry.js'
import type { ChainDescriptor } from './types.js'
import { evmPublicClient } from './evm/client.js'
import { artifactUrl, contractUrl, provenanceFor, railBySlug, PROOF_RAILS, type ChainProvenance } from './provenance.js'

const IDENTITY_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const

export type LiveCheck =
  | {
      reachable: true
      checkedAt: string
      blockNumber: string
      /** Present when the entry records an agent. */
      owner?: string
      tokenUri?: string
      /** Does the chain still say what the ledger says? */
      matchesLedger?: boolean
      contracts: { name: string; address: string; deployed: boolean }[]
    }
  | { reachable: false; checkedAt: string; reason: string }

export type ChainProofReport = ChainProvenance & {
  name: string
  caip2: string
  status: string
  explorer: string | null
  contractsLinked: { name: string; address: string; note?: string; explorerUrl: string | null }[]
  artifactsLinked: (ChainProvenance['artifacts'][number] & { explorerUrl: string | null })[]
  live: LiveCheck
}

export type RailProofReport = {
  slug: string
  title: string
  lede: string
  networks: ChainProofReport[]
  howToVerify: string[]
}

export async function chainProofReport(chainId: string, env: NodeJS.ProcessEnv = process.env): Promise<ChainProofReport | null> {
  const entry = provenanceFor(chainId)
  const chain = getChainById(chainId)
  if (!entry || !chain) return null
  return {
    ...entry,
    name: chain.name,
    caip2: chain.caip2,
    status: chain.status,
    explorer: chain.explorer,
    contractsLinked: entry.contracts.map((c) => ({ ...c, explorerUrl: contractUrl(chainId, c.address) })),
    artifactsLinked: entry.artifacts.map((a) => ({ ...a, explorerUrl: artifactUrl(a) })),
    live: await liveCheck(chain, entry, env),
  }
}

export async function railProofReport(slug: string, env: NodeJS.ProcessEnv = process.env): Promise<RailProofReport | null> {
  const rail = railBySlug(slug)
  if (!rail) return null
  const networks = (await Promise.all(rail.chains.map((c) => chainProofReport(c, env)))).filter(
    (r): r is ChainProofReport => r !== null,
  )
  return {
    slug: rail.slug,
    title: rail.title,
    lede: rail.lede,
    networks,
    howToVerify: [
      'Open any transaction link below: each is a real transaction in the block named, on the chain named.',
      'Every claim about an agent is re-read live when you load this page. If ownerOf stopped matching what we recorded, this page would say so.',
      'The registry addresses are the canonical ERC-8004 ones. Compare them to any other chain we list; they are deliberately identical.',
      'Settlements are proven by a receipt plus a matching Transfer log, not by a third party reporting success. See GET /api/facilitator/proof.',
    ],
  }
}

export function proofRailIndex(): { slug: string; title: string; chains: string[] }[] {
  return PROOF_RAILS.map((r) => ({ slug: r.slug, title: r.title, chains: [...r.chains] }))
}

async function liveCheck(chain: ChainDescriptor, entry: ChainProvenance, env: NodeJS.ProcessEnv): Promise<LiveCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const client = await evmPublicClient(chain, env)
    const blockNumber = await client.getBlockNumber()
    const contracts = await Promise.all(
      entry.contracts.map(async (c) => {
        const code = await client.getCode({ address: c.address as `0x${string}` }).catch(() => undefined)
        return { name: c.name, address: c.address, deployed: Boolean(code && code !== '0x') }
      }),
    )
    if (!entry.agent || !chain.contracts.identityRegistry) {
      return { reachable: true, checkedAt, blockNumber: blockNumber.toString(), contracts }
    }
    const registry = chain.contracts.identityRegistry as `0x${string}`
    const tokenId = BigInt(entry.agent.tokenId)
    const [owner, tokenUri] = await Promise.all([
      client.readContract({ address: registry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [tokenId] }) as Promise<string>,
      client.readContract({ address: registry, abi: IDENTITY_ABI, functionName: 'tokenURI', args: [tokenId] }) as Promise<string>,
    ])
    return {
      reachable: true,
      checkedAt,
      blockNumber: blockNumber.toString(),
      owner,
      tokenUri,
      matchesLedger: owner.toLowerCase() === entry.agent.owner.toLowerCase(),
      contracts,
    }
  } catch (e) {
    return { reachable: false, checkedAt, reason: e instanceof Error ? e.message : String(e) }
  }
}
