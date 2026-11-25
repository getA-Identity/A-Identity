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
    evidence: "A-Identity retired this address on 2026-11-11. It is not A-Identity's, and A-Identity does not vouch for it.",
  }),
  Object.freeze({
    address: '0xf43f43d8aee114a71b164e1f6214bc7625a5742d',
    checksum: '0xF43F43D8aee114a71B164e1f6214BC7625a5742D',
    label: 'the former Celo pay-to',
    retiredOn: '2026-11-11',
    metricCutoff: '2026-11-01T13:01:41Z',
    evidence: "A-Identity retired this address on 2026-11-11. It is not A-Identity's, and A-Identity does not vouch for it.",
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
    ? `${name} names ${r.label} (${shortAddress(r.checksum)}), which A-Identity retired on ${r.retiredOn}. Nothing is ever paid to it: set ${name} to a receiving address A-Identity holds.`
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
    label: 'an address linked to the two addresses A-Identity retired',
    evidence: "It has never been A-Identity's, and A-Identity does not vouch for it.",
  }),
  Object.freeze({
    address: '0xd4a92e6763aae819473a1730aff5d2263180f6e5',
    label: 'an address linked to an address A-Identity retired',
    evidence: "It has never been A-Identity's, and A-Identity does not vouch for it.",
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
