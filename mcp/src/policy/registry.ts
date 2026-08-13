/**
 * The surface registry: one descriptor per action surface, and the only place a surface
 * is described. Directly modeled on `chains/registry.ts`, for the same reason it worked
 * there: adding a surface should be a data edit plus (at most) one adapter, never a
 * change to the decision core.
 *
 * Status is honest, exactly as chain status is. A `planned` surface has a fixed schema so
 * callers can be written against it, but it can never produce an ALLOW. `bet` is planned
 * deliberately: prediction markets sit behind a much higher regulatory bar, so Phase 7 is
 * schema only, no execution path. See ../../../MULTICHAIN-STRATEGY.md section 1.10.
 */
import type { Surface, SurfaceStatus, ActionKind } from './types.js'

export type SurfaceDescriptor = {
  /** PRIMARY KEY. */
  id: Surface
  name: string
  status: SurfaceStatus
  /** Which policy block this surface reads. */
  policyBlock: 'trade' | 'spend'
  /**
   * Action kinds this surface accepts. An intent whose kind is not listed is rejected,
   * so a caller cannot smuggle a transfer through the trade surface.
   */
  kinds: ActionKind[]
  /** Why this surface exists, and what is honest to say about it today. */
  note: string
}

export const SURFACES: SurfaceDescriptor[] = [
  {
    id: 'trade',
    name: 'Brokerage trading',
    status: 'live',
    policyBlock: 'trade',
    // Every mutating brokerage path, not just orders. `recurring` and `settings` are the
    // two a naive integration misses, and they are exactly how a cap gets evaded.
    kinds: ['order', 'cancel', 'recurring', 'settings', 'transfer', 'document'],
    note: 'Caller-agnostic. Any brokerage client that can preview an action can use it.',
  },
  {
    id: 'spend',
    name: 'Card spending',
    status: 'live',
    policyBlock: 'spend',
    // A card purchase, a subscription, and money moved off the card. No `settings` kind:
    // card configuration lives with the venue, not with us.
    kinds: ['purchase', 'recurring', 'transfer'],
    note: 'Adds merchant, category and per-card control on top of the venue\'s own single limit and approval toggle.',
  },
  {
    id: 'bet',
    name: 'Prediction markets',
    status: 'planned',
    policyBlock: 'trade',
    kinds: ['order'],
    note: 'Phase 7 is schema only by design (CFTC-regulated venue). No execution path.',
  },
]

/**
 * The surface ids as a runtime tuple, so the MCP wire enum and the console tabs derive
 * from the registry instead of restating it. `bet` disappearing from here must change the
 * schema and the UI, not just this file.
 */
export const SURFACE_IDS = SURFACES.map((s) => s.id) as [Surface, ...Surface[]]

const BY_ID = new Map(SURFACES.map((s) => [s.id, s]))

/** Look up a surface. Returns undefined for an unknown id. */
export function getSurface(id: string): SurfaceDescriptor | undefined {
  return BY_ID.get(id as Surface)
}

/** Surfaces wired end to end. */
export function liveSurfaces(): SurfaceDescriptor[] {
  return SURFACES.filter((s) => s.status === 'live')
}

// Fail fast at import time on a malformed registry, same as the chain registry does.
for (const s of SURFACES) {
  if (!s.kinds.length) throw new Error(`Surface ${s.id} declares no action kinds`)
  if (new Set(s.kinds).size !== s.kinds.length) throw new Error(`Surface ${s.id} has duplicate kinds`)
}
