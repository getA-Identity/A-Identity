/**
 * The vault's events in words: one line per NEP-297 event the vault logged (event.rs), with the
 * tone the page draws it in. Amounts are token units formatted exactly; an event whose fields
 * are not what event.rs writes is still listed, under its raw name, rather than dropped.
 *
 * A held payment is described from its `kind` (vault 0.2.0 on), what the vault itself saw, and
 * never from its `reason`, which for a request is the agent's own text: that text is quoted as
 * the agent's words. A vault error name is followed by what it means (errors.ts).
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
import { parseHoldKind, readHold, type ChainEvent } from './abi.ts'
import { vaultErrorText } from './errors.ts'
import { formatGrouped, u128 } from './units.ts'

export type EventTone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'

export type EventLine = {
  tone: EventTone
  title: string
  /** A second line, when the event carries more than fits the first. */
  detail: string | null
  /** The account the event is about, for a link. */
  account: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const count = (v: unknown): string => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : 'an unreadable count')

/** "Words." for a vault error name, or nothing for any other text. */
const meaning = (reason: string | null): string => {
  const w = vaultErrorText(reason)
  return w ? ` ${w}` : ''
}

/** Who refused a payment: event.rs RefusalSource. */
const SOURCE: Record<string, string> = {
  policy: "the vault's own policy",
  registry: 'the A-Identity registry',
  agent_guard: "the agent's own guard",
}

