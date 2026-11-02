import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAINS } from './chains/registry.js'
import { PROVENANCE } from './chains/provenance.js'
import { arcLedgerFacts } from './chains/frontend-ledger.js'
import { PAGE_MAX_SESSION_SECONDS } from './arc-owner-vault.js'

/**
 * The Arc vault page's rules, run from src/ as they ship (/app/vault/arc deploys and runs vaults
 * that hold real USDC on Arc Mainnet, signed in the owner's own wallet).
 *
 * These src/ modules have no runtime imports but each other, named with their .ts extension, so
 * Node's type stripping loads them straight from the repository, the same way
 * frontend-stellar.test.ts loads kit.ts: vault-rules.ts (the page's rules), tx-rules.ts (what a
 * receipt, a nonce or a read-back means, and where a setup stands), send.ts with evm-chain.ts
 * (the hand-off to the wallet), the generated contract module and the generated chains module.
 * What they RETURN, and what a fake wallet is asked to do, is the guard: a source search cannot
 * tell that a 0 cap is refused, that a fee never drops under Arc's floor, or that a wrong chain
 * id sends nothing.
 */

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repoPath = (rel: string) => fileURLToPath(repoUrl(rel))
const repo = (rel: string) => readFileSync(repoPath(rel), 'utf8')

