/**
 * The stablecoin mark that sits next to a price.
 *
 * The three files under public/tokens/ share one geometry (an r=9 circle inset in a 24
 * box), so the marks line up optically at any size and need no disc of their own: the
 * artwork IS the round token logo. Same rule as the wallet's copy of this map: an unknown
 * symbol renders NOTHING rather than a made-up mark that would read as that token's real
 * brand. Purely decorative, so it is aria-hidden and the amount beside it keeps saying the
 * symbol in text for anyone who cannot see the logo.
 *
 * Lives here rather than next to ChainLogo because the marketplace and the agent profile
 * are the two surfaces that print prices; Wallet.tsx carries the older private copy.
 */
const TOKEN_LOGO: Record<string, string> = {
  USDC: '/tokens/usdc.svg',
  EURC: '/tokens/eurc.svg',
  USYC: '/tokens/usyc.svg',
}

export default function TokenLogo({
  symbol,
  size = 16,
  className = '',
}: {
  symbol: string
  size?: number
  className?: string
}) {
  const src = TOKEN_LOGO[symbol.toUpperCase()]
  if (!src) return null
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      decoding="async"
      className={`inline-block shrink-0 rounded-full align-[-0.15em] ${className}`}
    />
  )
}
