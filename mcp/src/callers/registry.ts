/**
 * The caller registry: one descriptor per thing that can ask for a verdict, and the only
 * place a venue is named.
 *
 * Same shape and same reasoning as `chains/registry.ts` and `policy/registry.ts`. Adding a
 * caller is a descriptor plus (at most) an adapter, never a change to the decision core.
 * `policy/engine.test.ts` fails the build if a venue name appears anywhere under `policy/`,
 * so this directory is where those strings have to live, and `callers.test.ts` asserts the
 * other direction: nothing under `policy/` may import this module.
 *
 * ── enforcement is the honest field ─────────────────────────────────────────────────
 *
 * A guardrail is only as strong as the caller's ability to NOT make the call. That differs
 * per caller and pretending otherwise would be the central dishonesty of this product:
 *
 *   process   the caller starts the venue process and gates its writes, so a DENY is a
 *             real veto rather than advice
 *   wrapper   the caller can only decline to make the call it was asked to make. An agent
 *             with another route to the same account is NOT contained
 *   none      nothing stands between the agent and the venue; the verdict is advice plus
 *             a record
 *
 * Status is honest the same way a chain's is: `planned` means the descriptor exists so a
 * caller can be written against it, not that we have run it.
 */
import type { Surface } from '../policy/index.js'
import { robinhoodCryptoAdapter } from './robinhood-crypto.js'
import type { CallerAdapter } from './types.js'

/** What the caller could actually do about a DENY. See the module docstring. */
export type CallerEnforcement = 'process' | 'wrapper' | 'none'

/** Lifecycle of the integration, not of the venue. */
export type CallerStatus = 'live' | 'beta' | 'planned'

export type CallerDescriptor = {
  /** PRIMARY KEY. Matches the `callerId` a client sends and the id an audit row records. */
  id: string
  /** How the integration is referred to in a UI. */
  name: string
  /** Where the money actually goes. Recorded on the audit row. */
  venue: string
  /** Which policy surface this caller's actions belong to. */
  surface: Surface
  status: CallerStatus
  enforcement: CallerEnforcement
  /** Present only when we can translate this caller's payloads today. */
  adapter?: CallerAdapter
  /** What is true about this caller right now, including what it cannot do. */
  note: string
}

export const CALLERS: CallerDescriptor[] = [
  {
    id: 'robinhood-crypto-api',
    name: 'Robinhood Crypto REST API',
    venue: 'Robinhood Crypto',
    surface: 'trade',
    // Beta, not live: the translation is written and unit-tested against the documented
    // payload shape, and we hold no account, so no call of ours has ever reached the venue.
    status: 'beta',
    enforcement: 'wrapper',
    adapter: robinhoodCryptoAdapter,
    note:
      'Order payloads translate today; the venue has no agent MCP, so a client drives the REST API itself. Order-type and field names came from third-party references, not from a live call, so treat a normalization failure as a shape we have not seen rather than as a bad order.',
  },
  {
    id: 'robinhood-mcp-official',
    name: 'Robinhood agent MCP (official)',
    venue: 'Robinhood',
    surface: 'trade',
    status: 'planned',
    // A hosted MCP has no local switch to hold, so the strongest honest claim is that the
    // wrapper can refuse to forward the call it was handed.
    enforcement: 'wrapper',
    note:
      'The sanctioned path and the one the guardrail skill defaults to. No adapter yet: the tool payload shape is not published, and inventing it would put guesses in the audit trail. Enforcement is wrapper-level, so an agent holding its own credentials for the same account is not contained.',
  },
  {
    id: 'robinhood-cli-community',
    name: 'Robinhood community CLI',
    venue: 'Robinhood',
    surface: 'trade',
    status: 'planned',
    // The one caller that can hold a real veto, because the wrapper starts the process and
    // the process gates its own writes behind an env switch.
    enforcement: 'process',
    note:
      'An OPTIONAL caller a user may point the skill at themselves. We neither distribute nor encourage it, and the terms-of-service consequences stay with whoever makes that choice. It is listed because its enforcement is genuinely stronger than the hosted path, and hiding that would misprice the difference.',
  },
]

const BY_ID = new Map(CALLERS.map((c) => [c.id, c]))

/** Look up a caller. Returns undefined for an unknown id. */
export function getCaller(id: string): CallerDescriptor | undefined {
  return BY_ID.get(id)
}

/** Callers that can translate a payload today. */
export function callersWithAdapter(): CallerDescriptor[] {
  return CALLERS.filter((c) => c.adapter !== undefined)
}

/**
 * The registry as plain JSON for a public GET. Deliberately drops the adapter: it is a
 * function, and what a reader needs is which venue, which surface, and how strong the
 * enforcement is.
 */
export function publicCallers(): Array<Omit<CallerDescriptor, 'adapter'> & { normalizes: boolean }> {
  return CALLERS.map(({ adapter, ...rest }) => ({ ...rest, normalizes: adapter !== undefined }))
}

// Fail fast at import time on a malformed registry, same as the chain and surface
// registries do.
for (const c of CALLERS) {
  if (!c.id || !c.venue) throw new Error(`Caller descriptor is missing an id or venue: ${c.id}`)
  if (c.adapter && c.adapter.id !== c.id) {
    throw new Error(`Caller ${c.id} carries adapter "${c.adapter.id}"; the ids must match so an audit row names one thing`)
  }
  if (c.adapter && c.adapter.surface !== c.surface) {
    throw new Error(`Caller ${c.id} declares surface "${c.surface}" but its adapter says "${c.adapter.surface}"`)
  }
}
