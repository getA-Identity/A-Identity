import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPlatformStateForTests,
  __setSettlementForTests,
  appLayerAudit,
  batchPaymentPlan,
  countRecentActions,
  createAgent,
  approveInstruction,
  createInstruction,
  executeInstruction,
  rejectInstruction,
  type Instruction,
  type Permissions,
  type PlatformAgent,
} from './platform.js'
import { encodeMemo, memoIdFor } from './chains/evm/memo.js'

/**
 * Settlement-path tests: what the audit trail says, and how a batch actually settles.
 *
 * Two invariants are load-bearing here and both are project law rather than taste:
 *
 *  1. An on-chain Memo and an app-layer audit record are NOT the same claim. Only the
 *     direct-EOA path can emit a real Memo; the vault (a contract), Circle (its own hosted
 *     wallet) and a batched Multicall3From call cannot. Those paths still record the "why",
 *     but on their own fields, so nothing implies an on-chain memo that does not exist.
 *  2. Nothing is marked settled without a receipt. A reverted batch is all-or-nothing and
 *     goes back to a human; it is never retried as a different settlement behind their back.
 *
 * The settlement calls only run with a funded signer against a live RPC, so they are driven
 * here through the __setSettlementForTests seam. Everything else is the real code path.
 */

// Persistence is OFF for this whole process from the first line.
__resetPlatformStateForTests()

const OWNER = 'owner@test'
const PAYEE = '0x000000000000000000000000000000000000dEaD'
const VAULT = '0x00000000000000000000000000000000000ADD11'

/** Wide-open policy, so the ladder auto-approves and the test is about SETTLEMENT. */
function seedAgent(over: Partial<Permissions> = {}): PlatformAgent {
  return createAgent({
    name: 'Settlement Test Agent',
    description: 'Seeded for settlement path tests.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 100, agentToHuman: true, ...over },
    owner: OWNER,
  })
}

function seedInstruction(
  agent: PlatformAgent,
  over: { type?: Instruction['type']; amountUsd?: number; count?: number } = {},
): Instruction {
  const ix = createInstruction({
    agentId: agent.id,
    type: over.type ?? 'payment',
    amountUsd: over.amountUsd ?? 0.5,
    count: over.count,
    payee: PAYEE,
    caller: OWNER,
  })
  assert.ok(!('error' in ix), `seed failed: ${JSON.stringify(ix)}`)
  return ix
}

/** Run body with fake settlement calls installed, always restoring afterwards. */
async function withSettlement(
  over: Parameters<typeof __setSettlementForTests>[0],
  body: () => Promise<void>,
): Promise<void> {
  const restore = __setSettlementForTests(over)
  try {
    await body()
  } finally {
    restore()
  }
}

/** A settlement call that must never be reached in a given test. */
const neverCalled = (what: string) => () => {
  throw new Error(`${what} should not have been called`)
}

// ── the app-layer audit record ───────────────────────────────────────────────────

test('the app-layer audit record carries exactly the payload the on-chain Memo commits', () => {
  const input = { agentId: 'agent_1', instructionId: 'ix_1', service: 'batch', policyDecision: 'auto_approved' }
  // Same encoder, so the on-chain trail and the app-layer trail can never drift in shape.
  assert.equal(appLayerAudit(input).offchainAuditReason, encodeMemo(input).reason)
  assert.deepEqual(JSON.parse(appLayerAudit(input).offchainAuditReason), {
    a: 'agent_1',
    i: 'ix_1',
    s: 'batch',
    d: 'auto_approved',
  })
})

test('the app-layer audit id cannot be mistaken for an on-chain memoId', () => {
  const { offchainAuditId } = appLayerAudit({
    agentId: 'agent_1',
    instructionId: 'ix_1',
    service: 'payment',
    policyDecision: 'approved',
  })
  // Not a bytes32: nobody can take this to arcscan and be told a memo is missing.
  assert.equal(/^0x[0-9a-fA-F]{64}$/.test(offchainAuditId), false)
  assert.notEqual(offchainAuditId, memoIdFor('ix_1'))
  assert.ok(offchainAuditId.includes('audit'))
  assert.ok(offchainAuditId.endsWith('ix_1'))
})

