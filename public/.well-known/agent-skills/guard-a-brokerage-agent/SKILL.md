# Put a guardrail in front of an agent that trades

Use this when an agent is about to place orders, change account settings or move
money at a brokerage, and you want a rule to decide instead of a prompt.

The guardrail is caller-agnostic: it never learns which client produced an
intent, so the same policy covers an official agent MCP, a local CLI wrapper, or
your own code calling a venue REST API. All calls go to the MCP server at
`https://a-identity.xyz/mcp` and every one of them is owner only, so the caller
needs a verified session for that agent.

Nothing here executes anything. The check returns a verdict; the caller is still
the thing that acts.

## Set the rules once

```json
{"method": "tools/call", "params": {
  "name": "policy_set",
  "arguments": {
    "agentId": "agent_m4x2k9p1",
    "policy": {
      "perActionCapUsd": 250,
      "dailyCapUsd": 1000,
      "humanApprovalAboveUsd": 100,
      "trade": {
        "allowSymbols": ["AAPL", "MSFT", "BTC"],
        "denySymbols": ["GME"],
        "allowOptions": false,
        "tradingHoursUtc": {"start": "14:30", "end": "21:00"},
        "maxConcentrationPct": 25
      }
    }
  }
}}
```

The patch is sanitized before it is stored: caps are clamped, symbols are
normalized, and the version bumps by one so an audit row can name the exact
policy that produced a verdict. Margin is not a switch. It is typed as
permanently off, so an edit that tries to enable it fails rather than shipping.

`policy_get` reads the current one back, including safe defaults with
`configured: false` when nobody has set one yet. An unconfigured agent is never
permissive.

## Check before every action

Send the intent you are about to execute, plus the account state you just read:

```json
{"method": "tools/call", "params": {
  "name": "pre_action_check",
  "arguments": {
    "agentId": "agent_m4x2k9p1",
    "surface": "trade",
    "intent": {
      "kind": "order",
      "side": "buy",
      "symbol": "AAPL",
      "assetClass": "equity",
      "notionalUsd": 180
    },
    "snapshot": {
      "todayNotionalUsd": 220,
      "positions": [{"symbol": "AAPL", "shares": 4, "valueUsd": 900}],
      "portfolioValueUsd": 10000,
      "cashAvailableUsd": 3200,
      "marginUsedUsd": 0,
      "accountType": "cash"
    }
  }
}}
```

Returns `ALLOW`, `WARN` or `DENY` with every triggered reason, a stable code per
reason, the audit id, and a `provenance` block saying where the numbers came
from.

Three rules worth knowing before you wire it up:

- `notionalUsd` must come from the venue's own preview of the order, not from
  the model's arithmetic. The point is to check the action the venue would
  actually receive.
- `snapshot` is gathered by whatever is making this call and never authored by
  the agent being checked. An agent that can write its own account state can buy
  an `ALLOW` by overstating its buying power.
- A rule whose input is missing fails closed. A thin snapshot costs you a
  `DENY`, never a wrong `ALLOW`.

Non-order actions need a verdict too, and skipping them is how a cap gets
evaded. `kind` accepts `order`, `purchase`, `cancel`, `recurring`, `settings`,
`transfer` and `document`. A recurring buy is one approval and many future
executions; cancelling a protective leg raises risk rather than lowering it.

### Let a registered caller translate instead

If you are driving a venue whose payload shape we already understand, send that
payload unmodified and let the adapter normalize it:

```json
{"method": "tools/call", "params": {
  "name": "pre_action_check",
  "arguments": {
    "agentId": "agent_m4x2k9p1",
    "surface": "trade",
    "callerId": "robinhood-crypto-api",
    "action": {
      "symbol": "BTC-USD",
      "side": "buy",
      "type": "limit",
      "limit_order_config": {"quote_amount": "25.00", "time_in_force": "gtc"}
    },
    "account": {
      "buying_power": "1200.00",
      "total_value_usd": "9800.00",
      "today_notional_usd": "0",
      "holdings": [{"symbol": "BTC-USD", "quantity": "0.01", "value_usd": "620.00"}]
    }
  }
}}
```

`GET https://a-identity.xyz/api/callers` lists the registered callers, which of
them can translate a payload today, and how strong each one's enforcement
actually is. Send either `intent` or `callerId` plus `action`, never both: with
both, the audit row could not honestly say which one produced the verdict.

An adapter that cannot compute a real USD value from the payload refuses rather
than estimating. A quantity with no price and no mark is not checkable, and an
estimate is not good enough to authorize money.

## Where each limit is actually enforced

This is the part most guardrail pitches overstate, so here it is per rule.

| Limit | Server pre-check | On-chain | Notes |
|---|---|---|---|
| Per-action cap, daily cap, approval line | yes | no | Action-surface caps; there is no contract in this path |
| Symbol allow and deny lists | yes | no | Ticker lists exist only here |
| Options off, margin off | yes | no | Margin is off at the type level, not by configuration |
| Trading hours window | yes | no | Skipped for 24/7 crypto, because a session window written for equities is not a limit the user meant to place on a round-the-clock market |
| Concentration limit | yes | no | Needs portfolio state, which exists only in the snapshot |
| Merchant, MCC, per-card ceiling (`spend`) | yes | no | A card network is not a chain we can write to |
| USDC daily cap, auto-approve line, payee allowlist, freeze | yes | yes | A different policy on a different surface: the AgentSpendPolicy vault on Arc reverts an over-limit `pay()` |

So the action policy has exactly one enforcement point today: this server. The
USDC payment policy has two, and the second one holds even if this server is
wrong or compromised. We are not going to describe those as the same guarantee.

The other half of enforcement is the caller, not us. What a `DENY` is actually
worth depends on whether the thing that received it could have made the call
anyway:

| Enforcement | What a DENY means |
|---|---|
| `process` | The caller starts the venue process and gates its writes. A real veto. |
| `wrapper` | The caller can only decline to make the call it was handed. An agent holding its own credentials for the same account is not contained. |
| `none` | Nothing we can name stood in between. The verdict is advice plus a record. |

Every audit row records which of the three applied. A row written before this
was recorded carries no provenance at all, and reads as "not recorded" rather
than being backfilled with a guess.

## Record what happened, then read the trail

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

Outcomes are `executed`, `blocked`, `awaiting_human` and `abandoned`.
`evidenceRef` is your post-action proof, for example a venue order id, so an
entry can be reconciled against the venue rather than believed.

A `DENY` can never be recorded as `executed`. The attempt is counted before it
is refused, because an operator repeatedly trying to mark blocked actions as
done is the single most informative behavioral signal there is.

```json
{"method": "tools/call", "params": {
  "name": "audit_log",
  "arguments": {"agentId": "agent_m4x2k9p1", "limit": 50}
}}
```

Newest first, with a summary that includes the USD value the policy actually
refused. Each entry carries a hash of the account snapshot rather than the
snapshot itself: the hash proves which state a verdict was computed against,
without turning the log into a record of your holdings.

## What this does not do

- It does not contain an agent that has been handed raw venue credentials and a
  shell. The honest claim is bounded: the policy is enforced on every path the
  caller mediates, and the caller is the only path you should grant.
- The `bet` surface is `planned` and ships as a schema only. Prediction
  contracts run through a different legal entity under different rules, and the
  engine refuses a non-live surface before any rule runs, so it can be read and
  built against and it still cannot authorize a dollar.
- It is not advice about whether a trade is good. A verdict is a comparison
  against limits a human wrote down, and nothing here forecasts anything.
