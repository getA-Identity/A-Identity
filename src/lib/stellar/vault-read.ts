/**
 * Live reads of a Stellar (Soroban) AgentSpendPolicy vault, for the console's vault panel.
 *
 * Every read goes through the backend's public endpoints (GET /api/stellar/vault/read and
 * /is-allowed), which answer with the ledger the values were read at and the time the read
 * completed. Both travel with the values all the way to the screen: a number without the
 * ledger it came from is a claim, and a claim is not what this panel is for.
 *
 * A failed read is a result, not an exception. It carries when it failed and why, so the
 * panel can say "Read failed at 14:02:11: the RPC did not answer" instead of a blank or,
 * worse, the previous numbers dressed up as current ones.
 *
 * Nothing here names a contract, a host or a token: the default vaults come from
 * GET /api/stellar/vaults and every explorer or RPC address is derived from src/lib/chains.ts,
 * which is generated from the backend registry.
 */
import { apiFetch, readJson, wakeBackend } from '../api'
import { CHAINS, type Chain } from '../chains'

/** A token amount: base units as an integer string, and the decimal a person reads. */
export type Amount = { raw: string; display: string }

export type VaultRole = 'flagship' | 'wallet-owned' | 'device-passkey' | 'rehearsal'

/** GET /api/stellar/vault/read, 200. */
export type VaultRead = {
  network: string
  chainId: string
  contract: string
  realMoney: boolean
  wasmHash: string
  knownBuild: boolean
  build: string | null
  role: VaultRole | null
  roleLabel: string | null
  owner: string
  ownerKind: 'account' | 'smart-account'
  operator: string
  token: string
  tokenSymbol: string
  decimals: number
  frozen: boolean
  dailyCap: Amount
  spentToday: Amount
  remainingToday: Amount | null
  autoApproveMax: Amount
  allowlistEnabled: boolean
  sessionKeyExpiry: number
  sessionKeyExpired: boolean
  balance: Amount
  day: number
  resetsAt: string
  ledger: number
  readAt: string
  ttl: { liveUntilLedger: number | null; archived: boolean }
  explorer: { contract: string }
  note?: string
}

/** GET /api/stellar/vault/is-allowed, 200. */
export type IsAllowedRead = {
  network: string
  contract: string
  address: string
  allowed: boolean
  allowlistEnabled: boolean
  effective: 'allowed' | 'blocked' | 'not-enforced'
  ledger: number
  readAt: string
}

/**
 * Why a read did not produce values. `bad_request`, `not_found`, `not_a_spend_vault`,
 * `read_failed` and `rate_limited` are the backend's own answers; `waking` and
 * `unreachable` are what this browser saw when the backend itself did not answer.
 */
export type ReadFailureKind =
  | 'bad_request'
  | 'not_found'
  | 'not_a_spend_vault'
  | 'read_failed'
  | 'rate_limited'
  | 'waking'
  | 'unreachable'

export type ReadFailure = { kind: ReadFailureKind; reason: string; at: string; wasmHash?: string }

export type ReadResult<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure }

/** A registry role, as a short name. The backend's roleLabel carries the longer story. */
export const ROLE_NAME: Record<VaultRole, string> = {
  flagship: 'Flagship vault',
  'wallet-owned': 'Wallet-owned vault',
  'device-passkey': 'Device-passkey vault',
  rehearsal: 'Rehearsal vault',
}

/** One row of GET /api/stellar/vaults, the fields this panel needs. */
export type VaultListRow = {
  chain: string
  caip2: string
  network: 'pubnet' | 'testnet'
  contract: string
  label: string
  role?: VaultRole
  roleLabel?: string
  ownerKind?: 'smart-account' | 'account' | null
  live?: { reachable: boolean; ledger?: number; checkedAt?: string; reason?: string }
}

/** The Stellar chains the registry knows, testnet first because that is where owners act. */
export function stellarChains(): Chain[] {
  return CHAINS.filter((c) => c.ecosystem === 'stellar').sort((a, b) => Number(b.testnet) - Number(a.testnet))
}

