/**
 * Durable state storage.
 *
 * When DATABASE_URL is set (production / ephemeral hosts like Render free tier)
 * the whole state is persisted to Postgres as a single JSONB blob. Otherwise it
 * falls back to a local JSON file (dev). Writes are debounced; there is no mock
 * data — an empty store simply starts empty.
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

const SPENT_FILE = join(DATA_DIR, 'spent-payments.json')

/** Load every spent payment hash (lowercase) recorded so far. */
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

// Flush pending state on shutdown, then exit (Render sends SIGTERM on redeploy).
process.on('SIGTERM', () => {
  void flush().finally(() => process.exit(0))
})
process.on('beforeExit', () => void flush())
