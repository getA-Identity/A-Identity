/**
 * What was bought on /check, kept for this tab (sessionStorage) so a reload or a detour does
 * not lose what was paid for. Storage can be off or full; then the answer is still on screen,
 * it just does not survive a reload.
 */
import type { PaidReport, PaidTool } from '../../lib/algorand/x402pay'

// ---- the detailed report, keyed by the address it is about ----

export type Bought = { report: PaidReport & { checkedAt?: unknown }; tx: string; amountUsd: number }

const boughtKey = (address: string) => `a-identity:check-report:${address}`

/** Fired on window when a report is bought from the Paid checks list, so the report card above can show it too. */
export const REPORT_BOUGHT_EVENT = 'a-identity:check-report-bought'

export function loadBought(address: string): Bought | null {
  try {
    const raw = window.sessionStorage.getItem(boughtKey(address))
    const b = raw ? (JSON.parse(raw) as Bought) : null
    return b && b.report && Array.isArray(b.report.details?.topPayers) && typeof b.tx === 'string' ? b : null
  } catch {
    return null
  }
}

export function saveBought(address: string, b: Bought): void {
  try {
    window.sessionStorage.setItem(boughtKey(address), JSON.stringify(b))
  } catch {
    /* storage can be off; the report is still on screen */
  }
}

// ---- every other paid answer, newest first, per tool ----

export type SavedAnswer = {
  tool: PaidTool
  /** The question it answers, as the person typed it: an id, an address, "3 agents". */
  label: string
  /** The exact body that was paid for. */
  body: string
  /** The whole 200 body, settlement included: what "Show raw answer" shows. */
  raw: Record<string, unknown>
  tx: string
  amountUsd: number
  at: string
}

const answersKey = (tool: PaidTool) => `a-identity:check-paid:${tool}`
const KEEP = 20

function isSaved(x: unknown, tool: PaidTool): x is SavedAnswer {
  const s = x as Partial<SavedAnswer> | null
  return (
    !!s &&
    s.tool === tool &&
    typeof s.label === 'string' &&
    typeof s.body === 'string' &&
    typeof s.tx === 'string' &&
    typeof s.amountUsd === 'number' &&
    typeof s.at === 'string' &&
    !!s.raw &&
    typeof s.raw === 'object'
  )
}

export function loadAnswers(tool: PaidTool): SavedAnswer[] {
  try {
    const raw = window.sessionStorage.getItem(answersKey(tool))
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is SavedAnswer => isSaved(x, tool)) : []
  } catch {
    return []
  }
}

/** The tool's list with `a` in front: newest first, one entry per receipt, the last twenty. */
export const addAnswer = (a: SavedAnswer, current: SavedAnswer[]): SavedAnswer[] => [a, ...current.filter((x) => x.tx !== a.tx)].slice(0, KEEP)

export function storeAnswers(tool: PaidTool, list: SavedAnswer[]): void {
  try {
    window.sessionStorage.setItem(answersKey(tool), JSON.stringify(list))
  } catch {
    /* storage can be off; the answer is still on screen */
  }
}
