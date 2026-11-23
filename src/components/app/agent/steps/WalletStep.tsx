import type { Dispatch, SetStateAction } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'

/** What GET /api/agents/circle-wallet/status says before anything is created. */
export type HostedWalletStatus = {
  configured: boolean
  starterFunding: { amountUsd: number; available: boolean; reason?: string }
}

/**
 * Wizard step 4, wallet. Two ways to give the agent one, and this pane only chooses between
 * them and shows what each means.
 *
 * Hosted: nothing happens here. The wallet is created together with the agent, Circle holds
 * its key, and no private key is ever shown. It is offered only when the server says it can
 * create one, and it is the default then.
 *
 * Own key: a key pair RegisterForm generates in the browser. This pane shows the address, the
 * reveal-once private key (never stored, never sent to the server) and the faucet and balance
 * helpers. Pure props pane: state and the async handlers stay in RegisterForm so hook order
 * never changes.
 */
export default function WalletStep({
  mode,
  setMode,
  hosted,
  wallet,
  walletBusy,
  createWallet,
  copiedAddr,
  copyAddress,
  showKey,
  setShowKey,
  copiedKey,
  setCopiedKey,
  keySaved,
  setKeySaved,
  fundBusy,
  fundBal,
  checkFunded,
  label,
}: {
  mode: 'hosted' | 'own'
  setMode: (m: 'hosted' | 'own') => void
  /** Null until the server has answered; then whether a hosted wallet can be created. */
  hosted: HostedWalletStatus | null
  wallet: { address: string; privateKey: string } | null
  walletBusy: boolean
  createWallet: () => void
  copiedAddr: boolean
  copyAddress: () => void
  showKey: boolean
  setShowKey: Dispatch<SetStateAction<boolean>>
  copiedKey: boolean
  setCopiedKey: (v: boolean) => void
  keySaved: boolean
  setKeySaved: (v: boolean) => void
  fundBusy: boolean
  fundBal: number | null
  checkFunded: () => void
  label: string
}) {
  const hostedOffered = Boolean(hosted?.configured)
  // A key generated in this browser decides it: that wallet is the agent's wallet.
  const shown = wallet ? 'own' : hostedOffered ? mode : 'own'
  const choice = (active: boolean) =>
    `flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
      active ? 'border-accent bg-accent/5' : 'border-border bg-background/40 hover:border-foreground/25'
    } disabled:cursor-not-allowed disabled:opacity-50`

  return (
    <div>
      <div className={label}>Arc testnet wallet</div>

      {hostedOffered && (
        <div role="radiogroup" aria-label="How the agent gets its wallet" className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            role="radio"
            aria-checked={shown === 'hosted'}
            disabled={Boolean(wallet)}
            onClick={() => setMode('hosted')}
            className={choice(shown === 'hosted')}
          >
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                Hosted wallet
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">Recommended</span>
              </span>
              <span className="mt-1 block text-xs text-foreground/60">
                Created with the agent. There is no key to save: Circle holds it, and A-Identity moves funds only
                within the limits you set. The agent can pay and hire, but cannot be KYA verified or listed for hire.
              </span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={shown === 'own'}
            onClick={() => setMode('own')}
            className={choice(shown === 'own')}
          >
            <KeyRound size={18} className="mt-0.5 shrink-0 text-foreground/60" />
            <span>
              <span className="block text-sm font-semibold text-foreground">My own key</span>
              <span className="mt-1 block text-xs text-foreground/60">
                Generated in this browser and shown once. You keep it, and nobody can recover it for you. Needed to
                verify the agent (KYA) and offer it for hire.
              </span>
            </span>
          </button>
        </div>
      )}

      {shown === 'hosted' && hosted && (
        <p className={`mt-3 text-xs ${hosted.starterFunding.available ? 'text-ok' : 'text-warn'}`}>
          {hosted.starterFunding.available
            ? `It starts with ${hosted.starterFunding.amountUsd} test USDC, sent when the agent is created.`
            : hosted.starterFunding.reason}
        </p>
      )}

      {hosted && !hosted.configured && (
        <p className="mt-2 text-[11px] text-foreground/50">
          Hosted wallets are not available on this server right now, so the wallet is generated in your browser.
        </p>
      )}

      {shown === 'own' &&
        (!wallet ? (
          <>
            <button
              type="button"
              onClick={createWallet}
              disabled={walletBusy}
              className="mt-3 rounded-full border border-usdc/30 px-4 py-2.5 text-sm font-semibold text-usdc transition-colors hover:bg-usdc/5 disabled:opacity-50"
            >
              {walletBusy ? 'Creating...' : 'Create wallet (generated in your browser)'}
            </button>
            <p className="mt-2 text-[11px] text-foreground/45">
              Optional. Without a wallet the agent registers fine, but it has no balance of its own and other agents
              cannot pay it.
            </p>
          </>
        ) : (
          <div className="mt-3 rounded-xl border border-usdc/25 bg-usdc/[0.04] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-foreground/50">Address</div>
              <button type="button" onClick={copyAddress} className="text-[11px] font-semibold text-usdc hover:underline">
                {copiedAddr ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="break-all font-mono text-xs text-foreground">{wallet.address}</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-red-600">
                Private key (generated in your browser, the server never sees it)
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="text-[11px] font-semibold text-usdc hover:underline"
                >
                  {showKey ? 'Hide' : 'Reveal'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(wallet.privateKey)
                      setCopiedKey(true)
                      setTimeout(() => setCopiedKey(false), 1500)
                    } catch {
                      setShowKey(true) // clipboard blocked, reveal so it can be copied by hand
                    }
                  }}
                  className="text-[11px] font-semibold text-usdc hover:underline"
                >
                  {copiedKey ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="break-all font-mono text-xs text-foreground/70">
              {showKey ? wallet.privateKey : '•'.repeat(48)}
            </div>
            <p className="mt-1 text-[11px] text-foreground/45">
              Save it now. It is shown once and never stored. Reveal only somewhere no one can see your screen.
            </p>
            <label className="mt-2 flex items-start gap-2 text-[11px] font-medium text-foreground/70">
              <input
                type="checkbox"
                checked={keySaved}
                onChange={(e) => setKeySaved(e.target.checked)}
                className="mt-0.5 accent-accent"
              />
              I saved this private key somewhere safe. A-Identity never stores it and cannot recover it.
            </label>
            <a
              href="https://faucet.circle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs font-semibold text-usdc hover:underline"
            >
              Fund it with testnet USDC at faucet.circle.com
            </a>
            <p className="mt-1 text-[11px] text-foreground/45">
              When the agent is created it is also sent a little test USDC, while the daily allowance lasts.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={checkFunded}
                disabled={fundBusy}
                className="rounded-full border border-usdc/30 px-3 py-1.5 text-[11px] font-semibold text-usdc transition-colors hover:bg-usdc/5 disabled:opacity-50"
              >
                {fundBusy ? 'Checking...' : 'I funded it, check balance'}
              </button>
              {fundBal != null && (
                <span className={`text-[11px] font-semibold ${fundBal > 0 ? 'text-emerald-600' : 'text-foreground/50'}`}>
                  {fundBal > 0 ? `Funded: ${fundBal.toFixed(4)} USDC` : 'Still 0 USDC, give the faucet a moment and check again'}
                </span>
              )}
            </div>
          </div>
        ))}
    </div>
  )
}
