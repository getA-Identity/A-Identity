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
 * refused. With --browser it then drives the deploy page and the vault's own page: an end date set
 * from the vault page, a forgotten setup, a tab closed on a failed question, a browser with no
 * hash and a 429 all end as the server's rule says. See the section at the end. Last the server's own
 * sweep is turned on, off until then so that only the posts above decide those checks: it counts a
 * vault no page asked about, with one host pruned and one rate limited, and with --browser one whose
 * owner's page had every post blocked, with no second row on reload.
 *
 * What stands in for what, so nothing here is read as more than it is:
 *   - Arc USDC at 0x3600... calls a native precompile anvil cannot run, so MockUSDC from
 *     mcp/test-sol/mocks/Tokens.sol, plus the symbol(), decimals() and Transfer log the page reads, is
 *     etched at that address with anvil_setCode. Native gas and the ERC-20 balance are therefore
 *     separate here, which they are not on Arc.
 *   - Every Arc Mainnet host in the registry is redirected to anvil inside the backend process, so
 *     it is one chain answering four times, and two hosts never disagree. Two sections change that:
 *     hosts stall, fail and answer null, as real ones have, and hosts disagree or simulate wrongly.
 *     Any other outbound fetch from that process is refused and listed at the end.
 *   - "Our keys" holds one freshly generated throwaway key, under an env var nothing in the server
 *     signs with, plus the committed lists.
 *
 * Safety: the backend gets a built-from-scratch environment (no DATABASE_URL, nothing from your
 * shell, cwd in a temp dir so no .env is found) and a copy of mcp/dist under that temp dir, so its
 * file store lands there too and never in mcp/data. Every signature goes to the local anvil, whose
 * accounts are the public test mnemonic. Nothing is sent to a real chain or to production.
 *
 * Usage: (cd mcp && npm run build), Foundry's anvil on PATH, then
 *        node scripts/rehearse-arc-vault-fork.mjs [--block N] [--browser] [--postgres] [--keep]
 *   --block N   fork at this block (default: the head when the run starts, printed so it can be repeated)
 *   --browser   also drive the deploy page; needs the root node_modules and Playwright's chromium
 *   --postgres  store admitted vaults in a throwaway local Postgres, as production does, instead of
 *               the file store; needs initdb and postgres on PATH
 *   --keep      keep the temp dir (backend log, store file, screenshots) and print its path
 * Exit: 0 all checks passed, 1 a check failed, 2 usage or a missing tool.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const blockArg = args.includes('--block') ? args[args.indexOf('--block') + 1] : null
const unknown = args.filter((a, i) => !['--browser', '--keep', '--postgres', '--block'].includes(a) && args[i - 1] !== '--block')
if (unknown.length || (args.includes('--block') && !/^\d+$/.test(blockArg ?? ''))) {
  console.error('usage: rehearse-arc-vault-fork.mjs [--block N] [--browser] [--postgres] [--keep]')
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
const { committedOurKeys, OUR_KEY_PUBLIC_ADDRESSES } = await mod('mcp/dist/arc-owner-vault.js')
const art = await mod('mcp/dist/contracts/AgentSpendPolicy.js')
const { encodeDeployData, encodeFunctionData, decodeFunctionResult, getAddress, parseAbi, parseUnits, toFunctionSelector, toHex } = viem

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
async function upstreamHead(upstream) {
  const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(20000) })
  return BigInt((await res.json()).result)
}
const anvilPort = await freePort()
const anvilUrl = `http://127.0.0.1:${anvilPort}`
let anvilOut = ''

let rpcId = 1
async function rpc(method, params = []) {
  const res = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal: AbortSignal.timeout(60000) })
  const j = await res.json()
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data })
  return j.result
}
// Any registry host can serve the fork. anvil exits at once when its host rate limits it, which
// says nothing about this code, so the next host is tried.
let forkBlock = null
for (const upstream of chain.rpcUrls) {
  const host = new URL(upstream).host
  const head = blockArg ? BigInt(blockArg) : await upstreamHead(upstream).catch(() => null)
  if (head === null) {
    say(`${host} gave no block number: trying the next host`)
    continue
  }
  const anvil = spawn('anvil', ['--fork-url', upstream, '--fork-block-number', head.toString(), '--port', String(anvilPort), '--host', '127.0.0.1', '--hardfork', 'prague', '--no-storage-caching'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(anvil)
  anvil.stdout.on('data', (d) => (anvilOut = (anvilOut + d).slice(-4000)))
  anvil.stderr.on('data', (d) => (anvilOut = (anvilOut + d).slice(-4000)))
  const exited = new Promise((resolve) => anvil.once('exit', () => resolve(false)))
  const answering = waitFor('anvil answering', () => rpc('eth_chainId').then(() => anvil.exitCode === null), 60000).then(
    () => true,
    () => false,
  )
  if (await Promise.race([answering, exited])) {
    forkBlock = head
    break
  }
  say(`${host} could not serve the fork (${anvilOut.split('\n').find((l) => /429|rate limit|error/i.test(l))?.slice(0, 120) ?? 'anvil did not answer'}): trying the next host`)
  anvil.kill('SIGTERM')
}
if (forkBlock === null) {
  console.log(anvilOut)
  throw new Error('no registry host could serve the fork')
}

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
// The page reads symbol() and decimals() before it deploys and looks for a Transfer log on the funding
// receipt, and the test mock has none of them. Same storage, same refusals.
const forkToken = `
contract ForkUSDC is MockUSDC {
    event Transfer(address indexed from, address indexed to, uint256 value);
    function symbol() external pure returns (string memory) { return "USDC"; }
    function decimals() external pure returns (uint8) { return 6; }
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
`
const solOut = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: { [tokensSol]: { content: readFileSync(join(repo, 'mcp', tokensSol), 'utf8') + forkToken } },
      settings: { evmVersion: 'paris', outputSelection: { '*': { ForkUSDC: ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
    }),
  ),
)
const mock = solOut.contracts?.[tokensSol]?.ForkUSDC
if (!mock) throw new Error(`the token did not compile: ${JSON.stringify(solOut.errors ?? []).slice(0, 400)}`)
await rpc('anvil_setCode', [USDC, `0x${mock.evm.deployedBytecode.object}`])
say(`MockUSDC runtime, plus symbol() and decimals(), etched at ${USDC}`)

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
const hostBehaviourFile = join(work, 'host-behaviour.json')
writeFileSync(
  preload,
  `import { appendFileSync, readFileSync } from 'node:fs'
const hosts = new Set(${JSON.stringify(chain.rpcUrls.map((u) => new URL(u).host))})
const anvil = ${JSON.stringify(anvilUrl)}
const real = globalThis.fetch
const behaviour = () => {
  try {
    return JSON.parse(readFileSync(${JSON.stringify(hostBehaviourFile)}, 'utf8'))
  } catch {
    return {}
  }
}
const nullFor = new Set(['eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber'])
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (hosts.has(url.host)) {
    const mode = behaviour()[url.host]
    if (mode === 'stall') {
      return new Promise((_, reject) => {
        if (init?.signal?.aborted) return reject(new Error('aborted'))
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (mode === 'rate-limited') return new Response('{"error":"too many requests"}', { status: 429 })
    if (mode === 'other-nonce' || mode === 'wrong-simulation') {
      const call = JSON.parse(init.body)
      if (mode === 'other-nonce' && call.method === 'eth_getTransactionByHash') {
        const answer = await (await real(anvil, init)).json()
        return Response.json({ ...answer, result: { ...answer.result, nonce: '0x' + (BigInt(answer.result.nonce) + 1n).toString(16) } })
      }
      if (mode === 'wrong-simulation' && call.method === 'eth_call' && call.params[0].data.length > 100) {
        return Response.json({ jsonrpc: '2.0', id: call.id, result: '0x6002' })
      }
    }
    if (mode === 'null') {
      const call = JSON.parse(init.body)
      if (nullFor.has(call.method)) return Response.json({ jsonrpc: '2.0', id: call.id, result: null })
    }
    // What Blockdaemon does with an old block: an error for state and logs, and the block with no transactions.
    if (mode === 'pruned') {
      const call = JSON.parse(init.body)
      if (call.method === 'eth_getCode' && call.params[1] !== 'latest') return Response.json({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'state at block is pruned' } })
      if (call.method === 'eth_getLogs') return Response.json({ jsonrpc: '2.0', id: call.id, error: { code: 4444, message: 'pruned history unavailable' } })
      if (call.method === 'eth_getBlockByNumber' && call.params[0] !== 'latest' && call.params[1] === true) {
        const answer = await (await real(anvil, init)).json()
        return Response.json({ ...answer, result: answer.result && { ...answer.result, transactions: [] } })
      }
    }
    return real(anvil, init)
  }
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
// A throwaway cluster, on TCP only: the temp path can be too long for a unix socket.
let databaseUrl = null
if (flag('--postgres')) {
  const pgDir = join(work, 'pg')
  // On macOS postgres refuses to start under an unset or invalid locale.
  const pgEnv = { PATH: process.env.PATH, LC_ALL: 'C' }
  const init = spawnSync('initdb', ['-D', pgDir, '-U', 'rehearsal', '--auth=trust', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8', env: pgEnv })
  if (init.status !== 0) throw new Error(`initdb failed: ${init.error?.message ?? init.stderr}`)
  const pgPort = await freePort()
  children.push(spawn('postgres', ['-D', pgDir, '-p', String(pgPort), '-h', '127.0.0.1', '-k', ''], { stdio: 'ignore', env: pgEnv }))
  const accepting = () =>
    new Promise((resolve) => {
      const c = connect(pgPort, '127.0.0.1')
      c.once('connect', () => {
        c.destroy()
        resolve(true)
      })
      c.once('error', () => resolve(false))
    })
  await waitFor('Postgres accepting connections', accepting, 30000)
  databaseUrl = `postgres://rehearsal@127.0.0.1:${pgPort}/postgres`
}
let backendOut = ''
let backend
// Off for every check that a post decides. restartWithSweep turns it on.
let sweepEnv = { ARC_VAULT_SWEEP: 'off' }
async function startBackend() {
  backend = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(backendDir, 'dist/http.js')], {
    cwd: backendDir,
    // Built from nothing on purpose. CCTP_EVM_SIGNER_KEY is on our list, has no committed address, and only a script ever signs with it.
    env: { PATH: process.env.PATH, HOME: work, PORT: String(backendPort), CCTP_EVM_SIGNER_KEY: ourEnvKey, ...sweepEnv, ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}) },
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
}
await startBackend()
say(`backend on port ${backendPort}, store ${databaseUrl ? 'a throwaway Postgres' : storeFile}`)

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
/** What the store holds: the file itself, or with Postgres what the list route read from it. */
const storeCount = async () => {
  if (databaseUrl) return (await getJson('/api/arc/vaults')).body.count
  return existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')).length : 0
}

