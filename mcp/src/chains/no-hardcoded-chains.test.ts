import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ARC_CHAIN, CHAINS } from './registry.js'

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
 *
 * The second group arrived when the forbidden list stopped being two hand-written chains
 * and started being generated from the registry: nine more chains came into scope at once,
 * and these are the files that were already carrying their constants.
 */
const ALLOWED: Record<string, string> = {
  'server.ts': 'example agent id inside a user-facing tool description',
  'aa-wallet.ts':
    'AA_RPCS deliberately EXCLUDES Arc\'s primary RPC: Kernel getSenderAddress needs eth_call revert data in viem\'s shape and the primary does not provide it, so this list is a hand-picked subset, not the registry order',

  // The ASP is a separate deployable whose OKX.AI listings (#6271, #8913) are registered
  // against this exact surface, and CLAUDE.md says a re-registration resets the review
  // clock. Deriving these from the registry would not change a single published byte, so
  // the reason to leave them is process rather than correctness: not worth the review
  // clock on its own. Revisit the day the ASP is redeployed for another reason.
  'payment.ts': 'frozen OKX ASP surface: X Layer is what the registered listings settle on',
  'proof.ts': 'frozen OKX ASP surface: published proof copy names the network in prose',
  'stats.ts': 'frozen OKX ASP surface: reads the payout balance off X Layer directly',
  'tools.ts': 'frozen OKX ASP surface',

  // Celo arrived through the first-party facilitator rather than the generic adapter, so
  // its constants live with the rail that uses them. Worth folding into the registry the
  // next time that rail is touched; not worth a payment-path change on its own.
  'celo-x402.ts': 'first-party Celo rail, wired before the generic adapter covered it',
  'gateway.ts': 'Circle Gateway mints on Base Sepolia specifically; the explorer link is about that demo hop, not a chain we settle on',
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

/**
 * Every chain's constants, generated FROM the registry rather than hand-listed.
 *
 * The list below used to name Arc and Robinhood Chain only, so nine of the eleven chains
 * were unguarded and CLAUDE.md's "no file may hardcode a chain constant" was true of two
 * elevenths of the registry. Generating it means a chain added tomorrow is guarded the day
 * it lands, with nobody having to remember to extend a literal.
 *
 * CAIP-2 ids are deliberately NOT banned. A CAIP-2 is a stable public identifier that
 * legitimately appears in prose, in published proof copy and in tool documentation, and
 * banning it would produce noise that gets exempted until the guard means nothing. What is
 * dangerous to duplicate is a value that can be WRONG and silently point money somewhere:
 * a numeric chain id, an RPC or explorer host, a token address. Those are what this catches.
 */
function fromRegistry(): { pattern: RegExp; what: string }[] {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const host = (u: string) => {
    try { return new URL(u).host } catch { return '' }
  }
  const out: { pattern: RegExp; what: string }[] = []
  for (const c of CHAINS) {
    if (c.evmChainId) {
      out.push({ pattern: new RegExp(`(?<![\\w.])${c.evmChainId}(?![\\w.])`, 'g'), what: `${c.id}'s numeric chain id` })
    }
    for (const u of c.rpcUrls ?? []) {
      const h = host(u)
      if (h) out.push({ pattern: new RegExp(esc(h), 'g'), what: `${c.id}'s RPC host` })
    }
    const eh = c.explorer ? host(c.explorer) : ''
    if (eh) out.push({ pattern: new RegExp(esc(eh), 'g'), what: `${c.id}'s explorer host` })
    for (const t of c.settlementTokens ?? []) {
      out.push({ pattern: new RegExp(esc(t.address), 'gi'), what: `${c.id}'s settlement token address` })
    }
    if (c.contracts.usdc) {
      out.push({ pattern: new RegExp(esc(c.contracts.usdc), 'gi'), what: `${c.id}'s USDC address` })
    }
  }
  return out
}

const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  ...fromRegistry(),
  { pattern: new RegExp(String(ARC_CHAIN.evmChainId), 'g'), what: `Arc's numeric chain id (${ARC_CHAIN.evmChainId})` },
  { pattern: /rpc(\.[a-z]+)?\.testnet\.arc\.network/g, what: "an Arc RPC host" },
  { pattern: /testnet\.arcscan\.app/g, what: "Arc's explorer host" },
  { pattern: /0x3600000000000000000000000000000000000000/g, what: "Arc's USDC address" },
  // Robinhood Chain arrived with a settlement rail, which is the moment a second chain's
  // constants start leaking into payment code. The word boundaries matter: 46630 contains
  // 4663, so a naive pattern would report the testnet id as a mainnet violation.
  { pattern: /(?<![\w.])4663(?![\w.])/g, what: "Robinhood Chain's numeric chain id" },
  { pattern: /(?<![\w.])46630(?![\w.])/g, what: "Robinhood Chain Testnet's numeric chain id" },
  { pattern: /(rpc|explorer)\.(mainnet|testnet)\.chain\.robinhood\.com/g, what: 'a Robinhood Chain RPC or explorer host' },
  { pattern: /robinhoodchain\.blockscout\.com/g, what: "Robinhood Chain's explorer host" },
  { pattern: /0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168/gi, what: "the USDG token address" },
  { pattern: /0x71c6e1c209A4e3d4bd9911B2d53c98023A56C32F/gi, what: "the bridged USDC.e token address" },
]

test('no module outside chains/ hardcodes any chain constant from the registry', () => {
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
