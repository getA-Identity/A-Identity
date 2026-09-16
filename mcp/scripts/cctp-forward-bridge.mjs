#!/usr/bin/env node
/**
 * Move native Circle USDC between two EVM chains in the registry over CCTP V2 with Circle's
 * Forwarding Service, so the DESTINATION needs no gas and no key of ours: the burn carries
 * the `cctp-forward` hook, Circle attests and broadcasts the mint, and the fee comes out of
 * the burned amount. Built for the day a chain opens and nothing of ours holds its gas token
 * yet (Arc mainnet, 2026-09-16), and chain-generic because nothing about that is Arc-shaped.
 *
 * Optional sweep first: `--sweep-env X402_3009_BUYER_KEY --sweep 1.0` moves USDC from a
 * second key of ours that holds USDC but no native gas into the source signer, as an
 * EIP-3009 transferWithAuthorization the swept key signs and the signer broadcasts. Same
 * mechanism the x402-3009 rail uses, so it needs nothing new from the token.
 *
 * Nothing is reported as arrived until the destination's own receipt for Iris's
 * forwardTxHash is read back as successful AND the recipient's USDC balance moved.
 *
 * Prepared-or-executed: without the source chain's signer env var this prints the exact
 * calls it would make and exits. The signer env var is the SOURCE descriptor's, so
 * bridging Base -> Arc mainnet needs BASE_SIGNER_KEY and nothing on Arc.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/cctp-forward-bridge.mjs \
 *          --from base --to arc-mainnet --amount all|<usd> [--recipient 0x...] \
 *          [--sweep-env X402_3009_BUYER_KEY --sweep <usd>] [--finality 1000|2000] [--fee-level med|high]
 */
import { createPublicClient, createWalletClient, pad, parseAbi, formatUnits, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const FROM = arg('from', '')
const TO = arg('to', '')
const AMOUNT = arg('amount', '')
const RECIPIENT = arg('recipient', '')
const SWEEP_ENV = arg('sweep-env', '')
const SWEEP_USD = arg('sweep', '')
const FINALITY = Number(arg('finality', '1000'))
const FEE_LEVEL = arg('fee-level', 'high')

let getChainById, evmTransport, irisHost, irisTxHash, maxFeeFor
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ evmTransport } = await import('../dist/chains/evm/client.js'))
  ;({ irisHost, irisTxHash, maxFeeFor } = await import('../dist/cctp-stellar.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }
const from = getChainById(FROM)
const to = getChainById(TO)
if (!from || !to) fail(`unknown chain: --from ${FROM} --to ${TO}`)
for (const c of [from, to]) {
  if (c.ecosystem !== 'evm') fail(`${c.id} is not EVM; cctp-stellar.ts covers Stellar`)
  if (c.cctpDomain === null || !c.contracts.cctp || !c.contracts.usdc) fail(`${c.id} declares no CCTP domain, CCTP contracts or USDC in the registry`)
}
if (from.testnet !== to.testnet) fail('source and destination must both be mainnets or both testnets')
if (![1000, 2000].includes(FINALITY)) fail('--finality must be 1000 (fast) or 2000 (standard)')

// The forwarding hook, version 0 with no integrator data: the static value Circle documents
// at developers.circle.com/cctp/concepts/forwarding-service ("cctp-forward", v0, length 0).
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
])
const TOKEN_MESSENGER = parseAbi([
  'function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)',
])

const srcPub = createPublicClient({ transport: await evmTransport(from) })
const dstPub = createPublicClient({ transport: await evmTransport(to) })
const units = (usd) => BigInt(Math.round(Number(usd) * 1e6))
const usd = (u) => formatUnits(u, 6)
const host = irisHost(from.testnet)

const key = from.signerEnvVar ? process.env[from.signerEnvVar] : undefined
const norm = (k) => (k.startsWith('0x') ? k : `0x${k}`)
const signer = key ? privateKeyToAccount(norm(key)) : null
const recipient = getAddress(RECIPIENT || signer?.address || fail('--recipient is required when no signer is set'))

console.log(`Route:     ${from.name} (domain ${from.cctpDomain}) -> ${to.name} (domain ${to.cctpDomain}), Forwarding Service`)
console.log(`Recipient: ${recipient} on ${to.caip2}`)

