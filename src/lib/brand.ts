/**
 * Single source of truth for brand-level constants used across the shell.
 * Kept LLM-parsable and centralized so every surface (landing, auth, app,
 * agent manifest) reuses the same identity.
 */

export const APP_NAME = 'A-Identity'
export const APP_TAGLINE = 'The passport and wallet for the agentic economy'

/**
 * Base URL of the Mintlify docs site. Overridable via VITE_DOCS_URL so each
 * environment points somewhere real:
 *   - dev: http://localhost:3000 (set in .env.development; run `npm run docs`)
 *   - prod: the deployed docs domain (set VITE_DOCS_URL at build time)
 * The fallback is the LIVE Mintlify docs site, so links resolve even if the env
 * var is unset. Prod (Vercel) sets VITE_DOCS_URL to the same value.
 */
const DOCS_ENV = (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim()
export const DOCS_URL = DOCS_ENV ? DOCS_ENV.replace(/\/$/, '') : 'https://a-identity.mintlify.site'

/** The three open protocols A-Identity connects, each with its own color. */
export const PROTOCOLS = [
  { label: 'ERC-8004', color: '#7342E2', href: `${DOCS_URL}/protocols/erc-8004` },
  { label: 'x402', color: '#2775CA', href: `${DOCS_URL}/protocols/x402` },
  { label: 'MCP', color: '#1AAB7A', href: `${DOCS_URL}/protocols/mcp` },
] as const

export type NavLink = { label: string; href: string; external?: boolean }

// The landing stays lean; the deeper material lives off it, reachable here. Order matters
// (left to right): try the product, read how it works, then the developer surfaces.
export const NAV_LINKS: readonly NavLink[] = [
  { label: 'Explorer', href: '/explorer' },
  { label: 'Developers', href: `${DOCS_URL}/developers/quickstart`, external: true },
  { label: 'Blog', href: '/blog' },
  { label: 'Docs', href: DOCS_URL, external: true },
]

export type FooterLink = { label: string; href: string; external?: boolean }
export type FooterColumn = { title: string; links: FooterLink[] }

/**
 * Footer navigation. Protocol and Developers point into the docs site (open
 * externally); Company items are standalone pages on this site.
 */
export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    title: 'Protocol',
    links: [
      { label: 'Verify (ERC-8004)', href: `${DOCS_URL}/protocols/erc-8004`, external: true },
      { label: 'Pay (x402)', href: `${DOCS_URL}/protocols/x402`, external: true },
      { label: 'Connect (MCP)', href: `${DOCS_URL}/protocols/mcp`, external: true },
      { label: 'Reputation', href: `${DOCS_URL}/concepts/reputation`, external: true },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Trust Explorer', href: '/explorer' },
      { label: 'OKX.AI ASP — Live Proof', href: 'https://a-identity-asp.onrender.com/proof', external: true },
      { label: 'SDK', href: `${DOCS_URL}/developers/sdk`, external: true },
      { label: 'CLI', href: `${DOCS_URL}/developers/cli`, external: true },
      { label: 'Agent Manifest', href: `${DOCS_URL}/developers/agent-manifest`, external: true },
      { label: 'Docs', href: DOCS_URL, external: true },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Manifesto', href: '/manifesto' },
      { label: 'Blog', href: '/blog' },
      { label: 'Brand', href: '/brand' },
      { label: 'Contact', href: '/contact' },
    ],
  },
]

/**
 * Public places to find us. One source, because a social link that lives in three files
 * is a social link that is wrong in two of them.
 *
 * The Discord invite is a PERMANENT one (no expiry, unlimited uses), created with
 * `npm run invite --prefix tools/discord`. Discord's default invite dies after 7 days,
 * which is exactly how a landing page ends up with a dead Join button nobody notices.
 *
 * An empty string means "not published yet", and every surface that renders these skips
 * the empty ones rather than shipping a link to nowhere.
 */
export const SOCIALS = {
  // Permanent invite: no expiry, unlimited uses, verified against Discord's invite API.
  // If this ever needs replacing, keep it permanent — a landing-page link with an expiry
  // date is a Join button with a scheduled death that nobody notices for a month.
  x: 'https://x.com/ai_dentity',
  discord: 'https://discord.gg/ak4rC3p7Tz',
  github: 'https://github.com/getA-Identity/A-Identity',
} as const

/**
 * "Ask an AI about us" links.
 *
 * The question carries the URL on purpose: every one of these assistants can fetch a page,
 * so handing it the site is the difference between an answer built from our own words and
 * one improvised from whatever the model half-remembers. It also fits what the footer
 * already claims a line above, that the page is written to be machine-readable.
 *
 * Prefill support is NOT uniform, and the difference is worth knowing before adding one:
 *   chatgpt / claude / perplexity / grok  fill the box from the URL (grok also auto-sends)
 *   gemini                               has no native prefill; the parameter is ignored
 *                                        and the visitor lands on an empty Gemini
 * Gemini is kept because landing on it is still useful and the link starts working the day
 * Google adds support, but that is the one that does less than it looks like it does.
 */
export const ASK_AI_PROMPT = 'What is A-Identity (https://a-identity.xyz) and what problem does it solve?'

export const ASK_AI_LINKS = [
  { label: 'ChatGPT', href: `https://chatgpt.com/?prompt=${encodeURIComponent(ASK_AI_PROMPT)}` },
  { label: 'Claude', href: `https://claude.ai/new?q=${encodeURIComponent(ASK_AI_PROMPT)}` },
  { label: 'Perplexity', href: `https://www.perplexity.ai/search/new?q=${encodeURIComponent(ASK_AI_PROMPT)}` },
  { label: 'Gemini', href: `https://gemini.google.com/app?q=${encodeURIComponent(ASK_AI_PROMPT)}` },
  { label: 'Grok', href: `https://grok.com/?q=${encodeURIComponent(ASK_AI_PROMPT)}` },
] as const

/** Contact addresses surfaced on the contact page and manifest. */
export const CONTACT = {
  agents: 'agents@a-identity.xyz',
  hello: 'hello@a-identity.xyz',
} as const

export const BACKGROUND_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260518_003132_8b7edcb6-c64d-4a52-a9ca-879942e122ad.mp4'

/** Shared cubic-bezier easing used by the entry + sheet animations. */
export const EASE_OUT_EXPO = [0.22, 1, 0.36, 1] as [number, number, number, number]
