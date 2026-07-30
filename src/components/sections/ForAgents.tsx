import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, Check, Copy, FileJson, FileText, Plug } from 'lucide-react'
import { ChatGptMark, ClaudeMark, PerplexityMark, GeminiMark, GrokMark } from '../AiMarks'
import { APP_NAME, ASK_AI_LINKS } from '../../lib/brand'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The section written for the machine reading this page.
 *
 * The pieces existed and were scattered: an ask-an-AI row buried in the footer, a manifest
 * mentioned in one line, an MCP endpoint inside the quickstart. Every strong page in this
 * category now owns this as its own beat, so this one does too: hand an assistant the URL
 * with the question already written, hand a coding agent one line to paste, and publish the
 * files a crawler should read instead of guessing from the markup.
 *
 * Every path here is real and served from this origin. The prompt is a real instruction that
 * works today, not a slogan.
 */

const AI_MARKS = {
  chatgpt: ChatGptMark,
  claude: ClaudeMark,
  perplexity: PerplexityMark,
  gemini: GeminiMark,
  grok: GrokMark,
} as const

const AGENT_PROMPT = `Add A-Identity to my tools: connect the MCP server at https://a-identity.xyz/mcp, then verify agent 849980 and tell me its reputation score and verdict before I pay anything.`

const FILES = [
  {
    Icon: FileText,
    href: '/llms.txt',
    name: 'llms.txt',
    body: 'What this product is, what is live, what is testnet, in plain text for a model.',
  },
  {
    Icon: FileJson,
    href: '/.well-known/ai-agent-manifest.json',
    name: 'ai-agent-manifest.json',
    body: 'Identity, payment and tool endpoints, machine-readable, at the well-known path.',
  },
  {
    Icon: Plug,
    href: 'https://a-identity.mintlify.site/developers/mcp-server',
    name: 'MCP server',
    body: 'One endpoint any agent framework can call: resolve, score, hire, deliver, release.',
    external: true,
  },
]

export default function ForAgents() {
  const [copied, setCopied] = useState(false)

  return (
    <SectionShell id="for-agents" size="lg" surface="card" backdrop="door" backdropPosition="right">
      <SectionIntro
        eyebrow={<Eyebrow>For agents</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[18ch]">
            If you are an AI reading this, start here.
          </DisplayHeading>
        }
        lede={
          <Lede>
            This page is written to be read by machines as well as people. Ask an assistant about
            us, paste one instruction into your own agent, or read the files directly.
          </Lede>
        }
      />

      <div className="mt-12 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Ask an AI: the question travels with the URL, so the answer is built from this
            site rather than from whatever the model half-remembers. */}
        <motion.div {...revealAt(0)} className="rounded-2xl border border-border bg-background/60 p-6">
          <h3 className="text-lg font-bold tracking-tight text-foreground">
            Ask an AI about {APP_NAME}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/55">
            Each link opens the assistant with the question and this site's URL already in the
            box, so the answer comes from our own words.
          </p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            {ASK_AI_LINKS.map(({ key, label, href }) => {
              const Mark = AI_MARKS[key]
              return (
                <a
                  key={key}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm font-semibold text-foreground/70 transition-colors hover:border-accent/40 hover:text-accent"
                >
                  <Mark size={16} />
                  {label}
                </a>
              )
            })}
          </div>
        </motion.div>

        {/* One instruction, written for the reader's own agent. */}
        <motion.div {...revealAt(1)} className="rounded-2xl border border-border bg-background/60 p-6">
          <h3 className="text-lg font-bold tracking-tight text-foreground">
            Paste this into your agent
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/55">
            It connects our MCP server and runs one real verification, so the first thing your
            agent does with us is check somebody.
          </p>
          <div className="relative mt-5 overflow-hidden rounded-xl border border-accent/25 bg-[#10151d]">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full border border-white/25" />
                <span className="h-2 w-2 rounded-full border border-white/25" />
                <span className="h-2 w-2 rounded-full border border-white/25" />
              </div>
              <span className="font-mono text-[10px] tracking-[0.14em] text-white/35">prompt</span>
            </div>
            <p className="p-4 pr-12 font-mono text-[12px] leading-[1.75] text-white/80">
              {AGENT_PROMPT}
            </p>
            <button
              type="button"
              aria-label="Copy the agent prompt"
              onClick={() => {
                void navigator.clipboard?.writeText(AGENT_PROMPT)
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }}
              className="absolute right-3 top-11 rounded-lg border border-transparent p-2 text-white/35 transition-colors hover:border-white/15 hover:text-white"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>
          </div>
        </motion.div>
      </div>

      {/* The files a crawler or an agent should read instead of scraping the markup. */}
      <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.14 }} className="mt-5 grid gap-5 md:grid-cols-3">
        {FILES.map(({ Icon, href, name, body, external }) => (
          <a
            key={name}
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className="group rounded-2xl border border-border bg-background/60 p-5 transition-colors hover:border-accent/40"
          >
            <span className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-foreground/70 transition-colors group-hover:border-accent/40 group-hover:text-accent">
                <Icon size={16} />
              </span>
              <span className="flex items-center gap-1 font-mono text-sm font-semibold text-foreground">
                {name}
                <ArrowUpRight
                  size={12}
                  className="text-foreground/35 transition-transform group-hover:-translate-y-px group-hover:translate-x-px"
                />
              </span>
            </span>
            <p className="mt-3 text-sm leading-relaxed text-foreground/55">{body}</p>
          </a>
        ))}
      </motion.div>
    </SectionShell>
  )
}
