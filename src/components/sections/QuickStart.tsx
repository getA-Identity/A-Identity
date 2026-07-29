import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
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
 * The human steps reuse the console's own stage labels (Register, KYA Verify, Go Live), so
 * what this section promises is exactly what /app/agent-id walks you through.
 */

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
      <pre className="overflow-x-auto whitespace-pre rounded-2xl bg-black/30 p-4 pr-12 font-mono text-[13px] leading-relaxed">
        <span className="text-white/35">{comment}</span>
        {'\n'}
        <span className="text-emerald-300/90">$</span> <span className="text-white/90">{cmd}</span>
      </pre>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(cmd)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}
        className="absolute right-3 top-3 rounded-lg p-2 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check size={14} className="text-emerald-300" /> : <Copy size={14} />}
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

      {/* The toggle. Two options, spelled out, never an icon-only mystery switch. */}
      <motion.div {...reveal} className="mt-10">
        <div className="inline-flex rounded-full border border-border bg-card p-1">
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
              className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors ${
                mode === key ? 'bg-foreground text-background' : 'text-foreground/55 hover:text-foreground'
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </motion.div>

      <div className="mt-10">
        {mode === 'human' ? (
          <div>
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
            <motion.div {...reveal} className="mt-10">
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
                style={{ boxShadow: '0 10px 34px rgba(115,66,226,0.34)' }}
              >
                Get your Agent ID <ArrowRight size={16} />
              </Link>
            </motion.div>
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="max-w-[760px] rounded-3xl bg-foreground p-6 sm:p-8"
          >
            <div className="flex items-center gap-2 pb-4">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
              <span className="ml-2 font-mono text-[11px] text-white/30">a-identity</span>
            </div>
            <div className="flex flex-col gap-3">
              {COMMANDS.map((c) => (
                <CommandBlock key={c.cmd} {...c} />
              ))}
            </div>
            <p className="mt-4 font-mono text-[11px] leading-relaxed text-white/35">
              Same flow as an SDK: <span className="text-white/60">@a-identity/marketplace-sdk</span> ·
              full reference in the{' '}
              <a
                href="https://a-identity.mintlify.site/developers/mcp-server"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/60 underline-offset-2 hover:underline"
              >
                docs
              </a>
              .
            </p>
          </motion.div>
        )}
      </div>
    </SectionShell>
  )
}
