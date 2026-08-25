# Design decisions the audit cannot make

Phase 4 fixed everything that could be fixed without touching the deployed contract. What
is left needs a decision rather than a patch, because **this contract has no upgrade path**.
There is no `update_current_contract_wasm` and no `initialize`, proven at bytecode level by
A7: the deployed wasm does not even import the host functions that would allow it. So every
item below costs a redeploy, and a redeploy costs a new contract id.

The audit protocol says not to improvise an architectural change. These are written up with
their trade-offs and stop here.

---

## What a redeploy actually costs

Measured by A7, not estimated.

| | |
| --- | --- |
| Network fees | about **12.34 XLM** (~2.41 USD) for freeze, withdraw, redeploy, repoint, re-arm |
| If the same wasm hash is reused | about **0.099 XLM** (the code entry is already uploaded and lives until ledger 66,177,015, around 2027-01-06) |
| New contract id | yes, unavoidable |
| Repoint surface | 4 files. `mcp/src/chains/registry.ts:126` is hardcoded with no env override |
| Provenance | a new `soroban/releases/` receipt, and the old address marked superseded rather than deleted |

The money is trivial. The real cost is the new address and, per **A7-01**, a policy that
has to be rebuilt by hand with nothing to rebuild it from.

---

## D-1. The permanent owner (A7-02 High, A1-01 Medium)

**The situation.** There is no `set_owner`. The owner chosen in the constructor is
permanent. Losing that key locks the vault balance forever; compromising it is total,
irreversible loss. The current pubnet owner is `GARC7OFB...QJ5R6I5`, a burner generated for
the deploy and held in a local CLI keystore. Not a multisig, not an HSM.

**The good news A7 found, which changes this from a redeploy question to a settings
question.** Per the pinned `soroban-env-host` 27.0.1 (`auth.rs:106-109`), a classic account
satisfies `require_auth` through *classic multisig authorization to its medium threshold*.
So the permanent owner G-address **can be made multisig with a plain `SetOptions`
operation**. No contract change. No redeploy. No new address.

The catch: it only works while the key is still held. It is a thing to do now or not at all.

**Options.**

| | What it means | Cost | Leaves |
| --- | --- | --- | --- |
| **A. Do nothing** | Burner key stays sole owner | 0 | Single point of total loss on a vault holding real USDC |
| **B. `SetOptions` the owner into a 2-of-3** | Add two signers, set medium threshold to 2 | one transaction, ~0.00001 XLM | Same contract, same address, no single key |
| **C. Redeploy with a multisig owner from the start** | New vault, owner is an already-multisig account | ~12.34 XLM + new id + policy rebuild | Cleanest story, highest disruption |
| **D. Accept, and cap the exposure** | Keep the burner, keep the balance at or near zero between demos | 0 | Honest, and matches what the vault holds today (0 USDC) |

### DONE, 2026-08-25: option B was taken

The owner account is now a **2-of-3 multisig**. Same account, same address, contract not
redeployed, wasm hash unchanged.

| | |
| --- | --- |
| Signers | the original owner key, plus `GCLZKYSS...K3DIFS` and `GDZQN2S2...QGDD75Q` |
| Thresholds | low 2, med 2, high 2 |
| Verified | one signature is now rejected with `txBadAuth`; two signatures calling `set_frozen(false)` on the vault landed at ledger 64,120,302 |

High threshold is 2 as well, deliberately: removing a signer needs two signatures, so one
stolen key cannot strip the others.

**One correction to what is written below.** This section said "close to free", which counted
the transaction fees and missed the reserve. Each extra signer raises the account's minimum
balance by 0.5 XLM, so 1 XLM is now locked that was previously spendable. The fees really
were negligible; the reserve was not, and the account had to be topped up before the change
would go through at all.

**Residual risk, and it is the maintainer's to close.** Three signers means losing any two
locks the account permanently. And all three keys are currently in the same local keystore,
which makes this change worth nothing against the threat it was made for: a laptop
compromise still takes all three. At least one key has to move somewhere else.

---

**Original recommendation, kept for the record: B, and it is close to free.** It removes the single point of failure
without a new address, without rebuilding the policy, and without touching the artifact
whose hash is published everywhere. D is a reasonable companion to B, not a substitute.

**Not recommended: C on its own.** Redeploying to solve only this trades a 0.00001 XLM
transaction for a new contract id and a hand-rebuilt allowlist.

---

## D-2. A redeploy silently drops the allowlist (A7-01 Medium)

**The situation.** The constructor takes five arguments and hardcodes `frozen = false`,
`allowlist_enabled = false` and `session_key_expiry = 0`. The allowlist itself lives in
`Allowed(Address)` persistent entries keyed to the contract id, so a redeploy loses all of
them. There is no view that enumerates the allowlist, and pubnet RPC event retention is only
about 7.9 days (measured: 120,959 ledgers), so after eight days there is no way to read back
what the old vault allowed.

**This is live on testnet today.** Its `allowlist_enabled` is `true`, diverged from the
release record by later legitimate traffic. A redeploy there right now would silently
re-open the policy.

**Options.**

| | What it means | Trade-off |
| --- | --- | --- |
| **A. Record the allowlist off-chain before any redeploy** | A pre-redeploy step that reads the `AllowlistSet` events and writes them into the release receipt | Free, works today, but relies on doing it within the 7.9-day event window |
| **B. Add an enumerating view** | `allowed_payees() -> Vec<Address>` | Needs a redeploy to add, and reintroduces an unbounded read the storage design deliberately avoids (INV-19) |
| **C. Take the allowlist as a constructor argument** | Redeploy carries it forward atomically | Needs a redeploy; bounds the constructor's input size |
| **D. Accept** | Document that a redeploy resets the policy and that re-arming is manual | Free, but the failure mode is silent, which is what makes it Medium |

