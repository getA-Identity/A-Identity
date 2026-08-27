/**
 * Durable state storage.
 *
 * When DATABASE_URL is set (production / ephemeral hosts like Render free tier)
 * the whole state is persisted to Postgres as a single JSONB blob. Otherwise it
 * falls back to a local JSON file (dev). Writes are debounced; there is no mock
 * data - an empty store simply starts empty.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const DATA_FILE = join(DATA_DIR, 'platform.json')
const DB_URL = process.env.DATABASE_URL

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any = null

async function getPool() {
  if (!DB_URL) return null
  if (pool) return pool
  // Variable specifier so tsc doesn't require pg's types at build time.
  const spec = 'pg'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pgMod: any = await import(spec)
  const Pool = pgMod.default?.Pool ?? pgMod.Pool
  const local = DB_URL.includes('localhost') || DB_URL.includes('127.0.0.1')
  pool = new Pool({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false } })
  await pool.query('CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, data jsonb NOT NULL)')
  return pool
}

/** Load the persisted state blob, or null if none yet. */
export async function loadState<T>(): Promise<T | null> {
  const p = await getPool()
  if (p) {
    const r = await p.query('SELECT data FROM app_state WHERE id = $1', ['platform'])
    return (r.rows[0]?.data as T) ?? null
  }
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8')) as T
  } catch {
    return null
  }
}

let pending: unknown = null
let timer: ReturnType<typeof setTimeout> | null = null

/** Persist the full state blob (debounced ~300ms). Callers stay synchronous. */
export function saveState(state: unknown): void {
  pending = state
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, 300)
}

// Serialize flushes so two overlapping persists (e.g. a debounced flush racing the
// SIGTERM flush) never interleave writes to the same row/file. Each flush awaits the
// previous one, then persists the LATEST pending snapshot.
let flushChain: Promise<void> = Promise.resolve()

function flush(): Promise<void> {
  flushChain = flushChain.then(doFlush, doFlush)
  return flushChain
}

async function doFlush() {
  const data = pending
  pending = null
  if (data == null) return
  try {
    const p = await getPool()
    if (p) {
      await p.query(
        'INSERT INTO app_state (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
        ['platform', JSON.stringify(data)],
      )
    } else {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
    }
  } catch (e) {
    console.error('[storage] persist failed:', e instanceof Error ? e.message : e)
  }
}

// ── durable spent-payment set (x402 replay protection) ───────────────────────────
//
// x402 unlocks a resource with a real USDC tx hash exactly once. If that "already
// spent" set lives only in memory, a restart (Render cold-start / redeploy) resets
// it and a previously-used payment could be replayed. So we persist spent hashes:
// Postgres when DATABASE_URL is set, else a local JSON file alongside the state.

// Two rails share this one table, and they never collide because their keys live in
// disjoint namespaces by construction: the Arc rail writes a 66-character tx hash
// (0x + 64 hex), while the EIP-3009 rail writes a structured key that starts with its
// CAIP-2 chain id ("eip155:4663/erc20:0x.../3009/0x.../0x..."). Namespacing was chosen
// over adding a `network` column deliberately: this table gates replay protection, and a
// schema migration on it is the one failure mode we cannot accept, since a half-applied
// migration fails OPEN. See x402-3009/engine.ts paymentKey().

const SPENT_FILE = join(DATA_DIR, 'spent-payments.json')

/** Load every spent payment key (lowercase) recorded so far.
 *
 *  Rethrows on a database failure, deliberately and unlike the settlement log: this set IS
 *  the replay guard, and continuing with an empty one would let a previously redeemed
 *  payment through. Callers must treat a failure as a refusal. */
export async function loadSpentPayments(): Promise<string[]> {
  const p = await getPool()
  if (p) {
    await p.query('CREATE TABLE IF NOT EXISTS spent_payments (hash text PRIMARY KEY)')
    const r = await p.query('SELECT hash FROM spent_payments')
    return r.rows.map((row: { hash: string }) => row.hash)
  }
  try {
    return JSON.parse(readFileSync(SPENT_FILE, 'utf8')) as string[]
  } catch {
    return []
  }
}

/** Durably record one spent payment hash (idempotent). */
export async function persistSpentPayment(hash: string): Promise<void> {
  const h = hash.toLowerCase()
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS spent_payments (hash text PRIMARY KEY)')
      await p.query('INSERT INTO spent_payments (hash) VALUES ($1) ON CONFLICT DO NOTHING', [h])
      return
    }
    let arr: string[] = []
    try {
      arr = JSON.parse(readFileSync(SPENT_FILE, 'utf8')) as string[]
    } catch {
      /* first write */
    }
    if (!arr.includes(h)) {
      arr.push(h)
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(SPENT_FILE, JSON.stringify(arr))
    }
  } catch (e) {
    console.error('[storage] spent-payment persist failed:', e instanceof Error ? e.message : e)
  }
}

