/**
 * Circle CCTP V2 between Stellar and the EVM chains we settle on, driven directly.
 *
 * Bridge Kit (cctp.ts) covers Arc -> Base Sepolia but knows no Stellar adapter, so this
 * module speaks the three CCTP steps itself, in both directions:
 *
 *   burn on the source     EVM: TokenMessengerV2.depositForBurnWithHook (hook = the
 *                          Stellar recipient's StrKey, mintRecipient AND destinationCaller
 *                          = the CctpForwarder). Stellar: approve the USDC SAC, then
 *                          TokenMessengerMinter.deposit_for_burn with the EVM recipient
 *                          left-padded to 32 bytes.
 *   attest through Iris    GET /v2/messages/{sourceDomain}?transactionHash=..., polled
 *                          until status "complete", bounded.
 *   mint on the destination  Stellar: CctpForwarder.mint_and_forward(message,
 *                          attestation), one atomic invocation. EVM:
 *                          MessageTransmitterV2.receiveMessage(message, attestation).
 *
 * Two facts from Circle's Stellar reference that this code exists to get right, because
 * getting either wrong strands funds with no recovery path: a Stellar recipient is never
 * the mintRecipient (the message has no StrKey type marker and assumes a contract), it
 * is carried in the hook data with the forwarder in both address slots; and Stellar USDC
 * has seven decimals while the message has six, so the seventh digit never leaves the
 * source account and the Stellar-side i128 is the six-decimal amount times ten.
 *
 * Every write is prepared-or-executed: without the signer for a side, or without
 * `execute`, the exact call is returned and nothing is broadcast. Mainnet is refused
 * unless CCTP_STELLAR_ALLOW_MAINNET=true, and the amount is capped either way. Addresses
 * and domains come from the chain registry, which cites the Circle page each was read
 * from. Every network call is injectable, so the whole flow is unit-tested dry.
 */
import { Keypair } from '@stellar/stellar-sdk'
import { CHAINS, getChain, getChainById, type ChainDescriptor } from './chains/index.js'
import { evmPublicClient, evmWalletClientFromKey, txUrl } from './chains/evm/client.js'
import { sorobanServer, networkPassphrase } from './chains/stellar/client.js'
import { isAccountId, isContractId, isSecretSeed } from './chains/stellar/strkey.js'

type Hex = `0x${string}`

// ── pure helpers ──────────────────────────────────────────────────────────────────

/** USD -> six-decimal USDC units, the unit of every CCTP message. */
export function usdcUnits6(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 1e6))
}
/** Six-decimal message units -> seven-decimal Stellar subunits (times ten, exactly). */
export function units7From6(units6: bigint): bigint {
  return units6 * 10n
}

