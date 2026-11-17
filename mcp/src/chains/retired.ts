/**
 * Retired, compromised addresses. THESE ADDRESSES ARE NOT A-IDENTITY'S: someone else holds their keys.
 *
 * Both come from one seed. An EIP-7702 delegation to the sweeper 0x33bcd6304fc165ef0bb85bd5720bc677baae4ce7,
 * whose only destination is 0xd9D6FE80E840c190dD44fcc21dE58AA5fFd4894B, sits on the former operating wallet on
 * Base and Arbitrum One and on the former Celo pay-to on Celo. The former Celo pay-to has also been delegated on
 * Ethereum since 2026-01-28, to an older sweeper that pays 0xd4a92e6763aae819473a1730aff5d2263180f6e5.
 * A-Identity retired both addresses on 2026-11-11 and controls neither of them alone.
 *
 * They are listed only so the system keeps four protections, each held by a test:
 *   - a vault whose owner is one of them is refused and never counts (owner-not-retired, arc-owner-vault.ts);
 *   - a payment from one never counts as external usage, and from metricCutoff on it opens no counted flow
 *     (the rails' proofs, arc-season.ts, settlement-networks.ts);
 *   - nothing is ever paid to one: a rail or route whose configured payTo is one fails closed as not configured;
 *   - no server signer signs with a key whose address is one (chains/evm/client.ts).
 *
 * Never add a live address here, and never remove one. This module imports nothing, so every layer can read it,
 * and it is the only source file allowed to spell either address out (retired.test.ts holds every other file to
 * that).
 */

export type RetiredAddress = {
  /** Lowercase: the form every comparison uses. */
  readonly address: string
  /** The EIP-55 spelling, for display. */
  readonly checksum: string
  /** What it was, in words that never call it ours. */
  readonly label: string
  /** The UTC day A-Identity stopped using it. */
  readonly retiredOn: string
  /**
   * From this time on, a payment from it opens no counted flow. It is the cutoff the season report has used
   * since 2026-11-01: the sweep on Base at 13:01:41 UTC (tx 0x4ddc0bd7...); the first sweep, on Arbitrum One,
   * came 65 seconds earlier (13:00:36 UTC, tx 0xafa4611a...). Both addresses share it, because both come from
   * the same seed.
   */
  readonly metricCutoff: string
  /** Why it is retired, by transaction. */
  readonly evidence: string
}

export const RETIRED_COMPROMISED: readonly RetiredAddress[] = Object.freeze([
  Object.freeze({
    address: '0xd305607510e0db2c95807173c7a05bea53c1ed36',
    checksum: '0xd305607510E0Db2c95807173c7A05BEA53c1ed36',
    label: 'the former operating wallet',
    retiredOn: '2026-11-11',
    metricCutoff: '2026-11-01T13:01:41Z',
    evidence:
      'Delegated through EIP-7702 to the sweeper 0x33bcd6304fc165ef0bb85bd5720bc677baae4ce7 by type-4 transactions from ' +
      '0xd9D6FE80E840c190dD44fcc21dE58AA5fFd4894B that also took the ETH it held: on Arbitrum One in tx ' +
      '0xafa4611a2b98fbaf8f1c53cdd55ad50774029cf22e810eb8890fd6f3e3ed504b (13:00:36 UTC on 2026-11-01) and on Base in tx ' +
      '0x4ddc0bd7ac976287c16d6b2d39f0395dbd44049ad35d9ac3823e98ea9cb75d28 (13:01:41 UTC the same day). 0.001 ETH sent to it on ' +
      'Arbitrum One was forwarded the same way in tx 0x3df4d8e83d491d4b8581692f5adc64788b0f5dccb975629864a1e8a9f8228f67 (2026-11-10).',
  }),
  Object.freeze({
    address: '0xf43f43d8aee114a71b164e1f6214bc7625a5742d',
    checksum: '0xF43F43D8aee114a71B164e1f6214BC7625a5742D',
    label: 'the former Celo pay-to',
    retiredOn: '2026-11-11',
    metricCutoff: '2026-11-01T13:01:41Z',
    evidence:
      'From the same seed as the former operating wallet. On Celo, tx 0x3ee846c8582dffb2bc91e41ec0c0cb8cc4ba5de184925e002a89487e13444f63 ' +
      '(block 82459492, 2026-11-11) delegated it to the same sweeper and sent its 16.9404493575 CELO to ' +
      '0xd9D6FE80E840c190dD44fcc21dE58AA5fFd4894B. On Ethereum it has been delegated since 2026-01-28 (tx ' +
      '0x513ae029b3bc70aff96ce6724eb428241c778470f3661466e756d33179f85964) to an older sweeper that pays ' +
      '0xd4a92e6763aae819473a1730aff5d2263180f6e5.',
  }),
])

