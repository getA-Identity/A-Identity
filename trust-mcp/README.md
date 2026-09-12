# @a-identity/trust-mcp

An MCP server that lets your AI agent check another agent before it pays or hires it, and pay
for each check in USDC on Algorand from its own account.

```bash
claude mcp add a-identity-trust \
  -e A_IDENTITY_ALGORAND_MNEMONIC="your 25 words" \
  -e A_IDENTITY_MAX_USD_PER_CALL=0.25 \
  -- npx -y @a-identity/trust-mcp
```

Any MCP client that runs stdio servers works the same way (Cursor, Claude Desktop, your own).

## Tools

| Tool | Price (USDC on Algorand) | What your agent gets |
| --- | --- | --- |
| `price_quote` | free | The live price of any tool below, and whether it fits your cap |
| `risk_check` | $0.05 | ALLOW / WARN / DENY on a counterparty, with reasons. Call it before paying. |
| `verify_agent` | $0.01 | On-chain ERC-8004 identity, KYA status, revocation |
| `reputation_score` | $0.02 | Deterministic 0-1000 score with its breakdown and a Sybil signal |
| `agent_passport` | $0.10 | Identity, KYA, reputation and risk in one document |
| `agent_batch_audit` | $0.04 per agent, up to 50 | Every verdict for a shortlist, with a summary count |

The price that is actually charged is always the one in the tool's x402 challenge; the table is a
convenience, and `price_quote` reads the live number.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `A_IDENTITY_ALGORAND_MNEMONIC` | unset | The paying account. It needs USDC (ASA 31566704, opted in) and no ALGO for fees. Unset: paid tools return their price instead of paying. |
| `A_IDENTITY_MAX_USD_PER_CALL` | `0.25` | Any single call priced above this is refused before anything is signed. A 50-agent audit is $2.00. |
| `A_IDENTITY_BASE_URL` | `https://a-identity.xyz` | The oracle origin, if you self-host. |
| `A_IDENTITY_ALGOD_URL` | public Nodely endpoint | algod override. |

## What happens when a tool is paid

1. The oracle answers 402 with the price.
2. If the price is within your cap, this server signs one USDC transfer of exactly that amount to
   the oracle, with fee zero, grouped with a fee-payer transaction the GoPlausible facilitator
   signs and pays for. Your key stays in this process.
3. The oracle produces the answer, submits the payment, reads the transfer back from the chain,
   and only then returns the answer. If it cannot produce the answer, it never submits the
   payment.

Built on [`@a-identity/trust-guard`](https://www.npmjs.com/package/@a-identity/trust-guard). Every
settlement is public at https://a-identity.xyz/api/x402/algorand/proof.

MIT