/** A 20-byte EVM address as the 32-byte payload CCTP carries (left-padded). */
export function evmAddressToBytes32(address: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`)
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

/** A Stellar C... contract as the 32-byte payload CCTP carries: its raw decoded bytes. */
export async function contractStrkeyToBytes32(strkey: string): Promise<Hex> {
  if (!isContractId(strkey)) throw new Error(`not a Stellar contract id: ${strkey}`)
  const { StrKey } = await import('@stellar/stellar-sdk')
  return `0x${Buffer.from(StrKey.decodeContract(strkey)).toString('hex')}`
}

/**
 * The CctpForwarder hook data, byte for byte as Circle's reference builder writes it
 * (developers.circle.com/cctp/references/stellar, read 2026-09-10): 24 zero magic bytes,
 * uint32 BE version 0, uint32 BE length of the recipient StrKey, then the StrKey as UTF-8.
 * The recipient is validated first because a typo here loses the funds, not the UX.
 */
export function forwarderHookData(forwardRecipient: string): Hex {
  if (!isAccountId(forwardRecipient) && !isContractId(forwardRecipient)) {
    throw new Error(`forward recipient must be a Stellar G... account or C... contract: ${forwardRecipient}`)
  }
  const recipient = Buffer.from(forwardRecipient, 'utf8')
  const hook = Buffer.alloc(32 + recipient.length)
  hook.writeUInt32BE(0, 24)
  hook.writeUInt32BE(recipient.length, 28)
  recipient.copy(hook, 32)
  return `0x${hook.toString('hex')}`
}

export const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`

/** Iris, Circle's attestation service. One host per environment, not per chain. */
export function irisHost(testnet: boolean): string {
  return testnet ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com'
}

/** Lowercase an EVM hash for Iris; leave anything that is not hex (a Stellar hash is hex too) alone. */
export function irisTxHash(hash: string): string {
  return /^(0x)?[0-9a-fA-F]+$/.test(hash) ? hash.toLowerCase() : hash
}

// ── configuration ─────────────────────────────────────────────────────────────────

export type CctpSide = {
  chain: ChainDescriptor
  domain: number
  contracts: NonNullable<ChainDescriptor['contracts']['cctp']>
  /** USDC on this side: the ERC-20 address or the SAC contract id. */
  usdc: string
  usdcDecimals: number
}

/** What a chain needs to take part: a CCTP domain, the cctp contracts, and USDC. */
export function cctpSide(id: string): CctpSide | { error: string } {
  const chain = getChain(id) ?? getChainById(id)
  if (!chain) return { error: `'${id}' is not a chain in the registry` }
  if (chain.cctpDomain === null) return { error: `${chain.id} has no CCTP domain in the registry` }
  if (!chain.contracts.cctp) return { error: `${chain.id} declares no CCTP contracts in the registry` }
  if (chain.ecosystem === 'stellar') {
    const sac = (chain.settlementTokens ?? []).find((t) => t.symbol === 'USDC' && t.authorization === 'soroban-auth')
    if (!sac) return { error: `${chain.id} declares no USDC settlement token, so there is nothing to burn or mint` }
    if (!chain.contracts.cctp.forwarder) return { error: `${chain.id} declares no CctpForwarder; a Stellar recipient cannot be reached without it` }
    return { chain, domain: chain.cctpDomain, contracts: chain.contracts.cctp, usdc: sac.address, usdcDecimals: sac.decimals }
  }
  if (chain.ecosystem !== 'evm') return { error: `${chain.id}: CCTP here is wired for EVM and Stellar only` }
  if (!chain.contracts.usdc) return { error: `${chain.id} declares no canonical USDC` }
  return { chain, domain: chain.cctpDomain, contracts: chain.contracts.cctp, usdc: chain.contracts.usdc, usdcDecimals: chain.usdcDecimals }
}

/** The dedicated Stellar bridging secret's variable, per network. Never the production
 *  operator or fee keys: a bridge test must not be able to spend those. */
export function stellarBridgeSecretVar(chain: ChainDescriptor): string {
  return chain.caip2 === 'stellar:pubnet' ? 'CCTP_STELLAR_PUBNET_SECRET' : 'CCTP_STELLAR_TESTNET_SECRET'
}
/** The EVM side signs with CCTP_EVM_SIGNER_KEY when set, else the chain's own signer. */
export function evmBridgeKeyVar(chain: ChainDescriptor, env: NodeJS.ProcessEnv): string {
  return env.CCTP_EVM_SIGNER_KEY?.trim() ? 'CCTP_EVM_SIGNER_KEY' : (chain.signerEnvVar ?? '(none)')
}

const DEFAULT_MAX_USD = 5
export function maxBridgeUsd(env: NodeJS.ProcessEnv): number {
  const n = Number(env.CCTP_STELLAR_MAX_USD ?? '')
  return Number.isFinite(n) && n > 0 ? Math.min(n, 9.99) : DEFAULT_MAX_USD
}

// ── injectable network surface ────────────────────────────────────────────────────

export type IrisMessage = {
  status: string
  message?: string
  attestation?: string
  eventNonce?: string
  delayReason?: string | null
  [k: string]: unknown
}

export type EvmCalls = {
  allowance: (side: CctpSide, owner: string, spender: string) => Promise<bigint>
  balance: (side: CctpSide, owner: string) => Promise<bigint>
  /** Sends a contract write with the signer key and waits for the receipt. */
  write: (side: CctpSide, key: string, call: { to: string; abi: readonly unknown[]; functionName: string; args: unknown[] }) => Promise<{ txHash: string; status: 'success' | 'reverted'; blockNumber?: string }>
  signerAddress: (key: string) => Promise<string>
}

export type StellarCalls = {
  currentLedger: (side: CctpSide) => Promise<number>
  balance: (side: CctpSide, account: string) => Promise<bigint>
  /** Build, simulate, sign, submit and wait one contract call. */
  invoke: (side: CctpSide, secret: string, call: { contract: string; method: string; args: unknown[] }) => Promise<{ txHash: string; status: 'success' | 'failed' | 'pending'; ledger?: number; reason?: string }>
  publicKey: (secret: string) => string
}

export type IrisCalls = {
  fees: (host: string, sourceDomain: number, destinationDomain: number) => Promise<{ finalityThreshold: number; minimumFee: number }[]>
  message: (host: string, sourceDomain: number, txHash: string) => Promise<IrisMessage | null>
}

export type CctpDeps = {
  env?: NodeJS.ProcessEnv
  evm?: Partial<EvmCalls>
  stellar?: Partial<StellarCalls>
  iris?: Partial<IrisCalls>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to wait for Iris before giving the caller the hash to resume with. */
  irisMaxWaitMs?: number
  irisPollMs?: number
}

const HTTP_TIMEOUT_MS = 15_000

async function fetchJson<T>(url: string, ms = HTTP_TIMEOUT_MS): Promise<{ ok: true; status: number; body: T } | { ok: false; status: number; text: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) return { ok: false, status: r.status, text: (await r.text().catch(() => '')).slice(0, 300) }
    return { ok: true, status: r.status, body: (await r.json()) as T }
  } finally {
    clearTimeout(timer)
  }
}

