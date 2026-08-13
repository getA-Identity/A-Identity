/**
 * Generic EVM chain adapter. `createEvmAdapter(descriptor)` returns the full set of
 * on-chain operations — identity register, ERC-8183 escrow, USDC settlement, the
 * AgentSpendPolicy vault, and ERC-8004 KYA attestation — parameterized entirely by the
 * chain descriptor. A new EVM chain gets ALL of this by adding one descriptor to the
 * registry; there is no per-chain logic to copy.
 *
 * This is the faithful, parameterized extraction of the original Arc integration:
 * reads run keyless; writes are gated behind the chain's signer env var and stay
 * human-on-the-loop (prepared-or-executed). Behavior for the Arc descriptor is
 * identical to the original arc-contracts.ts. See ../../../MULTICHAIN-STRATEGY.md.
 */
import type { ChainDescriptor } from '../types.js'
import type {
  Prepared,
  Executed,
  VaultDeployed,
  VaultNoKey,
  VaultResult,
  ValidationExecuted,
} from '../types.js'
import {
  evmPublicClient,
  evmWalletClient,
  evmWalletClientFromKey,
  revertReason,
  usdcUnits,
  fromUsdcUnits,
  txUrl,
  addressUrl,
} from './client.js'
import { IDENTITY_ABI, ERC20_ABI, COMMERCE_ABI, VALIDATION_ABI, REPUTATION_ABI, MEMO_ABI, MULTICALL3_FROM_ABI, JOB_STATUS, ZERO_ADDRESS, ZERO_HASH } from './abis.js'
import { encodeMemo, decodeMemo, type MemoInput } from './memo.js'
import { AgentSpendPolicyAbi, AgentSpendPolicyBytecode } from '../../contracts/AgentSpendPolicy.js'

type Hex = `0x${string}`

