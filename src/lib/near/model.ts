/**
 * What the live reads mean, as pure functions: whether the agent can pay right now, which keys
 * can sign, and what the vault would do with an agent payment to a given payee.
 *
 * The decision mirrors the contract's own order (near/contracts/agent-spend-policy, policy.rs
 * and the pipeline in lib.rs, amendment A1): Frozen, then the allowlist gate, then the
 * per-payment ceiling and the day's cap (which depend on the amount, so they are stated rather
 * than decided here), then the registry. DENY is refused on chain, an unreadable registry fails
 * closed, WARN is held for the owner, ALLOW pays, and silence pays only a payee the owner listed
 * or the vault has paid before when hold_unknown is on. Everything here is computed in the
 * browser from values read live, and the page says so wherever it shows a prediction.
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
import type { AgentKeyRecord, HoldKind, VerdictRecord } from './abi.ts'
import { AGENT_METHODS, isAgentMethodList } from './abi.ts'
import { firstPaymentNote } from './calls.ts'
import type { PayeeFacts, VaultSnapshot } from './read.ts'
import type { AccessKey } from './rpc.ts'
import { formatGrouped } from './units.ts'

export const SECONDS_PER_DAY = 86_400n

/** The Unix second the vault's UTC day `today` ends, which is when the day's spend resets. */
export function dayResetsAtS(today: bigint): bigint {
  return (today + 1n) * SECONDS_PER_DAY
}

/** A key's expiry: 0 means none, and a key is valid THROUGH its second (expired only when now is past it). */
export function keyExpired(expiresAtS: bigint, nowS: bigint): boolean {
  return expiresAtS !== 0n && nowS > expiresAtS
}

export type KeyRow = {
  publicKey: string
  /** The protocol's access key on the vault account, if there is one. */
  onChain: AccessKey | null
  /** The contract's own record of it (list_agents), if there is one. */
  record: AgentKeyRecord | null
  /** Can this key make an agent payment right now? */
  canPay: boolean
  /** What is notable about it, worst first. Empty for a plain, healthy agent key. */
  notes: { tone: 'danger' | 'warn' | 'muted'; text: string }[]
}

/**
 * Join the account's access keys with the contract's agent records, by public key. A key that
 * can pay needs both: the protocol lets it sign, the contract lets it spend.
 */
export function keyRows(vaultId: string, keys: readonly AccessKey[], agents: readonly AgentKeyRecord[], nowS: bigint): KeyRow[] {
  const ids = [...new Set([...keys.map((k) => k.publicKey), ...agents.map((a) => a.publicKey)])]
  return ids.map((publicKey) => {
    const onChain = keys.find((k) => k.publicKey === publicKey) ?? null
    const record = agents.find((a) => a.publicKey === publicKey) ?? null
    const notes: KeyRow['notes'] = []
    if (onChain?.permission.kind === 'full') {
      notes.push({ tone: 'danger', text: 'Full access: this key can redeploy the contract or delete the account, and nothing in the contract can bound it.' })
    }
    if (onChain?.permission.kind === 'call') {
      const p = onChain.permission
      if (p.receiverId !== vaultId) notes.push({ tone: 'warn', text: `It may call ${p.receiverId}, not this vault.` })
      if (!isAgentMethodList(p.methodNames)) {
        notes.push({
          tone: 'warn',
          text: p.methodNames.length === 0 ? 'It may call ANY method on its receiver.' : `Its methods are not exactly ${AGENT_METHODS.join(', ')}.`,
        })
      }
      if (p.allowanceYocto === null) notes.push({ tone: 'warn', text: 'Unlimited gas allowance: it can burn the vault\'s NEAR on gas.' })
      if (!record) notes.push({ tone: 'warn', text: 'The contract has no record of this key, so it cannot pay: the contract refuses any key it did not add.' })
    }
    if (record && !onChain && !record.revoked) {
      notes.push({ tone: 'warn', text: 'The contract lists it, but the account carries no such key, so it cannot sign.' })
    }
    if (record?.revoked) {
      notes.push(
        onChain
          ? { tone: 'warn', text: 'Revoked in the contract, which refuses it already; the key delete has not landed on the account yet.' }
          : { tone: 'muted', text: 'Revoked and deleted from the account. The record stays for audit.' },
      )
    } else if (record && keyExpired(record.expiresAtS, nowS)) {
      notes.push({ tone: 'warn', text: 'Expired: the contract refuses its payments until the owner sets a new expiry.' })
    } else if (record && record.expiresAtS === 0n) {
      notes.push({ tone: 'danger', text: 'No expiry: this key never runs out on its own.' })
    }
    const canPay =
      Boolean(onChain && record) &&
      onChain?.permission.kind === 'call' &&
      onChain.permission.receiverId === vaultId &&
      !record?.revoked &&
      !keyExpired(record?.expiresAtS ?? 0n, nowS)
    return { publicKey, onChain, record, canPay, notes }
  })
}

