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

## Deployed vaults and their live policy

Two instances of this contract are deployed. The table is a read of each contract's own view
functions on 2026-09-16, not a copy of what we meant to configure. The policy is fixed at
construction and there is no setter for the token or decimals, so the cap and ceiling below
change only if the owner calls `set_policy`, which would show up in the next read.

| Network | Contract | Token | Daily cap | Auto-approve max | Balance at read |
| --- | --- | --- | --- | --- | --- |
| pubnet (mainnet) | `CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP` | Circle USDC SAC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | 1 USDC (`10000000`, 7 decimals) | 0.25 USDC (`2500000`) | 0.04 USDC |
| testnet | `CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI` | Circle testnet USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | 10 USDC (`100000000`) | 2 USDC (`20000000`) | 13.988 USDC |

The pubnet vault is dust on purpose, an order of magnitude under the testnet one, because
the caps are the product and the balance is not. That also means it runs dry: every payment
in its release record spent the dust it was funded with, and the same read on 2026-09-16
found it at 0 before it was refilled with 0.04 USDC (transaction
`c91aaa824b84ee33a8b328514fcb415554626d824e443a2c338e318c99e4042c`, ledger 64458213). A
vault with nothing in it still enforces its policy, but "holds USDC" is a claim about the
balance, so the balance is what gets checked.

Read it yourself, free, with no key (the script prints the live policy and balance and, without
`--key-env`, only the transfer it would make):

```bash
cd mcp && npm run build
node scripts/stellar-vault-fund.mjs --chain stellar --vault CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP --amount 0.01
```

Or straight against the contract with the Stellar CLI, where each view call is a simulation
and costs nothing: `stellar contract invoke --id CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP --network pubnet -- daily_cap`
(and `auto_approve_max`, `balance`, `spent_today`, `token`).

**What proves the cap binds.** On pubnet the refusals are typed contract errors with no
transaction hash, because Soroban clients simulate first and a refused payment never reaches
the ledger: `DailyCapExceeded` (code 5) with `spent_today` at 0.95 against the 1 USDC cap, and
`AboveAutoApprove` (code 4) for a 0.50 payment, both recorded in
[`releases/pubnet-v0.1.0.json`](releases/pubnet-v0.1.0.json) and reproducible by anyone with
the command in that record. On testnet one refusal was forced onto the ledger for a reviewer
to open: transaction `12df418f21d329f606f412b1aee498714f1178d68fd0db0a97c64f0de6f209d3`, which Horizon reports as `successful: false` with its fee
charged, produced by `mcp/scripts/stellar-prove-revert.mjs`. It is a deliberately failed
transaction, and that is the point of it.

## Operations calendar

The section above explains why the instance TTL cannot be topped up early. This one is the
consequence: there is a date, it is months out, and the only thing to do before it arrives
is be told when it arrives.

Read live on 2026-09-15 with `node ../mcp/scripts/stellar-vault-archival.mjs`:

| Network | Vault | Live until ledger | Remaining | Archives around |
| --- | --- | --- | --- | --- |
| pubnet | `CB5LYXFK...KWSYP` | 66,177,017 | about 113.6 days | 2027-01-06 |
| testnet | `CAIL6ECR...B4UI` | 6,739,602 | about 134.0 days | 2027-01-27 |

**The pubnet action window opens in early November 2026.** A write extends the clock only
once the remaining life has fallen below the contract's 60-day `LONG_TTL_THRESHOLD`, so the
first useful moment is when 113.6 days becomes 60, which is about 54 days after the read
above. Acting in October buys nothing at all: the call succeeds, costs a fee, and `live
until` does not move. That is not a theory, it is what happened on 2026-08-25.

**The cheapest deliberate touch is `set_frozen(false)` on a vault that is already
unfrozen.** It changes no state, it costs a fee, and on pubnet it needs two of the owner
account's three signers because D-1 made that account a 2-of-3 multisig. Any writing
entrypoint would do; this one is chosen because it cannot move money even if it is sent
twice.

**The reminder is a weekly job, not a calendar entry.** `.github/workflows/stellar-ops.yml`
runs Mondays at 06:17 UTC and calls the archival script with `--warn-days 45`. Forty-five is
deliberate rather than round: the re-extension window opens at 60 days, so the first red run
is already about fifteen days inside the window where a touch actually works. The failure
mail is the notification. There is no earlier action to take, which is precisely why a job
that warns too early would be worse than no job.

**Testnet's numbers are a rehearsal.** Stellar testnet is reset periodically, and a reset
takes the vault, its balance and its allowlist with it. The testnet row above stops being
true the moment that happens, and the correct response is to redeploy there rather than to
worry about its TTL.

## Redeploy runbook

This contract has no upgrade path. `withdraw`, redeploy, repoint is the escape hatch, and it
produces a new contract id every time. Two open audit findings are cheap only if they ride
along with a redeploy that is happening anyway, so they are steps here rather than tickets:
A3-02 (decision D-3) and A7-01 (decision D-2).

Read `../audit/DESIGN-DECISIONS.md` before starting. The order below is not arbitrary: the
snapshot has to happen while the OLD vault is still readable, and the balance has to leave
before the address stops being the one anybody watches.

1. **Freeze the old vault.** `set_frozen(true)`. Finding A7-03 is that the documented
   recovery runbook used to omit this step. It stops the agent path from settling into a
   vault that is about to be abandoned.
