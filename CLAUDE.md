# CLAUDE.md

Guidance for AI coding agents working in this repo. Human-facing docs: README.md,
ARCHITECTURE.md, CONTRIBUTING.md. Machine-facing product surface: public/llms.txt,
public/llms-full.txt, public/.well-known/ (agent card, MCP server card, agent skills).

## Ground rules (project law, enforced in review)

- Plain ASCII punctuation in all prose, code comments, and UI copy: no em dashes, no
  curly quotes, no arrows outside code. English for code/commits/docs.
- Honest status everywhere: live reads are labeled live, simulations simulated, unbuilt
  things planned. Every on-chain write returns prepared-or-executed: without a signer it
  returns the exact call it would make, and nothing is marked settled without a receipt.
- No autonomous key custody. Keys are user-held or env-gated; a missing credential means
  a clean labeled no-op, never a crash and never a mock that looks real.
- New UI uses semantic tokens (bg-background, text-foreground, warn/ok/danger), not raw
  palette classes. The dark theme is a scoped .dark class, not prefers-color-scheme.
- Do not touch mcp/src/asp/ behavior, prices, or tool schemas casually: the OKX.AI
  listings (#6271, #8913) are registered against them and re-registration resets review.

## Structure (see mcp/README.md "Module map" for the full version)

- mcp/src/platform/ is layered (core at the bottom; a module imports only lower layers)
  and mcp/src/platform.ts is a pure re-export barrel. The layer graph is enforced by
  mcp/src/platform/layering.test.ts.
- mcp/src/http/ holds route-group handlers; mcp/src/http.ts stays the entry (dist path
  is pinned by scripts, CI, and Render).
- mcp/src/x402-3009/ is the self-facilitated EIP-3009 payment rail: the buyer signs and
  pays no gas, we broadcast, and nothing counts as settled without a receipt carrying a
  matching Transfer log. Chain-generic on purpose, so a chain gets it by declaring a
  settlementTokens entry. Its signing domain is PROVEN against the token's live
  DOMAIN_SEPARATOR, never pasted; if it cannot be proven, no challenge is served.
- mcp/src/chains/provenance.ts is the artifact ledger behind /proof/:rail: every tx we
  claim, plus caveats a test forces to be non-empty. Explorer links are derived, never
  typed.
- mcp/src/chains/registry.ts is the single source of truth for chains; a test fails the
  build if any other file hardcodes a chain id, RPC host, or USDC address.
- Generated files, never hand-edit: src/lib/chains.ts (run cd mcp && npm run gen:chains)
  and mcp/src/contracts/*.ts (run cd mcp && npm run compile).
- Regex-locked files, edit with care: src/lib/blog.ts and
  src/components/sections/LandingFaq.tsx are scraped by scripts/gen-sitemap.mjs and
  scripts/check-structured-data.mjs; changing their shape breaks npm run build.

## Verification

- Backend: cd mcp && npm test (tsc + 870 unit tests; new test files must be added to the
  test script in mcp/package.json, and the count literal in mcp/src/asp/proof.ts must
  match the number of test() declarations).
- E2E: boot node mcp/dist/http.js, then npm run e2e, e2e:guardrail, http-smoke.
- Frontend: npx tsc --noEmit and npm run lint from the repo root.
- Any change under src/ makes the prerender snapshot stale: run npm run prerender once
  before npm run build (the build fails on a stale snapshot by design).
- Full local proof: npm run build then npm run smoke (renders every route against the
  live backend and fails on console errors).

## Git

- origin (getA-Identity/A-Identity) is the source of truth; deploy
  (mericcintosun/a-identity) mirrors it and triggers Vercel. Pull origin first, push to
  both. Pushing main deploys: Render and Vercel auto-deploy from it.