/** A Stellar chain by CAIP-2 or registry id; null for anything else. Never guessed. */
export function stellarChainFor(network: string | null | undefined): Chain | null {
  if (!network) return null
  return CHAINS.find((c) => c.ecosystem === 'stellar' && (c.caip2 === network || c.id === network)) ?? null
}

/** "testnet" or "pubnet" for a CAIP-2 or registry id, for a sentence. */
export function networkWord(network: string | null | undefined): string {
  const c = stellarChainFor(network)
  if (!c) return network ?? 'an unknown network'
  return c.testnet ? 'testnet' : 'pubnet'
}

/** The explorer page for a transaction, derived from the registry's explorer base. */
export function txExplorerUrl(network: string, hash: string): string | null {
  const base = stellarChainFor(network)?.explorer
  return base ? `${base}/tx/${hash}` : null
}

/** The explorer page for a contract (C...) or an account (G...). */
export function addressExplorerUrl(network: string, address: string): string | null {
  const base = stellarChainFor(network)?.explorer
  if (!base) return null
  return address.startsWith('C') ? `${base}/contract/${address}` : `${base}/account/${address}`
}

/** Where to get Freighter, when the kit did not hand us its own link. */
export const FREIGHTER_URL = 'https://www.freighter.app'

export const CONTRACT_ID = /^C[A-Z2-7]{55}$/
export const ACCOUNT_ID = /^G[A-Z2-7]{55}$/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** How many times a read waits for a cold backend before it reports the backend as down. */
const WAKE_TRIES = 4

/**
 * One public GET, with the backend's own refusals kept apart from a backend that is not up.
 *
 * apiFetch retries any 502, which is right for a sleeping free-tier backend and wrong for a
 * vault read that genuinely failed: the backend answers that with 502 `read_failed`, and
 * retrying it four times would only delay the honest answer by half a minute. So retries
 * are off here and this loop retries only a gateway error that carries no JSON verdict.
 */
async function publicRead<T>(path: string, onWaking?: () => void): Promise<ReadResult<T>> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await apiFetch(path, { retries: 0, timeoutMs: 20_000 })
    } catch (e) {
      // A request that threw already waited out its own timeout, so it gets fewer tries
      // than a fast gateway error before the panel says the backend is unreachable.
      if (attempt < 2) {
        onWaking?.()
        wakeBackend()
        await sleep(2500 * (attempt + 1))
        continue
      }
      return {
        ok: false,
        failure: {
          kind: 'unreachable',
          reason: e instanceof Error && e.name === 'TimeoutError' ? 'the backend did not answer in time' : 'the backend could not be reached',
          at: new Date().toISOString(),
        },
      }
    }
    const body = await readJson<T & { error?: string; reason?: string; at?: string; wasmHash?: string }>(res)
    if (res.ok) return { ok: true, data: body as T }

    const at = typeof body.at === 'string' ? body.at : new Date().toISOString()
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : ''
    if (res.status >= 502 && res.status <= 504 && !body.error) {
      // A gateway error with no verdict in it: the backend is asleep or restarting.
      if (attempt < WAKE_TRIES) {
        onWaking?.()
        wakeBackend()
        await sleep(2500 * (attempt + 1))
        continue
      }
      return { ok: false, failure: { kind: 'waking', reason: 'the backend is waking up (free tier) and did not answer yet', at } }
    }
    if (res.status === 429) return { ok: false, failure: { kind: 'rate_limited', reason: reason || 'too many reads in a short time', at } }
    if (body.error === 'not_found')
      return { ok: false, failure: { kind: 'not_found', reason: reason || 'there is no contract at that address on this network', at } }
    // A 404 without the backend's own verdict is a route this backend does not serve,
    // which is not the same thing as a vault that does not exist.
    if (res.status === 404)
      return { ok: false, failure: { kind: 'read_failed', reason: 'this backend does not serve live vault reads yet', at } }
    if (res.status === 422 || body.error === 'not_a_spend_vault')
      return {
        ok: false,
        failure: {
          kind: 'not_a_spend_vault',
          reason: reason || 'the contract exists but does not answer like an AgentSpendPolicy vault',
          at,
          ...(typeof body.wasmHash === 'string' ? { wasmHash: body.wasmHash } : {}),
        },
      }
    if (res.status === 400 || body.error === 'bad_request')
      return { ok: false, failure: { kind: 'bad_request', reason: reason || 'that network or address is not one we can read', at } }
    return { ok: false, failure: { kind: 'read_failed', reason: reason || `the read failed (HTTP ${res.status})`, at } }
  }
}

