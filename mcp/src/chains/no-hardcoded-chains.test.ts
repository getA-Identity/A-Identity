import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ARC_CHAIN } from './registry.js'

/**
 * The registry is only a single source of truth if nothing else restates what it knows.
 *
 * This guard exists because the audit that produced the registry found Arc's chain id,
 * RPC host, CAIP-2 id, USDC address and CCTP domain restated across erc8004.ts,
 * gateway.ts, nanopay.ts, x402.ts, trust-oracle.ts, treasury.ts, aa-wallet.ts and arc.ts.
 * Every one of those was a place a second chain would have had to be wired by hand, and a
 * place a value could drift without a test noticing. Removing them once is not enough:
 * the next hardcoded literal is one hurried commit away, so it fails the build instead.
 *
 * Comments are exempt: prose may name a chain id when explaining something.
 */

/** Compiled to dist/chains/, so mcp/src is two levels up. */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/**
 * Deliberate exceptions, each with the reason it is allowed. An entry here is a decision
 * on the record, not an oversight, which is the point of listing them rather than
 * loosening the pattern.
 */
const ALLOWED: Record<string, string> = {
  'server.ts': 'example agent id inside a user-facing tool description',
  'aa-wallet.ts':
    'AA_RPCS deliberately EXCLUDES Arc\'s primary RPC: Kernel getSenderAddress needs eth_call revert data in viem\'s shape and the primary does not provide it, so this list is a hand-picked subset, not the registry order',
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = dir + entry
    if (statSync(full).isDirectory()) {
      // The registry and its own tests are where these values legitimately live.
      if (entry === 'chains') continue
      out.push(...tsFiles(full + '/'))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Strip block comments and line comments so only real code is inspected. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: new RegExp(String(ARC_CHAIN.evmChainId), 'g'), what: `Arc's numeric chain id (${ARC_CHAIN.evmChainId})` },
  { pattern: /rpc(\.[a-z]+)?\.testnet\.arc\.network/g, what: "an Arc RPC host" },
  { pattern: /testnet\.arcscan\.app/g, what: "Arc's explorer host" },
  { pattern: /0x3600000000000000000000000000000000000000/g, what: "Arc's USDC address" },
]

test('no module outside chains/ hardcodes an Arc chain constant', () => {
  const violations: string[] = []

  for (const file of tsFiles(SRC)) {
    const name = file.slice(SRC.length)
    const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
    if (ALLOWED[base]) continue
    const code = codeOnly(readFileSync(file, 'utf8'))
    for (const { pattern, what } of FORBIDDEN) {
      pattern.lastIndex = 0
      if (pattern.test(code)) {
        violations.push(`${name} hardcodes ${what}`)
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Read these from the chain registry instead (ARC_CHAIN / getChain), so a second chain is a descriptor rather than an edit here:\n  ${violations.join('\n  ')}`,
  )
})

test('the allowlist only names files that still exist', () => {
  // A stale exception is worse than none: it silently exempts a file that may have been
  // rewritten since the exception was justified.
  const present = new Set(tsFiles(SRC).map((f) => f.slice(f.lastIndexOf('/') + 1)))
  for (const base of Object.keys(ALLOWED)) {
    assert.ok(present.has(base), `allowlist names ${base}, which no longer exists`)
  }
})
