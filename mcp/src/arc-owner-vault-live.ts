/**
 * Milestone 1's owner-held vault admission: the half that reads the chain.
 *
 * arc-owner-vault.ts decides, with no network in scope. This module does the reading, and both
 * callers go through it so they cannot diverge: scripts/arc-owner-vault-check.mjs, which prints
 * what it read, and POST /api/arc/vaults, which stores an admitted vault. Read-only: nothing is
 * signed and nothing is sent. The RPC hosts are a seam (RpcHost), so every path is tested with
 * plain answers.
 *
 * The receipt, the transaction and its block are asked of EVERY host, because a null from one
 * host is not an answer: Blockdaemon serves old blocks without their transactions, and on
 * 2026-11-01 the launch-day receipt came back from dRPC alone. The vault's code and state are
 * read at one block on one host, and a host that errors, is behind the deploy or shows no code
 * hands over to the next.
 *
 * The owner is compared with every key we hold (collectOurAddresses), and the server keeps the
 * script's rule: admitting on Arc Mainnet without our key env vars loaded refuses
 * (envLoadedCheck), so a server missing them refuses every vault rather than admit one owned by
 * a key only the env knows.
 */
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, toHex, type Abi, type Hex } from 'viem'
import {
  ADMISSION_CHAIN,
  ADMISSION_EVIDENCE_URL,
  admissionHosts,
  agreeAcrossHosts,
  blockFingerprint,
  collectOurAddresses,
  deployChecks,
  encodeCreationInput,
  envLoadedCheck,
  liveOurAddressSources,
  matchCreationInput,
  matchRuntime,
  receiptFingerprint,
  stateChecks,
  stateNotes,
  transactionFingerprint,
  utcDayFromSeconds,
  verdict,
  type Check,
  type DeployEvidence,
  type HostAnswer,
  type OurAddresses,
  type RpcBlock,
  type RpcReceipt,
  type RpcTransaction,
  type RuntimeMatch,
  type VaultState,
  type Verdict,
} from './arc-owner-vault.js'
import type { ArcOwnerHeldVault } from './arc-season.js'
import { addressUrl, txUrl } from './chains/explorer.js'
import { getChainById } from './chains/registry.js'
import type { ChainDescriptor } from './chains/types.js'
import { AgentSpendPolicyAbi, AgentSpendPolicyBytecode } from './contracts/AgentSpendPolicy.js'
import { findAdmittedArcVaultByTx, loadAdmittedArcVaults, persistAdmittedArcVault, type ArcAdmittedVaultRecord, type ArcVaultInsert, type ArcVaultByTx, type ArcVaultStoreIo } from './storage.js'

const abi = AgentSpendPolicyAbi as unknown as Abi
const bytecode = AgentSpendPolicyBytecode as Hex
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

// -- the hosts -------------------------------------------------------------------------

/** One JSON-RPC endpoint. `url` is only there so an error never prints it: it can hold a key. */
export type RpcHost = {
  label: string
  url?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: (method: string, params: readonly unknown[]) => Promise<any>
}

/** The registry's hosts for the chain, as real clients. The script keeps viem's retry; the server asks for less. */
export function liveRpcHosts(chain: ChainDescriptor, env: Readonly<Record<string, string | undefined>>, opts: { timeoutMs?: number; retryCount?: number } = {}): RpcHost[] {
  return admissionHosts(chain, env).map((h) => {
    const client = createPublicClient({ transport: http(h.url, { timeout: opts.timeoutMs ?? 15_000, retryCount: opts.retryCount ?? 1, retryDelay: 500 }) })
    return {
      label: h.label,
      url: h.url,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request: (method, params) => client.request({ method, params } as any),
    }
  })
}

/** One line of an error, with any endpoint URL replaced by its label. */
export function shortRpcError(e: unknown, hosts: readonly RpcHost[]): string {
  const err = e as { shortMessage?: string; message?: string } | null
  let s = String(err?.shortMessage ?? err?.message ?? e).split('\n')[0]
  for (const h of hosts) if (h.url) s = s.split(h.url).join(h.label)
  return s.slice(0, 200)
}

