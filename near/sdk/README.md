# A-Identity NEAR SDK and verdict engine

Before an AI agent pays, this SDK computes a deterministic ALLOW, WARN or DENY verdict on the
payee from public NEAR chain data. Then it hands the payment to the agent's spend vault, which
has the final word on chain: `pay` on ALLOW, `request_payment` (held for the owner) on WARN,
`record_refusal` on DENY. Every verdict is pinned to one block, and anyone can recompute it from
a saved snapshot with no network, or from archival RPC at the same block, on testnet and on
mainnet alike.

Status: NEAR testnet for writes; mainnet is read only, for real-data signals. Unaudited. No
LLM sits in the verdict path; the engine is a pure function.

## Evaluate in two minutes

No keys and no account are needed. `npm ci` downloads the packages; after it, the typecheck, the
tests and the `--offline` replay use no network at all. The last four commands read NEAR RPC and
the indexers (read only).

```
cd near && npm ci
npm run typecheck
npm run test:sdk          # 239 tests, offline, under a second
npm run verdict -- --offline sdk/test/fixtures/snapshot-merchant.testnet.json
npm run verdict -- aid-demo-merchant.testnet
npm run verdict -- aid-demo-rnerchant.testnet --known aid-demo-merchant.testnet
npm run verdict -- wrap.near --network mainnet
npm run guard -- --vault vault.aid-demo-owner.testnet --payee aid-demo-rnerchant.testnet --amount 0.25 --known aid-demo-merchant.testnet
```

What to look for in the output. The `--offline` row is fixed forever (a committed snapshot);
the live rows depend on the chain on the day you run them, and say what changes them:

| Command | Expected |
| --- | --- |
| `--offline` replay | `verdict WARN score 440`, `new_account`, `low_activity`, `snapshot sha256 70e404a9...`, `chain sha256 3782912b...`. Same verdict and digests on every machine, on any day |
| `aid-demo-merchant.testnet` | On 2026-11-12: `WARN` (soft), `new_account` and `low_activity` (created 2026-11-11T23:46:57Z, 1 transaction). `new_account` stops firing 72 h after creation (from 2026-11-14T23:46:57Z); `low_activity` keeps it WARN while it has fewer than 5 transactions. Once the vault has paid it (`prior_payments`) or the registry says ALLOW (`registry_allow`), it is ALLOW |
| `aid-demo-rnerchant.testnet` | `DENY`: `lookalike_new_account` ("rn" reads as "m"), plus `account_not_found` while that name is unregistered |
| `wrap.near --network mainnet` | `ALLOW`: `long_history`, `locked_contract` (no full-access key) |
| `guard` with no key | `DENY -> record_refusal prepared (not sent)`, then the exact `receiverId` and `actions` an agent key would sign. Until the demo vault is deployed it also lists `vault_unreadable` |

`registry_not_deployed` (info) appears until `registry.a-identity.testnet` is deployed; after
that, the registry's own answer for the payee is read instead.

`npm run verdict -- <account> --json` prints one JSON object. `--save-snapshot file` writes the
snapshot. `--at-block N` pins every read to block N.

## How a verdict is made

```
collect (sdk/src/collect)    one Snapshot: every JSON-RPC request and answer, pinned to block N,
                             plus indexer answers recorded verbatim
normalize (engine)           Snapshot -> Signals; missing data becomes an explicit "unavailable"
decide (engine)              Signals -> {verdict, reasons[{code, severity, detail, source}],
                             score 0..1000, engine_version, policy_id}
```

`sdk/src/engine/` has no dependencies and does no I/O. It reads no clock, no network and no
disk, and it uses its own SHA-256, so it runs unchanged in Node, in a browser or in a judge
script. All time arithmetic is relative to the pinned block's timestamp.

### Recompute a verdict yourself

1. **From the snapshot, offline.** `npm run verdict -- --offline <file>` gives the same verdict,
   reasons, score and `snapshot_sha256`, with no network. In code:
   `verdictFromSnapshot(assertSnapshot(json))`. `assertSnapshot` checks the snapshot before it is
   used: the recorded block answer must be the pinned block (height, hash and timestamp, since
   every time line is drawn from that timestamp), every read must be pinned to that block (the
   archival probes to an earlier one, and their key lists to exactly the probe block), and every
   answer from the other network must be pinned to the block recorded for it.
