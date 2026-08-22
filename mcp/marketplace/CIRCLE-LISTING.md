# Circle Agent Marketplace — listing readiness

Circle reviews Agent Marketplace listings **manually** today (a self-serve flow is
"coming"), so the last step is a human submitting the intake form linked from
[How-to: Get listed](https://developers.circle.com/agent-stack/agent-marketplace/get-listed).
Everything the form asks for is prepared below, and every prerequisite is already met.

## Prerequisites, and where each one is satisfied

| Circle's prerequisite | Status | Where |
|---|---|---|
| Service returns `402 Payment Required` when unpaid, serves the resource when paid | ✅ | `mcp/src/asp/payment.ts` — x402 middleware over every paid tool, verified by `asp/*.test.ts` |
| Published OpenAPI spec so agents can read inputs and outputs | ✅ | Served at [`/openapi.json`](https://a-identity-asp.onrender.com/openapi.json) and `/.well-known/openapi.json` |
| Payout wallet address confirmed (sanctions-screened during review) | ✅ | `PAY_TO_ADDRESS`, published in `/proof.json` under `realOnchainRevenue.payTo` |

A drift guard (`mcp/src/asp/marketplace-listing.test.ts`) fails the build if a paid tool
is missing from the spec or its price disagrees with what the gateway charges, so the
published document cannot quietly go stale after the listing is approved.

## Values to paste into the intake form

| Field | Value |
|---|---|
| Service name | A-Identity — Agent Trust Oracle |
| Endpoint URL | `https://a-identity-asp.onrender.com` |
| OpenAPI spec URL | `https://a-identity-asp.onrender.com/openapi.json` |
| Service manifest | `https://a-identity-asp.onrender.com/.well-known/agent.json` |
| Payout wallet | the address in `/proof.json` → `realOnchainRevenue.payTo` |
| Category | Financial analysis (closest fit; the tools are counterparty risk and reputation) |
| Networks | Arc Testnet (`eip155:5042002`, Circle Gateway nanopayments) and X Layer (`eip155:196`) |
| Repo | `https://github.com/getA-Identity/A-Identity` |

**Short description (fits a form field):**

> Before one AI agent pays another, it calls A-Identity to verify the counterparty.
> ERC-8004 on-chain identity plus a KYA wallet-control attestation, a deterministic
> 0-1000 reputation score computed from real on-chain settlements, and a
> pre-transaction ALLOW / WARN / DENY verdict. Six paid tools and one free preview,
> all over x402. Every number is reproducible and every settlement is on-chain.

## The tools a reviewer will see

| Tool | Price | What it answers |
|---|---|---|
| `trust_preview` | free | Coarse trust band plus revoked and Sybil flags. Rate limited. |
| `verify_agent` | $0.001 | ERC-8004 identity and KYA status. |
| `reputation_score` | $0.002 | Deterministic 0-1000 score from real settlements. |
| `risk_check` | $0.005 | ALLOW / WARN / DENY with reasons, sized to the payment. |
| `guardrail_check` | $0.005 | The live policy engine's decision on a proposed action. |
| `counterparty_check` | $0.008 | Both sides of a deal, including same-operator self-dealing. |
| `agent_passport` | $0.01 | The full passport: identity, KYA, score, history. |

## After approval

Circle health-checks listed services continuously and delists unreachable ones, so the
keep-warm ping in `asp-gateway.ts` matters more once we are listed, not less. To confirm
the listing went live:

```bash
curl -s "https://api.circle.com/v2/x402/discovery/resources?query=a-identity" | jq
```
