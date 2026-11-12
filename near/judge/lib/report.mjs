// Output: one line per claim, a final count line, and judge-report.json.

import { writeFileSync } from 'node:fs';
import { curlFor } from './rpc.mjs';

const MAX_DETAIL = 400;

function oneLine(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 3)}...` : flat;
}

/** `PASS|FAIL|SKIP <id> <claim text> (<evidence or reason>; <seconds> s)` */
export function formatLine(result) {
  const secs = (result.ms / 1000).toFixed(2);
  return `${result.status} ${result.id} ${result.claim} (${oneLine(result.detail)}; ${secs} s)`;
}

export function totals(results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return { pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP') };
}

export function summaryLine(results, mode, ms) {
  const t = totals(results);
  return `JUDGE: ${t.pass} PASS, ${t.fail} FAIL, ${t.skip} SKIP (mode=${mode}, ${(ms / 1000).toFixed(1)} s)`;
}

/** The slowest steps, for the per-step timing line. */
export function slowest(results, n = 3) {
  return [...results]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n)
    .map((r) => `${r.id} ${(r.ms / 1000).toFixed(2)} s`)
    .join(', ');
}

export function buildReport({ results, mode, modeNote, ms, root, claims, deployments, argv, network, replayed = [] }) {
  return {
    schema: 'a-identity-near-judge-report/1',
    generated_at: new Date().toISOString(),
    mode,
    mode_note: modeNote ?? null,
    replayed_networks: replayed,
    command: `node judge/judge.mjs ${argv.join(' ')}`.trim(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    root,
    network,
    claims_file: claims.rel,
    claims_sha256: claims.sha256,
    deployments_file: deployments.rel,
    deployments_sha256: deployments.sha256,
    deployments_status: deployments.data.status ?? null,
    deployments_problems: deployments.problems,
    totals: totals(results),
    duration_ms: ms,
    checks: results.map((r) => ({
      id: r.id,
      status: r.status,
      claim: r.claim,
      check: r.check,
      network: r.network,
      detail: r.detail,
      expected: r.expected ?? null,
      observed: r.observed ?? null,
      pending: r.pending ?? null,
      evidence_file: r.evidence_file,
      replayed: Boolean(r.replayed) || mode === 'offline',
      urls: r.urls ?? [],
      ms: r.ms,
      calls: r.calls,
      curl: (r.raw_calls ?? []).map((c) => curlFor(c)),
      attachments: r.attachments ?? [],
    })),
  };
}

export function writeReport(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}