export function describeEvent(e: ChainEvent, decimals: number | null, symbol: string): EventLine {
  const d = e.data
  const amount = (v: unknown): string => {
    const n = u128(v)
    if (n === null) return 'an unreadable amount'
    return decimals === null ? `${n.toString()} units` : `${formatGrouped(n, decimals)} ${symbol}`
  }
  const payee = str(d.payee)
  switch (e.event) {
    case 'payment_sent':
      return {
        tone: 'ok',
        title: `Paid ${amount(d.amount)} to ${payee ?? 'a payee'}, ${d.by_owner === true ? 'approved by the owner' : 'by the agent'}`,
        detail: str(d.memo) ? `Memo: ${str(d.memo)}` : null,
        account: payee,
      }
    case 'payment_refused': {
      const reasons = Array.isArray(d.registry_reasons) ? d.registry_reasons.filter((r): r is string => typeof r === 'string') : []
      const source = str(d.source)
      const by = SOURCE[source ?? ''] ?? 'the vault'
      const reason = str(d.reason)
      // A refusal the agent recorded carries its guard's own text, never a vault error name.
      const why = source === 'agent_guard' ? '' : meaning(reason)
      return {
        tone: 'danger',
        title: `Refused ${amount(d.amount)} to ${payee ?? 'a payee'}: ${reason ?? 'no reason given'}`,
        detail: `Decided by ${by}${reasons.length ? `; registry reasons: ${reasons.join(', ')}` : ''}.${why} Nothing moved.`,
        account: payee,
      }
    }
    case 'payment_held': {
      const r = readHold({ kind: parseHoldKind(d.kind), kindText: str(d.kind), reason: str(d.reason) ?? '' })
      const words = r.agentWords
        ? ` The agent wrote, in its own words: "${r.agentWords}".`
        : r.unattributed
          ? ` Reason stored with it: "${r.unattributed}" (this build does not record whether the vault or the agent wrote it).`
          : ''
      return {
        tone: 'warn',
        title: `Held ${amount(d.amount)} to ${payee ?? 'a payee'} for the owner (#${str(d.held_id) ?? '?'}): ${r.label}`,
        detail: `${r.title}.${words} Nothing moved.`,
        account: payee,
      }
    }
    case 'payment_failed':
      return {
        tone: 'danger',
        title: `A payment of ${amount(d.amount)} to ${payee ?? 'a payee'} failed: ${str(d.reason) ?? 'no reason given'}`,
        detail: `Nothing moved, and the day's budget was given back.${str(d.reason) === 'TransferFailed' ? '' : meaning(str(d.reason))}`,
        account: payee,
      }
    case 'held_rejected':
      // owner_reject logs it, and so does revoke_agent_key for each held payment of the key it revokes (0.2.0 on).
      return { tone: 'muted', title: `Held payment #${str(d.held_id) ?? '?'} was dropped by the owner`, detail: 'A rejection, or the revocation of the agent key that asked for it. Nothing moved.', account: null }
    case 'held_expired':
      return { tone: 'muted', title: `Held payment #${str(d.held_id) ?? '?'} expired and was removed`, detail: null, account: null }
    case 'held_settle_failed':
      return {
        tone: 'danger',
        title: `Approving held payment #${str(d.held_id) ?? '?'} failed: ${str(d.reason) ?? 'no reason given'}`,
        detail: `Nothing moved, and the hold is gone.${str(d.reason) === 'TransferFailed' ? '' : meaning(str(d.reason))} The agent can ask again.`,
        account: payee,
      }
    case 'guard_refusals_forgotten':
      return {
        tone: 'muted',
        title: `The owner removed the agent's recorded refusals of ${payee ?? 'a payee'} (the count was ${count(d.count)})`,
        detail: "Its slot under the vault's 100-payee bound is free again. The count was the agent's own word, never a verdict.",
        account: payee,
      }
    case 'refusals_forgotten':
      return {
        tone: 'muted',
        title: `The owner removed the registry refusal count of ${payee ?? 'a payee'} (it was ${count(d.count)})`,
        detail: "Its slot under the vault's 100-payee bound is free again, and this line keeps what the counter said.",
        account: payee,
      }
    case 'frozen_set':
      return d.frozen === true
        ? { tone: 'danger', title: 'The owner froze the vault', detail: 'Every agent payment is refused until it is unfrozen.', account: null }
        : { tone: 'ok', title: 'The owner unfroze the vault', detail: null, account: null }
    case 'policy_updated': {
      const cap = u128(d.daily_cap)
      const ceiling = u128(d.auto_approve_max)
      return {
        tone: 'accent',
        title: 'The owner set the policy',
        detail: `Daily cap ${cap === 0n ? 'none' : amount(d.daily_cap)}, per payment ${ceiling === 0n ? 'no ceiling' : amount(d.auto_approve_max)}, allowlist ${d.allowlist_enabled === true ? 'on' : 'off'}.`,
        account: null,
      }
    }
    case 'allowlist_set':
      return { tone: 'accent', title: `${d.ok === true ? 'Added to' : 'Removed from'} the allowlist: ${payee ?? 'a payee'}`, detail: null, account: payee }
    case 'hold_unknown_set':
      return {
        tone: 'accent',
        title: d.hold_unknown === true ? 'Unknown payees now wait for the owner' : 'Unknown payees are no longer held',
        detail: null,
        account: null,
      }
    case 'registry_set':
      return { tone: 'accent', title: str(d.registry_id) ? `The vault now reads the registry ${str(d.registry_id)}` : 'The vault stopped reading any registry', detail: null, account: str(d.registry_id) }
    case 'deposited':
      return { tone: 'ok', title: `Deposit of ${amount(d.amount)} from ${str(d.sender_id) ?? 'someone'}`, detail: null, account: str(d.sender_id) }
    case 'withdrawn':
      return { tone: 'muted', title: `The owner withdrew ${amount(d.amount)}`, detail: null, account: null }
    case 'withdraw_failed':
      return { tone: 'danger', title: `A withdrawal of ${amount(d.amount)} failed`, detail: 'Nothing moved.', account: null }
    case 'agent_key_added':
      return { tone: 'accent', title: `Agent key added: ${str(d.label) || 'no label'}`, detail: str(d.public_key), account: null }
    case 'agent_key_add_failed':
      return { tone: 'warn', title: 'Adding an agent key failed', detail: str(d.public_key), account: null }
    case 'agent_key_revoked':
      return { tone: 'warn', title: 'The owner revoked an agent key', detail: str(d.public_key), account: null }
    case 'agent_expiry_set':
      return { tone: 'accent', title: 'The owner changed an agent key\'s expiry', detail: str(d.public_key), account: null }
    case 'vault_initialized':
      return { tone: 'muted', title: `Vault created for ${str(d.owner_id) ?? 'its owner'}`, detail: str(d.registry_id) ? `Registry: ${str(d.registry_id)}` : 'No registry', account: str(d.owner_id) }
    default:
      return { tone: 'muted', title: e.event, detail: null, account: null }
  }
}
