// node --experimental-strip-types sdk/src/cli/guard.ts --vault <id> --payee <id> --amount <usdc> [options]
//
// verifyThenPay from the command line. With no key it sends nothing and prints the exact call the
// agent would make (signer, receiver, method, arguments, gas, deposit), so anyone can see what
// the guard decides and what it would ask the vault to do, with no key and no account.
// With --key-file or --key-env it signs as the vault with the agent's function-call key and
// sends a real transaction on the chosen network.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { KeyError, loadKey, type LoadedKey } from "../chain/keys.ts";
import { toUnits, VaultArgumentError } from "../chain/vault.ts";
import type { FetchLike } from "../collect/rpc.ts";
import { verifyThenPay, type GuardResult } from "../guard.ts";

const USAGE = `A-Identity guard: check a payee, then pay, ask the owner, or record the refusal

usage:
  node --experimental-strip-types sdk/src/cli/guard.ts --vault <account> --payee <account> --amount <usdc> [options]

options:
  --amount <decimal>        amount in USDC, at most 6 decimals ("0.25")
  --memo <text>             memo for the transfer (at most 128 bytes)
  --known a,b,c             payees the owner knows (lookalike targets)
  --network testnet|mainnet default testnet
  --hosted <url>            ask a hosted A-Identity endpoint instead of computing locally
  --key-file <path>         the agent's function-call key (0600 file): SENDS a transaction
  --key-env <NAME>          the same, from an environment variable
  --json                    print the full result as JSON
  -h, --help                this text

Without a key nothing is sent: the output is the prepared call.
exit codes: 0 done (whatever the verdict), 1 failed, 2 bad arguments`;

export type GuardIo = {
  stdout: (t: string) => void;
  stderr: (t: string) => void;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

const nodeIo: GuardIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };

function render(r: GuardResult): string {
  const lines = [`A-Identity guard: ${r.summary}`];
  lines.push(`  verdict   ${r.verdict.verdict} (${r.verdict.source})${r.verdict.unavailable ? `  unavailable: ${r.verdict.unavailable}` : ""}`);
  if (r.verdict.decision) {
    for (const reason of r.verdict.decision.reasons) {
      if (reason.severity === "info") continue;
      lines.push(`    ${reason.severity.toUpperCase().padEnd(8)} ${reason.code}${reason.cleared_by ? ` (cleared by ${reason.cleared_by})` : ""}: ${reason.detail}`);
    }
    lines.push(`  snapshot  sha256 ${r.verdict.snapshot_sha256}  block #${r.verdict.decision.block.height}`);
  }
  lines.push(`  route     ${r.route}`);
  if (r.prepared) {
    lines.push(`  prepared  NOT SENT. Sign as ${r.prepared.signer_id} and send exactly:`);
    lines.push(`            ${JSON.stringify({ receiverId: r.prepared.receiver_id, actions: r.prepared.actions })}`);
  }
  if (r.onchain) lines.push(`  vault     ${r.onchain.status}${r.onchain.reason ? ` (${r.onchain.reason})` : ""}, payment ${r.onchain.payment_id}${r.onchain.held_id ? `, held ${r.onchain.held_id}` : ""}`);
  if (r.settlement) for (const c of r.settlement.checks) lines.push(`  ${c.ok ? "ok  " : "FAIL"}      ${c.name}: ${c.detail}`);
  if (r.tx_hash) lines.push(`  tx        ${r.tx_hash}`);
  if (r.links) lines.push(`  explorer  ${r.links.explorer}`, `  archival  ${r.links.archival_curl}`);
  if (r.error) lines.push(`  error     ${r.error}`);
  return `${lines.join("\n")}\n`;
}

export async function main(argv: readonly string[], io: GuardIo = nodeIo): Promise<number> {
  let values;
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        vault: { type: "string" },
        payee: { type: "string" },
        amount: { type: "string" },
        memo: { type: "string" },
        known: { type: "string" },
        network: { type: "string" },
        hosted: { type: "string" },
        "key-file": { type: "string" },
        "key-env": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (!values.vault || !values.payee || !values.amount) {
    io.stderr(`--vault, --payee and --amount are required\n\n${USAGE}\n`);
    return 2;
  }
  const network = values.network ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    io.stderr("--network must be testnet or mainnet\n");
    return 2;
  }
  let units: string;
  let signer: LoadedKey | null;
  try {
    units = toUnits(values.amount, 6);
    signer = await loadKey({
      ...(values["key-file"] ? { file: values["key-file"] } : {}),
      ...(values["key-env"] ? { envVar: values["key-env"], env: io.env } : {}),
    });
  } catch (e) {
    if (e instanceof VaultArgumentError || e instanceof KeyError) {
      io.stderr(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  try {
    const result = await verifyThenPay({
      vault: values.vault,
      payee: values.payee,
      amount: units,
      network,
      signer,
      verdictSource: values.hosted ? "hosted" : "local",
      known: values.known ? values.known.split(",").map((s) => s.trim()).filter(Boolean) : [],
      env: io.env,
      ...(values.memo !== undefined ? { memo: values.memo } : {}),
      ...(values.hosted ? { hostedUrl: values.hosted } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    io.stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
    return 0;
  } catch (e) {
    io.stderr(`${e instanceof TypeError || e instanceof VaultArgumentError ? "" : "failed: "}${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof TypeError || e instanceof VaultArgumentError ? 2 : 1;
  }
}

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
