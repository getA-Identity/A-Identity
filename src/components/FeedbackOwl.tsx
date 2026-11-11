import { useEffect, useRef } from 'react'
import { motion, useMotionValue, useReducedMotion, useSpring, type Variants } from 'framer-motion'
import { Github } from 'lucide-react'
import DiscordIcon from './DiscordIcon'
import LinkedInIcon from './LinkedInIcon'
import XIcon from './XIcon'
import YouTubeIcon from './YouTubeIcon'
import { SOCIALS } from '../lib/brand'
import { cn } from '../lib/utils'

/**
 * The visual half of /feedback: the deck's night sky (navy depth, two drifting glows, a faint
 * grid, the orbit rings) with the rendered owl floating in it, and the social row along the
 * bottom.
 *
 * The owl is the same soft render the deck and the landing use, and it stays that owl: the
 * verdict-eyed renders are a different, patterned model, and a bird that changes species on
 * Send reads as a glitch. The outcome is told by the light behind it instead, in the verdict
 * colours: accent at rest, green once the email went out, amber when the server could not send
 * and the mailto takes over, red on an error worth retrying. Green only ever follows a
 * delivered send, because the page only reaches `sent` on `delivered: true`.
 *
 * The panel is always the dark scope, like the deck, whatever the page theme. The owl and the
 * sky are decorative and hidden from assistive tech; the social links are not. Reduced motion
 * gets a still owl, decided here rather than left to MotionConfig, because an infinite loop
 * collapsed to zero duration is still a loop.
 */

export type OwlMood = 'idle' | 'typing' | 'sending' | 'sent' | 'fallback' | 'error'

type Tone = 'accent' | 'ok' | 'warn' | 'danger'
const TONES: Tone[] = ['accent', 'ok', 'warn', 'danger']

const TONE: Record<OwlMood, Tone> = {
  idle: 'accent',
  typing: 'accent',
  sending: 'accent',
  sent: 'ok',
  fallback: 'warn',
  error: 'danger',
}

/**
 * What each mood adds on top of the float, which runs on its own wrapper so a mood change
 * never restarts it. Every keyframe list starts and ends at rest, and the sending wiggle runs
 * on rotateZ, which composes with rotate, so a tilt eases back instead of snapping.
 */
const MOOD: Variants = {
  idle: { y: 0, x: 0, rotate: 0, rotateZ: 0, transition: { rotate: { duration: 0.5 } } },
  typing: { y: 0, x: 0, rotate: 4, rotateZ: 0, transition: { rotate: { type: 'spring', stiffness: 120, damping: 14 } } },
  sending: { y: 0, x: 0, rotate: 0, rotateZ: [0, -3, 3, 0], transition: { rotate: { duration: 0.3 }, rotateZ: { duration: 0.7, repeat: Infinity, ease: 'easeInOut' } } },
  sent: { y: [0, -30, 0, -12, 0], x: 0, rotate: 0, rotateZ: 0, transition: { y: { duration: 1.1, ease: 'easeOut' } } },
  fallback: { y: 0, x: 0, rotate: -5, rotateZ: 0, transition: { rotate: { type: 'spring', stiffness: 140, damping: 12 } } },
  error: { y: 0, x: [0, -9, 9, -6, 6, 0], rotate: 0, rotateZ: 0, transition: { x: { duration: 0.5 } } },
}

const SOCIAL_LINKS = [
  { href: SOCIALS.x, label: 'A-Identity on X', Icon: XIcon },
  { href: SOCIALS.linkedin, label: 'A-Identity on LinkedIn', Icon: LinkedInIcon },
  { href: SOCIALS.youtube, label: 'A-Identity on YouTube', Icon: YouTubeIcon },
  { href: SOCIALS.discord, label: 'Join the A-Identity Discord', Icon: DiscordIcon },
  { href: SOCIALS.github, label: 'A-Identity on GitHub', Icon: Github },
].filter((s) => s.href)

const GRID_MASK = 'radial-gradient(ellipse 75% 65% at 50% 40%, black, transparent 85%)'

