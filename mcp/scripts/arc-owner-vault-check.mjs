#!/usr/bin/env node
/**
 * Admit, or refuse, one AgentSpendPolicy vault to Milestone 1's owner-held list
 * (ARC_OWNER_HELD_VAULTS in src/arc-season.ts). Read-only: nothing is signed, nothing is
 * sent, and an env key is used for nothing but deriving its address.
 *
 * Given the deploy transaction, it reads the receipt from EVERY RPC host the built registry
 * lists for the chain, one host after another, because a null from one host is not an
 * answer: Blockdaemon serves old blocks without their transactions, and on 2026-11-01 the
 * launch-day receipt came back from dRPC alone. The transaction and its block are read the
 * same way, then the vault's code and state at one block on one host. The decision is
 * src/arc-owner-vault.ts, unit-tested, and refuses unless all of these hold:
 *   - the receipt succeeded and created the vault at the CREATE address of a
 *     contract-creation transaction, and no two hosts disagree about any of it;
 *   - the creation input is AgentSpendPolicyBytecode from src/contracts/AgentSpendPolicy.ts
 *     plus its ABI-encoded constructor args (keccak256; the artifact exports no deployed
 *     bytecode), and the runtime code is what that creation code returns in a simulated
 *     eth_call when a host can run one;
 *   - owner() is receipt.from, so the owner's own wallet sent the deploy;
 *   - owner() is none of our keys: the provenance ledger's agent owners (the operating
 *     wallet), both rails' internal payer lists, the oracle validator, and the address of
 *     every EVM key env var that is set (run with --env-file=.env to include those);
 *   - operator() is set and is not the owner; usdc() is the registry USDC;
 *   - dailyCap and autoApproveMax are not 0 (0 means no limit);
 *   - sessionKeyExpiry is not 0 and is later than the chain's current block time.
 * Admitted, it prints the ARC_OWNER_HELD_VAULTS entry ready to paste and explorer links
 * derived from the registry; refused, it prints REFUSED and every reason. The entry says whether
 * the owner is on the team or external, from --owner-kind, because the chain cannot tell: admitting
 * a vault on Arc Mainnet requires it, and it is a statement by whoever runs this, not a check.
 *
 * --chain arc runs every check on Arc Testnet as a rehearsal, labeled as one, and never
 * prints a Milestone 1 entry. --vault alone re-reads a vault's code and state with no
 * receipt; nothing is admitted that way, because who sent the deploy is half the claim.
 *
 * Usage: cd mcp && npm run build
 *        node scripts/arc-owner-vault-check.mjs --tx 0x<deploy hash> --owner-kind team|external [--vault 0x<address>]
 *        node scripts/arc-owner-vault-check.mjs --tx 0x<deploy hash> --chain arc [--vault 0x<address>]
 *        node scripts/arc-owner-vault-check.mjs --vault 0x<address> [--chain arc-mainnet|arc]
 * Exit:  0 admitted, rehearsal passed, or every state check holds; 1 refused; 2 usage or build.
 */
import { createPublicClient, formatUnits, getAddress, http, toHex } from 'viem'

const USAGE = `usage: node scripts/arc-owner-vault-check.mjs --tx <deploy tx hash> --owner-kind team|external [--vault <address>]
       node scripts/arc-owner-vault-check.mjs --tx <deploy tx hash> --chain arc [--vault <address>]
       node scripts/arc-owner-vault-check.mjs --vault <address> [--chain arc-mainnet|arc]

  --tx          the vault's deploy transaction: admit it to ARC_OWNER_HELD_VAULTS, or refuse with reasons
  --owner-kind  team (a person on our team, in their own wallet) or external (anyone else), printed in
                the entry. Required with --tx on arc-mainnet; the chain cannot tell them apart
  --vault       re-read a vault's code and state only (with --tx: the vault the receipt must have created)
  --chain       arc-mainnet (default, Milestone 1) or arc (Arc Testnet rehearsal, never an entry)

Read-only. Add --env-file=.env before the script path to compare the owner against the
addresses of our env keys as well.`

