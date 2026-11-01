import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAINS } from './chains/registry.js'

/**
 * The Arc vault page's rules, run from src/ as they ship (/app/vault/arc deploys and runs vaults
 * that hold real USDC on Arc Mainnet, signed in the owner's own wallet).
 *
 * src/lib/arc/vault-rules.ts and the generated src/lib/contracts/agent-spend-policy.ts have no
 * runtime imports, so Node's type stripping loads them straight from the repository, the same
 * way frontend-stellar.test.ts loads kit.ts. What they RETURN is the guard: a source search
 * cannot tell that a 0 cap is refused or that a fee never drops under Arc's floor.
 */

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repoPath = (rel: string) => fileURLToPath(repoUrl(rel))
const repo = (rel: string) => readFileSync(repoPath(rel), 'utf8')

type Snapshot = Record<string, unknown>
type Rules = {
  ZERO_ADDRESS: string
  FEE_FLOOR_WEI: bigint
  TIP_CAP_WEI: bigint
  REVOKED_SESSION_EXPIRY: bigint
  MIN_SESSION_SECONDS: number
  MAX_SESSION_SECONDS: number
  DEFAULT_DAILY_CAP: string
  DEFAULT_AUTO_APPROVE: string
  parseUnitsExact: (text: string, decimals: number) => bigint | null
  formatUnitsExact: (raw: bigint, decimals: number) => string
  weiToUnitsCeil: (wei: bigint, nativeDecimals: number, tokenDecimals: number) => bigint
  capsRefusal: (dailyCap: bigint | null, autoApproveMax: bigint | null, decimals: number) => string | null
  sessionSecondsRefusal: (seconds: number) => string | null
  sessionExpiryFor: (chainNow: bigint, seconds: number) => bigint | null
  expiryRefusal: (expiry: bigint) => string | null
  feeFields: (base: bigint | null, tip: bigint | null) => { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  gasWithMargin: (estimate: bigint) => bigint
  operatorRefusal: (operator: string, ctx: { owner: string | null; usdc: string; vault?: string | null }) => string | null
  withdrawRefusal: (input: { to: string; amount: bigint | null; balance: bigint; vault: string; usdc: string; decimals: number }) => string | null
  fundRefusal: (input: { amount: bigint | null; senderBalance: bigint; gasReserve: bigint; decimals: number }) => string | null
  maskImmutables: (code: string, ranges: readonly { start: number; length: number }[]) => string | null
  isKnownBuild: (code: string, runtime: string, ranges: readonly { start: number; length: number }[]) => boolean
  vaultHeadline: (v: Snapshot) => { text: string; tone: 'ok' | 'warn' | 'danger' }
}
type VaultModule = {
  AGENT_SPEND_POLICY_RUNTIME: string
  AGENT_SPEND_POLICY_BYTECODE: string
  AGENT_SPEND_POLICY_IMMUTABLES: readonly { start: number; length: number }[]
}

const rules = async () => (await import(repoUrl('src/lib/arc/vault-rules.ts').href)) as Rules
const vaultModule = async () => (await import(repoUrl('src/lib/contracts/agent-spend-policy.ts').href)) as VaultModule

// The registry's own Arc Mainnet USDC, never a literal here either.
const ARC_MAINNET = CHAINS.find((c) => c.id === 'arc-mainnet')
const USDC = ARC_MAINNET?.contracts.usdc ?? ''
const OWNER = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'
const OPERATOR = '0x2222222222222222222222222222222222222222'
const VAULT = '0x3333333333333333333333333333333333333333'

test('a 0 daily cap or per-payment ceiling is refused, because 0 means no limit in the contract', async () => {
  const r = await rules()
  assert.ok(USDC, 'the registry lists no Arc Mainnet USDC')
  assert.match(r.capsRefusal(0n, 250000n, 6) ?? '', /NO LIMIT/)
  assert.match(r.capsRefusal(1000000n, 0n, 6) ?? '', /per-payment ceiling/)
  assert.match(r.capsRefusal(0n, 0n, 6) ?? '', /daily cap and a per-payment ceiling/)
  assert.ok(r.capsRefusal(null, 1n, 6), 'an unparseable amount is refused, not read as 0')
  assert.equal(r.capsRefusal(1n, 1n, 6), null)
  // The dust defaults themselves pass, and are what the mainnet script uses.
  assert.equal(r.capsRefusal(r.parseUnitsExact(r.DEFAULT_DAILY_CAP, 6), r.parseUnitsExact(r.DEFAULT_AUTO_APPROVE, 6), 6), null)
  assert.equal(r.parseUnitsExact(r.DEFAULT_DAILY_CAP, 6), 1000000n)
  assert.equal(r.parseUnitsExact(r.DEFAULT_AUTO_APPROVE, 6), 250000n)
})

test('amounts are exact base units, never a float, and refuse more decimals than the token has', async () => {
  const r = await rules()
  assert.equal(r.parseUnitsExact('0.1', 6), 100000n)
  assert.equal(r.parseUnitsExact('1.000001', 6), 1000001n)
  assert.equal(r.parseUnitsExact(' 25 ', 6), 25000000n)
  assert.equal(r.parseUnitsExact('0.0000001', 6), null, 'a seventh decimal is refused, not rounded')
  for (const bad of ['', '-1', '1e6', '0x10', '1,5', '.5', 'abc']) assert.equal(r.parseUnitsExact(bad, 6), null, `"${bad}" parsed`)
  assert.equal(r.formatUnitsExact(1500000n, 6), '1.5')
  assert.equal(r.formatUnitsExact(10000n, 6), '0.01')
  assert.equal(r.formatUnitsExact(594000000000000n, 18), '0.000594')
  // One balance, two scales on Arc: 18-decimal native wei into 6-decimal units, rounded UP.
  assert.equal(r.weiToUnitsCeil(1n, 18, 6), 1n)
  assert.equal(r.weiToUnitsCeil(1_000_000_000_000n, 18, 6), 1n)
  assert.equal(r.weiToUnitsCeil(1_000_000_000_001n, 18, 6), 2n)
})

test('a session key expiry is chain time plus a bounded lifetime, and 0 is never written', async () => {
  const r = await rules()
  const chainNow = 1_793_536_086n
  assert.equal(r.sessionExpiryFor(chainNow, 7 * 86400), chainNow + 604800n)
  assert.equal(r.sessionExpiryFor(chainNow, r.MIN_SESSION_SECONDS - 1), null, 'under an hour')
  assert.equal(r.sessionExpiryFor(chainNow, r.MAX_SESSION_SECONDS + 1), null, 'over 30 days')
  assert.equal(r.sessionExpiryFor(0n, 3600), null, 'no chain time, no expiry: the browser clock is never used instead')
  assert.equal(r.sessionExpiryFor(chainNow, 3600.5), null)
  assert.ok(r.sessionSecondsRefusal(0))
  // Revoke writes 1: a second already past everywhere. 0 would mean no time bound at all.
  assert.equal(r.REVOKED_SESSION_EXPIRY, 1n)
  assert.equal(r.expiryRefusal(r.REVOKED_SESSION_EXPIRY), null)
  assert.match(r.expiryRefusal(0n) ?? '', /never expires/)
  assert.ok(r.expiryRefusal(-1n))
})

test('no fee under the 20 gwei floor is ever proposed, and an RPC cannot inflate the tip', async () => {
  const r = await rules()
  assert.equal(r.FEE_FLOOR_WEI, 20_000_000_000n)
  const quiet = r.feeFields(null, null)
  assert.equal(quiet.maxFeePerGas, r.FEE_FLOOR_WEI)
  assert.equal(quiet.maxPriorityFeePerGas, 0n)
  // Base at the floor: twice the base plus the tip, as Arc's docs suggest.
  const normal = r.feeFields(20_000_000_000n, 2_300_000n)
  assert.equal(normal.maxFeePerGas, 40_002_300_000n)
  assert.equal(normal.maxPriorityFeePerGas, 2_300_000n)
  // A tiny base still floors at 20 gwei; a huge tip suggestion is capped at 1 gwei.
  assert.equal(r.feeFields(1n, 0n).maxFeePerGas, r.FEE_FLOOR_WEI)
  const greedy = r.feeFields(20_000_000_000n, 500_000_000_000n)
  assert.equal(greedy.maxPriorityFeePerGas, r.TIP_CAP_WEI)
  assert.equal(greedy.maxFeePerGas, 41_000_000_000n)
  for (const [b, t] of [[0n, 0n], [7n, 3n], [null, 5n], [-5n, -5n]] as const) {
    const f = r.feeFields(b, t)
    assert.ok(f.maxFeePerGas >= r.FEE_FLOOR_WEI, `fee under the floor for base ${b}, tip ${t}`)
    assert.ok(f.maxPriorityFeePerGas <= f.maxFeePerGas)
  }
  assert.equal(r.gasWithMargin(965849n), 1159019n)
})

test('the operator is a separate key: never the owner, the zero address, the vault or the token', async () => {
  const r = await rules()
  const ctx = { owner: OWNER, usdc: USDC, vault: VAULT }
  assert.equal(r.operatorRefusal(OPERATOR, ctx), null)
  assert.match(r.operatorRefusal(OWNER, ctx) ?? '', /different key from the owner/)
  assert.match(r.operatorRefusal(`0x${OWNER.slice(2).toUpperCase()}`, ctx) ?? '', /different key/, 'case must not hide the owner')
  assert.match(r.operatorRefusal(r.ZERO_ADDRESS, ctx) ?? '', /zero address/)
  assert.match(r.operatorRefusal(USDC, ctx) ?? '', /USDC contract/)
  assert.match(r.operatorRefusal(VAULT, ctx) ?? '', /vault itself/)
  assert.ok(r.operatorRefusal('', ctx), 'an empty operator is refused: nothing is preset')
  assert.ok(r.operatorRefusal('0x1234', ctx))
})

test('a withdrawal to zero, the vault or the token, or above the balance, is refused', async () => {
  const r = await rules()
  const base = { balance: 500000n, vault: VAULT, usdc: USDC, decimals: 6 }
  assert.equal(r.withdrawRefusal({ ...base, to: OWNER, amount: 500000n }), null)
  assert.match(r.withdrawRefusal({ ...base, to: OWNER, amount: 500001n }) ?? '', /holds 0\.5 USDC/)
  assert.ok(r.withdrawRefusal({ ...base, to: OWNER, amount: 0n }))
  assert.ok(r.withdrawRefusal({ ...base, to: OWNER, amount: null }))
  assert.match(r.withdrawRefusal({ ...base, to: r.ZERO_ADDRESS, amount: 1n }) ?? '', /zero address/)
  assert.match(r.withdrawRefusal({ ...base, to: VAULT, amount: 1n }) ?? '', /vault itself/)
  assert.match(r.withdrawRefusal({ ...base, to: USDC, amount: 1n }) ?? '', /USDC contract/)
})

test('funding keeps enough USDC behind for the network fee, which on Arc is USDC too', async () => {
  const r = await rules()
  assert.equal(r.fundRefusal({ amount: 400000n, senderBalance: 500000n, gasReserve: 100000n, decimals: 6 }), null)
  assert.match(r.fundRefusal({ amount: 450000n, senderBalance: 500000n, gasReserve: 100000n, decimals: 6 }) ?? '', /send 0\.4 or less/)
  assert.ok(r.fundRefusal({ amount: 0n, senderBalance: 500000n, gasReserve: 0n, decimals: 6 }))
})

test('a vault is recognized as this build by its runtime with the immutables zeroed, and by nothing else', async () => {
  const r = await rules()
  const m = await vaultModule()
  const runtime = m.AGENT_SPEND_POLICY_RUNTIME
  assert.ok(m.AGENT_SPEND_POLICY_BYTECODE.slice(2).includes(runtime.slice(2)), 'the runtime is not inside the creation code')
  assert.ok(r.isKnownBuild(runtime, runtime, m.AGENT_SPEND_POLICY_IMMUTABLES))
  // A deployed copy carries the owner and the token in its immutable slots: still this build.
  let deployed = runtime.slice(2)
  for (const range of m.AGENT_SPEND_POLICY_IMMUTABLES) {
    const filled = OWNER.slice(2).padStart(range.length * 2, '0')
    deployed = deployed.slice(0, range.start * 2) + filled + deployed.slice((range.start + range.length) * 2)
  }
  assert.ok(r.isKnownBuild(`0x${deployed}`, runtime, m.AGENT_SPEND_POLICY_IMMUTABLES))
  // One byte changed outside those slots is another build; so is code that is too short.
  const flipAt = 10
  const flipped = deployed.slice(0, flipAt * 2) + (deployed.slice(flipAt * 2, flipAt * 2 + 2) === 'ff' ? '00' : 'ff') + deployed.slice(flipAt * 2 + 2)
  assert.equal(r.isKnownBuild(`0x${flipped}`, runtime, m.AGENT_SPEND_POLICY_IMMUTABLES), false)
  assert.equal(r.isKnownBuild(runtime.slice(0, 100), runtime, m.AGENT_SPEND_POLICY_IMMUTABLES), false)
  assert.equal(r.maskImmutables('0xabc', m.AGENT_SPEND_POLICY_IMMUTABLES), null)
})

test('the headline names a missing time bound before balance or headroom', async () => {
  const r = await rules()
  const v = {
    frozen: false,
    operator: OPERATOR,
    sessionKeyExpiry: 0n,
    expired: false,
    balance: 1000000n,
    remainingToday: 1000000n,
    decimals: 6,
  }
  assert.equal(r.vaultHeadline(v).tone, 'danger')
  assert.match(r.vaultHeadline(v).text, /NO time bound/)
  assert.match(r.vaultHeadline({ ...v, frozen: true }).text, /^Frozen/)
  assert.match(r.vaultHeadline({ ...v, sessionKeyExpiry: 1n, expired: true }).text, /expired/)
  assert.equal(r.vaultHeadline({ ...v, sessionKeyExpiry: 1_900_000_000n }).tone, 'ok')
  assert.match(r.vaultHeadline({ ...v, sessionKeyExpiry: 1_900_000_000n, balance: 0n }).text, /holds no USDC/)
})

/** Every Arc vault page source file, from the repository root. */
function arcPageFiles(): string[] {
  const out: string[] = ['src/routes/app/ArcVault.tsx']
  for (const dir of ['src/lib/arc', 'src/components/app/arc']) {
    for (const name of readdirSync(repoPath(dir))) {
      const rel = `${dir}/${name}`
      if (statSync(repoPath(rel)).isFile() && /\.tsx?$/.test(name)) out.push(rel)
    }
  }
  return out
}

/** Code only: prose in comments may name a chain, code may not. */
const codeOnly = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

test('the Arc vault page takes every chain fact from the generated registry module, and types no address', () => {
  // The backend guard (chains/no-hardcoded-chains.test.ts) does not reach src/, so this page,
  // which moves real money from the browser, carries its own: a chain id, an RPC or explorer
  // host, or a token address typed here could point a deploy or a transfer somewhere else.
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const host = (u: string) => {
    try {
      return new URL(u).host
    } catch {
      return ''
    }
  }
  const forbidden: { pattern: RegExp; what: string }[] = [
    { pattern: /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, what: 'a typed 40-hex address' },
  ]
  for (const c of CHAINS) {
    if (c.evmChainId) forbidden.push({ pattern: new RegExp(`(?<![\\w.])${c.evmChainId}(?![\\w.])`, 'g'), what: `${c.id}'s chain id` })
    for (const u of c.rpcUrls) if (host(u)) forbidden.push({ pattern: new RegExp(esc(host(u)), 'g'), what: `${c.id}'s RPC host` })
    if (c.explorer && host(c.explorer)) forbidden.push({ pattern: new RegExp(esc(host(c.explorer)), 'g'), what: `${c.id}'s explorer host` })
  }
  const files = arcPageFiles()
  assert.ok(files.length >= 10, `expected the page's lib and component files, found ${files.length}`)
  const violations: string[] = []
  for (const rel of files) {
    // The single exception, named: the zero address is a constant of the EVM, not of any chain.
    const code = codeOnly(repo(rel)).replace(/0x0{40}(?![0-9a-fA-F])/g, 'ZERO_ADDRESS')
    for (const { pattern, what } of forbidden) {
      pattern.lastIndex = 0
      if (pattern.test(code)) violations.push(`${rel} types ${what}`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Read these from src/lib/chains.ts (CHAIN_BY_ID, CHAIN_RPC_URLS, CHAIN_USDC) or from the backend's lists instead:\n  ${violations.join('\n  ')}`,
  )
})

test('every write is checked against the chain right before it is sent, and no operator is preset', () => {
  const write = codeOnly(repo('src/lib/arc/vault-write.ts'))
  const send = write.slice(write.indexOf('export async function sendPrepared'))
  assert.ok(send.length > 0, 'sendPrepared is gone')
  const order = ['FEE_FLOOR_WEI', 'ensureEvmChain', "'eth_chainId'", "'eth_accounts'", "'eth_sendTransaction'"].map((s) => send.indexOf(s))
  assert.ok(order.every((i) => i >= 0), `sendPrepared lost a step: ${order}`)
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the fee floor, the switch, then the chain and account reads must come before eth_sendTransaction')
  assert.match(write, /REVOKED_SESSION_EXPIRY/, 'a revoke must write the named past second, not a literal')
  // The operator field starts empty in both places it is typed: which key the agent uses is the owner's decision.
  for (const rel of ['src/components/app/arc/DeployFlow.tsx', 'src/components/app/arc/OwnerControls.tsx']) {
    assert.match(repo(rel), /const \[operator, setOperator\] = useState\(''\)/, `${rel} presets an operator`)
  }
})
