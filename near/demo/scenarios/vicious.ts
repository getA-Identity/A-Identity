// A "vicious agent": the agent's own key, used to try everything a hijacked agent would try
// once the guard is out of the way. The key is a function-call access key on the vault account,
// limited to receiver = the vault and methods pay, request_payment and record_refusal, with zero
// deposit. nearcore checks that permission when the transaction is validated, before anything
// executes, so each attempt below is answered by the RPC node with an InvalidTxError and NEVER
// becomes a transaction. The demo records the exact RPC error and labels it "rejected before
// execution, no transaction"; it never presents these as on-chain refusals.
//
// nearcore's order of checks for a function-call key (runtime verifier), after the nonce, the
// balance and the key's allowance: more than one action, or an action that is not a function
// call -> RequiresFullAccess; a deposit -> DepositWithFunctionCall; another receiver ->
// ReceiverMismatch; a method outside the list -> MethodNameMismatch. Each attempt is built so
// that the rule it is named after is the one that fires first, with a small gas figure so the
// allowance check does not fire before it. If another InvalidTxError comes back instead, the
// attempt still never executed; the log names the rule that did fire.
//
// Running these with a FULL-access key would execute them, so attack.ts refuses to run this
// phase unless the loaded agent key is verified on chain to be exactly that function-call key.

import { GAS, ONE_YOCTO } from '../lib/config.ts';
import { fnCall } from '../lib/chain.ts';
import type { TxPlan } from '../lib/chain.ts';
import type { DemoAccounts } from './accounts.ts';

export type ForbiddenRule = 'MethodNameMismatch' | 'DepositWithFunctionCall' | 'ReceiverMismatch' | 'RequiresFullAccess';

export type ForbiddenAttempt = {
  id: string;
  title: string;
  /** What a hijacked agent would gain if this worked. */
  goal: string;
  expected: ForbiddenRule;
  plan: TxPlan;
};

export const ORPHAN_KEY_PLACEHOLDER = '<fresh ed25519 public key, generated at run time, secret discarded>';

export function forbiddenAttempts(a: DemoAccounts, tokenId: string, amountUnits: bigint, orphanPublicKey: string): ForbiddenAttempt[] {
  const vault = a.vault;
  return [
    {
      id: 'owner_method',
      title: 'Call an owner method: set_registry(null)',
      goal: 'switch off the verdict check, so every later payment skips the registry',
      expected: 'MethodNameMismatch',
      plan: { signerId: vault, receiverId: vault, actions: [fnCall('set_registry', { registry_id: null }, GAS.forbiddenCall, 0n)] },
    },
    {
      id: 'attach_deposit',
      title: 'Attach a deposit: pay(...) with 1 yoctoNEAR',
      goal: 'a deposit is what every NEP-141 transfer and owner method requires; a key that can attach one can reach them',
      expected: 'DepositWithFunctionCall',
      plan: {
        signerId: vault,
        receiverId: vault,
        actions: [fnCall('pay', { payee: a.lookalike, amount: amountUnits.toString(), memo: 'deposit attempt' }, GAS.forbiddenCall, ONE_YOCTO)],
      },
    },
    {
      id: 'call_token',
      title: 'Call the token directly: ft_transfer on USDC',
      goal: "move the vault's USDC to the lookalike without asking the vault at all",
      expected: 'ReceiverMismatch',
      // Sent without the 1 yoctoNEAR NEP-141 requires, so that the receiver rule is the one
      // tested; with the yocto attached the deposit rule (attempt above) rejects it first.
      plan: {
        signerId: vault,
        receiverId: tokenId,
        actions: [fnCall('ft_transfer', { receiver_id: a.lookalike, amount: amountUnits.toString(), memo: null }, GAS.forbiddenCall, 0n)],
      },
    },
    {
      id: 'add_key',
      title: 'Add a full-access key to the vault account',
      goal: 'total control of the vault: redeploy its code, move its NEAR, delete it',
      expected: 'RequiresFullAccess',
      plan: { signerId: vault, receiverId: vault, actions: [{ type: 'AddKey', publicKey: orphanPublicKey, permission: 'FullAccess' }] },
    },
    {
      id: 'send_near',
      title: "Send the vault's NEAR to the lookalike (1 yoctoNEAR)",
      goal: "drain the NEAR that pays the vault's gas and storage",
      expected: 'RequiresFullAccess',
      plan: { signerId: vault, receiverId: a.lookalike, actions: [{ type: 'Transfer', deposit: ONE_YOCTO }] },
    },
  ];
}