function usage(message) {
  console.error(`error: ${message}\n\n${USAGE}`)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { tx: '', vault: '', chain: '', 'owner-kind': '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    const m = a.match(/^--(tx|vault|chain|owner-kind)(?:=(.*))?$/)
    if (!m) usage(`unknown argument ${a}`)
    const value = m[2] ?? argv[++i]
    if (!value || value.startsWith('--')) usage(`--${m[1]} needs a value`)
    opts[m[1]] = value.trim()
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.tx && !opts.vault) usage('give --tx <deploy hash>, or --vault <address> to re-read state only')
if (opts.tx && !/^0x[0-9a-fA-F]{64}$/.test(opts.tx)) usage(`--tx ${opts.tx} is not a transaction hash`)
if (opts.vault && !/^0x[0-9a-fA-F]{40}$/.test(opts.vault)) usage(`--vault ${opts.vault} is not an address`)

let registry, explorer, artifact, admission
try {
  ;[registry, explorer, artifact, admission] = await Promise.all([
    import('../dist/chains/registry.js'),
    import('../dist/chains/explorer.js'),
    import('../dist/contracts/AgentSpendPolicy.js'),
    import('../dist/arc-owner-vault.js'),
  ])
} catch (e) {
  console.error(`error: mcp/dist is missing or stale (${e?.message ?? e}). Run: cd mcp && npm run build`)
  process.exit(2)
}

const { ADMISSION_CHAIN, REHEARSAL_CHAIN } = admission
const chainId = opts.chain || ADMISSION_CHAIN
if (chainId !== ADMISSION_CHAIN && chainId !== REHEARSAL_CHAIN) {
  usage(`--chain ${chainId}: Milestone 1 counts ${ADMISSION_CHAIN} only, and ${REHEARSAL_CHAIN} is its testnet rehearsal`)
}
const chain = registry.getChainById(chainId)
if (!chain || chain.ecosystem !== 'evm') {
  console.error(`error: the built registry has no EVM chain ${chainId}`)
  process.exit(2)
}
const rehearsal = chainId !== ADMISSION_CHAIN
if (rehearsal !== chain.testnet) {
  console.error(`error: ${chainId} is ${chain.testnet ? '' : 'not '}a testnet in the registry, so it cannot be ${rehearsal ? 'the rehearsal' : 'Milestone 1'}`)
  process.exit(2)
}
const ownerKind = admission.parseOwnerKind(opts['owner-kind'])
if (opts['owner-kind'] && !ownerKind) usage(`--owner-kind ${opts['owner-kind']}: it is team or external`)
if (opts.tx && !rehearsal && !ownerKind) usage('--owner-kind team|external is required to admit a vault: an entry must say whose wallet the owner is')
const usdcToken = (chain.settlementTokens ?? []).find((t) => t.symbol === 'USDC')
const registryUsdc = chain.contracts.usdc ?? usdcToken?.address
if (!registryUsdc || (usdcToken && usdcToken.address.toLowerCase() !== registryUsdc.toLowerCase())) {
  console.error(`error: the registry names no single USDC for ${chainId}, so usdc() has nothing to be compared with`)
  process.exit(2)
}
const token = { symbol: usdcToken?.symbol ?? 'USDC', decimals: usdcToken?.decimals ?? chain.usdcDecimals }
const { AgentSpendPolicyAbi: abi, AgentSpendPolicyBytecode: bytecode } = artifact

const hosts = admission.admissionHosts(chain, process.env).map((h) => ({
  ...h,
  client: createPublicClient({ transport: http(h.url, { timeout: 15_000, retryCount: 1, retryDelay: 500 }) }),
}))
/** One line of an error, with any endpoint URL replaced by its label (an env URL can hold a key). */
const short = (e, h) => {
  let s = String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]
  for (const x of hosts) s = s.split(x.url).join(x.label)
  return (h ? s.split(h.url).join(h.label) : s).slice(0, 200)
}

/** Ask every host, one after another, and keep each answer: null, a value or an error. */
async function everyHost(method, params, normalize = (v) => v) {
  const answers = []
  for (const h of hosts) {
    try {
      const value = await h.client.request({ method, params })
      answers.push({ host: h.label, value: value == null ? null : normalize(value) })
    } catch (e) {
      answers.push({ host: h.label, value: null, error: short(e, h) })
    }
  }
  return answers
}

/** The vault's code and every getter at one block on one host; a host that errors, is
 *  behind the deploy or shows no code hands over to the next. */