2. **Snapshot the allowlist.** `node ../mcp/scripts/stellar-vault-allowlist.mjs`, then
   `--check` to confirm the committed file matches the chain, and commit the result. This is
   D-2 option A and it is the whole reason the snapshot exists: the allowlist lives in
   entries keyed to the contract id, no view enumerates it, and the `AllowlistSet` events
   that armed it expire out of RPC retention after about 7.9 days. Read the `note` field in
   the file it writes before trusting it. The snapshot is a lower bound, built by probing
   named candidates, and a payee nobody named is not in it.
3. **Withdraw the balance** to the owner account, and read the balance back as zero.
4. **Instantiate against the code entry that is already uploaded.** The wasm hash
   `155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239` is live on both
   networks and its code entry lives until ledger 66,177,015, around 2027-01-06.
   Instantiating on top of it cost 0.0992122 XLM on pubnet; uploading the same 11,625 bytes
   fresh cost 12.2319214 XLM. Pass the SAME constructor policy as the record in `releases/`,
   because those five arguments are permanent and there is no `initialize` to correct them.
   A source change means a new hash and the 12 XLM upload, so step 7 is what makes this
   step expensive.
5. **Repoint.** `mcp/src/chains/registry.ts` `contracts.spendVault` and
   `contracts.spendVaultWasmHash`, `mcp/src/chains/provenance.ts`, and a new receipt in
   `releases/` that marks the old address superseded rather than deleting it.
6. **Re-arm the allowlist from the snapshot,** one `set_allowed(payee, true)` per entry,
   then `set_policy(..., allowlist_enabled)` to match what the snapshot recorded. Re-run the
   snapshot script against the NEW contract and confirm `--check` passes. Getting this wrong
   is silent: an unarmed allowlist on a vault whose `allowlist_enabled` is false does not
   refuse anything, it permits everything.
7. **Carry A3-02 in the same commit.** In `src/lib.rs`, `withdraw` runs
   `policy::check_amount` before `require_valid_payee`; `settle` runs them the other way
   round. Swap those two lines in `withdraw` so both money paths name the same first reason
   for the same pair of violations, then un-ignore
   `a_doubly_invalid_input_names_the_same_first_reason_on_every_money_path` in
   `src/test/arithmetic.rs`, rebuild with `stellar contract build`, and re-record
   `LINUX_X64` in `.github/workflows/soroban.yml`. That literal is the hash the CI runner
   produces from the source, so a source change is supposed to move it; leaving it stale
   turns the drift gate red for the right reason and the wrong commit.

   Do NOT un-ignore the other `#[ignore]`d test in that file. It asserts INV-05 as it was
   originally written, that `pay` plus `owner_pay` stays under the daily cap, and decision
   D-4 chose to keep the contract as it is and keep the corrected wording instead. That
   assertion is false by design, so un-ignoring it would make `cargo test` red permanently.
   What it needs is its reason string updated to say the decision is made rather than
   pending.
8. **A4-01 rides along or it does not ship.** The token's error codes collide with this
   contract's, so a caller cannot tell an `Error(Contract, #13)` raised by the SAC from one
   of ours. Moving this contract's discriminants clear of the SAC range is a redeploy-only
   change with no cheaper carrier, and it is an ABI break: the codes are public and frozen
   by `test/errors.rs`. It needs its own line in `../audit/DESIGN-DECISIONS.md` recording
   the new range and what reads it, and it must not be improvised during the redeploy.

Then re-run the verification the rest of this README describes, and rehearse the whole
sequence on testnet first. Rehearsing it is free and finding A7-03 is that it never has
been.

## Key roles

Three roles per network, and they are meant to be three different keys.

| Role | Can do | Read from |
| --- | --- | --- |
| owner | withdraw the whole balance, set the policy, freeze. Permanent, there is no `set_owner` | `vault.owner()` |
| operator | spend inside the policy and only inside it | `vault.operator()` |
| x402 fee payer | sign and pay for the broadcast. No vault authority at all | `/api/x402/stellar/status` |

```bash
node ../mcp/scripts/stellar-key-roles.mjs            # reports, exits 0 on a known warning
node ../mcp/scripts/stellar-key-roles.mjs --strict   # a warning exits 1
```

It reads the vault roles off the ledger by simulation and the rail roles from the backend's
public status endpoints, which publish account ids and environment variable NAMES and never
a secret. It reads no key material and prints none.

**The overlap it reports today is on testnet only.** A fee payer is hot on Render, signs on
every sale, and its whole job is to hold a couple of XLM; an operator can spend the vault's
daily budget. Those are different threat models, so one key should not do both jobs. On
testnet it still does (`GDZXSO4A...` is both the x402 fee payer and the vault operator), and
the script reports that as a warning rather than a failure, because it is test money and the
operator's blast radius is bounded by the daily cap, which is what the cap is for. The
script exits 1 only if the fee payer ever becomes the vault OWNER, which would put the entire
balance behind a server key.

**Pubnet was split on 2026-09-15.** The dedicated fee payer that sat unfunded in the
maintainer's local CLI keystore under the alias `aid-pubnet-x402-fee`, public key
`GAFVDEN6BC52WWPRPINOVENMXW3FU4LCSVVVA5C67RLPG4GAK6BE4SXY`, was funded with 3 XLM and set as
`X402_STELLAR_PUBNET_FEE_PAYER` on Render, and the next production sale,
`43a97d67dad5f90a4c8dff703fb07bd9b5f17503201ffb37d5168b08bd12b2b4` at ledger 64432240, was
broadcast from it. On mainnet the vault operator key is out of the fee-paying business.

`payTo` being the vault owner on pubnet is reported as INFO and is not a problem: that is
where sales are meant to land.
