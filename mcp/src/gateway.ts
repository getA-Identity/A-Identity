/**
 * Circle Gateway - a unified, chain-abstracted USDC balance.
 *
 * Permissionless (no Circle API key). We deposit USDC into the Gateway Wallet on Arc
 * to establish a unified balance, then move it cross-chain with the Forwarding Service:
 * a signed EIP-712 "burn intent" is submitted to the Gateway API, which mints USDC on
 * the destination chain (Base Sepolia) in <500 ms - no wallet or gas needed there.
 *
 * All writes are env-gated behind ARC_SIGNER_KEY (the same funded testnet signer used
 * elsewhere). USDC uses the 6-decimal ERC-20 interface on both chains.
 */
import { randomBytes } from 'node:crypto'
import { ARC_CHAIN } from './chains/index.js'

export const GATEWAY_API = 'https://gateway-api-testnet.circle.com/v1'
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B'

/** Arc, from the one place a chain is described. RPC, USDC, the CCTP domain and the
 *  explorer were all restated here before; the CCTP domain in particular is its own id
 *  space, so a second copy of it is exactly the kind of value that drifts unnoticed. */
const ARC = {
  rpc: ARC_CHAIN.rpcUrls[0],
  usdc: ARC_CHAIN.contracts.usdc as string,
  domain: ARC_CHAIN.cctpDomain as number,
  explorer: ARC_CHAIN.explorer as string,
}
const BASE_SEPOLIA = {
  rpc: 'https://base-sepolia-rpc.publicnode.com',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  domain: 6,
  explorer: 'https://sepolia.basescan.org',
}

const usdcUnits = (usd: number) => BigInt(Math.round(usd * 1e6))
const fromUnits = (v: bigint) => Number(v) / 1e6
const bigintJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const GATEWAY_WALLET_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const

// EIP-712 types for the burn intent (verbatim from Circle's Gateway docs).
const TransferSpec = [
  { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
  { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' },
  { name: 'sourceToken', type: 'bytes32' }, { name: 'destinationToken', type: 'bytes32' },
  { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
  { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
  { name: 'value', type: 'uint256' }, { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
] as const
const BurnIntent = [
  { name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' },
] as const

async function arcSigner(env: NodeJS.ProcessEnv) {
  const key = env.ARC_SIGNER_KEY
  if (!key) return null
  const { createWalletClient, createPublicClient, http, defineChain } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const chain = defineChain({ id: ARC_CHAIN.evmChainId as number, name: ARC_CHAIN.name, nativeCurrency: ARC_CHAIN.nativeCurrency, rpcUrls: { default: { http: [ARC.rpc] } } })
  const account = privateKeyToAccount(key as `0x${string}`)
  return {
    account,
    wallet: createWalletClient({ account, chain, transport: http(ARC.rpc) }),
    pub: createPublicClient({ transport: http(ARC.rpc) }),
  }
}

/** Live unified balance for a depositor (available + pending), from the Gateway API. */
export async function gatewayBalance(depositor: string): Promise<{ available: number; pending: number } | { error: string }> {
  try {
    const r = await fetch(`${GATEWAY_API}/balances`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: ARC.domain, depositor }] }),
    })
    if (!r.ok) return { error: `balances ${r.status}` }
    const j = (await r.json()) as { balances?: { balance?: string; pendingBatch?: string }[] }
    const b = j.balances?.[0]
    return { available: Number(b?.balance ?? 0), pending: Number(b?.pendingBatch ?? 0) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Deposit USDC into the Gateway Wallet on Arc (approve + deposit). Establishes/tops up the unified balance. */
export async function gatewayDeposit(amountUsd: number, env: NodeJS.ProcessEnv = process.env) {
  const s = await arcSigner(env)
  if (!s) return { executed: false as const, reason: 'No ARC_SIGNER_KEY set.' }
  const value = usdcUnits(amountUsd)
  const approveTx = await s.wallet.writeContract({ address: ARC.usdc as `0x${string}`, abi: ERC20, functionName: 'approve', args: [GATEWAY_WALLET as `0x${string}`, value] })
  await s.pub.waitForTransactionReceipt({ hash: approveTx })
  const depositTx = await s.wallet.writeContract({ address: GATEWAY_WALLET as `0x${string}`, abi: GATEWAY_WALLET_ABI, functionName: 'deposit', args: [ARC.usdc as `0x${string}`, value] })
  await s.pub.waitForTransactionReceipt({ hash: depositTx })
  return { executed: true as const, amountUsd, approveTx, depositTx, approveUrl: `${ARC.explorer}/tx/${approveTx}`, depositUrl: `${ARC.explorer}/tx/${depositTx}` }
}

/**
 * Move `amountUsd` of the unified balance from Arc to Base Sepolia via the Forwarding
 * Service: estimate -> sign an EIP-712 burn intent -> submit. Circle mints on Base
 * automatically (gasless there). Returns the transferId (recipient = the signer).
 */
export async function gatewayTransfer(amountUsd: number, env: NodeJS.ProcessEnv = process.env) {
  const s = await arcSigner(env)
  if (!s) return { executed: false as const, reason: 'No ARC_SIGNER_KEY set.' }
  const { pad, zeroAddress } = await import('viem')
  const value = usdcUnits(amountUsd)
  const b32 = (a: string) => pad(a.toLowerCase() as `0x${string}`, { size: 32 })
  const specBytes32 = {
    version: 1, sourceDomain: ARC.domain, destinationDomain: BASE_SEPOLIA.domain,
    sourceContract: b32(GATEWAY_WALLET), destinationContract: b32(GATEWAY_MINTER),
    sourceToken: b32(ARC.usdc), destinationToken: b32(BASE_SEPOLIA.usdc),
    sourceDepositor: b32(s.account.address), destinationRecipient: b32(s.account.address),
    sourceSigner: b32(s.account.address), destinationCaller: b32(zeroAddress),
    value, salt: ('0x' + randomBytes(32).toString('hex')) as `0x${string}`, hookData: '0x' as `0x${string}`,
  }
  // 1) estimate (forwarder) -> maxFee + maxBlockHeight
  const est = await fetch(`${GATEWAY_API}/estimate?enableForwarder=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ spec: specBytes32 }], bigintJson),
  })
  if (!est.ok) return { executed: false as const, reason: `estimate ${est.status}: ${(await est.text()).slice(0, 200)}` }
  const estJson = (await est.json()) as { body: { burnIntent: { maxFee: string; maxBlockHeight: string } }[]; fees?: { forwardingFee?: string; token?: string } }
  const maxFee = BigInt(estJson.body[0].burnIntent.maxFee)
  const maxBlockHeight = BigInt(estJson.body[0].burnIntent.maxBlockHeight)
  // 2) sign the burn intent (EIP-712)
  const typedData = {
    types: { TransferSpec, BurnIntent },
    domain: { name: 'GatewayWallet', version: '1' },
    primaryType: 'BurnIntent' as const,
    message: { maxBlockHeight, maxFee, spec: specBytes32 },
  }
  const signature = await s.account.signTypedData(typedData as Parameters<typeof s.account.signTypedData>[0])
  // 3) submit (forwarder mints on the destination automatically)
  const tr = await fetch(`${GATEWAY_API}/transfer?enableForwarder=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ burnIntent: typedData.message, signature }], bigintJson),
  })
  if (!tr.ok) return { executed: false as const, reason: `transfer ${tr.status}: ${(await tr.text()).slice(0, 200)}` }
  const trJson = (await tr.json()) as { transferId?: string }
  return {
    executed: true as const, amountUsd, transferId: trJson.transferId ?? null,
    maxFeeUsd: fromUnits(maxFee), forwardingFee: estJson.fees?.forwardingFee ?? null,
    destination: 'Base Sepolia', recipient: s.account.address,
  }
}

