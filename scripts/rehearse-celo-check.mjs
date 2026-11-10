#!/usr/bin/env node
/**
 * The Celo pay check in a browser, against the live rail: /check/celo on a local build (or any
 * base URL), with a wallet held in this process answering the page the way an extension does.
 * The checks in mcp/src/frontend-celo-check.test.ts drive the page's rules with a fake wallet;
 * this drives the page itself, in a browser, the way a team we send the link to does.
 *
 * The wallet announces itself over EIP-6963, starts on another chain with Celo unknown, adds
 * and switches when asked, answers reads from Celo's public RPC, and signs the typed data the
 * page hands it with the buyer key from mcp/.env (CELO_BUYER_KEY: the dedicated buyer wallet,
 * never the server signer). Real money: one risk_check at the published price per run. It
 * refuses to sign anything but one TransferWithAuthorization on Celo mainnet, to the payTo the
 * rail publishes, for at most 0.01 USDC, and it never prints the key.
 *
 * What it checks: the chain is added from the registry's facts, exactly one signature is
 * asked for, the verdict and the receipt render, the settlement hash is on Celoscan's path,
 * and the same hash shows up in GET /api/celo/proof with this wallet as the payer. What it
 * cannot show: a real wallet's own screens. Those need a person with MetaMask or Rabby.
 *
 * Usage: npm run build (root and mcp), then
 *        node --env-file=mcp/.env scripts/rehearse-celo-check.mjs [baseUrl]
 * With no baseUrl it serves the local build on :4173 and forwards /api, /health and /mcp to the
 * live backend, like scripts/smoke.mjs. Exit: 0 all checks passed, 1 a check failed, 2 usage.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const mod = (p) => import(pathToFileURL(join(repo, p)).href)
const { chromium } = await mod('node_modules/playwright/index.mjs')
const { privateKeyToAccount } = await mod('node_modules/viem/_esm/accounts/index.js')
const { getChainById } = await mod('mcp/dist/chains/registry.js')

const key = process.env.CELO_BUYER_KEY
if (!key) {
  console.error('usage: node --env-file=mcp/.env scripts/rehearse-celo-check.mjs [baseUrl]   (CELO_BUYER_KEY must be set)')
  process.exit(2)
}
const buyer = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const chain = getChainById('celo')
if (!chain || chain.testnet) throw new Error('this rehearsal is for Celo mainnet')
const CHAIN_HEX = '0x' + chain.evmChainId.toString(16)
const USDC = chain.contracts.usdc.toLowerCase()
const RPCS = chain.rpcUrls
/** The most this process will ever sign for, in USDC base units: ten times the published price of a risk_check. */
const SPEND_CAP = 10_000n

const BACKEND = 'https://a-identity-backend.onrender.com'
const argBase = process.argv[2]
const BASE = argBase ? argBase.replace(/\/+$/, '') : 'http://localhost:4173'

// --- the local build, when no base URL was given ---
let preview = null
if (!argBase) {
  const busy = await fetch(BASE, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
  if (busy) {
    console.error(`${BASE} is already serving something. Stop it first: a stale preview would be rehearsed instead of this build.`)
    process.exit(2)
  }
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore', cwd: repo })
  process.on('exit', () => preview.kill())
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500))
    up = await fetch(BASE, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
  }
  if (!up) {
    preview.kill()
    console.error(`vite preview did not come up on ${BASE} within 30 s.`)
    process.exit(2)
  }
}

// --- the rail, read before anything is signed: the payTo this wallet may pay ---
const statusRes = await fetch(`${BACKEND}/api/celo/status`, { signal: AbortSignal.timeout(20000) })
const status = await statusRes.json()
if (status.configured !== true || status.network !== chain.caip2) throw new Error(`the live rail is not configured for ${chain.caip2}: ${JSON.stringify(status).slice(0, 200)}`)
const PAY_TO = String(status.payTo).toLowerCase()
console.log('buyer', buyer.address, '\nrail pays', PAY_TO, 'through', status.facilitator)

