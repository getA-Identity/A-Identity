/**
 * Milestone 1's owner-held vault admission: the half that decides, with no network in scope.
 *
 * ARC_OWNER_HELD_VAULTS in arc-season.ts counts AgentSpendPolicy vaults on Arc Mainnet whose
 * owner key A-Identity never held, and a vault joins that list only after its deploy receipt
 * has been checked. scripts/arc-owner-vault-check.mjs does the reading, read-only and from
 * every RPC host the registry lists; this module turns what it read into checks, so every
 * rule that can refuse a vault is unit-tested with plain values instead of living only in a
 * script.
 *
 * A vault is admitted only when every one of these holds:
 *   - a registry RPC host returned the deploy receipt, and no two hosts that answered
 *     disagree about it. A null from one host is not an answer: Arc hosts prune history
 *     unevenly, and on 2026-11-01 one of the four returned the launch-day receipt;
 *   - the receipt succeeded and created a contract, at the CREATE address of the sender and
 *     nonce of a contract-creation transaction, in a block every host that returned it
 *     agrees on;
 *   - the creation input is AgentSpendPolicyBytecode plus its ABI-encoded constructor
 *     arguments, compared by keccak256. The generated artifact exports no deployed bytecode,
 *     so the creation input is what can be compared exactly. The runtime code on chain is
 *     also compared with what that creation code returns in a simulated eth_call, whenever a
 *     host can run one;
 *   - owner() is the wallet that sent the deploy, and it is none of ours;
 *   - operator() is set and is not the owner;
 *   - usdc() is the registry's USDC for the chain;
 *   - dailyCap and autoApproveMax are both set, because the contract reads 0 as no limit;
 *   - sessionKeyExpiry is set and later than the chain's current block time.
 *
 * Ours means every address this repo publishes or derives as its own: the agent owners in
 * the provenance ledger (the operating wallet among them), both rails' internal payer
 * lists, the oracle validator that signs our published attestations, the receiving wallets
 * named in env, and the address of every EVM key env var that is set. A key is read only to
 * derive its address, inside collectOurAddresses, and is never returned, printed or kept.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  getCreateAddress,
  keccak256,
  zeroAddress,
  type Abi,
  type AbiParameter,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_SEASON_CHAIN, type ArcOwnerHeldVault, type ArcOwnerKind } from './arc-season.js'
import { ATTESTATIONS } from './asp/attestations.js'
import { PROVENANCE, type ChainProvenance } from './chains/provenance.js'
import { CHAINS } from './chains/registry.js'
import type { ChainDescriptor } from './chains/types.js'
import { internalPayers as gatewayInternalPayers } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers } from './x402-3009/rail.js'

/** The chain Milestone 1 counts. */
export const ADMISSION_CHAIN = ARC_SEASON_CHAIN
/** The testnet a browser deployment may be rehearsed on. A rehearsal runs every check and
 *  is never printed as a Milestone 1 entry. */
