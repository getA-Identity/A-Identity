import type { Dispatch, SetStateAction } from 'react'

/**
 * Wizard step 4, wallet: a real Arc testnet wallet whose key pair RegisterForm
 * generates in the browser. This pane only shows the address, the reveal-once
 * private key (never stored, never sent to the server) and the faucet/balance
 * helpers. Pure props pane: state and the async handlers stay in RegisterForm
 * so hook order never changes.
 */
export default function WalletStep({
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
  return (
    <div>
      <div className={label}>Arc testnet wallet</div>
      {!wallet ? (
        <>
          <button
            type="button"
            onClick={createWallet}
            disabled={walletBusy}
            className="mt-2 rounded-full border border-usdc/30 px-4 py-2.5 text-sm font-semibold text-usdc transition-colors hover:bg-usdc/5 disabled:opacity-50"
          >
            {walletBusy ? 'Creating...' : 'Create wallet (generated in your browser)'}
          </button>
          <p className="mt-2 text-[11px] text-foreground/45">
            Optional. Without a wallet the agent registers fine, but it cannot pay or receive until one is assigned.
          </p>
        </>
      ) : (
        <div className="mt-2 rounded-xl border border-usdc/25 bg-usdc/[0.04] p-4">
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
      )}
    </div>
  )
}
