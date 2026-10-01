# Stellar transaction archive

One JSON file per Stellar transaction we cite anywhere: on /proof/stellar, in the release
records beside this directory, or in a SOW 2 deliverable. The path is
`<chainId>/<hash>.json`, where `chainId` is the registry id (`stellar` for pubnet,
`stellar-testnet` for testnet) and `hash` is the 64-character transaction hash.

## Why it exists

A hash is only evidence while some node can still answer for it, and the network forgets
on a schedule:

- Soroban RPC keeps about 7 days of transactions. Every claim we publish is older than that
  within a week.
- Horizon keeps history back to the network's last reset, but it no longer serves result
  meta, which is where a failed contract call's typed error code lives.
- Testnet is reset periodically. After a reset no public node has any testnet transaction
  from before it, and every testnet hash on our proof pages stops resolving.

So every cited transaction is fetched once, read-only, while it can still be fetched, and
its raw bytes are kept here together with what they decode to.

## What each file holds

| Field | Meaning |
|---|---|
| `hash`, `chainId`, `network` | The transaction hash, the registry id, and the CAIP-2 network. |
| `ledger`, `createdAt` | The ledger it closed in and that ledger's close time, as the source reported them. |
| `status`, `resultCode` | `success` or `failed`; the transaction-level result code (for example `txSuccess`, `txFailed`), the per-operation result (for example `invokeHostFunctionTrapped`), and, for a refused call, the contract error code and, when the refusing contract is the vault that was called, its AgentSpendPolicy error name (for example `DailyCapExceeded`). |
| `sourceAccount`, `feeAccount`, `feeChargedStroops` | Who the transaction is from and who paid its fee. They differ only under a fee bump, where `feeAccount` is the outer source. |
| `envelopeXdr`, `resultXdr` | The raw transaction envelope and result, base64, byte for byte as served. The envelope hashes to `hash`; the script checks that before it writes anything. |
| `resultMetaXdr`, `metaFrom`, `metaNote` | The result meta when any source still had it, or null with a note saying why not. `metaFrom: "rpc"` is Soroban RPC; `"stellar-expert"` is Stellar Expert's public API, a third-party indexer, accepted only when the envelope and result it served beside the meta match RPC or Horizon byte for byte. Meta is not covered by the transaction hash, so that cross-check is the most that can be said for it. |
| `fetchedFrom` | Where the envelope and result came from: `rpc` or `horizon`. |
| `explorer` | The stellar.expert link, derived from the registry. |
| `archivedAt` | When the file was first written. A re-run keeps it. |
| `caption`, `deliverable`, `provenance` | The one-line caption (for `--all-provenance`, the label from mcp/src/chains/provenance.ts), the SOW deliverable it backs if one was given, and the provenance entry it came from. |
| `decoded` | The decoded evidence: every operation with its contract, function and arguments; every Soroban authorization entry with its credential type (`source_account` or `address`), nonce, expiration ledger, root invocation and signers; and a plain-language `summary` and any `caveats`. |

For an OpenZeppelin smart account, `decoded.auth[].signers[]` names each signer by its
verifier, using the verifier addresses the registry records for that network:
`webauthn-secp256r1` (a passkey), `ed25519`, `delegated`, or `unknown`. A passkey signer
carries the decoded WebAuthn assertion: the authenticator flags (UP, UV, BE, BS, AT, ED),
the sign count, the clientDataJSON type, origin and challenge, whether that challenge is
the auth digest recomputed from the entry itself, and whether the P-256 signature
re-verifies locally.

One caveat travels with every passkey signer and is repeated here: the chain verifies a
P-256 signature and cannot tell a device authenticator from a software P-256 key. The
flags and the origin are what the authenticator, or whatever produced the signature,
reported. The 2026-09-19 rehearsal (`stellar-testnet/994b5cb9...json`) is exactly that
case: a software key in our own script, flags 0x05, origin https://a-identity.xyz.

## How to verify a file

You do not need to trust this directory. Either:

1. Open the `explorer` link (stellar.expert) and compare the ledger, the result, the
   source and fee accounts, and the called function with the file. While the network
   still has the transaction, they must agree.
2. Or re-run the script, which re-fetches from the network and rewrites the file only if
   something differs:

   ```
   cd mcp && npm run build
   node scripts/stellar-archive-tx.mjs --chain stellar-testnet --hash <hash>
   ```

   It prints `unchanged` when the network still serves exactly what the file holds.

To see just the authorization of one transaction, decoded again from the stored XDR (so it
works offline and after a testnet reset):

```
node mcp/scripts/stellar-decode-auth.mjs --chain stellar-testnet --hash <hash>
```

Add `--live` to decode from the network instead of the archive. The same decode is served
by the backend at `GET /api/stellar/tx/<hash>?network=<stellar | stellar-testnet>`.

## Adding to it

```
node mcp/scripts/stellar-archive-tx.mjs --chain <stellar | stellar-testnet> --hash <hash> --caption "..." --deliverable D2
node mcp/scripts/stellar-archive-tx.mjs --all-provenance
```

`--all-provenance` archives every Stellar transaction listed in
mcp/src/chains/provenance.ts, including funding hops recorded under another chain's entry.
Both forms are idempotent: a re-run keeps the existing caption and deliverable unless new
ones are given, keeps the first `archivedAt`, and never drops a meta an earlier run
captured. The script is read-only against the network: it signs and submits nothing.

As of 2026-10-02 the archive holds 45 transactions (17 pubnet, 28 testnet), all with
result meta.
