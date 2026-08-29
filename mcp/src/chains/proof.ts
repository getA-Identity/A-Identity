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
  ecosystem: ChainDescriptor['ecosystem']
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
    ecosystem: chain.ecosystem,
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
    howToVerify: howToVerify(networks),
  }
}

/**
 * How to check this rail, in terms that exist on it.
 *
 * Branched by ecosystem because the EVM version was being served for every rail, and three
 * of its four lines are false on Stellar: there is no ERC-8004 registry to compare, no
 * ownerOf to re-read, and /api/facilitator/proof is the EIP-3009 log rather than this one.
 * Telling a reviewer to check something that does not exist is worse than telling them
 * nothing, because they conclude we do not know our own chain.
 */
function howToVerify(networks: ChainProofReport[]): string[] {
  const shared = 'Open any transaction link below: each is a real transaction in the ledger named, on the chain named.'
  if (networks.length && networks.every((n) => n.ecosystem === 'stellar')) {
    // The fetch command has to name the network the contract is actually ON. This line
    // said `--network testnet` unconditionally, which was true while this rail was one
    // network and became a wrong instruction the moment pubnet joined it: run it against
    // testnet for a pubnet contract and you get "contract not found", which reads as our
    // evidence being fake rather than as a typo in our own docs.
    const nets = [...new Set(networks.map((n) => (n.caip2 === 'stellar:pubnet' ? 'pubnet' : 'testnet')))]
    const fetchNet = nets.length === 1 ? `--network ${nets[0]}` : `--network <${nets.join('|')}, whichever the contract is on>`
    return [
      shared,
      'A refused payment usually has NO transaction to open, and that is Soroban rather than evasion: the contract answers during simulation and nothing is ever submitted. Where a refusal IS linked here, it exists because the limit moved while the payment was in flight, so it failed at apply time and the ledger recorded the typed error. Everywhere else the typed error code is the artifact, and you can reproduce it against the live contract for free precisely because it is refused.',
      `The contract is unverified on Stellar Expert by design, because Rust wasm is not bit-reproducible across machines. Check it the direct way instead: \`stellar contract fetch --id <contract> ${fetchNet}\` and sha256 the bytes against the hash in soroban/releases/.`,
      'Settlements are proven by our own read of the SEP-41 transfer event, matched to the authorization that paid for them, never by a broadcaster reporting success. See GET /api/x402/stellar/proof, whose byBroadcaster field says who actually moved each one.',
    ]
  }
  return [
    shared.replace('ledger named', 'block named'),
    'Every claim about an agent is re-read live when you load this page. If ownerOf stopped matching what we recorded, this page would say so.',
    'The registry addresses are the canonical ERC-8004 ones. Compare them to any other chain we list; they are deliberately identical.',
    'Settlements are proven by a receipt plus a matching Transfer log, not by a third party reporting success. See GET /api/facilitator/proof.',
  ]
}

/**
 * The Soroban analogue, doing the same job with the same standard of evidence.
 *
 * `getLedgerEntries` on a contract instance is the honest counterpart of eth_getCode: it
 * answers whether the contract is actually there NOW, which is the question, rather than
 * whether we once deployed it. A contract whose instance entry has been archived is exactly
 * the failure worth surfacing on a proof page, because an archived vault is uncallable and
 * withdraw is uncallable with it.
 */
async function stellarLiveCheck(
  chain: ChainDescriptor,
  entry: ChainProvenance,
  env: NodeJS.ProcessEnv,
  checkedAt: string,
): Promise<LiveCheck> {
  try {
    const { sorobanServer } = await import('./stellar/client.js')
    const { Address, xdr } = await import('@stellar/stellar-sdk')
    const server = sorobanServer(chain, env)
    const latest = await server.getLatestLedger()
    const keys = entry.contracts.map((c) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(c.address).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ),
    )
    const found = await server.getLedgerEntries(...keys)
    const present = new Set(
      found.entries.map((e) => {
        try {
          return Address.fromScAddress(e.key.contractData().contract()).toString()
        } catch {
          return ''
        }
      }),
    )
    return {
      reachable: true,
      checkedAt,
      blockNumber: String(latest.sequence),
      contracts: entry.contracts.map((c) => ({ name: c.name, address: c.address, deployed: present.has(c.address) })),
    }
  } catch (e) {
    return { reachable: false, checkedAt, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function proofRailIndex(): { slug: string; title: string; chains: string[] }[] {
  return PROOF_RAILS.map((r) => ({ slug: r.slug, title: r.title, chains: [...r.chains] }))
}

async function liveCheck(chain: ChainDescriptor, entry: ChainProvenance, env: NodeJS.ProcessEnv): Promise<LiveCheck> {
  const checkedAt = new Date().toISOString()
  // Branched, because the EVM path asked a Soroban RPC for eth_blockNumber and rendered the
  // resulting "method not found" as reachable: false. That is a lie in the honest direction
  // but a lie: the chain was reachable, we were speaking the wrong protocol at it.
  if (chain.ecosystem === 'stellar') return stellarLiveCheck(chain, entry, env, checkedAt)
  if (chain.ecosystem === 'algorand') {
    // Reachability by the chain's own protocol: algod /v2/status. No provenance entry
    // exists for Algorand yet, so this arm is defensive; without it a future entry
    // would be probed with eth_blockNumber and report a reachable chain as down.
    try {
      const rpc = env[chain.rpcEnvVar ?? ''] || chain.rpcUrls[0]
      const res = await fetch(`${rpc}/v2/status`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { reachable: false, checkedAt, reason: `algod status HTTP ${res.status}` }
      const body = (await res.json()) as { 'last-round'?: number }
      return {
        reachable: true,
        checkedAt,
        blockNumber: String(body['last-round'] ?? ''),
        contracts: entry.contracts.map((c) => ({ name: c.name, address: c.address, deployed: false })),
      }
    } catch (e) {
      return { reachable: false, checkedAt, reason: e instanceof Error ? e.message : String(e) }
    }
  }
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