2. **From the chain.** `npm run verdict -- <account> --at-block <N>` re-sends the same requests
   to RPC (archival where needed) and prints the same `chain_sha256`. Every height a snapshot
   reads at follows from block N alone: the probe blocks are found by timestamp from N, and for
   a mainnet payee, MimicWatch's testnet registry is read at the latest testnet block at or
   before N's timestamp (recorded as `block.testnet`, with its direct successor as
   `block.testnet.next` to show it is the latest). Checked on 2026-11-12:
   `aid-demo-merchant.testnet` at block 277300516 gave `chain_sha256 3782912b...` live and when
   re-collected later; `wrap.near` (mainnet) at block 224154515 gave `292a15b0...` in two
   collections, and at block 224157796 the same digest live and re-collected 20 s later.

There are two digests because the two kinds of evidence differ:

- `chain_sha256` covers only the block-pinned JSON-RPC requests and their answers (an error is
  reduced to its name, cause and kind). Archival nodes return the same answers forever, so anyone
  can reproduce this digest from the chain alone.
- `snapshot_sha256` covers the whole artifact, minus `meta`. That includes the indexer answers,
  which are not consensus data and carry their fetch time. It identifies the exact evidence an
  oracle used; `formatEvidence()` turns it into the registry's 256-byte `evidence` field.

## Decision table

A verdict is DENY if any deny rule fires, WARN if any warning fires and is not cleared, and
ALLOW otherwise. No positive signal overrides a DENY. Missing data is WARN and is never cleared,
following the repository's honest-status rule. A WARN is "soft" when every deciding warning only
says that nobody has history with this payee yet. The full table is `RULES` in
`sdk/src/engine/rules.ts`.

| Code | Effect | Fires when | Cleared by |
| --- | --- | --- | --- |
| `account_not_found` | DENY | a named account does not exist at the block; tokens sent there belong to whoever registers the name first | never |
| `usdc_blocklisted` | DENY | Circle's USDC `is_blocklisted` is true | never |
| `registry_deny` | DENY | A-Identity's registry says DENY | never |
| `lookalike_new_account` | DENY | the payee imitates a known payee's own name (a strong match) AND is under 72 h old (or does not exist yet) | never |
| `registry_warn` | WARN | the registry says WARN | never |
| `code_changed_since_verdict` | WARN | the registry's verdict was written for a different code hash | never |
| `code_changed_recently` | WARN | the contract's code hash 72 h ago differs from now | never |
| `global_contract_mutable` | WARN | the account runs a global contract referenced by account id (it can change without a deploy) | never |
| `new_full_access_key` | WARN | a full-access key exists now that did not exist 72 h ago on an older account | never |
| `prior_registry_refusals` | WARN | this vault refused the payee on a registry DENY that no longer stands | `registry_allow` |
| `open_reports` | WARN | the registry holds reports the oracle has not reviewed | an ALLOW written after the newest report |
| `third_party_flag` | WARN | another team's public registry flags the payee (attributed, never DENY alone) | `registry_allow` |
| `lookalike_known` | WARN | the payee imitates a known payee but is not new, or shares only a sub-account role label with one, whatever its age (`agent.bob.testnet` vs `agent.alice.testnet`) | `registry_allow`, `prior_payments`, `owner_allowlisted` |
| `new_account` (soft) | WARN | under 72 h old | same three |
| `low_activity` (soft) | WARN | fewer than 5 transactions at or before the block | same three |
| `implicit_unfunded` (soft) | WARN | an implicit account that was never funded | same three |
| `rpc_unavailable`, `indexer_unavailable`, `registry_unreadable`, `blocklist_unreadable`, `vault_unreadable` | WARN | a required source could not be read | never |
| `registry_allow`, `prior_payments`, `owner_allowlisted`, `long_history`, `erc8004_identity`, `erc8004_reputation` | positive | as named | |
| `known_payee`, `contract_account`, `locked_contract`, `usdc_unregistered`, `guard_refusals`, `erc8004_low_reputation`, `registry_not_deployed`, `third_party_unreadable`, `erc8004_unreadable` | info | as named; never decide | |

Reason codes follow the registry's own rule (1 to 32 bytes of `[a-z0-9_]`), so an oracle writes
them as they are: `registryReasons(decision)` gives the deciding codes, at most 8.