async function readVault(address, deployBlock) {
  const problems = []
  for (const h of hosts) {
    try {
      const head = await h.client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })
      if (!head) throw new Error('no latest block')
      const blockNumber = BigInt(head.number)
      const blockTime = BigInt(head.timestamp)
      if (deployBlock !== null && blockNumber < deployBlock) {
        problems.push(`${h.label}: at block ${blockNumber}, behind the deploy block ${deployBlock}`)
        continue
      }
      const code = await h.client.getCode({ address, blockNumber })
      if (!code || code === '0x') {
        problems.push(`${h.label}: no code at ${address} at block ${blockNumber}`)
        continue
      }
      const read = (functionName) => h.client.readContract({ address, abi, functionName, blockNumber })
      const names = ['owner', 'operator', 'usdc', 'dailyCap', 'autoApproveMax', 'sessionKeyExpiry', 'frozen', 'allowlistEnabled']
      const values = await Promise.all(names.map(read))
      const state = Object.fromEntries(names.map((n, i) => [n, values[i]]))
      state.balance = await read('balance').catch(() => null)
      return { host: h, blockNumber, blockTime, code, state, error: null }
    } catch (e) {
      problems.push(`${h.label}: ${short(e, h)}`)
    }
  }
  return { host: null, blockNumber: null, blockTime: null, code: null, state: null, error: problems.join('; ') || 'no host answered' }
}

/** What the artifact's creation code returns for these args: eth_call, so nothing is sent.
 *  The state host first, at the state block; then the others at their latest block. */
async function simulateCreation(initcode, from, preferred, blockNumber) {
  const order = preferred ? [preferred, ...hosts.filter((h) => h !== preferred)] : hosts
  const problems = []
  for (const h of order) {
    try {
      const tag = h === preferred && blockNumber !== null ? toHex(blockNumber) : 'latest'
      const out = await h.client.request({ method: 'eth_call', params: [{ from, data: initcode }, tag] })
      if (typeof out === 'string' && out.length > 2) return { code: out, host: h.label, error: null }
      problems.push(`${h.label}: empty result`)
    } catch (e) {
      problems.push(`${h.label}: ${short(e, h)}`)
    }
  }
  return { code: null, host: null, error: problems.join('; ') }
}

// -- read ------------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n)
const hostWidth = Math.max(...hosts.map((h) => h.label.length)) + 2
const fmtAmount = (u) => `${formatUnits(u, token.decimals)} ${token.symbol} (${u} units)`

console.log('AgentSpendPolicy owner-held vault check (read-only: nothing is signed or sent)\n')
console.log(`chain     ${chain.name} (${chain.id}, ${chain.caip2})${rehearsal ? ', REHEARSAL: nothing below is a Milestone 1 entry' : ', Milestone 1'}`)
if (opts.tx) console.log(`deploy    ${opts.tx.toLowerCase()}`)
if (opts.vault) console.log(`vault     ${getAddress(opts.vault)}${opts.tx ? ' (named with --vault)' : ' (state only, no receipt)'}`)
console.log(
  `artifact  AgentSpendPolicyBytecode, ${(bytecode.length - 2) / 2} bytes of creation code. src/contracts/AgentSpendPolicy.ts exports no deployed bytecode, so the code is compared ${opts.tx ? 'by the deploy\'s creation input (keccak256, method creation-input), and by' : 'by'} the runtime code a simulated creation returns`,
)
console.log(`hosts     ${hosts.map((h) => h.label).join(', ')}`)
if (ownerKind) console.log(`owner is  ${ownerKind} (stated with --owner-kind, not read from the chain)`)

