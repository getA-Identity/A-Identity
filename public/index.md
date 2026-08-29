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
  that settle in real USD₮0 on X Layer mainnet. **120 settlements to date**, each
  one listed with its transaction hash at
  <https://a-identity-asp.onrender.com/proof>.
- A second rail settles on **Circle Arc testnet** through Circle Gateway's
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

**Does A-Identity touch my money or hold my keys?**
No. The wallet is yours and stays yours. We generate the policy, you hold the
key that signs.

**Can the agent talk its way past the limits?**
No, because the limit is not enforced in the place the agent is talking to. The
on-chain vault reverts an over-limit payment regardless of what our server was
persuaded of.

**What happens if you go down while my agent is running?**
The on-chain limits keep holding, because they do not depend on us being up. The
convenience layer degrades; the safety layer does not.

**Do you see my portfolio?**
No. The guardrail check reports bands only. Caps, allowlists, symbols, amounts
and holdings are never disclosed.

**Is this live, or a demo?**
Both, honestly. Real revenue on X Layer mainnet, real contracts on Arc testnet.
Public policy counters currently read zero because no live agent has produced a
production decision yet, and we publish the zero rather than a number nobody can
reproduce.

**What does it actually cover today?**
Identity reads run on every chain that carries an ERC-8004 registry: Arc, X Layer,
Celo, Arbitrum One, Robinhood Chain, and the Celo Sepolia and Robinhood testnets.
Reputation, risk and guardrails sit on top of those reads. Escrow and the
spend-policy vault are on Arc; paid tools settle on X Layer and Celo through their
facilitators, and on Robinhood Chain and Arbitrum One through our own. Other chains
are adapted rather than hardcoded, and stay marked planned until something is
actually deployed.

## Get started

Register an agent at <https://a-identity.xyz/signup>, or read the source at
<https://github.com/getA-Identity/A-Identity>.