export const REHEARSAL_CHAIN = 'arc'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/
const same = (a?: string | null, b?: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const hexBytes = (h: string): number => Math.max(0, (h.length - 2) / 2)

// -- which hosts are read --------------------------------------------------------------

export type AdmissionHost = { url: string; label: string }

/**
 * Every RPC host the registry lists for the chain, in registry order, then the chain's
 * rpcEnvVar endpoint when one is set. The override is added rather than substituted for the
 * primary, unlike resolveRpcUrls, because here more hosts is the point: a receipt one host
 * pruned may still be on another. Labels are host names, never full URLs, since a
 * credentialed endpoint can carry its key in the path.
 */
export function admissionHosts(chain: ChainDescriptor, env: Readonly<Record<string, string | undefined>> = {}): AdmissionHost[] {
  const host = (u: string) => {
    try {
      return new URL(u).host
    } catch {
      return '(unparseable url)'
    }
  }
  const out: AdmissionHost[] = chain.rpcUrls.map((url) => ({ url, label: host(url) }))
  const override = chain.rpcEnvVar ? env[chain.rpcEnvVar]?.trim() : undefined
  if (override && !chain.rpcUrls.includes(override)) out.push({ url: override, label: `${host(override)} (${chain.rpcEnvVar})` })
  return out
}

// -- whose keys are ours ---------------------------------------------------------------

/**
 * EVM key env vars that hold keys of ours, beyond each EVM chain's own signerEnvVar in the
 * registry (ourKeyEnvVars adds those, so a chain is covered the day it lands). Each names
 * where it is read.
 */
export const OUR_KEY_ENV_VARS: readonly { name: string; readBy: string }[] = [
  { name: 'ARC_VALIDATOR_KEY', readBy: 'the oracle validator: scripts/publish-reputation.mjs, chains/evm/adapter.ts' },
  { name: 'X402_3009_SIGNER_KEY', readBy: 'the EIP-3009 facilitator broadcaster: x402-3009/engine.ts' },
  { name: 'X402_3009_FUNDER_KEY', readBy: 'scripts/x402-acquire-token.mjs' },
  { name: 'X402_3009_BUYER_KEY', readBy: 'our x402 buyer: scripts/x402-3009-buyer.mjs' },
  { name: 'X402_GATEWAY_BUYER_KEY', readBy: 'our Gateway buyer: scripts/x402-gateway-buyer.mjs, scripts/gateway-deposit.mjs' },
  { name: 'CELO_BUYER_KEY', readBy: 'scripts/celo-x402-buyer.mjs' },
  { name: 'CCTP_EVM_SIGNER_KEY', readBy: 'the EVM bridging key: cctp-stellar.ts' },
]

/** Env vars that hold an EVM address of ours: the wallets the rails are paid to. */
export const OUR_ADDRESS_ENV_VARS: readonly string[] = ['X402_PAY_TO', 'X402_GATEWAY_PAYTO', 'X402_3009_PAYTO', 'PAY_TO_ADDRESS']

/** Every env var name that may hold an EVM key of ours: each EVM chain's signer, then the rest. */
export function ourKeyEnvVars(chains: readonly ChainDescriptor[] = CHAINS): string[] {
  const signers = chains.filter((c) => c.ecosystem === 'evm' && c.signerEnvVar).map((c) => c.signerEnvVar as string)
  return [...new Set([...signers, ...OUR_KEY_ENV_VARS.map((k) => k.name)])]
}

export type OurAddressSources = {
  provenance: readonly Pick<ChainProvenance, 'chain' | 'agent' | 'accounts'>[]
  gatewayInternalPayers: readonly string[]
  facilitatorInternalPayers: readonly string[]
  attestationValidators: readonly string[]
  keyEnvVars: readonly string[]
  addressEnvVars: readonly string[]
  env: Readonly<Record<string, string | undefined>>
}

export type OurAddresses = {
  /** Lowercased address to every source that names it as ours. */
  byAddress: Map<string, string[]>
  /** Key env vars that were set and whose address was derived. */
  envKeysDerived: string[]
  /** Key env vars that were set but held no 32-byte hex key. Named, never shown. */
  envKeysUnreadable: string[]
}

export function collectOurAddresses(s: OurAddressSources): OurAddresses {
  const byAddress = new Map<string, string[]>()
  const add = (address: string, source: string) => {
    if (!EVM_ADDRESS.test(address)) return
    const key = address.toLowerCase()
    const sources = byAddress.get(key) ?? []
    if (!sources.includes(source)) sources.push(source)
    byAddress.set(key, sources)
  }

  // Agent owners first, grouped, so one wallet that owns our agent on six chains reads as
  // one line. The ledger itself calls the Arc Mainnet agent owner the operating wallet: it
  // minted agent #0 there and owns the launch-day vault.
  const agentChains = new Map<string, string[]>()
  for (const p of s.provenance) {
    if (p.agent && EVM_ADDRESS.test(p.agent.owner)) {
      const key = p.agent.owner.toLowerCase()
      agentChains.set(key, [...(agentChains.get(key) ?? []), p.chain])
    }
    for (const a of p.accounts ?? []) {
      if (a.custody.startsWith('ours:')) add(a.address, `provenance account on ${p.chain}: ${a.role}`)
    }
  }
  for (const [address, chains] of agentChains) {
    const label = `our agent's owner in the provenance ledger on ${chains.join(', ')}`
    add(address, chains.includes(ADMISSION_CHAIN) ? `the operating wallet (${label})` : label)
  }
  for (const a of s.gatewayInternalPayers) add(a, 'x402-gateway internal payer')
  for (const a of s.facilitatorInternalPayers) add(a, 'x402-3009 internal payer')
  for (const a of s.attestationValidators) add(a, 'the oracle validator that signs our attestations (asp/attestations.ts)')
  for (const name of s.addressEnvVars) {
    for (const part of (s.env[name] ?? '').split(',')) add(part.trim(), `env ${name}`)
  }

  const envKeysDerived: string[] = []
  const envKeysUnreadable: string[] = []
  for (const name of s.keyEnvVars) {
    const raw = s.env[name]?.trim()
    if (!raw) continue
    if (!PRIVATE_KEY.test(raw)) {
      envKeysUnreadable.push(name)
      continue
    }
    try {
      add(privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex).address, `the address of env ${name}`)
      envKeysDerived.push(name)
    } catch {
      // A 32-byte value outside the curve order is not a key; say so by name only.
      envKeysUnreadable.push(name)
    }
  }
  return { byAddress, envKeysDerived, envKeysUnreadable }
}

/** The real sources: the built provenance ledger, both rails' lists, the published
 *  attestations and the process env. The script adds nothing else. */
export function liveOurAddressSources(env: NodeJS.ProcessEnv = process.env): OurAddressSources {
  return {
    provenance: PROVENANCE,
    gatewayInternalPayers: gatewayInternalPayers(env),
    facilitatorInternalPayers: facilitatorInternalPayers(env),
    attestationValidators: ATTESTATIONS.map((a) => a.validator),
    keyEnvVars: ourKeyEnvVars(),
    addressEnvVars: OUR_ADDRESS_ENV_VARS,
    env,
  }
}

/**
 * What admission calls ours with no environment at all: the provenance ledger, both rails'
 * hardcoded buyers and the published attestations. It is what the page's generated key list is
 * built from, so a vault the script refuses as ours is labelled as ours there too. No env, so the
 * generated file does not depend on who ran the generator.
 */
export function committedOurKeys(): string[] {
  const live = liveOurAddressSources({})
  return [...collectOurAddresses({ ...live, keyEnvVars: [], addressEnvVars: [] }).byAddress.keys()].sort()
}

/**
 * Whether the run had our environment to compare against. Without it the owner was compared with
 * the committed addresses only, so a vault owned by an env-only key would pass "none of our keys"
 * and print a paste-ready entry. Required to admit; a rehearsal or a state read does not need it.
 * The committed internal payers are always loaded; the env lists add to them and may be unset.
 */
