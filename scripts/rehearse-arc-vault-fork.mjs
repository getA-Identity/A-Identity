#!/usr/bin/env node
/**
 * The success path of vault admission against a real EVM, with no real money: Arc Mainnet forked
 * into a local anvil at a pinned block, and the real backend (mcp/dist/http.js) answering over HTTP.
 * The unit tests give the route plain answers; on production its only real answers so far are
 * refusals. This is the run where it says yes to a vault an EVM actually created.
 *
 * What it runs: an anvil account deploys the current AgentSpendPolicyBytecode, sets the expiry and
 * funds the vault. POST /api/arc/vaults must admit it, GET /api/arc/vaults must list it, and
 * GET /api/arc/season must count it at 1 of 5 with ownerKind unstated. A second POST is a no-op. A
 * freeze and a withdrawal by the owner appear as freezeTxs and withdrawTxs; a stranger's direct
 * attempt reverts, and a log the stranger causes through an owner that has code does not appear. A
 * vault deployed by a key on our lists is refused, a vault with no expiry gets a retryable refusal
 * and is admitted once it has one, and a hash nobody knows and a contract that is no vault are
 * refused. With --browser it then drives the deploy page: see the section at the end.
 *
 * What stands in for what, so nothing here is read as more than it is:
 *   - Arc USDC at 0x3600... calls a native precompile anvil cannot run, so MockUSDC from
 *     mcp/test-sol/mocks/Tokens.sol is etched at that address with anvil_setCode. Native gas and the
 *     ERC-20 balance are therefore separate here, which they are not on Arc.
 *   - Every Arc Mainnet host in the registry is redirected to anvil inside the backend process, so
 *     host disagreement is not exercised: it is one chain answering four times. Any other outbound
 *     fetch from that process is refused and listed at the end.
 *   - "Our keys" holds one freshly generated throwaway key, under an env var nothing in the server
 *     signs with, plus the committed lists.
 *
 * Safety: the backend gets a built-from-scratch environment (no DATABASE_URL, nothing from your
 * shell, cwd in a temp dir so no .env is found) and a copy of mcp/dist under that temp dir, so its
 * file store lands there too and never in mcp/data. Every signature goes to the local anvil, whose
 * accounts are the public test mnemonic. Nothing is sent to a real chain or to production.
 *
 * Usage: (cd mcp && npm run build), Foundry's anvil on PATH, then
 *        node scripts/rehearse-arc-vault-fork.mjs [--block N] [--browser] [--keep]
 *   --block N   fork at this block (default: the head when the run starts, printed so it can be repeated)
 *   --browser   also drive the deploy page; needs the root node_modules and Playwright's chromium
 *   --keep      keep the temp dir (backend log, store file, screenshots) and print its path
 * Exit: 0 all checks passed, 1 a check failed, 2 usage or a missing tool.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const blockArg = args.includes('--block') ? args[args.indexOf('--block') + 1] : null
const unknown = args.filter((a, i) => !['--browser', '--keep', '--block'].includes(a) && args[i - 1] !== '--block')
if (unknown.length || (args.includes('--block') && !/^\d+$/.test(blockArg ?? ''))) {
  console.error('usage: rehearse-arc-vault-fork.mjs [--block N] [--browser] [--keep]')
  process.exit(2)
}
if (spawnSync('anvil', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error('anvil is not on PATH: install Foundry first')
  process.exit(2)
}
if (!existsSync(join(repo, 'mcp/dist/http.js'))) {
  console.error('mcp/dist/http.js is missing: run (cd mcp && npm run build) first')
  process.exit(2)
}

const mod = (p) => import(pathToFileURL(join(repo, p)).href)
const viem = await mod('mcp/node_modules/viem/_esm/index.js')
const { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } = await mod('mcp/node_modules/viem/_esm/accounts/index.js')
const { getChainById } = await mod('mcp/dist/chains/registry.js')
const { committedOurKeys } = await mod('mcp/dist/arc-owner-vault.js')
const art = await mod('mcp/dist/contracts/AgentSpendPolicy.js')
const { encodeDeployData, encodeFunctionData, decodeFunctionResult, getAddress, parseAbi, parseUnits, toHex } = viem

const chain = getChainById('arc-mainnet')
const USDC = chain.contracts.usdc
const abi = art.AgentSpendPolicyAbi
const bytecode = art.AgentSpendPolicyBytecode
const MOCK = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
const DAILY_CAP = parseUnits('1', 6)
const AUTO_APPROVE_MAX = parseUnits('0.25', 6)

// --- the checks ---------------------------------------------------------------------------
const results = []
const check = (ok, what) => {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${what}`)
  results.push({ ok: Boolean(ok), what })
  return Boolean(ok)
}
const say = (s) => console.log(`      ${s}`)
const section = (s) => console.log(`\n--- ${s}`)

// --- the processes, which only this run started and only this run stops, by pid --------------
const work = mkdtempSync(join(tmpdir(), 'arc-vault-fork-'))
const children = []
function stopChildren() {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM')
  }
}
function finish(code) {
  stopChildren()
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `\n${failed} of ${results.length} check(s) failed` : `\nALL ${results.length} CHECKS PASSED`)
  if (flag('--keep')) console.log('kept', work)
  else rmSync(work, { recursive: true, force: true })
  process.exit(code || (failed ? 1 : 0))
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => finish(130))
process.on('uncaughtException', (e) => {
  check(false, `the run stopped: ${e.message}`)
  finish(1)
})
process.on('unhandledRejection', (e) => {
  check(false, `the run stopped: ${e?.message ?? e}`)
  finish(1)
})

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function waitFor(what, fn, ms = 60000) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`${what} did not happen in ${ms} ms${last ? `: ${last.message}` : ''}`)
}

// --- the fork ------------------------------------------------------------------------------
const upstream = chain.rpcUrls[0]
async function upstreamHead() {
  const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(20000) })
  return BigInt((await res.json()).result)
}
const forkBlock = blockArg ? BigInt(blockArg) : await upstreamHead()
const anvilPort = await freePort()
const anvilUrl = `http://127.0.0.1:${anvilPort}`
const anvil = spawn('anvil', ['--fork-url', upstream, '--fork-block-number', forkBlock.toString(), '--port', String(anvilPort), '--host', '127.0.0.1', '--hardfork', 'prague', '--no-storage-caching'], { stdio: ['ignore', 'pipe', 'pipe'] })
children.push(anvil)
let anvilOut = ''
anvil.stdout.on('data', (d) => (anvilOut = (anvilOut + d).slice(-4000)))
anvil.stderr.on('data', (d) => (anvilOut = (anvilOut + d).slice(-4000)))

let rpcId = 1
async function rpc(method, params = []) {
  const res = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal: AbortSignal.timeout(60000) })
  const j = await res.json()
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data })
  return j.result
}
await waitFor('anvil answering', () => rpc('eth_chainId'), 60000).catch((e) => {
  console.log(anvilOut)
  throw e
})

// The public test mnemonic anvil funds. These keys exist on every local devnet, so nothing that
// signs with them could ever be mistaken for real money.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const acct = (i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i })
const owner = acct(0)
const agent = acct(1)
const stranger = acct(2)
const lateOwner = acct(3)
const foreignDeployer = acct(4)

const chainHex = await rpc('eth_chainId')
section(`Arc Mainnet forked at block ${forkBlock} on anvil port ${anvilPort}`)
check(Number(chainHex) === chain.evmChainId, `the fork answers the registry's chain id ${chain.evmChainId} (${chainHex})`)

// --- USDC: the precompile-backed token cannot run here, so the mock stands at its address ---------
const require = createRequire(join(repo, 'mcp/package.json'))
const solc = require('solc')
const tokensSol = 'test-sol/mocks/Tokens.sol'
const solOut = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: { [tokensSol]: { content: readFileSync(join(repo, 'mcp', tokensSol), 'utf8') } },
      settings: { evmVersion: 'paris', outputSelection: { '*': { MockUSDC: ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
    }),
  ),
)
const mock = solOut.contracts?.[tokensSol]?.MockUSDC
if (!mock) throw new Error(`MockUSDC did not compile: ${JSON.stringify(solOut.errors ?? []).slice(0, 400)}`)
await rpc('anvil_setCode', [USDC, `0x${mock.evm.deployedBytecode.object}`])
say(`MockUSDC runtime etched at ${USDC}`)

async function send(account, tx) {
  const nonce = Number(await rpc('eth_getTransactionCount', [account.address, 'pending']))
  const price = BigInt(await rpc('eth_gasPrice'))
  const maxFeePerGas = price * 2n + 1_000_000_000n
  const call = { from: account.address, ...(tx.to ? { to: tx.to } : {}), data: tx.data }
  const gas = tx.gas ?? (BigInt(await rpc('eth_estimateGas', [call])) * 13n) / 10n
  const raw = await account.signTransaction({ type: 'eip1559', chainId: chain.evmChainId, nonce, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n })
  const hash = await rpc('eth_sendRawTransaction', [raw])
  const receipt = await waitFor(`a receipt for ${hash}`, () => rpc('eth_getTransactionReceipt', [hash]))
  return { hash, receipt }
}
const nowOnChain = async () => BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)
const read = async (to, fn, callArgs = [], from) => {
  const data = encodeFunctionData({ abi, functionName: fn, args: callArgs })
  return decodeFunctionResult({ abi, functionName: fn, data: await rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']) })
}
const vaultCall = (vault, fn, callArgs) => ({ to: vault, data: encodeFunctionData({ abi, functionName: fn, args: callArgs }) })

async function deployVault(account, operator) {
  const data = encodeDeployData({ abi, bytecode, args: [account.address, operator, USDC, DAILY_CAP, AUTO_APPROVE_MAX] })
  const { hash, receipt } = await send(account, { data })
  if (receipt.status !== '0x1' || !receipt.contractAddress) throw new Error(`the deploy ${hash} failed: ${receipt.status}`)
  return { hash, vault: getAddress(receipt.contractAddress), block: BigInt(receipt.blockNumber) }
}
const setExpiry = async (account, vault) => send(account, vaultCall(vault, 'setSessionKeyExpiry', [(await nowOnChain()) + 86400n * 30n]))
/** The reader stops 20 blocks behind the head, so an action is only visible once the head has moved on. */
const mine = (n = 25) => rpc('anvil_mine', [toHex(n)])