/**
 * The same hosts, with one deadline over everything they are asked. Past it a read fails at once,
 * which the checks turn into a refusal that says so. The route sits behind a proxy that gives up
 * at about thirty seconds, and a stalled host must not take the answer down with it.
 */
export function withDeadline(hosts: readonly RpcHost[], ms: number, now: () => number = Date.now): RpcHost[] {
  const end = now() + ms
  return hosts.map((h) => ({
    ...h,
    request: async (method, params) => {
      if (now() >= end) throw new Error('the read ran out of time')
      return h.request(method, params)
    },
  }))
}

// -- what is checked against -----------------------------------------------------------

export type AdmissionContext = {
  chain: ChainDescriptor
  /** True on the testnet: every check runs, and nothing it passes is a Milestone 1 entry. */
  rehearsal: boolean
  registryUsdc: string
  token: { symbol: string; decimals: number }
}

/** The chain, and the one USDC its usdc() is compared with, or why there is none. */
export function admissionContext(chainId: string = ADMISSION_CHAIN): { ok: true; context: AdmissionContext } | { ok: false; reason: string } {
  const chain = getChainById(chainId)
  if (!chain || chain.ecosystem !== 'evm') return { ok: false, reason: `the built registry has no EVM chain ${chainId}` }
  const rehearsal = chainId !== ADMISSION_CHAIN
  if (rehearsal !== chain.testnet) {
    return { ok: false, reason: `${chainId} is ${chain.testnet ? '' : 'not '}a testnet in the registry, so it cannot be ${rehearsal ? 'the rehearsal' : 'Milestone 1'}` }
  }
  const usdcToken = (chain.settlementTokens ?? []).find((t) => t.symbol === 'USDC')
  const registryUsdc = chain.contracts.usdc ?? usdcToken?.address
  if (!registryUsdc || (usdcToken && usdcToken.address.toLowerCase() !== registryUsdc.toLowerCase())) {
    return { ok: false, reason: `the registry names no single USDC for ${chainId}, so usdc() has nothing to be compared with` }
  }
  return { ok: true, context: { chain, rehearsal, registryUsdc, token: { symbol: usdcToken?.symbol ?? 'USDC', decimals: usdcToken?.decimals ?? chain.usdcDecimals } } }
}

// -- the reads -------------------------------------------------------------------------

/** Ask every host and keep each answer: null, a value or an error. In parallel, so a host that stalls costs its own timeout once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function everyHost<T>(hosts: readonly RpcHost[], method: string, params: readonly unknown[], normalize: (v: any) => T = (v) => v): Promise<HostAnswer<T>[]> {
  return Promise.all(
    hosts.map(async (h): Promise<HostAnswer<T>> => {
      try {
        const value = await h.request(method, params)
        return { host: h.label, value: value == null ? null : normalize(value) }
      } catch (e) {
        return { host: h.label, value: null, error: shortRpcError(e, hosts) }
      }
    }),
  )
}

export type VaultSnapshot = {
  host: RpcHost | null
  blockNumber: bigint | null
  blockTime: bigint | null
  code: string | null
  state: VaultState | null
  error: string | null
}

const GETTERS = ['owner', 'operator', 'usdc', 'dailyCap', 'autoApproveMax', 'sessionKeyExpiry', 'frozen', 'allowlistEnabled'] as const

/** The vault's code and every getter at one block on one host; a host that errors, is behind the deploy or shows no code hands over to the next. */
export async function readVaultSnapshot(hosts: readonly RpcHost[], address: string, deployBlock: bigint | null): Promise<VaultSnapshot> {
  const problems: string[] = []
  for (const h of hosts) {
    try {
      const head = await h.request('eth_getBlockByNumber', ['latest', false])
      if (!head) throw new Error('no latest block')
      const blockNumber = BigInt(head.number)
      const blockTime = BigInt(head.timestamp)
      if (deployBlock !== null && blockNumber < deployBlock) {
        problems.push(`${h.label}: at block ${blockNumber}, behind the deploy block ${deployBlock}`)
        continue
      }
      const tag = toHex(blockNumber)
      const code = (await h.request('eth_getCode', [address, tag])) as string | null
      if (!code || code === '0x') {
        problems.push(`${h.label}: no code at ${address} at block ${blockNumber}`)
        continue
      }
      const read = async (functionName: string): Promise<unknown> => {
        const data = encodeFunctionData({ abi, functionName })
        const out = (await h.request('eth_call', [{ to: address, data }, tag])) as Hex
        return decodeFunctionResult({ abi, functionName, data: out })
      }
      const values = await Promise.all(GETTERS.map(read))
      const got = Object.fromEntries(GETTERS.map((n, i) => [n, values[i]]))
      const balance = (await read('balance').catch(() => null)) as bigint | null
      return { host: h, blockNumber, blockTime, code, state: { ...got, balance } as unknown as VaultState, error: null }
    } catch (e) {
      problems.push(`${h.label}: ${shortRpcError(e, hosts)}`)
    }
  }
  return { host: null, blockNumber: null, blockTime: null, code: null, state: null, error: problems.join('; ') || 'no host answered' }
}