export function envLoadedCheck(ours: OurAddresses): Check {
  const unreadable = ours.envKeysUnreadable.length > 0
  const none = ours.envKeysDerived.length === 0
  return {
    id: 'env-keys-loaded',
    group: 'ownership',
    required: true,
    label: 'our key env vars were loaded, so the owner was compared with every key we hold',
    ok: !none && !unreadable,
    detail: none
      ? 'no EVM key env var is set, so the owner was compared only with the committed addresses. Run with --env-file=.env before the script path.'
      : unreadable
        ? `set but not a 32-byte hex key, so never compared: ${ours.envKeysUnreadable.join(', ')}`
        : `compared with the addresses of ${ours.envKeysDerived.join(', ')}`,
  }
}

// -- the code: creation input and runtime ----------------------------------------------

export type ConstructorArgs = { owner: string; operator: string; usdc: string; dailyCap: bigint; autoApproveMax: bigint }

const ARG_NAMES = ['owner', 'operator', 'usdc', 'dailyCap', 'autoApproveMax'] as const
const STATIC_TYPES = new Set(['address', 'uint256'])

/**
 * The constructor's inputs, checked against the shape the creation-input split relies on:
 * five static words, so the arguments are always the last 160 bytes of a deploy. A changed
 * constructor fails here, loudly, instead of being compared as something it is not.
 */
export function constructorInputs(abi: Abi): readonly AbiParameter[] {
  const ctor = abi.find((e) => e.type === 'constructor')
  if (!ctor || ctor.type !== 'constructor') throw new Error('the AgentSpendPolicy ABI has no constructor')
  const names = ctor.inputs.map((p) => (p.name ?? '').replace(/^_/, ''))
  if (names.join(',') !== ARG_NAMES.join(',') || ctor.inputs.some((p) => !STATIC_TYPES.has(p.type))) {
    throw new Error(
      `the AgentSpendPolicy constructor is (${ctor.inputs.map((p) => `${p.type} ${p.name}`).join(', ')}), not the five static words this check splits a deploy by; update arc-owner-vault.ts`,
    )
  }
  return ctor.inputs
}

/** AgentSpendPolicyBytecode followed by the ABI-encoded constructor arguments: a deploy's input. */
export function encodeCreationInput(bytecode: Hex, abi: Abi, args: ConstructorArgs): Hex {
  const encoded = encodeAbiParameters(constructorInputs(abi), [args.owner, args.operator, args.usdc, args.dailyCap, args.autoApproveMax])
  return `${bytecode.toLowerCase()}${encoded.slice(2)}` as Hex
}

export type CreationMatch = {
  method: 'creation-input'
  /** keccak256(input) equals keccak256(AgentSpendPolicyBytecode ++ abi.encode(args read from the input)). */
  matches: boolean
  inputBytes: number
  artifactBytes: number
  inputHash: Hex
  expectedHash: Hex | null
  /** The last 160 bytes of the input, decoded, whatever came before them; null when they
   *  do not decode. Shown for a mismatch too, so a refusal still says what was deployed. */
  args: ConstructorArgs | null
  reason: string | null
}

export function matchCreationInput(input: Hex, bytecode: Hex, abi: Abi): CreationMatch {
  const params = constructorInputs(abi)
  const argBytes = 32 * params.length
  const body = input.toLowerCase() as Hex
  const code = bytecode.toLowerCase() as Hex
  const base = { method: 'creation-input' as const, inputBytes: hexBytes(body), artifactBytes: hexBytes(code), inputHash: keccak256(body) }
  if (hexBytes(body) < argBytes) {
    return { ...base, matches: false, expectedHash: null, args: null, reason: `the input is ${hexBytes(body)} bytes, shorter than the ${argBytes} bytes of constructor arguments alone` }
  }
  const tail = `0x${body.slice(body.length - argBytes * 2)}` as Hex
  let decoded: readonly unknown[]
  try {
    decoded = decodeAbiParameters(params, tail)
  } catch {
    return { ...base, matches: false, expectedHash: null, args: null, reason: `the last ${argBytes} bytes of the input do not decode as the constructor arguments` }
  }
  const [owner, operator, usdc, dailyCap, autoApproveMax] = decoded as [string, string, string, bigint, bigint]
  const args = { owner, operator, usdc, dailyCap, autoApproveMax }
  const expectedHash = keccak256(encodeCreationInput(code, abi, args))
  if (expectedHash === base.inputHash) return { ...base, matches: true, expectedHash, args, reason: null }
  const prefix = body.slice(0, body.length - argBytes * 2)
  const reason =
    prefix !== code
      ? `the creation code is ${hexBytes(prefix)} bytes and is not AgentSpendPolicyBytecode (${hexBytes(code)} bytes): another build or another contract`
      : 'the creation code is AgentSpendPolicyBytecode, but the constructor arguments are not in canonical ABI encoding'
  return { ...base, matches: false, expectedHash, args, reason }
}

export type RuntimeMatch = {
  method: 'runtime-simulated'
  codeBytes: number
  codeHash: Hex | null
  simulatedBytes: number | null
  simulatedHash: Hex | null
  /** null when the creation could not be simulated on any host. */
  matches: boolean | null
  reason: string | null
}

/**
 * The code at the vault against what AgentSpendPolicyBytecode returns for the same
 * constructor arguments, simulated with eth_call and never sent. Immutables (owner, usdc)
 * are part of runtime code, so the simulation must use the vault's own arguments.
 */
