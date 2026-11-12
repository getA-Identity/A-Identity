#!/usr/bin/env node
// A-Identity Guard for NEAR: the zero-key judge.
//
// Turns every claim in judge/claims.json into one PASS, FAIL or SKIP line, from public chain data
// only. No keys, no npm install, Node built-ins only. See judge/README.md.
//
//   node judge/judge.mjs                    online: state from RPC, every transaction from archival RPC
//   node judge/judge.mjs --offline          replay the committed evidence/*.json, no network
//   node judge/judge.mjs --full             also build and test (cargo, sandbox, npm, controls)
//   node judge/judge.mjs --step <id>[,<id>] run only these claims or steps
//   node judge/judge.mjs --verify-evidence  re-ask archival RPC every recorded question
//   node judge/judge.mjs --json             the report as JSON on stdout
//
// Exit status: 0 when nothing FAILED, 1 when any claim FAILED, 2 on a usage or setup error.

import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateClaim, loadClaims, loadDeployments, selectClaims } from './lib/engine.mjs';
import { buildReport, formatLine, slowest, summaryLine, writeReport } from './lib/report.mjs';
import { LiveTransport } from './lib/rpc.mjs';
import { CHECKS } from './lib/checks.mjs';
import { verifyEvidence } from './lib/verify.mjs';

const HELP = `A-Identity Guard for NEAR: zero-key judge

Usage: node judge/judge.mjs [options]

  (no option)          online: views from NEAR RPC, transactions from archival RPC.
                       Each network's RPC and archival RPC are probed first; the claims of a
                       network that does not answer replay the committed evidence instead,
                       and a NOTE says so (use --no-fallback to get SKIP lines instead).
  --offline            replay evidence/<id>.json only; no network at all
  --full               also run the build and test steps (cargo, sandbox, npm, controls)
  --step <ids>         run only these claim or step ids (comma-separated, repeatable)
  --list               print the claims table and exit
  --verify-evidence    re-ask archival RPC every recorded call, pinned to its block
  --json               print the report as JSON on stdout (lines go to stderr)
  --report <path>      where to write the report (default judge/judge-report.json)
  --no-report          do not write a report file
  --timeout-s <n>      time box for each --full step (default per step)
  --evidence-dir <dir> read evidence from another directory
  --root <dir>         the near/ directory to judge (default: the one holding this script)
  -h, --help           this text

Every line is: PASS|FAIL|SKIP <id> <claim> (<evidence or reason>; <seconds> s)
FAIL means the check ran and the chain or the code disagreed with the claim. SKIP always says
why (not deployed yet, no network, a tool missing); it is never a silent pass.
Exit 0 when nothing failed, 1 when something failed, 2 on a usage error.`;

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      offline: { type: 'boolean' },
      full: { type: 'boolean' },
      step: { type: 'string', multiple: true },
      list: { type: 'boolean' },
      'verify-evidence': { type: 'boolean' },
      json: { type: 'boolean' },
      report: { type: 'string' },
      'no-report': { type: 'boolean' },
      'no-fallback': { type: 'boolean' },
      'timeout-s': { type: 'string' },
      'evidence-dir': { type: 'string' },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  return values;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Probe, in parallel, the RPC kinds this run needs for each network (state and archival; only
 * archival for --verify-evidence). Returns the networks whose claims must replay evidence and one
 * NOTE per network. A host that fails its probe is marked dead in `live`, so no claim waits on it.
 */
async function probeNetworks(live, networks, mode, fallback) {
  const kinds = mode === 'verify-evidence' ? ['archival'] : ['state', 'archival'];
  const probes = await Promise.all(networks.flatMap((network) => kinds.map(async (kind) => ({ network, kind, ...(await live.probe(network, kind)) }))));
  const replay = new Map();
  const notes = [];
  for (const network of networks) {
    const mine = probes.filter((probe) => probe.network === network);
    const down = mine.filter((probe) => !probe.ok);
    if (down.length) {
      const why = down.map((probe) => `${probe.kind} RPC: ${probe.reason}`).join('; ');
      if (fallback) {
        replay.set(network, `${network} RPC not reachable`);
        notes.push(`NEAR ${network} is not reachable from here (${why}); its claims replay the committed evidence instead`);
      } else {
        notes.push(`NEAR ${network} is not reachable from here (${why}); its claims will SKIP`);
      }
    } else {
      notes.push(`${network}: ${mine.map((probe) => `${probe.kind} RPC ${hostOf(probe.url)}${probe.height ? ` at block ${probe.height}` : ''}`).join(', ')}`);
    }
  }
  return { replay, notes };
}

