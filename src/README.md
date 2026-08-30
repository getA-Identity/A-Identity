# a-identity (frontend)

The React app that serves **two surfaces out of one bundle**.

1. The **public marketing site** (landing, blog, FAQ, use cases, manifesto, brand kit)
   plus the logged-out product surfaces anyone can use without an account: the Agent Trust
   Explorer and the per-chain proof pages.
2. The **`/app` console**, the authenticated side where a human registers an agent, funds
   it, sets its limits, and watches what it spends.

React 19 + Vite 6, react-router-dom 7, Tailwind v4, framer-motion, viem for the wallet
sign-in, zustand for the two stores. There is no server component and no meta-framework:
the browser gets a single-page app, and crawlers get a committed prerendered snapshot of
every public route (see [Build pipeline](#build-pipeline)).

Everything the app reads comes from the backend in `../mcp`. In production the calls are
same-origin (`/health`, `/api/*`, `/mcp`) and `vercel.json` proxies them, so an ad blocker
that drops `*.onrender.com` cannot make a live backend look offline. See
[`lib/mcpBase.ts`](lib/mcpBase.ts).

## Route table

Every route is declared in one place, [`App.tsx`](App.tsx). `Landing` is imported eagerly
because it is the page almost everyone arrives on; **every other route is `lazy()`**, which
is what keeps the console, the explorer and viem out of the homepage's first chunk.

### Marketing and public product

| Path | File | Notes |
| --- | --- | --- |
| `/` | [`routes/Landing.tsx`](routes/Landing.tsx) | The only route in the entry chunk |
| `/login` | [`routes/Login.tsx`](routes/Login.tsx) | A thin wrapper; renders `components/auth/AuthScreen` in `mode="login"` |
| `/signup` | [`routes/Signup.tsx`](routes/Signup.tsx) | The same screen in `mode="signup"` |
| `/auth/callback` | [`routes/AuthCallback.tsx`](routes/AuthCallback.tsx) | Lands the email magic link |
| `/manifesto` | [`routes/Manifesto.tsx`](routes/Manifesto.tsx) | |
| `/intro` | [`routes/Intro.tsx`](routes/Intro.tsx) | The agent-facing front door: everything a crawling agent needs on one page, carried on static copy so the prerender is complete |
| `/stats` | [`routes/Stats.tsx`](routes/Stats.tsx) | Built out of `components/stats/` |
| `/brand` | [`routes/BrandKit.tsx`](routes/BrandKit.tsx) | `/brand-kit` is a `<Navigate replace>` to it, so old links still land |
| `/contact` | [`routes/Contact.tsx`](routes/Contact.tsx) | |
| `/faq` | [`routes/Faq.tsx`](routes/Faq.tsx) | Renders all of `lib/faq.ts`, then appends the landing cut |
| `/blog`, `/blog/:slug` | [`routes/Blog.tsx`](routes/Blog.tsx), [`routes/BlogPost.tsx`](routes/BlogPost.tsx) | Content from `lib/blog.ts` |
| `/tr/blog`, `/tr/blog/:slug` | the same two files | Turkish lives under a locale prefix, so each translation has its own crawlable URL |
| `/use-cases/:slug` | [`routes/UseCase.tsx`](routes/UseCase.tsx) | Content from `lib/usecases.ts` |
| `/explorer` | [`routes/Explorer.tsx`](routes/Explorer.tsx) | The public Agent Trust Explorer. No login |
| `/celo-proof` | [`routes/CeloProof.tsx`](routes/CeloProof.tsx) | The Celo x402 settlement log, `GET /api/celo/proof` verbatim |
| `/proof/:rail` | [`routes/ChainProof.tsx`](routes/ChainProof.tsx) | Provenance per rail (mints, deploys, addresses) from `GET /api/proof/:rail`. Deliberately not a copy of `/celo-proof`: that one is a settlement log, this one is the artifact ledger |
| `/architecture` | [`routes/Architecture.tsx`](routes/Architecture.tsx) | |
| `/mascot`, `/motion` | [`routes/Mascot.tsx`](routes/Mascot.tsx), [`routes/Motion.tsx`](routes/Motion.tsx) | Internal design surfaces, marked in `App.tsx` as unlinked and noindex |
| `*` | [`routes/NotFound.tsx`](routes/NotFound.tsx) | A real 404 page. It used to be a silent redirect home, which made a dead link look like a working one |

### The `/app` console

The whole tree sits behind [`routes/ProtectedRoute.tsx`](routes/ProtectedRoute.tsx) and
inside [`routes/app/AppLayout.tsx`](routes/app/AppLayout.tsx), which owns the sidebar, the
command bar, the per-screen tour and the `.dark` scope for the console.

| Path | File | Screen |
| --- | --- | --- |
| `/app` | [`routes/app/Dashboard.tsx`](routes/app/Dashboard.tsx) | Overview: reputation, balance, settlements, today's cap, activity |
| `/app/agent-id` | [`routes/app/AgentId.tsx`](routes/app/AgentId.tsx) | Register an ERC-8004 passport and pass KYA |
| `/app/wallet` | [`routes/app/Wallet.tsx`](routes/app/Wallet.tsx) | Balances, Circle Agent Wallet, treasury |
| `/app/settlements` | [`routes/app/Settlements.tsx`](routes/app/Settlements.tsx) | Every payment rail, one panel each |
| `/app/permissions` | [`routes/app/Permissions.tsx`](routes/app/Permissions.tsx) | The policy: caps, allowlist, freeze, vault |
| `/app/marketplace` | [`routes/app/Marketplace.tsx`](routes/app/Marketplace.tsx) | Hire a worker, Agent House, Leaderboard |
| `/app/marketplace/:agentId` | [`routes/app/AgentProfile.tsx`](routes/app/AgentProfile.tsx) | One agent's public record |
| `/app/earnings` | [`routes/app/Earnings.tsx`](routes/app/Earnings.tsx) | What the agent has been paid |

`ProtectedRoute` lets a **browse-only guest** in on purpose and only bounces a session with
no user at all. It also waits for `restored` before redirecting, because on a hard reload of
`/app` the persisted store can be empty while a valid HttpOnly cookie is still being
checked, and bouncing early would sign out a signed-in user.

## Component tree

- **`components/` (root)** is the chrome both surfaces share: `Navbar`, `MobileMenu`,
  `AuthButtons`, `Logo`, `OwlMark`, `OwlMascot`, `AgentAvatar`, `AiMarks`, `BlogCover`,
  `PageHeader`, the four social icons, plus the cross-cutting behavior: `ErrorBoundary`,
  `ScrollToTop`, `ScrollTopButton`, `PageViews`, and the three theme files
  (`ThemeProvider`, `ThemeScope`, `ThemeToggle`) described below.
- **`components/ui/`** is the primitive layer. The five Radix-backed shadcn-style pieces
  (`accordion`, `dropdown-menu`, `navigation-menu`, `tooltip`, and `button`, which uses
  `Slot` for `asChild`) sit next to the plain ones (`input`, `badge`, `skeleton`) and the
  house primitives that own a decision nobody should re-make per page: `section` (vertical rhythm, deliberately two sizes), `display` (the heading scale),
  `section-backdrop`, `panel` (the console card surface, extracted from fourteen panels that
  had each spelled it out), `stat`, `data-row`, `step-row`, `number-field`, and
  `product-mock` (a slice of the real product rendered in the real tokens, so it is correct
  in both themes instead of being a screenshot that goes stale).
- **`components/sections/`** holds the landing's narrative blocks in page order: `VerifyCta`,
  `Shift`, `VerifyPayFlow`, `ConsoleShowcase`, `QuickStart`, `ProtocolsWall`, `TractionSim`,
  `AgentVitrine`, `WhatYouGet`, `Safety`, `ForAgents`, `LiveProof`, `BuiltOn`, `LandingFaq`,
  `CloseCta`, `SiteFooter`. `AgentRing` and `SettlementTicker` live here too, but they are
  parts of `LiveProof` rather than blocks the page places itself. Two sections are not
  landing-only: `SiteFooter` is imported by fourteen route files, and `LandingFaq` by both
  `/` and `/faq`.
- **`components/landing/`** is the opposite: pieces bound to a single page. `Hero`,
  `MouseDither` and `TrustSpotlight` belong to `/`; `TractionPanel` and `VerifyStepper`
  belong to `/explorer`.
- **`components/auth/`** is `AuthScreen` (the one screen behind both `/login` and `/signup`)
  and `WalletModal`, the EIP-6963 multi-wallet picker with the WalletConnect path behind
  `VITE_WALLETCONNECT_PROJECT_ID`.
- **`components/stats/`** is the toolkit `/stats` is assembled from and nothing else:
  `RailCard`, `charts.tsx`, `kit.tsx`, and a local `format.ts`.
- **`components/app/`** is the console. At the top level sit the shell parts:
  `AppPage` (the single page shell that owns the measure and the entrance rows),
  `CommandBar` and `ConsoleTour` + `tours.ts` (per-screen tours, replayable, and steps whose
  target is off screen are skipped so a tour never points at nothing), `AgentSelect` (used by
  five screens, so choosing an agent in one does not snap back in the next), `ChainLogo`,
  `CopyBlock`, `DotField`, `Freshness`, `WalletPanels`, `consoleAmbient.ts`.
  Below it, one folder per screen:

  | Folder | Serves |
  | --- | --- |
  | `app/agent/` (+ `agent/steps/`) | `AgentId.tsx`: the register wizard (identity, wallet, capabilities, permissions, review) |
  | `app/dashboard/` | `Dashboard.tsx`: `AgentStatusBar`, `SetupChecklist`, `SpendSummary` |
  | `app/marketplace/` | `Marketplace.tsx`, and also `Dashboard`, `AgentProfile` and the landing's `AgentVitrine`, which all reuse `AgentCard` |
  | `app/permissions/` | `Permissions.tsx`: the toggles, the vault, the policy tester, the audit trail |
  | `app/profile/` | `AgentProfile.tsx`: the hero and the six panes |
  | `app/settlements/` | `Settlements.tsx`: one panel per rail (x402, Nanopay, Gateway, CCTP, escrow, batch, AppKit, autopilot, gas, session key, trust oracle) |

## Theme system

Two kinds of token, and the difference is the thing to understand before touching color.

**Fixed brand tokens** live in the plain `@theme` block in [`index.css`](index.css):
`--color-ink`, `--color-accent`, `--color-cream`, `--color-sand`, the two font families, the
Radix animations. Tailwind v4 generates `bg-accent`, `text-ink`, `font-heading` from them.
**These never change between light and dark.** `--accent` deliberately has no dark override,
because it has to keep matching the `bg-accent` utility, which is pinned to one value.

**Theme-aware semantic tokens** are declared as raw CSS variables on `:root` (`--background`,
`--foreground`, `--card`, `--border`, `--ring`, `--secondary`, `--sheet`, plus the meaning
tokens `--ok` / `--warn` / `--danger`, `--usdc`, the six `--cat-*` category tints and the
`--term-*` terminal roles), overridden in a `.dark` block, and bound into Tailwind by a
second `@theme inline` block that maps them through `var()`. The `inline` matters: it keeps
them as live references, which is what lets a runtime `.dark` class flip them at all.

`@custom-variant dark (&:where(.dark, .dark *))` points Tailwind's `dark:` variant at that
class. **The theme is a scoped `.dark` class, not `prefers-color-scheme` and not a class on
`<html>`.** [`ThemeProvider`](components/ThemeProvider.tsx) only holds the preference (state
plus `localStorage`), and hands it down; it forces nothing onto the document.

The consequence is sharp and worth stating plainly: **a page that does not sit inside a
`.dark` scope is permanently light, no matter how many `text-foreground` classes it uses.**
The token simply resolves to its `:root` value. That already happened once, which is why
[`ThemeScope`](components/ThemeScope.tsx) exists: it applies the class and the
`bg-background text-foreground` base in one wrapper, so a new page gets dark mode by
wrapping rather than by remembering three lines. Use it. Four routes still apply the class
inline instead, and each has its own root to attach it to: `Landing`, `Explorer`,
`Architecture`, and `AppLayout` (whose shell also drives a theme-flip transition).

`ThemeScope` takes a `surface` prop: `background` is the page tint, `card` is the raised
sheet the long-form pages sit on, which stays a step lighter than the page in dark mode too.

[`console.css`](console.css) is loaded by `AppLayout` alone and is the console's motion
system. Its rule: React decides *when* (phase classes, direction attributes, index
variables), the stylesheet decides *what* (keyframes, staggers, easings). No JS tweens.
Every color in it is one of the tokens above.

## `src/lib`

### The copy lives here

These modules are content, not plumbing. Edit the copy here rather than in a component, so
the same words cannot drift between two surfaces.

- [`brand.ts`](lib/brand.ts) is the single source for brand-level constants (app name,
  tagline, `DOCS_URL`, the shared easing curve, the background video) used by the landing,
  auth, the console and the agent manifest.
- [`faq.ts`](lib/faq.ts) is every question the site answers. `/faq` renders all of it; the
  landing renders a cut.
- [`blog.ts`](lib/blog.ts) is the blog, English and Turkish in one object per post, with
  [`blog-strings.ts`](lib/blog-strings.ts) for the chrome (a typed record, not an i18n
  runtime, because two languages and one section do not justify one).
- [`usecases.ts`](lib/usecases.ts) is the three use-case stories.
- [`reputation-bands.ts`](lib/reputation-bands.ts) is the 0-1000 banding, in one copy. Four
  hand-synced copies used to live in the routes.

### Generated. Do not hand-edit

- [`chains.ts`](lib/chains.ts) is **generated from `mcp/src/chains/registry.ts`**.
  Regenerate with `cd mcp && npm run gen:chains`. Editing it by hand fails
  `cd mcp && npm test` (`mcp/src/chains/frontend-sync.test.ts`). Add or change a chain in
  the registry, then regenerate, so the backend, the REST surface and the UI cannot
  disagree. [`arc.ts`](lib/arc.ts) follows the same rule from the other side: chain id, RPC
  host and explorer are read out of the generated mirror and never typed locally, because
  three hand-copied Arc configs had already drifted apart once.

### Regex-locked. Changing the SHAPE breaks the build

These files are read as **text** by build scripts, not imported. The formatting is part of
the contract, and the scripts fail loudly rather than silently dropping content.

- [`blog.ts`](lib/blog.ts) is scraped by `scripts/gen-sitemap.mjs`. It matches
  `slug: '...'` at a **four-space indent** and detects a translation by a `tr: {` key at the
  same indent, splitting posts on a two-space `{`. Re-indent the array, rename `slug`, or
  restructure the objects and the sitemap loses pages. That matters twice over, because
  `scripts/prerender.mjs` reads its route list back out of `public/sitemap.xml`: a page that
  falls out of the sitemap also stops being prerendered, and a crawler without JavaScript
  sees an empty shell. `usecases.ts` is scraped by the same `slug:` rule.
- [`components/sections/LandingFaq.tsx`](components/sections/LandingFaq.tsx) is scraped by
  `scripts/check-structured-data.mjs`, which matches `q:` / `plain:` pairs at a four-space
  indent and compares them against the `FAQPage` JSON-LD inlined in `index.html`. Change a
  question, an answer, or the shape, and `npm run build` fails until `index.html` is updated
  to match. That is the point: the schema is a promise about what the page shows, and a
  drifted promise is worse than none. `forceMount` on the accordion is also load-bearing:
  every answer stays in the DOM while collapsed, so an agent reading the markup gets them
  without simulating clicks.

### Everything else

`api.ts` (cold-start-resilient backend access: reads retry, mutations wait for `/health`
and then send exactly once), `mcpBase.ts` (where the backend is, per environment),
`mcp-client.ts` (JSON-RPC to `POST /mcp`), `platformAgents.ts` (one cached, deduped
`GET /api/platform-agents` shared by every console screen), `pickAgent.ts`, `head.ts`
(per-page title, description, canonical and JSON-LD for a client-rendered SPA; it overwrites
rather than appends, because two canonicals is worse than none), `analytics.ts`
(credential-gated, and never sends an email, wallet address or agent id), `wallets.ts`
(EIP-6963 discovery plus WalletConnect, all returning a plain EIP-1193 provider),
`webmcp.ts` (hands a browser-driving agent the same **free, read-only** tools a person gets
from the page), `format.ts`, `time.ts`, `utils.ts` (`cn`).

`store/` is two zustand stores: [`auth.ts`](store/auth.ts) (the real credential is an
HttpOnly cookie; a Bearer copy lives in memory for this tab only and is never persisted) and
[`agent.ts`](store/agent.ts) (the selected agent, in memory only, so a persisted id can
never point at an agent that no longer exists). `hooks/` holds `useMcp`,
`useScreenTransition`, `useTabCarousel`, `useTypewriter`.

## Build pipeline

```bash
npm run dev          # Vite dev server
npm run dev:all      # UI + backend + docs together
npx tsc --noEmit     # typecheck
npm run lint         # eslint over src/**/*.{ts,tsx}
npm run prerender    # refresh the committed snapshot (needs Playwright's Chromium)
npm run build        # check + tsc --noEmit + vite build + apply the snapshot
npm run smoke        # build, serve, and render every route against the live backend
```

`npm run build` runs `npm run check` first, which is five guards: `check:seo` (the FAQ
schema above), `check:skills`, `check:oauth`, `check:sitemap`, and `check:prerender`.

**The one thing to remember when working in `src/`:** the prerendered HTML in
`prerendered/` is **committed**, and `scripts/prerender-hash.mjs` fingerprints every
`.ts`, `.tsx`, `.css`, `.html` and `.xml` file under `src/`, plus `index.html` and
`public/sitemap.xml`, **by path and by content**. So **any** change under `src/` makes the
snapshot stale and `npm run build` fails by design:

```
the prerendered HTML is stale: source files have changed since it was taken.
Run: npm run prerender
```

Run `npm run prerender` once before `npm run build` and commit the result. The snapshot is
committed rather than generated at deploy time because Vercel's build container cannot
launch Chromium; the cost of that trade is exactly this staleness, and the check is how it
is paid for. Shipping a stale snapshot is the worst outcome available here, because it fails
silently and looks like success: the pages are there, they are full of text, and the text is
last week's.

`scripts/prerender.mjs` renders every route in `public/sitemap.xml` except `/app*`,
`/login` and `/signup`. [`main.tsx`](main.tsx) hydrates when the container arrives full and
mounts fresh when it does not, so `vite dev` (which serves an empty shell) needs no special
case.
