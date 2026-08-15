#!/usr/bin/env node
/**
 * Negative controls: prove the test suite would actually catch the bug it claims to.
 *
 * A green test suite says the contract passes its tests. It does not say the tests would
 * notice if the contract stopped being safe. For this contract that distinction is the
 * whole ballgame, because `pay` moves the vault's OWN balance: the token's from-side
 * authorization is satisfied structurally by Soroban's direct-call rule, there is no
 * `msg.sender`, and so the entire authorization surface collapses onto a single line. If
 * that line went missing, every policy gate would still pass and every amount would still
 * be checked. The vault would simply be drainable by anyone.
 *
 * And the standard Soroban test harness, `mock_all_auths()`, is precisely the thing that
 * hides that. A suite written the usual way passes identically against a contract with
 * the guard deleted.
 *
 * So: for each control below, delete the guard, run the suite, and REQUIRE it to go red.
 * A control that leaves the suite green is a reported failure, not a curiosity.
 *
 * Usage:  node soroban/audit/run-negative-controls.mjs
 * Exit 0 only when every control was caught.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(WORKSPACE, 'contracts/agent-spend-policy/src')

/**
 * Each control names a guard, the exact source text that implements it, and what would be
 * true of a deployed contract without it.
 *
 * Controls are added alongside the tests that cover them, never ahead of them: a control
 * with no covering test fails here and should, because it is telling the truth about a
 * gap. The amount, payee and arithmetic guards get their controls in the same commit as
 * their tests.
 */
const CONTROLS = [
  {
    name: 'operator-require-auth',
    file: 'lib.rs',
    find: '        operator.require_auth();\n',
    replace: '',
    breaks:
      'Any funded account on the network can call pay and drain the vault up to the policy limits. Every gate still passes; none of them says WHO may spend.',
    caughtBy: 'test::auth::a_funded_stranger_signing_for_itself_cannot_pay, and five others',
  },
  {
    name: 'owner-require-auth',
    file: 'lib.rs',
    find: '        let owner = store::get_owner(env);\n        owner.require_auth();\n',
    replace: '        let _owner = store::get_owner(env);\n',
    breaks:
      'Anyone can freeze the vault forever, retarget the operator, lift the caps, or withdraw the entire balance.',
    caughtBy: 'test::auth::every_owner_setter_without_auth_fails, and three others',
  },
]

const read = (f) => readFileSync(join(SRC, f), 'utf8')
const write = (f, s) => writeFileSync(join(SRC, f), s)

/** Returns true when the suite passed, which for a mutated tree is the failure we hunt. */
function suitePasses() {
  try {
    execFileSync('cargo', ['test', '--quiet'], { cwd: WORKSPACE, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

let failures = 0

// Baseline first. A suite that is already red makes every control below meaningless:
// each one would "pass" for the wrong reason, and the run would report safety it never
// measured.
process.stdout.write('baseline: ')
if (!suitePasses()) {
  console.error('FAIL\n  The suite is red before any control was applied. Fix that first.')
  process.exit(1)
}
console.log('green')

for (const c of CONTROLS) {
  const original = read(c.file)
  const hits = original.split(c.find).length - 1
  if (hits !== 1) {
    console.error(
      `\n${c.name}: FAIL\n  Expected the guard to appear exactly once in ${c.file}, found ${hits}.` +
        `\n  Either the guard was removed or renamed, or this control needs updating. Both are worth stopping for.`
    )
    failures += 1
    continue
  }

  process.stdout.write(`${c.name}: `)
  try {
    write(c.file, original.replace(c.find, c.replace))
    if (suitePasses()) {
      console.log('NOT CAUGHT')
      console.error(`  Removing this guard left the suite green.`)
      console.error(`  Without it: ${c.breaks}`)
      console.error(`  Expected to be caught by: ${c.caughtBy}`)
      failures += 1
    } else {
      console.log('caught')
    }
  } finally {
    // Restore unconditionally. A crashed run must never leave a guard deleted on disk.
    write(c.file, original)
  }
}

if (failures > 0) {
  console.error(`\n${failures} control(s) were not caught. The suite does not prove what it claims.`)
  process.exit(1)
}
console.log(`\nAll ${CONTROLS.length} negative controls were caught.`)