let evidence = null
let deployer = null
let deployBlockTime = null
let vault = null
if (opts.tx) {
  const receiptAnswers = await everyHost('eth_getTransactionReceipt', [opts.tx])
  const receipt = admission.agreeAcrossHosts(receiptAnswers, admission.receiptFingerprint)
  console.log('\nreceipt, from every registry host one by one:')
  for (const a of receiptAnswers) {
    const v = a.value
    console.log(
      `  ${pad(a.host, hostWidth)}${a.error ? `error: ${a.error}` : v ? `status ${v.status}, contract ${v.contractAddress ?? 'none'}, from ${v.from}, block ${BigInt(v.blockNumber)}` : 'null (no receipt on this host)'}`,
    )
  }
  const txAnswers = await everyHost('eth_getTransactionByHash', [opts.tx], (t) => ({ ...t, input: t.input ?? t.data ?? '0x' }))
  const tx = admission.agreeAcrossHosts(txAnswers, admission.transactionFingerprint)
  console.log('transaction, the same way:')
  for (const a of txAnswers) {
    const v = a.value
    console.log(`  ${pad(a.host, hostWidth)}${a.error ? `error: ${a.error}` : v ? `from ${v.from}, to ${v.to ?? '(contract creation)'}, nonce ${BigInt(v.nonce)}, ${(v.input.length - 2) / 2} bytes of input` : 'null'}`)
  }
  const r = receipt.conflict ? null : receipt.value
  let block = null
  if (r) {
    const blockAnswers = await everyHost('eth_getBlockByNumber', [r.blockNumber, false], (b) => ({ number: b.number, hash: b.hash, timestamp: b.timestamp }))
    block = admission.agreeAcrossHosts(blockAnswers, admission.blockFingerprint)
    console.log(`block ${BigInt(r.blockNumber)}, the same way:`)
    for (const a of blockAnswers) {
      const v = a.value
      console.log(`  ${pad(a.host, hostWidth)}${a.error ? `error: ${a.error}` : v ? `${v.hash} at ${admission.isoFromSeconds(BigInt(v.timestamp))}` : 'null'}`)
    }
    if (block.value && !block.conflict) deployBlockTime = BigInt(block.value.timestamp)
  }
  const t = tx.conflict ? null : tx.value
  const creation = t ? admission.matchCreationInput(t.input, bytecode, abi) : null
  evidence = { txHash: opts.tx, receipt, tx, block, creation, expectedVault: opts.vault || null }
  deployer = r?.from ?? null
  if (r?.contractAddress && /^0x[0-9a-fA-F]{40}$/.test(r.contractAddress)) vault = getAddress(r.contractAddress)
  if (creation?.args) {
    const a = creation.args
    console.log(
      `constructor args in the deploy input: owner ${getAddress(a.owner)}, operator ${getAddress(a.operator)}, usdc ${getAddress(a.usdc)}, dailyCap ${a.dailyCap}, autoApproveMax ${a.autoApproveMax}`,
    )
  }
}
if (!vault && opts.vault) vault = getAddress(opts.vault)

const snap = vault
  ? await readVault(vault, evidence?.receipt.value && !evidence.receipt.conflict ? BigInt(evidence.receipt.value.blockNumber) : null)
  : { host: null, blockNumber: null, blockTime: null, code: null, state: null, error: 'no vault address: the receipt named none' }
if (snap.state) {
  const s = snap.state
  console.log(`\nvault ${vault} at block ${snap.blockNumber} (${admission.isoFromSeconds(snap.blockTime)}), read on ${snap.host.label}:`)
  const rows = [
    ['owner', getAddress(s.owner)],
    ['operator', getAddress(s.operator)],
    ['usdc', getAddress(s.usdc)],
    ['dailyCap', fmtAmount(s.dailyCap)],
    ['autoApproveMax', fmtAmount(s.autoApproveMax)],
    ['sessionKeyExpiry', s.sessionKeyExpiry === 0n ? '0 (no expiry)' : `${admission.isoFromSeconds(s.sessionKeyExpiry)} (${s.sessionKeyExpiry})`],
    ['frozen', String(s.frozen)],
    ['allowlistEnabled', String(s.allowlistEnabled)],
    ['balance', s.balance === null ? 'unreadable' : fmtAmount(s.balance)],
  ]
  for (const [k, v] of rows) console.log(`  ${pad(k, 18)}${v}`)
} else if (vault) {
  console.log(`\nvault ${vault}: state not readable (${snap.error})`)
}

let runtime = null
const simArgs =
  evidence?.creation?.args ??
  (snap.state ? { owner: snap.state.owner, operator: snap.state.operator, usdc: snap.state.usdc, dailyCap: snap.state.dailyCap, autoApproveMax: snap.state.autoApproveMax } : null)
if (simArgs && snap.code) {
  let initcode = null
  try {
    initcode = admission.encodeCreationInput(bytecode, abi, simArgs)
  } catch (e) {
    runtime = admission.matchRuntime(snap.code, null, `the constructor args do not encode: ${short(e)}`)
  }
  if (initcode) {
    const sim = await simulateCreation(initcode, deployer ?? simArgs.owner, snap.host, snap.blockNumber)
    runtime = admission.matchRuntime(snap.code, sim.code, sim.error ?? undefined)
  }
}

