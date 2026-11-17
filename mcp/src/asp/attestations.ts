/**
 * Published ERC-8004 reputation attestations (A1). Each row is a REAL on-chain
 * `giveFeedback` tx on the Arc ReputationRegistry, written by the A-Identity oracle
 * validator (a wallet distinct from the agent owner, as ERC-8004 requires). It anchors an
 * agent's deterministic 0-1000 score on-chain so any caller can verify the score instead of
 * trusting our database. Populated by `scripts/publish-reputation.mjs` (the printed record
 * is pasted here after the tx confirms), mirroring how `settlements.ts` records real x402 txs.
 *
 * The tools surface the LATEST attestation per agent; the score itself is always recomputed
 * live, so an attestation is a verifiable snapshot, never the source of truth. A row whose
 * feedback the validator later revoked stays here as history and says so (`revoked`, `caveat`),
 * so the tools never present it as a standing anchor.
 */
import { getChainById } from '../chains/index.js'
import { FORMER_OPERATING_WALLET, shortAddress } from '../chains/retired.js'

/** Explorer link derived from the registry, never typed: the same rule provenance.ts
 *  follows, enforced by no-hardcoded-chains.test.ts. */
const txUrlOn = (chainId: string, hash: string): string => `${getChainById(chainId)?.explorer}/tx/${hash}`
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
  /**
   * Set once the validator that wrote the feedback took it back with revokeFeedback: the entry no longer
   * stands on chain (readFeedback answers isRevoked true), so the row is history, never a live anchor of
   * the score. The tools still return it, so a caller sees both transactions; the same revocation is an
   * artifact in chains/provenance.ts.
   */
  revoked?: { txHash: string; txUrl: string; blockNumber: number; revokedOn: string }
  /** Set with `revoked`: the same fact in words, wherever the attestation is shown. */
  caveat?: string
}

/** A revocation our validator sent, with its link derived like every other. */
const revokedIn = (chainId: string, txHash: string, blockNumber: number, revokedOn: string): NonNullable<ReputationAttestation['revoked']> => ({
  txHash,
  txUrl: txUrlOn(chainId, txHash),
  blockNumber,
  revokedOn,
})

/** What every revoked attestation says first: who took it back, when, and in which transaction. */
const revokedLine = (r: NonNullable<ReputationAttestation['revoked']>): string =>
  `Our oracle validator revoked this feedback on ${r.revokedOn} (revokeFeedback, tx ${r.txHash}), so it no longer stands on chain: read it as history, never as a live anchor of the score.`

/**
 * About an agent the former operating wallet still holds (a formerAgent in chains/provenance.ts): our
 * validator wrote it when the agent was ours, and revoked it on 2026-11-17.
 */
const aboutAFormerAgent = (r: NonNullable<ReputationAttestation['revoked']>): string =>
  `${revokedLine(r)} It is about an agent A-Identity registered that is still held by ${shortAddress(FORMER_OPERATING_WALLET.checksum)}, ${FORMER_OPERATING_WALLET.label}, which A-Identity retired on ${FORMER_OPERATING_WALLET.retiredOn} because someone else holds its key, so it is not ours and A-Identity does not vouch for it.`

const MERIDIAN_REVOKED = revokedIn('arc', '0x258a45213695e716fdce2caff60bf32181f2207ef140477e6b3b809be011d6c0', 72685118, '2026-11-17')
const ARBITRUM_1259_REVOKED = revokedIn('arbitrum', '0xa20cbe45f5d856fbac1ad8dfd701c02070a1e94b9925576f8ba5e2c7618d9bdc', 525042197, '2026-11-17')
const BASE_73232_REVOKED = revokedIn('base', '0x8f75a0630fdf317240209e1aeda7c82af697e0d80a9d9740822d03e7cbae5adc', 58653618, '2026-11-17')

