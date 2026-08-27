/**
 * Base URL for the A-Identity MCP HTTP backend, resolved per environment.
 *
 * Production: '' (same-origin). The deployed app calls /health, /api/*, /mcp on its
 * OWN domain, and vercel.json proxies those to the backend as first-party requests.
 * This dodges ad blockers / privacy lists that block *.onrender.com and would
 * otherwise show a false "backend offline". The production backend URL now lives in
 * vercel.json (change it there), so VITE_MCP_URL is a dev-only override.
 *
 * Dev: VITE_MCP_URL if set, else the local backend on :3399.
 */
export const MCP_BASE = import.meta.env.PROD
  ? ''
  : ((import.meta.env.VITE_MCP_URL as string | undefined) ?? 'http://localhost:3399')

/**
 * The backend's REAL origin, used ONLY for a best-effort wake ping (see lib/api.ts).
 * In production the app talks to the backend same-origin (MCP_BASE=''), but the Vercel
 * proxy gives up on a cold free-tier boot after ~30s and returns 502 before the ~50s
 * wake finishes, so the poller can never warm it through the proxy. A direct no-cors
 * ping to this origin has no such cap and lets the cold start complete. Ad blockers may
 * block *.onrender.com, so this is a nudge, not a dependency (the same-origin retry +
 * the keep-warm cron do the rest). Override with VITE_BACKEND_DIRECT_URL if the backend
 * host changes.
 */
export const BACKEND_DIRECT_URL = import.meta.env.PROD
  ? ((import.meta.env.VITE_BACKEND_DIRECT_URL as string | undefined) ??
     'https://a-identity-backend.onrender.com')
  : ((import.meta.env.VITE_MCP_URL as string | undefined) ?? 'http://localhost:3399')

/**
 * Fetch base for the OKX ASP gateway, a separate Render service with open CORS.
 * Production: '/asp', so reads ride the same-origin Vercel rewrite (/asp/:path* in
 * vercel.json) instead of hitting *.onrender.com directly, for exactly the ad-blocker
 * reason MCP_BASE is same-origin. Dev: the live ASP directly, since there is no local
 * ASP and no dev proxy. Use this for FETCHES only: human-facing links to the ASP's own
 * pages, provenance hrefs that name the real source, and URLs handed to agents (webmcp,
 * copy blocks) stay on the real origin, because those are opened or fetched from
 * outside this app.
 */
export const ASP_BASE = import.meta.env.PROD ? '/asp' : 'https://a-identity-asp.onrender.com'

/**
 * User-facing copy when a backend request fails. Honest and plain: on prod the app
 * uses a same-origin proxy, so "run the server / npm run dev" is wrong and confusing
 * to a judge. The free-tier backend usually just needs a few seconds to wake.
 */
export const BACKEND_UNREACHABLE =
  'The backend is waking up or briefly unreachable (free tier). Give it a few seconds and refresh.'
