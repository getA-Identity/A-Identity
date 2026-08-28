#!/usr/bin/env node
/**
 * Deploy + configure ONE AgentSpendPolicy vault on any EVM MAINNET in the registry that
 * declares a settlement token, then prove the policy with real money at dust scale:
 * fund it, make one in-policy payment, and probe one refusal.
 *
 * The vault is per-agent runtime infrastructure (see ChainContracts.spendVault), so this
 * does not add a descriptor address; it proves the deploy path works on this chain and
 * leaves a real, linkable vault behind - the same statement rh-testnet-deploy-vault.mjs
 * makes for the testnet, now with live value.
 *
 * Token honesty: the vault holds the chain's DECLARED settlement token, read from the
 * registry's settlementTokens (USDG on Robinhood Chain, native Circle USDC on Arbitrum
 * One and Base), and the contract's own symbol()/decimals() are read live and checked
 * against the registry before anything deploys, failing closed on any mismatch.
 *
 * Policy honesty: dust caps on purpose, mirroring the Stellar pubnet vault ("small
 * money on purpose, and the cap is the reason"): default dailyCap $1, autoApprove $0.25.
 *
 * Prepared-or-executed: without the chain's signer env var this prints the exact deploy
 * it would make and exits.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/evm-mainnet-vault.mjs \
 *          --chain rhchain [--daily-cap 1] [--auto-approve 0.25] [--session-days 7] \
 *          [--fund 0.03] [--pay 0.01] [--pay-to 0x...]
 */
