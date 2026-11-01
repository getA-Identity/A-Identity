#!/usr/bin/env node
/**
 * Milestone 1's on-chain refusal on Arc Mainnet: ONE pay() on the launch-day
 * AgentSpendPolicy vault, above its autoApproveMax, sent by the vault's operator key with an
 * explicit gas limit so that it is MINED and REVERTS with AboveAutoApprove. A reviewer gets
 * a transaction hash to open instead of our word that a simulation said no.
 *
 * Why it needs its own script: every earlier refusal on this vault was a simulation. A
 * wallet client estimates gas before it sends, the estimate runs the call, the call
 * reverts, and nothing is broadcast; that is why the launch-day 0.50 USDC refusal has no
 * hash (mcp/src/arc-season.ts says so). With the gas limit passed explicitly the node takes
 * the transaction and the contract refuses it on chain.
 *
 * DRY RUN (the default) signs nothing and sends nothing. It reads the vault at one block
 * (owner, operator, usdc, frozen, allowlist, sessionKeyExpiry against chain time,
 * autoApproveMax, dailyCap, spentToday, balance), checks that the sender is operator(),
 * predicts from that state the first gate pay() fails, simulates the exact call with
 * eth_call at the exact gas limit and decodes the revert, measures the gas the refused path
 * needs, reads a mined pay() from every RPC host as the gas reference, prices the fees and
 * prints the exact transaction --execute would send. It refuses (exit 1) when the
 * simulation does NOT revert with AboveAutoApprove: the transaction would then move money,
 * or fail for some other reason.
 *
 * EXECUTE needs all three: --execute, CONFIRM_ARC_REFUSAL=yes in the environment, and
 * --nonce <n> set to the nonce the dry run printed. It re-runs every check, simulates once
 * more right before signing, signs ONE transaction locally, prints its hash, broadcasts it
 * once, and reads the receipt from every RPC host in the registry one by one (a null from
 * one host is not an answer). It requires status reverted, replays the call on the parent
 * block to decode the reason (a receipt carries none) and prints the ARC_REFUSALS entry.
 *
 * What keeps it to one transaction, and keeps money where it is:
 *   - it signs once and never signs again; there is no retry with a new nonce;
 *   - --nonce pins the run to the nonce the dry run saw, so once that nonce is used (by a
 *     run that landed, or by anything else this key sent) a repeat refuses instead of
 *     sending a second transaction, and a pending transaction from the key refuses too;
 *   - it refuses while ARC_REFUSALS, as built in mcp/dist, already holds an on-chain refusal;
 *   - the payee defaults to the vault owner, our own operating wallet, so even a wrong
 *     revert assumption could only pay ourselves, and the amount is capped at 1 USDC;
 *   - the fixed gas limit times maxFeePerGas bounds the cost, refused above 0.01 USDC.
 *
 * Fees: Arc drops a transaction with maxFeePerGas under 20 gwei without an error receipt
 * (docs.arc.io/arc/references/gas-and-fees), so maxFeePerGas = max(20 gwei, 2 x
 * eth_gasPrice) and the tip is 1 gwei. Gas is paid in USDC at 18 decimals, so
 * gas x maxFeePerGas / 1e18 is the worst case in USDC, with no price feed involved.
 *
 * The operator key is read from X402_3009_BUYER_KEY (the buyer agent, the vault's operator
 * since 2026-09-25) unless --operator-env names another variable, and it is never printed.
 * Without a key the dry run still runs: --operator <address> is checked against operator()
 * instead, or the on-chain operator is simulated as read, and the output says that the key
 * check did not run.
 *
 * Exit codes: 0 dry run passed, or the refusal was mined as expected; 1 refused before
 * anything was sent; 2 sent but no receipt yet (do not run again with a new nonce: check the
 * hash first); 3 mined but not the expected refusal (investigate).
 *
 * Usage:
 *   cd mcp && npm run build
 *   node --env-file=.env scripts/arc-vault-refusal.mjs
 *   CONFIRM_ARC_REFUSAL=yes node --env-file=.env scripts/arc-vault-refusal.mjs --execute --nonce <n>
 * Options: --vault 0x.. --payee 0x.. --amount 0.5 --gas 80000 --operator 0x.. --operator-env NAME
 */
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  formatGwei,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseEventLogs,
  parseGwei,
  parseUnits,
  recoverTransactionAddress,
  toFunctionSelector,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// The launch-day vault, and the mined in-policy pay() used as the gas reference (0.01 USDC
// sent by the operator on 2026-09-25). Both are recorded in mcp/src/chains/provenance.ts.
const DEFAULT_VAULT = '0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146'
const REFERENCE_PAY_TX = '0xc1f3eb7fd7e8a7eccb2d36e309ea8f54c6e188d0687bbf1686a3d5e0165c7ae4'

const EXPECTED = 'AboveAutoApprove'
const DEFAULT_AMOUNT = '0.5' // twice the vault's 0.25 USDC autoApproveMax
const MAX_AMOUNT = '1' // dust bound on what a wrong revert assumption could ever move
const DEFAULT_GAS = 80_000n
const MAX_GAS = 200_000n
const FEE_FLOOR = parseGwei('20')
const TIP = parseGwei('1')
const MAX_COST_USDC = '0.01'
const SESSION_MARGIN_S = 3600n
const RECEIPT_WAIT_MS = 180_000
const CONFIRM_ENV = 'CONFIRM_ARC_REFUSAL'
const DEFAULT_OPERATOR_ENV = 'X402_3009_BUYER_KEY'
const ZERO = '0x0000000000000000000000000000000000000000'

