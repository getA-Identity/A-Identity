#!/usr/bin/env node
/**
 * Negative controls for the Solidity suite (mcp/test-sol). Run: `npm run test:sol:controls`.
 *
 * A green `forge test` proves the contracts pass their tests. It does not prove the tests
 * would notice a guard going missing, which is the claim that matters for a vault. So each
 * mutant below deletes or weakens exactly one guard and requires the suite to go RED, then
 * names the tests that caught it. A mutant that stays green is a guard nothing tests, and
 * the script exits 1.
 *
 * Mutants are applied to a throwaway copy of the Foundry project in the OS temp dir. The
 * tracked contracts are never written, so an interrupted run cannot leave a weakened
 * contract behind, and contracts/*.sol keep matching the deployed, verified sources.
 */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEND = 'contracts/AgentSpendPolicy.sol'
const DROP = 'contracts/MerkleAirdrop.sol'

const MUTANTS = [
  { file: SPEND, name: 'pay: operator guard removed',
    from: 'function pay(address to, uint256 amount) external onlyOperator {',
    to: 'function pay(address to, uint256 amount) external {' },
  { file: SPEND, name: 'ownerPay: owner guard removed',
    from: 'function ownerPay(address to, uint256 amount) external onlyOwner {',
    to: 'function ownerPay(address to, uint256 amount) external {' },
  { file: SPEND, name: 'withdraw: owner guard removed',
    from: 'function withdraw(address to, uint256 amount) external onlyOwner {',
    to: 'function withdraw(address to, uint256 amount) external {' },
  { file: SPEND, name: 'setPolicy: owner guard removed',
    from: 'bool _allowlistEnabled) external onlyOwner {',
    to: 'bool _allowlistEnabled) external {' },
  { file: SPEND, name: 'setOperator: owner guard removed',
    from: 'function setOperator(address _operator) external onlyOwner {',
    to: 'function setOperator(address _operator) external {' },
  { file: SPEND, name: 'pay: payee-validity gate (G-1) removed',
    from: '        if (to == address(this) || to == address(usdc)) revert InvalidPayee();\n        if (frozen) revert IsFrozen();\n',
    to: '        if (frozen) revert IsFrozen();\n' },
  { file: SPEND, name: 'pay: freeze gate removed',
    from: '        if (frozen) revert IsFrozen();\n',
    to: '' },
  { file: SPEND, name: 'pay: session-key expiry gate removed',
    from: '        if (sessionKeyExpiry != 0 && block.timestamp > sessionKeyExpiry) revert SessionKeyExpired();\n',
    to: '' },
  { file: SPEND, name: 'pay: expiry boundary moved (> to >=)',
    from: 'block.timestamp > sessionKeyExpiry',
    to: 'block.timestamp >= sessionKeyExpiry' },
  { file: SPEND, name: 'pay: allowlist gate removed',
    from: '        if (allowlistEnabled && !allowed[to]) revert PayeeNotAllowed();\n',
    to: '' },
  { file: SPEND, name: 'pay: per-payment ceiling removed',
    from: '        if (autoApproveMax != 0 && amount > autoApproveMax) revert AboveAutoApprove();\n',
    to: '' },
  { file: SPEND, name: 'pay: daily cap removed',
    from: '        if (dailyCap != 0 && spentOnDay[d] + amount > dailyCap) revert DailyCapExceeded();\n',
    to: '' },
  { file: SPEND, name: 'pay: daily cap boundary moved (> to >=)',
    from: 'spentOnDay[d] + amount > dailyCap',
    to: 'spentOnDay[d] + amount >= dailyCap' },
  { file: SPEND, name: 'pay: spend not recorded against the day',
    from: '        spentOnDay[d] += amount;\n        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Paid(to, amount, d, false);',
    to: '        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Paid(to, amount, d, false);' },
  { file: SPEND, name: 'ownerPay: spend not recorded against the day',
    from: '        spentOnDay[d] += amount;\n        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Paid(to, amount, d, true);',
    to: '        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Paid(to, amount, d, true);' },
  { file: SPEND, name: 'pay: token return value ignored',
    from: '        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Paid(to, amount, d, false);',
    to: '        usdc.transfer(to, amount);\n        emit Paid(to, amount, d, false);' },
  { file: DROP, name: 'claim: double-claim guard removed',
    from: '        if (isClaimed(index)) revert AlreadyClaimed();\n',
    to: '' },
  { file: DROP, name: 'claim: proof check removed',
    from: '        if (computed != merkleRoot) revert InvalidProof();\n',
    to: '' },
  { file: DROP, name: 'sweep: owner guard removed',
    from: '        if (msg.sender != owner) revert NotOwner();\n',
    to: '' },
  { file: DROP, name: 'sweep: deadline removed',
    from: '        if (block.timestamp < claimDeadline) revert SweepBeforeDeadline();\n',
    to: '' },
]

