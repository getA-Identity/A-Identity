// node --experimental-strip-types sdk/src/cli/verdict.ts <account> [options]
//
// Computes A-Identity's verdict on a NEAR payee from public chain data, prints every reason, the
// block it is pinned to and the snapshot's digests, and can save the snapshot so anyone can
// replay the exact verdict later with --offline (no network at all).
//
// Read-only: it sends JSON-RPC views and indexer queries, never a transaction, and needs no key.

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectSnapshot, CollectError } from "../collect/snapshot.ts";
import { explorerAccountUrl } from "../collect/networks.ts";
import type { FetchLike } from "../collect/rpc.ts";
import { assertSnapshot, formatEvidence, prettyJson, registryReasons, SnapshotError, verdictFromSnapshot, type Replay, type Snapshot } from "../engine/index.ts";

const USAGE = `A-Identity verdict for a NEAR payee (read-only, no keys)

usage:
  node --experimental-strip-types sdk/src/cli/verdict.ts <account> [options]
  node --experimental-strip-types sdk/src/cli/verdict.ts --offline <snapshot.json> [--json]

options:
  --network testnet|mainnet   network to read (default testnet)
  --at-block N                pin every read to block N (through archival RPC)
  --known a,b,c               payees the owner knows; a payee imitating one is a lookalike
  --vault <account>           the agent's vault: prior payments, refusals, owner allowlist
  --registry <account>|none   A-Identity registry (default: the vault's, else the network's)
  --json                      print one JSON object instead of text
  --save-snapshot <file>      write the snapshot (all requests and answers) to a file
  --offline <file>            replay a saved snapshot: no network
  --no-indexers               skip FastNEAR and NearBlocks (the verdict then warns)
  --no-third-party            skip other teams' registries
  -h, --help                  this text

exit codes: 0 verdict printed, 1 could not collect, 2 bad arguments or snapshot`;

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
};

const nodeIo: CliIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, t) => writeFile(p, t, "utf8"),
  env: process.env,
};

const TAG: Record<string, string> = { deny: "DENY", warn: "WARN", positive: "PLUS", info: "INFO" };

function renderText(replay: Replay, snapshot: Snapshot, mode: "online" | "offline", saved: string | null): string {
  const d = replay.decision;
  const lines: string[] = [];
  lines.push(`A-Identity verdict for ${d.subject} (${d.network}, ${mode})`);
  const kind = d.warn_kind === "soft" ? "  (soft: nobody has history with this payee yet)" : d.warn_kind === "hard" ? "  (hard)" : "";
  lines.push(`  verdict   ${d.verdict}  score ${d.score}/1000${kind}`);
  lines.push(`  block     #${d.block.height}  ${d.block.hash}  ${new Date(Number(BigInt(d.block.timestamp_ns) / 1_000_000n)).toISOString()}`);
  lines.push("  reasons");
  if (d.reasons.length === 0) lines.push("    (none)");
  for (const r of d.reasons) {
    const cleared = r.cleared_by ? `  (cleared by ${r.cleared_by})` : "";
    lines.push(`    ${TAG[r.severity]}  ${r.code}${cleared}`);
    lines.push(`          ${r.detail}`);
    lines.push(`          source: ${r.source}`);
  }
  lines.push(`  snapshot  sha256 ${replay.snapshot_sha256}`);
  lines.push(`  chain     sha256 ${replay.chain_sha256}  (the block-pinned RPC answers; re-fetch them from archival RPC to reproduce)`);
  lines.push(`  engine    ${d.engine_version}  policy ${d.policy_id}`);
  if (saved) lines.push(`  saved     ${saved}  (replay: node --experimental-strip-types sdk/src/cli/verdict.ts --offline ${saved})`);
  if (mode === "online") lines.push(`  explorer  ${explorerAccountUrl(d.network, d.subject)}  (for humans; the verdict reads RPC)`);
  for (const note of snapshot.meta?.notes ?? []) lines.push(`  note      ${note}`);
  return `${lines.join("\n")}\n`;
}