**Score.** The score runs from 0 to 1000, and higher is more trustworthy. It starts at 600,
loses 400 per deny, 120 per hard warning, 80 per soft warning and 20 per cleared warning, gains
the weight of each positive, and is then clamped into the verdict's band: DENY 0..199, WARN
200..499, ALLOW 500..1000. These are A-Identity's bands on other chains (`mcp/src/commerce.ts`).
The score orders payees inside a band and never decides the verdict.

## Signals and data sources

Every read below is a view or an index query. Nothing is signed or sent.

| Signal | Source and exact call | Pinned to the block |
| --- | --- | --- |
| Existence, code hash, global contract | JSON-RPC `query view_account {account_id, block_id: N}` | yes |
| Full-access and function-call keys | `query view_access_key_list {account_id, block_id: N, limit: 100, after_key}`, paged (nearcore refuses an unpaged list over 100 keys) | yes |
| Age (72 h line) | archival `view_account` at the latest block that is at least 72 h before N, found by timestamp | yes |
| Long history (30 d line) | the same at the 30-day block | yes |
| Key added in the last 72 h | the full-access keys at N minus those in `view_access_key_list` at the 72 h block | yes |
| Code changed in the last 72 h | the `code_hash` at N against the `code_hash` at the 72 h block | yes |
| USDC blocklist and registration | Circle USDC `is_blocklisted {account_id}`, `storage_balance_of {account_id}` (testnet `3e2210e1...afcb8af`, mainnet `17208628...36133a1`) | yes |
| A-Identity verdict, reports | registry `get_verdict`, `get_reports`, `report_count`, `list_verdicts` (live ALLOW entries join the known set) | yes |
| Prior payments, refusals, allowlist | vault `paid_count`, `refusal_count`, `guard_refusal_count` (info only), `is_allowed`, `list_allowlist` | yes |
| ERC-8004 identity and reputation | Arras's registries: `nft_tokens_for_owner`, `get_clients`, `get_summary` on `identity-registry.erc-8004.{testnet,near}` and `reputation-registry.erc-8004.{testnet,near}` | yes |
| Other teams' flags | MimicWatch `is_flagged {id}` (`registry.mimicwatch-e7iig5g5.testnet`), Tripwire `get_risk` (`tripwire-registry-44ea74.testnet`), near-leash `verdict` (`leash-registry.testnet`), Leash commons `get_status` (`registry.leash-busel-commons.testnet`). Method names were checked against each contract's embedded ABI on 2026-11-12. For a mainnet payee, MimicWatch's testnet registry is read at the latest testnet block at or before the mainnet block's timestamp | yes |
| Activity, first transaction | FastNEAR `POST https://tx.test.fastnear.com/v0/account {account_id, limit: 5, desc: false}` (tx.main for mainnet): the account's OLDEST transactions, counted at or below height N, so the answer never changes later | bounded by N |
| Fallbacks and deployments | NearBlocks v3 `/v3/accounts/{id}`, `/txns?limit=5&order=asc`, `/contract/deployments`. Powered by Nearblocks.io APIs | bounded by N |

RPC hosts, in failover order. Testnet: `rpc.testnet.fastnear.com`, `near-testnet.drpc.org`;
archival `archival-rpc.testnet.fastnear.com`, then `archival-rpc.testnet.near.org` as a last
resort. Mainnet: `rpc.mainnet.fastnear.com`, `near.drpc.org`, `free.rpc.fastnear.com`; archival
`archival-rpc.mainnet.fastnear.com`, then `archival-rpc.mainnet.near.org`. Only the
`EXPERIMENTAL_` method names are used, because dRPC rejects the new ones. The optional
`FASTNEAR_API_KEY` and `NEARBLOCKS_API_KEY` environment variables are sent only to their own
hosts and are never recorded or printed.

## Thresholds, and why

All of these live in `sdk/src/engine/policy.ts`, each with its reason in a comment.

- **72 hours** (new account, new full-access key, recent code change). Drainer and impersonation
  accounts are usually created minutes to hours before use; address poisoning plants its
  lookalike right after a test transfer. 72 h covers a weekend, so the owner and the shared
  registries have had a chance to see the account. A legitimate new merchant waits only for its
  first payment.
- **30 days** (long history, positive only). Burner accounts rarely live this long before use. Age
  never clears a flag, a report or a code change.
- **5 transactions** (low activity, soft). Setting up an account by hand (create, fund, add a
  key, register a token) already takes 3 or 4.
