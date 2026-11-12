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
 * Gas per method is the NEAR SDK's (near/sdk/src/chain/vault.ts, VAULT_GAS_TGAS), so the console
 * and the SDK quote one number: owner_pay runs the registry check (when the vault has a registry)
 * and the token transfer and gets 100 Tgas, withdraw a token transfer and its callback 50, the
 * rest 30. Unused gas is refunded.
 *
 * Funding is ONE transaction to the token: registration of the vault on the token if it is not
 * registered yet (storage_deposit, the token's own minimum), then ft_transfer_call with 1
 * yoctoNEAR and 100 Tgas, which the vault's ft_on_transfer accepts only from its own token.
 *
 * Import-free apart from sibling files, so near.test.ts can load it through type stripping.
 */
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

export const OWNER_GAS_TGAS = { owner_pay: 100, withdraw: 50, default: 30, storage_deposit: 10, ft_transfer_call: 100 } as const

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

/** `registryId` is the vault's own (get_config): it decides what the words can promise, never the call. */
export const prepareOwnerPay = (vaultId: string, heldId: string, registryId: string | null): PreparedTx => ({
  what:
    registryId === null
      ? `Approve held payment #${heldId}: the vault pays it. It asks no registry, so no verdict is checked first.`
      : `Approve held payment #${heldId}: the vault asks the registry ${registryId} once more, then pays it.`,
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
