/**
 * Guardrail badges (Phase 1.5): the per-surface claim an owner may publish about their
 * own agent.
 *
 * A badge has to be EARNED, not minted. A sticker anyone can mint is worse than no badge
 * at all: it launders an unconfigured agent into a trustworthy-looking one, which is the
 * exact inflated claim the project's honesty gate forbids. So every level here is derived
 * from state we already record, and an agent with refused override attempts cannot display
 * a clean badge.
 *
 * How this differs from the paid `guardrail_check`, so the two do not collide:
 *
 *   badge            OWNER-PUBLISHED, opt-in, one coarse level per surface. A
 *                    self-published claim, like a build-status badge.
 *   guardrail_check  THIRD-PARTY PULL about anyone, paid, the full band set (block rate,
 *                    override attempts, dangling approvals, stability).
 *
 * Same split as the free `trust_preview` against the paid depth: coarse and self-published
 * is the on-ramp, the pull is the product.
 *
 * Surfaces come from the surface registry, so a badge set is a data edit rather than a
 * hardcoded trading/spend enum, and a `planned` surface can only ever read `unavailable`.
 */
import type { AuditEntry } from './audit.js'
import type { SurfaceDescriptor } from './registry.js'
import type { Surface } from './types.js'

export type BadgeLevel =
  /** The surface itself is not live yet, so no claim is possible. */
  | 'unavailable'
  /** No policy covering this surface. */
  | 'none'
  /** The owner set a policy, but nothing has been checked against it yet. */
  | 'configured'
  /** Configured AND decisions recorded against it. */
  | 'enforced'
  /** Enforced, but the operator tried to record a blocked action as executed. */
  | 'enforced_with_flags'

export type Badge = {
  surface: Surface
  level: BadgeLevel
  /** Short human label for the badge face. */
  label: string
  /** One honest sentence about what this level does and does not claim. */
  note: string
}

const LABELS: Record<BadgeLevel, string> = {
  unavailable: 'not available',
  none: 'no policy',
  configured: 'policy set',
  enforced: 'enforced',
  enforced_with_flags: 'enforced, flagged',
}

const NOTES: Record<BadgeLevel, string> = {
  unavailable: 'This surface is not live yet, so no guardrail claim is made.',
  none: 'No policy covers this surface. Nothing is being enforced.',
  configured:
    'A policy exists but no action has been checked against it yet. It is a setting, not yet a track record.',
  enforced:
    'A policy exists and actions have been checked against it. This describes discipline, not performance, and makes no claim about returns.',
  enforced_with_flags:
    'A policy exists and is being checked, but an attempt was made to record a blocked action as executed. The attempt was refused and is disclosed here.',
}

/**
 * Derive the badge set. Pure: everything it needs is passed in.
 *
 * `policyConfigured` comes from the stored policy (did the owner ever set rules), and the
 * entries are that agent's decision trail.
 */
export function deriveBadges(input: {
  surfaces: SurfaceDescriptor[]
  policyConfigured: boolean
  entries: AuditEntry[]
}): Badge[] {
  const { surfaces, policyConfigured, entries } = input

  return surfaces.map((s) => {
    let level: BadgeLevel
    if (s.status !== 'live') {
      level = 'unavailable'
    } else if (!policyConfigured) {
      level = 'none'
    } else {
      // Count only decisions actually made on THIS surface: a busy trade history must not
      // earn a badge on a surface the agent has never used.
      const onSurface = entries.filter((e) => e.surface === s.id)
      if (onSurface.length === 0) {
        level = 'configured'
      } else {
        const overrides = onSurface.reduce((a, e) => a + (e.overrideAttempts ?? 0), 0)
        level = overrides > 0 ? 'enforced_with_flags' : 'enforced'
      }
    }
    return { surface: s.id, level, label: LABELS[level], note: NOTES[level] }
  })
}

/** Pick one surface's badge out of a set. */
export function badgeFor(badges: Badge[], surface: string): Badge | undefined {
  return badges.find((b) => b.surface === surface)
}

const COLORS: Record<BadgeLevel, string> = {
  unavailable: '#8a8f98',
  none: '#8a8f98',
  configured: '#b8860b',
  enforced: '#059669',
  enforced_with_flags: '#d97706',
}

/** Escape text for safe inclusion in SVG. */
function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/**
 * Render an embeddable SVG badge. Self-contained by necessity: an embedded badge is loaded
 * by third-party pages, so no external font, image or stylesheet may be referenced.
 *
 * Deliberately carries no number: a badge is a coarse claim, and putting a rate or a count
 * on someone's own public page is both a privacy leak and an invitation to read it as a
 * performance score.
 */
export function renderBadgeSvg(badge: Badge, opts: { label?: string } = {}): string {
  const left = esc(opts.label ?? `${badge.surface} guardrails`)
  const right = esc(badge.label)
  // Approximate advance width for the 11px sans stack, which is enough for a badge and
  // avoids shipping font metrics.
  const w = (s: string) => Math.round(s.length * 6.2) + 14
  const lw = w(left)
  const rw = w(right)
  const total = lw + rw
  const color = COLORS[badge.level]

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${left}: ${right}">
  <title>${left}: ${right}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-opacity=".3"/><stop offset="1" stop-opacity=".5"/></linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#3f4550"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14">${left}</text>
    <text x="${lw + rw / 2}" y="14">${right}</text>
  </g>
</svg>`
}
