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
import { CHAINS, getChainById } from './registry.js'
import type { ChainDescriptor } from './types.js'
import { evmPublicClient } from './evm/client.js'
import {
  artifactUrl,
  contractUrl,
  provenanceFor,
  railBySlug,
  PROOF_RAILS,
  PROVENANCE,
  SOW2_RAIL,
  STELLAR_SOW2,
  type ChainArtifact,
  type ChainProvenance,
  type ProvenanceAccount,
  type Sow2Deliverable,
  type Sow2Evidence,
} from './provenance.js'

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
      /** `archived` marks a contract whose instance entry came back with a lapsed TTL. */
      contracts: { name: string; address: string; deployed: boolean; archived?: boolean }[]
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
  /** The published accounts with an explorer link derived from this chain. Empty, never
   *  absent, so a reader can tell "none published" from an older backend. */
  accountsLinked: (ProvenanceAccount & { explorerUrl: string | null })[]
  live: LiveCheck
}

/** One artifact a SOW 2 deliverable names, resolved against the ledger. */
export type Sow2ArtifactRef = {
  txHash: string
  label: string
  date: string | null
  onChain: string | null
  explorerUrl: string | null
}

export type Sow2Report = Omit<Sow2Evidence, 'deliverables'> & {
  deliverables: (Sow2Deliverable & { artifactsLinked: Sow2ArtifactRef[] })[]
}

export type RailProofReport = {
  slug: string
  title: string
  lede: string
  networks: ChainProofReport[]
  howToVerify: string[]
  /** Only on the Stellar rail: the dated SOW 2 section. */
  sow2?: Sow2Report
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
    accountsLinked: (entry.accounts ?? []).map((acc) => ({ ...acc, explorerUrl: contractUrl(acc.network, acc.address) })),
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
    howToVerify: await howToVerify(networks.map((n) => n.chain)),
    ...(rail.slug === SOW2_RAIL ? { sow2: sow2Report() } : {}),
  }
}

/**
 * The SOW 2 section with every hash it names resolved to a dated, linked artifact.
 *
 * Purely local, like the ledger it reads: nothing here waits on a chain, so the section
 * renders in full even when the live re-read below it could not reach an RPC. A hash that
 * resolves to nothing is dropped rather than rendered as a dead link; provenance.test.ts
 * fails the build before that can ship.
 */
export function sow2Report(): Sow2Report {
  const byHash = new Map<string, ChainArtifact>()
  for (const p of PROVENANCE) {
    if (getChainById(p.chain)?.ecosystem !== 'stellar') continue
    for (const a of p.artifacts) byHash.set(a.txHash, a)
  }
  return {
    ...STELLAR_SOW2,
    deliverables: STELLAR_SOW2.deliverables.map((d) => ({
      ...d,
      artifactsLinked: d.artifacts.flatMap((h) => {
        const a = byHash.get(h)
        return a
          ? [{ txHash: a.txHash, label: a.label, date: a.date ?? null, onChain: a.onChain ?? null, explorerUrl: artifactUrl(a) }]
          : []
      }),
    })),
  }
}

/**
 * How to check this rail, in terms that exist on it.
 *
 * One generator per ecosystem, keyed by the descriptor's own `ecosystem`, so a fourth
 * ecosystem is a compile error here rather than a silent fall-through. The fall-through is
 * what shipped: everything that was not Stellar got the EVM lines, so the Algorand page told
 * a reviewer to compare ERC-8004 registries and read EVM Transfer logs on a chain that has
 * neither, and the Celo page pointed at /api/facilitator/proof, a log that never sees a Celo
 * payment because Celo's own facilitator settles them. Telling a reviewer to check something
 * that does not exist is worse than telling them nothing, because they conclude we do not
 * know our own chain.
 *
 * Built from the registry and the ledger alone, never from a live read, so a test can pin
 * every line to the descriptor it describes. Async only because the Stellar arm borrows the
 * network passphrase from the Stellar client, which is loaded lazily like every other use of
 * the Stellar SDK in this file.
 */
export async function howToVerify(chainIds: readonly string[]): Promise<string[]> {
  const chains = chainIds.map((id) => getChainById(id)).filter((c): c is ChainDescriptor => Boolean(c))
  const lines: string[] = []
  // First appearance decides the order, so a mixed rail reads in the order it lists its
  // networks. Every rail is single-ecosystem today; this keeps a mixed one honest anyway.
  for (const eco of [...new Set(chains.map((c) => c.ecosystem))]) {
    lines.push(...(await VERIFY_BY_ECOSYSTEM[eco](chains.filter((c) => c.ecosystem === eco))))
  }
  return [...new Set(lines)]
}

