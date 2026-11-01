#!/usr/bin/env node
/**
 * The Milestone 1 flow runner: verify-then-pay flows through the launch-day vault on Arc
 * Mainnet, each a settled Gateway check followed by a vault payment or a refusal. Milestone 1
 * needs 100 of them. The rules (the plan, the budget across runs, what counts, what stops) live
 * in src/arc-vtp-run.ts, unit-tested with fakes; this file reads the world and hands it over.
 *
 * PREPARED BY DEFAULT. It reads the vault, the operator's gas and Gateway balance, the check
 * price, the gas price and each payee's free reads, then prints the plan with the upper bound of
 * every cost, or refuses with the exact shortfall named. It signs nothing, needs no key (the
 * operator's address comes from --operator, the key, or the vault itself), and its one POST to
 * the verify-then-pay route carries no payment.
 *
 * EXECUTES only with --execute AND CONFIRM_ARC_VTP_RUN=yes, and --log. --allow and --deny are
 * totals for that log, so the same command resumes: what the log counts as done is not run again,
 * and what the log spent counts against --budget. Flows run strictly one at a time, refusals
 * first. It stops at the first unexpected outcome and never retries a check or a payment.
 *
 * The operator's key is read from X402_3009_BUYER_KEY and is never printed or logged. A-Identity
 * holds this vault's keys, which is why it is not one of the owner-held vaults Milestone 1 also
 * counts: those use the owner's own agent as operator.
 *
 * Usage (from mcp/, after npm run build and cd ../trust-guard && npm run build):
 *   node scripts/arc-vtp-runner.mjs --allow 2 --deny 2
 *   CONFIRM_ARC_VTP_RUN=yes node --env-file=.env scripts/arc-vtp-runner.mjs \
 *     --allow 30 --deny 70 --log data/arc-vtp-run.jsonl --execute
 *
 * Flags:
 *   --allow <n>          flows paying the showcase agent, expected ALLOW then a Paid tx
 *   --deny <n>           flows naming our operating wallet, expected DENY, nothing sent
 *   --amount-units <n>   USDC base units of the first flow (default 1000); each later flow pays
 *                        one unit more, so no two flows share an amount
 *   --base-url <url>     the hosted API (default https://a-identity.xyz)
 *   --budget <usdc>      the most the log may ever spend (default 0.75)
 *   --max-fee-gwei <n>   the highest fee a payment may use, and what the gas bound is priced at
 *                        (default 60)
 *   --pause-ms <n>       between flows (default 5000: the route allows 30 POSTs a minute per IP
 *                        and each flow makes two)
 *   --log <path>         JSONL log, required with --execute, read for resume in either mode
 *   --operator <0x...>   the operator's address when no key is set
 *   --ack-stop           the log holds flows whose money nobody has read, a human looked, go on
 *   --execute            spend, with CONFIRM_ARC_VTP_RUN=yes
 *
 * Exit: 0 prepared with no blockers, or the run finished. 1 refused or stopped. 2 usage.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createWalletClient, decodeFunctionResult, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── the run's fixed cast ──────────────────────────────────────────────────────────

const VAULT = '0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146'
const OPERATOR_KEY_ENV = 'X402_3009_BUYER_KEY'
const CONFIRM_ENV = 'CONFIRM_ARC_VTP_RUN'
const VTP_PATH = '/api/x402/gateway/verify-then-pay'
const PREVIEW_PATH = '/api/x402/gateway/tools/trust_preview'
const REPUTATION_PATH = '/api/reputation'
const TIP_WEI = 1_000_000_000n
const HTTP_TIMEOUT_MS = 30_000

const PAYEES = {
  allow: {
    role: 'allow',
    label: 'Meridian',
    address: '0x4e26ae66840134ac5979c56ba2509f3956b93431',
    agentId: '#4306',
    note: "Meridian was at 470 on 2026-11-01, and the owner's testnet payment lifts it to about 545.",
  },
  deny: {
    role: 'deny',
    label: 'operating-wallet (internal)',
    address: '0xd305607510e0db2c95807173c7a05bea53c1ed36',
    agentId: '#0',
    note: 'It is off-platform, which scores at most 60: if that changed, pick another DENY payee.',
  },
}

// ── arguments ─────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(['allow', 'deny', 'amount-units', 'base-url', 'budget', 'max-fee-gwei', 'pause-ms', 'log', 'operator'])
const BOOL_FLAGS = new Set(['execute', 'ack-stop', 'help'])

function usage(message) {
  console.error(`error: ${message}`)
  console.error('usage: arc-vtp-runner.mjs --allow <n> --deny <n> [--amount-units <n>] [--base-url <url>] [--budget <usdc>] [--max-fee-gwei <n>] [--pause-ms <n>] [--log <path>] [--operator <0x...>] [--ack-stop] [--execute]')
  process.exit(2)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) usage(`unexpected argument ${a}`)
    const name = a.slice(2)
    if (BOOL_FLAGS.has(name)) out[name] = true
    else if (VALUE_FLAGS.has(name)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) usage(`--${name} needs a value`)
      out[name] = v
    } else usage(`unknown flag ${a}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('See the block at the top of mcp/scripts/arc-vtp-runner.mjs, or "Run the Milestone 1 flows" in mcp/README.md.')
  process.exit(0)
}

function wholeNumber(name, fallback) {
  const raw = args[name] ?? fallback
  if (raw === undefined) return 0
  if (!/^[0-9]+$/.test(String(raw))) usage(`--${name} must be a whole number, got ${raw}`)
  return Number(raw)
}

const allow = wholeNumber('allow')
const deny = wholeNumber('deny')
if (allow + deny === 0) usage('nothing to do: pass --allow and/or --deny')
const pauseMs = wholeNumber('pause-ms', 5000)
const maxFeeGwei = wholeNumber('max-fee-gwei', 60)
const amountRaw = args['amount-units'] ?? '1000'
if (!/^[1-9][0-9]*$/.test(amountRaw)) usage(`--amount-units must be a whole number above 0, got ${amountRaw}`)
const baseAmountUnits = BigInt(amountRaw)
const baseUrl = (args['base-url'] ?? 'https://a-identity.xyz').replace(/\/+$/, '')
if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) usage(`--base-url must be https, or http on localhost: ${baseUrl}`)
const execute = args.execute === true
if (execute && !args.log) usage('--execute needs --log: the budget across runs is counted from it')
const operatorArg = args.operator?.toLowerCase()
if (operatorArg !== undefined && !/^0x[0-9a-f]{40}$/.test(operatorArg)) usage('--operator must be a 0x address')

// ── what the repo built ───────────────────────────────────────────────────────────

let arc, generated, registry, rpc, rules
try {
  ;[arc, generated] = await Promise.all([import('../../trust-guard/dist/arc.js'), import('../../trust-guard/dist/arc-mainnet.generated.js')])
} catch (e) {
  console.error(`error: trust-guard is not built (${e.message}). Run: cd trust-guard && npm ci && npm run build`)
  process.exit(1)
}
try {
  ;[registry, rpc, rules] = await Promise.all([import('../dist/chains/registry.js'), import('../dist/chains/evm/client.js'), import('../dist/arc-vtp-run.js')])
} catch (e) {
  console.error(`error: mcp/dist is not built (${e.message}). Run: cd mcp && npm run build`)
  process.exit(1)
}
const { ARC_MAINNET, arcChainReader, arcViemChain, fromViemWallet, preflightVault, usdcUnits, verifyThenPay } = arc
const { ARC_VAULT_ABI } = generated
const { buildPlan, forecastVerdict, formatUnits, readRunLog, RunLogError, runFlows } = rules

// ── the registry, and a trust-guard build that agrees with it ─────────────────────

const chain = registry.getChainById('arc-mainnet')
if (!chain) {
  console.error('error: the registry has no arc-mainnet')
  process.exit(1)
}
const lc = (v) => String(v).toLowerCase()
const stale = [
  ['chain id', ARC_MAINNET.chainId, chain.evmChainId],
  ['USDC', lc(ARC_MAINNET.usdc), lc(chain.contracts.usdc)],
  ['identity registry', lc(ARC_MAINNET.identityRegistry), lc(chain.contracts.identityRegistry)],
  ['Gateway wallet', lc(ARC_MAINNET.gatewayWallet), lc(chain.gateway?.wallet)],
  ['Gateway domain', ARC_MAINNET.gatewayDomain, chain.cctpDomain],
].filter(([, a, b]) => a !== b)
if (stale.length) {
  console.error(`error: this trust-guard build disagrees with the registry on ${stale.map(([n]) => n).join(', ')}. Run: cd mcp && npm run gen:chains, then rebuild trust-guard`)
  process.exit(1)
}

const DECIMALS = { usdc: chain.usdcDecimals, native: chain.nativeCurrency.decimals }
const rpcUrls = rpc.resolveRpcUrls(chain)
const reader = arcChainReader(rpcUrls)
const capWei = BigInt(maxFeeGwei) * 1_000_000_000n
const minFeeWei = ARC_MAINNET.minMaxFeePerGasWei
const usd = (units) => `${formatUnits(units, DECIMALS.usdc)} USDC`
const nat = (wei) => `${formatUnits(wei, DECIMALS.native)} USDC`
const gwei = (wei) => `${formatUnits(wei, 9)} gwei`

let budgetUnits
try {
  budgetUnits = usdcUnits(args.budget ?? '0.75')
} catch (e) {
  usage(`--budget: ${e.message}`)
}

// ── the key, kept out of everything printed ───────────────────────────────────────

const rawKey = process.env[OPERATOR_KEY_ENV]?.trim() ?? ''
let account = null
if (rawKey) {
  try {
    account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`)
  } catch {
    console.error(`error: ${OPERATOR_KEY_ENV} is set and is not a usable private key`)
    process.exit(1)
  }
}
const SECRETS = rawKey ? [rawKey, rawKey.replace(/^0x/, '')] : []
const scrub = (s) => SECRETS.reduce((text, k) => text.split(k).join('[redacted]'), String(s))
const print = (s) => console.log(scrub(s))

// ── the free reads ────────────────────────────────────────────────────────────────

async function httpJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body }
}

const errText = (e) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300)

/** A contract read, or null. The plan names what could not be read rather than guess at it. */
async function read(to, abi, functionName, argsList = []) {
  try {
    const data = encodeFunctionData({ abi, functionName, args: argsList })
    return decodeFunctionResult({ abi, functionName, data: await reader.call({ to, data }) })
  } catch {
    return null
  }
}

