import type { ChainId } from '../../lib/chains'
import { cn } from '../../lib/utils'

/**
 * Official network mark on a consistent circular badge.
 *
 * Every mark sits on a disc so nine differently-shaped logos read as one row of
 * tokens. The disc is white by default; the two near-white brand marks
 * (Robinhood lime, Celo yellow) get the fixed ink disc instead, so they hold
 * contrast on the light theme. The disc colours are deliberately theme-FIXED:
 * the badge is the brand's own ground, not one of our surfaces.
 */
const LOGO: Record<ChainId, string> = {
  arc: '/chains/arc.svg',
  base: '/chains/base.svg',
  arbitrum: '/chains/arbitrum.svg',
  avalanche: '/chains/avalanche.svg',
  xlayer: '/chains/xlayer.svg',
  'rhchain-testnet': '/chains/rhchain.svg',
  rhchain: '/chains/rhchain.svg',
  celo: '/chains/celo.svg',
  'celo-sepolia': '/chains/celo.svg',
  stellar: '/chains/stellar.svg',
  'stellar-testnet': '/chains/stellar.svg',
}

/** Marks too light to survive a white disc. */
const INK_DISC = new Set<ChainId>(['rhchain', 'rhchain-testnet'])

export default function ChainLogo({
  id,
  size = 24,
  className,
}: {
  id: ChainId
  size?: number
  className?: string
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full border border-border',
        INK_DISC.has(id) ? 'bg-[#192837]' : 'bg-white',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img src={LOGO[id]} alt="" loading="lazy" decoding="async" className="h-[62%] w-[62%] object-contain" />
    </span>
  )
}