/** What the artifact's creation code returns for these args: eth_call, so nothing is sent. The state host first, at the state block; then the others at their latest block. */
async function simulateCreation(hosts: readonly RpcHost[], initcode: Hex, from: string, preferred: RpcHost | null, blockNumber: bigint | null): Promise<{ code: string | null; error: string | null }> {
  const order = preferred ? [preferred, ...hosts.filter((h) => h !== preferred)] : hosts
  const problems: string[] = []
  for (const h of order) {
    try {
      const tag = h === preferred && blockNumber !== null ? toHex(blockNumber) : 'latest'
      const out = await h.request('eth_call', [{ from, data: initcode }, tag])
      if (typeof out === 'string' && out.length > 2) return { code: out, error: null }
      problems.push(`${h.label}: empty result`)
    } catch (e) {
      problems.push(`${h.label}: ${shortRpcError(e, hosts)}`)
    }
  }
  return { code: null, error: problems.join('; ') }
}

// -- one whole admission ---------------------------------------------------------------

export type AdmissionInput = {
  context: AdmissionContext
  hosts: readonly RpcHost[]
  /** The deploy transaction. Without it only the vault's state is read, and nothing is admitted. */
  tx?: string
  /** With tx: the vault the receipt must have created. Without tx: the vault to read. */
  vault?: string
  ours: OurAddresses
  /** Refuse unless our key env vars were loaded. Whoever would admit on Arc Mainnet sets it. */
  requireEnvKeys: boolean
}

export type AdmissionRun = {
  receiptAnswers: HostAnswer<RpcReceipt>[] | null
  txAnswers: HostAnswer<RpcTransaction>[] | null
  blockAnswers: HostAnswer<RpcBlock>[] | null
  /** The block number the receipt names, hex, when one was trusted. */
  receiptBlock: string | null
  evidence: DeployEvidence | null
  deployer: string | null
  deployBlock: bigint | null
  deployBlockTime: bigint | null
  vault: string | null
  snapshot: VaultSnapshot
  runtime: RuntimeMatch | null
  checks: Check[]
  verdict: Verdict
  notes: string[]
}