const REGISTRY_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
]

async function readVault() {
  const names = ['owner', 'operator', 'frozen', 'sessionKeyExpiry', 'allowlistEnabled', 'autoApproveMax', 'dailyCap', 'spentToday', 'balance']
  const [values, block] = await Promise.all([Promise.all(names.map((n) => read(VAULT, ARC_VAULT_ABI, n))), reader.latestBlock().catch(() => null)])
  const v = Object.fromEntries(names.map((n, i) => [n, values[i]]))
  if (values.some((x) => x === null) || !block) return null
  return {
    owner: lc(v.owner),
    operator: lc(v.operator),
    frozen: v.frozen,
    sessionKeyExpiry: v.sessionKeyExpiry,
    allowlistEnabled: v.allowlistEnabled,
    autoApproveMax: v.autoApproveMax,
    dailyCap: v.dailyCap,
    spentToday: v.spentToday,
    balanceUnits: v.balance,
    blockTimestamp: block.timestamp,
  }
}

async function readGatewayUnits(operator) {
  try {
    const r = await httpJson(`${chain.gateway.facilitator}/v1/balances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: chain.cctpDomain, depositor: operator }] }),
    })
    const row = r.body?.balances?.[0]
    return r.status === 200 && typeof row?.balance === 'string' ? usdcUnits(row.balance) : null
  } catch {
    return null
  }
}

/** The free call to the hosted route: the same request a flow makes, with no payment. */
async function readRoute(payee, amountUnits) {
  try {
    const r = await httpJson(`${baseUrl}${VTP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vault: VAULT, payee: payee.address, amount: amountUnits.toString(), payeeAgentId: payee.agentId, payOnWarn: false }),
    })
    if (r.status === 402) {
      const offer = r.body?.challenge?.accepts?.find((a) => a.network === chain.caip2)
      const price = typeof offer?.amount === 'string' && /^[0-9]+$/.test(offer.amount) ? BigInt(offer.amount) : null
      return price === null ? { price: null, error: 'the 402 carries no Arc Mainnet offer' } : { price, payTo: lc(offer.payTo), error: null }
    }
    if (r.status === 404) return { price: null, error: `${baseUrl}${VTP_PATH} answered 404, so this server does not have the route yet` }
    const code = r.body?.code ? `${r.body.code}: ` : ''
    return { price: null, error: `HTTP ${r.status} ${code}${r.body?.reason ?? r.body?.error ?? 'no readable answer'}` }
  } catch (e) {
    return { price: null, error: `no answer: ${errText(e)}` }
  }
}

