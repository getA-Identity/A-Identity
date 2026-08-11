#!/usr/bin/env node
/**
 * Deploy the canonical ERC-8004 registries to Robinhood Chain Testnet (eip155:46630)
 * at the SAME addresses they carry on Arc and Celo Sepolia.
 *
 * How the same-address promise actually works for these contracts: the ERC-8004 team
 * deployed every registry (implementation + ERC1967 proxy) through the Safe Singleton
 * Factory (0x914d...43d7), whose calldata is `bytes32 salt ++ initcode`. Anyone can
 * replay that exact calldata on any chain where the factory exists — the factory, not
 * the sender, determines the CREATE2 address — and the factory IS deployed on Robinhood
 * Chain testnet + mainnet (eth_getCode verified live 2026-08-11). Replaying keeps the
 * canonical upgrade authority (the initializer args are inside the initcode), so this
 * is a faithful propagation of the canonical deployment, not a fork.
 *
 * This script:
 *   1. fetches each pinned creation tx's calldata from the explorer it was mined on,
 *   2. recomputes the CREATE2 address from that calldata and REFUSES to continue unless
 *      it equals the pinned canonical address (so tampered/edited source data fails closed),
 *   3. skips anything already deployed (idempotent),
 *   4. without RHCHAIN_TESTNET_SIGNER_KEY prints the exact prepared txs; with it,
 *      broadcasts in dependency order (implementations before proxies), verifies each
 *      receipt AND eth_getCode, then does a real read (identity name/symbol) at the end.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/rh-testnet-deploy-8004.mjs
 * Env:   RHCHAIN_TESTNET_SIGNER_KEY   funded signer on 46630 (see rh-testnet-bridge.mjs)
 *        RHCHAIN_TESTNET_RPC_URL      optional RPC override
 */