// Fees first: forwarding is quoted in USDC units and moves with destination gas.
const feeRes = await fetch(`${host}/v2/burn/USDC/fees/${from.cctpDomain}/${to.cctpDomain}?forward=true`)
if (!feeRes.ok) fail(`Iris fee endpoint answered ${feeRes.status}`)
const tiers = await feeRes.json()
const tier = tiers.find((t) => t.finalityThreshold === FINALITY)
if (!tier?.forwardFee?.[FEE_LEVEL]) fail(`Iris returned no forwardFee.${FEE_LEVEL} for finality ${FINALITY}: ${JSON.stringify(tiers)}`)
const forwardFee = BigInt(tier.forwardFee[FEE_LEVEL])
console.log(`Fees:      forwardFee.${FEE_LEVEL} ${usd(forwardFee)} USDC, protocol ${tier.minimumFee} bps at finality ${FINALITY}`)

if (!signer) {
  console.log(`\nNo ${from.signerEnvVar} set - PREPARED (nothing was broadcast):`)
  console.log(JSON.stringify({
    executed: false,
    steps: [
      { contract: from.contracts.usdc, function: 'approve', args: [from.contracts.cctp.tokenMessenger, '(amount)'] },
      { contract: from.contracts.cctp.tokenMessenger, function: 'depositForBurnWithHook', args: ['(amount)', to.cctpDomain, pad(recipient, { size: 32 }), from.contracts.usdc, pad('0x', { size: 32 }), `(forwardFee ${forwardFee} + protocol fee)`, FINALITY, FORWARD_HOOK] },
    ],
    reason: `set ${from.signerEnvVar} to bridge for real`,
  }, null, 2))
  process.exit(0)
}
const wallet = createWalletClient({ account: signer, transport: await evmTransport(from) })
const send = async (label, req) => {
  const hash = await wallet.writeContract({ chain: null, ...req })
  const r = await srcPub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') fail(`${label} reverted: ${from.explorer}/tx/${hash}`)
  console.log(`${label.padEnd(10)} ${from.explorer}/tx/${hash} (block ${r.blockNumber}, ${r.gasUsed} gas)`)
  return { hash, receipt: r }
}
const USDC = from.contracts.usdc
console.log(`Signer:    ${signer.address}`)

// A receipt from one RPC node does not mean the next read (or the next gas estimate) lands
// on a node that has the block yet: the fallback transport spans several providers. Found
// on the first mainnet run, where a burn estimated against a node that had not seen its own
// approve. Every state a later step depends on is therefore polled until it is visible.
const waitFor = async (label, read, ok) => {
  for (let i = 0; i < 40; i++) {
    const v = await read()
    if (ok(v)) return v
    await new Promise((r) => setTimeout(r, 1500))
  }
  fail(`${label} was not visible on the source RPCs after 60 s`)
}

// ── optional sweep: a USDC-holding key with no native gas signs, the signer broadcasts ──
if (SWEEP_ENV) {
  const sk = process.env[SWEEP_ENV]
  if (!sk) fail(`--sweep-env ${SWEEP_ENV} is not set`)
  const swept = privateKeyToAccount(norm(sk))
  const value = units(SWEEP_USD)
  const have = await srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [swept.address] })
  if (value <= 0n || value > have) fail(`sweep of ${SWEEP_USD} USDC from ${swept.address} exceeds its balance ${usd(have)}`)
  const [name, version] = await Promise.all([
    srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'name' }),
    srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'version' }),
  ])
  const nonce = `0x${randomBytes(32).toString('hex')}`
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600)
  const message = { from: swept.address, to: signer.address, value, validAfter: 0n, validBefore, nonce }
  const signature = await swept.signTypedData({
    domain: { name, version, chainId: from.evmChainId, verifyingContract: USDC },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message,
  })
  const r = `0x${signature.slice(2, 66)}`
  const s = `0x${signature.slice(66, 130)}`
  const v = parseInt(signature.slice(130, 132), 16)
  console.log(`Sweep:     ${usd(value)} USDC from ${swept.address} (${SWEEP_ENV}) to the signer, EIP-3009 signed by the holder`)
  const signerBefore = await srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [signer.address] })
  await send('sweep tx', { address: USDC, abi: ERC20, functionName: 'transferWithAuthorization', args: [message.from, message.to, message.value, message.validAfter, message.validBefore, nonce, v, r, s] })
  await waitFor('the swept balance', () => srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [signer.address] }), (b) => b >= signerBefore + value)
}