- **Probe tolerance, 10 minutes.** The archival probe block must lie between 72 h and 72 h
  10 min before the pinned block. The engine checks this instead of trusting the snapshot, so the
  line is never drawn in the payee's favour.
- **Lookalikes.** Names under 5 characters match only on an identical skeleton ("bob" and "rob"
  are different names). One edit is allowed for names up to 8 characters and two from 9 on;
  typosquatting studies find most squats at Damerau-Levenshtein distance 1. Affixes of up to 8
  characters are matched around a known name of at least 5 characters. Implicit accounts match
  when they share the first 4 and last 4 hex digits, the part wallets show; two unrelated
  accounts share them with probability 1 in 4.3 billion. A first label of 5 or more characters
  under another parent is a parent swap; it is strong only when that label is the known
  account's own name (directly under `.near`, `.testnet` or the root). Under someone's account
  (`agent.alice.testnet`) it is a role any account can give a sub-account, so a sibling
  (`agent.bob.testnet`) is a weak match: it holds the payment for the owner and is never a DENY.

## Lookalike detection

`findLookalike(payee, known)` compares the payee with every known payee. The known set is the
caller's `--known` list, the vault's allowlist and the registry's live ALLOW entries. It returns
the strongest match:

| Kind | Example |
| --- | --- |
| homoglyph | `aid-demo-rnerchant` vs `aid-demo-merchant` (rn/m, vv/w, cl/d, 0/o, 1/l/i, 5/s; `-`, `_`, `.` dropped) |
| parent_swap | `aid-demo-merchant.near` vs `.testnet`; `aid-demo-merchant.evil.testnet`. Weak (WARN only): `agent.bob.testnet` vs `agent.alice.testnet` |
| address_poisoning | implicit, `0x` or hex-named accounts that share the first and last 4 hex digits |
| edit_distance | `aid-demo-merhcant` (a transposition is one edit) |
| affix | `aid-demo-merchant-pay`, `aid-demo-merch` |

Every match carries `strong`. Only the role-label parent swap is weak, and a weak match never
hides a strong one: `agent.alice-pay.testnet` is still a strong affix of `agent.alice.testnet`,
and `findLookalike` ranks strong matches first. Two cases are never lookalikes: the known
account itself, and an account in a parent/sub-account relation with it, because only the
parent can create its sub-accounts.

## verifyThenPay, and the contract's final word

```ts
import { loadKey, verifyThenPay } from "./sdk/src/index.ts";

const signer = await loadKey({ file: process.env.AGENT_KEY_FILE }); // null -> prepared, nothing sent
const r = await verifyThenPay({ vault: "vault.aid-demo-owner.testnet", payee, amount: "250000", memo, signer });
// r.verdict.verdict, r.route ("pay" | "request_payment" | "record_refusal"), r.status
// ("prepared" | "executed" | "pending" | "rejected"), r.onchain (the vault's PayOutcome),
// r.contract_overrode, r.settled, r.tx_hash, r.links.explorer, r.links.archival_curl
```

| Guard verdict | Agent calls | What the vault may still do |
| --- | --- | --- |
| ALLOW | `pay` | hold it (`UnknownPayee` under `hold_unknown`, `RegistryWarn`) or refuse it (`RegistryDeny`, caps, expiry, freeze) |
| WARN, or no verdict | `request_payment` | hold it for the owner, or refuse a registry DENY |
| DENY | `record_refusal` | nothing moves; the refusal is on chain with a receipt and an event |