// --- the real backend, from a copy under the temp dir so its file store lands there ------------
const backendDir = join(work, 'backend')
cpSync(join(repo, 'mcp/dist'), join(backendDir, 'dist'), { recursive: true })
cpSync(join(repo, 'mcp/package.json'), join(backendDir, 'package.json'))
symlinkSync(join(repo, 'mcp/node_modules'), join(backendDir, 'node_modules'))
const storeFile = join(backendDir, 'data', 'arc-admitted-vaults.json')
const blockedLog = join(work, 'blocked-fetches.log')
const preload = join(work, 'redirect-rpc.mjs')
writeFileSync(
  preload,
  `import { appendFileSync } from 'node:fs'
const hosts = new Set(${JSON.stringify(chain.rpcUrls.map((u) => new URL(u).host))})
const anvil = ${JSON.stringify(anvilUrl)}
const real = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (hosts.has(url.host)) return real(anvil, init)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init)
  appendFileSync(${JSON.stringify(blockedLog)}, url.host + '\\n')
  throw new Error('this rehearsal refuses outbound fetches to ' + url.host)
}
`,
)
const ourEnvKey = generatePrivateKey()
const ourEnvAccount = privateKeyToAccount(ourEnvKey)
const backendPort = await freePort()
const api = `http://127.0.0.1:${backendPort}`
let backendOut = ''
const backend = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(backendDir, 'dist/http.js')], {
  cwd: backendDir,
  // Built from nothing on purpose. CELO_BUYER_KEY is on our list and only a script ever signs with it.
  env: { PATH: process.env.PATH, HOME: work, PORT: String(backendPort), CELO_BUYER_KEY: ourEnvKey },
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(backend)
backend.stdout.on('data', (d) => (backendOut = (backendOut + d).slice(-8000)))
backend.stderr.on('data', (d) => (backendOut = (backendOut + d).slice(-8000)))
backend.on('exit', () => {
  if (existsSync(work)) writeFileSync(join(work, 'backend.log'), backendOut)
})
await waitFor('the backend answering /health', async () => (await fetch(`${api}/health`)).ok, 60000).catch((e) => {
  console.log(backendOut.slice(-2000))
  throw e
})
say(`backend on port ${backendPort}, store ${storeFile}`)

async function getJson(path) {
  const res = await fetch(`${api}${path}`, { headers: { accept: 'application/json' } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function postVault(deployTx) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${api}/api/arc/vaults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deployTx }) })
    const body = await res.json().catch(() => null)
    if (res.status === 429 && attempt < 3) {
      say('the route says 429 (10 posts a minute): waiting out the window')
      await new Promise((r) => setTimeout(r, 61000))
      continue
    }
    say(`POST ${deployTx.slice(0, 12)}... -> ${res.status} ${body?.status}${body?.alreadyAdmitted !== undefined ? ` alreadyAdmitted=${body.alreadyAdmitted}` : ''}${body?.retryable !== undefined ? ` retryable=${body.retryable}` : ''}${body?.reasons ? ` [${body.reasons.map((r) => r.id).join(', ')}]` : ''}`)
    return { status: res.status, body }
  }
}
const season = async () => (await getJson('/api/arc/season')).body
const seasonItem = (report, vault) => report.milestone1.vaults.items.find((v) => v.address.toLowerCase() === vault.toLowerCase())
const storeRows = () => (existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : [])