const VERIFY_BY_ECOSYSTEM: Record<ChainDescriptor['ecosystem'], (chains: ChainDescriptor[]) => string[] | Promise<string[]>> = {
  evm: evmVerifyLines,
  stellar: stellarVerifyLines,
  algorand: algorandVerifyLines,
}

/** "A, B and C", for a sentence. */
function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Where a chain's payments are logged when the facilitator is not ours. A chain absent here
 * still gets the line, just without a log to point at: no endpoint is invented for it.
 */
const THIRD_PARTY_RAIL: Record<string, { operator: string; log: string }> = {
  celo: { operator: 'the first-party facilitator Celo operates', log: 'GET /api/celo/proof' },
}

function evmVerifyLines(chains: ChainDescriptor[]): string[] {
  const lines = ['Open any transaction link below: each is a real transaction in the block named, on the chain named.']

  if (chains.some((c) => c.contracts.identityRegistry && provenanceFor(c.id)?.agent)) {
    lines.push(
      'Every claim about an agent is re-read live when you load this page: ownerOf and tokenURI on the identity registry, at the current block. If ownerOf stopped matching what we recorded, this page would say so.',
    )
  }

  // Derived, because the line it replaces said every registry address is "deliberately
  // identical" to every other chain's, and on a rail with a mainnet and a testnet the two
  // addresses differ: the ERC-8004 authors deploy one address across mainnets and another
  // across testnets. A reviewer who compared them found us contradicting ourselves.
  const registries = chains.filter((c) => c.contracts.identityRegistry)
  if (registries.length) {
    const clauses = registries.map((c) => {
      const address = c.contracts.identityRegistry!
      const twins = CHAINS.filter(
        (o) => o.id !== c.id && o.contracts.identityRegistry?.toLowerCase() === address.toLowerCase(),
      ).map((o) => o.name)
      return twins.length
        ? `on ${c.name} it is ${address}, the same address ${listNames(twins)} carry`
        : `on ${c.name} it is ${address}, which no other chain we list carries`
    })
    const families = new Set(registries.map((c) => c.contracts.identityRegistry!.toLowerCase()))
    lines.push(
      `The identity registry is the canonical ERC-8004 deployment, at the same address wherever that deployment exists, so compare it across chains: ${clauses.join('; ')}.` +
        (families.size > 1 && registries.some((c) => c.testnet) && registries.some((c) => !c.testnet)
          ? ' Mainnets and testnets carry two different addresses by design, so those two not matching is expected.'
          : ''),
    )
  }

  const ours = chains.filter((c) => !c.testnet && (c.settlementTokens ?? []).some((t) => t.authorization === 'eip3009'))
  if (ours.length) {
    lines.push(
      `Payments on ${listNames(ours.map((c) => c.name))} go through the EIP-3009 facilitator we run: the buyer signs, we broadcast, and a payment counts only on a receipt carrying a matching Transfer log, never on a third party reporting success. A payment from a wallet we own is labeled internal, not hidden. See GET /api/facilitator/proof.`,
    )
  }

  // Only where a mainnet network on this rail sells through Circle Gateway: there Circle,
  // not we, broadcasts the batch, and the line above would be true of our rail but silent
  // about theirs.
  if (chains.some((c) => !c.testnet && c.gateway)) {
    lines.push(
      'Circle Gateway sales are the exception: Circle broadcasts the batch, so one counts only once Circle\'s transfers API returns that transfer for the payment\'s own authorization nonce, and it links to Circle\'s batch transaction once that lands. See GET /api/x402/gateway/proof.',
    )
  }

  // A mainnet that takes x402 payments with no settlement token of ours: someone else's
  // facilitator moves the money, and the standard of evidence is theirs, so say so.
  for (const c of chains) {
    if (c.testnet || !c.payment.x402 || (c.settlementTokens ?? []).some((t) => t.authorization !== 'none')) continue
    const rail = THIRD_PARTY_RAIL[c.id]
    lines.push(
      `On ${c.name} the payment rail is not ours: ${rail?.operator ?? 'a facilitator we do not run'} broadcasts each payment, and a payment is recorded when that facilitator answers settled, with the transaction hash it returns. We do not read the transfer back ourselves there, so open those hashes on the explorer rather than taking our log's word for them.${rail ? ` See ${rail.log}.` : ''}`,
    )
  }
  return lines
}

