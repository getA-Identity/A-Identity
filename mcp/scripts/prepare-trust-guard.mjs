#!/usr/bin/env node
/**
 * Build trust-guard for the mcp tests that load it: the contract test of the hosted route against
 * the SDK, and the test that spawns scripts/arc-vtp-runner.mjs. Both have to run the code in this
 * checkout, so a stale or missing build is not an option. Installs its own dependencies only when
 * a fresh checkout has none. Nothing is published.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../trust-guard')

function run(args) {
  const r = spawnSync('npm', args, { cwd: dir, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`npm ${args.join(' ')} failed in ${dir}`)
    process.exit(r.status ?? 1)
  }
}

if (!existsSync(join(dir, 'node_modules'))) run(['ci'])
run(['run', 'build'])
