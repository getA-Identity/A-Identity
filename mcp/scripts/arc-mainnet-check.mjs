#!/usr/bin/env node
/**
 * Re-verify, live and read-only, every claim the `arc-mainnet` descriptor makes. Nothing is
 * signed and no key is read. Exit code 1 on any mismatch, so it can gate a status change.
 *
 * What it checks, and why each one is a real check rather than a presence probe:
 *  - each RPC answers eth_chainId 5042 (a host move shows up here first)
 *  - USDC: name/version reproduce the live DOMAIN_SEPARATOR with chainId 5042, and
 *    authorizationState answers (EIP-3009 is really there)
 *  - ERC-8004: the proxies' EIP-1967 implementation slots match Base's, and the
 *    implementation code hashes match too. eth_getCode alone proves nothing: 130-byte
 *    proxies at these addresses delegate to a different contract on some chains.
 *  - CCTP and Gateway contracts have code
 *  - Circle's live Gateway endpoint still advertises this chain with the registry's wallet
 *    and USDC
 *  - optionally, --owner 0x... reports that address's USDC and any agent it holds
 *
 * Usage: cd mcp && npm run build && node scripts/arc-mainnet-check.mjs [--owner 0x...]
 */
import { createPublicClient, http, parseAbi, hashDomain, keccak256, formatUnits, getAddress } from 'viem'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const OWNER = arg('owner', '')

let getChainById
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const arc = getChainById('arc-mainnet')
const base = getChainById('base')
if (!arc || !base) { console.error('error: arc-mainnet or base missing from the registry'); process.exit(1) }

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(label)
}
const client = (url) => createPublicClient({ transport: http(url, { timeout: 15000, retryCount: 2 }) })
const pub = client(arc.rpcUrls[0])
const basePub = createPublicClient({ transport: http(base.rpcUrls.at(-1), { timeout: 15000, retryCount: 3 }) })

console.log(`${arc.name} (${arc.caip2}), status ${arc.status}\n`)

for (const url of arc.rpcUrls) {
  try {
    const id = await client(url).getChainId()
    check(`rpc ${new URL(url).host} answers chain ${arc.evmChainId}`, id === arc.evmChainId, `got ${id}`)
  } catch (e) {
    check(`rpc ${new URL(url).host} answers`, false, e.shortMessage ?? e.message)
  }
}

// USDC and its EIP-712 domain
const usdc = arc.settlementTokens?.[0]
const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address,bytes32) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
const read = (fn, args = []) => pub.readContract({ address: usdc.address, abi: ERC20, functionName: fn, args })
const [name, version, decimals, separator] = await Promise.all([read('name'), read('version'), read('decimals'), read('DOMAIN_SEPARATOR')])
check('USDC decimals match the registry', Number(decimals) === usdc.decimals, `${decimals}`)
check('USDC version is a registry candidate', usdc.domainVersionCandidates.includes(version), `"${version}"`)
const rebuilt = hashDomain({
  domain: { name, version, chainId: arc.evmChainId, verifyingContract: usdc.address },
  types: { EIP712Domain: [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
  ] },
})
check('USDC DOMAIN_SEPARATOR reproduces from name/version/chainId', rebuilt === separator, separator)
try {
  await read('authorizationState', ['0x0000000000000000000000000000000000000001', `0x${'00'.repeat(32)}`])
  check('USDC answers authorizationState (EIP-3009)', true)
} catch (e) {
  check('USDC answers authorizationState (EIP-3009)', false, e.shortMessage ?? e.message)
}

// ERC-8004: implementation slot + code hash against Base
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const implOf = async (c, address) => {
  const slot = await c.getStorageAt({ address, slot: IMPL_SLOT })
  const impl = getAddress(`0x${slot.slice(-40)}`)
  const code = await c.getCode({ address: impl })
  return { impl, hash: code ? keccak256(code) : null }
}
for (const key of ['identityRegistry', 'reputationRegistry']) {
  const address = arc.contracts[key]
  const [a, b] = await Promise.all([implOf(pub, address), implOf(basePub, base.contracts[key])])
  check(`${key} implementation matches Base`, a.impl === b.impl && a.hash !== null && a.hash === b.hash, `${a.impl}`)
}
const ID_ABI = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)'])
const idName = await pub.readContract({ address: arc.contracts.identityRegistry, abi: ID_ABI, functionName: 'name' })
check('identityRegistry name() is AgentIdentity', idName === 'AgentIdentity', idName)

// CCTP, Gateway, predeploys: code present
const coded = {
  'cctp.tokenMessenger': arc.contracts.cctp?.tokenMessenger,
  'cctp.messageTransmitter': arc.contracts.cctp?.messageTransmitter,
  'gateway.wallet': arc.gateway?.wallet,
  memo: arc.contracts.memo,
  multicall3From: arc.contracts.multicall3From,
  create2Factory: arc.contracts.create2Factory,
}
for (const [label, address] of Object.entries(coded)) {
  const code = address ? await pub.getCode({ address }) : undefined
  check(`${label} has code`, Boolean(code && code.length > 2), address ?? 'missing')
}

// Circle Gateway advertises this chain with the registry's wallet and USDC
try {
  const res = await fetch(`${arc.gateway.facilitator}/v1/x402/supported`)
  const kinds = (await res.json()).kinds ?? []
  const kind = kinds.find((k) => k.network === arc.caip2)
  const extra = kind?.extra ?? {}
  check('Gateway lists this chain', Boolean(kind))
  check('Gateway verifyingContract is the registry wallet', extra.verifyingContract?.toLowerCase() === arc.gateway.wallet.toLowerCase(), extra.verifyingContract)
  check('Gateway asset is the registry USDC', (extra.assets ?? []).some((x) => x.address?.toLowerCase() === usdc.address.toLowerCase() && x.decimals === usdc.decimals))
} catch (e) {
  check('Gateway supported endpoint readable', false, e.message)
}

// CCTP forwarding fee from Base, informational
try {
  const res = await fetch(`https://iris-api.circle.com/v2/burn/USDC/fees/${base.cctpDomain}/${arc.cctpDomain}?forward=true`)
  const tiers = await res.json()
  console.log(`info CCTP Base -> Arc forwarding fee (fast): ${JSON.stringify(tiers.find((t) => t.finalityThreshold === 1000))}`)
} catch {}

if (OWNER) {
  const owner = getAddress(OWNER)
  const [bal, agents] = await Promise.all([
    read('balanceOf', [owner]),
    pub.readContract({ address: arc.contracts.identityRegistry, abi: ID_ABI, functionName: 'balanceOf', args: [owner] }),
  ])
  console.log(`info ${owner}: ${formatUnits(bal, 6)} USDC, ${agents} ERC-8004 agent(s) held on ${arc.name}`)
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
