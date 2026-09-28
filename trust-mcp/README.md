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

`npx -y @a-identity/trust-mcp@0.4.0 wallet status` shows the balances and the next step at any point.
The MCP server uses the same wallet file when `A_IDENTITY_ALGORAND_MNEMONIC` is not set.

## Only have XLM? One command, and all of it is spent on checks

```bash
npx -y @a-identity/trust-mcp@0.4.0 buy
```

It makes two one-time wallets on your computer (secrets saved under `~/.a-identity`, readable by
you only, never printed), prints a Stellar address, and starts working in the background. Send it
as much XLM as you want to spend, at least about 44. From there nothing else is needed:

1. The XLM is exchanged through SideShift: about 18 XLM into ALGO for network fees, the rest into
   USDC on Algorand.
2. The USDC is spent on checks, in this order, round after round, until less than 1 USDC is left:
   an "is it safe to pay" check on an Algorand seller ($5), an agent passport ($10), a payment
   decision ($5), a reputation score ($2), an agent check ($1), a group check of four agents
   ($16), and another seller check ($5). One round is $44 and covers every paid tool.
3. With `--return`, what is left (the ALGO and the Stellar reserve) goes back to that address as
   XLM. Use a personal wallet address (Lobstr, xBull, Freighter), not an exchange: an exchange
   needs a memo this does not send.

`npx -y @a-identity/trust-mcp@0.4.0 status` says where it is and lists every check with its answer
and receipt; the full answers are saved in `~/.a-identity/answers`. If the computer restarts,
run `buy` again: it continues where it stopped, and a check whose payment was already sent is
never paid again. XLM sent after it finished is spent too, the next time `buy` runs.

SideShift has minimums (about 14 XLM in, about 25 ALGO or 3 USDC back) and is not available in
every country. The step-by-step commands (`stellar start`, `stellar run`, `stellar return`) are
still there for anyone who wants to choose each check.

### One prompt for Claude Code (paying with XLM)

This command moves your own money, so Claude Code asks before running it, and its auto mode
blocks it on purpose. Approve it, run it yourself by typing `!` in front of it, or allow this one
tool with a permission rule in your Claude Code settings: `Bash(npx -y @a-identity/trust-mcp@0.4.0:*)`.

> Buy A-Identity checks with my XLM. Do only this, and do not ask me questions. 1) Run `npx -y @a-identity/trust-mcp@0.4.0 buy`. If you are not allowed to run it, show me that exact command in one line so I can run it myself by typing ! in front of it. 2) Show me only the Stellar address and the minimum XLM it prints. I will send the XLM to that address from my own wallet. 3) When I say I sent it, run `npx -y @a-identity/trust-mcp@0.4.0 status` every two minutes until it says "Finished", then list the checks it bought in plain words, one line each. Never print or ask for secret words or keys, and never run any other command.
>
> Spend everything I send, down to the last dollar: if I send 250 XLM, use all of it. Do not stop early or keep any back.

### One prompt for Claude Code (paying with ALGO and USDC)

Paste this into Claude Code. It asks before anything costs money.

> Help me check an Algorand address before I pay it, using A-Identity. Run every command yourself and never print or ask for any secret words. 1) Run `npx -y @a-identity/trust-mcp@0.4.0 wallet new` and show me the address it prints. 2) Tell me to send 0.3 ALGO (Algorand network) to it, then run `npx -y @a-identity/trust-mcp@0.4.0 wallet status` every 30 seconds until the ALGO arrives, and run `npx -y @a-identity/trust-mcp@0.4.0 wallet optin`. 3) Tell me to send 5 USDC (Algorand network) to the same address and wait the same way until it arrives. 4) Ask me which address or link to check, confirm the 5 USDC price with me, then run `npx -y @a-identity/trust-mcp@0.4.0 check <that address>` and explain the answer in plain words with the receipt link. 5) When I say I am done, ask for my own Algorand address and run `npx -y @a-identity/trust-mcp@0.4.0 wallet sweep <my address>` to send everything left back to me.

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
