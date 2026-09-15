/**
 * TrionLabs Stellar 8004: somebody else's agent registry, read live and labeled as such.
 *
 * This module exists because of a limitation this repo has published for months: ERC-8004
 * is EVM-only, nothing bridges it to Stellar, and a Stellar agent's passport is therefore
 * anchored on an EVM chain rather than here. That sentence is still true. What changed is
 * that a Soroban registry we can READ now exists, so "there is nothing to point at" has
 * stopped being accurate and "it is not ours" has become the honest reason.
 *
 * So every value this module returns carries the same four labels, and they are not
 * decoration:
 *
 *   source 'third-party'  Trion Labs deployed it, Trion Labs owns it. We wrote nothing here
 *                         except one testnet registration made with our own key.
 *   live                  a simulation against the real contract, not a cached fact.
 *   its own id space      agent ids are u32 and start at 0 in a namespace of its own, so
 *                         "agent 25" there and ERC-8004 token 25 are two different agents
 *                         that happen to be integers.
 *   upgradeable           the contracts sit behind a timelocked propose/execute upgrade
 *                         owned by Trion. Ours deliberately has no upgrade entrypoint.
 *
 * The consequence stated plainly, because it is the whole point: this is a live read and
 * NOT our identity anchor. Nothing here binds a Stellar agent to a foreign-chain identity,
 * the interface has no function that could, and the two places a cross-chain claim could be
 * written (the free-form agent_uri and set_metadata) are assertions by whoever holds the
 * key, checked by nobody. KYA cannot be anchored here.
 *
 * Read-only by construction. There is no write path in this file and there will not be
 * one: our own mainnet registration, when it happens, is a human running one command.
 */
import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { addressUrl } from '../explorer.js'
import { CHAINS } from '../registry.js'
import type { ChainDescriptor } from '../types.js'
import { networkPassphrase, simulationArchivedEntries, sorobanServer } from './client.js'
import { isContractId } from './strkey.js'

/**
 * The stand-in source account for reads, the all-zero ed25519 key in StrKey form.
 *
 * Restated rather than imported because `stellar/adapter.ts` keeps it module-private, and
 * the alternative to a second copy is exporting a constant out of a file this change has
 * no business touching. It is a well-known null account rather than a value that can drift:
 * it does not exist on any network, it cannot sign, and a read that depended on holding a
 * key would be the actual bug.
 */
const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

/** Soroban agent ids are u32. Anything outside the range is not an id, it is a typo. */
const U32_MAX = 4_294_967_295

/**
 * The sentence that travels with every read, so no caller has to reconstruct the caveat
 * from field names. Deliberately one string: a note split across three optional fields is
 * a note that gets rendered as one of them.
 */
export const STELLAR_8004_NOTE =
  'TrionLabs Stellar 8004 is a third-party registry: it mints its own u32 agent ids in its ' +
  'own space, binds no foreign-chain identity, and is upgradeable by its owner behind a ' +
  'timelock. So this is a live read of somebody else\'s contract, not our identity anchor, ' +
  'and KYA cannot be anchored here.'

// -- the id, and what it is not ----------------------------------------------------

/**
 * A parsed Stellar 8004 identifier.
 *
 * `network` carries Trion's word, not ours. Their display label spells mainnet "mainnet"
 * and CAIP-2 spells the same network "pubnet"; both are accepted on input and the label we
 * print back is theirs, because it is their registry and their explorer that has to
 * recognise it.
 */
export type Stellar8004Id = {
  /** Our registry slug for the chain this id names: 'stellar' or 'stellar-testnet'. */
  chain: string
  /** Trion's network word. Note this is NOT CAIP-2: CAIP-2 for mainnet is stellar:pubnet. */
  network: 'testnet' | 'mainnet'
  /** The Identity registry the id belongs to, taken from the chain descriptor. */
  identityRegistry: string
  agentId: number
  /** The canonical Trion label for this id. */
  label: string
}

