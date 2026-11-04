#!/usr/bin/env node
/**
 * Negative controls for the Solidity suite (mcp/test-sol). Run: `npm run test:sol:controls`.
 *
 * A green `forge test` proves the contracts pass their tests. It does not prove the tests
 * would notice a guard going missing, which is the claim that matters for a vault. So each
 * mutant below deletes or weakens exactly one guard, or changes one behaviour owners are told
 * about, and requires the suite to go RED, then names the tests that caught it. A mutant that
 * stays green is something nothing tests, and the script exits 1.
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
  { file: SPEND, name: 'pay: ceiling boundary moved (> to >=)',
    from: 'amount > autoApproveMax',
    to: 'amount >= autoApproveMax' },
  { file: SPEND, name: 'pay: expiry 1 reads as no expiry',
    from: 'sessionKeyExpiry != 0 && block.timestamp',
    to: 'sessionKeyExpiry > 1 && block.timestamp' },
  { file: SPEND, name: 'pay: zero amount skips the zero-address gate',
    from: 'onlyOperator {\n        if (to == address(0)) revert ZeroAddress();',
    to: 'onlyOperator {\n        if (amount != 0 && to == address(0)) revert ZeroAddress();' },
  { file: SPEND, name: 'pay: zero amount skips the allowlist gate',
    from: 'if (allowlistEnabled && !allowed[to])',
    to: 'if (amount != 0 && allowlistEnabled && !allowed[to])' },
  { file: SPEND, name: 'pay: made payable',
    from: 'function pay(address to, uint256 amount) external onlyOperator {',
    to: 'function pay(address to, uint256 amount) external payable onlyOperator {' },
  { file: SPEND, name: 'pay: emits Paid twice',
    from: '        emit Paid(to, amount, d, false);',
    to: '        emit Paid(to, amount, d, false);\n        emit Paid(to, amount, d, false);' },
  { file: SPEND, name: 'vault: accepts a plain native send',
    from: '    /// @notice Current UTC-day index (chain time).',
    to: '    receive() external payable {}\n\n    /// @notice Current UTC-day index (chain time).' },
  { file: SPEND, name: 'ownerPay: amount clamped to the balance',
    from: '        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Paid(to, amount, d, true);',
    to: '        if (!usdc.transfer(to, amount > usdc.balanceOf(address(this)) ? usdc.balanceOf(address(this)) : amount)) revert TransferFailed();\n        emit Paid(to, amount, d, true);' },
  { file: SPEND, name: 'withdraw: also counts toward the day',
    from: '        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Withdrawn(to, amount);',
    to: '        spentOnDay[today()] += amount;\n        if (!usdc.transfer(to, amount)) revert TransferFailed();\n        emit Withdrawn(to, amount);' },
  { file: SPEND, name: 'withdraw: event names the owner, not the recipient',
    from: 'emit Withdrawn(to, amount);',
    to: 'emit Withdrawn(owner, amount);' },
  { file: SPEND, name: 'constructor: the operator starts on the allowlist',
    from: '        autoApproveMax = _autoApproveMax;\n    }',
    to: '        autoApproveMax = _autoApproveMax;\n        allowed[_operator] = true;\n    }' },
  { file: SPEND, name: 'setAllowed: owner guard removed',
    from: 'function setAllowed(address payee, bool ok) external onlyOwner {',
    to: 'function setAllowed(address payee, bool ok) external {' },
  { file: SPEND, name: 'setAllowed: the operator accepted too',
    from: 'function setAllowed(address payee, bool ok) external onlyOwner {',
    to: 'function setAllowed(address payee, bool ok) external {\n        if (msg.sender != owner && msg.sender != operator) revert NotOwner();' },
  { file: SPEND, name: 'setOperator: the operator accepted too',
    from: 'function setOperator(address _operator) external onlyOwner {',
    to: 'function setOperator(address _operator) external {\n        if (msg.sender != owner && msg.sender != operator) revert NotOwner();' },
  { file: SPEND, name: 'setSessionKeyExpiry: owner guard removed',
    from: 'function setSessionKeyExpiry(uint256 _expiry) external onlyOwner {',
    to: 'function setSessionKeyExpiry(uint256 _expiry) external {' },
  { file: SPEND, name: 'setSessionKeyExpiry: the operator accepted too',
    from: 'function setSessionKeyExpiry(uint256 _expiry) external onlyOwner {',
    to: 'function setSessionKeyExpiry(uint256 _expiry) external {\n        if (msg.sender != owner && msg.sender != operator) revert NotOwner();' },
  { file: SPEND, name: 'setFrozen: owner guard removed',
    from: 'function setFrozen(bool _frozen) external onlyOwner {',
    to: 'function setFrozen(bool _frozen) external {' },
  { file: SPEND, name: 'setFrozen: toggles instead of setting',
    from: 'frozen = _frozen;',
    to: 'frozen = !frozen;' },
  { file: SPEND, name: 'setPolicy: the allowlist flag can only go on',
    from: 'allowlistEnabled = _allowlistEnabled;',
    to: 'allowlistEnabled = allowlistEnabled || _allowlistEnabled;' },
  { file: SPEND, name: 'setPolicy: refreshes the day',
    from: 'bool _allowlistEnabled) external onlyOwner {',
    to: 'bool _allowlistEnabled) external onlyOwner {\n        spentOnDay[today()] = 0;' },
  { file: SPEND, name: 'setOperator: refreshes the day',
    from: 'function setOperator(address _operator) external onlyOwner {',
    to: 'function setOperator(address _operator) external onlyOwner {\n        spentOnDay[today()] = 0;' },
  { file: SPEND, name: 'setOperator: clears the expiry, so a new key has no time bound',
    from: '        operator = _operator;\n        emit OperatorSet(_operator);',
    to: '        operator = _operator;\n        sessionKeyExpiry = 0;\n        emit OperatorSet(_operator);' },
  { file: SPEND, name: 'setSessionKeyExpiry: a revoke sticks, so a later extend cannot re-arm the key',
    from: '        sessionKeyExpiry = _expiry;',
    to: '        if (sessionKeyExpiry != 1) sessionKeyExpiry = _expiry;' },
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
  { file: DROP, name: 'sweep: deadline boundary moved (< to <=)',
    from: 'block.timestamp < claimDeadline',
    to: 'block.timestamp <= claimDeadline' },
  { file: DROP, name: 'claim: index never marked claimed',
    from: '        _setClaimed(index);\n',
    to: '' },
  { file: DROP, name: 'claim: the proof walk stops at depth 3',
    from: 'i < merkleProof.length; i++',
    to: 'i < merkleProof.length && i < 3; i++' },
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
// something goes red, and a full run per mutant would take minutes for no extra signal.
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
