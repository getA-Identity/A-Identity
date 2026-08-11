import { ArrowUp, Github } from 'lucide-react'
import { Link } from 'react-router-dom'
import Logo from '../Logo'
import DiscordIcon from '../DiscordIcon'
import XIcon from '../XIcon'
import LinkedInIcon from '../LinkedInIcon'
import YouTubeIcon from '../YouTubeIcon'
import { APP_NAME, ASK_AI_LINKS, FOOTER_COLUMNS, SOCIALS, type FooterLink } from '../../lib/brand'
import { SectionBackdrop } from '../ui/section-backdrop'

/**
 * The footer, leaned out.
 *
 * The previous one carried a raised card, ten bordered icon tiles, an accent-coloured
 * paragraph and eighteen links, and the weight of all that is what made the bottom of
 * every page feel like a second homepage. Nothing here is a new destination and almost
 * nothing was dropped: the card became plain background, the tiles became plain marks,
 * and the two machine-facing rows moved into one quiet block above the legal line.
 *
 * The manifest link survives on purpose. It is the one line on the page written for a
 * crawler rather than a reader, so it stays reachable and stops shouting.
 */

/**
 * The social row, in reading order: broadest reach first, then community, then code.
 * Kept as data so adding a channel is one line and the markup stays single-copy.
 */
const SOCIAL_LINKS = [
  { key: 'x', href: SOCIALS.x, label: 'A-Identity on X', Icon: XIcon },
  { key: 'linkedin', href: SOCIALS.linkedin, label: 'A-Identity on LinkedIn', Icon: LinkedInIcon },
  { key: 'youtube', href: SOCIALS.youtube, label: 'A-Identity on YouTube', Icon: YouTubeIcon },
  { key: 'discord', href: SOCIALS.discord, label: 'Join the A-Identity Discord', Icon: DiscordIcon },
  { key: 'github', href: SOCIALS.github, label: 'A-Identity on GitHub', Icon: Github },
] as const

/** Render an internal route link or an external (new-tab) anchor. */
function FooterItem({ link }: { link: FooterLink }) {
  const className = 'text-[13px] text-foreground/60 transition-colors hover:text-foreground'
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
    <footer className="relative w-full overflow-hidden border-t border-border bg-background px-5 pb-8 pt-14 text-foreground/70 sm:px-8">
      <SectionBackdrop name="footer" position="right" />
      <div className="relative mx-auto max-w-[1100px]">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.7fr] lg:gap-16">
          {/* Brand block: who this is, and where else to find it. */}
          <div>
            <div className="flex items-center gap-2">
              <Logo size={22} />
              <span className="text-base font-bold tracking-tight text-foreground">{APP_NAME}</span>
            </div>
            <p className="mt-2.5 max-w-[28ch] text-[13px] leading-relaxed text-foreground/55">
              The passport and wallet for the agentic economy.
            </p>

            {/* Socials. Each renders only when its link is set, so an unpublished channel
                is simply absent rather than a button that goes nowhere. */}
            <div className="mt-5 flex items-center gap-4">
              {SOCIAL_LINKS.filter((s) => s.href).map(({ key, href, label, Icon }) => (
                <a
                  key={key}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  title={label}
                  className="text-foreground/45 transition-colors hover:text-foreground"
                >
                  <Icon size={16} />
                </a>
              ))}
            </div>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  {col.title}
                </h3>
                <ul className="mt-3 flex flex-col gap-2">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <FooterItem link={l} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        {/* The quiet block: the machine-facing line, the ask-an-AI row and the legal
            line, all at one small size so none of them competes with the links above. */}
        <div className="mt-12 flex flex-col gap-2.5 border-t border-border pt-5 text-xs text-foreground/45">
          <p>
            This site speaks agent too:{' '}
            <a
              href="/.well-known/ai-agent-manifest.json"
              className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              machine-readable manifest
            </a>
            .
          </p>

          {/* Each link carries the question AND the URL, so the answer is built from the
              page rather than from whatever the model half-remembers. */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Ask an AI about {APP_NAME}:</span>
            {ASK_AI_LINKS.map(({ key, label, href }) => (
              <a
                key={key}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                {label}
              </a>
            ))}
          </p>

          <div className="mt-1 flex items-center justify-between gap-4">
            <span>
              © {new Date().getFullYear()} {APP_NAME}. Built for autonomous agents and the humans
              who supervise them.
            </span>
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              aria-label="Back to top"
              title="Back to top"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-foreground/50 transition-colors hover:border-accent/40 hover:text-foreground"
            >
              <ArrowUp size={14} />
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}
