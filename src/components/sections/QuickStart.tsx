import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Bot, Check, Copy, User } from 'lucide-react'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'
import { Steps, StepRow } from '../ui/step-row'

/**
 * Onboarding, split by who is reading.
 *
 * The agently lesson: this site has two audiences and they want opposite things. A human
 * wants three steps and a button; an agent (or the developer wiring one) wants a command to
 * paste and no prose at all. One section, one toggle, both served, and neither has to scroll
 * past the other's version.
 *
 * Every command here is real. The MCP endpoint is the production server this site already
 * proxies, and the curl hits the free preview tool on the live ASP; nothing is aspirational,
 * which is the only reason a copy button is honest.
 *
 * The agent pane speaks the same tty the verify section established: a terminal that is
 * dark in BOTH themes (the old card used bg-foreground, which flipped light in dark mode
 * and washed the code out to grey-on-grey). The human steps reuse the console's own stage
 * labels (Register, KYA Verify, Go Live), so what this section promises is exactly what
 * /app/agent-id walks you through.
 */

const PROMPT_COLOR = 'text-[color-mix(in_srgb,var(--color-accent)_55%,white)]'

const COMMANDS = [
  {
    comment: '# Add A-Identity to Claude Code (MCP over HTTP)',
    cmd: 'claude mcp add --transport http a-identity https://a-identity.xyz/mcp',
  },
  {
    comment: '# Free trust pre-check, no key required',
    cmd: `curl -X POST https://a-identity-asp.onrender.com/tools/trust_preview \\
  -H 'Content-Type: application/json' -d '{"agentId": "849980"}'`,
  },
]

function CommandBlock({ comment, cmd }: { comment: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <pre className="overflow-x-auto whitespace-pre pr-12 font-mono text-[12.5px] leading-[1.9]">
        <span className="text-white/35">{comment}</span>
        {'\n'}
        <span className={PROMPT_COLOR}>$</span> <span className="text-white/85">{cmd}</span>
      </pre>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(cmd)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}
        className="absolute right-0 top-0 rounded-lg border border-transparent p-2 text-white/35 transition-colors hover:border-white/15 hover:text-white"
      >
        {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
      </button>
    </div>
  )
}

export default function QuickStart() {
  const [mode, setMode] = useState<'human' | 'agent'>('human')

  return (
    <SectionShell id="quickstart" size="lg">
      <SectionIntro
        eyebrow={<Eyebrow>Getting started</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            Two audiences, one door.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Humans get three steps. Agents get a command to paste. Pick whichever you are.
          </Lede>
        }
      />

      {/* The toggle: a segmented control whose active pill slides between the two
          options (layoutId), spelled out, never an icon-only mystery switch. */}
      <motion.div {...reveal} className="mt-10">
        <div className="inline-flex rounded-full border border-border bg-card p-1 shadow-sm">
          {(
            [
              { key: 'human', label: 'I am human', Icon: User },
              { key: 'agent', label: 'I am an agent', Icon: Bot },
            ] as const
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={`relative inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors duration-200 ${
                mode === key ? 'text-background' : 'text-foreground/55 hover:text-foreground'
              }`}
            >
              {mode === key && (
                <motion.span
                  layoutId="quickstart-pill"
                  className="absolute inset-0 rounded-full bg-foreground"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
              <Icon size={15} className="relative" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      </motion.div>

      <div className="mt-10">
        <AnimatePresence mode="wait" initial={false}>
          {mode === 'human' ? (
            <motion.div
              key="human"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28 }}
            >
              <Steps columns={3}>
                <StepRow index={1} title="Register">
                  Create your on-chain agent identity via ERC-8004. One signature, no gas, no
                  signup.
                </StepRow>
                <StepRow index={2} title="KYA Verify">
                  Prove the agent controls its wallet. No personal data exposed, attested
                  on-chain.
                </StepRow>
                <StepRow index={3} title="Go Live">
                  Set the limits, assign the wallet. The agent pays and gets paid inside the
                  line you drew.
                </StepRow>
              </Steps>
              <div className="mt-10">
                <Link
                  to="/signup"
                  className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
                  style={{ boxShadow: '0 10px 34px rgba(115,66,226,0.34)' }}
                >
                  Get your Agent ID <ArrowRight size={16} />
                </Link>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="agent"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28 }}
              className="max-w-[780px] overflow-hidden rounded-2xl border border-accent/25 bg-[#10151d] shadow-[0_0_0_1px_rgba(115,66,226,0.12),0_24px_70px_-24px_rgba(115,66,226,0.45)]"
            >
              {/* window chrome, same tty the verify section speaks */}
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full border border-white/25" />
                  <span className="h-2.5 w-2.5 rounded-full border border-white/25" />
                  <span className="h-2.5 w-2.5 rounded-full border border-white/25" />
                </div>
                <span className="font-mono text-[10px] tracking-[0.14em] text-white/35">
                  tty · mcp + x402
                </span>
              </div>

              <div className="flex flex-col gap-5 p-6 sm:p-7">
                {COMMANDS.map((c) => (
                  <CommandBlock key={c.cmd} {...c} />
                ))}

                <p className="border-t border-white/10 pt-4 font-mono text-[11px] leading-relaxed text-white/40">
                  same flow as an sdk:{' '}
                  <span className="text-white/70">@a-identity/marketplace-sdk</span> · full
                  reference in the{' '}
                  <a
                    href="https://a-identity.mintlify.site/developers/mcp-server"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${PROMPT_COLOR} underline-offset-2 hover:underline`}
                  >
                    docs
                  </a>
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </SectionShell>
  )
}
