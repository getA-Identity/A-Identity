/**
 * What the page says about a stopped write: its title, what happened and the next step, for every
 * failure code.
 *
 * Every code gets a specific sentence and a next step. A contract refusal found in simulation is
 * named from the contract's own custom errors (mcp/contracts/AgentSpendPolicy.sol), and the page
 * says plainly that nothing was sent and no fee was spent, because a simulation costs nothing.
 *
 * A module of its own, with only imports named by their .ts extension, so that
 * mcp/src/frontend-arc-copy.test.ts can drive a real send into it and read what the person is told.
 */
import { USE_ANOTHER_ACCOUNT } from './deploy-copy.ts'
import type { TxFailure } from './send'

/** The contract's custom errors, one sentence each. */
const CONTRACT_ERROR_TEXT: Record<string, string> = {
  NotOwner: 'Only the vault owner can make this call, and the connected account is not the owner.',
  NotOperator: 'Only the operator key can call pay().',
  IsFrozen: 'The vault is frozen, so the agent cannot pay.',
  SessionKeyExpired: "The operator's session key has expired.",
  PayeeNotAllowed: 'The allowlist is on and this payee is not on it.',
  AboveAutoApprove: 'This single payment is above the largest amount the policy approves without the owner.',
  DailyCapExceeded: "This payment would take today's spending over the daily cap.",
  ZeroAddress: 'An address in this call is the zero address, which the contract refuses.',
  InvalidPayee: 'The destination is the vault itself or the USDC contract, which the contract refuses.',
  TransferFailed: 'The USDC transfer inside the call failed, usually because the vault does not hold that much.',
}

const CONTRACT_ERROR_NEXT: Record<string, string> = {
  NotOwner: `Pick the owner account in your wallet, then try again. If your wallet will not switch here, press ${USE_ANOTHER_ACCOUNT} at the top of this page.`,
  ZeroAddress: 'Check every address in the form.',
  InvalidPayee: 'Send it to an account, not to the vault or the token contract.',
  TransferFailed: 'Read the vault again and use an amount it holds.',
}