const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/** TokenMessengerV2 and MessageTransmitterV2, the two functions this module calls, from
 *  Circle's published V2 interface (developers.circle.com/cctp/evm-smart-contracts). */
export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const
export const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: 'function',
    name: 'receiveMessage',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
    outputs: [{ type: 'bool' }],
  },
] as const

function defaultEvm(env: NodeJS.ProcessEnv): EvmCalls {
  return {
    allowance: async (side, owner, spender) => {
      const c = await evmPublicClient(side.chain, env)
      return c.readContract({ address: side.usdc as Hex, abi: ERC20_ABI, functionName: 'allowance', args: [owner as Hex, spender as Hex] })
    },
    balance: async (side, owner) => {
      const c = await evmPublicClient(side.chain, env)
      return c.readContract({ address: side.usdc as Hex, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner as Hex] })
    },
    write: async (side, key, call) => {
      const wallet = await evmWalletClientFromKey(side.chain, key, env)
      if (!wallet) throw new Error('no usable EVM signer key')
      const pub = await evmPublicClient(side.chain, env)
      const hash = await wallet.client.writeContract({ address: call.to as Hex, abi: call.abi as never, functionName: call.functionName as never, args: call.args as never } as never)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      return { txHash: hash, status: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber.toString() }
    },
    signerAddress: async (key) => {
      const { privateKeyToAccount } = await import('viem/accounts')
      return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex).address
    },
  }
}

function defaultStellar(env: NodeJS.ProcessEnv): StellarCalls {
  return {
    currentLedger: async (side) => (await sorobanServer(side.chain, env).getLatestLedger()).sequence,
    balance: async (side, account) => {
      const { Contract, TransactionBuilder, Account, BASE_FEE, Address, rpc, scValToNative } = await import('@stellar/stellar-sdk')
      const server = sorobanServer(side.chain, env)
      const tx = new TransactionBuilder(new Account(account, '0'), { fee: BASE_FEE, networkPassphrase: networkPassphrase(side.chain) })
        .addOperation(new Contract(side.usdc).call('balance', new Address(account).toScVal()))
        .setTimeout(30)
        .build()
      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error(`balance simulation failed`)
      return BigInt(scValToNative(sim.result.retval) as bigint)
    },
    invoke: async (side, secret, call) => {
      const { Keypair, Contract, TransactionBuilder, BASE_FEE, rpc } = await import('@stellar/stellar-sdk')
      const kp = Keypair.fromSecret(secret)
      const server = sorobanServer(side.chain, env)
      const account = await server.getAccount(kp.publicKey())
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: networkPassphrase(side.chain) })
        .addOperation(new Contract(call.contract).call(call.method, ...(call.args as never[])))
        .setTimeout(180)
        .build()
      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim)) return { txHash: '', status: 'failed', reason: `simulation refused: ${sim.error}` }
      if (rpc.Api.isSimulationRestore(sim)) return { txHash: '', status: 'failed', reason: 'needs a state restore first; nothing submitted' }
      const assembled = rpc.assembleTransaction(tx, sim).build()
      assembled.sign(kp)
      const sent = await server.sendTransaction(assembled)
      if (sent.status === 'ERROR') return { txHash: sent.hash, status: 'failed', reason: `rejected before the ledger (${sent.status})` }
      let got = await server.getTransaction(sent.hash)
      for (let i = 0; i < 40 && got.status === 'NOT_FOUND'; i += 1) {
        await new Promise((r) => setTimeout(r, 1000))
        got = await server.getTransaction(sent.hash)
      }
      if (got.status === 'NOT_FOUND') return { txHash: sent.hash, status: 'pending', reason: 'submitted, not in the ledger inside the wait' }
      if (got.status === 'FAILED') return { txHash: sent.hash, status: 'failed', ledger: got.ledger, reason: 'landed and failed' }
      return { txHash: sent.hash, status: 'success', ledger: got.ledger }
    },
    publicKey: (secret) => Keypair.fromSecret(secret).publicKey(),
  }
}

function defaultIris(): IrisCalls {
  return {
    fees: async (host, src, dst) => {
      const r = await fetchJson<{ finalityThreshold: number; minimumFee: number }[]>(`${host}/v2/burn/USDC/fees/${src}/${dst}`)
      if (!r.ok) throw new Error(`Iris fees ${r.status}: ${r.text}`)
      return r.body
    },
    message: async (host, src, txHash) => {
      const r = await fetchJson<{ messages?: IrisMessage[] }>(`${host}/v2/messages/${src}?transactionHash=${encodeURIComponent(irisTxHash(txHash))}`)
      if (!r.ok) {
        if (r.status === 404) return null
        throw new Error(`Iris messages ${r.status}: ${r.text}`)
      }
      return r.body.messages?.[0] ?? null
    },
  }
}

