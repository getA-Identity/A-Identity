import { BadgeCheck, CheckCircle2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { OwlMascot } from '../../OwlMascot'

/**
 * The registered outcome card RegisterForm early-returns into: confirms the
 * new agent, then offers the two real follow-ups (anchor on Arc, prove wallet
 * control for KYA). Pure props component: every hook and async handler stays
 * in RegisterForm so the wizard's hook order never changes.
 */
export default function RegisterSuccess({
  name,
  wallet,
  kya,
  kyaBusy,
  kyaNote,
  anchored,
  anchorBusy,
  anchorNote,
  anchorOnchain,
  proveKya,
  onClose,
}: {
  name: string
  wallet: { address: string } | null
  kya: { verified: boolean; onchainTx?: string; onchainExplorer?: string } | null
  kyaBusy: boolean
  kyaNote: string | null
  anchored: { onchainTx?: string; onchainExplorer?: string; onchainAgentId?: string } | null
  anchorBusy: boolean
  anchorNote: string | null
  anchorOnchain: () => void
  proveKya: () => void
  onClose: () => void
}) {
  return (
    <div className="relative mt-5 overflow-hidden rounded-2xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/50 p-6">
      {/* The owl marks the good outcome. Decorative, so it stays out of the a11y tree and
          never overlaps the text: it sits in the card's empty top-right corner. */}
      <OwlMascot
        variant="geometric"
        width={264}
        className="pointer-events-none absolute -right-14 -top-16 hidden w-[264px] select-none opacity-90 sm:block"
      />
      <div className="flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 size={18} /> {name} is registered.
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 text-sm text-foreground/70">
        <li>Permissions set (daily cap, auto-approve).</li>
        {kya?.verified ? (
          <li>KYA verified: wallet control proven.</li>
        ) : (
          <li>KYA pending: prove the agent controls its wallet below.</li>
        )}
        {wallet && <li>Wallet {wallet.address.slice(0, 10)}... is assigned to it.</li>}
        {!anchored && <li>On-chain anchor is queued. Anchor it on Arc to mint a real ERC-8004 identity.</li>}
      </ul>

      {/* On-chain anchor: real ERC-8004 registration on Arc, human-triggered */}
      {anchored ? (
        <div className="mt-4 rounded-xl border border-usdc/25 bg-usdc/[0.05] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-usdc">
            <BadgeCheck size={16} /> Anchored on Arc: ERC-8004 id #{anchored.onchainAgentId ?? '?'}
          </div>
          {anchored.onchainExplorer && (
            <a
              href={anchored.onchainExplorer}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block break-all text-xs font-semibold text-usdc hover:underline"
            >
              View transaction on arcscan
            </a>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <button
            type="button"
            onClick={anchorOnchain}
            disabled={anchorBusy}
            className="rounded-full border border-usdc/30 px-4 py-2 text-sm font-semibold text-usdc transition-colors hover:bg-usdc/5 disabled:opacity-50"
          >
            {anchorBusy ? 'Anchoring on Arc...' : 'Anchor on Arc (register on-chain)'}
          </button>
          {anchorNote && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{anchorNote}</p>}
        </div>
      )}

      {/* KYA: prove the agent controls its wallet (real signature, not a stamp) */}
      {wallet && (
        <div className="mt-4">
          {kya?.verified ? (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                <BadgeCheck size={16} /> KYA verified: wallet control proven
              </div>
              {kya.onchainExplorer ? (
                <a
                  href={kya.onchainExplorer}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block break-all text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
                >
                  Attested on-chain: ERC-8004 ValidationRegistry (view tx)
                </a>
              ) : (
                <p className="mt-1 text-xs text-foreground/45">Anchor on Arc to also record this on the ERC-8004 ValidationRegistry.</p>
              )}
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={proveKya}
                disabled={kyaBusy}
                className="rounded-full border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300 transition-colors hover:bg-emerald-50 disabled:opacity-50"
              >
                {kyaBusy ? 'Proving wallet control...' : 'Prove wallet control (KYA)'}
              </button>
              <p className="mt-2 text-xs text-foreground/45">
                Signs a challenge with your agent's wallet key (in your browser)
                {anchored ? ' and records it on the ERC-8004 ValidationRegistry.' : '. Anchor first for an on-chain attestation.'}
              </p>
              {kyaNote && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{kyaNote}</p>}
            </>
          )}
        </div>
      )}

      <div className="mt-4 flex gap-3">
        <Button asChild size="sm" className="text-sm">
          <a href="/app/marketplace">See it in Agent House</a>
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground/70"
        >
          Close
        </button>
      </div>
    </div>
  )
}
