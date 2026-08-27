/**
 * ERC-4337 session-key smart account (idea C, phase C2) - the REAL account-abstraction
 * expression of bounded authority, on Arc testnet.
 *
 * The human owner deploys a Kernel (ERC-4337 v0.7) smart account and grants the agent a
 * SESSION KEY scoped by three standard permission policies:
 *   - `toTimestampPolicy(validUntil)` - the key EXPIRES at a UNIX time (bounded authority in time)
 *   - `toCallPolicy(... transfer(to == allowlisted, amount <= cap) ...)` - a per-tx CAP + a payee ALLOWLIST
 * The agent then settles USDC entirely on its own by signing a UserOperation with the session
 * key; a payment outside the bounds is rejected by the on-chain validator (not a server). When
 * the key expires it simply stops. This maps our AgentSpendPolicy vault onto the *standard* AA
 * session-key primitive - the same idea, expressed as a real UserOp through a bundler.
 *
 * Additive + credential-gated exactly like circle-agent.ts: a clean `prepared` no-op unless
 * PIMLICO_API_KEY (the Arc bundler) + ARC_SIGNER_KEY (the funding/owner signer) are set. The
 * Zerodev SDK is imported DYNAMICALLY so tsc/boot never hard-depend on it.
 *
 * NOTE on the RPC: Kernel's counterfactual-address step (`getSenderAddress`) needs an RPC that
 * returns eth_call revert data in viem's expected shape. Arc's primary `rpc.testnet.arc.network`
 * does NOT; `rpc.blockdaemon.testnet.arc.network` does - so the AA reads route through it.
 */
import { ARC_EXPLORER, CONTRACTS } from './arc-contracts.js'
import { ARC_CHAIN } from './chains/index.js'

/** Arc RPCs whose eth_call revert format works with the Kernel getSenderAddress step. */
const AA_RPCS = [
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
]
const ARC_CHAIN_ID = ARC_CHAIN.evmChainId as number
const USDC = CONTRACTS.usdc as `0x${string}`
const ERC20_TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

/** Session-key AA is available only with a bundler key + a funding signer. */
export function aaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.PIMLICO_API_KEY && !!env.ARC_SIGNER_KEY
}

const usdcUnits = (usd: number) => BigInt(Math.round(usd * 1e6))
const bundlerUrl = (env: NodeJS.ProcessEnv) => `https://api.pimlico.io/v2/${ARC_CHAIN_ID}/rpc?apikey=${env.PIMLICO_API_KEY}`

/** Pimlico gas price for a self-funded UserOp (no paymaster). */
async function pimlicoFees(env: NodeJS.ProcessEnv) {
  const r = await fetch(bundlerUrl(env), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pimlico_getUserOperationGasPrice', params: [] }),
  })
  const g = (await r.json()).result.fast
  return { maxFeePerGas: BigInt(g.maxFeePerGas), maxPriorityFeePerGas: BigInt(g.maxPriorityFeePerGas) }
}

