import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { __resetPlatformStateForTests, dailySpent, type PlatformAgent } from './core.js'
import { createAgent } from './agents.js'
import { vaultChainFor } from './vault-adapter.js'
import {
  __setSettlementForTests, approveInstruction, createInstruction, executeInstruction, rejectInstruction, sessionKeyBound, UNCONFIRMED_REJECT_AFTER_MS,
} from './instructions.js'
import { circlePay, circleTransferStatus } from '../circle-agent.js'

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

// ── broadcast, and no receipt on any RPC ─────────────────────────────────────────────
//
// A slow receipt used to come back as a revert, and a revert that was not a policy error falls
// through to Circle or direct settlement: the same money out twice, once through a transaction
// that landed after the wait gave up.

const UNCONFIRMED_TX = `0x${'6b'.repeat(32)}`
const unconfirmed = () => ({
  executed: false as const,
  reverted: false as const,
  unconfirmed: true as const,
  txHash: UNCONFIRMED_TX,
  explorerUrl: `https://explorer.test/tx/${UNCONFIRMED_TX}`,
  reason: 'no receipt on any RPC host',
})
const neverAgain = {
  policyOwnerPay: async () => {
    throw new Error('an unconfirmed payment must not be sent again through the vault')
  },
  circlePay: async () => {
    throw new Error('an unconfirmed vault payment must never fall through to Circle')
  },
  payUsdcWithMemo: async () => {
    throw new Error('an unconfirmed vault payment must never fall through to direct settlement')
  },
  payUsdcBatch: async () => {
    throw new Error('an unconfirmed vault payment must never fall through to the batch path')
  },
}

/** A vault agent with a Circle wallet too, so a fall-through has somewhere to land, whose
 *  payment has just come back unconfirmed. */
async function unconfirmedVaultPayment(amountUsd = 0.5) {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  agent.circleWalletId = 'circle-wallet-1'
  const ix = seedInstruction(agent, amountUsd)
  await withSettlement({ ...neverAgain, policyPay: async () => unconfirmed() }, async () => {
    await withSignerConfigured(agent, async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
    })
  })
  return { agent, ix }
}

test('THE DOUBLE PAYMENT: an unconfirmed vault payment never reaches Circle or direct settlement', async () => {
  const { agent, ix } = await unconfirmedVaultPayment()
  assert.equal(ix.status, 'pending_approval')
  assert.equal(ix.enforcedBy, 'onchain-vault')
  assert.equal(ix.unconfirmedTx, UNCONFIRMED_TX)
  assert.ok(ix.explorerUrl?.includes(UNCONFIRMED_TX))
  assert.equal(ix.txHash, undefined, 'txHash means settled, and this is not known to be')
  assert.ok(ix.policyNote.includes(UNCONFIRMED_TX), 'the human gets the hash to check')
  assert.match(ix.policyNote, /may have landed/)
  assert.doesNotMatch(ix.policyNote, /reverted|nothing settled/i)
  assert.equal(dailySpent(agent), 0.5, 'a payment that may have landed stays counted')
})

test('approving an unconfirmed payment while nobody has its receipt sends nothing and hands it back', async () => {
  const { agent, ix } = await unconfirmedVaultPayment()
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  await withSettlement(
    { ...neverAgain, receiptStatus: async () => ({ status: 'unknown' as const, reason: 'no receipt on any RPC host' }) },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(done.unconfirmedTx, UNCONFIRMED_TX)
      assert.match(done.policyNote, /No second payment was sent/)
      assert.equal(dailySpent(agent), 0.5, 'one claim throughout: approving added nothing and the hold released nothing')
    },
  )
})

test('an unconfirmed payment that landed settles the instruction with that hash and no second payment', async () => {
  const { agent, ix } = await unconfirmedVaultPayment()
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  await withSettlement(
    {
      ...neverAgain,
      receiptStatus: async () => ({ status: 'success' as const, txHash: UNCONFIRMED_TX, explorerUrl: `https://explorer.test/tx/${UNCONFIRMED_TX}` }),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.txHash, UNCONFIRMED_TX)
      assert.equal(done.unconfirmedTx, undefined)
      assert.ok(done.offchainAuditId, 'the same structured why, app-layer and labeled as such')
      assert.equal(dailySpent(agent), 0.5, 'one payment, counted once')
    },
  )
})

