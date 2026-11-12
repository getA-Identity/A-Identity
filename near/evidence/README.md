# Evidence

Recorded chain answers for the claims in `../judge/claims.json`, so the judge can verify every
claim with no network (`node judge/judge.mjs --offline`).

- `<claim id>.json`: written by `node judge/capture.mjs`. Each file holds the raw JSON-RPC requests
  and responses one claim needed, with the RPC URL, the block height and hash each answer was read
  at, and the time it was fetched (schema `a-identity-near-evidence/1`). Current-state views were
  read at finality `final`; reads pinned to a recorded block (the lookalike's verdict, the vault's
  counters, the snapshot's chain reads) and every transaction came from archival RPC.
- The public-data snapshots behind each registry verdict are where `deployments/testnet.json`
  points (`verdicts.<payee>.snapshot`; the oracle saves them as
  `demo/logs/oracle/snapshots/<sha256>.json`). `sdk/src/cli/verdict.ts --offline` recomputes the
  verdict from one with no network, and the `recompute-lookalike` evidence holds archival RPC's
  answers to every block-pinned read in it.

Nothing here is a summary: the offline judge re-runs the same checks on these raw answers. To
check the files against the chain, `node judge/judge.mjs --verify-evidence` re-asks archival RPC
every recorded call at its recorded block and compares. Transaction signatures are stored as
`ed25519-signature-sha256:<hex>`; everything else is as the node returned it. Capture exits 1 when
a claim that is filled in could not be recorded, so no ready claim is left without a file here.

Empty until the contracts are deployed and the demo has run.