/**
 * One-click Gateway demo: ensure a unified balance on Arc (top-up deposit if low),
 * then move `amountUsd` to Base Sepolia via the Forwarding Service and confirm the
 * gasless mint landed on Base. Env-gated; prepared without a key. Returns the trail.
 */
export async function runGatewayDemo(input: { amountUsd?: number } = {}, env: NodeJS.ProcessEnv = process.env) {
  const s = await arcSigner(env)
  if (!s) {
    return { executed: false as const, reason: 'No ARC_SIGNER_KEY set. With a funded key this deposits to Gateway and moves USDC Arc -> Base Sepolia (gasless).', gatewayWallet: GATEWAY_WALLET }
  }
  const me = s.account.address
  const amountUsd = input.amountUsd ?? 0.1

  // 1) ensure a unified balance (deposit tops up when low - deposits are available instantly on Arc)
  let bal = await gatewayBalance(me)
  let available = 'error' in bal ? 0 : bal.available
  let deposit: { amountUsd: number; depositTx?: string; explorerUrl?: string } | null = null
  if (available < amountUsd + 0.2) {
    const dep = await gatewayDeposit(2, env)
    if (dep.executed) {
      deposit = { amountUsd: 2, depositTx: dep.depositTx, explorerUrl: dep.depositUrl }
      bal = await gatewayBalance(me)
      available = 'error' in bal ? available : bal.available
    }
  }

  // 2) move it cross-chain (Arc -> Base Sepolia) via the Forwarding Service
  const before = await baseSepoliaUsdc(me)
  const tr = await gatewayTransfer(amountUsd, env)
  if (!tr.executed) {
    return { executed: true as const, recipient: me, amountUsd, unifiedBalanceUsd: available, deposit, transfer: { error: tr.reason }, baseMint: null }
  }

  // 3) confirm the gasless mint arrived on Base Sepolia
  let minted = false
  let after = before
  for (let i = 0; i < 8; i++) {
    const a = await baseSepoliaUsdc(me)
    if (a != null && before != null && a > before) { minted = true; after = a; break }
    await new Promise((r) => setTimeout(r, 5000))
  }

  return {
    executed: true as const,
    recipient: me,
    amountUsd,
    unifiedBalanceUsd: available,
    deposit,
    transfer: { transferId: tr.transferId, maxFeeUsd: tr.maxFeeUsd, forwardingFee: tr.forwardingFee, destination: 'Base Sepolia' },
    baseMint: { minted, beforeUsd: before, afterUsd: after, explorerUrl: `${BASE_SEPOLIA.explorer}/address/${me}` },
  }
}

/** Read the signer's live USDC balance on Base Sepolia (destination), for before/after proof. */
export async function baseSepoliaUsdc(address: string): Promise<number | null> {
  try {
    const { createPublicClient, http } = await import('viem')
    const pc = createPublicClient({ transport: http(BASE_SEPOLIA.rpc) })
    const bal = (await pc.readContract({ address: BASE_SEPOLIA.usdc as `0x${string}`, abi: ERC20, functionName: 'balanceOf', args: [address as `0x${string}`] })) as bigint
    return fromUnits(bal)
  } catch {
    return null
  }
}
