import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { usePageMeta } from '../lib/head'

/**
 * The pitch deck: the final Demo Day deck (A-Identity, Final, 13 November 2026), eleven slides on a
 * fixed 1920x1080 stage scaled to fit the window.
 *
 * Design and content are the PDF's, unchanged: each slide IS that PDF page, exported at 2560x1440
 * from the page's own 3840x2160 art. The only thing this page adds is motion. When a slide opens,
 * its content arrives in bands (top bar, headline, the body left to right, the footer) while the
 * page comes into focus behind them. Every band is a window onto the same image at the same place,
 * so the last frame of the animation is the PDF page, pixel for pixel. Reduced motion and print
 * mode show that last frame at once.
 *
 * Driven by the arrow keys, space, a swipe, the dots or the two click zones, and it keeps its
 * place in the hash (#3), so a link can open on a given slide. `?print=1` renders every slide
 * stacked, one per page, for a PDF export.
 *
 * Unlinked and noindex, like /motion and /mascot. Its colors are sampled from the PDF, not the
 * site's theme tokens, so the deck looks the same whichever theme the site is in.
 */

const W = 1920
const H = 1080
const EASE = [0.16, 1, 0.3, 1] as const

// The slides' own edge colors (top-left and bottom-right of every page), so the letterbox around
// a slide that does not fill the window blends into it.
const PAGE_TOP_LEFT = '#f6f5f1'
const PAGE_BOTTOM_RIGHT = '#e9e2f5'
const INK = '#151a33'

type DeckSlide = { src: string; alt: string }

// The alt text is each page's own text, in reading order, for screen readers and for anyone who
// cannot load the images.
const SLIDES: DeckSlide[] = [
  {
    src: '/deck/final/slide-01.webp',
    alt: 'Verify before AI agents pay. We check who an AI agent is about to pay and enforce spend limits before money moves. Aybars Dorman, Co-Founder and CEO. Demo Day, 13 November 2026. Arc Acceleration Season by Crecimiento.',
  },
  {
    src: '/deck/final/slide-02.webp',
    alt: 'The trust gap in agentic commerce. Permissions limit what, how much, how often and until when. Never who gets paid. 165M+ x402 transactions by April 2026, per Coinbase. $15T+ B2B spend through AI agents by 2028, per Gartner. 0 chargeback window: on-chain payments are final. Unknown counterparties: who is this agent, who stands behind it? Unbounded spend: a limit caps the amount, not who receives it. No durable proof: no receipt or audit trail after the payment.',
  },
  {
    src: '/deck/final/slide-03.webp',
    alt: 'How A-Identity works. Four steps to set up. One command for agents. MCP, Connector, SDK.',
  },
  {
    src: '/deck/final/slide-04.webp',
    alt: 'Agents just got wallets. Card networks and stablecoin rails opened to AI agents in under two years. 2025: Visa, Mastercard and Coinbase agent payment programs launch on cards and x402; cards and x402 live. May 2026: Circle Agent Stack, agent wallets and nanopayments in USDC; sub-cent USDC payments. September 2026: Arc Mainnet opens, Circle opens its own chain for USDC payments; sub-second finality. The rails exist. The check before payment does not. Bain projects $300B to $500B in US agentic e-commerce by 2030.',
  },
  {
    src: '/deck/final/slide-05.webp',
    alt: 'Live traction on chain. Real usage, real customers, real backing. 137 paid checks in 6 weeks. 33 from 8 outside wallets. 3,281 payments settled. 8 live mainnets. 2 cohort collaborations. +5 potential customers in talks. 4 grants won, Arc included. Circle Alliance Program member. Arc Microgrant recipient. Agent #0 on other mainnets too.',
  },
  {
    src: '/deck/final/slide-06.webp',
    alt: 'Big market, simple pricing. $3T to $5T agentic commerce worldwide by 2030, McKinsey, October 2025. $0.001 to $0.01: pay as you go, live today. Free to try, then USDC per call. $49 a month: starter pack, next. A monthly bundle of checks for teams. Custom: tailored enterprise, next. Custom policies and SLAs, book a call. Sold to the teams that sign off on agent spend.',
  },
  {
    src: '/deck/final/slide-07.webp',
    alt: 'The missing trust layer. Others move the money. We check who gets paid before it moves. A comparison of cards (Visa, Mastercard), rails and x402 (Circle, Coinbase), Skyfire agent pay, agent ID proof, agent wallets (Privy, Turnkey) and the A-Identity trust oracle on five rows: moves the money, caps the spend, verifies the buyer agent, checks the seller first, agent reputation score. Partial, lists only.',
  },
  {
    src: '/deck/final/slide-08.webp',
    alt: 'Builders who ship. One side sells payments. One side ships them. Aybars Dorman, Co-Founder and CEO. Meriç Cintosun, Co-Founder and CTO. Müge Ayşe Polat, Head of Brand and Strategy. Ensar Mert Günay, Digital Growth Lead. Ezgin Akyürek, Blockchain Developer. Agent #0, always on, 24/7.',
  },
  {
    src: '/deck/final/slide-09.webp',
    alt: 'Q1 2027: US entity and paid rollout, a Delaware C-Corp and paid checks on Arc. June 2027: 1,000 paying teams, 25,000 ERC-8004 agents scored. H2 2027: finance team product and first enterprise, with policies, approvals and an audit trail. The ask: raising $500,000 pre-seed, to turn live usage into paying teams.',
  },
  {
    src: '/deck/final/slide-10.webp',
    alt: 'Built this season. What we shipped and proved during Arc Acceleration Season. Live on Arc Mainnet: Agent #0 minted on day one. 137 paid checks: 33 from 8 outside wallets. 2 cohort startups: collaboration between startups and partners. +5 potential customers in talks. Circle Alliance Member, plus Arc Microgrant. Thank you, Arc, Circle and Crecimiento.',
  },
  {
    src: '/deck/final/slide-11.webp',
    alt: 'Verify, then pay. a-identity.xyz/connect. Contact: reach out to us. Back the round, verify your agents, or book a call. a-identity.xyz, hello@a-identity.xyz, x.com/ai_dentity, t.me/aybarsdorman.',
  },
]