test('a vault settlement records the app-layer audit and claims no on-chain memo', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  agent.vaultAddress = VAULT
  const ix = seedInstruction(agent)

  await withSettlement(
    {
      policyPay: async () => ({ executed: true, txHash: '0xvault', explorerUrl: 'https://example/tx/0xvault' }),
      payUsdcWithMemo: neverCalled('payUsdcWithMemo'),
      payUsdcBatch: neverCalled('payUsdcBatch'),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.enforcedBy, 'onchain-vault')
      // The distinction that is project law: no memo was emitted, so no memo is claimed.
      assert.equal(done.memoId, undefined)
      assert.equal(done.memoReason, undefined)
      assert.deepEqual(JSON.parse(done.offchainAuditReason as string), {
        a: agent.id,
        i: ix.id,
        s: 'payment',
        d: 'auto_approved',
      })
      assert.match(done.policyNote, /app-layer audit record/)
    },
  )
})

test('a Circle Agent Wallet settlement records the app-layer audit too', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  agent.circleWalletId = 'wallet_circle_1'
  const ix = seedInstruction(agent)

  await withSettlement(
    {
      circlePay: async () => ({ executed: true, txHash: '0xcircle', explorerUrl: 'https://example/tx/0xcircle' }),
      payUsdcWithMemo: neverCalled('payUsdcWithMemo'),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.enforcedBy, 'circle-agent-stack')
      assert.equal(done.memoId, undefined)
      assert.equal(JSON.parse(done.offchainAuditReason as string).i, ix.id)
    },
  )
})

test('a human-approved vault settlement records the decision that authorized it', async () => {
  __resetPlatformStateForTests()
  // Above the auto-approve line, so the ladder pauses it and a human has to approve.
  const agent = seedAgent({ autoApproveUnderUsd: 0.1 })
  agent.vaultAddress = VAULT
  const ix = seedInstruction(agent)
  assert.equal(ix.status, 'pending_approval')
  const { approveInstruction } = await import('./platform.js')
  approveInstruction(ix.id, OWNER)

  await withSettlement(
    {
      policyOwnerPay: async () => ({ executed: true, txHash: '0xowner', explorerUrl: 'https://example/tx/0xowner' }),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      // 'approved', not 'executed_onchain': the payload says why the money was allowed to
      // move, exactly like the Memo path records it.
      assert.equal(JSON.parse(done.offchainAuditReason as string).d, 'approved')
    },
  )
})

test('a real on-chain Memo keeps memoId and adds no app-layer record', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent)
  const realMemoId = memoIdFor(ix.id)

  await withSettlement(
    {
      payUsdcWithMemo: async (_to, _amount, memo) => ({
        executed: true,
        txHash: '0xmemo',
        explorerUrl: 'https://example/tx/0xmemo',
        memoId: realMemoId,
        memo: JSON.stringify(memo),
      }),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.memoId, realMemoId)
      // The on-chain trail exists, so there is nothing to substitute for it.
      assert.equal(done.offchainAuditId, undefined)
      assert.equal(done.offchainAuditReason, undefined)
    },
  )
})

test('a vault policy revert settles nothing and records no audit trail', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  agent.vaultAddress = VAULT
  const ix = seedInstruction(agent)

  await withSettlement(
    {
      policyPay: async () => ({ executed: false, reverted: true, reason: 'DailyCapExceeded' }),
      payUsdcWithMemo: neverCalled('payUsdcWithMemo'),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(done.txHash, undefined)
      assert.equal(done.offchainAuditId, undefined)
    },
  )
})

// ── batch settlement ─────────────────────────────────────────────────────────────

test('batchPaymentPlan expands a batch into count payments and refuses everything else', () => {
  const base: Instruction = {
    id: 'ix_plan',
    agentId: 'agent_1',
    type: 'batch',
    amountUsd: 0.25,
    count: 4,
    payee: PAYEE,
    memo: '',
    status: 'auto_approved',
    policyNote: '',
    createdAt: new Date().toISOString(),
  }
  const plan = batchPaymentPlan(base, PAYEE)
  assert.equal(plan?.length, 4)
  assert.deepEqual(plan?.[0], { to: PAYEE, amountUsd: 0.25 })
  assert.equal(
    plan?.reduce((s, p) => s + p.amountUsd, 0),
    base.amountUsd * base.count,
  )
  // Anything that is not an executable multi-payment batch keeps the single transfer.
  assert.equal(batchPaymentPlan({ ...base, type: 'payment' }, PAYEE), null)
  assert.equal(batchPaymentPlan({ ...base, count: 1 }, PAYEE), null)
  assert.equal(batchPaymentPlan({ ...base, count: Number.NaN }, PAYEE), null)
  assert.equal(batchPaymentPlan({ ...base, amountUsd: 0 }, PAYEE), null)
})