test('an unconfirmed payment that reverted is free to settle on the approval that followed', async () => {
  const { ix, agent } = await unconfirmedVaultPayment()
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  let paid = 0
  await withSettlement(
    {
      ...neverAgain,
      receiptStatus: async () => ({ status: 'reverted' as const, txHash: UNCONFIRMED_TX, explorerUrl: 'x' }),
      policyOwnerPay: async () => {
        paid += 1
        return { executed: true as const, txHash: `0x${'7c'.repeat(32)}`, explorerUrl: 'y' }
      },
      readVault: async () => ({}) as never,
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.unconfirmedTx, undefined)
        assert.equal(paid, 1)
        assert.equal(dailySpent(agent), 0.5, 'the claim the hold kept pays for this settlement, once')
      })
    },
  )
})

test('a direct settlement with no receipt is unconfirmed, not "no signer, simulated"', async () => {
  // Neither executed nor reverted used to mean one thing on this path: nothing was broadcast.
  __resetPlatformStateForTests()
  const agent = createAgent({
    name: 'Direct Agent',
    description: 'Seeded for direct settlement.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 100, agentToHuman: true },
    owner: OWNER,
  })
  const ix = seedInstruction(agent)
  await withSettlement({ payUsdcWithMemo: async () => unconfirmed() }, async () => {
    const done = await executeInstruction(ix.id, OWNER)
    assert.ok(!('error' in done))
    assert.equal(done.status, 'pending_approval')
    assert.equal(done.enforcedBy, 'server')
    assert.equal(done.unconfirmedTx, UNCONFIRMED_TX)
    assert.doesNotMatch(done.policyNote, /simulated/)
  })
})

// ── the daily cap while a payment may have landed ────────────────────────────────────

/** An agent with no vault and a cap of 10, whose 9 USDC payment just came back with no receipt. */
async function heldDirectPayment() {
  __resetPlatformStateForTests()
  const agent = createAgent({
    name: 'Capped Agent',
    description: 'Seeded for the cap while a payment is held.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 10, autoApproveUnderUsd: 10, agentToHuman: true },
    owner: OWNER,
  })
  const ix = seedInstruction(agent, 9)
  await withSettlement({ payUsdcWithMemo: async () => unconfirmed() }, async () => {
    const done = await executeInstruction(ix.id, OWNER)
    assert.ok(!('error' in done))
  })
  return { agent, ix }
}

test('THE CAP: a held payment stays counted, so the agent cannot spend the cap again while it lands', async () => {
  const { agent, ix } = await heldDirectPayment()
  assert.equal(ix.status, 'pending_approval')
  assert.equal(dailySpent(agent), 9)
  const next = createInstruction({ agentId: agent.id, type: 'payment', amountUsd: 9, payee: PAYEE, caller: OWNER })
  assert.ok(!('error' in next))
  assert.notEqual(next.status, 'auto_approved', '18 against a cap of 10')
})

test('approving a held payment does not count it twice, and a revert gives it back once', async () => {
  const { agent, ix } = await heldDirectPayment()
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  assert.equal(dailySpent(agent), 9)
  await withSettlement(
    {
      receiptStatus: async () => ({ status: 'reverted' as const, txHash: UNCONFIRMED_TX, explorerUrl: 'x' }),
      payUsdcWithMemo: async () => ({ executed: false as const, reverted: true as const, reason: 'still no funds' }),
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(done.unconfirmedTx, undefined)
    },
  )
  assert.equal(dailySpent(agent), 0)
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  assert.equal(dailySpent(agent), 9, 'with nothing held, an approval counts as it always did')
})