// --- before anything ----------------------------------------------------------------------
section('before any vault')
const list0 = await getJson('/api/arc/vaults')
check(list0.status === 200 && list0.body.readable === true && list0.body.count === 0, 'GET /api/arc/vaults answers an empty, readable list')
check(list0.body.admission?.ready === true && list0.body.admission?.keysCompared === 1, `the route says it can admit, with ${list0.body.admission?.keysCompared} env key compared`)
const report0 = await season()
check(report0.milestone1.vaults.count === 0 && report0.milestone1.vaults.target === 5, `GET /api/arc/season counts ${report0.milestone1.vaults.count} of ${report0.milestone1.vaults.target}`)

// --- the owner path -------------------------------------------------------------------------
section('the owner: deploy, expiry, funding, admission')
const { hash: deployTx, vault, block: deployBlock } = await deployVault(owner, agent.address)
say(`vault ${vault} deployed by ${owner.address} in block ${deployBlock}, tx ${deployTx}`)
check(getAddress(await read(vault, 'owner')) === owner.address, 'owner() is the wallet that deployed')
const expiryTx = await setExpiry(owner, vault)
check(expiryTx.receipt.status === '0x1' && (await read(vault, 'sessionKeyExpiry')) > (await nowOnChain()), 'the owner sets an expiry in the future')
await send(foreignDeployer, { to: USDC, data: encodeFunctionData({ abi: MOCK, functionName: 'mint', args: [owner.address, parseUnits('5', 6)] }) })
const funded = await send(owner, { to: USDC, data: encodeFunctionData({ abi: MOCK, functionName: 'transfer', args: [vault, parseUnits('1', 6)] }) })
check(funded.receipt.status === '0x1' && (await read(vault, 'balance')) === parseUnits('1', 6), 'the owner funds the vault with 1 USDC, as balance() reads it')

