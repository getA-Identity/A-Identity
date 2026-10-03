# @a-identity/trust-mcp

An MCP server that lets your AI agent check whoever it is about to pay (an Algorand address, an
x402 seller, another agent) and pay for each check in USDC on Algorand from its own account.
Checks are always paid in USDC on Algorand; if you only hold XLM on Stellar, `buy` exchanges it
for you (see below).

```bash
claude mcp add a-identity-trust \
  -e A_IDENTITY_ALGORAND_MNEMONIC="your 25 words" \
  -e A_IDENTITY_MAX_USD_PER_CALL=10 \
  -- npx -y @a-identity/trust-mcp
```

Any MCP client that runs stdio servers works the same way (Cursor, Claude Desktop, your own).

Your agent calls `check_before_pay` with the target and the amount before each payment. The tool
picks the checks that amount calls for and returns ALLOW, WARN or DENY; on DENY the agent does
not pay. The agent decides on its own and never asks you which checks to buy, and it never pays
twice for the same check (see "Each check is paid for once").

## No Algorand wallet? Use a one-time one

The same package runs as commands. It makes a wallet on your computer (the 25 secret words are
saved in `~/.a-identity/algorand-wallet.json`, readable by you only, and never printed), tells
you what to send, pays for the check, and sends everything left back to you when you are done.

```bash
npx -y @a-identity/trust-mcp wallet new            # prints the wallet's address
# send 0.3 ALGO to that address (Algorand network), then:
npx -y @a-identity/trust-mcp wallet optin          # lets it hold USDC
# send USDC (Algorand network): 5 covers one address check
npx -y @a-identity/trust-mcp check <ADDRESS, SELLER LINK OR AGENT ID> [AMOUNT YOU ARE ABOUT TO PAY]
npx -y @a-identity/trust-mcp ask risk '#0' 25      # or verify / reputation / passport
npx -y @a-identity/trust-mcp wallet sweep <YOUR ALGORAND ADDRESS>   # everything back, wallet closed
```

`npx -y @a-identity/trust-mcp@0.4.5 wallet status` shows the balances and the next step at any point.
The MCP server uses the same wallet file when `A_IDENTITY_ALGORAND_MNEMONIC` is not set.

## Only have XLM? One deposit becomes your agent's budget for checks

```bash
npx -y @a-identity/trust-mcp@0.4.5 buy --new
```

It starts by saying what the money is for:

> Everything you send is spent by your agent on checks of the targets it chooses, each one a
> different check. If no new target is left, what remains waits in the wallet; get it back with
> `refund`.

Then it makes two one-time wallets on your computer (secrets saved under `~/.a-identity`,
readable by you only, never printed), prints a Stellar address, and works in the background. Send
it as much XLM as you want your agent to spend on checks, at least about 44.

1. The XLM is exchanged through SideShift: about 18 XLM into ALGO for network fees, the rest into
   USDC on Algorand. Once the USDC is in, the ALGO above the 0.2 the wallet must keep becomes
   USDC too, so the whole amount can pay for checks.
2. Then it stops. Nothing is spent until your agent asks for a check. Add the server to your agent
   (`claude mcp add a-identity-trust -- npx -y @a-identity/trust-mcp@0.4.5`); it finds the
   one-time wallet on its own. From a terminal, `check <TARGET> <AMOUNT>` does the same thing.
3. What is not spent waits in the wallet. `refund --to <YOUR STELLAR ADDRESS>` sends it back to
   you as XLM. It covers the current wallets and every wallet an earlier run moved aside: the
   Stellar wallet is merged into your address, and the USDC and ALGO are exchanged back to XLM.
   Amounts under SideShift's minimum (about 3 USDC or 25 ALGO) cannot go that way; `refund`
   says so and prints the command that returns them on Algorand. Use a personal wallet address
   (Lobstr, xBull, Freighter), not an exchange: an exchange needs a memo this does not send.

`npx -y @a-identity/trust-mcp@0.4.5 status` starts with one line,
`Status: Running|Idle|Finished | Spent: .. USDC (n checks) | Left: .. USDC`, then lists every
check with its answer and receipt. Running means XLM is being exchanged or sent back, Idle means
the USDC is waiting for your agent, Finished means less than 1 USDC is left or everything was
sent back. If the computer restarts, run `buy` again: it continues where it stopped. XLM sent
later is added to the budget the next time `buy` runs.

`--new` gives each person their own wallets: if this computer already has wallets from someone
else's earlier run, they are moved aside (renamed, never deleted, with anything left in them)
and new ones are made. A round that is still waiting for XLM and received none is set aside
too, and its background worker stopped, once it is more than 30 minutes old; a younger one is
taken to be this person's own and continued, so running `buy --new` twice never changes the
address. Wallets that still hold unspent XLM or USDC, or an exchange under way, are never set
aside: spend the money or `refund` it first.

SideShift has minimums (about 14 XLM in, about 25 ALGO or 3 USDC back) and is not available in
every country. The step-by-step commands (`stellar start`, `stellar run`, `stellar return`) are
still there.

### One prompt for Claude Code (paying with XLM)

This command moves your own money, so Claude Code asks before running it, and its auto mode
blocks it on purpose. Approve it, run it yourself by typing `!` in front of it, or allow this one
tool with a permission rule in your Claude Code settings: `Bash(npx -y @a-identity/trust-mcp@0.4.5:*)`.