/** Read one vault live. */
export function readVault(network: string, contract: string, onWaking?: () => void): Promise<ReadResult<VaultRead>> {
  const q = new URLSearchParams({ network, contract })
  return publicRead<VaultRead>(`/api/stellar/vault/read?${q.toString()}`, onWaking)
}

/** Ask the vault whether one payee passes its allowlist, live. */
export function readIsAllowed(network: string, contract: string, address: string): Promise<ReadResult<IsAllowedRead>> {
  const q = new URLSearchParams({ network, contract, address })
  return publicRead<IsAllowedRead>(`/api/stellar/vault/is-allowed?${q.toString()}`)
}

/** The vaults the registry declares, as rows to pick from. */
export async function listVaults(onWaking?: () => void): Promise<ReadResult<VaultListRow[]>> {
  const r = await publicRead<{ vaults?: VaultListRow[] }>('/api/stellar/vaults', onWaking)
  if (!r.ok) return r
  return { ok: true, data: Array.isArray(r.data.vaults) ? r.data.vaults : [] }
}

/** Plain words for a failed read, by kind. The backend's own reason follows it. */
export const READ_FAILURE_TITLE: Record<ReadFailureKind, string> = {
  bad_request: 'That is not a vault address we can read',
  not_found: 'No contract at that address on this network',
  not_a_spend_vault: 'This contract is not an AgentSpendPolicy vault',
  read_failed: 'Read failed',
  rate_limited: 'Too many reads',
  waking: 'The backend is waking up',
  unreachable: 'The backend could not be reached',
}

/** What to do next after a failed read, by kind. */
export const READ_FAILURE_NEXT: Record<ReadFailureKind, string> = {
  bad_request: 'Check the address: a vault id starts with C and is 56 characters long. Then check the network.',
  not_found: 'Check that the address is a contract id on the network selected. A testnet vault does not exist on pubnet, and testnet resets remove contracts.',
  not_a_spend_vault: 'This panel reads only AgentSpendPolicy vaults. Paste the vault contract id, not the token, the owner or an agent registry.',
  read_failed: 'Press Refresh in a moment. Nothing is shown in place of the values until a read succeeds.',
  rate_limited: 'Wait a few seconds, then press Refresh.',
  waking: 'The free-tier backend takes up to a minute to start. Press Refresh shortly.',
  unreachable: 'Check your connection, then press Refresh.',
}

// --- formatting ---

/** "14:02:11" in the viewer's own clock. */
export function localTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** "Oct 2, 2026, 03:00" in the viewer's own clock. */
export function localDateTime(iso: string | number): string {
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The viewer's IANA time zone and its short offset name, e.g. "Europe/Istanbul, GMT+3". */
export function viewerTimeZone(at: Date = new Date()): string {
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    zone = ''
  }
  let short = ''
  try {
    short =
      new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    short = ''
  }
  if (zone && short && zone !== short) return `${zone}, ${short}`
  return zone || short || 'your local time'
}