export async function runAdmission(input: AdmissionInput): Promise<AdmissionRun> {
  const { context, hosts, tx: txHash, ours } = input
  const { chain, registryUsdc, token } = context

  let receiptAnswers: HostAnswer<RpcReceipt>[] | null = null
  let txAnswers: HostAnswer<RpcTransaction>[] | null = null
  let blockAnswers: HostAnswer<RpcBlock>[] | null = null
  let evidence: DeployEvidence | null = null
  let deployer: string | null = null
  let deployBlockTime: bigint | null = null
  let vault: string | null = null

  if (txHash) {
    receiptAnswers = await everyHost<RpcReceipt>(hosts, 'eth_getTransactionReceipt', [txHash])
    const receipt = agreeAcrossHosts(receiptAnswers, receiptFingerprint)
    txAnswers = await everyHost<RpcTransaction>(hosts, 'eth_getTransactionByHash', [txHash], (t) => ({ ...t, input: t.input ?? t.data ?? '0x' }))
    const tx = agreeAcrossHosts(txAnswers, transactionFingerprint)
    const r = receipt.conflict ? null : receipt.value
    let block: DeployEvidence['block'] = null
    if (r) {
      blockAnswers = await everyHost<RpcBlock>(hosts, 'eth_getBlockByNumber', [r.blockNumber, false], (b) => ({ number: b.number, hash: b.hash, timestamp: b.timestamp }))
      block = agreeAcrossHosts(blockAnswers, blockFingerprint)
      if (block.value && !block.conflict) deployBlockTime = BigInt(block.value.timestamp)
    }
    const t = tx.conflict ? null : tx.value
    const creation = t ? matchCreationInput(t.input as Hex, bytecode, abi) : null
    evidence = { txHash, receipt, tx, block, creation, expectedVault: input.vault || null }
    deployer = r?.from ?? null
    if (r?.contractAddress && ADDRESS.test(r.contractAddress)) vault = getAddress(r.contractAddress)
  }
  if (!vault && input.vault) vault = getAddress(input.vault)

  const trustedReceipt = evidence?.receipt.value && !evidence.receipt.conflict ? evidence.receipt.value : null
  const deployBlock = trustedReceipt ? BigInt(trustedReceipt.blockNumber) : null
  const snapshot: VaultSnapshot = vault
    ? await readVaultSnapshot(hosts, vault, deployBlock)
    : { host: null, blockNumber: null, blockTime: null, code: null, state: null, error: 'no vault address: the receipt named none' }

  let runtime: RuntimeMatch | null = null
  const s = snapshot.state
  const simArgs = evidence?.creation?.args ?? (s ? { owner: s.owner, operator: s.operator, usdc: s.usdc, dailyCap: s.dailyCap, autoApproveMax: s.autoApproveMax } : null)
  if (simArgs && snapshot.code) {
    let initcode: Hex | null = null
    try {
      initcode = encodeCreationInput(bytecode, abi, simArgs)
    } catch (e) {
      runtime = matchRuntime(snapshot.code, null, `the constructor args do not encode: ${shortRpcError(e, hosts)}`)
    }
    if (initcode) {
      const sim = await simulateCreation(hosts, initcode, deployer ?? simArgs.owner, snapshot.host, snapshot.blockNumber)
      runtime = matchRuntime(snapshot.code, sim.code, sim.error ?? undefined)
    }
  }

  const checks: Check[] = [
    ...(input.requireEnvKeys ? [envLoadedCheck(ours)] : []),
    ...(evidence ? deployChecks(evidence) : []),
    ...stateChecks({
      state: snapshot.state,
      stateError: snapshot.error ?? undefined,
      stateBlockedBy: vault ? undefined : evidence ? (trustedReceipt ? 'contract-created' : 'receipt-found') : undefined,
      deployer,
      deployerBlockedBy: txHash && deployer === null ? 'receipt-found' : undefined,
      registryUsdc,
      ours,
      blockTime: snapshot.blockTime ?? 0n,
      runtime,
      runtimeRequired: !txHash,
      token,
      chainId: chain.id,
    }),
  ]

  return {
    receiptAnswers,
    txAnswers,
    blockAnswers,
    receiptBlock: trustedReceipt?.blockNumber ?? null,
    evidence,
    deployer,
    deployBlock,
    deployBlockTime,
    vault,
    snapshot,
    runtime,
    checks,
    verdict: verdict(checks),
    notes: snapshot.state && snapshot.blockTime !== null ? stateNotes(snapshot.state, snapshot.blockTime) : [],
  }
}