/** Build the Kernel account + session-key client, scoped to {cap, allowlist, expiry}. */
async function buildSessionAccount(
  env: NodeJS.ProcessEnv,
  scope: { capUsd: number; allowlistTo: `0x${string}`; validUntil: number },
  sponsor = false,
) {
  const { createKernelAccount, createKernelAccountClient } = await import('@zerodev/sdk')
  const { getEntryPoint, KERNEL_V3_1 } = await import('@zerodev/sdk/constants')
  const { signerToEcdsaValidator } = await import('@zerodev/ecdsa-validator')
  const { toPermissionValidator } = await import('@zerodev/permissions')
  const { toECDSASigner } = await import('@zerodev/permissions/signers')
  const { toCallPolicy, toTimestampPolicy, CallPolicyVersion, ParamCondition } = await import('@zerodev/permissions/policies')
  const { createPublicClient, http, defineChain, fallback } = await import('viem')
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')

  const arc = defineChain({
    id: ARC_CHAIN_ID, name: 'Arc Testnet',
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: AA_RPCS } },
  })
  const entryPoint = getEntryPoint('0.7')
  const kernelVersion = KERNEL_V3_1
  const publicClient = createPublicClient({ chain: arc, transport: fallback(AA_RPCS.map((u) => http(u))) })

  const owner = privateKeyToAccount(env.ARC_SIGNER_KEY as `0x${string}`)
  const sudoValidator = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion })

  // The session key - a fresh scoped signer the owner authorizes.
  const sessionKey = privateKeyToAccount(generatePrivateKey())
  const sessionSigner = await toECDSASigner({ signer: sessionKey })
  const permission = await toPermissionValidator(publicClient, {
    entryPoint, kernelVersion, signer: sessionSigner,
    policies: [
      // Time bound: the key stops working after validUntil.
      toTimestampPolicy({ validUntil: scope.validUntil }),
      // Scope: only USDC.transfer(to == allowlisted, amount <= cap). Anything else is rejected.
      // (Cast the whole arg: the policy's arg-condition generics are stricter than we need here.)
      toCallPolicy({
        policyVersion: CallPolicyVersion.V0_0_5,
        permissions: [{
          target: USDC,
          valueLimit: 0n,
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [
            { condition: ParamCondition.EQUAL, value: scope.allowlistTo },
            { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdcUnits(scope.capUsd) },
          ],
        }],
      } as never),
    ],
  })

  const account = await createKernelAccount(publicClient, {
    entryPoint, kernelVersion,
    plugins: { sudo: sudoValidator, regular: permission },
  })
  // Paymaster (Gas Station / gas sponsorship): when `sponsor`, route the UserOp's gas through
  // Pimlico's ERC-7677 paymaster (viem's createPaymasterClient - no `permissionless` dependency),
  // so the agent's session key pays ZERO gas. Requires a Pimlico sponsorship policy on the
  // account; without one, use the self-funded path instead (see runSessionKeyDemo).
  let paymaster: unknown
  if (sponsor) {
    const { createPaymasterClient } = await import('viem/account-abstraction')
    paymaster = createPaymasterClient({ transport: http(bundlerUrl(env)) })
  }
  const kernelClient = createKernelAccountClient({
    account, chain: arc, bundlerTransport: http(bundlerUrl(env)),
    ...(paymaster ? { paymaster: paymaster as never } : {}),
    userOperation: { estimateFeesPerGas: async () => pimlicoFees(env) },
  })
  return { account, kernelClient, owner, sessionKey, publicClient, sponsored: sponsor }
}

type Attempt = { label: string; to: string; amountUsd: number; settled: boolean; txHash?: string; explorerUrl?: string; rejectedReason?: string }

/**
 * One-click demo of a REAL ERC-4337 session key on Arc: deploy a Kernel SCA, grant a session
 * key scoped to {cap, payee allowlist, expiry}, fund it, then let the SESSION KEY settle a
 * payment WITHIN bounds (a real UserOp) and attempt one OUTSIDE bounds (rejected on-chain by
 * the policy validator, not a server). Prepared without a bundler key.
 */
