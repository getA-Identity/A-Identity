import { Terminal, Github } from 'lucide-react'
import { Link } from 'react-router-dom'
import Logo from '../Logo'
import DiscordIcon from '../DiscordIcon'
import XIcon from '../XIcon'
import { APP_NAME, FOOTER_COLUMNS, SOCIALS, type FooterLink } from '../../lib/brand'

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
  const className = 'text-sm text-white/55 transition-colors hover:text-white'
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
    <footer className="w-full bg-[#10202d] px-5 py-16 text-white/80 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        {/* Agent-friendly note */}
        <div className="mb-12 flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <Terminal size={20} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm leading-relaxed text-white/70">
            This page's source is optimized to be <span className="font-semibold text-white">LLM-parsable</span>.
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
              <span className="text-lg font-bold tracking-tight text-white">{APP_NAME}</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-white/55">
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
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/60 transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
                >
                  <Icon size={17} />
                </a>
              ))}
            </div>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold text-white">{col.title}</h4>
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

        <div className="mt-12 border-t border-white/10 pt-6 text-xs text-white/40">
          © {new Date().getFullYear()} {APP_NAME}. Built for autonomous agents and the humans who supervise them.
        </div>
      </div>
    </footer>
  )
}