export function matchRuntime(code: string | null | undefined, simulated: string | null | undefined, simulationError?: string): RuntimeMatch {
  const present = (h: string | null | undefined): h is string => typeof h === 'string' && /^0x[0-9a-fA-F]+$/.test(h) && h.length > 2
  const sim = present(simulated) ? { simulatedBytes: hexBytes(simulated), simulatedHash: keccak256(simulated.toLowerCase() as Hex) } : { simulatedBytes: null, simulatedHash: null }
  if (!present(code)) return { method: 'runtime-simulated', codeBytes: 0, codeHash: null, ...sim, matches: false, reason: 'there is no code at the address' }
  const codeHash = keccak256(code.toLowerCase() as Hex)
  const base = { method: 'runtime-simulated' as const, codeBytes: hexBytes(code), codeHash, ...sim }
  if (sim.simulatedHash === null) return { ...base, matches: null, reason: simulationError ?? 'no host could simulate the creation' }
  const matches = sim.simulatedHash === codeHash
  return {
    ...base,
    matches,
    reason: matches ? null : `the code at the address is ${base.codeBytes} bytes and is not what AgentSpendPolicyBytecode returns for these constructor arguments (${sim.simulatedBytes} bytes)`,
  }
}

// -- agreement across hosts ------------------------------------------------------------

export type HostAnswer<T> = { host: string; value: T | null; error?: string }
export type Agreement<T> = { value: T | null; answered: string[]; nulls: string[]; errors: string[]; conflict: string | null }

/**
 * What the hosts said, taken together. A null is not an answer and neither is an error;
 * two answers that differ are a conflict, and a conflict is never resolved by picking one.
 */
export function agreeAcrossHosts<T>(answers: readonly HostAnswer<T>[], fingerprint: (v: T) => string): Agreement<T> {
  const real = answers.filter((a) => a.value !== null && a.error === undefined)
  const prints = new Map<string, string[]>()
  for (const a of real) {
    const k = fingerprint(a.value as T)
    prints.set(k, [...(prints.get(k) ?? []), a.host])
  }
  return {
    value: real[0]?.value ?? null,
    answered: real.map((a) => a.host),
    nulls: answers.filter((a) => a.value === null && a.error === undefined).map((a) => a.host),
    errors: answers.filter((a) => a.error !== undefined).map((a) => `${a.host}: ${a.error}`),
    conflict: prints.size > 1 ? [...prints].map(([k, hosts]) => `${hosts.join(', ')} say ${k}`).join('; ') : null,
  }
}

/** JSON-RPC shapes, as the hosts return them (hex quantities, lowercase or not). */
export type RpcReceipt = { transactionHash: string; status: string; from: string; to: string | null; contractAddress: string | null; blockNumber: string; blockHash: string }
export type RpcTransaction = { hash: string; from: string; to: string | null; nonce: string; input: string; blockHash: string | null }
export type RpcBlock = { number: string; hash: string; timestamp: string }

export const receiptFingerprint = (r: RpcReceipt): string =>
  `tx ${r.transactionHash} status ${r.status} block ${r.blockHash} contract ${r.contractAddress} from ${r.from}`.toLowerCase()
export const transactionFingerprint = (t: RpcTransaction): string =>
  `from ${t.from} to ${t.to} nonce ${t.nonce} input ${keccak256((t.input || '0x').toLowerCase() as Hex)}`.toLowerCase()
export const blockFingerprint = (b: RpcBlock): string => `hash ${b.hash} timestamp ${b.timestamp}`.toLowerCase()

// -- checks ----------------------------------------------------------------------------

/** Why a refusal is listed where it is: ownership is what the list is about, so it leads. */
export type CheckGroup = 'ownership' | 'deploy' | 'code' | 'policy'

export type Check = {
  id: string
  group: CheckGroup
  label: string
  /** null when the check could not be run. */
  ok: boolean | null
  /** A required check that could not be run refuses the vault as surely as one that failed. */
  required: boolean
  /** The check whose failure left this one with nothing to check. */
  blockedBy?: string
  detail: string
}

const MAX_DATE_SECONDS = 8_640_000_000_000n

/** ISO time of a chain timestamp, or the number itself when no calendar date reaches it. */
export function isoFromSeconds(t: bigint): string {
  if (t < 0n || t > MAX_DATE_SECONDS) return `${t} (beyond any calendar date)`
  return new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z')
}

/** The UTC day of a chain timestamp, YYYY-MM-DD. */
export function utcDayFromSeconds(t: bigint): string {
  if (t < 0n || t > MAX_DATE_SECONDS) throw new Error(`timestamp ${t} has no calendar day`)
  return new Date(Number(t) * 1000).toISOString().slice(0, 10)
}

export type DeployEvidence = {
  txHash: string
  receipt: Agreement<RpcReceipt>
  tx: Agreement<RpcTransaction>
  /** Read by the receipt's block number; null when there was no receipt to read it by. */
  block: Agreement<RpcBlock> | null
  creation: CreationMatch | null
  /** A vault named on the command line next to the hash: the receipt must have created it. */
  expectedVault?: string | null
}

function hostSummary(a: Agreement<unknown>, what: string): string {
  const parts = [`${a.answered.length} host(s) returned the ${what} (${a.answered.join(', ') || 'none'})`]
  if (a.nulls.length) parts.push(`${a.nulls.length} returned null (${a.nulls.join(', ')})`)
  if (a.errors.length) parts.push(`${a.errors.length} errored (${a.errors.join('; ')})`)
  return parts.join('; ')
}