test('a hold that crosses midnight is counted against the new day if it settles for real', async () => {
  const { agent, ix } = await heldDirectPayment()
  ix.capHeldOn = '2000-01-01'
  agent.spendDate = '2000-01-01'
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  assert.equal(dailySpent(agent), 0)
  await withSettlement(
    {
      receiptStatus: async () => ({ status: 'reverted' as const, txHash: UNCONFIRMED_TX, explorerUrl: 'x' }),
      payUsdcWithMemo: async () => ({ executed: true as const, txHash: `0x${'8d'.repeat(32)}`, explorerUrl: 'y' }),
    },
    async () => { await executeInstruction(ix.id, OWNER) },
  )
  assert.equal(ix.status, 'executed_onchain')
  assert.equal(dailySpent(agent), 9)
})

// ── rejecting a held instruction reads it first ──────────────────────────────────────

test('THE EDIT FLOW: rejecting a held payment that landed records it as settled, and answers with an error', async () => {
  const { agent, ix } = await heldDirectPayment()
  await withSettlement(
    { receiptStatus: async () => ({ status: 'success' as const, txHash: UNCONFIRMED_TX, explorerUrl: `https://explorer.test/tx/${UNCONFIRMED_TX}` }) },
    async () => {
      // The console rejects and then creates a replacement, so anything but an error here pays twice.
      const out = await rejectInstruction(ix.id, OWNER, 'replaced with edited terms')
      assert.ok('error' in out)
      if ('error' in out) assert.match(out.error, /already landed/)
      assert.equal(ix.status, 'executed_onchain')
      assert.equal(ix.txHash, UNCONFIRMED_TX)
      assert.equal(ix.unconfirmedTx, undefined)
      assert.equal(dailySpent(agent), 9, 'the spend is counted')
    },
  )
})

test('rejecting a held payment nobody can read is refused, and the hold is untouched', async () => {
  const { agent, ix } = await heldDirectPayment()
  await withSettlement(
    { receiptStatus: async () => ({ status: 'unknown' as const, reason: 'no receipt on any RPC host' }) },
    async () => {
      const out = await rejectInstruction(ix.id, OWNER, 'never mind')
      assert.ok('error' in out)
      if ('error' in out) assert.match(out.error, /may have moved money/)
    },
  )
  assert.equal(ix.status, 'pending_approval')
  assert.equal(ix.unconfirmedTx, UNCONFIRMED_TX)
  assert.equal(dailySpent(agent), 9)
})

test('a day later a human may give up on it, the hash stays on the record, and the cap claim is not given back', async () => {
  const { agent, ix } = await heldDirectPayment()
  ix.unconfirmedAt = new Date(Date.now() - UNCONFIRMED_REJECT_AFTER_MS - 1_000).toISOString()
  await withSettlement(
    { receiptStatus: async () => ({ status: 'unknown' as const, reason: 'no receipt on any RPC host' }) },
    async () => {
      const out = await rejectInstruction(ix.id, OWNER, 'it never landed')
      assert.ok(!('error' in out))
    },
  )
  assert.equal(ix.status, 'rejected')
  assert.equal(ix.abandonedTx, UNCONFIRMED_TX)
  assert.match(ix.policyNote, /may still have moved money/)
  assert.equal(dailySpent(agent), 9)
})

test('rejecting a held payment that reverted is a plain rejection, and the claim goes back', async () => {
  const { agent, ix } = await heldDirectPayment()
  await withSettlement(
    { receiptStatus: async () => ({ status: 'reverted' as const, txHash: UNCONFIRMED_TX, explorerUrl: 'x' }) },
    async () => {
      const out = await rejectInstruction(ix.id, OWNER, 'not paying this')
      assert.ok(!('error' in out))
    },
  )
  assert.equal(ix.status, 'rejected')
  assert.equal(ix.unconfirmedTx, undefined)
  assert.equal(dailySpent(agent), 0)
})

// ── a mined revert, and the hash on the record before the wait ───────────────────────

