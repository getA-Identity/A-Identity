# @a-identity/trust-mcp

An MCP server that lets your AI agent check another agent before it pays or hires it, and pay
for each check in USDC on Algorand from its own account.

```bash
claude mcp add a-identity-trust \
  -e A_IDENTITY_ALGORAND_MNEMONIC="your 25 words" \
  -e A_IDENTITY_MAX_USD_PER_CALL=10 \
  -- npx -y @a-identity/trust-mcp
```

Any MCP client that runs stdio servers works the same way (Cursor, Claude Desktop, your own).

## No Algorand wallet? Use a one-time one

The same package runs as commands. It makes a wallet on your computer (the 25 secret words are
saved in `~/.a-identity/algorand-wallet.json`, readable by you only, and never printed), tells
you what to send, pays for the check, and sends everything left back to you when you are done.

```bash
npx -y @a-identity/trust-mcp wallet new            # prints the wallet's address
# send 0.3 ALGO to that address (Algorand network), then:
npx -y @a-identity/trust-mcp wallet optin          # lets it hold USDC
# send USDC (Algorand network): 5 covers one address check
npx -y @a-identity/trust-mcp check <ADDRESS OR SELLER LINK>
npx -y @a-identity/trust-mcp ask risk '#0' 25      # or verify / reputation / passport
npx -y @a-identity/trust-mcp wallet sweep <YOUR ALGORAND ADDRESS>   # everything back, wallet closed
```

`npx -y @a-identity/trust-mcp@latest wallet status` shows the balances and the next step at any point.
The MCP server uses the same wallet file when `A_IDENTITY_ALGORAND_MNEMONIC` is not set.

## Only have XLM? Pay from Stellar

`stellar start` makes a one-time Stellar wallet next to the Algorand one and says how much XLM
to send. After that one deposit everything is automatic: `stellar run` exchanges the XLM through
SideShift into ALGO and USDC on Algorand, and `stellar return <your Stellar address>` sends what
is left back to you as XLM and closes both wallets. Run each until it says Ready or Done.

SideShift has minimums, so one 5 USDC check needs about 43 XLM; every extra 25 XLM or so is one
more check, and the rest comes back at the end. USDC left under 3 is below SideShift's minimum
and stays in the Algorand wallet. SideShift is not available in every country.

### One prompt for Claude Code (paying with XLM)

> Help me check an Algorand address before I pay it, using A-Identity, paying with XLM from Stellar. Run every command yourself and never print or ask for any secret words or keys. 1) Run `npx -y @a-identity/trust-mcp@latest stellar start` and show me the Stellar address and the amount of XLM it asks for. 2) Wait while I send XLM to that address from my own wallet or exchange. Then run `npx -y @a-identity/trust-mcp@latest stellar run` again and again (it waits about a minute each time) until it prints "Ready", and tell me briefly what it did. 3) Ask me which Algorand address or service link to check, confirm the 5 USDC price with me, then run `npx -y @a-identity/trust-mcp@latest check <that address>` and explain the answer in plain words with the receipt link. Repeat for more checks while money is left. 4) When I say I am done, ask for my own Stellar address and run `npx -y @a-identity/trust-mcp@latest stellar return <my address>` again and again until it prints "Done", then tell me what came back.

### One prompt for Claude Code (paying with ALGO and USDC)

Paste this into Claude Code. It asks before anything costs money.

> Help me check an Algorand address before I pay it, using A-Identity. Run every command yourself and never print or ask for any secret words. 1) Run `npx -y @a-identity/trust-mcp@latest wallet new` and show me the address it prints. 2) Tell me to send 0.3 ALGO (Algorand network) to it, then run `npx -y @a-identity/trust-mcp@latest wallet status` every 30 seconds until the ALGO arrives, and run `npx -y @a-identity/trust-mcp@latest wallet optin`. 3) Tell me to send 5 USDC (Algorand network) to the same address and wait the same way until it arrives. 4) Ask me which address or link to check, confirm the 5 USDC price with me, then run `npx -y @a-identity/trust-mcp@latest check <that address>` and explain the answer in plain words with the receipt link. 5) When I say I am done, ask for my own Algorand address and run `npx -y @a-identity/trust-mcp@latest wallet sweep <my address>` to send everything left back to me.

## Tools

| Tool | Price (USDC on Algorand) | What your agent gets |
| --- | --- | --- |
| `pay_check` | $5 | Is it safe to pay this Algorand address? A verdict, its biggest payers, its last payments, and who created it |
| `price_quote` | free | The live price of any tool below, and whether it fits your cap |
| `risk_check` | $5 | ALLOW / WARN / DENY on a counterparty, with reasons. Call it before paying. |
| `verify_agent` | $1 | On-chain ERC-8004 identity, KYA status, revocation |
| `reputation_score` | $2 | Deterministic 0-1000 score with its breakdown and a Sybil signal |
| `agent_passport` | $10 | Identity, KYA, reputation and risk in one document |
| `agent_batch_audit` | $4 per agent, up to 50 | Every verdict for a shortlist, with a summary count |

The price that is actually charged is always the one in the tool's x402 challenge; the table is a
convenience, and `price_quote` reads the live number. These are Algorand prices since
2026-09-26. The default per-call cap is 10 USDC, which covers every single-agent tool; set
`A_IDENTITY_MAX_USD_PER_CALL` higher for a batch audit (50 agents is $200), or lower to spend less.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `A_IDENTITY_ALGORAND_MNEMONIC` | unset | The paying account. It needs USDC (ASA 31566704, opted in) and no ALGO for fees. Unset: paid tools return their price instead of paying. |
| `A_IDENTITY_MAX_USD_PER_CALL` | `10` | Any single call priced above this is refused before anything is signed. 10 covers every single-agent tool; a 50-agent audit is $200. |
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