export function deployChecks(e: DeployEvidence): Check[] {
  const r = e.receipt.value
  const t = e.tx.value
  const b = e.block?.value ?? null
  const noReceipt = { ok: null, blockedBy: 'receipt-found', detail: 'not run: no trusted receipt to check' } as const
  const out: Check[] = []

  const found = r !== null && e.receipt.conflict === null && same(r.transactionHash, e.txHash)
  out.push({
    id: 'receipt-found',
    group: 'deploy',
    required: true,
    label: 'a registry RPC host returned the deploy receipt, and no two hosts disagree',
    ok: found,
    detail: e.receipt.conflict
      ? `the hosts disagree, so no receipt is trusted: ${e.receipt.conflict}`
      : r && !same(r.transactionHash, e.txHash)
        ? `a host returned the receipt of ${r.transactionHash}, not of ${e.txHash}`
        : r
          ? hostSummary(e.receipt, 'receipt')
          : `${hostSummary(e.receipt, 'receipt')}. If the deploy was just sent, wait for it to be mined and run again.`,
  })
  if (!found) {
    for (const [id, label] of [
      ['receipt-success', 'the receipt status is success'],
      ['contract-created', 'the receipt has a contractAddress'],
      ['creation-tx', 'the transaction is a contract creation sent by receipt.from'],
      ['create-address', 'contractAddress is the CREATE address of the sender and nonce'],
      ['deploy-block', 'the deploy block is the one every host that returned it agrees on'],
    ] as const) {
      out.push({ id, group: 'deploy', required: true, label, ...noReceipt })
    }
  } else {
    out.push({
      id: 'receipt-success',
      group: 'deploy',
      required: true,
      label: 'the receipt status is success',
      ok: r.status === '0x1',
      detail: r.status === '0x1' ? 'status 0x1' : `status ${r.status}: the deploy reverted and created nothing`,
    })
    const created = typeof r.contractAddress === 'string' && EVM_ADDRESS.test(r.contractAddress)
    const named = e.expectedVault ? same(r.contractAddress, e.expectedVault) : true
    out.push({
      id: 'contract-created',
      group: 'deploy',
      required: true,
      label: e.expectedVault ? 'the receipt has a contractAddress, and it is the vault named with --vault' : 'the receipt has a contractAddress',
      ok: created && named,
      detail: !created
        ? 'no contractAddress: this transaction did not create a contract itself (a factory or smart-account deploy creates it inside another call, and is not the owner wallet sending the deploy)'
        : !named
          ? `the receipt created ${getAddress(r.contractAddress as string)}, not ${e.expectedVault}`
          : getAddress(r.contractAddress as string),
    })
    out.push(
      t === null || e.tx.conflict
        ? {
            id: 'creation-tx',
            group: 'deploy',
            required: true,
            label: 'the transaction is a contract creation sent by receipt.from',
            ok: false,
            detail: e.tx.conflict ? `the hosts disagree about the transaction: ${e.tx.conflict}` : `${hostSummary(e.tx, 'transaction')}, so its input cannot be compared`,
          }
        : {
            id: 'creation-tx',
            group: 'deploy',
            required: true,
            label: 'the transaction is a contract creation sent by receipt.from',
            ok: t.to === null && same(t.from, r.from) && (t.blockHash === null || same(t.blockHash, r.blockHash)),
            detail:
              t.to !== null
                ? `the transaction calls ${t.to}; a deploy has no recipient`
                : !same(t.from, r.from)
                  ? `the transaction is from ${t.from} and the receipt from ${r.from}`
                  : t.blockHash !== null && !same(t.blockHash, r.blockHash)
                    ? `the transaction is in block ${t.blockHash} and the receipt in ${r.blockHash}`
                    : `from ${getAddress(t.from)}, nonce ${BigInt(t.nonce)}, ${hexBytes(t.input)} bytes of input; ${hostSummary(e.tx, 'transaction')}`,
          },
    )
    if (t !== null && !e.tx.conflict && created) {
      const expected = getCreateAddress({ from: getAddress(t.from), nonce: BigInt(t.nonce) })
      out.push({
        id: 'create-address',
        group: 'deploy',
        required: true,
        label: 'contractAddress is the CREATE address of the sender and nonce',
        ok: same(expected, r.contractAddress),
        detail: same(expected, r.contractAddress) ? expected : `the sender and nonce create ${expected}; the receipt says ${r.contractAddress}`,
      })
    } else {
      out.push({
        id: 'create-address',
        group: 'deploy',
        required: true,
        label: 'contractAddress is the CREATE address of the sender and nonce',
        ok: null,
        blockedBy: created ? 'creation-tx' : 'contract-created',
        detail: 'not run: needs both the transaction and a contractAddress',
      })
    }
    const blockOk = b !== null && !e.block?.conflict && same(b.hash, r.blockHash)
    out.push({
      id: 'deploy-block',
      group: 'deploy',
      required: true,
      label: 'the deploy block is the one every host that returned it agrees on',
      ok: blockOk,
      detail: e.block?.conflict
        ? `the hosts disagree about block ${BigInt(r.blockNumber)}: ${e.block.conflict}`
        : b === null
          ? `no host returned block ${BigInt(r.blockNumber)}, so the deploy cannot be dated`
          : !same(b.hash, r.blockHash)
            ? `block ${BigInt(r.blockNumber)} is ${b.hash} on the hosts, but the receipt names ${r.blockHash}: the receipt is not from the canonical chain`
            : `block ${BigInt(r.blockNumber)} (${b.hash}) at ${isoFromSeconds(BigInt(b.timestamp))}; ${hostSummary(e.block as Agreement<unknown>, 'block')}`,
    })
  }

  const c = e.creation
  out.push({
    id: 'creation-input',
    group: 'code',
    required: true,
    label: 'the creation input is AgentSpendPolicyBytecode plus its ABI-encoded constructor args (keccak256, method creation-input)',
    ok: c ? c.matches : null,
    ...(c ? {} : { blockedBy: found ? 'creation-tx' : 'receipt-found' }),
    detail: c
      ? c.matches
        ? `keccak256 ${c.inputHash} over ${c.inputBytes} bytes. The artifact exports no deployed bytecode, so the deploy input is compared exactly instead.`
        : `${c.reason}. keccak256 of the input is ${c.inputHash}${c.expectedHash ? `, of the artifact with these args ${c.expectedHash}` : ''}.`
      : 'not run: no transaction input to compare',
  })
  return out
}