test('a vault payment mined and reverted never falls through: the chain refused it', async () => {
  // The owner froze the vault after a lagging host's simulate passed. The receipt carries no
  // typed name, and the same money through Circle or the server signer has no vault in the way.
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  agent.circleWalletId = 'circle-wallet-1'
  const ix = seedInstruction(agent)
  const tx = `0x${'9e'.repeat(32)}`
  await withSettlement(
    {
      ...neverAgain,
      policyPay: async () => ({ executed: false as const, reverted: true as const, reason: `vault pay reverted on-chain (tx ${tx})`, minedTx: tx }),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'pending_approval')
        assert.equal(done.enforcedBy, 'onchain-vault')
        assert.ok(done.policyNote.includes(tx))
        assert.equal(dailySpent(agent), 0, 'it reverted, so nothing moved and the claim goes back')
      })
    },
  )
})

test('a vault simulate that failed on infra still falls through: nothing was broadcast', async () => {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)
  let direct = 0
  await withSettlement(
    {
      policyPay: async () => ({ executed: false as const, reverted: true as const, reason: 'RPC 503' }),
      payUsdcWithMemo: async () => { direct += 1; return { executed: true as const, txHash: '0xd', explorerUrl: 'y' } },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
      })
    },
  )
  assert.equal(direct, 1)
})

test('a restart during the wait finds the hash on the instruction and pays nothing again', async () => {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)
  let noted: string | undefined
  await withSettlement(
    {
      policyPay: async (_v, _t, _a, _e, hooks) => {
        hooks?.onBroadcast?.(UNCONFIRMED_TX)
        noted = ix.unconfirmedTx
        // The process goes away here, inside the wait.
        throw new Error('process restarted')
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        await assert.rejects(executeInstruction(ix.id, OWNER))
      })
    },
  )
  assert.equal(noted, UNCONFIRMED_TX, 'noted before the wait')
  assert.equal(ix.status, 'auto_approved', 'still approved, which is what used to pay twice')

  await withSettlement(
    {
      ...neverAgain,
      policyPay: async () => { throw new Error('the next execute must read the hash, not send') },
      receiptStatus: async () => ({ status: 'unknown' as const, reason: 'no receipt yet' }),
    },
    async () => {
      const held = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in held))
      assert.equal(held.status, 'pending_approval')
      assert.equal(held.unconfirmedTx, UNCONFIRMED_TX)
    },
  )
})

test('a payment answered on the first attempt leaves no open hash behind', async () => {
  __resetPlatformStateForTests()
  const agent = seedVaultAgent()
  const ix = seedInstruction(agent)
  await withSettlement(
    {
      policyPay: async (_v, _t, _a, _e, hooks) => {
        hooks?.onBroadcast?.(UNCONFIRMED_TX)
        return { executed: true as const, txHash: UNCONFIRMED_TX, explorerUrl: 'y' }
      },
      readVault: async () => vaultView({}),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
        assert.equal(done.unconfirmedTx, undefined)
        assert.equal(done.unconfirmedAt, undefined)
      })
    },
  )
})

// ── a Soroban payment that may still land ────────────────────────────────────────────

test('a pending Stellar vault payment is held with its hash, keeps the cap, and is read from Soroban', async () => {
  __resetPlatformStateForTests()
  const agent = seedStellarVaultAgent()
  const ix = seedStellarInstruction(agent, Keypair.random().publicKey())
  const spentBefore = dailySpent(agent)
  const hash = 'ab'.repeat(32)
  await withSettlement(
    {
      ...neverAgain,
      payFromVault: async () => ({ executed: false as const, reverted: false as const, unconfirmed: true as const, txHash: hash, explorerUrl: `https://x/tx/${hash}`, reason: `pending: ${hash}. not in a ledger yet` }),
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'pending_approval')
        assert.equal(done.unconfirmedTx, hash)
        assert.doesNotMatch(done.policyNote, /nothing moved|Nothing was settled/i)
        assert.equal(dailySpent(agent), spentBefore, 'not given back while it may land')
      })
    },
  )
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  const askedFor: unknown[] = []
  await withSettlement(
    {
      ...neverAgain,
      payFromVault: async () => { throw new Error('a pending payment is not sent a second time') },
      receiptStatus: async (h, a) => {
        askedFor.push(h, a?.id)
        return { status: 'success' as const, txHash: h, explorerUrl: `https://x/tx/${h}` }
      },
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.txHash, hash)
    },
  )
  assert.deepEqual(askedFor, [hash, agent.id], 'the read is told whose vault this is, which is what routes it to Soroban')
})

