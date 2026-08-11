import { useCallback, useState } from 'react'
import { Bot, Headset, PenLine, Search, Terminal, TrendingUp } from 'lucide-react'
import OwlMark, { type OwlVerdict } from './OwlMark'

/**
 * An agent's mark: what it does, plus the owl reporting its verdict.
 *
 * This used to be a five-by-five pixel identicon tinted `hsl(hash % 360)`. Two problems.
 * It read as a 2010s GitHub avatar next to everything else in the console, and a free hue
 * meant an agent could be handed lime, amber or red, which are the three colours that mean
 * allow, warn and deny here. A category could be mistaken for a verdict.
 *
 * So the tint comes from a fixed six-hue palette that deliberately avoids the semantic
 * three, and the glyph says what the agent is for rather than encoding its id in squares.
 * Identity is carried where it is actually legible: the name and the mono address beside
 * it, which every caller already renders.
 *
 * Three sources, in order:
 *   1. the owner's uploaded logo, when there is one,
 *   2. otherwise the shared default portrait every agent wears until it has its own,
 *   3. otherwise the generated category mark, which needs no file to exist.
 *
 * Step 2 is a file on disk, and a file can be absent (it is added outside this component).
 * A missing default is therefore not a broken tile: the image reports its own failure and
 * the generated mark takes the slot back. The check runs on the ref as well as on `error`
 * because a prerendered page can finish failing before React attaches the handler.
 *
 * The owl badge stays, on top, whatever the picture is. It is the reason a list of agents
 * can be scanned for risk without reading a single pill, and a logo must never hide it.
 */

/** The one shared portrait for agents that have not uploaded one. */
const DEFAULT_AVATAR = '/agents/default-agent.png'

const CATEGORIES: { match: RegExp; icon: typeof Bot; tint: number }[] = [
  { match: /trad|financ|defi|invest/i, icon: TrendingUp, tint: 1 },
  { match: /research|data|analy/i, icon: Search, tint: 2 },
  { match: /content|writ|market/i, icon: PenLine, tint: 3 },
  { match: /dev|code|ops|engineer/i, icon: Terminal, tint: 4 },
  { match: /support|service|customer/i, icon: Headset, tint: 5 },
]

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

export default function AgentAvatar({
  seed,
  category,
  size = 44,
  verdict,
  src,
  className = '',
}: {
  /** Address or token id. Only used to pick a tint when there is no category. */
  seed: string
  /** The agent's declared category. Free text, matched loosely. */
  category?: string
  size?: number
  /** Omitted when nothing has been decided yet, and then no badge is drawn. */
  verdict?: OwlVerdict
  /** An uploaded logo (small data: URL). When present it wins over the shared default
   *  portrait; the verdict owl stays either way, because a picture must never hide a
   *  risk signal. */
  src?: string | null
  className?: string
}) {
  const known = category ? CATEGORIES.find((c) => c.match.test(category)) : undefined
  // Without a category the tint still has to be stable per agent, so two rows never swap
  // colours between renders. The glyph falls back to the generic mark rather than
  // guessing at work the agent never claimed to do.
  const tint = known ? known.tint : (hash(seed) % 6) + 1
  const Icon = known?.icon ?? Bot
  const color = `var(--cat-${tint})`

  const badge = Math.max(16, Math.round(size * 0.52))

  // Which sources have already failed, tracked by URL rather than by a boolean: uploading
  // a new logo must get a fresh attempt instead of inheriting the previous picture's fate.
  const [failed, setFailed] = useState<string[]>([])
  const markFailed = useCallback((url: string | null | undefined) => {
    if (!url) return
    setFailed((prev) => (prev.includes(url) ? prev : [...prev, url]))
  }, [])

  // Uploaded logo first, then the shared default, then nothing (the generated mark below).
  const candidate = (src ? [src, DEFAULT_AVATAR] : [DEFAULT_AVATAR]).find((s) => !failed.includes(s))

  const noteIfBroken = useCallback(
    (node: HTMLImageElement | null) => {
      // A hydrated snapshot can finish loading (or 404ing) before React wires up onError,
      // so re-ask the element itself the moment the ref lands.
      if (node && node.complete && node.naturalWidth === 0) markFailed(node.getAttribute('src'))
    },
    [markFailed],
  )

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      {candidate ? (
        <img
          key={candidate}
          src={candidate}
          ref={noteIfBroken}
          onError={() => markFailed(candidate)}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="h-full w-full rounded-xl border border-border object-cover"
        />
      ) : (
        <div
          className="grid h-full w-full place-items-center rounded-xl"
          style={{
            background: `color-mix(in srgb, ${color} 13%, transparent)`,
            color,
          }}
          aria-hidden="true"
        >
          <Icon size={Math.round(size * 0.45)} strokeWidth={2} />
        </div>
      )}

      {verdict && (
        // The ring is the page surface, not a colour, so the badge reads as lifted off the
        // mark on every background this lands on.
        <span
          className="absolute -bottom-1 -right-1 grid place-items-center rounded-full bg-card ring-2 ring-[var(--background)]"
          style={{ width: badge, height: badge }}
        >
          <OwlMark verdict={verdict} size={Math.round(badge * 0.86)} />
        </span>
      )}
    </div>
  )
}