if (!existsSync(join(root, 'lib', 'forge-std'))) {
  console.error('lib/forge-std is missing; fetch it first (see .github/workflows/solidity.yml).')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'sol-controls-'))
cpSync(join(root, 'foundry.toml'), join(work, 'foundry.toml'))
cpSync(join(root, 'contracts'), join(work, 'contracts'), { recursive: true })
cpSync(join(root, 'test-sol'), join(work, 'test-sol'), { recursive: true })
symlinkSync(join(root, 'lib'), join(work, 'lib'), 'dir')

// Fewer fuzz and invariant runs than the main suite: a control only has to show that
// something goes red, and twenty full runs would take minutes for no extra signal.
const env = { ...process.env, FOUNDRY_FUZZ_RUNS: '256', FOUNDRY_INVARIANT_RUNS: '64' }

/** Run the suite in the work copy; return the failing tests as "name: reason", or null if none ran. */
function failingTests() {
  // A counterexample persisted by one mutant must not be replayed against the next.
  rmSync(join(work, 'forge-cache', 'invariant'), { recursive: true, force: true })
  rmSync(join(work, 'forge-cache', 'fuzz'), { recursive: true, force: true })
  const r = spawnSync('forge', ['test', '--json'], { cwd: work, env, encoding: 'utf8', maxBuffer: 1 << 28 })
  const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('{'))
  if (!line) return null
  const failed = []
  for (const suite of Object.values(JSON.parse(line))) {
    for (const [name, t] of Object.entries(suite.test_results ?? {})) {
      if (t.status !== 'Success') failed.push({ name: name.replace(/\(.*$/, ''), reason: t.reason ?? t.status })
    }
  }
  return failed
}

let survivors = 0
try {
  const baseline = failingTests()
  if (baseline === null || baseline.length) {
    console.error('Baseline is not green, so the controls would mean nothing:')
    for (const f of baseline ?? []) console.error(`  ${f.name}: ${f.reason}`)
    if (baseline === null) console.error('  no test output')
    process.exit(1)
  }
  console.log('baseline: green')

  for (const m of MUTANTS) {
    const path = join(work, m.file)
    const original = readFileSync(path, 'utf8')
    const hits = original.split(m.from).length - 1
    if (hits !== 1) {
      console.error(`mutant "${m.name}": expected exactly one match in ${m.file}, found ${hits}. Update the mutant.`)
      process.exit(1)
    }
    writeFileSync(path, original.replace(m.from, m.to))
    const failed = failingTests()
    writeFileSync(path, original)

    if (failed === null) {
      console.log(`  ?? ${m.name}: no test output (compile error?)`)
      survivors++
    } else if (failed.length === 0) {
      console.log(`  SURVIVED ${m.name}`)
      survivors++
    } else {
      const shown = failed.slice(0, 3).map((f) => f.name).join(', ') + (failed.length > 3 ? `, +${failed.length - 3} more` : '')
      console.log(`  killed  ${m.name}  [${failed.length}: ${shown}]`)
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length - survivors}/${MUTANTS.length} mutants killed`)
process.exit(survivors ? 1 : 0)