// ── Circle: a transfer it may still complete ─────────────────────────────────────────

const circlePending = (transactionId?: string) => ({
  executed: false as const,
  rejected: false as const,
  pending: true as const,
  ...(transactionId ? { transactionId } : {}),
  reason: 'Circle transaction is SENT and has not finished',
})

function seedCircleAgent() {
  __resetPlatformStateForTests()
  const agent = createAgent({
    name: 'Circle Agent',
    description: 'Seeded for Circle settlement.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 100, agentToHuman: true },
    owner: OWNER,
  })
  agent.circleWalletId = 'circle-wallet-1'
  return agent
}

test('THE CIRCLE DOUBLE PAYMENT: a transfer that may still complete holds, with the id, and nothing else goes out', async () => {
  const agent = seedCircleAgent()
  const ix = seedInstruction(agent)
  await withSettlement(
    {
      circlePay: async () => circlePending('circle-tx-1'),
      payUsdcWithMemo: async () => { throw new Error('Circle may still complete it, so this would pay twice') },
      payUsdcBatch: async () => { throw new Error('Circle may still complete it, so this would pay twice') },
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(done.enforcedBy, 'circle-agent-stack')
      assert.equal(done.unconfirmedCircleTx, 'circle-tx-1')
      assert.equal(done.txHash, undefined)
    },
  )
  assert.equal(dailySpent(agent), 0.5)
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))

  // Still open: read it, send nothing.
  const noSend = {
    circlePay: async () => { throw new Error('the open transfer is read, not created again') },
    payUsdcWithMemo: async () => { throw new Error('nothing else may go out') },
  }
  await withSettlement({ ...noSend, circleStatus: async () => ({ status: 'unknown' as const, reason: 'still SENT' }) }, async () => {
    const done = await executeInstruction(ix.id, OWNER)
    assert.ok(!('error' in done))
    assert.equal(done.status, 'pending_approval')
    assert.equal(dailySpent(agent), 0.5)
  })

  // It completes.
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  await withSettlement({ ...noSend, circleStatus: async () => ({ status: 'success' as const, txHash: '0xcircle', explorerUrl: 'u' }) }, async () => {
    const done = await executeInstruction(ix.id, OWNER)
    assert.ok(!('error' in done))
    assert.equal(done.status, 'executed_onchain')
    assert.equal(done.txHash, '0xcircle')
    assert.equal(done.unconfirmedCircleTx, undefined)
    assert.equal(done.circleIdempotencyKey, undefined)
    assert.equal(dailySpent(agent), 0.5, 'counted once')
  })
})

test('a held Circle transfer that ended FAILED is free to settle on the approval that followed', async () => {
  const agent = seedCircleAgent()
  const ix = seedInstruction(agent)
  await withSettlement({ circlePay: async () => circlePending('circle-tx-2') }, async () => { await executeInstruction(ix.id, OWNER) })
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  const keys: unknown[] = []
  await withSettlement(
    {
      circleStatus: async () => ({ status: 'reverted' as const, reason: 'FAILED' }),
      circlePay: async (_w, _t, _a, _e, deps) => {
        keys.push(deps?.idempotencyKey)
        return { executed: true as const, txHash: '0xc2', explorerUrl: 'u' }
      },
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(dailySpent(agent), 0.5)
    },
  )
  assert.equal(keys.length, 1)
  assert.ok(keys[0], 'a new transfer gets a new key')
})