const USAGE = `Usage: cd mcp && npm run build
  node --env-file=.env scripts/arc-vault-refusal.mjs [options]        dry run, sends nothing
  ${CONFIRM_ENV}=yes node --env-file=.env scripts/arc-vault-refusal.mjs --execute --nonce <n> [options]
Options:
  --vault 0x..        AgentSpendPolicy vault (default: the launch-day vault ${DEFAULT_VAULT})
  --payee 0x..        payee of the refused pay() (default: the vault owner, read on chain)
  --amount <usdc>     amount, above autoApproveMax and at most ${MAX_AMOUNT} (default: ${DEFAULT_AMOUNT})
  --gas <n>           explicit gas limit (default: ${DEFAULT_GAS})
  --nonce <n>         required with --execute: the nonce the dry run printed
  --operator 0x..     without a key: the operator address to check and simulate as
  --operator-env NAME env var holding the operator key (default: ${DEFAULT_OPERATOR_ENV})
  --execute           send the one transaction (needs ${CONFIRM_ENV}=yes and --nonce)`

const die = (msg, code = 1) => {
  console.error(`error: ${msg}`)
  process.exit(code)
}

// --- arguments: unknown flags are an error, so a typo cannot pass silently ---
const VALUE_FLAGS = ['vault', 'payee', 'amount', 'gas', 'nonce', 'operator', 'operator-env']
const BOOL_FLAGS = ['execute', 'help']
const opts = {}
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const name = a.startsWith('--') ? a.slice(2) : null
    if (name && BOOL_FLAGS.includes(name)) opts[name] = true
    else if (name && VALUE_FLAGS.includes(name)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) die(`${a} needs a value`)
      opts[name] = v
    } else die(`unknown argument '${a}'\n${USAGE}`)
  }
}
if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}

const EXECUTE = opts.execute === true
const VAULT = opts.vault ?? DEFAULT_VAULT
if (!isAddress(VAULT)) die('--vault must be an address (a mixed-case one must carry a valid checksum)')
if (opts.payee !== undefined && !isAddress(opts.payee)) die('--payee must be an address')
if (opts.operator !== undefined && !isAddress(opts.operator)) die('--operator must be an address')
const AMOUNT_TEXT = opts.amount ?? DEFAULT_AMOUNT
if (!/^\d+(\.\d+)?$/.test(AMOUNT_TEXT)) die('--amount must be a USDC amount such as 0.5')
if (opts.gas !== undefined && !/^\d+$/.test(opts.gas)) die('--gas must be a whole number')
const GAS = opts.gas === undefined ? DEFAULT_GAS : BigInt(opts.gas)
if (GAS <= 21_000n || GAS > MAX_GAS) die(`--gas must be above 21000 and at most ${MAX_GAS}`)
if (opts.nonce !== undefined && !/^\d+$/.test(opts.nonce)) die('--nonce must be a whole number')
const PIN = opts.nonce === undefined ? null : BigInt(opts.nonce)
const OPERATOR_ENV = opts['operator-env'] ?? DEFAULT_OPERATOR_ENV
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(OPERATOR_ENV)) die('--operator-env must name an environment variable')

