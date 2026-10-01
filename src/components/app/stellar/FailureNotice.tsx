/**
 * One place that turns a stopped owner action into what happened and what to do next.
 *
 * Every code gets a specific sentence and a next step, never a bare "something went wrong":
 * the person reading this is the vault's owner, and the next step is usually something only
 * they can do (switch the wallet's network, fund the account, add a trustline).
 *
 * A contract refusal is named in plain words from the contract's own error table
 * (soroban/contracts/agent-spend-policy/src/error.rs). The numbers are frozen ABI there, so
 * the table below is keyed by name and the number is shown beside it for anyone checking.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import type { VaultFailure } from '../../../lib/stellar/vault'
import { FREIGHTER_URL, networkWord, txExplorerUrl } from '../../../lib/stellar/vault-read'
import { CopyButton, Mono } from './bits'

/** Testnet XLM for fees. The person clicks it; this page never calls it. */
const FRIENDBOT = 'https://friendbot.stellar.org/?addr='

/** The contract's typed errors, one sentence each. */
const CONTRACT_ERROR_TEXT: Record<string, string> = {
  Frozen: 'The vault is frozen, so the agent cannot spend. The owner can still unfreeze it, withdraw, or pay directly.',
  SessionKeyExpired: "The operator's session key has expired, so the agent's payments revert until the owner extends it.",
  PayeeNotAllowed: 'The allowlist is on and this payee is not on it.',
  AboveAutoApprove: 'This single payment is above the largest amount the policy approves without the owner.',
  DailyCapExceeded: "This payment would take today's spending over the daily cap.",
  InvalidAmount: 'The amount is zero or negative. The contract only moves amounts above zero.',
  InvalidPayee: 'The destination is the vault itself or the token contract, which would move nothing.',
  MathOverflow: "The day's running total would overflow, so the contract refused rather than wrap around.",
  InsufficientBalance: 'The vault does not hold enough to cover this amount.',
  OwnerIsOperator: 'The owner and the operator would be the same key, which the contract never allows.',
}

/** What to do after each contract refusal, for the owner reading it. */
const CONTRACT_ERROR_NEXT: Record<string, string> = {
  Frozen: 'Unfreeze the vault first if you meant to let the agent pay again.',
  SessionKeyExpired: 'Extend the session key, or pay from the owner side.',
  PayeeNotAllowed: 'Add the payee to the allowlist, or turn the allowlist off in the policy.',
  AboveAutoApprove: 'Raise the auto-approve ceiling in the policy, or pay it from the owner side.',
  DailyCapExceeded: 'Wait for the daily reset at 00:00 UTC, or raise the daily cap.',
  InvalidAmount: 'Enter an amount above zero.',
  InvalidPayee: 'Send it to an account, not to the vault or the token contract.',
  MathOverflow: 'Use a smaller amount.',
  InsufficientBalance: 'Use a smaller amount (Max fills in the live balance), or fund the vault first.',
  OwnerIsOperator: 'Pick an operator that is not the owner account.',
}

type Props = {
  failure: VaultFailure
  /** The owner account, for the Friendbot link and the not-owner sentence. */
  owner?: string
  /** CAIP-2 of the vault, for the explorer link and the network sentence. */
  network?: string
  /** The wallet install link the kit reported, when it did. */
  installUrl?: string
  /** Rendered as the next step for no_session (the sign-in button). */
  signIn?: ReactNode
}