import { createPublicClient, createWalletClient, http, keccak256, getAddress, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const SAFE_SINGLETON_FACTORY = '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7'

// Pinned provenance: canonical address + the creation tx whose calldata we replay.
// identity/reputation were read from Celo Sepolia, validation from Arc (Celo has no
// ValidationRegistry). Order matters: a proxy's constructor delegatecalls its
// implementation, so implementations deploy first.
const DEPLOYS = [
  { label: 'IdentityRegistryUpgradeable (impl)', address: '0x7274e874CA62410a93Bd8bf61c69d8045E399c02', explorer: 'https://celo-sepolia.blockscout.com', tx: '0x412bc49217750d3f7880672626efb71828c5376f450db50e09dff2c4d9cee277' },
  { label: 'ReputationRegistryUpgradeable (impl)', address: '0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34', explorer: 'https://celo-sepolia.blockscout.com', tx: '0xfa3303e58ea645834e096e89bc1083ad8201bb12d363b9ea72dbf0ec20da35d8' },
  { label: 'ValidationRegistryUpgradeable (impl)', address: '0xDB31f5d9167f8ebc8B30FbBF814c4d297c2D7F99', explorer: 'https://testnet.arcscan.app', tx: '0x4e552f7bb116b76be03a66f2f65e047b772089d0d799dfa7f6cf216c64938c76' },
  { label: 'IdentityRegistry (proxy)', address: '0x8004A818BFB912233c491871b3d84c89A494BD9e', explorer: 'https://celo-sepolia.blockscout.com', tx: '0xd71d82ea66150fb5c61cda01c8ef118b91bcda8b7aab01391918291ff8ee732f' },
  { label: 'ReputationRegistry (proxy)', address: '0x8004B663056A597Dffe9eCcC1965A193B7388713', explorer: 'https://celo-sepolia.blockscout.com', tx: '0xff75d8bac3d3a3c21d51e13716fffdf5d954a22fc2d2c29c749deedd48a45963' },
  { label: 'ValidationRegistry (proxy)', address: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272', explorer: 'https://testnet.arcscan.app', tx: '0xac802302aa6efd2e3837b775bb2ef6be099d01e8c724a0737fef18b2f71a9ec7' },
]

let getChainById, resolveRpcUrls
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const chain = getChainById('rhchain-testnet')
const RPC = resolveRpcUrls(chain, process.env)[0]
const viemChain = defineChain({
  id: chain.evmChainId,
  name: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

// The whole plan rests on the factory being there; check it, do not assume it.
const factoryCode = await pub.getCode({ address: SAFE_SINGLETON_FACTORY })
if (!factoryCode || factoryCode === '0x') {
  console.error(`error: Safe Singleton Factory has no code on ${chain.name}; the same-address replay is impossible.`)
  process.exit(1)
}

console.log(`Target:  ${chain.name} (${chain.caip2}) via ${RPC}`)
console.log(`Factory: ${SAFE_SINGLETON_FACTORY} (code present)\n`)

// 1+2: fetch each creation calldata and prove it reproduces the canonical address.
const jobs = []
for (const d of DEPLOYS) {
  const res = await fetch(`${d.explorer}/api/v2/transactions/${d.tx}`)
  if (!res.ok) {
    console.error(`error: could not fetch ${d.tx} from ${d.explorer} (HTTP ${res.status})`)
    process.exit(1)
  }
  const body = await res.json()
  const to = body.to?.hash?.toLowerCase()
  const raw = body.raw_input
  if (to !== SAFE_SINGLETON_FACTORY.toLowerCase() || !raw?.startsWith('0x') || raw.length <= 66) {
    console.error(`error: ${d.label}: source tx does not look like a Safe-factory deploy (to=${to})`)
    process.exit(1)
  }
  const salt = `0x${raw.slice(2, 66)}`
  const initcode = `0x${raw.slice(66)}`
  const derived = getAddress(`0x${keccak256(`0xff${SAFE_SINGLETON_FACTORY.slice(2)}${salt.slice(2)}${keccak256(initcode).slice(2)}`).slice(26)}`)
  if (derived !== getAddress(d.address)) {
    console.error(`error: ${d.label}: calldata derives ${derived}, expected ${d.address}. Refusing to deploy.`)
    process.exit(1)
  }
  const existing = await pub.getCode({ address: d.address })
  const deployed = Boolean(existing && existing !== '0x')
  console.log(`${deployed ? 'SKIP (already deployed)' : 'READY'}  ${d.label}  ${d.address}`)
  if (!deployed) jobs.push({ ...d, calldata: raw })
}

if (jobs.length === 0) {
  console.log('\nEverything is already deployed. Nothing to do.')
  process.exit(0)
}

const key = process.env.RHCHAIN_TESTNET_SIGNER_KEY
if (!key) {
  console.log('\nNo RHCHAIN_TESTNET_SIGNER_KEY set - PREPARED transactions (nothing was broadcast):')
  console.log(JSON.stringify(jobs.map((j) => ({
    executed: false,
    chainId: chain.evmChainId,
    label: j.label,
    to: SAFE_SINGLETON_FACTORY,
    value: '0x0',
    data: `(the exact ${(j.calldata.length - 2) / 2}-byte calldata of ${j.explorer}/tx/${j.tx})`,
    resultsIn: j.address,
  })), null, 2))
  console.log('\nSend these from any funded wallet on 46630, in this order, to get the canonical addresses.')
  process.exit(0)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const wallet = createWalletClient({ account, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
const bal = await pub.getBalance({ address: account.address })
console.log(`\nSigner: ${account.address} (${Number(bal) / 1e18} ETH on 46630)`)
if (bal === 0n) {
  console.error('error: signer has no gas on 46630. Run scripts/rh-testnet-bridge.mjs first.')
  process.exit(1)
}

for (const j of jobs) {
  console.log(`\nDeploying ${j.label} -> ${j.address}`)
  const hash = await wallet.sendTransaction({ to: SAFE_SINGLETON_FACTORY, data: j.calldata })
  console.log(`  tx: ${hash}`)
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') {
    console.error(`  error: reverted (${chain.explorer}/tx/${hash}); stopping here.`)
    process.exit(1)
  }
  const code = await pub.getCode({ address: j.address })
  if (!code || code === '0x') {
    console.error(`  error: receipt ok but no code at ${j.address}; stopping here.`)
    process.exit(1)
  }
  console.log(`  deployed (${(code.length - 2) / 2} bytes): ${chain.explorer}/address/${j.address}`)
}

// A real read through the proxy, not just code-presence: the ERC-721 identity
// registry must answer name() and symbol() like it does on Arc/Celo Sepolia.
const NAME_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
]
const [name, symbol] = await Promise.all([
  pub.readContract({ address: '0x8004A818BFB912233c491871b3d84c89A494BD9e', abi: NAME_ABI, functionName: 'name' }),
  pub.readContract({ address: '0x8004A818BFB912233c491871b3d84c89A494BD9e', abi: NAME_ABI, functionName: 'symbol' }),
])
console.log(`\nIdentityRegistry live read: name="${name}" symbol="${symbol}"`)
console.log('\nDONE. Next: fill the rhchain-testnet descriptor contracts in mcp/src/chains/registry.ts')
console.log('with these addresses and run cd mcp && npm test.')