// --- the operator key: trimmed, validated, never printed ---
let account = null
const rawKey = process.env[OPERATOR_ENV]?.trim()
if (rawKey) {
  const hex = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`).toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(hex)) die(`${OPERATOR_ENV} is set but is not a 32-byte hex private key`)
  account = privateKeyToAccount(hex)
}
if (account && opts.operator && getAddress(opts.operator) !== account.address) {
  die(`--operator ${getAddress(opts.operator)} is not the address of the key in ${OPERATOR_ENV} (${account.address})`)
}
if (EXECUTE) {
  if (!account) die(`--execute needs the operator key in ${OPERATOR_ENV}; nothing was sent`)
  if (process.env[CONFIRM_ENV] !== 'yes') die(`--execute also needs ${CONFIRM_ENV}=yes in the environment; nothing was sent`)
  if (PIN === null) die('--execute needs --nonce <n>, the nonce the dry run printed; nothing was sent')
}

let getChainById, resolveRpcUrls, txUrl, addressUrl, AgentSpendPolicyAbi, ARC_SEASON_CHAIN, ARC_REFUSALS
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
  ;({ txUrl, addressUrl } = await import('../dist/chains/explorer.js'))
  ;({ AgentSpendPolicyAbi } = await import('../dist/contracts/AgentSpendPolicy.js'))
  ;({ ARC_SEASON_CHAIN, ARC_REFUSALS } = await import('../dist/arc-season.js'))
} catch (e) {
  die(`could not load mcp/dist (${e?.message ?? e}). Run: cd mcp && npm run build`)
}
// A build older than the refusal ledger would make the already-recorded check pass on nothing.
if (!ARC_SEASON_CHAIN || !Array.isArray(ARC_REFUSALS)) die('mcp/dist predates ARC_REFUSALS in arc-season.ts. Run: cd mcp && npm run build')

// The chain is the one the Milestone report reads; its id, hosts and token come from the
// built registry, never from this file.
const chain = getChainById(ARC_SEASON_CHAIN)
if (!chain || chain.ecosystem !== 'evm' || chain.testnet || chain.evmChainId == null) {
  die(`the registry has no EVM mainnet named '${ARC_SEASON_CHAIN}'`)
}
const token = chain.settlementTokens?.[0]
if (!token) die(`${chain.id} declares no settlement token`)
const GAS_DECIMALS = chain.nativeCurrency.decimals
if (!AgentSpendPolicyAbi.some((x) => x.type === 'error' && x.name === EXPECTED)) die(`the AgentSpendPolicy ABI has no ${EXPECTED} error`)
const EXPECTED_SELECTOR = toFunctionSelector(`${EXPECTED}()`)
const PAY_SELECTOR = toFunctionSelector('pay(address,uint256)')

// Hosts: the send order the backend uses (ARC_MAINNET_RPC_URL first when set), then every
// registry host, so a receipt is asked of all of them. The override is shown by name only,
// because a credentialed endpoint carries its key in the URL.
const overrideUrl = chain.rpcEnvVar ? process.env[chain.rpcEnvVar] : undefined
const SEND_ORDER = resolveRpcUrls(chain, process.env)
const HOSTS = [...new Set([...SEND_ORDER, ...chain.rpcUrls])]
const hostLabel = (url) => {
  if (overrideUrl && url === overrideUrl) return `${chain.rpcEnvVar} override`
  try {
    return new URL(url).host
  } catch {
    return 'unparseable URL'
  }
}

// --- JSON-RPC: raw, so each host's own answer is visible ---
class TransportError extends Error {}
let rpcId = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One request to one host: { result } or { error } (the node's own JSON-RPC error).
 *  Throws TransportError when the host did not answer at all. */
async function rpc(url, method, params, timeoutMs = 15_000) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new TransportError(`${method} ${e?.name === 'TimeoutError' ? 'timed out' : `failed: ${e?.cause?.code ?? e?.message ?? e}`}`)
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new TransportError(`${method} answered HTTP ${res.status} without JSON`)
  }
  if (body?.error) return { error: body.error }
  if (!res.ok || !body || !('result' in body)) throw new TransportError(`${method} answered HTTP ${res.status}`)
  return { result: body.result }
}

/** Reads may be retried when a host does not answer. A send never goes through here. */
async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof TransportError) || i >= tries) throw e
      await sleep(400 * i)
    }
  }
}

async function read(url, method, params) {
  const r = await withRetry(() => rpc(url, method, params))
  if (r.error) throw new Error(`${method} on ${hostLabel(url)}: ${r.error.message}`)
  return r.result
}

const ethCall = (url, tx, block) =>
  withRetry(() =>
    rpc(url, 'eth_call', [
      { ...(tx.from ? { from: tx.from } : {}), to: tx.to, data: tx.data, ...(tx.gas !== undefined ? { gas: toHex(tx.gas) } : {}) },
      block,
    ]),
  )

const revertData = (error) => {
  const d = error?.data
  if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d
  if (d && typeof d === 'object' && typeof d.data === 'string') return d.data
  return null
}
const decodeRevert = (data) => {
  if (!data || data === '0x') return null
  try {
    return decodeErrorResult({ abi: AgentSpendPolicyAbi, data }).errorName
  } catch {
    return `unknown error ${data.slice(0, 10)}`
  }
}

const iso = (s) => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z')
const gasUsd = (wei) => formatUnits(wei, GAS_DECIMALS)
const gwei = (wei) => `${formatGwei(wei)} gwei`
const pad = (s, n) => String(s).padEnd(n)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const tsString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

async function receiptFrom(url, hash) {
  try {
    const r = await rpc(url, 'eth_getTransactionReceipt', [hash])
    return r.error ? { url, error: r.error.message } : { url, receipt: r.result }
  } catch (e) {
    return { url, error: e.message }
  }
}
/** Every host, one after another. A host that answers null does not have the receipt; that
 *  says nothing about the chain, so the next host is asked anyway. */
async function sweepReceipts(hash, hosts) {
  const out = []
  for (const url of hosts) out.push(await receiptFrom(url, hash))
  return out
}
const describeReceipt = (x) => {
  if (x.error) return `no answer: ${x.error}`
  if (!x.receipt) return 'null (this host does not have it; not an answer)'
  const r = x.receipt
  const status = r.status === '0x1' ? 'success' : r.status === '0x0' ? 'reverted' : `status ${r.status}`
  return `${status}, block ${BigInt(r.blockNumber)}, gasUsed ${BigInt(r.gasUsed)}, ${r.logs.length} log(s)`
}

// --- 1. hosts and the chain id each one answers ---
console.log(`arc-vault-refusal: ${EXECUTE ? 'EXECUTE, one transaction once every check below passes' : 'DRY RUN, nothing is signed or sent'}`)
console.log(`Chain     ${chain.name} (${chain.caip2}), the chain mcp/src/arc-season.ts reports on`)
const verified = new Set()
const wrongChain = new Set()
for (const [i, url] of HOSTS.entries()) {
  let line
  try {
    const id = BigInt(await read(url, 'eth_chainId', []))
    const head = BigInt(await read(url, 'eth_blockNumber', []))
    if (id === BigInt(chain.evmChainId)) verified.add(url)
    else wrongChain.add(url)
    line = `${pad(hostLabel(url), 32)} chain id ${id}${verified.has(url) ? '' : `, NOT ${chain.evmChainId}, not used`}, head ${head}`
  } catch (e) {
    line = `${pad(hostLabel(url), 32)} no answer now (${e.message}); still asked for receipts`
  }
  console.log(`${i === 0 ? 'Hosts     ' : '          '}${line}`)
}
const RECEIPT_HOSTS = HOSTS.filter((u) => !wrongChain.has(u))
const READ = SEND_ORDER.find((u) => verified.has(u))
if (!READ) die(`no RPC host answered with chain id ${chain.evmChainId}; nothing was sent`)

// --- 2. one snapshot block; every state read below is pinned to it ---
const snap = await read(READ, 'eth_getBlockByNumber', ['latest', false])
const SNAP = BigInt(snap.number)
const SNAP_TAG = toHex(SNAP)
const chainTime = BigInt(snap.timestamp)
const baseFee = snap.baseFeePerGas ? BigInt(snap.baseFeePerGas) : null
console.log(`Snapshot  block ${SNAP}, chain time ${iso(chainTime)}, read from ${hostLabel(READ)}`)

const code = await read(READ, 'eth_getCode', [VAULT, SNAP_TAG])
if (!code || code === '0x') die(`no contract at ${VAULT} on ${chain.name}; nothing was sent`)

async function readVault(functionName, args = []) {
  const r = await ethCall(READ, { to: VAULT, data: encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName, args }) }, SNAP_TAG)
  if (r.error) throw new Error(`${functionName}() on ${hostLabel(READ)}: ${r.error.message}`)
  return decodeFunctionResult({ abi: AgentSpendPolicyAbi, functionName, data: r.result })
}
const [owner, operator, usdc, frozen, allowlistEnabled, sessionKeyExpiry, autoApproveMax, dailyCap, spentToday, balance] =
  await Promise.all(
    ['owner', 'operator', 'usdc', 'frozen', 'allowlistEnabled', 'sessionKeyExpiry', 'autoApproveMax', 'dailyCap', 'spentToday', 'balance'].map(
      (fn) => readVault(fn),
    ),
  )

const ERC20_DECIMALS = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }]
const decR = await ethCall(READ, { to: usdc, data: encodeFunctionData({ abi: ERC20_DECIMALS, functionName: 'decimals' }) }, SNAP_TAG)
if (decR.error) die(`decimals() on the vault's token ${usdc}: ${decR.error.message}`)
const DECIMALS = Number(decodeFunctionResult({ abi: ERC20_DECIMALS, functionName: 'decimals', data: decR.result }))
const usd = (units) => formatUnits(units, DECIMALS)
const fraction = AMOUNT_TEXT.split('.')[1] ?? ''
if (fraction.length > DECIMALS) die(`--amount has more than ${DECIMALS} decimals`)
const AMOUNT = parseUnits(AMOUNT_TEXT, DECIMALS)
const MAX_AMOUNT_UNITS = parseUnits(MAX_AMOUNT, DECIMALS)

const PAYEE = opts.payee ? getAddress(opts.payee) : owner
const payeeAllowed = allowlistEnabled ? await readVault('allowed', [PAYEE]) : true

let SENDER
let senderBasis
if (account) {
  SENDER = account.address
  senderBasis = `the key in ${OPERATOR_ENV}`
} else if (opts.operator) {
  SENDER = getAddress(opts.operator)
  senderBasis = `--operator; no key in ${OPERATOR_ENV}, so the key check did not run`
} else {
  SENDER = operator
  senderBasis = `operator() as read; no key in ${OPERATOR_ENV} and no --operator, so the key check did not run`
}

const PAY_DATA = encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'pay', args: [PAYEE, AMOUNT] })

