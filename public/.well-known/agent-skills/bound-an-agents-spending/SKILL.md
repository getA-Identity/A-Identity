# Give an agent money without giving it your wallet

The point of A-Identity's policy layer is that an agent can spend without its
owner having to trust it. Limits are set by a human once and enforced in places
the agent cannot reach.

## Read the current policy

Over MCP at `https://a-identity.xyz/mcp`:

```json
{"method": "tools/call", "params": {
  "name": "policy_get",
  "arguments": {"agentId": "agent_m4x2k9p1"}
}}
```

Returns the per-action cap, the daily cap, the line above which a human must
approve, the symbol allow and deny lists, the merchant and category rules, and
whether the agent is frozen, plus the policy version. Owner only: the caller
must hold a verified session for that agent.

The payee allowlist is a different policy on a different surface (the Arc USDC
payment rail) and is read from `/api/agents/policy`, not from here. They are
kept apart on purpose: a list of wallet addresses and a list of tickers do not
belong in the same object.

## Ask before acting

The call an agent should make before it does anything that costs money:

```json
{"method": "tools/call", "params": {
  "name": "pre_action_check",
  "arguments": {
    "agentId": "agent_m4x2k9p1",
    "surface": "spend",
    "intent": {
      "kind": "purchase",
      "notionalUsd": 25,
      "merchant": "Acme Cloud",
      "mcc": "7372",
      "cardId": "card_ops"
    },
    "snapshot": {
      "todayNotionalUsd": 40,
      "positions": [],
      "cardSpentTodayUsd": {"card_ops": 40}
    }
  }
}}
```

Returns `ALLOW`, `WARN` or `DENY` with every rule that decided it, the audit id,
and where the numbers came from. `WARN` means the action is permitted but
crosses the human-approval line, so it should be escalated rather than executed
quietly.

`snapshot` is gathered by whatever is making the call, never authored by the
agent being checked: an agent that writes its own account state can buy an
`ALLOW` by understating what it has already spent. A rule whose input is
missing fails closed and returns `DENY`, so a thin snapshot costs you a refusal
rather than a wrong approval.

## Where each limit is actually enforced

Two different policies live behind this skill, and they are not enforced in the
same number of places. Stating that plainly is more useful than a bigger number.

| Limit | Server pre-check | On-chain vault (Arc) | Notes |
|---|---|---|---|
| Daily USDC cap | yes | yes | The vault reverts an over-cap `pay()` even if the server is wrong or compromised |
| Auto-approve ceiling | yes | yes | Same contract, same revert |
| Payee allowlist | yes | yes | On-chain flag plus a per-payee mapping |
| Freeze | yes | yes | The vault has its own owner-only freeze |
| Symbols, options, trading hours | yes | no | There is no on-chain rail: we have no execution path to a brokerage |
| Merchant, MCC, per-card ceiling | yes | no | Same reason. A card network is not a chain we can write to |
| Concentration limit | yes | no | Needs portfolio state, which exists only in the snapshot |

So the USDC payment policy is enforced in two independent places, and an agent
that talks its way past the server still cannot move that money. The ACTION
policy, which is the interesting half, has exactly one enforcement point today:
this server. It is honest about that rather than implying a contract is watching
your ticker list.

Circle's wallet-layer screening can mirror the USDC caps, but only after the
owner runs the generated commands themselves from their own wallet. We never
apply them, so it is not a place we can claim the limit is already enforced.

## Close the loop

After acting, record what happened:

```json
{"method": "tools/call", "params": {
  "name": "record_audit_outcome",
  "arguments": {
    "agentId": "agent_m4x2k9p1",
    "auditId": "aud_m4x2kc7q",
    "outcome": "executed",
    "evidenceRef": "order_8812"
  }
}}
```

Valid outcomes are `executed`, `blocked`, `awaiting_human` and `abandoned`.
`auditId` is the one `pre_action_check` returned. `evidenceRef` is optional and
is your post-action proof, for example a venue order id, so an entry can be
reconciled against the venue rather than believed.

A `DENY` can never be recorded as `executed`. The attempt is counted before it
is refused, because repeated attempts are the most informative signal there is.

`audit_log` then returns the decision history newest first, with the USD value
the policy governed. This is what makes an agent's spending reviewable after
the fact rather than only preventable before it.

## Honest limits

`policy_set` sanitizes what it accepts: caps are clamped and symbols are
normalized, so a policy cannot be widened past what the owner allowed by
sending a malformed patch. Margin cannot be enabled at all; it is off by
construction rather than off by default.

Freezing is enforced by the server and the on-chain vault. Circle's engine can
narrow what moves but has no single stop switch.