// -- the route's half ------------------------------------------------------------------

/**
 * Each refusal as an owner can read it, by check id. The check's own detail stays next to it for
 * whoever wants the numbers. Every id a check can have is here, and a test holds it to that.
 */
export const PLAIN_REFUSALS: Readonly<Record<string, string>> = {
  'env-keys-loaded': 'Our server could not finish its own safety check, the one that makes sure this wallet is not one of ours. This is our problem to fix, not yours.',
  'receipt-found': 'No network host has shown this transaction yet, or the hosts disagree about it. If it was just sent, try again in a minute.',
  'receipt-success': 'This transaction failed on chain, so it created no vault.',
  'contract-created': 'This transaction did not create a contract by itself. A vault counts only when your own wallet sends the deploy directly, not through a smart account or a factory.',
  'creation-tx': 'This transaction could not be read as a contract creation sent by your wallet. If it was just sent, try again in a minute.',
  'create-address': 'The contract address does not match the wallet and the transaction that should have created it.',
  'deploy-block': 'The block holding this transaction could not be confirmed. Try again in a minute.',
  'creation-input': 'The contract this transaction created is not the vault contract this page deploys.',
  'vault-state': 'The vault could not be read just now. Try again in a minute.',
  'runtime-code': 'The code at this address is not the vault contract this page deploys.',
  'owner-sent-deploy': "The vault's owner is not the wallet that sent the deploy. A vault counts only when its owner deployed it from their own wallet.",
  'owner-not-ours': "The vault's owner is a wallet A-Identity itself holds. Only vaults owned by someone else's wallet count.",
  'operator-set': "The vault's agent key is missing, or it is the same wallet as the owner. The limits only mean something when the agent has a key of its own.",
  usdc: 'The vault does not use the USDC of this network.',
  'daily-cap': 'The vault has no daily cap: a cap of 0 means no limit at all.',
  'auto-approve-max': 'The vault has no limit per payment: a limit of 0 means no limit at all.',
  'session-key-expiry': "The agent key has no end date in the future. Set one from the vault's page, then try again.",
}

/** Checks whose detail says which of our env vars holds which address: a public refusal gives their plain words only. */
const DETAIL_KEPT_BACK = new Set(['env-keys-loaded', 'owner-not-ours'])

export type VaultRefusal = { id: string; reason: string; detail?: string }

export function plainRefusals(v: Verdict): VaultRefusal[] {
  return v.refusals.map((c) => ({
    id: c.id,
    reason: PLAIN_REFUSALS[c.id] ?? c.label,
    ...(DETAIL_KEPT_BACK.has(c.id) ? {} : { detail: c.detail }),
  }))
}

/**
 * Whether the same post could be admitted later, with nothing new on chain other than time: a
 * host that has not caught up, a read that failed, or an end date still being set. Anything else
 * is a fact about the vault, and posting again changes nothing.
 */
export function refusalIsRetryable(run: AdmissionRun): boolean {
  const passes = new Set(['receipt-found', 'deploy-block', 'vault-state', 'session-key-expiry'])
  return run.verdict.refusals.every((c) => passes.has(c.id) || (c.id === 'creation-tx' && run.evidence?.tx.value === null) || c.ok === null)
}

export type VaultAdmissionDeps = {
  findByTx: (deployTx: string) => Promise<ArcVaultByTx>
  persist: (rec: ArcAdmittedVaultRecord) => Promise<ArcVaultInsert>
  /** Everything the chain says about this deploy. May throw: then nothing is decided. */
  admit: (deployTx: string) => Promise<AdmissionRun>
  now?: () => number
}

export type VaultAdmissionAnswer =
  | { status: 'admitted'; alreadyAdmitted: boolean; vault: string; owner: string; deployTx: string; deployedAt: string; countedOn: string }
  | { status: 'refused'; vault: string | null; deployTx: string; retryable: boolean; reasons: VaultRefusal[] }
  /** Nothing was decided, or an admitted vault could not be stored: posting again is safe. */
  | { status: 'unavailable'; retryable: true; reason: string }
  | { status: 'invalid'; reason: string }

