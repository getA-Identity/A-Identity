import { ArrowUp, Terminal, Github } from 'lucide-react'
import { Link } from 'react-router-dom'
import Logo from '../Logo'
import DiscordIcon from '../DiscordIcon'
import XIcon from '../XIcon'
import { ChatGptMark, ClaudeMark, PerplexityMark, GeminiMark, GrokMark } from '../AiMarks'
import { APP_NAME, ASK_AI_LINKS, FOOTER_COLUMNS, SOCIALS, type FooterLink } from '../../lib/brand'
import { SectionBackdrop } from '../ui/section-backdrop'

/**
 * The footer, hybrid revision: the dashx composition carrying every piece the old footer
 * carried. One rounded sheet holds the brand block and the link columns, the machine-facing
 * and AI rows sit inside it, and a slim bar underneath holds the copyright and a back-to-top.
 *
 * The rule for this rewrite was subtraction-free: manifest link, on-chain proof, all three
 * link columns, the socials and the ask-an-AI row all survive, only the arrangement changed.
 */

/** Marks keyed to match ASK_AI_LINKS, so the link list stays the single source of order. */
const AI_MARKS = {
  chatgpt: ChatGptMark,
  claude: ClaudeMark,
  perplexity: PerplexityMark,
  gemini: GeminiMark,
  grok: GrokMark,
} as const

/**
 * The social row, in reading order: broadest reach first, then community, then code.
 * Kept as data so adding a channel is one line and the markup stays single-copy.
 */
const SOCIAL_LINKS = [
  { key: 'x', href: SOCIALS.x, label: 'A-Identity on X', Icon: XIcon },
  { key: 'discord', href: SOCIALS.discord, label: 'Join the A-Identity Discord', Icon: DiscordIcon },
  { key: 'github', href: SOCIALS.github, label: 'A-Identity on GitHub', Icon: Github },
] as const

/** Render an internal route link or an external (new-tab) anchor. */
function FooterItem({ link }: { link: FooterLink }) {
  const className = 'text-sm text-foreground/70 transition-colors hover:text-foreground'
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
        {link.label}
      </a>
    )
  }
  return (
    <Link to={link.href} className={className}>
      {link.label}
    </Link>
  )
}

export default function SiteFooter() {
  return (
    <footer className="relative w-full overflow-hidden border-t border-border bg-background px-5 pb-8 pt-16 text-foreground/80 sm:px-8">
      <SectionBackdrop name="footer" position="right" />
      <div className="mx-auto max-w-[1100px]">
        {/* The sheet: everything except the legal line lives on one raised surface. */}
        <div className="rounded-[2rem] border border-border bg-card p-7 sm:p-10">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_1.6fr] lg:gap-14">
            {/* Brand block: who this is, and the two links a machine should read first. */}
            <div>
              <div className="flex items-center gap-2">
                <Logo size={26} />
                <span className="text-lg font-bold tracking-tight text-foreground">{APP_NAME}</span>
              </div>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-foreground/70">
                The passport &amp; wallet for the agentic economy.
              </p>

              <p className="mt-6 flex items-start gap-2.5 text-[13px] leading-relaxed text-foreground/70">
                <Terminal size={15} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  This site speaks agent, too. Point your AI at our{' '}
                  <a
                    href="/.well-known/ai-agent-manifest.json"
                    className="font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    machine-readable manifest
                  </a>{' '}
                  and it can verify, pay and get to work, with every settlement{' '}
                  <a
                    href="https://a-identity-asp.onrender.com/proof"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    provable on-chain
                  </a>
                  .
                </span>
              </p>

              {/* Socials. Each renders only when its link is set, so an unpublished channel
                  is simply absent rather than a button that goes nowhere. */}
              <div className="mt-6 flex items-center gap-3">
                {SOCIAL_LINKS.filter((s) => s.href).map(({ key, href, label, Icon }) => (
                  <a
                    key={key}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    title={label}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-foreground/[0.04] text-foreground/60 transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
                  >
                    <Icon size={17} />
                  </a>
                ))}
              </div>
            </div>

            <div className="grid gap-8 sm:grid-cols-3">
              {FOOTER_COLUMNS.map((col) => (
                <div key={col.title}>
                  <h3 className="text-sm font-semibold text-foreground">{col.title}</h3>
                  <ul className="mt-3 flex flex-col gap-2">
                    {col.links.map((l) => (
                      <li key={l.label}>
                        <FooterItem link={l} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* Ask an AI about us: the LLM-parsable claim above, aimed at a human. Each link
              carries the question AND the URL, so the answer is built from the page rather
              than from whatever the model half-remembers. */}
          <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-3 border-t border-border pt-7">
            <span className="font-mono text-xs tracking-tight text-accent">
              Ask AI about {APP_NAME}
            </span>
            {ASK_AI_LINKS.map(({ key, label, href }) => {
              const Mark = AI_MARKS[key]
              return (
                <a
                  key={key}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Ask ${label} about ${APP_NAME}`}
                  title={`Ask ${label} about ${APP_NAME}`}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-foreground/55 transition-colors hover:border-accent/40 hover:bg-accent/[0.07] hover:text-accent"
                >
                  <Mark size={17} />
                </a>
              )
            })}
          </div>
        </div>

        {/* The slim bar: legal on the left, the way back up on the right. */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-foreground/70">
          <span>
            © {new Date().getFullYear()} {APP_NAME}. Built for autonomous agents and the humans who
            supervise them.
          </span>
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="inline-flex items-center gap-1.5 font-semibold text-foreground/70 transition-colors hover:text-foreground"
          >
            Go all the way up <ArrowUp size={13} />
          </button>
        </div>
      </div>
    </footer>
  )
}
