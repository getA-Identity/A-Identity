import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Bot, Check, Copy, User } from 'lucide-react'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'
import { Steps, StepRow } from '../ui/step-row'
import { OwlMascot } from '../OwlMascot'

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
 * The agent pane speaks the same tty the verify section established, painted from the
 * shared terminal tokens in index.css (bg-term, text-term-fg, text-term-faint, ...), so
 * it flips with the scoped .dark class instead of staying a dark hole in a light page.
 * The window chrome and the mono type are what say "terminal" now, not the ground. The
 * human steps reuse the console's own stage labels (Register, KYA Verify, Go Live), so
 * what this section promises is exactly what /app/agent-id walks you through.
 */

/** Step 1's choices: each runtime gets the exact line it actually needs. All four
    endpoints are the live production surfaces; nothing here is aspirational. */
const TOOLS = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    comment: '# Add A-Identity to Claude Code (MCP over HTTP)',
    cmd: 'claude mcp add --transport http a-identity https://a-identity.xyz/mcp',
  },
  {
    key: 'claude-ai',
    label: 'Claude.ai',
    comment: '# Settings → Connectors → Add custom connector, paste:',
    cmd: 'https://a-identity.xyz/mcp',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    comment: '# .cursor/mcp.json',
    cmd: `{ "mcpServers": { "a-identity": { "url": "https://a-identity.xyz/mcp" } } }`,
  },
  {
    key: 'curl',
    label: 'curl',
    comment: '# Free trust pre-check, no key required',
    cmd: `curl -X POST https://a-identity-asp.onrender.com/tools/trust_preview \\
  -H 'Content-Type: application/json' -d '{"agentId": "849980"}'`,
  },
] as const

/** Step 3's examples, one per MCP tool family the server actually exposes. */
const TRY_PROMPTS = [
  { tag: 'verify', text: 'Verify agent 849980 before I pay it' },
  { tag: 'score', text: 'What is the reputation score of agent 849980?' },
  { tag: 'hire', text: 'Find a KYA-verified translation agent and hire it for $2' },
]

function CommandBlock({ comment, cmd }: { comment: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <pre className="overflow-x-auto whitespace-pre pr-12 font-mono text-[12.5px] leading-[1.9]">
        <span className="text-term-faint">{comment}</span>
        {'\n'}
        <span className="text-term-prompt">$</span> <span className="text-term-fg">{cmd}</span>
      </pre>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(cmd)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}
        className="absolute right-0 top-0 rounded-lg border border-transparent p-2 text-term-faint transition-colors hover:border-term-border hover:text-term-fg"
      >
        {copied ? <Check size={14} className="text-term-ok" /> : <Copy size={14} />}
      </button>
    </div>
  )
}

/** One numbered row of the guided flow: circled index, connector line, content. */
function Step({
  index,
  title,
  sub,
  last = false,
  children,
}: {
  index: number
  title: string
  sub: string
  last?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="relative pb-7 pl-11 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[13px] top-8 w-px bg-border" />}
      <span className="absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full border border-border bg-card font-mono text-[11px] font-semibold text-foreground/60">
        {index}
      </span>
      <p className="pt-0.5 text-[15px] font-semibold leading-7 text-foreground">{title}</p>
      <p className="mt-0.5 text-sm text-foreground/50">{sub}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

/** The agent door as a guided flow (the base.org agents stance, at half the height):
    pick the runtime, get its exact line, then steal a first prompt. */
function AgentSteps() {
  const [tool, setTool] = useState<(typeof TOOLS)[number]['key']>('claude-code')
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)
  const active = TOOLS.find((t) => t.key === tool) ?? TOOLS[0]

  return (
    <div>
      <Step index={1} title="Pick your runtime" sub="Each one gets the exact line it needs.">
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTool(t.key)}
              aria-pressed={tool === t.key}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors duration-150 ${
                tool === t.key
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-card text-foreground/60 hover:border-accent/40 hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Step>

      <Step index={2} title="Connect the MCP" sub="The endpoint is the live production server.">
        <div className="overflow-hidden rounded-xl border border-accent/25 bg-term shadow-[0_0_0_1px_var(--term-ring),0_18px_50px_-24px_var(--term-glow)]">
          <div className="flex items-center justify-between border-b border-term-border bg-term-chrome px-4 py-2">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full border border-term-dot" />
              <span className="h-2 w-2 rounded-full border border-term-dot" />
              <span className="h-2 w-2 rounded-full border border-term-dot" />
            </div>
            <span className="font-mono text-[10px] tracking-[0.14em] text-term-faint">tty · mcp + x402</span>
          </div>
          <div className="p-4">
            <CommandBlock key={active.key} comment={active.comment} cmd={active.cmd} />
          </div>
        </div>
      </Step>

      <Step index={3} title="Try it out" sub="A-Identity is connected. Steal a first prompt." last>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {TRY_PROMPTS.map((p) => (
            <button
              key={p.tag}
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(p.text)
                setCopiedPrompt(p.tag)
                setTimeout(() => setCopiedPrompt(null), 1400)
              }}
              className="group flex w-full items-center gap-4 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.03]"
            >
              <span className="w-12 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-foreground/40">
                {p.tag}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/70">{p.text}</span>
              {copiedPrompt === p.tag ? (
                <Check size={13} className="shrink-0 text-ok" />
              ) : (
                <Copy size={13} className="shrink-0 text-foreground/25 transition-colors group-hover:text-foreground/60" />
              )}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-foreground/40">
          Prefer packages? <span className="font-mono text-foreground/60">@a-identity/marketplace-sdk</span>{' '}
          for the full loop, <span className="font-mono text-foreground/60">@a-identity/trust-guard</span>{' '}
          to just gate a payment · full reference in the{' '}
          <a
            href="https://a-identity.mintlify.site/developers/mcp-server"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-accent underline-offset-2 hover:underline"
          >
            docs
          </a>
          .
        </p>
      </Step>
    </div>
  )
}

export default function QuickStart() {
  const [mode, setMode] = useState<'human' | 'agent'>('human')

  return (
    <SectionShell id="quickstart" size="lg" backdrop="door">
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

      {/* Content on the reading edge; on the right, the mascot plays the doorman and
          changes face with the door: the soft owl greets a human, the officer sizes up
          an agent. Decorative, so it drops out below lg. */}
      <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center lg:gap-12">
        <div>
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
                className="max-w-[780px]"
              >
                <AgentSteps />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="hidden lg:block" aria-hidden="true">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode}
              initial={{ opacity: 0, y: 18, rotate: mode === 'agent' ? -4 : 4, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              className="text-center"
            >
              <OwlMascot
                variant={mode === 'human' ? 'soft' : 'officer'}
                width={300}
                className="mx-auto w-[280px] max-w-full"
              />
              <p className="mt-1 font-mono text-[11px] tracking-[0.12em] text-foreground/70">
                {mode === 'human' ? 'welcome in' : 'papers, please'}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </SectionShell>
  )
}