// The bands a slide arrives in, as insets of the page (top, right, bottom, left, in percent), in
// the order they appear. Together they cover the whole page, so nothing is missing at the end.
const BANDS: Array<[number, number, number, number]> = [
  [0, 0, 85, 0], // the top bar: logo and date
  [15, 0, 68, 0], // the headline
  [32, 64, 14, 0], // the body, left
  [32, 34, 14, 36], // the body, middle
  [32, 0, 14, 66], // the body, right
  [86, 0, 0, 0], // the footer: partners and the page number
]

function useFitScale() {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return scale
}

function readHash() {
  const n = Number(window.location.hash.replace('#', ''))
  return Number.isInteger(n) && n >= 1 && n <= SLIDES.length ? n - 1 : 0
}

/** One slide, still: exactly the PDF page. */
function StillSlide({ slide }: { slide: DeckSlide }) {
  return <img src={slide.src} alt={slide.alt} width={W} height={H} className="block h-full w-full select-none" draggable={false} />
}

/** One slide arriving: the page comes into focus while its bands rise into place. */
function ArrivingSlide({ slide }: { slide: DeckSlide }) {
  return (
    <div className="relative h-full w-full">
      <motion.img
        src={slide.src}
        alt={slide.alt}
        width={W}
        height={H}
        className="absolute inset-0 block h-full w-full select-none"
        draggable={false}
        initial={{ opacity: 0.25, filter: 'blur(16px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        transition={{ duration: 1.1, ease: EASE, delay: 0.1 }}
      />
      {BANDS.map(([t, r, b, l], i) => (
        <motion.img
          key={i}
          src={slide.src}
          alt=""
          aria-hidden
          width={W}
          height={H}
          className="pointer-events-none absolute inset-0 block h-full w-full select-none"
          draggable={false}
          style={{ clipPath: `inset(${t}% ${r}% ${b}% ${l}%)` }}
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: EASE, delay: 0.06 + i * 0.11 }}
        />
      ))}
    </div>
  )
}

function PrintDeck() {
  return (
    <>
      <style>{`@page { size: ${W}px ${H}px; margin: 0 } html, body { margin: 0; background: ${PAGE_TOP_LEFT} } .deck-page { break-after: page; width: ${W}px; height: ${H}px }`}</style>
      {SLIDES.map((s, i) => (
        <section key={i} className="deck-page" data-slide={i + 1}>
          <StillSlide slide={s} />
        </section>
      ))}
    </>
  )
}

