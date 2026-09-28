/**
 * SideShift, the exchange that turns XLM into ALGO and USDC on Algorand and back. Variable-rate
 * shifts only: SideShift gives a deposit address (plus a memo on Stellar), the deposit sets the
 * amount, and the result is sent to the settle address. Nothing here holds a key.
 */
import type { FetchLike } from '@a-identity/trust-guard'

export const SIDESHIFT = 'https://sideshift.ai/api/v2'
/** A-Identity's SideShift affiliate id: an identifier, not a secret. Override with A_IDENTITY_SIDESHIFT_AFFILIATE. */
export const DEFAULT_AFFILIATE = 'F9l0oNY6I'

export type Coin = 'xlm-stellar' | 'algo-algorand' | 'usdc-algorand'
const PARTS: Record<Coin, [string, string]> = {
  'xlm-stellar': ['xlm', 'stellar'],
  'algo-algorand': ['algo', 'algorand'],
  'usdc-algorand': ['usdc', 'algorand'],
}

export type Pair = { min: number; max: number; rate: number }
export type Shift = { id: string; depositAddress: string; depositMemo: string | null; depositMin: number; status: string }
export type ShiftStatus = { status: string; settleHash: string | null; settleAmount: number | null }

async function call(fetchImpl: FetchLike, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${SIDESHIFT}${path}`, init)
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const err = (json?.error as { message?: string } | undefined)?.message
  if (!res.ok || !json || err) throw new Error(`SideShift: ${err ?? `HTTP ${res.status}`}`)
  return json
}

export async function pair(from: Coin, to: Coin, fetchImpl: FetchLike = fetch): Promise<Pair> {
  const j = await call(fetchImpl, `/pair/${from}/${to}`)
  return { min: Number(j.min), max: Number(j.max), rate: Number(j.rate) }
}

export async function createShift(
  a: { from: Coin; to: Coin; settleAddress: string; refundAddress?: string; affiliateId?: string },
  fetchImpl: FetchLike = fetch,
): Promise<Shift> {
  const [depositCoin, depositNetwork] = PARTS[a.from]
  const [settleCoin, settleNetwork] = PARTS[a.to]
  const body: Record<string, string> = { depositCoin, depositNetwork, settleCoin, settleNetwork, settleAddress: a.settleAddress, affiliateId: a.affiliateId ?? DEFAULT_AFFILIATE }
  if (a.refundAddress) body.refundAddress = a.refundAddress
  const j = await call(fetchImpl, '/shifts/variable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return {
    id: String(j.id),
    depositAddress: String(j.depositAddress),
    depositMemo: typeof j.depositMemo === 'string' ? j.depositMemo : null,
    depositMin: Number(j.depositMin ?? 0),
    status: String(j.status),
  }
}

export async function shiftStatus(id: string, fetchImpl: FetchLike = fetch): Promise<ShiftStatus> {
  const j = await call(fetchImpl, `/shifts/${id}`)
  return {
    status: String(j.status),
    settleHash: typeof j.settleHash === 'string' ? j.settleHash : null,
    settleAmount: j.settleAmount === undefined ? null : Number(j.settleAmount),
  }
}