export function createEvmAdapter(chain: ChainDescriptor) {
  if (chain.ecosystem !== 'evm') {
    throw new Error(`createEvmAdapter: ${chain.id} is not an EVM chain (${chain.ecosystem})`)
  }

  const NO_KEY = `No ${chain.signerEnvVar ?? 'signer'} set. Fund a wallet and export the key to broadcast on-chain.`
  const tx = (h: string) => txUrl(chain, h)
  const c = chain.contracts
  // For the live app these are all defined; cast for viem's `0x${string}` address type.
  const identityRegistry = c.identityRegistry as Hex
  const validationRegistry = c.validationRegistry as Hex
  const reputationRegistry = c.reputationRegistry as Hex | undefined
  const agenticCommerce = c.agenticCommerce as Hex
  const usdc = c.usdc as Hex
  // Arc-only: the predeployed Memo precompile. Undefined on chains that don't ship it,
  // in which case memo-wrapped settlement cleanly degrades to a bare USDC transfer.
  const memoContract = c.memo as Hex | undefined
  // Arc-only: the predeployed Multicall3From precompile (batched transactions).
  const multicall3From = c.multicall3From as Hex | undefined

  const publicClient = (env: NodeJS.ProcessEnv) => evmPublicClient(chain, env)
  const walletClient = (env: NodeJS.ProcessEnv) => evmWalletClient(chain, env)

  // ── live reads (no key) ────────────────────────────────────────────────────────
  async function readContracts() {
    const out = {
      network: chain.testnet ? `${chain.id}-testnet` : chain.id,
      chainId: chain.evmChainId,
      contracts: chain.contracts,
      explorer: chain.explorer,
      identity: {} as Record<string, unknown>,
      usdc: {} as Record<string, unknown>,
      reachable: false,
      checkedAt: new Date().toISOString(),
    }
    try {
      const client = await publicClient(process.env)
      // This registry is not enumerable (totalSupply reverts) and token ids are
      // non-sequential, so we don't report a registered-agents count from the
      // contract — better to omit it than to surface a silently-null field.
      if (identityRegistry) {
        const [name, symbol] = await Promise.allSettled([
          client.readContract({ address: identityRegistry, abi: IDENTITY_ABI, functionName: 'name' }),
          client.readContract({ address: identityRegistry, abi: IDENTITY_ABI, functionName: 'symbol' }),
        ])
        out.identity = {
          address: identityRegistry,
          name: name.status === 'fulfilled' ? name.value : null,
          symbol: symbol.status === 'fulfilled' ? symbol.value : null,
        }
      }
      if (usdc) {
        const [usym, udec] = await Promise.allSettled([
          client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'symbol' }),
          client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'decimals' }),
        ])
        out.usdc = {
          address: usdc,
          symbol: usym.status === 'fulfilled' ? usym.value : 'USDC',
          decimals: udec.status === 'fulfilled' ? (udec.value as number) : null,
        }
      }
      out.reachable = true
      return out
    } catch (err) {
      return { ...out, note: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── writes (env-gated, human-on-the-loop) ──────────────────────────────────────
  async function registerAgent(metadataUri: string, env: NodeJS.ProcessEnv = process.env): Promise<Prepared | Executed> {
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: identityRegistry,
        function: 'register(string metadataURI)',
        args: [metadataUri],
        reason:
          `No ${chain.signerEnvVar ?? 'signer'} set. Fund a wallet at ${chain.faucet ?? 'the chain faucet'} and export ${chain.signerEnvVar ?? 'the key'} to broadcast this for real. This is the exact call that will be made.`,
      }
    }
    const { parseEventLogs } = await import('viem')
    const client = await publicClient(env)
    const hash = await signer.client.writeContract({
      address: identityRegistry,
      abi: IDENTITY_ABI,
      functionName: 'register',
      args: [metadataUri],
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    const logs = parseEventLogs({ abi: IDENTITY_ABI, eventName: 'Transfer', logs: receipt.logs })
    const agentId = logs[0] ? (logs[0].args as { tokenId: bigint }).tokenId.toString() : undefined
    return { executed: true, txHash: hash, explorerUrl: tx(hash), agentId }
  }

  async function createJob(
    input: { provider: string; evaluator: string; description: string; expiresInHours?: number },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Prepared | Executed> {
    const expiredAt = BigInt(Math.floor(Date.now() / 1000) + (input.expiresInHours ?? 24) * 3600)
    const args = [input.provider, input.evaluator, expiredAt, input.description, ZERO_ADDRESS]
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: agenticCommerce,
        function: 'createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook)',
        args: args.map((a) => (typeof a === 'bigint' ? a.toString() : a)),
        reason:
          `No ${chain.signerEnvVar ?? 'signer'} set. This is the exact ERC-8183 createJob call. Fund a wallet and export the key to broadcast.`,
      }
    }
    const client = await publicClient(env)
    const hash = await signer.client.writeContract({
      address: agenticCommerce,
      abi: COMMERCE_ABI,
      functionName: 'createJob',
      args: args as never,
    })
    await client.waitForTransactionReceipt({ hash })
    return { executed: true, txHash: hash, explorerUrl: tx(hash) }
  }

  async function runEscrowDemo(
    input: { budgetUsd?: number; description?: string; outcome?: 'complete' | 'refund' } = {},
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<
    | { executed: false; reason: string; contract: string; lifecycle: string[]; outcome: 'complete' | 'refund' }
    | {
        executed: true
        jobId: string
        budgetUsd: number
        outcome: 'complete' | 'refund'
        steps: { step: string; txHash: string; explorerUrl: string }[]
        status: string
        refundedUsd?: number
        failedAt?: string
        reason?: string
      }
  > {
    const budgetUsd = input.budgetUsd ?? 0.05
    const outcome = input.outcome ?? 'complete'
    const description =
      input.description ??
      (outcome === 'refund'
        ? 'A-Identity ERC-8183 refund demo: an agent hires an agent, the deliverable is disputed, and the escrowed USDC is refunded to the client.'
        : 'A-Identity ERC-8183 escrow demo: an agent hires an agent, USDC is held in escrow, released on delivery.')
    // Happy path ends in `complete` (provider paid); dispute path ends in `reject`
    // (client refunded in the same tx).
    const finalStep = outcome === 'refund' ? 'reject' : 'complete'
    const lifecycle = ['createJob', 'setBudget', 'approve(USDC)', 'fund', 'submit', finalStep]
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. With a funded key this broadcasts the full ERC-8183 ${outcome === 'refund' ? 'refund/dispute' : 'escrow'} lifecycle (6 real txs).`,
        contract: agenticCommerce,
        lifecycle,
        outcome,
      }
    }
    const { keccak256, toHex, parseEventLogs } = await import('viem')
    const client = await publicClient(env)
    const me = signer.account.address
    const budget = usdcUnits(chain, budgetUsd)
    const zero = ZERO_ADDRESS
    const empty = '0x' as const
    const steps: { step: string; txHash: string; explorerUrl: string }[] = []
    const record = async (step: string, hash: Hex) => {
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`${step} reverted on-chain`)
      steps.push({ step, txHash: hash, explorerUrl: tx(hash) })
    }

    try {
      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
      const createHash = await signer.client.writeContract({
        address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'createJob',
        args: [me, me, expiredAt, description, zero],
      })
      const receipt = await client.waitForTransactionReceipt({ hash: createHash })
      steps.push({ step: 'createJob', txHash: createHash, explorerUrl: tx(createHash) })
      const logs = parseEventLogs({ abi: COMMERCE_ABI, eventName: 'JobCreated', logs: receipt.logs })
      const jobId = (logs[0]?.args as { jobId?: bigint })?.jobId
      if (jobId === undefined)
        return { executed: true, jobId: '?', budgetUsd, outcome, steps, status: 'Unknown', failedAt: 'createJob', reason: 'could not parse jobId from JobCreated' }

      await record('setBudget', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'setBudget', args: [jobId, budget, empty] }))
      await record('approve(USDC)', await signer.client.writeContract({ address: usdc, abi: ERC20_ABI, functionName: 'approve', args: [agenticCommerce, budget] }))
      await record('fund', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'fund', args: [jobId, empty] }))
      await record('submit', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'submit', args: [jobId, keccak256(toHex(`a-identity:deliverable:${jobId}`)), empty] }))

      if (outcome === 'refund') {
        // Dispute path: the evaluator rejects the submitted deliverable; the escrowed
        // budget is refunded to the client in the SAME tx (buyer protection).
        const rejectHash = await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'reject', args: [jobId, keccak256(toHex(`a-identity:disputed:${jobId}`)), empty] })
        const rejectReceipt = await client.waitForTransactionReceipt({ hash: rejectHash })
        if (rejectReceipt.status !== 'success') throw new Error('reject reverted on-chain')
        steps.push({ step: 'reject', txHash: rejectHash, explorerUrl: tx(rejectHash) })
        const refundLogs = parseEventLogs({ abi: COMMERCE_ABI, eventName: 'Refunded', logs: rejectReceipt.logs })
        const refunded = (refundLogs[0]?.args as { amount?: bigint })?.amount
        const job = (await client.readContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'getJob', args: [jobId] })) as { status: number }
        return { executed: true, jobId: jobId.toString(), budgetUsd, outcome, steps, status: JOB_STATUS[Number(job.status)] ?? String(job.status), refundedUsd: refunded !== undefined ? fromUsdcUnits(chain, refunded) : undefined }
      }

      await record('complete', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'complete', args: [jobId, keccak256(toHex(`a-identity:approved:${jobId}`)), empty] }))
      const job = (await client.readContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'getJob', args: [jobId] })) as { status: number }
      return { executed: true, jobId: jobId.toString(), budgetUsd, outcome, steps, status: JOB_STATUS[Number(job.status)] ?? String(job.status) }
    } catch (err) {
      return { executed: true, jobId: steps.length ? '(partial)' : '?', budgetUsd, outcome, steps, status: 'Reverted', failedAt: lifecycle[steps.length] ?? '?', reason: await revertReason(err) }
    }
  }

  // ── ERC-8183 dispute / refund helpers (granular, per-job) ───────────────────────
  type RefundResult = Prepared | (Executed & { refundedUsd?: number }) | { executed: false; reverted: true; reason: string }

  /** Parse the Refunded amount (client-refund) from a receipt's logs, in USD. */
  async function refundedUsdFrom(logs: unknown[]): Promise<number | undefined> {
    const { parseEventLogs } = await import('viem')
    const parsed = parseEventLogs({ abi: COMMERCE_ABI, eventName: 'Refunded', logs: logs as never })
    const refunded = (parsed[0]?.args as { amount?: bigint })?.amount
    return refunded !== undefined ? fromUsdcUnits(chain, refunded) : undefined
  }

  /** Evaluator rejects a Funded/Submitted deliverable → the escrowed USDC is refunded to
   *  the client in the SAME tx (buyer protection). Prepared without a key. Simulates first
   *  (like the vault) so an unauthorized / wrong-status dispute reverts OFF-chain — a clean
   *  reason, no gas burned from the shared signer. */
  async function rejectJob(jobId: bigint, reason: string, env: NodeJS.ProcessEnv = process.env): Promise<RefundResult> {
    const { keccak256, toHex } = await import('viem')
    const reasonHash = keccak256(toHex(`a-identity:dispute:${jobId.toString()}:${reason}`))
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: agenticCommerce,
        function: 'reject(uint256 jobId, bytes32 reason, bytes optParams)',
        args: [jobId.toString(), reasonHash],
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. The evaluator rejects the deliverable; the escrowed USDC is refunded to the client in the same tx.`,
      }
    }
    const client = await publicClient(env)
    try {
      const { request } = await client.simulateContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'reject', args: [jobId, reasonHash, '0x'], account: signer.account })
      const hash = await signer.client.writeContract(request as never)
      const receipt = await client.waitForTransactionReceipt({ hash })
      return { executed: true, txHash: hash, explorerUrl: tx(hash), refundedUsd: await refundedUsdFrom(receipt.logs) }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err) }
    }
  }

  /** After the deadline, anyone reclaims the escrow for the client (Funded/Submitted →
   *  Expired). Prepared without a key. Simulates first so a not-yet-expired / wrong-status
   *  claim reverts OFF-chain (no gas burned). */
  async function claimJobRefund(jobId: bigint, env: NodeJS.ProcessEnv = process.env): Promise<RefundResult> {
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: agenticCommerce,
        function: 'claimRefund(uint256 jobId)',
        args: [jobId.toString()],
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. After the job's deadline, this returns the escrowed USDC to the client.`,
      }
    }
    const client = await publicClient(env)
    try {
      const { request } = await client.simulateContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'claimRefund', args: [jobId], account: signer.account })
      const hash = await signer.client.writeContract(request as never)
      const receipt = await client.waitForTransactionReceipt({ hash })
      return { executed: true, txHash: hash, explorerUrl: tx(hash), refundedUsd: await refundedUsdFrom(receipt.logs) }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err) }
    }
  }

  /** Read a job's live on-chain state (status, parties, budget). No key needed. */
  async function readJob(jobId: bigint, env: NodeJS.ProcessEnv = process.env) {
    const client = await publicClient(env)
    try {
      const job = (await client.readContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'getJob', args: [jobId] })) as {
        client: string; provider: string; evaluator: string; description: string; budget: bigint; expiredAt: bigint; status: number; hook: string
      }
      return {
        jobId: jobId.toString(),
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        description: job.description,
        budgetUsd: fromUsdcUnits(chain, job.budget),
        expiredAt: Number(job.expiredAt),
        status: JOB_STATUS[Number(job.status)] ?? String(job.status),
        explorer: addressUrl(chain, agenticCommerce),
      }
    } catch (e) {
      return { jobId: jobId.toString(), error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ── granular escrow: fund at hire, complete at release (real on-chain lock at hire) ──
  type EscStep = { step: string; txHash: string; explorerUrl: string }

  /**
   * Lock a task's escrow ON-CHAIN at hire: createJob -> setBudget -> approve -> fund. The USDC
   * is genuinely held in the ERC-8183 contract after this (verifiable on arcscan). The platform
   * signer is the client/provider/evaluator in this build (per-party wallet signing is roadmap).
   * Prepared without a key; a reverted step returns { reverted } without a false success.
   */
  async function fundEscrow(
    input: { budgetUsd?: number; description?: string },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<
    | { executed: false; reason: string }
    | { executed: false; reverted: true; reason: string; failedAt?: string }
    | { executed: true; jobId: string; budgetUsd: number; steps: EscStep[] }
  > {
    const budgetUsd = input.budgetUsd ?? 0.05
    const description = input.description ?? 'A-Identity marketplace escrow'
    const signer = await walletClient(env)
    if (!signer) return { executed: false, reason: NO_KEY }
    const { parseEventLogs } = await import('viem')
    const client = await publicClient(env)
    const me = signer.account.address
    const budget = usdcUnits(chain, budgetUsd)
    const empty = '0x' as const
    const steps: EscStep[] = []
    const record = async (step: string, hash: Hex) => {
      const r = await client.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`${step} reverted on-chain`)
      steps.push({ step, txHash: hash, explorerUrl: tx(hash) })
    }
    try {
      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600)
      const createHash = await signer.client.writeContract({
        address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'createJob', args: [me, me, expiredAt, description, ZERO_ADDRESS],
      })
      const receipt = await client.waitForTransactionReceipt({ hash: createHash })
      if (receipt.status !== 'success') throw new Error('createJob reverted on-chain')
      steps.push({ step: 'createJob', txHash: createHash, explorerUrl: tx(createHash) })
      const logs = parseEventLogs({ abi: COMMERCE_ABI, eventName: 'JobCreated', logs: receipt.logs })
      const jobId = (logs[0]?.args as { jobId?: bigint })?.jobId
      if (jobId === undefined) return { executed: false, reverted: true, reason: 'could not parse jobId from JobCreated', failedAt: 'createJob' }
      await record('setBudget', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'setBudget', args: [jobId, budget, empty] }))
      await record('approve(USDC)', await signer.client.writeContract({ address: usdc, abi: ERC20_ABI, functionName: 'approve', args: [agenticCommerce, budget] }))
      await record('fund', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'fund', args: [jobId, empty] }))
      return { executed: true, jobId: jobId.toString(), budgetUsd, steps }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err), failedAt: ['createJob', 'setBudget', 'approve(USDC)', 'fund'][steps.length] }
    }
  }

  /** Release a funded escrow: submit -> complete, paying the provider. The counterpart to
   *  fundEscrow. Prepared without a key; a reverted step returns { reverted }. */
  async function completeEscrow(
    jobId: bigint,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<
    | { executed: false; reason: string }
    | { executed: false; reverted: true; reason: string }
    | { executed: true; steps: EscStep[]; status: string }
  > {
    const signer = await walletClient(env)
    if (!signer) return { executed: false, reason: NO_KEY }
    const { keccak256, toHex } = await import('viem')
    const client = await publicClient(env)
    const empty = '0x' as const
    const steps: EscStep[] = []
    const record = async (step: string, hash: Hex) => {
      const r = await client.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`${step} reverted on-chain`)
      steps.push({ step, txHash: hash, explorerUrl: tx(hash) })
    }
    try {
      await record('submit', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'submit', args: [jobId, keccak256(toHex(`a-identity:deliverable:${jobId}`)), empty] }))
      await record('complete', await signer.client.writeContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'complete', args: [jobId, keccak256(toHex(`a-identity:approved:${jobId}`)), empty] }))
      const job = (await client.readContract({ address: agenticCommerce, abi: COMMERCE_ABI, functionName: 'getJob', args: [jobId] })) as { status: number }
      return { executed: true, steps, status: JOB_STATUS[Number(job.status)] ?? String(job.status) }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err) }
    }
  }

  async function payUsdc(to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env): Promise<Prepared | Executed> {
    const amount = usdcUnits(chain, amountUsd)
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: usdc,
        function: 'transfer(address to, uint256 amount)',
        args: [to, amount.toString()],
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. Fund a wallet and export the key to move real USDC.`,
      }
    }
    const client = await publicClient(env)
    const hash = await signer.client.writeContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to as Hex, amount],
    })
    await client.waitForTransactionReceipt({ hash })
    return { executed: true, txHash: hash, explorerUrl: tx(hash) }
  }

  // ── memo-wrapped settlement: Arc `Memo` precompile ──────────────────────────────
  /**
   * Settle USDC through the Memo precompile so the payment carries an on-chain,
   * indexable audit trail of WHY it happened (agent, instruction, service, decision).
   * `Memo.memo(usdc, transferCalldata, memoId, memoBytes)` routes the inner transfer via
   * `CallFrom`, preserving our EOA signer as `msg.sender` — the USDC still moves from the
   * signer exactly like `payUsdc`, plus a `Memo` event. Additive + credential-gated:
   *   - no `contracts.memo` on this chain → clean fallback to a bare `payUsdc`.
   *   - no signer → the exact prepared Memo call (same honesty contract as every write).
   * Result keeps the `{ executed, txHash, explorerUrl }` shape (+ memoId/memo) so
   * `executeInstruction` stays uniform.
   */
  async function payUsdcWithMemo(
    to: string,
    amountUsd: number,
    memoInput: MemoInput,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Prepared | Executed | { executed: false; reverted: true; reason: string }> {
    if (!memoContract) return payUsdc(to, amountUsd, env)
    const amount = usdcUnits(chain, amountUsd)
    const { memoId, memoBytes, reason } = encodeMemo(memoInput)
    const { encodeFunctionData } = await import('viem')
    const transferData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to as Hex, amount] })
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: memoContract,
        function: 'memo(address target, bytes data, bytes32 memoId, bytes memoData)',
        args: [usdc, transferData, memoId, memoBytes],
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. This is the exact Memo-wrapped USDC transfer (on-chain reason: ${reason}). Fund a wallet and export the key to broadcast.`,
      }
    }
    // NOTE: we deliberately do NOT simulateContract here. The Memo precompile rejects
    // STATICCALL (eth_call) — "static execution is rejected" — so a normal simulate would
    // falsely revert. writeContract's own gas estimation still catches an insufficient
    // balance / bad call BEFORE broadcast (caught below); we then verify receipt.status so a
    // mined-but-reverted tx is never reported as settled (honesty: no false executed_onchain).
    const client = await publicClient(env)
    try {
      const hash = await signer.client.writeContract({
        address: memoContract,
        abi: MEMO_ABI,
        functionName: 'memo',
        args: [usdc, transferData, memoId, memoBytes],
      })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        return { executed: false, reverted: true, reason: `Memo settlement reverted on-chain (tx ${hash})` }
      }
      return { executed: true, txHash: hash, explorerUrl: tx(hash), memoId, memo: reason }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err) }
    }
  }

  /**
   * Read the on-chain Memo audit trail, filtered by the indexed `memoId` and/or `sender`.
   * Bounded by a block window (DoS guard): defaults to the last `maxBlocks` blocks unless
   * an explicit `fromBlock` is given. Returns [] (supported:false) on a chain with no Memo
   * precompile. This is the "the reason is provably on-chain" verification read.
   */
  async function readMemos(
    filter: { sender?: string; memoId?: string; fromBlock?: bigint; maxBlocks?: number } = {},
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{
    supported: boolean
    contract?: string
    fromBlock?: string
    toBlock?: string
    memos: { txHash: string; blockNumber: string; sender: string; target: string; memoId: string; memo: string; explorerUrl: string }[]
  }> {
    if (!memoContract) return { supported: false, memos: [] }
    const { parseAbiItem } = await import('viem')
    const client = await publicClient(env)
    const latest = await client.getBlockNumber()
    // Cap the scan window so a caller can't ask for an unbounded getLogs. 5k default, 50k ceiling.
    const window = BigInt(Math.min(Math.max(filter.maxBlocks ?? 5000, 1), 50000))
    const fromBlock = filter.fromBlock ?? (latest > window ? latest - window : 0n)
    const event = parseAbiItem(
      'event Memo(address indexed sender,address indexed target,bytes32 callDataHash,bytes32 indexed memoId,bytes memo,uint256 memoIndex)',
    )
    const args: Record<string, unknown> = {}
    if (filter.sender) args.sender = filter.sender as Hex
    if (filter.memoId) args.memoId = filter.memoId as Hex
    const logs = await client.getLogs({
      address: memoContract,
      event,
      args: args as never,
      fromBlock,
      toBlock: latest,
    })
    const memos = logs.map((l) => {
      const a = l.args as { sender?: string; target?: string; memoId?: string; memo?: string }
      return {
        txHash: l.transactionHash ?? '',
        blockNumber: (l.blockNumber ?? 0n).toString(),
        sender: a.sender ?? '',
        target: a.target ?? '',
        memoId: a.memoId ?? '',
        memo: decodeMemo(a.memo ?? '0x'),
        explorerUrl: tx(l.transactionHash ?? ''),
      }
    })
    return { supported: true, contract: memoContract, fromBlock: fromBlock.toString(), toBlock: latest.toString(), memos }
  }

  // ── batched settlement: Arc `Multicall3From` precompile ─────────────────────────
  /**
   * Settle many USDC transfers ATOMICALLY in one Arc tx via `Multicall3From.aggregate3`,
   * each subcall routed through `CallFrom` so our EOA stays `msg.sender` (one USDC
   * `Transfer` per payment, `from` = the signer). `allowFailure=false`, so a batch is
   * all-or-nothing. Additive + credential-gated: no `contracts.multicall3From` on this
   * chain → falls back to a sequential loop of bare transfers; no signer → prepared. Hardened
   * like payUsdcWithMemo (try/catch + receipt.status, never a false "settled").
   */
  async function payUsdcBatch(
    payments: { to: string; amountUsd: number }[],
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Prepared | (Executed & { count: number; totalUsd: number }) | { executed: false; reverted: true; reason: string }> {
    const clean = payments.filter((p) => p && typeof p.to === 'string' && Number.isFinite(p.amountUsd) && p.amountUsd > 0)
    const totalUsd = clean.reduce((s, p) => s + p.amountUsd, 0)
    const { encodeFunctionData } = await import('viem')
    const calls = clean.map((p) => ({
      target: usdc,
      allowFailure: false,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [p.to as Hex, usdcUnits(chain, p.amountUsd)] }),
    }))
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: multicall3From ?? usdc,
        function: multicall3From ? 'aggregate3((address target, bool allowFailure, bytes callData)[])' : 'transfer(address to, uint256 amount) [x' + clean.length + ']',
        args: [calls],
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. This settles ${clean.length} USDC transfers ${multicall3From ? 'atomically in one Arc tx (Multicall3From)' : 'sequentially'}. Fund a wallet and export the key to broadcast.`,
      }
    }
    if (clean.length === 0) return { executed: false, reverted: true, reason: 'no valid payments in the batch' }
    const client = await publicClient(env)
    try {
      // No Multicall3From on this chain → fall back to a sequential loop of transfers.
      if (!multicall3From) {
        let last: Hex = '0x' as Hex
        for (const p of clean) {
          last = await signer.client.writeContract({ address: usdc, abi: ERC20_ABI, functionName: 'transfer', args: [p.to as Hex, usdcUnits(chain, p.amountUsd)] })
          const r = await client.waitForTransactionReceipt({ hash: last })
          if (r.status !== 'success') return { executed: false, reverted: true, reason: `a transfer reverted (tx ${last})` }
        }
        return { executed: true, txHash: last, explorerUrl: tx(last), count: clean.length, totalUsd }
      }
      const hash = await signer.client.writeContract({ address: multicall3From, abi: MULTICALL3_FROM_ABI, functionName: 'aggregate3', args: [calls] })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') return { executed: false, reverted: true, reason: `batch settlement reverted on-chain (tx ${hash})` }
      return { executed: true, txHash: hash, explorerUrl: tx(hash), count: clean.length, totalUsd }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err) }
    }
  }

  // ── on-chain spend policy vault (AgentSpendPolicy) ──────────────────────────────
  async function deployVault(
    input: { owner?: string; operator?: string; dailyCapUsd: number; autoApproveUsd: number },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<VaultDeployed | VaultNoKey> {
    const signer = await walletClient(env)
    if (!signer) return { executed: false, reverted: false, reason: NO_KEY }
    const owner = (input.owner ?? signer.account.address) as Hex
    const operator = (input.operator ?? signer.account.address) as Hex
    const client = await publicClient(env)
    const hash = await signer.client.deployContract({
      abi: AgentSpendPolicyAbi,
      bytecode: AgentSpendPolicyBytecode,
      args: [owner, operator, usdc, usdcUnits(chain, input.dailyCapUsd), usdcUnits(chain, input.autoApproveUsd)],
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    return { executed: true, vault: receipt.contractAddress as string, owner, operator, txHash: hash, explorerUrl: tx(hash) }
  }

  async function vaultWrite(vault: string, functionName: string, args: readonly unknown[], env: NodeJS.ProcessEnv): Promise<VaultResult> {
    const signer = await walletClient(env)
    if (!signer) return { executed: false, reverted: false, reason: NO_KEY }
    const client = await publicClient(env)
    try {
      const { request } = await client.simulateContract({
        address: vault as Hex,
        abi: AgentSpendPolicyAbi,
        functionName: functionName as never,
        args: args as never,
        account: signer.account,
      })
      const hash = await signer.client.writeContract(request as never)
      await client.waitForTransactionReceipt({ hash })
      return { executed: true, txHash: hash, explorerUrl: tx(hash) }
    } catch (err) {
      return { executed: false, reverted: true, reason: await revertReason(err) }
    }
  }

  const policyPay = (vault: string, to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
    vaultWrite(vault, 'pay', [to as Hex, usdcUnits(chain, amountUsd)], env)
  const policyOwnerPay = (vault: string, to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
    vaultWrite(vault, 'ownerPay', [to as Hex, usdcUnits(chain, amountUsd)], env)
  const policySetPolicy = (
    vault: string,
    input: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean },
    env: NodeJS.ProcessEnv = process.env,
  ) => vaultWrite(vault, 'setPolicy', [usdcUnits(chain, input.dailyCapUsd), usdcUnits(chain, input.autoApproveUsd), input.allowlistEnabled], env)
  const policySetFrozen = (vault: string, frozen: boolean, env: NodeJS.ProcessEnv = process.env) =>
    vaultWrite(vault, 'setFrozen', [frozen], env)
  /** Grant / extend / revoke the agent's session key by setting the UNIX expiry (seconds).
   *  A future time grants/extends; `now` (or a past time) revokes; 0 = no time bound. */
  const policySetSessionExpiry = (vault: string, expiryUnix: number, env: NodeJS.ProcessEnv = process.env) =>
    vaultWrite(vault, 'setSessionKeyExpiry', [BigInt(Math.max(0, Math.floor(expiryUnix)))], env)
  const policySetAllowed = (vault: string, payee: string, ok: boolean, env: NodeJS.ProcessEnv = process.env) =>
    vaultWrite(vault, 'setAllowed', [payee as Hex, ok], env)
  const policyWithdraw = (vault: string, to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
    vaultWrite(vault, 'withdraw', [to as Hex, usdcUnits(chain, amountUsd)], env)

  async function readVault(vault: string) {
    const client = await publicClient(process.env)
    const read = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: vault as Hex, abi: AgentSpendPolicyAbi, functionName: functionName as never, args: args as never })
    const [owner, operator, dailyCap, autoApproveMax, frozen, allowlistEnabled, spentToday, balance] = await Promise.all([
      read('owner'), read('operator'), read('dailyCap'), read('autoApproveMax'),
      read('frozen'), read('allowlistEnabled'), read('spentToday'), read('balance'),
    ])
    // sessionKeyExpiry is newer than the original vault; a vault deployed with the OLD
    // bytecode has no such getter, so read it tolerantly (defaults to 0 = no time bound)
    // instead of breaking the whole vault read for pre-existing agents.
    const sessionKeyExpiry = await read('sessionKeyExpiry').catch(() => 0n)
    const expiry = Number(sessionKeyExpiry as bigint)
    return {
      vault,
      owner: owner as string,
      operator: operator as string,
      dailyCapUsd: fromUsdcUnits(chain, dailyCap as bigint),
      autoApproveUsd: fromUsdcUnits(chain, autoApproveMax as bigint),
      frozen: frozen as boolean,
      allowlistEnabled: allowlistEnabled as boolean,
      spentTodayUsd: fromUsdcUnits(chain, spentToday as bigint),
      balanceUsd: fromUsdcUnits(chain, balance as bigint),
      // Session key: the UNIX expiry (0 = no time bound) + whether it's currently expired.
      sessionKeyExpiry: expiry,
      sessionKeyExpired: expiry !== 0 && Math.floor(Date.now() / 1000) > expiry,
      explorer: addressUrl(chain, vault),
    }
  }

  // ── KYA attestation: ERC-8004 ValidationRegistry ────────────────────────────────
  async function recordValidation(agentId: bigint, requestUri: string, env: NodeJS.ProcessEnv = process.env, opts?: { response?: number; tag?: string }): Promise<Prepared | ValidationExecuted | { executed: false; reverted: true; reason: string }> {
    // Most chains in this registry carry no ValidationRegistry, so the address above is
    // `undefined` cast to an address. Without this guard viem is handed undefined and the
    // caller gets a generic read error, which is a THIRD state on top of the two that
    // matter: "cannot be anchored here" and "anchored zero times". Refuse first and say
    // which one it is. recordReputation already does this for its own registry.
    if (!validationRegistry) {
      return {
        executed: false,
        reverted: true,
        reason: `Chain ${chain.id} has no ValidationRegistry in its descriptor, so a KYA result cannot be anchored on-chain here.`,
      }
    }
    const response = opts?.response ?? 100
    const tag = opts?.tag ?? 'kya'
    const { keccak256, toHex } = await import('viem')
    const requestHash = keccak256(toHex(`${tag}:${agentId.toString()}:${requestUri}:${Date.now()}`))
    const signer = await walletClient(env)
    if (!signer) {
      return {
        executed: false,
        contract: validationRegistry,
        function: 'validationRequest(address,uint256,string,bytes32) + validationResponse(bytes32,uint8,string,bytes32,string)',
        args: [agentId.toString(), requestUri, requestHash],
        reason: `No ${chain.signerEnvVar ?? 'signer'} set. This opens + answers an ERC-8004 validation (response=${response}, tag "${tag}") for the agent.`,
      }
    }
    const client = await publicClient(env)
    const validator = signer.account.address
    const reqTx = await signer.client.writeContract({
      address: validationRegistry, abi: VALIDATION_ABI, functionName: 'validationRequest',
      args: [validator, agentId, requestUri, requestHash],
    })
    await client.waitForTransactionReceipt({ hash: reqTx })
    const respTx = await signer.client.writeContract({
      address: validationRegistry, abi: VALIDATION_ABI, functionName: 'validationResponse',
      args: [requestHash, response, requestUri, ZERO_HASH, tag],
    })
    await client.waitForTransactionReceipt({ hash: respTx })
    return { executed: true, txHash: respTx, explorerUrl: tx(respTx), requestHash }
  }

  // ── reputation attestation: ERC-8004 ReputationRegistry ─────────────────────────
  type ReputationExecuted = {
    executed: true; txHash: Hex; explorerUrl: string; validator: string
    agentId: string; score: number; score100: number; tag: string; feedbackHash: Hex
  }
  type ReputationBlocked = { executed: false; reverted: true; reason: string }
  /**
   * Anchor an agent's deterministic 0-1000 reputation on-chain as an ERC-8004 feedback
   * attestation, so the score is independently verifiable, not just DB-asserted. The score
   * is normalized to the standard's 0-100 convention; the raw 0-1000 value + the tag are
   * committed in `feedbackHash`. Per ERC-8004 the caller (validator) must NOT own the agent,
   * so this uses a distinct validator key (`opts.validatorEnvVar`, default `ARC_VALIDATOR_KEY`,
   * falling back to the chain signer) and fails fast with a clear reason on self-attestation.
   * Prepared (not broadcast) when no validator key is set.
   */
  async function recordReputation(
    agentId: bigint,
    score: number,
    env: NodeJS.ProcessEnv = process.env,
    opts?: { validatorEnvVar?: string; tag?: string; evidenceUri?: string },
  ): Promise<Prepared | ReputationExecuted | ReputationBlocked> {
    if (!reputationRegistry) {
      return { executed: false, reverted: true, reason: `Chain ${chain.id} has no ReputationRegistry in its descriptor.` }
    }
    const tag = opts?.tag ?? 'a-identity:reputation:v1'
    const score100 = Math.max(0, Math.min(100, Math.round(score / 10)))
    const evidenceUri = opts?.evidenceUri ?? 'https://a-identity-asp.onrender.com/methodology'
    const { keccak256, toHex } = await import('viem')
    const feedbackHash = keccak256(toHex(`a-identity:rep:${agentId.toString()}:${score}:${tag}`))
    const args = [agentId, BigInt(score100), 0, tag, evidenceUri, '', '', feedbackHash] as const

    const validatorKey = (opts?.validatorEnvVar && env[opts.validatorEnvVar]) || env.ARC_VALIDATOR_KEY || (chain.signerEnvVar ? env[chain.signerEnvVar] : undefined)
    const signer = await evmWalletClientFromKey(chain, validatorKey, env)
    if (!signer) {
      return {
        executed: false,
        contract: reputationRegistry,
        function: 'giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)',
        args: [agentId.toString(), score100, 0, tag, evidenceUri, '', '', feedbackHash],
        reason: `No validator key set (ARC_VALIDATOR_KEY or ${chain.signerEnvVar ?? 'signer'}). This records agent ${agentId}'s reputation ${score}/1000 (= ${score100}/100) on the ERC-8004 ReputationRegistry as a signed observer attestation.`,
      }
    }
    const client = await publicClient(env)
    // ERC-8004 forbids an agent owner scoring its own agent; fail fast with a clear reason
    // instead of paying gas for a guaranteed revert.
    try {
      const owner = (await client.readContract({ address: identityRegistry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [agentId] })) as Hex
      if (owner.toLowerCase() === signer.account.address.toLowerCase()) {
        return { executed: false, reverted: true, reason: `Validator ${signer.account.address} owns agent ${agentId}; ERC-8004 forbids self-attestation. Set a distinct ARC_VALIDATOR_KEY.` }
      }
    } catch {
      // ownerOf may revert for an unknown id; let the write itself surface any real error.
    }
    const hash = await signer.client.writeContract({ address: reputationRegistry, abi: REPUTATION_ABI, functionName: 'giveFeedback', args })
    await client.waitForTransactionReceipt({ hash })
    return { executed: true, txHash: hash, explorerUrl: tx(hash), validator: signer.account.address, agentId: agentId.toString(), score, score100, tag, feedbackHash }
  }

  async function readValidation(agentId: bigint, env: NodeJS.ProcessEnv = process.env) {
    if (!validationRegistry) {
      // Same distinction as recordValidation: not anchorable is not the same fact as
      // anchored zero times, and a count of 0 would read like the second.
      return {
        agentId: agentId.toString(),
        supported: false as const,
        reason: `Chain ${chain.id} has no ValidationRegistry in its descriptor, so KYA cannot be anchored on-chain here.`,
      }
    }
    const client = await publicClient(env)
    try {
      const validator = (await walletClient(env))?.account.address
      const hashes = (await client.readContract({
        address: validationRegistry, abi: VALIDATION_ABI, functionName: 'getAgentValidations', args: [agentId],
      })) as readonly string[]
      let kyaCount = 0
      let kyaAverage = 0
      if (validator) {
        const summary = (await client.readContract({
          address: validationRegistry, abi: VALIDATION_ABI, functionName: 'getSummary',
          args: [agentId, [validator as Hex], 'kya'],
        })) as readonly [bigint, number]
        kyaCount = Number(summary[0])
        kyaAverage = Number(summary[1])
      }
      return {
        agentId: agentId.toString(),
        validations: hashes.length,
        kyaCount,
        kyaAverage,
        registry: validationRegistry,
        explorer: addressUrl(chain, validationRegistry),
      }
    } catch (e) {
      return { agentId: agentId.toString(), error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    chain,
    readContracts,
    registerAgent,
    createJob,
    runEscrowDemo,
    rejectJob,
    claimJobRefund,
    readJob,
    fundEscrow,
    completeEscrow,
    payUsdc,
    payUsdcWithMemo,
    payUsdcBatch,
    readMemos,
    deployVault,
    policyPay,
    policyOwnerPay,
    policySetPolicy,
    policySetFrozen,
    policySetAllowed,
    policySetSessionExpiry,
    policyWithdraw,
    readVault,
    recordValidation,
    readValidation,
    recordReputation,
  }
}

export type EvmAdapter = ReturnType<typeof createEvmAdapter>