// ── durable Celo settlement log (x402 facilitator proof) ─────────────────────────
//
// Every settled Celo x402 call is recorded so GET /api/celo/proof can show real,
// restart-surviving traction instead of an in-memory counter that a redeploy resets.
// Same dual pattern as spent_payments: Postgres when DATABASE_URL is set, else a local
// JSON file. Append-only with a hard cap (the newest CELO_SETTLEMENTS_CAP survive), so
// the log can't grow unbounded; the proof endpoint says its totals cover this window.

export type CeloSettlementRecord = {
  /** ISO timestamp of the settlement. */
  ts: string
  /** Tool that was served (e.g. 'verify_agent'). */
  tool: string
  /** Price actually charged, in USD. */
  amountUsd: number
  /** Paying wallet (the EIP-3009 authorization's `from`), when known. */
  payer?: string
  /** On-chain settlement transaction hash, when the facilitator reports it. */
  tx?: string
  /** CAIP-2 network the payment settled on (e.g. 'eip155:42220'). */
  network: string
  /** Credits figure returned by the facilitator's settle response, when present. */
  facilitatorCredits?: number
}

const CELO_SETTLEMENTS_FILE = join(DATA_DIR, 'celo-settlements.json')
export const CELO_SETTLEMENTS_CAP = 2000

/** Load the retained Celo settlement records, oldest first. */
export async function loadCeloSettlements(): Promise<CeloSettlementRecord[]> {
  const p = await getPool()
  if (p) {
    await p.query('CREATE TABLE IF NOT EXISTS celo_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
    const r = await p.query('SELECT data FROM celo_settlements ORDER BY id ASC')
    return r.rows.map((row: { data: CeloSettlementRecord }) => row.data)
  }
  try {
    return JSON.parse(readFileSync(CELO_SETTLEMENTS_FILE, 'utf8')) as CeloSettlementRecord[]
  } catch {
    return []
  }
}

/** Durably record one settled Celo call, trimming past the cap. Never throws: the
 *  settlement already happened at the facilitator, so a logging hiccup must not turn
 *  a paid, served call into an error for the buyer. */
export async function persistCeloSettlement(rec: CeloSettlementRecord): Promise<void> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS celo_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      await p.query('INSERT INTO celo_settlements (data) VALUES ($1)', [JSON.stringify(rec)])
      await p.query(
        'DELETE FROM celo_settlements WHERE id NOT IN (SELECT id FROM celo_settlements ORDER BY id DESC LIMIT $1)',
        [CELO_SETTLEMENTS_CAP],
      )
      return
    }
    let arr: CeloSettlementRecord[] = []
    try {
      arr = JSON.parse(readFileSync(CELO_SETTLEMENTS_FILE, 'utf8')) as CeloSettlementRecord[]
    } catch {
      /* first write */
    }
    arr.push(rec)
    if (arr.length > CELO_SETTLEMENTS_CAP) arr = arr.slice(-CELO_SETTLEMENTS_CAP)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(CELO_SETTLEMENTS_FILE, JSON.stringify(arr))
  } catch (e) {
    console.error('[storage] celo settlement persist failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * One settlement on the self-facilitated EIP-3009 rail (see x402-3009/).
 *
 * A separate type from CeloSettlementRecord on purpose, because the two record different
 * KINDS of evidence. The Celo record is a facilitator receipt: its distinguishing field
 * is `facilitatorCredits`, a third party's assertion that the money moved. This one is a
 * CHAIN receipt: we broadcast the transfer ourselves, so we hold the tx, the block, the
 * gas and the matching Transfer log. Merging them into one union would leave every field
 * optional and let a weaker provenance be displayed as if it were a stronger one.
 */
export type X402SettlementRecord = {
  ts: string
  /** 'settled' = receipt status success AND a matching Transfer log. 'reverted' = mined
   *  and failed. 'ambiguous' = broadcast, no receipt inside the timeout. Only 'settled'
   *  is revenue; the other two are shown rather than hidden, and all three cost gas. */
  outcome: 'settled' | 'reverted' | 'ambiguous'
  tool: string
  resource: string
  /** CAIP-2 network the payment settled on. */
  network: string
  /** The ERC-20 that actually moved. Mandatory here: without it a proof page cannot say
   *  WHAT was paid, which is the gap in the Celo record. */
  asset: string
  assetSymbol: string
  assetDecimals: number
  /** Base units, exactly as the Transfer log reported them. */
  value: string
  amountUsd: number
  baseUsd: number
  feeUsd: number
  payer: string
  payTo: string
  /** The EIP-3009 nonce, so an ambiguous settlement can later be resolved exactly. */
  authNonce: string
  tx?: string
  blockNumber?: string
  explorerUrl?: string
  /** What the settlement cost US, in native units only. This chain has no price feed we
   *  verify, so a USD gas figure would be a fabricated number. */
  gasUsed?: string
  gasWei?: string
  /** Present when we facilitated for a third-party payTo rather than for ourselves. */
  facilitatedFor?: string
}

const X402_SETTLEMENTS_FILE = join(DATA_DIR, 'x402-settlements.json')
export const X402_SETTLEMENTS_CAP = 2000

/**
 * The x402-3009 settlement log, with "empty" and "unreadable" told apart.
 *
 * The EVM twin of `loadStellarSettlementsResult`, and it exists for the same reason: the
 * daily gas budget in x402-3009/engine.ts is a guard on money we spend, and a guard that
 * cannot read its own ledger must stop rather than assume zero. `loadX402Settlements`
 * below returns `[]` on a read error, which a budget can only read as "nothing spent
 * today", so an unreachable Postgres turned the gas ceiling off completely. That is the
 * same fail-open the Stellar rail fixed; this is the fix arriving on this side.
 *
 * A missing FILE is genuinely empty: that is a first run, not a failure.
 *
 * `getPool` is injectable only so the failure branch can be tested against the real
 * function rather than a reimplementation of it.
 */
export type X402SettlementsRead =
  | { ok: true; rows: X402SettlementRecord[] }
  | { ok: false; reason: string }

export async function loadX402SettlementsResult(
  getPoolFn: () => Promise<unknown> = getPool,
): Promise<X402SettlementsRead> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (await getPoolFn()) as any
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS x402_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      const r = await p.query('SELECT data FROM x402_settlements ORDER BY id ASC')
      return { ok: true, rows: r.rows.map((row: { data: X402SettlementRecord }) => row.data) }
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[storage] x402 settlement read failed:', reason)
    return { ok: false, reason }
  }
  try {
    return { ok: true, rows: JSON.parse(readFileSync(X402_SETTLEMENTS_FILE, 'utf8')) as X402SettlementRecord[] }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, rows: [] }
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[storage] x402 settlement file unreadable:', reason)
    return { ok: false, reason }
  }
}

