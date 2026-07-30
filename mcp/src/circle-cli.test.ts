import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compilePolicyPlan, bootstrapCommands } from './circle-cli.js'

const ADDR = '0xd305607510E0Db2c95807173c7A05BEA53c1ed36'
const PAYEE = '0x000000000000000000000000000000000000bEEF'

/**
 * The compiler's whole job is to reproduce the owner's numbers exactly. A command that
 * quietly rounds a cap, or drops a payee, would loosen a limit the human set, which is
 * the one failure this product cannot have.
 */

test('the owner’s numbers survive compilation exactly', () => {
  const plan = compilePolicyPlan({
    address: ADDR,
    chain: 'ARC-TESTNET',
    permissions: { dailyCapUsd: 50, autoApproveUnderUsd: 5 },
  })
  const limit = plan.commands.find((c) => c.command.includes('transfer-limit'))
  assert.ok(limit)
  assert.match(limit.command, /--per-tx 5\.00/)
  assert.match(limit.command, /--daily 50\.00/)
  assert.match(limit.command, new RegExp(`--address ${ADDR}`))
})

test('an allowlist compiles to the bracketed targets the CLI expects', () => {
  const plan = compilePolicyPlan({
    address: ADDR,
    chain: 'ARC-TESTNET',
    permissions: { payeeAllowlist: [PAYEE] },
  })
  const allow = plan.commands.find((c) => c.command.includes('recipient-allowlist'))
  assert.ok(allow)
  assert.match(allow.command, /--targets "\[0x[0-9a-fA-F]{40}\]"/)
})

test('a non-address allowlist entry is dropped and the drop is declared', () => {
  const plan = compilePolicyPlan({
    address: ADDR,
    chain: 'ARC-TESTNET',
    permissions: { payeeAllowlist: [PAYEE, 'not-an-address'] },
  })
  const allow = plan.commands.find((c) => c.command.includes('recipient-allowlist'))
  assert.ok(allow && !allow.command.includes('not-an-address'))
  assert.ok(plan.notExpressible.some((n) => /not 0x addresses/i.test(n)))
})

test('a freeze is never silently lost: Circle cannot express it, so we say so', () => {
  const plan = compilePolicyPlan({ address: ADDR, chain: 'ARC-TESTNET', permissions: { frozen: true } })
  assert.ok(plan.notExpressible.some((n) => /frozen/i.test(n)))
})

test('reading the budget needs no confirmation, changing a limit does', () => {
  const plan = compilePolicyPlan({
    address: ADDR,
    chain: 'ARC-TESTNET',
    permissions: { dailyCapUsd: 100 },
  })
  const budget = plan.commands.find((c) => c.command.includes('limit budget'))
  const limit = plan.commands.find((c) => c.command.includes('transfer-limit'))
  assert.equal(budget?.needsOtp, false)
  assert.equal(limit?.needsOtp, true)
})

test('no permissions still yields a readable plan rather than an empty one', () => {
  const plan = compilePolicyPlan({ address: ADDR, chain: 'ARC-TESTNET', permissions: {} })
  assert.ok(plan.commands.length >= 1)
  assert.ok(plan.notExpressible.length >= 1)
})

test('bootstrap tells the owner to install and sign in, in that order', () => {
  const [install, login] = bootstrapCommands('a@b.com')
  assert.match(install.command, /npm install -g @circle-fin\/cli/)
  assert.match(login.command, /circle wallet login a@b\.com --testnet/)
})