const ADMITTED_NOTE =
  "Deploy sent by the owner's own wallet (receipt.from is owner()), its creation input is AgentSpendPolicyBytecode plus its constructor args, and its owner is none of our keys. Admitted automatically by POST /api/arc/vaults; the chain cannot say whose wallet this is, so the owner is not identified."

/**
 * POST /api/arc/vaults. A hash already admitted answers from the store with no chain read, so the
 * same post twice is a no-op. A vault is stored only when every check passed, and it is called
 * admitted only when the store took it: a store that failed is an answer of its own, never a claim
 * that the vault counts.
 */
export async function admitVaultDeploy(body: unknown, deps: VaultAdmissionDeps): Promise<{ httpStatus: number; answer: VaultAdmissionAnswer }> {
  const b = (body ?? {}) as { deployTx?: unknown; chain?: unknown }
  if (b.chain !== undefined && b.chain !== ADMISSION_CHAIN) {
    return { httpStatus: 400, answer: { status: 'invalid', reason: `only ${ADMISSION_CHAIN} is counted` } }
  }
  if (typeof b.deployTx !== 'string' || !TX_HASH.test(b.deployTx)) {
    return { httpStatus: 400, answer: { status: 'invalid', reason: 'deployTx must be a 32-byte transaction hash' } }
  }
  const deployTx = b.deployTx.toLowerCase()

  const known = await deps.findByTx(deployTx)
  if (!known.ok) return { httpStatus: 503, answer: { status: 'unavailable', retryable: true, reason: `the list of admitted vaults could not be read: ${known.reason}` } }
  if (known.row) return { httpStatus: 200, answer: admittedAnswer(known.row, true) }

  let run: AdmissionRun
  try {
    run = await deps.admit(deployTx)
  } catch (e) {
    return { httpStatus: 503, answer: { status: 'unavailable', retryable: true, reason: e instanceof Error ? e.message : String(e) } }
  }
  if (!run.verdict.admitted) {
    return { httpStatus: 200, answer: { status: 'refused', vault: run.vault, deployTx, retryable: refusalIsRetryable(run), reasons: plainRefusals(run.verdict) } }
  }
  const state = run.snapshot.state
  if (!run.vault || !state || run.deployBlock === null || run.deployBlockTime === null) {
    return { httpStatus: 503, answer: { status: 'unavailable', retryable: true, reason: 'every check passed but the deploy could not be dated' } }
  }
  const rec: ArcAdmittedVaultRecord = {
    v: 1,
    address: getAddress(run.vault),
    owner: getAddress(state.owner),
    ownerKind: 'unstated',
    deployTx,
    deployBlock: run.deployBlock.toString(),
    deployedAt: utcDayFromSeconds(run.deployBlockTime),
    admittedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    note: ADMITTED_NOTE,
  }
  const stored = await deps.persist(rec)
  if (!stored.ok) {
    return { httpStatus: 503, answer: { status: 'unavailable', retryable: true, reason: `every check passed but the vault could not be recorded: ${stored.reason}` } }
  }
  return { httpStatus: 200, answer: admittedAnswer(rec, !stored.inserted) }
}

function admittedAnswer(rec: ArcAdmittedVaultRecord, alreadyAdmitted: boolean): VaultAdmissionAnswer {
  return { status: 'admitted', alreadyAdmitted, vault: rec.address, owner: rec.owner, deployTx: rec.deployTx, deployedAt: rec.deployedAt, countedOn: ADMISSION_EVIDENCE_URL }
}

/** How long the server gives all of one admission's reads, and each read. Under the proxy's thirty seconds. */
const ROUTE_DEADLINE_MS = 22_000
const ROUTE_READ_TIMEOUT_MS = 6_000

