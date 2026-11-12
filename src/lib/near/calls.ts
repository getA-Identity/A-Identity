/**
 * The owner's calls, built as the exact transaction a wallet is handed: the "prepared" half of
 * the repository rule that every write is prepared-or-executed. The page shows this object
 * before the wallet opens, and hands the same object to the wallet, so what the owner reviews
 * is what is signed.
 *
 * The shape is NEAR Connect's FunctionCall action ({ type, params: { methodName, args, gas,
 * deposit } }). Gas is always explicit, because a builder that defaults it to 0 makes a call
 * that cannot run. Deposits follow the contract (near/contracts/agent-spend-policy, lib.rs):
 * every owner method that changes policy or moves money requires exactly 1 yoctoNEAR, which only
 * a full-access key can attach, so a function-call key a wallet created for some site can never
 * make these calls. `freeze` alone attaches nothing: a panic button must work in one click.
 *
 * Gas per method is the NEAR SDK's (near/sdk/src/chain/abi.ts, VAULT_GAS_TGAS), so the console
 * and the SDK quote one number: owner_pay runs the registry check (when the vault has a registry)
 * and the token transfer and gets 100 Tgas, withdraw a token transfer and its callback 50, the
 * two forget calls 100 for up to 50 removals and their events, the rest 30. Unused gas is
 * refunded.
 *
 * Funding is ONE transaction to the token: registration of the vault on the token if it is not
 * registered yet (storage_deposit, the token's own minimum), then ft_transfer_call with 1
 * yoctoNEAR and 100 Tgas, which the vault's ft_on_transfer accepts only from its own token.
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
import { isNearAccountId } from './ids.ts'
import { ONE_YOCTO, tgas, U128_MAX } from './units.ts'

export type FunctionCallAction = {
  type: 'FunctionCall'
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string }
}

export type PreparedTx = {
  /** One line for the review card: what this does, in words. */
  what: string
  /** The contract the transaction is sent to. */
  receiverId: string
  actions: FunctionCallAction[]
}

export const OWNER_GAS_TGAS = { owner_pay: 100, withdraw: 50, forget: 100, default: 30, storage_deposit: 10, ft_transfer_call: 100 } as const

/**
 * MAX_FORGET_BATCH (lib.rs, 0.2.0): most payees one forget call may name, duplicates included.
 * Every removal logs one event line, and a receipt may log at most 16384 bytes; the vault refuses
 * a longer list (BatchTooLarge) before it removes anything, so the page splits it first.
 */
export const FORGET_BATCH_MAX = 50

/**
 * The sentence an approval of a payee's FIRST payment carries (amendment A1). A payee becomes
 * known to the vault once it is paid, so this approval is the last time a payment to it waits
 * for the owner just for being new. With a registry, a WARN still holds and a DENY still refuses.
 */
export function firstPaymentNote(registryId: string | null): string {
  const unless = registryId === null ? '.' : ', unless the registry warns about it (held again) or flags it (refused).'
  return `Approving makes this payee known to the vault: a payee becomes known once paid, so later agent payments to it go through within the limits without waiting for you${unless}`
}

const call = (methodName: string, args: Record<string, unknown>, gasTgas: number, deposit: string): FunctionCallAction => ({
  type: 'FunctionCall',
  params: { methodName, args, gas: tgas(gasTgas), deposit },
})

const units = (amount: bigint): string => {
  if (amount <= 0n || amount > U128_MAX) throw new Error('amount must be above zero and fit a U128')
  return amount.toString()
}

export const prepareFreeze = (vaultId: string): PreparedTx => ({
  what: 'Freeze the vault: every agent payment is refused until you unfreeze it.',
  receiverId: vaultId,
  actions: [call('freeze', {}, OWNER_GAS_TGAS.default, '0')],
})

export const prepareUnfreeze = (vaultId: string): PreparedTx => ({
  what: 'Unfreeze the vault: the policy decides agent payments again.',
  receiverId: vaultId,
  actions: [call('unfreeze', {}, OWNER_GAS_TGAS.default, ONE_YOCTO)],
})

/**
 * `registryId` is the vault's own (get_config) and `firstPayment` says the vault has never paid
 * this payee: both decide what the words can promise, never the call.
 */
export const prepareOwnerPay = (vaultId: string, heldId: string, registryId: string | null, opts: { firstPayment?: boolean } = {}): PreparedTx => ({
  what:
    (registryId === null
      ? `Approve held payment #${heldId}: the vault pays it. It asks no registry, so no verdict is checked first.`
      : `Approve held payment #${heldId}: the vault asks the registry ${registryId} once more, then pays it.`) + (opts.firstPayment ? ` ${firstPaymentNote(registryId)}` : ''),
  receiverId: vaultId,
  actions: [call('owner_pay', { held_id: heldId }, OWNER_GAS_TGAS.owner_pay, ONE_YOCTO)],
})

export const prepareOwnerReject = (vaultId: string, heldId: string): PreparedTx => ({
  what: `Reject held payment #${heldId}: it is dropped and nothing moves.`,
  receiverId: vaultId,
  actions: [call('owner_reject', { held_id: heldId }, OWNER_GAS_TGAS.default, ONE_YOCTO)],
})

