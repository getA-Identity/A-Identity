# Changelog

## 0.4.5 (2026-10-03)

In 0.4.4, `buy` spent the whole deposit on a fixed list of targets, round after round, until
less than 1 USDC was left. Most of those checks were repeats: one run of 30 checks was mostly
the same few targets, and the same 16 USDC group check came back three times with the same
answer. In 0.4.5 the agent chooses the targets, and nothing is paid for twice.

### Added

- `check_before_pay(target, amount)`, the MCP tool to call before every payment. It picks the
  checks for the amount: an Algorand address or x402 seller gets `pay_check`; an agent gets
  `risk_check` sized to the amount, plus `agent_passport` above $100. It returns one decision,
  ALLOW, WARN or DENY: the worst of its checks, and never ALLOW when a check could not run or its
  answer was lost.
- `check_batch([...])`, the same for up to 20 targets. A target named twice is checked once, at
  the larger amount.
- One gate in the code for every paid check: the MCP tools and the `check` and `ask` commands.
  - Answers are kept in `~/.a-identity/checks.json`. The same check of the same target is not
    paid for again within 24 hours; the saved answer comes back for free (`"source": "cache"`).
    `A_IDENTITY_CACHE_HOURS` can make that longer, never shorter, and
    `A_IDENTITY_CHECKS_LEDGER` moves the file.
  - A check is recorded before signing and its payment id at signing, under a file lock. A
    stopped call, two calls at once, or the server and a command at the same moment cannot pay
    for one check twice. A signed payment that did not land blocks a repeat until its last valid
    round has passed.
  - The price is compared with the wallet's USDC before signing. When the budget is spent, new
    checks are refused with nothing signed, and saved answers are still free.
  - A loop guard: more than 30 checks asked for in a minute, or one target more than 5 times in
    10 minutes, pauses every check for 10 minutes. The agent gets an error that says why and
    when it resumes; the user is not asked anything.
- `refund --to <STELLAR ADDRESS>`: what is left goes back as XLM. The Stellar wallet is merged
  into the address, and USDC and ALGO are exchanged back through SideShift. It also covers
  wallets an earlier run moved aside (`*.closed-*.json`). Amounts under SideShift's minimum are
  reported along with the command that returns them on Algorand. It refuses to run while an
  exchange is under way, and it resumes when run again.
- Server `instructions`, and wording in the tool descriptions, for the agent: call
  `check_before_pay` before paying, do not pay on DENY, do not check the same target again,
  decide without asking the user.

### Changed

- `buy` only exchanges. The XLM becomes USDC, and so does the spare ALGO, so the whole deposit
  can pay for checks. Then it stops, and the money waits in the wallet for the agent. It starts
  by saying what the money is for and how to get it back.
- `status` starts with one line: `Status: Running|Idle|Finished | Spent: .. USDC (n checks) |
  Left: .. USDC`. Checks bought by 0.4.4 still count in Spent.
- `check <TARGET> [AMOUNT]` takes an agent id as well as an address or seller link, and goes
  through the same gate as `check_before_pay`. `ask` goes through the gate too.
- The single tools (`pay_check`, `risk_check`, `verify_agent`, `reputation_score`,
  `agent_passport`, `agent_batch_audit`) are still there, through the same gate. Their answers
  now carry a `cache` field that says whether they were paid for or served from the ledger.

### Removed

- The fixed target list and the loop that spent the deposit on it.
- `buy --return`. Nothing is spent or sent back on its own any more; `buy --return` now stops
  and points to `refund --to`.

Earlier versions are described in the git history of this folder.