const admitted = await postVault(deployTx)
check(admitted.status === 200 && admitted.body?.status === 'admitted' && admitted.body.alreadyAdmitted === false, 'POST /api/arc/vaults with the deploy hash answers admitted')
if (admitted.body?.status !== 'admitted') console.log(JSON.stringify(admitted.body, null, 1))
check(admitted.body?.vault === vault && admitted.body?.owner === owner.address, 'the answer names the vault and the owner the chain says')
check(admitted.body?.deployTx === deployTx.toLowerCase(), 'the answer names the deploy transaction')

const listed = await getJson('/api/arc/vaults')
const row = listed.body?.items?.find((v) => v.address === vault)
check(listed.body?.count === 1 && row, 'GET /api/arc/vaults lists it')
check(row?.deployBlock === deployBlock.toString(), `the list holds the deploy block ${row?.deployBlock}`)
check(/^\d{4}-\d{2}-\d{2}$/.test(row?.deployedAt ?? ''), `the list holds the UTC deploy day ${row?.deployedAt}`)
check(Boolean(row?.explorerUrl) && row.explorerUrl.includes(vault), `the list links the explorer ${row?.explorerUrl}`)

const report1 = await season()
const item1 = seasonItem(report1, vault)
check(report1.milestone1.vaults.count === 1 && report1.milestone1.vaults.target === 5, `GET /api/arc/season counts it: ${report1.milestone1.vaults.count} of ${report1.milestone1.vaults.target}`)
check(item1?.ownerKind === 'unstated', `the report says ownerKind ${item1?.ownerKind}`)
check(item1?.deployTx === deployTx.toLowerCase(), 'the report names its deploy transaction')
check(/admitted automatically/.test(report1.milestone1.vaults.note), 'the report note says it was admitted automatically, owner not identified')
say(`report note: ${report1.milestone1.vaults.note.slice(0, 160)}...`)