// --- before anything ----------------------------------------------------------------------
section('before any vault')
const list0 = await getJson('/api/arc/vaults')
check(list0.status === 200 && list0.body.readable === true && list0.body.count === 0, 'GET /api/arc/vaults answers an empty, readable list')
check(list0.body.admission?.ready === true && list0.body.admission?.keysCompared === 1 + Object.values(OUR_KEY_PUBLIC_ADDRESSES).filter(Boolean).length, `the route says it can admit, with ${list0.body.admission?.keysCompared} keys compared: the one env key and the committed ones`)
check(list0.body.admission?.keysNotCompared?.includes('X402_3009_FUNDER_KEY') && !list0.body.admission.keysNotCompared.includes('CCTP_EVM_SIGNER_KEY'), 'and it names the keys it holds neither the key nor a committed address for')
check(list0.body.sweep?.on === false && list0.body.sweep.lastRun === null && list0.body.sweep.lastBlockRead === null, 'with ARC_VAULT_SWEEP=off the list says the sweep is off, and it has read nothing')
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
const rowsAfterRepeat = await storeCount()
check(rowsAfterRepeat === 1, `the store still holds ${rowsAfterRepeat} row`)
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

// The same reading of a revert as scripts/rehearse-arc-vault.mjs: the custom error, not any error.
section("the agent is bound: the revert is the contract's own error")
const revertSelector = async (call) => {
  try {
    await rpc('eth_call', [call, 'latest'])
    return 'no revert'
  } catch (e) {
    return typeof e.data === 'string' ? e.data.slice(0, 10).toLowerCase() : `no revert data: ${e.message}`
  }
}
const payCall = (units) => ({ from: agent.address, ...vaultCall(vault, 'pay', [agent.address, units]) })
const overCeiling = await revertSelector(payCall(AUTO_APPROVE_MAX + 1n))
check(overCeiling === toFunctionSelector('AboveAutoApprove()'), `a payment above the ceiling reverts with AboveAutoApprove (${overCeiling})`)
const frozenFreeze = await send(owner, vaultCall(vault, 'setFrozen', [true]))
const whileFrozen = await revertSelector(payCall(1000n))
check(frozenFreeze.receipt.status === '0x1' && whileFrozen === toFunctionSelector('IsFrozen()'), `a frozen vault reverts with IsFrozen (${whileFrozen})`)
await send(owner, vaultCall(vault, 'setFrozen', [false]))

// --- refusals ---------------------------------------------------------------------------------
section('a vault deployed by a key of ours')
await rpc('anvil_setBalance', [ourEnvAccount.address, toHex(10n ** 20n)])
const oursVault = await deployVault(ourEnvAccount, agent.address)
await setExpiry(ourEnvAccount, oursVault.vault)
const oursAnswer = await postVault(oursVault.hash)
const oursIds = (oursAnswer.body?.reasons ?? []).map((r) => r.id)
check(oursAnswer.body?.status === 'refused' && oursIds.length === 1 && oursIds[0] === 'owner-not-ours' && oursAnswer.body.retryable === false, 'a vault owned by a key in our env is refused, for good, for that reason alone')
check(!JSON.stringify(oursAnswer.body).includes('CCTP_EVM_SIGNER_KEY'), 'the refusal does not name the env var that holds the key')