const [senderBalance, nonceLatest, noncePending, gasPrice] = await Promise.all([
  read(READ, 'eth_getBalance', [SENDER, SNAP_TAG]).then(BigInt),
  read(READ, 'eth_getTransactionCount', [SENDER, 'latest']).then(BigInt),
  read(READ, 'eth_getTransactionCount', [SENDER, 'pending']).then(BigInt),
  read(READ, 'eth_gasPrice', []).then(BigInt),
])
const maxFeePerGas = gasPrice * 2n > FEE_FLOOR ? gasPrice * 2n : FEE_FLOOR
const maxPriorityFeePerGas = TIP < maxFeePerGas ? TIP : maxFeePerGas
const maxCost = GAS * maxFeePerGas
const MAX_COST_WEI = parseUnits(MAX_COST_USDC, GAS_DECIMALS)

const sessionLine =
  sessionKeyExpiry === 0n
    ? 'no expiry (0)'
    : `valid until ${iso(sessionKeyExpiry)}, ${(Number(sessionKeyExpiry - chainTime) / 86400).toFixed(1)} days past chain time`
console.log(`\nVault     ${getAddress(VAULT)}${same(VAULT, DEFAULT_VAULT) ? ' (the launch-day vault)' : ''}`)
console.log(`          ${addressUrl(chain, getAddress(VAULT))}`)
console.log(`  owner           ${owner}`)
console.log(`  operator        ${operator}`)
console.log(`  usdc            ${usdc}${same(usdc, token.address) ? `, the registry's ${token.symbol}` : ', NOT the registry token'}, ${DECIMALS} decimals read live`)
console.log(`  frozen          ${frozen}`)
console.log(`  allowlist       ${allowlistEnabled ? `on, payee ${payeeAllowed ? 'allowed' : 'NOT allowed'}` : 'off'}`)
console.log(`  session key     ${sessionLine}`)
console.log(`  autoApproveMax  ${usd(autoApproveMax)} ${token.symbol}`)
console.log(`  dailyCap        ${usd(dailyCap)} ${token.symbol}`)
console.log(`  spentToday      ${usd(spentToday)} ${token.symbol}`)
console.log(`  balance         ${usd(balance)} ${token.symbol}`)
console.log(`\nSender    ${SENDER}, from ${senderBasis}`)
console.log(`Call      pay(${PAYEE}${same(PAYEE, owner) ? ' the vault owner' : ''}, ${AMOUNT}) = ${usd(AMOUNT)} ${token.symbol}`)

// --- 3. what the contract should answer, from the state and from the node ---
function firstFailingGate() {
  // pay()'s own order (contracts/AgentSpendPolicy.sol, unchanged since the c05b1710 build
  // this vault runs): operator, payee, frozen, session key, allowlist, ceiling, daily cap.
  if (!same(SENDER, operator)) return 'NotOperator'
  if (same(PAYEE, ZERO)) return 'ZeroAddress'
  if (same(PAYEE, VAULT) || same(PAYEE, usdc)) return 'InvalidPayee'
  if (frozen) return 'IsFrozen'
  if (sessionKeyExpiry !== 0n && chainTime > sessionKeyExpiry) return 'SessionKeyExpired'
  if (allowlistEnabled && !payeeAllowed) return 'PayeeNotAllowed'
  if (autoApproveMax !== 0n && AMOUNT > autoApproveMax) return 'AboveAutoApprove'
  if (dailyCap !== 0n && spentToday + AMOUNT > dailyCap) return 'DailyCapExceeded'
  return null
}
async function simulate(url, gas, block) {
  const r = await ethCall(url, { from: SENDER, to: VAULT, data: PAY_DATA, gas }, block)
  if (!r.error) return { reverted: false }
  const data = revertData(r.error)
  return { reverted: true, data, errorName: decodeRevert(data), message: String(r.error.message ?? '') }
}
const describeSim = (s) =>
  !s.reverted
    ? 'did NOT revert: the payment would go through'
    : s.errorName
      ? `reverted with ${s.data.slice(0, 10)} = ${s.errorName}()`
      : `reverted without decodable data (${s.message})`

/** The lowest gas limit at which the call still reaches the refusal, by bisection over
 *  eth_call. Below it the node answers out of gas, which carries no revert data. */
async function measureRefusedPath() {
  const reaches = async (g) => {
    const s = await simulate(READ, g, SNAP_TAG)
    if (s.errorName === EXPECTED) return true
    // Out of gas never carries revert data, and every node says so in its own words (reth "out
    // of gas: gas required exceeds", geth "intrinsic gas too low", revm "MemoryOOG"). Anything
    // else, a rate limit say, stops the measurement instead of skewing it.
    if (!s.data && /gas|OOG/i.test(s.message ?? '')) return false
    throw new Error(`eth_call at gas ${g}: ${describeSim(s)}`)
  }
  if (!(await reaches(GAS))) return null
  // A host that ignored the gas field would reach the refusal on intrinsic gas alone, and
  // the bisection would measure nothing.
  if (await reaches(21_000n)) throw new Error('the host ignores the eth_call gas field')
  let lo = 21_000n
  let hi = GAS
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if (await reaches(mid)) hi = mid
    else lo = mid
  }
  return hi
}

