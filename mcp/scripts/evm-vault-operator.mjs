#!/usr/bin/env node
/**
 * Give ONE existing AgentSpendPolicy vault an operator (the agent's session key) that is not
 * its owner: an owner-only setOperator(newOperator), on any EVM chain in the registry.
 *
 * Why this exists: evm-mainnet-vault.mjs deployed the Arc Mainnet vault with owner and
 * operator set to the same operating key. The contract's promise is that the agent's key is
 * bounded (cap, ceiling, allowlist, freeze, expiry) while only the owner can change those
 * bounds or withdraw. With one key in both roles, whoever holds the agent's key also holds
 * the owner's, and the promise is empty. The console already refuses that shape for product
 * vaults (platform/vault.ts); this brings the script-deployed vault in line.
 *
 * The contract has no owner transfer, so the owner stays where it is and the operator moves.
 *
 * Prepared-or-executed: without the owner's key this prints the exact call and exits. After
 * a broadcast it reads the operator back from the contract, then simulates (nothing
 * broadcast) that the new operator is refused every owner power and anything above the
 * auto-approve ceiling. With --pay <usd> the new operator also broadcasts one in-policy pay()
 * to the owner, and the Paid event and the vault balance are read back from the chain.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/evm-vault-operator.mjs \
 *          --chain arc-mainnet --vault 0x... --operator-env X402_3009_BUYER_KEY [--pay 0.01]
 */
import { createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, isAddress, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', '')
const VAULT = arg('vault', '')
const OPERATOR_ENV = arg('operator-env', '')
const PAY_USD = arg('pay', '')

if (!isAddress(VAULT)) { console.error('error: --vault 0x... is required'); process.exit(1) }
if (!OPERATOR_ENV) { console.error('error: --operator-env NAME is required (the env var holding the new operator key)'); process.exit(1) }
const opKey = process.env[OPERATOR_ENV]
if (!opKey) { console.error(`error: ${OPERATOR_ENV} is not set, so there is no operator to hand the vault to`); process.exit(1) }
const opAccount = privateKeyToAccount(opKey.startsWith('0x') ? opKey : `0x${opKey}`)
if (PAY_USD && !(Number(PAY_USD) > 0 && Number(PAY_USD) <= 1)) { console.error('error: --pay must be a USD amount above 0 and at most 1'); process.exit(1) }

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
const decimals = chain.settlementTokens?.[0]?.decimals ?? 6
const units = (usd) => BigInt(Math.round(Number(usd) * 10 ** decimals))
const usd = (u) => (Number(u) / 10 ** decimals).toString()

const [owner, current, autoApproveMax, dailyCap, frozen, expiry] = await Promise.all([
  read('owner'), read('operator'), read('autoApproveMax'), read('dailyCap'), read('frozen'), read('sessionKeyExpiry'),
])
const next = opAccount.address

console.log(`Target:   ${chain.name} (${chain.caip2})`)
console.log(`Vault:    ${chain.explorer}/address/${VAULT}`)
console.log(`Owner:    ${owner}`)
console.log(`Operator: ${current}${current.toLowerCase() === owner.toLowerCase() ? '  <- same key as the owner' : ''}`)
console.log(`New:      ${next} (from ${OPERATOR_ENV})`)
console.log(`Policy:   dailyCap ${usd(dailyCap)}, autoApproveMax ${usd(autoApproveMax)}, frozen ${frozen}, session key expires ${expiry === 0n ? 'never' : new Date(Number(expiry) * 1000).toISOString()}`)

if (next.toLowerCase() === owner.toLowerCase()) {
  console.error('error: the new operator is the owner, which is the shape this script exists to remove')
  process.exit(1)
}

if (current.toLowerCase() === next.toLowerCase()) {
  console.log('\nsetOperator: skipped, the vault already has this operator')
} else {
  const call = { to: VAULT, data: encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'setOperator', args: [next] }) }
  const prepared = (reason) => {
    console.log(`\nPREPARED (nothing was broadcast): ${reason}`)
    console.log(JSON.stringify({ executed: false, chainId: chain.evmChainId, from: owner, call: 'setOperator', operator: next, ...call }, null, 2))
    process.exit(0)
  }
  const key = chain.signerEnvVar ? process.env[chain.signerEnvVar] : undefined
  if (!key) prepared(`set ${chain.signerEnvVar} (the vault owner's key) to broadcast`)
  const ownerAccount = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  if (ownerAccount.address.toLowerCase() !== owner.toLowerCase()) {
    prepared(`${chain.signerEnvVar} is ${ownerAccount.address}, not the owner; the owner must send this call`)
  }
  const wallet = createWalletClient({ account: ownerAccount, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
  const hash = await wallet.writeContract({ address: VAULT, abi: AgentSpendPolicyAbi, functionName: 'setOperator', args: [next] })
  console.log(`\nsetOperator tx: ${hash}`)
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') { console.error(`error: setOperator reverted (${chain.explorer}/tx/${hash})`); process.exit(1) }
  const after = await read('operator')
  if (after.toLowerCase() !== next.toLowerCase()) { console.error(`error: contract reports operator ${after}, expected ${next}. Investigate.`); process.exit(1) }
  console.log(`operator: now ${after} (block ${receipt.blockNumber}, ${chain.explorer}/tx/${hash})`)
}

// What the split buys, read from the contract rather than asserted: the agent's key is refused
// every owner power, and the owner's key is no longer the agent. Simulations only.
const typedError = async (account, functionName, args) => {
  try {
    await pub.simulateContract({ account, address: VAULT, abi: AgentSpendPolicyAbi, functionName, args })
    return 'ALLOWED'
  } catch (e) {
    return e?.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? e?.shortMessage ?? 'unknown revert'
  }
}
const checks = [
  ['operator withdraw()', next, 'withdraw', [next, 1n], 'NotOwner'],
  ['operator setPolicy() to raise its own cap', next, 'setPolicy', [units(1000), units(1000), false], 'NotOwner'],
  ['operator setSessionKeyExpiry(0) to never expire', next, 'setSessionKeyExpiry', [0n], 'NotOwner'],
  ['operator ownerPay() to skip the ceiling', next, 'ownerPay', [next, 1n], 'NotOwner'],
  ['operator setOperator() to hand itself on', next, 'setOperator', [next], 'NotOwner'],
  ['operator pay() above autoApproveMax', next, 'pay', [owner, autoApproveMax + 1n], 'AboveAutoApprove'],
  ['owner pay() as if it were the agent', owner, 'pay', [owner, 1n], 'NotOperator'],
]
let bad = 0
console.log('\nsimulated, nothing broadcast:')
for (const [label, account, fn, args, want] of checks) {
  const got = await typedError(account, fn, args)
  const ok = got === want
  if (!ok) bad++
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`)
}
if (bad) { console.error(`error: ${bad} check(s) did not answer as the contract should`); process.exit(1) }

if (PAY_USD) {
  const amount = units(PAY_USD)
  const before = await read('balance')
  const opWallet = createWalletClient({ account: opAccount, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
  const hash = await opWallet.writeContract({ address: VAULT, abi: AgentSpendPolicyAbi, functionName: 'pay', args: [owner, amount] })
  console.log(`\noperator pay tx: ${hash}`)
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') { console.error(`error: pay reverted (${chain.explorer}/tx/${hash})`); process.exit(1) }
  const paid = parseEventLogs({ abi: AgentSpendPolicyAbi, eventName: 'Paid', logs: receipt.logs })
  const hit = paid.find((l) => l.address.toLowerCase() === VAULT.toLowerCase() && l.args.amount === amount && l.args.byOwner === false)
  const afterBal = await read('balance')
  if (!hit || before - afterBal !== amount) { console.error('error: no matching Paid event or the vault balance did not move by the amount. Investigate.'); process.exit(1) }
  console.log(`paid:     ${usd(amount)} USDC by the operator, Paid(byOwner=false) at block ${receipt.blockNumber}; vault balance ${usd(before)} -> ${usd(afterBal)}`)
  console.log(`          ${chain.explorer}/tx/${hash}`)
}