type Snapshot = Record<string, unknown>
type Ranges = Readonly<Record<string, readonly { start: number; length: number }[]>>
type Rules = {
  ZERO_ADDRESS: string
  FEE_FLOOR_WEI: bigint
  TIP_CAP_WEI: bigint
  REVOKED_SESSION_EXPIRY: bigint
  MIN_SESSION_SECONDS: number
  MAX_SESSION_SECONDS: number
  DEFAULT_DAILY_CAP: string
  DEFAULT_AUTO_APPROVE: string
  OWNER_ACTION_GAS: bigint
  parseUnitsExact: (text: string, decimals: number) => bigint | null
  formatUnitsExact: (raw: bigint, decimals: number) => string
  weiToUnitsCeil: (wei: bigint, nativeDecimals: number, tokenDecimals: number) => bigint
  weiToUnitsFloor: (wei: bigint, nativeDecimals: number, tokenDecimals: number) => bigint
  capsRefusal: (dailyCap: bigint | null, autoApproveMax: bigint | null, decimals: number) => string | null
  sessionSecondsRefusal: (seconds: number) => string | null
  sessionExpiryFor: (chainNow: bigint, seconds: number) => bigint | null
  expiryRefusal: (expiry: bigint) => string | null
  feeFields: (base: bigint | null, tip: bigint | null) => { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  gasWithMargin: (estimate: bigint) => bigint
  operatorRefusal: (operator: string, ctx: { owner: string | null; usdc: string; vault?: string | null }) => string | null
  withdrawRefusal: (input: { to: string; amount: bigint | null; balance: bigint; vault: string; usdc: string; decimals: number }) => string | null
  fundingReserveWei: (gas: bigint, maxFeePerGas: bigint) => bigint
  fundRefusal: (input: { amount: bigint | null; senderWei: bigint; gas: bigint; maxFeePerGas: bigint; nativeDecimals: number; decimals: number }) => string | null
  addressWord: (address: string) => string | null
  runtimeWith: (runtime: string, ranges: Ranges, values: Record<string, string>) => string | null
  isKnownBuild: (code: string, runtime: string, ranges: Ranges, values: Record<string, string>) => boolean
  vaultHeadline: (v: Snapshot) => { text: string; tone: 'ok' | 'warn' | 'danger'; state: string; canPay: boolean }
  readableDate: (unixSeconds: bigint) => Date | null
  relativeSeconds: (target: bigint, now: bigint) => string
  deployFormRefused: (networkParam: string | null, networkKnown: boolean, setupNetworkKnown: boolean) => boolean
}
type VaultModule = {
  AGENT_SPEND_POLICY_RUNTIME: string
  AGENT_SPEND_POLICY_BYTECODE: string
  AGENT_SPEND_POLICY_IMMUTABLES: { owner: readonly { start: number; length: number }[]; usdc: readonly { start: number; length: number }[] }
}
/** A TxRecord or SetupState as these tests build them: plain objects, checked by what the rules return. */
type Rec = Record<string, unknown>
type TxRules = {
  READ_BACK_TRIES: number
  REPLACED_AFTER_MS: number
  firstFound: <T>(asks: readonly Promise<T>[], isNotFound: (e: unknown) => boolean) => Promise<{ found: boolean; value?: T; index?: number; answered: number; total: number }>
  missingFrom: (logs: readonly Rec[], expect: readonly Rec[]) => string[]
  decideLanded: (record: Rec, rc: Rec, x: Rec) => Rec
  decideUnseen: (record: Rec, f: Rec) => Rec
  untracked: (r: Rec) => Rec
  retracked: (r: Rec) => Rec
  setupStep: (s: Rec | null, prepared: boolean, snapshot: Rec | null) => string
  fundingLanded: (r: Rec | undefined) => boolean
  fundingUnresolved: (r: Rec | undefined) => boolean
  withRecord: (s: Rec, field: string, r: Rec) => Rec
  predictedVault: (s: Rec) => string | null
  setupAlert: (s: Rec | null, snapshot: Rec | null) => string | null
  createdContract: (s: Rec | null) => string | null
  deployEnd: (s: Rec | null) => { kind: string; address?: string } | null
  vaultToLookFor: (s: Rec | null) => { predicted: string; deployArgs: Rec } | null
  UNSEEN_AFTER_MS: number
  UNSEEN_NOTE: string
  guessedNonce: (r: Rec) => number | undefined
  walletRepriced: (r: Rec) => boolean
  liveOf: (s: Rec, snapshot: Rec | null) => Rec | null
  setupDrift: (shown: Rec | null, held: Rec | null, snapshot: Rec | null) => string | null
}
type Failure = { code: string; message: string }
type SendModule = {
  sendPrepared: (provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, p: Rec, onStep: (s: string) => void) => Promise<string>
  failureOf: (e: unknown) => Failure
}
type HostsModule = {
  NoHostAnswered: new (tried: string[], last: unknown) => Error & { tried: string[]; last: unknown }
  onHosts: <C, T>(
    hosts: readonly { host: string; client: C }[],
    x: { chainId: number; askChainId: (client: C) => Promise<number>; isFinal: (e: unknown) => boolean },
    fn: (client: C, host: string) => Promise<T>,
  ) => Promise<{ value: T; host: string }>
}
type ChainLike = { id: string; caip2: string; chainId: number | null; name: string; testnet: boolean }
type ChainsModule = { CHAIN_BY_ID: Record<string, ChainLike> }

const rules = async () => (await import(repoUrl('src/lib/arc/vault-rules.ts').href)) as Rules
const vaultModule = async () => (await import(repoUrl('src/lib/contracts/agent-spend-policy.ts').href)) as VaultModule
const txRules = async () => (await import(repoUrl('src/lib/arc/tx-rules.ts').href)) as TxRules
const sendModule = async () => (await import(repoUrl('src/lib/arc/send.ts').href)) as SendModule
const hostsModule = async () => (await import(repoUrl('src/lib/arc/hosts.ts').href)) as HostsModule
const chainsModule = async () => (await import(repoUrl('src/lib/chains.ts').href)) as ChainsModule

// The registry's own Arc Mainnet USDC, never a literal here either.
const ARC_MAINNET = CHAINS.find((c) => c.id === 'arc-mainnet')
const USDC = ARC_MAINNET?.contracts.usdc ?? ''
const OWNER = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'
const OPERATOR = '0x2222222222222222222222222222222222222222'
const VAULT = '0x3333333333333333333333333333333333333333'
const VICTIM = '0x1111111111111111111111111111111111111111'
const ATTACKER = '0x4444444444444444444444444444444444444444'
const HASH = `0x${'ab'.repeat(32)}`

/** Every Arc vault page source file, from the repository root. */
function arcPageFiles(): string[] {
  // evm-chain.ts is the send path's chain switch, so it is held to the same rule.
  const out: string[] = ['src/routes/app/ArcVault.tsx', 'src/lib/evm-chain.ts']
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

/** The body of `export async function name` in already comment-stripped code, up to its closing brace. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}`)
  assert.ok(start >= 0, `${name} is gone`)
  const end = code.indexOf('\n}\n', start)
  return code.slice(start, end < 0 ? undefined : end)
}

test('a host is asked its chain id once, and a host on another chain is a host that failed', async () => {
  const { onHosts, NoHostAnswered } = await hostsModule()
  type Fake = { name: string; chainId: number | Error; ran: number; asked: number; answer?: () => unknown }
  const fake = (name: string, chainId: number | Error, answer?: () => unknown): Fake => ({ name, chainId, ran: 0, asked: 0, answer })
  class Verdict extends Error {}
  const run = (hosts: Fake[]) =>
    onHosts(
      hosts.map((f) => ({ host: f.name, client: f })),
      {
        chainId: 5,
        askChainId: async (f) => {
          f.asked += 1
          if (f.chainId instanceof Error) throw f.chainId
          return f.chainId
        },
        isFinal: (e) => e instanceof Verdict,
      },
      async (f, host) => {
        f.ran += 1
        return f.answer ? f.answer() : `answer from ${host}`
      },
    )

  // The wrong chain never runs the call, and the next host answers.
  const wrong = fake('wrong', 7)
  const right = fake('right', 5)
  assert.deepEqual(await run([wrong, right]), { value: 'answer from right', host: 'right' })
  assert.equal(wrong.ran, 0, 'nothing is asked of a host on another chain')
  assert.deepEqual([wrong.asked, right.asked], [1, 1], 'once per host')

  // A host that cannot say which chain it is on, or fails the call, passes it on too.
  const silent = fake('silent', new Error('timeout'))
  const flaky = fake('flaky', 5, () => {
    throw new Error('502')
  })
  const last = fake('last', 5)
  assert.equal((await run([silent, flaky, last])).host, 'last')
  assert.deepEqual([silent.ran, flaky.ran, last.ran], [0, 1, 1])
  assert.equal(flaky.asked, 1)

  // A verdict stops at once: the next host would only give the same answer later.
  const after = fake('after', 5)
  const refused = fake('refused', 5, () => {
    throw new Verdict('reverted')
  })
  await assert.rejects(run([refused, after]), Verdict)
  assert.equal(after.asked, 0)

  // Every host on the wrong chain: nothing was read, and the failure names why.
  await assert.rejects(run([fake('a', 7), fake('b', 8)]), (e: unknown) => {
    assert.ok(e instanceof NoHostAnswered)
    assert.deepEqual(e.tried, ['a', 'b'])
    assert.match(String((e.last as Error).message), /b answered for chain 8, not 5/)
    return true
  })

  // Every path into the chain goes through it: the writes and readUsdcFacts use onFirstHost, and
  // onFirstHost is this loop.
  const read = codeOnly(repo('src/lib/arc/vault-read.ts'))
  assert.match(fnBody(read, 'onFirstHost'), /onHosts\(/)
  assert.match(fnBody(read, 'onFirstHost'), /askChainId: \(c\) => c\.getChainId\(\)/)
  assert.match(fnBody(read, 'readUsdcFacts'), /onFirstHost\(/)
  const write = codeOnly(repo('src/lib/arc/vault-write.ts'))
  for (const fn of ['prepareDeploy', 'prepareOwnerCall', 'prepareFund']) assert.match(fnBody(write, fn), /onFirstHost\(/, fn)
})

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
  // A balance is rounded DOWN into units, so it is never overstated.
  assert.equal(r.weiToUnitsFloor(1_999_999_999_999n, 18, 6), 1n)
  assert.equal(r.weiToUnitsFloor(999_999_999_999n, 18, 6), 0n)
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

test('funding keeps this fee and two later owner actions behind: the rule prepareFund applies, from the chain\'s own numbers', async () => {
  const r = await rules()
  // prepareFund hands fundRefusal the sender's native balance in wei and the transfer's gas and
  // fee cap; the reserve is this transfer plus a freeze and a withdrawal, so funding the whole
  // balance never leaves the owner unable to pay the gas to stop the agent.
  assert.equal(r.OWNER_ACTION_GAS, 80_000n)
  const gas = 60_000n
  const fee = r.FEE_FLOOR_WEI
  assert.equal(r.fundingReserveWei(gas, fee), (gas + 2n * r.OWNER_ACTION_GAS) * fee)
  const reserve = r.weiToUnitsCeil(r.fundingReserveWei(gas, fee), 18, 6)
  assert.equal(reserve, 4400n, '0.0044 USDC: 220000 gas at 20 gwei')
  const oneUsdc = { senderWei: 10n ** 18n, gas, maxFeePerGas: fee, nativeDecimals: 18, decimals: 6 }
  assert.equal(r.fundRefusal({ ...oneUsdc, amount: 1_000_000n - reserve }), null)
  assert.match(r.fundRefusal({ ...oneUsdc, amount: 1_000_000n - reserve + 1n }) ?? '', /send 0\.9956 or less/)
  assert.ok(r.fundRefusal({ ...oneUsdc, amount: 1_000_000n }), 'the whole balance is never funded')
  // The balance rounds down: wei short of one more unit buys nothing.
  assert.ok(r.fundRefusal({ ...oneUsdc, senderWei: 10n ** 18n + 999_999_999_999n, amount: 1_000_000n - reserve + 1n }))
  // The reserve rounds up: a fraction of a unit of fee still keeps a whole unit back.
  assert.equal(r.weiToUnitsCeil(r.fundingReserveWei(1n, 1n), 18, 6), 1n)
  assert.ok(r.fundRefusal({ ...oneUsdc, amount: 0n }))
  assert.ok(r.fundRefusal({ ...oneUsdc, amount: null }))
  // And it IS the rule prepareFund applies (wiring, read from the source).
  const fund = fnBody(codeOnly(repo('src/lib/arc/vault-write.ts')), 'prepareFund')
  assert.match(fund, /fundRefusal\(\{/, 'prepareFund no longer decides the reserve with fundRefusal')
  assert.match(fund, /senderWei: await c\.getBalance\(\{ address: sender \}\)/, 'prepareFund no longer hands fundRefusal the live balance')
  assert.match(fund, /if \(refusal\) throw stop\('insufficient_gas', refusal\)/, 'prepareFund computes the refusal and sends anyway')
  assert.doesNotMatch(fund, /assertCovered\(/, 'prepareFund went back to a second, different balance rule')
})

/** `runtime` with every range in `ranges` holding `address` as a 32-byte word. */
function writeWord(runtime: string, ranges: readonly { start: number; length: number }[], address: string): string {
  let hex = runtime.startsWith('0x') ? runtime.slice(2) : runtime
  for (const range of ranges) {
    const word = address.slice(2).toLowerCase().padStart(range.length * 2, '0')
    hex = hex.slice(0, range.start * 2) + word + hex.slice((range.start + range.length) * 2)
  }
  return `0x${hex}`
}

test('a vault is this build only with the owner and token it reports in every one of their slots', async () => {
  const r = await rules()
  const m = await vaultModule()
  const runtime = m.AGENT_SPEND_POLICY_RUNTIME
  const refs = m.AGENT_SPEND_POLICY_IMMUTABLES
  assert.ok(m.AGENT_SPEND_POLICY_BYTECODE.slice(2).includes(runtime.slice(2)), 'the runtime is not inside the creation code')
  const values = { owner: OWNER, usdc: USDC }
  // A deployed copy carries its owner in every owner slot and its token in every usdc slot.
  const deployed = writeWord(writeWord(runtime, refs.owner, OWNER), refs.usdc, USDC)
  assert.ok(r.isKnownBuild(deployed, runtime, refs, values))
  assert.equal(r.runtimeWith(runtime, refs, values), deployed.toLowerCase())
  assert.ok(r.isKnownBuild(deployed.toUpperCase().replace(/^0X/, '0x'), runtime, refs, values), 'hex case decides nothing')
  // Zeroed slots are not "any value": the bare runtime is not a vault owned by anyone.
  assert.equal(r.isKnownBuild(runtime, runtime, refs, values), false)
  // The owner written into the token's slots too (what the old masking check accepted) is refused.
  assert.equal(r.isKnownBuild(writeWord(runtime, [...refs.owner, ...refs.usdc], OWNER), runtime, refs, values), false)
  // The page's values must be the code's: another owner or token is another vault.
  assert.equal(r.isKnownBuild(deployed, runtime, refs, { owner: ATTACKER, usdc: USDC }), false)
  assert.equal(r.isKnownBuild(deployed, runtime, refs, { owner: OWNER, usdc: ATTACKER }), false)
  // Fail closed on the inputs: a missing, an extra or a malformed value proves nothing.
  assert.equal(r.isKnownBuild(deployed, runtime, refs, { owner: OWNER }), false)
  assert.equal(r.isKnownBuild(deployed, runtime, refs, { ...values, extra: OPERATOR }), false)
  assert.equal(r.isKnownBuild(deployed, runtime, refs, { owner: 'not an address', usdc: USDC }), false)
  // A dirty high byte in an address word is not the word the constructor writes.
  const start = refs.owner[0].start
  const dirty = `0x${deployed.slice(2, 2 + start * 2)}ff${deployed.slice(2 + start * 2 + 2)}`
  assert.equal(r.isKnownBuild(dirty, runtime, refs, values), false)
  // One byte changed outside those slots is another build; so is code that is too short.
  const flipAt = 10
  const body = deployed.slice(2)
  const flipped = body.slice(0, flipAt * 2) + (body.slice(flipAt * 2, flipAt * 2 + 2) === 'ff' ? '00' : 'ff') + body.slice(flipAt * 2 + 2)
  assert.equal(r.isKnownBuild(`0x${flipped}`, runtime, refs, values), false)
  assert.equal(r.isKnownBuild(deployed.slice(0, 100), runtime, refs, values), false)
  assert.equal(r.runtimeWith('0xabc', refs, values), null)
  assert.equal(r.addressWord(OWNER), `${'0'.repeat(24)}${OWNER.slice(2)}`)
})

test('a vault whose owner() reads one key while its owner checks obey another is not this build', async () => {
  // The review's crafted copy: the victim in the slot owner() reads, the attacker in every other
  // owner slot (the ones onlyOwner compares msg.sender with). Zeroing the slots and comparing the
  // rest passed it, and the page then told the victim "you are the owner" and offered Fund.
  const r = await rules()
  const m = await vaultModule()
  const runtime = m.AGENT_SPEND_POLICY_RUNTIME
  const refs = m.AGENT_SPEND_POLICY_IMMUTABLES
  assert.ok(refs.owner.length > 1)
  for (let i = 0; i < refs.owner.length; i++) {
    const split = writeWord(
      writeWord(writeWord(runtime, refs.owner.filter((_, j) => j !== i), ATTACKER), [refs.owner[i]], VICTIM),
      refs.usdc,
      USDC,
    )
    for (const owner of [VICTIM, ATTACKER])
      assert.equal(r.isKnownBuild(split, runtime, refs, { owner, usdc: USDC }), false, `owner split at slot ${refs.owner[i].start} passed as owned by ${owner}`)
  }
})

test('a vault whose token slots disagree is not this build, so balance() cannot read a token the page did not check', async () => {
  const r = await rules()
  const m = await vaultModule()
  const runtime = m.AGENT_SPEND_POLICY_RUNTIME
  const refs = m.AGENT_SPEND_POLICY_IMMUTABLES
  assert.ok(refs.usdc.length > 1)
  for (let i = 0; i < refs.usdc.length; i++) {
    const split = writeWord(
      writeWord(writeWord(runtime, refs.usdc.filter((_, j) => j !== i), ATTACKER), [refs.usdc[i]], USDC),
      refs.owner,
      OWNER,
    )
    for (const usdc of [USDC, ATTACKER])
      assert.equal(r.isKnownBuild(split, runtime, refs, { owner: OWNER, usdc }), false, `usdc split at slot ${refs.usdc[i].start} passed with token ${usdc}`)
  }
  // Every place the page decides "this build" passes the values the vault itself reported, or the
  // ones the deploy asked for (wiring, read from the source).
  for (const rel of ['src/lib/arc/vault-read.ts', 'src/lib/arc/vault-write.ts']) {
    const code = codeOnly(repo(rel))
    const calls = code.match(/isKnownBuild\(/g) ?? []
    const withValues = code.match(/isKnownBuild\([^;]*?\{ owner[^}]*usdc[^}]*\}\)/g) ?? []
    assert.ok(calls.length > 0, `${rel} no longer checks the build`)
    assert.equal(withValues.length, calls.length, `${rel} has an isKnownBuild call without the owner and usdc values`)
  }
  const write = codeOnly(repo('src/lib/arc/vault-write.ts'))
  for (const fn of ['prepareOwnerCall', 'prepareFund'])
    assert.match(fnBody(write, fn), /assertCodeStill\(c, v\)/, `${fn} no longer re-reads the vault's code before simulating`)
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
  assert.match(r.vaultHeadline({ ...v, sessionKeyExpiry: 1_700_000_000n, expired: true }).text, /expired/)
  assert.equal(r.vaultHeadline({ ...v, sessionKeyExpiry: 1_900_000_000n }).tone, 'ok')
  assert.match(r.vaultHeadline({ ...v, sessionKeyExpiry: 1_900_000_000n, balance: 0n }).text, /holds no USDC/)
})

test('every state of the vault says in one sentence what the agent can do, and the State chip reads the same answer', async () => {
  const r = await rules()
  const v = {
    frozen: false,
    operator: OPERATOR,
    sessionKeyExpiry: 1_900_000_000n,
    expired: false,
    allowlistEnabled: false,
    balance: 1_000_000n,
    remainingToday: 1_000_000n,
    decimals: 6,
  }
  const cannot: [string, Snapshot, RegExp][] = [
    ['frozen', { frozen: true }, /Frozen: the agent cannot pay/],
    ['no key', { operator: r.ZERO_ADDRESS }, /No agent key/],
    ['revoked', { sessionKeyExpiry: r.REVOKED_SESSION_EXPIRY, expired: true }, /^Revoked: .*cannot pay/],
    ['expired', { sessionKeyExpiry: 1_700_000_000n, expired: true }, /expired: it cannot pay/],
    ['empty', { balance: 0n }, /cannot pay anything right now: the vault holds no USDC/],
    ['no allowance left', { remainingToday: 0n }, /cannot pay anything more today/],
  ]
  for (const [what, over, said] of cannot) {
    const h = r.vaultHeadline({ ...v, ...over })
    assert.match(h.text, said, what)
    assert.equal(h.canPay, false, `${what}: says the agent can pay`)
    assert.notEqual(h.tone, 'ok', `${what}: green while the agent cannot pay`)
    assert.doesNotMatch(`${h.text} ${h.state}`, /\bActive\b/, `${what}: the word that used to contradict it`)
    assert.doesNotMatch(h.text, /can spend/, `${what}: says the agent can spend`)
  }
  // A revoked key is not called an expiry from 1970.
  assert.equal(r.vaultHeadline({ ...v, sessionKeyExpiry: r.REVOKED_SESSION_EXPIRY, expired: true }).state, 'Revoked')
  // The allowlist narrows what the agent can do, wherever the sentence says it can.
  const open = r.vaultHeadline(v)
  assert.equal(open.tone, 'ok')
  assert.equal(open.canPay, true)
  assert.equal(open.state, 'Can pay')
  assert.match(open.text, /can spend up to 1 USDC more today\.$/)
  assert.doesNotMatch(open.text, /allowlist/)
  for (const over of [{}, { balance: 500_000n }, { remainingToday: null }]) {
    assert.match(r.vaultHeadline({ ...v, ...over, allowlistEnabled: true }).text, /only to payees on its allowlist/)
  }
  // The chip reads the answer, and the ceiling line appears only when the agent can pay at all.
  const status = codeOnly(repo('src/components/app/arc/VaultStatus.tsx'))
  assert.match(status, /<Chip tone=\{h\.tone\}>\{h\.state\}<\/Chip>/)
  assert.doesNotMatch(status, /v\.frozen \? <Chip/, 'a chip decided by frozen alone can contradict the sentence')
  assert.match(status, /v\.autoApproveMax !== 0n && h\.canPay/)
  assert.match(status, /v\.sessionKeyExpiry === REVOKED_SESSION_EXPIRY/)
})

test('nothing a contract answers for a time can crash the page: it reads as unreadable, and a panel that still throws stays a panel', async () => {
  const r = await rules()
  const huge = 2n ** 255n
  // Every value a uint256 can reach gives a Date that formats, or no Date at all.
  for (const x of [huge, 2n ** 256n - 1n, 2n ** 53n, 8_640_000_000_001n]) assert.equal(r.readableDate(x), null, `${x}`)
  assert.equal(r.readableDate(8_640_000_000_000n)?.toISOString(), '+275760-09-13T00:00:00.000Z')
  assert.equal(r.readableDate(0n)?.toISOString(), '1970-01-01T00:00:00.000Z')
  assert.equal(r.relativeSeconds(huge, 1_900_000_000n), 'at a time too far off to read')
  assert.equal(r.relativeSeconds(1_900_003_600n, 1_900_000_000n), 'in 1h 0m')
  // What the agent can do is still answered, and an expiry no date can hold is no real bound.
  const h = r.vaultHeadline({ frozen: false, operator: OPERATOR, sessionKeyExpiry: huge, expired: false, balance: 1n, remainingToday: 1n, decimals: 6 })
  assert.equal(h.tone, 'danger')
  assert.match(h.text, /too far ahead to read as a date/)

  const status = codeOnly(repo('src/components/app/arc/VaultStatus.tsx'))
  assert.doesNotMatch(status, /new Date\(/, 'a date built from a contract value without the guard')
  assert.match(status, /const resets = readableDate\(v\.resetsAt\)/)
  assert.match(status, /\{resets \? \(\s*`[^`]*resets\.toISOString\(\)/, 'toISOString only behind the guard')
  assert.match(status, /Unreadable: this contract's today\(\) answered <Mono>\{v\.today\.toString\(\)\}<\/Mono>/)
  assert.match(status, /readableDate\(v\.sessionKeyExpiry\) === null \?/)
  const read = codeOnly(repo('src/lib/arc/vault-read.ts'))
  assert.match(read, /export function utcDateTime[^\n]*\s*const d = readableDate\(unixSeconds\)\s*if \(d === null\) return String\(unixSeconds\)/)
  // No Date is built from a contract's answer anywhere else on the page.
  for (const rel of arcPageFiles()) {
    if (rel === 'src/lib/arc/vault-rules.ts') continue
    assert.doesNotMatch(codeOnly(repo(rel)), /new Date\(Number\(/, `${rel} builds a Date from a number with no guard`)
  }
  // The net under all of it: one vault's panel, keyed so the next vault starts clean.
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /<VaultBoundary key=\{key\} what="This vault">\s*<section aria-label="Vault"/)
  assert.match(page, /<VaultBoundary what="The setup">\s*<DeployFlow/)
  assert.match(codeOnly(repo('src/components/app/arc/VaultBoundary.tsx')), /static getDerivedStateFromError/)
})

test('a deploy link naming a network we do not know opens no form, and real money is never its fallback', async () => {
  const r = await rules()
  for (const typo of ['arc-testnet', 'base', '', ' ']) assert.equal(r.deployFormRefused(typo, false, false), true, `"${typo}" reaches the form`)
  assert.equal(r.deployFormRefused(null, false, false), false, 'a link that names no network still gets the form and its select')
  assert.equal(r.deployFormRefused('arc', true, false), false)
  assert.equal(r.deployFormRefused('base', false, true), false, 'a setup under way keeps its own network')
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /const deployRefused = deployMode && deployFormRefused\(networkParam, Boolean\(chain\), Boolean\(setup && arcChainFor\(setup\.network\)\)\)/)
  // The refusal comes first, so DeployFlow is not reachable while it holds.
  assert.match(page, /\{deployRefused \? \(\s*<DeployLinkRefused networkParam=/)
  assert.ok(page.indexOf('<DeployLinkRefused networkParam=') < page.indexOf('<DeployFlow'))
  // By name, with a link to each network, and no second notice saying the same thing.
  const refused = page.slice(page.indexOf('function DeployLinkRefused'), page.indexOf('function FailureLine'))
  assert.match(refused, /"\{networkParam\}" is not an Arc network we know/)
  assert.match(refused, /ARC_CHAINS\.map[\s\S]*<Link to=\{\{ search: `\?network=\$\{encodeURIComponent\(c\.caip2\)\}&deploy=1` \}\}/)
  assert.match(page, /\{networkParam && !chain && !deployRefused && \(/)
})

test('our older build reads as what it is, from the ledger, and nobody else\'s unknown code gets that kindness', async () => {
  const ours = (await import(repoUrl('src/lib/arc/ours.ts').href)) as OursModule
  const mainnet = PROVENANCE.find((p) => p.chain === 'arc-mainnet')
  const entry = mainnet?.contracts.find((c) => c.name === 'AgentSpendPolicy vault')
  const net = ARC_MAINNET?.caip2 ?? ''
  const testnet = CHAINS.find((c) => c.id === 'arc')?.caip2 ?? ''
  assert.ok(entry && net && testnet)
  const line = ours.earlierBuildLine(net, entry.address)
  assert.ok(line, 'the launch vault has no ledger-backed line')
  assert.match(line, /earlier source \(commit c05b1710\)/)
  assert.match(line, /verified on Sourcify/)
  assert.doesNotMatch(line, /may not be the key/, 'the wording that alarmed every visitor')
  // The address and the network both matter, and the ledger alone can say it.
  assert.equal(ours.earlierBuildLine(net, VAULT), null)
  assert.equal(ours.earlierBuildLine(testnet, entry.address), null)
  // Read from the entry's own note, so a vault the ledger says neither thing of gets neither claim.
  const facts = (note?: string) => arcLedgerFacts([], [{ chain: 'arc-mainnet', contracts: [{ name: 'AgentSpendPolicy vault', address: VAULT, note }] } as never]).vaults[0]
  assert.deepEqual(facts(), { network: net, address: VAULT, name: 'AgentSpendPolicy vault' })
  assert.deepEqual(facts('a plain note'), { network: net, address: VAULT, name: 'AgentSpendPolicy vault' })
  assert.equal(facts('Built from the contract source at commit abcdef12, before.')?.builtFromCommit, 'abcdef12')
  assert.equal(facts('Built from the contract source at commit abcdef12, before.')?.sourcifyVerified, undefined)
  assert.equal(facts('its source is verified on Sourcify as an exact match')?.sourcifyVerified, true)
  // On the page: the amber wording stays for everyone else, and ours is reached only through `ours`.
  const status = codeOnly(repo('src/components/app/arc/VaultStatus.tsx'))
  assert.match(status, /const earlierBuild = ours \? earlierBuildLine\(v\.network, v\.address\) : null/)
  assert.match(status, /earlierBuild \? \(\s*<>\s*<Chip tone="muted">Earlier build of ours<\/Chip> \{earlierBuild\}/)
  assert.match(repo('src/components/app/arc/VaultStatus.tsx'), /<Chip tone="warn">Not this page's build<\/Chip>[\s\S]{0,300}may not be the key it obeys/)
})

test('a step that needs the wallet says why when there is none, and skipping needs no wallet', async () => {
  const copy = (await import(repoUrl('src/lib/arc/deploy-copy.ts').href)) as { WALLET_GONE: string; WRONG_ACCOUNT: string }
  assert.match(copy.WALLET_GONE, /not connected/)
  assert.match(copy.WALLET_GONE, /press Connect wallet/)
  assert.match(copy.WALLET_GONE, /Your setup is saved/)
  assert.match(copy.WRONG_ACCOUNT, /Pick the owner account/)
  const flow = codeOnly(repo('src/components/app/arc/DeployFlow.tsx'))
  // The Deploy button: no wallet is said, and the old silent return is gone.
  const confirm = flow.slice(flow.indexOf('const confirmDeploy'), flow.indexOf('const setExpiry'))
  assert.match(confirm, /if \(!provider \|\| !account\) \{\s*setInvalid\(WALLET_GONE\)\s*return/)
  assert.doesNotMatch(confirm, /\|\| !provider \|\| !account \|\| parsed\.c === null[^\n]*\) return\n/, 'a silent return when the wallet is gone')
  assert.match(confirm, /if \(!onUsdc\) \{\s*setInvalid/, 'another silent return')
  assert.match(flow, /\{walletGone && <WalletGap \/>\}/, 'said on the review before anyone presses')
  assert.match(flow, /onClick=\{confirmDeploy\} disabled=\{busy !== null \|\| ownerMismatch \|\| walletGone\}/, 'a button that can do nothing, with the reason beside it')
  assert.match(flow, /v === WALLET_GONE \? null : v/, 'the message outlives the wallet coming back')
  // Step 3: the reason, for no wallet and for the wrong account, and Skip outside the wallet condition.
  assert.match(flow, /\{step === 'fund' && \(walletGone \|\| ownerMismatch\) && <WalletGap wrongAccount=\{!walletGone\} \/>\}/)
  const skip = flow.indexOf("patch((s) => ({ ...s, fundSkipped: true }))")
  const opener = flow.lastIndexOf('{step ===', skip)
  assert.equal(flow.slice(opener, flow.indexOf('&&', opener)).trim(), "{step === 'fund'", 'Skip sits behind a wallet condition again')
})

test('an expiry or a funding is built only from the setup the browser holds now, and only if it is still what the owner reviewed', async () => {
  const t = await txRules()
  const X = '0x' + '77'.repeat(20)
  const Y = '0x' + '88'.repeat(20)
  const shown = setupOf({ vault: X })
  const read = snap({ address: X })
  assert.equal(t.setupDrift(shown, shown, read), null)
  assert.equal(t.setupDrift(shown, { ...shown, vault: X.toUpperCase().replace('0X', '0x') }, read), null, 'the same vault, whatever the case')
  assert.equal(t.setupDrift(shown, { ...shown, expiryTx: record() }, read), null, 'a later step of the same setup is not drift')
  // Forgotten in another tab, or never held.
  assert.match(String(t.setupDrift(shown, null, read)), /forgotten in another tab/)
  assert.match(String(t.setupDrift(null, shown, read)), /forgotten in another tab/)
  // Another setup started there: the finding's case, with this tab's read still of X.
  const other = setupOf({ vault: Y, startedAt: new Date(1000).toISOString() })
  assert.match(String(t.setupDrift(shown, other, read)), /changed in another tab/)
  for (const over of [{ vault: Y }, { network: 'eip155:1' }, { owner: ATTACKER }, { sessionSeconds: 3600 }, { funding: 1n }]) {
    assert.match(String(t.setupDrift(shown, { ...shown, ...over }, read)), /no longer matches what you reviewed/, JSON.stringify(Object.keys(over)))
  }
  // A read of some other vault, or none, is not a read of this one.
  assert.match(String(t.setupDrift(other, other, read)), /has not read this setup's vault/)
  assert.match(String(t.setupDrift(shown, shown, null)), /has not read/)
  assert.match(String(t.setupDrift(shown, shown, { ...read, network: 'eip155:1' })), /has not read/)
  assert.equal(t.liveOf(other, read), null)

  const raw = codeOnly(repo('src/components/app/arc/DeployFlow.tsx'))
  // Read from the slot, and asked before each write is prepared.
  assert.match(raw, /setupDrift\(setup, loadSetup\(\), snapshot\)\s*if \(drift\) \{\s*setInvalid\(drift\)/, 'said above the form, which catching up unmounts')
  const expiry = raw.slice(raw.indexOf('const setExpiry'), raw.indexOf('const forget'))
  assert.ok(expiry.indexOf('driftNow()') < expiry.indexOf('prepareOwnerCall'), 'the slot is read after the expiry is prepared')
  assert.match(expiry, /prepareOwnerCall[^\n]*\s*(?:\/\/[^\n]*\s*)?if \(driftNow\(\)\) return null\s*const hash = await sendPrepared/, 'not asked again before the wallet')
  assert.match(expiry, /prepareOwnerCall\(chain, vault,/)
  assert.doesNotMatch(expiry, /prepareOwnerCall\(chain, snapshot/)
  // The form gets only the live read of this setup's vault, the same question, and a fresh start per setup.
  assert.match(raw, /const liveVault = setup \? liveOf\(setup, snapshot\) : null/)
  assert.match(raw, /key=\{`\$\{setup\.startedAt\}:\$\{setup\.vault\}`\}\s*chain=\{chain\}\s*vault=\{liveVault\}/)
  assert.match(raw, /stillCurrent=\{\(\) => !driftNow\(\)\}/)
  assert.doesNotMatch(raw, /vault=\{snapshot\}/)
  assert.match(raw, /useEffect\(\(\) => \{\s*setSnapshot\(null\)[\s\S]{0,120}\}, \[startedAt\]\)/, 'a read of the last setup survives into the next')
  const fund = codeOnly(repo('src/components/app/arc/FundForm.tsx'))
  assert.ok(fund.indexOf('!stillCurrent()') < fund.indexOf('await prepareFund'), 'funding is prepared before the slot is read')
  assert.equal([...fund.matchAll(/stillCurrent && !stillCurrent\(\)/g)].length, 2, 'asked before the review and again before the wallet')
})

test('a transaction nobody has seen says so in plain words at 30 seconds, and a wallet re-pricing is named when it can be', async () => {
  const t = await txRules()
  const r = await rules()
  const start = 1_000_000_000_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const fresh = record({ submittedAt: iso(start), proposedMaxFee: 40_000_000_000n })
  // Before the mark, or on a check that did not ask: nothing is said.
  assert.equal(t.decideUnseen(fresh, { now: start + t.UNSEEN_AFTER_MS - 1, tx: null }).unseen, undefined)
  assert.equal(t.decideUnseen(fresh, { now: start + t.UNSEEN_AFTER_MS }).unseen, undefined, 'no read of the transaction, so nothing is known')
  // At the mark: said, and still only pending. It may well land.
  const unseen = t.decideUnseen(fresh, { now: start + t.UNSEEN_AFTER_MS, tx: null })
  assert.equal(unseen.unseen, true)
  assert.equal(unseen.outcome, 'pending')
  assert.equal(unseen.note, t.UNSEEN_NOTE)
  assert.match(t.UNSEEN_NOTE, /under 20 gwei/)
  assert.match(t.UNSEEN_NOTE, /some wallets change the fee/)
  // Then it shows up: the warning goes, and the fee it really carries decides what is said.
  const low = { maxFeePerGas: r.FEE_FLOOR_WEI - 1n, gasPrice: null, nonce: 7, from: OWNER }
  const seen = t.decideUnseen(unseen, { now: start + 40_000, tx: low })
  assert.equal(seen.unseen, undefined)
  assert.equal(seen.note, undefined)
  assert.equal((seen.sent as Rec).belowFloor, true)
  assert.equal(t.walletRepriced(seen), true)
  assert.equal(t.walletRepriced(t.decideUnseen(fresh, { now: start, tx: { ...low, maxFeePerGas: 40_000_000_000n } })), false)
  assert.equal(t.walletRepriced(record()), false, 'nothing read back, nothing to compare')
  // A receipt ends it, and carries no stale warning.
  const done = t.decideLanded(unseen, landed(), { missing: [] })
  assert.equal(done.unseen, undefined)
  assert.equal(done.note, undefined)
  assert.equal(t.retracked(t.untracked(unseen)).unseen, undefined)
  const page = codeOnly(repo('src/components/app/arc/TxReceipt.tsx'))
  assert.match(page, /record\.outcome === 'pending' && record\.unseen && \(/)
  assert.match(page, /record\.proposedMaxFee !== undefined && ` This page asked for a max fee of/)
  assert.match(page, /a\.unseen !== b\.unseen/, 'a change of this flag would not be saved')
  assert.match(page, /record\.unseen \? 'Do not sign a new one until you have looked in your wallet\.'/)
  assert.match(codeOnly(repo('src/components/app/arc/useArcTx.ts')), /proposedMaxFee: p\.maxFeePerGas/)
  // Before signing too, where the person can still raise it, and no claim the wallet shows the same fee.
  const copy = (await import(repoUrl('src/lib/arc/deploy-copy.ts').href)) as { WALLET_MAY_REPRICE: string }
  assert.match(copy.WALLET_MAY_REPRICE, /may show a different network fee/)
  assert.match(copy.WALLET_MAY_REPRICE, /raise it before you confirm/)
  const view = repo('src/components/app/arc/PreparedView.tsx')
  assert.match(codeOnly(view), /\{WALLET_MAY_REPRICE\}/)
  assert.doesNotMatch(view, /shows this same call and fee/)
})

test('a speed-up of a hash never seen is noticed by the nonce read while preparing, and never called final on that guess', async () => {
  const t = await txRules()
  const now = 1_000_000_000_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const write = record({ nonce: 7, submittedAt: iso(now - 60_000) })
  assert.equal(t.guessedNonce(write), 7)
  assert.equal(t.guessedNonce({ ...write, action: 'deploy' }), undefined, 'a deploy has its own proof, the vault at its address')
  assert.equal(t.guessedNonce({ ...write, sent: { nonce: 8 } }), undefined, 'the chain has named the real one')
  // Not used yet: nothing.
  assert.equal(t.decideUnseen(write, { now, latestNonce: 7 }).nonceUsedAt, undefined)
  // Used: watched first.
  const first = t.decideUnseen(write, { now, tx: null, latestNonce: 8 })
  assert.equal(first.outcome, 'pending')
  assert.equal(first.nonceUsedAt, iso(now))
  // Still never seen after the watch: the page stops holding on it, and says it may still land.
  const later = t.decideUnseen(first, { now: now + t.REPLACED_AFTER_MS, tx: null })
  assert.equal(later.outcome, 'untracked', 'a guess is never the final "replaced"')
  assert.equal(later.likelyReplaced, true)
  assert.equal(later.nonceUsedAt, undefined)
  assert.match(String(later.note), /most likely replaced/)
  assert.match(String(later.note), /can land later/)
  assert.equal(t.retracked(later).likelyReplaced, undefined)
  // The hash shows up during the watch with a later nonce: the wallet queued it, and it is alive.
  const queued = { maxFeePerGas: 40_000_000_000n, gasPrice: null, nonce: 8, from: OWNER }
  const alive = t.decideUnseen(first, { now: now + t.REPLACED_AFTER_MS, tx: queued, latestNonce: 8 })
  assert.equal(alive.outcome, 'pending')
  assert.equal(alive.nonceUsedAt, undefined)
  assert.equal(alive.note, undefined)
  // Shown with the guessed nonce itself, the existing proof takes over.
  const own = t.decideUnseen(first, { now: now + 1000, tx: { ...queued, nonce: 7 }, latestNonce: 8 })
  assert.equal(own.nonceUsedAt, iso(now + 1000))
  assert.equal(t.decideUnseen(own, { now: now + 1000 + t.REPLACED_AFTER_MS, tx: null }).outcome, 'replaced')
  // A deploy is left to the rule that reads its address.
  assert.equal(t.decideUnseen({ ...write, action: 'deploy', deployArgs: DEPLOY_ARGS }, { now, tx: null, latestNonce: 8 }).nonceUsedAt, undefined)
  // Every write carries the nonce, and the check asks about it.
  const lib = codeOnly(repo('src/lib/arc/vault-write.ts'))
  for (const fn of ['prepareOwnerCall', 'prepareFund']) assert.match(fnBody(lib, fn), /nonceHint\(c, /, `${fn} no longer reads the next nonce`)
  assert.match(codeOnly(repo('src/lib/arc/receipt.ts')), /record\.sent\?\.nonce \?\? guessedNonce\(record\)/)
  assert.match(codeOnly(repo('src/components/app/arc/TxReceipt.tsx')), /record\.likelyReplaced\s*\? `\$\{record\.what\}: most likely replaced/)
  assert.match(codeOnly(repo('src/components/app/arc/DeployFlow.tsx')), /outcome === 'replaced' \|\| setup\.fundTx\?\.likelyReplaced/)
})

test('the deploy flow says plainly what each confirmation does and costs, who holds what, and what to do when a step fails', async () => {
  const copy = (await import(repoUrl('src/lib/arc/deploy-copy.ts').href)) as {
    DEPLOY_FEE_ABOUT: string
    CALL_FEE_ABOUT: string
    WHAT_IS_A_VAULT: string
    CONFIRMATIONS: readonly { title: string; does: string; cost: string }[]
    FEES_LINE: string
    OWNER_KEY_LINE: string
    AGENT_KEY_CAN: string
    AGENT_KEY_CANNOT: string
    REVIEW_LINE: string
    IF_A_STEP_FAILS: readonly { when: string; then: string }[]
  }
  const r = await rules()
  // Three confirmations, each with what it does and a cost in USDC. Only the third moves USDC in.
  assert.equal(copy.CONFIRMATIONS.length, 3)
  for (const c of copy.CONFIRMATIONS) assert.match(c.cost, /USDC/, c.title)
  assert.match(copy.CONFIRMATIONS[0].does, /No USDC goes into it yet/)
  assert.match(copy.CONFIRMATIONS[1].does, /No USDC moves/)
  assert.match(copy.CONFIRMATIONS[2].cost, /^That amount, plus/)
  // The costs are what the floor makes them: a deploy reads about 966,000 gas live, a call or transfer about 60,000.
  const usdcAt = (gas: bigint) => Number(gas * r.FEE_FLOOR_WEI) / 1e18
  assert.equal(copy.DEPLOY_FEE_ABOUT, `about ${usdcAt(966_000n).toFixed(2)} USDC`)
  assert.equal(copy.CALL_FEE_ABOUT, `about ${usdcAt(60_000n).toFixed(3)} USDC`)
  assert.match(copy.FEES_LINE, /paid in USDC/)
  // Whose key, what the agent's can and cannot do, and the honest warnings that must stay.
  assert.match(copy.OWNER_KEY_LINE, /stays in your wallet/)
  assert.match(copy.OWNER_KEY_LINE, /signs nothing/)
  assert.match(copy.AGENT_KEY_CAN, /one thing: pay from the vault, within your limits, until its end date/)
  assert.match(copy.AGENT_KEY_CANNOT, /cannot change the limits/)
  assert.match(copy.AGENT_KEY_CANNOT, /if it leaks/)
  assert.match(copy.REVIEW_LINE, /internal reviews and no outside audit/)
  assert.match(copy.REVIEW_LINE, /afford to lose/)
  assert.ok(copy.IF_A_STEP_FAILS.length >= 4)
  assert.ok(copy.IF_A_STEP_FAILS.some((f) => /Nothing was sent/.test(f.then)))
  assert.ok(copy.IF_A_STEP_FAILS.some((f) => /fee is spent/.test(f.then)))
  // No word a newcomer would have to look up, with the one that wallets show explained where it appears.
  const said = [copy.WHAT_IS_A_VAULT, copy.FEES_LINE, copy.OWNER_KEY_LINE, copy.AGENT_KEY_CAN, copy.AGENT_KEY_CANNOT, copy.REVIEW_LINE, ...copy.CONFIRMATIONS.flatMap((c) => [c.title, c.does, c.cost]), ...copy.IF_A_STEP_FAILS.flatMap((f) => [f.when, f.then])].join(' ')
  assert.doesNotMatch(said, /\b(nonce|calldata|simulat\w*|EVM|ERC-20|gas|gwei|bytecode|pay\(\)|AgentSpendPolicy|dust|RPC)\b/i)
  // On the page, not just in the module.
  const flow = codeOnly(repo('src/components/app/arc/DeployFlow.tsx'))
  for (const name of ['WHAT_IS_A_VAULT', 'CONFIRMATIONS.map', 'FEES_LINE', 'OWNER_KEY_LINE', 'AGENT_KEY_CAN', 'AGENT_KEY_CANNOT', 'REVIEW_LINE', 'IF_A_STEP_FAILS.map']) {
    assert.ok(flow.includes(name), `${name} is no longer on the page`)
  }
  // Semantic tokens only, across the page's every component.
  for (const rel of arcPageFiles()) {
    assert.doesNotMatch(repo(rel), /\b(?:bg|text|border|ring)-(?:red|amber|green|yellow|orange|emerald|rose|blue|gray|slate|zinc|neutral)-\d{2,3}\b/, `${rel} uses a raw palette class`)
  }
})

test('admission\'s note about a long key uses the page\'s own cap', async () => {
  const r = await rules()
  assert.equal(PAGE_MAX_SESSION_SECONDS, BigInt(r.MAX_SESSION_SECONDS))
})

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

test('our launch-day vault and our key are labelled from the build, with no answer from the backend', async () => {
  const ours = (await import(repoUrl('src/lib/arc/ours.ts').href)) as {
    isOurVault: (network: string, address: string, listed?: readonly { network: string; address: string; kind: string }[]) => boolean
    isOurKey: (network: string, address: string, listed?: Readonly<Record<string, readonly string[]>>) => boolean
  }
  const mainnet = PROVENANCE.find((p) => p.chain === 'arc-mainnet')
  const launchDay = mainnet?.contracts.find((c) => c.name === 'AgentSpendPolicy vault')?.address ?? ''
  const operating = mainnet?.agent?.owner ?? ''
  const net = ARC_MAINNET?.caip2 ?? ''
  const testnet = CHAINS.find((c) => c.id === 'arc')?.caip2 ?? ''
  assert.ok(launchDay && operating && net && testnet)
  // No list from the backend at all: the labels hold, in any address case.
  assert.equal(ours.isOurVault(net, launchDay), true)
  assert.equal(ours.isOurVault(net, launchDay.toUpperCase().replace('0X', '0x')), true)
  assert.equal(ours.isOurKey(net, operating), true)
  assert.equal(ours.isOurKey(net, operating.toLowerCase()), true)
  // The network matters: the same address elsewhere is someone else's claim to make.
  assert.equal(ours.isOurVault(testnet, launchDay), false)
  // Nobody else is called ours, and the backend can only add to the list.
  assert.equal(ours.isOurVault(net, VAULT), false)
  assert.equal(ours.isOurKey(net, OWNER), false)
  assert.equal(ours.isOurVault(net, VAULT, [{ network: net, address: VAULT, kind: 'owner-held' }]), false)
  assert.equal(ours.isOurVault(net, VAULT, [{ network: net, address: VAULT, kind: 'ours' }]), true)
  assert.equal(ours.isOurKey(net, OWNER, { [net]: [OWNER] }), true)
  // The page asks this module, and no list from the backend is what decides a control.
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /isOurVault\(v\.network, v\.address, known\?\.vaults\)/)
  assert.match(page, /isOurKey\(v\.network, v\.owner, known\?\.ourKeys\)/)
})

type OursModule = {
  autoLandVault: <T extends { network: string; kind: string; owner?: string }>(rows: readonly T[], network: string, account: string | null) => T | null
  ledgerKnownVaults: () => { vaults: { network: string; address: string; kind: string }[]; ourKeys: Record<string, string[]> }
  earlierBuildLine: (network: string, address: string) => string | null
  FUND_RISK: string
  NOT_MY_VAULT: string
  NAMES_OUR_KEY: string
}

test('a link with no vault opens ours or the connected account\'s own, never a stranger\'s', async () => {
  const ours = (await import(repoUrl('src/lib/arc/ours.ts').href)) as OursModule
  const net = ARC_MAINNET?.caip2 ?? ''
  const stranger = { network: net, address: VAULT, kind: 'owner-held', owner: OWNER }
  const our = { network: net, address: '0x' + '77'.repeat(20), kind: 'ours' }
  assert.equal(ours.autoLandVault([stranger, our], net, null), our)
  assert.equal(ours.autoLandVault([stranger, our], net, '0x' + '99'.repeat(20)), our)
  assert.equal(ours.autoLandVault([stranger], net, null), null, 'nothing to land on is better than someone else\'s vault with a fund form')
  assert.equal(ours.autoLandVault([stranger, our], net, OWNER.toUpperCase().replace('0X', '0x')), stranger, 'your own vault, whatever the address case')
  assert.equal(ours.autoLandVault([our], 'eip155:1', null), null, 'the network the link named')
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /autoLandVault\(known\.vaults, network \?\? ARC_MAINNET\.caip2, wallet\.account\)/)
  assert.match(page, /\|\| typing\.current\) return/, 'never once someone has started typing an address')
})

test('the build\'s own vaults are on the page from its first render, before any backend answer', async () => {
  const ours = (await import(repoUrl('src/lib/arc/ours.ts').href)) as OursModule
  const seeded = ours.ledgerKnownVaults()
  const launchDay = PROVENANCE.find((p) => p.chain === 'arc-mainnet')?.contracts.find((c) => c.name === 'AgentSpendPolicy vault')?.address ?? ''
  assert.ok(seeded.vaults.some((v) => v.address.toLowerCase() === launchDay.toLowerCase() && v.kind === 'ours'))
  assert.ok(Object.keys(seeded.ourKeys).length > 0)
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /useState<KnownVaults \| null>\(seededKnownVaults\)/)
  const lib = codeOnly(repo('src/lib/arc/known-vaults.ts'))
  assert.match(lib, /loading: true/)
})

test('a late list never overwrites what someone typed, and a row or a submit takes the box back', () => {
  const picker = codeOnly(repo('src/components/app/arc/VaultPicker.tsx'))
  assert.match(picker, /useEffect\(\(\) => \{\s*if \(dirty\) return/, 'the sync effect leaves a dirty input alone')
  assert.match(picker, /onChange=\{\(e\) => \{\s*typed\(\)\s*setAddress/)
  assert.match(picker, /onChange=\{\(e\) => \{\s*typed\(\)\s*setNet/)
  assert.equal([...picker.matchAll(/setDirty\(false\)/g)].length, 2)
})

test('funding someone else\'s vault takes an explicit tick, and the page says what sending means', async () => {
  const ours = (await import(repoUrl('src/lib/arc/ours.ts').href)) as OursModule
  const raw = repo('src/routes/app/ArcVault.tsx')
  assert.doesNotMatch(raw, /only its owner can take it out/, 'false: the agent key can pay it out within the caps')
  assert.match(ours.FUND_RISK, /owner can withdraw/)
  assert.match(ours.FUND_RISK, /agent key can spend it within the caps until the key expires/)
  assert.match(ours.NOT_MY_VAULT, /not my vault/)
  const page = codeOnly(raw)
  assert.match(page, /\{FUND_RISK\}/)
  assert.match(page, /\{\(isOwner \|\| fundAcked\) && \(\s*<FundForm/, 'the form needs ownership or the tick')
  assert.match(page, /\{!isOwner && \(\s*<label/)
  assert.match(page, /const isOwner = Boolean\(v && wallet\.account && sameAddress\(wallet\.account, v\.owner\)\)/)
  // A tick is for this vault and this account, not for whatever is on screen next.
  assert.match(page, /fundAck === `\$\{key\}:\$\{wallet\.account \?\? ''\}`/)
  const flow = repo('src/components/app/arc/DeployFlow.tsx')
  assert.doesNotMatch(flow, /safe\s+moment/)
  assert.match(flow, /\{FUND_RISK\}/)
})

test('a contract that only names our key as owner is not called ours or deployed by us', async () => {
  const ours = (await import(repoUrl('src/lib/arc/ours.ts').href)) as OursModule
  assert.match(ours.NAMES_OUR_KEY, /names one of our keys/)
  assert.match(ours.NAMES_OUR_KEY, /not in our ledger and we did not list it/)
  const status = codeOnly(repo('src/components/app/arc/VaultStatus.tsx'))
  // OURS_LABEL ("Deployed with our server key") appears once, inside the block only `ours` opens.
  const label = status.indexOf('{OURS_LABEL}')
  assert.ok(label > 0)
  assert.equal(status.lastIndexOf('{OURS_LABEL}'), label)
  const opening = status.lastIndexOf('{ours && (', label)
  const closing = status.lastIndexOf(')}', label)
  assert.ok(opening > closing, 'the "deployed with our server key" line is reached only when the vault is in the ledger')
  assert.match(status, /\{!ours && ownerIsOurKey && \([\s\S]{0,300}\{NAMES_OUR_KEY\}/)
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /ours \? 'This is our own vault[^']*' : `\$\{NAMES_OUR_KEY\}/)
})

test('the page labels an operator key of ours, and a team-owned vault is not dressed as a green owner-held one', () => {
  const status = codeOnly(repo('src/components/app/arc/VaultStatus.tsx'))
  assert.match(status, /operatorIsOurKey && <Chip tone="warn">/)
  assert.match(status, /ownerKind === 'team' && \(/)
  const picker = codeOnly(repo('src/components/app/arc/VaultPicker.tsx'))
  assert.match(picker, /r\.ownerKind === 'team' \? \(\s*<Chip tone="muted">/, 'not the green chip')
  const lib = codeOnly(repo('src/lib/arc/known-vaults.ts'))
  assert.match(lib, /ownerKind: v\.ownerKind/, 'carried from the season report')
  const page = codeOnly(repo('src/routes/app/ArcVault.tsx'))
  assert.match(page, /operatorIsOurKey=\{isOurKey\(v\.network, v\.operator, known\?\.ourKeys\)\}/)
  assert.match(page, /ownerKind=\{listedRow\?\.ownerKind\}/)
})

test('a wallet that never answers does not stop the page looking, or leave it with no way forward', () => {
  const flow = codeOnly(repo('src/components/app/arc/DeployFlow.tsx'))
  assert.doesNotMatch(flow, /busy === 'deploy'\) return/, 'the look runs while the wallet promise is open')
  assert.match(flow, /useEffect\(\(\) => \{\s*if \(!target\) return\s*void lookForVault\(\)/)
  assert.match(flow, /release\('deploy'\)/, 'a vault found lets go of the wallet promise, or the next step stays disabled')
  assert.match(flow, /WALLET_SLOW_MS = 30_000/)
  assert.match(flow, /\{walletSlow && \(/)
  assert.match(repo('src/components/app/arc/DeployFlow.tsx'), /Reloading this page is safe/)
})

test('a wallet error that sent nothing has a labelled way out, and the notice does not promise a retry', () => {
  const raw = repo('src/components/app/arc/DeployFlow.tsx')
  assert.match(raw, /My wallet shows nothing was sent: start again/)
  const flow = codeOnly(raw)
  assert.match(flow, /next=\{step === 'sending' \? SENDING_NEXT : undefined\}/)
  assert.match(codeOnly(repo('src/components/app/arc/FailureNotice.tsx')), /const next = instead \?\? usual/)
})

test('a run let go of cannot clear or fail the run after it', () => {
  const hook = codeOnly(repo('src/components/app/arc/useArcTx.ts'))
  assert.match(hook, /if \(current\.current === mine\) setFailure/)
  assert.match(hook, /if \(current\.current === mine\) \{\s*current\.current = null\s*setBusy\(null\)/)
  assert.match(hook, /const release = useCallback/)
})

test('a revoke writes the named past second, and no operator is preset', () => {
  const write = codeOnly(repo('src/lib/arc/vault-write.ts'))
  assert.match(write, /REVOKED_SESSION_EXPIRY/, 'a revoke must write the named past second, not a literal')
  // The operator field starts empty in both places it is typed: which key the agent uses is the owner's decision.
  for (const rel of ['src/components/app/arc/DeployFlow.tsx', 'src/components/app/arc/OwnerControls.tsx']) {
    assert.match(repo(rel), /const \[operator, setOperator\] = useState\(''\)/, `${rel} presets an operator`)
  }
  // The page sends through send.ts, the module the wallet tests below drive, and nothing else.
  assert.match(write, /export \{[^}]*\bsendPrepared\b[^}]*\} from '\.\/send'/, 'vault-write.ts no longer sends through send.ts')
  for (const rel of arcPageFiles()) {
    if (rel === 'src/lib/arc/send.ts') continue
    assert.doesNotMatch(codeOnly(repo(rel)), /'eth_sendTransaction'/, `${rel} sends a transaction outside send.ts`)
  }
})

// --- the hand-off to the wallet, driven with a fake EIP-1193 wallet ---

type WalletCall = { method: string; params?: unknown[] }

/**
 * A wallet that records every request. `chainIds` are its successive eth_chainId answers (the
 * last one repeats); a switch request moves it to `switchTo` when given, and does nothing
 * otherwise, like a wallet that says yes and stays where it is.
 */
function fakeWallet(opts: { chainIds: string[]; accounts: string[]; switchTo?: string; send?: () => unknown }) {
  const calls: WalletCall[] = []
  let answers = [...opts.chainIds]
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return answers.length > 1 ? answers.shift() : answers[0]
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
        if (opts.switchTo) answers = [opts.switchTo]
        return null
      }
      if (method === 'eth_accounts') return opts.accounts
      if (method === 'eth_sendTransaction') return opts.send ? opts.send() : HASH
      throw new Error(`the fake wallet does not answer ${method}`)
    },
  }
  return { provider, calls, sent: () => calls.filter((c) => c.method === 'eth_sendTransaction') }
}

async function walletSetup() {
  const send = await sendModule()
  const r = await rules()
  const { CHAIN_BY_ID } = await chainsModule()
  const mainnet = CHAIN_BY_ID['arc-mainnet']
  const testnet = CHAIN_BY_ID.arc
  assert.ok(typeof mainnet.chainId === 'number' && typeof testnet.chainId === 'number' && mainnet.chainId !== testnet.chainId)
  const hex = (c: ChainLike) => `0x${(c.chainId as number).toString(16)}`
  const prepared = (over: Rec = {}): Rec => ({
    action: 'freeze',
    what: 'Freeze the vault',
    chain: mainnet,
    from: OWNER,
    to: VAULT,
    data: '0x7ca1c5b4',
    call: { contract: `AgentSpendPolicy ${VAULT}`, function: 'setFrozen', args: [] },
    gas: 52_000n,
    maxFeePerGas: r.FEE_FLOOR_WEI,
    maxPriorityFeePerGas: 0n,
    maxFeeWei: 52_000n * r.FEE_FLOOR_WEI,
    expect: [],
    preparedAt: Date.now(),
    ...over,
  })
  const stopped = async (p: Promise<unknown>): Promise<Failure> => {
    try {
      await p
    } catch (e) {
      return send.failureOf(e)
    }
    assert.fail('the send went through')
  }
  return { send, r, mainnet, testnet, hex, prepared, stopped }
}

test('nothing reaches eth_sendTransaction on a fee under the floor, the wrong chain or the wrong account', async () => {
  const { send, r, mainnet, testnet, hex, prepared, stopped } = await walletSetup()

  // A fee under Arc's floor stops before the wallet is even asked anything.
  const low = fakeWallet({ chainIds: [hex(mainnet)], accounts: [OWNER] })
  assert.equal((await stopped(send.sendPrepared(low.provider, prepared({ maxFeePerGas: r.FEE_FLOOR_WEI - 1n }), () => {}))).code, 'fee_too_low')
  assert.equal(low.calls.length, 0)

  // A wallet that says yes to the switch and stays on another chain.
  const stuck = fakeWallet({ chainIds: [hex(testnet)], accounts: [OWNER] })
  assert.equal((await stopped(send.sendPrepared(stuck.provider, prepared(), () => {}))).code, 'wrong_chain')
  assert.equal(stuck.sent().length, 0)

  // On the right chain for the switch check, then on another one when read again right before
  // sending: the second read is what decides, so nothing is sent.
  const moved = fakeWallet({ chainIds: [hex(mainnet), hex(testnet)], accounts: [OWNER] })
  assert.equal((await stopped(send.sendPrepared(moved.provider, prepared(), () => {}))).code, 'wrong_chain')
  assert.equal(moved.sent().length, 0)

  // The right chain, another account.
  const other = fakeWallet({ chainIds: [hex(mainnet)], accounts: [ATTACKER] })
  assert.equal((await stopped(send.sendPrepared(other.provider, prepared(), () => {}))).code, 'account_mismatch')
  assert.equal(other.sent().length, 0)
  const none = fakeWallet({ chainIds: [hex(mainnet)], accounts: [] })
  assert.equal((await stopped(send.sendPrepared(none.provider, prepared(), () => {}))).code, 'account_mismatch')
  assert.equal(none.sent().length, 0)

  // A deploy with a recipient is not a deploy.
  const deploy = fakeWallet({ chainIds: [hex(mainnet)], accounts: [OWNER] })
  assert.equal((await stopped(send.sendPrepared(deploy.provider, prepared({ action: 'deploy' }), () => {}))).code, 'refused')
  assert.equal(deploy.calls.length, 0)
})

test('the wallet gets one transaction with explicit gas, fees and chain id, only after every check, and the last step can still stop it', async () => {
  const { send, r, mainnet, testnet, hex, prepared, stopped } = await walletSetup()

  // A wallet on another chain that does switch: one eth_sendTransaction, fully specified.
  const w = fakeWallet({ chainIds: [hex(testnet)], accounts: [OWNER.toUpperCase().replace(/^0X/, '0x')], switchTo: hex(mainnet) })
  const steps: { step: string; callsSoFar: string[] }[] = []
  const hash = await send.sendPrepared(w.provider, prepared(), (step) => steps.push({ step, callsSoFar: w.calls.map((c) => c.method) }))
  assert.equal(hash, HASH)
  assert.equal(w.sent().length, 1)
  const tx = (w.sent()[0].params?.[0] ?? {}) as Record<string, string>
  assert.equal(tx.from, OWNER)
  assert.equal(tx.to, VAULT)
  assert.equal(tx.value, '0x0')
  assert.equal(tx.chainId, hex(mainnet))
  assert.equal(BigInt(tx.gas), 52_000n)
  assert.ok(BigInt(tx.maxFeePerGas) >= r.FEE_FLOOR_WEI)
  assert.equal(BigInt(tx.maxPriorityFeePerGas), 0n)
  // 'wallet' is the step right before eth_sendTransaction, after the chain and the account were read.
  const handOff = steps.find((s) => s.step === 'wallet')
  assert.ok(handOff, 'no wallet step')
  assert.ok(handOff.callsSoFar.includes('wallet_switchEthereumChain'))
  assert.equal(handOff.callsSoFar.at(-1), 'eth_accounts')
  assert.ok(!handOff.callsSoFar.includes('eth_sendTransaction'))
  assert.deepEqual(steps.map((s) => s.step), ['switching', 'wallet', 'submitted'])

  // A deploy goes without a recipient.
  const d = fakeWallet({ chainIds: [hex(mainnet)], accounts: [OWNER] })
  await send.sendPrepared(d.provider, prepared({ action: 'deploy', to: null }), () => {})
  assert.ok(!('to' in ((d.sent()[0].params?.[0] ?? {}) as object)))

  // The deploy view saves its setup at the 'wallet' step and refuses there when another setup
  // holds the slot. A throw at that step must send nothing.
  const refused = fakeWallet({ chainIds: [hex(mainnet)], accounts: [OWNER] })
  const slotTaken = new Error('another setup holds the slot')
  await assert.rejects(
    send.sendPrepared(refused.provider, prepared(), (step) => {
      if (step === 'wallet') throw slotTaken
    }),
    (e) => e === slotTaken,
  )
  assert.equal(refused.sent().length, 0)

  // A no in the wallet is a rejection, and a non-hash answer is never tracked as one.
  const no = fakeWallet({ chainIds: [hex(mainnet)], accounts: [OWNER], send: () => Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 })) })
  assert.equal((await stopped(send.sendPrepared(no.provider, prepared(), () => {}))).code, 'rejected')
  const junk = fakeWallet({ chainIds: [hex(mainnet)], accounts: [OWNER], send: () => 'ok' })
  assert.equal((await stopped(send.sendPrepared(junk.provider, prepared(), () => {}))).code, 'wallet_error')
})

// --- what a receipt, a nonce or a read-back means (tx-rules.ts) ---

const record = (over: Rec = {}): Rec => ({
  hash: HASH,
  action: 'freeze',
  what: 'Freeze the vault',
  network: ARC_MAINNET?.caip2 ?? '',
  from: OWNER,
  vault: VAULT,
  submittedAt: new Date(0).toISOString(),
  expect: [{ kind: 'event', address: VAULT, eventName: 'FrozenSet', args: { frozen: true } }],
  outcome: 'pending',
  ...over,
})
const landed = (over: Rec = {}): Rec => ({ success: true, block: 100n, feeWei: 1_000n, host: 'rpc.example', contractAddress: null, ...over })
const DEPLOY_ARGS = { owner: OWNER, operator: OPERATOR, usdc: USDC, dailyCap: 1_000_000n, autoApproveMax: 250_000n }

test('a receipt counts only with every expected event, from the vault itself, carrying the values sent', async () => {
  const t = await txRules()
  const frozen = { kind: 'event', address: VAULT, eventName: 'FrozenSet', args: { frozen: true } }
  assert.equal(t.missingFrom([], [frozen]).length, 1)
  assert.deepEqual(t.missingFrom([{ address: VAULT.toUpperCase().replace(/^0X/, '0x'), eventName: 'FrozenSet', args: { frozen: true } }], [frozen]), [])
  assert.equal(t.missingFrom([{ address: ATTACKER, eventName: 'FrozenSet', args: { frozen: true } }], [frozen]).length, 1, 'an event from another contract counted')
  assert.equal(t.missingFrom([{ address: VAULT, eventName: 'FrozenSet', args: { frozen: false } }], [frozen]).length, 1, 'the opposite value counted')
  assert.equal(t.missingFrom([{ address: VAULT, eventName: 'PolicyUpdated', args: { frozen: true } }], [frozen]).length, 1, 'another event counted')
  const transfer = { kind: 'transfer', token: USDC, from: OWNER, to: VAULT, value: 500_000n }
  const log = { address: USDC, eventName: 'Transfer', args: { from: OWNER, to: VAULT, value: 500_000n } }
  assert.deepEqual(t.missingFrom([log], [transfer]), [])
  assert.equal(t.missingFrom([{ ...log, args: { ...log.args, value: 499_999n } }], [transfer]).length, 1, 'a different amount counted')
  assert.equal(t.missingFrom([{ ...log, address: ATTACKER }], [transfer]).length, 1, 'a Transfer from another token counted')
  assert.equal(t.missingFrom([{ ...log, args: { ...log.args, to: ATTACKER } }], [transfer]).length, 1, 'a Transfer to someone else counted')

  // A success without the expected event is landed-but-not-as-expected, never settled.
  const missed = t.decideLanded(record(), landed(), { missing: t.missingFrom([], [frozen]) })
  assert.equal(missed.outcome, 'unexpected')
  assert.equal(missed.logsMatched, false)
  assert.equal(t.decideLanded(record(), landed(), { missing: [] }).outcome, 'settled')
  assert.equal(t.decideLanded(record(), landed({ success: false }), {}).outcome, 'reverted')
})

test('a landed write is never called unexpected from a read older than its receipt, or from no read at all', async () => {
  const t = await txRules()
  const extend = record({ action: 'extend', expiry: 1_800_000_000n, expect: [] })
  const at = (block: bigint, sessionKeyExpiry: bigint, balance = 0n) => ({ ok: true, block, sessionKeyExpiry, balance })
  // A host one block behind: ask again.
  const behind = t.decideLanded(extend, landed(), { missing: [], readBack: at(99n, 0n) })
  assert.equal(behind.outcome, 'pending')
  assert.equal(behind.readBackTries, 1)
  assert.equal(t.decideLanded(extend, landed(), { missing: [], readBack: { ok: false, reason: 'unreachable' } }).outcome, 'pending')
  assert.equal(t.decideLanded(extend, landed(), { missing: [] }).outcome, 'pending')
  // At the receipt's block, the value decides.
  assert.equal(t.decideLanded(extend, landed(), { missing: [], readBack: at(100n, 1_800_000_000n) }).outcome, 'settled')
  const wrong = t.decideLanded(extend, landed(), { missing: [], readBack: at(100n, 5n) })
  assert.equal(wrong.outcome, 'unexpected')
  assert.equal(wrong.logsMatched, true)
  // A read-back that keeps failing settles on the receipt's events alone, and says so.
  const last = t.decideLanded({ ...extend, readBackTries: t.READ_BACK_TRIES - 1 }, landed(), { missing: [], readBack: { ok: false, reason: 'pruned' } })
  assert.equal(last.outcome, 'settled')
  assert.match(String(last.note), /rests on the receipt alone/)
  // A funding: the balance at the receipt's block.
  const fund = record({ action: 'fund', amount: 500_000n, expect: [] })
  assert.equal(t.decideLanded(fund, landed(), { missing: [], readBack: at(100n, 1n, 500_000n) }).outcome, 'settled')
  assert.equal(t.decideLanded(fund, landed(), { missing: [], readBack: at(100n, 1n, 400_000n) }).outcome, 'unexpected')
  assert.equal(t.decideLanded(fund, landed(), { missing: [], readBack: at(99n, 1n, 0n) }).outcome, 'pending')
})

test('a landed deploy counts only once the vault at the address the receipt names reads back as asked', async () => {
  const t = await txRules()
  const deploy = record({ action: 'deploy', vault: null, expect: [], deployArgs: DEPLOY_ARGS, predicted: VAULT, nonce: 3 })
  assert.equal(t.decideLanded(deploy, landed(), {}).outcome, 'unexpected', 'no contract address, no vault')
  const created = landed({ contractAddress: VAULT })
  const unread = t.decideLanded(deploy, created, { deploy: { status: 'unreadable', why: 'unreachable' } })
  assert.equal(unread.outcome, 'pending')
  assert.equal(unread.vault, null)
  assert.equal(t.decideLanded(deploy, created, { deploy: { status: 'no_code', why: 'a host behind' } }).outcome, 'pending')
  const odd = t.decideLanded(deploy, created, { deploy: { status: 'mismatch', why: 'owner reads someone else' } })
  assert.equal(odd.outcome, 'unexpected')
  const ok = t.decideLanded(deploy, created, { deploy: { status: 'ok', why: null } })
  assert.equal(ok.outcome, 'settled')
  assert.equal(ok.vault, VAULT)
  assert.equal(t.decideLanded({ ...deploy, deployArgs: undefined }, created, { deploy: { status: 'ok', why: null } }).outcome, 'unexpected')
})

test('one host\'s null decides nothing; this hash\'s nonce used by another is watched, then final', async () => {
  const t = await txRules()
  const r = await rules()
  // Every host at once: a "not found" from one host, or one that never answers, does not stop
  // another host's receipt from deciding; "not found" needs every host to have said so.
  class NotFound extends Error {}
  const isNotFound = (e: unknown) => e instanceof NotFound
  const never = new Promise<string>(() => {})
  const hit = await t.firstFound([Promise.reject(new NotFound()), never, Promise.resolve('receipt')], isNotFound)
  assert.equal(hit.found, true)
  assert.equal(hit.value, 'receipt')
  assert.equal(hit.index, 2)
  const miss = await t.firstFound([Promise.reject(new NotFound()), Promise.reject(new Error('timeout')), Promise.reject(new NotFound())], isNotFound)
  assert.deepEqual(miss, { found: false, answered: 2, total: 3 })
  assert.deepEqual(await t.firstFound([], isNotFound), { found: false, answered: 0, total: 0 })
  const now = 1_000_000_000_000
  const iso = (ms: number) => new Date(ms).toISOString()
  // No receipt anywhere and nothing else known: still pending, unchanged.
  const quiet = t.decideUnseen(record(), { now })
  assert.equal(quiet.outcome, 'pending')
  assert.equal(quiet.nonceUsedAt, undefined)
  // The transaction itself, read back: a fee under the floor is flagged.
  const tx = { maxFeePerGas: r.FEE_FLOOR_WEI - 1n, gasPrice: null, nonce: 7, from: OWNER }
  const seen = t.decideUnseen(record(), { now, tx })
  assert.equal((seen.sent as Rec).belowFloor, true)
  assert.equal(seen.outcome, 'pending')
  const sent = { maxFeePerGas: r.FEE_FLOOR_WEI, gasPrice: null, nonce: 7, belowFloor: false, from: OWNER }
  // Its nonce not yet used: nothing to say.
  assert.equal(t.decideUnseen(record({ sent }), { now, latestNonce: 7 }).nonceUsedAt, undefined)
  // Used: watched first, never final on one look.
  const first = t.decideUnseen(record({ sent }), { now, latestNonce: 8 })
  assert.equal(first.outcome, 'pending')
  assert.equal(first.nonceUsedAt, iso(now))
  assert.equal(t.decideUnseen(record({ sent, nonceUsedAt: iso(now - t.REPLACED_AFTER_MS + 1) }), { now }).outcome, 'pending')
  // Still no receipt for this hash after the watch: replaced, final, and nothing waits on it.
  const done = t.decideUnseen(record({ sent, nonceUsedAt: iso(now - t.REPLACED_AFTER_MS) }), { now })
  assert.equal(done.outcome, 'replaced')
  assert.match(String(done.note), /can no longer land/)
  // A receipt after all wins over the watch.
  assert.equal(t.decideLanded(record({ sent, nonceUsedAt: iso(now) }), landed(), { missing: [] }).nonceUsedAt, undefined)
  // The person can stop tracking it, and track it again.
  assert.equal(t.untracked(record()).outcome, 'untracked')
  assert.equal(t.retracked(t.untracked(record())).outcome, 'pending')
})

test('a deploy with no receipt is recognized by the vault at its CREATE address, never by a guessed nonce alone', async () => {
  const t = await txRules()
  const r = await rules()
  const now = 1_000_000_000_000
  const deploy = record({ action: 'deploy', vault: null, expect: [], deployArgs: DEPLOY_ARGS, predicted: VAULT, nonce: 3 })
  // A speed-up landed: the vault reads back exactly as asked where this nonce deploys.
  const found = t.decideUnseen(deploy, { now, latestNonce: 4, createdAt: { address: VAULT, back: { status: 'ok', why: null } } })
  assert.equal(found.outcome, 'replaced')
  assert.equal(found.vault, VAULT)
  // The transaction never seen and only the nonce read while preparing used: the wallet may have
  // given the deploy a later nonce, so this is not called replaced.
  const guessed = t.decideUnseen(deploy, { now, latestNonce: 4, createdAt: { address: VAULT, back: { status: 'no_code', why: 'no code' } } })
  assert.equal(guessed.outcome, 'pending')
  assert.equal(guessed.nonceUsedAt, undefined)
  // Its own nonce used, watched, and the address it creates holds nothing: no vault, final.
  const sent = { maxFeePerGas: r.FEE_FLOOR_WEI, gasPrice: null, nonce: 3, belowFloor: false, from: OWNER }
  const watched = { ...deploy, sent, nonceUsedAt: new Date(now - t.REPLACED_AFTER_MS).toISOString() }
  const cancelled = t.decideUnseen(watched, { now, createdAt: { address: VAULT, back: { status: 'no_code', why: 'no code' } } })
  assert.equal(cancelled.outcome, 'replaced')
  assert.equal(cancelled.vault, null)
  // ...but not while that address could not be read at all.
  assert.equal(t.decideUnseen(watched, { now, createdAt: { address: VAULT, back: { status: 'unreadable', why: 'down' } } }).outcome, 'pending')
  assert.equal(t.decideUnseen(watched, { now }).outcome, 'pending')
})

const setupOf = (over: Rec = {}): Rec => ({
  v: 1,
  network: ARC_MAINNET?.caip2 ?? '',
  owner: OWNER,
  operator: OPERATOR,
  dailyCap: 1_000_000n,
  autoApproveMax: 250_000n,
  sessionSeconds: 604_800,
  funding: 500_000n,
  startedAt: new Date(0).toISOString(),
  ...over,
})
const snap = (over: Rec = {}): Rec => ({ address: VAULT, network: ARC_MAINNET?.caip2 ?? '', block: 200n, sessionKeyExpiry: 0n, balance: 0n, ...over })

test('a deploy whose receipt names a contract is never no vault: it stays in the setup, with the banner, until read as bounded', async () => {
  const t = await txRules()
  const base = { action: 'deploy', vault: null, deployArgs: DEPLOY_ARGS, predicted: ATTACKER, nonce: 3 }
  // Both ways a receipt names a contract the setup cannot continue with, from decideLanded itself.
  const mismatch = t.decideLanded(record(base), landed({ contractAddress: VAULT }), { deploy: { status: 'mismatch', why: 'owner reads someone else' } })
  const lost = t.decideLanded(record({ ...base, deployArgs: undefined }), landed({ contractAddress: VAULT }), {})
  for (const deploy of [mismatch, lost]) {
    assert.equal(deploy.outcome, 'unexpected')
    const s = t.withRecord(setupOf(), 'deploy', deploy)
    assert.equal(s.vault, undefined, 'it does not become the vault the setup continues with')
    assert.equal(t.setupStep(s, false, null), 'deploy-failed')
    assert.deepEqual(t.deployEnd(s), { kind: 'contract', address: VAULT })
    assert.equal(t.predictedVault(s), VAULT, 'the address the receipt named, not the one predicted')
    assert.equal(t.setupAlert(s, null), 'unbounded', 'the vault page keeps warning')
    assert.equal(t.setupAlert(s, snap({ address: VAULT })), 'unbounded', 'read with no expiry')
    assert.equal(t.setupAlert(s, snap({ address: ATTACKER, sessionKeyExpiry: 1_800_000_000n })), 'unbounded', 'another vault decides nothing')
    assert.equal(t.setupAlert(s, snap({ address: VAULT, sessionKeyExpiry: 1_800_000_000n })), null, 'read with an expiry')
  }
  // A deploy that stopped being tracked after its receipt named the contract is still that contract.
  const stopped = setupOf({ deploy: record({ ...base, outcome: 'untracked', contractAddress: VAULT }) })
  assert.deepEqual(t.deployEnd(stopped), { kind: 'contract', address: VAULT })
  assert.equal(t.setupAlert(stopped, null), 'unbounded')
  assert.equal(t.vaultToLookFor(stopped)?.predicted, VAULT)

  // No vault is said only for a revert or a receipt with no contract address.
  const reverted = t.decideLanded(record(base), landed({ success: false, contractAddress: VAULT }), {})
  const noAddress = t.decideLanded(record(base), landed(), {})
  for (const deploy of [reverted, noAddress]) {
    const s = t.withRecord(setupOf(), 'deploy', deploy)
    assert.deepEqual(t.deployEnd(s), { kind: 'no-vault' }, deploy.outcome as string)
    assert.equal(t.createdContract(s), null)
    assert.equal(t.setupAlert(s, null), null)
  }
  // A revert is no vault even if an older record held an address from an earlier look.
  assert.deepEqual(t.deployEnd(setupOf({ deploy: record({ ...base, outcome: 'reverted', contractAddress: VAULT }) })), { kind: 'no-vault' })
  assert.deepEqual(t.deployEnd(setupOf({ deploy: record({ ...base, outcome: 'untracked' }) })), { kind: 'untracked' })
  assert.deepEqual(t.deployEnd(setupOf({ deploy: record({ ...base, outcome: 'replaced' }) })), { kind: 'replaced' })
  // Nothing to say while it is pending, or once the setup has its vault.
  assert.equal(t.deployEnd(setupOf({ deploy: record({ ...base, contractAddress: VAULT }) })), null)
  assert.equal(t.deployEnd(setupOf({ vault: VAULT, deploy: record({ ...base, outcome: 'settled', contractAddress: VAULT }) })), null)
  // The page says so: the no-vault line only behind its own case, and no way to start clean past a contract.
  const flow = codeOnly(repo('src/components/app/arc/DeployFlow.tsx'))
  const branch = flow.slice(flow.indexOf("step === 'deploy-failed' && setup?.deploy && created"), flow.indexOf("step === 'deploy-failed' && setup?.deploy && !created"))
  assert.ok(branch.length > 0, 'the contract branch of the deploy-failed step is gone')
  assert.doesNotMatch(branch, /No vault came out|Start again/)
  assert.match(branch, /no time bound/)
  assert.match(branch, /onOpenVault\(setup\.network, created\)/)
})

test('no funding is offered before the agent key is bounded in time, and the live vault wins over a record that is only pending', async () => {
  const t = await txRules()
  assert.equal(t.setupStep(null, false, null), 'form')
  assert.equal(t.setupStep(null, true, null), 'review')
  const intent = { from: OWNER, nonce: 3, predicted: VAULT, deployArgs: DEPLOY_ARGS, at: new Date(0).toISOString() }
  assert.equal(t.setupStep(setupOf({ intent }), false, null), 'sending')
  assert.equal(t.setupStep(setupOf({ intent, deploy: record({ action: 'deploy' }) }), false, null), 'deploying')
  assert.equal(t.setupStep(setupOf({ deploy: record({ action: 'deploy', outcome: 'reverted' }) }), false, null), 'deploy-failed')
  assert.equal(t.setupStep(setupOf({ deploy: record({ action: 'deploy', outcome: 'untracked' }) }), false, null), 'deploy-failed')
  const s = setupOf({ vault: VAULT })
  // No expiry anywhere: step 2, whatever the funding, before and after the vault is read.
  assert.equal(t.setupStep(s, false, null), 'expiry')
  assert.equal(t.setupStep(s, false, snap()), 'expiry')
  assert.equal(t.setupStep(s, false, snap({ balance: 10_000_000n })), 'expiry', 'money in the vault does not skip the expiry')
  // A pending expiry with the vault still unbounded waits; with the vault bounded, the vault wins.
  const pendingExpiry = { ...s, expiryTx: record({ action: 'expiry' }) }
  assert.equal(t.setupStep(pendingExpiry, false, snap()), 'expiry-pending')
  assert.equal(t.setupStep(pendingExpiry, false, snap({ sessionKeyExpiry: 1_800_000_000n })), 'fund')
  // A replaced or untracked expiry offers step 2 again rather than waiting forever.
  for (const outcome of ['replaced', 'untracked', 'reverted', 'unexpected'])
    assert.equal(t.setupStep({ ...s, expiryTx: record({ action: 'expiry', outcome }) }, false, snap()), 'expiry', outcome)
  // A settled expiry counts against a read from before its block, not against one after it.
  const settled = { ...s, expiryTx: record({ action: 'expiry', outcome: 'settled', block: 150n }) }
  assert.equal(t.setupStep(settled, false, null), 'fund')
  assert.equal(t.setupStep(settled, false, snap({ block: 140n })), 'fund')
  assert.equal(t.setupStep(settled, false, snap({ block: 160n })), 'expiry')
  // A snapshot of another vault decides nothing about this one.
  assert.equal(t.setupStep(pendingExpiry, false, snap({ address: ATTACKER, sessionKeyExpiry: 1_800_000_000n })), 'expiry-pending')
  // The vault page warns at every stage of this.
  assert.equal(t.setupAlert(setupOf({ intent }), null), 'sending')
  assert.equal(t.setupAlert(setupOf({ deploy: record({ action: 'deploy' }) }), null), 'deploying')
  assert.equal(t.setupAlert(s, null), 'unbounded')
  assert.equal(t.setupAlert(s, snap({ sessionKeyExpiry: 1_800_000_000n })), null)
  assert.equal(t.setupAlert(setupOf({ deploy: record({ action: 'deploy', outcome: 'reverted' }) }), null), null)
  assert.equal(t.setupAlert(setupOf({ deploy: record({ action: 'deploy', outcome: 'untracked' }) }), null), 'untracked', 'an untracked deploy can still land')
  assert.equal(t.predictedVault(setupOf({ intent })), VAULT)
  // A deploy with no hash back, or no longer tracked, is looked for at its address; a final one is not.
  assert.equal(t.vaultToLookFor(setupOf({ intent }))?.predicted, VAULT)
  const untrackedDeploy = record({ action: 'deploy', outcome: 'untracked', vault: null, predicted: VAULT, deployArgs: DEPLOY_ARGS })
  assert.equal(t.vaultToLookFor(setupOf({ intent, deploy: untrackedDeploy }))?.predicted, VAULT)
  assert.equal(t.vaultToLookFor(setupOf({ intent, deploy: { ...untrackedDeploy, outcome: 'pending' } })), null, 'a tracked deploy is decided by its receipt')
  assert.equal(t.vaultToLookFor(setupOf({ intent, deploy: { ...untrackedDeploy, outcome: 'replaced' } })), null)
  assert.equal(t.vaultToLookFor(setupOf({ intent, vault: VAULT })), null)
  // A deploy that settled, or was found through a replacement, names the setup's vault; one that
  // did not read back as asked never does.
  assert.equal(t.withRecord(setupOf(), 'deploy', record({ action: 'deploy', outcome: 'settled', vault: VAULT })).vault, VAULT)
  assert.equal(t.withRecord(setupOf(), 'deploy', record({ action: 'deploy', outcome: 'replaced', vault: VAULT })).vault, VAULT)
  assert.equal(t.withRecord(setupOf(), 'deploy', record({ action: 'deploy', outcome: 'unexpected', vault: VAULT })).vault, undefined)
})

test('a funding counts once its Transfer landed or the vault holds it, and one whose fate is unknown is never offered again silently', async () => {
  const t = await txRules()
  const s = setupOf({ vault: VAULT, expiryTx: record({ action: 'expiry', outcome: 'settled', block: 150n }) })
  const bounded = snap({ sessionKeyExpiry: 1_800_000_000n })
  assert.equal(t.setupStep(s, false, bounded), 'fund')
  // The receipt carried the exact Transfer: done, even if a later balance read disagreed.
  const odd = record({ action: 'fund', outcome: 'unexpected', logsMatched: true, amount: 500_000n })
  assert.equal(t.setupStep({ ...s, fundTx: odd }, false, bounded), 'done')
  assert.ok(t.fundingLanded(odd))
  assert.equal(t.fundingLanded(record({ action: 'fund', outcome: 'unexpected', logsMatched: false })), false)
  // A pending funding waits, unless the vault already holds it.
  const pendingFund = { ...s, fundTx: record({ action: 'fund', amount: 500_000n }) }
  assert.equal(t.setupStep(pendingFund, false, bounded), 'fund-pending')
  assert.equal(t.setupStep(pendingFund, false, snap({ sessionKeyExpiry: 1_800_000_000n, balance: 500_000n })), 'done')
  // Replaced or untracked: offered again, but the page asks first (fundingUnresolved).
  for (const outcome of ['replaced', 'untracked']) {
    const r = record({ action: 'fund', outcome, amount: 500_000n })
    assert.equal(t.setupStep({ ...s, fundTx: r }, false, bounded), 'fund')
    assert.ok(t.fundingUnresolved(r), outcome)
  }
  assert.equal(t.fundingUnresolved(record({ action: 'fund', outcome: 'reverted' })), false, 'a reverted funding moved nothing')
  // Skipped, or nothing to fund: done once the key is bounded.
  assert.equal(t.setupStep({ ...s, fundSkipped: true }, false, bounded), 'done')
  assert.equal(t.setupStep({ ...s, funding: 0n }, false, bounded), 'done')
  // And the deploy view keeps the second funding behind an explicit confirmation (wiring).
  const flow = repo('src/components/app/arc/DeployFlow.tsx')
  assert.match(flow, /fundingUnresolved\(setup\.fundTx\) && !refundConfirmed/, 'DeployFlow offers a second funding without asking')
  assert.match(flow, /setupStep\(setup, review !== null, snapshot\)/, 'DeployFlow no longer takes its step from setupStep')
})

test('a record is polled on the network it names, the deploy on the network it was reviewed on, and Freeze and Revoke never wait on a pending record', () => {
  const receipt = codeOnly(repo('src/components/app/arc/TxReceipt.tsx'))
  assert.match(receipt, /const chain = arcChainFor\(record\.network\)/, 'TxReceipt no longer takes its chain from the record')
  assert.doesNotMatch(receipt, /\bchain: Chain\b/, 'TxReceipt takes a chain prop again')
  const flow = codeOnly(repo('src/components/app/arc/DeployFlow.tsx'))
  const confirm = flow.slice(flow.indexOf('const confirmDeploy'), flow.indexOf('const setExpiry'))
  assert.match(confirm, /const on = review\.chain/, 'confirmDeploy no longer deploys on the reviewed network')
  assert.match(confirm, /prepareDeploy\(on, input\)/, 'a stale review is prepared again on another network')
  assert.match(confirm, /network: on\.caip2/, 'the setup records a network other than the one deployed on')
  assert.match(flow, /id="deploy-network"[\s\S]{0,200}disabled=\{busy !== null\}/, 'the network select is live while a review is prepared')
  assert.match(flow, /prepared && prepared\.chain\.caip2 === chain\.caip2 \? prepared : null/, 'a review prepared on another network can still be confirmed')
  const owner = codeOnly(repo('src/components/app/arc/OwnerControls.tsx'))
  const revoke = owner.slice(owner.indexOf("act('revoke'"), owner.indexOf("act('revoke'") + 160)
  assert.doesNotMatch(revoke, /\bheld\b/, 'Revoke waits on a pending record again')
  assert.match(owner, /disabled=\{busy !== null \|\| \(held && !next\)\}/, 'Freeze waits on a pending record again')
})