/** Real published attestations (append after each `publish-reputation.mjs` run). */
export const ATTESTATIONS: ReputationAttestation[] = [
  {
    tokenId: '849980',
    agentName: 'Meridian',
    score: 542,
    score100: 54,
    tag: 'a-identity:reputation:v1',
    chain: 'arc',
    registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    validator: '0xee602A161232Aac1436E812676b6626382FC84a9',
    txHash: '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c',
    txUrl: txUrlOn('arc', '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c'),
    feedbackHash: '0x135f58dd7871de3e006be5611a62050ca7b60d80863455c14ae2543df7e8e813',
    attestedAt: '2026-07-22T01:15:34.932Z',
    // Meridian moved to the founder's wallet on 2026-11-17, so it is ours again, and 22 blocks
    // later the validator revoked this feedback: no anchor of ours stands for it now.
    revoked: MERIDIAN_REVOKED,
    caveat: `${revokedLine(MERIDIAN_REVOKED)} Arc testnet agent #849980 is A-Identity's again since that day, held by the founder's wallet, but the move cleared its agent wallet, and no reputation anchor of ours stands for it now.`,
  },
  // 2026-08-28: the mainnet wave. The SAME oracle validator as Arc, now writing on the
  // canonical mainnet ReputationRegistry (its giveFeedback selector was located in the
  // implementation bytecode before the first write, never assumed from Arc's). Score 60
  // on all three, and the tag says why: onchain-identity-basis, the +60 identity credit
  // with no platform settlement history bound to these agents. Of the three, only Robinhood
  // Chain agent #0 is still ours (it moved to the founder's wallet on 2026-11-10), and its
  // feedback stands; #1259 and #73232 are still held by the former operating wallet, and the
  // validator revoked their feedback on 2026-11-17, as their caveat says.
  {
    tokenId: '0',
    score: 60,
    score100: 6,
    tag: 'a-identity:reputation:v1:onchain-identity-basis',
    chain: 'rhchain',
    registry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    validator: '0xee602A161232Aac1436E812676b6626382FC84a9',
    txHash: '0xe11d5d0f46a9b08b8fe6c623ad0f35e898a3c2db67937377083253fe6b260979',
    txUrl: txUrlOn('rhchain', '0xe11d5d0f46a9b08b8fe6c623ad0f35e898a3c2db67937377083253fe6b260979'),
    feedbackHash: '0x1802dd36dabd74f2b51669c62154d7d94d6a6140e650240eeecf3cde73d7c205',
    attestedAt: '2026-08-28T00:59:41.915Z',
  },
  {
    tokenId: '1259',
    score: 60,
    score100: 6,
    tag: 'a-identity:reputation:v1:onchain-identity-basis',
    chain: 'arbitrum',
    registry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    validator: '0xee602A161232Aac1436E812676b6626382FC84a9',
    txHash: '0x435a5c62bda28db23505812b9deb93dfce7aff3831e8449a5274fd0e7ecc376a',
    txUrl: txUrlOn('arbitrum', '0x435a5c62bda28db23505812b9deb93dfce7aff3831e8449a5274fd0e7ecc376a'),
    feedbackHash: '0xaa90410b36bd2cc62ff9e99752ac362bb5eee3712320990f0e393c32b98d3f4c',
    attestedAt: '2026-08-28T00:59:50.937Z',
    revoked: ARBITRUM_1259_REVOKED,
    caveat: aboutAFormerAgent(ARBITRUM_1259_REVOKED),
  },
  {
    tokenId: '73232',
    score: 60,
    score100: 6,
    tag: 'a-identity:reputation:v1:onchain-identity-basis',
    chain: 'base',
    registry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    validator: '0xee602A161232Aac1436E812676b6626382FC84a9',
    txHash: '0x4f0295d12dcdc356cc7ac12b8317f1ff07289e4584725895f9b482a2223b2aa6',
    txUrl: txUrlOn('base', '0x4f0295d12dcdc356cc7ac12b8317f1ff07289e4584725895f9b482a2223b2aa6'),
    feedbackHash: '0xa96aed982d5918e9675962945fd28057b94ceff2dc51ac5ef4158d041075f309',
    attestedAt: '2026-08-28T01:00:10.264Z',
    revoked: BASE_73232_REVOKED,
    caveat: aboutAFormerAgent(BASE_73232_REVOKED),
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
