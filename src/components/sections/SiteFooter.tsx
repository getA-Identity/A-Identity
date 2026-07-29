import { Terminal, Github } from 'lucide-react'
import { Link } from 'react-router-dom'
import Logo from '../Logo'
import DiscordIcon from '../DiscordIcon'
import XIcon from '../XIcon'
import { APP_NAME, ASK_AI_LINKS, FOOTER_COLUMNS, SOCIALS, type FooterLink } from '../../lib/brand'

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
  const className = 'text-sm text-foreground/55 transition-colors hover:text-foreground'
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
    <footer className="w-full border-t border-border bg-background px-5 py-16 text-foreground/80 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        {/* Agent-friendly note */}
        <div className="mb-12 flex items-start gap-3 rounded-2xl border border-border bg-foreground/[0.04] p-5">
          <Terminal size={20} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm leading-relaxed text-foreground/70">
            This page's source is optimized to be <span className="font-semibold text-foreground">LLM-parsable</span>.
            Agents can scan{' '}
            <a
              href="/.well-known/ai-agent-manifest.json"
              className="font-mono text-accent underline-offset-2 hover:underline"
            >
              /.well-known/ai-agent-manifest.json
            </a>{' '}
            to discover identity, payment, and tool endpoints. Live on OKX.AI as an A2MCP ASP
            (Agent #6271) — see the{' '}
            <a
              href="https://a-identity-asp.onrender.com/proof"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              on-chain proof
            </a>
            .
          </p>
        </div>

        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2">
              <Logo size={26} />
              <span className="text-lg font-bold tracking-tight text-foreground">{APP_NAME}</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-foreground/55">
              The passport &amp; wallet for the agentic economy.
            </p>

            {/* Socials. Each renders only when its link is set, so an unpublished channel
                is simply absent rather than a button that goes nowhere. */}
            <div className="mt-5 flex items-center gap-3">
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

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold text-foreground">{col.title}</h4>
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

        {/* Ask an AI about us. Sits right above the copyright, and deliberately next to the
            LLM-parsable note at the top: the same claim aimed at a human instead of an agent.
            Each link carries the question AND the URL, so the answer is built from the page
            rather than from whatever the model half-remembers. */}
        <div className="mt-12 flex flex-wrap items-center gap-x-3 gap-y-3 border-t border-border pt-8">
          <span className="font-mono text-xs tracking-tight text-accent">
            Ask AI about {APP_NAME}
          </span>
          {ASK_AI_LINKS.map(({ label, href }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-border px-4 py-1.5 text-sm text-foreground/70 transition-colors hover:border-accent/40 hover:bg-accent/[0.07] hover:text-accent"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="mt-8 border-t border-border pt-6 text-xs text-foreground/40">
          © {new Date().getFullYear()} {APP_NAME}. Built for autonomous agents and the humans who supervise them.
        </div>
      </div>
    </footer>
  )
}