const predicted = firstFailingGate()
const sim = await simulate(READ, GAS, SNAP_TAG)
let measured = null
let measureNote = ''
if (sim.errorName === EXPECTED) {
  try {
    measured = await measureRefusedPath()
  } catch (e) {
    measureNote = e.message
  }
}

// The gas reference: a mined pay() on this vault, read host by host.
let reference = null
if (same(VAULT, DEFAULT_VAULT)) {
  const answers = await sweepReceipts(REFERENCE_PAY_TX, RECEIPT_HOSTS)
  const found = answers.find((x) => x.receipt)
  let tx = null
  for (const url of RECEIPT_HOSTS) {
    try {
      const r = await rpc(url, 'eth_getTransactionByHash', [REFERENCE_PAY_TX])
      if (r.result) {
        tx = r.result
        break
      }
    } catch {}
  }
  reference = { answers, receipt: found?.receipt ?? null, tx }
}

// --- 4. the checks; any failure refuses ---
const refusals = []
const check = (ok, line, why = line) => {
  console.log(`  ${ok ? 'ok    ' : 'REFUSE'} ${line}`)
  if (!ok) refusals.push(why)
}
console.log('\nChecks')
check(same(usdc, token.address) && DECIMALS === token.decimals, `the vault holds the registry's ${token.symbol} (${token.decimals} decimals)`)
check(
  same(SENDER, operator),
  same(SENDER, operator) ? 'the sender is operator()' : `the sender ${SENDER} is not operator() ${operator}: pay() would revert NotOperator`,
)
check(
  !same(PAYEE, ZERO) && !same(PAYEE, VAULT) && !same(PAYEE, usdc),
  same(PAYEE, ZERO) || same(PAYEE, VAULT) || same(PAYEE, usdc)
    ? `the payee ${PAYEE} is the zero address, the vault or its token: pay() would revert ZeroAddress or InvalidPayee first`
    : same(PAYEE, owner)
      ? `the payee is the vault owner${same(VAULT, DEFAULT_VAULT) ? ', our operating wallet' : ''}: a wrong revert assumption could only move the vault's money to its own owner`
      : `the payee ${PAYEE} is NOT the vault owner: a wrong revert assumption would pay that address`,
)
check(!frozen, frozen ? 'the vault is frozen: pay() would revert IsFrozen first' : 'the vault is not frozen')
check(
  sessionKeyExpiry === 0n || sessionKeyExpiry > chainTime + SESSION_MARGIN_S,
  sessionKeyExpiry === 0n
    ? 'the session key has no expiry'
    : sessionKeyExpiry > chainTime + SESSION_MARGIN_S
      ? 'the session key is valid for more than an hour'
      : 'the session key is expired or expires within an hour: pay() could revert SessionKeyExpired first; renew it first',
)
check(!allowlistEnabled || payeeAllowed, allowlistEnabled ? (payeeAllowed ? 'the payee is on the allowlist' : 'the payee is NOT on the allowlist: pay() would revert PayeeNotAllowed first') : 'the allowlist is off')
check(
  autoApproveMax !== 0n && AMOUNT > autoApproveMax && AMOUNT <= MAX_AMOUNT_UNITS,
  autoApproveMax === 0n
    ? 'autoApproveMax is 0, so the vault has no ceiling and nothing can be refused by it'
    : AMOUNT <= autoApproveMax
      ? `${usd(AMOUNT)} ${token.symbol} is not above autoApproveMax ${usd(autoApproveMax)}, so the ceiling would not refuse it`
      : AMOUNT > MAX_AMOUNT_UNITS
        ? `${usd(AMOUNT)} ${token.symbol} is over the ${MAX_AMOUNT} ${token.symbol} dust bound`
        : `${usd(AMOUNT)} ${token.symbol} is above autoApproveMax ${usd(autoApproveMax)} and within the ${MAX_AMOUNT} ${token.symbol} dust bound`,
)
check(predicted === EXPECTED, `from this state the first gate pay() fails is ${predicted ?? 'none: the payment would go through'}`)
check(
  sim.errorName === EXPECTED,
  `eth_call at block ${SNAP}, gas ${GAS}, from the sender: ${describeSim(sim)}`,
  sim.reverted ? `the simulation answered ${sim.errorName ?? sim.message}, not ${EXPECTED}` : 'the simulation did NOT revert: sending would move money',
)
if (measured !== null) {
  console.log(`  ok     the refused path needs ${measured} gas: the lowest eth_call gas limit that still returns ${EXPECTED}`)
} else if (sim.errorName === EXPECTED) {
  console.log(`  note   the refused path could not be measured (${measureNote}); the eth_call at ${GAS} still reached ${EXPECTED}`)
}
check(maxCost <= MAX_COST_WEI, `the max gas cost ${gasUsd(maxCost)} ${chain.nativeCurrency.symbol} is ${maxCost <= MAX_COST_WEI ? 'within' : 'OVER'} the ${MAX_COST_USDC} ceiling`)
check(
  senderBalance >= maxCost,
  `the sender holds ${gasUsd(senderBalance)} ${chain.nativeCurrency.symbol} for gas, ${senderBalance >= maxCost ? 'enough for' : 'LESS than'} the max cost`,
)
check(
  noncePending === nonceLatest,
  noncePending === nonceLatest
    ? `nonce ${nonceLatest}, nothing pending from the sender`
    : `the sender has a pending transaction (nonce ${nonceLatest} mined, ${noncePending} pending): wait for it, send nothing on top`,
)
if (PIN !== null) {
  check(
    PIN === nonceLatest,
    PIN === nonceLatest
      ? `--nonce ${PIN} is the sender's next nonce`
      : `--nonce ${PIN} was pinned but the sender's next nonce is ${nonceLatest}: something from this key landed since the dry run, perhaps an earlier run of this script; check ${addressUrl(chain, SENDER)} before anything else`,
  )
}
const recorded = ARC_REFUSALS.filter((r) => r.kind === 'vault-policy-on-chain')
check(
  recorded.length === 0,
  recorded.length === 0
    ? 'ARC_REFUSALS (as built in mcp/dist) holds no on-chain refusal yet'
    : `ARC_REFUSALS already holds an on-chain refusal (${recorded.map((r) => r.txHash).join(', ')}); Milestone 1 needs one`,
)
if (balance < AMOUNT) {
  console.log(`  note   the vault holds ${usd(balance)} ${token.symbol}, less than ${usd(AMOUNT)}: even with the ceiling lifted before mining, the transfer could not move the amount`)
}