/** Load the retained x402-3009 settlement records, oldest first.
 *
 *  Never throws, and never says why. This is the REPORTING loader: a database hiccup must
 *  cost a proof page its history, not the service its life. Do NOT use it to feed a spend
 *  guard, because an unreadable log is indistinguishable here from an empty one. Use
 *  `loadX402SettlementsResult` for that. */
export async function loadX402Settlements(): Promise<X402SettlementRecord[]> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS x402_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      const r = await p.query('SELECT data FROM x402_settlements ORDER BY id ASC')
      return r.rows.map((row: { data: X402SettlementRecord }) => row.data)
    }
  } catch (e) {
    console.error('[storage] x402 settlement read failed:', e instanceof Error ? e.message : e)
    return []
  }
  try {
    return JSON.parse(readFileSync(X402_SETTLEMENTS_FILE, 'utf8')) as X402SettlementRecord[]
  } catch {
    return []
  }
}

/** Durably record one settlement attempt, trimming past the cap. Never throws: on this
 *  rail the money has already moved on-chain by the time we get here, so a logging
 *  hiccup must not turn a paid call into an error for the buyer. */
export async function persistX402Settlement(rec: X402SettlementRecord): Promise<void> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS x402_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      await p.query('INSERT INTO x402_settlements (data) VALUES ($1)', [JSON.stringify(rec)])
      await p.query(
        'DELETE FROM x402_settlements WHERE id NOT IN (SELECT id FROM x402_settlements ORDER BY id DESC LIMIT $1)',
        [X402_SETTLEMENTS_CAP],
      )
      return
    }
    let arr: X402SettlementRecord[] = []
    try {
      arr = JSON.parse(readFileSync(X402_SETTLEMENTS_FILE, 'utf8')) as X402SettlementRecord[]
    } catch {
      /* first write */
    }
    arr.push(rec)
    if (arr.length > X402_SETTLEMENTS_CAP) arr = arr.slice(-X402_SETTLEMENTS_CAP)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(X402_SETTLEMENTS_FILE, JSON.stringify(arr))
  } catch (e) {
    console.error('[storage] x402 settlement persist failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * One settlement on the Stellar rail (see x402-stellar/).
 *
 * A THIRD record type, and the reason is the same reason the first two are separate: they
 * record different kinds of evidence, and a union with everything optional would let the
 * weakest provenance render as if it were the strongest.
 *
 *   CeloSettlementRecord    a facilitator receipt. A third party asserts the money moved.
 *   X402SettlementRecord    a chain receipt. We broadcast it, so we hold the log ourselves.
 *   StellarSettlementRecord someone broadcast it, and we read the ledger to confirm.
 *
 * The third is genuinely its own thing. On this rail the broadcaster may be us or it may be
 * OpenZeppelin Channels, and the record says which. What does NOT vary is who decided it
 * settled: `confirmedBy` is always our own read of the transfer event, never the
 * broadcaster's word. That is the field a proof page should show, because it is the one
 * that makes "settled" mean something when a third party moved the money.
 */
export type StellarSettlementRecord = {
  ts: string
  /** 'settled' = we found the transfer event ourselves. 'reverted' = it landed and failed.
   *  'ambiguous' = broadcast but not in the ledger inside the window, which may still land
   *  and so is neither a sale nor a refusal. Only 'settled' is a sale. */
  outcome: 'settled' | 'reverted' | 'ambiguous'
  tool: string
  resource: string
  /** CAIP-2, so stellar:testnet and stellar:pubnet can never be summed into one figure. */
  network: string
  /** The SEP-41 contract that actually moved. A C... StrKey, never a 0x address. */
  asset: string
  assetSymbol: string
  /** 7 on Stellar, not the 6 every EVM USDC uses. Recorded per row so a decimals change
   *  cannot silently reprice history. */
  assetDecimals: number
  /** Base units, exactly as the transfer event reported them. */
  value: string
  amountUsd: number
  baseUsd: number
  payer: string
  payTo: string
  tx?: string
  /** Ledger sequence, the Stellar analogue of a block number. */
  ledger?: number
  explorerUrl?: string
  /** Who assembled the transaction and paid the network fee. 'buyer' means it arrived
   *  already made, which is the vault path: the agent broadcast it and paid for it. */
  broadcaster: 'self' | 'oz' | 'buyer'
  /** Always our own ledger read. Present as a field rather than assumed, so a future path
   *  that trusted a facilitator's word would have to write something else here and would
   *  be visible on the proof page for doing it. */
  confirmedBy: 'soroban-rpc'
  /** What the settlement cost US, in stroops. Stroops and not USD, because a row is a
   *  record of what happened and the USD value of an XLM fee is a thing that keeps
   *  changing after the row is written. It IS priceable: the XLM/USDC order book is on the
   *  ledger we settle on. Pricing belongs to whoever reads the row, at the time they read
   *  it, not baked in here. */
  feeStroops?: string
  /** Present when we broadcast for a third-party payTo rather than for ourselves. */
  facilitatedFor?: string
}

const STELLAR_SETTLEMENTS_FILE = join(DATA_DIR, 'stellar-settlements.json')
export const STELLAR_SETTLEMENTS_CAP = 2000

/**
 * The settlement log, with "empty" and "unreadable" told apart.
 *
 * They used to be the same value, and that was a real fail-open. `feeSpentOnDay` in
 * x402-stellar/settle.ts guards the daily fee budget and documents itself as fail-closed:
 * an unreadable log means we do not know what we have spent, so stop broadcasting. It
 * implemented that by catching a throw. Nothing ever threw, because this function caught
 * its own read error and returned `[]`, which the caller could only read as "nothing spent
 * today". An unreachable Postgres therefore turned the fee ceiling off completely.
 *
 * A missing FILE is still genuinely empty: that is a first run, not a failure. A file that
 * exists and will not parse is unreadable, and says so.
 */
export type StellarSettlementsRead =
  | { ok: true; rows: StellarSettlementRecord[] }
  | { ok: false; reason: string }

/**
 * `getPool` is injectable ONLY so the failure branch below can be tested against the real
 * function rather than a reimplementation of it. Without a seam here the only way to
 * exercise "the database is unreachable" is to have a database that is unreachable, and a
 * guard that spends real money should not be covered by a test nobody runs.
 *
 * The seam is external I/O, not logic: everything that decides `ok` stays under test.
 */
export async function loadStellarSettlementsResult(
  getPoolFn: () => Promise<unknown> = getPool,
): Promise<StellarSettlementsRead> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (await getPoolFn()) as any
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS stellar_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      const r = await p.query('SELECT data FROM stellar_settlements ORDER BY id ASC')
      return { ok: true, rows: r.rows.map((row: { data: StellarSettlementRecord }) => row.data) }
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[storage] stellar settlement read failed:', reason)
    return { ok: false, reason }
  }
  try {
    return { ok: true, rows: JSON.parse(readFileSync(STELLAR_SETTLEMENTS_FILE, 'utf8')) as StellarSettlementRecord[] }
  } catch (e) {
    // ENOENT is a first run and is genuinely empty. Anything else is a file we cannot read.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, rows: [] }
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[storage] stellar settlement file unreadable:', reason)
    return { ok: false, reason }
  }
}