/**
 * Three answers, not two.
 *
 * 'other' means "this string is not a Stellar 8004 id at all", which a caller must be able
 * to tell apart from 'refused': the first falls through to whatever else it resolves, the
 * second is a Stellar 8004 id that names a registry we do not recognise and must not be
 * quietly re-pointed at the one we do.
 */
export type Stellar8004IdParse =
  | ({ kind: 'stellar8004' } & Stellar8004Id)
  | { kind: 'other' }
  | { kind: 'refused'; reason: string }

/** Trion's display label: stellar:{testnet|mainnet}:{identityRegistry}#{agentId}. */
const TRION_LABEL = /^stellar:([A-Za-z]+):(C[A-Z2-7]{55})#(\d{1,10})$/
/** Our shorter alias, for a human who should not have to paste 56 characters. */
const SHORT_ALIAS = /^stellar8004:([A-Za-z]+)#(\d{1,10})$/i

/** Every chain in the registry whose descriptor names a Stellar 8004 Identity registry. */
export function stellar8004Chains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'stellar' && Boolean(c.contracts.stellar8004?.identity))
}

/** Descriptor lookup by Trion's network word, derived so no slug is restated here. */
function chainForNetwork(network: 'testnet' | 'mainnet'): ChainDescriptor | undefined {
  return stellar8004Chains().find((c) => (network === 'testnet' ? c.testnet : !c.testnet))
}

/** Trion's label for an agent on a chain whose descriptor names the registry. */
export function stellar8004Label(chain: ChainDescriptor, agentId: number): string {
  const registry = chain.contracts.stellar8004?.identity
  if (!registry) throw new Error(`${chain.id} declares no contracts.stellar8004.identity`)
  return `stellar:${chain.testnet ? 'testnet' : 'mainnet'}:${registry}#${agentId}`
}

/**
 * Parse Trion's label or our alias, and REFUSE an id whose registry is not the one the
 * chain descriptor names.
 *
 * The refusal is the part worth writing down. A Stellar 8004 label carries its registry
 * inline, and another deployment of the same source is a different registry with a
 * different id space: agent 25 there is a stranger. Reading the number against OUR
 * descriptor's registry because the shape matched would answer a question nobody asked,
 * with somebody else's agent.
 */
export function parseStellar8004Id(s: string): Stellar8004IdParse {
  const q = s.trim()

  const labelled = TRION_LABEL.exec(q)
  const aliased = labelled ? null : SHORT_ALIAS.exec(q)
  if (!labelled && !aliased) return { kind: 'other' }

  const word = (labelled ? labelled[1] : aliased![1]).toLowerCase()
  if (word !== 'testnet' && word !== 'mainnet' && word !== 'pubnet') return { kind: 'other' }
  const network: 'testnet' | 'mainnet' = word === 'testnet' ? 'testnet' : 'mainnet'

  const raw = labelled ? labelled[3] : aliased![2]
  const agentId = Number(raw)
  if (!Number.isInteger(agentId) || agentId < 0 || agentId > U32_MAX) {
    return { kind: 'refused', reason: `${raw} is not a u32 agent id; Stellar 8004 ids are u32.` }
  }

  const chain = chainForNetwork(network)
  if (!chain) {
    return {
      kind: 'refused',
      reason: `the chain registry declares no Stellar 8004 Identity registry for ${network}, so this id cannot be read.`,
    }
  }
  const identityRegistry = chain.contracts.stellar8004!.identity

  if (labelled && labelled[2] !== identityRegistry) {
    return {
      kind: 'refused',
      reason:
        `this id names Identity registry ${labelled[2]} on ${network}, which is not the one ` +
        `${chain.id} declares. A different deployment is a different id space, so the number ` +
        'was not read against ours.',
    }
  }

  return {
    kind: 'stellar8004',
    chain: chain.id,
    network,
    identityRegistry,
    agentId,
    label: stellar8004Label(chain, agentId),
  }
}

// -- the read ----------------------------------------------------------------------

/**
 * One simulated view call, in the three states a simulation actually has.
 *
 * 'restore' is separate from 'error' because Soroban archives ledger entries as a matter
 * of course and an archived registry is a live, recoverable fact about somebody else's
 * rent, not a failure of ours. Collapsing the two would report a registry that is merely
 * cold as a registry that is broken.
 */