export type Tone = 'ok' | 'warn' | 'danger'

/** The registry side of a vault, as one read gave it. */
export type RegistryState = {
  /** The registry the vault asks before every payment, or null when it asks none. */
  registryId: string | null
  /** Whether that account is a live contract: null when there is no registry or it was not read. */
  registryLive: boolean | null
}

/**
 * A registry the vault names that is not a live contract cannot answer, and the vault fails
 * closed on it (RegistryUnavailable): every agent payment AND every owner approval is refused,
 * because owner_pay asks the registry too. Only withdraw still works.
 */
export function registryDown(r: RegistryState): boolean {
  return r.registryId !== null && r.registryLive === false
}

/** The one-sentence answer to "what can my agent do right now?". */
export function vaultHeadline(
  v: RegistryState & {
    frozen: boolean
    payingKeys: number
    remaining: bigint | null
    autoApproveMax: bigint
    decimals: number
    symbol: string
    /** Whether a payee nobody has judged waits for the owner; null when the build does not report it. */
    holdUnknown: boolean | null
  },
): { tone: Tone; title: string; detail: string } {
  const amt = (x: bigint) => `${formatGrouped(x, v.decimals)} ${v.symbol}`
  const down = registryDown(v)
  if (v.frozen) {
    return {
      tone: 'danger',
      title: 'Frozen: the agent cannot pay.',
      detail: down
        ? `Every agent payment is refused on chain until the owner unfreezes the vault. Approving a held payment is refused too, because the registry ${v.registryId} is not a live contract. The owner can still withdraw.`
        : 'Every agent payment is refused on chain until the owner unfreezes the vault. The owner can still approve held payments and withdraw.',
    }
  }
  if (down) {
    return {
      tone: 'danger',
      title: `Every agent payment is refused: the registry ${v.registryId} is not a live contract.`,
      detail:
        'The vault asks that registry before every payment and it cannot answer, so the vault fails closed (RegistryUnavailable). Approving a held payment is refused the same way. Nothing is paid until a registry is deployed there or the owner points the vault at a live one; the owner can still withdraw.',
    }
  }
  if (v.payingKeys === 0) {
    return {
      tone: 'warn',
      title: 'No agent key can pay right now.',
      detail: 'The agent cannot start a payment until the owner adds an agent key or renews an expired one.',
    }
  }
  if (v.remaining === 0n) {
    return {
      tone: 'warn',
      title: "Today's cap is spent: the agent cannot pay again today.",
      detail: 'The cap resets at 00:00 UTC by the chain\'s clock. Payments the agent asks the owner for can still wait in the queue.',
    }
  }
  const room = v.remaining === null ? 'with no daily cap' : `up to ${amt(v.remaining)} more today`
  const ceiling = v.autoApproveMax === 0n ? ', with no per-payment ceiling' : `, at most ${amt(v.autoApproveMax)} per payment`
  if (v.registryId === null) {
    // No registry: the vault decides with no verdict at all (route() goes straight to silence).
    const unknown =
      v.holdUnknown === null
        ? ' This build does not report whether it holds a payee nobody has vouched for.'
        : v.holdUnknown
          ? ' A payee the owner has not listed and the vault has never paid waits for the owner; any other is paid within those limits.'
          : ' Any payee is paid within those limits.'
    return {
      tone: 'warn',
      title: `The agent can pay ${room}${ceiling}, with no registry check.`,
      detail: `This vault asks no registry, so nothing checks a payee on chain before it is paid.${unknown}`,
    }
  }
  const silent =
    v.holdUnknown === null
      ? ' This build does not report what it does with a payee the registry has no verdict on.'
      : v.holdUnknown
        ? ' A payee it has no verdict on waits too, unless the owner listed it or the vault paid it before.'
        : ' A payee it has no verdict on is paid.'
  const rules = `Within those limits, a payee the registry flags is refused on chain and one it warns about waits for the owner.${silent}`
  if (v.registryLive === null) {
    return {
      tone: 'warn',
      title: `The agent can pay ${room}${ceiling}, if its registry answers.`,
      detail: `Whether ${v.registryId} is a live contract was not read, and the vault refuses every payment while it is not. ${rules}`,
    }
  }
  return { tone: 'ok', title: `The agent can pay ${room}${ceiling}.`, detail: rules }
}