/** The real store and the real chain. The server's own env is what the owner is compared with. */
export function liveVaultAdmissionDeps(env: NodeJS.ProcessEnv = process.env): VaultAdmissionDeps {
  return {
    findByTx: (deployTx) => findAdmittedArcVaultByTx(deployTx),
    persist: (rec) => persistAdmittedArcVault(rec),
    admit: async (deployTx) => {
      const made = admissionContext()
      if (!made.ok) throw new Error(made.reason)
      const hosts = withDeadline(liveRpcHosts(made.context.chain, env, { timeoutMs: ROUTE_READ_TIMEOUT_MS, retryCount: 0 }), ROUTE_DEADLINE_MS)
      return runAdmission({ context: made.context, hosts, tx: deployTx, ours: collectOurAddresses(liveOurAddressSources(env)), requireEnvKeys: true })
    },
  }
}

/** Whether the route can admit anything at all, without naming a key's address. On GET, so a server missing its env is seen before anyone deploys. */
export function admissionReadiness(ours: OurAddresses): { ready: boolean; keysCompared: number; keysUnreadable: string[] } {
  return { ready: envLoadedCheck(ours).ok === true, keysCompared: ours.envKeysDerived.length, keysUnreadable: ours.envKeysUnreadable }
}

/**
 * Stored rows as season vaults. A row that does not read as a vault, or whose owner is by now one
 * of our keys (a key added to the env after it was admitted), is passed to onSkip and not counted.
 * Throws when the store cannot be read: an unreadable list is never an empty one.
 */
export async function admittedVaultsFromStore(ours: OurAddresses, onSkip?: (row: { vault: string | null; reason: string }) => void, io: ArcVaultStoreIo = {}): Promise<ArcOwnerHeldVault[]> {
  const read = await loadAdmittedArcVaults(io)
  if (!read.ok) throw new Error(read.reason)
  return read.rows.flatMap((row): ArcOwnerHeldVault[] => {
    const address = (row as { address?: unknown } | null)?.address
    const named = typeof address === 'string' ? address : null
    if (!row || !ADDRESS.test(String(row.address)) || !ADDRESS.test(String(row.owner)) || !TX_HASH.test(String(row.deployTx))) {
      onSkip?.({ vault: named, reason: 'the row does not name a vault, an owner and a deploy transaction' })
      return []
    }
    if (ours.byAddress.has(row.owner.toLowerCase())) {
      onSkip?.({ vault: named, reason: 'its owner is one of our keys' })
      return []
    }
    return [{ address: row.address, owner: row.owner, ownerKind: 'unstated', deployTx: row.deployTx, deployBlock: row.deployBlock, deployedAt: row.deployedAt, note: row.note }]
  })
}

/** What GET /api/arc/vaults answers: the stored vaults and whether the route can admit. */
export async function listAdmittedVaults(env: NodeJS.ProcessEnv = process.env, io: ArcVaultStoreIo = {}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const made = admissionContext()
  if (!made.ok) return { httpStatus: 503, body: { readable: false, reason: made.reason } }
  const { chain } = made.context
  const ours = collectOurAddresses(liveOurAddressSources(env))
  const skipped: { vault: string | null; reason: string }[] = []
  try {
    const rows = await admittedVaultsFromStore(ours, (r) => skipped.push(r), io)
    return {
      httpStatus: 200,
      body: {
        readable: true,
        chain: chain.id,
        network: chain.caip2,
        count: rows.length,
        items: rows.map((v) => ({ ...v, explorerUrl: addressUrl(chain, v.address), deployExplorerUrl: txUrl(chain, v.deployTx) })),
        ...(skipped.length ? { skipped } : {}),
        admission: admissionReadiness(ours),
        note: 'Vaults that passed every owner-held check, admitted by POST /api/arc/vaults. The chain cannot say whose wallet an owner is, so each owner is not identified. The season report at GET /api/arc/season counts these with the curated list.',
      },
    }
  } catch (e) {
    return { httpStatus: 503, body: { readable: false, reason: e instanceof Error ? e.message : String(e), admission: admissionReadiness(ours) } }
  }
}

