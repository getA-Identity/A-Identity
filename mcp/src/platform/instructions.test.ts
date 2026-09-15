import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { __resetPlatformStateForTests, dailySpent, type PlatformAgent } from './core.js'
import { createAgent } from './agents.js'
import { vaultChainFor } from './vault-adapter.js'
import {
  __setSettlementForTests, approveInstruction, createInstruction, executeInstruction, sessionKeyBound,
} from './instructions.js'

/**
 * Session-key settlement labeling.
 *
 * `enforcedBy: 'session-key'` is a claim about WHO authorised money moving, so it is only
 * ever made when the chain said so: the vault carried a live session-key expiry, the
 * settlement went through `pay` (not the owner override the contract exempts from that
 * gate), and there is a receipt. Every other case stays the broader `onchain-vault`.
 *
 * Most of the tests below are negative controls, and that is the point. A label that is
 * cheap to hand out is worth nothing, so the ones that matter are the ones proving it is
 * NOT handed out: no bound on the vault, a bound that lapsed, an RPC that would not
 * answer, and a human override. Delete the guard in executeInstruction and each of those
 * goes red, which is the only reason to trust the positive case.
 *
 * The chain calls run through the `__setSettlementForTests` seam; everything else is the
 * real code path.
 */

// Persistence is OFF for this whole process from the first line.
__resetPlatformStateForTests()

const OWNER = 'owner@test'
const PAYEE = '0x000000000000000000000000000000000000dEaD'
const VAULT = '0x00000000000000000000000000000000000ADD11'
const HUMAN_OWNER = '0x0000000000000000000000000000000000000010'
const OPERATOR = '0x0000000000000000000000000000000000000011'
const HOUR = 3600

/**
 * The vault read is gated on the vault chain's signer key being configured, because
 * without it `policyPay` returns prepared and nothing settles for real. Ask the registry
 * which env var that is rather than naming one, so this test does not pin a chain.
 */
async function withSignerConfigured(agent: PlatformAgent, body: () => Promise<void>): Promise<void> {
  const envVar = vaultChainFor(agent)?.signerEnvVar
  assert.ok(envVar, 'the vault chain declares no signer env var; the gate below is untestable')
  const had = process.env[envVar]
  process.env[envVar] = `0x${'1'.repeat(64)}`
  try {
    await body()
  } finally {
    if (had === undefined) delete process.env[envVar]
    else process.env[envVar] = had
  }
}

/** An agent whose payments auto-approve, with a vault the server can operate. */
function seedVaultAgent(): PlatformAgent {
  const agent = createAgent({
    name: 'Session Key Agent',
    description: 'Seeded for session-key settlement tests.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 100, agentToHuman: true },
    owner: OWNER,
  })
  agent.vaultAddress = VAULT
  // owner == operator, so the server may sign both pay() and ownerPay() in this fixture.
  agent.vaultOwner = OPERATOR
  agent.vaultOperator = OPERATOR
  return agent
}

function seedInstruction(agent: PlatformAgent, amountUsd = 0.5) {
  const ix = createInstruction({ agentId: agent.id, type: 'payment', amountUsd, payee: PAYEE, caller: OWNER })
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

const settledPay = async () => ({ executed: true as const, txHash: '0xvault', explorerUrl: 'https://example.test/tx/0xvault' })
const vaultView = (over: Record<string, unknown>) =>
  ({ vault: VAULT, sessionKeyExpiry: 0, sessionKeyExpired: false, ...over }) as never

// ── the pure reduction: what a vault read is allowed to mean ─────────────────────

test('an expiry of zero is NO time bound, which is the opposite of a session key', () => {
  // The contract only reverts when `sessionKeyExpiry != 0 && block.timestamp > expiry`, so
  // zero is an operator whose authority never lapses. Reading that as a session key would
  // label every ordinary vault settlement as bounded when nothing bounds it.
  const b = sessionKeyBound({ sessionKeyExpiry: 0 }, 1_000)
  assert.equal(b.live, false)
  assert.equal(b.live === false && b.why, 'no-bound')
})

test('a future expiry is a live session key, and the expiry second is still inside it', () => {
  assert.deepEqual(sessionKeyBound({ sessionKeyExpiry: 2_000 }, 1_000), { live: true, expiry: 2_000 })
  // `pay` reverts on `block.timestamp > expiry`, so the boundary second still settles.
  assert.deepEqual(sessionKeyBound({ sessionKeyExpiry: 1_000 }, 1_000), { live: true, expiry: 1_000 })
})

test('a lapsed expiry is expired, from either clock', () => {
  const late = sessionKeyBound({ sessionKeyExpiry: 999 }, 1_000)
  assert.equal(late.live === false && late.why, 'expired')
  // The adapter computes `sessionKeyExpired` against its own clock. If it says closed, it
  // is closed, even where our clock would still call the window open.
  const flagged = sessionKeyBound({ sessionKeyExpiry: 5_000, sessionKeyExpired: true }, 1_000)
  assert.equal(flagged.live === false && flagged.why, 'expired')
})

test('an unreadable or malformed expiry is never treated as a bound', () => {
  for (const view of [null, undefined, {}, { sessionKeyExpiry: 'soon' }, { sessionKeyExpiry: Number.NaN }, { sessionKeyExpiry: -1 }]) {
    const b = sessionKeyBound(view as never, 1_000)
    assert.equal(b.live, false, `${JSON.stringify(view)} must not read as a live session key`)
    assert.equal(b.live === false && b.why, 'no-read')
  }
})

// ── the settlement label ─────────────────────────────────────────────────────────

test('a vault settlement under a live session key is enforced by the session key', async () => {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)
  const expiry = Math.floor(Date.now() / 1000) + HOUR

  await withSettlement(
    { policyPay: settledPay, readVault: async () => vaultView({ sessionKeyExpiry: expiry }) },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.enforcedBy, 'session-key')
        assert.equal(done.txHash, '0xvault')
        // The note names the bound the chain actually reported, not a configured intent.
        assert.ok(done.policyNote.includes(new Date(expiry * 1000).toISOString()))
        assert.ok(done.policyNote.includes('SessionKeyExpired'))
      })
    },
  )
})

