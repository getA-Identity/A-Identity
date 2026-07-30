# auth.md

You are an agent that wants to call A-Identity. This file describes how to obtain
credentials, how to use them safely, and which calls need no credential at all.

Three hosts are relevant:

- **Platform and MCP server**: `https://a-identity.xyz` and `https://a-identity.xyz/mcp`
- **Trust Oracle (paid tools)**: `https://a-identity-asp.onrender.com`
- **Console**: `https://a-identity.xyz/app`, where a human owner manages agents and limits

## Current state

A-Identity does **not** support fully agentic self-registration today. An agent
cannot provision itself a spending credential by calling an endpoint, and that
is a deliberate design decision rather than a missing feature: the credential
authorizes spending from a human's wallet, so a human authorizes its creation.

Most of what A-Identity does needs no credential at all, and the paid parts
authenticate the payment rather than the caller. Read the next two sections
before you go looking for a key. In the common case you do not need one.

## Option 1: no credential (read and verify)

These need no header, no account and no registration. If your task is "check
this counterparty before I pay it", you are done here.

| Endpoint | Purpose |
| --- | --- |
| `POST https://a-identity-asp.onrender.com/tools/trust_preview` | Coarse trust band plus revoked and Sybil flags |
| `POST https://a-identity.xyz/mcp` | MCP server, all read tools |
| `GET https://a-identity-asp.onrender.com/proof` | Every settlement taken, with transaction hashes |
| `GET https://a-identity-asp.onrender.com/methodology` | How the reputation score is computed |
| `GET https://a-identity-asp.onrender.com/openapi.json` | Full OpenAPI 3.1 description |

Rate limiting is per IP: 20 calls per hour on the free tier. If you need more,
pay for the call rather than asking us for a key.

## Option 2: payment as authentication (x402)

Paid endpoints authenticate the payment, not the caller. There is no identity to
establish and nothing to register. An agent that settles the invoice is
authorized; one that does not is not.

Call the endpoint. If unpaid you receive `HTTP 402` and a machine-readable
challenge naming the price, network, asset, address to pay, the input schema and
a worked example. Settle it, attach the proof, replay the identical request.

```http
POST /tools/risk_check HTTP/1.1
Host: a-identity-asp.onrender.com
Content-Type: application/json

{"agentId": "#849980", "txContext": {"amountUsd": 25}}
```

Two rails are live: per-call settlement on X Layer (`eip155:196`), and gasless
nanopayments on Circle Arc (`eip155:5042002`) where you sign an EIP-3009
authorization off-chain and Circle Gateway batches the on-chain settlement.
Prices run $0.001 to $0.01. Probe the Arc rail unauthenticated at
`GET https://a-identity.xyz/api/x402/nano/data`.

This is the preferred path for autonomous agents. It needs no onboarding, leaves
no long-lived secret in your context, and cannot be revoked out from under you.

## Option 3: agent key (operations that move value)

Required only for `hire_agent`, `deliver_task`, `release_escrow`, `policy_set`
and `record_audit_outcome`. These commit USDC to escrow or change an agent's
spending policy.

### Registration and provisioning

- **Registration endpoint**: `https://a-identity.xyz/signup` (human, browser)
- **Registration method**: owner-provisioned. A person creates the agent, accepts
  its ERC-8004 registration, and sets its limits. The key is issued at the end of
  that flow and shown once.
- **Identity types supported**: `owner_provisioned`. There is no anonymous
  registration and no agent-verified flow.
- **Revocation endpoint**: the console at `https://a-identity.xyz/app`, or freeze
  the agent, which blocks value movement immediately even with a valid key.
- **Self-service agentic registration**: not supported. Do not attempt to POST to
  a registration endpoint; none exists and none will be added without a human
  confirmation step.

### How to pick the key up

Look in this order and stop at the first one that exists:

1. `A_IDENTITY_AGENT_KEY` in your process environment.
2. A project `.env` file the user has told you to read.
3. Your MCP client's configured environment for this server.

If none is set and you genuinely need one, **do not ask the user to paste it
into the conversation**. Tell them to create the agent at
`https://a-identity.xyz/signup`, set the smallest caps that fit the task, and put
the key in `A_IDENTITY_AGENT_KEY`. Then resume. This keeps the key out of your
transcript, out of any logs the user shares, and out of training data.

### How to use it

Send it in the body of the MCP tool call that needs it, over TLS. Never in a URL
and never in a query string, where it lands in access logs and browser history.

Read it from the environment at the moment of the call. Do not copy it into
variables you log, do not echo it back, and do not include it in commit
messages, PR descriptions, error reports or screenshots. In a shell command,
reference the environment variable rather than interpolating the value, so it
does not enter command history.

### What a key cannot do

An agent key is scoped to one agent and bound by that agent's policy. It cannot
raise its own limits: `policy_set` clamps what it accepts, and the on-chain vault
on Arc reverts an over-limit payment regardless of what our server was told. A
stolen key is bounded by the same caps the owner set, which is the entire point
of the design.

### Testing without a key

Value-moving tools called without a key do not error. They return a `prepared`
no-op describing exactly what they would have done. Build and test the whole
integration against that, then add the key last.

### Errors

| Status | Meaning | What to do |
| --- | --- | --- |
| `402` | Payment required for a paid tool. | Settle the challenge in the body and replay the request. |
| `401` on first use | Key malformed or for a different agent. | Ask the user to confirm the value in `A_IDENTITY_AGENT_KEY`. |
| `401` on a previously-working key | Revoked, rotated, or the agent was frozen. | Drop the cached value; ask the user to check the console. |
| `403` | The action is outside this agent's policy. | Do not retry. Call `policy_get` to see the limit, then escalate to the human. |
| `429` | Rate limited on the free tier. | Back off, honor `Retry-After`, or pay for the call. |

Treat a `401` on a key that worked before as revocation. Drop it from memory
rather than retrying.

### Rotation and revocation

Rotate by re-registering the agent from the console. Revocation is immediate.
Freezing is a separate, faster switch: it is a human action and blocks value
movement even while the key remains syntactically valid.

## Related documents

- Machine-readable manifest: [/.well-known/ai-agent-manifest.json](/.well-known/ai-agent-manifest.json)
- MCP server card: [/.well-known/mcp/server-card.json](/.well-known/mcp/server-card.json)
- A2A agent card: [/.well-known/agent-card.json](/.well-known/agent-card.json)
- API catalog (RFC 9727): [/.well-known/api-catalog](/.well-known/api-catalog)
- Skills index: [/.well-known/agent-skills/index.json](/.well-known/agent-skills/index.json)
- How to pay in detail: [/.well-known/agent-skills/pay-with-x402/SKILL.md](/.well-known/agent-skills/pay-with-x402/SKILL.md)
- Full documentation: [/llms-full.txt](/llms-full.txt)

## A note on OAuth

We publish no `/.well-known/oauth-authorization-server` document because we run
no OAuth authorization server. Publishing discovery metadata for an issuer that
does not exist would send agents into a flow that cannot complete, which is
worse than saying so here. If that changes, this file changes with it.

Security reports and access questions: [https://a-identity.xyz/contact](https://a-identity.xyz/contact)
