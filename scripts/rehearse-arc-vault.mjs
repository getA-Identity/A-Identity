#!/usr/bin/env node
/**
 * The vault page on a real chain: /app/vault/arc on Arc TESTNET, with real transactions and no
 * mock of the chain. The checks in mcp/src/frontend-arc-vault.test.ts drive the page's rules with
 * a fake wallet; this drives the page itself, in a browser, the way an owner does.
 *
 * A throwaway wallet held in this process answers the page as an injected wallet does: it announces
 * itself over EIP-6963, starts on Ethereum (0x1) with Arc unknown, adds and switches when asked, and
 * signs and broadcasts with the fees the page asked for. Its keys live in a 0600 file under outDir,
 * which must be gitignored, and are never printed. Test money only: it refuses to run on any chain
 * but Arc testnet, and it never touches a key from the environment.
 *
 * What it does: connect, deploy, set the expiry, fund, open the vault page, run the admission script
 * as a rehearsal, pay from the vault with the agent's own key, get a payment above the ceiling
 * refused, freeze, unfreeze, withdraw, reload. What it cannot show: a real wallet's own screens, and
 * how a real wallet prices a transaction. Those need a person with MetaMask or Rabby.
 *
 * Usage: npm run build (root and mcp), then
 *        node scripts/rehearse-arc-vault.mjs <baseUrl> [outDir] [vault deployTx]
 *        node scripts/rehearse-arc-vault.mjs https://a-identity.xyz _internal/arc-rehearsal
 * The first run prints the owner address: send it about 0.25 test USDC from faucet.circle.com.
 * With vault and deployTx it skips the setup and rehearses on that vault.
 * Exit: 0 all checks passed, 1 a check failed, 2 usage, 3 the owner needs test USDC.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const [base, outDir = '_internal/arc-rehearsal', resumeVault, resumeDeployTx] = process.argv.slice(2)
if (!base) {
  console.error('usage: rehearse-arc-vault.mjs <baseUrl> [outDir] [vault deployTx]')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const mod = (p) => import(pathToFileURL(join(repo, p)).href)
const { chromium } = await mod('node_modules/playwright/index.mjs')
const viem = await mod('node_modules/viem/_esm/index.js')
const { generatePrivateKey, privateKeyToAccount } = await mod('node_modules/viem/_esm/accounts/index.js')
const { getChainById } = await mod('mcp/dist/chains/registry.js')
const art = await mod('mcp/dist/contracts/AgentSpendPolicy.js')
const { encodeFunctionData, decodeFunctionResult, formatUnits, parseUnits, parseAbi, toHex } = viem

const chain = getChainById('arc')
const CHAIN_ID = chain.evmChainId
const CHAIN_HEX = toHex(CHAIN_ID)
if (CHAIN_ID !== 5042002 || !chain.testnet) throw new Error('this rehearsal is for Arc testnet only')
const USDC = chain.contracts.usdc
const RPCS = chain.rpcUrls
const abi = art.AgentSpendPolicyAbi
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])

// --- keys: throwaway, kept on disk so a failed run does not strand its test funds ---
const keyFile = join(outDir, 'testnet-wallet.json')
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, JSON.stringify({ note: 'Arc testnet rehearsal only', ownerKey: generatePrivateKey(), agentKey: generatePrivateKey() }))
  chmodSync(keyFile, 0o600)
}
const keys = JSON.parse(readFileSync(keyFile, 'utf8'))
const owner = privateKeyToAccount(keys.ownerKey)
const agent = privateKeyToAccount(keys.agentKey)
console.log('owner', owner.address, '\nagent', agent.address)

// --- a small RPC client that moves to the next host when one fails ---
let rpcId = 1
async function rpc(method, params = [], attempt = 0) {
  let last
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        signal: AbortSignal.timeout(20000),
      })
      const j = await res.json()
      if (j.error) {
        const e = new Error(j.error.message)
        e.code = j.error.code
        e.data = j.error.data
        throw e
      }
      return j.result
    } catch (e) {
      last = e
      const limited = e.code === -32005 || /rate limit|too many/i.test(String(e.message))
      if (e.code !== undefined && !limited) throw e // the chain answered: a revert is not a host failure
    }
  }
  if (attempt < 6) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    return rpc(method, params, attempt + 1)
  }
  throw last
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nativeOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']))
async function receiptOf(hash, ms = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null)
    if (r) return r
    await sleep(700)
  }
  throw new Error(`no receipt for ${hash} in ${ms} ms`)
}
async function signAndSend(account, { to, data, gas, maxFeePerGas, maxPriorityFeePerGas }) {
  const nonce = Number(await rpc('eth_getTransactionCount', [account.address, 'pending']))
  const raw = await account.signTransaction({ type: 'eip1559', chainId: CHAIN_ID, nonce, ...(to ? { to } : {}), data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas })
  return rpc('eth_sendRawTransaction', [raw])
}
async function fees() {
  const price = BigInt(await rpc('eth_gasPrice'))
  const floor = 20_000_000_000n
  const maxFeePerGas = (price > floor ? price : floor) * 2n
  return { maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n }
}
async function directCall(account, to, data, gasFallback) {
  const gas = BigInt(await rpc('eth_estimateGas', [{ from: account.address, to, data }]).catch(() => toHex(gasFallback)))
  const hash = await signAndSend(account, { to, data, gas: (gas * 13n) / 10n, ...(await fees()) })
  const r = await receiptOf(hash)
  return { hash, status: r.status, gasUsed: BigInt(r.gasUsed), effective: BigInt(r.effectiveGasPrice), logs: r.logs }
}
const read = async (to, fn, args = []) => {
  const data = encodeFunctionData({ abi, functionName: fn, args })
  const res = await rpc('eth_call', [{ to, data }, 'latest'])
  return decodeFunctionResult({ abi, functionName: fn, data: res })
}

// --- the throwaway wallet needs test USDC; the public faucet is a person's job, it has a reCAPTCHA ---
const NEED = parseUnits('0.2', 18)
let bal = await nativeOf(owner.address)
console.log('owner testnet balance', formatUnits(bal, 18))
if (bal < NEED) {
  console.log(`NEEDS TEST USDC: send about 0.25 to ${owner.address} on Arc testnet (faucet.circle.com), then run again`)
  process.exit(3)
}

// --- the browser, and the wallet the page talks to ---
const results = []
const check = (ok, what) => {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${what}`)
  results.push({ ok: Boolean(ok), what })
}
const wallet = { chainHex: '0x1', added: new Set(['0x1']), connected: false, sent: [], requests: [], addParams: null }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
let walletPage
const emit = (event, value) => walletPage?.evaluate(([e, v]) => window.__walletEmit?.(e, v), [event, value]).catch(() => {})
async function walletRequest(method, params) {
  wallet.requests.push(method)
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
      wallet.addParams = params[0]
      wallet.added.add(String(params[0].chainId).toLowerCase())
      return null
    case 'eth_sendTransaction': {
      const tx = params[0]
      if (wallet.chainHex !== CHAIN_HEX) throw Object.assign(new Error(`wallet is on ${wallet.chainHex}`), { code: -32000 })
      if (String(tx.chainId).toLowerCase() !== CHAIN_HEX) throw Object.assign(new Error(`tx names chain ${tx.chainId}`), { code: -32000 })
      if (String(tx.from).toLowerCase() !== owner.address.toLowerCase()) throw Object.assign(new Error('from is not the account'), { code: 4100 })
      const hash = await signAndSend(owner, { to: tx.to, data: tx.data, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) })
      wallet.sent.push({ hash, to: tx.to ?? null, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, selector: String(tx.data).slice(0, 10) })
      console.log(`      wallet sent ${hash} gas ${BigInt(tx.gas)} maxFee ${Number(BigInt(tx.maxFeePerGas)) / 1e9} gwei`)
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

if (/localhost/.test(base)) {
  await ctx.route('**/api/**', async (route, request) => {
    if (request.method() !== 'GET') return route.fulfill({ status: 405, body: '{}' })
    const url = request.url().replace(base, 'https://a-identity-backend.onrender.com')
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await res.arrayBuffer()) })
    } catch {
      await route.fulfill({ status: 502, body: '{}' })
    }
  })
}
const page = await ctx.newPage()
walletPage = page
const consoleErrors = []
const posts = []
page.on('console', (m) => {
  if (m.type() === 'error' && !/net::ERR|Failed to load resource|favicon/i.test(m.text())) consoleErrors.push(m.text().slice(0, 300))
})
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message.slice(0, 300)))
page.on('request', (r) => {
  if (r.method() === 'POST' && /(^|\.)a-identity\.xyz$|onrender\.com$/.test(new URL(r.url()).host)) posts.push(r.url())
})
const text = () => page.evaluate(() => document.getElementById('root')?.innerText ?? '')
let shot = 0
const snap = async (name) => {
  shot += 1
  const n = String(shot).padStart(2, '0')
  await page.screenshot({ path: join(outDir, `${n}-${name}.png`), fullPage: true }).catch(() => {})
  writeFileSync(join(outDir, `${n}-${name}.txt`), await text())
}
const waitText = async (re, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (re.test(await text())) return true
    await page.waitForTimeout(400)
  }
  return false
}
const stopIf = async (ok, what) => {
  check(ok, what)
  if (!ok) {
    await snap('failed')
    console.log('--- page text at the failure ---\n' + (await text()).slice(0, 2500))
    await finish(1)
  }
}
async function finish(code) {
  console.log('console errors:', consoleErrors)
  console.log('POSTs to our domains:', posts)
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, consoleErrors, posts, sent: wallet.sent, addParams: wallet.addParams }, null, 1))
  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `\n${failed} check(s) failed` : '\nALL CHECKS PASSED')
  process.exit(code || (failed ? 1 : 0))
}

let vault = resumeVault ? viem.getAddress(resumeVault) : null
let deploySent = resumeVault ? { hash: resumeDeployTx } : null
if (resumeVault) {
  await page.goto(`${base}/app/vault/arc?network=eip155:5042002&contract=${resumeVault}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Connect wallet' }).first().click()
  await page.getByRole('button', { name: 'RehearsalWallet' }).click()
  await stopIf(await waitText(/RehearsalWallet connected/), 'the wallet connects')
  await stopIf(await waitText(/IS the owner of this vault/, 60000), 'a fresh visit with the link recognises the owner')
  await stopIf(await waitText(/Switch to Arc testnet/, 20000), 'the page offers to switch a wallet on the wrong network')
  await page.getByRole('button', { name: /Switch to Arc testnet/ }).first().click()
  const switched = await waitText(/Freeze the vault/, 30000)
  console.log('      wallet requests so far:', wallet.requests.filter((m) => /^wallet_/.test(m)).join(', '), '| wallet chain', wallet.chainHex)
  await stopIf(switched, 'pressing Switch adds Arc to a wallet that does not know it, moves it there, and the owner controls appear')
  await snap('resumed-vault-page')
} else {
// --- 1. the link a new owner gets ---
await page.goto(`${base}/app/vault/arc?network=eip155:5042002&deploy=1`, { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: 'Connect wallet' }).first().waitFor({ timeout: 30000 })
await snap('before-connect')
await page.getByRole('button', { name: 'Connect wallet' }).first().click()
await page.getByRole('button', { name: 'RehearsalWallet' }).click()
await stopIf(await waitText(/RehearsalWallet connected/), 'the wallet connects')
await stopIf(await waitText(/on chain 1, not Arc/i, 15000), 'a wallet on Ethereum is reported as the wrong network')
await snap('connected-wrong-network')

// --- 2. the form ---
await page.fill('#deploy-operator', agent.address)
await page.fill('#deploy-funding', '0.1')
await snap('form-filled')
await page.getByRole('button', { name: 'Review the deploy' }).click()
await stopIf(await waitText(/Review: create your vault/, 90000), 'the deploy is prepared and simulated on the real chain')
await snap('deploy-review')

// --- 3. transaction 1: the deploy ---
const before = await nativeOf(owner.address)
await page.getByRole('button', { name: 'Deploy from my wallet' }).click()
await stopIf(await waitText(/Set it now/, 180000), 'the real deploy lands and step 2 opens')
check(wallet.addParams?.rpcUrls?.length > 0, `the page asked the wallet to add Arc (${wallet.addParams?.chainName}, ${wallet.addParams?.rpcUrls?.[0]})`)
await snap('expiry-step')
deploySent = wallet.sent[0]
const deployReceipt = await receiptOf(deploySent.hash)
vault = viem.getAddress(deployReceipt.contractAddress)
const deployCost = BigInt(deployReceipt.gasUsed) * BigInt(deployReceipt.effectiveGasPrice)
console.log(`      vault ${vault}; deploy ${deploySent.hash}; gas used ${BigInt(deployReceipt.gasUsed)} of ${BigInt(deploySent.gas)}; cost ${formatUnits(deployCost, 18)} USDC`)
check(deployReceipt.status === '0x1', 'the deploy receipt succeeded')
check((await text()).includes(vault), 'the page names the vault the receipt created')
check(viem.getAddress(await read(vault, 'owner')) === owner.address, 'owner() is the wallet that deployed')
check(viem.getAddress(await read(vault, 'operator')) === agent.address, 'operator() is the agent address typed in the form')
check((await read(vault, 'sessionKeyExpiry')) === 0n, 'before step 2 the agent key has no time bound, as the page warns')

// --- 4. transaction 2: the expiry ---
await page.getByRole('button', { name: /Set it now/ }).click()
await stopIf(await waitText(/Confirmation 3 of 3: put USDC in the vault/, 180000), 'the expiry lands and step 3 opens')
await snap('fund-step')
const expiry = await read(vault, 'sessionKeyExpiry')
const nowSec = BigInt(Math.floor(Date.now() / 1000))
console.log(`      expiry in ${(Number(expiry - nowSec) / 86400).toFixed(2)} days`)
check(expiry > nowSec, 'sessionKeyExpiry is in the future')

// --- 5. transaction 3: the funding ---
await page.getByRole('button', { name: 'Review', exact: true }).first().click()
const confirmFund = page.getByRole('button', { name: /Confirm in wallet|Send .*USDC|Put .*USDC/i }).first()
await confirmFund.waitFor({ timeout: 60000 })
check(true, 'the funding is reviewed before the wallet')
await snap('fund-review')
await confirmFund.click()
await stopIf(await waitText(/Your vault is set up/, 180000), 'the funding lands and the setup ends')
await snap('setup-done')
check(await waitText(new RegExp(deploySent.hash, 'i'), 15000), 'the end of the setup names the deploy transaction, the evidence an owner passes on')
check(await waitText(/balance 0\.1 USDC/, 30000), 'the end of the setup says the balance that was funded, not one read before it')
const bar = await text()
const shown = bar.match(/Your USDC on Arc testnet: ([0-9.]+) USDC/)?.[1]
console.log(`      wallet strip says ${shown} USDC`)
const vaultBal = await read(vault, 'balance').catch(() => null)
console.log('      vault balance', vaultBal === null ? '(no balance view)' : formatUnits(vaultBal, 6))
check(vaultBal === parseUnits('0.1', 6), 'the vault holds exactly what was funded')
const afterSetup = await nativeOf(owner.address)
console.log(`      the whole setup cost the owner ${formatUnits(before - afterSetup - parseUnits('0.1', 18), 18)} USDC in gas, plus the 0.1 funding`)
await page.waitForTimeout(16000)
const stripNow = (await text()).match(/Your USDC on Arc testnet: ([0-9.]+) USDC/)?.[1]
check(stripNow !== undefined && parseUnits(stripNow, 18) < before, `the wallet strip caught up with what the setup spent (${stripNow} USDC, it read ${formatUnits(before, 18)} before)`)

// --- 6. the vault's own page ---
await page.getByRole('button', { name: 'Open the vault' }).click()
await stopIf(await waitText(/IS the owner of this vault/, 60000), 'the vault page recognises its owner')
await snap('vault-page')

// --- 7. the admission script a real vault goes through ---
const admit = spawnSync(process.execPath, [join(repo, 'mcp/scripts/arc-owner-vault-check.mjs'), '--tx', deploySent.hash, '--chain', 'arc'], { encoding: 'utf8', cwd: join(repo, 'mcp') })
console.log(`      admission script exit ${admit.status}: ${(admit.stdout + admit.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`)
writeFileSync(join(outDir, 'admission.txt'), admit.stdout + admit.stderr)
check(admit.status === 0, 'the admission script passes this vault as a rehearsal')
}

// --- 8. the agent, holding only its own key, pays and is bound by the policy ---
const fundAgent = await directCall(owner, USDC, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [agent.address, parseUnits('0.02', 6)] }), 80000n)
check(fundAgent.status === '0x1', 'the agent key gets test USDC for its gas')
const PAYEE = owner.address
const pay = (units) => encodeFunctionData({ abi, functionName: 'pay', args: [PAYEE, units] })
const paid = await directCall(agent, vault, pay(parseUnits('0.01', 6)), 150000n)
check(paid.status === '0x1', `the agent pays 0.01 USDC from the vault with its own key (${paid.hash})`)
let refused = null
try {
  await rpc('eth_call', [{ from: agent.address, to: vault, data: pay(parseUnits('0.5', 6)) }, 'latest'])
} catch (e) {
  refused = e
}
check(Boolean(refused), `a payment above the 0.25 ceiling is refused for the agent (${String(refused?.data ?? refused?.message).slice(0, 40)})`)
await page.reload({ waitUntil: 'domcontentloaded' })
await stopIf(await waitText(/IS the owner of this vault/, 60000), 'after a reload the page still knows its owner')
await page.waitForTimeout(4000)
await snap('vault-after-agent-paid')
const afterPay = await text()
check(/0\.01/.test(afterPay), "the page shows the agent's 0.01 USDC payment")

// --- 9. freeze and unfreeze, by the owner, from the page ---
await page.getByRole('button', { name: 'Freeze the vault' }).click()
const frozenIs = async (want, ms = 180000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await read(vault, 'frozen')) === want) return true
    await sleep(1500)
  }
  return false
}
await stopIf(await frozenIs(true), 'the freeze lands: frozen() reads true on chain')
await stopIf(await waitText(/Unfreeze the vault/, 60000), 'the button flips to Unfreeze')
await snap('frozen')
let frozenRefused = null
try {
  await rpc('eth_call', [{ from: agent.address, to: vault, data: pay(1000n) }, 'latest'])
} catch (e) {
  frozenRefused = e
}
check(Boolean(frozenRefused), 'a frozen vault refuses the agent')
await page.getByRole('button', { name: 'Unfreeze the vault' }).click()
await stopIf(await frozenIs(false), 'the unfreeze lands: frozen() reads false again')
await page.waitForTimeout(4000)

// --- 10. withdraw, by the owner, from the page ---
const held = await page.locator(`[id^="withdraw-amount-"]`).first().getAttribute('id')
await page.fill(`#${held}`, '0.02')
await page.locator('form', { has: page.locator(`#${held}`) }).getByRole('button', { name: 'Review', exact: true }).click()
await stopIf(await waitText(/Review: .*0\.02 USDC/, 60000), 'the withdrawal is reviewed before the wallet')
await snap('withdraw-review')
const vaultBefore = await read(vault, 'balance')
await page.getByRole('button', { name: 'Confirm in wallet' }).click()
for (let i = 0; i < 180; i++) {
  if ((await read(vault, 'balance')) !== vaultBefore) break
  await sleep(1000)
}
const vaultAfter = await read(vault, 'balance')
check(vaultBefore - vaultAfter === parseUnits('0.02', 6), `the vault went from ${formatUnits(vaultBefore, 6)} to ${formatUnits(vaultAfter, 6)} USDC`)
await page.waitForTimeout(5000)
await snap('withdrawn')
await page.reload({ waitUntil: 'domcontentloaded' })
await stopIf(await waitText(/IS the owner of this vault/, 60000), 'a last reload still works')
await page.waitForTimeout(4000)
await snap('final')

// --- the hashes a reviewer can open, and a spent-today read for the record ---
console.log('owner txs', wallet.sent.map((s) => s.hash))
console.log('vault', vault)
console.log('spent today', formatUnits(await read(vault, 'spentToday'), 6))
check(consoleErrors.length === 0, `no console errors (${consoleErrors.slice(0, 2).join(' | ')})`)
writeFileSync(join(outDir, 'vault.json'), JSON.stringify({ vault, deployTx: deploySent.hash, owner: owner.address, agent: agent.address, sent: wallet.sent, paid: paid.hash }, null, 1))
await finish(0)