async function readPreview(payee) {
  try {
    const r = await httpJson(`${baseUrl}${PREVIEW_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: payee.address }) })
    if (r.status !== 200 || typeof r.body?.scoreBand !== 'string') return null
    return { verified: r.body.verified === true, kyaStatus: String(r.body.kya_status), scoreBand: r.body.scoreBand, revoked: r.body.flags?.revoked === true, sybilSuspected: r.body.flags?.sybilSuspected === true }
  } catch {
    return null
  }
}

async function readReputation(payee) {
  try {
    const r = await httpJson(`${baseUrl}${REPUTATION_PATH}?id=${payee.address}`)
    if (r.status === 404) return { found: false }
    const rep = r.body?.reputation
    if (r.status !== 200 || typeof rep?.score !== 'number') return null
    return { found: true, score: rep.score, tenurePoints: typeof rep.breakdown?.tenure === 'number' ? rep.breakdown.tenure : null, sybil: rep.sybil?.level ?? null }
  } catch {
    return null
  }
}

async function readPayee(spec, amountUnits, operator) {
  const [preview, reputation, agentsHeld, agentOwner, route] = await Promise.all([
    readPreview(spec),
    readReputation(spec),
    read(ARC_MAINNET.identityRegistry, REGISTRY_ABI, 'balanceOf', [spec.address]),
    read(ARC_MAINNET.identityRegistry, REGISTRY_ABI, 'ownerOf', [BigInt(spec.agentId.slice(1))]),
    readRoute(spec, amountUnits),
  ])
  let gasLimit = null
  let gasEstimate = null
  let preflightError = null
  try {
    const free = await preflightVault({ vault: VAULT, payee: spec.address, amountUnits, payeeAgentId: spec.agentId, operator, rpcUrls, maxFeePerGasCapWei: capWei, maxPriorityFeePerGasWei: TIP_WEI })
    gasLimit = free.gasLimit
    gasEstimate = free.gasEstimate
  } catch (e) {
    preflightError = `${e.name}${e.code ? ` ${e.code}` : ''}: ${errText(e)}`
  }
  return { spec, forecast: forecastVerdict(preview, reputation), agentsHeld, gasLimit, preflightError, routeError: route.error, price: route.price, payTo: route.payTo ?? null, preview, reputation, agentOwner, gasEstimate }
}

// ── the log ───────────────────────────────────────────────────────────────────────

const logPath = args.log ? resolve(args.log) : null

function loadLogState() {
  if (!logPath || !existsSync(logPath)) return readRunLog('')
  return readRunLog(readFileSync(logPath, 'utf8'))
}

/** One line, on the disk before this returns. */
function appendLine(line) {
  const fd = openSync(logPath, 'a')
  try {
    writeSync(fd, `${scrub(JSON.stringify(line))}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** One runner per log: two at once could each pass the budget alone. */
function takeLock() {
  const path = `${logPath}.lock`
  try {
    closeSync(openSync(path, 'wx'))
  } catch {
    console.error(`REFUSED: ${path} exists, so another run holds this log, or one crashed. If none is running, look at the log and then delete the lock file.`)
    process.exit(1)
  }
  return () => rmSync(path, { force: true })
}

// ── the plan ──────────────────────────────────────────────────────────────────────

async function gatherPlan(operatorHint, log) {
  const [vault, gasPriceWei] = await Promise.all([readVault(), reader.gasPrice().catch(() => null)])
  const operator = operatorHint ?? vault?.operator ?? null
  if (!operator) {
    console.error('REFUSED: the vault could not be read and no --operator was given, so there is no operator to plan for.')
    process.exit(1)
  }
  const [operatorGasWei, gatewayUnits] = await Promise.all([reader.nativeBalance(operator).catch(() => null), readGatewayUnits(operator)])
  const first = rules.flowAmountUnits(baseAmountUnits, log.nextSeq)
  const roles = [...(allow > 0 ? ['allow'] : []), ...(deny > 0 ? ['deny'] : [])]
  const payees = await Promise.all(roles.map((role) => readPayee(PAYEES[role], first, operator)))
  const prices = [...new Set(payees.map((p) => p.price).filter((p) => p !== null))]
  // Two payees quoted two prices: plan for the dearer one, and the cap on signing holds to it.
  const priceUnits = prices.length ? prices.reduce((a, b) => (a > b ? a : b)) : null
  const input = { allow, deny, baseAmountUnits, budgetUnits, log, operator, capWei, tipWei: TIP_WEI, minFeeWei, priceUnits, gatewayUnits, gasPriceWei, operatorGasWei, vault, payees, decimals: DECIMALS }
  const plan = buildPlan(input)
  // The offer's payTo must not be the payer, or Gateway rejects the self-transfer at signing.
  for (const p of payees) {
    if (p.payTo && p.payTo === operator) plan.blockers.push(`the operator ${operator} is the offer's payTo, and Gateway rejects a self-transfer`)
  }
  for (const p of payees) {
    if (p.agentOwner && lc(p.agentOwner) !== p.spec.address) plan.blockers.push(`agent ${p.spec.agentId} on Arc Mainnet is owned by ${p.agentOwner}, not by ${p.spec.label}`)
  }
  return { input, plan, operator, vault }
}

function printPlan({ input, plan, operator, vault }, operatorSource) {
  const { gatewayUnits, gasPriceWei, operatorGasWei, priceUnits, payees, log } = input
  const known = (v, f) => (v === null || v === undefined ? 'UNREADABLE' : f(v))
  print('Arc Mainnet verify-then-pay run')
  print(`mode: ${execute ? 'EXECUTE' : 'PREPARED (nothing signed, nothing paid)'}`)
  print(`api: ${baseUrl}`)
  print(`vault: ${VAULT} (launch-day vault)`)
  if (vault) {
    print(`  owner ${vault.owner}`)
    print(`  operator ${vault.operator}`)
    print(`  frozen ${vault.frozen}; allowlist ${vault.allowlistEnabled ? 'on' : 'off'}`)
    print(`  session key expires ${vault.sessionKeyExpiry === 0n ? 'never' : `${new Date(Number(vault.sessionKeyExpiry) * 1000).toISOString()} (${vault.sessionKeyExpiry})`}`)
    print(`  auto-approve ${usd(vault.autoApproveMax)}; daily cap ${usd(vault.dailyCap)}; spent today ${usd(vault.spentToday)}`)
    print(`  balance ${usd(vault.balanceUnits)}`)
  } else {
    print('  UNREADABLE')
  }
  print(`operator: ${operator} (${operatorSource})`)
  print(`  native gas ${known(operatorGasWei, nat)}`)
  print(`  Gateway balance, domain ${chain.cctpDomain}: ${known(gatewayUnits, usd)}`)
  print(`check price: ${known(priceUnits, usd)} (free 402 from the hosted route)`)
  print(`gas price: ${known(gasPriceWei, gwei)}; a payment would use a fee of ${known(plan.feeWei, gwei)}, capped at ${gwei(capWei)}`)
  print('')
  print('payees:')
  for (const p of payees) {
    const wanted = p.spec.role === 'allow' ? allow : deny
    const left = plan.remaining[p.spec.role]
    print(`  ${p.spec.label} ${p.spec.address}`)
    print(`    flows: ${left} left of ${wanted}; expected ${rules.expectedFor(p.spec.role)}; forecast today ${p.forecast.verdict}`)
    print(`    trust_preview: ${p.preview ? `verified ${p.preview.verified}, kya ${p.preview.kyaStatus}, band ${p.preview.scoreBand}, revoked ${p.preview.revoked}, sybil suspected ${p.preview.sybilSuspected}` : 'UNREADABLE'}`)
    print(`    /api/reputation: ${p.reputation === null ? 'UNREADABLE' : p.reputation.found ? `score ${p.reputation.score}, tenure points ${p.reputation.tenurePoints}, sybil ${p.reputation.sybil}` : 'not on the platform'}`)
    print(`    registry: balanceOf ${p.agentsHeld ?? 'UNREADABLE'}; agent ${p.spec.agentId} owner ${p.agentOwner ?? 'UNREADABLE'}`)
    print(`    pay() gas: estimate ${p.gasEstimate ?? 'none'}, limit ${p.gasLimit ?? 'none'}`)
    if (p.forecast.missing.length) print(`    between it and ALLOW: ${p.forecast.missing.join('; ')}`)
  }
  print('')
  if (logPath) print(`log: ${logPath}: ${log.doneDeny} DENY and ${log.doneAllow} ALLOW flows done, ${usd(log.spentUnits)} spent, next flow #${log.nextSeq}`)
  else print('log: none given, so nothing is counted as done or spent')
  const ub = plan.upperBound
  const flows = plan.remaining.allow + plan.remaining.deny
  print(`plan: ${flows} flow(s), refusals first (${plan.remaining.deny} DENY, then ${plan.remaining.allow} ALLOW), one at a time`)
  print('upper bound of every cost in this run:')
  print(`  checks          ${usd(ub.checksUnits)} (${flows} x ${known(priceUnits, usd)}, from the Gateway balance)`)
  print(`  vault payments  ${usd(ub.paymentsUnits)} (${plan.remaining.allow} flow(s), first amount ${formatUnits(baseAmountUnits, DECIMALS.usdc)}, one unit apart, largest ${usd(plan.largestAmountUnits)})`)
  print(`  gas             ${usd(ub.gasUnits)} (${plan.remaining.allow} x ${plan.gasLimit} gas x ${gwei(capWei)}; a DENY flow's signer cannot send, so it costs none)`)
  print(`  total           ${usd(ub.totalUnits)}`)
  print(`  with the log    ${usd(plan.worstCaseUnits)} against --budget ${usd(budgetUnits)}`)
  if (gasPriceWei !== null && plan.remaining.allow > 0) {
    const atPrice = plan.gasLimit * gasPriceWei * BigInt(plan.remaining.allow)
    print(`  gas at today's price, for scale: about ${usd(rules.weiToUnitsCeil(atPrice, DECIMALS))}. The budget counts the bound.`)
  }
  print('what the run needs on hand:')
  print(`  Gateway ${usd(plan.gatewayNeedUnits)}; vault ${usd(plan.vaultNeedUnits)} (also against the daily cap); native gas ${nat(plan.gasNeedWei)}`)
  for (const n of plan.notes) print(`note: ${n}`)
  print('')
  if (plan.blockers.length) {
    print(`REFUSED: ${plan.blockers.length} reason(s) this run would not go through:`)
    plan.blockers.forEach((b, i) => print(`  ${i + 1}. ${b}`))
  } else {
    print('The plan fits: every balance covers the run and each payee is expected to answer as planned.')
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────

function printSummary(result) {
  const line = result.reason ? `stopped (${result.stop}): ${result.reason}` : 'finished: every flow in the plan is done'
  print('')
  print('Summary')
  print(`  ${line}`)
  print(`  counted in this log: ${result.doneDeny} of ${deny} DENY, ${result.doneAllow} of ${allow} ALLOW`)
  print(`  ran this time: ${result.ranThisTime}`)
  print(`  running cost: ${usd(result.spentUnits)} of --budget ${usd(budgetUnits)}, flows with no receipt at their upper bound`)
  print(`  log: ${logPath}`)
  print('  Confirm the count on the public report, which is what Milestone 1 is judged on:')
  print(`    curl -s ${baseUrl}/api/arc/season | jq '.milestone1.checks | {count, target, linked, unlinked}'`)
  print(`  Each flow's public record: ${baseUrl}/api/x402/gateway/flows/<flowId>`)
}

let state
try {
  state = loadLogState()
} catch (e) {
  if (!(e instanceof RunLogError)) throw e
  console.error(`REFUSED: ${e.message}`)
  process.exit(1)
}

// With --ack-stop the plan is judged as if the acknowledged flows were looked at; they stay in
// the budget at their upper bound. The ack is written only when a run actually starts.
const ackSeqs = args['ack-stop'] ? state.unresolved : []
const planState = { ...state, unresolved: args['ack-stop'] ? [] : state.unresolved }

if (account && operatorArg && lc(account.address) !== operatorArg) usage(`--operator ${operatorArg} is not the address of ${OPERATOR_KEY_ENV}`)
const operatorHint = account ? lc(account.address) : operatorArg
const operatorSource = account ? `from ${OPERATOR_KEY_ENV}` : operatorArg ? 'from --operator, no key loaded' : "read from the vault's operator(), no key loaded"

const gathered = await gatherPlan(operatorHint, planState)
printPlan(gathered, operatorSource)

if (!execute) {
  print('')
  print('Nothing was signed and nothing was paid.')
  if (!gathered.plan.blockers.length) print(`To run it: ${CONFIRM_ENV}=yes with ${OPERATOR_KEY_ENV} set, plus --log <path> --execute.`)
  process.exit(gathered.plan.blockers.length ? 1 : 0)
}

// Everything below can spend. Each gate says what it refused.
if (process.env[CONFIRM_ENV] !== 'yes') {
  print('')
  print(`NOT EXECUTED: --execute also needs ${CONFIRM_ENV}=yes. Nothing was signed and nothing was paid.`)
  process.exit(1)
}
if (!account) {
  print('')
  print(`NOT EXECUTED: ${OPERATOR_KEY_ENV} is not set. Nothing was signed and nothing was paid.`)
  process.exit(1)
}
if (gathered.plan.blockers.length) {
  print('')
  print('NOT EXECUTED: the plan was refused. Nothing was signed and nothing was paid.')
  process.exit(1)
}
if (gathered.plan.remaining.allow + gathered.plan.remaining.deny === 0) {
  print('')
  print('Nothing left to run: the log counts every flow in the plan as done.')
  printSummary({ stop: 'complete', doneAllow: state.doneAllow, doneDeny: state.doneDeny, spentUnits: state.spentUnits, ranThisTime: 0, reason: null })
  process.exit(0)
}

mkdirSync(dirname(logPath), { recursive: true })
const releaseLock = takeLock()
let exitCode = 1
try {
  // Read again under the lock: what was planned may have come from before another run ended.
  const locked = loadLogState()
  if (locked.spentUnits !== state.spentUnits || locked.nextSeq !== state.nextSeq) {
    print('NOT EXECUTED: the log changed while the plan was being read. Run again.')
  } else {
    if (ackSeqs.length) {
      appendLine({ v: 1, kind: 'ack', at: new Date().toISOString(), seqs: ackSeqs })
      print(`acknowledged flow(s) ${ackSeqs.join(', ')}: each stays in the budget at its upper bound`)
    }
    const wallet = createWalletClient({ account, chain: arcViemChain, transport: await rpc.evmTransport(chain) })
    const signer = fromViemWallet(wallet)
    const priceUnits = gathered.input.priceUnits
    print('')
    print('Running. Each flow is on the log before it can spend.')
    const result = await runFlows({
      allow,
      deny,
      baseAmountUnits,
      budgetUnits,
      priceUnits,
      capWei,
      decimals: DECIMALS,
      state: planState,
      payees: PAYEES,
      signer,
      preflight: ({ payee, amountUnits }) => preflightVault({ vault: VAULT, payee: payee.address, amountUnits, payeeAgentId: payee.agentId, operator: signer.address, rpcUrls, maxFeePerGasCapWei: capWei, maxPriorityFeePerGasWei: TIP_WEI }),
      verifyThenPay: ({ payee, amountUnits, signer: flowSigner }) =>
        verifyThenPay({
          vault: VAULT,
          payee: payee.address,
          amountUnits,
          payeeAgentId: payee.agentId,
          signer: flowSigner,
          payOnWarn: false,
          maxCheckUnits: priceUnits,
          maxFeePerGasCapWei: capWei,
          maxPriorityFeePerGasWei: TIP_WEI,
          rpcUrls,
          baseUrl,
        }),
      append: appendLine,
      print,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pauseMs,
      now: () => new Date().toISOString(),
    })
    printSummary(result)
    exitCode = result.stop === 'complete' ? 0 : 1
  }
} catch (e) {
  print(`STOPPED by an error outside any flow: ${errText(e)}`)
  print('Read the log before running again: a flow with an intent line and no result may have spent.')
} finally {
  releaseLock()
}
process.exit(exitCode)