test('NEGATIVE CONTROL: a vault with no session-key bound is not a session-key settlement', async () => {
  // The guard that earns the label is `bound.live`. Remove it and this vault, whose
  // operator has unbounded authority in time, gets credited with a session key it never
  // had. That is the whole failure mode this file exists to catch.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)

  await withSettlement(
    { policyPay: settledPay, readVault: async () => vaultView({ sessionKeyExpiry: 0 }) },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.equal(done.policyNote.includes('session key'), false)
      })
    },
  )
})

test('NEGATIVE CONTROL: an expiry that already lapsed is not claimed as a live session key', async () => {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)

  await withSettlement(
    {
      policyPay: settledPay,
      readVault: async () => vaultView({ sessionKeyExpiry: Math.floor(Date.now() / 1000) - HOUR, sessionKeyExpired: true }),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.enforcedBy, 'onchain-vault')
      })
    },
  )
})

test('NEGATIVE CONTROL: an RPC that will not answer settles the payment and claims nothing', async () => {
  // An infrastructure hiccup must do exactly two things here: not invent a session key,
  // and not lose a payment that has a receipt. Both are asserted, because a guard that
  // fixed the first by dropping the second would be worse than the bug.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)

  await withSettlement(
    {
      policyPay: settledPay,
      readVault: async () => {
        throw new Error('rpc down')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.txHash, '0xvault')
        assert.equal(done.enforcedBy, 'onchain-vault')
      })
    },
  )
})

test('a vault read that never answers cannot strand a payment that already settled', async () => {
  // This read runs AFTER the money has moved but BEFORE the instruction is flipped to
  // executed_onchain, while the TOCTOU guard still holds the id. Without a deadline a hung
  // RPC would leave a real payment recorded nowhere and impossible to retry. Deliberately
  // slower than the deadline, so removing the deadline hangs this test instead of passing.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)

  await withSettlement(
    {
      policyPay: settledPay,
      readVault: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(vaultView({ sessionKeyExpiry: 2_000_000_000 })), 60_000).unref?.()
        }),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.txHash, '0xvault')
        assert.equal(done.enforcedBy, 'onchain-vault')
      })
    },
  )
})

test('NEGATIVE CONTROL: with no signer configured the vault is never read at all', async () => {
  // Without the chain's signer key `policyPay` returns prepared and this path cannot settle
  // for real, so there is nothing to label and no round trip to spend. If the gate goes,
  // every unit test in this suite starts making live RPC calls.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)
  const envVar = vaultChainFor(agent)?.signerEnvVar as string
  const had = process.env[envVar]
  delete process.env[envVar]

  try {
    await withSettlement(
      {
        policyPay: settledPay,
        readVault: async () => {
          throw new Error('readVault should not have been called without a signer')
        },
      },
      async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.enforcedBy, 'onchain-vault')
      },
    )
  } finally {
    if (had !== undefined) process.env[envVar] = had
  }
})

test('NEGATIVE CONTROL: a human override is never a session-key settlement', async () => {
  // `ownerPay` is owner-only and the contract exempts it from the session-key gate on
  // purpose: a human acting as owner is not the agent spending its bounded authority. So
  // even with a live bound on the vault, this settlement is not attributed to the key.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  // Above the auto-approve line, so it waits for a human and settles through ownerPay.
  const ix = seedInstruction(agent, 500)
  assert.equal(ix.status, 'pending_approval')
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))

  await withSettlement(
    {
      policyOwnerPay: settledPay,
      policyPay: async () => {
        throw new Error('policyPay should not have been called for a human override')
      },
      readVault: async () => vaultView({ sessionKeyExpiry: Math.floor(Date.now() / 1000) + HOUR }),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.ok(done.policyNote.includes('human override'))
      })
    },
  )
})