const committed = committedOurKeys()
const committedAddress = getAddress(committed[0])
await rpc('anvil_impersonateAccount', [committedAddress])
await rpc('anvil_setBalance', [committedAddress, toHex(10n ** 20n)])
const committedData = encodeDeployData({ abi, bytecode, args: [committedAddress, agent.address, USDC, DAILY_CAP, AUTO_APPROVE_MAX] })
const committedTx = await rpc('eth_sendTransaction', [{ from: committedAddress, data: committedData, gas: toHex(3_000_000n) }])
const committedReceipt = await waitFor('the impersonated deploy', () => rpc('eth_getTransactionReceipt', [committedTx]))
check(committedReceipt.status === '0x1', `an impersonated deploy from the committed list (${committedAddress}) lands`)
const committedExpiry = await rpc('eth_sendTransaction', [{ from: committedAddress, ...vaultCall(getAddress(committedReceipt.contractAddress), 'setSessionKeyExpiry', [(await nowOnChain()) + 86400n]), gas: toHex(200000n) }])
await waitFor('the impersonated expiry', () => rpc('eth_getTransactionReceipt', [committedExpiry]))
await rpc('anvil_stopImpersonatingAccount', [committedAddress])
const committedAnswer = await postVault(committedTx)
const committedIds = (committedAnswer.body?.reasons ?? []).map((r) => r.id)
check(committedAnswer.body?.status === 'refused' && committedIds.length === 1 && committedIds[0] === 'owner-not-ours' && committedAnswer.body.retryable === false, 'a vault owned by a key on our committed list is refused, for good, for that reason alone')

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

section('real hosts are not all up: one stalls, one is rate-limited, one has no copy of the receipt')
const hostNames = chain.rpcUrls.map((u) => new URL(u).host)
writeFileSync(hostBehaviourFile, JSON.stringify({ [hostNames[0]]: 'stall', [hostNames[1]]: 'null', [hostNames[2]]: 'rate-limited' }))
const mixed = await deployVault(acct(9), agent.address)
await setExpiry(acct(9), mixed.vault)
const t0 = Date.now()
const mixedAnswer = await postVault(mixed.hash)
const mixedMs = Date.now() - t0
writeFileSync(hostBehaviourFile, '{}')
say(`answered in ${mixedMs} ms, with only ${hostNames[3]} fully up`)
check(mixedAnswer.body?.status === 'admitted', 'the deploy is admitted from the one host that has it')
if (mixedAnswer.body?.status !== 'admitted') console.log(JSON.stringify(mixedAnswer.body, null, 1))
check(mixedMs < 30000, 'the answer came inside the 30 seconds the proxy gives it')
check((await season()).milestone1.vaults.count === 3, 'the report counts 3 of 5')

section('hosts that disagree, or simulate wrongly, are not a verdict about the vault')
await rpc('anvil_setBalance', [acct(13).address, toHex(10n ** 20n)])
const doubted = await deployVault(acct(13), agent.address)
await setExpiry(acct(13), doubted.vault)
writeFileSync(hostBehaviourFile, JSON.stringify({ [hostNames[1]]: 'other-nonce' }))
const disagreed = await postVault(doubted.hash)
check(disagreed.body?.status === 'refused' && disagreed.body.retryable === true && disagreed.body.reasons.length === 1 && disagreed.body.reasons[0].id === 'creation-tx', 'hosts that disagree about the transaction: refused, and retryable')
writeFileSync(hostBehaviourFile, JSON.stringify(Object.fromEntries(hostNames.map((h) => [h, 'wrong-simulation']))))
const missimulated = await postVault(doubted.hash)
writeFileSync(hostBehaviourFile, '{}')
check(missimulated.body?.status === 'refused' && missimulated.body.retryable === true && missimulated.body.reasons.length === 1 && missimulated.body.reasons[0].id === 'runtime-code', 'a simulation that disagrees with a creation input that matched: refused, and retryable')
check(!/is not the vault contract/.test(missimulated.body?.reasons?.[0]?.reason ?? ''), `and its words do not blame the vault: ${missimulated.body?.reasons?.[0]?.reason}`)
check((await season()).milestone1.vaults.count === 3, 'neither is counted')
const undoubted = await postVault(doubted.hash)
check(undoubted.body?.status === 'admitted' && undoubted.body.alreadyAdmitted === false, 'with the hosts back, the same post is admitted: retryable was true')
check((await season()).milestone1.vaults.count === 4, 'the report counts 4 of 5')