function calls(deps: CctpDeps) {
  const env = deps.env ?? process.env
  return {
    env,
    evm: { ...defaultEvm(env), ...(deps.evm ?? {}) } as EvmCalls,
    stellar: { ...defaultStellar(env), ...(deps.stellar ?? {}) } as StellarCalls,
    iris: { ...defaultIris(), ...(deps.iris ?? {}) } as IrisCalls,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now()),
    irisMaxWaitMs: deps.irisMaxWaitMs ?? 20 * 60 * 1000,
    irisPollMs: deps.irisPollMs ?? 5000,
  }
}

// ── fees ──────────────────────────────────────────────────────────────────────────

/**
 * Circle's fee endpoint reports minimumFee in basis points per finality threshold
 * (Circle's own provider-cctp-v2 scales it as bps). maxFee is that share of the amount,
 * rounded up, plus one tenth headroom when it is non-zero. Zero on every testnet pair we
 * have read; on mainnet the amount leaving must clear it, so it is computed, never
 * guessed.
 */
export function maxFeeFor(amountUnits: bigint, tiers: { finalityThreshold: number; minimumFee: number }[], finality: number): bigint {
  const tier = tiers.find((t) => t.finalityThreshold === finality) ?? tiers[tiers.length - 1]
  const bps = tier ? Number(tier.minimumFee) : 0
  if (!Number.isFinite(bps) || bps <= 0) return 0n
  const scaled = BigInt(Math.ceil(bps * 100))
  const fee = (amountUnits * scaled + 999_999n) / 1_000_000n
  return fee + fee / 10n + 1n
}

// ── the flows ─────────────────────────────────────────────────────────────────────

export type BridgeStep = {
  name: string
  state: 'prepared' | 'confirmed' | 'skipped' | 'failed' | 'pending'
  chain?: string
  contract?: string
  function?: string
  args?: unknown[]
  txHash?: string
  explorerUrl?: string
  reason?: string
  detail?: Record<string, unknown>
}

export type BridgeResult = {
  executed: boolean
  direction: 'evm-to-stellar' | 'stellar-to-evm'
  route: string
  network: { from: string; to: string }
  amountUsd: number
  amountUnits6: string
  recipient: string
  finality: 1000 | 2000
  steps: BridgeStep[]
  /** The Iris payload once attested, so a resumed mint can be run without re-polling. */
  attested?: { message: string; attestation: string; eventNonce?: string }
  reason?: string
}

export type BridgeInput = {
  from: string
  to: string
  amountUsd: number
  /** The receiving address on `to`: a G... account for Stellar, a 0x address for EVM.
   *  Defaults to the destination side's own bridging signer when one is configured. */
  recipient?: string
  finality?: 1000 | 2000
  /** Broadcast. Without it every step is returned prepared, keys or not. */
  execute?: boolean
  /** Resume the mint half from a burn that already happened. */
  resumeBurnTx?: string
}

function guard(input: BridgeInput, from: CctpSide, to: CctpSide, env: NodeJS.ProcessEnv): string | null {
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) return 'amountUsd must be a positive number'
  const cap = maxBridgeUsd(env)
  if (input.amountUsd > cap) return `amountUsd ${input.amountUsd} exceeds the cap of ${cap} (CCTP_STELLAR_MAX_USD)`
  const mainnet = !from.chain.testnet || !to.chain.testnet
  if (input.execute && mainnet && env.CCTP_STELLAR_ALLOW_MAINNET !== 'true') {
    return 'mainnet bridging is refused unless CCTP_STELLAR_ALLOW_MAINNET=true; this moves real USDC'
  }
  if (from.chain.testnet !== to.chain.testnet) return 'a testnet and a mainnet cannot be bridged to each other'
  return null
}

async function pollIris(c: ReturnType<typeof calls>, host: string, sourceDomain: number, burnTx: string): Promise<{ ok: true; msg: IrisMessage } | { ok: false; reason: string; last?: IrisMessage | null }> {
  const started = c.now()
  let last: IrisMessage | null = null
  while (c.now() - started < c.irisMaxWaitMs) {
    try {
      last = await c.iris.message(host, sourceDomain, burnTx)
      if (last && last.status === 'complete' && last.message && last.attestation) return { ok: true, msg: last }
    } catch {
      /* transient; keep polling inside the deadline */
    }
    await c.sleep(c.irisPollMs)
  }
  return { ok: false, reason: `Iris did not report the attestation complete within ${Math.round(c.irisMaxWaitMs / 1000)} s; resume later with resumeBurnTx`, last }
}

