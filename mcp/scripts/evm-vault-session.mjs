#!/usr/bin/env node
/**
 * Renew the operator's session key on ONE existing AgentSpendPolicy vault, on any EVM chain
 * in the registry: an owner-only setSessionKeyExpiry(now + days).
 *
 * Why this exists: pay() reverts SessionKeyExpired once block.timestamp passes
 * sessionKeyExpiry, and evm-mainnet-vault.mjs only sets the expiry at deploy time. The Arc
 * Mainnet vault's 7-day key lapsed on 2026-09-23, so its operator could no longer pay while
 * every other gate (cap, ceiling, allowlist, freeze) stayed exactly as the owner set them.
 * Renewing touches the expiry and nothing else.
 *
 * Owner-only on chain, so it is owner-only here: if the signer is not the vault's owner the
 * script says so and prints the call for the owner to make, instead of sending a tx that
 * would revert NotOwner.
 *
 * Prepared-or-executed: without the chain's signer env var this prints the exact call it
 * would make and exits. After a broadcast it reads the expiry back from the contract and
 * simulates one operator pay() (nothing broadcast) to show the session gate is open again.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/evm-vault-session.mjs \
 *          --chain arc-mainnet --vault 0x... [--days 30]
 */
import { createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', '')
const VAULT = arg('vault', '')
const DAYS = Number(arg('days', '30'))

if (!isAddress(VAULT)) { console.error('error: --vault 0x... is required'); process.exit(1) }
if (!Number.isFinite(DAYS) || DAYS <= 0 || DAYS > 365) { console.error('error: --days must be between 0 and 365'); process.exit(1) }

let getChainById, resolveRpcUrls, AgentSpendPolicyAbi
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
  ;({ AgentSpendPolicyAbi } = await import('../dist/contracts/AgentSpendPolicy.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

const chain = getChainById(CHAIN_ID)
if (!chain) { console.error(`error: unknown chain '${CHAIN_ID}'`); process.exit(1) }
if (chain.ecosystem !== 'evm') { console.error(`error: ${CHAIN_ID} is not an EVM chain`); process.exit(1) }

const RPC = resolveRpcUrls(chain, process.env)[0]
const viemChain = defineChain({ id: chain.evmChainId, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
const read = (fn, args = []) => pub.readContract({ address: VAULT, abi: AgentSpendPolicyAbi, functionName: fn, args })
const iso = (s) => (s === 0n ? 'never (0 = no expiry)' : new Date(Number(s) * 1000).toISOString())

const [owner, operator, current, frozen, autoApproveMax] = await Promise.all([
  read('owner'), read('operator'), read('sessionKeyExpiry'), read('frozen'), read('autoApproveMax'),
])
const now = BigInt(Math.floor(Date.now() / 1000))
const expiry = now + BigInt(Math.round(DAYS * 86400))

console.log(`Target:  ${chain.name} (${chain.caip2})`)
console.log(`Vault:   ${chain.explorer}/address/${VAULT}`)
console.log(`Owner:   ${owner}`)
console.log(`Session: operator ${operator}, expires ${iso(current)}${current !== 0n && current < now ? '  <- EXPIRED, pay() reverts SessionKeyExpired' : ''}`)
if (frozen) console.log('Note:    the vault is FROZEN; renewing the key does not unfreeze it, and pay() still reverts IsFrozen.')

const call = { to: VAULT, data: encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'setSessionKeyExpiry', args: [expiry] }) }
const prepared = (reason) => {
  console.log(`\nPREPARED (nothing was broadcast): ${reason}`)
  console.log(JSON.stringify({ executed: false, chainId: chain.evmChainId, from: owner, call: 'setSessionKeyExpiry', expiry: expiry.toString(), expiresAt: iso(expiry), ...call }, null, 2))
  process.exit(0)
}

const key = chain.signerEnvVar ? process.env[chain.signerEnvVar] : undefined
if (!key) prepared(`set ${chain.signerEnvVar} (the vault owner's key) to renew for real`)
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
if (account.address.toLowerCase() !== owner.toLowerCase()) {
  prepared(`${chain.signerEnvVar} is ${account.address}, not the owner; only the owner can renew, so the owner must send this call`)
}

const wallet = createWalletClient({ account, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
const hash = await wallet.writeContract({ address: VAULT, abi: AgentSpendPolicyAbi, functionName: 'setSessionKeyExpiry', args: [expiry] })
console.log(`\nrenew tx: ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
if (receipt.status !== 'success') { console.error(`error: setSessionKeyExpiry reverted (${chain.explorer}/tx/${hash})`); process.exit(1) }

// Report what the CONTRACT says now, not what we sent.
const after = await read('sessionKeyExpiry')
if (after !== expiry) { console.error(`error: contract reports expiry ${after}, expected ${expiry}. Investigate.`); process.exit(1) }
console.log(`renewed:  session key now expires ${iso(after)} (block ${receipt.blockNumber}, ${chain.explorer}/tx/${hash})`)

// Free readiness probe: simulate one operator pay() to the owner. The session gate is the
// only thing this proves; a later gate (allowlist, cap) answering instead is reported as is.
const probe = autoApproveMax > 0n && autoApproveMax < 10_000n ? autoApproveMax : 10_000n
try {
  await pub.simulateContract({ account: operator, address: VAULT, abi: AgentSpendPolicyAbi, functionName: 'pay', args: [owner, probe] })
  console.log(`probe:    an operator pay() of ${probe} base units simulates as allowed, nothing broadcast`)
} catch (e) {
  const typed = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? null
  if (typed === 'SessionKeyExpired') { console.error('error: pay() still simulates SessionKeyExpired after the renewal. Investigate.'); process.exit(1) }
  console.log(`probe:    session gate open; pay() now stops at a later gate: ${typed ?? (e?.shortMessage ?? 'unknown revert')}`)
}
