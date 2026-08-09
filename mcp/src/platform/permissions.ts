/**
 * Agent payment permissions: velocity/permissions sanitizers, owner updates (with
 * on-chain vault sync), and the live per-agent policy view.
 * Layering: L3 domain module; imports ./core.js, ./vault.js and flat ../ modules only.
 */
import {
  state, save, ownsAgent, pushActivity, dailySpent, nextUtcMidnight,
  type Permissions, type VelocityPolicy, type PlatformAgent,
} from './core.js'
import { syncVaultPolicy, type VaultSyncResult } from './vault.js'

// ── policy / permissions ───────────────────────────────────────────────────────

/** Bounds for the D3 velocity config. A day-long window and a 10k-action ceiling are
 *  already far past any honest agent burst; anything bigger is a typo or an attack. */
const VELOCITY_MAX_ACTIONS = 10_000
const VELOCITY_MAX_WINDOW_MINUTES = 1_440

/**
 * Validate a client-supplied velocity config (D3). Returns:
 *  - a normalized `{ maxActions, windowMinutes }` for a well-formed object,
 *  - `null` for an explicit `null` (the owner clearing the breaker),
 *  - `undefined` for anything malformed (NaN, zero, negative, fractional, out of
 *    bounds, wrong type), which the sanitizer treats as "field not supplied" in line
 *    with its only-well-formed-fields-survive contract.
 * Exported for unit tests: the rejection rules are part of the feature.
 */
export function sanitizeVelocity(v: unknown): VelocityPolicy | null | undefined {
  if (v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) return undefined
  const { maxActions, windowMinutes } = v as { maxActions?: unknown; windowMinutes?: unknown }
  const posInt = (x: unknown, max: number): number | undefined =>
    typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= max ? x : undefined
  const a = posInt(maxActions, VELOCITY_MAX_ACTIONS)
  const w = posInt(windowMinutes, VELOCITY_MAX_WINDOW_MINUTES)
  return a !== undefined && w !== undefined ? { maxActions: a, windowMinutes: w } : undefined
}

/** Sanitize a client-supplied permissions patch: clamp numbers into a sane range (a
 *  1e308 auto-approve line would silently disable human approval), coerce booleans, and
 *  bound the allowlist. Only well-formed fields survive to be merged. */
function sanitizePermissions(partial: Partial<Permissions>): Partial<Permissions> {
  const out: Partial<Permissions> = {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1_000_000, Math.max(0, v)) : undefined)
  if (partial.dailyCapUsd !== undefined) { const n = num(partial.dailyCapUsd); if (n !== undefined) out.dailyCapUsd = n }
  if (partial.autoApproveUnderUsd !== undefined) { const n = num(partial.autoApproveUnderUsd); if (n !== undefined) out.autoApproveUnderUsd = n }
  if (partial.agentToAgent !== undefined) out.agentToAgent = Boolean(partial.agentToAgent)
  if (partial.agentToHuman !== undefined) out.agentToHuman = Boolean(partial.agentToHuman)
  if (partial.frozen !== undefined) out.frozen = Boolean(partial.frozen)
  if (Array.isArray(partial.payeeAllowlist)) {
    out.payeeAllowlist = partial.payeeAllowlist
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 100)
      .map((x) => x.slice(0, 100))
  }
  // D3 velocity: a valid object sets it, an explicit null clears it, garbage is dropped.
  if (partial.velocity !== undefined) {
    const v = sanitizeVelocity(partial.velocity)
    if (v !== undefined) out.velocity = v
  }
  return out
}

export async function updateAgentPermissions(
  agentId: string,
  partial: Partial<Permissions>,
  caller?: string,
): Promise<(PlatformAgent & { vaultSync?: VaultSyncResult }) | { error: string }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  agent.permissions = { ...agent.permissions, ...sanitizePermissions(partial) }
  pushActivity(agent, 'Permissions updated by a human')

  // If the agent has an on-chain policy vault, push the new limits to it so the
  // chain-enforced policy tracks the UI instead of staying frozen at deploy time.
  const vaultSync = agent.vaultAddress ? await syncVaultPolicy(agent) : undefined
  save(state)
  return vaultSync ? { ...agent, vaultSync } : agent
}

/** Live policy view for one agent: limits + today's spend + reset time. */
export function agentPolicy(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  const spent = dailySpent(agent)
  return {
    agentId: agent.id,
    name: agent.name,
    permissions: agent.permissions,
    spentTodayUsd: spent,
    remainingTodayUsd: Math.max(0, agent.permissions.dailyCapUsd - spent),
    resetsAt: nextUtcMidnight(),
  }
}