async function stellarVerifyLines(chains: ChainDescriptor[]): Promise<string[]> {
  const { networkPassphrase } = await import('./stellar/client.js')
  // The fetch command has to name the network the contract is actually ON, in words the
  // Stellar CLI understands out of the box. `--network pubnet` was neither: the CLI's
  // built-in networks are local, futurenet, testnet and mainnet, and its mainnet entry ships
  // with no RPC ("Bring Your Own"), so a reviewer copying the line got an error that reads
  // as our evidence being fake. Pubnet is named by RPC and passphrase instead. The RPC is
  // the descriptor's public primary and never the deployment's env override, which may be
  // a private endpoint carrying a key. Checked 2026-10-11 with stellar 27.1.0 against the
  // pubnet vault: the fetched bytes hash to the registry's spendVaultWasmHash.
  const fetchLines = chains.map((c) =>
    c.testnet
      ? `on ${c.name}, \`stellar contract fetch --id <contract> --network testnet\``
      : `on ${c.name}, \`stellar contract fetch --id <contract> --rpc-url ${c.rpcUrls[0]} --network-passphrase "${networkPassphrase(c)}"\` (the CLI's built-in mainnet entry ships with no RPC, so name one; any mainnet Soroban RPC will do)`,
  )
  return [
    'Open any transaction link below: each is a real transaction in the ledger named, on the chain named.',
    'A refused payment usually has NO transaction to open, and that is Soroban rather than evasion: the contract answers during simulation and nothing is ever submitted. Where a refusal IS linked here, it exists because the limit moved while the payment was in flight, so it failed at apply time and the ledger recorded the typed error. Everywhere else the typed error code is the artifact, and you can reproduce it against the live contract for free precisely because it is refused.',
    `The contract is unverified on Stellar Expert by design, because Rust wasm is not bit-reproducible across machines. Check it the direct way instead, by fetching its bytes and comparing their sha256 with the hash in soroban/releases/. ${fetchLines.join('; ').replace(/^on /, 'On ')}.`,
    'Settlements are proven by our own read of the SEP-41 transfer event, never by a broadcaster reporting success. A payment we or OpenZeppelin Channels broadcast is matched to the buyer\'s authorization nonce; one the buyer broadcast is bound to its transaction hash alone, and the log says which is which. See GET /api/x402/stellar/proof: byBroadcaster counts who moved each payment, and a payment from an account we control is labeled internal, not hidden.',
  ]
}