/** Load the retained Stellar settlement records, oldest first. Never throws, for the same
 *  reason loadX402Settlements does not: this is read on the settlement path, and an
 *  exception there is an unhandled rejection that takes the process down.
 *
 *  Lenient by design: an unreadable log reads as empty here. That is correct for display
 *  surfaces such as /api/x402/stellar/proof, where showing nothing beats a 500. It is NOT
 *  correct for a spending guard, and any caller deciding whether to spend money must use
 *  `loadStellarSettlementsResult` instead. */
export async function loadStellarSettlements(): Promise<StellarSettlementRecord[]> {
  const r = await loadStellarSettlementsResult()
  return r.ok ? r.rows : []
}

/** Durably record one settlement attempt, trimming past the cap. Never throws: by the time
 *  we get here the money has already moved, so a logging hiccup must not turn a paid call
 *  into an error for the buyer. */
export async function persistStellarSettlement(rec: StellarSettlementRecord): Promise<void> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS stellar_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      await p.query('INSERT INTO stellar_settlements (data) VALUES ($1)', [JSON.stringify(rec)])
      await p.query(
        'DELETE FROM stellar_settlements WHERE id NOT IN (SELECT id FROM stellar_settlements ORDER BY id DESC LIMIT $1)',
        [STELLAR_SETTLEMENTS_CAP],
      )
      return
    }
    let arr: StellarSettlementRecord[] = []
    try {
      arr = JSON.parse(readFileSync(STELLAR_SETTLEMENTS_FILE, 'utf8')) as StellarSettlementRecord[]
    } catch {
      /* first write */
    }
    arr.push(rec)
    if (arr.length > STELLAR_SETTLEMENTS_CAP) arr = arr.slice(-STELLAR_SETTLEMENTS_CAP)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STELLAR_SETTLEMENTS_FILE, JSON.stringify(arr))
  } catch (e) {
    console.error('[storage] stellar settlement persist failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Native-unit gas spent on a given UTC day across every settlement attempt.
 *
 * The settlement log IS the gas ledger: no second table, and the daily budget the rail
 * enforces is therefore auditable from the same rows a reviewer can already see.
 *
 * Fail-closed: an unreadable log returns GAS_BUDGET_UNKNOWN rather than zero, so the rail
 * stops broadcasting instead of spending against a ceiling it cannot measure.
 */
export const GAS_BUDGET_UNKNOWN = BigInt(Number.MAX_SAFE_INTEGER)

export async function gasSpentOnDay(
  dayIso: string,
  load: () => Promise<X402SettlementsRead> = loadX402SettlementsResult,
): Promise<bigint> {
  let read: X402SettlementsRead
  try {
    read = await load()
  } catch (e) {
    // The loader is documented not to throw, but a guard that spends money may not rely on
    // a docstring. If it ever does, that is still "we cannot read the log".
    console.error('[storage] gas log read threw; treating the daily budget as spent:', e instanceof Error ? e.message : e)
    return GAS_BUDGET_UNKNOWN
  }
  if (!read.ok) {
    console.error('[storage] could not read the gas log; treating the daily budget as spent:', read.reason)
    return GAS_BUDGET_UNKNOWN
  }
  let total = 0n
  for (const r of read.rows) {
    if (!r.gasWei || !r.ts.startsWith(dayIso)) continue
    try {
      total += BigInt(r.gasWei)
    } catch {
      /* a malformed row must not break the budget read */
    }
  }
  return total
}

// Flush pending state on shutdown, then exit (Render sends SIGTERM on redeploy).
process.on('SIGTERM', () => {
  void flush().finally(() => process.exit(0))
})
process.on('beforeExit', () => void flush())