/**
 * Whether approving this hold would be the vault's first payment to its payee. That payment is
 * what makes the payee known (amendment A1), so with hold_unknown on, later agent payments to it
 * flow without a hold. Read from the payee's live paid_count and the allowlist when the page has
 * them, else from the hold's kind (unknown_payee: never paid nor listed when it was held). With
 * hold_unknown off, or a build that predates it, being known changes nothing, so it is false.
 */
export function approvalMakesKnown(p: { holdUnknown: boolean | null; listed: boolean; paidCount: number | null; kind: HoldKind | null }): boolean {
  if (p.holdUnknown !== true || p.listed) return false
  if (p.paidCount !== null) return p.paidCount === 0
  return p.kind === 'unknown_payee'
}

/**
 * What approving a held payment (owner_pay) does with this vault's registry, for the approve
 * panel. owner_pay removes the hold before it asks the registry, so an approval the registry
 * refuses drops the hold and pays nothing (held_settle_failed); the agent can ask again.
 * `blocked` is set when the chain is certain to refuse it, so the page offers no signature.
 * `firstPayment` (approvalMakesKnown) adds that the approval makes the payee known.
 */
export function ownerPayNote(r: RegistryState & { payeeDenied: boolean; firstPayment?: boolean }): { blocked: string | null; text: string } {
  const bypass = "It skips the freeze, the ceiling and the cap check, and still counts toward today's spend."
  const known = r.firstPayment ? ` ${firstPaymentNote(r.registryId)}` : ''
  if (r.registryId === null) {
    return { blocked: null, text: `This vault asks no registry, so the approval pays with no verdict check. ${bypass}${known}` }
  }
  if (registryDown(r)) {
    return {
      blocked: `Approving cannot pay now: the vault asks the registry ${r.registryId} first, and it is not a live contract, so the vault would refuse the approval (RegistryUnavailable), drop the hold and pay nothing. Reject it instead, or approve it once that registry answers.`,
      text: '',
    }
  }
  return {
    blocked: null,
    text:
      `The vault asks ${r.registryId} again before paying: a payee flagged DENY since it was held is refused even for you, and the hold is dropped.` +
      (r.payeeDenied ? ' The registry says DENY for this payee right now, so this approval would be refused on chain.' : '') +
      ` ${bypass}${r.payeeDenied ? '' : known}`,
  }
}

/** What the registry read for one payee came to: a record, no verdict, unreadable, or not asked. */
export type VerdictRead = { ok: true; verdict: VerdictRecord | null } | { ok: false } | null