export type VaultState = {
  owner: string
  operator: string
  usdc: string
  dailyCap: bigint
  autoApproveMax: bigint
  sessionKeyExpiry: bigint
  frozen: boolean
  allowlistEnabled: boolean
  /** balance() of the vault, or null when it could not be read. Reported, never gating. */
  balance: bigint | null
}

export type StateContext = {
  /** null when the getters could not be read, with the reason. */
  state: VaultState | null
  stateError?: string
  /** Set when there was no vault address to read at all, naming the check that left none. */
  stateBlockedBy?: string
  /** receipt.from, or null when only the state was read (--vault). */
  deployer: string | null
  /** Set when a receipt was asked for and none was trusted: then owner-sent-deploy is a
   *  required check left with nothing to check, not an optional one. */
  deployerBlockedBy?: string
  registryUsdc: string
  ours: OurAddresses
  /** Timestamp of the block the state was read at: the chain's current time. */
  blockTime: bigint
  runtime: RuntimeMatch | null
  /** Whether a runtime check that could not run refuses: yes when it is the only code check. */
  runtimeRequired: boolean
  token: { symbol: string; decimals: number }
  chainId: string
}

export function stateChecks(c: StateContext): Check[] {
  const out: Check[] = []
  const s = c.state
  out.push(
    !s && c.stateBlockedBy
      ? { id: 'vault-state', group: 'code', required: true, label: 'the AgentSpendPolicy getters answer at the vault', ok: null, blockedBy: c.stateBlockedBy, detail: 'not run: no vault address to read' }
      : {
          id: 'vault-state',
          group: 'code',
          required: true,
          label: 'the AgentSpendPolicy getters answer at the vault',
          ok: s !== null,
          detail: s ? 'owner, operator, usdc, dailyCap, autoApproveMax, sessionKeyExpiry and frozen read at one block' : `could not read them: ${c.stateError ?? 'no host answered'}`,
        },
  )
  const blocked = { ok: null, blockedBy: 'vault-state', detail: 'not run: the vault state could not be read' } as const

  const rt = c.runtime
  const runtimeLabel = 'the runtime code is what AgentSpendPolicyBytecode returns for the same constructor args (simulated eth_call, nothing sent)'
  out.push(
    !rt
      ? s
        ? { id: 'runtime-code', group: 'code', required: c.runtimeRequired, label: runtimeLabel, ok: null, detail: 'not run: no constructor arguments to simulate with' }
        : { id: 'runtime-code', group: 'code', required: c.runtimeRequired, label: runtimeLabel, ...blocked }
      : {
          id: 'runtime-code',
          group: 'code',
          required: c.runtimeRequired,
          label: runtimeLabel,
          ok: rt.matches,
          detail:
            rt.matches === true
              ? `keccak256 ${rt.codeHash} over ${rt.codeBytes} bytes, on chain and simulated`
              : rt.matches === null
                ? `not run: ${rt.reason}${c.runtimeRequired ? '' : '. The creation-input comparison is the required code check.'}`
                : `${rt.reason}`,
        },
  )
  const amount = (u: bigint) => `${formatUnits(u, c.token.decimals)} ${c.token.symbol} (${u} units)`

  if (!s) {
    out.push({ id: 'owner-sent-deploy', group: 'ownership', required: c.deployer !== null || !!c.deployerBlockedBy, label: "owner() is receipt.from: the owner's own wallet sent the deploy", ...blocked })
    out.push({ id: 'owner-not-ours', group: 'ownership', required: true, label: 'owner() is none of our keys', ...blocked })
    out.push({ id: 'operator-set', group: 'policy', required: true, label: 'operator() is set and is not the owner', ...blocked })
    out.push({ id: 'usdc', group: 'policy', required: true, label: `usdc() is the registry USDC for ${c.chainId}`, ...blocked })
    out.push({ id: 'daily-cap', group: 'policy', required: true, label: 'dailyCap is set (0 means no daily cap)', ...blocked })
    out.push({ id: 'auto-approve-max', group: 'policy', required: true, label: 'autoApproveMax is set (0 means no per-payment ceiling)', ...blocked })
    out.push({ id: 'session-key-expiry', group: 'policy', required: true, label: 'sessionKeyExpiry is set and later than the current block time', ...blocked })
    return out
  }

  out.push(
    c.deployer === null
      ? c.deployerBlockedBy
        ? {
            id: 'owner-sent-deploy',
            group: 'ownership',
            required: true,
            label: "owner() is receipt.from: the owner's own wallet sent the deploy",
            ok: null,
            blockedBy: c.deployerBlockedBy,
            detail: 'not run: no trusted receipt names who sent the deploy',
          }
        : {
            id: 'owner-sent-deploy',
            group: 'ownership',
            required: false,
            label: "owner() is receipt.from: the owner's own wallet sent the deploy",
            ok: null,
            detail: 'not checked: needs the deploy receipt (--tx)',
          }
      : {
          id: 'owner-sent-deploy',
          group: 'ownership',
          required: true,
          label: "owner() is receipt.from: the owner's own wallet sent the deploy",
          ok: same(s.owner, c.deployer),
          detail: same(s.owner, c.deployer)
            ? getAddress(s.owner)
            : `owner() is ${getAddress(s.owner)} but the deploy was sent by ${getAddress(c.deployer)}, so the owner's own wallet did not deploy it`,
        },
  )
  const ownerOurs = c.ours.byAddress.get(s.owner.toLowerCase())
  out.push({
    id: 'owner-not-ours',
    group: 'ownership',
    required: true,
    label: 'owner() is none of our keys',
    ok: !ownerOurs,
    detail: ownerOurs
      ? `owner ${getAddress(s.owner)} is ours: ${ownerOurs.join('; ')}`
      : `${getAddress(s.owner)} is not among the ${c.ours.byAddress.size} address(es) we hold or publish`,
  })
  const operatorOurs = c.ours.byAddress.get(s.operator.toLowerCase())
  const operatorOk = !same(s.operator, zeroAddress) && !same(s.operator, s.owner)
  out.push({
    id: 'operator-set',
    group: 'policy',
    required: true,
    label: 'operator() is set and is not the owner',
    ok: operatorOk,
    detail: same(s.operator, zeroAddress)
      ? 'operator() is the zero address: there is no agent key, so nothing can pay from the vault'
      : same(s.operator, s.owner)
        ? 'operator() is the owner: one key holds both roles, so the caps bind nobody who holds it'
        : `${getAddress(s.operator)}${operatorOurs ? ` (ours: ${operatorOurs.join('; ')}; the agent that pays is ours, the owner is not)` : ''}`,
  })
  out.push({
    id: 'usdc',
    group: 'policy',
    required: true,
    label: `usdc() is the registry USDC for ${c.chainId}`,
    ok: same(s.usdc, c.registryUsdc),
    detail: same(s.usdc, c.registryUsdc) ? getAddress(s.usdc) : `usdc() is ${s.usdc}; the registry says ${c.registryUsdc}`,
  })
  out.push({
    id: 'daily-cap',
    group: 'policy',
    required: true,
    label: 'dailyCap is set (0 means no daily cap)',
    ok: s.dailyCap !== 0n,
    detail: s.dailyCap === 0n ? 'dailyCap is 0, which the contract reads as no daily cap at all' : amount(s.dailyCap),
  })
  out.push({
    id: 'auto-approve-max',
    group: 'policy',
    required: true,
    label: 'autoApproveMax is set (0 means no per-payment ceiling)',
    ok: s.autoApproveMax !== 0n,
    detail: s.autoApproveMax === 0n ? 'autoApproveMax is 0, which the contract reads as no per-payment ceiling' : amount(s.autoApproveMax),
  })
  const expiry = s.sessionKeyExpiry
  out.push({
    id: 'session-key-expiry',
    group: 'policy',
    required: true,
    label: 'sessionKeyExpiry is set and later than the current block time',
    ok: expiry !== 0n && expiry > c.blockTime,
    detail:
      expiry === 0n
        ? 'sessionKeyExpiry is 0, which the contract reads as a key that never expires'
        : expiry <= c.blockTime
          ? `the key expires ${isoFromSeconds(expiry)}, not later than the current block time ${isoFromSeconds(c.blockTime)}`
          : `valid to ${isoFromSeconds(expiry)}; the current block time is ${isoFromSeconds(c.blockTime)}`,
  })
  return out
}