export type Stellar8004SimResult =
  | { status: 'ok'; retval: xdr.ScVal }
  | { status: 'restore'; reason: string }
  | { status: 'error'; error: string }

export type Stellar8004Simulate = (
  contractId: string,
  method: string,
  args: xdr.ScVal[],
) => Promise<Stellar8004SimResult>

export type Stellar8004Deps = {
  /** Injected in tests. Defaults to a real simulation against the chain's Soroban RPC. */
  simulate?: Stellar8004Simulate
  /** Injected in tests. Only used for an https agent_uri, never for a data: one. */
  fetch?: typeof globalThis.fetch
  env?: NodeJS.ProcessEnv
}

export type Stellar8004RegistryState = {
  identity: string
  /** get_owner(): whoever can propose an upgrade. null when the registry reports none. */
  owner: string | null
  version: string | null
  totalAgents: number | null
  /** Always true, and stated rather than implied: the contracts carry an upgrade path. */
  upgradeable: true
  /** pending_upgrade(): a proposal in its timelock, or null when nothing is queued. */
  pendingUpgrade: unknown | null
}

export type Stellar8004AgentState = {
  id: number
  /** find_owner(): who holds the agent NFT. */
  owner: string | null
  /** get_agent_wallet(): the account the agent pays and is paid from. */
  wallet: string | null
  agentUri: string | null
  agentUriKind: 'data' | 'https' | 'other' | null
  /** The registration JSON when the URI is a data: JSON or a fetchable https one. */
  registration: Record<string, unknown> | null
}

/**
 * Three outcomes, discriminated by `readable` FIRST.
 *
 * "the registry does not have this agent" and "we could not read the registry" are
 * different facts, and a caller that treats the second as the first publishes an absence it
 * never observed. That is the same distinction self-agent-id.ts and validation-registry.ts
 * already keep, for the same reason.
 */
export type Stellar8004Read =
  | {
      readable: true
      found: true
      source: 'third-party'
      live: true
      chain: string
      registry: Stellar8004RegistryState
      agent: Stellar8004AgentState
      label: string
      explorerUrl: string
      note: string
    }
  | {
      readable: true
      found: false
      source: 'third-party'
      live: true
      chain: string
      registry: string
      label: string
      explorerUrl: string
      reason: string
      note: string
    }
  | {
      readable: false
      reason: 'archived' | 'unreachable'
      source: 'third-party'
      live: false
      chain: string
      registry: string
      label: string
      explorerUrl: string
      detail: string
      note: string
    }

/**
 * The default simulator: a view call done exactly the way stellar/adapter.ts does one.
 *
 * A read needs a source account only so a transaction can be built; the simulator never
 * checks that it exists or that its sequence is real, which is what lets this work with no
 * key, no funds and no round trip to fetch an account.
 */
export function stellar8004Simulate(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  /** TEST ONLY: a simulator handle. Production passes nothing and reads the chain's RPC. */
  deps: { server?: Pick<rpc.Server, 'simulateTransaction'> } = {},
): Stellar8004Simulate {
  const net = networkPassphrase(chain)
  return async (contractId, method, args) => {
    let sim: rpc.Api.SimulateTransactionResponse
    try {
      const server = deps.server ?? sorobanServer(chain, env)
      const account = new Account(READ_ONLY_SOURCE, '0')
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(30)
        .build()
      sim = await server.simulateTransaction(tx)
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
    if (rpc.Api.isSimulationError(sim)) return { status: 'error', error: sim.error }
    // Checked BEFORE the value is used, in both shapes archived state arrives in: the number
    // beside it is a value the ledger would make you pay rent to read for real. A restore
    // preamble was the only shape before protocol 23. Since CAP-0066 there is no preamble,
    // the archived footprint indexes ride in the transaction data and the rent is folded into
    // the fee, and checking the preamble alone is how Trion's pubnet registry read as live on
    // 2026-09-15 with its instance and code both lapsed.
    const archived = simulationArchivedEntries(sim)
    if (rpc.Api.isSimulationRestore(sim) || archived.length > 0) {
      return {
        status: 'restore',
        reason:
          `${method} reads archived state and needs a restore first` +
          (archived.length ? ` (footprint entries ${archived.join(', ')} are archived)` : ''),
      }
    }
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
      return { status: 'error', error: `${method}: simulation returned no result` }
    }
    return { status: 'ok', retval: sim.result.retval }
  }
}