export default function FailureNotice({ failure, owner, network, installUrl, signIn }: Props) {
  const { title, body, next } = explain(failure, { owner, network, installUrl, signIn })
  const tone = failure.code === 'pending' || failure.code === 'restore_needed' || failure.code === 'not_accepted' ? 'warn' : 'danger'
  return (
    <div
      role="alert"
      className={`rounded-2xl border p-4 text-sm ${tone === 'warn' ? 'border-warn/30 bg-warn/10' : 'border-danger/25 bg-danger/[0.07]'}`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${tone === 'warn' ? 'text-warn' : 'text-danger'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">{title}</div>
          {body && <div className="mt-1 text-foreground/80">{body}</div>}
          <div className="mt-2 text-foreground/80">
            <span className="font-semibold text-foreground">Next step: </span>
            {next}
          </div>
        </div>
      </div>
    </div>
  )
}

function explain(
  f: VaultFailure,
  ctx: { owner?: string; network?: string; installUrl?: string; signIn?: ReactNode },
): { title: string; body?: ReactNode; next: ReactNode } {
  const net = networkWord(f.targetNetwork ?? ctx.network)
  switch (f.code) {
    case 'no_wallet':
      return {
        title: 'No Stellar wallet is installed in this browser.',
        body: 'Everything above is a public read and works without one. Owner actions need the owner key, which lives in a wallet.',
        next: (
          <>
            Install{' '}
            <a href={ctx.installUrl ?? FREIGHTER_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent underline underline-offset-2">
              Freighter
            </a>
            , unlock it, then reload this page.
          </>
        ),
      }
    case 'no_signer':
      return { title: 'No wallet is connected in this tab.', next: 'Press Connect wallet above and pick the owner account.' }
    case 'wallet_network_unknown':
      return {
        title: 'This wallet does not report which network it is on.',
        body: f.message,
        next: 'Use Freighter, or a wallet that reports its network, then connect again.',
      }
    case 'wrong_network':
      return {
        title: `Your wallet is not on ${net}.`,
        body: f.message,
        next: `Switch Freighter to ${net === 'testnet' ? 'Testnet' : 'Mainnet'}: Settings > Network. Then press the button again.`,
      }
    case 'not_owner':
      return {
        title: 'The connected account is not the owner of this vault.',
        body: f.message,
        next: 'Pick the owner account inside the wallet and connect again. Only the owner can sign these calls.',
      }
    case 'no_session':
      return {
        title: 'Sign in with this wallet to prepare owner actions.',
        body: 'Our backend builds and simulates each call for you to sign. It only does that for a signed-in session, and signing in is one message signature: no transaction, no fee.',
        next: ctx.signIn ?? 'Sign in with the owner wallet, then press the button again.',
      }
    case 'rejected':
      return {
        title: 'You rejected the request in the wallet.',
        body: 'Nothing was signed and nothing was sent.',
        next: 'Press the button again when you are ready.',
      }
    case 'insufficient_xlm':
      return {
        title: 'The owner account does not have enough XLM for the network fee.',
        body:
          f.availableXlm || f.neededXlm ? (
            <>
              Available: {f.availableXlm ?? 'unknown'} XLM. Needed: about {f.neededXlm ?? 'unknown'} XLM. The owner account is the
              transaction source, so it pays the fee.
            </>
          ) : (
            f.message
          ),
        next:
          net === 'testnet' && ctx.owner ? (
            <>
              Fund it with{' '}
              <a href={`${FRIENDBOT}${ctx.owner}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent underline underline-offset-2">
                Friendbot (testnet XLM)
              </a>
              {' '}if the account does not exist yet (Friendbot only creates accounts); otherwise send it testnet XLM from another
              testnet account. Then press the button again.
            </>
          ) : (
            'Send XLM to the owner account, then press the button again.'
          ),
      }
    case 'no_trustline':
      return {
        title: 'The destination cannot receive this token yet.',
        body: (
          <>
            {f.destination ? <Mono>{f.destination}</Mono> : 'The destination'} has no trustline for{' '}
            {f.asset ? <Mono>{f.asset}</Mono> : 'USDC'}, so the transfer would fail. Nothing was signed.
          </>
        ),
        next: (
          <>
            The destination account must add the asset first. In Freighter: Manage assets, Add an asset, pick USDC with the issuer
            shown above, and approve the change. Or send to an account that already holds USDC.
            {f.asset && (
              <span className="ml-1 inline-block align-middle">
                <CopyButton text={f.asset} label="Copy asset" />
              </span>
            )}
          </>
        ),
      }
    case 'refused': {
      const name = f.errorName ?? ''
      const plain = CONTRACT_ERROR_TEXT[name]
      return {
        title: name ? `The vault refused it: ${name}${typeof f.errorCode === 'number' ? ` (error ${f.errorCode})` : ''}.` : 'The vault refused it.',
        body: plain ?? f.message,
        next: CONTRACT_ERROR_NEXT[name] ?? 'Read the vault again; the values above show what the contract will accept.',
      }
    }
    case 'restore_needed':
      return {
        title: 'Part of this vault is archived on the ledger.',
        body: (
          <>
            Soroban archives contract state whose rent lapsed. Nothing it holds is lost, but the next call has to restore it, and a
            restore costs a higher fee. {f.message}
          </>
        ),
        next: 'Press the button again: the new prepare includes the restore, and the wallet shows the higher fee before you sign.',
      }
    case 'pending': {
      const href = f.hash && ctx.network ? txExplorerUrl(ctx.network, f.hash) : null
      return {
        title: 'Submitted, not in a ledger yet.',
        body: f.hash ? <Mono>{f.hash}</Mono> : 'The transaction is waiting for a ledger.',
        next: (
          <>
            Do not sign it again. It stays valid for its time bound and may still land; this page keeps checking.
            {href && (
              <a href={href} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-1 font-semibold text-accent">
                Explorer <ExternalLink size={11} />
              </a>
            )}
          </>
        ),
      }
    }
    case 'not_accepted':
      return {
        title: 'The network did not accept the transaction right now.',
        body: 'Nothing landed. The node answered TRY_AGAIN_LATER, which means it was not queued.',
        next: 'It is safe to press the button again in a few seconds.',
      }
    case 'failed':
      return {
        title: 'The network rejected the transaction.',
        body: f.resultCode ? (
          <>
            Result code: <Mono>{f.resultCode}</Mono>. {f.message}
          </>
        ) : (
          f.message
        ),
        next: 'Read the vault again, then retry. If the same code comes back, it names what to fix.',
      }
    case 'bad_request':
      return { title: 'The request was not valid.', body: f.message, next: 'Check the amount and the address, then try again.' }
    case 'unknown_vault':
      return {
        title: 'Our backend will not prepare calls for this vault.',
        body: f.message,
        next: 'Owner actions are prepared for registry vaults and for known AgentSpendPolicy builds owned by your signed-in or linked wallet.',
      }
    case 'unreachable':
      return { title: 'The backend did not answer.', body: f.message, next: 'Wait a few seconds (the free tier may be waking up), read the vault again, then retry.' }
    case 'wallet_error':
    default:
      return { title: 'The wallet stopped the request.', body: f.message, next: 'Open the wallet, finish or dismiss any prompt there, then press the button again.' }
  }
}
