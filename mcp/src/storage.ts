/**
 * Durable state storage.
 *
 * When DATABASE_URL is set (production / ephemeral hosts like Render free tier)
 * the whole state is persisted to Postgres as a single JSONB blob. Otherwise it
 * falls back to a local JSON file (dev). Writes are debounced; there is no mock
 * data - an empty store simply starts empty.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const DATA_FILE = join(DATA_DIR, 'platform.json')
const DB_URL = process.env.DATABASE_URL

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any = null

/**
 * TLS options for a remote Postgres.
 *
 * This was `{ rejectUnauthorized: false }`, unconditionally. That does not turn TLS off, it
 * turns off the part of TLS that tells you WHO you are talking to: the connection is still
 * encrypted, and encrypted to whoever answered. Anything that can answer for the database
 * host can present a self-signed certificate and read and rewrite everything that crosses,
 * which for this process is the entire platform state blob: agents, wallets, instructions,
 * spend policy.
 *
 * Verification is now the default. Neon, which is what this deploys against, serves a
 * publicly-trusted certificate, so Node's own CA bundle is enough and no bundled root is
 * needed here.
 *
 * The escape hatch is deliberately explicit and deliberately awkward to set by accident. It
 * exists for a self-hosted Postgres with a private CA, where the honest answer is to point
 * PGSSLROOTCERT at that CA rather than to stop checking. Turning verification off is logged
 * loudly every boot, because a security property nobody is reminded of is one nobody
 * revisits: this file already carried the unsafe setting for months without comment.
 */
export function sslOptions(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const ca = env.PGSSLROOTCERT?.trim()
  if (ca) return { rejectUnauthorized: true, ca: readFileSync(ca, 'utf8') }
  if (env.PGSSL_ALLOW_UNVERIFIED === 'true') {
    console.warn(
      '[storage] PGSSL_ALLOW_UNVERIFIED=true: the database certificate is NOT being checked. ' +
        'The connection is encrypted to whoever answered, which is not the same as encrypted to the database. ' +
        'Point PGSSLROOTCERT at your CA instead, or unset this on any host you did not deliberately choose it for.',
    )
    return { rejectUnauthorized: false }
  }
  return { rejectUnauthorized: true }
}

async function getPool() {
  if (!DB_URL) return null
  if (pool) return pool
  // Variable specifier so tsc doesn't require pg's types at build time.
  const spec = 'pg'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pgMod: any = await import(spec)
  const Pool = pgMod.default?.Pool ?? pgMod.Pool
  const local = DB_URL.includes('localhost') || DB_URL.includes('127.0.0.1')
  pool = new Pool({ connectionString: DB_URL, ssl: local ? false : sslOptions() })
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
  /** The MAXIMUM FEE WE BID, in stroops: the assembled envelope's own fee, and what the
   *  daily budget reserves against. It is deliberately not what we paid. Stellar runs an
   *  auction and charges the clearing fee, so the bid is a ceiling we offer rather than a
   *  price: our first pubnet sale bid 34035 and was charged 23479. Reserving against the
   *  bid is the conservative direction, because it is the most a settlement could cost.
   *  Stroops and not USD, because a row is a record of what happened and the USD value of
   *  an XLM fee keeps changing after the row is written. It IS priceable: the XLM/USDC
   *  order book is on the ledger we settle on. Pricing belongs to whoever reads the row,
   *  at the time they read it, not baked in here. */
  feeStroops?: string
  /** What the LEDGER actually charged, in stroops, read from the transaction result by our
   *  own confirmation. Present only on rows whose confirmation could read it, which is why
   *  it is optional rather than defaulted: rows written before this field existed carry the
   *  bid alone, and a zero here would be a claim about the ledger we cannot make. */
  feeChargedStroops?: string
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

// ── Algorand settlements ─────────────────────────────────────────────────────────────

/** One Algorand x402 settlement attempt. The sibling of StellarSettlementRecord with the
 *  fields that chain actually has: rounds instead of ledgers, an ASA id instead of a
 *  contract address, and a facilitator instead of a broadcaster, because on this rail we
 *  never broadcast - GoPlausible signs the fee payer and submits, and `confirmedBy`
 *  records whether WE read the transfer back before counting it. */
export type AlgorandSettlementRecord = {
  ts: string
  /** 'settled' = our indexer read found the matching transfer. 'ambiguous' = the
   *  facilitator reported submission but we could not read it back inside the window. */
  outcome: 'settled' | 'ambiguous'
  tool: string
  resource: string
  /** Registry CAIP-2 id, so mainnet and testnet can never be summed into one figure. */
  network: string
  /** ASA id as a decimal string, never a 0x address. */
  asset: string
  assetSymbol: string
  /** 6 for Algorand USDC. Recorded per row so a decimals change cannot reprice history. */
  assetDecimals: number
  value: string
  amountUsd: number
  baseUsd: number
  payer: string
  payTo: string
  tx?: string
  /** Confirmed round, the Algorand analogue of a block number. */
  round?: number
  explorerUrl?: string
  /** The facilitator URL that settled the group. */
  facilitator: string
  /** 'algod-indexer' = our own read. 'none' = recorded without confirmation (ambiguous
   *  rows only); a settled row must never carry it. */
  confirmedBy: 'algod-indexer' | 'none'
}

const ALGORAND_SETTLEMENTS_FILE = join(DATA_DIR, 'algorand-settlements.json')
export const ALGORAND_SETTLEMENTS_CAP = 2000

export type AlgorandSettlementsResult =
  | { ok: true; rows: AlgorandSettlementRecord[] }
  | { ok: false; reason: string }

/** Fail-closed loader for the replay guard: an unreadable log must stop a serving, not
 *  read as empty and give one away. */
export async function loadAlgorandSettlementsResult(): Promise<AlgorandSettlementsResult> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS algorand_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      const r = await p.query('SELECT data FROM algorand_settlements ORDER BY id ASC')
      return { ok: true, rows: r.rows.map((row: { data: AlgorandSettlementRecord }) => row.data) }
    }
    if (!existsSync(ALGORAND_SETTLEMENTS_FILE)) return { ok: true, rows: [] }
    return { ok: true, rows: JSON.parse(readFileSync(ALGORAND_SETTLEMENTS_FILE, 'utf8')) as AlgorandSettlementRecord[] }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Lenient loader for display surfaces (the proof route): an unreadable log reads as
 *  empty there, where showing nothing beats a 500. Spending decisions must use
 *  loadAlgorandSettlementsResult instead. */
