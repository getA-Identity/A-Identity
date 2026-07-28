# A-Identity guardrails

**The seatbelt for agentic finance.** You write the limits. Before your AI agent places an
order, schedules a buy, changes a setting or moves money, this checks the action against
those limits and answers ALLOW, WARN or DENY. It records every decision.

It does not place orders. It does not give investment advice. It never holds your venue
credentials.

## Install

```
npx skills add a-identity/skills
```

Then point it at the client you already use (see **Callers** below). Out of the box it
targets Robinhood's **official** MCP.

## What it actually does

Your agent asks to do something. The skill:

1. renders the action through the venue's own preview, so the checked amount is the real
   one and not the agent's description of it
2. reads your account state itself (buying power, positions, settled cash, margin, account
   type) rather than accepting numbers from the agent
3. asks A-Identity for a verdict against **your** policy
4. ALLOW runs it once. WARN stops for you. DENY stops, and cannot be retried or argued past
5. records the outcome, with the venue order id as evidence where there is one

## Defaults, before you configure anything

| Setting | Default |
|---|---|
| Per-action cap | $100 |
| Daily cap | $500 |
| Human approval above | $100 |
| Options | off |
| Auto-execute on WARN | off |
| Margin | off, and not offered as a setting |

Margin and "a DENY is final" are not preferences. They are frozen: margin means losing more
than the account holds, and a guardrail an agent can talk its way past is decoration.

## Callers

The guard is tool-agnostic. A caller is a descriptor, so adding one is data rather than a
change to the enforcement path.

**`robinhood-official-mcp` (default, supported).** Robinhood's own sanctioned agent
endpoint. Nothing about using it conflicts with the venue's terms.

Enforcement is **wrapper-level**: every intent this skill sees is checked, and the skill is
the only route it asks you to grant.

**`robinhood-community-cli` (opt-in).** A third-party, unofficial client. **We do not
bundle, install, vendor or distribute it.** If you choose to use it, you install it yourself
from upstream and accept its terms: it reaches Robinhood through your browser session token,
and its own documentation states that Robinhood's terms of service may prohibit automated or
non-browser access. That choice, and its consequences, are yours.

In exchange, enforcement on that path is **process-level**: that client keeps every write as
a dry-run unless a live-write environment switch is set, and this skill holds that switch. It
grants it for a single approved command and withholds it otherwise, so a denied action stays
a preview even if the agent retries.

## What this cannot do

Stated plainly, because the alternative is implying a guarantee we do not have.

- **It cannot contain an agent that has been given both a shell and your venue credential.**
  Such an agent can call the venue's API directly, past this skill entirely. The skill is
  the only path we ask you to grant; it is not a sandbox around everything else on your
  machine.
- On a caller with no live-write switch (including the official MCP), enforcement rests on
  the skill being that only path. There is no process-level veto to fall back on.
- It cannot prevent market losses. It bounds authority, it does not predict markets.
- It is not investment advice, a broker, or an endorsement by any venue.

## Verifying it

The bypass suite is the point of the package. It encodes every way we know of to reach the
venue without a verdict, and asserts the same outcome each time: no unchecked live write.

```
npm test
```

Covered: calling a write tool without checking; ignoring a DENY and retrying; setting the
live-write switch yourself; shelling out to the raw client; an unknown or newly added tool;
structuring one large action into many small ones; supplying a forged account snapshot;
avoiding orders via recurring buys or settings toggles; cancelling protective cover;
submitting legs through a different path; an unreadable preview; and a policy service that
returns nonsense. Deterministic fixtures throughout: no account, no network, no invented
market data.

## Not affiliated

A-Identity is independent. It is not affiliated with, endorsed by, or approved by Robinhood
Markets, Inc. or any other venue. Nothing here is investment advice. Trading involves risk
of loss, and options can lose more than you put in.