export default function FeedbackOwl({ mood, className = '' }: { mood: OwlMood; className?: string }) {
  const still = useReducedMotion() ?? false
  const stageRef = useRef<HTMLDivElement>(null)
  const lean = useMotionValue(0)
  const leanSpring = useSpring(lean, { stiffness: 110, damping: 16 })

  // A few degrees toward the pointer, wherever it is on the page. Never wired for reduced
  // motion, and harmless on touch, where there is no hover to follow.
  useEffect(() => {
    if (still) return
    const onMove = (e: PointerEvent) => {
      const stage = stageRef.current
      if (!stage) return
      const r = stage.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      lean.set(Math.max(-5, Math.min(5, dx / 90)))
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [still, lean])

  const spin = (dir: 1 | -1, duration: number) =>
    still ? {} : { animate: { rotate: 360 * dir }, transition: { duration, repeat: Infinity, ease: 'linear' as const } }
  const drift = (x: number[], y: number[], duration: number) =>
    still ? {} : { animate: { x, y }, transition: { duration, repeat: Infinity, ease: 'easeInOut' as const } }

  return (
    <div className={cn('dark relative isolate overflow-hidden rounded-[28px] bg-background text-foreground', className)}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 0%, var(--card), var(--background) 65%)' }} />
        <motion.div
          className="absolute -left-28 -top-36 h-[460px] w-[460px] rounded-full blur-[110px]"
          style={{ background: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}
          {...drift([0, 60, 0], [0, 40, 0], 18)}
        />
        <motion.div
          className="absolute -bottom-44 -right-28 h-[460px] w-[460px] rounded-full blur-[120px]"
          style={{ background: 'color-mix(in srgb, var(--usdc) 28%, transparent)' }}
          {...drift([0, -50, 0], [0, -30, 0], 22)}
        />
        <div
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: GRID_MASK,
            WebkitMaskImage: GRID_MASK,
          }}
        />
      </div>

      <div aria-hidden="true" className="absolute inset-x-0 bottom-16 top-0 flex items-center justify-center">
        <div ref={stageRef} className="relative aspect-square h-[84%] max-h-[460px]">
          {/* The outcome light: one layer per tone, crossfaded, so the colour change is a fade
              rather than a jump. It breathes while a send is in flight. */}
          {TONES.map((tone) => (
            <motion.div
              key={tone}
              // The class is what the prerendered page shows before framer takes over the opacity
              // inline, so only the resting accent layer is lit there.
              className={cn('absolute inset-[4%] rounded-full blur-[80px]', tone === 'accent' ? 'opacity-45' : 'opacity-0')}
              style={{ background: `color-mix(in srgb, var(--${tone}) 70%, transparent)` }}
              initial={false}
              animate={{
                opacity: TONE[mood] !== tone ? 0 : mood === 'sending' && !still ? [0.45, 0.85, 0.45] : tone === 'accent' ? 0.45 : 1,
              }}
              transition={mood === 'sending' && !still ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : { duration: still ? 0 : 0.6 }}
            />
          ))}
          <motion.svg viewBox="0 0 100 100" className="absolute inset-[2%] h-[96%] w-[96%]" {...spin(1, 70)}>
            <circle cx="50" cy="50" r="49" fill="none" stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="0.25" strokeDasharray="0.8 2.4" />
            <circle cx="50" cy="1" r="0.9" fill="var(--accent)" />
          </motion.svg>
          <motion.svg viewBox="0 0 100 100" className="absolute inset-[16%] h-[68%] w-[68%]" {...spin(-1, 50)}>
            <circle cx="50" cy="50" r="49" fill="none" stroke="var(--usdc)" strokeOpacity="0.45" strokeWidth="0.3" strokeDasharray="6 5" />
            <circle cx="99" cy="50" r="1.1" fill="var(--usdc)" />
          </motion.svg>
          <motion.div className="absolute inset-0" style={{ rotate: still ? 0 : leanSpring, transformOrigin: '50% 85%' }}>
            <motion.div className="absolute inset-0" animate={still ? undefined : { y: [0, -12, 0] }} transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}>
              <motion.div className="absolute inset-0" variants={MOOD} animate={still ? undefined : mood}>
                <img
                  src="/mascots/owl-soft.png"
                  alt=""
                  width={700}
                  height={700}
                  draggable={false}
                  className="absolute inset-0 h-full w-full select-none object-contain"
                  style={{ filter: 'drop-shadow(0 28px 40px rgba(0,0,0,0.45))' }}
                />
              </motion.div>
            </motion.div>
          </motion.div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex h-16 items-center justify-between gap-4 border-t border-border/60 bg-background/45 px-5 sm:px-6">
        <span className="hidden text-sm text-foreground/60 sm:block">Follow A-Identity</span>
        <ul className="mx-auto flex items-center gap-1 sm:mx-0">
          {SOCIAL_LINKS.map(({ href, label, Icon }) => (
            <li key={label}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="grid h-9 w-9 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon size={17} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
