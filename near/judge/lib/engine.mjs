// Shared by judge.mjs and capture.mjs: load the claims and the deployments, decide which claims
// run, resolve templates, pick the transport, run the check, and turn every outcome into exactly
// one of PASS, FAIL or SKIP with a reason.

import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { CHECKS } from './checks.mjs';
import { readJsonFile, resolveTemplates, validateDeployments } from './deployments.mjs';
import { EvidenceAbsentError, EvidenceStaleError, PendingError, ReplayTransport, SkipError, redactSignatures } from './evidence.mjs';
import { NetworkError } from './rpc.mjs';

export const CLAIMS_SCHEMA = 'a-identity-near-claims/1';
const ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const NON_ASCII = /[^\x09\x0a\x0d\x20-\x7e]/;

/** Load and validate claims.json. Structural problems are fatal (exit 2): a claims table the
 *  judge cannot read must not silently shrink. */
export function loadClaims(path) {
  const { value, sha256 } = readJsonFile(path);
  const problems = [];
  if (value.schema !== CLAIMS_SCHEMA) problems.push(`schema is ${JSON.stringify(value.schema)}, expected ${CLAIMS_SCHEMA}`);
  if (!Array.isArray(value.claims)) problems.push('claims is not an array');
  const seen = new Set();
  for (const [i, claim] of (value.claims ?? []).entries()) {
    const where = `claims[${i}]${claim?.id ? ` (${claim.id})` : ''}`;
    if (!claim || typeof claim !== 'object') {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (!ID.test(claim.id ?? '')) problems.push(`${where}: id must match ${ID}`);
    if (seen.has(claim.id)) problems.push(`${where}: duplicate id`);
    seen.add(claim.id);
    if (typeof claim.claim !== 'string' || claim.claim.length < 8) problems.push(`${where}: claim text missing`);
    else if (NON_ASCII.test(claim.claim)) problems.push(`${where}: claim text must be plain ASCII`);
    if (!CHECKS[claim.check]) problems.push(`${where}: unknown check type ${JSON.stringify(claim.check)}`);
    if (claim.network !== undefined && !['testnet', 'mainnet'].includes(claim.network)) problems.push(`${where}: network must be testnet or mainnet`);
    if (claim.mode !== undefined && !['default', 'full'].includes(claim.mode)) problems.push(`${where}: mode must be default or full`);
  }
  if (problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
  return { ...value, sha256, path };
}

export function loadDeployments(root, file, network = 'testnet') {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error(`${relative(root, path)} not found`);
  const { value, sha256 } = readJsonFile(path);
  return { data: value, sha256, path, rel: relative(root, path), problems: validateDeployments(value, network) };
}

/** Which claims run: --step names them; otherwise every default claim, plus the full ones with
 *  --full. Unknown step ids are an error, not an empty run. */
export function selectClaims(claims, { steps, full }) {
  if (steps && steps.length) {
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    const unknown = steps.filter((id) => !byId.has(id));
    if (unknown.length) {
      throw new Error(`unknown step id(s): ${unknown.join(', ')}. Known: ${claims.map((c) => c.id).join(', ')}`);
    }
    return steps.map((id) => byId.get(id));
  }
  return claims.filter((claim) => (claim.mode ?? 'default') === 'default' || full);
}

export function evidencePathFor(root, claim, evidenceDir) {
  if (evidenceDir) return resolve(evidenceDir, `${claim.id}.json`);
  return resolve(root, claim.evidence ?? `evidence/${claim.id}.json`);
}

/**
 * Evaluate one claim. `env`:
 *   root, deployments (loaded), mode ('online' | 'offline' | 'capture'),
 *   transportFor(claim) for online and capture, evidenceDir (optional), options, log.
 */
export async function evaluateClaim(claim, env) {
  const started = performance.now();
  const network = claim.network ?? 'testnet';
  const calls = [];
  const attachments = [];
  const base = {
    id: claim.id,
    claim: claim.claim,
    check: claim.check,
    network,
    mode: claim.mode ?? 'default',
    evidence_file: CHECKS[claim.check].network ? relative(env.root, evidencePathFor(env.root, claim, env.evidenceDir)) : null,
  };
  const done = (status, detail, extra = {}) => ({
    ...base,
    status,
    detail,
    ...extra,
    calls: calls.map(({ rpc_url, request, block_height, block_hash, fetched_at, ms, replayed }) => ({
      method: request.method,
      params: request.params,
      rpc_url,
      block_height,
      block_hash,
      fetched_at,
      ms,
      replayed: Boolean(replayed),
    })),
    raw_calls: calls,
    attachments,
    ms: Math.round(performance.now() - started),
  });

  const resolved = resolveTemplates({ params: claim.params ?? {}, requires: claim.requires ?? [] }, env.deployments.data);
  const missing = [...resolved.missing];
  for (const path of resolved.value.requires) {
    if (path === null) continue;
    const { missing: more } = resolveTemplates(`\${${path}}`, env.deployments.data);
    missing.push(...more);
  }
  if (missing.length) {
    const unique = [...new Set(missing)];
    const more = unique.length > 1 ? ` (and ${unique.length - 1} more field(s))` : '';
    return done('SKIP', `pending: ${unique[0]} is not recorded in ${env.deployments.rel} yet${more}`, { pending: unique });
  }

  let transport;
  if (env.mode === 'offline') {
    const path = evidencePathFor(env.root, claim, env.evidenceDir);
    transport = new ReplayTransport(path, relative(env.root, path));
  } else {
    transport = env.transportFor(claim);
  }
  const ctx = {
    root: env.root,
    network,
    mode: env.mode,
    claimId: claim.id,
    deployments: env.deployments.data,
    options: env.options ?? {},
    log: env.log ?? (() => {}),
    attach: (item) => attachments.push(item),
    rpc: async (spec) => {
      const call = await transport.call(spec);
      const clean = { ...call, response: redactSignatures(call.response) };
      calls.push(clean);
      return clean;
    },
  };

  try {
    const result = await CHECKS[claim.check].run(resolved.value.params, ctx);
    return done(result.status, result.detail, { expected: resolved.value.params?.expect ?? null, observed: result.observed, urls: result.urls ?? [] });
  } catch (err) {
    if (err instanceof EvidenceAbsentError) {
      const deployed = env.deployments.data.status === 'deployed';
      return deployed
        ? done('FAIL', `${err.message}: the deployment is marked deployed, so this claim needs recorded evidence (run node judge/capture.mjs)`)
        : done('SKIP', `${err.message}; it is captured after deploy`);
    }
    if (err instanceof EvidenceStaleError) return done('FAIL', `stale evidence: ${err.message}`);
    if (err instanceof NetworkError) return done('SKIP', `network: ${err.message}; try --offline`);
    if (err instanceof PendingError) return done('SKIP', `pending: ${err.message}`);
    if (err instanceof SkipError) return done('SKIP', err.message);
    return done('FAIL', `judge error while checking: ${err.stack?.split('\n').slice(0, 2).join(' ') ?? err.message}`);
  }
}