// ── the refusal ──────────────────────────────────────────────────────────────────

test('a SessionKeyExpired revert is the session key refusing, and nothing is settled', async () => {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)
  const committed = dailySpent(agent)
  assert.equal(committed, 0.5, 'an auto-approved payment commits against the cap before it settles')

  await withSettlement(
    {
      policyPay: async () => ({ executed: false as const, reverted: true as const, reason: 'SessionKeyExpired' }),
      // Deliberately unreadable: the revert IS the evidence, so recognising it must not
      // depend on a read that may be down at exactly the moment the chain says no.
      readVault: async () => {
        throw new Error('rpc down')
      },
      payUsdcWithMemo: async () => {
        throw new Error('a policy refusal must not fall through to direct settlement')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        // Nothing is marked settled without a receipt, and there is no receipt here.
        assert.equal(done.status, 'pending_approval')
        assert.equal(done.txHash, undefined)
        assert.equal(done.enforcedBy, 'session-key')
        assert.ok(done.policyNote.includes('SessionKeyExpired'))
        // A payment that moved nothing gives the day's budget back.
        assert.equal(dailySpent(agent), 0)
      })
    },
  )
})

test('NEGATIVE CONTROL: a cap or allowlist refusal is the vault, not the session key', async () => {
  // The two refusals need different human actions (extend the key vs raise the limit), so
  // collapsing them into one label would be a regression even though both come back here.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()

  for (const reason of ['DailyCapExceeded', 'PayeeNotAllowed', 'IsFrozen']) {
    const ix = seedInstruction(agent)
    await withSettlement(
      { policyPay: async () => ({ executed: false as const, reverted: true as const, reason }) },
      async () => {
        await withSignerConfigured(agent, async () => {
          const done = await executeInstruction(ix.id, OWNER)
          assert.ok(!('error' in done))
          assert.equal(done.status, 'pending_approval')
          assert.equal(done.enforcedBy, 'onchain-vault', `${reason} is a vault refusal, not a session-key one`)
        })
      },
    )
  }
})

// ── the same story on Soroban ────────────────────────────────────────────────────
//
// A vault on Stellar was half wired: `executeInstruction` called the Arc adapter whatever
// chain the vault was on, the payee resolver accepted only 0x addresses, and the vault view
// dropped the session-key expiry. The result was not an error message, which would have
// been fine. It was a SILENT FALL-THROUGH: the vault path failed as an infrastructure
// hiccup and settlement continued down the Arc rails, which is a payment recorded against a
// chain it never touched. These tests are mostly about that fall-through not happening.

const STELLAR_VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'

/** An agent whose vault is a Soroban contract, with the owner and operator separated the
 *  way that contract enforces (it refuses owner == operator at construction). */
function seedStellarVaultAgent(): PlatformAgent {
  const agent = createAgent({
    name: 'Soroban Vault Agent',
    description: 'Seeded for Stellar vault settlement tests.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 100, agentToHuman: true },
    owner: OWNER,
  })
  agent.vaultAddress = STELLAR_VAULT
  agent.vaultChainCaip2 = 'stellar:testnet'
  agent.vaultOwner = Keypair.random().publicKey()
  agent.vaultOperator = Keypair.random().publicKey()
  return agent
}

function seedStellarInstruction(agent: PlatformAgent, payee: string, amountUsd = 0.5) {
  const ix = createInstruction({ agentId: agent.id, type: 'payment', amountUsd, payee, caller: OWNER })
  assert.ok(!('error' in ix), `seed failed: ${JSON.stringify(ix)}`)
  return ix
}

const stellarSettled = async () => ({
  executed: true as const,
  txHash: 'ab'.repeat(32),
  explorerUrl: `https://example.test/tx/${'ab'.repeat(32)}`,
})

test('a Stellar vault settles through the routed adapter, not the Arc one', async () => {
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const payee = Keypair.random().publicKey()
  const ix = seedStellarInstruction(agent, payee)

  await withSettlement(
    {
      payFromVault: stellarSettled,
      readVaultPolicy: async () => ({ dailyCapUsd: 1000, autoApproveUsd: 100, allowlistEnabled: false, frozen: false, sessionKeyExpiry: 0 }),
      // The Arc pair must not be reached for a vault on another chain.
      policyPay: async () => {
        throw new Error('the Arc adapter was called for a Soroban vault')
      },
      policyOwnerPay: async () => {
        throw new Error('the Arc adapter was called for a Soroban vault')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.equal(done.txHash, 'ab'.repeat(32))
        assert.ok(done.explorerUrl?.includes('ab'.repeat(32)))
      })
    },
  )
})