/**
 * The longest key /app/vault/arc offers, in seconds (MAX_SESSION_SECONDS in src/lib/arc/vault-rules.ts;
 * frontend-arc-vault.test.ts holds the two equal). Admission does not enforce it: a key set from an
 * explorer is the owner's to set. A longer one is noted, in the printed notes and in the entry.
 */
export const PAGE_MAX_SESSION_SECONDS = 30n * 86_400n

/** The key outlives what the page itself would have set, measured from this block's time. */
export function keyOutlivesPage(s: VaultState, blockTime: bigint): boolean {
  return s.sessionKeyExpiry > blockTime + PAGE_MAX_SESSION_SECONDS
}

/** What a reader should know that refuses nothing: the rules above are the whole gate. */
export function stateNotes(s: VaultState, blockTime: bigint): string[] {
  const notes: string[] = []
  if (s.frozen) notes.push('frozen: the operator cannot pay until the owner unfreezes it. Not a refusal: freezing is the owner\'s own control.')
  if (keyOutlivesPage(s, blockTime)) {
    notes.push(`the session key is valid for longer than the vault page allows (to ${isoFromSeconds(s.sessionKeyExpiry)}, and the page stops at thirty days); the rule only asks that it be set and in the future, so this refuses nothing, and the entry says so`)
  }
  return notes
}

export type Verdict = {
  admitted: boolean
  /** Failed checks, and required checks that could not run on their own account, ownership first. */
  refusals: Check[]
  /** Required checks that could not run because an earlier one failed. */
  blocked: Check[]
  /** Optional checks that could not run. Reported, never refusing. */
  notRun: Check[]
}

const GROUP_ORDER: CheckGroup[] = ['ownership', 'deploy', 'code', 'policy']

export function verdict(checks: readonly Check[]): Verdict {
  const refusals = checks
    .filter((c) => c.ok === false || (c.ok === null && c.required && !c.blockedBy))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  const blocked = checks.filter((c) => c.ok === null && c.required && !!c.blockedBy)
  const notRun = checks.filter((c) => c.ok === null && !c.required)
  return { admitted: checks.length > 0 && refusals.length === 0 && blocked.length === 0, refusals, blocked, notRun }
}

// -- the entry -------------------------------------------------------------------------

