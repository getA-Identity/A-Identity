#!/usr/bin/env node
// Records the evidence the judge's --offline mode replays.
//
// For every claim that reads the chain, this runs the claim's check LIVE (views from RPC at
// finality "final", transactions from archival RPC) and writes evidence/<id>.json with each raw
// JSON-RPC request and response, the RPC URL, the block height and hash the answer was read at,
// and the time. Read-only: it never signs or sends anything. Run it after the deploy step has
// filled deployments/testnet.json and the demo has run, then commit evidence/.
//
//   node judge/capture.mjs                 every claim that is not pending
//   node judge/capture.mjs --step <ids>    only these
//   node judge/capture.mjs --dry-run       evaluate and print, write nothing
//
// A claim that FAILS live is not written (its evidence would prove nothing); --keep-failures
// writes it anyway for debugging. Pending claims are skipped. A claim whose fields are filled in
// but that could not be captured (a rate limit that did not clear, a missing tool) is listed as
// NOT CAPTURED. Exit 1 when any claim FAILED or was not captured: after deploy, a claim without
// evidence would only show up later, as a FAIL of the offline judge.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CHECKS } from './lib/checks.mjs';
import { evaluateClaim, evidencePathFor, loadClaims, loadDeployments, selectClaims } from './lib/engine.mjs';
import { EVIDENCE_SCHEMA, RecordingTransport } from './lib/evidence.mjs';
import { formatLine } from './lib/report.mjs';
import { LiveTransport } from './lib/rpc.mjs';

const HELP = `Usage: node judge/capture.mjs [--step <ids>] [--dry-run] [--keep-failures] [--evidence-dir <dir>] [--root <dir>]

Runs every chain-reading claim live and writes evidence/<id>.json for the ones that PASS.
Read-only JSON-RPC only. Commit evidence/ afterwards so --offline can replay it.
Exit 0 when every filled claim was captured, 1 when one FAILED or could not be captured,
2 on a usage error or when NEAR RPC cannot be reached.`;

async function main() {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      args: process.argv.slice(2),
      options: {
        step: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        'keep-failures': { type: 'boolean' },
        'evidence-dir': { type: 'string' },
        root: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = opts.root ? resolve(opts.root) : resolve(here, '..');
  const evidenceDir = opts['evidence-dir'] ? resolve(opts['evidence-dir']) : undefined;

  let claims;
  let deployments;
  let selected;
  try {
    claims = loadClaims(resolve(root, 'judge/claims.json'));
    deployments = loadDeployments(root, claims.deployments ?? 'deployments/testnet.json');
    const steps = (opts.step ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    selected = selectClaims(claims.claims, { steps, full: false }).filter((claim) => CHECKS[claim.check].network);
  } catch (err) {
    console.error(`capture: ${err.message}`);
    return 2;
  }
  for (const problem of deployments.problems) console.log(`NOTE ${deployments.rel}: ${problem}`);

  const live = new LiveTransport({ onRetry: ({ url, attempt, reason }) => console.error(`  ... retrying ${new URL(url).host} (attempt ${attempt + 1}): ${reason}`) });
  for (const network of new Set(selected.map((claim) => claim.network ?? 'testnet'))) {
    for (const kind of ['state', 'archival']) {
      const probe = await live.probe(network, kind);
      if (!probe.ok) {
        console.error(`capture: needs NEAR ${network} ${kind} RPC and cannot reach it (${probe.reason})`);
        return 2;
      }
    }
  }

  const written = [];
  const notCaptured = [];
  let failed = 0;
  let pending = 0;
  for (const claim of selected) {
    let recorder;
    const env = {
      root,
      deployments,
      mode: 'capture',
      evidenceDir,
      options: {},
      log: (line) => console.error(line),
      transportFor: () => {
        recorder = new RecordingTransport(live);
        return recorder;
      },
    };
    const result = await evaluateClaim(claim, env);
    console.log(formatLine(result));
    if (result.status === 'SKIP') {
      // Pending (a field not filled in, or a demo artifact not recorded yet) is expected before
      // deploy. Any other SKIP is a claim that is ready but has no evidence now.
      if (result.pending || /^pending: /.test(result.detail)) pending++;
      else notCaptured.push(`${claim.id} (${result.detail})`);
      continue;
    }
    if (result.status === 'FAIL') failed++;
    if (result.status === 'FAIL' && !opts['keep-failures']) continue;
    if (!recorder || recorder.calls.length === 0) continue;
    const path = evidencePathFor(root, claim, evidenceDir);
    const evidence = {
      schema: EVIDENCE_SCHEMA,
      claim_id: claim.id,
      claim: claim.claim,
      check: claim.check,
      network: claim.network ?? 'testnet',
      captured_at: new Date().toISOString(),
      captured_with: {
        tool: 'judge/capture.mjs',
        node: process.version,
        claims_sha256: claims.sha256,
        deployments_sha256: deployments.sha256,
      },
      result: { status: result.status, detail: result.detail },
      notes: [
        'Raw JSON-RPC requests and responses. Views were read at finality "final"; block_height and block_hash say which block answered.',
        'Transactions were read from archival RPC. A 64-byte ed25519 value (a signature) is stored as ed25519-signature-sha256:<sha256 of its bytes>.',
        'Replay: node judge/judge.mjs --offline. Re-check against the chain: node judge/judge.mjs --verify-evidence.',
      ],
      calls: recorder.calls,
    };
    if (!opts['dry-run']) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
      written.push(relative(root, path));
    }
  }
  for (const path of written) console.log(`wrote ${path}`);
  for (const line of notCaptured) console.log(`NOT CAPTURED ${line}`);
  console.log(
    `CAPTURE: ${written.length} written, ${failed} FAIL, ${notCaptured.length} NOT CAPTURED, ${pending} pending${opts['dry-run'] ? ' (dry run, nothing written)' : ''}`,
  );
  if (notCaptured.length) console.log('Re-run the claims not captured once their cause is gone: node judge/capture.mjs --step <id>');
  return failed > 0 || notCaptured.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`capture: unexpected error: ${err.stack ?? err.message}`);
    process.exitCode = 2;
  },
);