> I want to give my agent a budget for A-Identity checks (https://a-identity.xyz), paid with XLM, using their open-source tool @a-identity/trust-mcp 0.4.5 (source: https://github.com/getA-Identity/A-Identity/tree/main/trust-mcp). How it works: it makes a one-time Stellar wallet on this computer and prints its address, I send XLM there from my own wallet, and it exchanges the XLM through SideShift into USDC on Algorand (plus a little ALGO for fees). After that the USDC waits for checks: before a payment, the agent checks the target and pays only for checks it does not already have ($1 to $10 each, each check of a target paid for once). Read the package first if you want. 1) Run `npx -y @a-identity/trust-mcp@0.4.5 buy --new`. I want wallets of my own: --new makes new one-time wallets for me, and if this computer has wallets from someone else's earlier run it moves them aside (nothing is deleted) instead of using them. If you are not allowed to run it, show me that exact command so I can run it myself by typing ! in front of it. 2) Show me the Stellar address and the minimum XLM it prints. 3) When I say I sent it, run `npx -y @a-identity/trust-mcp@0.4.5 status` every two minutes until its first line says Idle. 4) From then on, before any payment you make for me, run `npx -y @a-identity/trust-mcp@0.4.5 check <target> <amount in USD>` and do not pay if it says DENY. Decide on your own which targets to check, do not ask me, and do not check the same target twice. 5) When I say I am done, ask for my own Stellar address and run `npx -y @a-identity/trust-mcp@0.4.5 refund --to <my address>` until it says Done. Never print or ask for secret words or keys.

### One prompt for Claude Code (paying with ALGO and USDC)

Paste this into Claude Code. It asks before anything costs money.

> Help me check an Algorand address before I pay it, using A-Identity. Run every command yourself and never print or ask for any secret words. 1) Run `npx -y @a-identity/trust-mcp@0.4.5 wallet new` and show me the address it prints. 2) Tell me to send 0.3 ALGO (Algorand network) to it, then run `npx -y @a-identity/trust-mcp@0.4.5 wallet status` every 30 seconds until the ALGO arrives, and run `npx -y @a-identity/trust-mcp@0.4.5 wallet optin`. 3) Tell me to send 5 USDC (Algorand network) to the same address and wait the same way until it arrives. 4) Ask me which address or link to check and how much I am about to pay, then run `npx -y @a-identity/trust-mcp@0.4.5 check <that address> <that amount>` and explain the answer in plain words with the receipt link. 5) When I say I am done, ask for my own Algorand address and run `npx -y @a-identity/trust-mcp@0.4.5 wallet sweep <my address>` to send everything left back to me.

## Tools

| Tool | Price (USDC on Algorand) | What your agent gets |
| --- | --- | --- |
| `check_before_pay` | what its checks cost | Call it before every payment, with the target and the amount. An Algorand address or x402 seller gets `pay_check`; an agent gets `risk_check` sized to the amount, plus `agent_passport` above $100. One decision, ALLOW / WARN / DENY, the worst of its checks. |
| `check_batch` | what its checks cost | `check_before_pay` for up to 20 targets. A target named twice is checked once, at the larger amount. |
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

## Each check is paid for once

Every paid tool, and the `check` and `ask` commands, goes through one gate in the code, so no
prompt can get around it:

- Every answer is kept in `~/.a-identity/checks.json`. The same check of the same target is
  never paid for twice within 24 hours; asking again returns the saved answer for free, marked
  `"source": "cache"`. Two spellings of one target (`#849980` and `849980`) are one target. The
  24 hours can be made longer with `A_IDENTITY_CACHE_HOURS`, never shorter.
- A payment decision (`risk_check`) is sized to the deal, and the oracle can DENY above $100 an
  agent it allows below, so a payment of $100 or less and one above $100 are two different
  checks. Within each, the decision is bought once.
- A check is written down before anything is signed, and its payment id the moment it is
  signed. If a call stops halfway, or two calls (from the server and a command, say) ask for the
  same check at once, the second one finds it and does not pay; a signed payment that did not
  land blocks a repeat until it can no longer land (about 45 minutes).
- Before signing, the price has to fit what is left in the wallet. When the budget is spent, new
  checks are refused with nothing signed, and saved answers are still free.
- A loop guard stops every check for 10 minutes when more than 30 are asked for in a minute, or
  one target more than 5 times in 10 minutes. The agent gets an error saying why and when it
  resumes; nothing is asked of you.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `A_IDENTITY_ALGORAND_MNEMONIC` | unset | The paying account. It needs USDC (ASA 31566704, opted in) and no ALGO for fees. Unset: the one-time wallet `wallet new` or `buy` made, if any; otherwise saved answers are served and new checks return their price instead of paying. |
| `A_IDENTITY_MAX_USD_PER_CALL` | `10` | Any single call priced above this is refused before anything is signed. 10 covers every single-agent tool; a 50-agent audit is $200. |
| `A_IDENTITY_CACHE_HOURS` | `24` | How long an answer is kept and served instead of paying again. Values under 24 count as 24. |
| `A_IDENTITY_CHECKS_LEDGER` | `~/.a-identity/checks.json` | Where the answers are kept. |
| `A_IDENTITY_BASE_URL` | `https://a-identity.xyz` | The oracle origin, if you self-host. |
| `A_IDENTITY_ALGOD_URL` | public Nodely endpoint | algod override. |

## What happens when a tool is paid

1. The oracle answers 402 with the price.
2. If the price is within your cap and the wallet holds it, this server signs one USDC transfer of
   exactly that amount to the oracle, with fee zero, grouped with a fee-payer transaction the
   GoPlausible facilitator signs and pays for. Your key stays in this process.
3. The oracle produces the answer, submits the payment, reads the transfer back from the chain,
   and only then returns the answer. If it cannot produce the answer, it never submits the
   payment.

Built on [`@a-identity/trust-guard`](https://www.npmjs.com/package/@a-identity/trust-guard). Every
settlement is public at https://a-identity.xyz/api/x402/algorand/proof. Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

MIT