// --- 5. gas, fees and the exact transaction ---
const ratio = measured ? ` (${(Number(GAS) / Number(measured)).toFixed(2)}x the ${measured} the refused path needs)` : ''
console.log(`\nGas       limit ${GAS}, fixed${ratio}.`)
if (reference) {
  const r = reference.receipt
  const t = reference.tx
  const isPay = t && same(t.to, VAULT) && String(t.input).slice(0, 10) === PAY_SELECTOR
  if (r && isPay) {
    console.log(
      `          For scale, the mined pay() ${REFERENCE_PAY_TX.slice(0, 10)} on this vault by ${same(t.from, operator) ? 'the current operator' : t.from} used ${BigInt(r.gasUsed)} gas for the full in-policy path, including the spentOnDay write and the USDC transfer that a refused pay() never reaches.`,
    )
  } else {
    console.log(`          The reference pay() ${REFERENCE_PAY_TX.slice(0, 10)} could not be confirmed as a pay() on this vault (${r ? 'not a pay() to the vault' : 'no host returned its receipt'}).`)
  }
  console.log('          Its receipt, host by host (a null from one host is not an answer):')
  for (const x of reference.answers) console.log(`            ${pad(hostLabel(x.url), 32)} ${describeReceipt(x)}`)
}
console.log(`Fees      eth_gasPrice ${gwei(gasPrice)}${baseFee !== null ? `, base fee ${gwei(baseFee)}` : ''}`)
console.log(`          maxFeePerGas ${gwei(maxFeePerGas)} = max(20 gwei floor, 2 x eth_gasPrice); maxPriorityFeePerGas ${gwei(maxPriorityFeePerGas)}`)
const effective = baseFee !== null && baseFee + maxPriorityFeePerGas < maxFeePerGas ? baseFee + maxPriorityFeePerGas : maxFeePerGas
console.log(
  `Cost      at most ${GAS} x ${gwei(maxFeePerGas)} = ${gasUsd(maxCost)} ${chain.nativeCurrency.symbol}` +
    (measured ? `; expected about ${measured} x ${gwei(effective)} = ${gasUsd(measured * effective)} ${chain.nativeCurrency.symbol}` : ''),
)

const prepared = {
  executed: false,
  chainId: chain.evmChainId,
  type: 'eip1559',
  from: SENDER,
  to: getAddress(VAULT),
  nonce: Number(nonceLatest),
  value: '0',
  gas: GAS.toString(),
  maxFeePerGas: maxFeePerGas.toString(),
  maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
  data: PAY_DATA,
  decoded: `pay(${PAYEE}, ${AMOUNT})`,
  expect: `mined, status reverted, ${EXPECTED}() ${EXPECTED_SELECTOR}`,
}
console.log('\nThe transaction --execute would send, signed locally and broadcast once:')
console.log(JSON.stringify(prepared, null, 2))

if (refusals.length) {
  console.log(`\nREFUSED, nothing was signed or sent:\n${refusals.map((r) => `  - ${r}`).join('\n')}`)
  process.exit(1)
}