export async function loadAlgorandSettlements(): Promise<AlgorandSettlementRecord[]> {
  const r = await loadAlgorandSettlementsResult()
  return r.ok ? r.rows : []
}

/** Durably record one settlement attempt, trimming past the cap. Never throws: by the
 *  time we get here the money has already moved. */
export async function persistAlgorandSettlement(rec: AlgorandSettlementRecord): Promise<void> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS algorand_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      await p.query('INSERT INTO algorand_settlements (data) VALUES ($1)', [JSON.stringify(rec)])
      await p.query(
        'DELETE FROM algorand_settlements WHERE id NOT IN (SELECT id FROM algorand_settlements ORDER BY id DESC LIMIT $1)',
        [ALGORAND_SETTLEMENTS_CAP],
      )
      return
    }
    let arr: AlgorandSettlementRecord[] = []
    try {
      arr = JSON.parse(readFileSync(ALGORAND_SETTLEMENTS_FILE, 'utf8')) as AlgorandSettlementRecord[]
    } catch {
      /* first write */
    }
    arr.push(rec)
    if (arr.length > ALGORAND_SETTLEMENTS_CAP) arr = arr.slice(-ALGORAND_SETTLEMENTS_CAP)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(ALGORAND_SETTLEMENTS_FILE, JSON.stringify(arr))
  } catch (e) {
    console.error('[storage] algorand settlement persist failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Native-unit gas spent on a given UTC day across every settlement attempt, on ONE network
 * when `network` is given.
 *
 * The settlement log IS the gas ledger: no second table, and the daily budget the rail
 * enforces is therefore auditable from the same rows a reviewer can already see.
 *
 * Per network because native units are not one currency: wei of ether on Base and wei of
 * USDC on Arc used to be added into a single total, so a day of Arc settlements would have
 * spent Base's ETH budget and the other way round. Without `network` the old all-rows total
 * is kept for callers that only want a count of activity.
 *
 * Fail-closed: an unreadable log returns GAS_BUDGET_UNKNOWN rather than zero, so the rail
 * stops broadcasting instead of spending against a ceiling it cannot measure.
 */
export const GAS_BUDGET_UNKNOWN = BigInt(Number.MAX_SAFE_INTEGER)

export async function gasSpentOnDay(
  dayIso: string,
  load: () => Promise<X402SettlementsRead> = loadX402SettlementsResult,
  network?: string,
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
    if (network && r.network !== network) continue
    try {
      total += BigInt(r.gasWei)
    } catch {
      /* a malformed row must not break the budget read */
    }
  }
  return total
}

/**
 * One settlement on the Circle Gateway batched rail (see x402-gateway/).
 *
 * A fourth record type rather than a reuse of X402SettlementRecord, for the reason that
 * type gives: the two record different KINDS of evidence. That one is a chain receipt we
 * produced by broadcasting. This one is a facilitator credit read back from Gateway's own
 * transfers API: the buyer's funds were locked inside the GatewayWallet and the seller's
 * pending balance was credited, and the on-chain batch that applies the net position
 * lands LATER, once, for many payments at a time. So a row here has two moments, the
 * credit (always, or it is not a row) and the batch (eventually, with a hash), and the
 * outcome vocabulary names both instead of collapsing them into "settled".
 */
export type GatewaySettlementRecord = {
  ts: string
  /** 'credited'    = Gateway's transfers API returned a transfer for this authorization,
   *                  to our payTo, for the price, from the payer: the seller balance holds
   *                  it, the on-chain batch has not landed yet.
   *  'completed'   = the same row after the batch landed; `tx` is the batch transaction.
   *  'failed'      = Gateway reported the transfer failed after crediting it.
   *  'unconfirmed' = settle answered success but no transfer could be read back inside
   *                  the window. NOT served, not revenue, shown rather than hidden. */
  outcome: 'credited' | 'completed' | 'failed' | 'unconfirmed'
  tool: string
  resource: string
  /** CAIP-2 network the payment settles on. */
  network: string
  asset: string
  assetSymbol: string
  assetDecimals: number
  /** Base units, exactly as Gateway's transfer record reported them. */
  value: string
  amountUsd: number
  payer: string
  payTo: string
  /** The EIP-3009 nonce: the key the transfer is read back by, and the key a later
   *  refresh uses to learn the batch hash. */
  authNonce: string
  /** Gateway's transfer id, from the settle response or the read-back. */
  transferId?: string
  /** Gateway's own status word at the time of the last read (received, batched,
   *  confirmed, completed, failed). Kept verbatim so a reader can compare it to ours. */
  gatewayStatus?: string
  /** The on-chain batch transaction, present once Gateway reports it. One hash covers
   *  many payments, so the same value legitimately appears on several rows. */
  tx?: string
  explorerUrl?: string
  /** Always Gateway's transfers API. Present as a field so a future path that trusted the
   *  settle response alone would have to write something else here and be visible. */
  confirmedBy: 'gateway-transfers-api'
  facilitator: string
}

const GATEWAY_SETTLEMENTS_FILE = join(DATA_DIR, 'gateway-settlements.json')
export const GATEWAY_SETTLEMENTS_CAP = 2000

/** Load the retained Gateway settlement records, oldest first. Never throws: this feeds
 *  a proof page, where showing nothing beats a 500. Nothing here guards spending, because
 *  this rail spends nothing per call. */
export async function loadGatewaySettlements(): Promise<GatewaySettlementRecord[]> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS gateway_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      const r = await p.query('SELECT data FROM gateway_settlements ORDER BY id ASC')
      return r.rows.map((row: { data: GatewaySettlementRecord }) => row.data)
    }
  } catch (e) {
    console.error('[storage] gateway settlement read failed:', e instanceof Error ? e.message : e)
    return []
  }
  try {
    return JSON.parse(readFileSync(GATEWAY_SETTLEMENTS_FILE, 'utf8')) as GatewaySettlementRecord[]
  } catch {
    return []
  }
}