/** A data: URI's payload as text, base64 or percent-encoded. null when it is neither. */
export function decodeDataUri(uri: string): string | null {
  const m = /^data:([^,]*),([\s\S]*)$/.exec(uri)
  if (!m) return null
  if (/;base64/i.test(m[1])) {
    try {
      return Buffer.from(m[2], 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  try {
    return decodeURIComponent(m[2])
  } catch {
    return m[2]
  }
}

/**
 * Whether an agent_uri may be fetched server-side.
 *
 * The URI is set by whoever registered the agent, so it is hostile input: https only, and
 * no loopback, private range or cloud metadata host. erc8004.ts carries the fuller guard
 * for EVM tokenURIs and is NOT imported here, because that module imports this one and a
 * cycle between them is worse than fifteen lines. This one is deliberately stricter: plain
 * http is refused outright rather than filtered.
 */
export function isFetchableAgentUri(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 100 && b >= 64 && b <= 127) return false
  }
  if (host.includes(':') && (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd'))) {
    return false
  }
  return true
}

function asObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Read one agent out of the Stellar 8004 Identity registry on a chain whose descriptor
 * names it. Live simulation, no key, no write, nothing cached.
 */
export async function readStellar8004Agent(
  chain: ChainDescriptor,
  agentId: number,
  deps: Stellar8004Deps = {},
): Promise<Stellar8004Read> {
  const registry = chain.contracts.stellar8004?.identity
  if (!registry) {
    throw new Error(
      `${chain.id} declares no contracts.stellar8004.identity, so there is no registry to read. ` +
        'Resolve the chain through parseStellar8004Id, which refuses an id no descriptor covers.',
    )
  }
  if (!isContractId(registry)) throw new Error(`${chain.id}'s stellar8004.identity is not a Soroban contract id`)

  const label = stellar8004Label(chain, agentId)
  const explorerUrl = addressUrl(chain, registry)
  const frame = { source: 'third-party' as const, chain: chain.id, label, explorerUrl, note: STELLAR_8004_NOTE }
  const unreadable = (reason: 'archived' | 'unreachable', detail: string): Stellar8004Read => ({
    readable: false,
    reason,
    live: false,
    registry,
    detail,
    ...frame,
  })

  const simulate = deps.simulate ?? stellar8004Simulate(chain, deps.env ?? process.env)
  const u32 = (v: number) => nativeToScVal(v, { type: 'u32' })
  const call = (method: string, args: xdr.ScVal[] = []) => simulate(registry, method, args)

  // The registry block first, and the whole read fails on it, because every later answer is
  // a statement about THIS registry at THIS version: reporting an agent while unable to say
  // what contract answered would be the part a reader most needs.
  const [version, totalAgents, owner, pendingUpgrade, exists] = await Promise.all([
    call('version'),
    call('total_agents'),
    call('get_owner'),
    call('pending_upgrade'),
    call('agent_exists', [u32(agentId)]),
  ])
  for (const r of [version, totalAgents, owner, pendingUpgrade, exists]) {
    if (r.status === 'restore') return unreadable('archived', r.reason)
    if (r.status === 'error') return unreadable('unreachable', r.error)
  }

  const native = (r: Stellar8004SimResult): unknown => (r.status === 'ok' ? scValToNative(r.retval) : null)
  const registryState: Stellar8004RegistryState = {
    identity: registry,
    owner: typeof native(owner) === 'string' ? (native(owner) as string) : null,
    version: typeof native(version) === 'string' ? (native(version) as string) : null,
    totalAgents: typeof native(totalAgents) === 'number' ? (native(totalAgents) as number) : null,
    upgradeable: true,
    pendingUpgrade: native(pendingUpgrade) ?? null,
  }

  if (native(exists) !== true) {
    return {
      readable: true,
      found: false,
      live: true,
      registry,
      reason:
        `the Identity registry on ${chain.name} has no agent ${agentId}. It reports ` +
        `${registryState.totalAgents ?? 'an unknown number of'} agents; ids are minted in its own ` +
        'space, so this number existing on another chain says nothing about this one.',
      ...frame,
    }
  }

  // Per-field, and tolerant on purpose. Existence is already proven, so a metadata field
  // that will not read is a missing field rather than a missing agent: the EVM path learned
  // the same lesson when a reverting tokenURI hid a real registration.
  const [uriR, ownerR, walletR] = await Promise.all([
    call('agent_uri', [u32(agentId)]),
    call('find_owner', [u32(agentId)]),
    call('get_agent_wallet', [u32(agentId)]),
  ])
  const agentUri = typeof native(uriR) === 'string' ? (native(uriR) as string) : null
  const agentUriKind = agentUri === null
    ? null
    : agentUri.startsWith('data:')
      ? 'data'
      : /^https:\/\//i.test(agentUri)
        ? 'https'
        : 'other'

  let registration: Record<string, unknown> | null = null
  if (agentUriKind === 'data') {
    registration = asObject(decodeDataUri(agentUri!))
  } else if (agentUriKind === 'https' && isFetchableAgentUri(agentUri!)) {
    const doFetch = deps.fetch ?? globalThis.fetch
    try {
      // redirect 'error' so an agent-controlled URL cannot 30x us into an internal target.
      const res = await doFetch(agentUri!, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
      if (res.ok) registration = asObject(await res.text())
    } catch {
      /* an unreachable registration document is metadata we do not have, not a failed read */
    }
  }

  return {
    readable: true,
    found: true,
    live: true,
    registry: registryState,
    agent: {
      id: agentId,
      owner: typeof native(ownerR) === 'string' ? (native(ownerR) as string) : null,
      wallet: typeof native(walletR) === 'string' ? (native(walletR) as string) : null,
      agentUri,
      agentUriKind,
      registration,
    },
    ...frame,
  }
}

// -- the point of sale --------------------------------------------------------------

/** A-Identity's agent number in the Stellar 8004 TESTNET id space. Not an ERC-8004 id. */
export const A_IDENTITY_TESTNET_AGENT_ID = 25

/**
 * What the x402 rails say about identity at the moment a buyer is asked to pay.
 *
 * It lives here rather than in the rail because every value in it is a fact about the
 * registry, and because a second rail asking the same question should get the same answer
 * rather than its own copy. The claim it makes is the narrow one: our passport is anchored
 * on an EVM chain, Stellar 8004 is read and not anchored on, and pubnet is not done.
 */
export function stellar8004SaleIdentity(): {
  anchoredOn: 'evm'
  note: string
  passport: string
  stellar8004: { testnet: string | null; pubnet: null; note: string }
} {
  const testnet = stellar8004Chains().find((c) => c.testnet)
  return {
    anchoredOn: 'evm',
    note: 'ERC-8004 is EVM-only; the passport this rail checks lives on an EVM chain and KYA cannot be anchored on Stellar',
    passport: 'https://a-identity.xyz/.well-known/agent-card.json',
    stellar8004: {
      // Our own testnet registration, tx 6070127842948b6aa26103e270f8e38b670f8c92916edbc691f3cd5f10754b07
      // (2026-09-08). The registry id is derived from the descriptor; only the agent number
      // is ours to state, because no descriptor field holds it.
      testnet: testnet ? stellar8004Label(testnet, A_IDENTITY_TESTNET_AGENT_ID) : null,
      // Not a placeholder for something in progress. The pubnet Identity registry's
      // instance and code entries were archived when we tried, with a 36.64 XLM restore in
      // the footprint, so there is nothing to claim until its owner restores it.
      pubnet: null,
      note: 'third-party registry, read-only for us, not our anchor; pubnet registration pending the registry owner restoring its archived instance',
    },
  }
}