export function explainFailure(f: TxFailure): { title: string; body?: string; next: string; tone: 'warn' | 'danger' } {
  switch (f.code) {
    case 'refused':
      return { title: 'This page will not send that.', body: f.message, next: 'Change the values above and try again.', tone: 'warn' }
    case 'reverted_in_simulation': {
      const name = f.errorName ?? ''
      return {
        title: `The contract would refuse this${name ? `: ${name}` : ''}.`,
        body: `${CONTRACT_ERROR_TEXT[name] ?? f.message} This page tried it first in a free practice run, before your wallet opened, so nothing was sent and no fee was spent.`,
        next: CONTRACT_ERROR_NEXT[name] ?? 'Read the vault again; if the same refusal comes back, it names what to change.',
        tone: 'danger',
      }
    }
    case 'not_this_build':
      return { title: 'Not a vault this page acts on.', body: f.message, next: 'Read the vault again. This page only builds calls for the vault build it deploys.', tone: 'danger' }
    case 'funding_too_high':
      return {
        title: 'Not enough USDC for the amount you chose to put in.',
        body: f.message,
        next: "Lower 'USDC to put in at step 3', or set it to 0 and add USDC later from the vault's page, then review again. Nothing was sent.",
        tone: 'warn',
      }
    case 'insufficient_gas':
      return {
        title: 'Not enough USDC for the network fee.',
        body: f.message,
        next: `Check that this is the account holding your USDC. If it is not, press ${USE_ANOTHER_ACCOUNT} at the top of this page. If it is, send a little USDC to it on this network (on Arc the fee is paid in USDC), then try again.`,
        tone: 'danger',
      }
    case 'rpc_unreachable':
      // Only a read before the wallet is asked can end here (vault-write.ts, DeployFlow's USDC read), so nothing was sent.
      return {
        title: 'The network could not be read.',
        body: f.message,
        next: 'Nothing was sent. Most often the network is taking too many requests just now, and sometimes it is your internet connection. Wait a minute, then try again.',
        tone: 'danger',
      }
    case 'no_wallet':
      return { title: 'No wallet is connected.', body: f.message, next: 'Connect your wallet in the strip at the top of the page.', tone: 'warn' }
    case 'rejected':
      return { title: 'You declined in your wallet.', body: 'Nothing was sent.', next: 'Press the button again when you are ready.', tone: 'warn' }
    case 'wrong_chain':
      return {
        title: 'Your wallet is not on the vault\'s network.',
        body: f.message,
        next: 'Switch the network in your wallet (or press Switch in the wallet strip), then try again. Nothing was sent.',
        tone: 'danger',
      }
    case 'chain_not_added':
      return {
        title: 'Your wallet could not add this network.',
        body: f.message,
        next: 'Nothing was sent. Use one of those two ways, then press the button again.',
        tone: 'warn',
      }
    case 'account_mismatch':
      return { title: 'Your wallet changed account.', body: f.message, next: `Pick the right account in your wallet, then try again. If your wallet will not switch here, press ${USE_ANOTHER_ACCOUNT} at the top of this page.`, tone: 'danger' }
    case 'wallet_pending':
      return { title: 'Your wallet already has a request open.', body: f.message, next: 'Open the wallet, finish or dismiss that request, then try again.', tone: 'warn' }
    case 'fee_too_low':
      return {
        title: 'The fee is below what Arc accepts.',
        body: f.message,
        next: 'Arc drops a transaction with a max fee under 20 gwei without telling anyone. Try again, and do not lower the fee in your wallet. If your wallet set a lower fee itself, raise it to at least 20 gwei before you confirm.',
        tone: 'danger',
      }
    case 'nonce':
      return {
        title: 'An earlier transaction is in the way.',
        body: f.message,
        next: 'An earlier transaction from this account may still be waiting. Let it finish or cancel it in your wallet, then try again.',
        tone: 'danger',
      }
    case 'handoff_not_from_agent':
      return { title: 'This did not come from your agent.', body: f.message, next: 'Do not send money because of it. If you expect a payment from your agent, ask it to check the payee again with its own key.', tone: 'danger' }
    case 'handoff_changed':
      return { title: 'What would be signed is not what was shown.', body: f.message, next: 'Nothing was sent. Read this page again, and look over whatever it shows then.', tone: 'danger' }
    case 'handoff_stale':
      return { title: 'This check is too old to act on.', body: f.message, next: 'Nothing was sent. Ask your agent to check the payee again, which costs it 0.005 USDC, and approve the new request.', tone: 'warn' }
    case 'handoff_ended':
      return { title: 'This payment is not waiting for you any more.', body: f.message, next: 'Nothing was sent. Read this page again to see where it stands.', tone: 'warn' }
    case 'handoff_no_balance':
      return { title: 'The vault does not hold enough USDC for this.', body: f.message, next: 'Nothing was sent. Add USDC to the vault below, or take less out, then try again.', tone: 'warn' }
    case 'handoff_held':
      return { title: 'A payment for this is already on its way.', body: f.message, next: 'Nothing was sent. Wait for that one to have an answer: two sends pay twice, and the contract cannot tell them apart.', tone: 'warn' }
    case 'handoff_already_paid':
      return { title: 'This has already been paid.', body: f.message, next: 'Nothing was sent. If you really mean to pay it again, ask your agent for a new check.', tone: 'warn' }
    case 'handoff_unreadable':
      return { title: 'This page could not make sure this is safe to send.', body: f.message, next: 'Nothing was sent. Wait a minute, then try again.', tone: 'danger' }
    case 'wallet_error':
    default:
      // An error from the wallet does not prove nothing went out, and a second USDC transfer is real money.
      return {
        title: 'Your wallet stopped the request.',
        body: f.message,
        next: "Look at your wallet's activity list first. If this transaction is there, do not send it again: wait for it. If nothing is there, finish or dismiss any prompt in your wallet, then try again.",
        tone: 'danger',
      }
  }
}
