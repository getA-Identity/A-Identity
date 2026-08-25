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

- **Negative amounts.** `uint256` made them unrepresentable; `i128` does not. An earlier
  version of this note said an unguarded negative amount would be *added* to the day
  accumulator, taking the running total down and handing the agent its cap back, a silent
  cap bypass. That was wrong, and an adversarial review caught it: the SAC validates the
  sign itself in `check_nonnegative_amount`, the panic aborts the invocation, and Soroban
  rolls back every state change including the accumulator write. There was never a
  persistent bypass. The guard still earns its place, for two reasons that hold. Without
  it the refusal arrives as an untyped host trap out of the token and the client cannot
  name it, where `InvalidAmount` is a reason the human-in-the-loop path can act on. And it
  does not rest on the token validating its own inputs, which is not a property a vault's
  safety should depend on. The class is genuinely new against Solidity; only the mechanism
  was misdescribed. See `src/policy.rs`.
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

Coverage is 99.70% of lines and 98.18% of functions with the test files excluded, measured
with `cargo llvm-cov --ignore-filename-regex 'src/test'` and archived at
`audit/tool-output/P5-llvm-cov.txt` rather than only asserted here. The single uncovered
line is `storage.rs:110`, the `#[contracttype]` macro on `DataKey`. `cargo mutants` leaves **zero** survivors out of 137.
Both numbers are worth stating together, because the first one alone is the one that lies:
the suite was at 93% lines while 22 mutants still survived, including two that disabled the
TTL guards outright.

```bash
cargo test                                   # 106 contract tests (2 ignored, see below)
cargo clippy --all-targets -- -D warnings
cargo fmt --check
stellar contract build                       # -> target/wasm32v1-none/release/*.wasm
node audit/run-negative-controls.mjs         # each guard deleted, suite must go red
```

Two of the 106 are `#[ignore]`d on purpose, and the reason is in the attribute rather than
in a comment somewhere else. They encode findings A3-02 and A3-07 from the 2026-08-25 audit:
the refusal ladder's first rung differs between `settle` and `withdraw`, and `owner_pay` is
charged to the daily cap without being limited by it. Both are live in the deployed wasm and
both need a contract change, which this contract cannot take without a redeploy. They are
kept failing-and-ignored rather than deleted, because a deleted test is a decision nobody
can see. Un-ignore them in the commit that redeploys.

`.github/workflows/soroban.yml` runs all of it plus two advisory checks and a 128KB size
gate, scoped to `soroban/**` so a frontend commit does not pay for a Rust toolchain. The
second advisory check exists because the first one is blind to this ecosystem: `cargo audit`
reads RustSec, and RustSec has never carried a single Stellar advisory.

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

## The vaults archive on a date, and it is checkable

Audit finding A2-04. A contract's instance entry carries every field this vault reads on
every call, and it has a TTL. `bump_instance` extends it, but only on writing entrypoints
and on none of the thirteen views. So a vault that is deployed, funded and then left alone
drifts toward archival on a timer, and the pubnet vault is in exactly that state today: the
x402 rail still sells on testnet, so nothing writes to it.

Read on chain 2026-08-25:

| Network | Live until ledger | Remaining | Archives around |
| --- | --- | --- | --- |
| pubnet | 66,177,017 | about 134 days | 2027-01-06 |
| testnet | 6,739,602 | about 157 days | 2027-01-29 |

```bash
node ../mcp/scripts/stellar-vault-archival.mjs                  # both networks
node ../mcp/scripts/stellar-vault-archival.mjs --warn-days 30   # exits 1 when closer
```

Archival is not a brick, and the distinction is the whole reason this is a note rather than
a Critical. An archived Persistent or Instance entry is restored WITH ITS VALUE: proven by
test in `src/test/durability.rs`, and done on chain by CAP-0066 since protocol 23. The four
`unwrap()`s in `storage.rs` are unreachable this way. What archival costs is rent plus a
restoring footprint on the next call, and an operator who did not know it was coming.

The asymmetry worth remembering: a TEMPORARY entry, which is what the day bucket is, is
deleted permanently rather than archived. Only persistent and instance entries come back.

A write extends the clock, but ONLY once the remaining life has fallen below the 60-day
threshold, and that catch is worth knowing before you rely on it. `bump_instance` calls
`extend_ttl(LONG_TTL_THRESHOLD, LONG_TTL_EXTEND)`, which is a no-op while the current TTL is
still above the threshold. Demonstrated on 2026-08-25: a real `set_frozen(false)` landed on
the pubnet vault at ledger 64,120,302 and `live until` did not move, because 134 days
remained against a 60-day threshold.

So you cannot top this up early. Touching the vault in month two buys nothing; touching it
inside the last 60 days sets it to the 150-day floor. Finding A2-03 explains the related
oddity that the entry never receives that 150-day floor in the first place on pubnet: it is
created with the network's own `min_persistent_ttl` of 2,073,600 ledgers, about 135 days,
which is already above the threshold, so the code's floor does not apply until the entry has
aged into range.

When the time does come, `set_frozen(false)` on a vault that is already unfrozen is the
cheapest deliberate touch: it changes nothing and costs a fee.

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
