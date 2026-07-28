/**
 * Published ERC-8004 reputation attestations (A1). Each row is a REAL on-chain
 * `giveFeedback` tx on the Arc ReputationRegistry, written by the A-Identity oracle
 * validator (a wallet distinct from the agent owner, as ERC-8004 requires). It anchors an
 * agent's deterministic 0-1000 score on-chain so any caller can verify the score instead of
 * trusting our database. Populated by `scripts/publish-reputation.mjs` (the printed record
 * is pasted here after the tx confirms), mirroring how `settlements.ts` records real x402 txs.
 *
 * The tools surface the LATEST attestation per agent; the score itself is always recomputed
 * live, so an attestation is a verifiable snapshot, never the source of truth.
 */
import { ARC_CHAIN } from '../chains/index.js'
export type ReputationAttestation = {
  /** ERC-8004 token id the attestation is about (matches identity.tokenId / onchainAgentId). */
  tokenId: string
  /** Human label, for readability only. */
  agentName?: string
  /** The 0-1000 score at attestation time (raw, our canonical scale). */
  score: number
  /** The 0-100 value actually written on-chain (ERC-8004 convention). */
  score100: number
  /** Registry tag committed with the feedback. */
  tag: string
  chain: string
  registry: string
  /** The oracle validator address that signed the attestation (never the agent owner). */
  validator: string
  txHash: string
  txUrl: string
  /** keccak256 of the score payload, committed on-chain in the feedback. */
  feedbackHash: string
  attestedAt: string
}

/** Real published attestations (append after each `publish-reputation.mjs` run). */
export const ATTESTATIONS: ReputationAttestation[] = [
  {
    tokenId: '849980',
    agentName: 'Meridian',
    score: 542,
    score100: 54,
    tag: 'a-identity:reputation:v1',
    chain: 'arc-testnet',
    registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    validator: '0xee602A161232Aac1436E812676b6626382FC84a9',
    txHash: '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c',
    txUrl: `${ARC_CHAIN.explorer}/tx/0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c`,
    feedbackHash: '0x135f58dd7871de3e006be5611a62050ca7b60d80863455c14ae2543df7e8e813',
    attestedAt: '2026-07-22T01:15:34.932Z',
  },
]

/**
 * The latest on-chain reputation attestation for an agent, matched by ERC-8004 token id.
 * Returns null when the agent has no published attestation (the common case) so the tools
 * simply omit the field rather than implying an anchor that does not exist.
 */
export function getReputationAttestation(tokenId: string | bigint | null | undefined): ReputationAttestation | null {
  if (tokenId === null || tokenId === undefined) return null
  const id = typeof tokenId === 'bigint' ? tokenId.toString() : tokenId.trim().replace(/^#/, '')
  if (!id) return null
  const matches = ATTESTATIONS.filter((a) => a.tokenId === id)
  if (matches.length === 0) return null
  // Latest by attestedAt (ISO strings sort lexicographically in time order).
  return matches.reduce((latest, a) => (a.attestedAt > latest.attestedAt ? a : latest))
}
