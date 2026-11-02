/**
 * One place that turns a stopped write into what happened and what to do next.
 *
 * Every code gets a specific sentence and a next step. A contract refusal found in simulation is
 * named from the contract's own custom errors (mcp/contracts/AgentSpendPolicy.sol), and the page
 * says plainly that nothing was sent and no fee was spent, because a simulation costs nothing.
 */
import { AlertTriangle } from 'lucide-react'
import type { TxFailure } from '../../../lib/arc/vault-write'

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
  NotOwner: 'Pick the owner account in your wallet, then try again.',
  ZeroAddress: 'Check every address in the form.',
  InvalidPayee: 'Send it to an account, not to the vault or the token contract.',
  TransferFailed: 'Read the vault again and use an amount it holds.',
}

function explain(f: TxFailure): { title: string; body?: string; next: string; tone: 'warn' | 'danger' } {
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
    case 'insufficient_gas':
      return {
        title: 'Not enough USDC for the network fee.',
        body: f.message,
        next: 'Send a little USDC to this account on the same network (on Arc the fee is paid in USDC), then try again.',
        tone: 'danger',
      }
    case 'rpc_unreachable':
      return { title: 'The network could not be read.', body: f.message, next: 'Nothing was sent. Check your connection and try again in a moment.', tone: 'danger' }
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
    case 'account_mismatch':
      return { title: 'Your wallet changed account.', body: f.message, next: 'Pick the right account in your wallet, then try again.', tone: 'danger' }
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
    case 'wallet_error':
    default:
      return { title: 'Your wallet stopped the request.', body: f.message, next: 'Open your wallet, finish or dismiss any prompt there, then try again.', tone: 'danger' }
  }
}

/** `next` replaces the usual next step when what comes after is not simply trying again. */
export default function FailureNotice({ failure, next: instead }: { failure: TxFailure; next?: string }) {
  const { title, body, next: usual, tone } = explain(failure)
  const next = instead ?? usual
  return (
    <div role="alert" className={`rounded-2xl border p-4 text-sm ${tone === 'warn' ? 'border-warn/30 bg-warn/10' : 'border-danger/25 bg-danger/[0.07]'}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${tone === 'warn' ? 'text-warn' : 'text-danger'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">{title}</div>
          {body && <div className="mt-1 break-words text-foreground/80">{body}</div>}
          <div className="mt-2 text-foreground/80">
            <span className="font-semibold text-foreground">Next step: </span>
            {next}
          </div>
        </div>
      </div>
    </div>
  )
}