test('a Stellar vault can now earn the session-key label, which it could not before', async () => {
  // The label was gated to EVM, with the reason written down: the vault view did not
  // surface an expiry for Soroban. It does now, and the claim is still grounded on a read
  // of the chain rather than on configuration.
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const payee = Keypair.random().publicKey()
  const ix = seedStellarInstruction(agent, payee)
  const expiry = Math.floor(Date.now() / 1000) + HOUR

  await withSettlement(
    {
      payFromVault: stellarSettled,
      readVaultPolicy: async () => ({ dailyCapUsd: 1000, autoApproveUsd: 100, allowlistEnabled: false, frozen: false, sessionKeyExpiry: expiry, sessionKeyExpired: false }),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.enforcedBy, 'session-key')
        assert.ok(done.policyNote.includes(new Date(expiry * 1000).toISOString()))
      })
    },
  )
})

test('a typed Soroban refusal comes back as a policy rejection with the contract error name', async () => {
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const payee = Keypair.random().publicKey()
  const ix = seedStellarInstruction(agent, payee)
  assert.equal(dailySpent(agent), 0.5, 'an auto-approved payment commits against the cap before it settles')

  await withSettlement(
    {
      payFromVault: async () => ({ executed: false as const, reverted: true as const, reason: 'DailyCapExceeded' }),
      payUsdcWithMemo: async () => {
        throw new Error('a policy refusal must not fall through to direct settlement')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'pending_approval')
        assert.equal(done.txHash, undefined)
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.ok(done.policyNote.includes('DailyCapExceeded'))
        assert.equal(dailySpent(agent), 0, 'a payment that moved nothing gives the day back')
      })
    },
  )
})

test('THE ONE THAT MATTERS: a Stellar vault that neither settled nor reverted never reaches the Arc rails', async () => {
  // Pending, no signer, an RPC that would not answer: on Arc all three deliberately fall
  // through to direct settlement, so a chain hiccup never blocks the flow. On Stellar that
  // fallback settles a G... payee from an EVM signer, which cannot work and, if it somehow
  // did, would be a payment on a chain nobody authorised. It stops here instead.
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const payee = Keypair.random().publicKey()
  const ix = seedStellarInstruction(agent, payee)

  await withSettlement(
    {
      payFromVault: async () => ({ executed: false as const, reverted: false as const, reason: 'pending: abc. not in a ledger yet' }),
      payUsdcWithMemo: async () => {
        throw new Error('a Stellar vault must never fall through to Arc direct settlement')
      },
      payUsdcBatch: async () => {
        throw new Error('a Stellar vault must never fall through to the Arc batch path')
      },
      circlePay: async () => {
        throw new Error('a Stellar vault must never fall through to Circle')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'pending_approval')
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.equal(done.txHash, undefined)
        assert.ok(done.policyNote.includes('nothing fell through to another chain'))
        assert.equal(dailySpent(agent), 0)
      })
    },
  )
})

test('a human override on a Stellar vault is owner-signed, so it goes back to the human rather than onward', async () => {
  // `owner_pay` is owner-only and the owner is the human's own G... account by
  // construction, so the server cannot sign it. Before this, that case skipped the vault
  // branch entirely and continued into the Arc rails with a Stellar payee.
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const payee = Keypair.random().publicKey()
  const ix = seedStellarInstruction(agent, payee, 500)
  assert.equal(ix.status, 'pending_approval')
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))

  await withSettlement(
    {
      payFromVault: async () => {
        throw new Error('the server must not attempt owner_pay on a vault it does not own')
      },
      payUsdcWithMemo: async () => {
        throw new Error('a Stellar vault must never fall through to Arc direct settlement')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'pending_approval')
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.ok(done.policyNote.includes('/api/stellar/vault/prepare'))
      })
    },
  )
})

test('a 0x payee on a Stellar-vault agent is not a payee at all, so nothing settles anywhere', async () => {
  // The payee shape follows the PAYING vault's ecosystem. Accepting a 0x address here would
  // resolve a payee the Soroban adapter then has to reject one layer deeper, wearing the
  // wrong chain's error message.
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const ix = seedStellarInstruction(agent, PAYEE)

  await withSettlement(
    {
      payFromVault: async () => {
        throw new Error('a 0x payee must never reach a Soroban vault')
      },
      payUsdcWithMemo: async () => {
        throw new Error('a Stellar-vault agent must not settle on the Arc rails')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_simulated')
        assert.ok(done.policyNote.includes('no Arc address'))
      })
    },
  )
})
