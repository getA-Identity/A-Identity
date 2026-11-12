/**
 * The vault's error names in words, for the lines where the page shows one: a refused or failed
 * payment in the activity log, an owner transaction the contract refused, an approval the vault
 * declined.
 *
 * On NEAR an error is its name. A refusal of the agent arrives as PayOutcome.reason and in the
 * payment_refused event; everything else is a panic whose failure text is exactly the name
 * (near/contracts/agent-spend-policy/src/error.rs). The list is append-only there and here, in
 * the same order, and near.test.ts holds it to that file. A name this page does not know is
 * shown as it is, with no words, rather than guessed at.
 *
 * Import-free, so near.test.ts can load it through type stripping.
 */

/** Every name, in ABI order (error.rs Error::ALL). */
export const VAULT_ERRORS = [
  'NotOwner',
  'NotAgent',
  'Frozen',
  'SessionKeyExpired',
  'PayeeNotAllowed',
  'AboveAutoApprove',
  'DailyCapExceeded',
  'InvalidAmount',
  'InvalidPayee',
  'MathOverflow',
  'OwnerIsVault',
  'RegistryDeny',
  'RegistryUnavailable',
  'TransferFailed',
  'HeldLimitReached',
  'HeldNotFound',
  'HeldExpired',
  'KeyLimitReached',
  'KeyExists',
  'KeyNotFound',
  'KeyNotRevoked',
  'AllowlistFull',
  'MemoTooLong',
  'RequiresOneYocto',
  'NotCallback',
  'GuardRefusalLimitReached',
  'StorageNotCovered',
  'InitNotAllowed',
  'BatchTooLarge',
] as const

export type VaultErrorName = (typeof VAULT_ERRORS)[number]

const WORDS: Record<VaultErrorName, string> = {
  NotOwner: "Only the vault's owner may make this call.",
  NotAgent:
    'Not an active agent key of this vault: the key is unknown or was revoked (a payment still in flight when its key is revoked is refused this way), or the call was relayed for it, which the vault refuses.',
  Frozen: 'The owner froze the vault: agent payments are refused until it is unfrozen.',
  SessionKeyExpired: "The agent key's expiry has passed; the owner can extend it.",
  PayeeNotAllowed: 'The allowlist is on and this payee is not on it.',
  AboveAutoApprove: 'Above the per-payment ceiling: the agent has to ask the owner for it instead.',
  DailyCapExceeded: "It would take today's spend over the daily cap.",
  InvalidAmount: 'The amount is zero.',
  InvalidPayee: 'The payee is the vault itself or its token.',
  MathOverflow: 'A total or an id would overflow, so the vault refused rather than wrap it.',
  OwnerIsVault: 'A vault cannot be its own owner.',
  RegistryDeny: 'The registry flags this payee, and the vault refuses it even when the owner approves.',
  RegistryUnavailable: 'The registry could not be read, and the vault fails closed: no verdict it can read means no payment.',
  TransferFailed: "The token transfer failed. Nothing moved, and the day's budget was given back.",
  HeldLimitReached: '20 payments already wait for the owner.',
  HeldNotFound: 'No held payment has this id any more: settled, rejected or expired.',
  HeldExpired: "The held payment's 24 hours were up, so the vault removed it.",
  KeyLimitReached: 'The vault already has 5 agent key records, revoked ones included until forgotten.',
  KeyExists: 'A record for this key already exists.',
  KeyNotFound: 'The vault has no record for this key.',
  KeyNotRevoked: 'Revoke the key before forgetting it.',
  AllowlistFull: 'The allowlist already holds 100 payees.',
  MemoTooLong: 'A memo or reason is over 128 bytes, or a key label over 64.',
  RequiresOneYocto: 'Owner calls that change policy or move money need exactly 1 yoctoNEAR attached, which only a full-access key can sign.',
  NotCallback: 'A callback was called directly.',
  GuardRefusalLimitReached:
    '100 payees already have a counter of refusals the agent recorded, so the vault wrote nothing. The owner frees room by forgetting counters.',
  StorageNotCovered:
    "The vault's NEAR above its storage stake is below its 0.01 NEAR headroom, so it wrote nothing. Top the vault up with a plain NEAR transfer.",
  InitNotAllowed: 'Only the vault account itself or its parent account, the one that created it, may initialize it.',
  BatchTooLarge: 'One call may forget the counters of at most 50 payees; nothing was removed. Split the list.',
}

export function isVaultError(name: unknown): name is VaultErrorName {
  return typeof name === 'string' && (VAULT_ERRORS as readonly string[]).includes(name)
}

/** The vault error name in words, or null for anything that is not one (an agent's own text, a token's message). */
export function vaultErrorText(name: string | null | undefined): string | null {
  return isVaultError(name) ? WORDS[name] : null
}