/** Durably record one settlement attempt, trimming past the cap. Never throws: by the time
 *  we get here Gateway has already locked the buyer's funds, so a logging hiccup must not
 *  turn a paid call into an error for the buyer. */
export async function persistGatewaySettlement(rec: GatewaySettlementRecord): Promise<void> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS gateway_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      await p.query('INSERT INTO gateway_settlements (data) VALUES ($1)', [JSON.stringify(rec)])
      await p.query(
        'DELETE FROM gateway_settlements WHERE id NOT IN (SELECT id FROM gateway_settlements ORDER BY id DESC LIMIT $1)',
        [GATEWAY_SETTLEMENTS_CAP],
      )
      return
    }
    let arr: GatewaySettlementRecord[] = []
    try {
      arr = JSON.parse(readFileSync(GATEWAY_SETTLEMENTS_FILE, 'utf8')) as GatewaySettlementRecord[]
    } catch {
      /* first write */
    }
    arr.push(rec)
    if (arr.length > GATEWAY_SETTLEMENTS_CAP) arr = arr.slice(-GATEWAY_SETTLEMENTS_CAP)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(GATEWAY_SETTLEMENTS_FILE, JSON.stringify(arr))
  } catch (e) {
    console.error('[storage] gateway settlement persist failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Upgrade a credited row once Gateway reports its batch: outcome, Gateway's status word,
 * the batch hash and its explorer link. Keyed by the authorization nonce because that is
 * the one value both we and Gateway hold for the same payment. Never throws; a refresh
 * that fails leaves the row as it was, which is still true.
 */
export async function updateGatewaySettlement(
  authNonce: string,
  patch: Pick<GatewaySettlementRecord, 'outcome'> & Partial<Pick<GatewaySettlementRecord, 'gatewayStatus' | 'tx' | 'explorerUrl' | 'transferId'>>,
): Promise<void> {
  try {
    const p = await getPool()
    if (p) {
      await p.query('CREATE TABLE IF NOT EXISTS gateway_settlements (id bigserial PRIMARY KEY, data jsonb NOT NULL)')
      await p.query("UPDATE gateway_settlements SET data = data || $2::jsonb WHERE data->>'authNonce' = $1", [authNonce, JSON.stringify(patch)])
      return
    }
    let arr: GatewaySettlementRecord[] = []
    try {
      arr = JSON.parse(readFileSync(GATEWAY_SETTLEMENTS_FILE, 'utf8')) as GatewaySettlementRecord[]
    } catch {
      return
    }
    let touched = false
    for (const r of arr) {
      if (r.authNonce === authNonce) {
        Object.assign(r, patch)
        touched = true
      }
    }
    if (touched) writeFileSync(GATEWAY_SETTLEMENTS_FILE, JSON.stringify(arr))
  } catch (e) {
    console.error('[storage] gateway settlement update failed:', e instanceof Error ? e.message : e)
  }
}

// ── verify-then-pay flows (see verify-then-pay/) ──────────────────────────────────────
//
// One row per paid check bought through POST /api/x402/gateway/verify-then-pay, keyed by the
// check's Gateway authorization nonce, which is also the key the check's settlement row and
// the Arc Acceleration Season report use. A row records what was checked, what the verdict
// was, and what the server prepared; only the server moves it on, and only after reading the
// payment's receipt from the chain itself. Rows are milestone evidence, so there is no cap:
// the Gateway log keeps 2000 rows, this keeps every flow.

/** Where a flow stands. The audit vocabulary (executed, blocked, awaiting_human, abandoned)
 *  plus pending: a verdict that allowed the payment and a receipt nobody has shown us yet. */
export type VtpFlowOutcome = 'pending' | 'executed' | 'blocked' | 'awaiting_human' | 'abandoned'

/** Why it stands there. */
export type VtpFlowDetail =
  | 'agent_will_pay' // ALLOW (or WARN with payOnWarn): pay() was prepared for the operator
  | 'agent_paid' // the vault's Paid(byOwner = false) and the USDC Transfer were read back
  | 'owner_paid' // the same, from ownerPay(): the owner settled it
  | 'deny' // the verdict was DENY; nothing was prepared
  | 'verdict_unusable' // the check was paid but its answer failed our checks; treated as DENY
  | 'verdict_unavailable' // the check was paid and the tool failed after settlement
  | 'verdict_block_unreadable' // the check was paid and answered, but the chain did not answer for its latest block after the verdict, so nothing was prepared
  | 'reverted_onchain' // the prepared call was sent and the vault reverted it
  | 'warn_handoff' // WARN without payOnWarn: ownerPay() was prepared for the owner
  | 'expired' // reserved: a pending flow nobody completed

export type VtpDecision = 'ALLOW' | 'WARN' | 'DENY'

export type VtpFlowRecord = {
  v: 1
  /** The check's authorization nonce, lowercase. The primary key. */
  flowId: string
  /** CAIP-2 network of both the check and the payment. */
  network: string
  createdAt: string
  updatedAt: string
  /** The vault and its two keys as read at check time, lowercase. */
  vault: string
  owner: string
  operator: string
  /** The address checked and the address paid: one address, so the verdict matches the Paid event. */
  payee: string
  payeeAgentId: string | null
  /** The registry's USDC, which the vault's usdc() matched. */
  asset: string
  /** USDC base units (6 decimals) as a decimal string, and the same amount in USD as sent to risk_check. */
  amount: string
  amountUsd: number
  check: {
    authNonce: string
    transferId: string | null
    gatewayOutcome: 'credited' | 'completed'
    payer: string
    /** The price, in the settlement token's base units. */
    value: string
    tool: 'risk_check'
    /** The settlement row's timestamp. */
    checkedAt: string
    /** The latest block the free preflight read before the check was bought. */
    checkedAtBlock: string
    /** The latest block read after the verdict came back, never below checkedAtBlock. A
     *  payment answers this check only when it lands in a later block: a pay() sent while the
     *  check was still running lands after checkedAtBlock too. null when there was no verdict,
     *  or the chain did not answer for its latest block after it; such a flow takes no receipt. */
    verdictBlock: string | null
  }
  verdict: null | {
    decision: VtpDecision | null
    effective: VtpDecision
    risk: string | null
    reasons: string[]
    reputationScore: number | null
    agentId: string | null
    checkedAt: string | null
    /** Set when our own checks overrode the decision; names the check that failed. */
    overriddenBecause?: string
  }
  payOnWarn: boolean
  /** The call the server prepared, built from the request's own inputs. Nothing was signed. */
  prepared: null | { from: string; to: string; data: string; function: 'pay(address,uint256)' | 'ownerPay(address,uint256)'; args: [string, string] }
  outcome: VtpFlowOutcome
  detail: VtpFlowDetail
  /** Present once the server read a receipt that proves what happened. */
  payment?: {
    txHash: string
    blockNumber: string
    /** The payment block's own timestamp, ISO, read from the block whose hash the receipt
     *  names: when the chain says the payment happened, not when the server read it. */
    minedAt: string
    status: 'success' | 'reverted'
    /** From the vault's Paid event, or for a revert from which call was sent. */
    byOwner: boolean | null
    from: string
    to: string | null
    gasUsed: string
    /** Wei, 18 decimals (Arc's gas is native USDC). */
    effectiveGasPrice: string
    /** gasUsed x effectiveGasPrice in USDC, 6 decimals. */
    costUsdc: string
    readBackAt: string
    /** The host the receipt was read from: a registry host, never an env override's URL. */
    readBackFrom: string
    explorerUrl: string
  }
}

const VTP_FLOWS_FILE = join(DATA_DIR, 'vtp-flows.json')

/** The seams a vtp_flows call reads through. Injectable so the failure branches are tested
 *  against these functions rather than a reimplementation of them. */
export type VtpStoreIo = { getPool?: () => Promise<unknown>; file?: string }

export type VtpFlowsRead = { ok: true; rows: VtpFlowRecord[] } | { ok: false; reason: string }
export type VtpFlowRead = { ok: true; row: VtpFlowRecord | null } | { ok: false; reason: string }
export type VtpFlowInsert = { ok: true; inserted: boolean } | { ok: false; reason: string }
export type VtpFlowUpdate =
  | { ok: true; updated: true; row: VtpFlowRecord }
  /** The row is missing, or its outcome had already moved: nothing was written. */
  | { ok: true; updated: false; row: VtpFlowRecord | null }
  | { ok: false; reason: string; conflict?: 'tx_linked' }
export type VtpFlowByTx = { ok: true; flowId: string | null } | { ok: false; reason: string }
/** One vault, payee and amount: the calls that pay them are byte-identical, whichever check
 *  they followed. Addresses lowercase, the amount in base units as a decimal string. */
export type VtpFlowMatch = { vault: string; payee: string; amount: string }

const vtpReady = new WeakSet<object>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function vtpPool(io: VtpStoreIo): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (await (io.getPool ?? getPool)()) as any
  if (!p) return null
  if (!vtpReady.has(p)) {
    await p.query('CREATE TABLE IF NOT EXISTS vtp_flows (flow_id text PRIMARY KEY, data jsonb NOT NULL)')
    // One payment transaction links to at most one flow. Rows without a payment have a NULL
    // key, and NULLs never collide in a unique index.
    await p.query("CREATE UNIQUE INDEX IF NOT EXISTS vtp_flows_payment_tx ON vtp_flows ((data->'payment'->>'txHash'))")
    vtpReady.add(p)
  }
  return p
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The file fallback, with "empty" (no file yet) and "unreadable" told apart. */
function readVtpFile(file: string): VtpFlowsRead {
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(rows)) return { ok: false, reason: `${file} does not hold a list of flows` }
    return { ok: true, rows: rows as VtpFlowRecord[] }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, rows: [] }
    return { ok: false, reason: reasonOf(e) }
  }
}