function renderJson(replay: Replay, snapshot: Snapshot, mode: "online" | "offline", saved: string | null): string {
  const d = replay.decision;
  return `${JSON.stringify(
    {
      account: d.subject,
      network: d.network,
      mode,
      verdict: d.verdict,
      score: d.score,
      warn_kind: d.warn_kind,
      reasons: d.reasons,
      registry_reasons: registryReasons(d),
      block: d.block,
      snapshot_sha256: replay.snapshot_sha256,
      chain_sha256: replay.chain_sha256,
      evidence: formatEvidence(replay),
      engine_version: d.engine_version,
      policy_id: d.policy_id,
      saved_snapshot: saved,
      endpoints: snapshot.meta?.endpoints ?? [],
      notes: snapshot.meta?.notes ?? [],
    },
    null,
    2,
  )}\n`;
}

export async function main(argv: readonly string[], io: CliIo = nodeIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        network: { type: "string" },
        "at-block": { type: "string" },
        known: { type: "string" },
        vault: { type: "string" },
        registry: { type: "string" },
        json: { type: "boolean" },
        "save-snapshot": { type: "string" },
        offline: { type: "string" },
        "no-indexers": { type: "boolean" },
        "no-third-party": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const account = positionals[0];
  if (positionals.length > 1) {
    io.stderr(`expected one account, got ${positionals.length}\n`);
    return 2;
  }

  let snapshot: Snapshot;
  let mode: "online" | "offline";
  if (values.offline !== undefined) {
    mode = "offline";
    try {
      snapshot = assertSnapshot(JSON.parse(await io.readFile(values.offline)));
    } catch (e) {
      io.stderr(`cannot replay ${values.offline}: ${e instanceof SnapshotError || e instanceof SyntaxError ? e.message : e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    if (account !== undefined && account !== snapshot.subject) {
      io.stderr(`the snapshot is about ${snapshot.subject}, not ${account}\n`);
      return 2;
    }
  } else {
    mode = "online";
    if (account === undefined) {
      io.stderr(`missing <account>\n\n${USAGE}\n`);
      return 2;
    }
    const network = values.network ?? "testnet";
    if (network !== "testnet" && network !== "mainnet") {
      io.stderr(`--network must be testnet or mainnet\n`);
      return 2;
    }
    let atBlock: number | undefined;
    if (values["at-block"] !== undefined) {
      if (!/^\d+$/.test(values["at-block"])) {
        io.stderr(`--at-block must be a block height\n`);
        return 2;
      }
      atBlock = Number(values["at-block"]);
    }
    const known = values.known ? values.known.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const registry = values.registry === undefined ? undefined : values.registry === "none" ? null : values.registry;
    try {
      snapshot = await collectSnapshot({
        account,
        network,
        known,
        vault: values.vault ?? null,
        indexers: !values["no-indexers"],
        thirdParty: !values["no-third-party"],
        env: io.env,
        ...(atBlock !== undefined ? { atBlock } : {}),
        ...(registry !== undefined ? { registry } : {}),
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.sleep ? { sleep: io.sleep } : {}),
        ...(io.clock ? { clock: io.clock } : {}),
      });
    } catch (e) {
      if (e instanceof TypeError) {
        io.stderr(`${e.message}\n`);
        return 2;
      }
      io.stderr(`no verdict: ${e instanceof CollectError ? e.message : e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  const replay = verdictFromSnapshot(snapshot);
  let saved: string | null = null;
  if (values["save-snapshot"] !== undefined) {
    saved = values["save-snapshot"];
    await io.writeFile(saved, `${prettyJson(snapshot)}\n`);
  }
  io.stdout(values.json ? renderJson(replay, snapshot, mode, saved) : renderText(replay, snapshot, mode, saved));
  return 0;
}

// Run when executed directly (not when imported by tests).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
