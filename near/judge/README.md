# Zero-key judge

One command turns every claim in the NEAR README's claims table into a `PASS`, `FAIL` or `SKIP`
line, from public chain data only. No keys, no accounts, no `npm install`: Node built-ins only, tested on
Node 22, 23 and 24. It never signs or sends a transaction. The verdict recompute and the judge's
own tests run TypeScript with type stripping, so those two need Node 22.6 or later; on an older
Node the recompute is a `SKIP` that says so.

## Run it

```
cd near
node judge/judge.mjs                  # online: views from NEAR RPC, every transaction from archival RPC
node judge/judge.mjs --offline        # no network: replays the committed evidence/*.json
node judge/judge.mjs --verify-evidence  # re-asks archival RPC every recorded question at its recorded block
node judge/judge.mjs --full           # also: cargo unit tests, sandbox suite, npm test, judge tests, negative controls
node judge/judge.mjs --step vault-keys,tx-pay-deny   # just these claims or steps
node judge/judge.mjs --list           # the claims table
node judge/judge.mjs --json           # the report on stdout
node --test judge/test/               # the judge's own tests (81, about 13 s; they start local fake RPC servers)
```

`npm run judge`, `npm run judge:offline` and `npm run judge:full` in `near/` run the same commands.
Exit status: 0 when nothing failed, 1 when a claim failed, 2 on a usage or setup error. Ctrl-C stops
a running `--full` step and its whole process group before the judge exits (status 130).

## Reading the output

```
NOTE testnet: state RPC rpc.testnet.fastnear.com at block 277306701, archival RPC archival-rpc.testnet.fastnear.com at block 277306701
PASS account-oracle oracle.a-identity.testnet, the oracle that writes verdicts, exists on NEAR testnet. (view_account at block 277306715: 2.0000 NEAR, no contract; 0.11 s)
SKIP vault-keys The vault account holds no full-access key: ... (pending: keys.vault.agent.public_key is not recorded in deployments/testnet.json yet; 0.00 s)
JUDGE: 13 PASS, 0 FAIL, 30 SKIP (mode=online, 10.4 s)
```

- One line per claim: `PASS|FAIL|SKIP <id> <claim text> (<evidence or reason>; <seconds> s)`.
  The claim text is the README sentence, word for word, from `judge/claims.json`.
- `FAIL` means the check ran and the chain or the code disagreed with the claim.
- `SKIP` always carries its reason: `pending` (not deployed or not recorded yet), `network` (RPC
  unreachable and no evidence to replay), a missing tool, an unsupported platform, or a step that
  did not finish in its time box. A SKIP is never counted as a pass.
- The last line is the count. `judge/judge-report.json` (git-ignored) holds every check with what
  was expected and observed, every RPC call with its block, explorer links for humans, and a
  `curl` per call, pinned to the recorded block on archival RPC, so any answer can be re-asked by
  hand.

## When the network does not answer

Before judging, the default run probes the state RPC and the archival RPC of each network it needs
(a `status` call, 8 s, two tries per endpoint for rate limits). The claims of a network that does
not answer are re-derived from the committed evidence instead, and both the `NOTE` line and each
claim's line say `replayed evidence`; the other network is still judged live. If a network stops
answering mid-run (a rate limit that does not clear), that claim and the network's remaining claims
replay evidence the same way, so one dead host cannot eat the two-minute budget. A host that times
out once is not asked again in that run. A rate-limited endpoint hands the question to the next
endpoint at once; only the last one is waited out with backoff. A node that no longer keeps a block
(`GARBAGE_COLLECTED_BLOCK`) passes the question on too: that is a fact about the node, not an
answer about the chain. `--no-fallback` turns replay off: those claims are `SKIP network` instead.
`--offline` never touches the network.

## What each check type proves

