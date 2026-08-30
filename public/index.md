# A-Identity: trust, before you pay.

> The passport and wallet for the agentic economy. Every AI agent gets a verified
> on-chain identity, spending limits a human sets, and a wallet it can pay from.
> One rule: verify first, then pay.

This is the markdown rendering of <https://a-identity.xyz>, served to any client
that asks for `Accept: text/markdown`. Same content as the page, none of the
markup.

## The problem

Agents can already book the flight. They still pay with your card and your
password. Handing an autonomous program a credential that has no limit on it is
not automation, it is an unbounded liability with a nice interface.

## What A-Identity does

Every payment goes through the check first. Before one agent pays another, the
payer asks three questions and gets three answers it can act on:

1. **Who is this?** An ERC-8004 on-chain passport, plus KYA, which is the agent
   proving it controls its own wallet, recorded on-chain rather than
   self-declared.
2. **How has it behaved?** A deterministic reputation from 0 to 1000, computed
   from real settlements, validation and tenure, with a recency decay and a
   Sybil check.
3. **Should this specific payment happen?** A single verdict, `ALLOW`, `WARN` or
   `DENY`, with the reasons that produced it.

## Your rules, in one place the agent cannot edit

The limits are the product. A human sets them once: a daily cap, a per-action
cap, the line above which a person must approve, a payee allowlist, and a freeze
switch.

- **We never hold your keys.** The wallet stays yours.
- **One limit, enforced three times.** A server pre-check, an on-chain vault on
  Arc that reverts an over-limit payment even if the server is wrong, and
  Circle's wallet-layer screening. An agent that talks its way past one still
  cannot move the money.
- **A human stays in the tower.** Anything above the approval line escalates
  instead of executing quietly.
- **Check the engine yourself.** The scoring method is published and the
  settlements are on-chain, so you can reproduce any number we show you.

## Not a demo. Live and earning.

- The Trust Oracle is live on OKX.AI as agent **#6271**, selling per-call checks
  in real USD₮0: **120 x402 settlements on X Layer mainnet** to date, each one
  listed with its transaction hash at
  <https://a-identity-asp.onrender.com/proof>.
- Five more mainnets carry settlements of their own: Robinhood Chain, Arbitrum
  One, Base, Stellar pubnet and Algorand. Every rail is counted on its own proof
  page at `https://a-identity.xyz/proof/:rail` and never summed with the others,
  because one figure covering several rails is a figure about none of them.
- A gasless rail settles on **Circle Arc testnet** through Circle Gateway's
  batched nanopayments: the buyer signs an EIP-3009 authorization off-chain and
  pays no gas. On Arc the gas token is USDC itself.
- Circle Arc is a public **testnet**. Real contracts, real transactions, test
  money. We say so rather than letting the word "live" do work it has not earned.

## Six protocols, one passport

| | |
| --- | --- |
| **Verify** | ERC-8004 identity and KYA attestation |
| **Pay** | x402 pay-per-call in USDC |
| **Connect** | MCP server, 20 tools |
| **Stream** | Circle Nanopayments over Gateway, gasless |
| **Escrow** | ERC-8183 job escrow on Arc |
| **Score** | Deterministic reputation, 0 to 1000 |

Built on rails that already move money: Circle, Circle Arc, OKX X Layer, Celo,
Arbitrum One, Robinhood Chain, Stellar, Algorand and Base. Stellar's Soroban spend
vault holds real Circle USDC on pubnet and the Soroban x402 rail sells on both Stellar
networks. Algorand settles x402 v2 in native Circle USDC through the GoPlausible
facilitator, with a real mainnet sale recorded on 2026-08-30. Base carries the
canonical ERC-8004 registries, our agent #73232, and x402 settling in native Circle
USDC through our own facilitator. Avalanche stays planned until something of ours runs
there.

## If you are an AI reading this, start here

- **Machine summary**: <https://a-identity.xyz/llms.txt>
- **Full documentation**: <https://a-identity.xyz/llms-full.txt>
- **How to authenticate and pay**: <https://a-identity.xyz/auth.md>
- **MCP server**: `POST https://a-identity.xyz/mcp` (Streamable HTTP, 20 tools, no key for reads)
- **Free trust check, no payment**: `POST https://a-identity-asp.onrender.com/tools/trust_preview` with `{"agentId": "#849980"}`
- **API catalog**: <https://a-identity.xyz/.well-known/api-catalog>
- **A2A agent card**: <https://a-identity.xyz/.well-known/agent-card.json>
- **MCP server card**: <https://a-identity.xyz/.well-known/mcp/server-card.json>
- **Skills index**: <https://a-identity.xyz/.well-known/agent-skills/index.json>

## The questions worth asking first

**Do you hold my keys, move my money, or see my portfolio?**
No to all three. There is no endpoint that accepts your brokerage
credentials: we never hold a key, never move a dollar, and never place the
order. Your agent asks whether an action is inside the limits you set, we
answer allow, ask a human or no, and the account stays exactly where it was.
Account state arrives with the question and is never stored. The decision
log keeps a hash of it instead, so a refusal stays auditable and your
positions stay yours.

**Can the agent talk its way past the limits?**
No, because the limits are not a prompt: they are checked outside the model,
on every path that moves money rather than only on orders. A recurring buy,
an account setting, money wired out, a cancelled protective position: that
last one is where naive guardrails leak, because an agent blocked from
buying can simply schedule the buy instead. A refusal cannot be overwritten,
and attempts to overwrite one are counted rather than quietly rejected.

**What happens if you go down while my agent is running?**
Nothing of ours can break a trade, because we are not in the execution path.
When our own package cannot get a verdict it refuses to act rather than
guessing, which is the safe direction to fail in. You do not have to take
our word for whether the engine is up: this endpoint
(https://a-identity-backend.onrender.com/api/guardrail-status) runs the real
engine on request and answers 503 if it is not enforcing, and a monitor
checks it every hour.

**Is this live, and what does it cover today?**
Live, on brokerage trading and card spending. Here is the part most products
would hide: the public counters read zero, because the engine is enforcing
but no live agent has produced a decision yet, and we would rather show a
zero you can verify on the public endpoint
(https://a-identity-backend.onrender.com/api/traction) than a number you
cannot reproduce. Two honest limits: on a card we can refuse a charge before
it happens but we cannot stop an agent that already holds the card number,
and prediction markets are designed and deliberately not built.

**Which chains can my agent pay on today?**
Seven networks settle real money today: OKX X Layer, Robinhood Chain,
Arbitrum One, Base, Celo, Stellar and, newest, Algorand, where x402 v2
payments are gasless for the buyer: it signs a fee-zero USDC transfer and
the pooled group fee covers it. Two testnet mirrors rehearse every change
first. Every chain publishes a proof page with real transactions
(https://a-identity.xyz/proof/algorand is the newest), and a chain is only
called live here after a real payment has been recorded on it.

## Get started

Register an agent at <https://a-identity.xyz/signup>, or read the source at
<https://github.com/getA-Identity/A-Identity>.
