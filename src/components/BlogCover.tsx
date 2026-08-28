/**
 * Brand-consistent generative cover art for blog posts. Pure SVG, so it stays
 * crisp at any size and ships no image files. Each post passes its chain accent
 * color and a seed; the dark ink base, angular bands, node network, and faint
 * A-Identity watermark keep every cover on-brand while the accent makes it distinct.
 */

/* The mark, used below as a faint watermark. Imported rather than pasted: this file used to
 * carry its own copy of the path geometry, which is a third place for it to drift out of
 * step with the Logo component and the favicon. The ribbon monogram is multi-path with a
 * mask, so the import is the whole glyph as a group rather than one path string. */
import { LogoGlyph } from './Logo'

const INK_DARK = '#141f2b'
const INK_LITE = '#1d2e3e'

type BlogCoverProps = {
  accent: string
  seed?: number
  className?: string
}

export default function BlogCover({ accent, seed = 0, className }: BlogCoverProps) {
  // Deterministic pseudo-random so a given seed always renders the same cover.
  const rnd = (n: number) => {
    const x = Math.sin((seed + 1) * 12.9898 + n * 78.233) * 43758.5453
    return x - Math.floor(x)
  }

  // Five nodes on a gentle wave; positions shift by seed for variety.
  const nodes = Array.from({ length: 5 }, (_, i) => ({
    x: 90 + i * 150 + (rnd(i) - 0.5) * 40,
    y: 150 + Math.sin(i * 1.1 + seed) * 70 + (rnd(i + 9) - 0.5) * 30,
    r: i % 2 === 0 ? 9 : 6,
    fill: i % 2 === 0,
  }))

  const bandRotate = -18 + (seed % 4) * 9

  return (
    <svg
      viewBox="0 0 800 450"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`bg-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={INK_DARK} />
          <stop offset="1" stopColor={INK_LITE} />
        </linearGradient>
        <linearGradient id={`band-${seed}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={accent} stopOpacity="0.32" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Base */}
      <rect width="800" height="450" fill={`url(#bg-${seed})`} />

      {/* Angular accent bands echoing the mark */}
      <g transform={`rotate(${bandRotate} 400 225)`}>
        <rect x="-200" y="120" width="1200" height="90" fill={`url(#band-${seed})`} />
        <rect x="-200" y="250" width="1200" height="36" fill={accent} opacity="0.14" />
      </g>

      {/* Dot grid */}
      <g fill="#ffffff" opacity="0.05">
        {Array.from({ length: 11 }).map((_, c) =>
          Array.from({ length: 6 }).map((__, r) => (
            <circle key={`${c}-${r}`} cx={40 + c * 72} cy={40 + r * 74} r="2" />
          )),
        )}
      </g>

      {/* Node network */}
      <g>
        {nodes.slice(0, -1).map((n, i) => (
          <line
            key={`l-${i}`}
            x1={n.x}
            y1={n.y}
            x2={nodes[i + 1].x}
            y2={nodes[i + 1].y}
            stroke={accent}
            strokeWidth="1.5"
            opacity="0.5"
          />
        ))}
        {nodes.map((n, i) => (
          <circle
            key={`n-${i}`}
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.fill ? accent : INK_DARK}
            stroke={accent}
            strokeWidth="2"
          />
        ))}
      </g>

      {/* Faint A-Identity watermark, bottom-right. The 512-grid glyph at 0.43 keeps the
          same ~220px footprint the old 256-grid mark had at 0.86. */}
      <g transform="translate(560 250) scale(0.43)" opacity="0.1">
        <LogoGlyph fill={accent} />
      </g>
    </svg>
  )
}