/** What --owner-kind accepts, or null. Never defaulted: an entry must say whose wallet the owner is. */
export function parseOwnerKind(text: string | null | undefined): ArcOwnerKind | null {
  return text === 'team' || text === 'external' ? text : null
}

export type EntryInput = {
  vault: string
  ownerKind: ArcOwnerKind
  deployTx: string
  deployBlockTime: bigint
  state: VaultState
  checkedBlock: bigint
  checkedBlockTime: bigint
  token: { symbol: string; decimals: number }
  operatorIsOurs: boolean
}

function entryNote(i: EntryInput, detailed: boolean): string {
  const lead = "Deploy sent by the owner's own wallet (receipt.from is owner()), and its creation input is AgentSpendPolicyBytecode plus its constructor args."
  // Said in both forms: a reader of the list should not lose this because the numbers were trimmed.
  const long = keyOutlivesPage(i.state, i.checkedBlockTime) ? 'When checked, its session key was valid for longer than the vault page allows, which stops at thirty days. ' : ''
  const tail = `${long}Checked by scripts/arc-owner-vault-check.mjs.`
  if (!detailed) return `${lead} ${tail}`
  const amount = (u: bigint) => `${formatUnits(u, i.token.decimals)} ${i.token.symbol}`
  const s = i.state
  const operator = `operator ${getAddress(s.operator)}${i.operatorIsOurs ? ' (our agent key: the agent that pays is ours, the owner is not)' : ''}`
  const read = `Read back on ${utcDayFromSeconds(i.checkedBlockTime)} at block ${i.checkedBlock}: ${operator}, dailyCap ${amount(s.dailyCap)}, autoApproveMax ${amount(s.autoApproveMax)}, session key valid to ${isoFromSeconds(s.sessionKeyExpiry)}${s.frozen ? ', frozen by the owner' : ''}.`
  return `${lead} ${read} ${tail}`
}

export function ownerHeldEntry(i: EntryInput, detailed = true): ArcOwnerHeldVault {
  return {
    address: getAddress(i.vault),
    owner: getAddress(i.state.owner),
    ownerKind: i.ownerKind,
    deployTx: i.deployTx.toLowerCase(),
    deployedAt: utcDayFromSeconds(i.deployBlockTime),
    note: entryNote(i, detailed),
  }
}

/** The entry as TypeScript, two-space indented, ready to paste into ARC_OWNER_HELD_VAULTS. */
export function renderEntry(e: ArcOwnerHeldVault): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  return [
    '  {',
    `    address: ${q(e.address)},`,
    `    owner: ${q(e.owner)},`,
    `    ownerKind: ${q(e.ownerKind)},`,
    `    deployTx: ${q(e.deployTx)},`,
    `    deployedAt: ${q(e.deployedAt)},`,
    `    note: ${q(e.note)},`,
    '  },',
  ].join('\n')
}

/**
 * The chain constants chains/no-hardcoded-chains.test.ts bans from mcp/src outside chains/,
 * generated from the registry by the same rules: every numeric chain id as a whole number,
 * every RPC and explorer host, every settlement token and USDC address. That test is the
 * rule; this applies it to an entry before it is printed, because the entry is pasted into
 * arc-season.ts and an entry that fails the build is not ready to paste.
 */
export function chainLiterals(chains: readonly ChainDescriptor[] = CHAINS): { pattern: RegExp; what: string }[] {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const host = (u: string) => {
    try {
      return new URL(u).host
    } catch {
      return ''
    }
  }
  const out: { pattern: RegExp; what: string }[] = []
  for (const c of chains) {
    if (c.evmChainId) out.push({ pattern: new RegExp(`(?<![\\w.])${c.evmChainId}(?![\\w.])`), what: `${c.id}'s numeric chain id` })
    for (const u of c.rpcUrls ?? []) {
      const h = host(u)
      if (h) out.push({ pattern: new RegExp(esc(h)), what: `${c.id}'s RPC host` })
    }
    const eh = c.explorer ? host(c.explorer) : ''
    if (eh) out.push({ pattern: new RegExp(esc(eh)), what: `${c.id}'s explorer host` })
    for (const t of c.settlementTokens ?? []) out.push({ pattern: new RegExp(esc(t.address), 'i'), what: `${c.id}'s settlement token address` })
    if (c.contracts.usdc) out.push({ pattern: new RegExp(esc(c.contracts.usdc), 'i'), what: `${c.id}'s USDC address` })
  }
  return out
}

export function pasteViolations(text: string, chains: readonly ChainDescriptor[] = CHAINS): string[] {
  return [...new Set(chainLiterals(chains).filter(({ pattern }) => pattern.test(text)).map(({ what }) => what))]
}

export type PasteReady =
  | { ok: true; entry: ArcOwnerHeldVault; source: string; trimmed: boolean }
  | { ok: false; violations: string[] }

/**
 * The entry with its full note when that passes the chain-constant guard, else with the
 * note's numbers left out (a cap of 196 USDC reads as X Layer's chain id to that guard), and
 * no entry at all when even that would not pass.
 */
export function pasteReadyEntry(i: EntryInput, chains: readonly ChainDescriptor[] = CHAINS): PasteReady {
  for (const detailed of [true, false]) {
    const entry = ownerHeldEntry(i, detailed)
    const source = renderEntry(entry)
    if (pasteViolations(source, chains).length === 0 && /^[\x20-\x7e\n]*$/.test(source)) return { ok: true, entry, source, trimmed: !detailed }
  }
  const source = renderEntry(ownerHeldEntry(i, false))
  return { ok: false, violations: pasteViolations(source, chains).length ? pasteViolations(source, chains) : ['a character outside printable ASCII'] }
}
