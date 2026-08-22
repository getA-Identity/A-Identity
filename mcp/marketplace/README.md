# Circle Agent Marketplace — listing the A-Identity Trust Oracle

This directory holds the service manifest for listing **A-Identity — Agent Trust Oracle**
on Circle's Agent Marketplace (`agents.circle.com/services`), the same x402 service we already
sell on OKX.AI (Agent #6271).

- **`circle-agent-marketplace.json`** — the service descriptor (name, tools, prices, x402
  networks, provider ERC-8004 identity, discovery links). A build test pins its tools and prices to the gateway's `PRICES`, so it cannot drift;
  the live ASP serves it at **`GET https://a-identity-asp.onrender.com/.well-known/agent.json`**
  (and `/manifest`), which is what `circle services inspect "<url>"` and the marketplace read.

## Listing checklist

**Confirmed (researched 2026-07-19, from Circle's own sources):** listing is a **self-serve Google
Form**. The `agents.circle.com/services` page has an "Accept USDC from agents" CTA linking to
[`forms.gle/7YFzvdmMcn1JH5tF6`](https://forms.gle/7YFzvdmMcn1JH5tF6); Circle's blog
("Turn your API into a storefront for agents") points to the same submission form with the CTA
*"If you are building a seller service and want to participate in the Agent Marketplace or have it
made available to agents, submit your interest here."* The `@circle-fin/cli` is buyer-side only
(`services search/inspect/pay`); there is no `services publish` — submission is via the form.

Our side is fully ready: the service is x402-compliant and serves an inspectable manifest at
`https://a-identity-asp.onrender.com/.well-known/agent.json`.

Steps (done once, by the account owner):

1. **Submit the service** at [`forms.gle/7YFzvdmMcn1JH5tF6`](https://forms.gle/7YFzvdmMcn1JH5tF6)
   (also reachable via the "Accept USDC from agents" button on `agents.circle.com/services`), with:
   - Service URL: `https://a-identity-asp.onrender.com`
   - Manifest: `https://a-identity-asp.onrender.com/.well-known/agent.json`
   - Tools (USDC/x402): `verify_agent` $0.001 · `reputation_score` $0.002 · `risk_check` $0.005 · `agent_passport` $0.01 · `counterparty_check` $0.008 · `guardrail_check` $0.005
   - Provider identity: ERC-8004 (Meridian #849980) on Arc testnet · app https://a-identity.xyz
2. Once listed, verify discovery: `npm i -g @circle-fin/cli && circle login`, then
   `circle services search "trust oracle" --output json` /
   `circle services inspect "https://a-identity-asp.onrender.com" --output json`.

## Dogfooding it (already wired, no account needed)

The same `risk_check` tool is bought by one of our own agents over x402 on **Arc testnet**
(Circle Gateway nanopayment) via `POST /api/arc/trust-oracle-demo` on the main backend — an agent
pays ~$0.005 and gets an ALLOW/WARN/DENY verdict before it transacts. See
`mcp/scripts/test-dogfood.mjs` (real on-chain proof) and the "Trust Oracle" panel in the app.