// ── amounts ──
const balance = await srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [signer.address] })
const total = AMOUNT === 'all' ? balance : units(AMOUNT)
if (total <= 0n || total > balance) fail(`burn of ${usd(total)} USDC exceeds the signer balance ${usd(balance)}`)
// maxFeeFor rounds the protocol fee UP from basis points; the forwarding fee rides on top.
const maxFee = maxFeeFor(total, tiers, FINALITY) + forwardFee
if (maxFee >= total) fail(`fees ${usd(maxFee)} would consume the whole ${usd(total)} USDC burn`)
console.log(`Burn:      ${usd(total)} USDC, maxFee ${usd(maxFee)}, recipient receives at least ${usd(total - maxFee)}`)

const before = await dstPub.readContract({ address: to.contracts.usdc, abi: ERC20, functionName: 'balanceOf', args: [recipient] })

const allowance = await srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [signer.address, from.contracts.cctp.tokenMessenger] })
if (allowance < total) {
  await send('approve', { address: USDC, abi: ERC20, functionName: 'approve', args: [from.contracts.cctp.tokenMessenger, total] })
  await waitFor('the approval', () => srcPub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [signer.address, from.contracts.cctp.tokenMessenger] }), (a) => a >= total)
}
const burn = await send('burn', {
  address: from.contracts.cctp.tokenMessenger,
  abi: TOKEN_MESSENGER,
  functionName: 'depositForBurnWithHook',
  args: [total, to.cctpDomain, pad(recipient, { size: 32 }), USDC, pad('0x', { size: 32 }), maxFee, FINALITY, FORWARD_HOOK],
})

// ── wait for Circle's forwarded mint, then prove it on the destination ourselves ──
const started = Date.now()
let msg
process.stdout.write('Iris:      waiting for the forwarded mint')
while (Date.now() - started < 30 * 60 * 1000) {
  const res = await fetch(`${host}/v2/messages/${from.cctpDomain}?transactionHash=${irisTxHash(burn.hash)}`)
  if (res.ok) {
    msg = (await res.json()).messages?.[0]
    if (msg?.forwardTxHash) break
    if (msg?.forwardState && /fail/i.test(msg.forwardState)) break
  }
  process.stdout.write('.')
  await new Promise((r) => setTimeout(r, 5000))
}
console.log()
if (!msg?.forwardTxHash) fail(`no forwardTxHash after ${Math.round((Date.now() - started) / 1000)} s; last Iris message: ${JSON.stringify(msg ?? null)}. Resume by polling ${host}/v2/messages/${from.cctpDomain}?transactionHash=${burn.hash}`)
const mint = await dstPub.waitForTransactionReceipt({ hash: msg.forwardTxHash, timeout: 180_000 })
if (mint.status !== 'success') fail(`forwarded mint reverted: ${to.explorer}/tx/${msg.forwardTxHash}`)
const after = await dstPub.readContract({ address: to.contracts.usdc, abi: ERC20, functionName: 'balanceOf', args: [recipient] })
if (after <= before) fail(`mint receipt succeeded but ${recipient} did not gain USDC (${usd(before)} -> ${usd(after)})`)
console.log(`mint       ${to.explorer}/tx/${msg.forwardTxHash} (block ${mint.blockNumber}, forwarded by ${mint.from})`)
console.log(`Arrived:   ${usd(after - before)} USDC at ${recipient} (balance ${usd(before)} -> ${usd(after)}), fees ${usd(total - (after - before))}`)
console.log(JSON.stringify({
  route: `${from.caip2} -> ${to.caip2}`,
  burnTx: burn.hash,
  burnBlock: burn.receipt.blockNumber.toString(),
  mintTx: msg.forwardTxHash,
  mintBlock: mint.blockNumber.toString(),
  burnedUnits: total.toString(),
  arrivedUnits: (after - before).toString(),
  finality: FINALITY,
  eta: `${Math.round((Date.now() - started) / 1000)} s from burn receipt to forwarded mint`,
}, null, 2))