export type Prediction =
  | { kind: 'refused'; code: 'Frozen' | 'PayeeNotAllowed' | 'RegistryDeny' | 'RegistryUnavailable'; text: string }
  | { kind: 'held'; code: 'RegistryWarn' | 'UnknownPayee'; text: string }
  | { kind: 'paid'; text: string }
  | { kind: 'unread'; text: string }

/**
 * What the vault would do now with an agent `pay` to this payee, amount aside: the per-payment
 * ceiling and the day's cap still apply to whatever amount it is.
 */
export function predictAgentPay(p: {
  frozen: boolean
  allowlistEnabled: boolean
  onAllowlist: boolean
  registryId: string | null
  verdict: VerdictRead
  holdUnknown: boolean | null
  paidCount: number | null
}): Prediction {
  if (p.frozen) return { kind: 'refused', code: 'Frozen', text: 'Refused on chain: the vault is frozen.' }
  if (p.allowlistEnabled && !p.onAllowlist) return { kind: 'refused', code: 'PayeeNotAllowed', text: 'Refused on chain: the allowlist is on and this payee is not on it.' }
  if (p.registryId) {
    if (p.verdict === null) return { kind: 'unread', text: 'Not decided here: the registry was not read for this payee.' }
    if (!p.verdict.ok) return { kind: 'refused', code: 'RegistryUnavailable', text: 'Refused on chain: the registry answer is unreadable, and the vault fails closed.' }
    const v = p.verdict.verdict?.verdict
    if (v === 'DENY') return { kind: 'refused', code: 'RegistryDeny', text: 'Refused on chain: the registry says DENY.' }
    if (v === 'WARN') return { kind: 'held', code: 'RegistryWarn', text: 'Held for the owner: the registry warns about this payee.' }
    if (v === 'ALLOW') return { kind: 'paid', text: 'Paid, within the cap and the ceiling: the registry says ALLOW.' }
  }
  // Silence: no verdict, or no registry at all.
  if (p.holdUnknown === false || p.holdUnknown === null) {
    return { kind: 'paid', text: 'Paid, within the cap and the ceiling: nobody has judged this payee, and this vault does not hold unknown payees.' }
  }
  if (p.paidCount === null) return { kind: 'unread', text: 'Not decided here: the vault\'s payment count for this payee was not read.' }
  if (p.onAllowlist) return { kind: 'paid', text: 'Paid, within the cap and the ceiling: the owner listed this payee.' }
  if (p.paidCount > 0) return { kind: 'paid', text: 'Paid, within the cap and the ceiling: this vault has paid this payee before.' }
  return { kind: 'held', code: 'UnknownPayee', text: 'Held for the owner: nobody has judged this payee and the vault has never paid it.' }
}

/** The prediction for one payee of a live vault, from the vault's settings and the payee's own reads. */
export function predictionFor(s: VaultSnapshot, payee: string, f: PayeeFacts | undefined): Prediction {
  return predictAgentPay({
    frozen: s.config.frozen,
    allowlistEnabled: s.config.allowlistEnabled,
    onAllowlist: s.allowlist.includes(payee),
    registryId: s.config.registryId,
    verdict: f ? f.verdict : null,
    holdUnknown: s.config.holdUnknown,
    paidCount: f ? f.paidCount : null,
  })
}

/** Seconds as a short relative phrase: "in 3 h 20 min", "5 min ago". */
export function relativeTime(targetS: bigint, nowS: bigint): string {
  const diff = targetS - nowS
  const abs = diff < 0n ? -diff : diff
  const s = Number(abs)
  const text =
    s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86_400 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`
  return diff < 0n ? `${text} ago` : `in ${text}`
}

/** A Unix second as a UTC date and time, or null when no date can hold it. */
export function utcText(s: bigint): string | null {
  if (s <= 0n || s > 253_402_300_799n) return null
  return `${new Date(Number(s) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`
}