test('a batch instruction settles as count payments in one atomic tx', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })
  let seen: { to: string; amountUsd: number }[] = []

  await withSettlement(
    {
      payUsdcBatch: async (payments) => {
        seen = payments
        return {
          executed: true,
          txHash: '0xbatch',
          explorerUrl: 'https://example/tx/0xbatch',
          count: payments.length,
          totalUsd: payments.reduce((s, p) => s + p.amountUsd, 0),
        }
      },
      // The whole point: it is no longer one transfer of the total.
      payUsdcWithMemo: neverCalled('payUsdcWithMemo'),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.txHash, '0xbatch')
      assert.equal(done.enforcedBy, 'server')
      assert.deepEqual(seen, [
        { to: PAYEE, amountUsd: 0.5 },
        { to: PAYEE, amountUsd: 0.5 },
        { to: PAYEE, amountUsd: 0.5 },
      ])
      // A contract call cannot emit a Memo, so the reason is app-layer and labeled.
      assert.equal(done.memoId, undefined)
      assert.equal(JSON.parse(done.offchainAuditReason as string).s, 'batch')
      assert.match(done.policyNote, /3 USDC payments/)
    },
  )
})

test('a reverted batch is never reported as executed and is not retried as one transfer', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })

  await withSettlement(
    {
      payUsdcBatch: async () => ({ executed: false, reverted: true, reason: 'transfer amount exceeds balance' }),
      // A revert must go back to the human, not silently become a different settlement.
      payUsdcWithMemo: neverCalled('payUsdcWithMemo'),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(done.txHash, undefined)
      assert.equal(done.offchainAuditId, undefined)
      assert.match(done.policyNote, /reverted on-chain/)
    },
  )
})

// -- the daily cap after a settlement that moved nothing --------------------------

/**
 * The cap bounds AUTHORIZED spending, so an instruction commits against it when it is
 * auto-approved. That is correct. What was not correct is what happened next when the
 * settlement broadcast and FAILED: four paths pushed the instruction back to
 * `pending_approval` and none of them gave the cap back.
 *
 * Two consequences, both visible to an owner. A day's budget was consumed by payments that
 * moved nothing. And `approveInstruction` calls addSpend unconditionally, so re-approving
 * the returned instruction charged the same payment twice.
 */
test('a settlement that reverts gives the daily cap back', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })
  // Auto-approved on creation, so the cap is already committed before we settle.
  assert.equal(agent.spentTodayUsd, 1.5)

  await withSettlement(
    { payUsdcBatch: async () => ({ executed: false, reverted: true, reason: 'transfer amount exceeds balance' }),
      payUsdcWithMemo: neverCalled('payUsdcWithMemo') },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(agent.spentTodayUsd, 0, 'nothing moved on-chain, so nothing should be charged to the day')
    },
  )
})

test('re-approving a reverted settlement charges it once, not twice', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })

  await withSettlement(
    { payUsdcBatch: async () => ({ executed: false, reverted: true, reason: 'insufficient balance' }),
      payUsdcWithMemo: neverCalled('payUsdcWithMemo') },
    async () => { await executeInstruction(ix.id, OWNER) },
  )
  // The human looks at it and approves it again. Before the fix this reached 3.0: the same
  // 1.5 charged on creation and never returned, plus 1.5 charged again here.
  const again = approveInstruction(ix.id, OWNER)
  assert.ok(!('error' in again), JSON.stringify(again))
  assert.equal(agent.spentTodayUsd, 1.5)
})