- **Prepared or executed.** Without a key, every write returns the exact signer, receiver and
  actions (`{type: "FunctionCall", params: {methodName, args, gas, deposit}}`, the shape NEAR
  wallets take). Nothing is sent. With a key, the SDK signs, computes the transaction hash
  locally (a test checks it against near-api-js's own signer), submits, and polls
  `EXPERIMENTAL_tx_status` until FINAL. Polling avoids nearcore's 10 s deadline on a multi-hop
  payment.
- **Settled means proven.** `settled` is true only when the transaction succeeded, the vault
  returned `status: "sent"` and emitted `payment_sent` for this payee and amount, and the TOKEN's
  own receipt succeeded as an `ft_transfer` called by the vault and emitted a NEP-141
  `ft_transfer` from the vault to the payee for exactly the amount. An event counts only when the
  account that logged it is the account it speaks for.
- **Rejected is not refused.** A transaction the network refuses at validation (key scope,
  deposit from a function-call key, exhausted allowance, bad nonce) is reported as `rejected`
  with no tx hash. Nothing was included on chain, so it is never shown as an on-chain refusal.
- **A failed send is pending, not rejected.** A send that ends any other way (nearcore's 10 s
  deadline, which arrives as HTTP 408, a 5xx, a dropped connection, a node's internal error)
  says nothing about delivery: the transaction may already be included, and it stays valid for
  86400 blocks after the block it references. The SDK never signs a second one; it polls the
  hash it computed for the full timeout and reports `executed`, or `pending` with the hash and
  links. Check that hash before sending again. `rejected` is used only for nearcore's decided
  refusals (`refusedAtValidation`).
- **A verdict is about this payment.** A snapshot passed in through `collect` must pass
  `assertSnapshot` and be about this payee, network and vault, collected with every `known`
  payee (`snapshotMismatch`); otherwise the verdict is WARN with the reason, never another
  account's ALLOW.
- A hosted verdict (`verdictSource: "hosted"`, `hostedUrl`) must answer
  `POST {account, network, vault, known}` with the shape `npm run verdict -- --json` prints,
  about the same account (and network, when it says one). Anything else is WARN.

## The agent's function-call key: exact limits

- It lives ON THE VAULT ACCOUNT. The vault created it in `add_agent_key` with receiver = the vault
  and methods = `pay`, `request_payment`, `record_refusal`. The agent signs as the vault (`signer_id`
  is the vault), and the SDK's agent calls do exactly that.
- A function-call key can never attach a deposit. So the protocol refuses it calling the token's
  `ft_transfer` (1 yoctoNEAR), moving NEAR, adding or deleting keys, deploying code, and any owner
  method (they require exactly 1 yoctoNEAR; only `freeze` takes none, and it checks the owner).
- The allowance caps NEAR spent on gas, not tokens; the vault's policy caps tokens. The protocol
  holds 0.001 NEAR per prepaid Tgas from the allowance until the receipts finish. The SDK
  prepays the contract's own figures: `AGENT_PREPAID_GAS`, 73 Tgas, for `pay` and
  `request_payment` (measured: the payment path cannot be scheduled below 51 Tgas, and 73 keeps
  30 percent over that floor; 0.073 NEAR held per payment in flight), and 10 Tgas for
  `record_refusal`. A test reads `AGENT_PREPAID_GAS` from the contract source, so the two cannot
  drift apart. A 0.25 NEAR allowance runs three payments at once. An allowance cannot be topped
  up: the owner revokes, forgets and adds a new key. Note that in near-api-js an allowance of
  `"0"` means a ZERO allowance, not an unlimited one; the vault refuses 0.
- `revoke_agent_key` marks the key revoked in the same receipt and deletes it from the account,
  so a revoked agent cannot even sign.

Owner methods go through `vaultClient({owner: {accountId, key}})` and attach exactly 1
yoctoNEAR, so they need a full-access key. Oracle writes go through
`registryClient({oracle: {accountId, key}})` and attach no deposit, so the oracle can run on a
function-call key limited to `set_verdict`, `set_verdicts`, `clear_verdict` and `clear_reports`.

## API

| Module | Exports |
| --- | --- |
| `engine` (pure) | `verdictFromSnapshot`, `assertSnapshot`, `normalize`, `decide`, `RULES`, `registryReasons`, `findLookalike`, `compareAccounts`, `skeleton`, `editDistance`, `canonicalJson`, `prettyJson`, `sha256Hex`, `snapshotSha256`, `chainSha256`, `formatEvidence`, `DEFAULT_POLICY`, `SCORE_BANDS`, `REASON_CODES`, `ENGINE_VERSION`, types |
| `collect` | `collectSnapshot({account, network, atBlock, known, vault, registry, ...})`, `createReader` (quiet read failover), `createHttpClient`, `NETWORKS`, `explorerTxUrl`, `archivalTxCurl` |
| `chain` | `vaultClient`, `registryClient`, `verdictInputFromDecision`, `checkVerdictInput`, `send`, `prepare`, `refusedAtValidation`, `parseOutcome`, `payOutcomeOf`, `vaultEventFor`, `proveSettlement`, `waitFinal`, `loadKey` (a 0600 file or an env var; never logged), `toUnits` |
| `guard` | `verifyThenPay`, `routeFor`, `guardReason`, `snapshotMismatch` |

Everything is re-exported from `sdk/src/index.ts`. TypeScript uses erasable syntax only, so Node
runs the sources directly (`--experimental-strip-types`, Node 22.22.2 or later; the tests also pass
on Node 22.14 and 24).

## Tests

`npm run test:sdk` runs 239 tests in 38 suites, offline, in about half a second. The fixtures
are real read-only answers recorded on 2026-11-12 (testnet and mainnet), plus a real Circle USDC
transfer (its signature is stored as the sha256 of its 64 bytes, as `near/judge` does, because
the repository's secret scanner reads any 64-byte ed25519 value as a possible secret key).

| File | What it proves |
| --- | --- |
| `rules.test.ts` | every rule, the clearing table, missing data never ALLOW, positives never override DENY, a weak lookalike never DENY, score bands on 500 random mixes |
| `lookalike.test.ts` | each lookalike kind with examples, role-label siblings (`agent`, `vault`, `store`, `payments`) as weak matches that never hide a strong one, and the non-matches |
| `canonical.test.ts` | SHA-256 against the FIPS vectors and node:crypto, canonical JSON, what each digest covers |
| `replay.test.ts` | five recorded snapshots replay to pinned verdicts and digests; variants (registry DENY, fail-closed parsing, the owner's first approval, missing indexers, a forged probe block, probe keys read at another block); snapshot validation (a missing or mismatched block record, a moved timestamp, an unpinned cross-network answer) |
| `collect.test.ts` | recorded HTTP exchanges rebuild the identical snapshot; indexer outage is WARN; no RPC means no verdict; on synthetic chains, the same mainnet block collected twice with testnet's head far apart records the same testnet block and one chain digest |
| `rpc.test.ts` | failover only on transport, 5xx, 429 and internal errors; decided answers are final; archival routing; pacing; nothing logged |
| `outcome.test.ts` | events, receipts and the settlement proof (wrong amount, a forged event, a failed token receipt and a foreign caller are all NOT settled); FINAL polling |
| `send.test.ts` | the signed transaction (signer, gas, deposit), the local hash equal to near-api-js's, the rejected, timeout, nonce-retry and pending paths, and HTTP 408, 503, a dropped connection, exhausted retries and internal errors never reported as rejected |
| `chain.test.ts`, `guard.test.ts`, `guard-cli.test.ts`, `cli.test.ts` | keys never shown, prepared calls (73/73/10 Tgas, equal to the contract's `AGENT_PREPAID_GAS`, 1 yoctoNEAR on owner calls), routing, a snapshot about another payee, network or vault never used, hosted fallbacks, the contract overriding the guard, CLI exit codes, `--offline` with every network request failing |

## Honest limits

- Indexer data is not consensus. It is recorded verbatim, and only facts bounded by the pinned
  height are used. If both indexers fail, the verdict is WARN (`indexer_unavailable`).
- The other teams' registries mostly hold demo data. Their entries are attributed by name and
  contract, labeled when they call themselves demo or test data, and never refuse a payment on
  their own.
- ERC-8004 registration and feedback are permissionless and cost a small deposit, so they move
  the score only.
- `new_full_access_key` also fires on a legitimate key rotation. That is deliberate: a known
  supplier whose keys changed between invoices should wait for one human tap.
- `prior_payments` is read from the agent's own vault. Agent-recorded refusals
  (`guard_refusal_count`) are shown and never used, because any agent key can record one about
  any payee.
- As of 2026-11-12 the registry (`registry.a-identity.testnet`) and the demo vault are not
  deployed. The CLI says so (`registry_not_deployed`, and `vault_unreadable` for a vault that
  does not exist) instead of assuming a clean answer.
- For a mainnet payee, the reads that only locate the testnet block are not recorded (they
  depend on when the search ran); `block.testnet` and `block.testnet.next` prove the choice. If
  testnet has not passed the mainnet block's time within 8 seconds (a stalled testnet),
  MimicWatch is recorded as not read (info, never as clean), and a later re-collection that can
  read it gives a different `chain_sha256`. Use `--no-third-party` for a mainnet digest that
  depends on mainnet alone.
- Not used: NEAR Intents, Chain Signatures, TEEs. No model takes part in a verdict.