function LiveDeck() {
  const scale = useFitScale()
  const reduce = useReducedMotion()
  const [[index, dir], setState] = useState<[number, 1 | -1]>(() => [readHash(), 1])
  const touchX = useRef<number | null>(null)

  const go = useCallback((next: number) => {
    setState(([cur]) => {
      const clamped = Math.max(0, Math.min(SLIDES.length - 1, next))
      return clamped === cur ? [cur, 1] : [clamped, clamped > cur ? 1 : -1]
    })
  }, [])

  useEffect(() => {
    window.history.replaceState(null, '', `#${index + 1}`)
  }, [index])

  // The neighbours load ahead, so a slide never arrives before its image.
  useEffect(() => {
    for (const n of [index - 1, index + 1]) {
      if (n >= 0 && n < SLIDES.length) new Image().src = SLIDES[n].src
    }
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault()
        go(index + 1)
      } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) {
        e.preventDefault()
        go(index - 1)
      } else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(SLIDES.length - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, index])

  const slide = SLIDES[index]
  const left = (window.innerWidth - W * scale) / 2
  const top = (window.innerHeight - H * scale) / 2

  return (
    <div
      className="fixed inset-0 cursor-pointer overflow-hidden"
      style={{ background: `linear-gradient(135deg, ${PAGE_TOP_LEFT}, ${PAGE_BOTTOM_RIGHT})` }}
      // Click zones: the left third goes back, the rest goes forward.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return
        go(index + (e.clientX < window.innerWidth / 3 ? -1 : 1))
      }}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return
        const dx = e.changedTouches[0].clientX - touchX.current
        if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1))
        touchX.current = null
      }}
    >
      <div className="absolute origin-top-left overflow-hidden" style={{ width: W, height: H, left, top, transform: `scale(${scale})` }}>
        {reduce ? (
          <StillSlide slide={slide} />
        ) : (
          <AnimatePresence mode="wait" custom={dir} initial={true}>
            <motion.div
              key={index}
              custom={dir}
              className="h-full w-full"
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d * 40 }),
                center: { opacity: 1, x: 0 },
                exit: (d: number) => ({ opacity: 0, x: d * -40 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.35, ease: EASE }}
            >
              <ArrivingSlide slide={slide} />
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: 'rgba(21, 26, 51, 0.08)' }}>
        <motion.div
          className="h-full"
          style={{ background: 'linear-gradient(90deg, #6d4aff, #8b6cff)' }}
          animate={{ width: `${((index + 1) / SLIDES.length) * 100}%` }}
          transition={{ duration: 0.6, ease: EASE }}
        />
      </div>
      <nav
        className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full px-3 py-2 backdrop-blur"
        style={{ background: 'rgba(255, 255, 255, 0.72)', border: '1px solid rgba(21, 26, 51, 0.10)', color: INK }}
      >
        <button aria-label="Previous slide" onClick={() => go(index - 1)} className="rounded-full p-1 opacity-70 hover:opacity-100">
          <ChevronLeft size={18} />
        </button>
        {SLIDES.map((_, i) => (
          <button
            key={i}
            aria-label={`Slide ${i + 1}`}
            aria-current={i === index ? 'true' : undefined}
            onClick={() => go(i)}
            className={`h-2 rounded-full transition-all ${i === index ? 'w-6' : 'w-2 opacity-30 hover:opacity-60'}`}
            style={{ background: i === index ? '#6d4aff' : INK }}
          />
        ))}
        <button aria-label="Next slide" onClick={() => go(index + 1)} className="rounded-full p-1 opacity-70 hover:opacity-100">
          <ChevronRight size={18} />
        </button>
      </nav>
    </div>
  )
}

export default function Deck() {
  usePageMeta({
    title: 'A-Identity · Pitch Deck',
    description: 'Verify before AI agents pay: A-Identity checks who an AI agent is about to pay and enforces spend limits before money moves.',
    noindex: true,
  })
  const print = useMemo(() => new URLSearchParams(window.location.search).has('print'), [])
  return print ? <PrintDeck /> : <LiveDeck />
}