section('things that are no vault')
const unknownHash = await postVault(toHex(BigInt(Date.now()), { size: 32 }))
check(unknownHash.body?.status === 'refused' && unknownHash.body.retryable === true && unknownHash.body.reasons.some((r) => r.id === 'receipt-found'), 'a hash no host knows is a retryable refusal')
const foreign = await send(foreignDeployer, { data: `0x${mock.evm.bytecode.object}` })
const foreignAnswer = await postVault(foreign.hash)
check(foreignAnswer.body?.status === 'refused' && foreignAnswer.body.reasons.some((r) => r.id === 'creation-input') && foreignAnswer.body.retryable === false, 'a contract that is not the vault is refused, for good')
const rowsAtEnd = await storeCount()
check(rowsAtEnd === 4, `the store holds exactly the ${rowsAtEnd} admitted vaults`)
const badHash = await postVault('0x1234')
check(badHash.status === 400 && badHash.body?.status === 'invalid', 'a malformed hash answers 400 invalid')
const notJson = await fetch(`${api}/api/arc/vaults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
check(notJson.status === 400, `a body that is not JSON answers 400 (${notJson.status})`)

section('a redeploy: the server restarts')
const exited = new Promise((r) => backend.once('exit', r))
backend.kill('SIGTERM')
await exited
await startBackend()
const afterRestart = await getJson('/api/arc/vaults')
check(afterRestart.body?.count === 4 && afterRestart.body.items.some((v) => v.address === vault), `the list survives it: ${afterRestart.body?.count} vaults`)
const afterRestartPost = await postVault(deployTx)
check(afterRestartPost.body?.alreadyAdmitted === true, 'a repeat after the restart is still a no-op')
const reread = await waitFor(
  'the report to read the actions again',
  async () => {
    const item = seasonItem(await season(), vault)
    return item?.actionsRead.state === 'complete' && BigInt(item.actionsRead.scannedToBlock) >= BigInt(viaWithdraw.receipt.blockNumber) ? item : null
  },
  90000,
)
check(reread.freezeTxs[0]?.txHash.toLowerCase() === ownerFreeze.hash.toLowerCase() && reread.withdrawTxs[0]?.txHash.toLowerCase() === ownerWithdraw.hash.toLowerCase(), "the cache is gone, and the report reads the owner's actions back from the chain")

// --- what left this process ---------------------------------------------------------------------
section('isolation')
const blocked = existsSync(blockedLog) ? [...new Set(readFileSync(blockedLog, 'utf8').trim().split('\n'))] : []
say(`outbound fetches the backend tried and this run refused: ${blocked.length ? blocked.join(', ') : 'none'}`)
check(!existsSync(join(repo, 'mcp/data/arc-admitted-vaults.json')) || !readFileSync(join(repo, 'mcp/data/arc-admitted-vaults.json'), 'utf8').includes(vault), 'nothing landed in the repo store')

// --- the same path through the page ---------------------------------------------------------------
// The built page under vite preview, with the browser's Arc Mainnet hosts routed to anvil, /api and
// /health routed to the local backend, and every other host refused. A stub wallet answers as an
// injected wallet does and signs with an anvil key, the same bridge scripts/rehearse-arc-vault.mjs
// uses. It cannot show a real wallet's own screens: those still need a person.
if (flag('--browser')) await browserRehearsal()
else {
  await restartWithSweep()
  await sweepWithNoPage()
}

/** A redeploy with the sweep on, ticking fast, from just after the fork: the blocks before it hold nobody from this run. */
async function restartWithSweep() {
  section("the server's own sweep: a redeploy turns it on")
  const exited = new Promise((r) => backend.once('exit', r))
  backend.kill('SIGTERM')
  await exited
  sweepEnv = { ARC_VAULT_SWEEP_EVERY_SECONDS: '2', ARC_VAULT_SWEEP_START_BLOCK: (forkBlock + 1n).toString() }
  await startBackend()
  const on = await getJson('/api/arc/vaults')
  check(on.body?.sweep?.on === true, 'the list says the sweep is on')
  check(Object.keys(on.body.sweep).sort().join() === 'lastBlockRead,lastProblem,lastRun,on', 'and says only what it read, when, and what went wrong')
}

/** The vault is on the list once the sweep has counted it. The blocks have to pass first: it stays short of the head. */
async function sweepCounts(address, ms = 120000) {
  await mine()
  return waitFor(
    `the sweep to count ${address}`,
    async () => {
      const row = (await getJson('/api/arc/vaults')).body?.items?.find((v) => v.address === address)
      if (row) return row
      await mine(1)
      return null
    },
    ms,
  ).catch(async (e) => {
    say(`the sweep says ${JSON.stringify((await getJson('/api/arc/vaults')).body?.sweep)} and the backend log ends:\n${backendOut.slice(-1500)}`)
    throw e
  })
}

/** Nobody's page asks: the hosts are as real ones have been, and the only thing that can count it is the sweep. */
async function sweepWithNoPage() {
  section("the server's own sweep: a vault no page ever asked about")
  const swept = acct(15)
  await rpc('anvil_setBalance', [swept.address, toHex(10n ** 20n)])
  const quiet = await deployVault(swept, agent.address)
  await mine()
  await new Promise((r) => setTimeout(r, 5000))
  const before = await storeCount()
  check((await getJson('/api/arc/vaults')).body.items.every((v) => v.address !== quiet.vault), 'with no end date it is not found: nothing about it says it is there yet')
  writeFileSync(hostBehaviourFile, JSON.stringify({ [hostNames[0]]: 'pruned', [hostNames[1]]: 'rate-limited' }))
  await setExpiry(swept, quiet.vault)
  const row = await sweepCounts(quiet.vault)
  writeFileSync(hostBehaviourFile, '{}')
  say(`row ${JSON.stringify({ address: row.address, deployTx: row.deployTx, ownerKind: row.ownerKind })}`)
  check(row.deployTx === quiet.hash.toLowerCase(), 'the sweep found the deploy hash from the chain alone, with one host pruned and one rate limited')
  check(row.owner === swept.address && row.ownerKind === 'unstated', 'the row is the same row: the owner the chain says, not identified')
  check(/own sweep/.test(row.note), 'and its note says who found it')
  check(Number((await getJson('/api/arc/vaults')).body.sweep.lastBlockRead) >= Number(quiet.block), 'the list says how far it has read')
  check(seasonItem(await season(), quiet.vault)?.deployTx === quiet.hash.toLowerCase(), 'GET /api/arc/season counts it')
  check((await storeCount()) >= before + 1, 'the store took it')

  section("the server's own sweep: what it may not count, and what it does not count twice")
  await waitFor('the sweep to reach the vaults of ours', async () => /refused for good [^\n]*owner-not-ours/.test(backendOut), 90000)
  const listed = (await getJson('/api/arc/vaults')).body.items
  check(listed.every((v) => v.address !== oursVault.vault && v.address !== getAddress(committedReceipt.contractAddress)), 'a vault owned by a key of ours has an end date too, and the same checks refuse it')
  const repeat = await postVault(quiet.hash)
  check(repeat.body?.status === 'admitted' && repeat.body.alreadyAdmitted === true, 'a page that asks about it afterwards hears it is already counted')
  const rows = await storeCount()
  const exited = new Promise((r) => backend.once('exit', r))
  backend.kill('SIGTERM')
  await exited
  backendOut = ''
  await startBackend()
  // Only a sweep that read past the vault with nothing wrong has said anything about it.
  await mine()
  const reread = await waitFor(
    'the restarted sweep to read past the vault with no problem',
    async () => {
      const sweep = (await getJson('/api/arc/vaults')).body.sweep
      return sweep?.lastRun && sweep.lastProblem === null && Number(sweep.lastBlockRead) >= Number(quiet.block) ? sweep : null
    },
    60000,
  )
  say(`after the restart the sweep says ${JSON.stringify(reread)}`)
  check((await storeCount()) === rows && (await getJson('/api/arc/vaults')).body.items.filter((v) => v.address === quiet.vault).length === 1, 'a restart reads it all again, past that vault, and adds no second row')
  check(!backendOut.includes(`counted ${quiet.vault.toLowerCase()}`), 'and it was on the list, so nothing asked about it again')
}

async function browserRehearsal() {
  section('the page: building it and serving it')
  const siteDir = join(work, 'site')
  const built = spawnSync(join(repo, 'node_modules/.bin/vite'), ['build', '--outDir', siteDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, VITE_DOCS_URL: 'https://a-identity.mintlify.site' } })
  if (built.status !== 0) throw new Error(`vite build failed: ${(built.stdout + built.stderr).slice(-800)}`)
  const sitePort = await freePort()
  const base = `http://127.0.0.1:${sitePort}`
  const preview = spawn(join(repo, 'node_modules/.bin/vite'), ['preview', '--outDir', siteDir, '--port', String(sitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: repo, stdio: 'ignore' })
  children.push(preview)
  await waitFor('vite preview answering', async () => (await fetch(base)).ok, 30000)
  say(`vite preview on port ${sitePort}`)

  const { chromium } = await mod('node_modules/playwright/index.mjs')
  const browser = await chromium.launch()
  const rpcHosts = new Set(chain.rpcUrls.map((u) => new URL(u).host))
  const CHAIN_HEX = toHex(chain.evmChainId)
  const refused = new Set()

  /**
   * One owner in one browser profile: a stub wallet, the routing, and helpers to read the page.
   * failPost(n) is asked about the nth POST to /api/arc/vaults, and may wait; true answers it 503, and
   * 429 answers it as the route's limiter does. failSeason makes GET /api/arc/season fail, so the
   * page's list does not load. holdSeason and holdProof keep their route unanswered until they resolve.
   */
  async function ownerBrowser({ ownerIndex, agentIndex, failPost = async () => false, failSeason = () => false, holdSeason = async () => {}, holdProof = async () => {} }) {
    const owner = acct(ownerIndex)
    const agent = acct(agentIndex)
    if (ownerIndex > 9) await rpc('anvil_setBalance', [owner.address, toHex(10n ** 20n)])
    await send(foreignDeployer, { to: USDC, data: encodeFunctionData({ abi: MOCK, functionName: 'mint', args: [owner.address, parseUnits('5', 6)] }) })
    const wallet = { chainHex: '0x1', added: new Set(['0x1']), connected: false, sent: [] }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    let page
    const emit = (event, value) => page?.evaluate(([e, v]) => window.__walletEmit?.(e, v), [event, value]).catch(() => {})
    async function walletRequest(method, params) {
      switch (method) {
        case 'eth_requestAccounts':
          wallet.connected = true
          return [owner.address]
        case 'eth_accounts':
          return wallet.connected ? [owner.address] : []
        case 'eth_chainId':
          return wallet.chainHex
        case 'net_version':
          return String(parseInt(wallet.chainHex, 16))
        case 'wallet_switchEthereumChain': {
          const id = String(params[0].chainId).toLowerCase()
          if (!wallet.added.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
          wallet.chainHex = id
          void emit('chainChanged', id)
          return null
        }
        case 'wallet_addEthereumChain':
          wallet.added.add(String(params[0].chainId).toLowerCase())
          return null
        case 'eth_sendTransaction': {
          const tx = params[0]
          if (wallet.chainHex !== CHAIN_HEX) throw Object.assign(new Error(`wallet is on ${wallet.chainHex}`), { code: -32000 })
          if (String(tx.from).toLowerCase() !== owner.address.toLowerCase()) throw Object.assign(new Error('from is not the account'), { code: 4100 })
          const nonce = Number(await rpc('eth_getTransactionCount', [owner.address, 'pending']))
          const raw = await owner.signTransaction({ type: 'eip1559', chainId: chain.evmChainId, nonce, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: 0n, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) })
          const hash = await rpc('eth_sendRawTransaction', [raw])
          wallet.sent.push({ hash, to: tx.to ?? null })
          return hash
        }
        default:
          if (wallet.chainHex !== CHAIN_HEX) throw Object.assign(new Error(`read on ${wallet.chainHex} not served`), { code: 4200 })
          return rpc(method, params ?? [])
      }
    }
    await ctx.exposeBinding('__walletBridge', async (_src, method, params) => {
      try {
        return { ok: true, result: await walletRequest(method, params) }
      } catch (e) {
        return { ok: false, code: e.code ?? -32603, message: e.message, data: e.data }
      }
    })
    await ctx.addInitScript(() => {
      const listeners = {}
      window.__walletEmit = (e, v) => (listeners[e] ?? []).forEach((f) => f(v))
      const provider = {
        isRehearsal: true,
        async request({ method, params }) {
          const r = await window.__walletBridge(method, params)
          if (r.ok) return r.result
          throw Object.assign(new Error(r.message), { code: r.code, data: r.data })
        },
        on(e, f) {
          ;(listeners[e] ??= []).push(f)
        },
        removeListener(e, f) {
          listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)
        },
      }
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: { uuid: 'rehearsal-1', name: 'RehearsalWallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.rehearsal' }, provider }),
          }),
        )
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    })

    const posts = []
    const seasonReads = { count: 0 }
    await ctx.route('**/*', async (route, request) => {
      const url = new URL(request.url())
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
      if (rpcHosts.has(url.host)) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        const res = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.postData() })
        return route.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: Buffer.from(await res.arrayBuffer()) })
      }
      if (url.origin === base && (url.pathname.startsWith('/api/') || url.pathname === '/health')) {
        if (request.method() === 'POST' && url.pathname === '/api/arc/vaults') {
          posts.push(url.pathname)
          const failing = await failPost(posts.length)
          if (failing === 429) {
            return route.fulfill({ status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' }, body: JSON.stringify({ error: 'Too many requests. Slow down and try again in a minute.' }) })
          }
          if (failing) {
            return route.fulfill({ status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'unavailable', retryable: true, reason: 'held by the rehearsal' }) })
          }
        }
        if (url.pathname === '/api/arc/season') {
          seasonReads.count++
          if (failSeason()) return route.fulfill({ status: 503, headers: { 'content-type': 'application/json' }, body: '{}' })
          await holdSeason()
        }
        if (url.pathname === '/api/proof/arc') await holdProof()
        const headers = { 'content-type': request.headers()['content-type'] ?? 'application/json', accept: 'application/json' }
        const res = await fetch(`${api}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.method() === 'POST' ? request.postData() : undefined })
        return route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await res.arrayBuffer()) })
      }
      if (url.origin === base || url.protocol === 'data:') return route.continue()
      refused.add(url.host)
      return route.abort()
    })

    page = await ctx.newPage()
    const pageErrors = []
    ctx.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300))))
    page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)))
    const text = () => page.evaluate(() => document.getElementById('root')?.innerText ?? '')
    const waitText = async (re, ms = 60000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (re.test(await text())) return true
        await page.waitForTimeout(250)
      }
      return false
    }
    const stopIf = async (ok, what) => {
      check(ok, what)
      if (!ok) {
        console.log('--- page text at the failure ---\n' + (await text()).slice(-1800))
        await page.screenshot({ path: join(work, `failed-${ownerIndex}.png`), fullPage: true }).catch(() => {})
        await browser.close()
        finish(1)
      }
    }

    const connect = async () => {
      await page.getByRole('button', { name: 'Connect wallet' }).first().waitFor({ timeout: 30000 })
      await page.getByRole('button', { name: 'Connect wallet' }).first().click()
      await page.getByRole('button', { name: 'RehearsalWallet' }).click()
      await stopIf(await waitText(/RehearsalWallet connected/), 'the wallet connects')
    }
    /** The notice that says whether this vault counts, by what only it says. */
    const noticeSays = async () => (await text()).split('\n').find((l) => /on a-identity\.xyz\/proof\/arc|counts? on a-identity|counted on/.test(l)) ?? '(no line about the count)'
    return { ctx, owner, agent, wallet, posts, seasonReads, pageErrors, text, waitText, stopIf, connect, noticeSays, page, newPage: async () => (page = await ctx.newPage()), current: () => page }
  }

  /** The deploy flow from the form to the moment the deploy has landed and the end date is asked for. */
  async function deployFromThePage(b, funding = '0.1') {
    const { agent, wallet, waitText, stopIf, connect, current } = b
    const page = current()
    await page.goto(`${base}/app/vault/arc?network=${encodeURIComponent(chain.caip2)}&deploy=1`, { waitUntil: 'domcontentloaded' })
    await connect()
    await page.fill('#deploy-operator', agent.address)
    await page.fill('#deploy-funding', funding)
    await page.getByRole('button', { name: 'Review the deploy' }).click()
    await stopIf(await waitText(/Review: create your vault/, 60000), 'the deploy is prepared and simulated on the fork')
    await page.getByRole('button', { name: 'Deploy from my wallet' }).click()
    await stopIf(await waitText(/Set it now/, 90000), 'the deploy lands and the end-date step opens')
    const receipt = await rpc('eth_getTransactionReceipt', [wallet.sent[0].hash])
    const vault = getAddress(receipt.contractAddress)
    say(`vault ${vault}, deploy ${wallet.sent[0].hash}`)
    check(wallet.chainHex === CHAIN_HEX, 'the page moved the wallet to Arc Mainnet')
    return { vault, hash: wallet.sent[0].hash }
  }

  const rowsFor = async (vault) => (await getJson('/api/arc/vaults')).body.items.filter((v) => v.address === vault).length

  /** The route takes 10 posts a minute from one address, and every run here comes from one. */
  const waitOutPostWindow = async () => {
    say('waiting out the 10-a-minute window on the route')
    await new Promise((r) => setTimeout(r, 61000))
  }

  /** The gap this guards: an owner who sets the end date from the vault's page and never returns to the deploy flow. */
  async function vaultPageRun({ ownerIndex, agentIndex }) {
    section('the page: the end date is set from the vault page, and the owner never goes back to the setup')
    const b = await ownerBrowser({ ownerIndex, agentIndex })
    const { ctx, wallet, posts, pageErrors, waitText, stopIf, noticeSays } = b
    const page = b.current()
    const { vault, hash } = await deployFromThePage(b, '0')
    check(posts.length === 0, 'the setup has not asked: the agent key has no end date')
    await page.getByRole('button', { name: 'Back to vaults' }).click()
    await stopIf(await waitText(/IS the owner of this vault/, 60000), 'with no vault in the link the page opens the one this browser deployed, not ours')
    check(new URL(page.url()).searchParams.get('contract')?.toLowerCase() === vault.toLowerCase(), 'the link now names that vault')
    await stopIf(await waitText(/can count on .* once its agent key has an end date/, 30000), 'the vault page says what it is waiting for, without calling the vault counted or refused')
    say(`the vault page says: ${await noticeSays()}`)
    check(posts.length === 0, 'it has not asked either, with no end date to show')
    const sentBefore = wallet.sent.length
    await page.getByRole('button', { name: 'Set the expiry' }).click()
    await waitFor('the end date on chain', async () => (await read(vault, 'sessionKeyExpiry')) !== 0n, 60000)
    check(wallet.sent.length === sentBefore + 1, 'setting it took the one transaction the owner signed')
    await stopIf(await waitText(/This vault is now counted on/, 60000), 'the vault page says this vault is counted, by itself')
    say(`the vault page says: ${await noticeSays()}`)
    check(posts.length === 1, `the page asked once (${posts.length}), with the deploy hash this browser held`)
    check(wallet.sent.length === sentBefore + 1, 'asking prompted no wallet: no transaction, nothing to sign')
    const item = seasonItem(await season(), vault)
    check(item?.ownerKind === 'unstated' && item.deployTx === hash.toLowerCase(), 'GET /api/arc/season counts it, under the hash the wallet sent, owner not identified')
    check((await rowsFor(vault)) === 1, 'GET /api/arc/vaults holds one row for it')
    const before = await storeCount()
    await page.reload({ waitUntil: 'domcontentloaded' })
    check(await waitText(/This vault is now counted on/, 40000), 'after a reload the vault page still says it is counted')
    check((await rowsFor(vault)) === 1 && (await storeCount()) === before, 'the reload added no second row')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
  }

  /** The setup itself offers this: forget the setup, and set the end date from the vault's page. Forgetting must not lose the hash. */
  async function forgottenSetupRun({ ownerIndex, agentIndex }) {
    section('the page: the owner forgets the setup, then sets the end date from the vault page')
    const b = await ownerBrowser({ ownerIndex, agentIndex })
    const { ctx, posts, pageErrors, waitText, stopIf } = b
    const page = b.current()
    const { vault } = await deployFromThePage(b, '0')
    await page.getByRole('button', { name: 'Forget this setup' }).click()
    check(await page.evaluate(() => localStorage.getItem('aid-arc-vault-setup')) === null, 'the setup slot is empty')
    await page.getByRole('button', { name: 'Back to vaults' }).click()
    await stopIf(await waitText(/IS the owner of this vault/, 60000), 'the page still opens the vault this browser deployed')
    await page.getByRole('button', { name: 'Set the expiry' }).click()
    await stopIf(await waitText(/This vault is now counted on/, 90000), 'the vault is counted from the hash kept when its deploy settled')
    check(posts.length === 1 && (await rowsFor(vault)) === 1, 'one question, one row')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
  }

  /** The owner closes the tab with the first question failed, and comes back on a bare link with no wallet connected. */
  async function closedTabRun({ ownerIndex, agentIndex }) {
    section('the page: the tab closes after a failed first question, and the owner comes back with no wallet connected')
    let serverDown = true
    const b = await ownerBrowser({ ownerIndex, agentIndex, failPost: async () => serverDown })
    const { ctx, wallet, posts, pageErrors, waitText, stopIf } = b
    const first = b.current()
    const { vault } = await deployFromThePage(b, '0')
    await first.getByRole('button', { name: /Set it now/ }).click()
    await waitFor('the first question', () => posts.length === 1, 60000)
    await first.waitForTimeout(500)
    check((await rowsFor(vault)) === 0, 'the question failed: nothing is on the list')
    await first.close()
    serverDown = false
    const page = await b.newPage()
    const sentBefore = wallet.sent.length
    wallet.connected = false
    await page.goto(`${base}/app/vault/arc`, { waitUntil: 'domcontentloaded' })
    await stopIf(await waitText(/This vault is now counted on/, 90000), 'it is asked about again and counted, with no wallet connected and no person involved')
    check(new URL(page.url()).searchParams.get('contract')?.toLowerCase() === vault.toLowerCase(), 'a bare link opened the vault this browser deployed')
    check((await rowsFor(vault)) === 1, 'one row')
    check(wallet.sent.length === sentBefore, 'nothing was sent')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
    return vault
  }

  /** Another device, or cleared storage: no hash in this browser. The page says what it can know, asks nothing it cannot ask, and a refusal stands. */
  async function otherDeviceRun({ countedVault, ownerIndex, agentIndex }) {
    section('the page: another device, with no deploy hash in this browser')
    let seasonDown = false
    let seasonHeld = Promise.resolve()
    let proofHeld = Promise.resolve()
    const b = await ownerBrowser({ ownerIndex, agentIndex, failSeason: () => seasonDown, holdSeason: () => seasonHeld, holdProof: () => proofHeld })
    const { ctx, posts, seasonReads, pageErrors, waitText, stopIf, connect, text, noticeSays } = b
    const page = b.current()
    const open = (address) => page.goto(`${base}/app/vault/arc?network=${encodeURIComponent(chain.caip2)}&contract=${address}`, { waitUntil: 'domcontentloaded' })
    // What the page says needs only the season report. /api/proof/arc is slow in this run, because it
    // re-reads Arc testnet live and those hosts are refused above, so an answer inside this wait
    // shows the notice does not wait for it.
    const LIST_WAIT = 20000
    const t0 = Date.now()
    const proofStatus = (await getJson('/api/proof/arc')).status
    say(`GET /api/proof/arc answered ${proofStatus} in ${Date.now() - t0} ms`)
    await open(countedVault)
    await connect()
    await stopIf(await waitText(/This vault is now counted on/, LIST_WAIT), 'a counted vault reads as counted from the server list')
    check(posts.length === 0, 'and nothing is posted: this browser holds no hash, and none was needed')

    // Deployed and bounded by the same owner on another device, and never counted.
    const other = await deployVault(acct(ownerIndex), acct(agentIndex).address)
    await setExpiry(acct(ownerIndex), other.vault)
    await open(other.vault)
    // The sweep is off until restartWithSweep, and the list says so, so the page must not say it is looking.
    await stopIf(await waitText(/This vault is not counted on .* yet\. Our server is not looking for vaults on the chain right now, so open this vault in the browser that deployed it/, LIST_WAIT), 'an uncounted vault says it is not on the list, and with the sweep off it says nobody is looking and what still works')
    say(`the vault page says: ${await noticeSays()}`)
    check(!/our server looks for vaults/.test(await text()), 'it does not claim a search that is not running')
    check(posts.length === 0 && (await rowsFor(other.vault)) === 0, 'nothing is posted and no row appears: no hash, no question')

    seasonDown = true
    let answerProof
    proofHeld = new Promise((r) => (answerProof = r))
    await open(other.vault)
    await stopIf(await waitText(/We could not find out whether this vault counts on/, LIST_WAIT), 'a list that did not load is said to be that')
    const screen = await text()
    check(!/This vault is not counted on/.test(screen) && !/This vault is now counted on/.test(screen), 'and is presented as neither counted nor not counted')
    check(/Our server could not give its list of counted vaults just now/.test(screen), 'and it says what happened, not that the server did not answer')
    seasonDown = false

    // Try again, with the first load's proof read still out: that read ends with no season report,
    // and it used to land after this one and overwrite it.
    let answerSeason
    seasonHeld = new Promise((r) => (answerSeason = r))
    const readsBefore = seasonReads.count
    await page.getByRole('button', { name: 'Try again' }).click()
    check(await waitText(/Checking whether this vault counts on/, 3000), 'Try again goes back to Checking at once, so the click shows')
    check((await page.getByRole('button', { name: 'Try again' }).count()) === 0, 'and offers no second click while it reads')
    answerSeason()
    seasonHeld = Promise.resolve()
    await stopIf(await waitText(/This vault is not counted on .* yet\. Our server is not looking for vaults/, LIST_WAIT), 'the answer replaces it')
    check(seasonReads.count === readsBefore + 1, `one click, one read of the list (${seasonReads.count - readsBefore})`)
    answerProof()
    proofHeld = Promise.resolve()
    await page.waitForTimeout(3000)
    check(/This vault is not counted on .* yet\./.test(await text()), "the first load's read, landing late, does not overwrite the newer answer")

    // The page's memory is not evidence. A hash claimed for a vault it did not create, or for one our
    // key owns, goes to the same checks and is refused on the same grounds.
    const foreignHash = oursVault.hash
    await page.evaluate(
      ([network, vault, hash]) => localStorage.setItem('aid-arc-vault-deploys', JSON.stringify([{ network, vault, hash }])),
      [chain.caip2, other.vault, foreignHash],
    )
    await open(other.vault)
    await stopIf(await waitText(/This vault is not counted on a-identity\.xyz\/proof\/arc, for this reason/, 60000), "a hash this browser's storage claims for this vault is checked like any other, and refused")
    say(`the vault page says: ${await noticeSays()}`)
    check((await rowsFor(other.vault)) === 0 && (await rowsFor(oursVault.vault)) === 0, 'neither vault gets a row')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
    return other
  }

  /** What a browser with no hash says with the sweep on, for each thing the vault's end date can read as. The page's prop decides this, so only the page can prove it. */
  async function noHashWordsRun({ ownerIndex, agentIndex }) {
    section('the page: with the sweep on and no hash, it says what the end date reads as')
    const b = await ownerBrowser({ ownerIndex, agentIndex })
    const { ctx, posts, pageErrors, text, waitText, stopIf, connect, noticeSays } = b
    const page = b.current()
    const open = (address) => page.goto(`${base}/app/vault/arc?network=${encodeURIComponent(chain.caip2)}&contract=${address}`, { waitUntil: 'domcontentloaded' })
    const { vault } = await deployVault(acct(ownerIndex), acct(agentIndex).address)

    await open(vault)
    await connect()
    await stopIf(await waitText(/yet, because its agent key has no end date\. Set one from this page\. You do not have to send anything to anyone: our server looks for vaults/, 30000), 'no end date: it says so, says to set one, and says the server then finds it')
    say(`the vault page says: ${await noticeSays()}`)
    check(!/has the agent key end date it looks for/.test(await text()), 'and it does not claim a date the vault does not have')

    await setExpiry(acct(ownerIndex), vault)
    await open(vault)
    await stopIf(await waitText(/yet\. You do not have to send anything to anyone: our server looks for vaults on the chain by itself, and this one has the agent key end date it looks for/, 30000), 'a date in the future: it says this one has what the server looks for')

    // Revoked is the date a second after the epoch, which the page reads as passed.
    await send(acct(ownerIndex), vaultCall(vault, 'setSessionKeyExpiry', [1n]))
    await open(vault)
    await stopIf(await waitText(/yet, because its agent key's end date has passed\. Set a new one from this page\. .*within about an hour of the new end date/, 30000), 'a revoked key: it says the date has passed, to set a new one, and when the server finds it again')
    say(`the vault page says: ${await noticeSays()}`)
    const said = await text()
    check(!/has the agent key end date it looks for/.test(said) && !/tell the A-Identity team/.test(said), 'and it neither claims a date the server wants nor sends anyone to a person')
    check(posts.length === 0, 'nothing is posted: no hash, no question')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
  }

  /** The gap the sweep closes: the owner's page never gets a question through, and the tab can close. */
  async function blockedPostRun({ ownerIndex, agentIndex }) {
    section("the page: every question is blocked, and the server's own sweep counts the vault")
    const b = await ownerBrowser({ ownerIndex, agentIndex, failPost: async () => true })
    const { ctx, wallet, posts, pageErrors, waitText, stopIf } = b
    const page = b.current()
    const { vault, hash } = await deployFromThePage(b, '0')
    await page.getByRole('button', { name: 'Back to vaults' }).click()
    await stopIf(await waitText(/IS the owner of this vault/, 60000), 'the page opens the vault this browser deployed')
    await page.getByRole('button', { name: 'Set the expiry' }).click()
    await waitFor('the end date on chain', async () => (await read(vault, 'sessionKeyExpiry')) !== 0n, 60000)
    await stopIf(await waitText(/We could not find out whether this vault counts on/, 60000), 'the page says its question failed')
    check(posts.length >= 1, `the page asked and was blocked (${posts.length})`)
    check((await rowsFor(vault)) === 0, 'nothing is on the list yet: the sweep stays short of the head')
    const row = await sweepCounts(vault)
    check(row.deployTx === hash.toLowerCase(), 'the sweep counts it under the hash the wallet sent, with no question from the page')
    check(row.ownerKind === 'unstated' && /own sweep/.test(row.note), 'the same row, and its note says who found it')
    const sentBefore = wallet.sent.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await stopIf(await waitText(/This vault is now counted on/, 40000), 'after a reload the vault page says it is counted')
    // The page may still ask before its list arrives. That question is blocked here too, and a yes from the list stands.
    await page.waitForTimeout(3000)
    check(/This vault is now counted on/.test(await b.text()) && !/could not find out/.test(await b.text()), 'a question that still fails does not take the answer away')
    check((await rowsFor(vault)) === 1, 'the reload added no second row')
    check(wallet.sent.length === sentBefore, 'no wallet was asked for anything')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
    return vault
  }

  /** The limit on the route is shared through the site's proxy, so a real owner can meet a 429 they did nothing to earn. */
  async function rateLimitedRun({ ownerIndex, agentIndex }) {
    section('the page: the first question meets a 429')
    const asked = []
    const b = await ownerBrowser({
      ownerIndex,
      agentIndex,
      failPost: async (n) => {
        asked.push(Date.now())
        return n === 1 ? 429 : false
      },
    })
    const { ctx, wallet, posts, pageErrors, waitText, stopIf, noticeSays } = b
    const page = b.current()
    const { vault } = await deployFromThePage(b, '0')
    await page.getByRole('button', { name: 'Back to vaults' }).click()
    await stopIf(await waitText(/IS the owner of this vault/, 60000), 'the page opens the vault this browser deployed')
    const sentBefore = wallet.sent.length
    await page.getByRole('button', { name: 'Set the expiry' }).click()
    await stopIf(await waitText(/Our server is taking too many of these checks right now/, 60000), 'the page says the server is limiting checks')
    const said = await noticeSays()
    say(`the vault page says: ${said}`)
    check(!/your connection|this connection/i.test(said), "and does not put it down to the owner's connection")
    check(/Your vault is not affected/.test(said), 'and says the vault is not affected')
    await stopIf(await waitText(/This vault is now counted on/, 100000), 'it asks again by itself and is counted')
    check(posts.length === 2 && asked[1] - asked[0] >= 60000, `the page waited out the limit's minute before asking again (${asked[1] - asked[0]} ms)`)
    check((await rowsFor(vault)) === 1, 'one row')
    check(wallet.sent.length === sentBefore + 1, 'no wallet was asked for anything but the end date')
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
  }

  /** One owner, from a fresh browser profile. flaky answers the first POST 503 only once the last screen is up, and the second 503 at once. */
  async function ownerRun({ label, ownerIndex, agentIndex, flaky = false, ownerActions = false }) {
    section(`the page: ${label}`)
    let lastScreen
    const lastScreenUp = new Promise((resolve) => (lastScreen = resolve))
    const failPost = async (n) => {
      if (!flaky || n > 2) return false
      if (n === 1) await lastScreenUp
      return true
    }
    const b = await ownerBrowser({ ownerIndex, agentIndex, failPost })
    const { ctx, wallet, posts, pageErrors, text, waitText, stopIf } = b
    const page = b.current()
    const { vault } = await deployFromThePage(b)
    await page.getByRole('button', { name: /Set it now/ }).click()
    await stopIf(await waitText(/Confirmation 3 of 3: put USDC in the vault/, 90000), 'the end date lands and the funding step opens')
    await page.getByRole('button', { name: 'Review', exact: true }).first().click()
    const confirmFund = page.getByRole('button', { name: /Confirm in wallet|Send .*USDC|Put .*USDC/i }).first()
    await confirmFund.waitFor({ timeout: 60000 })
    await confirmFund.click()
    await stopIf(await waitText(/Your vault is set up/, 90000), 'the funding lands and the setup ends')
    lastScreen()

    const counted = await waitText(/This vault is now counted on/, 40000)
    const screen = await text()
    const notice = screen.split('\n').find((l) => /counted on|counts on|count on/.test(l))
    say(`the last screen says: ${notice ?? '(no line about the count)'}`)
    await page.screenshot({ path: join(work, `setup-done-${ownerIndex}.png`), fullPage: true }).catch(() => {})
    await stopIf(counted, 'the last screen says this vault is counted')
    check(!/Try again|could not find out/.test(screen.slice(screen.indexOf('Your vault is set up'))), 'the last screen offers no retry for a vault that counted')
    say(`the page sent ${posts.length} POST(s) to /api/arc/vaults`)
    if (flaky) check(posts.length === 3, 'the last screen asked when the first question came back failed, and once more by itself when that failed too')
    else check(posts.length === 1, 'the page asked once: a vault already counted is not asked about again')
    const listed = await getJson('/api/arc/vaults')
    check(listed.body.items.some((v) => v.address === vault), 'GET /api/arc/vaults lists the vault the page deployed')
    const item = seasonItem(await season(), vault)
    check(item?.ownerKind === 'unstated' && item.deployTx === wallet.sent[0].hash.toLowerCase(), 'GET /api/arc/season counts it, under the hash the wallet sent')

    await page.reload({ waitUntil: 'domcontentloaded' })
    check(await waitText(/This vault is now counted on/, 40000), 'after a reload the last screen still says it is counted')
    check((await getJson('/api/arc/vaults')).body.items.filter((v) => v.address === vault).length === 1, 'the reload added no second row')

    if (ownerActions) {
      await page.getByRole('button', { name: 'Open the vault' }).click()
      await stopIf(await waitText(/IS the owner of this vault/, 60000), 'the vault page recognises its owner')
      await waitText(/Freeze the vault/, 30000)
      await page.getByRole('button', { name: 'Freeze the vault' }).click()
      await stopIf(await waitFor('the freeze', async () => (await read(vault, 'frozen')) === true, 60000), 'the freeze lands from the page')
      const freezeHash = wallet.sent.at(-1).hash.toLowerCase()
      await page.waitForTimeout(3000)
      const amount = await page.locator('[id^="withdraw-amount-"]').first().getAttribute('id')
      await page.fill(`#${amount}`, '0.02')
      await page.locator('form', { has: page.locator(`#${amount}`) }).getByRole('button', { name: 'Review', exact: true }).click()
      await stopIf(await waitText(/Review: .*0\.02 USDC/, 60000), 'the withdrawal is reviewed before the wallet')
      const before = await read(vault, 'balance')
      await page.getByRole('button', { name: 'Confirm in wallet' }).click()
      await waitFor('the withdrawal', async () => (await read(vault, 'balance')) !== before, 60000)
      const withdrawHash = wallet.sent.at(-1).hash.toLowerCase()
      await mine()
      const after = await waitFor(
        'the report to show what the page signed',
        async () => {
          const it = seasonItem(await season(), vault)
          return it?.freezeTxs.length && it?.withdrawTxs.length ? it : null
        },
        90000,
      )
      check(after.freezeTxs[0].txHash.toLowerCase() === freezeHash && after.withdrawTxs[0].txHash.toLowerCase() === withdrawHash, 'the report shows the freeze and the withdrawal the page signed')
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
    await ctx.close()
    return vault
  }

  await ownerRun({ label: 'an owner goes all the way', ownerIndex: 6, agentIndex: 7, ownerActions: true })
  await ownerRun({ label: 'the server fails twice, the first time while the last screen comes up', ownerIndex: 8, agentIndex: 7, flaky: true })
  await waitOutPostWindow()
  await vaultPageRun({ ownerIndex: 10, agentIndex: 7 })
  await forgottenSetupRun({ ownerIndex: 11, agentIndex: 7 })
  await waitOutPostWindow()
  const closedTabVault = await closedTabRun({ ownerIndex: 12, agentIndex: 7 })
  const otherDevice = await otherDeviceRun({ countedVault: closedTabVault, ownerIndex: 12, agentIndex: 7 })
  await rateLimitedRun({ ownerIndex: 14, agentIndex: 7 })

  await restartWithSweep()
  await sweepWithNoPage()
  section("the server's own sweep: the vault from another device, that no page could ask about")
  const otherRow = await sweepCounts(otherDevice.vault)
  check(otherRow.deployTx === otherDevice.hash.toLowerCase(), 'it is counted, under its real deploy hash, and not the one a browser had claimed for it')
  await noHashWordsRun({ ownerIndex: 17, agentIndex: 7 })
  await blockedPostRun({ ownerIndex: 16, agentIndex: 7 })
  await browser.close()
  say(`hosts the browser tried and this run refused: ${[...refused].join(', ') || 'none'}`)
}

finish(0)
