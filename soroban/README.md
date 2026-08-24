# soroban

The Rust half of A-Identity. One contract today: `AgentSpendPolicy`, the Soroban port of
[`mcp/contracts/AgentSpendPolicy.sol`](../mcp/contracts/AgentSpendPolicy.sol).

A workspace sibling of `mcp/` rather than a directory inside it, following the precedent
`sdk/`, `trust-guard/` and `agents/` already set. `mcp/` is an npm package installed with
`npm install --prefix mcp`, and a Cargo workspace inside it would muddy both toolchains.

## What the contract is

A vault that custodies a SEP-41 token for an AI agent and enforces the agent's spend
policy **on the ledger**: a per-UTC-day cap, a per-payment auto-approve ceiling, a payee
allowlist, a freeze switch, and a time-bounded session key. Two roles. The human `owner`
sets the policy, freezes, settles an above-ceiling payment out of band, and withdraws. The
agent `operator` may only call `pay`, and only inside the policy. Anything outside it
reverts with a typed error.

Behaviour is deliberately identical to the Solidity original, down to the order the gates
fire and the meaning of a zero (0 cap, 0 ceiling and 0 expiry all mean "no bound"),
because the console and the spend-preflight API already assume all of it.

## The one line this rests on

On EVM a payment has two independent guards: `msg.sender` is supplied by the chain and
cannot be forged, and the token's allowance accounting sits underneath. Neither exists
here. `pay` moves the vault's **own** balance, so the token's `from`-side authorization is
satisfied structurally by Soroban's direct-call rule, and Soroban has no `msg.sender` at
all. The entire authorization surface collapses onto `operator.require_auth()`.

Without that line every policy gate still passes and every amount is still checked. The
vault is simply drainable by anyone, because a cap says how much may move and never who
may move it.

And the usual Soroban test harness hides exactly that: `mock_all_auths()` makes a suite
pass identically against a contract with the guard deleted. So the suite never mocks by
default, and `audit/run-negative-controls.mjs` deletes each guard in turn and **requires
the suite to go red**. A green suite says the contract passes its tests; only that runner
says the tests would notice if the contract stopped being safe.

## Two bug classes with no Solidity counterpart

- **Negative amounts.** `uint256` made them unrepresentable; `i128` does not. An unguarded
  negative amount is not merely a bad transfer, it is *added* to the day accumulator,
  taking the running total down and handing the agent its cap back. A silent cap bypass.
- **Self-payment.** Paying the vault or the token contract moves nothing while still
  consuming the day's budget, so a compromised operator could burn the whole cap at zero
  cost every day and deny the legitimate agent indefinitely.

## Storage, and why the day bucket is temporary

The whole instance map is a **single ledger entry**, read by every entrypoint. A
`SpentOnDay(day)` key written once per day and never removed would grow it until every
entrypoint bricks, `withdraw` included: a vault holding a stranger's money, unspendable on
a timer. That is the instance-storage-exhaustion class from published Soroban audits, and
`src/test/storage_shape.rs` rules it out with assertions rather than a comment.

Persistent was rejected too: an archived bucket aborts with an opaque host error instead
of a typed policy error, and the typed reason IS the product. Temporary means expired
reads as zero, which is the right answer for a past day. The audit trail lives in the
`Paid` event, which is permanent and carries the counterparty, which a running total never
could.

TTL floors come from pubnet's own settings read live, not from a doc: `max_entry_ttl`
3,110,400, `min_persistent_ttl` 2,073,600, `min_temporary_ttl` 17,280. Note what the last
one means: the network's minimum covers a day bucket's own day only just, so every write
extends to a two-day floor.

## Versions

Both networks were probed directly on 2026-08-15 and both run **protocol 27**
(`releases/protocol-verification-2026-08-15.json` has the raw `getVersionInfo`). The docs
version table showing protocol 25 is stale. `soroban-sdk` is therefore pinned to
`=27.0.6`, exactly, with no caret: a drifting or stale SDK pin is itself a published
Soroban audit finding.

Target is `wasm32v1-none`. Some documentation still says `wasm32-unknown-unknown`; that is
wrong for this platform.

## Build and test

```bash
cargo test                                   # 52 contract tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
stellar contract build                       # -> target/wasm32v1-none/release/*.wasm
node audit/run-negative-controls.mjs         # each guard deleted, suite must go red
```

`.github/workflows/soroban.yml` runs all of it plus `cargo audit` and a 128KB size gate,
scoped to `soroban/**` so a frontend commit does not pay for a Rust toolchain.

The Instawards SoW asks for a tests-passed screenshot, and a picture of green text is both
trivial to fake and impossible to re-check, so we do not take one. `node
scripts/gen-stellar-tests-image.mjs` (from the repo root) runs the suites above plus the
Stellar rail tests, refuses to write anything if one of them is not green, and renders
`docs/images/stellar-tests-passed.png` out of their own stdout, with the commit, the
toolchain versions and the contract id read from the repo. Rename a test and the picture
says the new name.

**The Rust count lives here and nowhere else.** `mcp/src/doc-counts.test.ts` matches the
phrase `N unit tests` across five repo documents and counts `test()` declarations under
`mcp/src/**/*.test.ts`. Writing "N unit tests" about this suite in any of those files would
make the two disagree permanently. Say "contract tests" and keep the number here.

## What is deliberately absent

- **No `upgrade` entrypoint.** It is a second total-authority door and it makes the
  admin-centralization finding worse, which is the wrong trade for a contract whose whole
  claim is bounded authority. The escape hatch is the one that already exists: `withdraw`,
  redeploy, repoint.
- **No `initialize`.** `__constructor` is atomic at deploy, so the front-run-the-
  initializer class is structurally absent rather than merely tested against. Note the
  corollary: a contract deployed without a constructor can never gain one, so the
  constructor's shape has to be right before the first mainnet deploy.
- **No committed wasm.** Rust wasm builds are not bit-reproducible across machines by
  default, so committing one would invite a reproducibility claim we cannot honor. What is
  committed instead is a receipt in `releases/`, and anyone can pull the deployed bytes
  themselves with `stellar contract fetch --id C... --out-file`.

## Forward compatibility

`operator` is a plain `Address`, and in Soroban an `Address` is either an account or a
contract, with `require_auth()` dispatching to `__check_auth` when it is a contract. So
`set_operator(C...)` retargets the vault at a passkey smart account or an OpenZeppelin
policy account later with **zero contract changes**. Not built now, because custom auth is
where Soroban audits find criticals and this contract's security thesis is that the
authorization surface is one line.

One property worth stating: because `pay` moves the vault's own balance, the operator
never holds the token and never needs a trustline. It needs XLM for fees, or a sponsor.
That is a smaller blast radius than the EVM version has.
