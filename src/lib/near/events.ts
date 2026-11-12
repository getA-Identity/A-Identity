/**
 * The vault's events in words: one line per NEP-297 event the vault logged (event.rs), with the
 * tone the page draws it in. Amounts are token units formatted exactly; an event whose fields
 * are not what event.rs writes is still listed, under its raw name, rather than dropped.
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
import { heldReason, type ChainEvent } from './abi.ts'
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
      const source = SOURCE[str(d.source) ?? ''] ?? 'the vault'
      return {
        tone: 'danger',
        title: `Refused ${amount(d.amount)} to ${payee ?? 'a payee'}: ${str(d.reason) ?? 'no reason given'}`,
        detail: `Decided by ${source}${reasons.length ? `; registry reasons: ${reasons.join(', ')}` : ''}. Nothing moved.`,
        account: payee,
      }
    }
    case 'payment_held':
      return {
        tone: 'warn',
        title: `Held ${amount(d.amount)} to ${payee ?? 'a payee'} for the owner (#${str(d.held_id) ?? '?'})`,
        detail: `${heldReason(str(d.reason) ?? '').title}. Nothing moved.`,
        account: payee,
      }
    case 'payment_failed':
      return { tone: 'danger', title: `A payment of ${amount(d.amount)} to ${payee ?? 'a payee'} failed: ${str(d.reason) ?? 'no reason given'}`, detail: 'Nothing moved, and the day\'s budget was given back.', account: payee }
    case 'held_rejected':
      return { tone: 'muted', title: `The owner rejected held payment #${str(d.held_id) ?? '?'}`, detail: null, account: null }
    case 'held_expired':
      return { tone: 'muted', title: `Held payment #${str(d.held_id) ?? '?'} expired and was removed`, detail: null, account: null }
    case 'held_settle_failed':
      return { tone: 'danger', title: `Approving held payment #${str(d.held_id) ?? '?'} failed: ${str(d.reason) ?? 'no reason given'}`, detail: 'Nothing moved. The agent can ask again.', account: payee }
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