function writeVtpFile(file: string, rows: VtpFlowRecord[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(rows))
}

/**
 * Every recorded flow, oldest first, with "no flows" and "could not read the flows" told
 * apart. The season report counts from this, and a log it cannot read must say so rather than
 * read as zero flows.
 */
export async function loadVtpFlowsResult(io: VtpStoreIo = {}): Promise<VtpFlowsRead> {
  try {
    const p = await vtpPool(io)
    if (p) {
      const r = await p.query("SELECT data FROM vtp_flows ORDER BY data->>'createdAt' ASC, flow_id ASC")
      return { ok: true, rows: r.rows.map((row: { data: VtpFlowRecord }) => row.data) }
    }
  } catch (e) {
    const reason = reasonOf(e)
    console.error('[storage] vtp flow read failed:', reason)
    return { ok: false, reason }
  }
  const read = readVtpFile(io.file ?? VTP_FLOWS_FILE)
  if (!read.ok) console.error('[storage] vtp flow file unreadable:', read.reason)
  return read
}

/** One flow by id (the check nonce, any case). */
export async function loadVtpFlow(flowId: string, io: VtpStoreIo = {}): Promise<VtpFlowRead> {
  const id = flowId.toLowerCase()
  try {
    const p = await vtpPool(io)
    if (p) {
      const r = await p.query('SELECT data FROM vtp_flows WHERE flow_id = $1', [id])
      return { ok: true, row: (r.rows[0]?.data as VtpFlowRecord | undefined) ?? null }
    }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
  const read = readVtpFile(io.file ?? VTP_FLOWS_FILE)
  if (!read.ok) return read
  return { ok: true, row: read.rows.find((r) => r.flowId === id) ?? null }
}

/** The flow a payment transaction is already linked to, if any. */
export async function findVtpFlowByTx(txHash: string, io: VtpStoreIo = {}): Promise<VtpFlowByTx> {
  const hash = txHash.toLowerCase()
  try {
    const p = await vtpPool(io)
    if (p) {
      const r = await p.query("SELECT flow_id FROM vtp_flows WHERE data->'payment'->>'txHash' = $1 LIMIT 1", [hash])
      return { ok: true, flowId: (r.rows[0]?.flow_id as string | undefined) ?? null }
    }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
  const read = readVtpFile(io.file ?? VTP_FLOWS_FILE)
  if (!read.ok) return read
  return { ok: true, flowId: read.rows.find((r) => r.payment?.txHash === hash)?.flowId ?? null }
}

const OPEN_OUTCOMES: VtpFlowOutcome[] = ['pending', 'awaiting_human']

/**
 * The flows on one vault, payee and amount that are still open (pending, or waiting for the
 * owner), oldest first: every check a payment on that vault, payee and amount could answer.
 * The receipt route reads these to decide which one a payment answers, so a log it cannot
 * read is an error and never an empty list. Never throws.
 */
export async function loadOpenVtpFlows(match: VtpFlowMatch, io: VtpStoreIo = {}): Promise<VtpFlowsRead> {
  const want = { vault: match.vault.toLowerCase(), payee: match.payee.toLowerCase(), amount: match.amount }
  try {
    const p = await vtpPool(io)
    if (p) {
      const r = await p.query(
        "SELECT data FROM vtp_flows WHERE data->>'vault' = $1 AND data->>'payee' = $2 AND data->>'amount' = $3 AND data->>'outcome' = ANY($4::text[]) ORDER BY data->>'createdAt' ASC, flow_id ASC",
        [want.vault, want.payee, want.amount, OPEN_OUTCOMES],
      )
      return { ok: true, rows: r.rows.map((row: { data: VtpFlowRecord }) => row.data) }
    }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
  const read = readVtpFile(io.file ?? VTP_FLOWS_FILE)
  if (!read.ok) return read
  return {
    ok: true,
    rows: read.rows.filter((r) => r.vault === want.vault && r.payee === want.payee && r.amount === want.amount && OPEN_OUTCOMES.includes(r.outcome)),
  }
}

/**
 * Write a flow once. Insert-only: a row that already exists is never overwritten, so a second
 * request for the same check cannot rewrite what the first one recorded. Never throws; a
 * failure is returned, because the check has already been paid by the time this runs and the
 * caller has to be told the record is missing rather than handed an error.
 */
export async function persistVtpFlow(rec: VtpFlowRecord, io: VtpStoreIo = {}): Promise<VtpFlowInsert> {
  const row: VtpFlowRecord = { ...rec, flowId: rec.flowId.toLowerCase() }
  try {
    const p = await vtpPool(io)
    if (p) {
      const r = await p.query('INSERT INTO vtp_flows (flow_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (flow_id) DO NOTHING RETURNING flow_id', [
        row.flowId,
        JSON.stringify(row),
      ])
      return { ok: true, inserted: r.rows.length === 1 }
    }
    const file = io.file ?? VTP_FLOWS_FILE
    const read = readVtpFile(file)
    if (!read.ok) return read
    if (read.rows.some((r) => r.flowId === row.flowId)) return { ok: true, inserted: false }
    writeVtpFile(file, [...read.rows, row])
    return { ok: true, inserted: true }
  } catch (e) {
    const reason = reasonOf(e)
    console.error('[storage] vtp flow persist failed:', reason)
    return { ok: false, reason }
  }
}

/**
 * Move a flow on, compare-and-set: the patch lands only while the row's outcome is one of
 * `fromOutcomes`, so two receipts racing for one flow cannot both win, and a flow that
 * already ended stays ended. A payment transaction already linked to another flow is refused
 * (the unique index in Postgres, a scan in the file fallback). Never throws.
 */
export async function updateVtpFlow(
  flowId: string,
  patch: Partial<Pick<VtpFlowRecord, 'outcome' | 'detail' | 'payment' | 'updatedAt'>>,
  fromOutcomes: VtpFlowOutcome[],
  io: VtpStoreIo = {},
): Promise<VtpFlowUpdate> {
  const id = flowId.toLowerCase()
  const clean = patch.payment ? { ...patch, payment: { ...patch.payment, txHash: patch.payment.txHash.toLowerCase() } } : patch
  try {
    const p = await vtpPool(io)
    if (p) {
      try {
        const r = await p.query(
          "UPDATE vtp_flows SET data = data || $2::jsonb WHERE flow_id = $1 AND data->>'outcome' = ANY($3::text[]) RETURNING data",
          [id, JSON.stringify(clean), fromOutcomes],
        )
        if (r.rows.length === 1) return { ok: true, updated: true, row: r.rows[0].data as VtpFlowRecord }
      } catch (e) {
        if ((e as { code?: string })?.code === '23505') return { ok: false, reason: 'that transaction is already linked to another flow', conflict: 'tx_linked' }
        throw e
      }
      const cur = await p.query('SELECT data FROM vtp_flows WHERE flow_id = $1', [id])
      return { ok: true, updated: false, row: (cur.rows[0]?.data as VtpFlowRecord | undefined) ?? null }
    }
    const file = io.file ?? VTP_FLOWS_FILE
    const read = readVtpFile(file)
    if (!read.ok) return read
    const at = read.rows.findIndex((r) => r.flowId === id)
    if (at < 0) return { ok: true, updated: false, row: null }
    const cur = read.rows[at]
    if (!fromOutcomes.includes(cur.outcome)) return { ok: true, updated: false, row: cur }
    const tx = clean.payment?.txHash
    if (tx && read.rows.some((r, i) => i !== at && r.payment?.txHash === tx)) {
      return { ok: false, reason: 'that transaction is already linked to another flow', conflict: 'tx_linked' }
    }
    const next: VtpFlowRecord = { ...cur, ...clean }
    const rows = read.rows.slice()
    rows[at] = next
    writeVtpFile(file, rows)
    return { ok: true, updated: true, row: next }
  } catch (e) {
    const reason = reasonOf(e)
    console.error('[storage] vtp flow update failed:', reason)
    return { ok: false, reason }
  }
}

// Flush pending state on shutdown, then exit (Render sends SIGTERM on redeploy).
process.on('SIGTERM', () => {
  void flush().finally(() => process.exit(0))
})
process.on('beforeExit', () => void flush())