section('a repeat is a no-op')
const repeat = await postVault(deployTx)
check(repeat.status === 200 && repeat.body?.status === 'admitted' && repeat.body.alreadyAdmitted === true, 'a second POST answers admitted, alreadyAdmitted true')
const upper = await postVault(`0x${deployTx.slice(2).toUpperCase()}`)
check(upper.body?.alreadyAdmitted === true, 'the same hash in capitals is the same deploy')
check(storeRows().length === 1, `the store still holds ${storeRows().length} row`)
check((await season()).milestone1.vaults.count === 1, 'the report still counts 1')

// --- what the owner did, and what anyone else did ----------------------------------------------
section("owner actions: the owner's appear, anyone else's do not")
const strangerFreeze = await send(stranger, { ...vaultCall(vault, 'setFrozen', [true]), gas: 200000n })
const strangerWithdraw = await send(stranger, { ...vaultCall(vault, 'withdraw', [stranger.address, 1n]), gas: 200000n })
check(strangerFreeze.receipt.status === '0x0' && strangerWithdraw.receipt.status === '0x0', "a stranger's direct freeze and withdrawal revert on chain")
const ownerFreeze = await send(owner, vaultCall(vault, 'setFrozen', [true]))
const ownerUnfreeze = await send(owner, vaultCall(vault, 'setFrozen', [false]))
const ownerWithdraw = await send(owner, vaultCall(vault, 'withdraw', [owner.address, parseUnits('0.2', 6)]))
const ownerZero = await send(owner, vaultCall(vault, 'withdraw', [owner.address, 0n]))
check([ownerFreeze, ownerUnfreeze, ownerWithdraw, ownerZero].every((t) => t.receipt.status === '0x1'), 'the owner freezes, unfreezes, withdraws 0.2 USDC, and withdraws 0')