/** "in 3h 12m" or "4h 5m ago" for UNIX seconds, against now. */
export function relativeTo(unixSeconds: number, nowMs: number = Date.now()): string {
  const diff = Math.round(unixSeconds - nowMs / 1000)
  const abs = Math.abs(diff)
  const d = Math.floor(abs / 86400)
  const h = Math.floor((abs % 86400) / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(m, abs > 0 ? 1 : 0)}m`
  return diff >= 0 ? `in ${span}` : `${span} ago`
}

/** An amount with its symbol, "10 USDC". */
export function money(a: Amount | null | undefined, symbol: string): string {
  if (!a) return '-'
  return `${a.display} ${symbol}`
}

/** Compare two amounts in base units without floating point. */
export function amountLess(a: Amount, b: Amount): boolean {
  try {
    return BigInt(a.raw) < BigInt(b.raw)
  } catch {
    return Number(a.display) < Number(b.display)
  }
}

export function isZero(a: Amount | null | undefined): boolean {
  if (!a) return true
  try {
    return BigInt(a.raw) === 0n
  } catch {
    return Number(a.display) === 0
  }
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}...${id.slice(-6)}` : id
}

/**
 * A decimal a person typed, in base units, or null when it is not a plain positive-or-zero
 * decimal with at most `decimals` places. No floats: "0.1" is exactly 1000000 at 7 decimals.
 */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/**
 * The owner's question, answered in one sentence: can the agent pay, and how much more today.
 * Amounts are compared in base units, so a balance one stroop short never reads as enough.
 */
export function vaultHeadline(v: VaultRead): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  const sym = v.tokenSymbol || 'USDC'
  if (v.frozen) return { text: 'Frozen: the agent cannot pay anything until the owner unfreezes.', tone: 'danger' }
  if (v.sessionKeyExpired)
    return { text: 'Active, but the session key has expired: the agent cannot pay until the owner extends it.', tone: 'danger' }
  if (isZero(v.balance)) return { text: `Active, but the vault holds no ${sym}: the agent cannot pay anything until it is funded.`, tone: 'warn' }
  if (v.remainingToday) {
    if (isZero(v.remainingToday))
      return { text: "Active, but today's cap is used up: the agent cannot pay more until the reset at 00:00 UTC.", tone: 'warn' }
    if (amountLess(v.balance, v.remainingToday))
      return {
        text: `Active: the agent can spend up to ${money(v.balance, sym)} more today, everything the vault holds (the daily cap alone would allow ${money(v.remainingToday, sym)}).`,
        tone: 'ok',
      }
    return { text: `Active: the agent can spend up to ${money(v.remainingToday, sym)} more today.`, tone: 'ok' }
  }
  return {
    text: `Active: no daily cap is set, so the agent can spend up to the whole balance, ${money(v.balance, sym)}, today.`,
    tone: 'ok',
  }
}

// --- a transaction's receipt, read from the network ---

export type TxPoll =
  | { status: 'settled'; ledger: number }
  | { status: 'failed'; ledger?: number }
  | { status: 'pending' }
  | { status: 'unknown'; reason: string }

/**
 * Ask the network's own RPC whether a submitted transaction made a ledger.
 *
 * Used only after a submit came back pending: the hash is known, the outcome is not. A
 * read-only JSON-RPC getTransaction against the RPC the registry lists for that network.
 * NOT_FOUND means "not in a ledger yet" and is reported as pending, never as failed:
 * a transaction keeps its validity window and may still land.
 */
export async function pollTransaction(network: string, hash: string): Promise<TxPoll> {
  const rpc = stellarChainFor(network)?.rpcUrl
  if (!rpc) return { status: 'unknown', reason: 'no RPC is listed for this network' }
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as { result?: { status?: string; ledger?: number } }
    const status = body.result?.status
    if (status === 'SUCCESS') return { status: 'settled', ledger: Number(body.result?.ledger ?? 0) }
    if (status === 'FAILED') return { status: 'failed', ledger: body.result?.ledger }
    if (status === 'NOT_FOUND') return { status: 'pending' }
    return { status: 'unknown', reason: 'the RPC gave no status' }
  } catch {
    return { status: 'unknown', reason: 'the RPC did not answer' }
  }
}