function algorandVerifyLines(chains: ChainDescriptor[]): string[] {
  const lines = [
    'Open any transaction link below: each is a real transaction on the chain it names, linked to that chain\'s own explorer, so a funding hop that crossed from another chain opens there.',
  ]
  if (!chains.some((c) => c.contracts.identityRegistry)) {
    lines.push(
      'No agent is re-read here because none is claimed: there is no ERC-8004 registry or agent-identity ARC on Algorand that we can anchor to, so an agent\'s passport is bridged from an EVM chain and this rail makes no identity claim of its own.',
    )
  }
  if (chains.some((c) => (provenanceFor(c.id)?.contracts.length ?? 0) > 0)) {
    lines.push(
      'Each contract here is an Algorand application, named by its id. The live check above asks algod for it on every load (GET /v2/applications/<id>), which any public algod will answer for you too, and its approval program is committed as TEAL next to its source under algorand/contracts/, so you can compile it yourself and compare.',
    )
  }
  const tokens = chains.flatMap((c) =>
    (c.settlementTokens ?? [])
      .filter((t) => t.authorization === 'algorand-group')
      .map((t) => `${t.symbol} (ASA ${t.address}) on ${c.name}`),
  )
  if (tokens.length) {
    lines.push(
      `Settlements are proven by our own indexer read of the ASA transfer, never by the facilitator reporting success: the transaction must be confirmed in a round, move ${listNames(tokens)}, pay our payTo at least the price, and come from the account that signed the payment group. See GET /api/x402/algorand/proof, where every row carries its round and what confirmed it.`,
    )
  }
  return lines
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
    const { isLiveLedgerEntry, sorobanServer } = await import('./stellar/client.js')
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
    // Kept by contract, entry and all. An archived instance still comes back from the RPC,
    // with liveUntilLedgerSeq 0, so presence alone printed "code present" over a contract that
    // cannot be called until somebody pays to restore it, which is the one state this check
    // exists to surface.
    const byAddress = new Map<string, { liveUntilLedgerSeq?: number }>()
    for (const e of found.entries) {
      try {
        byAddress.set(Address.fromScAddress(e.key.contractData().contract()).toString(), e)
      } catch {
        /* an entry whose key will not decode names no contract */
      }
    }
    return {
      reachable: true,
      checkedAt,
      blockNumber: String(latest.sequence),
      contracts: entry.contracts.map((c) => {
        const hit = byAddress.get(c.address)
        const archived = hit !== undefined && !isLiveLedgerEntry(hit, found.latestLedger)
        return { name: c.name, address: c.address, deployed: hit !== undefined, ...(archived ? { archived: true } : {}) }
      }),
    }
  } catch (e) {
    return { reachable: false, checkedAt, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** One network inside a rail, summarised from the local ledger. No chain is contacted. */
export type RailIndexNetwork = {
  chain: string
  name: string
  status: string
  testnet: boolean
  color: string
  /** Agent token id when the entry records one, null when the chain carries no identity. */
  agentTokenId: string | null
  contracts: number
  artifacts: number
  caveats: number
}

export type RailIndexEntry = {
  slug: string
  title: string
  lede: string
  chains: string[]
  networks: RailIndexNetwork[]
  /** Totals across the rail, so an index card can be honest without fetching the report. */
  totals: { contracts: number; artifacts: number; caveats: number }
  /** True when at least one network on the rail is a mainnet. */
  mainnet: boolean
}

/**
 * The rail index, rich enough to render a card per rail without a live read.
 *
 * The one page that shows every chain at once cannot afford to open seven RPC
 * connections before it paints, so this stays purely local: counts and names out of the
 * ledger we already hold. The live re-read is what /proof/:rail is for, and the index
 * links there rather than pretending to have done it.
 */
export function proofRailIndex(): RailIndexEntry[] {
  return PROOF_RAILS.map((r) => {
    const networks: RailIndexNetwork[] = r.chains.flatMap((id) => {
      const entry = provenanceFor(id)
      const chain = getChainById(id)
      if (!entry || !chain) return []
      return [
        {
          chain: id,
          name: chain.name,
          status: chain.status,
          testnet: chain.testnet,
          color: chain.color,
          agentTokenId: entry.agent?.tokenId ?? null,
          contracts: entry.contracts.length,
          artifacts: entry.artifacts.length,
          caveats: entry.caveats.length,
        },
      ]
    })
    return {
      slug: r.slug,
      title: r.title,
      lede: r.lede,
      chains: [...r.chains],
      networks,
      totals: {
        contracts: networks.reduce((n, x) => n + x.contracts, 0),
        artifacts: networks.reduce((n, x) => n + x.artifacts, 0),
        caveats: networks.reduce((n, x) => n + x.caveats, 0),
      },
      mainnet: networks.some((n) => !n.testnet),
    }
  })
}

async function liveCheck(chain: ChainDescriptor, entry: ChainProvenance, env: NodeJS.ProcessEnv): Promise<LiveCheck> {
  const checkedAt = new Date().toISOString()
  // Branched, because the EVM path asked a Soroban RPC for eth_blockNumber and rendered the
  // resulting "method not found" as reachable: false. That is a lie in the honest direction
  // but a lie: the chain was reachable, we were speaking the wrong protocol at it.
  if (chain.ecosystem === 'stellar') return stellarLiveCheck(chain, entry, env, checkedAt)
  if (chain.ecosystem === 'algorand') {
    // Reachability by the chain's own protocol (algod /v2/status), then each contract by
    // the question that matters for it. An Algorand contract is an application, and
    // GET /v2/applications/<id> answers whether it exists now: 200 with its params, 404
    // once deleted. This arm used to mark every contract `deployed: false` without asking,
    // written when no Algorand entry existed, and the live vault (application 3688854723)
    // then rendered "no code" in red on its own proof page. Any other answer fails the
    // whole check as unreachable rather than guessing in either direction.
    try {
      const rpc = env[chain.rpcEnvVar ?? ''] || chain.rpcUrls[0]
      const res = await fetch(`${rpc}/v2/status`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { reachable: false, checkedAt, reason: `algod status HTTP ${res.status}` }
      const body = (await res.json()) as { 'last-round'?: number }
      const contracts = await Promise.all(
        entry.contracts.map(async (c) => {
          const app = await fetch(`${rpc}/v2/applications/${encodeURIComponent(c.address)}`, {
            signal: AbortSignal.timeout(10_000),
          })
          if (!app.ok && app.status !== 404) throw new Error(`algod applications/${c.address} HTTP ${app.status}`)
          return { name: c.name, address: c.address, deployed: app.ok }
        }),
      )
      return {
        reachable: true,
        checkedAt,
        blockNumber: String(body['last-round'] ?? ''),
        contracts,
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
