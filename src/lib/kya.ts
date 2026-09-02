/**
 * KYA (Know Your Agent) status, read the same way on every surface.
 *
 * The backend stores three states, not two: verified, unverified, revoked. The
 * difference between the last two is the difference between "wallet control is not
 * proven yet" and "the attestation this agent had was taken away", which is an
 * incident. Folding revoked into the pending case is how a screen ends up showing a
 * danger signal in a neutral, hopeful word, so the mapping lives here once instead of
 * being re-derived from a ternary on each screen.
 *
 * Each surface keeps its own paint: the profile hero sits on a theme-fixed dark ground
 * and mixes the semantic tokens toward white (.cn-pf2-chip-*), the console card paints
 * from the Badge variants. What they share is the label, the glyph, the tone and the
 * verdict the agent's mark should report, so a fourth state is one row of this table
 * rather than another ternary in two files.
 */
import { BadgeCheck, ShieldQuestion, ShieldX } from 'lucide-react'

/** The KYA states the marketplace actually stores. */
export type KyaStatus = 'verified' | 'unverified' | 'revoked'

/** Semantic tone, never a class: each surface maps it into its own vocabulary. */
export type KyaTone = 'ok' | 'neutral' | 'danger'

export type KyaPresentation = {
  status: KyaStatus
  /** The chip's word. Short enough for a pill, specific enough to be read on its own. */
  label: string
  tone: KyaTone
  /** Distinct silhouettes, so the state survives being read without colour. */
  Icon: typeof BadgeCheck
  /** One sentence saying what the state means, for a title attribute. */
  detail: string
  /** What the agent's mark (the owl) should report alongside the chip. */
  verdict: 'allow' | 'warn' | 'deny'
}

const KYA: Record<KyaStatus, KyaPresentation> = {
  verified: {
    status: 'verified',
    label: 'KYA Verified',
    tone: 'ok',
    Icon: BadgeCheck,
    detail: 'Wallet control is attested in the ValidationRegistry.',
    verdict: 'allow',
  },
  unverified: {
    status: 'unverified',
    label: 'KYA Pending',
    tone: 'neutral',
    Icon: ShieldQuestion,
    detail: 'No KYA attestation yet, so wallet control is not proven.',
    verdict: 'warn',
  },
  revoked: {
    status: 'revoked',
    label: 'KYA Revoked',
    tone: 'danger',
    Icon: ShieldX,
    detail: 'The KYA attestation was revoked. This agent is flagged as an incident.',
    verdict: 'deny',
  },
}

/**
 * Reads a KYA value coming off the backend. An unrecognised value falls back to the
 * not-attested state: an unknown answer must never be presented as an attested one.
 */
export function kyaPresentation(kya: string | null | undefined): KyaPresentation {
  return KYA[kya as KyaStatus] ?? KYA.unverified
}