import { createPublicClient, createWalletClient, http, defineChain, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', '')
const DAILY_CAP_USD = Number(arg('daily-cap', '1'))
const AUTO_APPROVE_USD = Number(arg('auto-approve', '0.25'))
const SESSION_DAYS = Number(arg('session-days', '7'))
const FUND_USD = Number(arg('fund', '0'))
const PAY_USD = Number(arg('pay', '0'))
const PAY_TO = arg('pay-to', '')

let getChainById, resolveRpcUrls, AgentSpendPolicyAbi, AgentSpendPolicyBytecode
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
  ;({ AgentSpendPolicyAbi, AgentSpendPolicyBytecode } = await import('../dist/contracts/AgentSpendPolicy.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

const chain = getChainById(CHAIN_ID)
if (!chain) { console.error(`error: unknown chain '${CHAIN_ID}'`); process.exit(1) }
if (chain.ecosystem !== 'evm') { console.error(`error: ${CHAIN_ID} is not an EVM chain`); process.exit(1) }
if (chain.testnet) { console.error(`error: ${CHAIN_ID} is a testnet; this script is the mainnet path (rh-testnet-deploy-vault.mjs covers 46630)`); process.exit(1) }
const token = chain.settlementTokens?.[0]
if (!token) { console.error(`error: ${CHAIN_ID} declares no settlement token; a vault needs a real token to hold`); process.exit(1) }

const RPC = resolveRpcUrls(chain, process.env)[0]
const viemChain = defineChain({ id: chain.evmChainId, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

// Read the token's own story and check it against the registry before touching anything.
const ERC20 = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
]
const [liveSymbol, liveDecimals] = await Promise.all([
  pub.readContract({ address: token.address, abi: ERC20, functionName: 'symbol' }),
  pub.readContract({ address: token.address, abi: ERC20, functionName: 'decimals' }),
])
if (Number(liveDecimals) !== token.decimals) {
  console.error(`error: ${token.address} reports ${liveDecimals} decimals, registry says ${token.decimals}. Refusing.`)
  process.exit(1)
}
const units = (usd) => BigInt(Math.round(usd * 10 ** Number(liveDecimals)))

console.log(`Target: ${chain.name} (${chain.caip2})`)
console.log(`Token:  ${token.address} (${liveSymbol}, ${liveDecimals} decimals) - the registry's declared settlement token`)
console.log(`Policy: dailyCap $${DAILY_CAP_USD}, autoApprove $${AUTO_APPROVE_USD}, session key ${SESSION_DAYS}d`)

const key = chain.signerEnvVar ? process.env[chain.signerEnvVar] : undefined
if (!key) {
  console.log(`\nNo ${chain.signerEnvVar} set - PREPARED deployment (nothing was broadcast):`)
  console.log(JSON.stringify({
    executed: false,
    chainId: chain.evmChainId,
    deploy: 'AgentSpendPolicy',
    constructorArgs: { owner: '(signer)', operator: '(signer)', usdc: token.address, dailyCap: units(DAILY_CAP_USD).toString(), autoApproveMax: units(AUTO_APPROVE_USD).toString() },
    reason: `set ${chain.signerEnvVar} to deploy the per-agent vault for real`,
  }, null, 2))
  process.exit(0)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const wallet = createWalletClient({ account, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
console.log(`Signer: ${account.address}`)

const hash = await wallet.deployContract({
  abi: AgentSpendPolicyAbi,
  bytecode: AgentSpendPolicyBytecode,
  args: [account.address, account.address, token.address, units(DAILY_CAP_USD), units(AUTO_APPROVE_USD)],
})
console.log(`deploy tx: ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
if (receipt.status !== 'success' || !receipt.contractAddress) {
  console.error(`error: vault deploy reverted (${chain.explorer}/tx/${hash})`)
  process.exit(1)
}
const vault = receipt.contractAddress
console.log(`vault:     ${chain.explorer}/address/${vault}  (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)`)

// Configure: give the operator a time-bounded session key (a real policy write).
const expiry = BigInt(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400)
const cfgHash = await wallet.writeContract({ address: vault, abi: AgentSpendPolicyAbi, functionName: 'setSessionKeyExpiry', args: [expiry] })
const cfgReceipt = await pub.waitForTransactionReceipt({ hash: cfgHash, timeout: 180_000 })
if (cfgReceipt.status !== 'success') { console.error(`error: setSessionKeyExpiry reverted (${chain.explorer}/tx/${cfgHash})`); process.exit(1) }
console.log(`session:   expires ${new Date(Number(expiry) * 1000).toISOString()} (tx ${cfgHash})`)

// Read back the on-chain state - report what the CONTRACT says, not what we sent.
const read = (fn, args = []) => pub.readContract({ address: vault, abi: AgentSpendPolicyAbi, functionName: fn, args })
const [owner, operator, dailyCap, autoApproveMax, frozen] = await Promise.all([
  read('owner'), read('operator'), read('dailyCap'), read('autoApproveMax'), read('frozen'),
])
console.log('\nOn-chain vault state:')
console.log(JSON.stringify({ vault, owner, operator, dailyCap: dailyCap.toString(), autoApproveMax: autoApproveMax.toString(), frozen, token: token.address, tokenSymbol: liveSymbol }, null, 2))

// ── The policy, proven with real value (dust scale, and the caps are the point) ──
if (FUND_USD > 0) {
  const fundHash = await wallet.writeContract({ address: token.address, abi: ERC20, functionName: 'transfer', args: [vault, units(FUND_USD)] })
  const fr = await pub.waitForTransactionReceipt({ hash: fundHash, timeout: 180_000 })
  if (fr.status !== 'success') { console.error(`error: funding transfer reverted (tx ${fundHash})`); process.exit(1) }
  console.log(`\nfunded:    ${FUND_USD} ${liveSymbol} into the vault (tx ${fundHash})`)
}
if (PAY_USD > 0) {
  const payee = PAY_TO || account.address
  const payHash = await wallet.writeContract({ address: vault, abi: AgentSpendPolicyAbi, functionName: 'pay', args: [payee, units(PAY_USD)] })
  const pr = await pub.waitForTransactionReceipt({ hash: payHash, timeout: 180_000 })
  if (pr.status !== 'success') { console.error(`error: in-policy pay reverted (tx ${payHash})`); process.exit(1) }
  console.log(`paid:      ${PAY_USD} ${liveSymbol} to ${payee} inside the policy (tx ${payHash}, block ${pr.blockNumber})`)

  // Refusal probe, free: simulate a payment above autoApprove and expect the TYPED error.
  // simulateContract, not raw eth_call: viem decodes the custom error from the revert
  // data there, while some RPCs' plain call errors surface only "execution reverted".
  try {
    await pub.simulateContract({
      account: account.address,
      address: vault,
      abi: AgentSpendPolicyAbi,
      functionName: 'pay',
      args: [payee, units(AUTO_APPROVE_USD * 2)],
    })
    console.error('error: an over-autoApprove payment SIMULATED as allowed; the policy is not enforcing. Investigate before claiming anything.')
    process.exit(1)
  } catch (e) {
    const typed = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? /AboveAutoApprove|DailyCapExceeded/.exec(e?.message ?? '')?.[0] ?? null
    if (typed === 'AboveAutoApprove' || typed === 'DailyCapExceeded') {
      console.log(`refused:   a $${AUTO_APPROVE_USD * 2} payment simulates to the contract's own typed ${typed} error, nothing broadcast`)
    } else {
      console.error(`error: over-limit simulation reverted WITHOUT a recognizable typed error: ${(e?.message ?? '').slice(0, 200)}`)
      process.exit(1)
    }
  }
  const [bal, spent] = await Promise.all([read('balance'), read('spentToday')])
  console.log(`state:     vault balance ${bal} base units, spentToday ${spent} base units`)
}