export const prepareWithdraw = (vaultId: string, amount: bigint, label: string): PreparedTx => ({
  what: `Withdraw ${label} to the owner. The contract has no other destination.`,
  receiverId: vaultId,
  actions: [call('withdraw', { amount: units(amount) }, OWNER_GAS_TGAS.withdraw, ONE_YOCTO)],
})

export const prepareSetHoldUnknown = (vaultId: string, holdUnknown: boolean): PreparedTx => ({
  what: holdUnknown
    ? 'Hold unknown payees: a first payment to a payee nobody has judged waits for you.'
    : 'Stop holding unknown payees: a payee nobody has judged is paid within the limits.',
  receiverId: vaultId,
  actions: [call('set_hold_unknown', { hold_unknown: holdUnknown }, OWNER_GAS_TGAS.default, ONE_YOCTO)],
})

export const prepareSetPolicy = (vaultId: string, p: { dailyCap: bigint; autoApproveMax: bigint; allowlistEnabled: boolean }): PreparedTx => {
  if (p.dailyCap < 0n || p.dailyCap > U128_MAX || p.autoApproveMax < 0n || p.autoApproveMax > U128_MAX) throw new Error('limits must fit a U128')
  return {
    what: 'Set the daily cap, the per-payment ceiling and the allowlist switch, all in one call.',
    receiverId: vaultId,
    actions: [
      call(
        'set_policy',
        { daily_cap: p.dailyCap.toString(), auto_approve_max: p.autoApproveMax.toString(), allowlist_enabled: p.allowlistEnabled },
        OWNER_GAS_TGAS.default,
        ONE_YOCTO,
      ),
    ],
  }
}

export const prepareSetAllowed = (vaultId: string, payee: string, ok: boolean): PreparedTx => ({
  what: ok ? `Add ${payee} to the allowlist.` : `Remove ${payee} from the allowlist.`,
  receiverId: vaultId,
  actions: [call('set_allowed', { payee, ok }, OWNER_GAS_TGAS.default, ONE_YOCTO)],
})

/**
 * Forget refusal counters (vault 0.2.0 on): `guard` is forget_guard_refusals, the counters of
 * refusals the agent recorded with record_refusal; `registry` is forget_refusals, the registry
 * DENY counts behind refusal_count. Each removal frees the payee's slot under the vault's bound
 * of 100 and its storage stake, and logs the count it had, so the record of what the counter
 * said stays on chain. A payee with no counter is skipped. One transaction per
 * FORGET_BATCH_MAX payees; each needs the owner's signature.
 */
export function prepareForgetCounters(vaultId: string, which: 'guard' | 'registry', payees: readonly string[]): PreparedTx[] {
  const unique = [...new Set(payees)]
  if (unique.length === 0) throw new Error('name at least one payee')
  const bad = unique.find((p) => !isNearAccountId(p))
  if (bad !== undefined) throw new Error(`not a NEAR account id: ${bad}`)
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += FORGET_BATCH_MAX) chunks.push(unique.slice(i, i + FORGET_BATCH_MAX))
  return chunks.map((chunk, i) => {
    const part = chunks.length > 1 ? ` (transaction ${i + 1} of ${chunks.length})` : ''
    const n = `${chunk.length} payee${chunk.length === 1 ? '' : 's'}`
    return {
      what:
        which === 'guard'
          ? `Forget the agent's recorded refusals of ${n}${part}: each counter is removed, its slot under the 100-payee bound freed and its storage stake returned. The log keeps each count.`
          : `Forget the registry refusal counts of ${n}${part}: each counter is removed and its slot under the 100-payee bound freed. The log keeps each count, and no registry verdict changes.`,
      receiverId: vaultId,
      actions: [call(which === 'guard' ? 'forget_guard_refusals' : 'forget_refusals', { payees: chunk }, OWNER_GAS_TGAS.forget, ONE_YOCTO)],
    }
  })
}

/**
 * Fund the vault: one transaction to the TOKEN. `registration` is the token's storage minimum in
 * yoctoNEAR when the vault is not registered on the token yet, and null when it is.
 */
export const prepareFund = (tokenId: string, vaultId: string, amount: bigint, label: string, registration: bigint | null): PreparedTx => ({
  what: registration === null ? `Send ${label} into the vault.` : `Register the vault on the token, then send ${label} into it.`,
  receiverId: tokenId,
  actions: [
    ...(registration === null
      ? []
      : [call('storage_deposit', { account_id: vaultId, registration_only: true }, OWNER_GAS_TGAS.storage_deposit, registration.toString())]),
    call('ft_transfer_call', { receiver_id: vaultId, amount: units(amount), msg: '' }, OWNER_GAS_TGAS.ft_transfer_call, ONE_YOCTO),
  ],
})

/** Total prepaid gas of a prepared transaction, in Tgas, for the review card. */
export function totalTgas(tx: PreparedTx): number {
  return tx.actions.reduce((n, a) => n + Number(BigInt(a.params.gas) / 10n ** 12n), 0)
}

/** Total attached deposit, in yoctoNEAR. */
export function totalDeposit(tx: PreparedTx): bigint {
  return tx.actions.reduce((n, a) => n + BigInt(a.params.deposit), 0n)
}
