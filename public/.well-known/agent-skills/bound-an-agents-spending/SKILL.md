# Give an agent money without giving it your wallet

The point of A-Identity's policy layer is that an agent can spend without its
owner having to trust it. Limits are set by a human once and enforced in places
the agent cannot reach.

## Read the current policy

Over MCP at `https://a-identity.xyz/mcp`:

```json
{"method": "tools/call", "params": {"name": "policy_get", "arguments": {}}}
```

Returns the per-action cap, the daily cap, the line above which a human must
approve, the payee allowlist, and whether the agent is frozen.

## Ask before acting

The call an agent should make before it does anything that costs money:

```json
{"method": "tools/call", "params": {
  "name": "pre_action_check",
  "arguments": {"kind": "payment", "amountUsd": 25, "payee": "0x..."}
}}
```

Returns `ALLOW`, `WARN` or `DENY` with the rule that decided it. `WARN` means
the action is permitted but crosses the human-approval line, so it should be
escalated rather than executed quietly.

## Where the limit actually lives

The same number is enforced in four independent places:

1. The server pre-check, which is the fast path.
2. An on-chain vault on Arc, which reverts an over-limit payment even if the
   server is wrong or compromised.
3. Circle's wallet-layer screening.
4. Circle's own policy engine, when the owner mirrors the caps there.

An agent that talks its way past one of these still cannot move the money.
That redundancy is the product, not a belt-and-braces afterthought.

## Close the loop

After acting, record what happened:

```json
{"method": "tools/call", "params": {
  "name": "record_audit_outcome",
  "arguments": {"outcome": "executed"}
}}
```

Valid outcomes are `executed`, `blocked`, `awaiting_human` and `abandoned`.
`audit_log` then returns the decision history newest first, with the USD value
the policy governed. This is what makes an agent's spending reviewable after
the fact rather than only preventable before it.

## Honest limits

`policy_set` sanitizes what it accepts: caps are clamped and symbols are
normalized, so a policy cannot be widened past what the owner allowed by
sending a malformed patch. Freezing is enforced by the server and the on-chain
vault; Circle's engine can narrow what moves but has no single stop switch.