export async function runSessionKeyDemo(
  input: { capUsd?: number; expirySeconds?: number; sponsorGas?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { executed: false; reason: string }
  | {
      executed: true
      sca: string
      sessionKey: string
      scopedTo: { capUsd: number; allowlist: string; expiresAt: number }
      gasSponsored: boolean
      funded: { amountUsd: number; txHash?: string } | null
      attempts: Attempt[]
    }
> {
  if (!aaEnabled(env)) {
    return {
      executed: false,
      reason: 'No PIMLICO_API_KEY (+ ARC_SIGNER_KEY) set. With them, this deploys a Kernel ERC-4337 smart account, grants a session key scoped to a spend cap + payee allowlist + expiry, and settles a real UserOp within bounds (rejecting anything outside) - bounded authority on the standard AA primitive.',
    }
  }
  const capUsd = Math.min(Math.max(input.capUsd ?? 0.05, 0.001), 1)
  const validUntil = Math.floor(Date.now() / 1000) + Math.min(Math.max(input.expirySeconds ?? 3600, 60), 86400)

  const { encodeFunctionData, parseUnits } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const owner = privateKeyToAccount(env.ARC_SIGNER_KEY as `0x${string}`)
  const allowlistTo = owner.address // the session key may only pay THIS payee, up to the cap

  const sponsor = input.sponsorGas === true
  const { account, kernelClient, sessionKey, publicClient, sponsored } = await buildSessionAccount(env, { capUsd, allowlistTo, validUntil }, sponsor)
  const sca = account.address

  // Fund the SCA with a little native USDC for its own UserOp gas (from the owner EOA).
  const { createWalletClient, http: vhttp, defineChain } = await import('viem')
  const arc = defineChain({ id: ARC_CHAIN_ID, name: 'Arc Testnet', nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: AA_RPCS } } })
  const wallet = createWalletClient({ account: owner, chain: arc, transport: vhttp(AA_RPCS[0]) })
  // With a paymaster the SCA needs no native gas; only fund it on the self-funded path.
  let funded: { amountUsd: number; txHash?: string } | null = null
  if (!sponsored) {
    const bal = await publicClient.getBalance({ address: sca })
    if (bal < parseUnits('0.2', 18)) {
      const fundTx = await wallet.sendTransaction({ to: sca, value: parseUnits('0.3', 18) })
      await publicClient.waitForTransactionReceipt({ hash: fundTx })
      funded = { amountUsd: 0.3, txHash: fundTx }
    }
  }

  const transferCall = (to: `0x${string}`, amountUsd: number) => account.encodeCalls([{
    to: USDC, value: 0n,
    data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [to, usdcUnits(amountUsd)] }),
  }])

  const attempts: Attempt[] = []

  // 1) WITHIN bounds: pay the allowlisted payee, under the cap -> the session key settles it.
  try {
    const callData = await transferCall(allowlistTo, Math.min(0.01, capUsd))
    const uo = await kernelClient.sendUserOperation({ callData })
    const receipt = await kernelClient.waitForUserOperationReceipt({ hash: uo })
    const tx = receipt.receipt.transactionHash
    attempts.push({ label: 'in-bounds: allowlisted payee, under cap', to: allowlistTo, amountUsd: Math.min(0.01, capUsd), settled: receipt.success, txHash: tx, explorerUrl: `${ARC_EXPLORER}/tx/${tx}` })
  } catch (e) {
    attempts.push({ label: 'in-bounds: allowlisted payee, under cap', to: allowlistTo, amountUsd: Math.min(0.01, capUsd), settled: false, rejectedReason: e instanceof Error ? e.message.slice(0, 160) : String(e) })
  }

  // 2) OUTSIDE bounds: a NON-allowlisted payee -> the on-chain call policy rejects the UserOp.
  const stranger = '0x000000000000000000000000000000000000dEaD' as const
  try {
    const callData = await transferCall(stranger, Math.min(0.01, capUsd))
    const uo = await kernelClient.sendUserOperation({ callData })
    await kernelClient.waitForUserOperationReceipt({ hash: uo })
    attempts.push({ label: 'out-of-bounds: NON-allowlisted payee', to: stranger, amountUsd: Math.min(0.01, capUsd), settled: true })
  } catch (e) {
    attempts.push({ label: 'out-of-bounds: NON-allowlisted payee', to: stranger, amountUsd: Math.min(0.01, capUsd), settled: false, rejectedReason: 'rejected by the session-key policy (payee not on the allowlist)' })
  }

  return {
    executed: true,
    sca,
    sessionKey: sessionKey.address,
    scopedTo: { capUsd, allowlist: allowlistTo, expiresAt: validUntil },
    gasSponsored: sponsored,
    funded,
    attempts,
  }
}