test('a Circle create nobody answered goes back to Circle with the same key, ahead of the vault', async () => {
  const agent = seedCircleAgent()
  agent.vaultAddress = VAULT
  agent.vaultOwner = OPERATOR
  agent.vaultOperator = OPERATOR
  const ix = seedInstruction(agent)
  const keys: unknown[] = []
  await withSettlement(
    {
      policyPay: async () => ({ executed: false as const, reverted: true as const, reason: 'RPC 503' }),
      circlePay: async (_w, _t, _a, _e, deps) => {
        keys.push(deps?.idempotencyKey)
        return circlePending()
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'pending_approval')
        assert.ok(done.circleIdempotencyKey)
      })
    },
  )
  assert.ok(!('error' in approveInstruction(ix.id, OWNER)))
  await withSettlement(
    {
      policyOwnerPay: async () => { throw new Error('the vault must not run ahead of a transfer Circle may hold') },
      circlePay: async (_w, _t, _a, _e, deps) => {
        keys.push(deps?.idempotencyKey)
        return { executed: true as const, txHash: '0xc3', explorerUrl: 'u' }
      },
    },
    async () => {
      await withSignerConfigured(agent, async () => {
        const done = await executeInstruction(ix.id, OWNER)
        assert.ok(!('error' in done))
        assert.equal(done.status, 'executed_onchain')
      })
    },
  )
  assert.equal(keys.length, 2)
  assert.equal(keys[0], keys[1], 'the same key finds the same transfer')
})

test('a Circle that definitely did not take it still falls through to direct settlement', async () => {
  const agent = seedCircleAgent()
  const ix = seedInstruction(agent)
  let direct = 0
  await withSettlement(
    {
      circlePay: async () => ({ executed: false as const, rejected: false as const, reason: 'FAILED: out of funds' }),
      payUsdcWithMemo: async () => { direct += 1; return { executed: true as const, txHash: '0xd', explorerUrl: 'y' } },
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'executed_onchain')
      assert.equal(done.circleIdempotencyKey, undefined)
    },
  )
  assert.equal(direct, 1)
})

test('rejecting a held Circle transfer reads Circle first', async () => {
  const agent = seedCircleAgent()
  const ix = seedInstruction(agent)
  await withSettlement({ circlePay: async () => circlePending('circle-tx-4') }, async () => { await executeInstruction(ix.id, OWNER) })
  await withSettlement({ circleStatus: async () => ({ status: 'unknown' as const, reason: 'still SENT' }) }, async () => {
    assert.ok('error' in (await rejectInstruction(ix.id, OWNER)))
  })
  assert.equal(ix.status, 'pending_approval')
  await withSettlement({ circleStatus: async () => ({ status: 'reverted' as const, reason: 'CANCELLED' }) }, async () => {
    assert.ok(!('error' in (await rejectInstruction(ix.id, OWNER))))
  })
  assert.equal(ix.status, 'rejected')
  assert.equal(dailySpent(agent), 0)
})

// The real circlePay against a fake client: what each Circle answer means.
const circleClient = (over: { create?: () => unknown; get?: () => unknown }) =>
  ({
    createTransaction: over.create ?? (async () => ({ data: { id: 'circle-id' } })),
    getTransaction: over.get ?? (async () => ({ data: { transaction: { state: 'SENT' } } })),
  }) as never

test('circlePay: a poll that runs out or throws is pending with the id, never unavailable', async () => {
  const ran = await circlePay('w', PAYEE, 1, {}, { client: circleClient({}), pollDelayMs: 0 })
  assert.ok('pending' in ran)
  if ('pending' in ran) assert.equal(ran.transactionId, 'circle-id')
  const threw = await circlePay('w', PAYEE, 1, {}, { client: circleClient({ get: async () => { throw new Error('socket hang up') } }), pollDelayMs: 0 })
  assert.ok('pending' in threw)
  if ('pending' in threw) assert.equal(threw.transactionId, 'circle-id')
})