if (!EXECUTE) {
  const extra = []
  if (opts.vault) extra.push('--vault', getAddress(VAULT))
  if (opts.payee) extra.push('--payee', PAYEE)
  if (opts.amount) extra.push('--amount', AMOUNT_TEXT)
  if (opts.gas) extra.push('--gas', String(GAS))
  if (opts['operator-env']) extra.push('--operator-env', OPERATOR_ENV)
  const command = `cd mcp && ${CONFIRM_ENV}=yes node --env-file=.env scripts/arc-vault-refusal.mjs --execute --nonce ${nonceLatest}${extra.length ? ` ${extra.join(' ')}` : ''}`
  console.log(
    account
      ? '\nREADY, nothing was signed or sent. To send exactly this one transaction:'
      : `\nPREPARED, nothing was signed or sent. The key check did not run: ${OPERATOR_ENV} is not set here. With the key in mcp/.env, send exactly this one transaction with:`,
  )
  console.log(`  ${command}`)
  if (process.env[CONFIRM_ENV] === 'yes') console.log(`  (${CONFIRM_ENV}=yes is set, but without --execute it changes nothing.)`)
  process.exit(0)
}

// --- 6. EXECUTE: one last look, one signature, one broadcast ---
const last = await simulate(READ, GAS, 'latest')
const [nonceNow, pendingNow] = await Promise.all([
  read(READ, 'eth_getTransactionCount', [SENDER, 'latest']).then(BigInt),
  read(READ, 'eth_getTransactionCount', [SENDER, 'pending']).then(BigInt),
])
if (last.errorName !== EXPECTED) die(`the last eth_call before signing ${describeSim(last)}, not ${EXPECTED}; nothing was sent`)
if (nonceNow !== PIN || pendingNow !== PIN) die(`the sender's nonce moved to ${nonceNow} (pending ${pendingNow}) since the checks; nothing was sent`)
console.log(`\nLast look eth_call on the latest block: ${describeSim(last)}; nonce still ${PIN}, nothing pending`)

const serialized = await account.signTransaction({
  type: 'eip1559',
  chainId: chain.evmChainId,
  nonce: Number(PIN),
  to: getAddress(VAULT),
  value: 0n,
  data: PAY_DATA,
  gas: GAS,
  maxFeePerGas,
  maxPriorityFeePerGas,
})
const hash = keccak256(serialized)
const signer = await recoverTransactionAddress({ serializedTransaction: serialized })
if (!same(signer, operator)) die(`the signature recovers to ${signer}, not the operator ${operator}; nothing was sent`)
console.log(`Signed    ${hash} (nonce ${PIN}; the signature recovers to ${signer})`)

let accepted = false
let ambiguous = null
let rejected = null
try {
  const r = await rpc(READ, 'eth_sendRawTransaction', [serialized], 30_000)
  if (r.result) {
    accepted = true
    if (!same(r.result, hash)) console.log(`note      ${hostLabel(READ)} returned ${r.result} for a transaction that hashes to ${hash}; following ${hash}`)
  } else if (/already known|known transaction/i.test(String(r.error?.message))) accepted = true
  else rejected = String(r.error?.message ?? 'unknown error')
} catch (e) {
  ambiguous = e.message
}
console.log(
  `Broadcast once, to ${hostLabel(READ)}: ${accepted ? 'accepted' : rejected ? `refused by the node (${rejected}); asking every host before calling it unsent` : `no answer (${ambiguous}); the transaction may still have reached the node`}`,
)
if (!rejected) {
  console.log(`SENT      ${hash}`)
  console.log(`          ${txUrl(chain, hash)}`)
}

// A refusal from the node usually means nothing entered a mempool, but the hosts are asked
// before saying so.
const deadline = rejected ? 15_000 : RECEIPT_WAIT_MS
const started = Date.now()
let found = null
for (let round = 1; !found && Date.now() - started < deadline; round++) {
  for (const url of RECEIPT_HOSTS) {
    const x = await receiptFrom(url, hash)
    if (x.receipt) {
      found = x
      break
    }
  }
  if (!found) {
    if (round % 15 === 0) console.log(`          no receipt on any of ${RECEIPT_HOSTS.length} hosts after ${Math.round((Date.now() - started) / 1000)} s; still reading`)
    await sleep(1000)
  }
}
if (!found) {
  let known = null
  for (const url of RECEIPT_HOSTS) {
    try {
      const r = await rpc(url, 'eth_getTransactionByHash', [hash])
      if (r.result) {
        known = r.result
        break
      }
    } catch {}
  }
  if (rejected && !known) {
    console.log(`\nNOT SENT: the node refused the transaction (${rejected}) and no host knows its hash. Nothing landed.`)
    process.exit(1)
  }
  const state = !known
    ? 'No host knows the hash.'
    : known.blockNumber
      ? `A host reports it mined in block ${BigInt(known.blockNumber)}, but no host returned its receipt.`
      : 'A host holds the transaction as pending.'
  console.log(`\nNO RECEIPT after ${Math.round((Date.now() - started) / 1000)} s. ${state}`)
  console.log(`Do not run again with a new nonce. Check ${txUrl(chain, hash)} first; a run with --nonce ${PIN} refuses while that nonce is pending or used.`)
  process.exit(2)
}

// --- 7. the receipt, from every host, and what it says ---
if (rejected) console.log(`note      the node refused the broadcast, but ${hostLabel(found.url)} has a receipt for this hash, so it was sent`)
const answers = await sweepReceipts(hash, RECEIPT_HOSTS)
const receipt = found.receipt
console.log(`Receipt   first found on ${hostLabel(found.url)}; every host, one by one (a null is not an answer):`)
for (const x of answers) console.log(`            ${pad(hostLabel(x.url), 32)} ${describeReceipt(x)}`)
const disagree = answers.filter(
  (x) =>
    x.receipt &&
    (BigInt(x.receipt.status) !== BigInt(receipt.status) ||
      !same(x.receipt.blockHash, receipt.blockHash) ||
      BigInt(x.receipt.gasUsed) !== BigInt(receipt.gasUsed)),
)
if (disagree.length) {
  console.error(`error: hosts disagree about ${hash} (${disagree.map((x) => hostLabel(x.url)).join(', ')}). Investigate before recording anything.`)
  process.exit(3)
}
if (!same(receipt.transactionHash, hash) || !same(receipt.from, SENDER) || !same(receipt.to, VAULT)) {
  console.error(`error: the receipt does not describe this transaction (hash ${receipt.transactionHash}, from ${receipt.from}, to ${receipt.to}). Investigate.`)
  process.exit(3)
}