/**
 * EVM -> Stellar. The recipient's StrKey rides in the hook data and the forwarder sits
 * in both address slots; on Stellar the mint and the forward are one invocation.
 */
export async function bridgeEvmToStellar(input: BridgeInput, deps: CctpDeps = {}): Promise<BridgeResult | { error: string }> {
  const c = calls(deps)
  const from = cctpSide(input.from)
  const to = cctpSide(input.to)
  if ('error' in from) return from
  if ('error' in to) return to
  if (from.chain.ecosystem !== 'evm' || to.chain.ecosystem !== 'stellar') return { error: 'bridgeEvmToStellar needs an EVM source and a Stellar destination' }
  const bad = guard(input, from, to, c.env)
  if (bad) return { error: bad }
  const finality = input.finality ?? 2000
  const units = usdcUnits6(input.amountUsd)
  const evmKey = (c.env.CCTP_EVM_SIGNER_KEY?.trim() || (from.chain.signerEnvVar ? c.env[from.chain.signerEnvVar]?.trim() : undefined)) || undefined
  const stellarSecret = c.env[stellarBridgeSecretVar(to.chain)]?.trim()
  const stellarSigner = stellarSecret && isSecretSeed(stellarSecret) ? c.stellar.publicKey(stellarSecret) : null
  const recipient = input.recipient ?? stellarSigner ?? ''
  if (!isAccountId(recipient) && !isContractId(recipient)) return { error: 'recipient must be a Stellar G... account (with a USDC trustline) or C... contract; none given and no CCTP Stellar signer to default to' }
  const forwarder = to.contracts.forwarder as string
  const forwarder32 = await contractStrkeyToBytes32(forwarder)
  const hook = forwarderHookData(recipient)
  const host = irisHost(from.chain.testnet)
  const route = `${from.chain.name} -> ${to.chain.name}`
  const base = { direction: 'evm-to-stellar' as const, route, network: { from: from.chain.caip2, to: to.chain.caip2 }, amountUsd: input.amountUsd, amountUnits6: units.toString(), recipient, finality }
  const steps: BridgeStep[] = []
  const execute = Boolean(input.execute)

  let maxFee = 0n
  try {
    maxFee = maxFeeFor(units, await c.iris.fees(host, from.domain, to.domain), finality)
  } catch (e) {
    return { ...base, executed: false, steps, reason: `fee estimate failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (maxFee >= units) return { ...base, executed: false, steps, reason: `the amount (${units} units) does not clear Circle's max fee (${maxFee} units); send more` }

  const approveCall = { to: from.usdc, abi: ERC20_ABI, functionName: 'approve', args: [from.contracts.tokenMessenger, units] }
  const burnCall = {
    to: from.contracts.tokenMessenger,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: 'depositForBurnWithHook',
    args: [units, to.domain, forwarder32, from.usdc, forwarder32, maxFee, finality, hook],
  }
  const show = (call: { to: string; functionName: string; args: unknown[] }) => ({ chain: from.chain.id, contract: call.to, function: call.functionName, args: call.args.map((a) => (typeof a === 'bigint' ? a.toString() : a)) })

  let burnTx = input.resumeBurnTx
  if (!burnTx) {
    if (!execute || !evmKey) {
      const why = !execute ? 'execute was not requested' : `${evmBridgeKeyVar(from.chain, c.env)} is not set`
      steps.push({ name: 'approve USDC to TokenMessengerV2', state: 'prepared', ...show(approveCall), reason: why })
      steps.push({ name: 'depositForBurnWithHook (recipient in hook data, forwarder in both address slots)', state: 'prepared', ...show(burnCall), reason: why, detail: { maxFee: maxFee.toString(), hookRecipient: recipient, forwarder } })
      steps.push({ name: 'Iris attestation', state: 'prepared', reason: `GET ${host}/v2/messages/${from.domain}?transactionHash=<burn tx>` })
      steps.push({ name: 'mint_and_forward on CctpForwarder', state: 'prepared', chain: to.chain.id, contract: forwarder, function: 'mint_and_forward', args: ['<message>', '<attestation>'], reason: why })
      return { ...base, executed: false, steps, reason: why }
    }
    const owner = await c.evm.signerAddress(evmKey)
    const balance = await c.evm.balance(from, owner)
    if (balance < units) return { ...base, executed: false, steps, reason: `${owner} holds ${balance} USDC units on ${from.chain.id}; ${units} needed` }
    const allowance = await c.evm.allowance(from, owner, from.contracts.tokenMessenger)
    if (allowance >= units) {
      steps.push({ name: 'approve USDC to TokenMessengerV2', state: 'skipped', ...show(approveCall), reason: 'existing allowance covers the amount' })
    } else {
      const r = await c.evm.write(from, evmKey, approveCall)
      steps.push({ name: 'approve USDC to TokenMessengerV2', state: r.status === 'success' ? 'confirmed' : 'failed', ...show(approveCall), txHash: r.txHash, explorerUrl: txUrl(from.chain, r.txHash) })
      if (r.status !== 'success') return { ...base, executed: false, steps, reason: 'approve reverted' }
    }
    const burn = await c.evm.write(from, evmKey, burnCall)
    steps.push({ name: 'depositForBurnWithHook', state: burn.status === 'success' ? 'confirmed' : 'failed', ...show(burnCall), txHash: burn.txHash, explorerUrl: txUrl(from.chain, burn.txHash), detail: { maxFee: maxFee.toString(), hookRecipient: recipient, forwarder, blockNumber: burn.blockNumber } })
    if (burn.status !== 'success') return { ...base, executed: false, steps, reason: 'burn reverted; nothing left the source' }
    burnTx = burn.txHash
  } else {
    steps.push({ name: 'depositForBurnWithHook', state: 'confirmed', chain: from.chain.id, txHash: burnTx, explorerUrl: txUrl(from.chain, burnTx), reason: 'resumed from an earlier burn' })
  }

  const attested = await pollIris(c, host, from.domain, burnTx)
  if (!attested.ok) {
    steps.push({ name: 'Iris attestation', state: 'pending', reason: attested.reason, detail: { lastStatus: attested.last?.status ?? null, delayReason: attested.last?.delayReason ?? null, burnTx } })
    return { ...base, executed: true, steps, reason: attested.reason }
  }
  steps.push({ name: 'Iris attestation', state: 'confirmed', detail: { eventNonce: attested.msg.eventNonce ?? null, host } })
  const payload = { message: attested.msg.message as string, attestation: attested.msg.attestation as string, ...(attested.msg.eventNonce ? { eventNonce: attested.msg.eventNonce } : {}) }

  if (!stellarSecret || !isSecretSeed(stellarSecret)) {
    steps.push({ name: 'mint_and_forward on CctpForwarder', state: 'prepared', chain: to.chain.id, contract: forwarder, function: 'mint_and_forward', args: [payload.message, payload.attestation], reason: `${stellarBridgeSecretVar(to.chain)} is not set; anyone may submit this call, it is permissionless` })
    return { ...base, executed: true, steps, attested: payload, reason: 'burned and attested; the Stellar mint is prepared, not submitted' }
  }
  const { nativeToScVal } = await import('@stellar/stellar-sdk')
  const bytes = (hex: string) => nativeToScVal(Buffer.from(hex.replace(/^0x/, ''), 'hex'), { type: 'bytes' })
  const mint = await c.stellar.invoke(to, stellarSecret, { contract: forwarder, method: 'mint_and_forward', args: [bytes(payload.message), bytes(payload.attestation)] })
  steps.push({
    name: 'mint_and_forward on CctpForwarder',
    state: mint.status === 'success' ? 'confirmed' : mint.status,
    chain: to.chain.id,
    contract: forwarder,
    function: 'mint_and_forward',
    ...(mint.txHash ? { txHash: mint.txHash, explorerUrl: txUrl(to.chain, mint.txHash) } : {}),
    ...(mint.reason ? { reason: mint.reason } : {}),
    detail: { ledger: mint.ledger ?? null, recipient },
  })
  return { ...base, executed: true, steps, attested: payload, ...(mint.status !== 'success' ? { reason: `mint ${mint.status}: ${mint.reason ?? ''}` } : {}) }
}

/**
 * Stellar -> EVM. Approve the SAC for the messenger, deposit_for_burn with the EVM
 * recipient left-padded, attest, then receiveMessage on the EVM transmitter, which is
 * permissionless because destinationCaller is zero.
 */
export async function bridgeStellarToEvm(input: BridgeInput, deps: CctpDeps = {}): Promise<BridgeResult | { error: string }> {
  const c = calls(deps)
  const from = cctpSide(input.from)
  const to = cctpSide(input.to)
  if ('error' in from) return from
  if ('error' in to) return to
  if (from.chain.ecosystem !== 'stellar' || to.chain.ecosystem !== 'evm') return { error: 'bridgeStellarToEvm needs a Stellar source and an EVM destination' }
  const bad = guard(input, from, to, c.env)
  if (bad) return { error: bad }
  const finality = input.finality ?? 2000
  const units = usdcUnits6(input.amountUsd)
  const units7 = units7From6(units)
  const stellarSecret = c.env[stellarBridgeSecretVar(from.chain)]?.trim()
  const stellarOk = Boolean(stellarSecret && isSecretSeed(stellarSecret))
  const evmKey = (c.env.CCTP_EVM_SIGNER_KEY?.trim() || (to.chain.signerEnvVar ? c.env[to.chain.signerEnvVar]?.trim() : undefined)) || undefined
  const recipient = input.recipient ?? (evmKey ? await c.evm.signerAddress(evmKey) : '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return { error: 'recipient must be a 0x EVM address; none given and no EVM signer to default to' }
  const host = irisHost(from.chain.testnet)
  const route = `${from.chain.name} -> ${to.chain.name}`
  const base = { direction: 'stellar-to-evm' as const, route, network: { from: from.chain.caip2, to: to.chain.caip2 }, amountUsd: input.amountUsd, amountUnits6: units.toString(), recipient, finality }
  const steps: BridgeStep[] = []
  const execute = Boolean(input.execute)

  let maxFee = 0n
  try {
    maxFee = maxFeeFor(units, await c.iris.fees(host, from.domain, to.domain), finality)
  } catch (e) {
    return { ...base, executed: false, steps, reason: `fee estimate failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (maxFee >= units) return { ...base, executed: false, steps, reason: `the amount (${units} units) does not clear Circle's max fee (${maxFee} units); send more` }
  const maxFee7 = units7From6(maxFee)

  const display = {
    approve: { chain: from.chain.id, contract: from.usdc, function: 'approve', args: ['<signer>', from.contracts.tokenMessenger, units7.toString(), '<ledger + 100>'] },
    burn: { chain: from.chain.id, contract: from.contracts.tokenMessenger, function: 'deposit_for_burn', args: ['<signer>', units7.toString(), to.domain, evmAddressToBytes32(recipient), from.usdc, ZERO_BYTES32, maxFee7.toString(), finality] },
    mint: { chain: to.chain.id, contract: to.contracts.messageTransmitter, function: 'receiveMessage', args: ['<message>', '<attestation>'] },
  }

  let burnTx = input.resumeBurnTx
  if (!burnTx) {
    if (!execute || !stellarOk) {
      const why = !execute ? 'execute was not requested' : `${stellarBridgeSecretVar(from.chain)} is not set`
      steps.push({ name: 'approve USDC SAC for TokenMessengerMinter', state: 'prepared', ...display.approve, reason: why })
      steps.push({ name: 'deposit_for_burn', state: 'prepared', ...display.burn, reason: why, detail: { note: 'seven-decimal subunits; the seventh digit never leaves the account' } })
      steps.push({ name: 'Iris attestation', state: 'prepared', reason: `GET ${host}/v2/messages/${from.domain}?transactionHash=<burn tx>` })
      steps.push({ name: 'receiveMessage on MessageTransmitterV2', state: 'prepared', ...display.mint, reason: why })
      return { ...base, executed: false, steps, reason: why }
    }
    const signer = c.stellar.publicKey(stellarSecret as string)
    const balance = await c.stellar.balance(from, signer)
    if (balance < units7) return { ...base, executed: false, steps, reason: `${signer} holds ${balance} USDC subunits on ${from.chain.id}; ${units7} needed` }
    const { nativeToScVal, Address } = await import('@stellar/stellar-sdk')
    const ledger = await c.stellar.currentLedger(from)
    const expiry = ledger + 100
    const approve = await c.stellar.invoke(from, stellarSecret as string, {
      contract: from.usdc,
      method: 'approve',
      args: [new Address(signer).toScVal(), new Address(from.contracts.tokenMessenger).toScVal(), nativeToScVal(units7, { type: 'i128' }), nativeToScVal(expiry, { type: 'u32' })],
    })
    steps.push({ name: 'approve USDC SAC for TokenMessengerMinter', state: approve.status === 'success' ? 'confirmed' : approve.status, ...display.approve, ...(approve.txHash ? { txHash: approve.txHash, explorerUrl: txUrl(from.chain, approve.txHash) } : {}), ...(approve.reason ? { reason: approve.reason } : {}), detail: { expiryLedger: expiry } })
    if (approve.status !== 'success') return { ...base, executed: false, steps, reason: `approve ${approve.status}` }
    const bytes32 = (hex: string) => nativeToScVal(Buffer.from(hex.replace(/^0x/, ''), 'hex'), { type: 'bytes' })
    const burn = await c.stellar.invoke(from, stellarSecret as string, {
      contract: from.contracts.tokenMessenger,
      method: 'deposit_for_burn',
      args: [
        new Address(signer).toScVal(),
        nativeToScVal(units7, { type: 'i128' }),
        nativeToScVal(to.domain, { type: 'u32' }),
        bytes32(evmAddressToBytes32(recipient)),
        new Address(from.usdc).toScVal(),
        bytes32(ZERO_BYTES32),
        nativeToScVal(maxFee7, { type: 'i128' }),
        nativeToScVal(finality, { type: 'u32' }),
      ],
    })
    steps.push({ name: 'deposit_for_burn', state: burn.status === 'success' ? 'confirmed' : burn.status, ...display.burn, ...(burn.txHash ? { txHash: burn.txHash, explorerUrl: txUrl(from.chain, burn.txHash) } : {}), ...(burn.reason ? { reason: burn.reason } : {}), detail: { ledger: burn.ledger ?? null } })
    if (burn.status !== 'success') return { ...base, executed: false, steps, reason: `burn ${burn.status}; nothing left the source` }
    burnTx = burn.txHash
  } else {
    steps.push({ name: 'deposit_for_burn', state: 'confirmed', chain: from.chain.id, txHash: burnTx, explorerUrl: txUrl(from.chain, burnTx), reason: 'resumed from an earlier burn' })
  }

  const attested = await pollIris(c, host, from.domain, burnTx)
  if (!attested.ok) {
    steps.push({ name: 'Iris attestation', state: 'pending', reason: attested.reason, detail: { lastStatus: attested.last?.status ?? null, delayReason: attested.last?.delayReason ?? null, burnTx } })
    return { ...base, executed: true, steps, reason: attested.reason }
  }
  steps.push({ name: 'Iris attestation', state: 'confirmed', detail: { eventNonce: attested.msg.eventNonce ?? null, host } })
  const payload = { message: attested.msg.message as string, attestation: attested.msg.attestation as string, ...(attested.msg.eventNonce ? { eventNonce: attested.msg.eventNonce } : {}) }

  const mintCall = { to: to.contracts.messageTransmitter, abi: MESSAGE_TRANSMITTER_V2_ABI, functionName: 'receiveMessage', args: [payload.message, payload.attestation] }
  if (!evmKey) {
    steps.push({ name: 'receiveMessage on MessageTransmitterV2', state: 'prepared', ...display.mint, args: [payload.message, payload.attestation], reason: `${evmBridgeKeyVar(to.chain, c.env)} is not set; destinationCaller is zero so anyone may submit this` })
    return { ...base, executed: true, steps, attested: payload, reason: 'burned and attested; the EVM mint is prepared, not submitted' }
  }
  const mint = await c.evm.write(to, evmKey, mintCall)
  steps.push({ name: 'receiveMessage on MessageTransmitterV2', state: mint.status === 'success' ? 'confirmed' : 'failed', ...display.mint, txHash: mint.txHash, explorerUrl: txUrl(to.chain, mint.txHash), detail: { blockNumber: mint.blockNumber ?? null, recipient } })
  return { ...base, executed: true, steps, attested: payload, ...(mint.status !== 'success' ? { reason: 'receiveMessage reverted' } : {}) }
}

/** One entry point for the route and the script. */
export async function bridgeCctp(input: BridgeInput, deps: CctpDeps = {}): Promise<BridgeResult | { error: string }> {
  const from = getChain(input.from) ?? getChainById(input.from)
  if (!from) return { error: `'${input.from}' is not a chain in the registry` }
  return from.ecosystem === 'stellar' ? bridgeStellarToEvm(input, deps) : bridgeEvmToStellar(input, deps)
}

// ── status ────────────────────────────────────────────────────────────────────────

export function cctpStellarStatus(env: NodeJS.ProcessEnv = process.env) {
  const sides = CHAINS.filter((ch) => ch.contracts.cctp && ch.cctpDomain !== null).map((ch) => {
    const side = cctpSide(ch.id)
    const usable = !('error' in side)
    let signer: { configured: boolean; from: string; address?: string } = { configured: false, from: '(none)' }
    if (ch.ecosystem === 'stellar') {
      const v = stellarBridgeSecretVar(ch)
      const s = env[v]?.trim()
      signer = s && isSecretSeed(s) ? { configured: true, from: v, address: defaultStellar(env).publicKey(s) } : { configured: false, from: v }
    } else if (ch.ecosystem === 'evm') {
      const v = evmBridgeKeyVar(ch, env)
      const k = v === 'CCTP_EVM_SIGNER_KEY' ? env.CCTP_EVM_SIGNER_KEY?.trim() : ch.signerEnvVar ? env[ch.signerEnvVar]?.trim() : undefined
      signer = { configured: Boolean(k && /^(0x)?[0-9a-fA-F]{64}$/.test(k)), from: v }
    }
    return {
      chain: ch.id,
      network: ch.caip2,
      testnet: ch.testnet,
      domain: ch.cctpDomain,
      contracts: ch.contracts.cctp,
      usable,
      ...(usable ? {} : { reason: (side as { error: string }).error }),
      signer,
      iris: irisHost(ch.testnet),
    }
  })
  return {
    rail: 'cctp-stellar',
    method:
      'Circle CCTP V2 driven directly: burn on the source, Iris attestation, mint on the destination. A Stellar recipient is carried in the hook data and minted through the CctpForwarder in one atomic call; a direct mint to a G... account is unrecoverable, so this code never builds one.',
    mainnetAllowed: env.CCTP_STELLAR_ALLOW_MAINNET === 'true',
    maxUsd: maxBridgeUsd(env),
    sides,
  }
}
