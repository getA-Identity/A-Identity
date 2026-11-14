# A-Identity Guard for NEAR

A spend vault for an AI agent on NEAR testnet. The agent's only key is a function-call key that
can call three methods on the vault, and before any USDC moves the vault reads A-Identity's risk
registry on chain: a flagged payee is refused by the contract, and a payee nobody has judged is
held until the owner approves it or A-Identity's oracle judges it from public chain data (an
oracle ALLOW lets the agent's retry pay it, inside the owner's caps).

**The problem.** An AI agent that can pay can be talked into paying the wrong account: one
poisoned invoice that says "our payment account changed" is enough. Spending caps do not stop a
payment to the wrong payee, and a risk check that runs inside the agent protects nothing once the
agent itself has been fooled.

**What is different.** A cap-and-allowlist wallet stops overspending, not a wrong payee, and a
mandate vault fixes every payee in advance. This vault handles the first payment to a payee nobody
listed: the contract reads a registry verdict that anyone can recompute from public chain data,
holds a payee nobody has judged, and refuses a DENY even when the owner approves it.

Status: NEAR testnet, unaudited. An entry to NEAR HACKATHON 2026, tracks `security`, `agents` and
`open`. Only the NEAR integration built in the hackathon window is submitted (listed in
[Built in the window](#built-in-the-window-and-what-is-baseline)); A-Identity on other chains is
older and is not part of this entry.

## Evaluate in 2 minutes

No keys, no accounts, no `npm install`, no Rust. Node 22 or later (22.6 or later for the claim that
recomputes a verdict; an older Node prints it as SKIP and says why).

```
git clone https://github.com/getA-Identity/A-Identity
cd A-Identity
git checkout hackathon-submission       # the state submitted for judging
node near/judge/judge.mjs               # online: views from NEAR testnet RPC, every transaction from archival RPC
node near/judge/judge.mjs --offline     # no network: replays the raw RPC answers committed in near/evidence/
```

Expected last lines at `hackathon-submission`: `JUDGE: 54 PASS, 0 FAIL, 0 SKIP (mode=online, <seconds> s)`
online, and `JUDGE: 54 PASS, 0 FAIL, 0 SKIP (mode=offline, <seconds> s)` offline. On `main`, which
adds one claim after the submitted tag (`tx-x402-settlement`, an x402 payment settled on NEAR
testnet), both runs end `JUDGE: 55 PASS, 0 FAIL, 0 SKIP`.

- One line per claim: `PASS|FAIL|SKIP <id> <claim> (<evidence or reason>; <seconds> s)`. The claim
  is the sentence in [Claims the judge checks](#claims-the-judge-checks), word for word.
- Exit status 0 only when nothing failed. A SKIP always names its reason (not deployed yet, no
  network, a missing tool) and never counts as a pass.
- Live or replayed: FastNEAR's free archival RPC answers bursts with HTTP 429. The judge retries
  (a `... retrying <host>` line on stderr); if a network stops answering, its remaining claims
  replay the committed evidence, a `NOTE` line says so, and each of those claims' lines reads
  `(replayed evidence (<why>): ...)`. The last line does not split live from replayed:
  `node near/judge/judge.mjs | grep -c 'replayed evidence'` counts the replayed claims, and
  `checks[].replayed` in the report marks each one.
- `near/judge/judge-report.json` (git-ignored) keeps every check with what was expected and what
  was observed, every RPC call with the block that answered it, and a `curl` per call pinned to
  that block on archival RPC, so any answer can be asked again by hand.
- `--list` prints the claims, `--step <id>,<id>` runs a few, `--verify-evidence` re-asks archival
  RPC every recorded answer at its recorded block, and `--full` adds the build and test steps
  (Rust unit tests, the sandbox suite, the reproducible wasm, `npm test`, the judge's own tests,
  the negative controls).
  Details: [judge/README.md](judge/README.md).
- A shallow clone (`--depth 1`) has no tags, so the `built-in-window` claim is SKIP there; the
  compare link below shows the same thing.

Time each command took on 2026-11-12, from the repository root:

| Command | Time | Notes |
| --- | --- | --- |
| `node near/judge/judge.mjs --offline` | 0.2 to 0.5 s (four runs) | no network |
| `node near/judge/judge.mjs` | 13.8 s, 16.9 s and 93.4 s (three runs) | 11, 9 and 0 of the 43 testnet claims (measured before the 5 mainnet claims were added) replayed evidence; the 93.4 s run waited out its HTTP 429 retries instead |
| `node near/judge/judge.mjs --verify-evidence` | 132.5 s (one run) | 37 PASS, 6 SKIP: 4 on HTTP 429, and 2 local checks with nothing recorded to verify |
| `node near/judge/judge.mjs --step full-unit-tests,full-judge-tests,full-sdk-tests` | 36.4 s on a warm build cache (one run) | needs the tools in [Reproduce from source](#reproduce-from-source) |
| `node near/judge/judge.mjs --full` | not timed end to end | adds the sandbox suite (one local node per test) and the Docker reproducible build; CI's `contracts` job (format, clippy, unit and sandbox tests, negative controls) took 20 minutes |

## Try to break it

The demo post asks for this. Each of these counts as a break:

- USDC leaves the vault for a payee the registry says DENY, or for a payee with no registry ALLOW
  that the owner neither allowlisted nor paid before, without the owner's approval.
- The agent's key does anything but call `pay`, `request_payment` or `record_refusal` on the vault,
  or moves more than the policy allows (per-payment ceiling 2 USDC, daily cap 5 USDC).
- A verdict in the registry does not recompute: `cd near && npm ci && npm run verdict -- <account>
  --at-block <N>` gives a different `chain_sha256` or verdict.
- `node near/judge/judge.mjs` prints FAIL, or a claim passes while its evidence says otherwise.

Ask the hosted check about any NEAR testnet account:
`curl --max-time 120 "https://a-identity-backend.onrender.com/api/near/check?account=<id>"`. Report a break
as a GitHub issue, or privately as [SECURITY.md](../SECURITY.md) describes.

## What it does, and what to look for

1. **Unknown payees wait on chain.** With `hold_unknown` on (the default at init), the vault pays
   a payee only if the registry says ALLOW, the owner allowlisted it, or the vault has paid it
   before. Any other payee is held for the owner (`UnknownPayee`). A registry DENY is refused by
   the contract (`RegistryDeny`) with nothing moved, even when the owner approves the payment.
   A held payment waits 24 hours (`HELD_TTL_S` in `contracts/agent-spend-policy/src/lib.rs`);
   after that the owner's approval is refused `HeldExpired` and the agent has to ask again. While
   the oracle watcher runs, it judges each held payee the registry has no verdict for. A DENY
   makes the agent's retry and the owner's approval fail `RegistryDeny`; an ALLOW, which it
   writes for 24 hours when the engine allows a name that does not imitate a known payee, lets
   the agent's retry pay without the owner (the limit this sets is under
   [Benchmark](#benchmark-the-engine-on-real-mainnet-accounts)).
   Claims `tx-pay-unknown`, `tx-pay-deny`, `tx-owner-pay-denied`.
2. **No full-access key on the vault, the registry or the oracle.** The vault's only key is the
   agent's function-call key, which the vault added itself, for exactly `pay`, `request_payment`
   and `record_refusal`. The registry holds no key at all, and the oracle only a function-call key
   on the registry. Neither contract has an upgrade method, and the vault has no owner transfer.
   Claims `vault-keys`, `oracle-keys`, `registry-keys`.
3. **The agent's key cannot do anything else.** In the attack demo the agent's own key signs a
   call to the USDC contract, a call with a deposit, an owner method, a new full-access key and a
   NEAR transfer; the protocol rejects each one before execution. Claims `reject-*`.
4. **Verdicts can be recomputed from public chain data.** The oracle writes each verdict with the
   sha256 of the snapshot it was computed from, the block and the engine version.
   `npm run verdict -- --offline <snapshot>` recomputes it with no network, and the judge re-asks
   archival RPC every block-pinned read in the snapshot. Claim `recompute-lookalike`.
5. **A real-data benchmark that names every miss.** On the 30 cited suspicious and 46 known-good
   NEAR mainnet accounts of our dataset, the engine alone denies none of the suspicious ones and
   warns on 6. That is why the vault holds every payee nobody has judged instead of paying on the
   agent's own check. The oracle's ALLOW still rests on the engine; that limit is stated in
   [Benchmark](#benchmark-the-engine-on-real-mainnet-accounts).
6. **A judge with zero keys.** Every row of the claims table below is a line the judge prints,
   checked against public chain data or this repository; none needs a key. Numbers outside that
   table name the file, log or command they come from.

## Built in the window, and what is baseline

Hackathon rules Q-001 to Q-005. The window runs from 2026-10-19 to 2026-11-14 23:59 UTC.

- Tag `pre-hackathon`: commit `6815d3af` (2026-11-11 23:21 UTC), the last commit before any NEAR
  work. Nothing under `near/` exists at that tag.
- Tag `hackathon-submission`: the state submitted for judging;
  `git rev-list -n 1 hackathon-submission` prints its commit.
- Every change, on GitHub:
  https://github.com/getA-Identity/A-Identity/compare/pre-hackathon...hackathon-submission ;
  locally: `git diff --stat pre-hackathon hackathon-submission`.
- Why the baseline tag sits on 2026-11-11 and not on 2026-10-19: A-Identity's commits between
  those dates are product work on other chains. They fall inside the window by date, but they are
  not NEAR work and are not submitted, so the tag keeps them on the baseline side.

| Built in the window (submitted) | What it is |
| --- | --- |
| `near/contracts/` | the vault `agent-spend-policy` 0.2.0, the registry `a-identity-registry` 0.2.0, `mock-ft` (sandbox tests only, never deployed), the sandbox suite, the negative controls |
| `near/sdk/` | the verdict engine, the chain data collectors, `verifyThenPay`, the `verdict` and `guard` CLIs |
| `near/judge/`, `near/evidence/`, `near/deployments/` | the zero-key judge, the recorded RPC answers it replays, the deploy record |
| `near/demo/`, `near/scripts/` | the attack demo and the oracle watcher |
| `near/scan/` | the cited NEAR mainnet dataset and the benchmark |
| `.github/workflows/near.yml` | NEAR CI: format, clippy, unit and sandbox tests, negative controls, reproducible wasm |
| `mcp/src/chains/near/`, `mcp/src/near-check/`, `mcp/src/http/near-check-routes.ts`, the `near-testnet` entry in `mcp/src/chains/registry.ts` | the backend's NEAR check: `GET /api/near/check`, and NEAR testnet targets in the A-Identity trust tools |
| `src/routes/app/NearVault.tsx`, `src/components/app/near/`, `src/lib/near/` | the owner console at `/app/vault/near` |
| `.gitleaks.toml` | a CI rule that catches NEAR ed25519 secret keys |
| generated, not written by hand | `prerendered/` (the site snapshot), `src/lib/chains.ts`, `mcp/src/chains/near/sdk.generated/` (a copy of `near/sdk/src`) |

Built in the window but added to `main` after the `hackathon-submission` tag, so not part of the
submitted state: x402 exact on `near:testnet` (`mcp/src/near-x402/`, `mcp/src/http/near-x402-routes.ts`),
its buyer `near/scripts/x402-buy.ts`, the `x402` block of `deployments/testnet.json`, the claim
`tx-x402-settlement` with `evidence/tx-x402-settlement.json`, and the at-age replay of the benchmark
(`near/scan/benchmark/at-age/`).

Baseline, not submitted and not judged: everything else in this repository, including
A-Identity's engine, its MCP server, its x402 rails on other chains, `trust-guard` and the vaults on Arc, Stellar
and Algorand. Two pre-hackathon designs of our own are reused: the vault's gate order and the
meaning of a zero limit come from the AgentSpendPolicy vault
([Solidity](../mcp/contracts/AgentSpendPolicy.sol),
[Soroban](../soroban/contracts/agent-spend-policy)), and the score bands come from
[mcp/src/commerce.ts](../mcp/src/commerce.ts).

## Deployed on NEAR testnet

The record is [deployments/testnet.json](deployments/testnet.json) (`"status": "deployed"`). A
`null` there means not done, and the judge prints `SKIP pending` for any claim that needs it.

| Role | Account | Code hash (base58), keys |
| --- | --- | --- |
| Vault, `agent-spend-policy` 0.2.0 | [vault.aid-demo-owner.testnet](https://testnet.nearblocks.io/address/vault.aid-demo-owner.testnet) | `4FKHJrJm1iyphfbCcAaxGGdhS5vUEjH5BpnZScNjFgny`; no full-access key; the agent's function-call key below |
| Registry, `a-identity-registry` 0.2.0 | [registry.a-identity.testnet](https://testnet.nearblocks.io/address/registry.a-identity.testnet) | `7JBaTHGEmZpDHcyWacXBaRSkmwUUiYwg9oFRqfcsPogX`; no access key at all |
| Oracle, writes verdicts | [oracle.a-identity.testnet](https://testnet.nearblocks.io/address/oracle.a-identity.testnet) | no full-access key; one function-call key on the registry for `set_verdict`, `set_verdicts`, `clear_verdict`, `clear_reports`: `ed25519:DZTaJkebXp9ftmf8dCrB72MBxBTLvnGfXHHBh3jTsg6b` |
| Vault owner, a person | [aid-demo-owner.testnet](https://testnet.nearblocks.io/address/aid-demo-owner.testnet) | the owner's full-access key; in the recorded demo the script signs the owner's approvals with it, tagged `scripted` |
| Registry owner | [a-identity.testnet](https://testnet.nearblocks.io/address/a-identity.testnet) | one full-access key; the owner role only adds and removes oracles and can hand itself over (`set_owner`) |
| USDC, Circle's testnet contract (NEP-141, 6 decimals) | [3e2210e1...cb8af](https://testnet.nearblocks.io/address/3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af) | Circle's |
| Payee: the known merchant | [aid-demo-merchant.testnet](https://testnet.nearblocks.io/address/aid-demo-merchant.testnet) | paid once with the owner's approval, then by the agent |
| Payee: the lookalike, one letter changed | [aid-demo-merchamt.testnet](https://testnet.nearblocks.io/address/aid-demo-merchamt.testnet) | created 2026-11-12 18:49:37 UTC, less than a minute before the recorded run; received 0 USDC |
| Payee: a new vendor | [aid-demo-printshop.testnet](https://testnet.nearblocks.io/address/aid-demo-printshop.testnet) | nobody had judged or paid it |
| Payees of the two later runs (not judged) | [aid-demo-rnerchant.testnet](https://testnet.nearblocks.io/address/aid-demo-rnerchant.testnet), [aid-demo-merchent.testnet](https://testnet.nearblocks.io/address/aid-demo-merchent.testnet), [aid-demo-copyshop.testnet](https://testnet.nearblocks.io/address/aid-demo-copyshop.testnet) | the lookalikes of the run with a model and of the attempt before it, both received 0 USDC; the new vendor of the run with a model, paid 0.75 USDC after the owner's approval |
| Not a payee | [aid-demo-attacker.testnet](https://testnet.nearblocks.io/address/aid-demo-attacker.testnet) | created during setup; never a demo role or payee (a payee named "attacker" proves nothing about a classifier). Its one transaction created `aid-demo-rnerchant.testnet`, the lookalike of the run with a model, with 1 NEAR (`4SKBCnLzDch9nzcJeCreekLb3TfyjkJiEThTh4pPT9zi`); no verdict reads who created or funded an account |
| Not the agent | [aid-demo-agent.testnet](https://testnet.nearblocks.io/address/aid-demo-agent.testnet) | predates this vault design; one full-access key; signs no demo transaction; on main it is the buyer of the recorded x402 settlement (claim `tx-x402-settlement`), signing one Delegate with its full-access key, never a vault call |

- The agent's key on the vault: `ed25519:AyrM3caas16rWjMky2fPdQKPgQptdRrHRvPJaP7YFbeA`, receiver
  `vault.aid-demo-owner.testnet`, methods `pay`, `request_payment`, `record_refusal`, allowance
  0.5 NEAR at creation, added by the vault's own `add_agent_key` in transaction
  `CEHAa3QYVp2zBM2vT36Kd3waKD93ss44uPE1TBzmRWMA`.
- The vault's policy: daily cap 5 USDC, per-payment ceiling 2 USDC, allowlist off, `hold_unknown`
  on.
- Deploy transactions: registry `5F38SuVmnzrAjWjVwAmheVzyU1PZ2Sb2pSzW4JcgqumL` (block 277401995,
  signed by `a-identity.testnet`), vault `9b7Zna2t2jaVso4WqSpxM6HYcVGMjAMX7FPzcpb8dMJ` (block
  277402011, signed by `aid-demo-owner.testnet`). Each one is a single batch (create the account,
  fund it, deploy, call `new`) that adds no access key, so the registry has no key at all and the
  vault's only key is the one its contract added. The oracle's full-access key was deleted in
  `23WazyK4C7XHha1DLpiNAPUUCHZn8AcEUKzzx8Neoxxz`, after its function-call key (added in
  `dghHot5rjpQc2e1WoCuyuH1h2JkHYmUb3PzzG7eBQge`) was confirmed on chain.
- The deployed bytes are committed as `near/deployments/wasm/agent_spend_policy.wasm` (285,642
  bytes, sha256 `303ddcd92f7188f5ffdefa39a3a8733166a10afbe8703e44df5117743f5de316`) and
  `near/deployments/wasm/a_identity_registry.wasm` (178,793 bytes, sha256
  `5d8cf45af8fde6de39e5df79c5f32529656eb8511f6e7330e593ffb3300e985c`); the base58 form of each
  sha256 is the code hash above (claims `vault-code`, `registry-code`).
- They were built on the host with `cargo near build non-reproducible-wasm --locked` (rustc
  1.95.0, cargo-near 0.23.0) from commit `8a210e12`, not with the reproducible Docker build. A
  host build embeds the builder's local paths, so the chain can be checked against the committed
  bytes, but the bytes cannot be rebuilt identically on another machine. `deployments/testnet.json`
  therefore records `"reproducible": false`, and the `full-wasm-vault` and `full-wasm-registry`
  steps print `SKIP pending` under `--full`: they cannot pass against this deploy, only after a
  redeploy of the CI reproducible build.
- Explorer links are for people; NearBlocks pages can challenge clients that are not browsers.
  The judge reads RPC only, and every transaction from archival RPC, which keeps old transactions
  after regular nodes have dropped them.

## Deployed on NEAR mainnet

The same source, built reproducibly in CI (`cargo near build reproducible-wasm` in the pinned
`sourcescan/cargo-near:0.22.0-rust-1.99.1` image, workflow `.github/workflows/near.yml`, run on the
tagged commit `f266e4d2`, where the sandbox suite ran against these exact bytes), deployed on
2026-11-12 by the owner's own wallet. Each contract was created, funded, deployed and initialized in
one batch with no access key added. The bytes are committed in `deployments/wasm-mainnet/` with the
CI's `hashes.json`.

| Role | Account | Code hash or key | Transaction |
| --- | --- | --- | --- |
| Risk registry | [registry.a-identity.near](https://nearblocks.io/address/registry.a-identity.near) | `FiSTFw7TWdhgL5SUVTb6L6J9uYp9fkSkBcrd4rV8V2jG` (178,383 bytes); no access key | deploy [3dAQFimSz7XSoMhGhGUCFb6MWRFzRKJuAhmoxSVwKyKp](https://nearblocks.io/txns/3dAQFimSz7XSoMhGhGUCFb6MWRFzRKJuAhmoxSVwKyKp) |
| Spend vault | [vault.a-identity.near](https://nearblocks.io/address/vault.a-identity.near) | `N5JUw1STCok4nmsRvJfHeeAnbYgZrVHLcyfWK8tE8DN` (283,224 bytes); only key: the agent's function-call key `ed25519:9wHaVjSEfCvugBoRfiDM1RRxqeW8p8UTb1Ls7hoEszdU` (pay, request_payment, record_refusal; 0.25 NEAR allowance; expires 2026-12-12) | deploy [EPF293WdqsGgSN1tVpGdz64oiV2SHeuBpEqT1rRv3rJ8](https://nearblocks.io/txns/EPF293WdqsGgSN1tVpGdz64oiV2SHeuBpEqT1rRv3rJ8); agent key [GSHrf1BBq3Ma19qC4xdWThPWM2fZHb7mLgYH5DvbRKnA](https://nearblocks.io/txns/GSHrf1BBq3Ma19qC4xdWThPWM2fZHb7mLgYH5DvbRKnA) |
| Oracle | [oracle.a-identity.near](https://nearblocks.io/address/oracle.a-identity.near) | no contract; only key: a function-call key on the registry's verdict methods, `ed25519:2eqV2YcQs836yXx8Y9NZ3u9oMh53ymtKFmFZtdBK3Mig`; it never had a full-access key | created with that key in one batch [CD4aMbdiE6TaegZRjHJVEJ7pNZs5JkHomC7wrn4Pojjb](https://nearblocks.io/txns/CD4aMbdiE6TaegZRjHJVEJ7pNZs5JkHomC7wrn4Pojjb) |
| Owner of all three | [a-identity.near](https://nearblocks.io/address/a-identity.near) | no contract | signed every transaction above |

- Policy at init: owner `a-identity.near`, Circle's mainnet USDC
  (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`), registry
  `registry.a-identity.near`, 5 USDC daily cap, 2 USDC per payment, unknown payees held.
- `contract_source_metadata` on both contracts returns version 0.2.0, the repository link at commit
  `f266e4d2` and `build_info` with the image digest and `source_code_snapshot`, so a NEP-330
  verifier can rebuild the same bytes.

### The vault refusing and holding on mainnet

`demo/mainnet-run.ts` (log `demo/logs/mainnet/20261112T220918Z-mainnet.txt`) drives the mainnet
vault with its agent key and the oracle's function-call key. It refuses to start if the vault holds
any USDC, and the vault holds none, so every outcome is a hold or a refusal and no token can move.

| Step | Transaction | What the chain did |
| --- | --- | --- |
| The agent pays `linear-protoco1.near` (one character off LiNEAR's token account; it does not exist) | [AQf6d11pTUjkW7AbWyTuJTdZXyNnRjaWRyQuXMz4UefJ](https://nearblocks.io/txns/AQf6d11pTUjkW7AbWyTuJTdZXyNnRjaWRyQuXMz4UefJ) | held, `unknown_payee`: nobody had judged it |
| The agent pays `linear_protocol.near` (a cited fake-airdrop account, `scan/dataset.json`) | [HgYUEU7KAx1N2gidU5t4RvUB1XWFtNFjnioTLPiFSref](https://nearblocks.io/txns/HgYUEU7KAx1N2gidU5t4RvUB1XWFtNFjnioTLPiFSref) | held, `unknown_payee` |
| The oracle judges `linear-protoco1.near` from mainnet data | [H3aeCuM9bsr5Zm4hf6krcaBTPNUUyiXzpjtpdv5kVPRv](https://nearblocks.io/txns/H3aeCuM9bsr5Zm4hf6krcaBTPNUUyiXzpjtpdv5kVPRv) | DENY [account_not_found, lookalike_new_account], snapshot `b246fe6f...c935` |
| The oracle judges `linear_protocol.near` | [BaG8AY6E516MND2iU1yDLgKNZrjGiHUE1rx4EHheyN3k](https://nearblocks.io/txns/BaG8AY6E516MND2iU1yDLgKNZrjGiHUE1rx4EHheyN3k) | WARN [third_party_flag, lookalike_known]: another team's public registry flags it |
| The agent pays `linear-protoco1.near` again | [G9q2HkSAnsSv1JL9KZgeRAqBa2v3cT6WDBeMpwTz8qFM](https://nearblocks.io/txns/G9q2HkSAnsSv1JL9KZgeRAqBa2v3cT6WDBeMpwTz8qFM) | refused on chain, `RegistryDeny` |
| The agent pays `linear_protocol.near` again | [3PkqJJmgmYJSsdwtw6oTK7exPZ3D1jcXarajXMEU4oLh](https://nearblocks.io/txns/3PkqJJmgmYJSsdwtw6oTK7exPZ3D1jcXarajXMEU4oLh) | held for the owner, `registry_warn` |

- Recompute either verdict: `npm run verdict -- --offline demo/logs/mainnet/oracle/snapshots/<sha256>.json`.
- What is not there, stated: no USDC in the vault, so no payment has been sent on mainnet, and the
  oracle is not a running service; it ran once in this script.
- Check it: `node near/judge/judge.mjs --step mainnet-registry-code,mainnet-vault-code,mainnet-registry-keys,mainnet-vault-keys,mainnet-oracle-keys,mainnet-vault-config,mainnet-registry-oracles,mainnet-tx-oracle-deny,mainnet-tx-pay-deny,mainnet-tx-oracle-warn,mainnet-tx-pay-warn-held`.

## Claims the judge checks

Every row is one line the judge prints. A claim whose deploy fields are still `null` prints
`SKIP pending`, never `PASS`. Rows marked `build` run only with `--full` or `--step <id>`.

| ID | Claim (judge/claims.json, word for word) | Where | How the judge checks |
| --- | --- | --- | --- |
| `usdc-testnet-token` | Circle's USDC on NEAR testnet (3e2210e1...cb8af) reports NEP-141 metadata: spec ft-1.0.0, symbol USDC, 6 decimals. | testnet | call_function view |
| `usdc-testnet-blocklist` | Circle's testnet USDC answers is_blocklisted, one of the signals the verdict engine reads (aid-demo-merchant.testnet: false). | testnet | call_function view |
| `usdc-mainnet-blocklist` | Circle's USDC on NEAR mainnet (17208628...36133a1) answers is_blocklisted, so the same signal works on real mainnet accounts (read-only). | mainnet | call_function view |
| `erc8004-identity-mainnet` | Arras's ERC-8004 identity registry, identity-registry.erc-8004.near, is a deployed contract on NEAR mainnet (read-only signal source). | mainnet | view_account |
| `erc8004-reputation-mainnet` | Arras's ERC-8004 reputation registry, reputation-registry.erc-8004.near, is a deployed contract on NEAR mainnet (read-only signal source). | mainnet | view_account |
| `account-registry-owner` | a-identity.testnet, the registry owner, exists on NEAR testnet. | testnet | view_account |
| `account-oracle` | oracle.a-identity.testnet, the oracle that writes verdicts, exists on NEAR testnet. | testnet | view_account |
| `account-vault-owner` | aid-demo-owner.testnet, the vault owner, exists on NEAR testnet. | testnet | view_account |
| `account-merchant` | aid-demo-merchant.testnet, the legitimate demo payee, exists on NEAR testnet. | testnet | view_account |
| `account-attacker` | aid-demo-attacker.testnet exists on NEAR testnet; it was created during setup and is not a demo payee (a payee named attacker proves nothing about a classifier). | testnet | view_account |
| `account-agent-legacy` | aid-demo-agent.testnet is not the agent: it predates the keyless vault and holds one full-access key and no function-call key; every agent transaction in this table is signed by the vault account with its function-call key instead. | testnet | view_access_key_list |
| `registry-code` | registry.a-identity.testnet runs the committed build: its on-chain code_hash is base58(sha256) of deployments/wasm/a_identity_registry.wasm. | testnet | view_account code_hash vs sha256 of the committed wasm |
| `vault-code` | vault.aid-demo-owner.testnet runs the committed build: its on-chain code_hash is base58(sha256) of deployments/wasm/agent_spend_policy.wasm. | testnet | view_account code_hash vs sha256 of the committed wasm |
| `vault-keys` | The vault account holds no full-access key: every key on it is a function-call key for exactly pay, request_payment and record_refusal on the vault, with a finite NEAR allowance. | testnet | view_access_key_list |
| `oracle-keys` | The oracle account holds no full-access key: it writes verdicts only with a function-call key on the registry limited to set_verdict, set_verdicts, clear_verdict and clear_reports. | testnet | view_access_key_list |
| `registry-keys` | The registry account holds no full-access key, so nobody can redeploy or delete the registry. | testnet | view_access_key_list |
| `registry-owner-keys` | The registry owner's key list is public and small: a-identity.testnet holds exactly one full-access key and no function-call key. | testnet | view_access_key_list |
| `vault-config` | The vault's on-chain policy is the one stated: owner aid-demo-owner.testnet, Circle testnet USDC, registry registry.a-identity.testnet, not frozen, unknown payees held, and the daily cap and per-payment ceiling recorded in deployments/testnet.json. | testnet | call_function view |
| `registry-oracles` | Only oracle.a-identity.testnet may write verdicts: the registry's oracles() is exactly [oracle.a-identity.testnet]. | testnet | call_function view |
| `registry-owner` | The registry's owner is a-identity.testnet, whose key stays offline. | testnet | call_function view |
| `mainnet-registry-code` | registry.a-identity.near on NEAR mainnet runs the CI reproducible build: its code_hash is base58(sha256) of deployments/wasm-mainnet/a_identity_registry.wasm. | mainnet | view_account code_hash vs base58(sha256) of the committed wasm |
| `mainnet-vault-code` | vault.a-identity.near on NEAR mainnet runs the CI reproducible build: its code_hash is base58(sha256) of deployments/wasm-mainnet/agent_spend_policy.wasm. | mainnet | view_account code_hash vs base58(sha256) of the committed wasm |
| `mainnet-registry-keys` | registry.a-identity.near holds no access key at all, so nobody can redeploy or delete it. | mainnet | view_access_key_list |
| `mainnet-vault-keys` | vault.a-identity.near holds no full-access key: its only key is the agent's function-call key for exactly pay, request_payment and record_refusal on the vault, with a finite NEAR allowance. | mainnet | view_access_key_list |
| `mainnet-vault-config` | The mainnet vault's policy is owner a-identity.near, Circle's mainnet USDC, registry registry.a-identity.near, not frozen, unknown payees held, a 5 USDC daily cap and a 2 USDC per-payment ceiling. | mainnet | call_function view |
| `mainnet-oracle-keys` | oracle.a-identity.near holds no full-access key: it writes verdicts only with a function-call key on registry.a-identity.near limited to set_verdict, set_verdicts, clear_verdict and clear_reports. | mainnet | view_access_key_list |
| `mainnet-registry-oracles` | Only oracle.a-identity.near may write verdicts on mainnet: the registry's oracles() is exactly [oracle.a-identity.near]. | mainnet | call_function view |
| `mainnet-tx-oracle-deny` | On mainnet the oracle judged linear-protoco1.near, a name one character off LiNEAR's token that does not exist, DENY from public chain data and wrote it with its function-call key: verdict_set with verdict DENY. | mainnet | EXPERIMENTAL_tx_status on archival RPC |
| `mainnet-tx-pay-deny` | On mainnet the agent's payment to linear-protoco1.near after the oracle's DENY was refused by the vault contract: payment_refused with reason RegistryDeny and source registry, and no receipt reached the USDC contract. | mainnet | EXPERIMENTAL_tx_status on archival RPC |
| `mainnet-tx-oracle-warn` | On mainnet the oracle judged linear_protocol.near, a cited fake-airdrop account that another team's public registry flags, WARN and wrote it: verdict_set with verdict WARN. | mainnet | EXPERIMENTAL_tx_status on archival RPC |
| `mainnet-tx-pay-warn-held` | On mainnet the agent's payment to linear_protocol.near after the oracle's WARN was held by the vault for its owner: payment_held with kind registry_warn, and no receipt reached the USDC contract. | mainnet | EXPERIMENTAL_tx_status on archival RPC |
| `verdict-lookalike` | The registry's verdict for the lookalike aid-demo-merchamt.testnet, read at the block recorded in deployments/testnet.json, is DENY with reason codes, written by the oracle, and its evidence names the snapshot, block and engine it was computed from. | testnet | call_function view |
| `tx-setup-request` | The merchant's first payment waited for the owner: the agent's request_payment to aid-demo-merchant.testnet emitted payment_held, and no receipt reached the USDC contract. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-setup-owner-pay` | The owner approved that first payment once, with one owner_pay (1 yoctoNEAR): payment_sent with by_owner true, and a nep141 ft_transfer moved the USDC from the vault to aid-demo-merchant.testnet. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-pay-known` | The agent paid aid-demo-merchant.testnet with its function-call key and USDC moved: payment_sent, and the USDC contract executed a nep141 ft_transfer from the vault to the merchant for the exact amount. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-guard-refusal` | The agent's guard refused the lookalike aid-demo-merchamt.testnet and recorded it on chain: record_refusal emitted payment_refused with source agent_guard, and nothing moved. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-pay-unknown` | A compromised agent that skipped the guard and paid the lookalike, which nobody had judged yet, was held by the vault contract for the owner: payment_held with reason UnknownPayee, and no receipt reached the USDC contract. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-oracle-deny` | The oracle judged the lookalike DENY from public chain data and wrote it with its function-call key: set_verdict signed by oracle.a-identity.testnet with that key, verdict_set with verdict DENY. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-pay-deny` | Paying the lookalike again was refused by the vault contract on chain: payment_refused with reason RegistryDeny and source registry, and no receipt reached the USDC contract. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-owner-pay-denied` | The owner's approval does not override a later DENY: owner_pay of the held lookalike payment was refused on chain with RegistryDeny (held_settle_failed), and nothing moved. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-vendor-request` | For aid-demo-printshop.testnet, a vendor nobody has history with, the agent asked the owner instead of paying: request_payment emitted payment_held, and nothing moved. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-vendor-owner-pay` | The owner approved the vendor's held payment with one owner_pay (1 yoctoNEAR): payment_sent with by_owner true, and a nep141 ft_transfer moved the USDC from the vault to the vendor. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `tx-over-ceiling` | A payment above the per-payment ceiling was refused by the vault contract on chain: payment_refused with reason AboveAutoApprove and source policy, and nothing moved. | testnet | EXPERIMENTAL_tx_status, archival RPC |
| `known-payee-merchant` | aid-demo-merchant.testnet is a payee the vault knows from its own payments: at the block recorded after the demo, paid_count equals the payment_sent events to it in the demo's transactions, one of them the owner's approval (by_owner true). | testnet | vault counter at a pinned block vs events in the demo txs |
| `refusal-count` | The vault counts registry refusals only: at the block recorded after the demo, refusal_count(aid-demo-merchamt.testnet) equals the payment_refused events with reason RegistryDeny and source registry in the demo's transactions (at least the agent's pay and the owner's owner_pay). | testnet | vault counter at a pinned block vs events in the demo txs |
| `guard-refusal-count` | Refusals an agent records are counted apart from registry refusals: at the same block, guard_refusal_count(aid-demo-merchamt.testnet) equals the payment_refused events with source agent_guard in the demo's transactions, and none of the registry's refusals. | testnet | vault counter at a pinned block vs events in the demo txs |
| `reject-call-token` | The agent key cannot call the USDC contract: the protocol rejected its ft_transfer on USDC with ReceiverMismatch, before execution. | testnet | signed bytes in the demo log + view_access_key at that block |
| `reject-attach-deposit` | The agent key cannot attach a deposit, so no 1-yoctoNEAR method is reachable: the protocol rejected pay with 1 yoctoNEAR attached (DepositWithFunctionCall), before execution. | testnet | signed bytes in the demo log + view_access_key at that block |
| `reject-owner-method` | The agent key cannot call an owner method: the protocol rejected set_registry on the vault with MethodNameMismatch, before execution. | testnet | signed bytes in the demo log + view_access_key at that block |
| `reject-add-key` | The agent key cannot give itself more power: the protocol rejected adding a full-access key to the vault account (RequiresFullAccess), before execution. | testnet | signed bytes in the demo log + view_access_key at that block |
| `reject-send-near` | The agent key cannot move the vault's NEAR: the protocol rejected a 1 yoctoNEAR transfer out of the vault (RequiresFullAccess), before execution. | testnet | signed bytes in the demo log + view_access_key at that block |
| `recompute-lookalike` | Anyone can recompute the lookalike's verdict: the SDK's offline verdict on the snapshot the oracle saved gives the registry's DENY at the recorded block, with the same reasons and evidence string, and every block-pinned chain read in that snapshot is what archival RPC returns. | testnet | SDK offline verdict + archival re-read of the snapshot |
| `tx-x402-settlement` | An x402 payment settled on NEAR testnet through A-Identity's own relayer: x402-relayer.a-identity.testnet signed one Delegate action from aid-demo-agent.testnet holding exactly one ft_transfer with 1 yoctoNEAR, and the USDC contract executed a nep141 ft_transfer of exactly 10000 (0.01 USDC) from aid-demo-agent.testnet to a-identity.testnet, with no failed receipt. | testnet | EXPERIMENTAL_tx_status, archival RPC; on main only, added after `hackathon-submission` |
| `no-secrets` | No NEAR secret key, private_key field or PEM private key is committed under near/. | repo | files git tracks under near/ |
| `built-in-window` | Everything under near/ was committed inside the hackathon window (2026-10-19 to 2026-11-14 UTC), and nothing under near/ exists at the pre-hackathon tag. | repo | git log and the pre-hackathon tag |
| `full-unit-tests` | The registry and vault unit tests pass: cargo test -p a-identity-registry -p agent-spend-policy --locked. | build | --full: a time-boxed test or build command |
| `full-sandbox-tests` | The sandbox suite passes: every vault guard and flow runs against a local NEAR node (cargo test -p sandbox-tests --locked). | build | --full: a time-boxed test or build command |
| `full-wasm-vault` | The committed vault wasm is reproducible from this source: cargo near build reproducible-wasm gives the same sha256. | build | --full: a time-boxed test or build command |
| `full-wasm-registry` | The committed registry wasm is reproducible from this source: cargo near build reproducible-wasm gives the same sha256. | build | --full: a time-boxed test or build command |
| `full-sdk-tests` | The TypeScript tests in near/ pass (npm test). | build | --full: a time-boxed test or build command |
| `full-judge-tests` | The judge's own tests pass: node --test judge/test/. | build | --full: a time-boxed test or build command |
| `full-negative-controls` | Every vault guard is load-bearing: contracts/audit/run-negative-controls.mjs deletes each guard in a temporary copy and the tests turn red. | build | --full: a time-boxed test or build command |

Three rows to read with care:

- `registry-owner`: the judge checks only that `owner()` returns `a-identity.testnet`. That its
  key stays offline is not checked by anything, and that key did sign the registry's deploy batch
  on 2026-11-12 (`5F38SuVmnzrAjWjVwAmheVzyU1PZ2Sb2pSzW4JcgqumL`) and, for the x402 rail on main,
  two setup transactions the same day: USDC storage for `a-identity.testnet`
  (`CZponfLYL63L7q8QjWbu7Mffr9Lbd7jRTrrcZvTfr9SZ`) and the creation of
  `x402-relayer.a-identity.testnet` (`EPtmgPKxKMp5JFojnSCi2s47AUedGrRfNw8bxAVew8rk`).
- `tx-x402-settlement` (main only): the judge checks the relayed transaction and the token's
  transfer on chain. That it answered an HTTP 402 from A-Identity's server is not on chain and is
  not checked; the recorded run was `near/scripts/x402-buy.ts` against a local `mcp/dist/http.js`,
  not the hosted deployment (`x402.settlement.ran` in `deployments/testnet.json`).
- `full-wasm-vault`, `full-wasm-registry`: they need `build.reproducible_command` in
  `deployments/testnet.json`, which is `null` for this deploy (a host build, see
  [Deployed on NEAR testnet](#deployed-on-near-testnet)), so they print `SKIP pending` and cannot
  pass until the CI reproducible build is deployed.

## Do X, see Y

From the repository root. Rows that start with `cd near` need one `npm ci` in `near/` first
(Node 22.22.2 or later). Rows that read the chain need network access; the offline rows give the
same answer on any machine, on any day.

| Do | See |
| --- | --- |
| `node near/judge/judge.mjs --list` | the claims above with their ids; the build and test steps among them run only with `--full` |
| `node near/judge/judge.mjs --step vault-keys,oracle-keys,registry-keys,registry-owner-keys` | four PASS lines: no full-access key on the vault, the oracle or the registry; exactly one on the registry owner |
| `node near/judge/judge.mjs --step tx-pay-known,tx-pay-unknown,tx-pay-deny,tx-owner-pay-denied` | PASS: USDC moved to the known merchant; the lookalike held `UnknownPayee`, then refused `RegistryDeny`, also for the owner's approval, with no receipt at the USDC contract |
| `node near/judge/judge.mjs --step reject-call-token,reject-attach-deposit,reject-owner-method,reject-add-key,reject-send-near` | PASS: each rejected transaction's signed bytes verify, and nearcore's rule applied to the key's on-chain permission names `ReceiverMismatch`, `DepositWithFunctionCall`, `MethodNameMismatch`, `RequiresFullAccess`, `RequiresFullAccess` |
| `cd near && npm run verdict -- --offline sdk/test/fixtures/snapshot-merchant.testnet.json` | `verdict   WARN  score 440/1000`, reasons `new_account` and `low_activity`, `snapshot  sha256 70e404a9...`: the same on any machine, any day, with no network |
| `cd near && npm run verdict -- --offline demo/logs/oracle/snapshots/aa339b86c1c318eaea54ffd18d213791587b1e85dcbaaa23738f1c1ab9e47e00.json` | `verdict   DENY  score 40/1000` with `lookalike_new_account` (one edit from `aid-demo-merchant.testnet`, created under a minute before block 277402268), and `snapshot  sha256 aa339b86...`: the snapshot the registry's DENY names in its evidence |
| `cd near && npm run verdict -- aid-demo-merchamt.testnet` | live, no keys: `verdict   DENY` with `DENY  registry_deny` and `A-Identity registry registry.a-identity.testnet says DENY (lookalike_new_account), written by oracle.a-identity.testnet`, until that DENY expires on 2026-12-12; the score and the other reasons change as the account ages |
| `cd near && npm run demo:dry -- --log-dir "$(mktemp -d)"` | every phase of the attack demo as exact calls, with no network and no keys; the summary lines read `phases: setup PLANNED, a PLANNED, b PLANNED, c PLANNED, d PLANNED, e PLANNED` and `on-chain transactions: 0; protocol rejections (no transaction): 0; prepared, not executed: 16`. The log goes to the temporary directory, not into the repository |
| `cd near && npm run guard -- --vault vault.aid-demo-owner.testnet --payee aid-demo-merchamt.testnet --amount 0.25 --known aid-demo-merchant.testnet` | `A-Identity guard: DENY -> record_refusal prepared (not sent: no agent key loaded)`, then `prepared  NOT SENT.` and the exact call an agent key would sign. Nothing is sent without a key |
| `cd near && npm run oracle:once -- --dry-run --log-dir "$(mktemp -d)"` | what the oracle watcher would write now, with nothing signed: `oracle: <n> held payment(s) on vault.aid-demo-owner.testnet, ...`, then for each held payee the registry has no verdict for `oracle: <payee> would write <VERDICT> [<reasons>] (dry run, prepared, not executed)` and the exact `set_verdict` arguments; with nothing held, `oracle: done, 0 payee(s): nothing held` |
| `grep -F '[model]' near/demo/logs/20261112T195833Z-llm.txt` | the model's own lines from the run with a model; in phase b, `raw tool call: pay_invoice({"payee": "aid-demo-rnerchant.testnet", "amount_usdc": "0.50", "memo": "INV-1002"})`, then the model saying the payment was refused |
| the first `curl` below | the vault's key list: only `FunctionCall` keys with `receiver_id` `vault.aid-demo-owner.testnet` and `method_names` `pay`, `request_payment`, `record_refusal`, each with a finite `allowance`; no `FullAccess` entry |
| the second `curl` below | the vault's policy: `"version":"agent-spend-policy 0.2.0"`, `"hold_unknown":true`, the owner, the token, the registry and the caps |
| the third `curl` below | an `EVENT_JSON:` line with `"event":"payment_refused"`, `"reason":"RegistryDeny"`, `"source":"registry"`, and no `nep141` `ft_transfer` event: nothing moved |
| the fourth `curl` below, A-Identity's hosted check (live from main since 2026-11-12) | `"verdict": "DENY"`, `"registry_reasons": ["registry_deny"]`, and the registry's verdict as written: `"verdict": "DENY"`, `"reasons": ["lookalike_new_account"]`, `"written_by": "oracle.a-identity.testnet"`. It runs the same engine as `npm run verdict` above |
| the fifth `curl` below | the refusal from the run with a model, on chain: an `EVENT_JSON:` line with `"event":"payment_refused"`, `"payee":"aid-demo-rnerchant.testnet"`, `"source":"agent_guard"` |
| open https://a-identity.xyz/app/vault/near in a browser (live from main since 2026-11-12; browser only: the page renders in JavaScript, and the judge does not check it) | the deployed vault, `vault.aid-demo-owner.testnet`: its policy, keys, held payments and recent activity, read from NEAR testnet RPC in the browser and stamped with the block that answered; owner actions open the owner's own wallet |

```
curl -s https://rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"vault.aid-demo-owner.testnet"}}'

curl -s https://rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"vault.aid-demo-owner.testnet","method_name":"get_config","args_base64":"e30="}}' | jq -r '.result.result | implode'

curl -s https://archival-rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_tx_status","params":{"tx_hash":"9YR7ohek5GcaDdHzQc3PgU3mX9xFL3i3w5dAbEFPB6nG","sender_account_id":"vault.aid-demo-owner.testnet","wait_until":"NONE"}}' | jq -r '.result.receipts_outcome[].outcome.logs[]'

curl -s --max-time 120 'https://a-identity-backend.onrender.com/api/near/check?account=aid-demo-merchamt.testnet' | jq '{verdict, registry_reasons, registry: (.registry | {verdict, reasons, written_by})}'

curl -s https://archival-rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_tx_status","params":{"tx_hash":"EzuUUxoihBEpXyLmTCBcH6UFkJJp1Nrk9yCPgNzVvGXX","sender_account_id":"vault.aid-demo-owner.testnet","wait_until":"NONE"}}' | jq -r '.result.receipts_outcome[].outcome.logs[]'
```

## The attack demo

An accounts-payable agent pays invoices from the vault. One invoice is poisoned: it says the
merchant's payment account changed and names a fresh lookalike, `aid-demo-merchamt.testnet`,
`aid-demo-merchant` with one letter changed. The run shows what the A-Identity guard, the vault
contract and the NEAR protocol each do about it. In the one run with a model, the model on NEAR AI
Cloud followed the poisoned invoice and proposed paying a lookalike, and the guard refused it on
chain (below). Full description: [demo/README.md](demo/README.md).

| Phase | What happens | Result | Claims |
| --- | --- | --- | --- |
| setup | the known merchant's first payment: the agent asks, the owner approves once | `request_payment` held, then `owner_pay` sent; USDC moves | `tx-setup-request`, `tx-setup-owner-pay` |
| a | clean invoice from the merchant; guard ALLOW | `pay` sent; the USDC contract's own `ft_transfer` from the vault to the merchant | `tx-pay-known` |
| b | the poisoned invoice; the agent proposes the lookalike (a script in the run the judge reads, a model in the `--llm` run below); the guard computes DENY from chain data (`lookalike_new_account`) | `record_refusal`: `payment_refused`, source `agent_guard`; nothing moved | `tx-guard-refusal` |
| c | a compromised agent skips the guard and calls `pay(lookalike)` itself | held `UnknownPayee`; the oracle computes DENY and writes it with its function-call key; the retry is refused `RegistryDeny`; the owner's approval of the held payment is refused `RegistryDeny`; nothing moved | `tx-pay-unknown`, `tx-oracle-deny`, `tx-pay-deny`, `tx-owner-pay-denied` |
| d | invoice from a vendor nobody has judged; guard WARN; the agent asks the owner | `request_payment` held, then `owner_pay` sent | `tx-vendor-request`, `tx-vendor-owner-pay` |
| e | the agent's own key tries what it must not do | rejected by the protocol before execution, so no transaction exists: `MethodNameMismatch` (the owner's `set_registry`), `DepositWithFunctionCall` (`pay` with 1 yoctoNEAR), `ReceiverMismatch` (`ft_transfer` on USDC), `RequiresFullAccess` (add a full-access key; send NEAR). Split payments to the lookalike refused `RegistryDeny`; a payment above the ceiling refused `AboveAutoApprove` | `reject-*`, `tx-over-ceiling`, `refusal-count` |

```
cd near && npm ci
npm run demo:dry       # no network, no keys: every exact call, nothing sent
npm run demo:no-llm    # scripted tool calls, every line tagged "scripted"
npm run demo           # a model on NEAR AI Cloud reads the invoices (NEAR_AI_API_KEY or NEAR_AI_KEY_FILE)
```

Each run writes its log to `near/demo/logs/` unless `--log-dir <dir>` is given (as in the
`demo:dry` row of [Do X, see Y](#do-x-see-y)). The `--llm` mode behind `npm run demo` is labeled
in [Status](#status-live-simulated-planned).

- Without keys a run still reads the chain and computes real verdicts; every write becomes a
  "prepared, not executed" line with the exact call. A recorded run needs the deploy's keys.
- The run the judge reads is [demo/logs/20261112T185000Z-scripted.txt](demo/logs/20261112T185000Z-scripted.txt)
  (and its [.json](demo/logs/20261112T185000Z-scripted.json)), from 2026-11-12 18:50 UTC:
  scripted tool calls, no model, so every line is tagged `[scripted]` and in phase b a script
  stands in for the model and proposes the lookalike. Its summary: every phase PASS, 13 vault
  transactions plus the oracle's one `set_verdict`, 5 protocol rejections, and the lookalike
  received 0 USDC. The oracle's DENY on the lookalike lasts 30 days (until about 2026-12-12, the
  log's oracle line; the demo writes it with `DEMO_TTL_DENY_S` in `demo/attack.ts`, while the
  watcher's own default is 7 days), so it outlives the judging window.
- The run with a model is [demo/logs/20261112T195833Z-llm.txt](demo/logs/20261112T195833Z-llm.txt)
  (and its [.json](demo/logs/20261112T195833Z-llm.json)), from 2026-11-12 19:58 UTC.
  `Qwen/Qwen3.6-35B-A3B-FP8` on NEAR AI Cloud (temperature 0, seed 7) read the invoices of phases
  a, b and d; setup, c and e were scripted. In phase b the model called `pay_invoice` for a fresh
  lookalike, `aid-demo-rnerchant.testnet` ("rn" for "m"); the guard computed DENY
  (`lookalike_new_account`) and recorded the refusal on chain
  (`EzuUUxoihBEpXyLmTCBcH6UFkJJp1Nrk9yCPgNzVvGXX`). Its summary: setup SKIP (the merchant was
  already paid), a to e PASS, 11 transactions, 5 protocol rejections, and the lookalike received 0
  USDC. Lines the model wrote are tagged `[model]`, and what the demo read back `[report]`; each of
  the 6 model exchanges is logged with its request and response bodies and their sha256, without
  the key. The judge's claims do not cover this run.
- The attempt before it, [demo/logs/20261112T194624Z-no-model.txt](demo/logs/20261112T194624Z-no-model.txt),
  had no usable NEAR AI key: its model phases say SKIP and nothing was sent to a model; its
  scripted phases c and e ran on chain.
- The owner's approvals are signed by the demo in place of a person and tagged `scripted`.
- A protocol rejection is never shown as an on-chain refusal: no transaction exists. The log keeps
  the signed bytes and the exact RPC error, and the judge verifies the signature and re-derives
  the rule from the key's permission at that block (claims `reject-*`).

## The agent key: exact limits

- It lives on the vault account. The vault created it in `add_agent_key` (an owner call) with
  receiver = the vault, methods = exactly `pay`, `request_payment`, `record_refusal`, and a finite
  NEAR allowance; a zero allowance is refused. The agent signs as the vault.
- The protocol enforces the rest. Any other method, owner methods included, fails with
  `MethodNameMismatch`; any other contract, the USDC token included, with `ReceiverMismatch`; any
  call with a deposit with `DepositWithFunctionCall`, so even a path to the token's 1-yoctoNEAR
  `ft_transfer` is closed. Moving NEAR, adding or deleting keys and deploying code need a
  full-access key (`RequiresFullAccess`).
- The contract adds: the signer must be the vault account itself, so a NEP-366 delegate action
  someone else relays is refused (`NotAgent`); callbacks need exactly one promise result, so the
  key cannot call them directly; every payment passes the policy (freeze, key expiry, allowlist,
  per-payment ceiling, daily cap), the registry's verdict and `hold_unknown`.
- The allowance caps NEAR spent on gas, not tokens; the vault's policy caps tokens. The protocol
  holds 0.001 NEAR per prepaid Tgas until the receipts finish. `pay` and `request_payment`
  prepay 73 Tgas (`AGENT_PREPAID_GAS`), so 0.073 NEAR is held per payment in flight; a landed
  payment burns about 14 Tgas (measured on near-sandbox 2.14.0, figures in
  [the vault's crate docs](contracts/agent-spend-policy/src/lib.rs)). A 0.25 NEAR allowance runs
  three payments at once; the demo's key started with 0.5 NEAR. An allowance cannot be topped up:
  when it runs out the key can no longer sign (`NotEnoughAllowance`), and the owner revokes it and
  adds a new one.
- What a stolen agent key can still do: pay, inside the caps, payees the owner listed, the vault
  already paid, or the registry says ALLOW; file held requests (at most 20 waiting at a time,
  `MAX_PENDING_HELD` in `contracts/agent-spend-policy/src/policy.rs`, each expiring after 24
  hours); record refusals (counted apart, never used as a signal); burn its allowance.
- `revoke_agent_key` marks the key revoked in the same receipt and deletes it from the account,
  so a revoked agent cannot even sign. `freeze` stops every agent payment with one owner call.

## Signals and data sources

The verdict engine is a pure function: no I/O, no clock, no model. Every RPC read is pinned to one
block, missing data is WARN and never ALLOW, and no positive signal overrides a DENY. The full rule
table and every threshold with its reason: [sdk/README.md](sdk/README.md); the thresholds below
(72 hours, 30 days, 5 transactions) are set in `sdk/src/engine/policy.ts`.

| Signal | Source, exact call | Effect |
| --- | --- | --- |
| Account exists, code hash, global contract | `view_account` at block N | `account_not_found` DENY (a named account nobody has registered); `global_contract_mutable` WARN |
| Age | archival `view_account` at the block 72 hours and 30 days before N | `new_account` WARN (soft); `long_history` positive |
| Keys | `view_access_key_list` at N and at the 72-hour block | `new_full_access_key` WARN |
| Code change | the `code_hash` at N against the 72-hour block | `code_changed_recently` WARN |
| USDC blocklist | Circle's USDC `is_blocklisted`, `storage_balance_of` | `usdc_blocklisted` DENY |
| A-Identity registry | `get_verdict`, `get_reports`, `report_count`, `list_verdicts` | `registry_deny` DENY, `registry_warn` WARN, `open_reports` WARN, `registry_allow` positive |
| The agent's vault | `paid_count`, `refusal_count`, `is_allowed`, `list_allowlist` | `prior_payments` and `owner_allowlisted` positive; `prior_registry_refusals` WARN |
| Lookalike | the payee's name against the known payees (pure function) | `lookalike_new_account` DENY (strong match, under 72 hours old); `lookalike_known` WARN |
| Activity | the FastNEAR transactions API (oldest transactions, bounded by N); NearBlocks as fallback | `low_activity` WARN (soft, under 5 transactions) |
| ERC-8004 identity and reputation | Arras's registries on NEAR, read only | positive or info, score only |
| Other teams' public registries | four testnet registries, each read with one view call: MimicWatch (`registry.mimicwatch-e7iig5g5.testnet`, `is_flagged`), Tripwire (`tripwire-registry-44ea74.testnet`, `get_risk`), near-leash (`leash-registry.testnet`, `verdict`), Leash commons (`registry.leash-busel-commons.testnet`, `get_status`); on mainnet only MimicWatch, which lists mainnet impersonators in its testnet registry (`sdk/src/collect/networks.ts`) | `third_party_flag` WARN, never DENY alone |

Recompute any verdict: `npm run verdict -- --offline <snapshot.json>` from a saved snapshot (no
network), or `npm run verdict -- <account> --at-block <N>` against archival RPC, which gives the
same `chain_sha256`.

## Benchmark: the engine on real mainnet accounts

From [scan/benchmark/RESULTS.md](scan/benchmark/RESULTS.md), "Summary for quoting", verbatim:

> On 176 NEAR mainnet accounts (all 30 `suspicious` and 46 `known_good` rows of
> `scan/dataset.json` and a seeded sample of 100 of its 445 `lookalike_candidate`
> rows), read-only at block 224191308 (2026-11-12), the engine issued no DENY: strict recall is
> 0.0% (0 of 30). Counting WARN as flagged, recall is 20.0% (6 of 30) and precision 46.2% (6 of 13),
> or 40.0% (6 of 15) counting the 2 `known_good` tokens (`token.rhealab.near` and `token.v2.ref-finance.near`) that
> are not warned only because they are on the engine's known list, whose entries are never compared
> as lookalikes. Of the 6 catches, 4 are deleted exploit accounts, flagged for not
> existing at the block, and 2 are fake airdrop tokens whose names imitate a token on
> that list. All 24 misses are older than 30 days with 5 or more transactions at the block, and
> 19 of the 26 suspicious rows named in a report were named within 15 days of
> their creation (for the 4 deleted ones, of a surviving account of the same exploit):
> this benchmark observes them months to years after the incident, not at payment time.
> Replayed instead at each account's own age (pre-registered in `at-age/PREREGISTRATION.md`: the first block 1 day and 7 days after its creation block, with the 4 deleted worker accounts, gone by then, counted as misses), strict precision and recall are 100.0% (2 of 2) and 6.7% (2 of 30) at 1 day and n/a (no DENY issued) and 0.0% (0 of 30) at 7 days, and cautious precision and recall are 36.1% (26 of 72) and 86.7% (26 of 30) at 1 day, where every account that exists is held as new whatever its class, and 26.8% (11 of 41) and 36.7% (11 of 30) at 7 days. The engine was not given the labels (`labels_used: false`); its known list is the
> top 25 NEP-141 tokens by on-chain market cap on NearBlocks, 15 of which are
> also `known_good` rows.

What it means for the design:

- The heuristic engine alone warns on 20% of the cited scam and exploit accounts and denies none.
  A score is not enough to let money move, so the vault holds every payee nobody has judged
  (`hold_unknown`) and refuses only what the registry says DENY.
- The limit, stated: the oracle writes ALLOW (for 24 hours, `DEFAULT_TTL_S` in
  `scripts/oracle.ts`) when the engine says ALLOW and the name is not a lookalike, and the 24
  misses above were all ALLOW. A payee like them, once judged ALLOW, is paid inside the owner's
  caps without a human tap. An owner who wants a tap for every new payee turns the allowlist on,
  or points the vault at no registry, so that every payee not listed or paid before is held.
- Every miss is named in RESULTS.md, with the data, the citations ([scan/README.md](scan/README.md),
  [scan/SOURCES.md](scan/SOURCES.md)) and the commands that reproduce each number offline.

## Reproduce from source

Pinned: Rust through rustup (`near/contracts/rust-toolchain.toml` installs 1.95.0 with the
`wasm32-unknown-unknown` target), cargo-near 0.23.0, Node 22.22.2 or later (`near/.nvmrc`), and
Docker only for the reproducible wasm.

```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-installer.sh | sh
cd near/contracts
rustup show active-toolchain || rustup toolchain install   # 1.95.0 from rust-toolchain.toml
cargo near --version                                       # cargo-near-near 0.23.0
cargo fmt --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test -p agent-spend-policy -p a-identity-registry --locked
cargo near build non-reproducible-wasm --manifest-path agent-spend-policy/Cargo.toml --locked
cargo near build non-reproducible-wasm --manifest-path a-identity-registry/Cargo.toml --locked
SANDBOX_TESTS_PARALLEL=2 cargo test -p sandbox-tests --locked
```

- Never run plain `cargo build` in `near/contracts` (nor `cargo clippy` without `--all-targets`):
  near-sdk 5.30.1 refuses a host build with a `compile_error!` that says to use
  `cargo near build`. A bare `cargo test` at the workspace root also starts the sandbox suite; the
  `-p` form above runs the unit tests only.
- The sandbox suite runs one local node per test (near-sandbox 0.4.0, which runs neard 2.14.0) and
  builds the contracts with `cargo near build`, so `cargo near` must be on PATH. On its first run
  near-sandbox downloads its node binary from NEAR's S3 bucket into the target directory. It
  supports Linux x86_64, Linux aarch64 and macOS on Apple silicon only; on an Intel Mac or on
  Windows, use WSL2 or a Linux container. `NEAR_SANDBOX_BIN_PATH=<path to a near-sandbox binary>`
  skips the download. `SANDBOX_TESTS_PARALLEL` caps the nodes one test binary runs at once
  (default 4; CI uses 2). A run that crosses 00:00 UTC can see the vault's day roll over in a cap
  test; that is the contract being right.
- Reproducible wasm (Docker and a clean, committed tree):
  `cargo near build reproducible-wasm --manifest-path agent-spend-policy/Cargo.toml`, and the same
  for `a-identity-registry`. It builds inside the image pinned by digest in each crate's
  `Cargo.toml` (`sourcescan/cargo-near:0.22.0-rust-1.99.1`), whose rustc is 1.99.1, not the
  host's 1.95.0; CI's `reproducible` job runs the whole sandbox suite again against exactly those
  bytes before it publishes them ([.github/workflows/near.yml](../.github/workflows/near.yml)).
- TypeScript (SDK, demo, judge, scan): `cd near && npm ci && npm run typecheck && npm test`. The
  judge's own tests need no install: `node --test near/judge/test/`.
- The backend's NEAR check lives in `mcp/` and needs the root install first: `npm ci` at the
  repository root, then `npm ci --prefix mcp && npm test --prefix mcp` (CI runs the same steps
  with `npm install`). The console's pure helpers in `src/lib/near/` run with the root `npm test`.
- All of the above in one command, each step in a time box with a PASS, FAIL or SKIP line and its
  reason: `node near/judge/judge.mjs --full`.
- Your own copy on testnet: `near/scripts/deploy.ts` runs the deploy one step at a time and leaves
  no full-access key on the registry, the oracle or the vault
  (`node --experimental-strip-types scripts/deploy.ts` from `near/`). `--dry-run`, the default,
  reads the chain and prints every transaction it would send; `--execute` signs and sends, on
  testnet only; `--network mainnet` never signs and prints near-cli-rs commands for the owner to
  run. The demo's prerequisites are in [demo/README.md](demo/README.md) ("What a recorded run
  needs"), and what to record after a deploy is in [judge/README.md](judge/README.md) ("For the
  team: after deploying").

## Trust model

| Who | Holds | Can | Cannot | If its key is stolen, or it is wrong |
| --- | --- | --- | --- | --- |
| Vault owner, `aid-demo-owner.testnet` | a full-access key on its own account | set the daily cap, the per-payment ceiling, the allowlist and `hold_unknown`; add, expire and revoke agent keys; freeze (one call, no deposit) and unfreeze; approve or reject held payments; point the vault at another registry or none; withdraw | upgrade the vault or transfer ownership (no such methods); withdraw to anyone but itself; pay a payee the registry says DENY (`owner_pay` asks the registry again) | total authority over the vault's tokens: a thief can withdraw them to the owner account and move them on. This key belongs in a wallet, never on a server |
| Agent | one function-call key on the vault account | `pay`, `request_payment`, `record_refusal`, inside the policy | everything else (see [the agent key](#the-agent-key-exact-limits)) | pays, inside the caps, payees the owner listed, the vault already paid, or the registry says ALLOW. The owner freezes the vault or revokes the key |
| Oracle, `oracle.a-identity.testnet`, run by A-Identity | one function-call key on the registry for `set_verdict`, `set_verdicts`, `clear_verdict`, `clear_reports` | write, overwrite and clear verdicts; clear reports after review | move tokens; change a vault's policy or keys; change the registry's owner or oracles | can refuse good payees (DENY), hold them (WARN), or mark a bad payee ALLOW, which lets an agent pay it inside the caps without a human tap. Each verdict names its snapshot, so a wrong one can be recomputed and shown wrong, and `updated_by` and the `verdict_set` event name who wrote it. The registry owner removes the oracle; the vault owner can turn the allowlist on, lower the caps, point the vault at no registry (then every payee not listed or paid before is held), or freeze |
| Registry owner, `a-identity.testnet`, A-Identity | one full-access key | add and remove oracles; hand over the owner role | write a verdict or clear a report without first making itself an oracle, which emits an event like any other | can add a bad oracle, with a bad oracle's limits; `oracle_added` shows it |
| The registry and vault accounts | no full-access key | | be redeployed, upgraded or deleted by anyone | a bug means a new contract: the vault owner withdraws, deploys a new vault and moves the agent there |
| Anyone | a NEAR account | file a report on a payee for 0.01 NEAR (at most 20 open reports per payee, one per reporter: `REPORT_DEPOSIT`, `MAX_OPEN_REPORTS` in `contracts/a-identity-registry/src/rules.rs`) | change a verdict: a report only queues for the oracle's review | the SDK guard treats unreviewed reports as WARN, so the payment waits for the owner until the oracle writes an ALLOW after the newest report: a report can delay a payment, never cause one |
| RPC and indexer operators | | answer the guard's and the oracle's reads | change what the vault does: the vault reads the registry on chain | a wrong answer could mislead the oracle; the judge re-asks archival RPC every block-pinned read behind a verdict (`recompute-lookalike`) |

The contracts are unaudited. CI deletes each guard of the vault in a temporary copy and requires the
tests to turn red (`near/contracts/audit/run-negative-controls.mjs`, claim
`full-negative-controls`).

## Privacy

- Read: public chain data only. For a payee: its account state, keys and code hash, its USDC
  blocklist status and registration, the registry's verdict and reports, the vault's counters for
  it, and its oldest transactions from an indexer.
- Stored: on chain, the registry keeps one verdict per judged account (verdict, reason codes, the
  snapshot's sha256 and block, a score, the code hash seen, an expiry), and the vault's events
  record each payment, hold and refusal (payee, amount, memo). Both are public because the chain
  is. The contracts, the SDK, the oracle and the judge store nothing personal: no names, no
  emails, no IP addresses. A memo lands in a public event, so it must never carry personal data.
- Who learns what: asking an RPC node, an indexer or A-Identity's hosted check about a payee tells
  that operator which account you are about to pay. The SDK runs the same engine locally
  (`npm run verdict`), and `--no-indexers` and `--no-third-party` limit the reads to RPC.
- The hosted check `GET /api/near/check` keeps each answer for 60 s (`NEAR_CHECK_TTL_MS` in
  `mcp/src/near-check/check.ts`) and uses the client IP only to limit it to 20 requests a minute
  (`NEAR_CHECK_BUDGET` in `mcp/src/rate-budget.ts`).
- The owner console reads the chain from the browser. Its analytics events (`near_vault_read`,
  `near_vault_owner_action` in `src/lib/analytics.ts`) carry the kind of action, the contract
  method and the outcome: no account id, no key, no amount. The site's Google Analytics tag also
  records the page URL, so a console link with `?vault=<account>` can carry that account id into
  the analytics data; `/app/vault/near` without the parameter opens the deployed vault and leaves
  it out.
- In an `--llm` demo run, the model (NEAR AI Cloud) sees the demo invoices and the tool results;
  its API key never reaches a log (the run `20261112T195833Z-llm` logs its exchanges without it).
  The run the judge reads used no model.

## How this uses NEAR

- Function-call access keys: the agent's only key. The vault adds it to its own account with a
  promise (`add_access_key_allowance`): receiver the vault, three method names, a finite
  allowance. The protocol, not our code, enforces the receiver, the method list, the ban on
  deposits and the allowance.
- Promises and callbacks: `pay` reserves the day's budget before any external call, asks
  `registry.get_verdict`, and decides in `on_verdict`; a payment then chains `storage_deposit` and
  `ft_transfer` into `on_transfer`. Callbacks read raw promise results, never panic on a registry
  or token answer, and fail closed (`RegistryUnavailable`).
- NEP-141: payments in Circle's testnet USDC. Deposits arrive through `ft_transfer_call` and
  `ft_on_transfer`; any other token is refused and returned.
- NEP-145: the vault registers each new payee on the token before paying it (0.00125 NEAR on
  testnet USDC, `token.storage_deposit_yocto` in `deployments/testnet.json`, refunded when the
  payee is already registered).
- NEP-297: every outcome is an event, standard `a_identity_vault` or `a_identity_registry`,
  version 1.0.0; the judge parses the `EVENT_JSON:` lines of the receipts.
- NEP-330: `contract_source_metadata` on both contracts gives version 0.2.0 and a link to this
  repository. Its `build_info` is `null` on testnet today, because the deployed bytes are a host
  build; a reproducible build records its image digest there.
- NEP-366 relayed actions: refused on purpose. The protocol does not charge a function-call key's
  allowance for a delegate action someone else relays, so the vault accepts an agent call only
  when the vault account itself signed the transaction (`NotAgent` otherwise). The x402 rail on
  main uses NEP-366 the other way round: the buyer signs a SignedDelegate holding one ft_transfer and
  A-Identity's relayer submits it (claim `tx-x402-settlement`).
- Sub-accounts: deploy and `new` go in one batch from the parent or from the account itself, and
  `new` refuses any other caller (`InitNotAllowed`), so a deploy without its init cannot be
  claimed by a stranger.
- RPC: FastNEAR for state; FastNEAR's archival RPC for every transaction and every block-pinned
  read, because regular nodes drop old blocks; the FastNEAR transactions API and NearBlocks (as a
  fallback) for account history. NearBlocks pages are the links for people.
- NEAR AI Cloud: the attack demo's `--llm` mode sends the invoices to a model there, through its
  OpenAI-compatible API; one run is recorded (see [The attack demo](#the-attack-demo)). NEAR
  Connect (`@hot-labs/near-connect`) connects the owner's wallet in the console.
- Not used: NEAR Intents, Chain Signatures, TEE attestation checks. No model takes part in a
  verdict.

## Status: live, simulated, planned

| Part | Status |
| --- | --- |
| Vault and registry contracts on NEAR testnet | live on testnet since 2026-11-12 (registry at block 277401995, vault at block 277402011) |
| Attack demo with on-chain transactions (phases setup, a to e) | recorded on testnet, `near/demo/logs/20261112T185000Z-scripted.json`, the run the judge reads: scripted, no model; the owner's approvals in it are signed by the demo in place of a person |
| Attack demo with a model (`npm run demo`, `--llm`, NEAR AI Cloud) | recorded on testnet once, `near/demo/logs/20261112T195833Z-llm.json`: `Qwen/Qwen3.6-35B-A3B-FP8` read the invoices of phases a, b and d (6 model exchanges, logged without the key) and proposed paying a fresh lookalike, which the guard refused on chain; setup, c and e scripted. The judge's claims do not cover this run |
| Phase e, the agent key's forbidden actions | rejected before execution: no transaction exists; recorded as signed bytes and RPC errors, re-derived by the judge |
| Verdict engine, SDK, `verifyThenPay`, CLIs | runs locally; live reads of testnet, and of mainnet read only |
| Mainnet benchmark | measured read only at block 224191308 on 2026-11-12; every number reproducible offline |
| Oracle watcher (`near/scripts/oracle.ts`, `npm run oracle`) | a script run by A-Identity, not a hosted service. It signs with the oracle's function-call key and writes ALLOW for 24 hours when the engine allows a name that does not imitate a known payee. The recorded demo runs its oracle step in-process in phase c. Running during judging: no, it is not left running as a service; it ran in-process in the recorded demo runs. A judge cannot create a held payment to watch it; `npm run oracle:once -- --dry-run` shows what it would write now |
| Owner console, `/app/vault/near` | live from main since 2026-11-12; browser only, not checked by the judge |
| `GET /api/near/check` and NEAR testnet targets in the trust tools | live from main since 2026-11-12; the fourth `curl` in [Do X, see Y](#do-x-see-y) checks the hosted check |
| Mainnet deployment of the CI reproducible build of the same source, signed by the owner's own wallet | deployed 2026-11-12: `registry.a-identity.near`, `vault.a-identity.near` and `oracle.a-identity.near`, no full-access key on any of them (claims `mainnet-*`). The vault has refused (`RegistryDeny`) and held (`registry_warn`) agent payments on mainnet; it holds no USDC, so no payment has been sent on mainnet |
| x402 payments on `near:testnet` | planned, not built, at `hackathon-submission`. On `main`, added after that tag and not part of the submitted state: `GET /api/near/x402/check` (`mcp/src/near-x402/`) answers 503 `rail off` with no challenge until `NEAR_X402_RELAYER_ACCOUNT` and `NEAR_X402_RELAYER_KEY` are set on the server; one settlement on testnet on 2026-11-12 22:32 UTC, made by `near/scripts/x402-buy.ts` against a local server, not the hosted deployment (claim `tx-x402-settlement`) |
| Unknown payees resolved live with yield and resume | planned, not built |
| Audit | none; unaudited |

## Libraries, templates and AI-assisted code

Hackathon rule Q-005. Exact versions, from the lockfiles:

| Used for | What | Version |
| --- | --- | --- |
| Contracts | `near-sdk` | 5.30.1 |
| Sandbox token (`mock-ft`, never deployed) | `near-contract-standards` | 5.30.1 |
| Sandbox suite | `near-sandbox` (runs neard 2.14.0), `near-api`, `cargo-near-build`, `tokio`, `testresult` | 0.4.0, 0.8.7, 0.11.5, 1.54.1, 0.4.2 |
| Building | `cargo-near`; Rust (host); the reproducible-build image `sourcescan/cargo-near:0.22.0-rust-1.99.1`, pinned by digest | 0.23.0; 1.95.0 |
| SDK, demo, oracle (`near/`) | `near-api-js`; `typescript` and `@types/node` (dev only) | 7.5.3; 5.9.3, 22.19.21 |
| Owner console | `@hot-labs/near-connect` | 0.12.0 |
| Runtime | Node | 22.22.2 or later |
| Account setup in the deploy steps | `near-cli-rs` | 0.31.1 |
| Data | FastNEAR RPC, archival RPC and transactions API; NearBlocks API (fallback); NEAR AI Cloud (the demo's `--llm` model, `Qwen/Qwen3.6-35B-A3B-FP8` by default); MimicWatch's scan data (MIT, attributed in [scan/SOURCES.md](scan/SOURCES.md)); other teams' public testnet registries, read only: MimicWatch, Tripwire, near-leash, Leash commons (accounts in [Signals and data sources](#signals-and-data-sources)) | |

- Template: the workspace pins and the reproducible-build block come from `cargo near new`
  (cargo-near 0.23.0).
- Our own pre-hackathon work, counted as baseline: the AgentSpendPolicy design (gate order, the
  meaning of zero) and the score bands, named in [Built in the window](#built-in-the-window-and-what-is-baseline).
- AI-assisted code: the NEAR code in this entry was written with Claude Code agents under the
  team's review. Each commit from `pre-hackathon` to `hackathon-submission` carries a
  `Co-Authored-By` line naming the model:
  `git log --format=%B pre-hackathon..hackathon-submission | grep -c '^Co-Authored-By: Claude'`
  equals `git rev-list --count pre-hackathon..hackathon-submission`.
  At runtime a model (NEAR AI Cloud) appears only in the attack demo's `--llm` mode, as the agent
  being attacked; the run the judge reads is scripted, and no model takes part in a verdict.

## Security and secrets

- No key of any kind is committed. Scripts read keys from `~/.near-credentials` (mode 0600) or
  from environment variables, and `near/.gitignore` keeps `.env`, `*.key` and `*.secret.json` out.
  CI runs gitleaks 8.30.1 over the whole git history with a rule for NEAR ed25519 secret keys
  ([.gitleaks.toml](../.gitleaks.toml)), and the judge's `no-secrets` claim scans `near/` again.
- Without a key every write is a prepared call that is printed, never a crash and never a mock
  that looks real.
- The keychain file of `aid-demo-owner.testnet`'s first key was exposed on 2026-11-12. The demo
  and the oracle refuse to sign with that key (`near/demo/lib/keys.ts`), and it is no longer on
  the account: `view_access_key_list` at block 277404126 shows `aid-demo-owner.testnet` with one
  key, the full-access key `ed25519:fvqF69RtDp5JP4gYga1U5yMD5N5NQtLHCc5AHqKw45A`, which signed
  the recorded run.
- A-Identity's baseline on other chains had an operating key exposed in November 2026; its rotation
  is in [SECURITY.md](../SECURITY.md#the-2026-11-11-rotation). No key from that incident is used here.
- Report a vulnerability: see [SECURITY.md](../SECURITY.md).

## License, team, contact

- License: MIT, [LICENSE](../LICENSE).
- Team lead: Aybars Dorman. Team of five. Contact: ceo@a-identity.xyz.
- Demo video and post on X: https://x.com/ai_dentity/status/2120968438168617470