/** The wallet that held the server keys until 2026-11-11. It still holds part of what it registered and deployed then; chains/provenance.ts records which. */
export const FORMER_OPERATING_WALLET: RetiredAddress = RETIRED_COMPROMISED[0]
/** The wallet the Celo rail was paid to until 2026-11-11. */
export const FORMER_CELO_PAYTO: RetiredAddress = RETIRED_COMPROMISED[1]

const lower = (a: string | null | undefined): string => (typeof a === 'string' ? a.trim().toLowerCase() : '')

/** The retired entry for an address, in any case, or null. */
export function retiredEntry(address: string | null | undefined): RetiredAddress | null {
  const a = lower(address)
  return a ? (RETIRED_COMPROMISED.find((r) => r.address === a) ?? null) : null
}

/** Whether an address, in any case, is one A-Identity retired as compromised. */
export function isRetired(address: string | null | undefined): boolean {
  return retiredEntry(address) !== null
}

/** Every retired address, lowercase, in list order. */
export function retiredAddresses(): string[] {
  return RETIRED_COMPROMISED.map((r) => r.address)
}

/** '0xd305...ed36': how published copy names an address without spelling it out. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** What a public list may say of a retired address: the address, what it was, and when it was retired. */
export function retiredPublic(): { address: string; label: string; retiredOn: string }[] {
  return RETIRED_COMPROMISED.map((r) => ({ address: r.address, label: r.label, retiredOn: r.retiredOn }))
}

/**
 * The refusal a rail or route gives for a receiving address that is retired, or null when it is not.
 * `name` is the env var that holds it. The address is not repeated: the retired list already names it.
 */
export function retiredPayToRefusal(name: string, address: string | null | undefined): string | null {
  const r = retiredEntry(address)
  return r
    ? `${name} names ${r.label} (${shortAddress(r.checksum)}), which A-Identity retired on ${r.retiredOn} because someone else holds its key. Nothing is ever paid to it: set ${name} to a receiving address A-Identity holds.`
    : null
}

/**
 * Where the sweepers on the retired addresses send what they take: the attacker's side, never A-Identity's.
 * Kept here so a check of either can answer with the evidence, and never so anything is paid to them.
 */
export type SweepRecipient = { readonly address: string; readonly label: string; readonly evidence: string }

export const SWEEP_RECIPIENTS: readonly SweepRecipient[] = Object.freeze([
  Object.freeze({
    address: '0xd9d6fe80e840c190dd44fcc21de58aa5ffd4894b',
    label: 'the recipient of the sweeper on the retired addresses',
    evidence:
      'The only destination of the sweeper 0x33bcd6304fc165ef0bb85bd5720bc677baae4ce7, hardcoded in its code. It received what was ' +
      'taken from the retired addresses in tx 0xafa4611a2b98fbaf8f1c53cdd55ad50774029cf22e810eb8890fd6f3e3ed504b and ' +
      '0x3df4d8e83d491d4b8581692f5adc64788b0f5dccb975629864a1e8a9f8228f67 on Arbitrum One, ' +
      '0x4ddc0bd7ac976287c16d6b2d39f0395dbd44049ad35d9ac3823e98ea9cb75d28 on Base and ' +
      '0x3ee846c8582dffb2bc91e41ec0c0cb8cc4ba5de184925e002a89487e13444f63 on Celo, and it passes funds on.',
  }),
  Object.freeze({
    address: '0xd4a92e6763aae819473a1730aff5d2263180f6e5',
    label: 'the recipient of an older sweeper on Ethereum',
    evidence:
      'It sent tx 0x513ae029b3bc70aff96ce6724eb428241c778470f3661466e756d33179f85964 on Ethereum on 2026-01-28, which delegated the ' +
      'former Celo pay-to to a sweeper whose receiver() is this address.',
  }),
])

/**
 * What is known against an address, or null: an address A-Identity retired as compromised, or the recipient of the
 * sweepers on them. Either way, paying it hands money to whoever holds those keys.
 */
export function knownCompromised(address: string | null | undefined): { kind: 'retired' | 'sweep-recipient'; label: string; evidence: string } | null {
  const r = retiredEntry(address)
  if (r) return { kind: 'retired', label: r.label, evidence: r.evidence }
  const a = lower(address)
  const s = a ? SWEEP_RECIPIENTS.find((x) => x.address === a) : undefined
  return s ? { kind: 'sweep-recipient', label: s.label, evidence: s.evidence } : null
}