| check | reads | PASS means |
| --- | --- | --- |
| `account_exists` | `view_account` | the account exists (or, with `exists: false`, does not); optionally that it runs a contract |
| `code_hash_matches_committed_wasm` | `view_account` + the committed wasm | the on-chain `code_hash` is base58(sha256) of the wasm in this tree, and equals what `deployments/testnet.json` records |
| `access_keys` | `view_access_key_list` | the exact key shape: how many full-access keys, how many function-call keys, and every function-call key's receiver, exact method set (an empty list means ANY method and fails) and finite allowance |
| `view_equals` | `call_function`, at `final` or at a recorded block (archival) | a view returns what the claim says (subset match on objects, exact on arrays and scalars) |
| `tx_outcome` | `EXPERIMENTAL_tx_status` + `block` on archival RPC | final, signer and key, method, return value, a NEP-297 event with fields (exactly once), and the presence or ABSENCE of a NEP-141 `ft_transfer` to a payee executed by the token with a successful receipt; optionally that no receipt reached the token at all |
| `counter_matches_events` | a vault counter at a recorded block + every demo transaction on archival RPC | the counter equals, exactly, the matching events in the demo's transactions (those `deployments/testnet.json` lists and those in the cited demo log), each executed at or before that block. A counter that counts something else is larger than its events; a transaction left out of the record makes the events fewer. Both FAIL |
| `protocol_rejection` | the attack demo log + `view_access_key` at the block the transaction names | the signed bytes decode and their Ed25519 signature verifies, everything the log says about them (`local_tx_hash`, signer, key, receiver, nonce, block) is what the bytes say, the recorded RPC error names the rule, and nearcore's own rule applied to that key's on-chain permission gives the same rule |
| `verdict_recompute` | `sdk/src/cli/verdict.ts --offline <snapshot> --json`, `get_verdict` at a recorded block, and every block-pinned read in the snapshot on archival RPC | anyone can recompute the registry's verdict and reasons from the snapshot, the registry's evidence string names that snapshot, and the snapshot is the chain: each recorded JSON-RPC answer is what archival RPC gives at the same block (a read the oracle could not make is listed, indexer answers are not pinned to a block and are not re-asked) |
| `repo_secret_scan` | files git tracks under `near/` (the file tree in a download without git) | no NEAR secret key, no `private_key` field, no PEM private key. A 64-byte `ed25519:` value is a secret key only if its first 32 bytes derive its last 32 (seed, then public key); a transaction signature never does, so recorded signatures are not reported |
| `git_window` | `git log`, the `pre-hackathon` tag | every commit touching `near/` is dated inside the window and nothing under `near/` exists at the tag (git dates are self-reported). Without the tag (a clone that did not fetch tags) it is `SKIP`, never a half-checked PASS; a commit outside the window is still `FAIL` |
| `command` (`--full`) | a time-boxed child process | the test command exits 0 with at least one test and no failures; a reproducible rebuild has the committed sha256. A step that outlives its time box is `SKIP` (raise it with `--timeout-s`) |

## Pinned reads and current state

Two kinds of claims read the chain differently, on purpose.

- Pinned to a recorded block (archival RPC), so every judge on every later day gets the same
  answer: the lookalike's registry verdict and its recomputation (`verdicts.lookalike.read_block`;
  the oracle writes a DENY with a TTL, and `get_verdict` returns nothing once it expires), and the
  vault's counters (`demo.state_block`; a later demo run would move them).
- Current state at finality `final`: `vault-keys`, `oracle-keys`, `registry-keys`,
  `registry-owner-keys`, `vault-config`, `registry-oracles`, `registry-owner`. These are claims
  about how the system stands now, so they assume the owners do not freeze, re-key or re-policy
  the vault, or change the registry's oracles, after capture. If they do, the online judge FAILS
  the claim while `--offline` still replays the captured state; that difference is the point.

## Why the offline replay is honest

`node judge/capture.mjs` runs every chain-reading claim live and writes `evidence/<id>.json`: the
raw JSON-RPC request and response, the RPC URL, the block height and hash the answer was read at,
and the time. `--offline` runs the same check code with a transport that answers from that file.
Nothing is pre-digested, so an offline PASS is re-derived from what the chain said. A request the
file cannot answer (the claims or deployments changed after capture) is `FAIL stale evidence`, and
once `deployments/testnet.json` says `deployed`, a claim with no evidence is a `FAIL` too. Capture
itself exits 1 when a claim whose fields are filled in could not be recorded (`NOT CAPTURED`), so a
claim cannot quietly go without evidence. `--verify-evidence` re-asks archival RPC each recorded
call at its recorded block and compares the answers, so a doctored evidence file does not survive
contact with the chain. Transaction signatures are stored as `ed25519-signature-sha256:<hex>`
because the repository's CI secret scanner (`.gitleaks.toml`) treats every 64-byte ed25519 value as
a key; no check reads them.

## Pending is SKIP, never PASS

Claims never hardcode a deployed fact. They name a field of `deployments/testnet.json` as
`${contracts.vault.account_id}`; a field that is still `null` makes the claim pending and the line
says which field. `${?path}` marks a field that may stay null.