**Recommendation: A now, and C bundled into any redeploy that happens for another reason.**
A is a runbook change and costs nothing. B contradicts a deliberate storage decision and
should not be adopted just to make C unnecessary.

---

## D-3. The refusal ladder's first rung differs by path (A3-02 Low, live defect)

**The situation.** `settle` checks the payee before the amount; `withdraw` checks the amount
before the payee. So `pay(vault, 0)` returns `InvalidPayee` (7) and `withdraw(vault, 0)`
returns `InvalidAmount` (6). Same two violations, same contract, two different answers.

This matters more here than it would elsewhere, because the typed refusal *is* the product:
a caller is meant to branch on the reason. It violates INV-17 and INV-22.

The failing test exists and is committed, `#[ignore]`d with the finding id in the attribute
so `cargo test` prints it on every run.

**Options.**

| | Trade-off |
| --- | --- |
| **A. Fix in the next redeploy** | Two lines reordered in `withdraw`. Free if a redeploy happens anyway |
| **B. Redeploy for this alone** | Not worth a new contract id for a Low |
| **C. Document the divergence** | Honest, cheap, leaves a wrong answer in production |

**Recommendation: A.** Hold it until a redeploy is happening for another reason, then take
it. It is genuinely two lines.

---

## D-4. `owner_pay` is charged to the cap but not limited by it (A5-01, A3-07 Low)

**The situation.** `check_owner_pay` runs the amount guard, the checked arithmetic and the
balance guard, and no cap comparison. The operator ladder has one; the owner ladder does
not. So `owner_pay` increments the day accumulator and is never bounded by it. A5 moved 51
times the cap in one UTC day this way, and the fuzzer found it independently.

**This is deliberate and matches Solidity.** The defect was in the invariant text and in the
provenance copy, both now corrected. Impact is Low because the owner already controls the
whole balance through an uncapped `withdraw`, so nothing escalates.

**But it is not Informational**, because the per-day cap is the product's central claim, and
"the human override bypasses the gates, not the budget" is a sentence this project published
and had to retract.

**Options.**

| | Trade-off |
| --- | --- |
| **A. Leave the contract, keep the corrected wording** | Free. The claim is now accurate: the cap binds the AGENT, not the human |
| **B. Add a cap gate to `owner_pay` in a future redeploy** | Makes the simpler sentence true again, but removes the override's usefulness in exactly the case it exists for: settling something out of band after the day's budget is spent |
| **C. Add a separate, higher owner ceiling** | More faithful to intent, more surface, more to explain |

**Recommendation: A.** B would break the override's purpose. The honest sentence is short:
the daily cap bounds the agent; the owner is bounded by the balance and by nothing else.

---

## D-5. Circle can freeze this vault, and no contract change can prevent it (A4-02 Medium)

**The situation.** Circle's pubnet USDC issuer has `auth_revocable = true`, verified on
chain. If Circle deauthorizes the vault's balance, `withdraw` stops working while
`balance()` keeps reporting the funds, because the SAC's balance read and its transfer
authorization are separate things.

**No contract change fixes this.** It is a property of the asset, not of the vault. Options
are about disclosure and asset choice, not code.

**Options.**

| | Trade-off |
| --- | --- |
| **A. Disclose it in the provenance caveats** | Free, honest, and it is currently NOT disclosed |
| **B. Use a non-revocable asset** | Would mean not using Circle USDC, which is the whole point of the rail |
| **C. Keep balances small** | Already the policy: 1 USDC daily cap, and the vault holds 0 today |

### DECLINED, 2026-08-25: option A was not taken

The maintainer decided not to publish the Circle freeze disclosure, and removed the
"What is not true here" box from `/proof/:rail` entirely at the same time.

Recorded here rather than dropped, because an accepted risk that nobody wrote down is
indistinguishable from one nobody noticed. The facts are unchanged: the pubnet USDC issuer
sets `auth_revocable`, Circle can deauthorize the vault's balance, and if it does then
`withdraw` stops working while `balance()` keeps reporting the funds. Option **C**, keeping
balances small, is in force and is what bounds the exposure.

The caveat data itself is not gone. `provenance.ts` still carries every caveat, every
response from `GET /api/proof/:rail` still includes them, and
`chains/provenance.test.ts` still fails the build if a chain publishes an empty or
throwaway caveat list. The limitations remain machine-readable and remain enforced; they
are no longer rendered on the page.

---

**Original recommendation, kept for the record: A plus C.** B is not a real option. A is a gap that should close regardless
of what is decided here: a reader of `/proof/stellar` is told the vault is bounded by its
policy and is not told the issuer can freeze it.

---

## Summary

| | Decision | Recommended | Needs redeploy |
| --- | --- | --- | --- |
| D-1 | Permanent owner | **B**, `SetOptions` to a 2-of-3, ~free | no |
| D-2 | Redeploy drops the allowlist | **A** now, **C** if redeploying anyway | partly |
| D-3 | Ladder order differs by path | **A**, bundle into the next redeploy | yes |
| D-4 | `owner_pay` not capped | **A**, keep the corrected wording | no |
| D-5 | Circle can freeze | **A + C**, disclose and stay small | no |

Three of the five need no redeploy at all. If a redeploy is ever done for another reason,
D-3 and D-2's constructor change are the two to carry with it.
