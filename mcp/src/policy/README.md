# The policy module: what the code is citing

Source files in this module carried citations to `docs/robinhood-*.md`. Those files are
gitignored, so every one of those citations pointed at nothing for anyone who cloned this
repository, including the reader most likely to need them: someone auditing a refusal.

This file is the tracked replacement. It carries only the reasoning the code actually
cites, restated so it stands on its own. It is deliberately NOT a copy of the internal
documents: the full bypass matrix stays unpublished, because a list of every way to attack
a guardrail is more useful to an attacker than to a reviewer. What is published is the
reason a specific rule exists, which is what a reader of that rule needs.

`docs-citations.test.ts` fails the build if a tracked source cites a path that is
gitignored or missing, so this cannot silently rot again.

---

## The five things we do not do

Architectural, not policy preferences. Each is enforced by the design.

1. **We do not place orders, charges or bets.** There is no execution path from here to
   any venue. A verdict is a return value; the caller acts on it. This is the same
   prepared-or-executed separation the chain writes use, one level up.
2. **We do not give investment advice.** No recommendations, no price targets, no
   security selection, no market outlook. A DENY means "this breaches a limit you set",
   never "this is a bad investment".
3. **We do not hold venue credentials.** A brokerage session token stays on the user's
   own machine, is never sent here, is never logged, and is rejected if it ever appears
   in a payload.
4. **We do not connect to the venue.** No server here opens a connection to a brokerage.
   Account state reaches the engine only as a minimized `snapshot` supplied by the caller.
5. **We do not custody assets or take a cut of trading activity.** Never a percentage of
   volume or P&L.

## Why the owner surface is free

`pre_action_check`, `audit_log`, `policy_get`, `policy_set` and `register_agent` are free
and owner-gated. That is a design constraint, not a promotion, for two reasons:

- **Payment cannot prove ownership.** If an x402 gate stood in front of
  `pre_action_check`, any stranger could pay a fraction of a cent and probe someone else's
  policy, learning their caps, their allowlists and, through verdicts, their holdings.
  Metering `audit_log` would be worse: that is someone's decision history.
- **Charging the owner per check taxes safety.** The check runs on every action the
  owner's own agent takes. Metering it means the more carefully someone configures
  themselves, the more they pay, and a refusal costs them money for being protected.

Revenue comes from the counterparty signal instead (`guardrail_check`), which answers
"does this agent operate under an enforced policy, and does it respect the verdicts?" for
a THIRD party, in bands only. The payer is a stranger asking about someone else, which is
what payment is actually good for. See `compliance.ts` for what a band may and may not
contain.

## Why a verdict is a comparison, not advice

The distinction this module relies on, stated plainly so it can be challenged:

- The **user** authors the policy: caps, allowed symbols, hours, the options and margin
  switches, approval thresholds. Nothing here suggests values, offers presets tuned to a
  market view, or tunes them per user.
- The output is a **deterministic function of the user's own rules and their account
  state**. `evaluateAction` takes (policy, intent, snapshot, clock) and nothing else.
  Identical inputs always produce an identical verdict. That is a comparison, not an
  opinion.
- Nothing here ranks, scores or suggests securities. `allowSymbols` and `denySymbols` are
  lists the user typed. A symbol being on one carries no view about that symbol.
- It does not say whether to trade, when, or how much. It answers whether an action the
  user's agent **already intends** breaches a limit the user **already set**.

Binding on future work: no feature may propose, autofill or optimize policy values from
market data; no output may rank securities or express a directional view; and reputation
excludes P&L, because scoring an agent on returns would be a performance claim while
scoring it on limit compliance is not.

## Snapshot minimization

An account snapshot is holdings and buying power. Keeping it would turn an audit log into
a financial dossier, and it is not needed: what a decision has to be reconcilable against
is WHICH state it was computed on, and a hash proves that.

So `audit.ts` stores `sha256` of a canonical snapshot and never the snapshot. Canonical
matters: key order and position order must not change the hash, or the same account state
would produce two hashes and reconciliation would mean nothing.

Everything else stored is bounded and truncated, so a caller cannot grow an entry without
limit or smuggle a payload through a label. The snapshot itself carries only what a
verdict needs: buying power, positions as `{symbol, shares, valueUsd}`, today's notional,
account type, margin used. No account numbers, no personal identifiers, no document
contents, no order history.

## Red lines

No order, charge or bet execution. No advice. No credential custody. `allowMargin` hard
false and not silently flippable (it is typed as the literal `false`, so an edit that
tries to enable it fails to compile). Auto-execute off by default. A DENY is not
overridable by an agent, and an attempt to record one as executed is counted before it is
refused. Reputation excludes P&L. No fabricated volume on the real-money side; canaries
are labelled `ci` and excluded from every traction headline. **No mock or fabricated
account data in the product**: deterministic fixtures live in unit tests only, and a
runtime snapshot always comes from a real caller. Every user-facing verdict says it is not
investment advice.

## Two evasions the rules exist to answer

Published by REASON, because a rule whose motivation is invisible is a rule someone
deletes during a refactor. The full attack matrix stays internal.

### Splitting one large action into many small ones

A per-action cap alone does not stop an agent that turns one over-cap order into N
under-cap ones. The daily cap is what catches it, which is why `dailyCap` reads
`snapshot.todayNotionalUsd` and adds the current action to it rather than looking at the
action in isolation, and why the rule DENIES outright when no snapshot is supplied. A
cumulative limit that cannot see the cumulative total is not a limit.

### An agent that writes its own snapshot

An agent that can author its own account state can buy an ALLOW by overstating buying
power or hiding positions. The defence is procedural and it is stated honestly rather than
claimed: the snapshot must be gathered by the CALLER (the wrapper or skill, from the
venue's own read paths) and never by the agent being policed. Nothing in this process can
verify that, so the audit entry records a hash of exactly what was used, which makes a
falsified snapshot detectable after the fact instead of invisible.

The same reasoning is why `notionalUsd` must come from the venue's own dry-run preview
rather than from a model's arithmetic: the engine has to check the action the venue would
actually receive, not the action the agent described in prose. An adapter that cannot
compute a real value from a payload fails rather than estimating (see `../callers/`).

## The bound on the whole claim

An agent with both a shell and a bearer credential on the same machine can reach a venue
directly, and nothing here contains it. The honest claim is bounded: **the policy is
enforced on every path the caller mediates, and the caller is the only path the user is
asked to grant.** A caller's `enforcement` level (`process`, `wrapper`, `none`) records
how strong that mediation actually is per caller, because it genuinely differs and
implying one guarantee for all of them would be the central dishonesty available here.

## The rule that keeps this module a core

Nothing in `policy/` may import a caller-specific module, and the engine never branches on
who is asking. Translation lives in `../callers/`; decisions live here.
`engine.test.ts` fails the build if a venue name appears in this directory's code, and
`../callers/normalize.test.ts` fails it if anything here imports the seam. Prose may name
a caller, because explaining a rule sometimes requires it; code may not.