async function main() {
  const argv = process.argv.slice(2);
  let opts;
  try {
    opts = parse(argv);
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
  const say = opts.json ? (line) => console.error(line) : (line) => console.log(line);
  const note = (line) => console.error(line);

  let claims;
  let deployments;
  let selected;
  try {
    claims = loadClaims(resolve(root, 'judge/claims.json'));
    claims.rel = relative(root, claims.path);
    deployments = loadDeployments(root, claims.deployments ?? 'deployments/testnet.json');
    const steps = (opts.step ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    selected = selectClaims(claims.claims, { steps, full: opts.full });
  } catch (err) {
    console.error(`judge: ${err.message}`);
    return 2;
  }

  if (opts.list) {
    for (const claim of claims.claims) {
      say(`${claim.id.padEnd(28)} ${(claim.mode ?? 'default').padEnd(7)} ${claim.check.padEnd(32)} ${claim.claim}`);
    }
    return 0;
  }

  const timeoutS = opts['timeout-s'] ? Number(opts['timeout-s']) : undefined;
  if (timeoutS !== undefined && !(timeoutS > 0)) {
    console.error('judge: --timeout-s needs a positive number of seconds');
    return 2;
  }

  const started = performance.now();
  const live = new LiveTransport({ onRetry: ({ url, attempt, reason }) => note(`  ... retrying ${hostOf(url)} (attempt ${attempt + 1}): ${reason}`) });
  let mode = opts['verify-evidence'] ? 'verify-evidence' : opts.offline ? 'offline' : 'online';
  const networks = [...new Set(selected.filter((c) => CHECKS[c.check].network).map((c) => c.network ?? 'testnet'))];

  let replay = new Map();
  let notes = [];
  if (mode !== 'offline' && networks.length) {
    ({ replay, notes } = await probeNetworks(live, networks, mode, mode === 'online' && !opts['no-fallback']));
    // Nothing answers at all: this is simply an offline run, and the header says so.
    if (mode === 'online' && networks.every((network) => replay.has(network))) mode = 'offline';
  }
  const modeNote = notes.length ? notes.join('; ') : null;

  const header = `A-Identity Guard for NEAR: judge (mode=${mode}; ${selected.length} of ${claims.claims.length} claims; ${deployments.rel} status=${deployments.data.status})`;
  say(header);
  for (const line of notes) say(`NOTE ${line}`);
  for (const problem of deployments.problems) say(`NOTE ${deployments.rel}: ${problem}`);
  const fullOnly = claims.claims.filter((c) => c.mode === 'full' && !selected.includes(c));
  if (fullOnly.length && !opts.step) say(`NOTE ${fullOnly.length} build and test steps run with --full or --step <id>: ${fullOnly.map((c) => c.id).join(', ')}`);

  const env = {
    root,
    deployments,
    mode,
    evidenceDir: opts['evidence-dir'] ? resolve(opts['evidence-dir']) : undefined,
    options: { timeoutS },
    log: note,
    transportFor: () => live,
  };
  const fallback = mode === 'online' && !opts['no-fallback'];
  const replayed = async (claim, why) => {
    const result = await evaluateClaim(claim, { ...env, mode: 'offline' });
    result.detail = `replayed evidence (${why}): ${result.detail}`;
    result.replayed = true;
    return result;
  };
  const results = [];
  for (const claim of selected) {
    let result;
    const chain = CHECKS[claim.check].network;
    const network = claim.network ?? 'testnet';
    if (mode === 'verify-evidence') {
      result = chain
        ? await verifyEvidence(claim, env, live)
        : { id: claim.id, claim: claim.claim, check: claim.check, status: 'SKIP', detail: 'local check, nothing recorded to verify', calls: [], ms: 0 };
    } else if (mode === 'online' && chain && replay.has(network)) {
      // This claim's network did not answer: re-derive the claim from the committed evidence.
      result = await replayed(claim, replay.get(network));
    } else {
      result = await evaluateClaim(claim, env);
      if (fallback && chain && result.status === 'SKIP' && /^network: /.test(result.detail)) {
        // The network stopped answering mid-run (a rate limit that did not clear). With evidence
        // to replay, this claim and the network's remaining claims are re-derived from it at once
        // instead of each waiting out the same backoff. Without evidence the SKIP stands, and the
        // next claim tries the network again.
        const again = await replayed(claim, `${network} RPC stopped answering`);
        if (!/no recorded evidence/.test(again.detail)) {
          replay.set(network, `${network} RPC stopped answering`);
          say(`NOTE ${network} RPC stopped answering (${result.detail.replace(/^network: /, '').replace(/; try --offline$/, '')}); this and the remaining ${network} claims replay the committed evidence`);
          // The step's time includes the live attempt it waited out.
          again.ms += result.ms;
          result = again;
        }
      }
    }
    results.push(result);
    say(formatLine(result));
  }

  const ms = Math.round(performance.now() - started);
  if (results.length) say(`timings: slowest ${slowest(results)}; ${live.count} RPC calls`);
  const report = buildReport({ results, mode, modeNote, ms, root, claims, deployments, argv, network: networks.join(',') || 'none', replayed: [...replay.keys()] });
  if (!opts['no-report']) {
    const reportPath = resolve(opts.report ?? resolve(root, 'judge/judge-report.json'));
    try {
      writeReport(reportPath, report);
      say(`report: ${relative(process.cwd(), reportPath) || reportPath}`);
    } catch (err) {
      note(`judge: could not write the report (${err.message})`);
    }
  }
  say(summaryLine(results, mode, ms));
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.totals.fail > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`judge: unexpected error: ${err.stack ?? err.message}`);
    process.exitCode = 2;
  },
);