// An owner with code, as an EIP-7702 delegation gives an EOA: the vault sees msg.sender == owner and
// emits the log, but the transaction was signed by someone else. Only this reaches the reader's
// sender filter, because the contract stops a stranger's direct call. The runtime forwards its
// calldata to the vault and reverts when the call does.
const forwarder = `0x36600060003760006000366000600073${vault.slice(2).toLowerCase()}5af115602b57005b60006000fd`
await rpc('anvil_setCode', [owner.address, forwarder])
const viaFreeze = await send(stranger, { to: owner.address, data: encodeFunctionData({ abi, functionName: 'setFrozen', args: [true] }), gas: 300000n })
const viaWithdraw = await send(stranger, { to: owner.address, data: encodeFunctionData({ abi, functionName: 'withdraw', args: [stranger.address, 1000n] }), gas: 300000n })
await rpc('anvil_setCode', [owner.address, '0x'])
check(viaFreeze.receipt.status === '0x1' && viaFreeze.receipt.logs.length === 1 && viaWithdraw.receipt.status === '0x1', 'a stranger, through an owner that has code, makes the vault log a freeze and a withdrawal')
check((await read(vault, 'frozen')) === true, 'frozen() reads true: the log was real')
await send(owner, vaultCall(vault, 'setFrozen', [false]))
await mine()

const actions = await waitFor(
  'the report to read every action',
  async () => {
    const item = seasonItem(await season(), vault)
    return item?.actionsRead.state === 'complete' && BigInt(item.actionsRead.scannedToBlock) >= BigInt(viaWithdraw.receipt.blockNumber) ? item : null
  },
  90000,
)
say(`actionsRead ${JSON.stringify(actions.actionsRead)}`)
say(`freezeTxs ${actions.freezeTxs.map((t) => t.txHash).join(', ')}`)
say(`withdrawTxs ${actions.withdrawTxs.map((t) => t.txHash).join(', ')}`)
const hashes = (l) => l.map((t) => t.txHash.toLowerCase())
check(hashes(actions.freezeTxs).length === 1 && hashes(actions.freezeTxs)[0] === ownerFreeze.hash.toLowerCase(), "freezeTxs is exactly the owner's freeze: no unfreeze, no stranger")
check(hashes(actions.withdrawTxs).length === 1 && hashes(actions.withdrawTxs)[0] === ownerWithdraw.hash.toLowerCase(), "withdrawTxs is exactly the owner's withdrawal: no zero amount, no stranger")
check(actions.freezeTxs[0]?.block === BigInt(ownerFreeze.receipt.blockNumber).toString(), `the freeze names its block ${actions.freezeTxs[0]?.block}`)
check(Boolean(actions.freezeTxs[0]?.explorerUrl?.includes(ownerFreeze.hash)), 'the freeze links the explorer')
const report2 = await season()
check(report2.milestone1.vaults.ownerActions.freezes === 1 && report2.milestone1.vaults.ownerActions.withdrawals === 1 && report2.milestone1.vaults.ownerActions.vaultsNotFullyRead === 0, `the report sums ${JSON.stringify(report2.milestone1.vaults.ownerActions)}`)

// --- refusals ---------------------------------------------------------------------------------
section('a vault deployed by a key of ours')
await rpc('anvil_setBalance', [ourEnvAccount.address, toHex(10n ** 20n)])
const oursVault = await deployVault(ourEnvAccount, agent.address)
await setExpiry(ourEnvAccount, oursVault.vault)
const oursAnswer = await postVault(oursVault.hash)
const oursIds = (oursAnswer.body?.reasons ?? []).map((r) => r.id)
check(oursAnswer.body?.status === 'refused' && oursIds.includes('owner-not-ours') && oursAnswer.body.retryable === false, 'a vault owned by a key in our env is refused, for good')
check(!JSON.stringify(oursAnswer.body).includes('CELO_BUYER_KEY'), 'the refusal does not name the env var that holds the key')

