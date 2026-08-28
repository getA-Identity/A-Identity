import { Github } from 'lucide-react'
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

          {/* Three groups. On a phone they stack and their LINKS split into two columns
              instead; putting the groups themselves side by side is what made the footer
              look broken. A grid row is as tall as its tallest cell, and Developers has
              six links against Protocol's three, so the first row left a link-height hole
              under Protocol and pushed Company down into a second row on its own. Stacking
              the groups removes the hole, and paired links keep the block from becoming a
              fifteen-item ladder. From `sm` up the original three-across returns, with each
              group's links back in a single column. */}
          <nav aria-label="Footer" className="grid grid-cols-1 gap-8 sm:grid-cols-3">
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  {col.title}
                </h3>
                <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:flex sm:flex-col sm:gap-2">
                  {col.links.map((l) => (
                    <li key={l.label} className="min-w-0">
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
          {/* The label gets its own line on a phone. Inline, it left the five model names
              wrapping mid-row with the last two stranded under the sentence. */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="w-full sm:w-auto">Ask an AI about {APP_NAME}:</span>
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

          {/* No back-to-top button here: the floating ScrollTopButton already covers it,
              and two arrows in the same viewport read as a bug. */}
          <p className="mt-1">
            © {new Date().getFullYear()} {APP_NAME}. Built for autonomous agents and the humans
            who supervise them.
          </p>
        </div>
      </div>
    </footer>
  )
}