## For the team: after deploying

1. Build, then `node judge/wasm-hash.mjs <wasm>` and copy the wasm and its numbers into
   `deployments/wasm/` and `deployments/testnet.json` (see `deployments/README.md`).
2. Lock the accounts: the vault keeps no full-access key, and the oracle's full-access key is
   deleted after its function-call key on the registry is added (`oracle-keys` FAILS otherwise).
3. Fill every field the deploy and demo produced: accounts, `code_hash`, keys, policy, verdicts
   (with `read_block`), every demo transaction hash, `demo.log`, `demo.state_block`.
4. `node judge/judge.mjs` until every claim you keep is PASS. Delete claims the demo will not
   produce rather than leaving them pending.
5. `node judge/capture.mjs` (it must end with `0 FAIL, 0 NOT CAPTURED`), set `"status": "deployed"`,
   commit `evidence/`, then check `node judge/judge.mjs --offline` and `--verify-evidence`.
6. Push the `pre-hackathon` and `hackathon-submission` tags with the merge, or `built-in-window`
   stays `SKIP` in every clone.

## Interfaces other parts fill

- Attack demo log (`demo.log`, `demo/logs/<run-id>.json`, written by `demo/attack.ts`). The five
  `reject-*` claims set `require_signed_tx`: each rejection must keep the bytes it sent
  (`signed_tx_base64`, as `demo/lib/log.ts` `SignedBytesRecord` defines it, or the exact `request`
  body). The judge verifies the Ed25519 signature, checks `local_tx_hash`, `signer_id`,
  `public_key`, `receiver_id`, `nonce` and `block_hash` against the bytes, reads the key's
  permission from archival RPC at the block the transaction names, and re-derives nearcore's rule;
  an entry with `rule_matched: false` FAILS. Without the bytes the claim FAILS: a log line alone is
  not re-derived. `demo.rejections.<name>.entry` is the entry's `id` or `attempt`. The counters
  also read the log's `txs` list (`tx_hash`, `signer_id`) to find every transaction of the run.
- SDK verdict CLI (for `verdict_recompute`): `node --experimental-strip-types
  sdk/src/cli/verdict.ts --offline <snapshot> --json`, no network and no npm package on that path.
  The judge reads `account`, `verdict`, `registry_reasons` (compared with the registry's
  `reasons`), `snapshot_sha256` and `evidence`, and the snapshot's own `rpc` reads
  (`sdk/src/engine/types.ts` `RpcRecord`: `method`, `params` with `block_id`, `result` or `error`,
  `projection`). The oracle (`scripts/oracle.ts`) writes that same `evidence` string,
  `near-snapshot sha256:<hex> block:<height> engine:<version>`, into the registry verdict and saves
  the snapshot as `demo/logs/oracle/snapshots/<sha256>.json`; with `require_snapshot_binding` the
  on-chain verdict must name exactly the snapshot the CLI recomputed.

## Endpoints and limits

- Testnet: `rpc.testnet.fastnear.com` (fallback `near-testnet.drpc.org`), archival
  `archival-rpc.testnet.fastnear.com`. Mainnet (read-only signals): `rpc.mainnet.fastnear.com`
  (fallback `free.rpc.fastnear.com`), archival `archival-rpc.mainnet.fastnear.com`. Override with
  `JUDGE_RPC_TESTNET`, `JUDGE_ARCHIVAL_RPC_TESTNET`, `JUDGE_RPC_MAINNET`,
  `JUDGE_ARCHIVAL_RPC_MAINNET` (comma-separated). Calls are paced (150 ms per host, 300 ms per
  archival host, because free archival RPC rate-limits bursts) and back off on HTTP 429, JSON-RPC
  -429 and node timeouts; answers that cannot change (anything pinned to a block, blocks, finished
  transactions) are asked once per run. NEAR's own `https://archival-rpc.testnet.near.org` also
  serves old blocks and can be added as a second archival endpoint, but it allows about 20
  requests a minute. The judge never calls NearBlocks or any indexer.
- A transaction the protocol rejects never reaches the chain. `protocol_rejection` proves the
  recorded rejection is consistent with the signed bytes and with the key's on-chain permission;
  the permission is the on-chain fact, the RPC answer itself is a recording.
- In a download without git history, `no-secrets` scans the file tree instead of the files git
  tracks (PASS or FAIL as usual) and `built-in-window` is SKIP.
