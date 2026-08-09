/**
 * The 0-1000 reputation banding, one copy.
 *
 * Four hand-synced copies of this banding used to live in the routes (Dashboard's
 * gradeOf, Explorer's grade, AgentId's LEVELS, Intro's LADDER), which is how a
 * threshold edited on one screen quietly stops matching the next.
 *
 * Reconciliation: the four copies were two internally consistent pairs, not one
 * drifted set. AgentId's LEVELS (the primary product surface) and Intro's LADDER
 * agreed verbatim on the level ladder (0/100/300/500/900); LEVELS is canonical and
 * is copied here unchanged. Dashboard and Explorer agreed verbatim on the credit
 * grade scale (200/350/500/650/800), which is deliberately a different reading of
 * the same score: a grade answers "how risky is this counterparty now", a level
 * answers "what has this agent unlocked". Both scales live here so neither pair
 * can drift again, and every consumer renders exactly what it rendered before.
 */

export type ReputationLevel = {
  /** Minimum score for the level. */
  threshold: number
  name: string
  /** Milestone row label on the Agent ID screen; empty for the base level. */
  milestone: string
  /** Tooltip copy for the milestone row; empty for the base level. */
  info: string
}

/** The reputation ladder: milestone names, level names, and what each unlocks. */
export const REPUTATION_LEVELS: readonly ReputationLevel[] = [
  { threshold: 0, name: 'Newcomer', milestone: '', info: '' },
  {
    threshold: 100,
    name: 'Verified',
    milestone: 'First verified agent',
    info: 'Reputation 100+. The agent has a verified identity and its first real settlements behind it.',
  },
  {
    threshold: 300,
    name: 'Trusted',
    milestone: 'Trusted agent',
    info: 'Reputation 300+. Counterparties can safely auto-approve small payments from this agent without a manual click.',
  },
  {
    threshold: 500,
    name: 'Established',
    milestone: 'Established agent',
    info: 'Reputation 500+. A settlement track record long enough to justify a raised daily cap.',
  },
  {
    threshold: 900,
    name: 'Elite',
    milestone: 'Elite agent',
    info: 'Reputation 900+. The top autonomy tier: broad limits with minimal supervision.',
  },
]

/** Index into REPUTATION_LEVELS of the highest level the score has reached. */
export function levelIndexOf(score: number): number {
  return REPUTATION_LEVELS.reduce((acc, l, i) => (score >= l.threshold ? i : acc), 0)
}

export type ReputationGrade = { label: string; tier: string }

/** The FICO-style credit grade scale, highest band first. */
export const REPUTATION_GRADES: readonly (ReputationGrade & { min: number })[] = [
  { min: 800, label: 'Excellent', tier: 'AAA' },
  { min: 650, label: 'Strong', tier: 'AA' },
  { min: 500, label: 'Good', tier: 'A' },
  { min: 350, label: 'Fair', tier: 'BBB' },
  { min: 200, label: 'Weak', tier: 'B' },
  { min: 0, label: 'High risk', tier: 'C' },
]

/** Grade for a 0-1000 score. Anything below the lowest floor reads as the lowest band. */
export function gradeOf(score: number): ReputationGrade {
  return REPUTATION_GRADES.find((g) => score >= g.min) ?? REPUTATION_GRADES[REPUTATION_GRADES.length - 1]
}