const blockNumber = BigInt(receipt.blockNumber)
const gasUsed = BigInt(receipt.gasUsed)
const effectivePrice = BigInt(receipt.effectiveGasPrice ?? maxFeePerGas)
const cost = gasUsed * effectivePrice
let at = null
for (const url of RECEIPT_HOSTS) {
  try {
    const r = await rpc(url, 'eth_getBlockByNumber', [receipt.blockNumber, false])
    if (r.result?.timestamp) {
      at = iso(BigInt(r.result.timestamp))
      break
    }
  } catch {}
}
const afterR = await ethCall(READ, { to: VAULT, data: encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'balance' }) }, 'latest')
const balanceAfter = afterR.error ? null : decodeFunctionResult({ abi: AgentSpendPolicyAbi, functionName: 'balance', data: afterR.result })

if (BigInt(receipt.status) !== 0n) {
  let paid = []
  try {
    paid = parseEventLogs({ abi: AgentSpendPolicyAbi, eventName: 'Paid', logs: receipt.logs })
  } catch {}
  console.error(
    `\nerror: the transaction was mined with status ${receipt.status} and was NOT refused. ${paid.length ? `The vault emitted Paid for ${paid.map((l) => `${usd(l.args.amount)} to ${l.args.to}`).join(', ')}.` : 'No Paid event was decoded.'} Vault balance ${usd(balance)} before, ${balanceAfter === null ? 'unreadable' : usd(balanceAfter)} after. Investigate; record nothing.`,
  )
  process.exit(3)
}

// A receipt carries no revert data, so the reason is recovered by replaying the same call on
// the state before the transaction's block.
let reason = null
let replayAnomaly = false
let replayNote = 'no host could replay the call'
for (const url of RECEIPT_HOSTS) {
  try {
    const s = await simulate(url, GAS, toHex(blockNumber - 1n))
    if (s.reverted && !s.errorName && !/execution reverted/i.test(s.message)) continue // this host lacks that state
    reason = s.reverted ? s.errorName : null
    replayAnomaly = !s.reverted
    replayNote = s.reverted
      ? s.errorName
        ? `${s.data.slice(0, 10)} = ${s.errorName}(), replayed by eth_call on block ${blockNumber - 1n} at ${hostLabel(url)} (a receipt carries no revert data)`
        : `the replay on block ${blockNumber - 1n} reverted without data`
      : `the replay on block ${blockNumber - 1n} did NOT revert, so the state the transaction ran on differed from that block`
    break
  } catch {}
}

console.log(`Outcome   mined in block ${blockNumber}${at ? ` at ${at}` : ''}, status reverted, ${receipt.logs.length} log(s)`)
console.log(`Reason    ${replayNote}`)
console.log(
  `Gas       ${gasUsed} used${measured ? ` (${measured} measured before sending)` : ''} x ${gwei(effectivePrice)} = ${gasUsd(cost)} ${chain.nativeCurrency.symbol}`,
)
console.log(`Vault     balance ${usd(balance)} ${token.symbol} before, ${balanceAfter === null ? 'unreadable' : `${usd(balanceAfter)} ${token.symbol}`} after`)

const why = reason
  ? `reverted with ${reason}`
  : `reverted; the reason could not be replayed from the RPC, and the eth_call right before sending returned ${EXPECTED}`
const gasMatch = measured !== null && gasUsed === measured ? ', the same gas the refused path measured by eth_call before sending' : ''
const sym = token.symbol
const note =
  `A pay() of ${usd(AMOUNT)} ${sym} ${same(PAYEE, owner) ? `to the vault owner ${PAYEE}` : `to ${PAYEE}`}, above the ${usd(autoApproveMax)} ${sym} autoApproveMax, ` +
  `sent by the operator key ${SENDER} to ${same(VAULT, DEFAULT_VAULT) ? 'the launch-day vault' : 'the vault'} ${getAddress(VAULT)} with an explicit ${GAS} gas limit so that it would be mined: ` +
  `block ${blockNumber}, ${why}, ${gasUsed} gas${gasMatch}, ${gasUsd(cost)} ${chain.nativeCurrency.symbol} of gas. ` +
  (receipt.logs.length === 0
    ? `Nothing moved: the receipt carries no logs${balanceAfter !== null && balanceAfter === balance ? ` and the vault balance read ${usd(balance)} ${sym} before and after` : ''}. `
    : `The receipt carries ${receipt.logs.length} log(s), which a reverted transaction should not. `) +
  'Sent by mcp/scripts/arc-vault-refusal.mjs.'

console.log('\nARC_REFUSALS entry for mcp/src/arc-season.ts, ready to paste:')
console.log('  {')
console.log("    kind: 'vault-policy-on-chain',")
console.log(`    txHash: ${tsString(hash)},`)
console.log(`    at: ${tsString(at ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))},`)
console.log(`    note: ${tsString(note)},`)
console.log('  },')
if (!at) console.log('note: the block timestamp could not be read, so `at` above is the local clock; replace it with the block time.')

if ((reason && reason !== EXPECTED) || replayAnomaly || receipt.logs.length > 0) {
  console.error(
    `\nwarning: the transaction was mined and reverted, but ${replayAnomaly ? 'its replay did not revert' : receipt.logs.length > 0 ? 'its receipt carries logs' : `the replay reads ${reason}, not ${EXPECTED}`}. The entry above says what the chain says; check it before recording.`,
  )
  process.exit(3)
}
process.exit(0)