const committed = committedOurKeys()
const committedAddress = getAddress(committed[0])
await rpc('anvil_impersonateAccount', [committedAddress])
await rpc('anvil_setBalance', [committedAddress, toHex(10n ** 20n)])
const committedData = encodeDeployData({ abi, bytecode, args: [committedAddress, agent.address, USDC, DAILY_CAP, AUTO_APPROVE_MAX] })
const committedTx = await rpc('eth_sendTransaction', [{ from: committedAddress, data: committedData, gas: toHex(3_000_000n) }])
const committedReceipt = await waitFor('the impersonated deploy', () => rpc('eth_getTransactionReceipt', [committedTx]))
check(committedReceipt.status === '0x1', `an impersonated deploy from the committed list (${committedAddress}) lands`)
await rpc('eth_sendTransaction', [{ from: committedAddress, ...vaultCall(getAddress(committedReceipt.contractAddress), 'setSessionKeyExpiry', [(await nowOnChain()) + 86400n]), gas: toHex(200000n) }])
await rpc('anvil_stopImpersonatingAccount', [committedAddress])
const committedAnswer = await postVault(committedTx)
check(committedAnswer.body?.status === 'refused' && committedAnswer.body.reasons.some((r) => r.id === 'owner-not-ours') && committedAnswer.body.retryable === false, 'a vault owned by a key on our committed list is refused, for good')

section('a vault with no expiry yet')
const late = await deployVault(lateOwner, agent.address)
const lateAnswer = await postVault(late.hash)
const lateIds = (lateAnswer.body?.reasons ?? []).map((r) => r.id)
check(lateAnswer.body?.status === 'refused' && lateIds.length === 1 && lateIds[0] === 'session-key-expiry', `the refusal names only the end date: ${lateAnswer.body?.reasons?.[0]?.reason}`)
check(lateAnswer.body?.retryable === true, 'the refusal is retryable')
check((await season()).milestone1.vaults.count === 1, 'it is not counted')
await setExpiry(lateOwner, late.vault)
const lateAgain = await postVault(late.hash)
check(lateAgain.body?.status === 'admitted' && lateAgain.body.alreadyAdmitted === false, 'once the expiry is set the same post is admitted: retryable was true')
check((await season()).milestone1.vaults.count === 2, 'the report counts 2 of 5')

section('things that are no vault')
const unknownHash = await postVault(toHex(BigInt(Date.now()), { size: 32 }))
check(unknownHash.body?.status === 'refused' && unknownHash.body.retryable === true && unknownHash.body.reasons.some((r) => r.id === 'receipt-found'), 'a hash no host knows is a retryable refusal')
const foreign = await send(foreignDeployer, { data: `0x${mock.evm.bytecode.object}` })
const foreignAnswer = await postVault(foreign.hash)
check(foreignAnswer.body?.status === 'refused' && foreignAnswer.body.reasons.some((r) => r.id === 'creation-input') && foreignAnswer.body.retryable === false, 'a contract that is not the vault is refused, for good')
check(storeRows().length === 2, `the store holds exactly the ${storeRows().length} admitted vaults`)
const notJson = await fetch(`${api}/api/arc/vaults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
check(notJson.status === 400, 'a body that is not JSON answers 400')
const badHash = await postVault('0x1234')
check(badHash.status === 400 && badHash.body?.status === 'invalid', 'a malformed hash answers 400 invalid')

// --- what left this process ---------------------------------------------------------------------
section('isolation')
const blocked = existsSync(blockedLog) ? [...new Set(readFileSync(blockedLog, 'utf8').trim().split('\n'))] : []
say(`outbound fetches the backend tried and this run refused: ${blocked.length ? blocked.join(', ') : 'none'}`)
check(!existsSync(join(repo, 'mcp/data/arc-admitted-vaults.json')) || !readFileSync(join(repo, 'mcp/data/arc-admitted-vaults.json'), 'utf8').includes(vault), 'nothing landed in the repo store')

finish(0)