// --- a small RPC client for the wallet's reads ---
let rpcId = 1
async function rpc(method, params = []) {
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
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data })
      return j.result
    } catch (e) {
      last = e
      if (e.code !== undefined) throw e
    }
  }
  throw last
}

// --- the browser, and the wallet the page talks to ---
const results = []
const check = (ok, what) => {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${what}`)
  results.push({ ok: Boolean(ok), what })
}
const wallet = { chainHex: '0x1', added: new Set(['0x1']), connected: false, requests: [], addParams: null, signed: [] }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } })

async function walletRequest(method, params) {
  wallet.requests.push(method)
  switch (method) {
    case 'eth_requestAccounts':
      wallet.connected = true
      return [buyer.address]
    case 'eth_accounts':
      return wallet.connected ? [buyer.address] : []
    case 'eth_chainId':
      return wallet.chainHex
    case 'net_version':
      return String(parseInt(wallet.chainHex, 16))
    case 'wallet_switchEthereumChain': {
      const id = String(params[0].chainId).toLowerCase()
      if (!wallet.added.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
      wallet.chainHex = id
      return null
    }
    case 'wallet_addEthereumChain':
      wallet.addParams = params[0]
      wallet.added.add(String(params[0].chainId).toLowerCase())
      return null
    case 'eth_signTypedData_v4': {
      const [from, json] = params
      const td = JSON.parse(json)
      // The only thing this process signs: one USDC authorization on Celo, to the rail, under the cap.
      if (wallet.chainHex !== CHAIN_HEX) throw Object.assign(new Error(`wallet is on ${wallet.chainHex}`), { code: 4001 })
      if (String(from).toLowerCase() !== buyer.address.toLowerCase()) throw Object.assign(new Error('from is not the account'), { code: 4100 })
      if (td.primaryType !== 'TransferWithAuthorization') throw Object.assign(new Error(`refusing to sign ${td.primaryType}`), { code: 4001 })
      if (Number(td.domain.chainId) !== chain.evmChainId) throw Object.assign(new Error(`refusing chain ${td.domain.chainId}`), { code: 4001 })
      if (String(td.domain.verifyingContract).toLowerCase() !== USDC) throw Object.assign(new Error(`refusing token ${td.domain.verifyingContract}`), { code: 4001 })
      if (String(td.message.to).toLowerCase() !== PAY_TO) throw Object.assign(new Error(`refusing payee ${td.message.to}`), { code: 4001 })
      if (BigInt(td.message.value) > SPEND_CAP) throw Object.assign(new Error(`refusing ${td.message.value} units`), { code: 4001 })
      if (wallet.signed.length > 0) throw Object.assign(new Error('this process signs once per run'), { code: 4001 })
      const signature = await buyer.signTypedData({
        domain: { name: td.domain.name, version: td.domain.version, chainId: Number(td.domain.chainId), verifyingContract: td.domain.verifyingContract },
        types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: td.message.from,
          to: td.message.to,
          value: BigInt(td.message.value),
          validAfter: BigInt(td.message.validAfter),
          validBefore: BigInt(td.message.validBefore),
          nonce: td.message.nonce,
        },
      })
      wallet.signed.push({ to: td.message.to, value: td.message.value, validBefore: td.message.validBefore })
      console.log(`      wallet signed ${td.message.value} units of USDC to ${td.message.to}`)
      return signature
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
  const info = { uuid: 'rehearsal-0000-0000-0000-000000000001', name: 'Rehearsal wallet', icon: 'data:image/svg+xml,', rdns: 'xyz.a-identity.rehearsal' }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
})

// Preview only serves static files, so stand in for the Vercel rewrite and forward the backend
// paths to the live backend. The X-PAYMENT header travels with the request headers.
if (!argBase) {
  const forward = async (route, request) => {
    const url = request.url().replace(BASE, BACKEND)
    const headers = { ...request.headers(), host: 'a-identity-backend.onrender.com' }
    try {
      const res = await fetch(url, { method: request.method(), headers, body: request.postData() ?? undefined, redirect: 'manual' })
      const body = Buffer.from(await res.arrayBuffer())
      await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, body })
    } catch {
      await route.fulfill({ status: 502, body: '{}' })
    }
  }
  await ctx.route('**/api/**', forward)
  await ctx.route('**/health', forward)
  await ctx.route('**/mcp', forward)
}

const page = await ctx.newPage()
const errs = []
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource/i.test(m.text())) errs.push(m.text())
})
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))

try {
  await page.goto(`${BASE}/check/celo?q=%239759`, { waitUntil: 'domcontentloaded' })
  const button = page.getByRole('button', { name: /^Pay \$0\.005 and check$/ })
  await button.waitFor({ state: 'visible', timeout: 30000 })
  check(await page.getByLabel('Agent id').inputValue() === '#9759', 'the deep link prefilled the agent id and paid nothing on load')
  check(wallet.requests.length === 0 || !wallet.requests.includes('eth_signTypedData_v4'), 'nothing was signed before the button was pressed')
  await button.click()

  const answer = page.getByText('Receipt', { exact: true })
  const stop = page.getByRole('alert')
  await Promise.race([answer.waitFor({ state: 'visible', timeout: 150000 }), stop.waitFor({ state: 'visible', timeout: 150000 })])
  if (await stop.isVisible().catch(() => false)) {
    check(false, `the purchase stopped: ${(await stop.innerText()).trim()}`)
  } else {
    const verdict = await page.locator('h2').filter({ hasText: /Looks safe to pay|Be careful|Don't pay|No verdict/ }).first().innerText()
    check(/Looks safe to pay|Be careful|Don't pay/.test(verdict), `a verdict rendered: ${verdict.replace(/\s+/g, ' ').trim()}`)
    const txLink = page.locator(`a[href^="${chain.explorer}/tx/"]`).first()
    const href = await txLink.getAttribute('href').catch(() => null)
    check(Boolean(href), `the receipt links the settlement on the explorer: ${href}`)
    const tx = href ? href.split('/tx/')[1] : null
    check(await page.getByText('/proof/celo', { exact: true }).first().isVisible(), 'the receipt points at /proof/celo')
    // The rail's own log, from the backend, carries the same settlement with this wallet as the payer.
    if (tx) {
      let seen = false
      for (let i = 0; i < 6 && !seen; i++) {
        const proof = await fetch(`${BACKEND}/api/celo/proof`, { signal: AbortSignal.timeout(20000) }).then((r) => r.text(), () => '')
        seen = proof.toLowerCase().includes(tx.toLowerCase()) && proof.toLowerCase().includes(buyer.address.toLowerCase())
        if (!seen) await new Promise((r) => setTimeout(r, 2000))
      }
      check(seen, 'GET /api/celo/proof lists the settlement with this wallet as the payer')
    }
  }
  check(wallet.requests.filter((m) => m === 'eth_signTypedData_v4').length === 1, 'the wallet was asked for exactly one signature')
  check(wallet.signed.length === 1 && wallet.signed[0].to.toLowerCase() === PAY_TO, 'the one signature pays the rail')
  check(wallet.requests.includes('wallet_addEthereumChain') && wallet.chainHex === CHAIN_HEX, 'Celo was added and switched to before signing')
  check(wallet.addParams?.chainName === chain.name && wallet.addParams?.rpcUrls?.[0] === RPCS[0] && wallet.addParams?.nativeCurrency?.symbol === 'CELO', 'the chain was added from the registry facts')
  check(wallet.requests.indexOf('wallet_switchEthereumChain') < wallet.requests.indexOf('eth_signTypedData_v4'), 'the switch came before the signature')
  check(errs.length === 0, errs.length ? `console errors: ${errs.slice(0, 3).join(' | ').slice(0, 300)}` : 'no console errors or page exceptions')
} catch (e) {
  check(false, `the rehearsal broke: ${e.message}`)
} finally {
  await browser.close()
  preview?.kill()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length ? `${failed.length} check(s) failed` : 'ALL CHECKS PASSED'}`)
process.exit(failed.length ? 1 : 0)