test('circlePay: a create that may have arrived is pending; a 4xx and a terminal failure are unavailable', async () => {
  const timeout = await circlePay('w', PAYEE, 1, {}, { client: circleClient({ create: async () => { throw new Error('timeout of 30000ms exceeded') } }), pollDelayMs: 0 })
  assert.ok('pending' in timeout)
  const server = await circlePay('w', PAYEE, 1, {}, { client: circleClient({ create: async () => { throw Object.assign(new Error('bad gateway'), { response: { status: 502 } }) } }), pollDelayMs: 0 })
  assert.ok('pending' in server)
  const refused = await circlePay('w', PAYEE, 1, {}, { client: circleClient({ create: async () => { throw Object.assign(new Error('insufficient'), { response: { status: 422 } }) } }), pollDelayMs: 0 })
  assert.ok(!('pending' in refused))
  assert.equal(refused.executed, false)
  for (const state of ['FAILED', 'CANCELLED']) {
    const ended = await circlePay('w', PAYEE, 1, {}, { client: circleClient({ get: async () => ({ data: { transaction: { state } } }) }), pollDelayMs: 0 })
    assert.ok(!('pending' in ended), state)
    assert.equal(ended.executed, false)
  }
})

test('circlePay sends the idempotency key, and completes and denies as before', async () => {
  let sent: Record<string, unknown> = {}
  const done = await circlePay('w', PAYEE, 1, {}, {
    idempotencyKey: 'key-1',
    pollDelayMs: 0,
    client: circleClient({
      create: async (input?: unknown) => { sent = input as Record<string, unknown>; return { data: { id: 'x' } } },
      get: async () => ({ data: { transaction: { state: 'COMPLETE', txHash: '0xfeed' } } }),
    } as never),
  })
  assert.equal(sent.idempotencyKey, 'key-1')
  assert.equal(done.executed, true)
  const denied = await circlePay('w', PAYEE, 1, {}, { pollDelayMs: 0, client: circleClient({ get: async () => ({ data: { transaction: { state: 'DENIED' } } }) }) })
  assert.ok(!denied.executed && denied.rejected)
})

test('one look at a Circle transfer names each state, and a read that fails is unknown', async () => {
  const read = (t: unknown) => circleTransferStatus('x', {}, { client: circleClient({ get: async () => ({ data: { transaction: t } }) }) })
  assert.equal((await read({ state: 'COMPLETE', txHash: '0xa' })).status, 'success')
  assert.equal((await read({ state: 'DENIED' })).status, 'denied')
  assert.equal((await read({ state: 'FAILED' })).status, 'reverted')
  assert.equal((await read({ state: 'CANCELLED' })).status, 'reverted')
  assert.equal((await read({ state: 'SENT' })).status, 'unknown')
  assert.equal((await read({ state: 'COMPLETE' })).status, 'unknown', 'complete with no hash is no receipt')
  const failed = await circleTransferStatus('x', {}, { client: circleClient({ get: async () => { throw new Error('no') } }) })
  assert.equal(failed.status, 'unknown')
  assert.equal((await circleTransferStatus('x', {})).status, 'unknown', 'no credentials is not a verdict')
})

test('a batch with no receipt does not degrade to a single transfer', async () => {
  __resetPlatformStateForTests()
  const agent = createAgent({
    name: 'Batch Agent',
    description: 'Seeded for batch settlement.',
    category: 'Research',
    capabilities: [],
    permissions: { dailyCapUsd: 1000, autoApproveUnderUsd: 100, agentToHuman: true },
    owner: OWNER,
  })
  const ix = createInstruction({ agentId: agent.id, type: 'batch', amountUsd: 0.1, count: 3, payee: PAYEE, caller: OWNER })
  assert.ok(!('error' in ix), JSON.stringify(ix))
  await withSettlement(
    {
      payUsdcBatch: async () => unconfirmed(),
      payUsdcWithMemo: async () => {
        throw new Error('the batch may have landed, so the single transfer must not go out')
      },
    },
    async () => {
      const done = await executeInstruction(ix.id, OWNER)
      assert.ok(!('error' in done))
      assert.equal(done.status, 'pending_approval')
      assert.equal(done.unconfirmedTx, UNCONFIRMED_TX)
    },
  )
})
