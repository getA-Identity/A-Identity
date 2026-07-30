import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, BadgeCheck, Snowflake } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'
import { ProductMock, MockRow, MockValue, MockToggle } from '../ui/product-mock'
import OwlMark from '../OwlMark'

/**
 * The console, shown as itself inside a frame, and now ALIVE: the caps cycle
 * through presets when clicked, the switches actually flip, and throwing the
 * freeze switch dims the trust panel next to it because that is literally what
 * freeze does, nothing moves. Letting a visitor pull the levers teaches the
 * product faster than any copy; every value and label is still the console's
 * real vocabulary.
 *
 * A palette illustration sits far behind the frame at whisper opacity, so the
 * section has a horizon without competing with the interactive surface.
 */

const DAILY_CAPS = ['$50.00', '$100.00', '$250.00']
const AUTO_APPROVES = ['$5.00', '$1.00', '$25.00']

/** A row the visitor can press: hover lifts it a breath, tap sinks it. */
function PressableRow({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      whileHover={{ scale: 1.012 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="block w-full cursor-pointer text-left"
    >
      {children}
    </motion.button>
  )
}

export default function ConsoleShowcase() {
  const [capIdx, setCapIdx] = useState(0)
  const [autoIdx, setAutoIdx] = useState(0)
  const [allowlist, setAllowlist] = useState(true)
  const [frozen, setFrozen] = useState(false)

  return (
    <SectionShell size="lg" surface="card" backdrop="console">
      <SectionIntro
        eyebrow={<Eyebrow>The console</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[18ch]">
            Your rules, in one place the agent cannot edit.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Caps, allowlists, session keys and a freeze switch, enforced outside the model
            and mirrored on-chain. This is the actual surface, not a mockup of one. Go on,
            pull the levers.
          </Lede>
        }
      />

      <div className="relative mt-14">
        {/* The horizon: brand art far behind the frame, at whisper opacity. */}
        <img
          src="/art/art-vault.webp"
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="pointer-events-none absolute -right-10 -top-24 hidden w-[420px] rotate-6 opacity-[0.08] lg:block"
        />

        {/* The frame: a soft gradient mat around an inner card, dashx-style. */}
        <motion.div
          {...reveal}
          transition={{ ...reveal.transition, delay: 0.12 }}
          className="relative rounded-[2rem] border border-border bg-gradient-to-b from-foreground/[0.05] to-transparent p-2.5 shadow-[0_40px_100px_-40px_rgba(16,24,40,0.35)] sm:p-3"
        >
          {/* min-w-0 on the grid items: a grid child's default min-width is auto, so a
              wide mono value inside a mock could otherwise push past a phone viewport. */}
          <div className="grid gap-4 rounded-[1.6rem] border border-border bg-background/70 p-4 backdrop-blur-sm sm:p-6 md:grid-cols-2 [&>*]:min-w-0">
            <ProductMock title="Spend Permissions" meta="agent · translator-01 · Arc testnet">
              <PressableRow label="Cycle the daily cap" onClick={() => setCapIdx((i) => (i + 1) % DAILY_CAPS.length)}>
                <MockRow
                  label="Daily cap"
                  sub="resets 00:00 UTC · click to change"
                  value={
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={capIdx}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.18 }}
                      >
                        <MockValue>{DAILY_CAPS[capIdx]}</MockValue>
                      </motion.span>
                    </AnimatePresence>
                  }
                />
              </PressableRow>
              <PressableRow label="Cycle the auto-approve line" onClick={() => setAutoIdx((i) => (i + 1) % AUTO_APPROVES.length)}>
                <MockRow
                  label="Auto-approve under"
                  sub="above this, a human signs"
                  value={
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={autoIdx}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.18 }}
                      >
                        <MockValue>{AUTO_APPROVES[autoIdx]}</MockValue>
                      </motion.span>
                    </AnimatePresence>
                  }
                />
              </PressableRow>
              <PressableRow label="Toggle the payee allowlist" onClick={() => setAllowlist((v) => !v)}>
                <MockRow label="Payee allowlist" sub={allowlist ? '4 addresses' : 'off · anyone can be paid'} value={<MockToggle on={allowlist} />} />
              </PressableRow>
              <PressableRow label="Toggle the freeze switch" onClick={() => setFrozen((v) => !v)}>
                <MockRow
                  label="Freeze"
                  sub={frozen ? 'everything is stopped' : 'stops everything, instantly'}
                  value={<MockToggle on={frozen} />}
                />
              </PressableRow>
            </ProductMock>

            {/* The trust panel reacts to the freeze switch, because that is what freeze
                means: verdicts keep computing, money stops moving. */}
            <div className="relative">
              <div className={`transition-all duration-500 ${frozen ? 'opacity-40 blur-[1px] saturate-50' : ''}`}>
                <ProductMock title="Trust check" meta="explorer · live from the chain">
                  <MockRow
                    leading={<OwlMark verdict="allow" size={30} />}
                    label="Meridian"
                    sub="#849980 · KYA verified"
                    value={
                      <span className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs font-bold" style={{ color: '#059669', background: '#05966914' }}>
                        ALLOW
                      </span>
                    }
                  />
                  <MockRow label="Reputation" sub="settlements, validation, tenure" value={<MockValue>720 / 1000</MockValue>} />
                  <MockRow
                    leading={<BadgeCheck size={16} className="text-emerald-600" />}
                    label="Wallet control proven"
                    sub="attested in the ValidationRegistry"
                  />
                  <MockRow
                    leading={<OwlMark verdict="deny" size={30} />}
                    label="Unknown counterparty"
                    sub="no on-chain identity"
                    value={
                      <span className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs font-bold" style={{ color: '#dc2626', background: '#dc262614' }}>
                        DENY
                      </span>
                    }
                  />
                </ProductMock>
              </div>
              <AnimatePresence>
                {frozen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.94 }}
                    transition={{ duration: 0.25 }}
                    className="absolute inset-0 grid place-items-center"
                  >
                    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-mono text-xs font-bold text-foreground shadow-lg">
                      <Snowflake size={14} className="text-accent" />
                      FROZEN · nothing moves until you unfreeze
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>

      <motion.div {...reveal} className="mt-8">
        <Link
          to="/explorer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-opacity hover:opacity-80"
        >
          Open the live explorer <ArrowRight size={15} />
        </Link>
      </motion.div>
    </SectionShell>
  )
}