test('rejecting a reverted settlement leaves no claim on the cap', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  // count must be >= 2 or executeInstruction takes the single-transfer path, not the batch.
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 1, count: 2 })

  await withSettlement(
    { payUsdcBatch: async () => ({ executed: false, reverted: true, reason: 'reverted' }),
      payUsdcWithMemo: neverCalled('payUsdcWithMemo') },
    async () => { await executeInstruction(ix.id, OWNER) },
  )
  // rejectInstruction unwinds nothing, on the stated premise that a pending instruction
  // holds no claim on the cap. That premise is only true because the revert path gave it
  // back; without that this agent would carry 2 USD it never spent until UTC midnight.
  const rejected = rejectInstruction(ix.id, OWNER, 'not paying this')
  assert.ok(!('error' in rejected))
  assert.equal(rejected.status, 'rejected')
  assert.equal(agent.spentTodayUsd, 0)
})

test('without a signer a batch degrades to the labeled simulation, as before', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })
  let fellBack = false

  await withSettlement(
    {
      // What the adapter returns with no signer key: the prepared call, nothing broadcast.
      payUsdcBatch: async (payments) => ({
        executed: false,
        contract: '0x0000000000000000000000000000000000000001',
        function: 'aggregate3(...)',
        args: [payments],
        reason: 'No signer set.',
      }),
      payUsdcWithMemo: async () => {
        fellBack = true
        return {
          executed: false,
          contract: '0x0000000000000000000000000000000000000002',
          function: 'transfer(address to, uint256 amount)',
          args: [],
          reason: 'No signer set.',
        }
      },
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_simulated')
      assert.equal(fellBack, true)
      assert.match(done.policyNote, /simulated/)
    },
  )
})

test('an adapter that throws degrades to the single transfer instead of crashing', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 2 })

  await withSettlement(
    {
      payUsdcBatch: async () => {
        throw new Error('multicall transport exploded')
      },
      payUsdcWithMemo: async () => ({
        executed: true,
        txHash: '0xfallback',
        explorerUrl: 'https://example/tx/0xfallback',
      }),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.txHash, '0xfallback')
    },
  )
})

test('a single payment still settles as one Memo-wrapped transfer', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'payment', amountUsd: 0.5 })

  await withSettlement(
    {
      payUsdcBatch: neverCalled('payUsdcBatch'),
      payUsdcWithMemo: async () => ({ executed: true, txHash: '0xsingle', explorerUrl: 'https://example/tx/0xsingle' }),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.txHash, '0xsingle')
    },
  )
})

test('a batch on an agent with a vault still settles through the vault', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  agent.vaultAddress = VAULT
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })
  let vaultAmount = 0

  await withSettlement(
    {
      policyPay: async (_vault, _to, amountUsd) => {
        vaultAmount = amountUsd
        return { executed: true, txHash: '0xvault', explorerUrl: 'https://example/tx/0xvault' }
      },
      // Vault-first is unchanged: the chain-enforced path still wins.
      payUsdcBatch: neverCalled('payUsdcBatch'),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.enforcedBy, 'onchain-vault')
      assert.equal(vaultAmount, 1.5)
    },
  )
})

test('the policy ladder still denies a batch before any settlement runs', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent({ velocity: { maxActions: 2, windowMinutes: 10 } })
  // A batch of 3 is 3 actions: the velocity breaker hard-denies it at creation.
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })
  assert.equal(ix.status, 'rejected')
  assert.equal(ix.denyCode, 'velocity_exceeded')

  await withSettlement(
    { payUsdcBatch: neverCalled('payUsdcBatch'), payUsdcWithMemo: neverCalled('payUsdcWithMemo') },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.deepEqual(done, { error: 'Cannot execute from status rejected' })
    },
  )
})

test('a settled batch still counts as its full count in the velocity window', async () => {
  const state = __resetPlatformStateForTests()
  const agent = seedAgent()
  const ix = seedInstruction(agent, { type: 'batch', amountUsd: 0.5, count: 3 })

  await withSettlement(
    {
      payUsdcBatch: async (payments) => ({
        executed: true,
        txHash: '0xbatch',
        explorerUrl: 'https://example/tx/0xbatch',
        count: payments.length,
        totalUsd: payments.reduce((s, p) => s + p.amountUsd, 0),
      }),
    },
    async () => {
      await executeInstruction(ix.id, OWNER)
      // Atomic settlement did not turn 3 payments into 1 action.
      assert.equal(countRecentActions(state.instructions, agent.id, 10), 3)
    },
  )
})