const ours = admission.collectOurAddresses(admission.liveOurAddressSources(process.env))
console.log(`\nour keys and wallets, compared case-insensitively (${ours.byAddress.size}):`)
for (const [address, sources] of ours.byAddress) console.log(`  ${getAddress(address)}  ${sources.join('; ')}`)
if (ours.envKeysDerived.length) console.log(`  env keys derived: ${ours.envKeysDerived.join(', ')}`)
else console.log('  env keys: none set, so no env-derived address was compared (add --env-file=.env to include them)')
if (ours.envKeysUnreadable.length) console.log(`  env keys set but not a 32-byte hex key, skipped: ${ours.envKeysUnreadable.join(', ')}`)

// -- decide ----------------------------------------------------------------------------

const checks = [
  ...(evidence ? admission.deployChecks(evidence) : []),
  ...admission.stateChecks({
    state: snap.state,
    stateError: snap.error ?? undefined,
    stateBlockedBy: vault ? undefined : evidence ? (evidence.receipt.value && !evidence.receipt.conflict ? 'contract-created' : 'receipt-found') : undefined,
    deployer,
    deployerBlockedBy: opts.tx && deployer === null ? 'receipt-found' : undefined,
    registryUsdc,
    ours,
    blockTime: snap.blockTime ?? 0n,
    runtime,
    runtimeRequired: !opts.tx,
    token,
    chainId: chain.id,
  }),
]
const v = admission.verdict(checks)

console.log('\nchecks:')
for (const c of checks) {
  const mark = c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : c.required ? 'FAIL' : '--  '
  console.log(`  ${mark}  ${c.label}`)
  console.log(`        ${c.detail}`)
}
const notes = snap.state ? admission.stateNotes(snap.state, snap.blockTime) : []
if (notes.length) {
  console.log('\nnotes (none of these refuses):')
  for (const n of notes) console.log(`  - ${n}`)
}

const links = () => {
  console.log(`\nexplorer, derived from the registry${rehearsal ? ' (Arc Testnet)' : ''}:`)
  if (vault) console.log(`  vault:  ${explorer.addressUrl(chain, vault)}`)
  if (opts.tx) console.log(`  deploy: ${explorer.txUrl(chain, opts.tx.toLowerCase())}`)
  if (snap.state) console.log(`  owner:  ${explorer.addressUrl(chain, getAddress(snap.state.owner))}`)
}

const subject = vault ?? opts.tx
if (!v.admitted) {
  const what = opts.tx ? (rehearsal ? 'REHEARSAL REFUSED' : 'REFUSED') : 'STATE CHECK FAILED'
  const tail = opts.tx
    ? rehearsal
      ? `fails the checks a Milestone 1 vault must pass (on ${chain.name}, so it was never a candidate)`
      : 'is not admitted to ARC_OWNER_HELD_VAULTS'
    : 'does not hold the state the owner-held list requires'
  console.log(`\n${what}: ${subject} ${tail}, for ${v.refusals.length} reason(s):`)
  v.refusals.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}: ${c.detail}`))
  if (v.blocked.length) console.log(`  not run because of the above: ${v.blocked.map((c) => c.id).join(', ')}`)
  links()
  process.exit(1)
}

if (!opts.tx) {
  console.log(`\nSTATE ONLY: every state check holds for ${vault}, and nothing is admitted without the deploy receipt. Run with --tx <deploy hash> to admit it.`)
  links()
  process.exit(0)
}

if (rehearsal) {
  console.log(`\nREHEARSAL PASSED: every check holds for ${vault} on ${chain.name}. This is not a Milestone 1 entry and none is printed: Milestone 1 counts ${ADMISSION_CHAIN} only.`)
  links()
  process.exit(0)
}

const ready = admission.pasteReadyEntry({
  vault,
  ownerKind,
  deployTx: opts.tx,
  deployBlockTime,
  state: snap.state,
  checkedBlock: snap.blockNumber,
  checkedBlockTime: snap.blockTime,
  token,
  operatorIsOurs: ours.byAddress.has(snap.state.operator.toLowerCase()),
})
if (!ready.ok) {
  console.log(`\nADMITTED, but the entry would contain ${ready.violations.join(', ')}, which chains/no-hardcoded-chains.test.ts bans from mcp/src. Write the entry by hand from the facts above.`)
  links()
  process.exit(1)
}
console.log(`\nADMITTED: every check holds. Paste this into ARC_OWNER_HELD_VAULTS in mcp/src/arc-season.ts:${ready.trimmed ? ' (its note leaves out the numbers, which the chain-constant guard would have read as a chain id)' : ''}\n`)
console.log(ready.source)
links()
process.exit(0)
